import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { SessionPayload } from "../shared/types.js";
import {
  SCHEMA, assertSnapshot, assertAgentDetail,
  type Snapshot, type AgentDetail, type Page, type Message, type WorkflowEvent,
} from "../shared/agentContract.js";
import type { AgentCollector, CollectedAgentDetail } from "./agentCollector.js";
import { LiveExecutionTracker } from "./liveExecutionTracker.js";
import type { ExecutionSnapshot } from "../shared/executionTrace.js";

export class AgentServiceError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}

export interface AgentDetailRequest {
  stream_id: string;
  revision: number;
  session_id: string;
  agent_id: string;
  conversation_cursor?: string | null;
  workflow_cursor?: string | null;
}

interface FrozenState {
  snapshot: Snapshot;
  details: Map<string, CollectedAgentDetail>;
  advertisedAt: number;
  bytes: number;
}

export interface AgentServiceOptions {
  getSessions: () => readonly SessionPayload[];
  collector: AgentCollector;
  now?: () => number;
  streamId?: string;
  refreshMs?: number;
  historyMs?: number;
  historyLimit?: number;
  historyBytes?: number;
  pageSize?: number;
}

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

/** Names are labels. A workspace path and its host/harness determine project identity. */
export function agentProjectId(session: SessionPayload): string | null {
  // A display name (or session ID suffix) does not establish a workspace.
  if (!session.project_path?.trim().replace(/\/+$/, "")) return null;
  const host = session.origin === "remote" ? session.harness_instance_id ?? session.session_id : "local";
  const workspace = session.project_path.replace(/\/+$/, "") || "/";
  return `project-${digest(JSON.stringify([host, workspace])).slice(0, 32)}`;
}

/** Pull-driven, single-flight reads; no listener, outbound network or background timer. */
export class AgentService {
  private readonly stream: string;
  private readonly now: () => number;
  private readonly pageSize: number;
  private readonly secret = randomBytes(32);
  private readonly executionTracker: LiveExecutionTracker;
  private readonly history = new Map<number, FrozenState>();
  private latest: FrozenState | undefined;
  private fingerprint = "";
  private checkedAt = -Infinity;
  private pending: Promise<Snapshot> | undefined;

  constructor(private readonly options: AgentServiceOptions) {
    this.stream = options.streamId ?? randomUUID();
    this.executionTracker = new LiveExecutionTracker(this.stream);
    this.now = options.now ?? Date.now;
    this.pageSize = options.pageSize ?? 100;
    if (!Number.isSafeInteger(this.pageSize) || this.pageSize < 1 || this.pageSize > 200) throw new Error("invalid agent page size");
  }

  async snapshot(): Promise<Snapshot> {
    const now = this.now();
    this.prune(now);
    if (this.latest && now - this.checkedAt < (this.options.refreshMs ?? 4_000)) {
      this.latest.advertisedAt = now;
      return structuredClone(this.latest.snapshot);
    }
    if (!this.pending) {
      this.pending = this.refresh(now).finally(() => { this.pending = undefined; });
    }
    return structuredClone(await this.pending);
  }

  private async refresh(now: number): Promise<Snapshot> {
    const sessions = structuredClone([...this.options.getSessions()]);
    const collected = await this.options.collector.collect(sessions, now);
    const projects = new Map<string, { project_id: string; name: string }>();
    const summaries = sessions.map(session => {
      const project_id = agentProjectId(session);
      if (project_id) projects.set(project_id, {
        project_id,
        name: (session.project || session.project_path?.split("/").filter(Boolean).at(-1) || "Project").slice(0, 256),
      });
      return {
        session_id: session.session_id, project_id,
        name: (session.session_name || session.task_name || session.session_id).slice(0, 256),
        agents_coverage: collected.coverage[session.session_id] ?? "unsupported" as const,
      };
    }).sort((a, b) => a.session_id < b.session_id ? -1 : 1);
    const snapshot: Snapshot = {
      schema_version: SCHEMA, kind: "snapshot", stream_id: this.stream,
      revision: (this.latest?.snapshot.revision ?? 0) + 1,
      projects: [...projects.values()].sort((a, b) => a.project_id < b.project_id ? -1 : 1),
      sessions: summaries,
      agents: [...collected.agents].sort((a, b) => a.agent_id < b.agent_id ? -1 : 1),
    };
    assertSnapshot(snapshot);
    const known = new Set(snapshot.agents.map(agent => agent.agent_id));
    const details = new Map([...collected.details].filter(([id]) => known.has(id)).sort(([a], [b]) => a < b ? -1 : 1));
    this.executionTracker.observe({ agents: snapshot.agents, details, coverage: collected.coverage }, now, sessions);
    const serialized = JSON.stringify({ projects: snapshot.projects, sessions: snapshot.sessions, agents: snapshot.agents, details: [...details] });
    const fingerprint = digest(serialized);
    if (this.latest && this.fingerprint === fingerprint) {
      this.checkedAt = now;
      // A long-unchanged revision was just handed to a reader. Its retention
      // window must not expire immediately when the next update arrives.
      this.latest.advertisedAt = now;
      return this.latest.snapshot;
    }
    const bytes = Buffer.byteLength(serialized);
    if (bytes > (this.options.historyBytes ?? 32 * 1024 * 1024)) throw new AgentServiceError(503, "agent_data_limit");
    const state: FrozenState = { snapshot: structuredClone(snapshot), details: structuredClone(details), advertisedAt: now, bytes };
    this.history.set(snapshot.revision, state);
    this.latest = state;
    this.fingerprint = fingerprint;
    this.checkedAt = now;
    this.prune(now);
    return snapshot;
  }

  private prune(now: number): void {
    let bytes = [...this.history.values()].reduce((sum, state) => sum + state.bytes, 0);
    for (const [revision, state] of this.history) {
      if (state === this.latest) continue;
      if (now - state.advertisedAt > (this.options.historyMs ?? 120_000)
        || this.history.size > (this.options.historyLimit ?? 12)
        || bytes > (this.options.historyBytes ?? 32 * 1024 * 1024)) {
        this.history.delete(revision);
        bytes -= state.bytes;
      }
    }
  }

  async detail(request: AgentDetailRequest): Promise<AgentDetail> {
    await this.snapshot();
    if (request.stream_id !== this.stream) throw new AgentServiceError(410, "snapshot_expired");
    const state = this.history.get(request.revision);
    if (!state) throw new AgentServiceError(410, "snapshot_expired");
    const matches = (snapshot: Snapshot) => snapshot.agents.find(agent => agent.agent_id === request.agent_id && agent.identity.session_id === request.session_id);
    if (!matches(state.snapshot) || !matches(this.latest!.snapshot)) throw new AgentServiceError(404, "agent_not_found");
    const source = state.details.get(request.agent_id);
    const unknown = { availability: "unknown" as const, items: [], truncated_before: false };
    const detail: AgentDetail = {
      schema_version: SCHEMA, kind: "agent_detail", stream_id: this.stream, revision: request.revision,
      agent_id: request.agent_id,
      conversation: this.page(source?.conversation ?? unknown, request, "conversation", request.conversation_cursor),
      workflow: this.page(source?.workflow ?? unknown, request, "workflow", request.workflow_cursor),
      workflow_graph: source?.workflow_graph ?? { availability: "unknown", graph: null },
    };
    assertAgentDetail(detail, state.snapshot, { kind: "agent", session_id: request.session_id, agent_id: request.agent_id });
    return structuredClone(detail);
  }

  async execution(sessionId: string): Promise<ExecutionSnapshot> {
    const snapshot = await this.snapshot();
    if (!snapshot.sessions.some(session => session.session_id === sessionId)) throw new AgentServiceError(404, "session_not_found");
    const view = this.executionTracker.view(sessionId, this.now());
    if (!view) throw new AgentServiceError(503, "execution_data_limit");
    return view;
  }

  private page<T extends Message | WorkflowEvent>(
    resource: Omit<Page<T>, "next_cursor">, request: AgentDetailRequest,
    kind: "conversation" | "workflow", cursor?: string | null,
  ): Page<T> {
    const offset = cursor ? this.cursorOffset(cursor, request, kind) : 0;
    if (offset > 0 && (resource.availability !== "available" || offset >= resource.items.length)) throw new AgentServiceError(400, "invalid_cursor");
    const next = offset + this.pageSize;
    return {
      availability: resource.availability,
      items: resource.items.slice(offset, next),
      truncated_before: resource.truncated_before,
      next_cursor: next < resource.items.length ? this.cursor(request, kind, next) : null,
    };
  }

  private cursor(request: AgentDetailRequest, kind: string, offset: number): string {
    const payload = Buffer.from(JSON.stringify({ s: this.stream, r: request.revision, a: digest(request.agent_id), k: kind, o: offset })).toString("base64url");
    return `${payload}.${createHmac("sha256", this.secret).update(payload).digest("hex")}`;
  }

  private cursorOffset(cursor: string, request: AgentDetailRequest, kind: string): number {
    try {
      if (cursor.length > 2048) throw new Error();
      const parts = cursor.split(".");
      if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]!) || !/^[0-9a-f]{64}$/.test(parts[1]!)) throw new Error();
      const expected = createHmac("sha256", this.secret).update(parts[0]!).digest();
      if (!timingSafeEqual(expected, Buffer.from(parts[1]!, "hex"))) throw new Error();
      const parsed = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8"));
      if (parsed.s !== this.stream || parsed.r !== request.revision || parsed.a !== digest(request.agent_id) || parsed.k !== kind
        || !Number.isSafeInteger(parsed.o) || parsed.o <= 0) throw new Error();
      return parsed.o;
    } catch { throw new AgentServiceError(400, "invalid_cursor"); }
  }
}
