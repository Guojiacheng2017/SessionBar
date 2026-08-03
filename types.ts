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

export interface SessionAdvisor {
  level: "green" | "yellow" | "red";
  pacing: string;
  cardTiming: string;
  autoResetIn: string;
  sustainableRate: number;
  actualVsSustainable: number | null;
  projectedCapHitAt: number | null;
}

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

export interface SessionPayload {
  session_id: string;    // unique per session, e.g. "vision-dash-40393"
  session_type: string;  // label, e.g. "Claude Code", "Gemini CLI"
  source?: "hook" | "codex_jsonl";
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
  agent_signals?: SessionAgentSignal[];
  workflow_events?: SessionWorkflowEvent[];
  unknown_events?: SessionUnknownEvent[];
  timestamp: number;
  project?: string;       // project dir basename, e.g. "vision-dash"
  project_path?: string;  // full project dir, e.g. "/Users/…/Vision-Dash"
  advisor?: SessionAdvisor; // server-internal derived field, NOT from POST /session/status
}
