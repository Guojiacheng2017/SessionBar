import assert from "node:assert/strict";
import test from "node:test";
import { nativePayloadToHookEvents, sessionSnapshotToHookEvents } from "../dist/hookEvents.js";

const snapshot = {
  session_id: "codex-demo__Vision-Dash",
  session_type: "Codex",
  session_name: "Build dashboard",
  status: "working",
  task_name: "running: npm test",
  activity_tail: ["tool: npm test", "done: npm test"],
  tokens: 1700000,
  input_tokens: 48200,
  output_tokens: 12800,
  cache_read_tokens: 1400000,
  turns: 34,
  context_percent: 72,
  project: "Vision-Dash",
  project_path: "/Users/jcus/Documents/Jcus/Vision-Dash",
};

test("snapshot payload normalizes into status, activity, and usage hook events", () => {
  const events = sessionSnapshotToHookEvents(snapshot, 1_700_000_000_000);

  assert.deepEqual(events.map(event => event.type), [
    "session_status",
    "activity_event",
    "activity_event",
    "usage_snapshot",
  ]);
  assert.equal(events[0].agent_type, "Codex");
  assert.equal(events[0].session_id, snapshot.session_id);
  assert.equal(events[0].session_name, snapshot.session_name);
  assert.equal(events[0].project_path, snapshot.project_path);
  assert.equal(events[0].timestamp, 1_700_000_000_000);

  const usage = events.find(event => event.type === "usage_snapshot");
  assert.equal(usage.total_tokens, 1700000);
  assert.equal(usage.input_tokens, 48200);
  assert.equal(usage.output_tokens, 12800);
  assert.equal(usage.cached_input_tokens, 1400000);
  assert.equal(usage.turns, 34);
  assert.equal(usage.context_percent, 72);
});

test("native unknown payloads are preserved as unknown hook events", () => {
  const raw = { provider: "demo", shape: { useful: true } };
  const events = nativePayloadToHookEvents(raw, {
    agent_type: "Pi Agent",
    session_id: "pi-demo__Vision-Dash",
    project: "Vision-Dash",
    timestamp: 1_700_000_000_000,
    source: "hook",
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].type, "unknown");
  assert.equal(events[0].agent_type, "Pi Agent");
  assert.deepEqual(events[0].raw, raw);
});

test("native payloads with structured hook event names emit canonical workflow events", () => {
  const raw = { hook_event: "PreCompress", payload: { compact: true } };
  const events = nativePayloadToHookEvents(raw, {
    agent_type: "Gemini CLI",
    session_id: "gemini-demo__Vision-Dash",
    project: "Vision-Dash",
    timestamp: 1_700_000_000_000,
    source: "hook",
  });

  assert.deepEqual(events.map(event => event.type), ["session_status", "activity_event", "workflow_event", "unknown"]);
  assert.equal(events[0].status, "working");
  assert.equal(events[0].task_name, "Compacting context");
  assert.equal(events[1].label, "context: compact");
  const workflow = events[2];
  assert.equal(workflow.raw_event, "PreCompress");
  assert.equal(workflow.canonical_stage_id, "context.compact.before");
  assert.equal(workflow.canonical_category, "context");
  assert.equal(workflow.canonical_direction, "before");
  assert.equal(workflow.mapping_type, "same_concept");
  assert.equal(workflow.confidence, "high");
  assert.deepEqual(events[3].raw, raw);
});

test("native payload mapping accepts SessionBar agent aliases", () => {
  const events = nativePayloadToHookEvents({ event: "PreToolUse" }, {
    agent_type: "Codex",
    session_id: "codex-demo__Vision-Dash",
    project: "Vision-Dash",
    timestamp: 1_700_000_000_000,
    source: "hook",
  });

  const workflow = events.find(event => event.type === "workflow_event");
  assert.equal(workflow.agent_type, "Codex");
  assert.equal(workflow.raw_event, "PreToolUse");
  assert.equal(workflow.canonical_stage_id, "tool.execute.before");
});

test("native payload adapter emits status, activity, and usage hook events", () => {
  const raw = {
    hook_event: "PreToolUse",
    toolName: "Bash",
    toolInput: { command: "npm test" },
    usage: {
      totalTokens: 1700000,
      inputTokens: 48200,
      outputTokens: 12800,
      cacheReadTokens: 1400000,
      cacheWriteTokens: 185000,
      turns: 34,
      contextPercent: 72,
    },
  };
  const events = nativePayloadToHookEvents(raw, {
    agent_type: "Codex",
    session_id: "codex-demo__Vision-Dash",
    project: "Vision-Dash",
    timestamp: 1_700_000_000_000,
    source: "hook",
  });

  assert.deepEqual(events.map(event => event.type), [
    "session_status",
    "activity_event",
    "usage_snapshot",
    "workflow_event",
    "unknown",
  ]);
  assert.equal(events[0].status, "working");
  assert.equal(events[0].task_name, "running: npm test");
  assert.equal(events[1].label, "tool: npm test");
  assert.equal(events[2].total_tokens, 1700000);
  assert.equal(events[2].input_tokens, 48200);
  assert.equal(events[2].output_tokens, 12800);
  assert.equal(events[2].cached_input_tokens, 1400000);
  assert.equal(events[2].cache_write_tokens, 185000);
  assert.equal(events[2].turns, 34);
  assert.equal(events[2].context_percent, 72);
  assert.equal(events[3].canonical_stage_id, "tool.execute.before");
  assert.deepEqual(events[4].raw, raw);
});

test("unmapped native hook names remain raw-only", () => {
  const raw = { hook_event_name: "DefinitelyNotARealHook" };
  const events = nativePayloadToHookEvents(raw, {
    agent_type: "Claude Code",
    session_id: "claude-demo__Vision-Dash",
    project: "Vision-Dash",
    timestamp: 1_700_000_000_000,
    source: "hook",
  });

  assert.deepEqual(events.map(event => event.type), ["unknown"]);
  assert.deepEqual(events[0].raw, raw);
});
