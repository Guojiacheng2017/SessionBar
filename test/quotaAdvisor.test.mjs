import { test } from "node:test";
import assert from "node:assert/strict";
import { computeAdvisorForSession, computeAdvisorRows, inferWindowForSession, defaultResetAtForWindow } from "../dist/quotaAdvisor.js";

// computePlanRows reads provider credentials from real paths/env. This machine
// has Codex auth configured, which would otherwise trigger live wham API calls
// during the computeAdvisorRows tests. Point CODEX_HOME at a nonexistent dir
// and drop KIMI_ACCESS_TOKEN so the subscription adapters short-circuit to
// "no credentials" → [] rows. Each test file runs in its own process, so this
// mutation is file-scoped and does not leak to other test files.
process.env.CODEX_HOME = "/nonexistent-sessionbar-codex-home";
delete process.env.KIMI_ACCESS_TOKEN;

const baseSession = {
  session_id: "codex-abc__Vision-Dash",
  session_type: "Codex",
  status: "working",
  task_name: "running",
  timestamp: 1_700_000_000_000,
  agent_signals: [
    { signal: "openai.usage", kind: "usage", source: "provider_api", scope: "account", used: 500_000, limit: 1_000_000, unit: "tokens" },
  ],
};

test("builds advisor from usage signal", () => {
  const advisor = computeAdvisorForSession(baseSession, new Map(), [], 1_700_000_000_000);
  assert.ok(advisor);
  assert.ok(["green", "yellow", "red"].includes(advisor.level));
  assert.equal(typeof advisor.pacing, "string");
});

test("returns null when no usage signal", () => {
  const advisor = computeAdvisorForSession({ ...baseSession, agent_signals: [] }, new Map(), [], 1_700_000_000_000);
  assert.equal(advisor, null);
});

test("non-openai/anthropic session returns null", () => {
  const advisor = computeAdvisorForSession({ ...baseSession, session_type: "DeepSeek" }, new Map(), [], 1_700_000_000_000);
  assert.equal(advisor, null);
});

test("usage signal + quota_percent derives limit", () => {
  const session = {
    ...baseSession,
    quota_percent: 75,
    agent_signals: [{ signal: "openai.usage", kind: "usage", source: "provider_api", scope: "account", used: 500_000, unit: "tokens" }],
  };
  const advisor = computeAdvisorForSession(session, new Map(), [], 1_700_000_000_000);
  assert.ok(advisor);
  assert.ok(["green", "yellow", "red"].includes(advisor.level));
});

test("quota-kind signal builds advisor", () => {
  const session = {
    ...baseSession,
    agent_signals: [{ signal: "minimax.quota", kind: "quota", source: "provider_api", scope: "account", used: 500_000, remaining: 500_000, limit: 1_000_000, unit: "tokens" }],
  };
  const advisor = computeAdvisorForSession(session, new Map(), [], 1_700_000_000_000);
  assert.ok(advisor);
});

test("quota_percent >= 100 without limit returns null", () => {
  const session = {
    ...baseSession,
    quota_percent: 100,
    agent_signals: [{ signal: "openai.usage", kind: "usage", source: "provider_api", scope: "account", used: 500_000 }],
  };
  const advisor = computeAdvisorForSession(session, new Map(), [], 1_700_000_000_000);
  assert.equal(advisor, null);
});

test("quota_percent undefined without limit returns null", () => {
  const session = {
    ...baseSession,
    agent_signals: [{ signal: "openai.usage", kind: "usage", source: "provider_api", scope: "account", used: 500_000 }],
  };
  const advisor = computeAdvisorForSession(session, new Map(), [], 1_700_000_000_000);
  assert.equal(advisor, null);
});

test("window inference: claude/anthropic → 5h, else weekly", () => {
  assert.equal(inferWindowForSession({ session_type: "Claude Code" }), "5h");
  assert.equal(inferWindowForSession({ session_type: "Anthropic" }), "5h");
  assert.equal(inferWindowForSession({ session_type: "Codex" }), "weekly");
  assert.equal(inferWindowForSession({ session_type: "OpenAI" }), "weekly");
  assert.equal(inferWindowForSession({ session_type: "Gemini CLI" }), "weekly");
});

test("default resetAt follows inferred window duration", () => {
  const now = 1_700_000_000_000;
  assert.equal(defaultResetAtForWindow("5h", now), now + 5 * 3_600_000);
  assert.equal(defaultResetAtForWindow("weekly", now), now + 7 * 24 * 3_600_000);
});

test("anthropic session without reset_at gets 5h reset window", () => {
  const now = 1_700_000_000_000;
  const session = {
    ...baseSession,
    session_type: "Claude Code",
    agent_signals: [{ signal: "anthropic.usage", kind: "usage", source: "provider_api", scope: "account", used: 500_000, limit: 1_000_000 }],
  };
  const advisor = computeAdvisorForSession(session, new Map(), [], now);
  assert.ok(advisor);
  // 5h window ⇒ reset is < 24h away; a hardcoded 7d default would show days
  assert.doesNotMatch(advisor.autoResetIn, /d /);
});

test("wham cards only attach to openai/codex sessions", () => {
  const now = 1_700_000_000_000;
  const cards = [{ count: 1, expiresAt: now + 20 * 24 * 3_600_000 }];
  const spent = {
    ...baseSession,
    agent_signals: [{ signal: "openai.usage", kind: "usage", source: "provider_api", scope: "account", used: 1_000_000, limit: 1_000_000 }],
  };

  const codexAdvisor = computeAdvisorForSession(spent, new Map(), cards, now);
  assert.ok(codexAdvisor);
  assert.match(codexAdvisor.cardTiming, /现在用卡|立即用/);

  const claudeAdvisor = computeAdvisorForSession({ ...spent, session_type: "Claude Code" }, new Map(), cards, now);
  assert.ok(claudeAdvisor);
  assert.match(claudeAdvisor.cardTiming, /无重置卡可建议/);
});

test("rate buffer keyed by full signal key", () => {
  const buffers = new Map();
  const s1 = { ...baseSession, session_id: "a", agent_signals: [{ signal: "quota", kind: "usage", source: "provider_api", scope: "account", used: 500_000, limit: 1_000_000 }] };
  const s2 = { ...baseSession, session_id: "b", agent_signals: [{ signal: "quota", kind: "quota", source: "hook", scope: "project", used: 600_000, limit: 1_000_000 }] };
  computeAdvisorForSession(s1, buffers, [], 1_700_000_000_000);
  computeAdvisorForSession(s2, buffers, [], 1_700_000_000_000);
  assert.equal(buffers.size, 2);
});

// --- computeAdvisorRows (multi-form) ---

test("computeAdvisorRows: usage signal becomes api row", async () => {
  const rows = await computeAdvisorRows(baseSession, new Map(), 1_700_000_000_000);
  const api = rows.find(r => r.form === "api");
  assert.ok(api, "expected an api row");
  assert.equal(api.provider, "openai");
  assert.equal(api.used, 500_000);
  assert.equal(api.remaining, 500_000);
  assert.equal(api.unit, "tokens");
});

test("computeAdvisorRows: balance signal on non-target session becomes api row (no TARGETS gate)", async () => {
  const session = {
    ...baseSession,
    session_type: "DeepSeek",
    agent_signals: [
      { signal: "deepseek.balance", kind: "balance", source: "provider_api", scope: "account", remaining: 42.5, unit: "USD" },
    ],
  };
  const rows = await computeAdvisorRows(session, new Map(), 1_700_000_000_000);
  const api = rows.find(r => r.form === "api");
  assert.ok(api, "expected an api row for balance signal");
  assert.equal(api.provider, "deepseek");
  assert.equal(api.remaining, 42.5);
  assert.equal(api.unit, "USD");
});

test("computeAdvisorRows: signal.balance maps to remaining", async () => {
  const session = {
    ...baseSession,
    agent_signals: [
      { signal: "xai.balance", kind: "balance", source: "provider_api", scope: "account", balance: 7.25, balance_unit: "USD" },
    ],
  };
  const rows = await computeAdvisorRows(session, new Map(), 1_700_000_000_000);
  const api = rows.find(r => r.form === "api");
  assert.ok(api, "expected an api row");
  assert.equal(api.provider, "xai");
  assert.equal(api.remaining, 7.25);
  assert.equal(api.unit, "USD");
});

test("computeAdvisorRows: no signals and no subscription rows → []", async () => {
  const rows = await computeAdvisorRows({ ...baseSession, agent_signals: [] }, new Map(), 1_700_000_000_000);
  assert.deepEqual(rows, []);
});
