import type { SessionPayload, SessionRuntimeSnapshot } from "./types.js";

export type RuntimeSession = Pick<SessionPayload, "session_id" | "status" | "session_name" | "project" | "process_pid"> & {
  runtime?: SessionRuntimeSnapshot;
};

export interface RuntimeContribution {
  sessionId: string;
  sessionIds: string[];
  sessionName?: string;
  project?: string;
  processPid?: number;
  sharedProcess: boolean;
  cpuPercent?: number;
  gpuPercent?: number;
  memoryPercent?: number;
  memoryBytes?: number;
  processCount?: number;
  cpuShare?: number;
  gpuShare?: number;
  memoryShare?: number;
  processShare?: number;
}

export interface RuntimeUsage {
  activeSessions: number;
  sampledSessions: number;
  sampledAt?: number;
  cpuPercent?: number;
  gpuPercent?: number;
  memoryPercent?: number;
  memoryBytes?: number;
  processCount?: number;
  hasGpuData: boolean;
  contributions: RuntimeContribution[];
}

const ACTIVE_STATUSES = new Set(["working", "blocked"]);

export function aggregateRuntimeUsage(sessions: readonly RuntimeSession[]): RuntimeUsage {
  const active = sessions.filter(session => ACTIVE_STATUSES.has(session.status));
  const sampled = active.filter(session => hasRuntimeValue(session.runtime));
  const sources = runtimeSources(active);
  const cpuPercent = sum(sources.map(source => source.runtime.cpu_percent));
  const gpuPercent = sum(sources.map(source => source.runtime.gpu_percent));
  const memoryPercent = sum(sources.map(source => source.runtime.memory_percent));
  const memoryBytes = sum(sources.map(source => source.runtime.memory_bytes));
  const processCount = sum(sources.map(source => source.runtime.process_count));
  const sampledAt = max(sampled.map(session => session.runtime?.sampled_at));

  return {
    activeSessions: active.length,
    sampledSessions: sampled.length,
    sampledAt,
    cpuPercent,
    gpuPercent,
    memoryPercent,
    memoryBytes,
    processCount,
    hasGpuData: gpuPercent !== undefined,
    contributions: sources.map(source => ({
      sessionId: source.sessions[0].session_id,
      sessionIds: source.sessions.map(session => session.session_id),
      sessionName: source.sessions[0].session_name,
      project: source.sessions[0].project,
      processPid: source.processPid,
      sharedProcess: source.processPid !== undefined && source.sessions.length > 1,
      cpuPercent: source.runtime.cpu_percent,
      gpuPercent: source.runtime.gpu_percent,
      memoryPercent: source.runtime.memory_percent,
      memoryBytes: source.runtime.memory_bytes,
      processCount: source.runtime.process_count,
      cpuShare: share(source.runtime.cpu_percent, cpuPercent),
      gpuShare: share(source.runtime.gpu_percent, gpuPercent),
      memoryShare: share(source.runtime.memory_percent, memoryPercent),
      processShare: share(source.runtime.process_count, processCount),
    })),
  };
}

interface RuntimeSource {
  processPid?: number;
  sessions: RuntimeSession[];
  runtime: SessionRuntimeSnapshot;
}

function runtimeSources(sessions: readonly RuntimeSession[]): RuntimeSource[] {
  const groups = new Map<string, { processPid?: number; sessions: RuntimeSession[] }>();
  for (const session of sessions) {
    const key = session.process_pid === undefined ? `session:${session.session_id}` : `pid:${session.process_pid}`;
    const group = groups.get(key) ?? { processPid: session.process_pid, sessions: [] };
    group.sessions.push(session);
    groups.set(key, group);
  }

  const sources: RuntimeSource[] = [];
  for (const group of groups.values()) {
    const runtimes = group.sessions.map(session => session.runtime).filter(hasRuntimeValue);
    if (runtimes.length === 0) continue;
    sources.push({
      ...group,
      runtime: {
        cpu_percent: latestMetric(runtimes, "cpu_percent"),
        gpu_percent: latestMetric(runtimes, "gpu_percent"),
        memory_percent: latestMetric(runtimes, "memory_percent"),
        memory_bytes: latestMetric(runtimes, "memory_bytes"),
        process_count: latestMetric(runtimes, "process_count"),
        sampled_at: max(runtimes.map(runtime => runtime.sampled_at)),
      },
    });
  }
  return sources;
}

function latestMetric(
  runtimes: readonly SessionRuntimeSnapshot[],
  field: Exclude<keyof SessionRuntimeSnapshot, "sampled_at">,
): number | undefined {
  let latest: SessionRuntimeSnapshot | undefined;
  for (const runtime of runtimes) {
    const value = runtime[field];
    if (value === undefined || !Number.isFinite(value)) continue;
    if (!latest || (runtime.sampled_at ?? -Infinity) > (latest.sampled_at ?? -Infinity)) latest = runtime;
  }
  return latest?.[field];
}

export function runtimeProgressBar(value: number | undefined, max: number, width = 16): string {
  const safeWidth = Math.max(1, Math.floor(width));
  if (value === undefined || !Number.isFinite(value) || !Number.isFinite(max) || max <= 0) {
    return "·".repeat(safeWidth);
  }
  const filled = Math.max(0, Math.min(safeWidth, Math.round((value / max) * safeWidth)));
  return "█".repeat(filled) + "░".repeat(safeWidth - filled);
}

export function formatRuntimeBytes(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value) || value < 0) return "—";
  if (value < 1024) return `${Math.round(value)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let scaled = value;
  let unit = "B";
  for (const next of units) {
    scaled /= 1024;
    unit = next;
    if (scaled < 1024 || next === units[units.length - 1]) break;
  }
  const digits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
  return `${scaled.toFixed(digits).replace(/\.0+$/, "")} ${unit}`;
}

function hasRuntimeValue(runtime: SessionRuntimeSnapshot | undefined): runtime is SessionRuntimeSnapshot {
  return runtime !== undefined && [
    runtime.cpu_percent,
    runtime.gpu_percent,
    runtime.memory_percent,
    runtime.memory_bytes,
    runtime.process_count,
  ].some(value => value !== undefined && Number.isFinite(value));
}

function sum(values: readonly (number | undefined)[]): number | undefined {
  const present = values.filter((value): value is number => value !== undefined && Number.isFinite(value));
  return present.length > 0 ? present.reduce((total, value) => total + value, 0) : undefined;
}

function max(values: readonly (number | undefined)[]): number | undefined {
  const present = values.filter((value): value is number => value !== undefined && Number.isFinite(value));
  return present.length > 0 ? Math.max(...present) : undefined;
}

function share(value: number | undefined, total: number | undefined): number | undefined {
  if (value === undefined || total === undefined || total < 0) return undefined;
  if (total === 0) return value === 0 ? 0 : undefined;
  return Math.round((value / total) * 10000) / 100;
}
