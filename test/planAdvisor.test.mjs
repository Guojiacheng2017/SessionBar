import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { computePlanRows } from "../dist/providers/planAdvisor.js";

// Hermetic: drop kimi access-token env so the subscription adapters
// short-circuit to "no credentials" unless a test sets them explicitly.
delete process.env.SESSIONBAR_KIMI_ACCESS_TOKEN;
delete process.env.KIMI_ACCESS_TOKEN;
process.env.SESSIONBAR_GROK_BILLING = "0";
delete process.env.SESSIONBAR_WORKBUDDY_BALANCE_COMMAND;

// Non-existent paths force the file-based adapters to bail out (wham → null,
// anthropic → []), and no kimi token → []. The aggregate is deterministically [].
const noCredsOpts = {
  now: 1_700_000_000_000,
  openaiAuthPath: "/nonexistent/wham-auth.json",
  anthropicCredentialsPath: "/nonexistent/claude-credentials.json",
  githubCopilotCredentialsPath: "/nonexistent/github-copilot-apps.json",
  workbuddyDbPath: "/nonexistent/workbuddy.db",
  workbuddyBalanceCommand: "",
  grokBillingEnabled: false,
};

test("aggregates available subscription adapters without crashing", async () => {
  const rows = await computePlanRows(noCredsOpts);
  assert.ok(Array.isArray(rows));
});

test("aggregation uses the injected HTTP transport for every subscription provider", async t => {
  const directory = mkdtempSync(join(tmpdir(), "sessionbar-plan-transports-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const authPath = join(directory, "auth.json");
  const claudePath = join(directory, "claude.json");
  writeFileSync(authPath, JSON.stringify({ tokens: { access_token: "fixture-openai" } }));
  writeFileSync(claudePath, JSON.stringify({ accessToken: "fixture-anthropic" }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Unexpected default transport"); };
  t.after(() => { globalThis.fetch = originalFetch; });
  const reset = "2023-11-21T22:13:20.000Z";
  const rows = await computePlanRows({
    ...noCredsOpts,
    openaiAuthPath: authPath,
    anthropicCredentialsPath: claudePath,
    kimiAccessToken: "fixture-kimi",
    githubCopilotToken: "fixture-github",
    fetchImpl: async input => {
      const url = String(input);
      let body = {};
      if (url.endsWith("/wham/usage")) body = { rate_limit: { primary_window: { used_percent: 10, reset_at: 1700604800 } } };
      else if (url.includes("anthropic.com")) body = { five_hour: { utilization: 20, resets_at: reset } };
      else if (url.includes("kimi.com")) body = { usage: { limit: 100, remaining: 70, resetTime: reset }, limits: [] };
      else if (url.includes("github.com")) body = { quota_reset_date_utc: reset, quota_snapshots: { premium_interactions: { entitlement: 100, remaining: 60 } } };
      return new Response(JSON.stringify(body), { status: 200 });
    },
  });
  assert.deepEqual(rows.map(row => row.provider).sort(), ["anthropic", "github", "kimi", "openai"]);
});

test("disabled external billing does not start an installed CLI", async t => {
  const directory = mkdtempSync(join(tmpdir(), "sessionbar-plan-child-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const grokDirectory = join(directory, ".grok");
  mkdirSync(grokDirectory);
  writeFileSync(join(grokDirectory, "auth.json"), "{}");
  const marker = join(directory, "started");
  const executable = join(directory, "fixture-cli");
  writeFileSync(executable, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o700 });
  const source = `import { computePlanRows } from ${JSON.stringify(new URL("../dist/providers/planAdvisor.js", import.meta.url).href)};\nconsole.log(JSON.stringify(await computePlanRows(${JSON.stringify(noCredsOpts)})));`;
  const result = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", source], {
    cwd: resolve("."),
    env: { ...process.env, HOME: directory, SESSIONBAR_GROK_BILLING: "1", SESSIONBAR_GROK_BIN: executable },
    timeout: 5_000,
  });
  assert.equal(existsSync(marker), false);
  assert.deepEqual(JSON.parse(result.stdout), []);
});

test("returns empty array when no credentials are available", async () => {
  const rows = await computePlanRows(noCredsOpts);
  assert.deepEqual(rows, []);
});

function kimiEnvFixture() {
  let sawAuth;
  const now = 1_700_000_000_000;
  const fetchImpl = async (_url, init) => {
    sawAuth = init?.headers?.Authorization;
    return new Response(JSON.stringify({
      usage: { limit: "100", remaining: "80", resetTime: new Date(now + 3600000).toISOString() },
      limits: [],
    }), { status: 200 });
  };
  return {
    opts: { ...noCredsOpts, now, fetchImpl },
    auth: () => sawAuth,
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
  }
});
