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
import { parseSystemSampleMs } from "../dist/server.js";

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
      SESSIONBAR_SYSTEM_SAMPLE_MS: "100",
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
    const exited = child.exitCode === null
      ? new Promise(resolve => child.once("exit", resolve))
      : Promise.resolve();
    if (child.exitCode === null) child.kill("SIGTERM");
    await Promise.race([
      exited,
      new Promise(resolve => setTimeout(resolve, 1_000)),
    ]);
    rmSync(root, { recursive: true, force: true });
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

  await new Promise(resolve => setTimeout(resolve, 220));
  const later = await fetch(`${baseUrl}/system/live`).then(response => response.json());
  assert.equal(typeof later.system.sampled_at, "number");
  assert.ok(lineCount(netstatCalls) >= 2, "system sampler did not advance across samples");
  assert.equal(lineCount(codexReads), 0, "system samples must not discover Codex sessions");
  assert.equal(lineCount(psCalls), 0, "system samples must not read the process table");
});
