import assert from "node:assert/strict";
import test from "node:test";
import {
  createSystemSampler,
  deriveSystemSnapshot,
  parseNetworkCounters,
} from "../dist/systemSampler.js";

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

test("parses non-loopback network maxima across address rows", () => {
  const counters = parseNetworkCounters([
    "Name Mtu Network Address Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll",
    "en0 1500 inet 192.0.2.1 10 0 1000 20 0 2000 0",
    "en0 1500 inet6 fe80::1 30 0 3000 40 0 5000 0",
    "en1 1500 inet 198.51.100.1 5 0 4 6 0 8 0",
    "lo0 16384 inet 127.0.0.1 99 0 9000 99 0 9000 0",
  ].join("\n"));

  assert.deepEqual(counters, { received_bytes: 3004, transmitted_bytes: 5008 });
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
