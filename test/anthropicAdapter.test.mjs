import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { fetchAnthropicSubscription } from "../dist/provider-plans/anthropicAdapter.js";

const credsPath = join(tmpdir(), "anthropic-test-creds.json");
const missingCredsPath = join(tmpdir(), "anthropic-nonexistent-creds.json");
const tokenlessPath = join(tmpdir(), "anthropic-tokenless-creds.json");

before(() => {
  writeFileSync(credsPath, JSON.stringify({
    tokens: { accessToken: "test-oauth-token-abc" },
  }));
  writeFileSync(tokenlessPath, JSON.stringify({
    someOtherField: true,
  }));
  rmSync(missingCredsPath, { force: true });
});
after(() => {
  rmSync(credsPath, { force: true });
  rmSync(missingCredsPath, { force: true });
  rmSync(tokenlessPath, { force: true });
});

test("builds 5h + weekly rows from oauth usage", async () => {
  let sentHeaders;
  const now = Date.now();
  const rows = await fetchAnthropicSubscription({
    credentialsPath: credsPath,
    now,
    fetchImpl: async (_url, init) => {
      sentHeaders = init?.headers;
      return new Response(JSON.stringify({
        five_hour: { utilization: 30, resets_at: new Date(now + 5 * 3600000).toISOString() },
        seven_day: { utilization: 50, resets_at: new Date(now + 3 * 86400000).toISOString() },
      }), { status: 200 });
    },
  });
  assert.equal(rows.length, 2);
  assert.ok(rows.every(r => r.form === "subscription" && r.provider === "anthropic"));
  assert.ok(sentHeaders);
  assert.equal(sentHeaders.Authorization, "Bearer test-oauth-token-abc");
  assert.equal(sentHeaders["anthropic-beta"], "oauth-2025-04-20");
  const fiveHour = rows.find(r => r.label === "Anthropic 订阅 (5h)");
  const weekly = rows.find(r => r.label === "Anthropic 订阅 (weekly)");
  assert.ok(fiveHour && weekly);
  assert.equal(fiveHour.sustainableRate, 70 / 5); // 100-30 = 70 remaining over 5h
  assert.equal(weekly.sustainableRate, 50 / (3 * 24)); // 100-50 = 50 remaining over 3d
});

test("oauth.access_token shape + epoch resets_at both work", async () => {
  writeFileSync(credsPath, JSON.stringify({
    oauth: { access_token: "second-token" },
  }));
  const rows = await fetchAnthropicSubscription({
    credentialsPath: credsPath,
    fetchImpl: async (_url, init) => {
      const headers = init?.headers;
      assert.equal(headers.Authorization, "Bearer second-token");
      return new Response(JSON.stringify({
        five_hour: { utilization: 40, resets_at: Date.now() / 1000 + 5 * 3600 },
        seven_day: { utilization: 60, resets_at: Date.now() + 2 * 86400000 },
      }), { status: 200 });
    },
  });
  assert.equal(rows.length, 2);
  assert.ok(rows.every(r => r.provider === "anthropic"));
});

test("no credentials → empty array", async () => {
  const rows = await fetchAnthropicSubscription({
    credentialsPath: missingCredsPath,
    fetchImpl: async () => new Response("{}", { status: 401 }),
  });
  assert.deepEqual(rows, []);
});

test("credentials without token → empty array", async () => {
  const rows = await fetchAnthropicSubscription({
    credentialsPath: tokenlessPath,
    fetchImpl: async () => new Response("{}", { status: 200 }),
  });
  assert.deepEqual(rows, []);
});

test("non-ok usage response → empty array", async () => {
  const rows = await fetchAnthropicSubscription({
    credentialsPath: credsPath,
    fetchImpl: async () => new Response("{}", { status: 403 }),
  });
  assert.deepEqual(rows, []);
});
