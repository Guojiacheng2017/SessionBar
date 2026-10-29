import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync } from "fs";
import { execFileSync } from "node:child_process";
import { basename, dirname, join, win32 } from "path";
import { homedir } from "os";
import type { SessionPayload } from "../shared/types.js";

export interface WorkBuddyDesktopDiscoveryOptions {
  root?: string;
  now?: number;
  activeMs?: number;
  retentionMs?: number;
  maxFiles?: number;
  paths?: readonly string[];
  sqlitePath?: string;
}

interface RegistryEntry {
  pid?: unknown;
  sessionId?: unknown;
  cwd?: unknown;
  startedAt?: unknown;
  lastHeartbeat?: unknown;
  updatedAt?: unknown;
  kind?: unknown;
  version?: unknown;
}

interface DesktopSessionEntry {
  conversationId?: unknown;
  workDir?: unknown;
  startedAt?: unknown;
  resumedAt?: unknown;
}

interface DatabaseSessionEntry {
  id?: unknown;
  cwd?: unknown;
  title?: unknown;
  status?: unknown;
  timestamp?: unknown;
  updated_at?: unknown;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function displayProject(cwd: string): string {
  const normalized = cwd.replace(/\\/g, "/");
  const name = basename(normalized) || "WorkBuddy";
  return /^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}$/.test(name) && normalized.includes("/WorkBuddy/") ? "WorkBuddy" : name;
}

function sessionTitle(root: string, sessionId: string, cwd: string): string | undefined {
  const encodedCwd = cwd.replace(/^\//, "").replace(/\//g, "-");
  const file = join(root, "projects", encodedCwd, `${sessionId}.jsonl`);
  if (!existsSync(file)) return undefined;
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const bytes = readSync(fd, buffer, 0, buffer.length, 0);
    for (const line of buffer.toString("utf8", 0, bytes).split("\n")) {
      if (!line.includes('"type":"ai-title"')) continue;
      const item = JSON.parse(line) as { aiTitle?: unknown };
      if (typeof item.aiTitle !== "string") continue;
      const title = item.aiTitle.trim();
      if (title && !/^start new conversation$/i.test(title)) return title.slice(0, 160);
    }
  } catch { /* title metadata is optional and may be mid-write */ }
  finally { if (fd !== undefined) closeSync(fd); }
  return undefined;
}

function parseRegistryEntry(value: unknown, root: string, now: number, activeMs: number, retentionMs: number): SessionPayload | undefined {
  if (!value || typeof value !== "object") return undefined;
  const entry = value as RegistryEntry;
  if (entry.kind !== "interactive" || typeof entry.sessionId !== "string" || !entry.sessionId.trim()) return undefined;
  if (typeof entry.cwd !== "string" || !entry.cwd.startsWith("/") || entry.cwd.includes("__workbuddy_cli_host__")) return undefined;

  const timestamp = finiteNumber(entry.lastHeartbeat) ?? finiteNumber(entry.updatedAt) ?? finiteNumber(entry.startedAt);
  if (timestamp === undefined || now - timestamp > retentionMs) return undefined;
  const project = displayProject(entry.cwd);
  const title = sessionTitle(root, entry.sessionId, entry.cwd) || "WorkBuddy session";
  const working = now - timestamp <= activeMs;
  return {
    session_id: `workbuddy-${entry.sessionId}__${project}`,
    session_type: "WorkBuddy Desktop",
    session_kind: "user",
    source: "filesystem_registry",
    session_name: title,
    status: working ? "working" : "idle",
    task_name: title,
    timestamp,
    project,
    project_path: entry.cwd,
    session_source: typeof entry.version === "string" ? `desktop:${entry.version}` : "desktop",
  };
}

function dateMs(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function parseDesktopSession(value: unknown, root: string, now: number, retentionMs: number): SessionPayload | undefined {
  if (!value || typeof value !== "object") return undefined;
  const entry = value as DesktopSessionEntry;
  if (typeof entry.conversationId !== "string" || !entry.conversationId.trim()) return undefined;
  if (typeof entry.workDir !== "string" || !entry.workDir.startsWith("/")) return undefined;
  const timestamp = dateMs(entry.resumedAt) ?? dateMs(entry.startedAt);
  if (timestamp === undefined || now - timestamp > retentionMs) return undefined;
  const project = displayProject(entry.workDir);
  const title = sessionTitle(root, entry.conversationId, entry.workDir) || "WorkBuddy session";
  return {
    session_id: `workbuddy-${entry.conversationId}__${project}`,
    session_type: "WorkBuddy Desktop",
    session_name: title,
    source: "filesystem_registry",
    status: "idle",
    task_name: title,
    timestamp,
    project,
    project_path: entry.workDir,
    session_source: "desktop",
  };
}

function conversationId(session: SessionPayload): string {
  return session.session_id.slice("workbuddy-".length).split("__", 1)[0];
}

function databaseSessions(root: string, sqlitePath: string, now: number, activeMs: number, retentionMs: number, limit: number): SessionPayload[] {
  const db = join(root, "workbuddy.db");
  if (!existsSync(db) || limit === 0 || !Number.isFinite(now) || !Number.isFinite(retentionMs)) return [];
  try {
    const json = execFileSync(sqlitePath, [
      "-readonly", "-batch", "-json", "-cmd", ".timeout 50", db,
      `PRAGMA query_only=ON;
       SELECT id, cwd, COALESCE(NULLIF(TRIM(custom_title), ''), title) AS title,
         status, COALESCE(last_activity_at, created_at) AS timestamp, updated_at
       FROM sessions
       WHERE deleted_at IS NULL AND LOWER(transport) = 'local' AND LOWER(status) != 'archived'
         AND COALESCE(last_activity_at, created_at) BETWEEN ${Math.max(0, now - retentionMs)} AND ${now}
       ORDER BY COALESCE(last_activity_at, created_at) DESC, id ASC LIMIT ${limit};`,
    ], { encoding: "utf8", timeout: 1_000, maxBuffer: 512 * 1024, stdio: ["ignore", "pipe", "ignore"] });
    const rows: unknown = JSON.parse(json);
    if (!Array.isArray(rows)) return [];
    const sessions: SessionPayload[] = [];
    for (const value of rows) {
      if (!value || typeof value !== "object") continue;
      const entry = value as DatabaseSessionEntry;
      if (typeof entry.id !== "string" || !entry.id.trim()) continue;
      if (typeof entry.cwd !== "string" || entry.cwd.includes("__workbuddy_cli_host__")) continue;
      if (!entry.cwd.startsWith("/") && !(/^(?:[a-z]:[\\/]|\\\\)/i.test(entry.cwd) && win32.isAbsolute(entry.cwd))) continue;
      const timestamp = finiteNumber(entry.timestamp);
      if (timestamp === undefined || timestamp > now || now - timestamp > retentionMs) continue;
      const status = typeof entry.status === "string" ? entry.status.toLowerCase() : "";
      const updatedAt = finiteNumber(entry.updated_at) ?? timestamp;
      const recent = updatedAt <= now && now - updatedAt <= activeMs;
      const project = displayProject(entry.cwd);
      const title = typeof entry.title === "string" && entry.title.trim() ? entry.title.trim().slice(0, 160) : "WorkBuddy session";
      sessions.push({
        session_id: `workbuddy-${entry.id}__${project}`,
        session_type: "WorkBuddy Desktop",
        source: "filesystem_snapshot",
        session_source: "desktop:sqlite",
        session_name: title,
        task_name: title,
        status: status === "failed" ? "error" : recent && (status === "working" || status === "planning") ? "working" : "idle",
        timestamp,
        project,
        project_path: entry.cwd,
      });
    }
    return sessions;
  } catch {
    // A missing binary, locked DB or unrecognized schema must not break legacy discovery.
    return [];
  }
}

export function discoverWorkBuddyDesktopSessions(options: WorkBuddyDesktopDiscoveryOptions = {}): SessionPayload[] {
  const root = options.root ?? join(homedir(), ".workbuddy");
  const sessionsRoot = join(root, "sessions");

  const now = options.now ?? Date.now();
  const activeMs = options.activeMs ?? 15_000;
  const retentionMs = options.retentionMs ?? 30 * 60 * 1000;
  const maxFiles = Number.isFinite(options.maxFiles) ? Math.max(0, Math.min(80, Math.floor(options.maxFiles!))) : 80;
  const bySession = new Map<string, SessionPayload>();

  const desktopRegistry = join(root, "app", "sessions.json");
  if (!options.paths && existsSync(desktopRegistry)) {
    try {
      const parsed = JSON.parse(readFileSync(desktopRegistry, "utf8")) as { sessions?: unknown };
      if (Array.isArray(parsed.sessions)) {
        for (const value of parsed.sessions.slice(0, maxFiles)) {
          const session = parseDesktopSession(value, root, now, retentionMs);
          if (session) bySession.set(conversationId(session), session);
        }
      }
    } catch { /* optional desktop registry may be replaced during shutdown */ }
  }

  const files = options.paths
    ? options.paths.filter(path => dirname(path) === sessionsRoot && path.endsWith(".json")).slice(0, maxFiles)
    : existsSync(sessionsRoot) ? readdirSync(sessionsRoot, { withFileTypes: true }).slice(0, maxFiles)
      .filter(entry => entry.isFile() && entry.name.endsWith(".json"))
      .map(entry => join(sessionsRoot, entry.name)) : [];
  for (const file of files) {
    try {
      const session = parseRegistryEntry(JSON.parse(readFileSync(file, "utf8")), root, now, activeMs, retentionMs);
      if (!session) continue;
      const id = conversationId(session);
      const previous = bySession.get(id);
      if (!previous || session.status === "working" || session.timestamp > previous.timestamp) bySession.set(id, session);
    } catch { /* registry files may be replaced while WorkBuddy updates them */ }
  }

  const db = join(root, "workbuddy.db");
  if (!options.paths || options.paths.some(path => path === db || path === `${db}-wal`)) {
    for (const session of databaseSessions(root, options.sqlitePath ?? "sqlite3", now, activeMs, retentionMs, maxFiles)) {
      const id = conversationId(session);
      const previous = bySession.get(id);
      if (!previous || session.timestamp >= previous.timestamp) {
        session.session_kind ??= previous?.session_kind;
        bySession.set(id, session);
      }
    }
  }

  return [...bySession.values()].sort((a, b) => b.timestamp - a.timestamp);
}
