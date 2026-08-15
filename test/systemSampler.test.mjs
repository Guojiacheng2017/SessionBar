import assert from "node:assert/strict";
import test from "node:test";
import {
  createSystemSampler,
  deriveSystemSnapshot,
  parseNetworkCounters,
} from "../dist/system/systemSampler.js";

function observation(overrides = {}) {
  return {
    monotonic_ms: 0,
    sampled_at: 1_000,
    cpu: { idle: 0, total: 0 },
    network: { received_bytes: 0, transmitted_bytes: 0 },
    process_cpu_micros: 0,
    load_average: [1, 0.5, 0.25],
    memory_used_bytes: 40,
    memory_total_bytes: 100,
    server_memory_bytes: 12,
    ...overrides,
  };
}

test("derives CPU, network, and server CPU rates from monotonic deltas", () => {
  const first = observation({
    monotonic_ms: 1_000,
    cpu: { idle: 700, total: 1_000 },
    network: { received_bytes: 10_000, transmitted_bytes: 4_000 },
    process_cpu_micros: 1_000_000,
  });
  const second = observation({
    monotonic_ms: 3_000,
    cpu: { idle: 800, total: 1_400 },
    network: { received_bytes: 14_000, transmitted_bytes: 5_000 },
    process_cpu_micros: 1_500_000,
  });

  const snapshot = deriveSystemSnapshot(first, second);
  assert.equal(snapshot.cpu_percent, 75);
  assert.equal(snapshot.network_down_bytes_per_second, 2_000);
  assert.equal(snapshot.network_up_bytes_per_second, 500);
  assert.equal(snapshot.server_cpu_percent, 25);
});

test("carries temperature readings through transient missing observations", () => {
  const first = observation({
    monotonic_ms: 1_000,
    device_temperature_celsius: 70.6,
    battery_temperature_celsius: 30.9,
  });
  const second = observation({
    monotonic_ms: 3_000,
    device_temperature_celsius: undefined,
    battery_temperature_celsius: undefined,
  });

  const snapshot = deriveSystemSnapshot(first, second);
  assert.equal(snapshot.device_temperature_celsius, 70.6);
  assert.equal(snapshot.battery_temperature_celsius, 30.9);
});

test("clamps server CPU to the public percentage range", () => {
  const first = observation({
    monotonic_ms: 1_000,
    process_cpu_micros: 1_000_000,
  });
  const second = observation({
    monotonic_ms: 2_000,
    process_cpu_micros: 3_000_000,
  });

  assert.equal(deriveSystemSnapshot(first, second).server_cpu_percent, 100);
});

test("leaves first-sample rates unavailable", () => {
  const snapshot = deriveSystemSnapshot(undefined, observation({ monotonic_ms: 1_000 }));

  assert.equal(snapshot.cpu_percent, undefined);
  assert.equal(snapshot.network_down_bytes_per_second, undefined);
  assert.equal(snapshot.network_up_bytes_per_second, undefined);
  assert.equal(snapshot.server_cpu_percent, undefined);
});

test("makes reset and negative counters unavailable", () => {
  const first = observation({
    monotonic_ms: 1_000,
    cpu: { idle: 700, total: 1_000 },
    network: { received_bytes: 10_000, transmitted_bytes: 4_000 },
    process_cpu_micros: 1_000_000,
  });
  const second = observation({
    monotonic_ms: 3_000,
    cpu: { idle: 650, total: 900 },
    network: { received_bytes: 9_000, transmitted_bytes: 5_000 },
    process_cpu_micros: 500_000,
  });

  const snapshot = deriveSystemSnapshot(first, second);
  assert.equal(snapshot.cpu_percent, undefined);
  assert.equal(snapshot.network_down_bytes_per_second, undefined);
  assert.equal(snapshot.network_up_bytes_per_second, 500);
  assert.equal(snapshot.server_cpu_percent, undefined);
});

test("leaves every delta metric unavailable for invalid elapsed time", () => {
  const first = observation({
    monotonic_ms: 1_000,
    cpu: { idle: 700, total: 1_000 },
    network: { received_bytes: 10_000, transmitted_bytes: 4_000 },
    process_cpu_micros: 1_000_000,
  });
  const second = observation({
    monotonic_ms: Number.POSITIVE_INFINITY,
    cpu: { idle: 800, total: 1_400 },
    network: { received_bytes: 14_000, transmitted_bytes: 5_000 },
    process_cpu_micros: 1_500_000,
  });

  const snapshot = deriveSystemSnapshot(first, second);
  assert.equal(snapshot.cpu_percent, undefined);
  assert.equal(snapshot.network_down_bytes_per_second, undefined);
  assert.equal(snapshot.network_up_bytes_per_second, undefined);
  assert.equal(snapshot.server_cpu_percent, undefined);
});

test("parses non-loopback network maxima across address rows", () => {
  const counters = parseNetworkCounters([
    "Name Mtu Network Address Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll",
    "en0 1500 inet 192.0.2.1 10 0 1000 20 0 2000 0",
    "en0 1500 inet6 fe80::1 30 0 3000 40 0 5000 0",
    "en1 1500 inet 198.51.100.1 5 0 4 6 0 8 0",
    "lo0 16384 inet 127.0.0.1 99 0 9000 99 0 9000 0",
  ].join("\n"));

  assert.deepEqual(counters, {
    received_bytes: 3004,
    transmitted_bytes: 5008,
    interface_names: ["en0", "en1"],
  });
});

test("clamps memory percentage and preserves other metrics when network is unavailable", () => {
  const first = observation({ monotonic_ms: 1_000 });
  const second = observation({
    monotonic_ms: 3_000,
    cpu: { idle: 50, total: 100 },
    network: undefined,
    memory_used_bytes: 140,
    memory_total_bytes: 100,
  });

  const snapshot = deriveSystemSnapshot(first, second);
  assert.equal(snapshot.memory_percent, 100);
  assert.equal(snapshot.memory_used_bytes, 140);
  assert.equal(snapshot.cpu_percent, 50);
  assert.equal(snapshot.network_down_bytes_per_second, undefined);
  assert.equal(snapshot.network_up_bytes_per_second, undefined);
});

test("recovers network throughput from the last valid baseline after a failed pass", async () => {
  let sampleNumber = 0;
  const networkResults = [
    { received_bytes: 1_000, transmitted_bytes: 400 },
    undefined,
    { received_bytes: 5_000, transmitted_bytes: 1_400 },
  ];
  const sampler = createSystemSampler({
    platform: "linux",
    monotonicNow: () => (++sampleNumber) * 1_000,
    sampledAt: () => sampleNumber * 1_000,
    cpuTimes: () => ({ idle: 700 + sampleNumber * 100, total: 1_000 + sampleNumber * 200 }),
    loadAverage: () => [1, 0.5, 0.25],
    memory: () => ({ used_bytes: 40, total_bytes: 100 }),
    processCpuMicros: () => sampleNumber * 100_000,
    networkCollector: () => networkResults[sampleNumber - 1],
  });

  assert.equal((await sampler.sample()).network_down_bytes_per_second, undefined);
  assert.equal((await sampler.sample()).network_down_bytes_per_second, undefined);
  const recovered = await sampler.sample();
  assert.equal(recovered.network_down_bytes_per_second, 2_000);
  assert.equal(recovered.network_up_bytes_per_second, 500);
});

test("resets network rates for one sample when eligible interfaces are added or removed", async () => {
  let sampleNumber = 0;
  const networkResults = [
    { received_bytes: 1_000, transmitted_bytes: 400, interface_names: ["en0"] },
    { received_bytes: 2_000, transmitted_bytes: 900, interface_names: ["en0"] },
    { received_bytes: 12_500, transmitted_bytes: 6_200, interface_names: ["en0", "en1"] },
    { received_bytes: 13_500, transmitted_bytes: 6_700, interface_names: ["en0", "en1"] },
    { received_bytes: 4_000, transmitted_bytes: 1_800, interface_names: ["en0"] },
    { received_bytes: 5_000, transmitted_bytes: 2_300, interface_names: ["en0"] },
  ];
  const sampler = createSystemSampler({
    platform: "linux",
    monotonicNow: () => (++sampleNumber) * 1_000,
    sampledAt: () => sampleNumber * 1_000,
    cpuTimes: () => ({ idle: sampleNumber * 100, total: sampleNumber * 200 }),
    loadAverage: () => [1, 0.5, 0.25],
    memory: () => ({ used_bytes: 40, total_bytes: 100 }),
    processCpuMicros: () => sampleNumber * 100_000,
    networkCollector: () => networkResults[sampleNumber - 1],
  });

  await sampler.sample();
  assert.equal((await sampler.sample()).network_down_bytes_per_second, 1_000);
  assert.equal((await sampler.sample()).network_down_bytes_per_second, undefined);
  assert.equal((await sampler.sample()).network_down_bytes_per_second, 1_000);
  assert.equal((await sampler.sample()).network_down_bytes_per_second, undefined);
  assert.equal((await sampler.sample()).network_down_bytes_per_second, 1_000);
});

test("a full observation exception preserves the last snapshot and resolves safely", async () => {
  let sampleNumber = 0;
  let throwMemory = false;
  const sampler = createSystemSampler({
    platform: "linux",
    monotonicNow: () => (++sampleNumber) * 1_000,
    sampledAt: () => sampleNumber * 1_000,
    cpuTimes: () => ({ idle: sampleNumber * 100, total: sampleNumber * 200 }),
    loadAverage: () => [1, 0.5, 0.25],
    memory: () => {
      if (throwMemory) throw new Error("memory reader failed");
      return { used_bytes: 40, total_bytes: 100 };
    },
    processCpuMicros: () => sampleNumber * 100_000,
  });

  const first = await sampler.sample();
  throwMemory = true;
  assert.equal(await sampler.sample(), undefined);
  assert.equal(sampler.latest(), first);
});

test("uses the bounded netstat adapter on macOS", async () => {
  const calls = [];
  const sampler = createSystemSampler({
    platform: "darwin",
    monotonicNow: () => 1_000,
    sampledAt: () => 2_000,
    cpuTimes: () => ({ idle: 700, total: 1_000 }),
    loadAverage: () => [1, 0.5, 0.25],
    memory: () => ({ used_bytes: 40, total_bytes: 100 }),
    processCpuMicros: () => 1_000_000,
    execFile(file, args, options, callback) {
      calls.push({ file, args, options });
      callback(null, "Name Mtu Network Address Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll\nen0 1500 inet 192.0.2.1 1 0 100 1 0 50 0\n");
    },
  });

  const snapshot = await sampler.sample();
  assert.deepEqual(calls, [{
    file: "netstat",
    args: ["-ibn"],
    options: { encoding: "utf8", timeout: 750, maxBuffer: 1024 * 1024 },
  }]);
  assert.equal(snapshot.network_down_bytes_per_second, undefined);
  assert.equal(snapshot.cpu_percent, undefined);
});

test("preserves non-network metrics when the network callback reports an error", async () => {
  const sampler = createSystemSampler({
    platform: "darwin",
    monotonicNow: () => 1_000,
    sampledAt: () => 2_000,
    cpuTimes: () => ({ idle: 700, total: 1_000 }),
    loadAverage: () => [1, 0.5, 0.25],
    memory: () => ({ used_bytes: 40, total_bytes: 100 }),
    processCpuMicros: () => 1_000_000,
    serverMemoryBytes: () => 12,
    execFile(_file, _args, _options, callback) {
      callback(new Error("netstat failed"), "");
    },
  });

  const snapshot = await sampler.sample();
  assert.equal(snapshot.network_down_bytes_per_second, undefined);
  assert.equal(snapshot.cpu_percent, undefined);
  assert.deepEqual(snapshot.load_average, [1, 0.5, 0.25]);
  assert.equal(snapshot.memory_used_bytes, 40);
  assert.equal(snapshot.server_memory_bytes, 12);
});

test("skips network collection on unsupported platforms without losing other metrics", async () => {
  let called = false;
  const sampler = createSystemSampler({
    platform: "linux",
    monotonicNow: () => 1_000,
    sampledAt: () => 2_000,
    cpuTimes: () => ({ idle: 700, total: 1_000 }),
    loadAverage: () => [1, 0.5, 0.25],
    memory: () => ({ used_bytes: 40, total_bytes: 100 }),
    processCpuMicros: () => 1_000_000,
    execFile() {
      called = true;
    },
  });

  const snapshot = await sampler.sample();
  assert.equal(called, false);
  assert.equal(snapshot.network_down_bytes_per_second, undefined);
  assert.deepEqual(snapshot.load_average, [1, 0.5, 0.25]);
  assert.equal(snapshot.memory_used_bytes, 40);
});

test("adds cached temperature readings to system samples", async () => {
  let sampleNumber = 0;
  const readings = [
    { device_temperature_celsius: 68.2, battery_temperature_celsius: 31.4 },
    undefined,
  ];
  const sampler = createSystemSampler({
    platform: "linux",
    monotonicNow: () => (++sampleNumber) * 1_000,
    sampledAt: () => sampleNumber * 1_000,
    cpuTimes: () => ({ idle: sampleNumber * 100, total: sampleNumber * 200 }),
    loadAverage: () => [1, 0.5, 0.25],
    memory: () => ({ used_bytes: 40, total_bytes: 100 }),
    processCpuMicros: () => sampleNumber * 100_000,
    temperatureCollector: () => readings[sampleNumber - 1],
  });

  const first = await sampler.sample();
  const second = await sampler.sample();
  assert.equal(first.device_temperature_celsius, 68.2);
  assert.equal(first.battery_temperature_celsius, 31.4);
  assert.equal(second.device_temperature_celsius, 68.2);
  assert.equal(second.battery_temperature_celsius, 31.4);
});

test("returns an immutable latest snapshot", async () => {
  const sampler = createSystemSampler({
    platform: "linux",
    monotonicNow: () => 1_000,
    sampledAt: () => 2_000,
    cpuTimes: () => ({ idle: 700, total: 1_000 }),
    loadAverage: () => [1, 0.5, 0.25],
    memory: () => ({ used_bytes: 40, total_bytes: 100 }),
    processCpuMicros: () => 1_000_000,
  });

  await sampler.sample();
  const latest = sampler.latest();
  assert.ok(Object.isFrozen(latest));
  assert.ok(Object.isFrozen(latest.load_average));
  assert.throws(() => { latest.memory_percent = 99; }, TypeError);
  assert.throws(() => { latest.load_average[0] = 99; }, TypeError);
  assert.equal(sampler.latest().memory_percent, 40);
  assert.deepEqual(sampler.latest().load_average, [1, 0.5, 0.25]);
});

test("does not overlap unresolved samples", async () => {
  let resolveNetwork;
  let networkCalls = 0;
  const network = new Promise((resolve) => {
    resolveNetwork = resolve;
  });
  const sampler = createSystemSampler({
    platform: "darwin",
    monotonicNow: () => 1_000,
    sampledAt: () => 2_000,
    cpuTimes: () => ({ idle: 700, total: 1_000 }),
    loadAverage: () => [1, 0.5, 0.25],
    memory: () => ({ used_bytes: 40, total_bytes: 100 }),
    processCpuMicros: () => 1_000_000,
    networkCollector: async () => {
      networkCalls++;
      return network;
    },
  });

  const first = sampler.sample();
  assert.equal(await sampler.sample(), undefined);
  assert.equal(networkCalls, 1);

  resolveNetwork({ received_bytes: 10, transmitted_bytes: 20 });
  assert.ok(await first);
  assert.ok(sampler.latest());
  sampler.stop();
  assert.equal(await sampler.sample(), undefined);
});
