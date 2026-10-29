import assert from "node:assert/strict";
import test from "node:test";
import {
  HARNESS_INPUT_MATRIX,
  harnessInputsFor,
} from "../dist/harness/harnessInputMatrix.js";
import {
  appDataRoot,
  filesystemHarnessArtifacts,
  matchesHarnessArtifact,
} from "../dist/harness/filesystemHarnessAdapters.js";
import { harnessDedupeKey } from "../dist/harness/harnessSourceIdentity.js";

test("DSH is a separate filesystem harness with bounded cross-platform checkpoint paths", () => {
  assert.ok(harnessInputsFor("dsh").some(input => input.transport === "filesystem" && input.contract === "session_snapshot"));
  for (const context of [
    { platform: "darwin", home: "/Users/test", env: {} },
    { platform: "linux", home: "/home/test", env: {} },
    { platform: "win32", home: "C:\\Users\\test", env: {} },
  ]) {
    const artifact = filesystemHarnessArtifacts(context).find(item => item.harness === "dsh");
    assert.ok(artifact);
    const separator = context.platform === "win32" ? "\\" : "/";
    assert.equal(matchesHarnessArtifact(artifact, artifact.roots[0] + separator + "session-one.json"), true);
    assert.equal(matchesHarnessArtifact(artifact, artifact.roots[0] + separator + "nested" + separator + "session.json"), false);
  }
});

test("Desktop harnesses are explicit filesystem inputs rather than generic discovery", () => {
  const claude = harnessInputsFor("claude-desktop");
  const workbuddy = harnessInputsFor("workbuddy-desktop");

  assert.ok(claude.some(input => input.transport === "filesystem" && input.contract === "session_snapshot"));
  assert.ok(workbuddy.some(input => input.transport === "filesystem" && input.contract === "session_registry"));
  assert.equal(claude.some(input => input.transport === "hook"), false);
  assert.equal(workbuddy.some(input => input.transport === "hook"), false);
  assert.ok(HARNESS_INPUT_MATRIX.some(input => input.harness === "codex" && input.transport === "hook"));
  assert.ok(HARNESS_INPUT_MATRIX.some(input => input.harness === "codex" && input.transport === "filesystem"));
});

test("Cursor is a native hook input and keeps Grok model identity as enrichment", () => {
  const cursor = harnessInputsFor("cursor");

  assert.ok(cursor.some(input => input.transport === "hook" && input.contract === "native_hook_payload"));
  assert.match(cursor[0].notes, /conversation_id/);
  assert.match(cursor[0].notes, /model/i);
});

test("application data roots follow each desktop platform convention", () => {
  assert.equal(
    appDataRoot("Claude-3p", { platform: "darwin", home: "/Users/test", env: {} }),
    "/Users/test/Library/Application Support/Claude-3p",
  );
  assert.equal(
    appDataRoot("Claude-3p", { platform: "linux", home: "/home/test", env: { XDG_CONFIG_HOME: "/config" } }),
    "/config/Claude-3p",
  );
  assert.equal(
    appDataRoot("Claude-3p", { platform: "win32", home: "C:\\Users\\test", env: { APPDATA: "D:\\Profiles\\test\\AppData\\Roaming" } }),
    "D:\\Profiles\\test\\AppData\\Roaming\\Claude-3p",
  );
});

test("filesystem descriptors identify bounded session artifacts on Windows and POSIX", () => {
  const windows = filesystemHarnessArtifacts({
    platform: "win32",
    home: "C:\\Users\\test",
    env: { APPDATA: "C:\\Users\\test\\AppData\\Roaming" },
  });
  const workbuddy = windows.find(item => item.id === "workbuddy-desktop-live-registry");
  assert.ok(workbuddy);
  assert.equal(matchesHarnessArtifact(workbuddy, "C:\\Users\\test\\.workbuddy\\sessions\\abc.json"), true);
  assert.equal(matchesHarnessArtifact(workbuddy, "C:\\Users\\test\\.workbuddy\\traces\\trace_1.json"), false);

  const linux = filesystemHarnessArtifacts({ platform: "linux", home: "/home/test", env: {} });
  const codex = linux.find(item => item.id === "codex-session-jsonl");
  assert.ok(codex);
  assert.equal(matchesHarnessArtifact(codex, "/home/test/.codex/sessions/2026/08/20/session.jsonl"), true);
});

test("WorkBuddy SQLite notifications include WAL writes but not noisy shared-memory or arbitrary DB files", () => {
  const artifacts = filesystemHarnessArtifacts({ platform: "linux", home: "/home/test", env: {} });
  const database = artifacts.find(item => item.id === "workbuddy-desktop-database");
  assert.ok(database);
  assert.equal(matchesHarnessArtifact(database, "/home/test/.workbuddy/workbuddy.db"), true);
  assert.equal(matchesHarnessArtifact(database, "/home/test/.workbuddy/workbuddy.db-wal"), true);
  assert.equal(matchesHarnessArtifact(database, "/home/test/.workbuddy/workbuddy.db-shm"), false);
  assert.equal(matchesHarnessArtifact(database, "/home/test/.workbuddy/other.db"), false);
});

test("dedupe identity is transport independent when adapters share a native event id", () => {
  const base = {
    harness: "codex",
    native_session_id: "session-1",
    native_event_id: "event-9",
    event_kind: "tool.execute.after",
  };
  assert.equal(
    harnessDedupeKey({ ...base, transport: "hook" }),
    harnessDedupeKey({ ...base, transport: "filesystem", artifact: "/tmp/session.jsonl", cursor: "840" }),
  );
});

test("semantic fingerprints bridge hook and filesystem events without native ids", () => {
  const base = {
    harness: "claude-code",
    native_session_id: "session-2",
    event_kind: "tool.execute.before",
    semantic_fingerprint: "tool:Bash:npm-test:2026-08-20T07:00:01.000Z",
  };
  assert.equal(
    harnessDedupeKey({ ...base, transport: "hook" }),
    harnessDedupeKey({ ...base, transport: "filesystem", artifact: "/tmp/transcript.jsonl", cursor: "920" }),
  );
});

test("artifact cursor is a last-resort identity and remains source-specific", () => {
  const base = {
    harness: "workbuddy-desktop",
    native_session_id: "session-3",
    event_kind: "snapshot.changed",
    transport: "filesystem",
    artifact: "/tmp/session.json",
  };
  assert.notEqual(harnessDedupeKey({ ...base, cursor: "1" }), harnessDedupeKey({ ...base, cursor: "2" }));
});
