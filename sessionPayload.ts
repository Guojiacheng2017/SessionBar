import { SessionAgentSignalInput, SessionPayload, SessionStatus } from "./types.js";
import { sessionSnapshotToHookEvents } from "./hookEvents.js";
import { reduceSessionEvents } from "./sessionReducer.js";

export type SessionReportPayload = Omit<SessionPayload, "source" | "timestamp" | "agent_signals"> & {
  source?: SessionPayload["source"];
  timestamp?: number;
  hook_event?: string;
  agent_signals?: SessionAgentSignalInput[];
};

const STATUSES: readonly SessionStatus[] = ["idle", "working", "blocked", "error"];
const NON_NEGATIVE_NUMBER_FIELDS = [
  "tokens",
  "turns",
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "token_rate",
] as const;
const PERCENT_FIELDS = ["context_percent", "quota_percent"] as const;

export function validateSessionPayload(body: unknown): body is SessionReportPayload {
  if (!body || typeof body !== "object") return false;
  const payload = body as Record<string, unknown>;
  if (typeof payload.session_id !== "string" || !payload.session_id) return false;
  if (typeof payload.session_type !== "string" || !payload.session_type) return false;
  if (typeof payload.status !== "string" || !STATUSES.includes(payload.status as SessionStatus)) return false;
  if (typeof payload.task_name !== "string" || payload.task_name.length > 500) return false;
  if (payload.progress !== undefined && !isNumberInRange(payload.progress, 0, 1)) return false;
  for (const field of PERCENT_FIELDS) {
    if (payload[field] !== undefined && !isNumberInRange(payload[field], 0, 100)) return false;
  }
  for (const field of NON_NEGATIVE_NUMBER_FIELDS) {
    if (payload[field] !== undefined && !isNonNegativeNumber(payload[field])) return false;
  }
  if (payload.process_pid !== undefined && !isPositiveInteger(payload.process_pid)) return false;
  if (payload.quota_reset !== undefined && (typeof payload.quota_reset !== "string" || payload.quota_reset.length > 64)) return false;
  if (payload.hook_event !== undefined && !isShortNonEmptyString(payload.hook_event, 128)) return false;
  if (payload.session_name !== undefined && !isShortNonEmptyString(payload.session_name, 128)) return false;
  if (payload.activity_tail !== undefined && (
    !Array.isArray(payload.activity_tail) ||
    payload.activity_tail.length > 8 ||
    payload.activity_tail.some((line: unknown) => typeof line !== "string" || line.length > 240)
  )) return false;
  if (payload.project !== undefined && typeof payload.project !== "string") return false;
  if (payload.project_path !== undefined && typeof payload.project_path !== "string") return false;
  if (payload.runtime !== undefined && !isValidRuntimeSnapshot(payload.runtime)) return false;
  if (payload.agent_signals !== undefined && (
    !Array.isArray(payload.agent_signals) ||
    payload.agent_signals.length > 8 ||
    payload.agent_signals.some(signal => !isValidAgentSignal(signal))
  )) return false;
  return true;
}

export function mergeSessionPayload(
  prev: SessionPayload | undefined,
  data: SessionReportPayload,
  now: number,
): SessionPayload {
  const reduced = reduceSessionEvents(prev, sessionSnapshotToHookEvents(data, now));
  return {
    ...reduced,
    quota_percent: data.quota_percent ?? prev?.quota_percent,
    quota_reset: data.quota_reset ?? prev?.quota_reset,
    process_pid: data.process_pid ?? prev?.process_pid,
    runtime: data.runtime ?? prev?.runtime,
  };
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isNumberInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function isShortNonEmptyString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

function isValidAgentSignal(value: unknown): value is SessionAgentSignalInput {
  if (!value || typeof value !== "object") return false;
  const signal = value as Record<string, unknown>;
  if (!isShortNonEmptyString(signal.signal, 64)) return false;
  if (signal.timestamp !== undefined && !isNonNegativeNumber(signal.timestamp)) return false;
  if (signal.source !== undefined && !isShortNonEmptyString(signal.source, 64)) return false;
  if (signal.scope !== undefined && !isShortNonEmptyString(signal.scope, 32)) return false;
  if (signal.kind !== undefined && !isShortNonEmptyString(signal.kind, 64)) return false;
  if (signal.used !== undefined && !isNonNegativeNumber(signal.used)) return false;
  if (signal.remaining !== undefined && !isNonNegativeNumber(signal.remaining)) return false;
  if (signal.limit !== undefined && !isNonNegativeNumber(signal.limit)) return false;
  if (signal.unit !== undefined && !isShortNonEmptyString(signal.unit, 32)) return false;
  if (signal.status !== undefined && !isShortNonEmptyString(signal.status, 32)) return false;
  if (signal.error_code !== undefined && !isShortNonEmptyString(signal.error_code, 64)) return false;
  if (signal.balance !== undefined && !isNonNegativeNumber(signal.balance)) return false;
  if (signal.balance_unit !== undefined && !isShortNonEmptyString(signal.balance_unit, 32)) return false;
  if (signal.used_percent !== undefined && !isNumberInRange(signal.used_percent, 0, 100)) return false;
  if (signal.reset_at !== undefined && !isNonNegativeNumber(signal.reset_at)) return false;
  if (signal.label !== undefined && (typeof signal.label !== "string" || signal.label.length > 128)) return false;
  return true;
}

function isValidRuntimeSnapshot(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const runtime = value as Record<string, unknown>;
  for (const field of ["cpu_percent", "memory_bytes", "process_count", "sampled_at"] as const) {
    if (runtime[field] !== undefined && !isNonNegativeNumber(runtime[field])) return false;
  }
  for (const field of ["gpu_percent", "memory_percent"] as const) {
    if (runtime[field] !== undefined && !isNumberInRange(runtime[field], 0, 100)) return false;
  }
  if (runtime.process_count !== undefined && !Number.isInteger(runtime.process_count)) return false;
  return true;
}
