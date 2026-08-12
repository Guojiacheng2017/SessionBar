import { execFile as systemExecFile } from "node:child_process";
import { cpus, freemem, loadavg, totalmem } from "node:os";
import { performance } from "node:perf_hooks";
import { cpuUsage, memoryUsage } from "node:process";
import type { SystemEfficiencySnapshot } from "./types.js";

export interface CpuTimes {
  idle: number;
  total: number;
}

export interface NetworkCounters {
  received_bytes: number;
  transmitted_bytes: number;
  interface_names?: string[];
}

export interface SystemSampleInput {
  monotonic_ms: number;
  cpu: CpuTimes;
  network?: NetworkCounters;
  process_cpu_micros: number;
  load_average?: [number, number, number];
  memory_used_bytes?: number;
  memory_total_bytes?: number;
  server_memory_bytes?: number;
  sampled_at?: number;
}

interface ExecFileOptions {
  encoding: "utf8";
  timeout: number;
  maxBuffer: number;
}

export type ExecFile = (
  file: string,
  args: string[],
  options: ExecFileOptions,
  callback: (error: Error | null, stdout: string) => void,
) => void;

interface MemoryValues {
  used_bytes: number;
  total_bytes: number;
}

export interface SystemSamplerOptions {
  platform?: NodeJS.Platform;
  monotonicNow?: () => number;
  sampledAt?: () => number;
  cpuTimes?: () => CpuTimes;
  loadAverage?: () => [number, number, number];
  memory?: () => MemoryValues;
  processCpuMicros?: () => number;
  serverMemoryBytes?: () => number;
  networkCollector?: () => NetworkCounters | Promise<NetworkCounters | undefined>;
  execFile?: ExecFile;
}

const NETSTAT_ARGS = ["-ibn"];
const NETSTAT_OPTIONS: ExecFileOptions = {
  encoding: "utf8",
  timeout: 750,
  maxBuffer: 1024 * 1024,
};

function finiteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function counterDelta(previous: number | undefined, current: number | undefined): number | undefined {
  if (previous === undefined || current === undefined) return undefined;
  if (!finiteNonNegative(previous) || !finiteNonNegative(current) || current < previous) return undefined;
  return current - previous;
}

function hasPositiveFiniteElapsed(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function rateDelta(previous: number | undefined, current: number | undefined, seconds: number): number | undefined {
  const delta = counterDelta(previous, current);
  if (delta === undefined || !hasPositiveFiniteElapsed(seconds)) return undefined;
  return delta / seconds;
}

function cpuPercent(previous: CpuTimes | undefined, current: CpuTimes, elapsedMs: number): number | undefined {
  if (!previous || !hasPositiveFiniteElapsed(elapsedMs)) return undefined;
  const totalDelta = counterDelta(previous.total, current.total);
  const idleDelta = counterDelta(previous.idle, current.idle);
  if (totalDelta === undefined || idleDelta === undefined || totalDelta <= 0 || idleDelta > totalDelta) return undefined;
  return ((totalDelta - idleDelta) / totalDelta) * 100;
}

function serverCpuPercent(previous: number | undefined, current: number, elapsedMs: number): number | undefined {
  const delta = counterDelta(previous, current);
  if (delta === undefined || !hasPositiveFiniteElapsed(elapsedMs)) return undefined;
  return clampPercent((delta / (elapsedMs * 1_000)) * 100);
}

export function deriveSystemSnapshot(
  previous: SystemSampleInput | undefined,
  current: SystemSampleInput,
): SystemEfficiencySnapshot {
  const elapsedMs = previous ? current.monotonic_ms - previous.monotonic_ms : 0;
  const elapsedSeconds = hasPositiveFiniteElapsed(elapsedMs) ? elapsedMs / 1_000 : 0;
  const memoryUsed = Number.isFinite(current.memory_used_bytes) ? current.memory_used_bytes ?? 0 : 0;
  const memoryTotal = Number.isFinite(current.memory_total_bytes) ? current.memory_total_bytes ?? 0 : 0;
  const memoryPercent = memoryTotal > 0 ? clampPercent((memoryUsed / memoryTotal) * 100) : 0;
  const load = current.load_average ?? [0, 0, 0];
  const networkDown = rateDelta(previous?.network?.received_bytes, current.network?.received_bytes, elapsedSeconds);
  const networkUp = rateDelta(previous?.network?.transmitted_bytes, current.network?.transmitted_bytes, elapsedSeconds);

  return {
    cpu_percent: cpuPercent(previous?.cpu, current.cpu, elapsedMs),
    load_average: [load[0], load[1], load[2]],
    memory_used_bytes: memoryUsed,
    memory_total_bytes: memoryTotal,
    memory_percent: memoryPercent,
    network_down_bytes_per_second: networkDown,
    network_up_bytes_per_second: networkUp,
    server_cpu_percent: serverCpuPercent(previous?.process_cpu_micros, current.process_cpu_micros, elapsedMs),
    server_memory_bytes: current.server_memory_bytes ?? 0,
    sampled_at: current.sampled_at ?? current.monotonic_ms,
  };
}

function aggregateCpuTimes(): CpuTimes {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus()) {
    for (const value of Object.values(cpu.times)) {
      if (Number.isFinite(value) && value >= 0) total += value;
    }
    if (Number.isFinite(cpu.times.idle) && cpu.times.idle >= 0) idle += cpu.times.idle;
  }
  return { idle, total };
}

function processCpuMicros(): number {
  const usage = cpuUsage();
  return usage.user + usage.system;
}

function parseCounter(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function validNetworkCounters(value: NetworkCounters | undefined): value is NetworkCounters {
  return value !== undefined
    && finiteNonNegative(value.received_bytes)
    && finiteNonNegative(value.transmitted_bytes)
    && (value.interface_names === undefined
      || value.interface_names.every(name => typeof name === "string" && name.length > 0));
}

function sameEligibleInterfaces(previous: NetworkCounters | undefined, current: NetworkCounters): boolean {
  if (!previous?.interface_names || !current.interface_names) return true;
  if (previous.interface_names.length !== current.interface_names.length) return false;
  const currentNames = new Set(current.interface_names);
  return previous.interface_names.every(name => currentNames.has(name));
}

function isLoopbackInterface(name: string): boolean {
  return /^lo\d*$/i.test(name);
}

export function parseNetworkCounters(stdout: string): NetworkCounters | undefined {
  const lines = stdout.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => {
    const fields = line.trim().split(/\s+/);
    return fields.includes("Name") && fields.includes("Ibytes") && fields.includes("Obytes");
  });
  if (headerIndex < 0) return undefined;

  const header = lines[headerIndex].trim().split(/\s+/);
  const nameIndex = header.indexOf("Name");
  const receivedIndex = header.indexOf("Ibytes");
  const transmittedIndex = header.indexOf("Obytes");
  const interfaces = new Map<string, NetworkCounters>();

  for (const line of lines.slice(headerIndex + 1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length <= Math.max(nameIndex, receivedIndex, transmittedIndex)) continue;
    const name = fields[nameIndex];
    if (!name || isLoopbackInterface(name)) continue;
    const received = parseCounter(fields[receivedIndex]);
    const transmitted = parseCounter(fields[transmittedIndex]);
    if (received === undefined && transmitted === undefined) continue;

    const prior = interfaces.get(name);
    interfaces.set(name, {
      received_bytes: Math.max(prior?.received_bytes ?? 0, received ?? 0),
      transmitted_bytes: Math.max(prior?.transmitted_bytes ?? 0, transmitted ?? 0),
    });
  }

  if (interfaces.size === 0) return undefined;
  let receivedBytes = 0;
  let transmittedBytes = 0;
  for (const counters of interfaces.values()) {
    receivedBytes += counters.received_bytes;
    transmittedBytes += counters.transmitted_bytes;
  }
  return {
    received_bytes: receivedBytes,
    transmitted_bytes: transmittedBytes,
    interface_names: [...interfaces.keys()].sort(),
  };
}

function defaultExecFile(
  file: string,
  args: string[],
  options: ExecFileOptions,
  callback: (error: Error | null, stdout: string) => void,
): void {
  systemExecFile(file, args, options, (error, stdout) => callback(error, String(stdout ?? "")));
}

function collectNetworkCounters(
  platform: NodeJS.Platform,
  execFile: ExecFile,
): Promise<NetworkCounters | undefined> {
  if (platform !== "darwin") return Promise.resolve(undefined);
  return new Promise((resolve) => {
    execFile("netstat", NETSTAT_ARGS, NETSTAT_OPTIONS, (error, stdout) => {
      if (error) {
        resolve(undefined);
        return;
      }
      resolve(parseNetworkCounters(stdout));
    });
  });
}

function freezeSnapshot(snapshot: SystemEfficiencySnapshot): SystemEfficiencySnapshot {
  const load = Object.freeze([...snapshot.load_average]) as unknown as [number, number, number];
  return Object.freeze({ ...snapshot, load_average: load });
}

export function createSystemSampler(options: SystemSamplerOptions = {}): {
  sample(): Promise<SystemEfficiencySnapshot | undefined>;
  latest(): SystemEfficiencySnapshot | undefined;
  stop(): void;
} {
  const platform = options.platform ?? process.platform;
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const sampledAt = options.sampledAt ?? (() => Date.now());
  const readCpuTimes = options.cpuTimes ?? aggregateCpuTimes;
  const readLoadAverage = options.loadAverage ?? (() => {
    const values = loadavg();
    return [values[0] ?? 0, values[1] ?? 0, values[2] ?? 0];
  });
  const readMemory = options.memory ?? (() => {
    const total = totalmem();
    return { used_bytes: Math.max(0, total - freemem()), total_bytes: total };
  });
  const readProcessCpu = options.processCpuMicros ?? processCpuMicros;
  const readServerMemory = options.serverMemoryBytes ?? (() => memoryUsage().rss);
  const execFile = options.execFile ?? defaultExecFile;
  let previous: SystemSampleInput | undefined;
  let lastValidNetwork: SystemSampleInput | undefined;
  let latestSnapshot: SystemEfficiencySnapshot | undefined;
  let inFlight = false;
  let stopped = false;

  async function sample(): Promise<SystemEfficiencySnapshot | undefined> {
    if (stopped || inFlight) return undefined;
    inFlight = true;
    try {
      try {
        const memory = readMemory();
        const current: SystemSampleInput = {
          monotonic_ms: monotonicNow(),
          cpu: readCpuTimes(),
          load_average: readLoadAverage(),
          memory_used_bytes: memory.used_bytes,
          memory_total_bytes: memory.total_bytes,
          process_cpu_micros: readProcessCpu(),
          server_memory_bytes: readServerMemory(),
          sampled_at: sampledAt(),
        };
        let network: NetworkCounters | undefined;
        try {
          network = options.networkCollector
            ? await options.networkCollector()
            : await collectNetworkCounters(platform, execFile);
        } catch {
          network = undefined;
        }
        current.network = validNetworkCounters(network) ? network : undefined;
        const snapshot = deriveSystemSnapshot(previous, current);
        if (current.network) {
          if (sameEligibleInterfaces(lastValidNetwork?.network, current.network)) {
            const networkSnapshot = deriveSystemSnapshot(lastValidNetwork, current);
            snapshot.network_down_bytes_per_second = networkSnapshot.network_down_bytes_per_second;
            snapshot.network_up_bytes_per_second = networkSnapshot.network_up_bytes_per_second;
          } else {
            snapshot.network_down_bytes_per_second = undefined;
            snapshot.network_up_bytes_per_second = undefined;
          }
          lastValidNetwork = current;
        }
        const immutableSnapshot = freezeSnapshot(snapshot);
        previous = current;
        latestSnapshot = immutableSnapshot;
        return immutableSnapshot;
      } catch {
        return undefined;
      }
    } finally {
      inFlight = false;
    }
  }

  return {
    sample,
    latest: () => latestSnapshot,
    stop: () => {
      stopped = true;
    },
  };
}
