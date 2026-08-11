import type { SessionPayload, SessionRuntimeSnapshot } from "./types.js";

export type RuntimeSession = Pick<SessionPayload, "session_id" | "status" | "session_name" | "project"> & {
  runtime?: SessionRuntimeSnapshot;
};

export interface RuntimeContribution {
  sessionId: string;
  sessionName?: string;
  project?: string;
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
  const cpuPercent = sum(sampled.map(session => session.runtime?.cpu_percent));
  const gpuPercent = sum(sampled.map(session => session.runtime?.gpu_percent));
  const memoryPercent = sum(sampled.map(session => session.runtime?.memory_percent));
  const memoryBytes = sum(sampled.map(session => session.runtime?.memory_bytes));
  const processCount = sum(sampled.map(session => session.runtime?.process_count));
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
    contributions: sampled.map(session => ({
      sessionId: session.session_id,
      sessionName: session.session_name,
      project: session.project,
      cpuShare: share(session.runtime?.cpu_percent, cpuPercent),
      gpuShare: share(session.runtime?.gpu_percent, gpuPercent),
      memoryShare: share(session.runtime?.memory_percent, memoryPercent),
      processShare: share(session.runtime?.process_count, processCount),
    })),
  };
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

function hasRuntimeValue(runtime: SessionRuntimeSnapshot | undefined): boolean {
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
  if (value === undefined || total === undefined || total <= 0) return undefined;
  return Math.round((value / total) * 10000) / 100;
}
