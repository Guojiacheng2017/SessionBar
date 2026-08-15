import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireAppClient, acquireInstanceLock, configuredPort, readRuntimeState, releaseAppClient, releaseRuntimeState, writeRuntimeState } from "../dist/server/runtimeState.js";

test("configured port prefers SessionBar names and permits dynamic zero", () => {
  assert.equal(configuredPort({ SESSIONBAR_PORT: "7001", SESSION_BAR_PORT: "7002", PORT: "7003" }), 7001);
  assert.equal(configuredPort({ SESSION_BAR_PORT: "7002", PORT: "7003" }), 7002);
  assert.equal(configuredPort({ PORT: "0" }), 0);
  assert.equal(configuredPort({ SESSIONBAR_PORT: "invalid" }), undefined);
});

test("hooks are released only after the final live app client exits", () => {
  const home = mkdtempSync(join(tmpdir(), "sessionbar-app-clients-"));
  const alive = new Set([101, 202]);
  try {
    acquireAppClient(home, 101, pid => alive.has(pid));
    acquireAppClient(home, 202, pid => alive.has(pid));
    alive.delete(101);
    assert.equal(releaseAppClient(home, 101, pid => alive.has(pid)), false);
    alive.delete(202);
    assert.equal(releaseAppClient(home, 202, pid => alive.has(pid)), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("runtime state shares the selected port and lock prevents a second instance", () => {
  const home = mkdtempSync(join(tmpdir(), "sessionbar-runtime-state-"));
  try {
    const lock = acquireInstanceLock(home, process.pid);
    assert.notEqual(lock, undefined);
    assert.equal(acquireInstanceLock(home, process.pid), undefined);
    writeRuntimeState(home, { pid: process.pid, port: 54321, started_at: 123 });
    assert.deepEqual(readRuntimeState(home), { pid: process.pid, port: 54321, started_at: 0 });
    releaseRuntimeState(home, lock);
    assert.equal(readRuntimeState(home), undefined);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
