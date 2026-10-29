import { acceptSnapshot, assertAgentDetail, assertSnapshot, type AgentDetail, type AgentSummary, type Snapshot } from "../shared/agentContract.js";
import { mergeAgentDetailPage, type AgentResource } from "./agentViews.js";

export interface AgentSelection {
  agent: AgentSummary;
  snapshot: Snapshot;
  detail: AgentDetail | null;
  loading: boolean;
  error: string | null;
  cursors: Record<AgentResource, string | null>;
}

/** This optional read client never owns or modifies the v1 session list. */
export class AgentClient {
  snapshot: Snapshot | null = null;
  selected: AgentSelection | null = null;
  private snapshotRequest: Promise<void> | null = null;
  private snapshotController: AbortController | null = null;
  private detailController: AbortController | null = null;
  private stopped = false;

  constructor(private request: typeof fetch, private onChange: () => void) {}

  refreshSnapshot(): Promise<void> {
    if (this.snapshotRequest) return this.snapshotRequest;
    if (this.stopped) return Promise.resolve();
    const controller = new AbortController();
    this.snapshotController = controller;
    const timeout = setTimeout(() => controller.abort(), 10000);
    this.snapshotRequest = (async () => {
      try {
        const response = await this.request("/agents/live", { headers: { Accept: "application/json" }, signal: controller.signal });
        if (!response.ok) return; // A v1 server remains usable without this feature.
        const value: unknown = await response.json();
        assertSnapshot(value);
        if (this.stopped || controller.signal.aborted) return;
        const newEpoch = this.snapshot !== null && this.snapshot.stream_id !== value.stream_id;
        const next = acceptSnapshot(newEpoch ? null : this.snapshot, value);
        if (next === this.snapshot) return;
        this.snapshot = next;
        if (this.selected && (newEpoch || !next.agents.some(agent => agent.agent_id === this.selected!.agent.agent_id))) this.clearSelection(false);
        this.onChange();
      } catch { /* Retain the last known snapshot during transient failures. */ }
      finally {
        clearTimeout(timeout);
        this.snapshotController = null;
        this.snapshotRequest = null;
      }
    })();
    return this.snapshotRequest;
  }

  select(agentId: string): void {
    const agent = this.snapshot?.agents.find(item => item.agent_id === agentId);
    if (!agent || !this.snapshot || this.stopped) return;
    this.detailController?.abort();
    this.selected = {
      agent: structuredClone(agent), snapshot: structuredClone(this.snapshot), detail: null,
      loading: false, error: null, cursors: { conversation: null, workflow: null },
    };
    void this.readDetail();
  }

  clearSelection(notify = true): void {
    this.detailController?.abort();
    this.detailController = null;
    this.selected = null;
    if (notify) this.onChange();
  }

  async refreshDetail(): Promise<void> {
    const selected = this.selected;
    if (!selected) return;
    await this.refreshSnapshot();
    if (this.selected === selected) this.select(selected.agent.agent_id);
  }

  async loadMore(resource: AgentResource): Promise<void> {
    if (!this.selected || this.selected.loading || !this.selected.detail?.[resource].next_cursor) return;
    await this.readDetail(resource);
  }

  private async readDetail(resource?: AgentResource): Promise<void> {
    const selected = this.selected;
    if (!selected || selected.loading || this.stopped) return;
    const cursors = { ...selected.cursors };
    if (resource) cursors[resource] = selected.detail![resource].next_cursor;
    const query = new URLSearchParams({
      stream_id: selected.snapshot.stream_id, revision: String(selected.snapshot.revision),
      session_id: selected.agent.identity.session_id, agent_id: selected.agent.agent_id,
    });
    for (const key of ["conversation", "workflow"] as const) if (cursors[key]) query.set(`${key}_cursor`, cursors[key]!);
    const controller = new AbortController();
    this.detailController?.abort();
    this.detailController = controller;
    const timeout = setTimeout(() => controller.abort(), 10000);
    selected.loading = true;
    selected.error = null;
    this.onChange();
    try {
      const response = await this.request(`/agents/detail?${query}`, { headers: { Accept: "application/json" }, signal: controller.signal });
      if (this.selected !== selected || this.stopped || controller.signal.aborted) return;
      if (response.status === 410) {
        selected.error = "This retained view has expired. Refresh to load the latest details.";
        await this.refreshSnapshot();
        return;
      }
      if (response.status === 404) {
        this.clearSelection();
        await this.refreshSnapshot();
        return;
      }
      if (!response.ok) throw new Error("Agent details could not be loaded. Refresh to try again.");
      const value: unknown = await response.json();
      assertAgentDetail(value, selected.snapshot, { kind: "agent", agent_id: selected.agent.agent_id, session_id: selected.agent.identity.session_id });
      if (this.selected !== selected || this.stopped || controller.signal.aborted) return;
      selected.detail = resource && selected.detail ? mergeAgentDetailPage(selected.detail, value, resource) : value;
      selected.cursors = cursors;
    } catch {
      if (this.selected === selected && !this.stopped) selected.error = "Agent details could not be loaded. Refresh to try again.";
    } finally {
      clearTimeout(timeout);
      if (this.detailController === controller) this.detailController = null;
      if (this.selected === selected) { selected.loading = false; this.onChange(); }
    }
  }

  stop(): void {
    this.stopped = true;
    this.snapshotController?.abort();
    this.detailController?.abort();
  }
}
