import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverClaudeDesktopSessions } from "../dist/sessions/claudeDesktopDiscovery.js";

function fixture(root, id, extra = {}) {
  const dir = join(root, "account", "shard");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), JSON.stringify({
    sessionId: id,
    cwd: `/private/claude/${id}`,
    userSelectedFolders: ["/Users/test/project"],
    createdAt: 1_000,
    lastActivityAt: 1_000,
    model: "kimi-k3",
    title: "Kimi work",
    isArchived: false,
    ...extra,
  }));
}

test("discovers Claude Desktop sessions and maps kimi model provider", () => {
  const root = mkdtempSync(join(tmpdir(), "sessionbar-claude-"));
  fixture(root, "local_one");
  const [session] = discoverClaudeDesktopSessions({ root, now: 1_005, windowMs: 10_000, activeMs: 10_000 });
  assert.equal(session.session_type, "Claude Desktop");
  assert.equal(session.model_provider, "kimi");
  assert.equal(session.project, "project");
  assert.equal(session.status, "working");
});

test("uses the Desktop inference model label instead of its internal Claude alias", () => {
  const root = mkdtempSync(join(tmpdir(), "sessionbar-claude-"));
  const configRoot = mkdtempSync(join(tmpdir(), "sessionbar-claude-config-"));
  fixture(root, "local_gateway", { model: "claude-haiku-4-5" });
  writeFileSync(join(configRoot, "gateway.json"), JSON.stringify({
    inferenceGatewayApiKey: "must-not-be-read",
    inferenceModels: [{ name: "claude-haiku-4-5", labelOverride: "kimi-k3" }],
  }));

  const [session] = discoverClaudeDesktopSessions({ root, configRoot, now: 1_005, windowMs: 10_000 });
  assert.equal(session.model_provider, "kimi");
  assert.equal(session.session_source, "model:kimi-k3");
});

test("keeps multiple Desktop sessions independent", () => {
  const root = mkdtempSync(join(tmpdir(), "sessionbar-claude-"));
  fixture(root, "local_one", { title: "First" });
  fixture(root, "local_two", { title: "Second" });
  const sessions = discoverClaudeDesktopSessions({ root, now: 1_005, windowMs: 10_000 });
  assert.equal(sessions.length, 2);
  assert.notEqual(sessions[0].session_id, sessions[1].session_id);
});

test("ignores malformed and archived registry entries", () => {
  const root = mkdtempSync(join(tmpdir(), "sessionbar-claude-"));
  fixture(root, "local_archived", { isArchived: true });
  const dir = join(root, "account", "shard");
  writeFileSync(join(dir, "local_bad.json"), "not json");
  assert.equal(discoverClaudeDesktopSessions({ root, now: 1_005, windowMs: 10_000 }).length, 0);
});
