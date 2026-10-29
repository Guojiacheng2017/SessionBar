import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { relayNodeExecutable, stopRelayProcess, waitForChildSpawn, fetchRelayHealth } from "../dist/server/relayLifecycle.js";

test("relay stop waits for exit and never escalates signals", async () => {
  let running = true;
  let elapsed = 0;
  const signals = [];
  const result = await stopRelayProcess({
    pid: 101, owner: "101:1", readOwner: () => "101:1", isAlive: () => running,
    verifyOwner: async () => true,
    signal: (pid, signal) => signals.push([pid, signal]),
    wait: async ms => { elapsed += ms; if (elapsed >= 600) running = false; },
    timeoutMs: 1_000, intervalMs: 100,
  });
  assert.equal(result, "stopped");
  assert.equal(elapsed, 600);
  assert.deepEqual(signals, [[101, "SIGTERM"]]);
});

test("stop timeout is a failure with no SIGKILL or state deletion", async () => {
  const signals = [];
  let elapsed = 0;
  assert.equal(await stopRelayProcess({
    pid: 101, owner: "101:1", readOwner: () => "101:1", isAlive: () => true,
    verifyOwner: async () => true, signal: (_pid, signal) => signals.push(signal),
    wait: async ms => { elapsed += ms; }, timeoutMs: 300, intervalMs: 100,
  }), "timeout");
  assert.equal(elapsed, 300);
  assert.deepEqual(signals, ["SIGTERM"]);
});

test("an uncertain process owner is never signalled", async () => {
  for (const patch of [{ pid: -1 }, { verifyOwner: async () => false }, { readOwner: () => "new-owner" }]) {
    const signals = [];
    assert.equal(await stopRelayProcess({
      pid: 101, owner: "101:1", readOwner: () => "101:1", isAlive: () => true,
      verifyOwner: async () => true, signal: (...args) => signals.push(args), wait: async () => {},
      ...patch,
    }), "unverified");
    assert.deepEqual(signals, []);
  }
});

test("stop detects another relay taking ownership during shutdown", async () => {
  let owner = "101:1";
  const signals = [];
  assert.equal(await stopRelayProcess({
    pid: 101, owner, readOwner: () => owner, isAlive: () => true,
    verifyOwner: async () => true, signal: (...args) => signals.push(args),
    wait: async () => { owner = "202:2"; },
  }), "replaced");
  assert.equal(signals.length, 1);
});

test("owner is rechecked after asynchronous verification before signalling", async () => {
  let owner = "101:1";
  assert.equal(await stopRelayProcess({
    pid: 101, owner, readOwner: () => owner, isAlive: () => true,
    verifyOwner: async () => { owner = "202:2"; return true; },
    signal: () => assert.fail("must not signal a replaced owner"), wait: async () => {},
  }), "unverified");
});

test("removing shutdown markers does not count as process exit", async () => {
  let owner = "101:1";
  let running = true;
  let waits = 0;
  assert.equal(await stopRelayProcess({
    pid: 101, owner, readOwner: () => owner, isAlive: () => running,
    verifyOwner: async () => true, signal: () => { owner = undefined; },
    wait: async () => { if (++waits === 3) running = false; },
  }), "stopped");
  assert.equal(waits, 3);
});

test("permission errors do not report a successful stop", async () => {
  assert.equal(await stopRelayProcess({
    pid: 101, owner: "101:1", readOwner: () => "101:1", isAlive: () => true,
    verifyOwner: async () => true,
    signal: () => { throw Object.assign(new Error(), { code: "EPERM" }); },
  }), "failed");
});

test("missing process and a process exiting before SIGTERM are successful stops", async () => {
  const base = {
    pid: 101, owner: "101:1", readOwner: () => "101:1", verifyOwner: async () => true,
    wait: async () => {},
  };
  assert.equal(await stopRelayProcess({ ...base, isAlive: () => false, signal: () => assert.fail() }), "stopped");
  assert.equal(await stopRelayProcess({ ...base, isAlive: () => true, signal: () => { throw Object.assign(new Error(), { code: "ESRCH" }); } }), "stopped");
});

test("spawn readiness observes asynchronous errors and only unrefs after spawn", async () => {
  const child = new EventEmitter();
  let unrefCount = 0;
  child.unref = () => { unrefCount++; };
  const ready = waitForChildSpawn(child);
  assert.equal(unrefCount, 0);
  child.emit("spawn");
  await ready;
  assert.equal(unrefCount, 1);
  child.emit("error", new Error("late error is handled"));

  const failed = new EventEmitter();
  failed.unref = () => assert.fail();
  const rejected = waitForChildSpawn(failed);
  failed.emit("error", Object.assign(new Error("missing runtime"), { code: "ENOENT" }));
  await assert.rejects(rejected, { code: "ENOENT" });
});

test("Node executable survives Bun monitor reexecution", () => {
  assert.equal(relayNodeExecutable("/exact/node", false, {}), "/exact/node");
  assert.equal(relayNodeExecutable("/exact/bun", true, { SESSIONBAR_NODE_EXEC_PATH: "/original/node" }), "/original/node");
  assert.equal(relayNodeExecutable("/exact/bun", true, {}), "node");
});

test("health timeout includes a stalled response body", async () => {
  let cancelled = false;
  const health = await fetchRelayHealth(async (_url, { signal }) => ({
    ok: true,
    json: () => new Promise((_, reject) => signal.addEventListener("abort", () => {
      cancelled = true; reject(signal.reason);
    }, { once: true })),
  }), "http://127.0.0.1:1/health", 10);
  assert.equal(health, undefined);
  assert.equal(cancelled, true);
});

test("health keeps response metadata but rejects HTTP failures", async () => {
  assert.deepEqual(await fetchRelayHealth(async () => ({ ok: true, json: async () => ({ service: "sessionbar", runtime_config_id: "abc" }) }), "http://127.0.0.1/health"), { service: "sessionbar", runtime_config_id: "abc" });
  assert.equal(await fetchRelayHealth(async () => ({ ok: false }), "http://127.0.0.1/health"), undefined);
});
