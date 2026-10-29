import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { validateSessionPayload, mergeSessionPayload } from "../dist/sessions/sessionPayload.js";
const bridge = await import("../dist/hooks/nativeHarnessBridge.js").catch(() => ({}));
const base = { session_id: "session_abc", cwd: "/projects/alpha", client_type: "kimi_code_cli", session_title: "Fix login" };

test("Kimi hook payload preserves native identity, client provenance and canonical workflow", () => {
  assert.equal(typeof bridge.nativeHarnessHookReport, "function");
  const report = bridge.nativeHarnessHookReport("kimi-code", { ...base, hook_event_name: "PreToolUse", tool_name: "Bash" });
  assert.ok(validateSessionPayload(report));
  assert.equal(report.session_id, "kimi-code-session_abc__alpha");
  assert.equal(report.session_type, "Kimi CLI");
  assert.equal(report.session_name, "Fix login");
  assert.equal(report.status, "working");
  assert.equal(report.source, "hook");
  const session = mergeSessionPayload(undefined, report, 100);
  assert.equal(session.workflow_events.at(-1).canonical_stage_id, "tool.execute.before");
  const otherClient = bridge.nativeHarnessHookReport("kimi-code", { ...base, client_type: "unrecognized-client", hook_event_name: "Stop" });
  assert.equal(otherClient.session_id, report.session_id);
  assert.equal(otherClient.session_type, "Kimi Code", "unverified client names do not masquerade as CLI or Desktop");
  assert.match(otherClient.session_source, /unrecognized-client/);
});

test("Kimi lifecycle distinguishes ready, permission, turn start, interruption and failure", () => {
  assert.equal(typeof bridge.nativeHarnessHookReport, "function");
  for (const [event, status] of [["SessionStart", "idle"], ["UserPromptSubmit", "working"], ["TurnStarted", "working"],
    ["PermissionRequest", "blocked"], ["PostToolUse", "working"], ["PostToolUseFailure", "error"],
    ["PreCompact", "working"], ["PostCompact", "working"], ["Stop", "idle"], ["StopFailure", "error"], ["Interrupt", "idle"], ["SessionEnd", "idle"]]) {
    assert.equal(bridge.nativeHarnessHookReport("kimi-code", { ...base, hook_event_name: event }).status, status, event);
  }
  assert.equal(bridge.nativeHarnessHookReport("kimi-code", { ...base, hook_event_name: "PermissionResult", decision: "approved" }).status, "working");
  assert.equal(bridge.nativeHarnessHookReport("kimi-code", { ...base, hook_event_name: "PermissionResult", decision: "denied" }).status, "blocked");
  assert.equal(bridge.nativeHarnessHookReport("kimi-code", { ...base, hook_event_name: "PermissionResult", decision: "error" }).status, "error");
  assert.equal(bridge.nativeHarnessHookReport("kimi-code", { ...base, hook_event_name: "SessionHeartbeat" }), undefined, "heartbeat cannot imply working state");
});

test("an explicit Kimi hook promotes a registry fallback to the actual reporting client", () => {
  const report = bridge.nativeHarnessHookReport("kimi-code", { ...base, hook_event_name: "PermissionRequest" });
  const previous = { session_id: report.session_id, session_type: "Kimi Code", source: "filesystem_registry",
    status: "idle", task_name: "Ready", timestamp: 1 };
  const session = mergeSessionPayload(previous, report, 2);
  assert.equal(session.source, "hook");
  assert.equal(session.session_type, "Kimi CLI");
  assert.equal(session.session_source, report.session_source);
});

test("ZCode uses its own identity and only documented lifecycle events", () => {
  assert.equal(typeof bridge.nativeHarnessHookReport, "function");
  const report = bridge.nativeHarnessHookReport("zcode", { ...base, session_id: "session-z", hook_event_name: "PermissionRequest" });
  assert.equal(report.session_id, "zcode-session-z__alpha");
  assert.equal(report.session_type, "ZCode");
  assert.equal(report.status, "blocked");
  assert.equal(mergeSessionPayload(undefined, report, 100).workflow_events.at(-1).canonical_stage_id, "permission.request");
  assert.equal(bridge.nativeHarnessHookReport("zcode", { ...base, hook_event_name: "SessionEnd" }), undefined);
  assert.equal(bridge.nativeHarnessHookReport("zcode", { ...base, hook_event_name: "PreToolUse", cwd: "C:\\work\\alpha" }).project, "alpha");
});

test("bridge ignores untrusted content, missing identities and undocumented usage", () => {
  assert.equal(typeof bridge.nativeHarnessHookReport, "function");
  const report = bridge.nativeHarnessHookReport("kimi-code", { ...base, hook_event_name: "PostToolUse", prompt: "private prompt",
    tool_response: { content: "private output", tokens: 100, status: "working" }, authorization: "secret", tokens: 99 });
  assert.equal(report.tokens, undefined);
  assert.equal(report.model_provider, undefined);
  assert.doesNotMatch(JSON.stringify(report), /private|secret|tool_response|authorization/);
  assert.equal(bridge.nativeHarnessHookReport("kimi-code", { ...base, session_id: "", hook_event_name: "Stop" }), undefined);
  assert.equal(bridge.nativeHarnessHookReport("kimi-code", { ...base, cwd: "relative", hook_event_name: "Stop" }), undefined);
  assert.equal(bridge.nativeHarnessHookReport("kimi-code", { ...base, hook_event_name: "FutureEvent" }), undefined);
});

test("installed bridge reads runtime port, reports to a mock Relay and emits no hook stdout", async t => {
  assert.equal(typeof bridge.nativeHarnessHookReport, "function");
  const root = mkdtempSync(join(tmpdir(), "sessionbar-hook-bridge-"));
  const received = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    received.push({ path: req.url, payload: JSON.parse(body) });
    res.end('{"ok":true}');
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  writeFileSync(join(root, "port"), String(server.address().port));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  });
  for (const harness of ["kimi-code", "zcode"]) {
    const child = spawn(process.execPath, ["dist/hooks/nativeHarnessBridge.js", "--sessionbar-harness", harness], {
      cwd: new URL("..", import.meta.url), env: { ...process.env, SESSIONBAR_HOME: root, SESSIONBAR_PORT: "", SESSION_BAR_PORT: "" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", chunk => output += chunk);
    child.stderr.on("data", chunk => output += chunk);
    const payload = Buffer.from(JSON.stringify({ ...base, cwd: "/projects/项目", hook_event_name: "PreToolUse", tool_name: "Bash" }) + "\n");
    const split = payload.indexOf(Buffer.from("项")) + 1;
    child.stdin.write(payload.subarray(0, split));
    await new Promise(resolve => setTimeout(resolve, 100));
    child.stdin.end(payload.subarray(split));
    assert.equal(await new Promise(resolve => child.once("close", resolve)), 0);
    assert.equal(output, "");
  }
  assert.equal(received.length, 2);
  assert.ok(received.every(r => r.payload.project_path === "/projects/项目" && r.payload.session_id.endsWith("__项目")));
  assert.ok(received.every(r => r.path === "/session/status" && r.payload.source === "hook" && validateSessionPayload(r.payload)));
});
