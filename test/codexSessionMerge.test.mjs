import assert from "node:assert/strict";
import test from "node:test";
import { mergeCodexDiscovery, mergeCodexThreadMetadata } from "../dist/sessions/codexSessionMerge.js";

const hookSession = {
  session_id: "codex-Vision-Dash-d4739ba8__Vision-Dash",
  session_type: "Codex",
  source: "hook",
  status: "working",
  task_name: "Working",
  timestamp: 1_700_000_000_000,
  project: "Vision-Dash",
  project_path: "/Users/jcus/Documents/Jcus/Vision-Dash",
};

const jsonlSession = {
  session_id: "codex-019ee93e-56d1-7f13-9624-c84bdaf7c97a__Vision-Dash",
  session_type: "Codex",
  source: "codex_jsonl",
  status: "working",
  task_name: "running: npm test",
  activity_tail: ["tool: npm test", "done: npm test"],
  timestamp: 1_700_000_010_000,
  project: "Vision-Dash",
  project_path: "/Users/jcus/Documents/Jcus/Vision-Dash",
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
    [hookSession.session_id]: { ...hookSession, session_id: "019ee93e-56d1-7f13-9624-c84bdaf7c97a__Vision-Dash" },
  };
  const completed = { ...jsonlSession, status: "idle", task_name: "Ready", activity_tail: [] };

  mergeCodexDiscovery(sessions, [completed]);

  const session = Object.values(sessions)[0];
  assert.equal(session.status, "idle");
  assert.equal(session.task_name, "Ready");
});

test("codex discovery keeps separate sessions in the same project", () => {
  const firstId = "019ee93e-56d1-7f13-9624-c84bdaf7c97a";
  const secondId = "019fdb88-8209-7b32-8816-cf684186fde1";
  const sessions = {
    [`${firstId}__Vision-Dash`]: { ...hookSession, session_id: `${firstId}__Vision-Dash` },
    [`${secondId}__Vision-Dash`]: { ...hookSession, session_id: `${secondId}__Vision-Dash`, timestamp: hookSession.timestamp + 1 },
  };
  const discoveries = [
    { ...jsonlSession, session_id: `codex-${firstId}__Vision-Dash`, task_name: "first task" },
    { ...jsonlSession, session_id: `codex-${secondId}__Vision-Dash`, task_name: "second task" },
  ];

  mergeCodexDiscovery(sessions, discoveries);

  assert.equal(Object.keys(sessions).length, 2);
  assert.equal(sessions[`${firstId}__Vision-Dash`].task_name, "first task");
  assert.equal(sessions[`${secondId}__Vision-Dash`].task_name, "second task");
});

test("Codex app-server names enrich the matching UUID instead of another session in the same project", () => {
  const firstId = "019ee93e-56d1-7f13-9624-c84bdaf7c97a";
  const secondId = "019fdb88-8209-7b32-8816-cf684186fde1";
  const sessions = {
    [`codex-${firstId}__Vision-Dash`]: {
      ...hookSession,
      session_id: `codex-${firstId}__Vision-Dash`,
    },
    [`codex-${secondId}__Vision-Dash`]: {
      ...hookSession,
      session_id: `codex-${secondId}__Vision-Dash`,
      timestamp: hookSession.timestamp + 1,
    },
  };

  mergeCodexThreadMetadata(sessions, [{
    threadId: firstId,
    sessionName: "First renamed task",
    project: "Vision-Dash",
    projectPath: "/Users/jcus/Documents/Jcus/Vision-Dash",
    updatedAt: 1_700_000_020_000,
  }]);

  assert.equal(sessions[`codex-${firstId}__Vision-Dash`].session_name, "First renamed task");
  assert.equal(sessions[`codex-${secondId}__Vision-Dash`].session_name, undefined);
  assert.equal(sessions[`codex-${firstId}__Vision-Dash`].status, "working");
});
