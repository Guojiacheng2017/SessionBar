import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import * as zlib from "node:zlib";
import { agentId, type AgentSummary, type Lifecycle, type Message, type Status, type WorkflowEvent } from "../shared/agentContract.js";
import type { SessionPayload } from "../shared/types.js";
import type { CollectedAgentDetail, CollectedAgents } from "./agentCollector.js";
import type { NativeExecutionEvent } from "../shared/executionTrace.js";

export interface DeepSeekAgentCollectorOptions {
  root: string;
  sourceId: string;
  windowMs?: number;
  activeMs?: number;
  maxFiles?: number;
  maxBytes?: number;
}
type Json = Record<string, unknown>;
type Mode = "continuable" | "one-shot" | "external" | "unknown";
interface Child { id: string; createdAt: number; mode: Mode; label: string | null }
interface Checkpoint {
  id: string; createdAt: number; cwd: string; seeded: boolean; cut: number;
  child: boolean;
  descriptor: { mode: string; seq: number; label: string | null } | null;
  children: Child[]; members: Map<string, { name: string | null; provider: string | null; phase: string }>;
  open: boolean | null; questions: boolean; completedTurn: boolean | null; activeThrough: number | null;
  mtime: number;
}
interface Cached<T> { stamp: string; mtime: number; value: T }
interface Read<T> { value: T | null; uncertain: boolean; unsupported?: boolean }
interface Transcript { detail: CollectedAgentDetail; provider: string | null; parent: string | null; scope: string }
const MAX_ITEMS = 500;
const ID = /^[\w-]{1,256}$/;
const object = (value: unknown): Json | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : null;
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const text = (value: unknown, limit = 256): string | null => typeof value === "string" && value.trim() ? value.trim().slice(0, limit) : null;
const nativeId = (value: unknown): value is string => typeof value === "string" && ID.test(value);
function row(rows: Json, key: string, version: number): Json | null {
  const entry = object(rows[key]);
  return entry?.ver === version && count(entry.seq) ? object(entry.val) : null;
}
function unavailable(availability: "unknown" | "unsupported" = "unknown"): CollectedAgentDetail {
  return {
    conversation: { availability, items: [], truncated_before: false },
    workflow: { availability, items: [], truncated_before: false },
    workflow_graph: { availability: "unsupported", graph: null },
  };
}

/** Installed DSH: checkpoint v7 / Session v4; catalog v6 is parent-owned and
 * excludes the inherited prefix. Team membership alone does not prove parentage. */
function parseCheckpoint(value: unknown, id: string, mtime: number): Checkpoint | null {
  const document = object(value), record = object(document?.record), identity = object(record?.identity), rows = object(record?.rows);
  if (document?.version !== 7 || identity?.formatVersion !== 4 || !rows || !count(identity.createdAt)
    || typeof identity.cwd !== "string" || !isAbsolute(identity.cwd) || typeof identity.isSeeded !== "boolean"
    || !count(identity.inheritedEventCount) || (!identity.isSeeded && identity.inheritedEventCount !== 0)) return null;
  const cut = identity.inheritedEventCount;
  const descriptorValue = object(row(rows, "subagent", 2)?.identity);
  const descriptor = descriptorValue && ["continuable", "one-shot"].includes(String(descriptorValue.mode))
    && count(descriptorValue.seq) && descriptorValue.seq >= cut
    ? { mode: String(descriptorValue.mode), seq: descriptorValue.seq, label: text(descriptorValue.label) } : null;
  const children: Child[] = [];
  const catalog = row(rows, "subagentCatalog", 6);
  if (catalog?.inheritedEventCount === cut) {
    let chunk = object(catalog.head);
    const chunks: unknown[][] = [];
    let valid = catalog.head === undefined || chunk !== null;
    for (let n = 0; chunk && n < 512; n++) {
      if (!Array.isArray(chunk.values) || !chunk.values.length || chunk.values.length > 64) { valid = false; break; }
      chunks.push(chunk.values);
      if (chunk.previous === undefined) { chunk = null; break; }
      chunk = object(chunk.previous);
      if (!chunk) valid = false;
    }
    if (chunk) valid = false;
    if (valid) for (const item of chunks.reverse().flat()) {
      const entry = object(item);
      if (!entry || !nativeId(entry.childId) || !count(entry.childCreatedAt)) continue;
      const supported = (entry.version === 0 || entry.version === 1) && ["one-shot", "continuable"].includes(String(entry.mode));
      if (!supported && !(entry.version === 1 && entry.mode === "unknown") && !(entry.version === 2 && entry.mode === "external")) continue;
      if (entry.mode === "continuable" && typeof entry.label !== "string") continue;
      children.push({ id: entry.childId, createdAt: entry.childCreatedAt, mode: entry.mode as Mode, label: text(entry.label) });
    }
  }
  const members = new Map<string, { name: string | null; provider: string | null; phase: string }>();
  const team = row(rows, "agentTeam", 4);
  if (team?.id === id && Array.isArray(team.members)) for (const item of team.members) {
    const member = object(item);
    if (member && nativeId(member.id) && ["provisioning", "active", "failed"].includes(String(member.phase))) {
      members.set(member.id, { name: text(member.name), provider: text(member.provider), phase: String(member.phase) });
    }
  }
  const boundary = row(rows, "turnBoundary", 2), questions = row(rows, "userQuestions", 2), timing = row(rows, "subagentTiming", 3);
  const active = object(timing?.active);
  const questionList = object(questions?.questions)?.active;
  return {
    id, createdAt: identity.createdAt, cwd: identity.cwd, seeded: identity.isSeeded, cut, child: descriptorValue !== null, descriptor, children, members,
    open: boundary?.openTurnStartSeq === null ? false : count(boundary?.openTurnStartSeq) ? true : null,
    questions: questions?.inheritedEventCount === cut && Array.isArray(questionList) && questionList.length > 0,
    completedTurn: timing?.descriptorSeen === true && typeof timing.lastTurnCompleted === "boolean" ? timing.lastTurnCompleted : null,
    activeThrough: timing?.descriptorSeen === true && count(active?.through) ? active.through : null, mtime,
  };
}

// DSH's projectKey is deliberately readable/lossy; the log header must also
// match cwd + id + createdAt before any conversation is exposed.
function projectKey(cwd: string): string {
  let value = "", separators = false;
  for (let i = 0; i < cwd.length; i++) {
    const ch = cwd[i]!;
    if (/[\\/:]/.test(ch)) { if (!separators) value += "-"; separators = true; }
    else { value += /^[A-Za-z0-9._-]$/.test(ch) ? ch : `~${cwd.charCodeAt(i).toString(16).toUpperCase().padStart(4, "0")}`; separators = false; }
  }
  return `--${(value.replace(/^-+/, "") || "root").slice(0, 251)}--`;
}

/** DSH appends independently compressed frames. Node's one-shot decoder only
 * consumes the first frame; locate each complete frame and ignore a torn tail. */
function zstdFrames(bytes: Buffer): { frames: Buffer[]; torn: boolean } {
  const frames: Buffer[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const start = offset;
    if (bytes.length - offset < 5) return { frames, torn: true };
    if (bytes.readUInt32LE(offset) !== 0xfd2fb528) throw new Error("Invalid Zstandard frame");
    const descriptor = bytes[offset + 4]!;
    if (descriptor & 24) throw new Error("Unsupported Zstandard header");
    const single = !!(descriptor & 32), flag = descriptor >>> 6, dictionary = descriptor & 3;
    offset += 5 + (single ? 0 : 1) + (dictionary === 3 ? 4 : dictionary) + (flag === 0 ? single ? 1 : 0 : 1 << flag);
    if (offset > bytes.length) return { frames, torn: true };
    for (;;) {
      if (bytes.length - offset < 3) return { frames, torn: true };
      const block = bytes.readUIntLE(offset, 3), type = block >>> 1 & 3;
      if (type === 3) throw new Error("Unsupported Zstandard block");
      offset += 3 + (type === 1 ? 1 : block >>> 3);
      if (offset > bytes.length) return { frames, torn: true };
      if (block & 1) break;
    }
    if (descriptor & 4) offset += 4;
    if (offset > bytes.length) return { frames, torn: true };
    frames.push(bytes.subarray(start, offset));
  }
  return { frames, torn: false };
}
async function decompress(bytes: Buffer, maxBytes: number): Promise<{ bytes: Buffer; torn: boolean }> {
  // Optional at runtime: older Node versions can still provide the roster.
  const decode = (zlib as typeof zlib & { zstdDecompress?: typeof zlib.zstdDecompress }).zstdDecompress;
  if (!decode) throw new Error("Zstandard is unavailable");
  const { frames, torn } = zstdFrames(bytes);
  const chunks: Buffer[] = [];
  let size = 0;
  for (const frame of frames) {
    if (size >= maxBytes) throw new Error("Decoded log limit exceeded");
    const chunk = await new Promise<Buffer>((accept, reject) => decode(frame, { maxOutputLength: maxBytes - size }, (error, output) => error ? reject(error) : accept(output)));
    chunks.push(chunk); size += chunk.length;
  }
  return { bytes: Buffer.concat(chunks, size), torn };
}
function parseTranscript(bytes: Buffer, cp: Checkpoint, torn: boolean): Transcript | null {
  const source = bytes.toString("utf8");
  // Never promote a partial JSON record. Complete earlier frames remain usable.
  const lines = source.slice(0, source.lastIndexOf("\n") + 1).split("\n").filter(Boolean);
  const header = object(JSON.parse(lines.shift() ?? "null"));
  if (header?.type !== "session" || header.version !== 4 || header.id !== cp.id || header.cwd !== cp.cwd
    || header.createdAt !== cp.createdAt || header.isSeeded !== cp.seeded || !count(header.delegationDepth)) return null;
  const events: Json[] = lines.map(line => {
    const event = object(JSON.parse(line));
    if (!event) throw new Error("Invalid event");
    return event;
  });
  let lastCut: number | null = null;
  for (const [index, event] of events.entries()) {
    if (event.seq !== index || !count(event.time) || typeof event.type !== "string" || !object(event.data)) return null;
    if (event.type === "session/end-seed" && object(event.data)?.inherited === true) lastCut = index;
  }
  if (cp.seeded ? lastCut !== cp.cut : lastCut !== null || cp.cut !== 0) return null;
  if (cp.descriptor && !events.some(event => event.seq === cp.descriptor!.seq && event.type === "subagent/descriptor"
    && object(event.data)?.version === 3 && object(event.data)?.mode === cp.descriptor!.mode)) return null;
  const messages: Message[] = [], workflow: WorkflowEvent[] = [];
  const execution: NativeExecutionEvent[] = [];
  let provider: string | null = null;
  const names = new Map<string, string>();
  for (const event of events) {
    const sequence = event.seq as number;
    if (sequence < cp.cut) continue;
    const data = object(event.data)!;
    if (event.type === "subagent/descriptor" && data.version === 3 && sequence === cp.descriptor?.seq) provider = text(data.provider);
    // Human transcript: append-origin messages only. Replacement copies are
    // model-only; assistant stream/attempt, reasoning and tool blocks stay private.
    if (event.surfaceOp === "append" && (event.type === "user/message" || event.type === "assistant/message")) {
      const role = event.type === "user/message" ? "user" : "assistant";
      const message = role === "user" ? data : object(data.message);
      const origin = object(message?.source);
      if (message?.role === role && text(message.id) && origin?.kind === (role === "user" ? "user" : "model") && Array.isArray(message.content)) {
        const body = message.content.flatMap(part => {
          const block = object(part);
          return block?.type === "text" && typeof block.text === "string" ? [block.text] : [];
        }).join("\n");
        if (body.trim()) messages.push({ message_id: `dsh-message:${sequence}`, sequence, role, text: body.slice(0, 16000),
          content_state: body.length > 16000 ? "truncated" : "complete", occurred_at: event.time as number });
      }
      if (role === "assistant" && Array.isArray(message?.content)) for (const part of message.content) {
        const block = object(part);
        if (block?.type === "tool-call" && text(block.id) && text(block.name)) names.set(String(block.id), text(block.name)!);
      }
    }
    let stage: string | null = null, label = "";
    if (event.type === "turn/start") { stage = "turn.start"; label = "Turn started"; }
    if (event.type === "turn/end") { stage = object(data.reason)?.kind === "completed" ? "turn.complete" : "turn.interrupted"; label = stage === "turn.complete" ? "Turn completed" : "Turn interrupted"; }
    if (event.type === "step/start") { stage = "step.start"; label = "Step started"; }
    if (event.type === "step/end") { stage = "step.complete"; label = "Step ended"; }
    if (event.type === "tool/call") { stage = "tool.start"; label = names.get(String(data.callId)) ?? "Tool started"; }
    if (event.type === "tool/result" && event.surfaceOp === "append") { stage = "tool.complete"; label = names.get(String(object(object(data.message)?.source)?.callId)) ?? "Tool completed"; }
    if (stage) workflow.push({ event_id: `dsh-event:${sequence}`, sequence, stage, label, occurred_at: event.time as number });
    const callId = event.type === "tool/call" ? text(data.callId) : event.type === "tool/result" && event.surfaceOp === "append" ? text(object(object(data.message)?.source)?.callId) : null;
    if (callId) execution.push({ event_id: `dsh:${sequence}`, sequence, at: event.time as number,
      kind: event.type === "tool/call" ? "call.start" : "call.end", call_id: callId,
      label: names.get(callId) ?? "Tool", ...(event.type === "tool/result" ? { outcome: "completed" as const } : {}) });
  }
  return { provider, parent: text(header.parentSession), scope: transcriptScope(cp), detail: torn || !source.endsWith("\n") ? unavailable() : {
    conversation: { availability: "available", items: messages.slice(-MAX_ITEMS), truncated_before: messages.length > MAX_ITEMS },
    workflow: { availability: "available", items: workflow.slice(-MAX_ITEMS), truncated_before: workflow.length > MAX_ITEMS },
    workflow_graph: { availability: "unsupported", graph: null },
    execution: { events: execution.slice(-1024), truncated_before: workflow.length > MAX_ITEMS },
  } };
}
function transcriptScope(cp: Checkpoint): string {
  return JSON.stringify([cp.id, cp.createdAt, cp.cwd, cp.seeded, cp.cut, cp.descriptor?.seq ?? null]);
}

export function createDeepSeekAgentCollector(options: DeepSeekAgentCollectorOptions) {
  const root = resolve(options.root), windowMs = options.windowMs ?? 7 * 24 * 3600_000, activeMs = options.activeMs ?? 30_000;
  const maxFiles = Math.max(1, Math.min(1000, options.maxFiles ?? 80)), maxBytes = Math.max(1, options.maxBytes ?? 4 * 1024 * 1024);
  const checkpoints = new Map<string, Cached<Checkpoint>>(), transcripts = new Map<string, Cached<Transcript>>();

  async function read<T>(file: string, cache: Map<string, Cached<T>>, now: number, parse: (bytes: Buffer, mtime: number) => Promise<T | null>, limit = maxBytes): Promise<Read<T>> {
    const previous = cache.get(file);
    try {
      // Refuse linked files and directory escapes, including intermediate links.
      const local = relative(root, file);
      if (local.startsWith(`..${sep}`) || isAbsolute(local)) return { value: null, uncertain: true };
      let directory = root;
      for (const segment of ["", ...relative(root, dirname(file)).split(sep).filter(Boolean)]) {
        if (segment) directory = join(directory, segment);
        const info = await lstat(directory);
        if (!info.isDirectory() || info.isSymbolicLink()) { cache.delete(file); return { value: null, uncertain: true }; }
      }
      const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const before = await handle.stat(), stamp = `${before.ino}:${before.size}:${before.mtimeMs}`;
        if (!before.isFile() || before.size > limit || before.mtimeMs > now + 1000 || now - before.mtimeMs > windowMs) {
          cache.delete(file); return { value: null, uncertain: true };
        }
        if (previous?.stamp === stamp) return { value: previous.value, uncertain: false };
        const bytes = Buffer.alloc(before.size);
        let offset = 0;
        while (offset < bytes.length) {
          const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
          if (!bytesRead) throw new Error("Incomplete read");
          offset += bytesRead;
        }
        const after = await handle.stat();
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error("Changing file");
        const value = await parse(bytes, Math.floor(before.mtimeMs));
        if (!value) { cache.delete(file); return { value: null, uncertain: false, unsupported: true }; }
        cache.set(file, { stamp, mtime: before.mtimeMs, value });
        return { value, uncertain: false };
      } finally { await handle.close(); }
    } catch (error) {
      if (["ENOENT", "ENOTDIR", "ELOOP"].includes(String((error as NodeJS.ErrnoException).code))) {
        cache.delete(file); return { value: null, uncertain: true };
      }
      if (previous && now - previous.mtime <= windowMs) return { value: previous.value, uncertain: true };
      cache.delete(file); return { value: null, uncertain: true };
    }
  }

  return {
    async collect(sessions: readonly SessionPayload[], now = Date.now()): Promise<CollectedAgents> {
      const result: CollectedAgents = { agents: [], coverage: {}, details: new Map() };
      const visited = new Set<string>(), memo = new Map<string, Read<Checkpoint>>();
      let reads = 0;
      const checkpoint = async (id: string): Promise<Read<Checkpoint>> => {
        const known = memo.get(id);
        if (known) return known;
        if (++reads > maxFiles) return { value: null, uncertain: true };
        const file = join(root, "storages", "session_projcache", "sessions", `${id}.json`);
        visited.add(file);
        const value = await read(file, checkpoints, now, async (bytes, mtime) => parseCheckpoint(JSON.parse(bytes.toString("utf8")), id, mtime), Math.min(maxBytes, 2 * 1024 * 1024));
        memo.set(id, value); return value;
      };
      for (const session of sessions) {
        result.coverage[session.session_id] = "unsupported";
        if (session.origin === "remote" || !["deepseek harness", "dsh"].includes(session.session_type.toLowerCase())) continue;
        result.coverage[session.session_id] = "unknown";
        const suffix = `__${session.project}`;
        const id = session.session_id.startsWith("dsh-") && session.session_id.endsWith(suffix) ? session.session_id.slice(4, -suffix.length) : null;
        if (!nativeId(id)) continue;
        const rootRead = await checkpoint(id), primary = rootRead.value;
        if (!primary || primary.cwd !== session.project_path || primary.child) {
          if (rootRead.unsupported) result.coverage[session.session_id] = "unsupported";
          continue;
        }
        result.coverage[session.session_id] = "partial";
        type Node = { entry: Child; parent: string | null; cp: Checkpoint | null; uncertain: boolean };
        const nodes = new Map<string, Node>([[id, { entry: { id, createdAt: primary.createdAt, mode: "continuable", label: session.session_name ?? null }, parent: null, cp: primary, uncertain: rootRead.uncertain }]]);
        const conflicting = new Set<string>();
        const queue = [id];
        for (let index = 0; index < queue.length && index < maxFiles; index++) {
          const parentId = queue[index]!, parent = nodes.get(parentId)!;
          for (const child of parent.cp?.children ?? []) {
            if (child.id === id) { if (parentId !== id) conflicting.add(parentId); continue; }
            if (nodes.size >= maxFiles && !nodes.has(child.id)) break;
            const existing = nodes.get(child.id);
            if (existing) {
              if (existing.parent !== parentId || existing.entry.createdAt !== child.createdAt) conflicting.add(child.id);
              continue;
            }
            const observed = child.mode === "external" ? { value: null, uncertain: false } : await checkpoint(child.id);
            const cp = observed.value;
            if (cp && cp.createdAt !== child.createdAt) continue;
            if (cp && (!cp.descriptor || cp.descriptor.mode !== child.mode)) continue;
            if (!cp && now - child.createdAt > windowMs) continue;
            nodes.set(child.id, { entry: child, parent: parentId, cp, uncertain: parent.uncertain || observed.uncertain });
            queue.push(child.id);
          }
        }
        const accepted = new Map<string, AgentSummary>();
        const bad = (node: Node): boolean => {
          const seen = new Set<string>();
          for (let current: Node | undefined = node; current; current = current.parent ? nodes.get(current.parent) : undefined) {
            if (conflicting.has(current.entry.id) || seen.has(current.entry.id)) return true;
            seen.add(current.entry.id);
          }
          return false;
        };
        for (const native of queue) {
          const node = nodes.get(native)!;
          if (bad(node) || (node.parent && !accepted.has(node.parent))) continue;
          const cp = node.cp, rootNode = node.parent === null;
          const identity = { source_id: options.sourceId, session_id: session.session_id, native_agent_id: native, generation: String(node.entry.createdAt) };
          const member = primary.members.get(native);
          let status: Status = "unknown", lifecycle: Lifecycle = "unknown";
          if (cp && !node.uncertain) {
            const recent = now - cp.mtime <= activeMs;
            status = recent && cp.questions ? "blocked" : recent && cp.open === true ? "working" : cp.open === false || cp.completedTurn !== null ? "idle" : "unknown";
            lifecycle = "active";
            if (node.entry.mode === "one-shot" && cp.completedTurn === true && cp.open === false) { lifecycle = "completed"; status = "idle"; }
            if (!recent && cp.open === true) status = "unknown";
          }
          if (member?.phase === "failed" && !node.uncertain) { status = "error"; lifecycle = "failed"; }
          let detail = unavailable(node.entry.mode === "external" || node.entry.mode === "unknown" ? "unsupported" : "unknown");
          let provider = member?.provider ?? null;
          if (cp && (!node.parent || cp.descriptor)) {
            const file = join(root, "sessions", projectKey(cp.cwd), native, "session.v4.jsonl.zstd");
            visited.add(file);
            const transcript = await read(file, transcripts, now, async bytes => {
              const decoded = await decompress(bytes, maxBytes);
              return parseTranscript(decoded.bytes, cp, decoded.torn);
            });
            if (transcript.value && transcript.value.scope === transcriptScope(cp) && (!node.parent || transcript.value.parent === node.parent)) {
              detail = structuredClone(transcript.value.detail); provider = transcript.value.provider ?? provider;
              if (transcript.uncertain || node.uncertain) detail = unavailable();
            }
          }
          const agent: AgentSummary = {
            agent_id: agentId(identity), identity, role: rootNode ? "primary" : "subagent", parent_agent_id: node.parent ? accepted.get(node.parent)!.agent_id : null,
            name: text(member?.name) ?? cp?.descriptor?.label ?? node.entry.label ?? (rootNode ? "DeepSeek Harness" : "Subagent"),
            provider_id: provider, avatar: null, status, lifecycle, updated_at: cp?.mtime ?? Math.min(now, node.entry.createdAt),
          };
          accepted.set(native, agent); result.agents.push(agent); result.details.set(agent.agent_id, detail);
        }
      }
      for (const cache of [checkpoints, transcripts]) for (const file of cache.keys()) if (!visited.has(file)) cache.delete(file);
      return structuredClone(result);
    },
  };
}
