import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SessionPayload } from "../shared/types.js";
import { codexBackgroundService, codexNativeSource, CODEX_USER_SOURCES, type CodexBackgroundService } from "../shared/codexServices.js";
import { writePrivateState } from "../shared/privateState.js";
import { codexSessionNativeId } from "./codexRecoveredSessions.js";
import { classifyCodexSession, createCodexDesktopOriginsReader } from "./codexSessionOrigins.js";
import { createCodexPredictionOriginsReader } from "./codexPredictionOrigins.js";

interface Origin { threadId: string; service: CodexBackgroundService; observedAt: number }
interface Options {
  cachePath?: string;
  predictionCachePath?: string;
  nativeDbPath?: string;
  sqlitePath?: string;
  readDesktop?: (now: number) => ReadonlyMap<string, string>;
  readPredictions?: (now: number) => ReadonlyMap<string, string>;
}
const RETAIN_MS = 24 * 60 * 60 * 1000;
const MAX_ORIGINS = 512;

/** Exact IDs only: native source enums can identify services omitted by thread/list. */
function readNativeSources(ids: readonly string[], path: string, sqlitePath: string): Map<string, string> {
  const sources = new Map<string, string>();
  const nativeIds = [...new Set(ids.map(codexSessionNativeId).filter((id): id is string => !!id))].slice(0, 128);
  if (!nativeIds.length || !existsSync(path)) return sources;
  try {
    const json = execFileSync(sqlitePath, ["-readonly", "-batch", "-json", "-cmd", ".timeout 50", path,
      `PRAGMA query_only=ON; SELECT id, source FROM threads WHERE id IN (${nativeIds.map(id => `'${id}'`).join(",")}) LIMIT 128;`,
    ], { encoding: "utf8", timeout: 1000, maxBuffer: 128 * 1024, stdio: ["ignore", "pipe", "ignore"] });
    const rows: unknown = JSON.parse(json);
    if (Array.isArray(rows)) for (const row of rows) {
      const id = typeof row?.id === "string" ? codexSessionNativeId(row.id) : undefined;
      const source = codexNativeSource(row?.source);
      if (id && source && (codexBackgroundService(source) || CODEX_USER_SOURCES.has(source))) sources.set(id, source);
    }
  } catch { /* Optional native schema/binary/DB may be unavailable. */ }
  return sources;
}

/** One persistent classification path for native services, MCP hosts and predictions.
 * Stores only native IDs, service enums and observation times; never creates sessions. */
export function createCodexServiceOrigins(options: Options = {}) {
  const stateHome = process.env.SESSIONBAR_HOME || process.env.AGENTBAR_HOME || join(homedir(), ".sessionbar");
  const cachePath = options.cachePath ?? join(stateHome, "codex-service-origins.json");
  const readDesktop = options.readDesktop ?? createCodexDesktopOriginsReader();
  const readPredictions = options.readPredictions ?? createCodexPredictionOriginsReader({ cachePath: options.predictionCachePath });
  const nativeDb = options.nativeDbPath ?? join(process.env.CODEX_HOME || join(homedir(), ".codex"), "state_5.sqlite");
  const entries = new Map<string, Origin>();
  let loaded = false;
  let saved = "";
  let lastNativeRead = -Infinity;
  let lastNativeIds = "";
  let nativeSources = new Map<string, string>();

  function load(now: number): void {
    if (!loaded) {
      loaded = true;
      try {
        if (statSync(cachePath).size <= 128 * 1024) {
          const data = JSON.parse(readFileSync(cachePath, "utf8"));
          if (data?.version === 1 && Array.isArray(data.entries)) {
            for (const entry of data.entries.slice(-MAX_ORIGINS)) {
              const id = typeof entry?.threadId === "string" ? codexSessionNativeId(entry.threadId) : undefined;
              const service = codexBackgroundService(entry?.service);
              if (id && service && Number.isFinite(entry.observedAt)) entries.set(id, { threadId: id, service, observedAt: entry.observedAt });
            }
          }
        }
      } catch { /* Optional SessionBar-owned provenance cache. */ }
      saved = JSON.stringify({ version: 1, entries: [...entries.values()] });
    }
    for (const [id, entry] of entries) if (entry.observedAt > now || now - entry.observedAt > RETAIN_MS) entries.delete(id);
  }

  function observe(threadId: string, source: unknown, now = Date.now()): void {
    if (!Number.isFinite(now)) return;
    load(now);
    const id = codexSessionNativeId(threadId);
    const service = codexBackgroundService(source);
    if (id && service && entries.get(id)?.service !== service) entries.set(id, { threadId: id, service, observedAt: now });
  }

  function classify(sessions: readonly SessionPayload[], now = Date.now()): void {
    if (!Number.isFinite(now)) return;
    load(now);
    for (const [id, service] of [...readPredictions(now), ...readDesktop(now)]) observe(id, service, now);
    const unresolved = sessions.filter(session => session.origin !== "remote" && session.session_type.toLowerCase() === "codex"
      && !codexBackgroundService(session.session_source) && !CODEX_USER_SOURCES.has(session.session_source || ""))
      .map(session => session.session_id);
    const nativeKey = [...new Set(unresolved)].sort().join("\n");
    if (nativeKey !== lastNativeIds || now - lastNativeRead >= 5000) {
      nativeSources = readNativeSources(unresolved, nativeDb, options.sqlitePath ?? "sqlite3");
      lastNativeIds = nativeKey;
      lastNativeRead = now;
    }
    const origins = new Map([...entries].map(([id, entry]) => [id, entry.service]));
    for (const session of sessions) {
      if (session.origin === "remote" || session.session_type.toLowerCase() !== "codex") continue;
      const nativeId = codexSessionNativeId(session.session_id);
      if (!codexBackgroundService(session.session_source) && !CODEX_USER_SOURCES.has(session.session_source || "")
        && nativeId && nativeSources.has(nativeId)) session.session_source = nativeSources.get(nativeId);
      classifyCodexSession(session, origins);
      const id = codexSessionNativeId(session.session_id);
      if (!id) continue;
      if (session.session_source && CODEX_USER_SOURCES.has(session.session_source)) entries.delete(id);
      else if (session.session_service) observe(id, session.session_service, now);
    }
    const retained = [...entries.values()].sort((a, b) => a.observedAt - b.observedAt).slice(-MAX_ORIGINS);
    entries.clear();
    for (const entry of retained) entries.set(entry.threadId, entry);
    const serialized = JSON.stringify({ version: 1, entries: retained });
    if (serialized !== saved) {
      try { writePrivateState(cachePath, serialized); saved = serialized; } catch { /* In-memory classification still works with read-only state. */ }
    }
  }
  return { observe, classify };
}
