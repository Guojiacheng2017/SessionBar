import assert from "node:assert/strict";
import test from "node:test";
import { applyProviderPollResults } from "../dist/providers/providerMonitor.js";

const base = {
  session_type: "Codex",
  status: "working",
  task_name: "running: npm test",
  timestamp: 1_700_000_000_000,
  project: "Vision-Dash",
};

test("provider signals attach only to matching agent sessions and preserve heartbeat state", () => {
  const sessions = {
    codex: { ...base, session_id: "codex-1" },
    claude: { ...base, session_id: "claude-1", session_type: "Claude Code", status: "idle", task_name: "Ready" },
  };
  const result = applyProviderPollResults(sessions, [{
    config: {
      id: "openai",
      provider: "openai",
      api_key: "redacted",
      label: "OpenAI API",
      target: "Codex",
    },
    signals: [{
      signal: "openai.usage",
      kind: "usage",
      source: "provider_api",
      scope: "account",
      used: 1500,
      unit: "tokens",
      status: "ok",
      label: "OpenAI API today",
    }],
  }]);

  assert.equal(result, true);
  assert.equal(sessions.codex.agent_signals[0].used, 1500);
  assert.equal(sessions.codex.timestamp, base.timestamp);
  assert.equal(sessions.codex.status, "working");
  assert.equal(sessions.claude.agent_signals, undefined);
});

test("a later provider poll replaces the same signal without growing the buffer", () => {
  const sessions = {
    codex: {
      ...base,
      session_id: "codex-1",
      agent_signals: [{
        signal: "deepseek.balance.CNY",
        kind: "balance",
        source: "provider_api",
        scope: "account",
        remaining: 100,
        unit: "CNY",
        status: "ok",
        label: "DeepSeek API CNY",
        timestamp: base.timestamp,
      }],
    },
  };
  applyProviderPollResults(sessions, [{
    config: { id: "deepseek", provider: "deepseek", api_key: "redacted", target: "Codex" },
    signals: [{
      signal: "deepseek.balance.CNY",
      kind: "balance",
      source: "provider_api",
      scope: "account",
      remaining: 90,
      unit: "CNY",
      status: "ok",
      label: "DeepSeek API CNY",
    }],
  }]);

  assert.equal(sessions.codex.agent_signals.length, 1);
  assert.equal(sessions.codex.agent_signals[0].remaining, 90);
});

test("an unchanged provider poll does not create an unread update", () => {
  const sessions = {
    codex: {
      ...base,
      session_id: "codex-1",
      agent_signals: [{
        signal: "openai.usage",
        kind: "usage",
        source: "provider_api",
        scope: "account",
        used: 1500,
        unit: "tokens",
        status: "ok",
        label: "OpenAI API today",
        timestamp: base.timestamp + 100,
      }],
    },
  };
  const changed = applyProviderPollResults(sessions, [{
    config: { id: "openai", provider: "openai", api_key: "redacted", target: "Codex" },
    signals: [{
      signal: "openai.usage",
      kind: "usage",
      source: "provider_api",
      scope: "account",
      used: 1500,
      unit: "tokens",
      status: "ok",
      label: "OpenAI API today",
    }],
  }], base.timestamp + 5000);

  assert.equal(changed, false);
  assert.equal(sessions.codex.agent_signals[0].timestamp, base.timestamp + 100);
});
