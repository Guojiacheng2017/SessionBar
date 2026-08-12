import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { consumeSystemSample, parseSystemSampleMs } from "../dist/server.js";

test("system sample interval accepts only safe integers within the supported range", () => {
  for (const value of [
    undefined,
    "",
    "invalid",
    "Infinity",
    "NaN",
    "0",
    "-20",
    "0.5",
    "12.5",
    "99",
    "2147483648",
  ]) {
    assert.equal(parseSystemSampleMs(value), 2000, String(value));
  }
  assert.equal(parseSystemSampleMs("100"), 100);
  assert.equal(parseSystemSampleMs("2000"), 2000);
  assert.equal(parseSystemSampleMs("2500"), 2500);
  assert.equal(parseSystemSampleMs("2147483647"), 2_147_483_647);
});

test("server sampling boundary logs and consumes an unexpected rejection", async () => {
  const failure = new Error("unexpected sampler rejection");
  const logged = [];
  const unhandled = [];
  const onUnhandled = reason => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    void consumeSystemSample(
      async () => { throw failure; },
      (...args) => logged.push(args),
    );
    await new Promise(resolve => setImmediate(resolve));
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }

  assert.equal(unhandled.length, 0);
  assert.equal(logged.length, 1);
  assert.match(logged[0][0], /system sample failed/i);
  assert.equal(logged[0][1], failure);
});

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

async function waitFor(check, message, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`${message}${lastError ? `: ${lastError.message}` : ""}`);
}

function lineCount(path) {
  if (!existsSync(path)) return 0;
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).length;
}

test("direct server serves cached system samples without Codex discovery or process-table reads", async (t) => {
  const systemSampleMs = 100;
  const root = mkdtempSync(join(tmpdir(), "sessionbar-server-system-"));
  const home = join(root, "home");
  const sessionbarHome = join(root, "sessionbar");
  const sessionDir = join(sessionbarHome, "sessions");
  const codexHome = join(root, "codex");
  const codexSessionDir = join(codexHome, "sessions");
  const bin = join(root, "bin");
  const codexReads = join(root, "codex-reads.log");
  const netstatCalls = join(root, "netstat-calls.log");
  const psCalls = join(root, "ps-calls.log");
  const fsProbe = join(root, "codex-read-probe.cjs");
  mkdirSync(home, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(codexSessionDir, { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "netstat"), `#!/bin/sh
printf 'call\\n' >> "$SESSIONBAR_NETSTAT_CALLS"
printf '%s\\n' 'Name  Mtu   Network       Address            Ipkts Ierrs Ibytes  Opkts Oerrs Obytes  Coll'
printf '%s\\n' 'en0   1500  <Link#4>      12:34:56:78:9a:bc  1     0     111     2     0     222     0'
`);
  writeFileSync(join(bin, "ps"), `#!/bin/sh
printf 'call\\n' >> "$SESSIONBAR_PS_CALLS"
`);
  writeFileSync(fsProbe, `const fs = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");
const originalReaddirSync = fs.readdirSync;
fs.readdirSync = function(path, ...args) {
  if (path === process.env.SESSIONBAR_CODEX_SESSION_DIR) {
    fs.appendFileSync(process.env.SESSIONBAR_CODEX_READS, "read\\n");
  }
  return originalReaddirSync.call(this, path, ...args);
};
syncBuiltinESMExports();
`);
  chmodSync(join(bin, "netstat"), 0o755);
  chmodSync(join(bin, "ps"), 0o755);

  const port = await availablePort();
  const child = spawn(process.execPath, ["--require", fsProbe, "dist/server.js"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      HOME: home,
      CODEX_HOME: codexHome,
      PORT: String(port),
      SESSIONBAR_HOME: sessionbarHome,
      SESSIONBAR_PROVIDER_POLL: "0",
      SESSIONBAR_CCSWITCH: "0",
      SESSIONBAR_IDLE_SHUTDOWN_MS: "60000",
      SESSIONBAR_SYSTEM_SAMPLE_MS: String(systemSampleMs),
      SESSIONBAR_CODEX_SESSION_DIR: codexSessionDir,
      SESSIONBAR_CODEX_READS: codexReads,
      SESSIONBAR_NETSTAT_CALLS: netstatCalls,
      SESSIONBAR_PS_CALLS: psCalls,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let childOutput = "";
  child.stdout.on("data", chunk => { childOutput += chunk; });
  child.stderr.on("data", chunk => { childOutput += chunk; });
  t.after(async () => {
    assert.equal(child.exitCode, null, `server exited before SIGTERM (${childOutput})`);
    const exited = new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
    assert.equal(child.kill("SIGTERM"), true, "SIGTERM was not delivered to the server");
    let timeout;
    const exitTimeout = new Promise(resolve => {
      timeout = setTimeout(() => resolve(undefined), 1_000);
    });
    try {
      const exit = await Promise.race([exited, exitTimeout]);
      clearTimeout(timeout);
      if (!exit) {
        if (child.exitCode === null) child.kill("SIGKILL");
        await exited;
        assert.fail(`server did not exit after SIGTERM (${childOutput})`);
      }
      assert.deepEqual(exit, { code: 0, signal: null }, `server did not exit cleanly (${childOutput})`);

      const netstatCallsAfterExit = lineCount(netstatCalls);
      await new Promise(resolve => setTimeout(resolve, systemSampleMs + 50));
      assert.equal(lineCount(netstatCalls), netstatCallsAfterExit, "system sampler continued after shutdown");
    } finally {
      clearTimeout(timeout);
      rmSync(root, { recursive: true, force: true });
    }
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitFor(async () => {
    const response = await fetch(`${baseUrl}/system/live`);
    if (!response.ok) return undefined;
    const body = await response.json();
    return body.system;
  }, `server did not start (${childOutput})`);

  const initial = await fetch(`${baseUrl}/system/live`).then(response => response.json());
  assert.equal(typeof initial.system.memory_total_bytes, "number");
  assert.equal(typeof initial.system.server_memory_bytes, "number");
  assert.equal(Array.isArray(initial.system.load_average), true);

  const streamResponse = await fetch(`${baseUrl}/sessions/stream`);
  assert.equal(streamResponse.ok, true);
  assert.ok(streamResponse.body);
  const streamReader = streamResponse.body.getReader();
  const decoder = new TextDecoder();
  let initialStreamData = "";
  await waitFor(async () => {
    const chunk = await streamReader.read();
    if (chunk.done) throw new Error("session SSE closed before initial event");
    initialStreamData += decoder.decode(chunk.value, { stream: true });
    return initialStreamData.includes("data:");
  }, "session SSE did not send its initial event");
  assert.equal((initialStreamData.match(/data:/g) || []).length, 1);
  const codexReadsAfterSessionSort = lineCount(codexReads);
  const nextStreamChunk = streamReader.read();

  await new Promise(resolve => setTimeout(resolve, systemSampleMs * 2 + 20));
  const later = await fetch(`${baseUrl}/system/live`).then(response => response.json());
  await fetch(`${baseUrl}/system/live`).then(response => response.json());
  assert.equal(typeof later.system.sampled_at, "number");
  assert.ok(lineCount(netstatCalls) >= 2, "system sampler did not advance across samples");
  assert.equal(lineCount(codexReads), codexReadsAfterSessionSort, "system samples or endpoint reads must not sort/discover sessions");
  assert.equal(lineCount(psCalls), 0, "system samples must not read the process table");
  const extraStreamData = await Promise.race([
    nextStreamChunk.then(chunk => chunk.done ? "closed" : decoder.decode(chunk.value, { stream: true })),
    new Promise(resolve => setTimeout(() => resolve("timeout"), systemSampleMs * 2)),
  ]);
  assert.equal(extraStreamData, "timeout", "system samples must not broadcast session SSE events");
  await streamReader.cancel();
});

test("direct server survives a full sampler observation exception and keeps its last snapshot", async (t) => {
  const systemSampleMs = 100;
  const root = mkdtempSync(join(tmpdir(), "sessionbar-server-sampler-failure-"));
  const home = join(root, "home");
  const sessionbarHome = join(root, "sessionbar");
  const sessionDir = join(sessionbarHome, "sessions");
  const bin = join(root, "bin");
  const osProbe = join(root, "throwing-os-probe.cjs");
  mkdirSync(home, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "netstat"), `#!/bin/sh
printf '%s\\n' 'Name Mtu Network Address Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll'
printf '%s\\n' 'en0 1500 inet 192.0.2.1 1 0 100 1 0 50 0'
`);
  chmodSync(join(bin, "netstat"), 0o755);
  writeFileSync(osProbe, `const os = require("node:os");
const { syncBuiltinESMExports } = require("node:module");
const originalTotalmem = os.totalmem;
let calls = 0;
os.totalmem = function() {
  calls += 1;
  if (calls > 1) throw new Error("forced totalmem failure");
  return originalTotalmem();
};
syncBuiltinESMExports();
`);

  const port = await availablePort();
  const child = spawn(process.execPath, ["--require", osProbe, "dist/server.js"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      HOME: home,
      PORT: String(port),
      SESSIONBAR_HOME: sessionbarHome,
      SESSIONBAR_PROVIDER_POLL: "0",
      SESSIONBAR_CCSWITCH: "0",
      SESSIONBAR_IDLE_SHUTDOWN_MS: "60000",
      SESSIONBAR_SYSTEM_SAMPLE_MS: String(systemSampleMs),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let childOutput = "";
  child.stdout.on("data", chunk => { childOutput += chunk; });
  child.stderr.on("data", chunk => { childOutput += chunk; });
  t.after(async () => {
    if (child.exitCode === null) {
      const exited = new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
      child.kill("SIGTERM");
      await exited;
    }
    rmSync(root, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  const first = await waitFor(async () => {
    const response = await fetch(`${baseUrl}/system/live`);
    if (!response.ok) return undefined;
    return (await response.json()).system;
  }, `server did not produce an initial sample (${childOutput})`);

  await new Promise(resolve => setTimeout(resolve, systemSampleMs * 3));
  const later = await fetch(`${baseUrl}/system/live`).then(response => response.json());
  assert.equal(child.exitCode, null, `server exited after collector failure (${childOutput})`);
  assert.equal(later.system.sampled_at, first.sampled_at);
});
