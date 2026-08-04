import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregateProviders } from "../dist/server.js";

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
