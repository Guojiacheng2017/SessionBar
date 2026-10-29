import assert from "node:assert/strict";
import test from "node:test";
import { sessionDisplayName, sessionListColumns } from "../dist/tui/displayUtils.js";

test("session names stay distinct from project labels when the native name is missing", () => {
  assert.equal(sessionDisplayName({
    session_name: "  Refactor dashboard  ",
    project: "atlas",
    session_id: "claude-123",
  }), "Refactor dashboard");
  assert.equal(sessionDisplayName({
    project: "atlas",
    project_path: "/workspace/other-project",
    session_id: "claude-123",
  }), "Unnamed session · claude-123");
  assert.equal(sessionDisplayName({
    project_path: "/workspace/other-project/",
    session_id: "claude-123",
  }), "Unnamed session · claude-123");
  assert.equal(sessionDisplayName({ session_id: "claude-123__encoded-project" }), "Unnamed session · claude-123");
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
  }), { name: "Unnamed session · claude-123", project: "graphite" });
});

test("confirmed services get useful labels while unknown sessions retain distinct native IDs", () => {
  assert.equal(sessionDisplayName({ session_service: "mcp_extension_host" }), "MCP tool host");
  assert.equal(sessionDisplayName({ session_service: "composer_predictions" }), "Input suggestions");
  assert.equal(sessionDisplayName({ session_service: "mcp_extension_host", session_name: "Original title" }), "Original title");
  assert.deepEqual(sessionListColumns({ session_id: "01a18080-bfd7-7e41-925c-8cdca07635e6__/", project: "/", project_path: "/" }), {
    name: "Unnamed session · a07635e6", project: "?",
  });
});
