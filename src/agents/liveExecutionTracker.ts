import type { CollectedAgents } from "./agentCollector.js";
import type { SessionPayload } from "../shared/types.js";
import type { ExecutionPhase, ExecutionSnapshot, ExecutionSpan, NativeExecutionEvent, NativePhase } from "../shared/executionTrace.js";

interface Observation {
  since: number; revision: number; supported: boolean; unsupported: boolean;
  watermarks: Map<string, number>;
  lanes: Map<string, ExecutionSnapshot["lanes"][number]>;
  phases: Map<string, ExecutionPhase>; spans: Map<string, ExecutionSpan>; notes: Set<string>;
  planIds: Map<string, Set<string>>;
  spanScopes: Map<string, string>;
}
const key = (...parts: string[]) => JSON.stringify(parts);

/** Incremental, receiver-owned observation. Initial log history is a baseline only. */
export class LiveExecutionTracker {
  private readonly sessions = new Map<string, Observation>();
  constructor(private readonly stream: string) {}

  observe(collected: Pick<CollectedAgents, "agents" | "details"> & Partial<Pick<CollectedAgents, "coverage">>, now: number, sessions?: readonly SessionPayload[]): void {
    const ids = new Set(sessions?.map(s => s.session_id) ?? collected.agents.map(a => a.identity.session_id));
    for (const id of this.sessions.keys()) if (!ids.has(id)) this.sessions.delete(id);
    const created = new Set<string>();
    for (const id of ids) if (!this.sessions.has(id)) {
      this.sessions.set(id, { since: now, revision: 0, supported: false, unsupported: false, watermarks: new Map(), lanes: new Map(), phases: new Map(), spans: new Map(), notes: new Set(), planIds: new Map(), spanScopes: new Map() });
      created.add(id);
    }
    for (const id of ids) this.sessions.get(id)!.unsupported = collected.coverage?.[id] === "unsupported";
    const current = new Set(collected.agents.map(agent => agent.agent_id));
    const terminal = new Set(collected.agents.filter(agent => ["completed", "cancelled", "failed"].includes(agent.lifecycle)).map(agent => agent.agent_id));
    for (const agent of collected.agents) {
      const root = this.sessions.get(agent.identity.session_id)!;
      if (!root.lanes.has(agent.agent_id) && root.lanes.size >= 128) { root.notes.add("Only 128 observed agent lanes are retained for this session."); continue; }
      root.lanes.set(agent.agent_id, { agent_id: agent.agent_id, label: agent.name, status: agent.status });
    }
    // Lifecycle records are emitted by a parent but refer to a native child.
    // Establish every retained lane before reading any parent's event stream.
    for (const agent of collected.agents) {
      const root = this.sessions.get(agent.identity.session_id)!;
      if (!root.lanes.has(agent.agent_id)) continue;
      const source = collected.details.get(agent.agent_id)?.execution;
      if (!source) continue;
      root.supported = true;
      if (source.truncated_before) root.notes.add("The native source has a retained-window boundary; missing starts remain unknown.");
      for (const note of source.notes ?? []) if (typeof note === "string" && note.length <= 2000 && root.notes.size < 32) root.notes.add(note);
      const groups = new Map<string, NativeExecutionEvent[]>([[agent.agent_id, []]]);
      for (const event of source.events) {
        if (event.cursor_scope !== undefined && (typeof event.cursor_scope !== "string" || event.cursor_scope.length > 256)) continue;
        const cursor = event.cursor_scope ? key(agent.agent_id, event.cursor_scope) : agent.agent_id;
        if (!groups.has(cursor)) groups.set(cursor, []);
        groups.get(cursor)!.push(event);
      }
      for (const [cursor, events] of groups) {
        const previous = root.watermarks.get(cursor), max = Math.max(previous ?? -1, ...events.map(e => e.sequence));
        const active = new Set(source.initial_active_event_ids ?? []);
        for (const event of events) {
          const resume = (created.has(agent.identity.session_id) || previous === undefined) && event.at !== null && active.has(event.event_id);
          if (!resume && (created.has(agent.identity.session_id) || (previous !== undefined && event.sequence <= previous)
            || (event.at !== null && event.at < root.since) || (previous === undefined && event.at === null))) continue;
          if (resume) root.notes.add("Resumed native operations that were still active when observation began.");
          this.ingest(root, agent.agent_id, event); root.revision++;
        }
        root.watermarks.set(cursor, max);
      }
      for (const scope of source.closed_scopes ?? []) for (const span of root.spans.values()) if (span.agent_id === agent.agent_id && span.state === "open" && root.spanScopes.get(span.span_id) === scope) {
        span.state = "unknown"; root.revision++;
        root.notes.add("The native event capture ended before a wait completion was observed. Its end time remains unknown.");
      }
    }
    for (const root of this.sessions.values()) for (const lane of root.lanes.values()) {
      if (current.has(lane.agent_id) && lane.status !== "unknown" && !terminal.has(lane.agent_id)) continue;
      lane.status = "unknown";
      for (const span of root.spans.values()) if (span.agent_id === lane.agent_id && span.state === "open") {
        span.state = "unknown"; root.revision++;
        root.notes.add("An agent stopped or is no longer reliably observed. Its unfinished intervals have no confirmed end.");
      }
    }
    while (this.sessions.size > 128) this.sessions.delete(this.sessions.keys().next().value!);
  }

  private phase(root: Observation, agent: string, native: NativePhase, at: number | null): void {
    const id = key(agent, native.id), existing = root.phases.get(id);
    if (!existing && root.phases.size >= 128) { root.notes.add("Phase limit reached; only the first 128 observed phases are shown."); return; }
    const phase = existing ?? { phase_id: id, agent_id: agent, label: native.label || `Task ${native.id}`, state: "unknown" as const, declared_at: at, started_at: null, ended_at: null, depends_on: [] };
    if (native.label) phase.label = native.label;
    if (native.state) {
      if (native.state === "in_progress" && phase.state !== "in_progress") { phase.started_at = at; phase.ended_at = null; }
      if (["completed", "failed", "cancelled"].includes(native.state) && native.state !== phase.state) phase.ended_at = at;
      phase.state = native.state;
    }
    if (native.depends_on) phase.depends_on = [...new Set([...phase.depends_on, ...native.depends_on.map(dep => key(agent, dep))])].slice(0, 64);
    root.phases.set(id, phase);
  }

  private ingest(root: Observation, agent: string, event: NativeExecutionEvent): void {
    if (event.kind === "phase" && event.phase) { this.phase(root, agent, event.phase, event.at); return; }
    if (event.kind === "plan" && event.phases) {
      const ids = new Set(event.phases.map(phase => key(agent, phase.id)));
      for (const old of root.planIds.get(agent) ?? []) if (!ids.has(old)) root.phases.delete(old);
      for (const phase of event.phases) {
        this.phase(root, agent, phase, event.at);
        const id = key(agent, phase.id), current = root.phases.get(id);
        if (current) { root.phases.delete(id); root.phases.set(id, current); }
      }
      root.planIds.set(agent, ids); return;
    }
    if (!event.call_id) return;
    const [kind, direction] = event.kind.split(".") as [ExecutionSpan["kind"], "start" | "end"];
    if (!["call", "run", "turn", "agent"].includes(kind)) return;
    if (kind === "agent") {
      if (!event.target_agent_id || !root.lanes.has(event.target_agent_id)) return;
      agent = event.target_agent_id;
    }
    const id = key(agent, kind, event.call_id);
    const span = root.spans.get(id) ?? { span_id: id, agent_id: agent, kind, label: event.label, started_at: null, ended_at: null, state: "open" as const };
    if (kind === "call" && (event.wait_for_agent_ids || event.wait_result_agent_ids)) {
      let dropped = 0;
      for (const field of ["wait_for_agent_ids", "wait_result_agent_ids"] as const) if (event[field]) {
        span[field] = [...new Set(event[field]!.filter(id => id !== agent && root.lanes.has(id)))].slice(0, 128);
        dropped += event[field]!.length - span[field]!.length;
      }
      span.unresolved_wait_targets = Math.min(128, (event.unresolved_wait_targets ?? 0) + dropped);
    }
    if (event.label && event.label !== "Tool") span.label = event.label;
    if (direction === "start") span.started_at = event.at;
    else { span.ended_at = event.at; span.state = event.outcome || "completed"; }
    if (span.started_at !== null && span.ended_at !== null && span.ended_at < span.started_at) {
      span.ended_at = null; span.state = "unknown";
      root.notes.add("A native end preceded its start; its duration is not drawn.");
    }
    root.spans.set(id, span);
    if (event.cursor_scope) root.spanScopes.set(id, event.cursor_scope);
    if (root.spans.size > 512) { const oldest = root.spans.keys().next().value!; root.spans.delete(oldest); root.spanScopes.delete(oldest); root.notes.add("Only the latest 512 observed spans are retained."); }
  }

  view(sessionId: string, now: number): ExecutionSnapshot | null {
    const root = this.sessions.get(sessionId); if (!root) return null;
    const spans = [...root.spans.values()];
    const peak = (kind: ExecutionSpan["kind"]): number => {
      const timed = spans.filter(s => s.kind === kind && s.started_at !== null && (s.ended_at !== null || s.state === "open"));
      const boundaries = timed.filter(s => (s.ended_at ?? now) > s.started_at!).flatMap(s => [[s.started_at!, 1], [s.ended_at ?? now, -1]]);
      boundaries.sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]!);
      let count = 0, max = timed.length ? 1 : 0;
      for (const [, delta] of boundaries) { count += delta!; max = Math.max(max, count); }
      return max;
    };
    return structuredClone({
      schema_version: "sessionbar.execution.v1", kind: "execution", stream_id: this.stream,
      revision: root.revision, session_id: sessionId, observed_since: root.since, observed_at: Math.max(root.since, now),
      availability: root.supported ? "available" : root.unsupported ? "unsupported" : "unknown", lanes: [...root.lanes.values()],
      phases: [...root.phases.values()], spans, max_concurrent_calls: peak("call"),
      max_parallel_execution: spans.some(s => s.kind === "run" && s.started_at !== null && (s.ended_at !== null || s.state === "open")) ? peak("run") : null,
      max_parallel_agents: spans.some(s => s.kind === "agent" && s.started_at !== null && (s.ended_at !== null || s.state === "open")) ? peak("agent") : null,
      notes: [...root.notes].slice(0, 32),
    });
  }
}
