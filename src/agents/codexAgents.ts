import { open, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { codexExecutionEvents } from "./nativeExecutionEvents.js";
import {
  agentId, type AgentSummary, type Coverage,
  type Lifecycle, type Message, type Status, type WorkflowEvent,
} from "../shared/agentContract.js";
import type { SessionPayload } from "../shared/types.js";
import type { CodexAvatarSource } from "./codexNativeAvatars.js";
import type { CollectedAgents, CollectedAgentDetail } from "./agentCollector.js";
import type { NativeExecutionEvent } from "../shared/executionTrace.js";
import { readCodexStream } from "./codexStream.js";
import { readCodexHooks } from "./codexHooks.js";
export type { CollectedAgents, CollectedAgentDetail } from "./agentCollector.js";

export interface CodexAgentCollectorOptions {
  root: string;
  sourceId: string;
  avatarSource?: Pick<CodexAvatarSource, "forAgent">;
  windowMs?: number;
  activeMs?: number;
  maxFiles?: number;
  maxBytes?: number;
  streamRoot?: string;
  hookRoot?: string;
}

type Json = Record<string, unknown>;
interface Row { value: Json; sequence: number }
interface ParsedFile {
  readable?: boolean;
  nativeId: string;
  cwd: string | null;
  parentId: string | null;
  child: boolean;
  name: string | null;
  provider: string | null;
  mtime: number;
  status: Status;
  lifecycle: Lifecycle;
  detail: CollectedAgentDetail;
  activeTurn?: { id: string; at: number };
}
interface CachedFile { mtime: number; size: number; ino: number; parsed: ParsedFile | null }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_IN_SESSION = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const MAX_ITEMS = 500;

function object(value: unknown): Json | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined;
}
function text(value: unknown, limit = 256): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, limit) : null;
}
function uuid(value: unknown): string | null {
  return typeof value === "string" && UUID.test(value) ? value.toLowerCase() : null;
}
function time(value: unknown): number | null {
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}
function unavailableDetail(): CollectedAgentDetail {
  return {
    conversation: { availability: "unknown", items: [], truncated_before: false },
    workflow: { availability: "unknown", items: [], truncated_before: false },
    workflow_graph: { availability: "unsupported", graph: null },
  };
}
function visibleText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content.flatMap(part => {
    const p = object(part);
    return p && ["input_text", "output_text", "text"].includes(String(p.type)) && typeof p.text === "string" ? [p.text] : [];
  }).join("\n");
}

/** Byte positions provide one stable ordering even when old/new formats coexist. */
function rows(bytes: Buffer, offset: number): Row[] {
  const result: Row[] = [];
  let cursor = 0;
  if (offset > 0) {
    const firstNewline = bytes.indexOf(10);
    if (firstNewline < 0) return result;
    cursor = firstNewline + 1;
  }
  while (cursor < bytes.length) {
    const newline = bytes.indexOf(10, cursor);
    // A concurrently written last line is retried after size/mtime changes.
    if (newline < 0) break;
    try {
      const value = object(JSON.parse(bytes.subarray(cursor, newline).toString("utf8")));
      if (value) {
        result.push({ value, sequence: offset + cursor });
      }
    } catch { /* incomplete/malformed source records cannot become observations */ }
    cursor = newline + 1;
  }
  return result;
}

function parseFile(meta: Json, records: Row[], mtime: number, clipped: boolean, retained: readonly NativeExecutionEvent[] = []): ParsedFile | null {
  const nativeId = uuid(meta.id);
  const spawn = object(object(object(meta.source)?.subagent)?.thread_spawn);
  const isSubagent = meta.thread_source === "subagent" || !!object(meta.source)?.subagent;
  // Internal subagent.other (for example guardian) is not a user-visible worker.
  if (!nativeId || (isSubagent && !spawn)) return null;
  const child = !!spawn;
  const parentId = child ? uuid(spawn?.parent_thread_id) ?? uuid(meta.parent_thread_id) : null;
  if (child && !parentId) return null;
  const historyStart = Number.isSafeInteger(meta.subagent_history_start_ordinal) && (meta.subagent_history_start_ordinal as number) >= 0
    ? meta.subagent_history_start_ordinal as number : null;
  const unsafeInheritedHistory = child && ((!!meta.forked_from_id && historyStart === null)
    || (historyStart !== null && records.some(row => !Number.isSafeInteger(row.value.ordinal))));
  const usable = unsafeInheritedHistory ? [] : records.filter(({ value }) => {
    if (historyStart === null) return true;
    return Number.isSafeInteger(value.ordinal) && (value.ordinal as number) >= historyStart;
  });
  type Candidate = { item: Message; index: number; body: string };
  const canonical: Candidate[] = [];
  const fallback: Candidate[] = [];
  const workflow: WorkflowEvent[] = [];
  let status: Status = "unknown";
  let lifecycle: Lifecycle = "unknown";
  let activeTurn: ParsedFile["activeTurn"];
  const calls = new Map<string, string>();
  const agentPath = text(meta.agent_path) ?? text(spawn?.agent_path);
  const message = (target: Candidate[], value: Json, payload: Json, sequence: number, index: number, role: "user" | "assistant", body: string): void => {
    if (!body.trim()) return;
    target.push({ index, body, item: {
      message_id: text(payload.id) ?? `message:${sequence}`,
      sequence, role, text: body.slice(0, 16000), content_state: body.length > 16000 ? "truncated" : "complete",
      occurred_at: time(value.timestamp),
    } });
  };
  for (const [index, { value, sequence }] of usable.entries()) {
    const payload = object(value.payload);
    if (!payload) continue;
    const type = String(payload.type);
    let stage: string | null = null;
    let label = "";
    if (value.type === "response_item") {
      if (type === "message" && (payload.role === "user" || payload.role === "assistant")) {
        const safeChannel = payload.channel === undefined || ["commentary", "final"].includes(String(payload.channel));
        const safePhase = payload.phase === undefined || ["commentary", "final_answer", "final"].includes(String(payload.phase));
        if (safeChannel && safePhase) message(canonical, value, payload, sequence, index, payload.role, visibleText(payload.content));
      }
      // Inter-agent prompts are visible messages sent to this child, not hidden reasoning.
      if (type === "agent_message" && typeof payload.author === "string" && typeof payload.recipient === "string") {
        if (agentPath && payload.recipient === agentPath) message(canonical, value, payload, sequence, index, "user", visibleText(payload.content));
        else if (agentPath && payload.author === agentPath) message(canonical, value, payload, sequence, index, "assistant", visibleText(payload.content));
      }
      if (type === "function_call" || type === "custom_tool_call") {
        const name = text(payload.name) ?? "Tool";
        const callId = text(payload.call_id);
        if (callId) calls.set(callId, name);
        stage = "tool.start"; label = name;
        status = "working"; lifecycle = "active";
      } else if (type === "function_call_output" || type === "custom_tool_call_output") {
        stage = "tool.complete";
        label = calls.get(text(payload.call_id) ?? "") ?? "Tool completed";
      }
    } else if (value.type === "event_msg") {
      if ((type === "user_message" || type === "agent_message") && typeof payload.message === "string"
        && (payload.channel === undefined || ["commentary", "final"].includes(String(payload.channel)))) {
        message(fallback, value, payload, sequence, index, type === "user_message" ? "user" : "assistant", payload.message);
      }
      if (type === "task_started") {
        status = "working"; lifecycle = "active"; stage = "turn.start"; label = "Turn started";
        const turn = uuid(payload.turn_id), at = time(value.timestamp); activeTurn = turn && at !== null ? { id: turn, at } : undefined;
      }
      if (type === "task_complete" || type === "turn_aborted") {
        activeTurn = undefined;
        status = "idle"; lifecycle = "active"; stage = type === "task_complete" ? "turn.complete" : "turn.interrupted";
        label = type === "task_complete" ? "Turn completed" : "Turn interrupted";
      }
      if (type === "agent_shutdown" || type === "agent_completed") { status = "idle"; lifecycle = "completed"; stage = "agent.complete"; label = "Agent completed"; }
      if (type === "agent_cancelled") { status = "idle"; lifecycle = "cancelled"; stage = "agent.cancelled"; label = "Agent cancelled"; }
      if (type === "agent_failed") { status = "error"; lifecycle = "failed"; stage = "agent.failed"; label = "Agent failed"; }
      if (type === "item_completed" && payload.thread_id === nativeId && object(payload.item)?.type === "Plan") {
        stage = "plan.proposed"; label = "Native proposed plan";
      }
    }
    if (stage) workflow.push({ event_id: `event:${sequence}`, sequence, stage, label, occurred_at: time(value.timestamp) });
  }
  // Match one adjacent mirror from the other representation, never all text of a role.
  // This leaves event-only new messages and intentional repeated utterances intact.
  const paired = new Set<number>();
  const unmatched = fallback.filter(event => {
    const match = canonical.findIndex((response, index) => !paired.has(index)
      && event.item.role === response.item.role && event.body === response.body
      && Math.abs(event.index - response.index) === 1
      && event.item.occurred_at !== null && response.item.occurred_at !== null
      && Math.abs(event.item.occurred_at - response.item.occurred_at) <= 1000);
    if (match < 0) return true;
    paired.add(match);
    return false;
  });
  const messages = [...canonical, ...unmatched].map(candidate => candidate.item);
  const byId = new Map<string, Message>();
  for (const item of messages) byId.set(item.message_id, item);
  const ordered = [...byId.values()].sort((a, b) => a.sequence - b.sequence);
  const uniqueSequences = ordered.filter((item, index) => index === 0 || item.sequence !== ordered[index - 1]!.sequence);
  const workflowBySequence = [...new Map(workflow.map(item => [item.sequence, item])).values()].sort((a, b) => a.sequence - b.sequence);
  const detail = unavailableDetail();
  if (!unsafeInheritedHistory) {
    detail.conversation = { availability: "available", items: uniqueSequences.slice(-MAX_ITEMS), truncated_before: clipped || uniqueSequences.length > MAX_ITEMS };
    detail.workflow = { availability: "available", items: workflowBySequence.slice(-MAX_ITEMS), truncated_before: clipped || workflowBySequence.length > MAX_ITEMS };
    const current = codexExecutionEvents(usable, { nativeId, knownAgentStarts: retained });
    const lifetimes = new Map<string, NativeExecutionEvent>();
    for (const event of [...retained, ...current]) if (event.kind.startsWith("agent.")) {
      const key = JSON.stringify([event.kind, event.call_id, event.target_native_id]);
      if (!lifetimes.has(key)) lifetimes.set(key, event);
    }
    const events = [...current.filter(event => !event.kind.startsWith("agent.")), ...[...lifetimes.values()].sort((a, b) => a.sequence - b.sequence).slice(-256)].sort((a, b) => a.sequence - b.sequence);
    const notes: string[] = [];
    if (workflow.some(event => event.stage === "plan.proposed")) notes.push("Native proposed plan text was observed. It does not supply structured phase statuses or dependency IDs.");
    if (current.some(event => event.label === "Native command")) notes.push("Codex command intervals arrive when a native completed item is persisted. In-flight starts may be unavailable; timestamps describe harness observation, not the OS process clock.");
    if (lifetimes.size) notes.push("Codex agent activity does not declare business task dependencies. Spawning, unspecified waits and phase order do not create dependency edges.");
    detail.execution = { events, truncated_before: clipped, notes };
  }
  const pathName = text(spawn?.agent_path)?.split("/").filter(Boolean).at(-1);
  return {
    nativeId, cwd: text(meta.cwd, 2048), parentId, child, mtime, status, lifecycle, detail, activeTurn,
    name: text(meta.agent_nickname) ?? text(spawn?.agent_nickname) ?? pathName ?? null,
    provider: text(meta.model_provider),
  };
}

function positiveInteger(value: number | undefined, fallback: number, max: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? Math.min(value, max) : fallback;
}

/** Bounded, read-only discovery of explicit Codex worker threads. No server side effects. */
export function createCodexAgentCollector(options: CodexAgentCollectorOptions): { collect(sessions: readonly SessionPayload[], now?: number): Promise<CollectedAgents> } {
  if (!options.sourceId.trim() || options.sourceId.length > 256) throw new Error("Invalid agent source namespace");
  const windowMs = positiveInteger(options.windowMs, 7 * 24 * 60 * 60_000, 90 * 24 * 60 * 60_000);
  const activeMs = positiveInteger(options.activeMs, 120_000, 60 * 60_000);
  const maxFiles = positiveInteger(options.maxFiles, 256, 2000);
  const maxBytes = positiveInteger(options.maxBytes, 256 * 1024, 2 * 1024 * 1024);
  const cache = new Map<string, CachedFile>();

  async function readFile(path: string): Promise<ParsedFile | null> {
    const file = await open(path, "r");
    try {
      const info = await file.stat();
      const cached = cache.get(path);
      if (cached && cached.mtime === info.mtimeMs && cached.size === info.size && cached.ino === info.ino) return cached.parsed;
      const head = Buffer.alloc(Math.min(info.size, 64 * 1024));
      const headRead = await file.read(head, 0, head.length, 0);
      const metaRow = rows(head.subarray(0, headRead.bytesRead), 0)[0]?.value;
      const meta = metaRow?.type === "session_meta" ? object(metaRow.payload) : undefined;
      if (!meta) throw new Error("Codex metadata is incomplete or unreadable");
      const start = Math.max(0, info.size - maxBytes);
      const tail = Buffer.alloc(Math.min(info.size, maxBytes));
      const tailRead = await file.read(tail, 0, tail.length, start);
      const sameSource = cached?.ino === info.ino && info.size >= cached.size && cached.parsed?.nativeId === uuid(meta.id) && cached.parsed?.cwd === text(meta.cwd, 2048);
      const parsed = parseFile(meta, rows(tail.subarray(0, tailRead.bytesRead), start), Math.max(0, Math.floor(info.mtimeMs)), start > 0,
        sameSource ? cached?.parsed?.detail.execution?.events.filter(event => event.kind.startsWith("agent.")) : undefined);
      cache.set(path, { mtime: info.mtimeMs, size: info.size, ino: info.ino, parsed });
      return parsed;
    } finally { await file.close(); }
  }

  return {
    async collect(sessions, now = Date.now()) {
      const coverage: Record<string, Coverage> = {};
      const roots = new Map<string, SessionPayload>();
      const ambiguousRoots = new Set<string>();
      for (const session of sessions) {
        const localCodex = session.session_type.toLowerCase() === "codex" && session.origin !== "remote";
        coverage[session.session_id] = localCodex ? "unknown" : "unsupported";
        const id = session.session_id.match(UUID_IN_SESSION)?.[0]?.toLowerCase();
        if (localCodex && id) {
          // Ambiguous aliases cannot be attached safely without the existing merger.
          if (roots.has(id)) { roots.delete(id); ambiguousRoots.add(id); }
          else if (!ambiguousRoots.has(id)) roots.set(id, session);
        }
      }
      if (!roots.size) return { agents: [], coverage, details: new Map() };
      const dirs = new Set([options.root]);
      const firstDay = new Date(now - windowMs - 24 * 60 * 60_000);
      const endDay = new Date(now + 24 * 60 * 60_000);
      for (let day = endDay; day >= firstDay; day = new Date(day.getTime() - 24 * 60 * 60_000)) {
        dirs.add(join(options.root, String(day.getUTCFullYear()), String(day.getUTCMonth() + 1).padStart(2, "0"), String(day.getUTCDate()).padStart(2, "0")));
      }
      const candidates: { path: string; mtime: number }[] = [];
      const listedDirs = new Set<string>();
      const missingDirs = new Set<string>();
      const presentPaths = new Set<string>();
      const missingPaths = new Set<string>();
      let rootReadable = false;
      // Limit candidate metadata work as well as tail parsing. The result stays partial.
      const maxCandidates = maxFiles * 8;
      let inspected = 0;
      for (const dir of dirs) {
        try {
          const entries = await readdir(dir, { withFileTypes: true });
          listedDirs.add(dir);
          if (dir === options.root) rootReadable = true;
          for (const entry of entries) {
            if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
            const path = join(dir, entry.name);
            presentPaths.add(path);
            if (inspected >= maxCandidates) continue;
            inspected++;
            try {
              const info = await stat(path);
              if (info.mtimeMs >= now - windowMs) candidates.push({ path, mtime: info.mtimeMs });
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ENOENT") missingPaths.add(path);
            }
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") missingDirs.add(dir);
        }
      }
      const selected = candidates.sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path)).slice(0, maxFiles);
      for (const [path, cached] of cache) {
        if (cached.mtime < now - windowMs || missingPaths.has(path) || missingDirs.has(dirname(path))
          || (listedDirs.has(dirname(path)) && !presentPaths.has(path))) cache.delete(path);
      }
      const parsed = new Map<string, ParsedFile>();
      // Cache entries are last-good observations, not proof that the worker is still running.
      for (const cached of cache.values()) {
        if (cached.parsed) parsed.set(cached.parsed.nativeId, { ...cached.parsed, status: "unknown", readable: false });
      }
      for (const candidate of selected) {
        const old = cache.get(candidate.path)?.parsed;
        try {
          const entry = await readFile(candidate.path);
          if (old && old.nativeId !== entry?.nativeId) parsed.delete(old.nativeId);
          if (entry && (!parsed.has(entry.nativeId) || parsed.get(entry.nativeId)!.mtime <= entry.mtime)) parsed.set(entry.nativeId, entry);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            cache.delete(candidate.path);
            if (old) parsed.delete(old.nativeId);
          }
          // Other errors retain last-good records with unknown status and partial coverage.
        }
      }
      // Bound retained last-good observations separately from the per-pass read budget.
      const retained = [...cache.entries()].sort((a, b) => b[1].mtime - a[1].mtime).slice(0, maxFiles * 2);
      const retainedPaths = new Set(retained.map(([path]) => path));
      for (const [path, cached] of cache) if (!retainedPaths.has(path)) {
        cache.delete(path);
        if (cached.parsed) parsed.delete(cached.parsed.nativeId);
      }
      if (rootReadable) for (const session of roots.values()) coverage[session.session_id] = "partial";
      const rootFor = (entry: ParsedFile): SessionPayload | undefined => {
        const seen = new Set([entry.nativeId]);
        let parent = entry.parentId;
        while (parent) {
          if (seen.has(parent)) return undefined;
          seen.add(parent);
          const root = roots.get(parent);
          if (root) return root;
          const next = parsed.get(parent);
          if (!next?.child) return undefined;
          parent = next.parentId;
        }
        return undefined;
      };
      const agents: AgentSummary[] = [];
      const details = new Map<string, CollectedAgentDetail>();
      const owned = new Map<string, { entry: ParsedFile; session: SessionPayload }>();
      for (const entry of parsed.values()) {
        if (!entry.child) continue;
        const session = rootFor(entry);
        if (session) owned.set(entry.nativeId, { entry, session });
      }
      const identity = (session: SessionPayload, nativeId: string) => ({ source_id: options.sourceId, session_id: session.session_id, native_agent_id: nativeId, generation: "persistent" });
      const overlays = new Map<string, CollectedAgentDetail>();
      const rootIds = new Map([...roots].map(([nativeId, session]) => [session.session_id, nativeId]));
      for (const entry of parsed.values()) {
        const session = roots.get(entry.nativeId) ?? owned.get(entry.nativeId)?.session;
        if (!session || !entry.cwd || (roots.has(entry.nativeId) && session.project_path && resolve(entry.cwd) !== resolve(session.project_path))) continue;
        const stream = options.streamRoot ? await readCodexStream({ root: options.streamRoot, nativeId: entry.nativeId, cwd: entry.cwd, now, maxBytes }) : null;
        const hooks = options.hookRoot && !stream?.events.length ? readCodexHooks({ root: options.hookRoot, nativeId: entry.nativeId,
          rootNativeId: rootIds.get(session.session_id)!, cwd: entry.cwd, now, maxBytes }) : null;
        const source = entry.detail.execution;
        if (!source && !stream && !hooks) continue;
        const hookIds = new Set(hooks?.events.map(event => event.call_id));
        const nativeWaitEnds = new Set(source?.events.filter(event => event.label === "Native wait" && event.kind === "call.end").map(event => event.call_id));
        const events = [
          ...(source?.events ?? []).filter(event => {
            if (stream?.events.length && event.label === "Native wait") return false;
            if (!hookIds.has(event.call_id)) return true;
            if (event.kind === "call.start") return false;
            return !(event.kind === "call.end" && nativeWaitEnds.has(event.call_id) && event.label !== "Native wait");
          }).map(event => hookIds.has(event.call_id) && event.kind === "call.end" ? { ...event, label: "Native wait" } : event),
          ...(stream?.events ?? []), ...(hooks?.events ?? []),
        ];
        const closed = [...(stream?.closed_scopes ?? []), ...(hooks?.closed_scopes ?? [])];
        const ended = new Set(events.filter(e => e.kind === "call.end").map(e => e.call_id));
        const activityKey = (e: NativeExecutionEvent) => JSON.stringify([e.call_id, e.target_native_id]);
        const endedActivities = new Set(events.filter(e => e.kind === "agent.end").map(activityKey));
        const hookTurns = new Map(hooks?.pending.map(p => [p.event.event_id, p.turnId]));
        const active = entry.readable !== false && now - entry.mtime <= activeMs && entry.status === "working" && entry.activeTurn ? events.filter(e => e.at !== null && e.at >= entry.activeTurn!.at && (
          e.kind === "agent.start" && !endedActivities.has(activityKey(e)) && !["idle", "error"].includes(parsed.get(e.target_native_id ?? "")?.status ?? "working")
          || e.kind === "call.start" && e.label === "Native wait" && !ended.has(e.call_id) && !closed.includes(e.cursor_scope ?? "")
            && (!e.cursor_scope?.startsWith("codex-hooks:") || hookTurns.get(e.event_id) === entry.activeTurn!.id)
        )).map(e => e.event_id) : [];
        overlays.set(entry.nativeId, { ...entry.detail, execution: { events,
          truncated_before: !!source?.truncated_before || !!stream?.truncated_before || !!hooks?.truncated_before,
          notes: [...(source?.notes ?? []), ...(stream?.notes ?? []), ...(hooks?.notes ?? [])], closed_scopes: closed, initial_active_event_ids: active } });
      }
      const activity = new Map<string, NativeExecutionEvent>();
      const sources: { entry: ParsedFile; session: SessionPayload }[] = [...owned.values()];
      for (const [rootId, session] of roots) {
        const entry = parsed.get(rootId);
        if (entry && !entry.child && entry.cwd && (!session.project_path || resolve(entry.cwd) === resolve(session.project_path))) sources.push({ entry, session });
      }
      for (const { entry, session } of sources) for (const event of entry.detail.execution?.events ?? []) {
        const nativeId = event.target_native_id;
        if (!nativeId || nativeId === entry.nativeId || roots.has(nativeId) || !event.kind.startsWith("agent.")) continue;
        const existing = owned.get(nativeId);
        // A native target cannot adopt metadata belonging to a different tree.
        if (existing ? existing.session.session_id !== session.session_id : parsed.has(nativeId)) continue;
        if (!existing) owned.set(nativeId, { session, entry: { nativeId, cwd: null, parentId: entry.nativeId, child: true,
          name: event.label, provider: entry.provider, mtime: event.at ?? entry.mtime,
          status: entry.readable === false ? "unknown" : "working", lifecycle: "active", detail: unavailableDetail() } });
        const previous = activity.get(nativeId);
        if (!previous || previous.sequence <= event.sequence) activity.set(nativeId, event);
      }
      const mappedDetail = (detail: CollectedAgentDetail, session: SessionPayload): CollectedAgentDetail => !detail.execution ? detail : {
        ...detail, execution: { ...detail.execution, events: detail.execution.events.map(event => {
          const mapped = event.target_native_id && owned.get(event.target_native_id)?.session.session_id === session.session_id
            ? { ...event, target_agent_id: agentId(identity(session, event.target_native_id)) } : event;
          if (!event.wait_for_native_ids && !event.wait_result_native_ids) return mapped;
          const mapIds = (ids: string[]) => ids.filter(id => owned.get(id)?.session.session_id === session.session_id).map(id => agentId(identity(session, id)));
          const all = [...new Set([...(event.wait_for_native_ids ?? []), ...(event.wait_result_native_ids ?? [])])];
          return { ...mapped,
            ...(event.wait_for_native_ids ? { wait_for_agent_ids: mapIds(event.wait_for_native_ids) } : {}),
            ...(event.wait_result_native_ids ? { wait_result_agent_ids: mapIds(event.wait_result_native_ids) } : {}),
            unresolved_wait_targets: all.length - mapIds(all).length };
        }) },
      };
      // Primary identities come from already-normalized sessions, never from guessed names.
      for (const [rootId, session] of roots) {
        const candidate = parsed.get(rootId);
        const primary = candidate && !candidate.child && candidate.cwd && (!session.project_path || resolve(candidate.cwd) === resolve(session.project_path)) ? candidate : undefined;
        if (!primary && ![...owned.values()].some(item => item.session.session_id === session.session_id)) continue;
        const id = identity(session, rootId);
        const agent: AgentSummary = {
          agent_id: agentId(id), identity: id, role: "primary", parent_agent_id: null,
          name: (session.session_name || "Main agent").slice(0, 256), provider_id: text(session.model_provider) ?? "openai", avatar: null,
          status: session.status, lifecycle: "active", updated_at: Math.max(0, Math.floor(session.timestamp)),
        };
        agents.push(agent);
        details.set(agent.agent_id, mappedDetail(overlays.get(rootId) ?? primary?.detail ?? unavailableDetail(), session));
        coverage[session.session_id] = "partial";
      }
      for (const { entry, session } of owned.values()) {
        const native = activity.get(entry.nativeId);
        const id = identity(session, entry.nativeId);
        const parent = entry.parentId && (roots.has(entry.parentId) || owned.has(entry.parentId)) ? agentId(identity(session, entry.parentId)) : null;
        let avatar: AgentSummary["avatar"] = null;
        try { avatar = await options.avatarSource?.forAgent(entry.nativeId) ?? null; }
        catch { /* Optional native artwork must never prevent session discovery. */ }
        const agent: AgentSummary = {
          agent_id: agentId(id), identity: id, role: "subagent", parent_agent_id: parent,
          name: entry.name ?? `Agent ${entry.nativeId.slice(0, 8)}`, provider_id: entry.provider ?? "openai", avatar,
          status: native?.kind === "agent.end" ? "idle" : entry.status === "working" && now - Math.max(entry.mtime, native?.at ?? 0) > activeMs ? "unknown" : entry.status,
          lifecycle: entry.lifecycle, updated_at: Math.max(entry.mtime, native?.at ?? 0),
        };
        agents.push(agent); details.set(agent.agent_id, mappedDetail(overlays.get(entry.nativeId) ?? entry.detail, session));
      }
      agents.sort((a, b) => a.agent_id < b.agent_id ? -1 : a.agent_id > b.agent_id ? 1 : 0);
      return structuredClone({ agents, coverage, details });
    },
  };
}
