import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import test from "node:test";
import { nativeHarnessHookReport } from "../dist/hooks/nativeHarnessBridge.js";

test("Kimi hook and filesystem reports share one session and the registry cannot overwrite blocked state", async t => {
  const root = mkdtempSync(join(tmpdir(), "sessionbar-kimi-hook-fallback-"));
  const home = join(root, "kimi");
  const dir = join(home, "sessions", "wd-alpha", "session_one");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(home, "session_index.jsonl"), JSON.stringify({ sessionId: "session_one", sessionDir: dir, workDir: "/work/alpha" }) + "\n");
  const state = { id: "session_one", version: 2, cwd: "/work/alpha", updatedAt: Date.now(), title: "Kimi work", lastTurnReason: "completed" };
  const statePath = join(dir, "state.json");
  writeFileSync(statePath, JSON.stringify(state));
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const child = spawn(process.execPath, ["dist/server/server.js"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, HOME: root, SESSIONBAR_HOME: join(root, "relay"), KIMI_CODE_HOME: home,
      CODEX_HOME: join(root, "codex"), WORKBUDDY_HOME: join(root, "workbuddy"), SESSIONBAR_DSH_HOME: join(root, "dsh"),
      SESSIONBAR_HOST: "127.0.0.1", SESSIONBAR_PORT: String(port), SESSIONBAR_PROVIDER_POLL: "0", SESSIONBAR_CCSWITCH: "0" },
    stdio: "ignore",
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) await new Promise(resolve => {
      const timeout = setTimeout(() => child.kill("SIGKILL"), 1500);
      child.once("close", () => { clearTimeout(timeout); resolve(); });
      child.kill("SIGTERM");
    });
    rmSync(root, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${port}`;
  let sessions = [];
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try { sessions = await fetch(url + "/sessions/live").then(r => r.json()); if (sessions.length) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(sessions.length, 1);
  const report = nativeHarnessHookReport("kimi-code", { session_id: "session_one", cwd: "/work/alpha", client_type: "kimi_code_cli", hook_event_name: "PermissionRequest" });
  assert.equal(report.session_id, sessions[0].session_id);
  assert.equal((await fetch(url + "/session/status", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(report) })).status, 200);
  writeFileSync(statePath, JSON.stringify({ ...state, updatedAt: Date.now() }));
  await new Promise(resolve => setTimeout(resolve, 700));
  sessions = await fetch(url + "/sessions/live").then(r => r.json());
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].source, "hook");
  assert.equal(sessions[0].status, "blocked");
  assert.equal(sessions[0].session_type, "Kimi CLI");
});
