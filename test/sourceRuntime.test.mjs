import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileSourceRuntime,
  laneIntervalMs,
  pathInsideRoot,
  watchedPath,
} from "../dist/runtime/sourceRuntime.js";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitFor = async (predicate, timeoutMs = 2_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition not reached before timeout");
    await sleep(20);
  }
};

test("filesystem notifications debounce a burst into one targeted adapter refresh", async () => {
  const reads = [];
  const runtime = new FileSourceRuntime([{
    id: "codex-files",
    lane: "session",
    roots: ["/tmp/codex/sessions"],
    accepts: path => path.endsWith(".jsonl"),
    read: change => { reads.push(change); return { ok: true, value: change.paths }; },
    apply: () => true,
  }], { debounceMs: 25, reconcileMs: 10_000 });

  runtime.notify("/tmp/codex/sessions", "one.jsonl");
  runtime.notify("/tmp/codex/sessions", "one.jsonl");
  runtime.notify("/tmp/codex/sessions", "two.jsonl");
  await sleep(60);
  runtime.close();

  assert.equal(reads.length, 1);
  assert.equal(reads[0].kind, "targeted");
  assert.deepEqual(reads[0].paths.sort(), ["/tmp/codex/sessions/one.jsonl", "/tmp/codex/sessions/two.jsonl"]);
});

test("native filesystem notifications trigger a targeted refresh", async t => {
  const root = mkdtempSync(join(tmpdir(), "sessionbar-watch-"));
  const reads = [];
  const errors = [];
  const runtime = new FileSourceRuntime([{
    id: "files", lane: "session", roots: [root], accepts: path => path.endsWith(".jsonl"),
    read: change => { reads.push(change); return { ok: true, value: [] }; }, apply: () => false,
  }], { debounceMs: 30, reconcileMs: 10_000, onError: (_id, error) => errors.push(error) });
  try {
    runtime.start();
    await sleep(30);
    writeFileSync(join(root, "session.jsonl"), "{}\n");
    await waitFor(() => reads.length > 0 || errors.length > 0);
    if (errors.some(error => error?.code === "EMFILE" || error?.code === "ENOSPC")) {
      t.skip("OS filesystem watcher quota is exhausted");
      return;
    }
    assert.deepEqual(errors, []);
    assert.equal(reads[0].kind, "targeted");
    assert.ok(reads[0].paths.some(path => path.endsWith("session.jsonl")));
  } finally {
    runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("changed paths dispatch only to the matching source adapter", async () => {
  const calls = [];
  const adapter = (id, root, extension) => ({
    id, lane: "session", roots: [root], accepts: path => path.endsWith(extension),
    read: change => { calls.push([id, ...change.paths]); return { ok: true, value: [] }; },
    apply: () => false,
  });
  const runtime = new FileSourceRuntime([
    adapter("codex", "/tmp/codex", ".jsonl"),
    adapter("desktop", "/tmp/desktop", ".json"),
  ], { debounceMs: 10, reconcileMs: 10_000 });

  runtime.notify("/tmp/codex", "2026/session.jsonl");
  await sleep(30);
  runtime.close();

  assert.deepEqual(calls, [["codex", "/tmp/codex/2026/session.jsonl"]]);
});

test("missing OS event filenames upgrade only covered sources to reconciliation", async () => {
  const calls = [];
  const runtime = new FileSourceRuntime([{
    id: "desktop", lane: "session", roots: ["/tmp/desktop/registry"], accepts: () => false,
    read: change => { calls.push(change); return { ok: true, value: [] }; }, apply: () => false,
  }, {
    id: "other", lane: "session", roots: ["/tmp/other"], accepts: () => false,
    read: change => { calls.push(change); return { ok: true, value: [] }; }, apply: () => false,
  }], { debounceMs: 10, reconcileMs: 10_000 });

  runtime.notify("/tmp/desktop", null);
  await sleep(30);
  runtime.close();

  assert.deepEqual(calls, [{ kind: "reconcile", paths: [] }]);
});

test("watch paths normalize recursive events across POSIX and Windows", () => {
  assert.equal(watchedPath("/home/user/.codex/sessions", "2026/08/a.jsonl", "linux"), "/home/user/.codex/sessions/2026/08/a.jsonl");
  assert.equal(watchedPath("C:\\Users\\me\\.codex\\sessions", "2026\\08\\a.jsonl", "win32"), "C:\\Users\\me\\.codex\\sessions\\2026\\08\\a.jsonl");
  assert.equal(pathInsideRoot("C:\\Users\\ME\\.codex\\sessions\\a.jsonl", "c:\\users\\me\\.codex\\sessions", "win32"), true);
  assert.equal(pathInsideRoot("/home/user/.codex-other/a.jsonl", "/home/user/.codex", "linux"), false);
});

test("runtime lanes keep session reconciliation stable while background work backs off", () => {
  assert.equal(laneIntervalMs("session", true), laneIntervalMs("session", false));
  assert.ok(laneIntervalMs("system", false) > laneIntervalMs("system", true));
  assert.ok(laneIntervalMs("provider", false) > laneIntervalMs("provider", true));
  assert.ok(laneIntervalMs("cost", false) > laneIntervalMs("cost", true));
  assert.notEqual(laneIntervalMs("system", true), laneIntervalMs("provider", true));
});
