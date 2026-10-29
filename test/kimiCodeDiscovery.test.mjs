import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverKimiCodeSessions } from "../dist/sessions/kimiCodeDiscovery.js";

function fixture(root, id, extra = {}) {
  const workDir = extra.cwd || `/Users/test/projects/${id}`;
  const sessionDir = join(root, "sessions", "wd-test", id);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, "state.json"), JSON.stringify({
    id,
    version: 2,
    cwd: workDir,
    createdAt: 1_000,
    updatedAt: 2_000,
    archived: false,
    title: "Implement Kimi adapter",
    lastTurnReason: "completed",
    ...extra,
  }));
  return { sessionId: id, sessionDir, workDir };
}

function writeIndex(root, entries) {
  writeFileSync(join(root, "session_index.jsonl"), entries.map(entry => JSON.stringify(entry)).join("\n"));
}

test("discovers Kimi Code sessions from the v2 session registry", () => {
  const root = mkdtempSync(join(tmpdir(), "sessionbar-kimi-code-"));
  const entry = fixture(root, "session_123", { cwd: "/Users/test/projects/alpha" });
  writeIndex(root, [entry]);

  const [session] = discoverKimiCodeSessions({ root, now: 2_500, retentionMs: 10_000 });

  assert.equal(session.session_id, "kimi-code-session_123__alpha");
  assert.equal(session.session_type, "Kimi Code");
  assert.equal(session.source, "filesystem_registry");
  assert.equal(session.project, "alpha");
  assert.equal(session.project_path, "/Users/test/projects/alpha");
  assert.equal(session.session_name, "Implement Kimi adapter");
  assert.equal(session.status, "idle");
});

test("marks a recent unfinished Kimi Code turn as working", () => {
  const root = mkdtempSync(join(tmpdir(), "sessionbar-kimi-code-"));
  const entry = fixture(root, "session_live", { lastTurnReason: undefined, updatedAt: 4_000 });
  writeIndex(root, [entry]);

  const [session] = discoverKimiCodeSessions({ root, now: 4_500, activeMs: 1_000, retentionMs: 10_000 });

  assert.equal(session.status, "working");
  assert.equal(session.task_name, "Implement Kimi adapter");
});

test("does not expose prompt-like generated titles", () => {
  const root = mkdtempSync(join(tmpdir(), "sessionbar-kimi-code-"));
  const entry = fixture(root, "session_prompt_title", {
    title: "# Instructions (read first)\nTreat this prompt as private session context.",
  });
  writeIndex(root, [entry]);

  const [session] = discoverKimiCodeSessions({ root, now: 2_500, retentionMs: 10_000 });

  assert.equal(session.session_name, "Kimi Code session");
  assert.equal(session.task_name, "Kimi Code session");
});

test("drops archived, malformed, and expired Kimi Code sessions", () => {
  const root = mkdtempSync(join(tmpdir(), "sessionbar-kimi-code-"));
  const archived = fixture(root, "session_archived", { archived: true });
  const expired = fixture(root, "session_expired", { updatedAt: 500 });
  mkdirSync(join(root, "sessions", "wd-test", "session_bad"), { recursive: true });
  writeFileSync(join(root, "sessions", "wd-test", "session_bad", "state.json"), "not json");
  writeIndex(root, [archived, expired, {
    sessionId: "session_bad",
    sessionDir: join(root, "sessions", "wd-test", "session_bad"),
    workDir: "/Users/test/projects/bad",
  }]);

  assert.deepEqual(discoverKimiCodeSessions({ root, now: 4_000, retentionMs: 2_000 }), []);
});

test("rejects session directories outside the Kimi Code root", () => {
  const root = mkdtempSync(join(tmpdir(), "sessionbar-kimi-code-"));
  const outside = mkdtempSync(join(tmpdir(), "sessionbar-kimi-outside-"));
  writeFileSync(join(outside, "state.json"), JSON.stringify({
    id: "session_escape",
    cwd: "/Users/test/projects/escape",
    updatedAt: 2_000,
  }));
  writeIndex(root, [{
    sessionId: "session_escape",
    sessionDir: outside,
    workDir: "/Users/test/projects/escape",
  }]);

  assert.deepEqual(discoverKimiCodeSessions({ root, now: 2_500, retentionMs: 10_000 }), []);
});

test("Kimi registry accepts Windows project paths without guessing a CLI client", () => {
  const root = mkdtempSync(join(tmpdir(), "sessionbar-kimi-windows-"));
  const entry = fixture(root, "session_windows", { cwd: "C:\\work\\alpha" });
  writeIndex(root, [entry]);
  const [session] = discoverKimiCodeSessions({ root, now: 2500, retentionMs: 10_000 });
  assert.ok(session);
  assert.equal(session.project, "alpha");
  assert.equal(session.project_path, "C:\\work\\alpha");
  assert.equal(session.session_type, "Kimi Code");
});
