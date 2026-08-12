import assert from "node:assert/strict";
import test from "node:test";
import { createSSETransport } from "../dist/sseTransport.js";

function deferred() {
  let resolve;
  const promise = new Promise(next => { resolve = next; });
  return { promise, resolve };
}

test("an idle SSE read returns at its deadline without starting a second read", async () => {
  const pendingRead = deferred();
  let reads = 0;
  const reader = {
    read() {
      reads += 1;
      return pendingRead.promise;
    },
    cancel: async () => undefined,
  };
  const transport = createSSETransport(async () => reader);

  const startedAt = Date.now();
  assert.equal(await transport.next(20), "timeout");
  assert.ok(Date.now() - startedAt < 250, "stalled read exceeded its deadline");
  assert.equal(reads, 1);

  pendingRead.resolve({ done: false, value: "data: [{\"session_id\":\"a\"}]\n\n" });
  assert.deepEqual(await transport.next(100), [{ session_id: "a" }]);
  assert.equal(reads, 1);
  transport.close();
});

test("repeated idle deadlines reuse one read and release timeout waiters", async () => {
  const pendingRead = deferred();
  let reads = 0;
  const reader = {
    read() {
      reads += 1;
      return pendingRead.promise;
    },
    cancel: async () => undefined,
  };
  const transport = createSSETransport(async () => reader);

  for (let index = 0; index < 50; index += 1) {
    assert.equal(await transport.next(1), "timeout");
  }
  assert.equal(reads, 1);

  pendingRead.resolve({ done: false, value: "data: [{\"session_id\":\"quiet\"}]\n\n" });
  assert.deepEqual(await transport.next(100), [{ session_id: "quiet" }]);
  assert.equal(reads, 1);
  transport.close();
});

test("closing SSE transport aborts and cancels an active read", async () => {
  const pendingRead = deferred();
  let signal;
  let cancels = 0;
  const reader = {
    read: () => pendingRead.promise,
    async cancel() {
      cancels += 1;
      pendingRead.resolve({ done: true, value: undefined });
    },
  };
  const transport = createSSETransport(async nextSignal => {
    signal = nextSignal;
    return reader;
  });

  const active = transport.next(1_000);
  await Promise.resolve();
  await Promise.resolve();
  transport.close();

  assert.equal(await active, "closed");
  assert.equal(signal.aborted, true);
  assert.equal(cancels, 1);
});
