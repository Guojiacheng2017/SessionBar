export type SSEReader = Pick<ReadableStreamDefaultReader<string>, "read" | "cancel">;

export interface SSETransport<T> {
  next(timeoutMs: number): Promise<T | "timeout" | "closed">;
  close(): void;
}

type WaitResult<T> =
  | { kind: "value"; value: T }
  | { kind: "timeout" }
  | { kind: "aborted" }
  | { kind: "error" };

const NO_EVENT = Symbol("no-event");

function waitForValue<T>(promise: Promise<T>, timeoutMs: number, signal: AbortSignal): Promise<WaitResult<T>> {
  return new Promise(resolve => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: WaitResult<T>) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = () => finish({ kind: "aborted" });

    if (signal.aborted) {
      finish({ kind: "aborted" });
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => finish({ kind: "timeout" }), Math.max(0, timeoutMs));
    promise.then(
      value => finish({ kind: "value", value }),
      () => finish({ kind: "error" }),
    );
  });
}

function parseBufferedEvent<T>(buffer: { value: string }): T | typeof NO_EVENT {
  while (true) {
    const delimiter = /\r?\n\r?\n/.exec(buffer.value);
    if (!delimiter || delimiter.index === undefined) return NO_EVENT;
    const event = buffer.value.slice(0, delimiter.index);
    buffer.value = buffer.value.slice(delimiter.index + delimiter[0].length);
    const data = event
      .split(/\r?\n/)
      .filter(line => line.startsWith("data:"))
      .map(line => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data) continue;
    try {
      return JSON.parse(data) as T;
    } catch {
      // Ignore malformed events and continue with the buffered stream.
    }
  }
}

export function createSSETransport<T>(
  connect: (signal: AbortSignal) => Promise<SSEReader | null>,
): SSETransport<T> {
  const controller = new AbortController();
  const buffer = { value: "" };
  let reader: SSEReader | null = null;
  let connecting: Promise<SSEReader | null> | null = null;
  let pendingRead: Promise<ReadableStreamReadResult<string> | undefined> | null = null;
  let pendingReadResult: ReadableStreamReadResult<string> | undefined | typeof NO_EVENT = NO_EVENT;
  const readWaiters = new Set<(value: ReadableStreamReadResult<string> | undefined) => void>();
  let closed = false;

  function startRead(): void {
    if (pendingRead || !reader) return;
    pendingReadResult = NO_EVENT;
    pendingRead = reader.read().catch(() => undefined);
    void pendingRead.then(value => {
      pendingReadResult = value;
      for (const waiter of readWaiters) waiter(value);
      readWaiters.clear();
    });
  }

  function waitForRead(timeoutMs: number): Promise<WaitResult<ReadableStreamReadResult<string> | undefined>> {
    if (pendingReadResult !== NO_EVENT) {
      return Promise.resolve({ kind: "value", value: pendingReadResult });
    }
    return new Promise(resolve => {
      let settled = false;
      const finish = (result: WaitResult<ReadableStreamReadResult<string> | undefined>) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        controller.signal.removeEventListener("abort", onAbort);
        readWaiters.delete(onValue);
        resolve(result);
      };
      const onValue = (value: ReadableStreamReadResult<string> | undefined) => finish({ kind: "value", value });
      const onAbort = () => finish({ kind: "aborted" });
      const timer = setTimeout(() => finish({ kind: "timeout" }), Math.max(0, timeoutMs));
      readWaiters.add(onValue);
      controller.signal.addEventListener("abort", onAbort, { once: true });
      if (controller.signal.aborted) onAbort();
    });
  }

  function connection(): Promise<SSEReader | null> {
    if (connecting) return connecting;
    connecting = connect(controller.signal).catch(() => null);
    const pending = connecting;
    void pending.then(candidate => {
      if (!candidate) return;
      if (closed) void Promise.resolve(candidate.cancel()).catch(() => undefined);
      else if (!reader) reader = candidate;
    });
    return pending;
  }

  async function next(timeoutMs: number): Promise<T | "timeout" | "closed"> {
    if (closed) return "closed";
    const deadline = Date.now() + Math.max(0, timeoutMs);

    if (!reader) {
      const pendingConnection = connection();
      const connected = await waitForValue(
        pendingConnection,
        Math.max(0, deadline - Date.now()),
        controller.signal,
      );
      if (connected.kind === "timeout") return "timeout";
      if (connected.kind !== "value" || !connected.value || closed) return "closed";
      if (connecting === pendingConnection) connecting = null;
      reader = connected.value;
    }

    while (!closed) {
      const buffered = parseBufferedEvent<T>(buffer);
      if (buffered !== NO_EVENT) return buffered;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) return "timeout";

      startRead();
      const activeRead = pendingRead;
      const outcome = await waitForRead(remainingMs);
      if (outcome.kind === "timeout") return "timeout";
      if (outcome.kind !== "value" || !outcome.value || closed) return "closed";
      if (pendingRead === activeRead) {
        pendingRead = null;
        pendingReadResult = NO_EVENT;
      }
      if (outcome.value.done) return "closed";
      buffer.value += outcome.value.value;
    }
    return "closed";
  }

  function close(): void {
    if (closed) return;
    closed = true;
    controller.abort();
    readWaiters.clear();
    const activeReader = reader;
    reader = null;
    if (activeReader) void Promise.resolve(activeReader.cancel()).catch(() => undefined);
  }

  return { next, close };
}
