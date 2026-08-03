import assert from "node:assert/strict";
import test from "node:test";
import { mergeCodexDiscovery } from "../dist/codexSessionMerge.js";

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
