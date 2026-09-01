import type { HookEvent, UsageSnapshotEvent } from "../hooks/hookEvents.js";
import type { SessionAgentSignal, SessionPayload, SessionUnknownEvent, SessionWorkflowEvent } from "../shared/types.js";

const MAX_BUFFERED_EVENTS = 20;

export function reduceSessionEvents(prev: SessionPayload | undefined, events: readonly HookEvent[]): SessionPayload {
  let session = prev ? cloneSession(prev) : undefined;
  let previousUsage = usagePoint(prev);

  for (const event of events) {
    session = ensureSession(session, event);
    if (event.type === "session_status") {
      session.status = event.status;
      session.task_name = event.task_name;
      session.progress = event.progress;
      session.timestamp = event.timestamp;
      session.session_name = event.session_name || session.session_name;
      session.project = event.project || session.project;
      session.project_path = event.project_path || session.project_path;
    } else if (event.type === "activity_event") {
      session.activity_tail = [...(session.activity_tail ?? []), event.label].slice(-8);
      session.timestamp = event.timestamp;
    } else if (event.type === "usage_snapshot") {
      const nextUsage = applyUsageSnapshot(session, event, previousUsage);
      previousUsage = nextUsage;
    } else if (event.type === "flow_event") {
      session.flow = event.flow ?? session.flow;
      session.timestamp = event.timestamp;
    } else if (event.type === "agent_signal") {
      const nextSignal: SessionAgentSignal = {
        signal: event.signal,
        timestamp: event.timestamp,
        source: event.source,
        scope: event.scope,
        kind: event.kind,
        used: event.used,
        remaining: event.remaining,
        limit: event.limit,
        unit: event.unit,
        status: event.status,
        error_code: event.error_code,
        balance: event.balance,
        balance_unit: event.balance_unit,
        used_percent: event.used_percent,
        reset_at: event.reset_at,
        label: event.label,
      };
      const signalKey = agentSignalKey(nextSignal);
      session.agent_signals = [
        ...(session.agent_signals ?? []).filter(signal => agentSignalKey(signal) !== signalKey),
        nextSignal,
      ].slice(-MAX_BUFFERED_EVENTS);
      session.timestamp = event.timestamp;
    } else if (event.type === "workflow_event") {
      const nextWorkflow: SessionWorkflowEvent = {
        timestamp: event.timestamp,
        source: event.source,
        raw_event: event.raw_event,
        canonical_stage_id: event.canonical_stage_id,
        canonical_category: event.canonical_category,
        canonical_direction: event.canonical_direction,
        mapping_type: event.mapping_type,
        confidence: event.confidence,
        notes: event.notes,
      };
      session.workflow_events = [...(session.workflow_events ?? []), nextWorkflow].slice(-MAX_BUFFERED_EVENTS);
      session.timestamp = event.timestamp;
    } else if (event.type === "unknown") {
      const nextUnknown: SessionUnknownEvent = {
        timestamp: event.timestamp,
        source: event.source,
        raw: event.raw,
      };
      session.unknown_events = [...(session.unknown_events ?? []), nextUnknown].slice(-MAX_BUFFERED_EVENTS);
      session.timestamp = event.timestamp;
    }
  }

  if (!session) throw new Error("Cannot reduce an empty event list without previous session state");
  return session;
}

function ensureSession(session: SessionPayload | undefined, event: HookEvent): SessionPayload {
  if (session) return session;
  return {
    session_id: event.session_id ?? `${event.agent_type}-unknown`,
    session_type: event.agent_type,
    session_name: event.session_name,
    source: event.source === "codex_jsonl" ? "codex_jsonl" : "hook",
    status: "working",
    task_name: "Working",
    timestamp: event.timestamp,
    project: event.project,
    project_path: event.project_path,
  };
}

function cloneSession(session: SessionPayload): SessionPayload {
  return {
    ...session,
    activity_tail: session.activity_tail ? [...session.activity_tail] : undefined,
    agent_signals: session.agent_signals ? [...session.agent_signals] : undefined,
    workflow_events: session.workflow_events ? [...session.workflow_events] : undefined,
    unknown_events: session.unknown_events ? [...session.unknown_events] : undefined,
  };
}

function applyUsageSnapshot(
  session: SessionPayload,
  event: UsageSnapshotEvent,
  previousUsage: ReturnType<typeof usagePoint>,
): ReturnType<typeof usagePoint> {
  session.tokens = event.total_tokens ?? session.tokens;
  session.input_tokens = event.input_tokens ?? session.input_tokens;
  session.output_tokens = event.output_tokens ?? session.output_tokens;
  session.cache_read_tokens = event.cached_input_tokens ?? session.cache_read_tokens;
  session.cache_write_tokens = event.cache_write_tokens ?? session.cache_write_tokens;
  session.turns = event.turns ?? session.turns;
  session.context_percent = contextPercent(event) ?? session.context_percent;

  if (event.total_tokens !== undefined && previousUsage) {
    const tokenDelta = event.total_tokens - previousUsage.tokens;
    const msDelta = event.timestamp - previousUsage.timestamp;
    if (tokenDelta >= 0 && msDelta > 0) {
      session.token_rate = Math.round((tokenDelta / msDelta) * 60_000);
    }
  }

  session.timestamp = event.timestamp;
  if (event.total_tokens === undefined) return previousUsage;
  return { tokens: event.total_tokens, timestamp: event.timestamp };
}

function usagePoint(session: SessionPayload | undefined): { tokens: number; timestamp: number } | undefined {
  if (!session || session.tokens === undefined) return undefined;
  return { tokens: session.tokens, timestamp: session.timestamp };
}

function agentSignalKey(signal: Pick<SessionAgentSignal, "signal" | "source" | "scope" | "kind">): string {
  return `${signal.source ?? ""}:${signal.scope ?? ""}:${signal.kind ?? ""}:${signal.signal}`;
}

function contextPercent(event: UsageSnapshotEvent): number | undefined {
  if (event.context_percent !== undefined) return event.context_percent;
  if (event.total_tokens === undefined || !event.model_context_window) return undefined;
  return Math.max(0, Math.min(100, (event.total_tokens / event.model_context_window) * 100));
}
