import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregateProviders, matchesSessionProvider, sessionAdvisorRows } from "../dist/server.js";

function planRow(overrides = {}) {
  return {
    form: "subscription",
    provider: "anthropic",
    label: "Anthropic 订阅 (5h)",
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

// --- aggregateProviders ---

test("aggregateProviders: merges subscription + api rows", () => {
  const subscriptionRows = [
    planRow({ provider: "anthropic", label: "Anthropic 订阅 (5h)" }),
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
    planRow({ provider: "anthropic", label: "Anthropic 订阅 (5h)" }),
    planRow({ provider: "anthropic", label: "Anthropic 订阅 (weekly)" }),
  ];
  const result = aggregateProviders(subscriptionRows, {});
  assert.equal(result.length, 2);
  assert.deepEqual(
    result.map(r => r.label).sort(),
    ["Anthropic 订阅 (5h)", "Anthropic 订阅 (weekly)"],
  );
});

test("aggregateProviders: dedup key includes form (subscription + api of same provider/label both kept)", () => {
  const subscriptionRows = [
    planRow({ provider: "anthropic", label: "Anthropic 订阅 (5h)" }),
  ];
  const sessions = {
    a: session("a", [
      planRow({ form: "api", provider: "anthropic", label: "Anthropic 订阅 (5h)", remaining: 42.5 }),
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
    planRow({ provider: "openai", label: "OpenAI ChatGPT 订阅" }),
    planRow({ provider: "anthropic", label: "Anthropic 订阅 (5h)" }),
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
    planRow({ provider: "anthropic", label: "Anthropic 订阅 (5h)" }),
    planRow({ provider: "openai", label: "OpenAI ChatGPT 订阅" }),
  ];
  const rows = sessionAdvisorRows(claudeSession, [], subscriptionRows);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].provider, "anthropic");
  assert.equal(rows[0].form, "subscription");
});

test("sessionAdvisorRows: no subscriptions and no api rows → empty (advisor tab shows 无额度数据)", () => {
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
