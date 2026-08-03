import type { SessionAgentSignalInput, SessionPayload, SessionStatus } from "./types.js";
import { adaptNativeHookPayload, type HookAdapterResult } from "./hookAdapters.js";
import { mapHookEvent, type HookMappingConfidence, type HookMappingType } from "./hookOntology.js";

export interface HookEventBase {
  type: string;
  agent_type: string;
  session_id?: string;
  project?: string;
  project_path?: string;
  timestamp: number;
  source?: string;
}

export interface SessionStatusEvent extends HookEventBase {
  type: "session_status";
  status: SessionStatus;
  task_name: string;
  progress?: number;
}

export interface ActivityEvent extends HookEventBase {
  type: "activity_event";
  label: string;
}

export interface UsageSnapshotEvent extends HookEventBase {
  type: "usage_snapshot";
  total_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  cached_input_tokens?: number;
  cache_write_tokens?: number;
  turns?: number;
  context_percent?: number;
  model_context_window?: number;
}

export interface FlowEvent extends HookEventBase {
  type: "flow_event";
  flow?: SessionPayload["flow"];
}

export interface WorkflowEvent extends HookEventBase {
  type: "workflow_event";
  raw_event: string;
  canonical_stage_id: string;
  canonical_category: string;
  canonical_direction: string;
  mapping_type: HookMappingType;
  confidence: HookMappingConfidence;
  notes?: string;
}

export interface AgentSignalEvent extends HookEventBase {
  type: "agent_signal";
  signal: string;
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

export interface ProjectSignalEvent extends HookEventBase {
  type: "project_signal";
  label?: string;
}

export interface UnknownHookEvent extends HookEventBase {
  type: "unknown";
  raw: unknown;
}

export type HookEvent =
  | SessionStatusEvent
  | ActivityEvent
  | UsageSnapshotEvent
  | FlowEvent
  | WorkflowEvent
  | AgentSignalEvent
  | ProjectSignalEvent
  | UnknownHookEvent;

export type SessionSnapshotInput = Omit<SessionPayload, "source" | "timestamp" | "agent_signals"> & {
  source?: SessionPayload["source"];
  timestamp?: number;
  hook_event?: string;
  agent_signals?: SessionAgentSignalInput[];
};

export type NativePayloadContext = Omit<HookEventBase, "type">;

export function sessionSnapshotToHookEvents(snapshot: SessionSnapshotInput, timestamp: number): HookEvent[] {
  const base = eventBase(snapshot, timestamp);
  const events: HookEvent[] = [
    {
      ...base,
      type: "session_status",
      status: snapshot.status,
      task_name: snapshot.task_name,
      progress: snapshot.progress,
    },
  ];

  for (const label of snapshot.activity_tail ?? []) {
    events.push({ ...base, type: "activity_event", label });
  }

  if (hasUsage(snapshot)) {
    events.push({
      ...base,
      type: "usage_snapshot",
      total_tokens: snapshot.tokens,
      input_tokens: snapshot.input_tokens,
      output_tokens: snapshot.output_tokens,
      cached_input_tokens: snapshot.cache_read_tokens,
      cache_write_tokens: snapshot.cache_write_tokens,
      turns: snapshot.turns,
      context_percent: snapshot.context_percent,
    });
  }

  for (const signal of snapshot.agent_signals ?? []) {
    events.push({
      ...base,
      type: "agent_signal",
      source: signal.source ?? base.source,
      signal: signal.signal,
      scope: signal.scope,
      kind: signal.kind,
      used: signal.used,
      remaining: signal.remaining,
      limit: signal.limit,
      unit: signal.unit,
      status: signal.status,
      error_code: signal.error_code,
      balance: signal.balance,
      balance_unit: signal.balance_unit,
      used_percent: signal.used_percent,
      reset_at: signal.reset_at,
      label: signal.label,
    });
  }

  if (snapshot.flow) {
    events.push({ ...base, type: "flow_event", flow: snapshot.flow });
  }

  const workflow = workflowEventFromRaw(snapshot.hook_event, base);
  if (workflow) {
    events.push(workflow);
  }

  return events;
}

export function nativePayloadToHookEvents(raw: unknown, context: NativePayloadContext): HookEvent[] {
  const events: HookEvent[] = [];
  const adapted = adaptNativeHookPayload(context.agent_type, raw);

  if (adapted.status && adapted.task_name) {
    events.push({
      ...context,
      type: "session_status",
      status: adapted.status,
      task_name: adapted.task_name,
    });
  }

  for (const label of adapted.activity_tail ?? []) {
    events.push({ ...context, type: "activity_event", label });
  }

  if (hasAdapterUsage(adapted)) {
    events.push({
      ...context,
      type: "usage_snapshot",
      total_tokens: adapted.tokens,
      input_tokens: adapted.input_tokens,
      output_tokens: adapted.output_tokens,
      cached_input_tokens: adapted.cache_read_tokens,
      cache_write_tokens: adapted.cache_write_tokens,
      turns: adapted.turns,
      context_percent: adapted.context_percent,
    });
  }

  const workflow = workflowEventFromRaw(adapted.hook_event, context);
  if (workflow) {
    events.push(workflow);
  }

  events.push({ ...context, type: "unknown", raw });
  return events;
}

function workflowEventFromRaw(
  rawEvent: string | undefined,
  base: Omit<HookEventBase, "type">,
): WorkflowEvent | undefined {
  if (!rawEvent) return undefined;
  const eventName = rawEvent.trim();
  if (!eventName) return undefined;
  const mapping = mapHookEvent(base.agent_type, eventName);
  if (mapping.mapping_type === "unmapped" || mapping.mapping_type === "unavailable") return undefined;
  return {
    ...base,
    type: "workflow_event",
    raw_event: eventName,
    canonical_stage_id: mapping.canonical_stage_id,
    canonical_category: mapping.canonical_category,
    canonical_direction: mapping.canonical_direction,
    mapping_type: mapping.mapping_type,
    confidence: mapping.confidence,
    notes: mapping.notes || undefined,
  };
}

function eventBase(snapshot: SessionSnapshotInput, timestamp: number): Omit<HookEventBase, "type"> {
  return {
    agent_type: snapshot.session_type,
    session_id: snapshot.session_id,
    project: snapshot.project,
    project_path: snapshot.project_path,
    timestamp,
    source: snapshot.source ?? "hook",
  };
}

function hasUsage(snapshot: SessionSnapshotInput): boolean {
  return snapshot.tokens !== undefined ||
    snapshot.input_tokens !== undefined ||
    snapshot.output_tokens !== undefined ||
    snapshot.cache_read_tokens !== undefined ||
    snapshot.cache_write_tokens !== undefined ||
    snapshot.turns !== undefined ||
    snapshot.context_percent !== undefined;
}

function hasAdapterUsage(adapted: HookAdapterResult): boolean {
  return adapted.tokens !== undefined ||
    adapted.input_tokens !== undefined ||
    adapted.output_tokens !== undefined ||
    adapted.cache_read_tokens !== undefined ||
    adapted.cache_write_tokens !== undefined ||
    adapted.turns !== undefined ||
    adapted.context_percent !== undefined;
}
