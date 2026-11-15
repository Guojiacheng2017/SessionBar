import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { localFetch } from "../dist/runtime/networkRuntime.js";
import { readRuntimeState } from "../dist/server/runtimeState.js";
const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../dist/cli/cli.js", import.meta.url));
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, description) {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        if (await check())
            return;
        await delay(20);
    }
    assert.fail(description);
}
function exited(pid) {
    try {
        process.kill(pid, 0);
        return false;
    }
    catch (error) {
        if (error.code === "ESRCH")
            return true;
        throw error;
    }
}
async function relay(t, extraEnv = {}) {
    const home = mkdtempSync(join(tmpdir(), "sessionbar-lifecycle-http-"));
    const stateHome = join(home, "state");
    const env = {
        PATH: process.env.PATH, HOME: home, USERPROFILE: home,
        TMPDIR: home, TEMP: home, TMP: home,
        SESSIONBAR_HOME: stateHome, SESSIONBAR_HOST: "127.0.0.1", SESSIONBAR_PORT: "0",
        CODEX_HOME: join(home, ".codex"), WORKBUDDY_HOME: join(home, ".workbuddy"),
        KIMI_CODE_HOME: join(home, ".kimi-code"), XDG_CONFIG_HOME: join(home, ".config"),
        SESSIONBAR_PROVIDER_POLL: "0", SESSIONBAR_CODEX_APP_SERVER: "0",
        SESSIONBAR_CCSWITCH: "0", SESSIONBAR_GROK_BILLING: "0", ...extraEnv,
    };
    const run = (command) => exec(process.execPath, [cli, command], { cwd: home, env, timeout: 12_000 });
    t.after(async () => {
        await run("stop");
        rmSync(home, { recursive: true, force: true });
    });
    await run("start");
    const state = readRuntimeState(stateHome);
    assert.ok(state);
    const call = (path, init = {}) => localFetch(`http://127.0.0.1:${state.port}${path}`, {
        ...init, signal: init.signal ?? AbortSignal.timeout(5_000),
    });
    const health = async () => {
        const response = await call("/health");
        assert.equal(response.status, 200);
        return response.json();
    };
    const stream = async () => {
        const controller = new AbortController();
        t.after(() => controller.abort());
        const response = await call("/sessions/stream", { signal: controller.signal });
        assert.equal(response.status, 200);
        assert.ok(response.body);
        const reader = response.body.getReader();
        assert.equal((await reader.read()).done, false);
        return { reader, close: () => controller.abort() };
    };
    return { state, stateHome, run, call, health, stream };
}
test("SSE client accounting and reconnect grace preserve one Relay until the final disconnect", { timeout: 20_000 }, async (t) => {
    const grace = 1_000;
    const f = await relay(t, { SESSIONBAR_IDLE_SHUTDOWN_MS: String(grace) });
    const first = await f.stream(), second = await f.stream();
    await waitFor(async () => (await f.health()).web_clients === 2, "both viewers must be observed");
    first.close();
    await waitFor(async () => (await f.health()).web_clients === 1, "first viewer did not disconnect");
    await delay(grace + 100);
    assert.equal((await f.health()).pid, f.state.pid, "one remaining viewer must keep the Relay alive");
    second.close();
    await waitFor(async () => (await f.health()).web_clients === 0, "last viewer did not disconnect");
    const reconnected = await f.stream();
    await waitFor(async () => (await f.health()).web_clients === 1, "reconnected viewer was not observed");
    await delay(grace + 100);
    assert.deepEqual(readRuntimeState(f.stateHome), f.state, "reconnection must preserve the process and port");
    reconnected.close();
    await waitFor(() => exited(f.state.pid), "Relay did not exit after the final disconnect and grace");
    assert.equal(readRuntimeState(f.stateHome), undefined);
    assert.equal(existsSync(join(f.stateHome, "server.lock")), false);
});
test("manual refresh keeps the Relay instance and stop drains SSE while cancelling in-flight provider HTTP", { timeout: 20_000 }, async (t) => {
    const pending = [];
    const target = createServer((request, response) => {
        assert.equal(request.url, "/user/balance");
        assert.equal(request.headers.authorization, "Bearer synthetic-lifecycle-token");
        pending.push(response);
    });
    t.after(async () => {
        target.closeAllConnections();
        await new Promise(resolve => target.close(() => resolve()));
    });
    await new Promise(resolve => target.listen(0, "127.0.0.1", resolve));
    const address = target.address();
    assert.ok(address && typeof address === "object");
    const f = await relay(t, {
        SESSIONBAR_PROVIDER_POLL: "1", SESSIONBAR_PROVIDER_POLL_MS: "60000",
        SESSIONBAR_DEEPSEEK_API_KEY: "synthetic-lifecycle-token",
        SESSIONBAR_DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}`,
    });
    await waitFor(() => pending.length === 1, "initial synthetic provider request did not arrive");
    pending[0].setHeader("content-type", "application/json");
    pending[0].end(JSON.stringify({ is_available: true, balance_infos: [{ currency: "CNY", total_balance: "17" }] }));
    await waitFor(async () => {
        const { providers } = await (await f.call("/providers/live")).json();
        return providers.some(row => row.provider === "deepseek" && row.remaining === 17);
    }, "initial provider snapshot was not published");
    const stream = await f.stream();
    const refresh = f.call("/providers/refresh", { method: "POST" })
        .then(response => ({ status: response.status }), (error) => ({ error }));
    await waitFor(() => pending.length === 2, "manual refresh did not issue a new provider request");
    assert.deepEqual(readRuntimeState(f.stateHome), f.state, "manual refresh must preserve the process and port");
    const streamEnded = (async () => {
        while (!(await stream.reader.read()).done) { /* wait for Relay to end the stream */ }
        return true;
    })().catch((error) => error);
    await f.run("stop");
    assert.equal(await streamEnded, true, "stop must end the active SSE response");
    assert.ok("error" in await refresh, "stop must cancel the unfinished refresh response");
    await waitFor(() => pending[1].destroyed, "outbound provider HTTP remained live after stop");
    assert.equal(exited(f.state.pid), true);
    assert.equal(readRuntimeState(f.stateHome), undefined);
    assert.equal(existsSync(join(f.stateHome, "server.lock")), false);
});
