import assert from "node:assert/strict";
import test from "node:test";
import { sessionDisplayName, sessionListColumns } from "../dist/tui/displayUtils.js";

test("session display name follows name, project, path, then id fallback order", () => {
  assert.equal(sessionDisplayName({
    session_name: "  Refactor dashboard  ",
    project: "Vision-Dash",
    session_id: "claude-123",
  }), "Refactor dashboard");
  assert.equal(sessionDisplayName({
    project: "Vision-Dash",
    project_path: "/workspace/other-project",
    session_id: "claude-123",
  }), "Vision-Dash");
  assert.equal(sessionDisplayName({
    project_path: "/workspace/other-project/",
    session_id: "claude-123",
  }), "other-project");
  assert.equal(sessionDisplayName({ session_id: "claude-123__encoded-project" }), "encoded-project");
  assert.equal(sessionDisplayName({ session_id: "claude-123" }), "claude-123");
  assert.equal(sessionDisplayName({}), "?");
});

test("session list uses the session-name fallback for the bold column and project for the second column", () => {
  assert.deepEqual(sessionListColumns({
    session_name: "Research&Focus",
    project: "Vision-Dash",
    session_id: "codex-123__Vision-Dash",
  }), { name: "Research&Focus", project: "Vision-Dash" });

  assert.deepEqual(sessionListColumns({
    project: "graphite",
    session_id: "claude-123__graphite",
  }), { name: "graphite", project: "graphite" });
});
