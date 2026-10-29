import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  assert.ok(sessions.every(session => session.session_kind === "user"));
  assert.ok(sessions.every(session => session.status === "working"));
  assert.equal(sessions[0].source, "filesystem_registry");
});

test("targeted discovery reads only the changed WorkBuddy registry file", () => {
  const root = mkdtempSync(join(tmpdir(), "sessionbar-workbuddy-"));
  fixture(root, 101);
  fixture(root, 102);
  const sessions = discoverWorkBuddyDesktopSessions({
    root,
    paths: [join(root, "sessions", "102.json")],
    now: 2_500,
    activeMs: 1_000,
    retentionMs: 10_000,
  });
  assert.deepEqual(sessions.map(session => session.session_id), ["workbuddy-conversation-102__project-102"]);
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

function databaseFixture(t, rows) {
  const root = mkdtempSync(join(tmpdir(), "sessionbar-workbuddy-db-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = join(root, "workbuddy.db");
  execFileSync("sqlite3", [db, `
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, cwd TEXT NOT NULL, user_id TEXT NOT NULL,
      title TEXT, custom_title TEXT, status TEXT NOT NULL DEFAULT 'Pending',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      last_activity_at INTEGER, deleted_at INTEGER, transport TEXT NOT NULL DEFAULT 'local'
    );
  `]);
  const values = rows.map(row => ({
    id: "database-conversation", cwd: "/Users/test/projects/shared", user_id: "fixture-user",
    title: "Inspect build results", status: "Working", created_at: 1000,
    updated_at: 4000, last_activity_at: 4000, ...row,
  }));
  for (const row of values) {
    const json = JSON.stringify(row).replaceAll("'", "''");
    execFileSync("sqlite3", [db, `
      INSERT INTO sessions (id,cwd,user_id,title,custom_title,status,created_at,updated_at,last_activity_at,deleted_at,transport)
      SELECT json_extract(value,'$.id'),json_extract(value,'$.cwd'),json_extract(value,'$.user_id'),
        json_extract(value,'$.title'),json_extract(value,'$.custom_title'),json_extract(value,'$.status'),
        json_extract(value,'$.created_at'),json_extract(value,'$.updated_at'),
        json_extract(value,'$.last_activity_at'),json_extract(value,'$.deleted_at'),
        COALESCE(json_extract(value,'$.transport'),'local') FROM (SELECT '${json}' AS value);
    `]);
  }
  return root;
}

test("discovers current SQLite sessions without the obsolete JSON registries", t => {
  const root = databaseFixture(t, [
    { id: "first", custom_title: "Review's custom title" },
    { id: "second", title: "Check tests", status: "Completed", updated_at: 3000, last_activity_at: 3000 },
  ]);
  const db = join(root, "workbuddy.db");
  const hash = () => createHash("sha256").update(readFileSync(db)).digest("hex");
  const before = hash();
  const sessions = discoverWorkBuddyDesktopSessions({ root, now: 4500, activeMs: 1000, retentionMs: 10000 });
  assert.deepEqual(sessions.map(s => s.session_id), ["workbuddy-first__shared", "workbuddy-second__shared"]);
  assert.equal(sessions[0].session_type, "WorkBuddy Desktop");
  assert.equal(sessions[0].source, "filesystem_snapshot");
  assert.equal(sessions[0].status, "working");
  assert.equal(sessions[0].session_name, "Review's custom title");
  assert.equal(sessions[0].task_name, "Review's custom title");
  assert.equal(sessions[0].project_path, "/Users/test/projects/shared");
  assert.equal(sessions[0].timestamp, 4000);
  assert.equal(sessions[1].status, "idle");
  assert.equal(hash(), before);
});

test("maps only observed WorkBuddy states and does not turn recent completed tasks into working", t => {
  const cases = [
    ["Working", "working"], ["Planning", "working"], ["Pending", "idle"],
    ["Completed", "idle"], ["Terminated", "idle"], ["Failed", "error"],
    ["UnexpectedState", "idle"],
  ];
  const root = databaseFixture(t, cases.map(([status], i) => ({ id: `state-${i}`, status })));
  const sessions = discoverWorkBuddyDesktopSessions({ root, now: 4500, activeMs: 1000, retentionMs: 10000 });
  const states = new Map(sessions.map(s => [s.session_id, s.status]));
  for (const [i, [, expected]] of cases.entries()) assert.equal(states.get(`workbuddy-state-${i}__shared`), expected);
});

test("retains only recent nondeleted local sessions and never treats metadata updates as activity", t => {
  const root = databaseFixture(t, [
    { id: "recent" },
    { id: "old-but-edited", last_activity_at: 1000, updated_at: 4900 },
    { id: "deleted", deleted_at: 4300 },
    { id: "cloud", transport: "cloud" },
    { id: "host", cwd: "/private/tmp/__workbuddy_cli_host__-1" },
    { id: "future", last_activity_at: 9000, updated_at: 9000 },
    { id: "no-activity", last_activity_at: null, created_at: 1000, updated_at: 4900 },
  ]);
  const sessions = discoverWorkBuddyDesktopSessions({ root, now: 5000, activeMs: 1500, retentionMs: 2500 });
  assert.deepEqual(sessions.map(s => s.session_id), ["workbuddy-recent__shared"]);
});

test("applies the database limit to the newest eligible sessions and ages persisted working states", t => {
  const root = databaseFixture(t, [
    { id: "oldest", updated_at: 1500, last_activity_at: 1500 },
    { id: "middle", updated_at: 2500, last_activity_at: 2500 },
    { id: "newest", updated_at: 3500, last_activity_at: 3500 },
  ]);
  const sessions = discoverWorkBuddyDesktopSessions({ root, now: 5000, activeMs: 500, retentionMs: 10000, maxFiles: 2 });
  assert.deepEqual(sessions.map(s => s.session_id), ["workbuddy-newest__shared", "workbuddy-middle__shared"]);
  assert.ok(sessions.every(s => s.status === "idle"));
});

test("deduplicates legacy records against the newer SQLite session with the same identity", t => {
  const root = databaseFixture(t, [{ id: "same", custom_title: "Current title" }]);
  fixture(root, 701, { sessionId: "same", cwd: "/Users/test/projects/shared", lastHeartbeat: 2000 });
  const sessions = discoverWorkBuddyDesktopSessions({ root, now: 4500, activeMs: 1000, retentionMs: 10000 });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].timestamp, 4000);
  assert.equal(sessions[0].session_name, "Current title");
  assert.equal(sessions[0].session_kind, "user");
});

test("targeted legacy discovery does not query unrelated SQLite sessions", t => {
  const root = databaseFixture(t, [{ id: "database-only" }]);
  fixture(root, 702);
  const sessions = discoverWorkBuddyDesktopSessions({ root, paths: [join(root, "sessions", "702.json")], now: 4500 });
  assert.deepEqual(sessions.map(s => s.session_id), ["workbuddy-conversation-702__project-702"]);
});

test("targeted SQLite WAL discovery returns the current snapshot", t => {
  const root = databaseFixture(t, [{ id: "database-only" }]);
  const sessions = discoverWorkBuddyDesktopSessions({ root, paths: [join(root, "workbuddy.db-wal")], now: 4500 });
  assert.deepEqual(sessions.map(s => s.session_id), ["workbuddy-database-only__shared"]);
});

test("keeps legacy discovery usable when the optional database or SQLite executable is unavailable", t => {
  const root = databaseFixture(t, [{ id: "database-only" }]);
  fixture(root, 703);
  const sessions = discoverWorkBuddyDesktopSessions({ root, sqlitePath: join(root, "missing-sqlite"), now: 4500 });
  assert.deepEqual(sessions.map(s => s.session_id), ["workbuddy-conversation-703__project-703"]);
  writeFileSync(join(root, "workbuddy.db"), "unsupported database");
  assert.equal(discoverWorkBuddyDesktopSessions({ root, now: 4500 }).length, 1);
  rmSync(join(root, "workbuddy.db"));
  discoverWorkBuddyDesktopSessions({ root, now: 4500 });
  assert.equal(existsSync(join(root, "workbuddy.db")), false);
});

test("keeps Windows drive and UNC project paths independent in the SQLite schema", t => {
  const root = databaseFixture(t, [
    { id: "drive", cwd: "C:\\Users\\test\\WorkBuddy\\2026-10-29-00-10-00" },
    { id: "unc", cwd: "\\\\server\\share\\workspace" },
    { id: "relative", cwd: "projects/relative" },
  ]);
  const sessions = discoverWorkBuddyDesktopSessions({ root, now: 4500 });
  assert.deepEqual(sessions.map(s => s.session_id), ["workbuddy-drive__WorkBuddy", "workbuddy-unc__workspace"]);
  assert.equal(sessions[0].project_path, "C:\\Users\\test\\WorkBuddy\\2026-10-29-00-10-00");
  assert.equal(sessions[1].project_path, "\\\\server\\share\\workspace");
});

test("reads committed SQLite WAL changes without checkpointing the application database", async t => {
  const root = databaseFixture(t, [{ id: "database-only" }]);
  const db = join(root, "workbuddy.db");
  const writer = spawn("sqlite3", [db], { stdio: ["pipe", "pipe", "ignore"] });
  const exited = once(writer, "exit");
  let timeout;
  try {
    const ready = new Promise((resolve, reject) => {
      let output = "";
      writer.once("error", reject);
      writer.stdout.on("data", data => {
        output += data;
        if (output.includes("sessionbar-wal-ready")) resolve();
      });
      timeout = setTimeout(() => reject(new Error("SQLite WAL fixture did not become ready")), 3000);
    });
    writer.stdin.write(`
      PRAGMA journal_mode=WAL;
      PRAGMA wal_autocheckpoint=0;
      UPDATE sessions SET title='Committed in WAL', last_activity_at=4500, updated_at=4500;
      .print sessionbar-wal-ready
    `.replace(/^ +/gm, ""));
    await ready;
    clearTimeout(timeout);
    assert.equal(existsSync(`${db}-wal`), true);
    const before = createHash("sha256").update(readFileSync(db)).digest("hex");
    const [session] = discoverWorkBuddyDesktopSessions({ root, paths: [`${db}-wal`], now: 5000 });
    assert.equal(session?.session_name, "Committed in WAL");
    assert.equal(session?.timestamp, 4500);
    assert.equal(createHash("sha256").update(readFileSync(db)).digest("hex"), before);
  } finally {
    clearTimeout(timeout);
    writer.kill("SIGKILL");
    await exited;
  }
});
