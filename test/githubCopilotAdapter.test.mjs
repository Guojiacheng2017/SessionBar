import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { fetchGitHubCopilotSubscription } from "../dist/providers/provider-plans/githubCopilotAdapter.js";
import { computePlanRows } from "../dist/providers/planAdvisor.js";

const credentialsPath = join(tmpdir(), "sessionbar-github-copilot-apps.json");
const missingCredentialsPath = join(tmpdir(), "sessionbar-github-copilot-missing.json");
const now = Date.parse("2026-08-10T10:40:00.000Z");

const copilotUser = {
  login: "Guojiacheng2017",
  copilot_plan: "individual_pro_plus",
  quota_reset_date_utc: "2026-09-01T00:00:00.000Z",
  quota_snapshots: {
    chat: { unlimited: true, entitlement: 0, remaining: 0 },
    completions: { unlimited: true, entitlement: 0, remaining: 0 },
    premium_interactions: {
      unlimited: false,
      entitlement: 7000,
      remaining: 4674,
      quota_remaining: 4674.5,
      credits_used: 2325,
      percent_remaining: 66.7,
    },
  },
};

before(() => {
  writeFileSync(credentialsPath, JSON.stringify({
    "github.com:Iv1.test": { oauth_token: "copilot-oauth-token" },
  }));
  rmSync(missingCredentialsPath, { force: true });
});

after(() => {
  rmSync(credentialsPath, { force: true });
  rmSync(missingCredentialsPath, { force: true });
});

test("fetches the personal Copilot entitlement and exposes live AI credit usage", async () => {
  let requestedUrl;
  let authorization;
  const rows = await fetchGitHubCopilotSubscription({
    credentialsPath,
    now,
    fetchImpl: async (url, init) => {
      requestedUrl = url;
      authorization = init?.headers?.Authorization;
      return new Response(JSON.stringify(copilotUser), { status: 200 });
    },
  });

  assert.equal(requestedUrl, "https://api.github.com/copilot_internal/user");
  assert.equal(authorization, "Bearer copilot-oauth-token");
  assert.equal(rows.length, 1);
  assert.partialDeepStrictEqual(rows[0], {
    form: "subscription",
    provider: "github",
    label: "GitHub Copilot Pro+",
    used: 2325,
    remaining: 4674.5,
    limit: 7000,
    unit: "AI credits",
  });
  assert.match(rows[0].autoResetIn, /21d/);
});

test("missing Copilot credentials produce no subscription row", async () => {
  const rows = await fetchGitHubCopilotSubscription({
    credentialsPath: missingCredentialsPath,
    fetchImpl: async () => new Response("{}", { status: 401 }),
  });
  assert.deepEqual(rows, []);
});

test("unusable entitlement payloads do not create a misleading quota row", async () => {
  const rows = await fetchGitHubCopilotSubscription({
    credentialsPath,
    fetchImpl: async () => new Response(JSON.stringify({
      copilot_plan: "individual_pro",
      quota_snapshots: { premium_interactions: { unlimited: true, entitlement: 0, remaining: 0 } },
    }), { status: 200 }),
  });
  assert.deepEqual(rows, []);
});

test("subscription aggregation keeps the Copilot row alongside other providers", async () => {
  const originalFetch = globalThis.fetch;
  delete process.env.SESSIONBAR_KIMI_ACCESS_TOKEN;
  delete process.env.KIMI_ACCESS_TOKEN;
  globalThis.fetch = async () => new Response(JSON.stringify(copilotUser), { status: 200 });
  try {
    const rows = await computePlanRows({
      now,
      openaiAuthPath: missingCredentialsPath,
      anthropicCredentialsPath: missingCredentialsPath,
      githubCopilotCredentialsPath: credentialsPath,
    });
    assert.ok(rows.some(row => row.provider === "github" && row.label === "GitHub Copilot Pro+"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
