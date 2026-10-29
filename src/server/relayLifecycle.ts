import type { ChildProcess } from "node:child_process";

export type RelayStopResult = "stopped" | "timeout" | "unverified" | "replaced" | "failed";

interface RelayStopOptions {
  pid: number;
  owner: string;
  readOwner: () => string | undefined;
  isAlive: (pid: number) => boolean;
  verifyOwner: (pid: number) => Promise<boolean>;
  signal: (pid: number, signal: "SIGTERM") => void;
  wait?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  intervalMs?: number;
}

/** Stop only the captured owner. Never remove runtime state or signal a successor. */
export async function stopRelayProcess(options: RelayStopOptions): Promise<RelayStopResult> {
  const { pid, owner, readOwner, isAlive, verifyOwner, signal } = options;
  if (!Number.isSafeInteger(pid) || pid <= 0 || !owner || readOwner() !== owner) return "unverified";
  if (!isAlive(pid)) return "stopped";
  if (!await verifyOwner(pid) || readOwner() !== owner) return "unverified";
  try { signal(pid, "SIGTERM"); } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? "stopped" : "failed";
  }
  const wait = options.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  // The Relay may need two seconds to reap a provider child and three more
  // seconds to drain a collection; leave room for scheduling and cleanup.
  const timeoutMs = options.timeoutMs ?? 10_000;
  const intervalMs = options.intervalMs ?? 50;
  for (let elapsed = 0; ; elapsed += intervalMs) {
    const currentOwner = readOwner();
    if (currentOwner !== undefined && currentOwner !== owner) return "replaced";
    if (!isAlive(pid)) return "stopped";
    if (elapsed >= timeoutMs) return "timeout";
    await wait(Math.min(intervalMs, timeoutMs - elapsed));
  }
}

/** A TUI running under Bun preserves the Node executable that launched it. */
export function relayNodeExecutable(execPath: string, isBun: boolean, env: NodeJS.ProcessEnv): string {
  return isBun ? env.SESSIONBAR_NODE_EXEC_PATH || "node" : execPath;
}

export function waitForChildSpawn(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    child.once("spawn", () => {
      if (settled) return;
      settled = true;
      child.unref();
      resolve();
    });
    // Keep an error listener after spawn too: a detached child must not turn a
    // later process error into an uncaught exception in its former parent.
    child.on("error", error => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

export async function fetchRelayHealth(
  fetcher: (url: string, init: RequestInit) => Promise<Response>,
  url: string,
  timeoutMs = 1_500,
): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(url, { signal: controller.signal });
    if (!response.ok) return undefined;
    return await response.json();
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
