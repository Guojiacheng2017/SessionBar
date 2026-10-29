import type { ExecutionSnapshot, ExecutionSpan } from "../shared/executionTrace.js";
import { reportedWorkflowGraph, type FlowGraph } from "../shared/workflowGraph.js";
import { escapeHtml } from "./webComponents.js";
import { workflowGraphMarkup } from "./workflowGraphView.js";

const clock = (at: number | null): string => at === null ? "Not reported" : new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const duration = (start: number, end: number): string => `${((end - start) / 1000).toFixed(1)}s`;
const typeName = (kind: ExecutionSpan["kind"]) => kind === "run" ? "Execution" : kind === "agent" ? "Agent lifecycle" : kind === "turn" ? "Turn" : "Calls";
const phaseLabel = (state: string) => ({ in_progress: "In progress", pending: "Pending", completed: "Completed", failed: "Failed", cancelled: "Cancelled", deleted: "Deleted", unknown: "Unknown" }[state] || state);
const planningCall = (span: ExecutionSpan) => span.kind === "call" && ["TaskCreate", "TaskUpdate", "TodoWrite", "update_plan"].includes(span.label);
const nativeWait = (span: ExecutionSpan) => span.label === "Native wait" || span.wait_for_agent_ids !== undefined || span.wait_result_agent_ids !== undefined;

function phaseGraph(view: ExecutionSnapshot): FlowGraph | null {
  if (!view.phases.length) return null;
  const graph = reportedWorkflowGraph({
    nodes: view.phases.map(phase => ({ id: phase.phase_id, label: phase.label, status: phaseLabel(phase.state) })),
    edges: view.phases.flatMap(phase => phase.depends_on.map(from => ({ from, to: phase.phase_id }))),
  });
  graph.nodes.forEach(node => { node.subtitle = view.lanes.find(lane => lane.agent_id === view.phases.find(phase => phase.phase_id === node.id)!.agent_id)?.label || "Reported task"; });
  return graph;
}

function waitGraph(view: ExecutionSnapshot): FlowGraph | null {
  const lanes = new Map(view.lanes.map(lane => [lane.agent_id, lane]));
  const requested = view.spans.filter(span => span.kind === "call" && span.wait_for_agent_ids?.some(id => lanes.has(id)));
  const fullRequest = requested.length > 0;
  const all = fullRequest ? requested : view.spans.filter(span => span.kind === "call" && span.wait_result_agent_ids?.some(id => lanes.has(id)));
  if (!all.length) return null;
  const references = (span: ExecutionSpan) => (fullRequest ? span.wait_for_agent_ids : span.wait_result_agent_ids) ?? [];
  const waits = all.slice(-16), ids = [...new Set(waits.flatMap(span => references(span).filter(id => lanes.has(id))))];
  const activityStatus = (id: string): string => {
    const latest = view.spans.filter(span => span.kind === "agent" && span.agent_id === id).sort((a, b) => (b.started_at ?? b.ended_at ?? 0) - (a.started_at ?? a.ended_at ?? 0))[0];
    return latest ? latest.state === "open" ? "Working" : phaseLabel(latest.state) : phaseLabel(lanes.get(id)!.status);
  };
  const graph = reportedWorkflowGraph({
    nodes: [
      ...ids.map(id => ({ id: `agent:${id}`, label: lanes.get(id)!.label, status: activityStatus(id) })),
      ...waits.map((span, index) => ({ id: `wait:${span.span_id}`, label: `Wait ${index + 1}`, status: span.state === "open" ? "Waiting" : span.state === "completed" ? "Returned" : phaseLabel(span.state) })),
    ],
    edges: waits.flatMap(span => references(span).filter(id => lanes.has(id)).map(id => ({ from: `agent:${id}`, to: `wait:${span.span_id}`, label: fullRequest ? "wait target" : "returned result" }))),
  });
  graph.evidence = fullRequest ? "native_wait" : "native_wait_result";
  graph.nodes.forEach(node => {
    const span = waits.find(span => node.id === `wait:${span.span_id}`);
    node.subtitle = span ? `${clock(span.started_at)} → ${clock(span.ended_at)}` : "Observed agent activity";
  });
  graph.notes.push(fullRequest ? "Arrows show explicit wait targets, not business stage prerequisites. A returned wait does not prove all targets completed."
    : "Only returned result references are available; the full request target set is unknown. These are not business stage prerequisites.");
  const unresolved = waits.reduce((sum, span) => sum + (span.unresolved_wait_targets ?? 0), 0);
  if (unresolved) graph.notes.push(`${unresolved} unresolved native wait target references are omitted.`);
  if (all.length > waits.length) graph.notes.push(`Showing the latest ${waits.length} of ${all.length} observed native waits.`);
  return graph;
}

function ganttMarkup(view: ExecutionSnapshot): string {
  const timed = view.spans.filter(span => span.started_at !== null && (span.ended_at !== null || span.state === "open"));
  const phaseTimed = view.phases.filter(phase => phase.started_at !== null && (phase.ended_at !== null || phase.state === "in_progress"));
  const active = timed.some(span => span.state === "open") || phaseTimed.some(phase => phase.state === "in_progress");
  const ends = [...timed.map(span => span.ended_at ?? view.observed_at), ...phaseTimed.map(phase => phase.ended_at ?? view.observed_at)];
  const end = active || !ends.length ? view.observed_at : Math.max(view.observed_since, ...ends);
  const starts = [...timed.map(span => span.started_at!), ...phaseTimed.map(phase => phase.started_at!)];
  const start = Math.max(view.observed_since, end - 120_000, starts.length ? Math.min(...starts) : view.observed_since);
  const range = Math.max(1000, end - start);
  const percent = (at: number) => Math.max(0, Math.min(100, (at - start) / range * 100));
  const geometry = (from: number, until: number) => `left:${percent(from).toFixed(3)}%;width:${Math.max(.3, percent(until) - percent(from)).toFixed(3)}%`;
  const label = (name: string, detail: string) => `<div class="execution-lane-label"><strong title="${escapeHtml(name)}">${escapeHtml(name)}</strong><span>${escapeHtml(detail)}</span></div>`;
  const phaseRows = view.phases.map(phase => {
    const running = phase.state === "in_progress" && !["unknown", "lost"].includes(view.lanes.find(lane => lane.agent_id === phase.agent_id)?.status || "unknown");
    const until = phase.ended_at ?? (running ? end : null);
    let mark = `<span class="execution-untimed">${phase.started_at === null ? phase.state === "pending" ? "Not started" : "Start not observed" : "End not observed"}</span>`;
    if (phase.started_at !== null && until !== null) {
      mark = until < start ? '<span class="execution-untimed">Before this window</span>' : `<span class="execution-span execution-phase-span" data-phase-interval="${escapeHtml(phase.phase_id)}" data-phase-state="${phase.state}" style="${geometry(phase.started_at, until)};top:8px" title="${escapeHtml(`${phase.label} · ${clock(phase.started_at)} → ${phase.ended_at === null ? "end not observed" : clock(phase.ended_at)}`)}"><span>${escapeHtml(phase.label)}</span></span>`;
    }
    const owner = view.lanes.length > 1 ? ` · ${view.lanes.find(lane => lane.agent_id === phase.agent_id)?.label || "Agent"}` : "";
    return `<div class="execution-lane execution-phase-lane" data-phase-state="${phase.state}">${label(phase.label, phaseLabel(phase.state) + owner)}<div class="execution-lane-track">${mark}</div></div>`;
  }).join("");
  const groups = new Map<string, ExecutionSpan[]>();
  for (const span of timed) {
    if ((span.ended_at ?? end) < start || span.started_at! > end) continue;
    const id = JSON.stringify([span.agent_id, nativeWait(span) ? "wait" : planningCall(span) ? "plan" : span.kind]);
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id)!.push(span);
  }
  const renderGroup = (spans: ExecutionSpan[]): string => {
    spans.sort((a, b) => a.started_at! - b.started_at! || a.span_id.localeCompare(b.span_id));
    const trackEnds: number[] = [];
    const bars = spans.map(span => {
      const from = Math.max(start, span.started_at!), until = Math.max(from, span.ended_at ?? end);
      let track = trackEnds.findIndex(last => last <= from);
      if (track < 0) track = trackEnds.length;
      trackEnds[track] = until;
      const text = `${span.label} · ${typeName(span.kind)} · ${clock(span.started_at)} → ${span.ended_at === null ? "end not observed" : clock(span.ended_at)} · ${duration(from, until)}`;
      return `<span class="execution-span" data-execution-span="${escapeHtml(span.span_id)}" data-span-kind="${span.kind}" data-span-role="${nativeWait(span) ? "wait" : planningCall(span) ? "plan" : "work"}" data-span-state="${span.state}" style="${geometry(from, until)};top:${8 + track * 28}px" title="${escapeHtml(text)}"><span>${escapeHtml(span.label)}</span></span>`;
    }).join("");
    const first = spans[0]!, lane = view.lanes.find(item => item.agent_id === first.agent_id);
    return `<div class="execution-lane" style="min-height:${Math.max(44, trackEnds.length * 28 + 16)}px">${label(lane?.label || "Agent", nativeWait(first) ? "Native waits" : planningCall(first) ? "Plan updates" : typeName(first.kind))}<div class="execution-lane-track">${bars}</div></div>`;
  };
  const agentRows = [...groups.values()].filter(spans => spans[0]!.kind === "agent").map(renderGroup).join("");
  const runRows = [...groups.values()].filter(spans => spans[0]!.kind === "run").map(renderGroup).join("");
  const waitRows = [...groups.values()].filter(spans => nativeWait(spans[0]!)).map(renderGroup).join("");
  const rows = [...groups.values()].filter(spans => !["agent", "run"].includes(spans[0]!.kind) && !nativeWait(spans[0]!)).map(renderGroup).join("");
  const chart = phaseRows || rows || agentRows || runRows || waitRows ? `<div class="execution-timeline-scroll" tabindex="0" role="region" aria-label="Gantt timeline. Scroll to explore tasks and agents."><div class="execution-timeline"><div class="execution-axis"><span>Task / agent</span><div>${[0, .25, .5, .75, 1].map(part => `<time style="left:${part * 100}%">${clock(start + range * part)}</time>`).join("")}</div></div>${agentRows}${phaseRows}${runRows}${waitRows}${rows}</div></div>` : '<p class="execution-chart-empty">No new execution events since observation began. Previous log history is not replayed.</p>';
  return `<section class="execution-gantt"><div class="execution-chart-heading"><h4>Gantt</h4><span>≤2 min · dashed calls include waiting</span></div>${chart}</section>`;
}

/** Charts own the first viewport; raw observations stay in closed disclosures. */
export function executionTraceMarkup(view: ExecutionSnapshot | null, error: string | null = null, reportedGraph: FlowGraph | null = null): string {
  const phases = view ? phaseGraph(view) : null;
  const graph = reportedGraph?.kind === "workflow" ? reportedGraph : phases?.edges.length ? phases : view ? waitGraph(view) ?? phases : null;
  const observedAgents = view?.spans.some(span => span.kind === "agent");
  const missingGraph = observedAgents ? "No native task dependencies reported. Observed agent activity is shown in the Gantt timeline." : "No task graph reported yet. Phase order and agent parent links do not establish task dependencies.";
  const dag = graph ? workflowGraphMarkup(graph, `execution:${view?.session_id ?? "waiting"}:${graph.evidence ?? "tasks"}`, undefined, true)
    : `<section class="execution-dag execution-dag-empty"><div class="execution-chart-heading"><h4>Task DAG</h4></div><p class="execution-chart-empty">${missingGraph}</p></section>`;
  const heading = '<div class="execution-heading"><h4>Live execution</h4><span class="execution-live-label">Observed as it runs</span></div>';
  const key = view ? escapeHtml(JSON.stringify([view.session_id, view.stream_id])) : "waiting";
  const wrap = (body: string) => `<sessionbar-execution class="execution-view" data-execution-key="${key}">${heading}${body}</sessionbar-execution>`;
  if (!view || view.availability === "unsupported") {
    const message = error ? escapeHtml(error) : !view ? "Connecting to native execution observations…" : "Native live execution is not yet connected for this harness.";
    return wrap(`<section class="execution-gantt"><div class="execution-chart-heading"><h4>Gantt</h4></div><p class="execution-chart-empty">${message}</p></section>${dag}`);
  }
  const warning = error ? `<p class="workflow-note execution-stale" role="status">${escapeHtml(error)}</p>` : "";
  const phaseCount = view.phases.length ? `<b>${view.phases.filter(phase => phase.state === "completed").length}/${view.phases.length}</b> phases completed` : "No native phases reported";
  const counts = `<div class="execution-summary"><span>${phaseCount}</span>${view.max_parallel_agents != null ? `<span><b>${view.max_parallel_agents}</b> peak concurrent agents</span>` : ""}<span><b>${view.max_concurrent_calls}</b> peak concurrent calls</span><span>${view.max_parallel_execution === null ? "Tool execution timing is not yet available" : `<b>${view.max_parallel_execution}</b> observed execution overlap`}</span></div>`;
  const retained = view.spans.slice(-48).reverse();
  const intervals = retained.length ? `<details class="execution-interval-details"><summary>Tool use list · ${retained.length} of ${view.spans.length} intervals</summary><ol>${retained.map(span => `<li><div><strong>${escapeHtml(span.label)}</strong><span>${typeName(span.kind)} · ${escapeHtml(span.state)}</span></div><p>${span.started_at === null ? "Start not observed" : clock(span.started_at)} → ${span.ended_at === null ? "End not observed" : clock(span.ended_at)}${span.started_at !== null && span.ended_at !== null ? ` · ${duration(span.started_at, span.ended_at)}` : ""}</p></li>`).join("")}</ol></details>` : "";
  const interpretation = `<details class="execution-interpretation"><summary>Timing &amp; source</summary><p class="execution-observation">Watching since ${clock(view.observed_since)} · as of ${clock(view.observed_at)}${view.availability !== "available" ? " · source not observed yet" : ""}</p><p class="execution-semantics">Calls show dispatch → result, including queue, permission and hook time. Execution bars require explicit native start/end events. Agent lifecycle bars show confirmed launch → native completion notice, including model and tool time. Declared phase order alone does not establish dependencies.</p>${view.notes.map(note => `<p class="workflow-note">${escapeHtml(note)}</p>`).join("")}</details>`;
  return wrap(`${warning}${counts}${ganttMarkup(view)}${dag}${intervals}${interpretation}`);
}

interface ExecutionViewState { tools: boolean; source: boolean; left: number; top: number }
const states = new Map<string, ExecutionViewState>();

/** A live update keeps the user's disclosure and Gantt scroll choices. */
export function installExecutionViews(): void {
  if (customElements.get("sessionbar-execution")) return;
  class ExecutionView extends HTMLElement {
    private state: ExecutionViewState = { tools: false, source: false, left: 0, top: 0 };
    private frame = 0;
    private ready = false;
    connectedCallback(): void {
      this.frame = requestAnimationFrame(() => {
        if (!this.isConnected) return;
        this.state = { ...(states.get(this.dataset.executionKey!) ?? this.state) };
        const tools = this.querySelector<HTMLDetailsElement>(".execution-interval-details");
        const source = this.querySelector<HTMLDetailsElement>(".execution-interpretation");
        if (tools) tools.open = this.state.tools;
        if (source) source.open = this.state.source;
        const gantt = this.querySelector<HTMLElement>(".execution-timeline-scroll");
        if (gantt) { gantt.scrollLeft = this.state.left; gantt.scrollTop = this.state.top; }
        this.addEventListener("toggle", this.remember, true);
        gantt?.addEventListener("scroll", this.remember, { passive: true });
        this.ready = true;
      });
    }
    disconnectedCallback(): void {
      if (this.ready) this.save();
      this.ready = false;
      cancelAnimationFrame(this.frame);
      this.removeEventListener("toggle", this.remember, true);
      this.querySelector(".execution-timeline-scroll")?.removeEventListener("scroll", this.remember);
    }
    private save(): void {
      this.state.tools = this.querySelector<HTMLDetailsElement>(".execution-interval-details")?.open ?? this.state.tools;
      this.state.source = this.querySelector<HTMLDetailsElement>(".execution-interpretation")?.open ?? this.state.source;
      const key = this.dataset.executionKey!;
      states.delete(key); states.set(key, { ...this.state });
      if (states.size > 64) states.delete(states.keys().next().value!);
    }
    private remember = (): void => {
      const gantt = this.querySelector<HTMLElement>(".execution-timeline-scroll");
      if (gantt) { this.state.left = gantt.scrollLeft; this.state.top = gantt.scrollTop; }
      this.save();
    };
  }
  customElements.define("sessionbar-execution", ExecutionView);
}
