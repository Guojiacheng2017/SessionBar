import assert from "node:assert/strict";
import test from "node:test";
import {
  parseProcessTable,
  sampleProcessTree,
  sampleRegisteredProcesses,
} from "../dist/runtimeSampler.js";

test("aggregates a process root and all descendants into a runtime snapshot", () => {
  const records = parseProcessTable(`100 1 12.5 1000\n101 100 7.5 2000\n102 101 2.0 3000\n`);

  assert.deepEqual(records, [
    { pid: 100, ppid: 1, cpu_percent: 12.5, rss_kib: 1000 },
    { pid: 101, ppid: 100, cpu_percent: 7.5, rss_kib: 2000 },
    { pid: 102, ppid: 101, cpu_percent: 2, rss_kib: 3000 },
  ]);
  assert.deepEqual(sampleProcessTree(records, 100, 100_000_000, 1234), {
    cpu_percent: 22,
    memory_bytes: 6_144_000,
    memory_percent: 6.144,
    process_count: 3,
    sampled_at: 1234,
  });
  assert.equal(sampleProcessTree(records, 999, 100_000_000, 1234), undefined);
});

test("ignores malformed process-table rows and handles zero host memory", () => {
  const records = parseProcessTable([
    "bad row",
    "100 1 nope 1000",
    "101 100 1.5 -2",
    "102 100 2.5 500 extra",
    "103 100 2.5 500",
    "",
  ].join("\n"));

  assert.deepEqual(records, [
    { pid: 103, ppid: 100, cpu_percent: 2.5, rss_kib: 500 },
  ]);
  assert.deepEqual(sampleProcessTree(records, 103, 0, 1234), {
    cpu_percent: 2.5,
    memory_bytes: 512_000,
    memory_percent: 0,
    process_count: 1,
    sampled_at: 1234,
  });
});

test("accepts only non-negative integer RSS KiB values", () => {
  assert.deepEqual(parseProcessTable([
    "100 1 1.5 0",
    "101 100 2.5 12",
    "102 100 3.5 12.5",
  ].join("\n")), [
    { pid: 100, ppid: 1, cpu_percent: 1.5, rss_kib: 0 },
    { pid: 101, ppid: 100, cpu_percent: 2.5, rss_kib: 12 },
  ]);
});

test("does not double-count descendants when the process table contains a cycle", () => {
  const records = parseProcessTable(`100 200 1 100\n200 100 2 200\n300 200 3 300\n`);

  assert.deepEqual(sampleProcessTree(records, 100, 1_000_000, 1234), {
    cpu_percent: 6,
    memory_bytes: 614_400,
    memory_percent: 61.44,
    process_count: 3,
    sampled_at: 1234,
  });
});

test("reads the process table once and samples every registered root", async () => {
  const calls = [];
  const samples = await sampleRegisteredProcesses([100, 200, 100], {
    totalMemoryBytes: 100_000_000,
    sampledAt: 1234,
    execFile(file, args, options, callback) {
      calls.push({ file, args, options });
      callback(null, "100 1 1 1000\n101 100 2 2000\n200 1 4 3000\n");
    },
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    file: "ps",
    args: ["-axo", "pid=,ppid=,%cpu=,rss="],
    options: { encoding: "utf8" },
  });
  assert.deepEqual([...samples.keys()], [100, 200]);
  assert.equal(samples.get(100)?.process_count, 2);
  assert.equal(samples.get(200)?.cpu_percent, 4);
});

test("returns no samples without roots and rejects process-table command errors", async () => {
  let called = false;
  const empty = await sampleRegisteredProcesses([], {
    execFile() {
      called = true;
    },
  });
  assert.deepEqual(empty, new Map());
  assert.equal(called, false);

  await assert.rejects(
    sampleRegisteredProcesses([100], {
      execFile(_file, _args, _options, callback) {
        callback(new Error("ps failed"), "");
      },
    }),
    /ps failed/,
  );
});
