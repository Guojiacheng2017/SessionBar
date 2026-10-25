import assert from "node:assert/strict";
import test from "node:test";
import { mergeCodexDiscovery, mergeCodexThreadMetadata } from "../dist/sessions/codexSessionMerge.js";

const hookSession = {
  session_id: "codex-atlas-d4739ba8__atlas",
  session_type: "Codex",
  source: "hook",
  status: "working",
  task_name: "Working",
  timestamp: 1_700_000_000_000,
  project: "atlas",
  project_path: "/demo/projects/atlas",
};

const jsonlSession = {
  session_id: "codex-00000000-0000-4000-8000-000000000001__atlas",
  session_type: "Codex",
  source: "codex_jsonl",
  status: "working",
  task_name: "running: npm test",
  activity_tail: ["tool: npm test", "done: npm test"],
  timestamp: 1_700_000_010_000,
  project: "atlas",
  project_path: "/demo/projects/atlas",
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

test("codex completion makes its matching hook-backed session idle", () => {
  const sessions = {
    [hookSession.session_id]: { ...hookSession, session_id: "00000000-0000-4000-8000-000000000001__atlas" },
  };
  const completed = { ...jsonlSession, status: "idle", task_name: "Ready", activity_tail: [] };

  mergeCodexDiscovery(sessions, [completed]);

  const session = Object.values(sessions)[0];
  assert.equal(session.status, "idle");
  assert.equal(session.task_name, "Ready");
});

test("codex discovery keeps separate sessions in the same project", () => {
  const firstId = "00000000-0000-4000-8000-000000000001";
  const secondId = "00000000-0000-4000-8000-000000000002";
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

test("Codex app-server names enrich the matching UUID instead of another session in the same project", () => {
  const firstId = "00000000-0000-4000-8000-000000000001";
  const secondId = "00000000-0000-4000-8000-000000000002";
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
    projectPath: "/demo/projects/atlas",
    updatedAt: 1_700_000_020_000,
  }]);

  assert.equal(sessions[`codex-${firstId}__atlas`].session_name, "First renamed task");
  assert.equal(sessions[`codex-${secondId}__atlas`].session_name, undefined);
  assert.equal(sessions[`codex-${firstId}__atlas`].status, "working");
});
