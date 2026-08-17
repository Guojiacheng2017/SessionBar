import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { discoverWorkBuddyDesktopSessions } from "../dist/sessions/workbuddyDesktopDiscovery.js";

function fixture(root, pid, extra = {}) {
  const sessions = join(root, "sessions");
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, `${pid}.json`), JSON.stringify({
    pid,
    sessionId: `conversation-${pid}`,
    cwd: `/Users/test/projects/project-${pid}`,
    startedAt: 1_000,
    lastHeartbeat: 2_000,
    updatedAt: 2_000,
    kind: "interactive",
    ...extra,
  }));
}

test("discovers each live WorkBuddy Desktop interactive session", () => {
  const root = mkdtempSync(join(tmpdir(), "sessionbar-workbuddy-"));
  fixture(root, 101);
  fixture(root, 102);

  const sessions = discoverWorkBuddyDesktopSessions({ root, now: 2_500, activeMs: 1_000, retentionMs: 10_000 });

  assert.equal(sessions.length, 2);
  assert.deepEqual(sessions.map(session => session.session_id).sort(), [
    "workbuddy-conversation-101__project-101",
    "workbuddy-conversation-102__project-102",
  ]);
  assert.ok(sessions.every(session => session.session_type === "WorkBuddy Desktop"));
  assert.ok(sessions.every(session => session.status === "working"));
  assert.equal(sessions[0].source, "native_registry");
});

test("keeps a recent stopped session as idle and drops expired entries", () => {
  const root = mkdtempSync(join(tmpdir(), "sessionbar-workbuddy-"));
  fixture(root, 201, { lastHeartbeat: 2_000 });
  fixture(root, 202, { lastHeartbeat: 500 });

  const sessions = discoverWorkBuddyDesktopSessions({ root, now: 4_000, activeMs: 500, retentionMs: 3_000 });

  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].status, "idle");
  assert.equal(sessions[0].timestamp, 2_000);
});

test("ignores prewarm, host-only, and malformed registry entries", () => {
  const root = mkdtempSync(join(tmpdir(), "sessionbar-workbuddy-"));
  fixture(root, 301, { kind: "prewarm" });
  fixture(root, 302, { cwd: "/private/tmp/workbuddy-host-cli/__workbuddy_cli_host__-1" });
  mkdirSync(join(root, "sessions"), { recursive: true });
  writeFileSync(join(root, "sessions", "bad.json"), "not json");

  assert.deepEqual(discoverWorkBuddyDesktopSessions({ root, now: 2_500 }), []);
});

test("deduplicates duplicate pid records for the same WorkBuddy conversation", () => {
  const root = mkdtempSync(join(tmpdir(), "sessionbar-workbuddy-"));
  fixture(root, 401, { sessionId: "same", lastHeartbeat: 2_000 });
  fixture(root, 402, { sessionId: "same", lastHeartbeat: 3_000, cwd: "/Users/test/projects/newest" });

  const sessions = discoverWorkBuddyDesktopSessions({ root, now: 3_500, retentionMs: 10_000 });

  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].project, basename("/Users/test/projects/newest"));
  assert.equal(sessions[0].timestamp, 3_000);
});

test("retains a recently closed WorkBuddy session from the desktop registry", () => {
  const root = mkdtempSync(join(tmpdir(), "sessionbar-workbuddy-"));
  mkdirSync(join(root, "app"), { recursive: true });
  writeFileSync(join(root, "app", "sessions.json"), JSON.stringify({
    version: 1,
    updatedAt: "1970-01-01T00:00:04.000Z",
    sessions: [{
      conversationId: "recent-conversation",
      workDir: "/Users/test/projects/recent-project",
      startedAt: "1970-01-01T00:00:02.000Z",
      resumedAt: "1970-01-01T00:00:03.000Z",
    }],
  }));

  const [session] = discoverWorkBuddyDesktopSessions({ root, now: 4_000, retentionMs: 2_000 });

  assert.equal(session.session_id, "workbuddy-recent-conversation__recent-project");
  assert.equal(session.status, "idle");
  assert.equal(session.timestamp, 3_000);
});

test("live WorkBuddy registry takes priority over the retained desktop record", () => {
  const root = mkdtempSync(join(tmpdir(), "sessionbar-workbuddy-"));
  fixture(root, 501, { sessionId: "same", lastHeartbeat: 4_000 });
  mkdirSync(join(root, "app"), { recursive: true });
  writeFileSync(join(root, "app", "sessions.json"), JSON.stringify({
    sessions: [{
      conversationId: "same",
      workDir: "/Users/test/projects/old-project",
      startedAt: "1970-01-01T00:00:01.000Z",
      resumedAt: "1970-01-01T00:00:03.000Z",
    }],
  }));

  const [session] = discoverWorkBuddyDesktopSessions({ root, now: 4_500, retentionMs: 10_000 });

  assert.equal(session.status, "working");
  assert.equal(session.project, "project-501");
  assert.equal(session.timestamp, 4_000);
});

test("uses WorkBuddy ai-title as the session name without exposing generated date folders", () => {
  const root = mkdtempSync(join(tmpdir(), "sessionbar-workbuddy-"));
  fixture(root, 601, {
    sessionId: "named",
    cwd: "/Users/test/WorkBuddy/2026-08-17-15-27-26",
  });
  const projectDir = join(root, "projects", "Users-test-WorkBuddy-2026-08-17-15-27-26");
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, "named.jsonl"), [
    JSON.stringify({ type: "message", role: "user" }),
    JSON.stringify({ type: "ai-title", aiTitle: "Review deployment logs" }),
  ].join("\n"));

  const [session] = discoverWorkBuddyDesktopSessions({ root, now: 2_500, retentionMs: 10_000 });

  assert.equal(session.project, "WorkBuddy");
  assert.equal(session.session_name, "Review deployment logs");
  assert.equal(session.task_name, "Review deployment logs");
});

test("uses a stable fallback for placeholder WorkBuddy titles", () => {
  const root = mkdtempSync(join(tmpdir(), "sessionbar-workbuddy-"));
  fixture(root, 602, {
    sessionId: "untitled",
    cwd: "/Users/test/WorkBuddy/2026-08-17-15-27-26",
  });
  const projectDir = join(root, "projects", "Users-test-WorkBuddy-2026-08-17-15-27-26");
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, "untitled.jsonl"), JSON.stringify({ type: "ai-title", aiTitle: "Start new conversation" }));

  const [session] = discoverWorkBuddyDesktopSessions({ root, now: 2_500, retentionMs: 10_000 });

  assert.equal(session.project, "WorkBuddy");
  assert.equal(session.session_name, "WorkBuddy session");
});
