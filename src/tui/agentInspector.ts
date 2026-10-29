import type { AgentSummary, Snapshot } from "../shared/agentContract.js";
import type { AgentSelection } from "../web/agentClient.js";
import { terminalText, wrapTerminalText } from "./terminalText.js";

export type AgentDetailTab = "overview" | "conversation" | "workflow";
export const AGENT_DETAIL_TABS: readonly AgentDetailTab[] = ["overview", "conversation", "workflow"];

export function agentList(snapshot: Snapshot | null | undefined, sessionIds: readonly string[], filter = ""): AgentSummary[] {
  const ids = new Set(sessionIds);
  const query = filter.toLowerCase();
  return (snapshot?.agents ?? []).filter(agent => agent.role === "subagent"
    && (ids.size === 0 || ids.has(agent.identity.session_id))
    && (!query || [agent.name, agent.provider_id, agent.identity.session_id, agent.status, agent.lifecycle].some(value => value?.toLowerCase().includes(query))))
    .sort((a, b) => a.agent_id.localeCompare(b.agent_id));
}

export function agentDetailText(selected: Pick<AgentSelection, "agent" | "snapshot" | "detail" | "loading" | "error"> | null | undefined, tab: AgentDetailTab, width: number): string {
  if (!selected) return "";
  const { agent, snapshot, detail, loading, error } = selected;
  const render = (body: string) => wrapTerminalText([error, body].filter(Boolean).join("\n\n"), width);
  if (tab === "overview") {
    const session = snapshot.sessions.find(item => item.session_id === agent.identity.session_id);
    const parent = snapshot.agents.find(item => item.agent_id === agent.parent_agent_id);
    return render([
      agent.name, "", `Status     ${agent.status}`, `Lifecycle  ${agent.lifecycle}`,
      `Provider   ${agent.provider_id ?? ""}`, `Session    ${session?.name ?? agent.identity.session_id}`,
      `Parent     ${parent?.name ?? ""}`, `Agent ID   ${agent.identity.native_agent_id}`,
      `Source     ${agent.identity.source_id}`, "", "As loaded",
    ].join("\n"));
  }
  if (!detail) return render(loading ? "Loading..." : "");
  const lines: string[] = [];
  if (tab === "conversation") {
    const page = detail.conversation;
    if (page.availability !== "available") return render("");
    if (page.truncated_before) lines.push("Earlier history is outside the retained window.", "");
    for (const message of page.items) {
      lines.push(message.role + (message.content_state === "complete" ? "" : ` / ${message.content_state}`));
      lines.push(message.content_state === "redacted" ? "" : terminalText(message.text), "");
    }
    if (page.next_cursor) lines.push("More conversation available");
  } else {
    const resource = detail.workflow_graph;
    if (resource.availability === "available" && resource.graph) {
      const graph = resource.graph;
      const labels = new Map(graph.nodes.map(node => [node.node_id, node.label]));
      lines.push("Workflow graph");
      for (const node of graph.nodes) lines.push(`${node.status}  ${node.label}`);
      for (const edge of graph.edges) lines.push(`${labels.get(edge.from) || edge.from} -> ${labels.get(edge.to) || edge.to}${edge.label ? ` / ${edge.label}` : ""}`);
      lines.push("");
    }
    const page = detail.workflow;
    if (page.availability === "available") {
      if (page.truncated_before) lines.push("Earlier events are outside the retained window.");
      for (const event of page.items) lines.push(event.stage, event.label, "");
      if (page.next_cursor) lines.push("More workflow events available");
    }
  }
  return render(lines.join("\n"));
}
