import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateRuntimeUsage,
  formatRuntimeBytes,
  runtimeProgressBar,
} from "../dist/runtimeUsage.js";

const session = (overrides = {}) => ({
  session_id: "codex-demo__Vision-Dash",
  status: "working",
  runtime: {
    cpu_percent: 20,
    gpu_percent: 40,
    memory_percent: 8,
    memory_bytes: 512 * 1024 * 1024,
    process_count: 3,
    sampled_at: 1_700_000_000_000,
  },
  ...overrides,
});

test("aggregates runtime only for active sessions and keeps missing GPU unknown", () => {
  const usage = aggregateRuntimeUsage([
    session(),
    session({
      session_id: "claude-demo__Vision-Dash",
      runtime: {
        cpu_percent: 10,
        memory_percent: 4,
        memory_bytes: 256 * 1024 * 1024,
        process_count: 2,
        sampled_at: 1_700_000_001_000,
      },
    }),
    session({ status: "idle", session_id: "idle-demo__Vision-Dash" }),
  ]);

  assert.equal(usage.activeSessions, 2);
  assert.equal(usage.sampledSessions, 2);
  assert.equal(usage.cpuPercent, 30);
  assert.equal(usage.gpuPercent, 40);
  assert.equal(usage.memoryPercent, 12);
  assert.equal(usage.memoryBytes, 768 * 1024 * 1024);
  assert.equal(usage.processCount, 5);
  assert.equal(usage.sampledAt, 1_700_000_001_000);
  assert.equal(usage.hasGpuData, true);
});

test("runtime progress bars use a fixed width and a neutral track for unavailable data", () => {
  assert.equal(runtimeProgressBar(50, 100, 10), "█████░░░░░");
  assert.equal(runtimeProgressBar(undefined, 100, 10), "··········");
  assert.equal(formatRuntimeBytes(768 * 1024 * 1024), "768 MB");
});

test("runtime aggregation exposes per-session contributions for the Web matrix", () => {
  const usage = aggregateRuntimeUsage([
    session({ session_id: "a", runtime: { cpu_percent: 30, memory_percent: 5, process_count: 2 } }),
    session({ session_id: "b", runtime: { cpu_percent: 10, memory_percent: 15, process_count: 1 } }),
  ]);

  assert.deepEqual(usage.contributions.map(item => item.sessionId), ["a", "b"]);
  assert.deepEqual(usage.contributions.map(item => item.cpuShare), [75, 25]);
  assert.deepEqual(usage.contributions.map(item => item.memoryShare), [25, 75]);
  assert.deepEqual(usage.contributions.map(item => item.processShare), [66.67, 33.33]);
});

test("runtime aggregation retains observed per-session values for runtime presentation", () => {
  const usage = aggregateRuntimeUsage([
    session({ runtime: {
      cpu_percent: 22,
      memory_percent: 1,
      memory_bytes: 196 * 1024 * 1024,
      process_count: 1,
    } }),
  ]);

  assert.equal(usage.contributions[0].cpuPercent, 22);
  assert.equal(usage.contributions[0].gpuPercent, undefined);
  assert.equal(usage.contributions[0].memoryPercent, 1);
  assert.equal(usage.contributions[0].memoryBytes, 196 * 1024 * 1024);
  assert.equal(usage.contributions[0].processCount, 1);
});
