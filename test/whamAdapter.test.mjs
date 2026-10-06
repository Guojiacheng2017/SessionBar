import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { fetchOpenAISubscription } from "../dist/providers/provider-plans/whamAdapter.js";

const authJsonPath = join(tmpdir(), "wham-test-auth.json");
const missingAuthPath = join(tmpdir(), "wham-nonexistent-auth.json");
const consumptionStatePath = join(tmpdir(), "wham-test-reset-card-state.json");

before(() => {
  writeFileSync(authJsonPath, JSON.stringify({
    tokens: { access_token: "test-token-abc" },
    account_id: "test-account",
  }));
  rmSync(missingAuthPath, { force: true });
});
after(() => {
  rmSync(authJsonPath, { force: true });
  rmSync(missingAuthPath, { force: true });
  rmSync(consumptionStatePath, { force: true });
});

test("builds subscription row from wham usage + credits", async () => {
  const now = Date.parse("2026-08-14T10:00:00.000Z");
  const row = await fetchOpenAISubscription({
    authJsonPath,
    now,
    fetchImpl: async (url) => {
      if (url.includes("profiles/me")) {
        return new Response(JSON.stringify({
          stats: { daily_usage_buckets: [
            { start_date: "2026-08-12", tokens: 367_400_000 },
            { start_date: "2026-08-13", tokens: 12_000_000 },
          ] },
        }), { status: 200 });
      }
      if (url.includes("rate-limit-reset-credits")) {
        return new Response(JSON.stringify({
          available_count: 1,
          credits: [{ expires_at: new Date(Date.now() + 86400000).toISOString() }],
        }), { status: 200 });
      }
      // wham/usage - real structure: rate_limit.primary_window.{used_percent, reset_at}
      return new Response(JSON.stringify({
        rate_limit: {
          primary_window: { used_percent: 40, reset_at: Date.now() + 3 * 86400000 },
        },
      }), { status: 200 });
    },
  });
  assert.ok(row);
  assert.equal(row.form, "subscription");
  assert.equal(row.provider, "openai");
  assert.match(row.cardTiming, /Card expires in/);
  assert.equal(row.usageTrend.unit, "tokens");
  assert.equal(row.usageTrend.source, "OpenAI API");
  assert.deepEqual(row.usageTrend.points.slice(-3), [367_400_000, 12_000_000, null]);
  assert.deepEqual(row.usageTrend.labels.slice(-3), ["2026-08-12", "2026-08-13", "2026-08-14"]);
});

test("derives a calendar-day quota pace from utilization and reset time", async () => {
  const now = Date.parse("2026-08-19T09:00:00.000Z");
  const resetAt = now + 18 * 60 * 60 * 1000;
  const row = await fetchOpenAISubscription({
    authJsonPath,
    now,
    fetchImpl: async (url) => {
      if (String(url).includes("rate-limit-reset-credits")) {
        return new Response(JSON.stringify({ credits: [] }), { status: 200 });
      }
      if (String(url).includes("profiles/me")) {
        return new Response(JSON.stringify({}), { status: 200 });
      }
      return new Response(JSON.stringify({
        rate_limit: { primary_window: { used_percent: 99, reset_at: resetAt } },
      }), { status: 200 });
    },
  });

  assert.ok(row);
  assert.equal(row.level, "red");
  assert.ok(Math.abs(row.measuredRate - 0.66) < 0.001, `rate=${row.measuredRate}`);
  assert.equal(row.measuredRateLabel, "15.84%/day avg");
  assert.ok(row.actualVsSustainable > 10);
  assert.ok(row.projectedCapHitAt > now && row.projectedCapHitAt < resetAt);
  assert.match(row.pacing, /%\/h/);
});

test("missing auth → null", async () => {
  const row = await fetchOpenAISubscription({
    authJsonPath: missingAuthPath,
    fetchImpl: async () => new Response("{}", { status: 401 }),
  });
  assert.equal(row, null);
});

test("keeps a recently expired provider card visible without making it consumable", async () => {
  const now = Date.parse("2026-08-13T10:00:00.000Z");
  const row = await fetchOpenAISubscription({
    authJsonPath,
    now,
    autoConsumeResetCards: true,
    fetchImpl: async (url) => {
      if (url.includes("rate-limit-reset-credits")) {
        return new Response(JSON.stringify({ credits: [
          { id: "expired-card", expires_at: new Date(now - 2 * 86400000).toISOString() },
        ] }), { status: 200 });
      }
      return new Response(JSON.stringify({
        rate_limit: { primary_window: { used_percent: 40, reset_at: now + 3 * 86400000 } },
      }), { status: 200 });
    },
  });
  assert.ok(row);
  assert.equal(row.cardTiming, "Card expired 2d ago");
});

test("reads account id from the current nested Codex auth shape", async () => {
  writeFileSync(authJsonPath, JSON.stringify({
    tokens: { access_token: "test-token-abc", account_id: "nested-account" },
  }));
  const seenAccountIds = [];
  const row = await fetchOpenAISubscription({
    authJsonPath,
    fetchImpl: async (url, init) => {
      seenAccountIds.push(init?.headers?.["ChatGPT-Account-Id"]);
      if (url.includes("rate-limit-reset-credits")) {
        return new Response(JSON.stringify({ credits: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({
        rate_limit: { primary_window: { used_percent: 40, reset_at: Date.now() + 3 * 86400000 } },
      }), { status: 200 });
    },
  });
  assert.ok(row);
  assert.deepEqual(seenAccountIds, ["nested-account", "nested-account", "nested-account"]);
});

test("auto-consumes the nearest reset card only when enabled", async () => {
  const now = Date.parse("2026-08-13T10:00:00.000Z");
  const requests = [];
  let consumeResult;
  let creditsReads = 0;
  const row = await fetchOpenAISubscription({
    authJsonPath,
    now,
    autoConsumeResetCards: true,
    consumptionStatePath,
    onResetCardConsume: (result) => { consumeResult = result; },
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      if (String(url).endsWith("/consume")) {
        return new Response(JSON.stringify({ status: "reset" }), { status: 200 });
      }
      if (String(url).includes("rate-limit-reset-credits")) {
        creditsReads += 1;
        return new Response(JSON.stringify({ credits: creditsReads === 1 ? [
          { id: "nearest-card", status: "available", expires_at: now + 4 * 60 * 1000 },
          { id: "later-card", status: "available", expires_at: now + 2 * 86400000 },
        ] : [] }), { status: 200 });
      }
      return new Response(JSON.stringify({
        rate_limit: { primary_window: { used_percent: 40, reset_at: now + 3 * 86400000 } },
      }), { status: 200 });
    },
  });
  assert.ok(row);
  const consume = requests.find(request => request.url.endsWith("/consume"));
  assert.ok(consume, "expected a reset-card consume request");
  assert.equal(consume.init.method, "POST");
  assert.equal(consume.init.headers["ChatGPT-Account-Id"], "nested-account");
  assert.equal(consume.init.headers["Content-Type"], "application/json");
  const body = JSON.parse(consume.init.body);
  assert.equal(body.credit_id, "nearest-card");
  assert.match(body.redeem_request_id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(consumeResult, {
    outcome: "reset",
    cardId: "nearest-card",
    idempotencyKey: body.redeem_request_id,
  });
});

test("does not consume an expiring reset card when the setting is disabled", async () => {
  const now = Date.parse("2026-08-13T10:00:00.000Z");
  const requests = [];
  const row = await fetchOpenAISubscription({
    authJsonPath,
    now,
    autoConsumeResetCards: false,
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      if (String(url).includes("rate-limit-reset-credits")) {
        return new Response(JSON.stringify({ credits: [
          { id: "nearest-card", status: "available", expires_at: now + 4 * 60 * 1000 },
        ] }), { status: 200 });
      }
      return new Response(JSON.stringify({
        rate_limit: { primary_window: { used_percent: 40, reset_at: now + 3 * 86400000 } },
      }), { status: 200 });
    },
  });
  assert.ok(row);
  assert.equal(requests.some(request => request.url.endsWith("/consume")), false);
});
