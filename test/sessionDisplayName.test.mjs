import assert from "node:assert/strict";
import test from "node:test";
import { sessionDisplayName, sessionListColumns } from "../dist/tui/displayUtils.js";
import { codexThreadMetadata } from "../dist/sessions/codexAppServer.js";

test("missing session names fall back to the project label", () => {
  assert.equal(sessionDisplayName({
    session_name: "  Refactor dashboard  ",
    project: "atlas",
    session_id: "claude-123",
  }), "Refactor dashboard");
  assert.equal(sessionDisplayName({
    project: "atlas",
    project_path: "/workspace/other-project",
    session_id: "claude-123",
  }), "atlas");
  assert.equal(sessionDisplayName({
    project_path: "/workspace/other-project/",
    session_id: "claude-123",
  }), "other-project");
  assert.equal(sessionDisplayName({ session_id: "claude-123__encoded-project" }), "encoded-project");
  assert.equal(sessionDisplayName({ session_name: "  ", project: " atlas " }), "atlas");
  assert.equal(sessionDisplayName({ project_path: "C:\\workspace\\atlas\\" }), "atlas");
  assert.equal(sessionDisplayName({ session_id: "claude-123" }), "Unnamed session · claude-123");
  assert.equal(sessionDisplayName({}), "Unnamed session");
});

test("session list uses the session-name fallback for the bold column and project for the second column", () => {
  assert.deepEqual(sessionListColumns({
    session_name: "Research&Focus",
    project: "atlas",
    session_id: "codex-123__atlas",
  }), { name: "Research&Focus", project: "atlas" });

  assert.deepEqual(sessionListColumns({
    project: "graphite",
    session_id: "claude-123__graphite",
  }), { name: "graphite", project: "graphite" });
});

test("confirmed services get useful labels while unknown sessions retain distinct native IDs", () => {
  assert.equal(sessionDisplayName({ session_service: "mcp_extension_host" }), "MCP tool host");
  assert.equal(sessionDisplayName({ session_service: "mcp_extension_host", project: "atlas" }), "MCP tool host");
  assert.equal(sessionDisplayName({ session_service: "composer_predictions" }), "Input suggestions");
  assert.equal(sessionDisplayName({ session_service: "mcp_extension_host", session_name: "Original title" }), "Original title");
  assert.deepEqual(sessionListColumns({ session_id: "01a18080-bfd7-7e41-925c-8cdca07635e6__/", project: "/", project_path: "/" }), {
    name: "Unnamed session · a07635e6", project: "?",
  });
});

test("Codex null native name uses its project, not the preview; a rename takes priority", () => {
  const thread = {
    id: "33333333-3333-4333-8333-33333333abcd",
    sessionId: "33333333-3333-4333-8333-33333333abcd",
    createdAt: 1_781_517_540,
    updatedAt: 1_793_543_434,
    status: { type: "idle" },
    source: "vscode",
    modelProvider: "openai",
    name: null,
    preview: "Review fixture project",
    cwd: "/workspace/atlas",
  };
  for (const name of [null, "Runtime fixes"]) {
    const metadata = codexThreadMetadata({ ...thread, name });
    const session = {
      session_id: `${metadata.threadId}__atlas`,
      session_name: metadata.sessionName,
      project: metadata.project,
      project_path: metadata.projectPath,
    };
    assert.equal(metadata.sessionName, name ?? undefined);
    assert.equal(sessionDisplayName(session), name ?? "atlas");
  }
});
