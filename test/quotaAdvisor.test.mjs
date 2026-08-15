import { test } from "node:test";
import assert from "node:assert/strict";
import { computeAdvisorRows } from "../dist/providers/quotaAdvisor.js";

const baseSession = {
  session_id: "codex-abc__Vision-Dash",
  session_type: "Codex",
  status: "working",
  task_name: "running",
  timestamp: 1_700_000_000_000,
  agent_signals: [
    { signal: "openai.usage", kind: "usage", source: "provider_api", scope: "account", used: 500_000, limit: 1_000_000, unit: "tokens" },
  ],
};

// --- computeAdvisorRows (multi-form) ---

test("computeAdvisorRows: usage signal becomes api row", async () => {
  const rows = await computeAdvisorRows(baseSession, new Map(), 1_700_000_000_000);
  const api = rows.find(r => r.form === "api");
  assert.ok(api, "expected an api row");
  assert.equal(api.provider, "openai");
  assert.equal(api.used, 500_000);
  assert.equal(api.remaining, 500_000);
  assert.equal(api.unit, "tokens");
});

test("computeAdvisorRows: balance signal on non-target session becomes api row (no TARGETS gate)", async () => {
  const session = {
    ...baseSession,
    session_type: "DeepSeek",
    agent_signals: [
      { signal: "deepseek.balance", kind: "balance", source: "provider_api", scope: "account", remaining: 42.5, unit: "USD" },
    ],
  };
  const rows = await computeAdvisorRows(session, new Map(), 1_700_000_000_000);
  const api = rows.find(r => r.form === "api");
  assert.ok(api, "expected an api row for balance signal");
  assert.equal(api.provider, "deepseek");
  assert.equal(api.remaining, 42.5);
  assert.equal(api.unit, "USD");
});

test("computeAdvisorRows: signal.balance maps to remaining", async () => {
  const session = {
    ...baseSession,
    agent_signals: [
      { signal: "xai.balance", kind: "balance", source: "provider_api", scope: "account", balance: 7.25, balance_unit: "USD" },
    ],
  };
  const rows = await computeAdvisorRows(session, new Map(), 1_700_000_000_000);
  const api = rows.find(r => r.form === "api");
  assert.ok(api, "expected an api row");
  assert.equal(api.provider, "xai");
  assert.equal(api.remaining, 7.25);
  assert.equal(api.unit, "USD");
});

test("computeAdvisorRows: no signals and no subscription rows → []", async () => {
  const rows = await computeAdvisorRows({ ...baseSession, agent_signals: [] }, new Map(), 1_700_000_000_000);
  assert.deepEqual(rows, []);
});

test("computeAdvisorRows: distinct api signals without labels keep distinct labels (not provider-collapsed)", async () => {
  const session = {
    ...baseSession,
    agent_signals: [
      { signal: "openai.usage", kind: "usage", source: "provider_api", scope: "account", used: 500_000, limit: 1_000_000, unit: "tokens" },
      { signal: "openai.balance", kind: "balance", source: "provider_api", scope: "account", remaining: 42.5, unit: "USD" },
    ],
  };
  const rows = await computeAdvisorRows(session, new Map(), 1_700_000_000_000);
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map(r => r.label).sort(),
    ["openai.balance", "openai.usage"],
  );
});
