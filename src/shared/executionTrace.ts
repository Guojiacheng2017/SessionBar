export type PhaseState = "pending" | "in_progress" | "completed" | "failed" | "cancelled" | "deleted" | "unknown";
export interface NativePhase { id: string; label?: string; state?: PhaseState; depends_on?: string[] }
export interface NativeExecutionEvent {
  event_id: string;
  sequence: number;
  at: number | null;
  kind: "call.start" | "call.end" | "run.start" | "run.end" | "turn.start" | "turn.end" | "agent.start" | "agent.end" | "phase" | "plan";
  call_id?: string;
  // Native lifecycle targets are canonicalized by the validated collector;
  // they never cause the tracker to create foreign or unobserved lanes.
  target_native_id?: string;
  target_agent_id?: string;
  wait_for_native_ids?: string[];
  wait_for_agent_ids?: string[];
  wait_result_native_ids?: string[];
  wait_result_agent_ids?: string[];
  cursor_scope?: string;
  unresolved_wait_targets?: number;
  label: string;
  outcome?: "completed" | "failed" | "cancelled";
  phase?: NativePhase;
  phases?: NativePhase[];
}
export interface ExecutionPhase {
  phase_id: string; agent_id: string; label: string; state: PhaseState;
  declared_at: number | null; started_at: number | null; ended_at: number | null;
  depends_on: string[];
}
export interface ExecutionSpan {
  span_id: string; agent_id: string; kind: "call" | "run" | "turn" | "agent"; label: string;
  started_at: number | null; ended_at: number | null;
  state: "open" | "completed" | "failed" | "cancelled" | "unknown";
  /** Native wait references, not business phase prerequisites. */
  wait_for_agent_ids?: string[];
  wait_result_agent_ids?: string[];
  unresolved_wait_targets?: number;
}
export interface ExecutionSnapshot {
  schema_version: "sessionbar.execution.v1";
  kind: "execution";
  stream_id: string; revision: number; session_id: string;
  observed_since: number; observed_at: number;
  availability: "available" | "unknown" | "unsupported";
  lanes: { agent_id: string; label: string; status: string }[];
  phases: ExecutionPhase[]; spans: ExecutionSpan[];
  max_concurrent_calls: number;
  max_parallel_execution: number | null;
  max_parallel_agents?: number | null;
  notes: string[];
}

/** A separate optional read resource; the frozen sub-agent v1 contract stays unchanged. */
export function isExecutionSnapshot(value: unknown, sessionId: string): value is ExecutionSnapshot {
  if (!value || typeof value !== "object") return false;
  const v = value as ExecutionSnapshot;
  const time = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 8.64e15;
  const nullableTime = (n: unknown) => n === null || time(n);
  const str = (s: unknown, max = 8192) => typeof s === "string" && s.length > 0 && s.length <= max;
  if (v.schema_version !== "sessionbar.execution.v1" || v.kind !== "execution" || v.session_id !== sessionId
    || !str(v.stream_id, 256) || !Number.isSafeInteger(v.revision) || v.revision < 0
    || !time(v.observed_since) || !time(v.observed_at) || v.observed_at < v.observed_since
    || !["available", "unknown", "unsupported"].includes(v.availability)
    || !Array.isArray(v.lanes) || v.lanes.length > 128 || !Array.isArray(v.phases) || v.phases.length > 128
    || !Array.isArray(v.spans) || v.spans.length > 512 || !Array.isArray(v.notes) || v.notes.length > 32
    || v.notes.some(n => typeof n !== "string" || n.length > 2000)) return false;
  const lanes = new Set(v.lanes.map(lane => lane?.agent_id));
  const references = (ids: unknown, owner: string) => ids === undefined || Array.isArray(ids) && ids.length <= 128
    && new Set(ids).size === ids.length && ids.every(id => typeof id === "string" && lanes.has(id) && id !== owner);
  if (lanes.size !== v.lanes.length || v.lanes.some(lane => !str(lane?.agent_id) || !str(lane.label, 256) || !str(lane.status, 64))) return false;
  if (v.phases.some(p => !p || !str(p.phase_id, 16384) || !lanes.has(p.agent_id) || !str(p.label, 256)
    || !["pending", "in_progress", "completed", "failed", "cancelled", "deleted", "unknown"].includes(p.state)
    || !nullableTime(p.declared_at) || !nullableTime(p.started_at) || !nullableTime(p.ended_at)
    || !Array.isArray(p.depends_on) || p.depends_on.length > 64 || p.depends_on.some(id => !str(id, 16384)))) return false;
  if (v.spans.some(s => !s || !str(s.span_id, 16384) || !lanes.has(s.agent_id) || !str(s.label, 256)
    || !["call", "run", "turn", "agent"].includes(s.kind) || !["open", "completed", "failed", "cancelled", "unknown"].includes(s.state)
    || !references(s.wait_for_agent_ids, s.agent_id) || !references(s.wait_result_agent_ids, s.agent_id)
    || (s.kind !== "call" && (s.wait_for_agent_ids !== undefined || s.wait_result_agent_ids !== undefined))
    || (s.unresolved_wait_targets !== undefined && (!Number.isSafeInteger(s.unresolved_wait_targets) || s.unresolved_wait_targets < 0 || s.unresolved_wait_targets > 128))
    || !nullableTime(s.started_at) || !nullableTime(s.ended_at)
    || (s.started_at !== null && s.ended_at !== null && s.ended_at < s.started_at))) return false;
  return (v.max_parallel_agents === undefined || v.max_parallel_agents === null || (Number.isSafeInteger(v.max_parallel_agents) && v.max_parallel_agents >= 0 && v.max_parallel_agents <= 512))
    && Number.isSafeInteger(v.max_concurrent_calls) && v.max_concurrent_calls >= 0 && v.max_concurrent_calls <= 512
    && (v.max_parallel_execution === null || (Number.isSafeInteger(v.max_parallel_execution) && v.max_parallel_execution >= 0 && v.max_parallel_execution <= 512));
}
