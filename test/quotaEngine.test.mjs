import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateRate } from "../dist/quota-engine/rateEstimator.js";
import { computeAdvice } from "../dist/quota-engine/quotaEngine.js";

// ===== types =====
test("types compile and are usable", () => {
  const state = {
    window: "weekly",
    limit: 1_000_000,
    remaining: 500_000,
    resetAt: 1_728_000_000_000,
    rateSamples: [{ value: 10_000, at: 1_728_000_000_000 }],
  };
  assert.equal(state.window, "weekly");
  const method = "sma";
  assert.equal(method, "sma");
  const advice = {
    sustainableRate: 1000,
    actualVsSustainable: 1,
    projectedCapHitAt: null,
    level: "green",
    pacing: "ok",
    cardTiming: "save",
    autoResetIn: "in 2h",
  };
  assert.equal(advice.level, "green");
});

// ===== rateEstimator =====
const samples = [
  { value: 10_000, at: 1000 },
  { value: 20_000, at: 2000 },
  { value: 30_000, at: 3000 },
  { value: 40_000, at: 4000 },
  { value: 50_000, at: 5000 },
];

test("sma averages the last maWindow samples", () => {
  // last 3 of [10k,20k,30k,40k,50k] = 40k
  assert.equal(estimateRate(samples, "sma", 3), 40_000);
});

test("ema weights recent samples higher", () => {
  const result = estimateRate(samples, "ema", 5);
  assert.ok(result > 30_000 && result < 50_000, `ema=${result} out of range`);
});

test("median resists outliers", () => {
  const withOutlier = [
    { value: 10_000, at: 1000 },
    { value: 900_000, at: 2000 },
    { value: 12_000, at: 3000 },
    { value: 11_000, at: 4000 },
    { value: 13_000, at: 5000 },
  ];
  assert.equal(estimateRate(withOutlier, "median", 5), 12_000);
});

test("linear fit returns the predicted current rate (line at newest timestamp)", () => {
  // values 10k..50k over at=1s..5s, line at newest ts (5000) = 50k (tokens/hour)
  assert.equal(estimateRate(samples, "linear", 5), 50_000);
});

test("linear fit on steady samples returns the flat value", () => {
  const steady = [
    { value: 50_000, at: 1000 },
    { value: 50_000, at: 2000 },
    { value: 50_000, at: 3000 },
  ];
  assert.equal(estimateRate(steady, "linear", 5), 50_000);
});

test("samples are sorted by timestamp before estimating", () => {
  const shuffled = [...samples].reverse(); // 50k..10k out of order
  assert.equal(estimateRate(shuffled, "linear", 5), estimateRate(samples, "linear", 5));
  // sma on last 3 after sorting: [30k,40k,50k] → 40k
  assert.equal(estimateRate(shuffled, "sma", 3), 40_000);
});

test("fewer than 2 samples returns 0", () => {
  assert.equal(estimateRate([{ value: 5000, at: 1000 }], "sma", 5), 0);
  assert.equal(estimateRate([], "sma", 5), 0);
});

test("all-zero samples return 0", () => {
  const zeros = [
    { value: 0, at: 1000 },
    { value: 0, at: 2000 },
    { value: 0, at: 3000 },
  ];
  assert.equal(estimateRate(zeros, "sma", 5), 0);
});

// ===== quotaEngine =====
const NOW = 1_728_000_000_000; // fixed now for deterministic tests

// note: estimateRate needs >=2 samples to compute a rate; helper defaults to 2x 50k samples
function state(over) {
  return {
    window: "weekly",
    limit: 1_000_000,
    remaining: 500_000,
    resetAt: NOW + 7 * 24 * 3_600_000, // 7 days out (168h window)
    rateSamples: [
      { value: 50_000, at: NOW - 3_600_000 },
      { value: 50_000, at: NOW - 7_200_000 },
    ],
    ...over,
  };
}

test("green: reset arrives before cap hit", () => {
  // remaining 900k, rate 5k/h -> 180h cap hit > 168h reset -> reset comes first, null
  const advice = computeAdvice(state({ remaining: 900_000, rateSamples: [
    { value: 5_000, at: NOW - 3_600_000 },
    { value: 5_000, at: NOW - 7_200_000 },
  ] }), NOW);
  assert.equal(advice.level, "green");
  assert.equal(advice.projectedCapHitAt, null);
});

test("yellow: cap hits in second half of window", () => {
  // remaining 900k, rate 8k/h -> 112.5h cap hit; second half of 168h window -> yellow
  const advice = computeAdvice(state({ remaining: 900_000, rateSamples: [
    { value: 8_000, at: NOW - 3_600_000 },
    { value: 8_000, at: NOW - 7_200_000 },
  ] }), NOW);
  assert.equal(advice.level, "yellow");
});

test("red: cap hits in first half of window", () => {
  // remaining 100k, rate 50k/h -> 2h cap hit < 84h -> red
  const advice = computeAdvice(state({ remaining: 100_000 }), NOW);
  assert.equal(advice.level, "red");
});

test("red: remaining below 5% while still burning", () => {
  // 5% of 1M limit = 50k; remaining 40k (4%) with measured>0 -> red
  const advice = computeAdvice(state({ remaining: 40_000, rateSamples: [
    { value: 5_000, at: NOW - 3_600_000 },
    { value: 5_000, at: NOW - 7_200_000 },
  ] }), NOW);
  assert.equal(advice.level, "red");
});

test("sustainableRate computed from remaining / hours", () => {
  const advice = computeAdvice(state({ remaining: 168_000 }), NOW); // 168h until reset
  assert.ok(Math.abs(advice.sustainableRate - 1_000) < 0.1);
});

test("remaining >= limit treated as just-restored (green, normal rate)", () => {
  const advice = computeAdvice(state({ remaining: 1_100_000, rateSamples: [
    { value: 5_000, at: NOW - 3_600_000 },
    { value: 5_000, at: NOW - 7_200_000 },
  ] }), NOW);
  assert.equal(advice.level, "green");
  assert.ok(Number.isFinite(advice.sustainableRate));
});

test("zero remaining → red, sustainable 0", () => {
  const advice = computeAdvice(state({ remaining: 0 }), NOW);
  assert.equal(advice.level, "red");
  assert.equal(advice.sustainableRate, 0);
  assert.match(advice.pacing, /Exhausted/);
});

test("resetAt in past → autoResetIn says resetting", () => {
  const advice = computeAdvice(state({ resetAt: NOW - 1_000 }), NOW);
  assert.match(advice.autoResetIn, /Resetting|reset/);
});

test("insufficient samples → no cap projection", () => {
  const advice = computeAdvice(state({ rateSamples: [] }), NOW);
  assert.equal(advice.projectedCapHitAt, null);
  assert.match(advice.pacing, /Observing/);
});

test("card: spend when cap hit before reset and reset far", () => {
  const advice = computeAdvice(state({
    remaining: 100_000,
    cards: [{ count: 1, expiresAt: NOW + 20 * 24 * 3_600_000 }],
  }), NOW); // default 2x50k -> 2h cap hit, reset 168h out -> use card now
  assert.match(advice.cardTiming, /Use card now/);
});

test("card: expiring soon forces spend", () => {
  const advice = computeAdvice(state({
    remaining: 900_000,
    rateSamples: [
      { value: 5_000, at: NOW - 3_600_000 },
      { value: 5_000, at: NOW - 7_200_000 },
    ],
    cards: [{ count: 1, expiresAt: NOW + 12 * 3_600_000 }], // expires in 12h
  }), NOW);
  assert.match(advice.cardTiming, /Card expiring/);
});

test("card: no cap hit → save", () => {
  const advice = computeAdvice(state({
    remaining: 900_000,
    rateSamples: [
      { value: 5_000, at: NOW - 3_600_000 },
      { value: 5_000, at: NOW - 7_200_000 },
    ],
    cards: [{ count: 1, expiresAt: NOW + 20 * 24 * 3_600_000 }],
  }), NOW);
  assert.match(advice.cardTiming, /Card available/);
});

test("no divide by zero → finite numbers", () => {
  const advice = computeAdvice(state({ remaining: 500_000, rateSamples: [
    { value: 0, at: NOW - 3_600_000 },
    { value: 0, at: NOW - 7_200_000 },
  ] }), NOW);
  assert.ok(Number.isFinite(advice.sustainableRate));
  assert.equal(advice.projectedCapHitAt, null);
});

test("card: remaining=0 with a valid card -> spend it now, not save", () => {
  const advice = computeAdvice(state({
    remaining: 0,
    cards: [{ count: 1, expiresAt: NOW + 20 * 24 * 3_600_000 }],
  }), NOW);
  assert.match(advice.cardTiming, /Use card now/);
  assert.doesNotMatch(advice.cardTiming, /Save card/);
});

test("card: already-expired card is not actionable", () => {
  const advice = computeAdvice(state({
    cards: [{ count: 1, expiresAt: NOW - 3_600_000 }], // expired 1h ago
  }), NOW);
  assert.doesNotMatch(advice.cardTiming, /Use card now|Card expiring/);
  assert.match(advice.cardTiming, /No cards/);
});

test("card: all-expired cards -> No reset cards", () => {
  const advice = computeAdvice(state({
    cards: [
      { count: 2, expiresAt: NOW - 3_600_000 },
      { count: 1, expiresAt: NOW - 24 * 3_600_000 },
    ],
  }), NOW);
  assert.match(advice.cardTiming, /No cards/);
});

test("card: expires before reset in save branch → mentions it", () => {
  const advice = computeAdvice(state({
    remaining: 900_000,
    rateSamples: [
      { value: 5_000, at: NOW - 3_600_000 },
      { value: 5_000, at: NOW - 7_200_000 },
    ],
    cards: [{ count: 1, expiresAt: NOW + 3 * 24 * 3_600_000 }], // 3d < reset 7d
  }), NOW);
  assert.match(advice.cardTiming, /expires in/);
});

test("actualVsSustainable null/0 instead of Infinity", () => {
  const advice = computeAdvice(state({ remaining: 0 }), NOW); // sustainable 0, measured 50k
  assert.equal(advice.actualVsSustainable, null);
  const zeroRate = computeAdvice(state({
    remaining: 0,
    rateSamples: [
      { value: 0, at: NOW - 3_600_000 },
      { value: 0, at: NOW - 7_200_000 },
    ],
  }), NOW);
  assert.equal(zeroRate.actualVsSustainable, 0);
});

test("resetAt in past → yellow level + window-reset pacing", () => {
  const advice = computeAdvice(state({ resetAt: NOW - 1_000 }), NOW);
  assert.equal(advice.level, "yellow");
  assert.equal(advice.pacing, "Resetting");
  assert.match(advice.autoResetIn, /Resetting|reset/);
});

test("autoResetIn: same-day reset → at HH:MM", () => {
  const noon = new Date();
  noon.setHours(12, 0, 0, 0); // local noon, safe from midnight rollover
  const now = noon.getTime();
  const resetAt = now + 5 * 60_000;
  const advice = computeAdvice(state({ resetAt }), now);
  const d = new Date(resetAt);
  const hh = d.getHours().toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  assert.equal(advice.autoResetIn, `at ${hh}:${mm}`);
});

test("red from low remaining (not fast burn) -> Quota low copy", () => {
  const advice = computeAdvice(state({
    remaining: 40_000, // 4% of limit
    rateSamples: [
      { value: 100, at: NOW - 3_600_000 },
      { value: 100, at: NOW - 7_200_000 },
    ],
  }), NOW);
  assert.equal(advice.level, "red");
  assert.match(advice.pacing, /<5% left/);
  assert.doesNotMatch(advice.pacing, /Burning too fast/);
});
