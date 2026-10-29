import assert from "node:assert/strict";
import test from "node:test";
import { classifyCodexSession, parseCodexDesktopOrigins } from "../dist/sessions/codexSessionOrigins.js";

test("MCP host log evidence identifies only the exact local native session", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const origins = parseCodexDesktopOrigins(`2026-10-28T03:22:45.698Z info [electron-message-handler] mcp_extension_host_thread_retired hostId=local threadId=${id}\n2026-10-28T03:22:45.698Z info [electron-message-handler] mcp_extension_host_thread_created hostId=remote threadId=22222222-2222-4222-8222-222222222222`);
  const session = { session_id: `${id}__/`, session_type: "Codex", project_path: "/" };
  classifyCodexSession(session, origins);
  assert.equal(origins.size, 1);
  assert.equal(session.session_kind, "background");
  assert.equal(session.session_service, "mcp_extension_host");
  assert.equal(session.session_name, undefined, "service labels do not overwrite native titles");
});

test("missing names are not proof of background work", () => {
  const unknown = { session_id: "unknown__Project", session_type: "Codex" };
  const user = { ...unknown, session_source: "vscode" };
  const background = { ...unknown, session_source: "composer_predictions" };
  for (const session of [unknown, user, background]) classifyCodexSession(session, new Map());
  assert.equal(unknown.session_kind, "unknown");
  assert.equal(user.session_kind, "user");
  assert.equal(background.session_kind, "background");
  const nativeUser = { ...user, session_id: "11111111-1111-4111-8111-111111111111__Project" };
  classifyCodexSession(nativeUser, new Map([["11111111-1111-4111-8111-111111111111", "composer_predictions"]]));
  assert.equal(nativeUser.session_kind, "user", "native user metadata takes precedence over inferred prediction ownership");
});
