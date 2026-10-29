import assert from "node:assert/strict";
import test from "node:test";
import { mergeCodexDiscovery, mergeCodexHookSession, mergeCodexThreadMetadata } from "../dist/sessions/codexSessionMerge.js";

const hookSession = {
  session_id: "11111111-1111-4111-8111-111111111111__atlas",
  session_type: "Codex",
  source: "hook",
  status: "working",
  task_name: "Working",
  timestamp: 1_700_000_000_000,
  project: "atlas",
  project_path: "/projects/atlas",
};

const jsonlSession = {
  session_id: "codex-11111111-1111-4111-8111-111111111111__atlas",
  session_type: "Codex",
  source: "codex_jsonl",
  status: "working",
  task_name: "running: npm test",
  activity_tail: ["tool: npm test", "done: npm test"],
  timestamp: 1_700_000_010_000,
  project: "atlas",
  project_path: "/projects/atlas",
};

test("codex jsonl enriches a hook-backed session instead of creating a duplicate row", () => {
  const sessions = { [hookSession.session_id]: { ...hookSession } };

  mergeCodexDiscovery(sessions, [jsonlSession]);

  assert.deepEqual(Object.keys(sessions), [hookSession.session_id]);
  assert.equal(sessions[hookSession.session_id].session_id, hookSession.session_id);
  assert.equal(sessions[hookSession.session_id].task_name, "running: npm test");
  assert.deepEqual(sessions[hookSession.session_id].activity_tail, ["tool: npm test", "done: npm test"]);
});

test("codex jsonl remains standalone when no hook-backed session exists for the project", () => {
  const sessions = {};

  mergeCodexDiscovery(sessions, [jsonlSession]);

  assert.deepEqual(Object.keys(sessions), [jsonlSession.session_id]);
  assert.equal(sessions[jsonlSession.session_id].task_name, "running: npm test");
});

test("codex jsonl removes stale standalone discovery after a hook-backed merge", () => {
  const sessions = {
    [hookSession.session_id]: { ...hookSession },
    [jsonlSession.session_id]: { ...jsonlSession, task_name: "old duplicate" },
  };

  mergeCodexDiscovery(sessions, [jsonlSession]);

  assert.deepEqual(Object.keys(sessions), [hookSession.session_id]);
  assert.equal(sessions[hookSession.session_id].task_name, "running: npm test");
});

test("a late Codex hook immediately absorbs its matching JSONL discovery", () => {
  const id = "01a03331-e5b4-7262-aec6-c1486c2fc971";
  const discoveryId = `codex-${id}__atlas`;
  const hookId = `${id}__atlas`;
  const sessions = { [discoveryId]: { ...jsonlSession, session_id: discoveryId } };
  mergeCodexHookSession(sessions, { ...hookSession, session_id: hookId, project: undefined, project_path: undefined });
  assert.equal(sessions[discoveryId], undefined);
  assert.equal(sessions[hookId].source, "hook");
  assert.equal(sessions[hookId].task_name, jsonlSession.task_name);
});

test("codex completion makes its matching hook-backed session idle", () => {
  const sessions = {
    [hookSession.session_id]: { ...hookSession, session_id: "11111111-1111-4111-8111-111111111111__atlas" },
  };
  const completed = { ...jsonlSession, status: "idle", task_name: "Ready", activity_tail: [] };

  mergeCodexDiscovery(sessions, [completed]);

  const session = Object.values(sessions)[0];
  assert.equal(session.status, "idle");
  assert.equal(session.task_name, "Ready");
});

test("codex discovery keeps separate sessions in the same project", () => {
  const firstId = "11111111-1111-4111-8111-111111111111";
  const secondId = "22222222-2222-4222-8222-222222222222";
  const sessions = {
    [`${firstId}__atlas`]: { ...hookSession, session_id: `${firstId}__atlas` },
    [`${secondId}__atlas`]: { ...hookSession, session_id: `${secondId}__atlas`, timestamp: hookSession.timestamp + 1 },
  };
  const discoveries = [
    { ...jsonlSession, session_id: `codex-${firstId}__atlas`, task_name: "first task" },
    { ...jsonlSession, session_id: `codex-${secondId}__atlas`, task_name: "second task" },
  ];

  mergeCodexDiscovery(sessions, discoveries);

  assert.equal(Object.keys(sessions).length, 2);
  assert.equal(sessions[`${firstId}__atlas`].task_name, "first task");
  assert.equal(sessions[`${secondId}__atlas`].task_name, "second task");
});

test("an unmatched hook does not collapse multiple discoveries in the same project", () => {
  const firstId = "11111111-1111-4111-8111-111111111111";
  const secondId = "22222222-2222-4222-8222-222222222222";
  const sessions = {
    ["codex-legacy-hook__atlas"]: {
      ...hookSession,
      session_id: "codex-legacy-hook__atlas",
    },
  };

  mergeCodexDiscovery(sessions, [
    { ...jsonlSession, session_id: `codex-${firstId}__atlas`, task_name: "first task" },
    { ...jsonlSession, session_id: `codex-${secondId}__atlas`, task_name: "second task" },
  ]);

  assert.deepEqual(Object.keys(sessions).sort(), [
    "codex-legacy-hook__atlas",
    `codex-${firstId}__atlas`,
    `codex-${secondId}__atlas`,
  ].sort());
});

test("Codex app-server names enrich the matching UUID instead of another session in the same project", () => {
  const firstId = "11111111-1111-4111-8111-111111111111";
  const secondId = "22222222-2222-4222-8222-222222222222";
  const sessions = {
    [`codex-${firstId}__atlas`]: {
      ...hookSession,
      session_id: `codex-${firstId}__atlas`,
    },
    [`codex-${secondId}__atlas`]: {
      ...hookSession,
      session_id: `codex-${secondId}__atlas`,
      timestamp: hookSession.timestamp + 1,
    },
  };

  mergeCodexThreadMetadata(sessions, [{
    threadId: firstId,
    sessionName: "First renamed task",
    project: "atlas",
    projectPath: "/projects/atlas",
    updatedAt: 1_700_000_020_000,
  }]);

  assert.equal(sessions[`codex-${firstId}__atlas`].session_name, "First renamed task");
  assert.equal(sessions[`codex-${secondId}__atlas`].session_name, undefined);
  assert.equal(sessions[`codex-${firstId}__atlas`].status, "working");
});

test("empty metadata and repeated discovery retain a known session name", () => {
  const sessions = { [jsonlSession.session_id]: { ...jsonlSession, session_name: "Known name" } };
  mergeCodexDiscovery(sessions, [jsonlSession]);
  mergeCodexThreadMetadata(sessions, [{
    threadId: "11111111-1111-4111-8111-111111111111", sessionName: " ", project: "", projectPath: "", updatedAt: 0,
  }]);
  assert.equal(sessions[jsonlSession.session_id].session_name, "Known name");
  mergeCodexHookSession(sessions, { ...hookSession });
  assert.equal(sessions[hookSession.session_id].session_name, "Known name");
  assert.equal(Object.keys(sessions).length, 1);
});

test("hook aliases of one native thread retain its name and never add a session", () => {
  const sessions = { [hookSession.session_id]: { ...hookSession, session_name: "Known name" } };
  const alias = { ...hookSession, session_id: "11111111-1111-4111-8111-111111111111-deadbeef__Renamed project" };
  mergeCodexHookSession(sessions, alias);
  mergeCodexDiscovery(sessions, [jsonlSession, { ...jsonlSession, session_id: "codex-11111111-1111-4111-8111-111111111111__Renamed project" }]);
  assert.equal(Object.keys(sessions).length, 1);
  assert.equal(Object.values(sessions)[0].session_name, "Known name");
});
