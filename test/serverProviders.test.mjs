import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregateProviders, matchesSessionProvider, migrateLegacyHookSessions, sessionAdvisorRows } from "../dist/server/server.js";

function planRow(overrides = {}) {
  return {
    form: "subscription",
    provider: "anthropic",
    label: "Anthropic Subscription (5h)",
    level: "green",
    pacing: "ok",
    cardTiming: "",
    autoResetIn: "5h",
    sustainableRate: 10,
    actualVsSustainable: null,
    projectedCapHitAt: null,
    ...overrides,
  };
}

function session(id, advisorRows = []) {
  return {
    session_id: id,
    session_type: "Claude Code",
    status: "working",
    task_name: "running",
    timestamp: 1_700_000_000_000,
    advisorRows,
  };
}

test("migrateLegacyHookSessions removes only the old fallback for a stable session", () => {
  const sessions = {
    legacy: {
      session_id: "codex-Vision-Dash-f75de08f__Vision-Dash",
      session_type: "Codex",
      source: "hook",
      status: "working",
      task_name: "running",
      timestamp: 1_700_000_000_000,
      project: "Vision-Dash",
      project_path: "/Users/jcus/Documents/Jcus/Vision-Dash",
    },
    otherStable: {
      session_id: "019ee93e-56d1-7f13-9624-c84bdaf7c97a__Vision-Dash",
      session_type: "Codex",
      source: "hook",
      status: "working",
      task_name: "running",
      timestamp: 1_700_000_001_000,
      project: "Vision-Dash",
      project_path: "/Users/jcus/Documents/Jcus/Vision-Dash",
    },
  };

  const removed = migrateLegacyHookSessions(sessions, {
    session_id: "019fdb88-8209-7b32-8816-cf684186fde1__Vision-Dash",
    session_type: "Codex",
    source: "hook",
    status: "working",
    task_name: "running",
    timestamp: 1_700_000_002_000,
    project: "Vision-Dash",
    project_path: "/Users/jcus/Documents/Jcus/Vision-Dash",
  });

  assert.deepEqual(removed, ["codex-Vision-Dash-f75de08f__Vision-Dash"]);
  assert.ok(sessions.otherStable);
  assert.equal(sessions.legacy, undefined);
});

// --- aggregateProviders ---

test("aggregateProviders: merges subscription + api rows", () => {
  const subscriptionRows = [
    planRow({ provider: "anthropic", label: "Anthropic Subscription (5h)" }),
  ];
  const sessions = {
    a: session("a", [
      planRow({ form: "api", provider: "anthropic", label: "anthropic", remaining: 42.5, unit: "USD" }),
    ]),
  };
  const result = aggregateProviders(subscriptionRows, sessions);
  assert.equal(result.length, 2);
  assert.deepEqual(result.map(r => r.form).sort(), ["api", "subscription"]);
  const api = result.find(r => r.form === "api");
  assert.equal(api.remaining, 42.5);
  assert.equal(api.unit, "USD");
});

test("aggregateProviders: dedupes identical api rows across sessions", () => {
  const apiRow = planRow({ form: "api", provider: "anthropic", label: "anthropic", remaining: 42.5, unit: "USD" });
  const sessions = {
    a: session("a", [apiRow]),
    b: session("b", [apiRow]),
  };
  const result = aggregateProviders([], sessions);
  assert.equal(result.length, 1);
  assert.equal(result[0].provider, "anthropic");
  assert.equal(result[0].form, "api");
  assert.equal(result[0].remaining, 42.5);
});

test("aggregateProviders: keeps distinct subscription rows (5h vs weekly labels)", () => {
  const subscriptionRows = [
    planRow({ provider: "anthropic", label: "Anthropic Subscription (5h)" }),
    planRow({ provider: "anthropic", label: "Anthropic Subscription (weekly)" }),
  ];
  const result = aggregateProviders(subscriptionRows, {});
  assert.equal(result.length, 2);
  assert.deepEqual(
    result.map(r => r.label).sort(),
    ["Anthropic Subscription (5h)", "Anthropic Subscription (weekly)"],
  );
});

test("aggregateProviders: dedup key includes form (subscription + api of same provider/label both kept)", () => {
  const subscriptionRows = [
    planRow({ provider: "anthropic", label: "Anthropic Subscription (5h)" }),
  ];
  const sessions = {
    a: session("a", [
      planRow({ form: "api", provider: "anthropic", label: "Anthropic Subscription (5h)", remaining: 42.5 }),
    ]),
  };
  const result = aggregateProviders(subscriptionRows, sessions);
  assert.equal(result.length, 2);
  assert.deepEqual(result.map(r => r.form).sort(), ["api", "subscription"]);
});

test("aggregateProviders: keeps distinct api rows for same provider when labels collapse", () => {
  const sessions = {
    a: session("a", [
      planRow({ form: "api", provider: "openai", label: "openai.usage", remaining: 42.5, unit: "USD" }),
      planRow({ form: "api", provider: "openai", label: "openai.balance", used: 10 }),
    ]),
  };
  const result = aggregateProviders([], sessions);
  assert.equal(result.length, 2);
  assert.deepEqual(result.map(r => r.label).sort(), ["openai.balance", "openai.usage"]);
});

test("aggregateProviders: includes global provider api rows without a matching session", () => {
  const globalApiRows = [
    planRow({
      form: "api",
      provider: "deepseek",
      label: "DeepSeek API CNY",
      remaining: 110,
      unit: "CNY",
    }),
  ];
  const result = aggregateProviders([], { a: session("a") }, globalApiRows);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0], globalApiRows[0]);
});

// --- sessionAdvisorRows (session detail advisor tab: api + matching subscriptions) ---

function apiRow(overrides = {}) {
  return {
    form: "api",
    provider: "openai",
    label: "openai.usage",
    level: "green",
    pacing: "",
    cardTiming: "",
    autoResetIn: "",
    sustainableRate: 0,
    actualVsSustainable: null,
    projectedCapHitAt: null,
    remaining: 500_000,
    used: 500_000,
    limit: 1_000_000,
    unit: "tokens",
    ...overrides,
  };
}

test("sessionAdvisorRows: session with api signal + matching subscription rows keeps both", () => {
  const codexSession = { ...session("codex-abc"), session_type: "Codex" };
  const subscriptionRows = [
    planRow({ provider: "openai", label: "OpenAI Subscription" }),
    planRow({ provider: "anthropic", label: "Anthropic Subscription (5h)" }),
  ];
  const rows = sessionAdvisorRows(codexSession, [apiRow()], subscriptionRows);
  assert.equal(rows.length, 2);
  assert.ok(rows.some(r => r.form === "api"), "kept the api row from the signal");
  assert.ok(rows.some(r => r.form === "subscription" && r.provider === "openai"), "added the openai subscription row");
  assert.ok(!rows.some(r => r.provider === "anthropic"), "dropped the anthropic subscription row for a codex session");
});

test("sessionAdvisorRows: session with no api signals but non-empty subscriptions gets subscription rows, not empty", () => {
  const claudeSession = session("claude-abc", []);
  const subscriptionRows = [
    planRow({ provider: "anthropic", label: "Anthropic Subscription (5h)" }),
    planRow({ provider: "openai", label: "OpenAI Subscription" }),
  ];
  const rows = sessionAdvisorRows(claudeSession, [], subscriptionRows);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].provider, "anthropic");
  assert.equal(rows[0].form, "subscription");
});

test("sessionAdvisorRows: no subscriptions and no api rows → empty (advisor tab shows No quota data)", () => {
  const rows = sessionAdvisorRows(session("claude-abc", []), [], []);
  assert.deepEqual(rows, []);
});

test("matchesSessionProvider: session_type maps to the right subscription provider", () => {
  const codex = { ...session("a"), session_type: "Codex" };
  const claude = { ...session("b"), session_type: "Claude Code" };
  const kimi = { ...session("c"), session_type: "Kimi" };
  const gemini = { ...session("d"), session_type: "Gemini CLI" };
  assert.equal(matchesSessionProvider(planRow({ provider: "openai" }), codex), true);
  assert.equal(matchesSessionProvider(planRow({ provider: "openai" }), claude), false);
  assert.equal(matchesSessionProvider(planRow({ provider: "anthropic" }), claude), true);
  assert.equal(matchesSessionProvider(planRow({ provider: "anthropic" }), codex), false);
  assert.equal(matchesSessionProvider(planRow({ provider: "kimi" }), kimi), true);
  assert.equal(matchesSessionProvider(planRow({ provider: "kimi" }), gemini), false);
});
