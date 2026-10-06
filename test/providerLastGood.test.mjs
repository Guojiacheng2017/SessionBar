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

test("provider last-good expires after its retention window", () => {
  const now = 1_700_000_000_000;
  const cached = retainProviderLastGood({ rows: [], seenAt: {} }, [row], now, 30 * 86400_000);
  const expired = retainProviderLastGood(cached, [], now + 31 * 86400_000, 30 * 86400_000);
  assert.deepEqual(expired.rows, []);
});
