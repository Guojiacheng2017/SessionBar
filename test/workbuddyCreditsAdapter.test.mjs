import assert from "node:assert/strict";
import test from "node:test";
import { parseWorkBuddyBalance, parseWorkBuddyCredits } from "../dist/providers/workbuddyCreditsAdapter.js";

test("accepts a user-provided WorkBuddy balance snapshot", () => {
  const row = parseWorkBuddyBalance(JSON.stringify({ remaining: 2471, used: 2250.52, unit: "credits" }));
  assert.equal(row?.remaining, 2471);
  assert.equal(row?.used, 2250.52);
  assert.equal(row?.unit, "credits");
});

test("rejects malformed user balance snapshots", () => {
  assert.equal(parseWorkBuddyBalance("{}"), null);
  assert.equal(parseWorkBuddyBalance("not json"), null);
});

test("aggregates WorkBuddy Desktop credit usage into one provider row", () => {
  const row = parseWorkBuddyCredits(JSON.stringify([
    { used: 100, size: 1000, credit_json: JSON.stringify({ modelA: 12.5, modelB: 7.5 }) },
    { used: 200, size: 2000, credit_json: JSON.stringify({ modelA: 3 }) },
  ]));
  assert.deepEqual(row, {
    form: "api",
    provider: "workbuddy",
    label: "WorkBuddy Desktop",
    level: "green",
    pacing: "",
    cardTiming: "",
    autoResetIn: "",
    sustainableRate: 0,
    actualVsSustainable: 0,
    projectedCapHitAt: null,
    used: 23,
    unit: "credits",
  });
});

test("falls back to session usage when WorkBuddy has no credit map", () => {
  const row = parseWorkBuddyCredits(JSON.stringify([{ used: 100, size: 1000 }, { used: 50, size: 500 }]));
  assert.equal(row?.used, 150);
  assert.equal(row?.limit, 1500);
});

test("malformed or empty WorkBuddy snapshots are ignored", () => {
  assert.equal(parseWorkBuddyCredits("not json"), null);
  assert.equal(parseWorkBuddyCredits("[]"), null);
});
