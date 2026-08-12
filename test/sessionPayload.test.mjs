import assert from "node:assert/strict";
import test from "node:test";
import { mergeSessionPayload, validateSessionPayload } from "../dist/sessionPayload.js";

const basePayload = {
  session_id: "codex-demo__Vision-Dash",
  session_type: "Codex",
  session_name: "Build dashboard",
  status: "working",
  task_name: "running: npm test",
  timestamp: 1_700_000_000_000,
  project: "Vision-Dash",
  project_path: "/Users/jcus/Documents/Jcus/Vision-Dash",
};

test("validates canonical usage fields", () => {
  assert.equal(validateSessionPayload({
    ...basePayload,
    context_percent: 72,
    tokens: 1700000,
    turns: 34,
    input_tokens: 48200,
    output_tokens: 12800,
    cache_read_tokens: 1400000,
    cache_write_tokens: 185000,
    token_rate: 17000,
    quota_percent: 65,
    quota_reset: "5h38m",
    hook_event: "PreToolUse",
  }), true);
});

test("validates an API-backed agent balance signal", () => {
  assert.equal(validateSessionPayload({
    ...basePayload,
    agent_signals: [{
      signal: "api_balance",
      kind: "balance",
      source: "provider_api",
      scope: "account",
      remaining: 12.4,
      limit: 100,
      unit: "USD",
      status: "ok",
      label: "Codex API",
    }],
  }), true);
});

test("rejects invalid API-backed agent balance signals", () => {
  assert.equal(validateSessionPayload({
    ...basePayload,
    agent_signals: [{ signal: "api_balance", balance: -1 }],
  }), false);
  assert.equal(validateSessionPayload({
    ...basePayload,
    agent_signals: [{ signal: "api_balance", used_percent: 101 }],
  }), false);
  assert.equal(validateSessionPayload({
    ...basePayload,
    agent_signals: [{ signal: "api_balance", balance_unit: "x".repeat(33) }],
  }), false);
  assert.equal(validateSessionPayload({
    ...basePayload,
    agent_signals: [{ signal: "api_quota", used: -1 }],
  }), false);
  assert.equal(validateSessionPayload({
    ...basePayload,
    agent_signals: [{ signal: "api_quota", remaining: -1 }],
  }), false);
  assert.equal(validateSessionPayload({
    ...basePayload,
    agent_signals: [{ signal: "api_quota", limit: -1 }],
  }), false);
  assert.equal(validateSessionPayload({
    ...basePayload,
    agent_signals: [{ signal: "api_quota", unit: "x".repeat(33) }],
  }), false);
});

test("rejects negative usage numbers and invalid percentages", () => {
  assert.equal(validateSessionPayload({ ...basePayload, input_tokens: -1 }), false);
  assert.equal(validateSessionPayload({ ...basePayload, output_tokens: -1 }), false);
  assert.equal(validateSessionPayload({ ...basePayload, cache_read_tokens: -1 }), false);
  assert.equal(validateSessionPayload({ ...basePayload, cache_write_tokens: -1 }), false);
  assert.equal(validateSessionPayload({ ...basePayload, token_rate: -1 }), false);
  assert.equal(validateSessionPayload({ ...basePayload, quota_percent: -1 }), false);
  assert.equal(validateSessionPayload({ ...basePayload, quota_percent: 101 }), false);
});

test("validates and preserves runtime resource snapshots", () => {
  const runtime = {
    cpu_percent: 24.5,
    gpu_percent: 12,
    memory_percent: 8,
    memory_bytes: 805306368,
    process_count: 4,
    sampled_at: 1_700_000_000_000,
  };
  assert.equal(validateSessionPayload({ ...basePayload, runtime }), true);
  assert.equal(validateSessionPayload({ ...basePayload, runtime: { ...runtime, gpu_percent: 101 } }), false);
  assert.equal(validateSessionPayload({ ...basePayload, runtime: { ...runtime, process_count: 1.5 } }), false);
  const merged = mergeSessionPayload(undefined, { ...basePayload, runtime }, 1_700_000_001_000);
  assert.deepEqual(merged.runtime, runtime);
  const withoutRuntime = mergeSessionPayload(merged, { ...basePayload }, 1_700_000_002_000);
  assert.equal(withoutRuntime.runtime, undefined);
});

test("ignores unknown legacy process roots without exposing them on sessions", () => {
  const runtime = { cpu_percent: 24.5, sampled_at: 1_700_000_000_000 };
  const merged = mergeSessionPayload({
    ...basePayload,
    source: "hook",
    process_pid: 4242,
  }, { ...basePayload, process_pid: 5252, runtime }, 1_700_000_001_000);

  assert.equal(validateSessionPayload({ ...basePayload, process_pid: "retired", runtime }), true);
  assert.equal(Object.hasOwn(merged, "process_pid"), false);
  assert.deepEqual(merged.runtime, runtime);
});

test("rejects overlong quota reset labels", () => {
  assert.equal(validateSessionPayload({ ...basePayload, quota_reset: "x".repeat(65) }), false);
});

test("rejects invalid hook event labels", () => {
  assert.equal(validateSessionPayload({ ...basePayload, hook_event: "" }), false);
  assert.equal(validateSessionPayload({ ...basePayload, hook_event: "x".repeat(129) }), false);
  assert.equal(validateSessionPayload({ ...basePayload, hook_event: 1 }), false);
});

test("merge preserves previous usage fields when hook omits them", () => {
  const prev = {
    ...basePayload,
    source: "hook",
    input_tokens: 48200,
    output_tokens: 12800,
    cache_read_tokens: 1400000,
    cache_write_tokens: 185000,
    token_rate: 17000,
    quota_percent: 65,
    quota_reset: "5h38m",
  };
  const merged = mergeSessionPayload(prev, {
    ...basePayload,
    status: "idle",
    task_name: "Ready",
  }, 1_700_000_010_000);

  assert.equal(merged.status, "idle");
  assert.equal(merged.session_name, "Build dashboard");
  assert.equal(merged.task_name, "Ready");
  assert.equal(merged.timestamp, 1_700_000_010_000);
  assert.equal(merged.input_tokens, 48200);
  assert.equal(merged.output_tokens, 12800);
  assert.equal(merged.cache_read_tokens, 1400000);
  assert.equal(merged.cache_write_tokens, 185000);
  assert.equal(merged.token_rate, 17000);
  assert.equal(merged.quota_percent, 65);
  assert.equal(merged.quota_reset, "5h38m");
});

test("merge derives token rate through hook event reduction", () => {
  const prev = {
    ...basePayload,
    source: "hook",
    tokens: 1000,
    timestamp: 1_700_000_000_000,
  };
  const merged = mergeSessionPayload(prev, {
    ...basePayload,
    tokens: 1600,
  }, 1_700_000_030_000);

  assert.equal(merged.tokens, 1600);
  assert.equal(merged.token_rate, 1200);
});

test("merge turns reported hook events into visible workflow events", () => {
  const merged = mergeSessionPayload(undefined, {
    ...basePayload,
    hook_event: "PreToolUse",
  }, 1_700_000_030_000);

  assert.equal(merged.workflow_events.length, 1);
  assert.equal(merged.workflow_events[0].raw_event, "PreToolUse");
  assert.equal(merged.workflow_events[0].canonical_stage_id, "tool.execute.before");
});

test("merge preserves the provider API source on agent balance signals", () => {
  const merged = mergeSessionPayload(undefined, {
    ...basePayload,
    agent_signals: [{
      signal: "api_balance",
      source: "provider_api",
      scope: "account",
      kind: "balance",
      remaining: 12.4,
      limit: 100,
      unit: "USD",
      status: "ok",
    }],
  }, 1_700_000_030_000);

  assert.equal(merged.agent_signals.length, 1);
  assert.equal(merged.agent_signals[0].source, "provider_api");
  assert.equal(merged.agent_signals[0].scope, "account");
  assert.equal(merged.agent_signals[0].kind, "balance");
  assert.equal(merged.agent_signals[0].remaining, 12.4);
  assert.equal(merged.agent_signals[0].limit, 100);
});
