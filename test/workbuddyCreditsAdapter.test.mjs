import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fetchWorkBuddyDesktopCredits, parseWorkBuddyBalance, parseWorkBuddyCredits } from "../dist/providers/workbuddyCreditsAdapter.js";

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

test("never reports context usage as account credits when the credit map is absent", () => {
  const row = parseWorkBuddyCredits(JSON.stringify([{ used: 100, size: 1000 }, { used: 50, size: 500 }]));
  assert.equal(row, null);
});

test("malformed or empty WorkBuddy snapshots are ignored", () => {
  assert.equal(parseWorkBuddyCredits("not json"), null);
  assert.equal(parseWorkBuddyCredits("[]"), null);
});

test("preserves an explicit zero-credit snapshot without falling back to context usage", () => {
  const row = parseWorkBuddyCredits(JSON.stringify([
    { used: 58618, size: 300000, credit_json: '{"request-zero":0}', updated_at: 2000 },
  ]));
  assert.equal(row?.used, 0);
  assert.equal(row?.limit, undefined);
  assert.equal(row?.remaining, undefined);
  assert.equal(row?.lastSeenAt, 2000);
});

test("uses the credit observation timestamp, not a newer context-only update", () => {
  const row = parseWorkBuddyCredits(JSON.stringify([
    { used: 58618, size: 300000, credit_json: null, updated_at: 9000 },
    { used: 100, size: 1000, credit_json: '{"request-a":12.5}', updated_at: 1000 },
    { used: 200, size: 2000, credit_json: '{"request-b":7.5}', updated_at: 2000 },
  ]));
  assert.equal(row?.used, 20);
  assert.equal(row?.lastSeenAt, 2000);
  assert.equal(row?.remaining, undefined);
  assert.equal(row?.limit, undefined);
});

test("ignores invalid credit maps instead of substituting context counts", () => {
  for (const credit_json of ['{}', '[]', '[12, 8]', '{"a":null}', '{"a":true}', '{"a":""}', '{"a":-1}', 'broken']) {
    assert.equal(parseWorkBuddyCredits(JSON.stringify([{ used: 999, size: 1000, credit_json }])), null, credit_json);
  }
});

test("does not coerce missing or nonnumeric balances into zero remaining", () => {
  for (const remaining of [null, true, false, '', ' ', [], [2471], {}, -1, 'Infinity']) {
    assert.equal(parseWorkBuddyBalance(JSON.stringify({ remaining })), null, JSON.stringify(remaining));
  }
  assert.equal(parseWorkBuddyBalance('{"remaining":0}')?.remaining, 0);
  assert.equal(parseWorkBuddyBalance('{"remaining":"2471.125"}')?.remaining, 2471.125);
});

test("queries the current session_usage schema read-only without inventing balance or refreshing its age", async t => {
  const root = mkdtempSync(join(tmpdir(), "sessionbar-workbuddy-credits-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dbPath = join(root, "workbuddy.db");
  execFileSync("sqlite3", [dbPath, `
    CREATE TABLE session_usage (session_id TEXT PRIMARY KEY, used INTEGER NOT NULL, size INTEGER NOT NULL, updated_at INTEGER NOT NULL, credit_json TEXT);
    INSERT INTO session_usage VALUES ('first', 58618, 300000, 9000, NULL);
    INSERT INTO session_usage VALUES ('second', 200, 2000, 2000, '{"request-one":20.125}');
  `]);
  const hash = () => createHash("sha256").update(readFileSync(dbPath)).digest("hex");
  const before = hash();
  const row = await fetchWorkBuddyDesktopCredits({ dbPath, balanceCommand: "" });
  assert.equal(row?.used, 20.125);
  assert.equal(row?.lastSeenAt, 2000);
  assert.equal(row?.remaining, undefined);
  assert.equal(row?.limit, undefined);
  assert.equal(hash(), before);
});

test("an unavailable or incompatible optional credit database returns no fabricated row", async t => {
  const root = mkdtempSync(join(tmpdir(), "sessionbar-workbuddy-credits-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dbPath = join(root, "workbuddy.db");
  assert.equal(await fetchWorkBuddyDesktopCredits({ dbPath, balanceCommand: "" }), null);
  assert.equal(existsSync(dbPath), false);
  execFileSync("sqlite3", [dbPath, "CREATE TABLE other (id INTEGER);"]);
  assert.equal(await fetchWorkBuddyDesktopCredits({ dbPath, balanceCommand: "" }), null);
  assert.equal(await fetchWorkBuddyDesktopCredits({ dbPath, balanceCommand: "", sqlitePath: join(root, "missing-sqlite") }), null);
});
