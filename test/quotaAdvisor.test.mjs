import { test } from "node:test";
import assert from "node:assert/strict";
import { computeAdvisorForSession } from "../dist/quotaAdvisor.js";

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

test("builds advisor from usage signal", () => {
  const advisor = computeAdvisorForSession(baseSession, new Map(), [], 1_700_000_000_000);
  assert.ok(advisor);
  assert.ok(["green", "yellow", "red"].includes(advisor.level));
  assert.equal(typeof advisor.pacing, "string");
});

test("returns null when no usage signal", () => {
  const advisor = computeAdvisorForSession({ ...baseSession, agent_signals: [] }, new Map(), [], 1_700_000_000_000);
  assert.equal(advisor, null);
});

test("non-openai/anthropic session returns null", () => {
  const advisor = computeAdvisorForSession({ ...baseSession, session_type: "DeepSeek" }, new Map(), [], 1_700_000_000_000);
  assert.equal(advisor, null);
});
