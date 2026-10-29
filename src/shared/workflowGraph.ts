import type { Avatar, Snapshot } from "./agentContract.js";
import type { SessionFlowGraph, SessionPayload } from "./types.js";

export interface FlowNode {
  id: string;
  label: string;
  status: string;
  subtitle: string;
  agentId?: string;
  sessionId?: string;
  avatar?: Avatar | null;
}
export interface FlowEdge { from: string; to: string; label: string }
export interface FlowGraph {
  kind: "workflow" | "agents";
  evidence?: "native_wait" | "native_wait_result";
  nodes: FlowNode[];
  edges: FlowEdge[];
  notes: string[];
}
export interface PositionedNode extends FlowNode { x: number; y: number; width: number; height: number; rank: number }
export interface PositionedEdge extends FlowEdge { path: string; loop: boolean }
export interface FlowLayout { nodes: PositionedNode[]; edges: PositionedEdge[]; width: number; height: number }

const MAX_NODES = 128;
const MAX_EDGES = 512;
const text = (value: unknown): string => typeof value === "string" ? value : "";

/** Only reported endpoints survive; invalid references never create synthetic steps. */
function boundedGraph(kind: FlowGraph["kind"], input: FlowNode[], connections: FlowEdge[], notes: string[] = []): FlowGraph {
  const nodes: FlowNode[] = [], ids = new Set<string>();
  let duplicate = 0;
  for (const node of input) {
    if (!node.id) continue;
    if (ids.has(node.id)) { duplicate++; continue; }
    ids.add(node.id);
    if (nodes.length < MAX_NODES) nodes.push(node);
  }
  const retained = new Set(nodes.map(node => node.id));
  const edges: FlowEdge[] = [];
  let dangling = 0;
  for (const edge of connections) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) { dangling++; continue; }
    if (retained.has(edge.from) && retained.has(edge.to) && edges.length < MAX_EDGES) edges.push(edge);
  }
  if (duplicate) notes.push(`${duplicate} duplicate node ID${duplicate === 1 ? " was" : "s were"} omitted.`);
  if (nodes.length < ids.size) notes.push(`Showing ${nodes.length} of ${ids.size} reported nodes.`);
  if (dangling) notes.push(`${dangling} connection${dangling === 1 ? " references" : "s reference"} unreported nodes and cannot be drawn.`);
  if (edges.length < connections.length - dangling) notes.push(`Showing ${edges.length} of ${connections.length - dangling} valid connections in this bounded view.`);
  return { kind, nodes, edges, notes };
}

export function reportedWorkflowGraph(graph: SessionFlowGraph): FlowGraph {
  return boundedGraph("workflow", (Array.isArray(graph.nodes) ? graph.nodes : []).filter(node => node && text(node.id)).map(node => ({
    id: node.id, label: text(node.label).trim() || node.id, status: text(node.status) || "Not reported", subtitle: "Reported step",
  })), (Array.isArray(graph.edges) ? graph.edges : []).filter(edge => edge && text(edge.from) && text(edge.to)).map(edge => ({
    from: edge.from, to: edge.to, label: text(edge.label),
  })));
}

export function sessionWorkflowGraph(session: SessionPayload, snapshot: Snapshot | null): FlowGraph | null {
  if (session.flow) return reportedWorkflowGraph(session.flow);
  const summary = snapshot?.sessions.find(item => item.session_id === session.session_id);
  if (!summary || !snapshot) return null;
  const agents = snapshot.agents.filter(agent => agent.identity.session_id === session.session_id);
  if (!agents.some(agent => agent.role === "subagent")) return null;
  const ids = new Set(agents.map(agent => agent.agent_id));
  const notes: string[] = [];
  if (summary.agents_coverage !== "complete") notes.push(`${summary.agents_coverage[0]!.toUpperCase()}${summary.agents_coverage.slice(1)} coverage · only observed agents are shown.`);
  const orphanCount = agents.filter(agent => agent.role === "subagent" && (!agent.parent_agent_id || !ids.has(agent.parent_agent_id))).length;
  if (orphanCount) notes.push(`${orphanCount} sub-agent parent${orphanCount === 1 ? " was" : "s were"} not observed; those agents remain unconnected.`);
  return boundedGraph("agents", agents.map(agent => ({
    id: agent.agent_id, label: agent.name,
    status: ["completed", "cancelled", "failed"].includes(agent.lifecycle) ? agent.lifecycle : agent.status,
    subtitle: `${agent.role === "primary" ? "Primary agent" : "Sub-agent"}${agent.provider_id ? ` · ${agent.provider_id}` : ""}`,
    agentId: agent.agent_id, sessionId: agent.identity.session_id, avatar: agent.avatar,
  })), agents.flatMap(agent => agent.parent_agent_id && ids.has(agent.parent_agent_id)
    ? [{ from: agent.parent_agent_id, to: agent.agent_id, label: "parent → child" }] : []), notes);
}

/** Stable layered layout. Condense cycles for ranking, but retain every original edge. */
export function layoutWorkflowGraph(graph: FlowGraph, compact = false): FlowLayout {
  const order = new Map(graph.nodes.map((node, index) => [node.id, index]));
  const adjacent = new Map(graph.nodes.map(node => [node.id, [] as string[]]));
  for (const edge of graph.edges) adjacent.get(edge.from)!.push(edge.to);
  const index = new Map<string, number>(), low = new Map<string, number>();
  const stack: string[] = [], onStack = new Set<string>(), components: string[][] = [];
  let nextIndex = 0;
  const visit = (id: string): void => {
    index.set(id, nextIndex); low.set(id, nextIndex++); stack.push(id); onStack.add(id);
    for (const to of adjacent.get(id)!) {
      if (!index.has(to)) { visit(to); low.set(id, Math.min(low.get(id)!, low.get(to)!)); }
      else if (onStack.has(to)) low.set(id, Math.min(low.get(id)!, index.get(to)!));
    }
    if (low.get(id) !== index.get(id)) return;
    const members: string[] = [];
    let member: string;
    do { member = stack.pop()!; onStack.delete(member); members.push(member); } while (member !== id);
    components.push(members.sort((a, b) => order.get(a)! - order.get(b)!));
  };
  for (const node of graph.nodes) if (!index.has(node.id)) visit(node.id);
  components.sort((a, b) => order.get(a[0]!)! - order.get(b[0]!)!);
  const component = new Map(components.flatMap((members, i) => members.map(id => [id, i] as const)));
  const outgoing = components.map(() => new Set<number>()), indegree = components.map(() => 0), ranks = components.map(() => 0);
  for (const edge of graph.edges) {
    const from = component.get(edge.from)!, to = component.get(edge.to)!;
    if (from !== to && !outgoing[from]!.has(to)) { outgoing[from]!.add(to); indegree[to]!++; }
  }
  const queue = components.map((_, i) => i).filter(i => indegree[i] === 0);
  for (let i = 0; i < queue.length; i++) for (const to of outgoing[queue[i]!]!) {
    ranks[to] = Math.max(ranks[to]!, ranks[queue[i]!]! + 1);
    if (--indegree[to]! === 0) queue.push(to);
  }
  const rankOf = (id: string) => ranks[component.get(id)!]!;
  const overhead = graph.edges.filter(edge => rankOf(edge.to) !== rankOf(edge.from) + 1).length;
  const top = (compact ? 20 : 32) + Math.min(overhead, 12) * 9;
  const rows = new Map<number, number>();
  const nodeWidth = compact ? 156 : graph.kind === "agents" ? 200 : 184;
  const nodeHeight = compact ? 60 : graph.kind === "agents" ? 68 : 84;
  const rowPitch = compact ? 80 : graph.kind === "agents" ? 88 : 112;
  const nodes: PositionedNode[] = graph.nodes.map((node, i) => {
    // Independent tasks form a small grid; their source order creates no edges.
    const rank = compact && !graph.edges.length ? i % 3 : rankOf(node.id);
    const row = compact && !graph.edges.length ? Math.floor(i / 3) : rows.get(rank) ?? 0;
    rows.set(rank, row + 1);
    return { ...node, rank, x: (compact ? 20 : 36) + rank * (compact ? 188 : 256), y: top + row * rowPitch, width: nodeWidth, height: nodeHeight };
  });
  const positioned = new Map(nodes.map(node => [node.id, node]));
  let lane = 0;
  const edges = graph.edges.map(edge => {
    const from = positioned.get(edge.from)!, to = positioned.get(edge.to)!;
    const sx = from.x + from.width, sy = from.y + from.height / 2, tx = to.x, ty = to.y + to.height / 2;
    const loop = to.rank <= from.rank;
    let path: string;
    if (to.rank === from.rank + 1) {
      const bend = sx + (tx - sx) / 2;
      path = `M ${sx} ${sy} H ${bend} V ${ty} H ${tx - 3}`;
    } else {
      // Skip-rank and return connections use overhead gutters, never node bodies.
      const rail = 14 + (lane++ % 12) * 9;
      path = `M ${sx} ${sy} H ${sx + 20} V ${rail} H ${tx - 20} V ${ty} H ${tx - 3}`;
    }
    return { ...edge, path, loop };
  });
  return { nodes, edges, width: Math.max(256, ...nodes.map(node => node.x + node.width + (compact ? 20 : 36))), height: Math.max(compact ? 108 : 160, ...nodes.map(node => node.y + node.height + (compact ? 20 : 32))) };
}

export interface FlowEvent { id: string; stage: string; label: string; occurredAt: number | null; source?: string }
export interface FlowEventGroup extends FlowEvent { count: number; firstAt: number | null; lastAt: number | null }

/** Input order is source order; timestamps may be missing or out of order. */
export function groupWorkflowEvents(events: readonly FlowEvent[]): FlowEventGroup[] {
  const groups: FlowEventGroup[] = [];
  for (const event of events) {
    const at = typeof event.occurredAt === "number" && Number.isFinite(event.occurredAt) && Math.abs(event.occurredAt) <= 8.64e15 ? event.occurredAt : null;
    const last = groups.at(-1);
    if (last && last.stage === event.stage && last.label === event.label && last.source === event.source) {
      last.count++;
      if (at !== null) { last.firstAt = last.firstAt === null ? at : Math.min(last.firstAt, at); last.lastAt = last.lastAt === null ? at : Math.max(last.lastAt, at); }
    } else groups.push({ ...event, count: 1, firstAt: at, lastAt: at });
  }
  return groups;
}
