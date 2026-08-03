import assert from "node:assert/strict";
import test from "node:test";
import { reduceSessionEvents } from "../dist/sessionReducer.js";

const base = {
  agent_type: "Codex",
  session_id: "codex-demo__Vision-Dash",
  project: "Vision-Dash",
  project_path: "/Users/jcus/Documents/Jcus/Vision-Dash",
  source: "hook",
};

test("usage snapshots update session usage and compute token rate from deltas", () => {
  const session = reduceSessionEvents(undefined, [
    {
      ...base,
      type: "session_status",
      status: "working",
      task_name: "running: npm test",
      timestamp: 1_700_000_000_000,
    },
    {
      ...base,
      type: "usage_snapshot",
      total_tokens: 1000,
      input_tokens: 800,
      output_tokens: 200,
      cached_input_tokens: 300,
      model_context_window: 4000,
      timestamp: 1_700_000_000_000,
    },
    {
      ...base,
      type: "usage_snapshot",
      total_tokens: 1600,
      input_tokens: 1200,
      output_tokens: 400,
      cached_input_tokens: 500,
      model_context_window: 4000,
      timestamp: 1_700_000_030_000,
    },
  ]);

  assert.equal(session.tokens, 1600);
  assert.equal(session.input_tokens, 1200);
  assert.equal(session.output_tokens, 400);
  assert.equal(session.cache_read_tokens, 500);
  assert.equal(session.context_percent, 40);
  assert.equal(session.token_rate, 1200);
});

test("agent signals are preserved without becoming session quota", () => {
  const session = reduceSessionEvents(undefined, [
    {
      ...base,
      type: "session_status",
      status: "working",
      task_name: "Working",
      timestamp: 1_700_000_000_000,
    },
    {
      ...base,
      type: "agent_signal",
      signal: "provider_limit",
      used_percent: 65,
      reset_at: 1_700_001_000,
      timestamp: 1_700_000_001_000,
    },
  ]);

  assert.equal(session.quota_percent, undefined);
  assert.equal(session.quota_reset, undefined);
  assert.equal(session.agent_signals.length, 1);
  assert.equal(session.agent_signals[0].signal, "provider_limit");
  assert.equal(session.agent_signals[0].used_percent, 65);
});

test("agent signals retain API balance and replace the previous snapshot", () => {
  const first = reduceSessionEvents(undefined, [
    {
      ...base,
      type: "session_status",
      status: "working",
      task_name: "Working",
      timestamp: 1_700_000_000_000,
    },
    {
      ...base,
      type: "agent_signal",
      signal: "api_balance",
      source: "provider_api",
      scope: "account",
      kind: "balance",
      remaining: 12.4,
      limit: 100,
      unit: "USD",
      status: "ok",
      label: "Codex API",
      timestamp: 1_700_000_001_000,
    },
  ]);
  const second = reduceSessionEvents(first, [{
    ...base,
    type: "agent_signal",
    signal: "api_balance",
    source: "provider_api",
    scope: "account",
    kind: "balance",
    remaining: 9.8,
    limit: 100,
    unit: "USD",
    status: "ok",
    label: "Codex API",
    timestamp: 1_700_000_002_000,
  }]);

  assert.equal(second.agent_signals.length, 1);
  assert.equal(second.agent_signals[0].remaining, 9.8);
  assert.equal(second.agent_signals[0].limit, 100);
  assert.equal(second.agent_signals[0].kind, "balance");
  assert.equal(second.quota_percent, undefined);
});

test("provider signals can represent quota and health without changing session status", () => {
  const session = reduceSessionEvents(undefined, [
    {
      ...base,
      type: "session_status",
      status: "working",
      task_name: "running: npm test",
      timestamp: 1_700_000_000_000,
    },
    {
      ...base,
      type: "agent_signal",
      signal: "provider_quota",
      kind: "quota",
      scope: "account",
      used: 65,
      remaining: 35,
      limit: 100,
      unit: "%",
      used_percent: 65,
      status: "ok",
      timestamp: 1_700_000_001_000,
    },
    {
      ...base,
      type: "agent_signal",
      signal: "provider_health",
      kind: "service_health",
      scope: "account",
      status: "degraded",
      error_code: "429",
      timestamp: 1_700_000_002_000,
    },
  ]);

  assert.equal(session.status, "working");
  assert.equal(session.task_name, "running: npm test");
  assert.equal(session.agent_signals[0].kind, "quota");
  assert.equal(session.agent_signals[0].remaining, 35);
  assert.equal(session.agent_signals[1].status, "degraded");
  assert.equal(session.agent_signals[1].error_code, "429");
});

test("unknown events are retained and do not block state updates", () => {
  const raw = { native: "payload" };
  const session = reduceSessionEvents(undefined, [
    {
      ...base,
      type: "unknown",
      raw,
      timestamp: 1_700_000_000_000,
    },
    {
      ...base,
      type: "session_status",
      status: "idle",
      task_name: "Ready",
      timestamp: 1_700_000_001_000,
    },
  ]);

  assert.equal(session.status, "idle");
  assert.equal(session.task_name, "Ready");
  assert.equal(session.unknown_events.length, 1);
  assert.deepEqual(session.unknown_events[0].raw, raw);
});

test("common workflow events update lightweight session state", () => {
  const session = reduceSessionEvents(undefined, [
    {
      ...base,
      type: "session_status",
      status: "idle",
      task_name: "Ready",
      timestamp: 1_700_000_000_000,
    },
    {
      ...base,
      type: "workflow_event",
      raw_event: "PermissionRequest",
      canonical_stage_id: "permission.request",
      canonical_category: "permission",
      canonical_direction: "before",
      mapping_type: "same_concept",
      confidence: "high",
      timestamp: 1_700_000_001_000,
    },
    {
      ...base,
      type: "unknown",
      raw: { hook_event: "PermissionRequest" },
      timestamp: 1_700_000_001_000,
    },
  ]);

  assert.equal(session.status, "blocked");
  assert.equal(session.task_name, "Waiting for permission");
  assert.equal(session.workflow_events.length, 1);
  assert.equal(session.workflow_events[0].raw_event, "PermissionRequest");
  assert.equal(session.workflow_events[0].canonical_stage_id, "permission.request");
  assert.equal(session.workflow_events[0].mapping_type, "same_concept");
  assert.equal(session.workflow_events[0].confidence, "high");
  assert.equal(session.workflow_events[0].timestamp, 1_700_000_001_000);
  assert.equal(session.unknown_events.length, 1);
});

test("weak workflow events are retained without driving session state", () => {
  const session = reduceSessionEvents(undefined, [
    {
      ...base,
      type: "session_status",
      status: "idle",
      task_name: "Ready",
      timestamp: 1_700_000_000_000,
    },
    {
      ...base,
      type: "workflow_event",
      raw_event: "session_before_tree",
      canonical_stage_id: "context.tree.before",
      canonical_category: "context",
      canonical_direction: "before",
      mapping_type: "weak",
      confidence: "low",
      timestamp: 1_700_000_001_000,
    },
  ]);

  assert.equal(session.status, "idle");
  assert.equal(session.task_name, "Ready");
  assert.equal(session.workflow_events.length, 1);
  assert.equal(session.workflow_events[0].canonical_stage_id, "context.tree.before");
});

test("workflow event buffer keeps the latest 20 entries", () => {
  const events = Array.from({ length: 25 }, (_, index) => ({
    ...base,
    type: "workflow_event",
    raw_event: `Hook${index + 1}`,
    canonical_stage_id: "tool.execute.before",
    canonical_category: "tool",
    canonical_direction: "before",
    mapping_type: "same_concept",
    confidence: "high",
    timestamp: 1_700_000_000_000 + index,
  }));

  const session = reduceSessionEvents(undefined, events);

  assert.equal(session.workflow_events.length, 20);
  assert.equal(session.workflow_events[0].raw_event, "Hook6");
  assert.equal(session.workflow_events.at(-1).raw_event, "Hook25");
});
