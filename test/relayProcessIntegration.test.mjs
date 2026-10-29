import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { readRuntimeState } from "../dist/server/runtimeState.js";
import { readRelayConfigMatch } from "../dist/runtime/relayConfig.js";
import { localFetch } from "../dist/runtime/networkRuntime.js";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../dist/cli/cli.js", import.meta.url));

test("CLI reuses startup environment and applies a changed environment only on restart", { timeout: 35_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "sessionbar-relay-process-"));
  const stateHome = join(home, "state");
  // A fresh HOME/cwd and a minimal environment keep this test independent of
  // installed accounts, credential variables, existing Relay state and hooks.
  const env = {
    HOME: home,
    PATH: process.env.PATH,
    SESSIONBAR_HOME: stateHome,
    SESSIONBAR_PROVIDER_POLL: "0",
    SESSIONBAR_CODEX_APP_SERVER: "0",
    NODE_USE_ENV_PROXY: "1",
    HTTP_PROXY: "http://127.0.0.1:1",
    HTTPS_PROXY: "http://127.0.0.1:1",
    NO_PROXY: "",
  };
  const run = (command, launchEnv = env) => exec(process.execPath, [cli, command], {
    cwd: home, env: launchEnv, timeout: 12_000,
  });
  try {
    await run("start");
    const first = readRuntimeState(stateHome);
    assert.ok(first?.pid);
    const changed = { ...env, HTTPS_PROXY: "http://127.0.0.1:2" };
    const attach = await run("start", changed);
    assert.match(attach.stdout, /Already running/);
    assert.match(attach.stderr, /startup environment.*sessionbar restart/);
    assert.equal(readRuntimeState(stateHome).pid, first.pid);

    const restarted = await run("restart", changed);
    assert.match(restarted.stdout, /restarted/);
    const second = readRuntimeState(stateHome);
    assert.notEqual(second.pid, first.pid);
    assert.throws(() => process.kill(first.pid, 0), { code: "ESRCH" });
    const health = await (await localFetch(`http://127.0.0.1:${second.port}/health`)).json();
    assert.equal(readRelayConfigMatch(stateHome, changed, second.pid, health.config_revision), true);
    const attachedAgain = await run("start", changed);
    assert.doesNotMatch(attachedAgain.stderr, /startup environment/);

    const stopped = await run("stop", changed);
    assert.match(stopped.stdout, /Stopped/);
    assert.throws(() => process.kill(second.pid, 0), { code: "ESRCH" });
    assert.equal(readRuntimeState(stateHome), undefined);
  } finally {
    await run("stop");
    rmSync(home, { recursive: true, force: true });
  }
});

test("Bun local Relay transport bypasses proxy environment and preserves streaming", { timeout: 10_000 }, async t => {
  const home = mkdtempSync(join(tmpdir(), "sessionbar-bun-transport-"));
  const env = { HOME: home, PATH: process.env.PATH };
  let server;
  try {
    try { await exec("bun", ["--version"], { cwd: home, env, timeout: 3_000 }); }
    catch (error) {
      if (error.code === "ENOENT") { t.skip("Bun is not installed"); return; }
      throw error;
    }
    server = createServer((request, response) => {
      if (request.url === "/echo") {
        let body = "";
        request.on("data", chunk => { body += chunk; });
        request.on("end", () => {
          response.writeHead(201, { "content-type": "application/json" });
          response.end(JSON.stringify({ method: request.method, authorization: request.headers.authorization, body }));
        });
        return;
      }
      if (request.url === "/empty") { response.writeHead(204); response.end(); return; }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("data: first\n\n");
      if (request.url === "/abort") return;
      setTimeout(() => response.end("data: second\n\n"), 50);
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const url = `http://127.0.0.1:${server.address().port}/stream`;
    const module = new URL("../dist/runtime/networkRuntime.js", import.meta.url).href;
    const script = `const { localFetch } = await import(${JSON.stringify(module)});
      const response = await localFetch(${JSON.stringify(url)});
      const stream = { status: response.status, body: await response.text() };
      const echo = await localFetch(${JSON.stringify(url.replace("/stream", "/echo"))}, { method: "POST", headers: { Authorization: "Bearer fixture", "content-type": "application/json" }, body: '{"value":1}' });
      const posted = { status: echo.status, body: await echo.json() };
      const empty = await localFetch(${JSON.stringify(url.replace("/stream", "/empty"))});
      const controller = new AbortController();
      const pending = await localFetch(${JSON.stringify(url.replace("/stream", "/abort"))}, { signal: controller.signal });
      const reader = pending.body.getReader();
      await reader.read();
      controller.abort();
      let aborted = false;
      try { await reader.read(); } catch { aborted = true; }
      console.log(JSON.stringify({ stream, posted, empty: { status: empty.status, body: await empty.text() }, aborted }));`;
    const result = await exec("bun", ["--eval", script], {
      cwd: home, timeout: 5_000,
      env: { ...env, NODE_USE_ENV_PROXY: "1", HTTP_PROXY: "http://127.0.0.1:1", HTTPS_PROXY: "http://127.0.0.1:1", ALL_PROXY: "http://127.0.0.1:1", NO_PROXY: "" },
    });
    assert.deepEqual(JSON.parse(result.stdout.trim()), {
      stream: { status: 200, body: "data: first\n\ndata: second\n\n" },
      posted: { status: 201, body: { method: "POST", authorization: "Bearer fixture", body: '{"value":1}' } },
      empty: { status: 204, body: "" },
      aborted: true,
    });
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    rmSync(home, { recursive: true, force: true });
  }
});
