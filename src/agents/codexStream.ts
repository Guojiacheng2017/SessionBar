import type { NativeExecutionEvent } from "../shared/executionTrace.js";
import { closeSync, constants, fstatSync, openSync, readSync, readdirSync, statSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import { ensurePrivateDirectory } from "../shared/privateState.js";
export interface CodexStreamOptions { root: string; cwd: string; streamId?: string }
type Json = Record<string, unknown>;
const object = (v: unknown): Json | undefined => v && typeof v === "object" && !Array.isArray(v) ? v as Json : undefined;
const uuid = (v: unknown): string | undefined => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) ? v.toLowerCase() : undefined;
const time = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= 8.64e15;
const ids = (v: unknown): string[] | undefined => Array.isArray(v) && v.length <= 128 && v.every(id => uuid(id)) ? [...new Set(v.map(id => uuid(id)!))] : undefined;
const schema = "sessionbar.codex-stream.v1";

/** Metadata-only tee for native JSON stdout / app-server notifications. */
export class CodexStreamRecorder {
  private readonly streamId: string;
  private readonly scopes = new Map<string, number>();
  private readonly requests = new Map<string, string[]>();
  private readonly heartbeat: ReturnType<typeof setInterval>;
  private closed = false;
  constructor(private readonly options: CodexStreamOptions) {
    this.streamId = uuid(options.streamId) ?? randomUUID();
    ensurePrivateDirectory(options.root);
    this.heartbeat = setInterval(() => { for (const fd of this.scopes.values()) { try { writeSync(fd, JSON.stringify({ kind: "heartbeat", at: Date.now() }) + "\n"); } catch { /* Reader freshness will become unknown. */ } } }, 5000);
    this.heartbeat.unref();
  }
  write(value: unknown, receivedAt = Date.now()): void {
    const message = object(value); if (this.closed || !message || !time(receivedAt)) return;
    const params = object(message.params), thread = object(params?.thread);
    const nativeId = message.type === "thread.started" ? uuid(message.thread_id) : message.method === "thread/started" ? uuid(thread?.id) : undefined;
    if (nativeId && !this.scopes.has(nativeId) && this.scopes.size < 128) {
      const cwd = message.method === "thread/started" && typeof thread?.cwd === "string" ? thread.cwd : this.options.cwd;
      if (!isAbsolute(cwd)) return;
      const fd = openSync(join(this.options.root, `${nativeId}.${this.streamId}.jsonl`), "wx", 0o600);
      writeSync(fd, JSON.stringify({ schema_version: schema, kind: "scope", native_id: nativeId, cwd: resolve(cwd), stream_id: this.streamId, captured_at: receivedAt }) + "\n");
      this.scopes.set(nativeId, fd);
    }
    const started = message.type === "item.started" || message.method === "item/started";
    const completed = message.type === "item.completed" || message.method === "item/completed";
    if (!started && !completed) return;
    const item = object(message.item) ?? object(params?.item);
    if (!item || !["collab_tool_call", "collabAgentToolCall"].includes(String(item.type)) || item.tool !== "wait") return;
    const owner = uuid(item.sender_thread_id ?? item.senderThreadId), itemId = item.id;
    if (!owner || !this.scopes.has(owner) || (params?.threadId !== undefined && params.threadId !== owner)
      || typeof itemId !== "string" || !/^[A-Za-z0-9:_-]{1,128}$/.test(itemId)) return;
    const references = ids(item.receiver_thread_ids ?? item.receiverThreadIds); if (!references) return;
    const callId = `codex-stream:${this.streamId}:${itemId}`, requestKey = `${owner}:${itemId}`;
    if (started && references.length) this.requests.set(requestKey, references);
    while (this.requests.size > 512) this.requests.delete(this.requests.keys().next().value!);
    const requested = this.requests.get(requestKey);
    const event = { kind: started ? "call.start" : "call.end", call_id: callId, at: time(message.emittedAtMs) ? message.emittedAtMs : receivedAt,
      ...(requested ? { wait_for_native_ids: requested } : {}),
      ...(completed ? { wait_result_native_ids: references, outcome: item.status === "failed" ? "failed" : "completed" } : {}) };
    writeSync(this.scopes.get(owner)!, JSON.stringify({ kind: "event", received_at: receivedAt, event }) + "\n");
    if (completed) this.requests.delete(requestKey);
  }
  close(): void {
    if (this.closed) return; this.closed = true; clearInterval(this.heartbeat);
    let failure: unknown;
    for (const fd of this.scopes.values()) { try { writeSync(fd, JSON.stringify({ kind: "closed" }) + "\n"); } catch (error) { failure = error; } finally { closeSync(fd); } }
    this.scopes.clear(); this.requests.clear(); if (failure) throw failure;
  }
}

/** Scope validation is independent of stream IDs; no body text is accepted. */
export async function readCodexStream(options: { root: string; nativeId: string; cwd: string; now: number; maxBytes?: number }): Promise<{ events: NativeExecutionEvent[]; truncated_before: boolean; notes: string[]; closed_scopes: string[] } | null> {
  const nativeId = uuid(options.nativeId); if (!nativeId || !isAbsolute(options.cwd)) return null;
  let files: { path: string; mtime: number }[] = [];
  try { files = readdirSync(options.root, { withFileTypes: true }).filter(entry => entry.isFile() && entry.name.startsWith(`${nativeId}.`) && entry.name.endsWith(".jsonl")).slice(0, 64)
    .flatMap(entry => { try { const path = join(options.root, entry.name); return [{ path, mtime: statSync(path).mtimeMs }]; } catch { return []; } }).sort((a, b) => b.mtime - a.mtime).slice(0, 8); } catch { return null; }
  const events: NativeExecutionEvent[] = [], closedScopes = new Set<string>(); let found = false, clipped = false;
  const maxBytes = Math.min(2 * 1024 * 1024, Math.max(1024, options.maxBytes ?? 256 * 1024));
  for (const candidate of files) {
    let fd: number | undefined;
    try {
      fd = openSync(candidate.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const info = fstatSync(fd); if (!info.isFile()) continue;
      const head = Buffer.alloc(Math.min(info.size, 8192)); const headSize = readSync(fd, head, 0, head.length, 0), newline = head.subarray(0, headSize).indexOf(10);
      if (newline < 0) continue;
      const header = object(JSON.parse(head.subarray(0, newline).toString("utf8"))), streamId = uuid(header?.stream_id);
      if (header?.schema_version !== schema || header.kind !== "scope" || header.native_id !== nativeId || !streamId || typeof header.cwd !== "string"
        || !isAbsolute(header.cwd) || resolve(header.cwd) !== resolve(options.cwd) || !time(header.captured_at) || header.captured_at > options.now + 1000) continue;
      found = true;
      let lastReceived = header.captured_at;
      const offset = Math.max(0, info.size - maxBytes), bytes = Buffer.alloc(Math.min(info.size, maxBytes)); const size = readSync(fd, bytes, 0, bytes.length, offset);
      clipped ||= offset > 0;
      let cursor = offset ? bytes.indexOf(10) + 1 : 0;
      if (offset && cursor === 0) continue;
      while (cursor < size) {
        const end = bytes.indexOf(10, cursor); if (end < 0 || end >= size) break;
        try {
          const row = object(JSON.parse(bytes.subarray(cursor, end).toString("utf8"))), event = object(row?.event);
          const received = row?.kind === "heartbeat" ? row.at : row?.received_at;
          if (time(received) && received <= options.now + 1000) lastReceived = Math.max(lastReceived, received);
          if (row?.kind === "closed") closedScopes.add(`codex-stream:${streamId}`);
          if (row?.kind === "event" && event && ["call.start", "call.end"].includes(String(event.kind)) && typeof event.call_id === "string"
            && event.call_id.startsWith(`codex-stream:${streamId}:`) && event.call_id.length <= 256 && time(event.at) && event.at <= options.now + 1000) {
            const requested = event.wait_for_native_ids === undefined ? undefined : ids(event.wait_for_native_ids), returned = event.wait_result_native_ids === undefined ? undefined : ids(event.wait_result_native_ids);
            if ((event.wait_for_native_ids === undefined || requested) && (event.wait_result_native_ids === undefined || returned)) events.push({
              event_id: `stream:${streamId}:${offset + cursor}`, sequence: offset + cursor, cursor_scope: `codex-stream:${streamId}`, at: event.at,
              kind: event.kind as "call.start" | "call.end", call_id: event.call_id, label: "Native wait",
              ...(requested ? { wait_for_native_ids: requested } : {}), ...(returned ? { wait_result_native_ids: returned } : {}),
              ...(event.kind === "call.end" ? { outcome: event.outcome === "failed" ? "failed" : "completed" } : {}),
            });
          }
        } catch { /* Partial or non-metadata rows never become events. */ }
        cursor = end + 1;
      }
      if (options.now - lastReceived > 30000) closedScopes.add(`codex-stream:${streamId}`);
    } catch { /* A changing capture remains a partial source. */ } finally { if (fd !== undefined) closeSync(fd); }
  }
  return found ? { events: events.slice(-1024), truncated_before: clipped || events.length > 1024, closed_scopes: [...closedScopes],
    notes: ["Wait request targets are captured from native item/started. Completed receiver IDs are returned results and never replace the request. Stream timestamps use the native emitter or local receiver clock."] } : null;
}
