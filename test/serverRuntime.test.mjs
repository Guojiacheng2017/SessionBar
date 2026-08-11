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
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyRuntimeSamples } from "../dist/server.js";

function session(id, overrides = {}) {
  return {
    session_id: id,
    session_type: "Codex",
    status: "working",
    task_name: "running",
    timestamp: 1_700_000_000_000,
    ...overrides,
  };
}

test("applies host samples only to active sessions without changing activity timestamps", () => {
  const sessions = {
    working: session("working", {
      process_pid: 101,
      runtime: { cpu_percent: 1, gpu_percent: 37, sampled_at: 100 },
    }),
    blocked: session("blocked", { status: "blocked", process_pid: 102 }),
    idle: session("idle", {
      status: "idle",
      process_pid: 103,
      runtime: { cpu_percent: 8, sampled_at: 100 },
    }),
    error: session("error", { status: "error", process_pid: 104 }),
  };
  const samples = new Map([
    [101, { cpu_percent: 12, memory_percent: 3, memory_bytes: 3000, process_count: 2, sampled_at: 200 }],
    [102, { cpu_percent: 5, memory_percent: 1, memory_bytes: 1000, process_count: 1, sampled_at: 200 }],
    [103, { cpu_percent: 99, memory_percent: 9, memory_bytes: 9000, process_count: 9, sampled_at: 200 }],
    [104, { cpu_percent: 88, memory_percent: 8, memory_bytes: 8000, process_count: 8, sampled_at: 200 }],
  ]);

  const changed = applyRuntimeSamples(sessions, samples, new Set([101, 102, 103, 104]));

  assert.equal(changed, true);
  assert.deepEqual(sessions.working.runtime, {
    cpu_percent: 12,
    gpu_percent: 37,
    memory_percent: 3,
    memory_bytes: 3000,
    process_count: 2,
    sampled_at: 200,
  });
  assert.deepEqual(sessions.blocked.runtime, samples.get(102));
  assert.deepEqual(sessions.idle.runtime, { cpu_percent: 8, sampled_at: 100 });
  assert.equal(sessions.error.runtime, undefined);
  assert.equal(sessions.working.timestamp, 1_700_000_000_000);
  assert.equal(sessions.blocked.timestamp, 1_700_000_000_000);
});

test("clears dead-root host metrics after a successful table read and preserves explicit GPU", () => {
  const sessions = {
    dead: session("dead", {
      process_pid: 201,
      runtime: {
        cpu_percent: 22,
        gpu_percent: 41,
        memory_percent: 4,
        memory_bytes: 4000,
        process_count: 3,
        sampled_at: 100,
      },
    }),
    unavailable: session("unavailable", {
      process_pid: 202,
      runtime: { cpu_percent: 7, sampled_at: 100 },
    }),
    notSampled: session("not-sampled", {
      process_pid: 203,
      runtime: { cpu_percent: 9, sampled_at: 100 },
    }),
  };

  const changed = applyRuntimeSamples(sessions, new Map(), new Set([201, 202]));

  assert.equal(changed, true);
  assert.deepEqual(sessions.dead.runtime, { gpu_percent: 41 });
  assert.equal(sessions.unavailable.runtime, undefined);
  assert.deepEqual(sessions.notSampled.runtime, { cpu_percent: 9, sampled_at: 100 });
});

test("advances sampled_at without reporting a visible change when metrics are unchanged", () => {
  const sessions = {
    stable: session("stable", {
      process_pid: 301,
      runtime: {
        cpu_percent: 10,
        gpu_percent: 50,
        memory_percent: 2,
        memory_bytes: 2000,
        process_count: 1,
        sampled_at: 100,
      },
    }),
  };
  const samples = new Map([
    [301, {
      cpu_percent: 10,
      memory_percent: 2,
      memory_bytes: 2000,
      process_count: 1,
      sampled_at: 200,
    }],
  ]);

  const changed = applyRuntimeSamples(sessions, samples, new Set([301]));

  assert.equal(changed, false);
  assert.equal(sessions.stable.runtime.sampled_at, 200);
  assert.equal(sessions.stable.runtime.gpu_percent, 50);
  assert.equal(sessions.stable.timestamp, 1_700_000_000_000);
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

test("direct server restores roots and runs non-overlapping failure-safe active sampling", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "sessionbar-server-runtime-"));
  const home = join(root, "home");
  const sessionbarHome = join(root, "sessionbar");
  const sessionDir = join(sessionbarHome, "sessions");
  const codexHome = join(root, "codex");
  const bin = join(root, "bin");
  const table = join(root, "process-table.txt");
  const calls = join(root, "ps-calls.log");
  const failures = join(root, "ps-failures.log");
  const overlap = join(root, "ps-overlap.log");
  const lock = join(root, "ps.lock");
  const fail = join(root, "ps.fail");
  mkdirSync(home, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(bin, { recursive: true });

  const validMarker = "sessionbar-id-codex-project-notty-valid";
  const invalidMarker = "sessionbar-id-codex-project-notty-invalid";
  writeFileSync(join(sessionDir, validMarker), "recovered-valid\n");
  writeFileSync(join(sessionDir, validMarker.replace("sessionbar-id-", "sessionbar-process-")), "4242\n");
  writeFileSync(join(sessionDir, invalidMarker), "recovered-invalid\n");
  writeFileSync(join(sessionDir, invalidMarker.replace("sessionbar-id-", "sessionbar-process-")), "0\n");
  writeFileSync(table, "4242 1 10 1000\n4243 4242 5 2000\n");
  writeFileSync(join(bin, "ps"), `#!/bin/sh
if ! mkdir "$SESSIONBAR_PS_LOCK" 2>/dev/null; then
  printf 'overlap\n' >> "$SESSIONBAR_PS_OVERLAP"
fi
printf 'call\n' >> "$SESSIONBAR_PS_CALLS"
sleep 0.08
if [ -f "$SESSIONBAR_PS_FAIL" ]; then
  printf 'failure\n' >> "$SESSIONBAR_PS_FAILURES"
  rmdir "$SESSIONBAR_PS_LOCK" 2>/dev/null || true
  exit 1
fi
cat "$SESSIONBAR_PS_TABLE"
rmdir "$SESSIONBAR_PS_LOCK" 2>/dev/null || true
`);
  chmodSync(join(bin, "ps"), 0o755);

  const port = await availablePort();
  const child = spawn(process.execPath, ["dist/server.js"], {
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
      SESSIONBAR_RUNTIME_SAMPLE_MS: "20",
      SESSIONBAR_PS_TABLE: table,
      SESSIONBAR_PS_CALLS: calls,
      SESSIONBAR_PS_FAILURES: failures,
      SESSIONBAR_PS_OVERLAP: overlap,
      SESSIONBAR_PS_LOCK: lock,
      SESSIONBAR_PS_FAIL: fail,
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
    const response = await fetch(`${baseUrl}/sessions/live`);
    return response.ok;
  }, `server did not start (${childOutput})`);

  const recovered = await fetch(`${baseUrl}/sessions/live`).then(response => response.json());
  assert.equal(recovered.find(row => row.session_id === "recovered-valid").process_pid, 4242);
  assert.equal(recovered.find(row => row.session_id === "recovered-invalid").process_pid, undefined);
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(lineCount(calls), 0, "idle recovered sessions must not trigger process-table reads");

  const postResponse = await fetch(`${baseUrl}/session/status`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      session_id: "recovered-valid",
      session_type: "Codex",
      status: "working",
      task_name: "running",
      runtime: { gpu_percent: 44 },
    }),
  });
  assert.equal(postResponse.status, 200);

  const firstSample = await waitFor(async () => {
    const rows = await fetch(`${baseUrl}/sessions/live`).then(response => response.json());
    const current = rows.find(row => row.session_id === "recovered-valid");
    return current?.runtime?.cpu_percent === 15 ? current : undefined;
  }, `active session was not sampled (${childOutput})`);
  assert.equal(firstSample.process_pid, 4242);
  assert.equal(firstSample.runtime.memory_bytes, 3_072_000);
  assert.equal(firstSample.runtime.process_count, 2);
  assert.equal(firstSample.runtime.gpu_percent, 44);

  const laterSample = await waitFor(async () => {
    const rows = await fetch(`${baseUrl}/sessions/live`).then(response => response.json());
    const current = rows.find(row => row.session_id === "recovered-valid");
    return current?.runtime?.sampled_at > firstSample.runtime.sampled_at ? current : undefined;
  }, "sample timestamp did not advance");
  assert.equal(laterSample.timestamp, firstSample.timestamp);
  assert.equal(existsSync(overlap), false, "runtime passes overlapped");

  writeFileSync(fail, "1\n");
  writeFileSync(table, "");
  await waitFor(() => lineCount(failures) >= 1, "controlled ps failure was not observed");
  const afterFirstFailure = await fetch(`${baseUrl}/sessions/live`).then(response => response.json());
  const preservedRuntime = afterFirstFailure.find(row => row.session_id === "recovered-valid").runtime;
  await waitFor(() => lineCount(failures) >= 2, "second controlled ps failure was not observed");
  const afterSecondFailure = await fetch(`${baseUrl}/sessions/live`).then(response => response.json());
  assert.deepEqual(
    afterSecondFailure.find(row => row.session_id === "recovered-valid").runtime,
    preservedRuntime,
  );

  unlinkSync(fail);
  const deadRoot = await waitFor(async () => {
    const rows = await fetch(`${baseUrl}/sessions/live`).then(response => response.json());
    const current = rows.find(row => row.session_id === "recovered-valid");
    return current?.runtime && Object.keys(current.runtime).length === 1 ? current : undefined;
  }, "successful empty process table did not clear stale host metrics");
  assert.deepEqual(deadRoot.runtime, { gpu_percent: 44 });
  assert.equal(deadRoot.timestamp, firstSample.timestamp);
  assert.equal(existsSync(overlap), false, "runtime passes overlapped");
});
