import type { PlanRow } from "../providers/planTypes.js";

export type SessionStatus = "idle" | "working" | "blocked" | "error";

export interface SessionPlanSignal {
  state: "now" | "next" | "done" | "blocked" | string;
  text: string;
  age?: string;
}

export interface SessionFlowNode {
  id: string;
  label?: string;
  status?: string;
}

export interface SessionFlowEdge {
  from: string;
  to: string;
  label?: string;
}

export interface SessionFlowGraph {
  nodes: SessionFlowNode[];
  edges: SessionFlowEdge[];
}

export interface SessionAgentSignal {
  signal: string;
  timestamp: number;
  source?: string;
  scope?: string;
  kind?: string;
  used?: number;
  remaining?: number;
  limit?: number;
  unit?: string;
  status?: string;
  error_code?: string;
  balance?: number;
  balance_unit?: string;
  used_percent?: number;
  reset_at?: number;
  label?: string;
}

export type SessionAgentSignalInput = Omit<SessionAgentSignal, "timestamp"> & {
  timestamp?: number;
};

export interface SessionUnknownEvent {
  timestamp: number;
  source?: string;
  raw: unknown;
}

export interface SessionWorkflowEvent {
  timestamp: number;
  source?: string;
  raw_event: string;
  canonical_stage_id: string;
  canonical_category: string;
  canonical_direction: string;
  mapping_type: string;
  confidence: string;
  notes?: string;
}

export interface SessionRuntimeSnapshot {
  cpu_percent?: number;
  gpu_percent?: number;
  memory_percent?: number;
  memory_bytes?: number;
  process_count?: number;
  sampled_at?: number;
}

export interface SystemEfficiencySnapshot {
  cpu_percent?: number;
  load_average: [number, number, number];
  memory_used_bytes: number;
  memory_total_bytes: number;
  memory_percent: number;
  network_down_bytes_per_second?: number;
  network_up_bytes_per_second?: number;
  device_temperature_celsius?: number;
  battery_temperature_celsius?: number;
  server_cpu_percent?: number;
  server_memory_bytes: number;
  sampled_at: number;
}

export function isSystemEfficiencySnapshot(value: unknown): value is SystemEfficiencySnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Record<string, unknown>;
  const load = snapshot.load_average;
  const requiredNumbers = [
    snapshot.memory_used_bytes,
    snapshot.memory_total_bytes,
    snapshot.memory_percent,
    snapshot.server_memory_bytes,
    snapshot.sampled_at,
  ];
  const optionalNumbers = [
    snapshot.cpu_percent,
    snapshot.network_down_bytes_per_second,
    snapshot.network_up_bytes_per_second,
    snapshot.device_temperature_celsius,
    snapshot.battery_temperature_celsius,
    snapshot.server_cpu_percent,
  ];
  return Array.isArray(load)
    && load.length === 3
    && load.every(item => typeof item === "number" && Number.isFinite(item))
    && requiredNumbers.every(item => typeof item === "number" && Number.isFinite(item))
    && optionalNumbers.every(item => item === undefined || (typeof item === "number" && Number.isFinite(item)));
}

export interface SessionPayload {
  session_id: string;    // unique per session, e.g. "vision-dash-40393"
  session_type: string;  // label, e.g. "Claude Code", "Gemini CLI"
  session_name?: string; // human-readable session name, when reported by the agent
  source?: "hook" | "codex_jsonl" | "native_registry";
  status: SessionStatus;
  task_name: string;
  activity_tail?: string[]; // short recent activity lines, agent-specific adapters may report this
  plan_signal?: SessionPlanSignal[];
  flow?: SessionFlowGraph;
  progress?: number;     // 0.0 ~ 1.0
  context_percent?: number; // 0 ~ 100, when reported by the agent/hook
  tokens?: number;
  turns?: number;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  token_rate?: number; // tokens per minute, when reported by the hook
  quota_percent?: number; // 0 ~ 100, provider quota remaining or available
  quota_reset?: string; // short display label, e.g. "5h38m"
  runtime?: SessionRuntimeSnapshot; // resources used by this session's agent process
  agent_signals?: SessionAgentSignal[];
  workflow_events?: SessionWorkflowEvent[];
  unknown_events?: SessionUnknownEvent[];
  timestamp: number;
  project?: string;       // project dir basename, e.g. "vision-dash"
  project_path?: string;  // full project dir, e.g. "/Users/…/Vision-Dash"
  session_source?: string; // source reported by the agent's native session registry
  model_provider?: string;
  session_preview?: string;
  git_branch?: string;
  git_sha?: string;
  session_updated_at?: number;
  advisorRows?: PlanRow[]; // server-internal derived field, NOT from POST /session/status
}
