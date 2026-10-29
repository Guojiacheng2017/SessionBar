/** Versioned sub-agent read contract, shared by receiver and browser. */
export const SCHEMA = "sessionbar.subagents.v1-draft" as const;

export interface AgentIdentity {
  /** Receiver-owned durable namespace for harness + host + installation/account. */
  source_id: string;
  /** Existing canonical root SessionPayload.session_id, never a child thread ID. */
  session_id: string;
  native_agent_id: string;
  /** Stable incarnation; does not change on collector restart. */
  generation: string;
}

export type Avatar =
  | { kind: "asset"; asset_id: string }
  | { kind: "generated"; seed: string };

export type Coverage = "complete" | "partial" | "unknown" | "unsupported";
export type Status = "idle" | "working" | "blocked" | "error" | "unknown";
export type Lifecycle = "active" | "completed" | "cancelled" | "failed" | "unknown";

export interface ProjectSummary {
  project_id: string;
  name: string;
}

export interface SessionSummary {
  session_id: string;
  project_id: string | null;
  name: string;
  /** Coverage of retained agent roster, not whether conversation was fetched. */
  agents_coverage: Coverage;
}

export interface AgentSummary {
  agent_id: string;
  identity: AgentIdentity;
  role: "primary" | "subagent";
  /** null for primary; null for a subagent means parent is not yet known. */
  parent_agent_id: string | null;
  name: string;
  provider_id: string | null;
  avatar: Avatar | null;
  status: Status;
  lifecycle: Lifecycle;
  /** Last known source update, epoch milliseconds; null means unobserved.
   * For local Codex this is file mtime, never a cross-source ordering key. */
  updated_at: number | null;
}

export interface Snapshot {
  schema_version: typeof SCHEMA;
  kind: "snapshot";
  /** Receiver-owned epoch; revision is comparable only within this stream. */
  stream_id: string;
  revision: number;
  projects: ProjectSummary[];
  sessions: SessionSummary[];
  agents: AgentSummary[];
}

export type Availability = "available" | "unknown" | "unsupported" | "redacted";

export interface Page<T> {
  availability: Availability;
  items: T[];
  /** Opaque token scoped to stream/revision/agent/resource. */
  next_cursor: string | null;
  /** True if retained history omits older entries, independent of pagination. */
  truncated_before: boolean;
}

export interface Message {
  message_id: string;
  sequence: number;
  role: "user" | "assistant" | "system" | "tool";
  text: string;
  content_state: "complete" | "truncated" | "redacted";
  occurred_at: number | null;
}

export interface WorkflowEvent {
  event_id: string;
  sequence: number;
  stage: string;
  label: string;
  occurred_at: number | null;
}

export interface WorkflowGraph {
  nodes: { node_id: string; label: string; status: string }[];
  edges: { from: string; to: string; label: string }[];
}

export interface GraphResource {
  availability: Availability;
  /** available requires a graph, including an explicitly empty graph. */
  graph: WorkflowGraph | null;
}

export interface AgentDetail {
  schema_version: typeof SCHEMA;
  kind: "agent_detail";
  stream_id: string;
  revision: number;
  agent_id: string;
  conversation: Page<Message>;
  workflow: Page<WorkflowEvent>;
  /** Graph and event history have independent availability; both are agent-local. */
  workflow_graph: GraphResource;
}

export type DetailScope =
  | { kind: "session"; session_id: string }
  | { kind: "agent"; session_id: string; agent_id: string };

/** JSON tuples avoid delimiter collisions; IDs are case-sensitive opaque strings. */
export function agentId(identity: AgentIdentity): string {
  return JSON.stringify([
    "agent", identity.source_id, identity.session_id,
    identity.native_agent_id, identity.generation,
  ]);
}

function fail(message: string): never { throw new Error(message); }
function record(value: unknown, keys: string[], path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${path}: expected object`);
  const result = value as Record<string, unknown>;
  if (keys.some(key => !Object.hasOwn(result, key)) || Object.keys(result).some(key => !keys.includes(key))) {
    fail(`${path}: unexpected or missing fields`);
  }
  return result;
}
function str(value: unknown, path: string, max = 256, empty = false): asserts value is string {
  if (typeof value !== "string" || value.length > max || (!empty && !value.trim())) fail(`${path}: invalid string`);
}
function integer(value: unknown, path: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail(`${path}: invalid nonnegative integer`);
}
function timestamp(value: unknown, path: string): void { if (value !== null) integer(value, path); }
function choice(value: unknown, values: readonly string[], path: string): void {
  if (typeof value !== "string" || !values.includes(value)) fail(`${path}: invalid enum`);
}
function list(value: unknown, path: string, max: number): asserts value is unknown[] {
  if (!Array.isArray(value) || value.length > max) fail(`${path}: invalid array`);
}
function unique(ids: string[], path: string): void {
  if (new Set(ids).size !== ids.length) fail(`${path}: duplicate identity`);
}
function envelope(value: unknown, keys: string[], kind: string): Record<string, unknown> {
  const v = record(value, ["schema_version", "kind", "stream_id", "revision", ...keys], kind);
  if (v.schema_version !== SCHEMA || v.kind !== kind) fail("unsupported schema or message kind");
  str(v.stream_id, "stream_id");
  integer(v.revision, "revision");
  return v;
}

/** Validates the complete normalized snapshot, not raw provider reports. */
export function assertSnapshot(value: unknown): asserts value is Snapshot {
  const v = envelope(value, ["projects", "sessions", "agents"], "snapshot");
  list(v.projects, "projects", 1000);
  list(v.sessions, "sessions", 10000);
  list(v.agents, "agents", 50000);
  for (const raw of v.projects) {
    const p = record(raw, ["project_id", "name"], "project");
    str(p.project_id, "project_id"); str(p.name, "project.name");
  }
  for (const raw of v.sessions) {
    const s = record(raw, ["session_id", "project_id", "name", "agents_coverage"], "session");
    str(s.session_id, "session_id"); str(s.name, "session.name");
    if (s.project_id !== null) str(s.project_id, "session.project_id");
    choice(s.agents_coverage, ["complete", "partial", "unknown", "unsupported"], "agents_coverage");
  }
  for (const raw of v.agents) {
    const a = record(raw, ["agent_id", "identity", "role", "parent_agent_id", "name", "provider_id", "avatar", "status", "lifecycle", "updated_at"], "agent");
    const i = record(a.identity, ["source_id", "session_id", "native_agent_id", "generation"], "identity");
    for (const key of Object.keys(i)) str(i[key], `identity.${key}`);
    str(a.agent_id, "agent_id", 8192);
    if (a.agent_id !== agentId(i as unknown as AgentIdentity)) fail("agent_id: identity mismatch");
    choice(a.role, ["primary", "subagent"], "role");
    if (a.parent_agent_id !== null) str(a.parent_agent_id, "parent_agent_id", 8192);
    str(a.name, "agent.name");
    if (a.provider_id !== null) str(a.provider_id, "provider_id");
    if (a.avatar !== null) {
      const av = a.avatar as Avatar;
      if (av.kind === "asset") { record(av, ["kind", "asset_id"], "avatar"); str(av.asset_id, "asset_id"); }
      else if (av.kind === "generated") { record(av, ["kind", "seed"], "avatar"); str(av.seed, "seed", 8192); }
      else fail("avatar: invalid kind");
    }
    choice(a.status, ["idle", "working", "blocked", "error", "unknown"], "status");
    choice(a.lifecycle, ["active", "completed", "cancelled", "failed", "unknown"], "lifecycle");
    timestamp(a.updated_at, "updated_at");
    if (["completed", "cancelled", "failed"].includes(String(a.lifecycle)) && ["working", "blocked"].includes(String(a.status))) {
      fail("terminal lifecycle cannot be working or blocked");
    }
  }
  const snapshot = value as Snapshot;
  unique(snapshot.projects.map(p => p.project_id), "projects");
  unique(snapshot.sessions.map(s => s.session_id), "sessions");
  unique(snapshot.agents.map(a => a.agent_id), "agents");
  const projects = new Set(snapshot.projects.map(p => p.project_id));
  const sessions = new Map(snapshot.sessions.map(s => [s.session_id, s]));
  const agents = new Map(snapshot.agents.map(a => [a.agent_id, a]));
  const primaries = new Set<string>();
  for (const session of snapshot.sessions) {
    if (session.project_id !== null && !projects.has(session.project_id)) fail("session: unknown project");
  }
  for (const agent of snapshot.agents) {
    const session = sessions.get(agent.identity.session_id);
    if (!session) fail("agent: unknown session");
    if (["unknown", "unsupported"].includes(session.agents_coverage)) fail("agent: roster contradicts coverage");
    if (agent.role === "primary") {
      if (agent.parent_agent_id !== null || primaries.has(session.session_id)) fail("invalid primary agent");
      primaries.add(session.session_id);
    }
    if (agent.parent_agent_id !== null) {
      const parent = agents.get(agent.parent_agent_id);
      if (!parent || parent.identity.session_id !== session.session_id) fail("parent: missing or cross-session");
    }
  }
  // Linear-time ancestry walk; workflow graphs need not be acyclic.
  const complete = new Set<string>();
  for (const agent of snapshot.agents) {
    const path = new Set<string>();
    let current: AgentSummary | undefined = agent;
    while (current && !complete.has(current.agent_id)) {
      if (path.has(current.agent_id)) fail("parent: cycle");
      path.add(current.agent_id);
      current = current.parent_agent_id === null ? undefined : agents.get(current.parent_agent_id);
    }
    for (const id of path) complete.add(id);
  }
}

function page(value: unknown, path: string): Page<unknown> {
  const p = record(value, ["availability", "items", "next_cursor", "truncated_before"], path);
  choice(p.availability, ["available", "unknown", "unsupported", "redacted"], `${path}.availability`);
  list(p.items, `${path}.items`, 200);
  if (p.next_cursor !== null) str(p.next_cursor, `${path}.next_cursor`, 2048);
  if (typeof p.truncated_before !== "boolean") fail(`${path}: invalid truncation flag`);
  if (p.availability !== "available" && (p.items.length || p.next_cursor !== null || p.truncated_before)) fail(`${path}: unavailable content must be empty`);
  return p as unknown as Page<unknown>;
}

/** Validate against the request's frozen snapshot and the current selected scope.
 * Unrelated live revisions do not invalidate the frozen detail read. */
export function assertAgentDetail(value: unknown, snapshot: Snapshot, scope: DetailScope): asserts value is AgentDetail {
  assertSnapshot(snapshot);
  const v = envelope(value, ["agent_id", "conversation", "workflow", "workflow_graph"], "agent_detail");
  str(v.agent_id, "agent_id", 8192);
  const agent = snapshot.agents.find(a => a.agent_id === v.agent_id);
  if (v.stream_id !== snapshot.stream_id || v.revision !== snapshot.revision) fail("detail: stale snapshot reference");
  if (!agent || scope.kind !== "agent" || scope.agent_id !== v.agent_id || scope.session_id !== agent.identity.session_id) fail("detail: scope mismatch");
  const conversation = page(v.conversation, "conversation");
  const workflow = page(v.workflow, "workflow");
  for (const raw of conversation.items) {
    const m = record(raw, ["message_id", "sequence", "role", "text", "content_state", "occurred_at"], "message");
    str(m.message_id, "message_id"); integer(m.sequence, "message.sequence");
    choice(m.role, ["user", "assistant", "system", "tool"], "message.role");
    str(m.text, "message.text", 16000, true);
    choice(m.content_state, ["complete", "truncated", "redacted"], "content_state");
    if (m.content_state === "redacted" && m.text !== "") fail("redacted message must have empty text");
    timestamp(m.occurred_at, "message.occurred_at");
  }
  for (const raw of workflow.items) {
    const e = record(raw, ["event_id", "sequence", "stage", "label", "occurred_at"], "workflow event");
    str(e.event_id, "event_id"); integer(e.sequence, "workflow.sequence");
    str(e.stage, "stage"); str(e.label, "label", 1000, true); timestamp(e.occurred_at, "workflow.occurred_at");
  }
  const detail = value as AgentDetail;
  for (const [items, key] of [[detail.conversation.items, "message_id"], [detail.workflow.items, "event_id"]] as const) {
    unique(items.map(item => (item as unknown as Record<string, string>)[key]), key);
    if (items.some((item, index) => index > 0 && item.sequence <= items[index - 1]!.sequence)) fail("page: sequences must increase");
  }
  const resource = record(v.workflow_graph, ["availability", "graph"], "workflow_graph");
  choice(resource.availability, ["available", "unknown", "unsupported", "redacted"], "workflow_graph.availability");
  if (resource.availability !== "available" && resource.graph !== null) fail("unavailable graph must be null");
  if (resource.availability === "available") {
    const g = record(resource.graph, ["nodes", "edges"], "graph");
    list(g.nodes, "graph.nodes", 500); list(g.edges, "graph.edges", 2000);
    for (const raw of g.nodes) {
      const n = record(raw, ["node_id", "label", "status"], "node");
      str(n.node_id, "node_id"); str(n.label, "node.label"); str(n.status, "node.status");
    }
    for (const raw of g.edges) {
      const e = record(raw, ["from", "to", "label"], "edge");
      str(e.from, "edge.from"); str(e.to, "edge.to"); str(e.label, "edge.label", 256, true);
    }
    const graph = detail.workflow_graph.graph!;
    unique(graph.nodes.map(n => n.node_id), "graph.nodes");
    const ids = new Set(graph.nodes.map(n => n.node_id));
    if (graph.edges.some(e => !ids.has(e.from) || !ids.has(e.to))) fail("graph: dangling edge");
  }
}

export interface AvatarItem {
  agent_id: string;
  session_id: string;
  parent_agent_id: string | null;
  name: string;
  provider_id: string | null;
  avatar: Avatar;
  status: Status;
  lifecycle: Lifecycle;
}

export type AvatarScope = { kind: "session"; session_id: string } | { kind: "project"; project_id: string };

/** Both rows use this projection. Includes nested and retained terminal subagents. */
export function avatarRoster(snapshot: Snapshot, scope: AvatarScope): { coverage: Coverage; items: AvatarItem[] } {
  assertSnapshot(snapshot);
  if (scope.kind === "session" && !snapshot.sessions.some(s => s.session_id === scope.session_id)) fail("unknown session scope");
  if (scope.kind === "project" && !snapshot.projects.some(p => p.project_id === scope.project_id)) fail("unknown project scope");
  const sessions = snapshot.sessions.filter(s => scope.kind === "session" ? s.session_id === scope.session_id : s.project_id === scope.project_id);
  const ids = new Set(sessions.map(s => s.session_id));
  const coverage: Coverage = sessions.every(s => s.agents_coverage === "complete") ? "complete"
    : sessions.every(s => s.agents_coverage === "unsupported") ? "unsupported"
    : sessions.every(s => s.agents_coverage === "unknown") ? "unknown" : "partial";
  const agents = snapshot.agents.filter(a => a.role === "subagent" && ids.has(a.identity.session_id));
  // Stable identity ordering prevents status updates from shuffling avatars.
  agents.sort((a, b) => a.agent_id < b.agent_id ? -1 : a.agent_id > b.agent_id ? 1 : 0);
  return { coverage, items: agents.map(a => ({
    agent_id: a.agent_id, session_id: a.identity.session_id, parent_agent_id: a.parent_agent_id,
    name: a.name, provider_id: a.provider_id, avatar: a.avatar ? { ...a.avatar } : { kind: "generated", seed: a.agent_id },
    status: a.status, lifecycle: a.lifecycle,
  })) };
}

/** Full snapshots only. A different epoch requires explicit reconnect/bootstrap. */
export function acceptSnapshot(previous: Snapshot | null, incoming: unknown): Snapshot {
  assertSnapshot(incoming);
  if (previous) {
    assertSnapshot(previous);
    if (previous.stream_id !== incoming.stream_id) fail("new stream requires bootstrap");
    if (incoming.revision <= previous.revision) return previous;
  }
  return structuredClone(incoming);
}
