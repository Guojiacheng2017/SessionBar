import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync } from "fs";
import { basename, join } from "path";
import { homedir } from "os";
import type { SessionPayload } from "../shared/types.js";

export interface WorkBuddyDesktopDiscoveryOptions {
  root?: string;
  now?: number;
  activeMs?: number;
  retentionMs?: number;
  maxFiles?: number;
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

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function displayProject(cwd: string): string {
  const name = basename(cwd) || "WorkBuddy";
  return /^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}$/.test(name) && cwd.includes("/WorkBuddy/") ? "WorkBuddy" : name;
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
    source: "native_registry",
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
    source: "native_registry",
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

export function discoverWorkBuddyDesktopSessions(options: WorkBuddyDesktopDiscoveryOptions = {}): SessionPayload[] {
  const root = options.root ?? join(homedir(), ".workbuddy");
  const sessionsRoot = join(root, "sessions");

  const now = options.now ?? Date.now();
  const activeMs = options.activeMs ?? 15_000;
  const retentionMs = options.retentionMs ?? 30 * 60 * 1000;
  const maxFiles = options.maxFiles ?? 80;
  const bySession = new Map<string, SessionPayload>();

  const desktopRegistry = join(root, "app", "sessions.json");
  if (existsSync(desktopRegistry)) {
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

  if (!existsSync(sessionsRoot)) return [...bySession.values()].sort((a, b) => b.timestamp - a.timestamp);
  for (const entry of readdirSync(sessionsRoot, { withFileTypes: true }).slice(0, maxFiles)) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      const session = parseRegistryEntry(JSON.parse(readFileSync(join(sessionsRoot, entry.name), "utf8")), root, now, activeMs, retentionMs);
      if (!session) continue;
      const id = conversationId(session);
      const previous = bySession.get(id);
      if (!previous || session.status === "working" || session.timestamp > previous.timestamp) bySession.set(id, session);
    } catch { /* registry files may be replaced while WorkBuddy updates them */ }
  }

  return [...bySession.values()].sort((a, b) => b.timestamp - a.timestamp);
}
