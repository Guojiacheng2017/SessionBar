import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { fetchOpenAISubscription } from "../dist/provider-plans/whamAdapter.js";

const authJsonPath = join(tmpdir(), "wham-test-auth.json");
const missingAuthPath = join(tmpdir(), "wham-nonexistent-auth.json");

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
});

test("builds subscription row from wham usage + credits", async () => {
  const row = await fetchOpenAISubscription({
    authJsonPath,
    fetchImpl: async (url) => {
      if (url.includes("rate-limit-reset-credits")) {
        return new Response(JSON.stringify({
          available_count: 1,
          credits: [{ expires_at: new Date(Date.now() + 86400000).toISOString() }],
        }), { status: 200 });
      }
      // wham/usage — 真实结构: rate_limit.primary_window.{used_percent, reset_at}
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
  assert.match(row.cardTiming, /攒|未触顶/);
});

test("missing auth → null", async () => {
  const row = await fetchOpenAISubscription({
    authJsonPath: missingAuthPath,
    fetchImpl: async () => new Response("{}", { status: 401 }),
  });
  assert.equal(row, null);
});
