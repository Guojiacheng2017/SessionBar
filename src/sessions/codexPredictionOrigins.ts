import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { writePrivateState } from "../shared/privateState.js";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const NATIVE_ID = new RegExp(`^${UUID}$`, "i");
const THREAD_ID = new RegExp(`\\bthread_id=(${UUID})(?:\\s|})`, "i");
const SAMPLE_REQUEST = new RegExp(`request_id=String\\("thread/sample:${UUID}"\\)`, "i");
const LINK_MS = 1000;
const RETAIN_MS = 24 * 60 * 60 * 1000;
const MAX_ORIGINS = 512;

interface NativeLogRow {
  id: number;
  ts: number;
  ts_nanos: number;
  target: string;
  message: string;
  thread_id: string | null;
  process_uuid: string;
}

interface PredictionOrigin {
  threadId: string;
  observedAt: number;
}

/** Match Desktop's resume -> sample -> unique child chain, within one native process.
 * Parent IDs, bare keywords and overlapping thread creation are never classified. */
export function correlateCodexPredictionOrigins(rows: readonly NativeLogRow[]): PredictionOrigin[] {
  const valid = rows.filter(row => Number.isSafeInteger(row.id) && Number.isFinite(row.ts)
    && Number.isFinite(row.ts_nanos) && row.ts_nanos >= 0 && row.ts_nanos < 1e9
    && typeof row.process_uuid === "string" && !!row.process_uuid
    && typeof row.message === "string");
  const at = (row: NativeLogRow) => row.ts * 1000 + row.ts_nanos / 1e6;
  const after = (row: NativeLogRow, before: NativeLogRow) => row.process_uuid === before.process_uuid
    && row.id > before.id && at(row) >= at(before) && at(row) - at(before) <= LINK_MS;
  const requests = valid.filter(row => row.target === "codex_app_server::message_processor"
    && /^app-server request: thread\/(?:sample|start|fork|resume)\b/.test(row.message));
  const resumes = valid.filter(row => row.target === "codex_app_server::request_processors::thread_lifecycle"
    && row.message.startsWith("composing running thread resume response thread_id=")
    && typeof row.thread_id === "string" && NATIVE_ID.test(row.thread_id));
  const spawns = new Map<string, NativeLogRow>();
  for (const row of [...valid].sort((a, b) => a.id - b.id)) {
    if (row.target !== "codex_models_manager::manager" || !row.message.startsWith('thread_spawn{otel.name="thread_spawn"}:session_init:apply_rollout_reconstruction{')) continue;
    const threadId = THREAD_ID.exec(row.message)?.[1]?.toLowerCase();
    if (!threadId || threadId !== row.thread_id?.toLowerCase()) continue;
    const key = `${row.process_uuid}:${threadId}`;
    if (!spawns.has(key)) spawns.set(key, row);
  }
  const origins: PredictionOrigin[] = [];
  for (const request of requests) {
    if (!request.message.startsWith("app-server request: thread/sample ") || !SAMPLE_REQUEST.test(request.message)) continue;
    const parents = resumes.filter(row => after(request, row));
    if (new Set(parents.map(row => row.thread_id)).size !== 1) continue;
    const children = [...spawns.values()].filter(row => after(row, request));
    if (children.length !== 1) continue;
    const child = children[0];
    if (child.thread_id === parents[0].thread_id) continue;
    // Prediction children have a fresh UUIDv7. A resumed older conversation isn't a child.
    if (child.thread_id?.[14] !== "7") continue;
    const createdAt = Number.parseInt(child.thread_id.replaceAll("-", "").slice(0, 12), 16);
    if (createdAt < at(request) || createdAt > at(child)) continue;
    // Another create/resume request or overlapping sample makes ownership ambiguous.
    if (requests.some(row => row.id !== request.id && (after(row, request) && row.id < child.id
      || row.message.startsWith("app-server request: thread/sample ") && after(child, row)))) continue;
    origins.push({ threadId: child.thread_id!.toLowerCase(), observedAt: at(child) });
  }
  return origins;
}

interface PredictionOriginsOptions {
  logsPath?: string;
  cachePath?: string;
  sqlitePath?: string;
}

/** Read only bounded native log metadata; cache IDs so log pruning/restarts don't erase evidence. */
export function createCodexPredictionOriginsReader(options: PredictionOriginsOptions = {}): (now?: number) => ReadonlyMap<string, string> {
  const logsPath = options.logsPath ?? join(process.env.CODEX_HOME || join(homedir(), ".codex"), "logs_2.sqlite");
  const cachePath = options.cachePath ?? join(process.env.SESSIONBAR_HOME || process.env.AGENTBAR_HOME || join(homedir(), ".sessionbar"), "codex-prediction-origins.json");
  let lastRead = -Infinity;
  let loaded = false;
  let entries: PredictionOrigin[] = [];
  let saved = "";
  let origins = new Map<string, string>();
  return (now = Date.now()) => {
    if (!Number.isFinite(now) || now - lastRead < 5000) return origins;
    lastRead = now;
    if (!loaded) {
      loaded = true;
      try {
        if (statSync(cachePath).size <= 128 * 1024) {
          const data = JSON.parse(readFileSync(cachePath, "utf8"));
          if (data?.version === 1 && Array.isArray(data.entries)) entries = data.entries.slice(-MAX_ORIGINS);
        }
      } catch { /* Optional SessionBar-owned metadata cache. */ }
      saved = JSON.stringify({ version: 1, entries });
    }
    try {
      const json = execFileSync(options.sqlitePath ?? "sqlite3", [
        "-readonly", "-batch", "-json", "-cmd", ".timeout 50", logsPath,
        `PRAGMA query_only=ON;
         SELECT id, ts, ts_nanos, target, feedback_log_body AS message, thread_id, process_uuid FROM logs
         WHERE ts BETWEEN ${Math.floor((now - 5 * 60 * 1000) / 1000)} AND ${Math.floor(now / 1000)}
           AND ((target = 'codex_app_server::message_processor' AND feedback_log_body LIKE 'app-server request: thread/%')
             OR (target = 'codex_app_server::request_processors::thread_lifecycle' AND feedback_log_body LIKE 'composing running thread resume response thread_id=%')
             OR (target = 'codex_models_manager::manager' AND feedback_log_body LIKE 'thread_spawn%:session_init:apply_rollout_reconstruction%'))
         ORDER BY id DESC LIMIT 1024;`,
      ], { encoding: "utf8", timeout: 1000, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
      const rows: unknown = JSON.parse(json);
      // Wait for the complete matching window before accepting a unique candidate.
      if (Array.isArray(rows)) entries.push(...correlateCodexPredictionOrigins(rows).filter(entry => entry.observedAt + LINK_MS <= now));
    } catch { /* Missing/locked optional native DB must not affect session reporting. */ }
    entries = [...new Map(entries.filter(entry => entry && typeof entry.threadId === "string" && NATIVE_ID.test(entry.threadId)
      && Number.isFinite(entry.observedAt) && entry.observedAt <= now && now - entry.observedAt <= RETAIN_MS)
      .map(entry => [entry.threadId.toLowerCase(), { threadId: entry.threadId.toLowerCase(), observedAt: entry.observedAt }])).values()]
      .sort((a, b) => a.observedAt - b.observedAt).slice(-MAX_ORIGINS);
    const serialized = JSON.stringify({ version: 1, entries });
    if (serialized !== saved) {
      try { writePrivateState(cachePath, serialized); saved = serialized; } catch { /* Keep in-memory evidence if state is read-only. */ }
    }
    origins = new Map(entries.map(entry => [entry.threadId, "composer_predictions"]));
    return origins;
  };
}
