import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, renameSync, statSync, writeSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { NativeExecutionEvent } from "../shared/executionTrace.js";
import { ensurePrivateDirectory } from "../shared/privateState.js";

type Json = Record<string, unknown>;
const object = (v: unknown): Json | undefined => v && typeof v === "object" && !Array.isArray(v) ? v as Json : undefined;
const uuid = (v: unknown): string | undefined => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) ? v.toLowerCase() : undefined;
const clock = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= 8.64e15;
const ids = (v: unknown): string[] | undefined => Array.isArray(v) && v.length > 0 && v.length <= 128 && v.every(id => uuid(id)) ? [...new Set(v.map(id => uuid(id)!))] : undefined;
const schema = "sessionbar.codex-hooks.v1";
const safeOpen = (file: string, flags: number, mode?: number) => openSync(file, flags | (constants.O_NOFOLLOW ?? 0) | constants.O_NONBLOCK, mode);
const scope = (id: string, info: { dev: number; ino: number }) => `codex-hooks:${id}:${info.dev}:${info.ino}`;

/** The hook's transcript is authoritative; CODEX_THREAD_ID can be inherited from an unrelated caller. */
export function captureCodexHook(options: { root: string; sessionsRoot: string; raw: unknown; now: number }): boolean {
  let transcript: number | undefined, output: number | undefined;
  try {
    const raw = object(options.raw), rootId = uuid(raw?.session_id), turnId = uuid(raw?.turn_id);
    const kind = raw?.hook_event_name === "PreToolUse" ? "wait.start" : raw?.hook_event_name === "Stop" ? "turn.end" : raw?.hook_event_name === "SessionEnd" ? "session.end" : undefined;
    if (!raw || !rootId || !kind || !clock(options.now) || typeof raw.cwd !== "string" || !isAbsolute(raw.cwd)
      || typeof raw.transcript_path !== "string" || !isAbsolute(raw.transcript_path)) return false;
    const input = object(raw.tool_input), tool = typeof raw.tool_name === "string" ? raw.tool_name.toLowerCase().replace(/[^a-z0-9]/g, "") : "";
    const targets = ids(input?.targets), callId = raw.tool_use_id;
    if (kind === "wait.start" && (!turnId || !["wait", "waitagent", "multiagentv1waitagent", "collaborationwaitagent"].includes(tool)
      || typeof callId !== "string" || !/^[A-Za-z0-9:_-]{1,128}$/.test(callId))) return false;
    const actual = realpathSync(raw.transcript_path), sessions = realpathSync(options.sessionsRoot), path = relative(sessions, actual);
    if (!path || path.startsWith("..") || isAbsolute(path) || !actual.endsWith(".jsonl")) return false;
    transcript = safeOpen(raw.transcript_path, constants.O_RDONLY);
    if (!fstatSync(transcript).isFile()) return false;
    const bytes = Buffer.alloc(64 * 1024), size = readSync(transcript, bytes, 0, bytes.length, 0), newline = bytes.subarray(0, size).indexOf(10);
    if (newline < 0) return false;
    const header = object(JSON.parse(bytes.subarray(0, newline).toString("utf8"))), meta = object(header?.payload), nativeId = uuid(meta?.id);
    if (header?.type !== "session_meta" || !nativeId || typeof meta?.cwd !== "string" || resolve(meta.cwd) !== resolve(raw.cwd)
      || (raw.agent_id != null && uuid(raw.agent_id) !== nativeId) || targets?.includes(nativeId)) return false;
    const parent = uuid(object(object(object(meta?.source)?.subagent)?.thread_spawn)?.parent_thread_id);
    if (nativeId !== rootId && !parent) return false;
    ensurePrivateDirectory(options.root);
    const file = join(options.root, `${nativeId}.jsonl`);
    // Terminal notifications have nothing to close if this owner never captured a wait.
    if (kind !== "wait.start") { try { output = safeOpen(file, constants.O_WRONLY | constants.O_APPEND); } catch { return false; } }
    else output = safeOpen(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT, 0o600);
    if (!fstatSync(output).isFile()) return false;
    if (fstatSync(output).size >= 4 * 1024 * 1024) {
      closeSync(output); output = undefined; renameSync(file, `${file}.previous`);
      output = safeOpen(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_EXCL, 0o600);
    }
    writeSync(output, JSON.stringify({ schema_version: schema, kind, native_id: nativeId, root_native_id: rootId, cwd: resolve(raw.cwd), at: options.now,
      ...(turnId ? { turn_id: turnId } : {}), ...(kind === "wait.start" ? { call_id: callId, ...(targets ? { targets } : {}) } : {}) }) + "\n");
    return true;
  } catch { return false; }
  finally { if (transcript !== undefined) closeSync(transcript); if (output !== undefined) closeSync(output); }
}

export function readCodexHooks(options: { root: string; nativeId: string; rootNativeId: string; cwd: string; now: number; maxBytes?: number }): {
  events: NativeExecutionEvent[]; pending: { event: NativeExecutionEvent; turnId: string }[]; closed_scopes: string[]; truncated_before: boolean; notes: string[];
} | null {
  let fd: number | undefined;
  try {
    const nativeId = uuid(options.nativeId), rootId = uuid(options.rootNativeId); if (!nativeId || !rootId || !isAbsolute(options.cwd)) return null;
    const file = join(options.root, `${nativeId}.jsonl`); fd = safeOpen(file, constants.O_RDONLY); const info = fstatSync(fd); if (!info.isFile()) return null;
    const maxBytes = Math.min(2 * 1024 * 1024, Math.max(1024, options.maxBytes ?? 256 * 1024));
    const offset = Math.max(0, info.size - maxBytes), bytes = Buffer.alloc(Math.min(info.size, maxBytes)), size = readSync(fd, bytes, 0, bytes.length, offset);
    let cursor = offset ? bytes.indexOf(10) + 1 : 0; if (offset && cursor === 0) return null;
    const events: NativeExecutionEvent[] = [], pending = new Map<string, { event: NativeExecutionEvent; turnId: string }>(), captureScope = scope(nativeId, info);
    let found = false, closed = false;
    while (cursor < size) {
      const end = bytes.indexOf(10, cursor); if (end < 0 || end >= size) break;
      try {
        const row = object(JSON.parse(bytes.subarray(cursor, end).toString("utf8")));
        if (row?.schema_version === schema && row.native_id === nativeId && row.root_native_id === rootId && typeof row.cwd === "string"
          && resolve(row.cwd) === resolve(options.cwd) && clock(row.at) && row.at <= options.now + 1000) {
          found = true;
          if (["turn.end", "session.end"].includes(String(row.kind))) { pending.clear(); closed = true; }
          const targets = ids(row.targets), turnId = uuid(row.turn_id);
          if (row.kind === "wait.start" && (row.targets === undefined || targets) && turnId && typeof row.call_id === "string" && /^[A-Za-z0-9:_-]{1,128}$/.test(row.call_id) && !targets?.includes(nativeId)) {
            const event: NativeExecutionEvent = { event_id: `hook:${info.dev}:${info.ino}:${offset + cursor}`, sequence: offset + cursor,
              cursor_scope: captureScope, kind: "call.start", at: row.at, label: "Native wait", call_id: row.call_id, ...(targets ? { wait_for_native_ids: targets } : {}) };
            events.push(event); pending.set(row.call_id, { event, turnId }); closed = false;
          }
        }
      } catch { /* Partial rows and private/unrecognized data never become execution events. */ }
      cursor = end + 1;
    }
    if (!found) return null;
    const closedScopes = closed ? [captureScope] : [];
    try { const old = statSync(`${file}.previous`, { throwIfNoEntry: false }); if (old?.isFile()) closedScopes.push(scope(nativeId, old)); } catch { /* No rotated source. */ }
    return { events: events.slice(-512), pending: [...pending.values()].slice(-512), closed_scopes: closedScopes, truncated_before: offset > 0 || events.length > 512,
      notes: ["Native waits are captured automatically by the existing Codex PreToolUse hook. Exact native call IDs join completed results; the request clock includes hook dispatch time. Missing explicit UUID targets remain unknown."] };
  } catch { return null; } finally { if (fd !== undefined) closeSync(fd); }
}
