import { test } from "node:test";
import assert from "node:assert/strict";
import { computePlanRows } from "../dist/providers/planAdvisor.js";

// Hermetic: drop kimi access-token env so the subscription adapters
// short-circuit to "no credentials" unless a test sets them explicitly.
delete process.env.SESSIONBAR_KIMI_ACCESS_TOKEN;
delete process.env.KIMI_ACCESS_TOKEN;

// Non-existent paths force the file-based adapters to bail out (wham → null,
// anthropic → []), and no kimi token → []. The aggregate is deterministically [].
const noCredsOpts = {
  now: 1_700_000_000_000,
  openaiAuthPath: "/nonexistent/wham-auth.json",
  anthropicCredentialsPath: "/nonexistent/claude-credentials.json",
  githubCopilotCredentialsPath: "/nonexistent/github-copilot-apps.json",
};

test("aggregates available subscription adapters without crashing", async () => {
  const rows = await computePlanRows(noCredsOpts);
  assert.ok(Array.isArray(rows));
});

test("returns empty array when no credentials are available", async () => {
  const rows = await computePlanRows(noCredsOpts);
  assert.deepEqual(rows, []);
});

function kimiEnvFixture() {
  const origFetch = globalThis.fetch;
  let sawAuth;
  const now = 1_700_000_000_000;
  globalThis.fetch = async (_url, init) => {
    sawAuth = init?.headers?.Authorization;
    return new Response(JSON.stringify({
      usage: { limit: "100", remaining: "80", resetTime: new Date(now + 3600000).toISOString() },
      limits: [],
    }), { status: 200 });
  };
  return {
    opts: { ...noCredsOpts, now },
    auth: () => sawAuth,
    restore: () => { globalThis.fetch = origFetch; },
  };
}

test("kimi access token from env reaches kimi adapter (SESSIONBAR_KIMI_ACCESS_TOKEN)", async () => {
  process.env.SESSIONBAR_KIMI_ACCESS_TOKEN = "env-kimi-token";
  const fixture = kimiEnvFixture();
  try {
    const rows = await computePlanRows(fixture.opts);
    assert.equal(fixture.auth(), "Bearer env-kimi-token");
    assert.ok(rows.some(r => r.provider === "kimi"), "expected a kimi subscription row");
  } finally {
    delete process.env.SESSIONBAR_KIMI_ACCESS_TOKEN;
    fixture.restore();
  }
});

test("bare KIMI_ACCESS_TOKEN env also enables kimi subscription rows", async () => {
  process.env.KIMI_ACCESS_TOKEN = "bare-kimi-token";
  const fixture = kimiEnvFixture();
  try {
    const rows = await computePlanRows(fixture.opts);
    assert.equal(fixture.auth(), "Bearer bare-kimi-token");
    assert.ok(rows.some(r => r.provider === "kimi"), "expected a kimi subscription row");
  } finally {
    delete process.env.KIMI_ACCESS_TOKEN;
    fixture.restore();
  }
});
