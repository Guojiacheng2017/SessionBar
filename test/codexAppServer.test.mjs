import assert from "node:assert/strict";
import test from "node:test";
import {
  codexThreadMetadata,
  parseCodexUsageResponse,
  parseCodexThreadListResponse,
} from "../dist/sessions/codexAppServer.js";

test("parses official Codex daily token buckets from account usage", () => {
  const output = [
    JSON.stringify({ method: "account/rateLimits/updated", params: {} }),
    JSON.stringify({ id: 2, result: {
      summary: { lifetimeTokens: 900 },
      dailyUsageBuckets: [
        { startDate: "2026-08-12", tokens: 367_400_000 },
        { startDate: "2026-08-13", tokens: 12_000_000 },
      ],
    } }),
  ].join("\n");

  assert.deepEqual(parseCodexUsageResponse(output), {
    "2026-08-12": 367_400_000,
    "2026-08-13": 12_000_000,
  });
});

const thread = (id, name) => ({
  id,
  sessionId: id,
  forkedFromId: null,
  preview: "First user message",
  ephemeral: false,
  modelProvider: "openai",
  createdAt: 1_700_000_000,
  updatedAt: 1_700_000_100,
  status: { type: "notLoaded" },
  path: `/tmp/${id}.jsonl`,
  cwd: "/workspace/atlas",
  cliVersion: "0.147.0",
  source: "vscode",
  threadSource: null,
  agentNickname: null,
  agentRole: null,
  gitInfo: { sha: "abc123", branch: "main", originUrl: null },
  name,
  turns: [],
});

test("parses the thread/list response while ignoring unrelated protocol messages", () => {
  const expected = thread("00000000-0000-4000-8000-000000000002", "Web UI polish");
  const output = [
    JSON.stringify({ id: 1, result: { userAgent: "Codex" } }),
    JSON.stringify({ method: "thread/status/changed", params: {} }),
    JSON.stringify({ id: 2, result: { data: [expected], nextCursor: null } }),
  ].join("\n");

  assert.deepEqual(parseCodexThreadListResponse(output, 2), [expected]);
});

test("maps app-server thread metadata without inventing a session name", () => {
  assert.deepEqual(
    codexThreadMetadata(thread("00000000-0000-4000-8000-000000000002", "  Web UI polish  ")),
    {
      threadId: "00000000-0000-4000-8000-000000000002",
      sessionName: "Web UI polish",
      project: "atlas",
      projectPath: "/workspace/atlas",
      updatedAt: 1_700_000_100_000,
      source: "vscode",
      modelProvider: "openai",
      preview: "First user message",
      gitBranch: "main",
      gitSha: "abc123",
    },
  );

  assert.equal(codexThreadMetadata(thread("00000000-0000-4000-8000-000000000002", null)).sessionName, undefined);
});
