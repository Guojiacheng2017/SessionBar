import assert from "node:assert/strict";
import test from "node:test";
import {
  codexThreadMetadata,
  parseCodexThreadListResponse,
} from "../dist/sessions/codexAppServer.js";
import * as codexAppServer from "../dist/sessions/codexAppServer.js";

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
  const expected = thread("22222222-2222-4222-8222-222222222222", "Web UI polish");
  const output = [
    JSON.stringify({ id: 1, result: { userAgent: "Codex" } }),
    JSON.stringify({ method: "thread/status/changed", params: {} }),
    JSON.stringify({ id: 2, result: { data: [expected], nextCursor: null } }),
  ].join("\n");

  assert.deepEqual(parseCodexThreadListResponse(output, 2), [expected]);
});

test("maps app-server thread metadata without inventing a session name", () => {
  assert.deepEqual(
    codexThreadMetadata(thread("22222222-2222-4222-8222-222222222222", "  Web UI polish  ")),
    {
      threadId: "22222222-2222-4222-8222-222222222222",
      isSubagent: false,
      sessionName: "Web UI polish",
      project: "atlas",
      projectPath: "/workspace/atlas",
      updatedAt: 1_700_000_100_000,
      source: "vscode",
      modelProvider: "openai",
      preview: "First user message",
      gitBranch: "main",
      gitSha: "abc123",
      sessionPath: "/tmp/22222222-2222-4222-8222-222222222222.jsonl",
    },
  );

  assert.equal(codexThreadMetadata(thread("22222222-2222-4222-8222-222222222222", null)).sessionName, undefined);
});

test("preserves explicit subagent identity from native metadata", () => {
  const child = thread("22222222-2222-4222-8222-222222222222", null);
  for (const source of ["subagent", { subagent: { thread_spawn: { parent_thread_id: "root" } } }]) {
    assert.equal(codexThreadMetadata({ ...child, source }).isSubagent, true);
  }
  assert.equal(codexThreadMetadata({ ...child, threadSource: "subagent" }).isSubagent, true);
  assert.equal(codexThreadMetadata({ ...child, thread_source: "subagent" }).isSubagent, true);
});

test("recent thread paths include resumed sessions stored in old date directories", () => {
  const now = 1_700_000_200_000;
  const resumed = {
    ...thread("44444444-4444-4444-8444-444444444444", "Resumed task"),
    path: "/sessions/2026/06/15/resumed.jsonl",
    updatedAt: now / 1000 - 30,
  };
  const stale = {
    ...thread("22222222-2222-4222-8222-222222222222", "Stale task"),
    path: "/sessions/2026/08/24/stale.jsonl",
    updatedAt: now / 1000 - 3_600,
  };

  assert.deepEqual(
    codexAppServer.recentCodexThreadPaths?.([resumed, stale], now, 30 * 60_000),
    ["/sessions/2026/06/15/resumed.jsonl"],
  );
});
