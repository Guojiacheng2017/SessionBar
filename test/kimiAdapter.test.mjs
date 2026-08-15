import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { fetchKimiSubscription } from "../dist/providers/provider-plans/kimiAdapter.js";

// hermetic fixture dir under os.tmpdir() — no /tmp hardcoding
const fixtureDir = mkdtempSync(join(tmpdir(), "kimi-adapter-test-"));

before(() => {
  // token passed via opts — nothing to seed
});
after(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

test("builds overall + 5h windowed rows from coding usage (string limit/remaining)", async () => {
  const now = Date.now();
  let sentHeaders;
  let sentMethod;
  const rows = await fetchKimiSubscription({
    accessToken: "kimi-test-token",
    now,
    fetchImpl: async (_url, init) => {
      sentHeaders = init?.headers;
      sentMethod = init?.method;
      return new Response(JSON.stringify({
        usage: {
          limit: "100",
          remaining: "74",
          resetTime: new Date(now + 86400000).toISOString(),
        },
        limits: [{
          window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
          detail: {
            limit: "10",
            remaining: "6",
            resetTime: new Date(now + 300 * 60000).toISOString(),
          },
        }],
      }), { status: 200 });
    },
  });

  assert.equal(sentHeaders?.Authorization, "Bearer kimi-test-token");
  assert.equal(sentHeaders?.Accept, "application/json");
  assert.equal(sentMethod, "GET");

  assert.equal(rows.length, 2);
  assert.ok(rows.every(r => r.form === "subscription" && r.provider === "kimi"));

  const overall = rows.find(r => r.label === "Kimi Subscription (overall)");
  const fiveHour = rows.find(r => r.label === "Kimi Subscription (5h)");
  assert.ok(overall && fiveHour);

  // string limit/remaining parsed as numbers
  assert.equal(overall.limit, 100);
  assert.equal(overall.remaining, 74);
  assert.equal(fiveHour.limit, 10);
  assert.equal(fiveHour.remaining, 6);

  // 5h window → remaining 6 over 5h
  assert.ok(Math.abs(fiveHour.sustainableRate - 6 / 5) < 1e-9);
  // overall weekly → remaining 74 over 24h
  assert.ok(Math.abs(overall.sustainableRate - 74 / 24) < 1e-9);
});

test("epoch resetTime (seconds) is converted to ms", async () => {
  const now = Date.now();
  const rows = await fetchKimiSubscription({
    accessToken: "kimi-test-token",
    now,
    fetchImpl: async () => new Response(JSON.stringify({
      usage: { limit: "100", remaining: "50", resetTime: (now + 3600000) / 1000 },
      limits: [{
        window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
        detail: { limit: "10", remaining: "8", resetTime: new Date(now + 300 * 60000).toISOString() },
      }],
    }), { status: 200 }),
  });
  assert.equal(rows.length, 2);
  const overall = rows.find(r => r.label === "Kimi Subscription (overall)");
  assert.ok(overall);
  // 50 remaining over 1h
  assert.ok(Math.abs(overall.sustainableRate - 50) < 1e-9);
});

test("missing/empty accessToken → empty array", async () => {
  assert.deepEqual(
    await fetchKimiSubscription({ fetchImpl: async () => new Response("{}", { status: 200 }) }),
    [],
  );
  assert.deepEqual(
    await fetchKimiSubscription({ accessToken: "", fetchImpl: async () => new Response("{}", { status: 200 }) }),
    [],
  );
});

test("non-ok response → empty array", async () => {
  const rows = await fetchKimiSubscription({
    accessToken: "kimi-test-token",
    fetchImpl: async () => new Response("{}", { status: 401 }),
  });
  assert.deepEqual(rows, []);
});

test("fetch failure → empty array", async () => {
  const rows = await fetchKimiSubscription({
    accessToken: "kimi-test-token",
    fetchImpl: async () => { throw new Error("network down"); },
  });
  assert.deepEqual(rows, []);
});

test("body without usage/limits → empty array", async () => {
  const rows = await fetchKimiSubscription({
    accessToken: "kimi-test-token",
    fetchImpl: async () => new Response(JSON.stringify({ foo: "bar" }), { status: 200 }),
  });
  assert.deepEqual(rows, []);
});
