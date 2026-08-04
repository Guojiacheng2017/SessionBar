import { test } from "node:test";
import assert from "node:assert/strict";
import { computePlanRows } from "../dist/planAdvisor.js";

// Non-existent paths force the file-based adapters to bail out (wham → null,
// anthropic → []), and no kimi token → []. The aggregate is deterministically [].
const noCredsOpts = {
  now: 1_700_000_000_000,
  openaiAuthPath: "/nonexistent/wham-auth.json",
  anthropicCredentialsPath: "/nonexistent/claude-credentials.json",
};

test("aggregates available subscription adapters without crashing", async () => {
  const rows = await computePlanRows(noCredsOpts);
  assert.ok(Array.isArray(rows));
});

test("returns empty array when no credentials are available", async () => {
  const rows = await computePlanRows(noCredsOpts);
  assert.deepEqual(rows, []);
});
