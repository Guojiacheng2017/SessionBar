import type { Snapshot } from "../shared/agentContract.js";
import type { SessionPayload } from "../shared/types.js";
import { groupWorkflowEvents, sessionWorkflowGraph, type FlowEvent } from "../shared/workflowGraph.js";
import { escapeHtml } from "./webComponents.js";
import type { ExecutionSnapshot } from "../shared/executionTrace.js";
import { executionTraceMarkup } from "./executionViews.js";

import { workflowGraphMarkup, type AvatarRenderer } from "./workflowGraphView.js";
export { workflowGraphMarkup } from "./workflowGraphView.js";

const stageName = (stage: string): string => {
  if (/permission|approval|ask/.test(stage)) return "Permission";
  if (/tool/.test(stage)) return "Tools";
  if (/turn|prompt|response/.test(stage)) return "Turns";
  if (/agent/.test(stage)) return "Agents";
  return "Other";
};
const clockLabel = (at: number | null): string => at === null ? "Time not reported" : new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

/** Point marks encode timestamps; no start/end matching is inferred from stage names. */
export function workflowHistoryMarkup(events: readonly FlowEvent[], key: string): string {
  const groups = groupWorkflowEvents(events);
  if (!groups.length) return '<p class="workflow-note">No workflow events in this retained view.</p>';
  const timed = events.filter(event => typeof event.occurredAt === "number" && Number.isFinite(event.occurredAt) && Math.abs(event.occurredAt) <= 8.64e15);
  let timeline = "";
  if (timed.length) {
    const times = timed.map(event => event.occurredAt!), start = Math.min(...times), end = Math.max(...times), range = end - start || 1;
    const lanes = [...new Set(timed.map(event => stageName(event.stage)))];
    const height = 42 + lanes.length * 32;
    const x = (at: number) => 90 + (at - start) / range * 404;
    const points = timed.map(event => `<circle data-timeline-point="" cx="${x(event.occurredAt!).toFixed(2)}" cy="${36 + lanes.indexOf(stageName(event.stage)) * 32}" r="4"><title>${escapeHtml(`${clockLabel(event.occurredAt)} · ${event.stage} · ${event.label}`)}</title></circle>`).join("");
    const ticks = [0, 0.5, 1].map(fraction => `<line x1="${90 + fraction * 404}" x2="${90 + fraction * 404}" y1="20" y2="${height - 12}"></line><text class="workflow-timeline-tick" x="${90 + fraction * 404}" y="12" text-anchor="${fraction === 0 ? "start" : fraction === 1 ? "end" : "middle"}">${escapeHtml(clockLabel(start + fraction * (end - start)))}</text>`).join("");
    timeline = `<div class="workflow-timeline-scroll"><svg class="workflow-timeline" viewBox="0 0 514 ${height}" role="img" aria-label="Observed event timestamps by category. Points indicate observations, not durations."><title>Retained observations · ${escapeHtml(clockLabel(start))} to ${escapeHtml(clockLabel(end))}</title>${ticks}${lanes.map((lane, i) => `<text x="0" y="${40 + i * 32}">${lane}</text><path d="M 90 ${36 + i * 32} H 494"></path>`).join("")}${points}</svg></div>`;
  }
  const rows = groups.map((group, i) => `<li class="workflow-event" data-event-id="${escapeHtml(group.id)}"><span class="workflow-event-index">${String(i + 1).padStart(2, "0")}</span><div><div class="workflow-event-title"><strong>${escapeHtml(group.label)}</strong>${group.count > 1 ? `<span class="workflow-repeat">× ${group.count}</span>` : ""}</div><span class="workflow-event-stage">${escapeHtml(group.stage)}${group.source ? ` · ${escapeHtml(group.source)}` : ""}</span></div><span class="workflow-event-time">${escapeHtml(clockLabel(group.firstAt))}${group.lastAt !== group.firstAt ? `<br>${escapeHtml(clockLabel(group.lastAt))}` : ""}</span></li>`).join("");
  return `<div class="workflow-history" data-workflow-history="${escapeHtml(key)}"><p class="workflow-caption">${events.length} retained events · source order. Consecutive repeats are grouped. Task dependencies are not reported by this history.</p>${timeline}<ol class="workflow-events">${rows}</ol></div>`;
}

export function sessionFlowMarkup(session: SessionPayload, snapshot: Snapshot | null, renderAvatar?: AvatarRenderer, execution?: ExecutionSnapshot | null): string {
  const graph = sessionWorkflowGraph(session, snapshot);
  const events: FlowEvent[] = (session.workflow_events ?? []).map((event, i) => ({ id: `session-event-${i}`, stage: event.canonical_stage_id, label: event.raw_event, occurredAt: event.timestamp, source: event.source }));
  const history = events.length ? workflowHistoryMarkup(events, `session:${session.session_id}`) : "";
  const live = execution !== undefined;
  const graphMarkup = graph && (!live || graph.kind === "agents") ? workflowGraphMarkup(graph, `session:${session.session_id}`, renderAvatar) : "";
  return `<div class="detail-tab-content">${live ? `<div data-execution-session="${escapeHtml(session.session_id)}">${executionTraceMarkup(execution ?? null, null, graph)}</div>` : ""}${graphMarkup ? live ? `<details class="execution-topology"><summary>Agent topology</summary>${graphMarkup}</details>` : graphMarkup : ""}${history ? graph || live
    ? `<details class="workflow-history-disclosure"><summary>${live ? "Retained hook events" : "Observed events"} (${events.length})</summary>${history}</details>`
    : `<section class="workflow-section"><h4>Observed events</h4><p class="workflow-note">A dependency graph is not available for this session.</p>${history}</section>`
    : graph || live ? "" : '<section class="workflow-section"><h4>Flow</h4><p class="workflow-note">No workflow data. This session has not reported a structured flow, sub-agents or workflow events.</p></section>'}</div>`;
}

interface GraphViewState { scale: number; left: number; top: number; selected: string | null; connections: boolean }
const views = new Map<string, GraphViewState>();

/** Local viewport state survives SSE rerenders. No global wheel/touch handlers. */
export function installWorkflowCanvases(): void {
  if (customElements.get("sessionbar-flow")) return;
  let nextInstance = 0;
  class WorkflowCanvas extends HTMLElement {
    private state: GraphViewState = { scale: 1, left: 0, top: 0, selected: null, connections: false };
    private frame = 0;
    private ready = false;
    private get viewport(): HTMLElement { return this.querySelector<HTMLElement>(".workflow-viewport")!; }
    private get width(): number { return Number(this.dataset.flowWidth) || 256; }
    private get height(): number { return Number(this.dataset.flowHeight) || 160; }

    connectedCallback(): void {
      // Parsed custom elements can connect before their children have been inserted.
      this.frame = requestAnimationFrame(() => {
        if (!this.isConnected) return;
        // Replacement connection callbacks can precede the old element's disconnection.
        // Read only after that old element has saved its last disclosure state.
        const saved = views.get(this.dataset.flowKey!);
        this.state = { ...(saved ?? this.state) };
        if (!saved && this.hasAttribute("data-flow-fit")) {
          const fitHeight = this.height > this.viewport.clientHeight ? (this.viewport.clientHeight - 4) / this.height : 1;
          this.state.scale = Math.max(.85, Math.min(1, (this.viewport.clientWidth - 12) / this.width, fitHeight));
        }
        this.scale(this.state.scale, false);
        this.viewport.scrollLeft = this.state.left;
        this.viewport.scrollTop = this.state.top;
        const details = this.querySelector("details");
        if (details) details.open = this.state.connections;
        if (this.state.selected) this.inspect(this.state.selected);
        const marker = this.querySelector("marker");
        if (marker) {
          marker.id = `sessionbar-flow-arrow-${++nextInstance}`;
          this.querySelectorAll("[data-flow-edge]").forEach(edge => edge.setAttribute("marker-end", `url(#${marker.id})`));
        }
        this.addEventListener("click", this.handleClick);
        this.viewport.addEventListener("scroll", this.remember, { passive: true });
        details?.addEventListener("toggle", this.remember);
        this.ready = true;
      });
    }
    disconnectedCallback(): void {
      if (this.ready) {
        // A detached scroller has already lost its offsets; retain the observed offsets.
        this.state.connections = this.querySelector("details")?.open ?? this.state.connections;
        this.save();
      }
      this.ready = false;
      cancelAnimationFrame(this.frame);
      this.removeEventListener("click", this.handleClick);
      this.querySelector(".workflow-viewport")?.removeEventListener("scroll", this.remember);
      this.querySelector("details")?.removeEventListener("toggle", this.remember);
    }
    private remember = (): void => {
      this.state.left = this.viewport.scrollLeft;
      this.state.top = this.viewport.scrollTop;
      this.state.connections = this.querySelector("details")?.open ?? false;
      this.save();
    };
    private save(): void {
      const key = this.dataset.flowKey!;
      views.delete(key); views.set(key, { ...this.state });
      if (views.size > 64) views.delete(views.keys().next().value!);
    }
    private scale(value: number, center = true): void {
      const viewport = this.viewport, previous = this.state.scale;
      const scale = Math.min(2, Math.max(0.005, value));
      const x = (viewport.scrollLeft + viewport.clientWidth / 2) / previous;
      const y = (viewport.scrollTop + viewport.clientHeight / 2) / previous;
      this.state.scale = scale;
      const canvas = this.querySelector<HTMLElement>(".workflow-canvas")!, sizer = this.querySelector<HTMLElement>(".workflow-sizer")!;
      canvas.style.transform = `scale(${scale})`;
      sizer.style.width = `${this.width * scale}px`;
      sizer.style.height = `${this.height * scale}px`;
      this.querySelector("[data-flow-zoom]")!.textContent = `${Math.round(scale * 100)}%`;
      if (center) { viewport.scrollLeft = x * scale - viewport.clientWidth / 2; viewport.scrollTop = y * scale - viewport.clientHeight / 2; }
      this.querySelector<HTMLButtonElement>('[data-flow-action="out"]')!.disabled = scale <= 0.2;
      this.querySelector<HTMLButtonElement>('[data-flow-action="in"]')!.disabled = scale >= 2;
    }
    private inspect(id: string): void {
      const nodes = [...this.querySelectorAll<HTMLButtonElement>("[data-flow-node]")];
      const node = nodes.find(item => item.dataset.flowNode === id);
      if (!node) return;
      nodes.forEach(item => item.setAttribute("aria-pressed", String(item === node)));
      const template = this.querySelector<HTMLTemplateElement>(`template[data-flow-inspector="${node.dataset.flowIndex}"]`)!;
      const selection = this.querySelector<HTMLElement>("[data-flow-selection]")!;
      selection.replaceChildren(template.content.cloneNode(true)); selection.hidden = false;
      this.state.selected = id;
    }
    private handleClick = (event: Event): void => {
      const target = event.target as Element;
      const action = target.closest<HTMLElement>("[data-flow-action]")?.dataset.flowAction;
      if (action) {
        if (action === "in") this.scale(this.state.scale + 0.2);
        if (action === "out") this.scale(Math.max(0.2, this.state.scale - 0.2));
        if (action === "reset") { this.scale(1, false); this.viewport.scrollTo(0, 0); }
        if (action === "fit") { this.scale(Math.min(1, (this.viewport.clientWidth - 12) / this.width, (this.viewport.clientHeight - 12) / this.height), false); this.viewport.scrollTo(0, 0); }
      }
      const node = target.closest<HTMLElement>("[data-flow-node]");
      if (node?.dataset.flowNode) this.inspect(node.dataset.flowNode);
      this.remember();
    };
  }
  customElements.define("sessionbar-flow", WorkflowCanvas);
}
