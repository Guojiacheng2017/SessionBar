import assert from "node:assert/strict";
import test from "node:test";
import {
  decorateProviderUsage,
  recordProviderUsage,
} from "../dist/providers/providerUsageHistory.js";

const DAY = 24 * 60 * 60 * 1000;
const start = new Date(2026, 7, 1, 12).getTime();

function row(overrides = {}) {
  return {
    form: "api",
    provider: "deepseek",
    label: "DeepSeek API CNY",
    level: "green",
    pacing: "",
    cardTiming: "",
    autoResetIn: "",
    sustainableRate: 0,
    actualVsSustainable: null,
    projectedCapHitAt: null,
    remaining: 100,
    unit: "CNY",
    ...overrides,
  };
}

test("records balance decreases as seven daily consumption bars", () => {
  let history = {};
  history = recordProviderUsage(history, [row({ remaining: 100 })], start);
  history = recordProviderUsage(history, [row({ remaining: 92 })], start + 60_000);
  history = recordProviderUsage(history, [row({ remaining: 90 })], start + DAY);
  history = recordProviderUsage(history, [row({ remaining: 85 })], start + DAY + 60_000);

  const [decorated] = decorateProviderUsage([row({ remaining: 85 })], history, start + DAY + 60_000);
  assert.equal(decorated.usageTrend.kind, "bars");
  assert.equal(decorated.usageTrend.days, 7);
  assert.deepEqual(decorated.usageTrend.points.slice(-2), [8, 5]);
});

test("quota resets and balance top-ups never become negative consumption", () => {
  let history = {};
  history = recordProviderUsage(history, [row({ remaining: 10 })], start);
  history = recordProviderUsage(history, [row({ remaining: 100 })], start + 60_000);

  const [decorated] = decorateProviderUsage([row({ remaining: 100 })], history, start + 60_000);
  assert.equal(decorated.usageTrend.points.at(-1), 0);
});

test("Copilot gets a thirty-day line from cumulative used credits", () => {
  let history = {};
  for (let day = 0; day < 3; day += 1) {
    history = recordProviderUsage(history, [row({
      form: "subscription",
      provider: "github",
      label: "GitHub Copilot Pro",
      used: 100 + day * 25,
      remaining: 900 - day * 25,
      limit: 1000,
      unit: "AI credits",
    })], start + day * DAY);
  }

  const [decorated] = decorateProviderUsage([row({
    form: "subscription",
    provider: "github",
    label: "GitHub Copilot Pro",
    used: 150,
    remaining: 850,
    limit: 1000,
    unit: "AI credits",
  })], history, start + 2 * DAY);
  assert.equal(decorated.usageTrend.kind, "line");
  assert.equal(decorated.usageTrend.days, 30);
  assert.deepEqual(decorated.usageTrend.points.slice(-3), [100, 125, 150]);
});

test("rows without measurable counters receive an empty fixed-size trend", () => {
  const [decorated] = decorateProviderUsage([row({ remaining: undefined })], {}, start);
  assert.equal(decorated.usageTrend.points.length, 7);
  assert.ok(decorated.usageTrend.points.every(point => point === null));
});

test("Kimi balance history falls back to daily money consumption when tokens are unavailable", () => {
  let history = {};
  const kimi = row({ provider: "kimi", label: "Kimi API", remaining: 100, unit: "USD" });
  history = recordProviderUsage(history, [kimi], start);
  history = recordProviderUsage(history, [{ ...kimi, remaining: 92 }], start + 60_000);

  const [decorated] = decorateProviderUsage([{ ...kimi, remaining: 92 }], history, start + 60_000);

  assert.equal(decorated.usageTrend.unit, "USD");
  assert.equal(decorated.usageTrend.points.at(-1), 8);
});

test("official token buckets are not replaced by quota percentage history", () => {
  const official = { kind: "bars", days: 7, points: [null, null, 367_358_950, 121_295_867, null, null, null], unit: "tokens" };
  const openai = row({
    form: "subscription",
    provider: "openai",
    label: "OpenAI Subscription",
    remaining: 75,
    limit: 100,
    unit: "%",
    usageTrend: official,
  });

  const [decorated] = decorateProviderUsage([openai], {}, start);
  assert.strictEqual(decorated.usageTrend, official);
});
