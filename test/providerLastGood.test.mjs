import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadProviderLastGood, retainProviderLastGood, saveProviderLastGood } from "../dist/providers/providerLastGood.js";

const row = {
  form: "subscription",
  provider: "openai",
  label: "OpenAI Subscription",
  level: "green",
  pacing: "",
  cardTiming: "",
  autoResetIn: "",
  sustainableRate: 0,
  actualVsSustainable: null,
  projectedCapHitAt: null,
  remaining: 80,
  limit: 100,
  unit: "%",
};

test("failed collections remain visible without becoming successful observations", () => {
  const failed = { ...row, remaining: undefined, collectionError: "Query unavailable" };
  const empty = retainProviderLastGood({ rows: [], seenAt: {} }, [failed], 200, 1000);
  assert.equal(empty.rows[0].collectionError, "Query unavailable");
  assert.equal(Object.keys(empty.seenAt).length, 0);
  const previous = { rows: [{ ...row, lastSeenAt: 100 }], seenAt: { "openai:subscription:OpenAI Subscription": 100 } };
  const retained = retainProviderLastGood(previous, [failed], 200, 1000);
  assert.equal(retained.rows[0].remaining, 80);
  assert.equal(retained.rows[0].lastSeenAt, 100);
  assert.equal(retained.rows[0].stale, true);
});

test("provider last-good survives a relay restart and is marked stale", () => {
  const path = join(mkdtempSync(join(tmpdir(), "sessionbar-provider-cache-")), "providers.json");
  const now = 1_700_000_000_000;
  const fresh = retainProviderLastGood({ rows: [], seenAt: {} }, [row], now, 30 * 86400_000);
  saveProviderLastGood(path, fresh);

  const loaded = loadProviderLastGood(path, now + 86400_000, 30 * 86400_000);
  assert.equal(loaded.rows.length, 1);
  assert.equal(loaded.rows[0].stale, true);
  assert.equal(loaded.rows[0].lastSeenAt, now);
});

test("fresh provider data replaces stale data and clears its stale marker", () => {
  const now = 1_700_000_000_000;
  const cached = retainProviderLastGood({ rows: [], seenAt: {} }, [row], now, 30 * 86400_000);
  const next = retainProviderLastGood(cached, [{ ...row, remaining: 70 }], now + 60_000, 30 * 86400_000);
  assert.equal(next.rows[0].remaining, 70);
  assert.equal(next.rows[0].stale, false);
  assert.equal(next.rows[0].lastSeenAt, now + 60_000);
});

test("last-good preserves the upstream observation time across repeated aggregation", () => {
  const observedAt = 1_700_000_000_000;
  const observed = { ...row, lastSeenAt: observedAt };
  const first = retainProviderLastGood({ rows: [], seenAt: {} }, [observed], observedAt + 10_000, 30 * 86400_000);
  const repeated = retainProviderLastGood(first, [observed], observedAt + 60_000, 30 * 86400_000);
  assert.equal(repeated.rows[0].lastSeenAt, observedAt);
  assert.equal(repeated.seenAt["openai:subscription:OpenAI Subscription"], observedAt);
});

test("provider last-good expires after its retention window", () => {
  const now = 1_700_000_000_000;
  const cached = retainProviderLastGood({ rows: [], seenAt: {} }, [row], now, 30 * 86400_000);
  const expired = retainProviderLastGood(cached, [], now + 31 * 86400_000, 30 * 86400_000);
  assert.deepEqual(expired.rows, []);
});
