import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("restarting with primary, child and orphan markers only restores the verified primary", async t => {
  const root = await mkdtemp(join(tmpdir(), "sessionbar-recovery-integration-"));
  const home = join(root, "home"), state = join(root, "state"), codex = join(root, "codex");
  await Promise.all([mkdir(home), mkdir(join(state, "sessions"), { recursive: true }), mkdir(join(codex, "sessions"), { recursive: true })]);
  const primary = "11111111-1111-4111-8111-111111111111", child = "22222222-2222-4222-8222-222222222222", orphan = "33333333-3333-4333-8333-333333333333";
  for (const id of [primary, child, orphan]) await writeFile(join(state, "sessions", `sessionbar-id-codex-fixture-${id}`), `${id}__Project\n`);
  for (const id of [primary, child]) await writeFile(join(codex, "sessions", `${id}.jsonl`), JSON.stringify({ type: "session_meta", payload: {
    id, cwd: "/fixture/Project", originator: "Codex Desktop", thread_source: id === child ? "subagent" : "user",
    source: id === child ? { subagent: { thread_spawn: { parent_thread_id: primary } } } : "vscode",
  } }) + "\n");
  let process;
  async function stop() {
    if (!process || process.exitCode !== null) return;
    const ended = new Promise(resolve => process.once("exit", resolve)); process.kill("SIGTERM"); await ended;
  }
  t.after(async () => { await stop(); await rm(root, { recursive: true, force: true }); });
  for (let run = 0; run < 2; run++) {
    process = spawn(globalThis.process.execPath, ["dist/server/server.js"], {
      cwd: new URL("..", import.meta.url), stdio: "ignore",
      env: { ...globalThis.process.env, HOME: home, SESSIONBAR_HOME: state, CODEX_HOME: codex,
        SESSIONBAR_PORT: "0", SESSIONBAR_PROVIDER_POLL: "0", SESSIONBAR_CCSWITCH: "0", SESSIONBAR_CODEX_APP_SERVER: "0" },
    });
    let base, rows;
    for (let i = 0; i < 100; i++) {
      try {
        base = `http://127.0.0.1:${Number((await readFile(join(state, "port"), "utf8")).trim())}`;
        rows = await (await fetch(base + "/sessions/live")).json();
        if (rows.length === 1 && rows[0].session_id === primary + "__Project") break;
      } catch { /* Wait for startup and native file reconciliation. */ }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.deepEqual(rows?.map(row => row.session_id), [primary + "__Project"]);
    assert.equal(rows[0].session_name, undefined, "a real unnamed primary is retained");
    const response = await fetch(base + "/session/status", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
      session_id: child + "__Project", session_type: "Codex", status: "working", task_name: "Child hook",
    }) });
    assert.equal(response.status, 200);
    assert.deepEqual((await (await fetch(base + "/sessions/live")).json()).map(row => row.session_id), [primary + "__Project"]);
    // A fresh native hook is valid even if this thread has no saved transcript.
    await fetch(base + "/session/status", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
      session_id: orphan + "__Project", session_type: "Codex", status: "working", task_name: "Working",
    }) });
    assert.deepEqual((await (await fetch(base + "/sessions/live")).json()).map(row => row.session_id).sort(), [primary + "__Project", orphan + "__Project"].sort());
    const nativePath = join(codex, "sessions", `${orphan}.jsonl`);
    await writeFile(nativePath, JSON.stringify({ type: "session_meta", payload: {
      id: orphan, cwd: "/fixture/Project", originator: "Codex Desktop", thread_source: "user", source: "vscode",
    } }) + "\n");
    for (let i = 0; i < 100; i++) {
      rows = await (await fetch(base + "/sessions/live")).json();
      if (rows.some(row => row.session_id === orphan + "__Project")) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(rows.some(row => row.session_id === orphan + "__Project"), "native confirmation reveals a genuine new unnamed session");
    await rm(nativePath);
    await stop();
  }
});
