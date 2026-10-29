import { constants } from "node:fs";
import { lstat, open, opendir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { agentId, type AgentSummary, type Coverage, type Message, type Status, type WorkflowEvent } from "../shared/agentContract.js";
import type { SessionPayload } from "../shared/types.js";
import type { CollectedAgents, CollectedAgentDetail } from "./agentCollector.js";
import { claudeExecutionEvents } from "./nativeExecutionEvents.js";
import type { NativeExecutionEvent } from "../shared/executionTrace.js";

export interface ClaudeAgentCollectorOptions {
  root: string;
  sourceId: string;
  windowMs?: number;
  activeMs?: number;
  maxFiles?: number;
  maxBytes?: number;
}

type Json = Record<string, unknown>;
interface Row { value: Json; offset: number }
interface Parsed {
  rootId: string; nativeId: string; cwd: string; name: string; toolUseId: string | null;
  spawnDepth: number | null; stopped: boolean; finished: boolean;
  mtime: number; status: Status; calls: string[]; detail: CollectedAgentDetail;
}
interface Cached { stamp: string; parsed: Parsed }
interface Candidate { path: string; directory: string; rootId: string; nativeId: string; mtime: number }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_IN_ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/ig;
const CHILD_FILE = /^agent-([A-Za-z0-9_-]{1,128})\.jsonl$/;
const MAX_ITEMS = 500;
function object(value: unknown): Json | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Json : null; }
function text(value: unknown, max = 256): string | null { return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null; }
function timestamp(value: unknown): number | null { const n = typeof value === "string" ? Date.parse(value) : NaN; return Number.isSafeInteger(n) && n >= 0 ? n : null; }
function limit(value: number | undefined, fallback: number, max: number): number { return value !== undefined && Number.isSafeInteger(value) && value > 0 ? Math.min(value, max) : fallback; }
function missing(error: unknown): boolean { return ["ENOENT", "ENOTDIR"].includes(String(object(error)?.code)); }
function supports(session: SessionPayload): boolean { return session.origin !== "remote" && ["claude", "claude code", "claude-code"].includes(session.session_type.toLowerCase()); }
function rows(buffer: Buffer, start: number): Row[] {
  const result: Row[] = [];
  let cursor = start > 0 ? buffer.indexOf(10) + 1 : 0;
  if (start > 0 && cursor === 0) return result;
  while (cursor < buffer.length) {
    const end = buffer.indexOf(10, cursor); if (end < 0) break;
    try { const value = object(JSON.parse(buffer.subarray(cursor, end).toString("utf8"))); if (value) result.push({ value, offset: start + cursor }); } catch { /* Ignore malformed complete lines, never expose their contents. */ }
    cursor = end + 1;
  }
  return result;
}
async function listing(path: string, max: number): Promise<{ entries: import("node:fs").Dirent[]; complete: boolean }> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw Object.assign(new Error("not a source directory"), { code: "ENOTDIR" });
  const directory = await opendir(path); const result: import("node:fs").Dirent[] = [];
  let complete = true;
  try { for await (const item of directory) { if (result.length >= max) { complete = false; break; } result.push(item); } }
  finally { await directory.close().catch(() => {}); }
  return { entries: result, complete };
}
async function sliceFile(path: string, maxBytes: number): Promise<{ head: Row[]; tail: Row[]; clipped: boolean; mtime: number; stamp: string }> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > Number.MAX_SAFE_INTEGER / 1024) throw Object.assign(new Error("invalid source file"), { code: "ENOTDIR" });
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await file.stat();
    if (opened.ino !== info.ino || !opened.isFile()) throw new Error("source changed");
    const head = Buffer.alloc(Math.min(opened.size, 64 * 1024));
    const headRead = await file.read(head, 0, head.length, 0);
    const start = Math.max(0, opened.size - maxBytes);
    const tail = start ? Buffer.alloc(Math.min(opened.size, maxBytes)) : head.length === opened.size ? head : Buffer.alloc(opened.size);
    const read = tail === head ? headRead : await file.read(tail, 0, tail.length, start);
    const after = await file.stat();
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) throw new Error("source changed while reading");
    return { head: rows(head.subarray(0, headRead.bytesRead), 0), tail: rows(tail.subarray(0, read.bytesRead), start), clipped: start > 0,
      mtime: Math.max(0, Math.floor(opened.mtimeMs)), stamp: `${opened.ino}:${opened.size}:${opened.mtimeMs}` };
  } finally { await file.close(); }
}
async function metadata(path: string): Promise<{ value: Json; stamp: string; mtime: number }> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024) return { value: {}, stamp: "unsupported", mtime: 0 };
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await file.stat();
      if (opened.ino !== info.ino || !opened.isFile() || opened.size > 64 * 1024) throw new Error("metadata changed");
      const buffer = Buffer.alloc(opened.size); const read = await file.read(buffer, 0, buffer.length, 0);
      const after = await file.stat();
      if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) throw new Error("metadata changed while reading");
      const value = object(JSON.parse(buffer.subarray(0, read.bytesRead).toString("utf8")));
      if (!value) throw new Error("incomplete metadata");
      return { value, stamp: `${opened.ino}:${opened.size}:${opened.mtimeMs}`, mtime: Math.max(0, Math.floor(opened.mtimeMs)) };
    } finally { await file.close(); }
  } catch (error) { if (missing(error)) return { value: {}, stamp: "missing", mtime: 0 }; throw error; }
}
function parse(candidate: Candidate, source: Awaited<ReturnType<typeof sliceFile>>, meta: Json, metaTime: number): Parsed | null {
  const first = source.head.find(row => row.value.isSidechain === true && typeof row.value.agentId === "string");
  if (!first) throw new Error("incomplete subagent metadata");
  if (first.value.sessionId !== candidate.rootId || first.value.agentId !== candidate.nativeId || typeof first.value.cwd !== "string") return null;
  const cwd = first.value.cwd;
  // Ordinary child transcripts start a separate message chain. Forks inherit
  // parent context; without a verified boundary their detail remains unknown.
  const independent = first.value.type === "user" && object(first.value.message)?.role === "user"
    && first.value.parentUuid === null && text(meta.agentType)?.toLowerCase() !== "fork";
  const owned = independent ? source.tail.filter(({ value }) => value.sessionId === candidate.rootId && value.agentId === candidate.nativeId && value.isSidechain === true && value.cwd === cwd) : [];
  const messages: Message[] = [], workflow: WorkflowEvent[] = [], calls: string[] = [];
  const toolNames = new Map<string, string>(), seen = new Set<string>();
  let status: Status = "unknown";
  for (const { value, offset } of owned) {
    const message = object(value.message);
    if (!message || (value.type !== "assistant" && value.type !== "user") || message.role !== value.type) continue;
    if (value.isMeta === true || value.isSynthetic === true || value.isCompactSummary === true || value.isVisible === false) continue;
    const blocks = Array.isArray(message.content) ? message.content.map(object).filter((b): b is Json => b !== null) : [];
    const body = value.type === "user" && blocks.some(block => block.type === "tool_result") ? "" : typeof message.content === "string" ? message.content : blocks.filter(block => block.type === "text" && typeof block.text === "string").map(block => block.text).join("\n");
    const id = text(value.uuid) ?? `message:${offset}`;
    if (body.trim() && !seen.has(id)) {
      seen.add(id);
      messages.push({ message_id: id, sequence: offset, role: value.type, text: body.slice(0, 16000), content_state: body.length > 16000 ? "truncated" : "complete", occurred_at: timestamp(value.timestamp) });
      status = "working";
    }
    const event = (index: number, stage: string, label: string) => workflow.push({ event_id: `event:${offset}:${index}`, sequence: offset * 1024 + index, stage, label, occurred_at: timestamp(value.timestamp) });
    for (const [index, block] of blocks.slice(0, 1000).entries()) {
      if (value.type === "assistant" && block.type === "tool_use") {
        const toolId = text(block.id), name = text(block.name);
        if (!toolId || !name) continue;
        toolNames.set(toolId, name); if (["Agent", "Task"].includes(name)) calls.push(toolId);
        event(index, "tool.start", name); status = "working";
      } else if (value.type === "user" && block.type === "tool_result") {
        const name = toolNames.get(String(block.tool_use_id)) ?? "Tool";
        event(index, block.is_error === true ? "tool.error" : "tool.complete", name);
        status = block.is_error === true ? "error" : "working";
      }
    }
    if (value.type === "assistant" && message.stop_reason === "end_turn") { event(1000, "turn.complete", "Turn finished"); status = "idle"; }
  }
  return { rootId: candidate.rootId, nativeId: candidate.nativeId, cwd, name: text(meta.name) ?? text(meta.agentType) ?? `Agent ${candidate.nativeId}`,
    toolUseId: text(meta.toolUseId), spawnDepth: Number.isSafeInteger(meta.spawnDepth) && (meta.spawnDepth as number) > 0 ? meta.spawnDepth as number : null,
    stopped: meta.stoppedByUser === true, finished: meta.finished === true, mtime: Math.max(source.mtime, metaTime), status, calls,
    detail: { conversation: { availability: independent ? "available" : "unknown", items: messages.slice(-MAX_ITEMS), truncated_before: independent && (source.clipped || messages.length > MAX_ITEMS) },
      workflow: { availability: independent ? "available" : "unknown", items: workflow.slice(-MAX_ITEMS), truncated_before: independent && (source.clipped || workflow.length > MAX_ITEMS) },
      workflow_graph: { availability: "unsupported", graph: null },
      ...(independent ? { execution: { events: claudeExecutionEvents(owned.map(row => ({ value: row.value, sequence: row.offset })), { sessionId: candidate.rootId, primary: false, agentId: candidate.nativeId }), truncated_before: source.clipped } } : {}),
    } };
}

/** Local Claude Code's documented per-session subagent transcripts. No writes or timers. */
export function createClaudeAgentCollector(options: ClaudeAgentCollectorOptions): { collect(sessions: readonly SessionPayload[], now?: number): Promise<CollectedAgents> } {
  if (!options.sourceId.trim() || options.sourceId.length > 256) throw new Error("Invalid agent source namespace");
  const windowMs = limit(options.windowMs, 7 * 86400_000, 90 * 86400_000), activeMs = limit(options.activeMs, 120_000, 3600_000);
  const maxFiles = limit(options.maxFiles, 256, 2000), maxBytes = limit(options.maxBytes, 256 * 1024, 2 * 1024 * 1024);
  const cache = new Map<string, Cached>();
  const lifecycleCache = new Map<string, { scope: string; events: Map<string, NativeExecutionEvent> }>();
  return { async collect(sessions, now = Date.now()) {
    const coverage: Record<string, Coverage> = {}, roots = new Map<string, SessionPayload>(), ambiguous = new Set<string>();
    for (const session of sessions) {
      coverage[session.session_id] = supports(session) ? "unknown" : "unsupported";
      if (!supports(session)) continue;
      const ids = [...session.session_id.split("__", 1)[0]!.matchAll(UUID_IN_ID)].map(match => match[0].toLowerCase());
      if (ids.length !== 1) continue;
      const id = ids[0]!;
      if (roots.has(id)) { roots.delete(id); ambiguous.add(id); } else if (!ambiguous.has(id)) roots.set(id, session);
    }
    if (!roots.size) { lifecycleCache.clear(); return { agents: [], coverage, details: new Map() }; }
    for (const id of lifecycleCache.keys()) if (!roots.has(id)) lifecycleCache.delete(id);
    const candidates: Candidate[] = [], observed = new Map<string, Parsed>(), failed = new Set<string>();
    const rootLogs = new Map<string, string>(), primaryLogs = new Map<string, string>(), traversed = new Set<string>();
    let projectEntries: import("node:fs").Dirent[] = [];
    try { projectEntries = (await listing(options.root, 256)).entries; } catch { /* unknown coverage below */ }
    for (const project of projectEntries) {
      if (!project.isDirectory() || project.isSymbolicLink()) continue;
      const projectPath = join(options.root, project.name);
      let entries: import("node:fs").Dirent[];
      try { entries = (await listing(projectPath, 4096)).entries; } catch { continue; }
      for (const entry of entries) {
        const primaryId = /^([0-9a-f-]{36})\.jsonl$/i.exec(entry.name)?.[1]?.toLowerCase();
        if (primaryId && roots.has(primaryId) && entry.isFile() && !entry.isSymbolicLink()) primaryLogs.set(primaryId, join(projectPath, entry.name));
        if (!entry.isDirectory() || entry.isSymbolicLink() || !UUID.test(entry.name) || !roots.has(entry.name.toLowerCase())) continue;
        const rootId = entry.name.toLowerCase(), directory = join(projectPath, entry.name, "subagents");
        const session = roots.get(rootId)!;
        rootLogs.set(directory, join(projectPath, `${entry.name}.jsonl`));
        try {
          const children = await listing(directory, Math.max(512, maxFiles * 2));
          if (children.complete) traversed.add(directory);
          coverage[session.session_id] = "partial";
          for (const child of children.entries) {
            const match = CHILD_FILE.exec(child.name);
            if (!match || !child.isFile() || child.isSymbolicLink()) continue;
            const path = join(directory, child.name);
            try {
              const info = await lstat(path);
              if (!info.isFile() || info.isSymbolicLink() || now - info.mtimeMs > windowMs || info.mtimeMs > now + 1000) { cache.delete(path); continue; }
              candidates.push({ path, directory, rootId, nativeId: match[1]!, mtime: info.mtimeMs });
            } catch (error) { if (missing(error)) cache.delete(path); else failed.add(path); }
          }
        } catch (error) {
          if (missing(error)) { traversed.add(directory); coverage[session.session_id] = "partial"; }
        }
      }
    }
    candidates.sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path));
    const retained = candidates.slice(0, maxFiles), seenPaths = new Set(candidates.map(candidate => candidate.path));
    for (const candidate of retained) {
      try {
        const info = await lstat(candidate.path), meta = await metadata(candidate.path.replace(/\.jsonl$/, ".meta.json"));
        if (!info.isFile() || info.isSymbolicLink()) { cache.delete(candidate.path); continue; }
        let stamp = `${info.ino}:${info.size}:${info.mtimeMs}:${meta.stamp}`;
        const previous = cache.get(candidate.path);
        let parsed = previous?.stamp === stamp ? previous.parsed : null;
        if (!parsed) { const source = await sliceFile(candidate.path, maxBytes); parsed = parse(candidate, source, meta.value, meta.mtime); stamp = source.stamp + ":" + meta.stamp; }
        if (!parsed) { cache.delete(candidate.path); continue; }
        const session = roots.get(parsed.rootId)!;
        if (session.project_path && resolve(session.project_path) !== resolve(parsed.cwd)) { cache.delete(candidate.path); continue; }
        cache.set(candidate.path, { stamp, parsed }); observed.set(candidate.path, parsed);
      } catch (error) { if (missing(error)) cache.delete(candidate.path); else failed.add(candidate.path); }
    }
    for (const [path, value] of cache) {
      const session = roots.get(value.parsed.rootId);
      if (!session || now - value.parsed.mtime > windowMs || (session.project_path && resolve(session.project_path) !== resolve(value.parsed.cwd))) { cache.delete(path); continue; }
      if (observed.has(path)) continue;
      const directory = path.slice(0, path.lastIndexOf("/"));
      if (traversed.has(directory) && !seenPaths.has(path) && !failed.has(path)) { cache.delete(path); continue; }
      if (failed.has(path) || !traversed.has(directory)) {
        try { await lstat(path); } catch (error) { if (missing(error)) { cache.delete(path); continue; } }
        observed.set(path, { ...value.parsed, status: "unknown" });
      }
    }
    // A root UUID appearing in multiple project stores is ambiguous even if labels match.
    const stores = new Map<string, Set<string>>();
    for (const [path, parsed] of observed) { const paths = stores.get(parsed.rootId) ?? new Set<string>(); paths.add(path.slice(0, path.lastIndexOf("/"))); stores.set(parsed.rootId, paths); }
    const keyed = new Map<string, Parsed>(), duplicate = new Set<string>();
    for (const value of observed.values()) {
      if (stores.get(value.rootId)!.size > 1) continue;
      const key = `${value.rootId}:${value.nativeId}`;
      if (keyed.has(key)) { keyed.delete(key); duplicate.add(key); } else if (!duplicate.has(key)) keyed.set(key, value);
    }
    const parentByTool = new Map<string, Set<string>>();
    const addCalls = (directory: string, owner: string, calls: string[]) => { for (const call of calls) { const key = `${directory}:${call}`; const owners = parentByTool.get(key) ?? new Set<string>(); owners.add(owner); parentByTool.set(key, owners); } };
    for (const [path, parsed] of observed) addCalls(path.slice(0, path.lastIndexOf("/")), parsed.nativeId, parsed.calls);
    for (const [directory, path] of rootLogs) {
      try {
        const source = await sliceFile(path, maxBytes);
        const rootId = directory.split("/").at(-2)!;
        const calls = source.tail.flatMap(({ value }) => {
          if (value.sessionId !== rootId || value.isSidechain === true || value.type !== "assistant") return [];
          const content = object(value.message)?.content;
          return Array.isArray(content) ? content.flatMap(block => { const b = object(block); return b?.type === "tool_use" && ["Agent", "Task"].includes(String(b.name)) && text(b.id) ? [text(b.id)!] : []; }) : [];
        });
        addCalls(directory, rootId, calls);
      } catch { /* Parent omitted when its spawn call is outside the readable window. */ }
    }
    const parentIds = new Map<string, string | null>();
    for (const [path, parsed] of observed) {
      const key = `${parsed.rootId}:${parsed.nativeId}`;
      if (!keyed.has(key)) continue;
      const owners = parsed.toolUseId ? parentByTool.get(`${path.slice(0, path.lastIndexOf("/"))}:${parsed.toolUseId}`) : undefined;
      const explicit = owners?.size === 1 ? [...owners][0]! : null;
      parentIds.set(key, explicit && explicit !== parsed.nativeId ? explicit : parsed.spawnDepth === 1 ? parsed.rootId : null);
    }
    const agents: AgentSummary[] = [], details = new Map<string, CollectedAgentDetail>();
    const primaryDetails = new Map<string, CollectedAgentDetail>();
    for (const [rootId, path] of primaryLogs) {
      try {
        const source = await sliceFile(path, maxBytes), session = roots.get(rootId)!;
        const head = source.head.find(({ value }) => value.sessionId === rootId && value.isSidechain !== true && ["user", "assistant"].includes(String(value.type)) && typeof value.cwd === "string");
        if (!head || (session.project_path && resolve(session.project_path) !== resolve(String(head.value.cwd))) || now - source.mtime > windowMs || source.mtime > now + 1000) continue;
        const scope = JSON.stringify([session.session_id, path, source.stamp.split(":", 1)[0], resolve(String(head.value.cwd))]);
        let retained = lifecycleCache.get(rootId);
        if (!retained || retained.scope !== scope) { retained = { scope, events: new Map() }; lifecycleCache.set(rootId, retained); }
        const current = claudeExecutionEvents(source.tail.map(row => ({ value: row.value, sequence: row.offset })), { sessionId: rootId, primary: true, knownAgentStarts: [...retained.events.values()] });
        for (const event of current) if (event.kind.startsWith("agent.")) {
          const key = JSON.stringify([event.kind, event.call_id, event.target_native_id]);
          if (!retained.events.has(key)) retained.events.set(key, event);
        }
        while (retained.events.size > 256) retained.events.delete(retained.events.keys().next().value!);
        const events = [...current.filter(event => !event.kind.startsWith("agent.")), ...retained.events.values()].sort((a, b) => a.sequence - b.sequence);
        primaryDetails.set(rootId, {
          conversation: { availability: "unsupported", items: [], truncated_before: false },
          workflow: { availability: "available", items: events.filter(e => e.kind === "call.start" || e.kind === "call.end").map(e => ({ event_id: e.event_id, sequence: e.sequence, stage: e.kind === "call.start" ? "tool.start" : "tool.complete", label: e.label, occurred_at: e.at })), truncated_before: source.clipped },
          workflow_graph: { availability: "unsupported", graph: null }, execution: { events, truncated_before: source.clipped },
        });
      } catch { /* An incomplete or changing source cannot become a live observation. */ }
    }
    while (lifecycleCache.size > 128) lifecycleCache.delete(lifecycleCache.keys().next().value!);
    const identity = (session: SessionPayload, nativeId: string) => ({ source_id: options.sourceId, session_id: session.session_id, native_agent_id: nativeId, generation: "persistent" });
    type NativeActor = { nativeId: string; parentId: string; name: string; at: number; ended: boolean; outcome: "completed" | "failed" | "cancelled" };
    const nativeActors = new Map<string, NativeActor>();
    const noteActors = (rootId: string, parentId: string, detail: CollectedAgentDetail): void => {
      if ((stores.get(rootId)?.size ?? 0) > 1) return;
      for (const event of detail.execution?.events ?? []) {
        const nativeId = event.target_native_id;
        if (!nativeId || nativeId === rootId || nativeId === parentId || !["agent.start", "agent.end"].includes(event.kind)) continue;
        const key = `${rootId}:${nativeId}`, previous = nativeActors.get(key);
        if (previous && previous.at > (event.at ?? 0)) continue;
        nativeActors.set(key, { nativeId, parentId, name: event.label, at: event.at ?? 0, ended: event.kind === "agent.end", outcome: event.outcome ?? "completed" });
      }
    };
    for (const [rootId, detail] of primaryDetails) noteActors(rootId, rootId, detail);
    const mappedDetail = (detail: CollectedAgentDetail, session: SessionPayload, rootId: string): CollectedAgentDetail => {
      if (!detail.execution) return detail;
      return { ...detail, execution: { ...detail.execution, events: detail.execution.events.map(event => event.target_native_id && nativeActors.has(`${rootId}:${event.target_native_id}`)
        ? { ...event, target_agent_id: agentId(identity(session, event.target_native_id)) } : event) } };
    };
    for (const [rootId, session] of roots) {
      const children = [...keyed.values()].filter(parsed => parsed.rootId === rootId);
      if (!children.length && !primaryDetails.has(rootId)) continue;
      coverage[session.session_id] = "partial";
      const primaryId = identity(session, rootId);
      agents.push({ agent_id: agentId(primaryId), identity: primaryId, role: "primary", parent_agent_id: null, name: (session.session_name || "Main agent").slice(0, 256), provider_id: text(session.model_provider), avatar: null, status: session.status, lifecycle: "active", updated_at: Math.max(0, Math.floor(session.timestamp)) });
      if (primaryDetails.has(rootId)) details.set(agentId(primaryId), mappedDetail(primaryDetails.get(rootId)!, session, rootId));
      const childIds = new Set([...children.map(child => child.nativeId), ...[...nativeActors].filter(([key]) => key.startsWith(`${rootId}:`)).map(([, actor]) => actor.nativeId)]);
      for (const nativeId of childIds) {
        const child = keyed.get(`${rootId}:${nativeId}`), native = nativeActors.get(`${rootId}:${nativeId}`);
        let parent = child ? parentIds.get(`${rootId}:${nativeId}`) ?? null : native?.parentId ?? null;
        const visited = new Set([nativeId]); let cursor = parent;
        while (cursor && cursor !== rootId) { if (visited.has(cursor) || !keyed.has(`${rootId}:${cursor}`)) { parent = null; break; } visited.add(cursor); cursor = parentIds.get(`${rootId}:${cursor}`) ?? null; }
        const id = identity(session, nativeId);
        const lifecycle = child?.stopped ? "cancelled" : native?.ended ? native.outcome : child?.finished ? "completed" : "active";
        const lastAt = Math.max(child?.mtime ?? 0, native?.at ?? 0);
        const status = lifecycle !== "active" ? "idle" : child ? child.status === "working" && now - child.mtime > activeMs ? "unknown" : child.status : "working";
        const agent: AgentSummary = { agent_id: agentId(id), identity: id, role: "subagent", parent_agent_id: parent ? agentId(identity(session, parent)) : null,
          name: child?.name ?? native?.name ?? `Agent ${nativeId}`, provider_id: text(session.model_provider), avatar: null, status, lifecycle, updated_at: lastAt };
        const detail: CollectedAgentDetail = child?.detail ?? { conversation: { availability: "unknown", items: [], truncated_before: false }, workflow: { availability: "unknown", items: [], truncated_before: false }, workflow_graph: { availability: "unsupported", graph: null } };
        agents.push(agent); details.set(agent.agent_id, mappedDetail(detail, session, rootId));
      }
    }
    // Bound last-good memory independently from the current retained roster.
    if (cache.size > maxFiles * 2) for (const [path] of [...cache].sort((a, b) => a[1].parsed.mtime - b[1].parsed.mtime).slice(0, cache.size - maxFiles * 2)) cache.delete(path);
    agents.sort((a, b) => a.agent_id < b.agent_id ? -1 : a.agent_id > b.agent_id ? 1 : 0);
    return structuredClone({ agents, coverage, details });
  } };
}
