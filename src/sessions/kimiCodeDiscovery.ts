import { existsSync, readFileSync, statSync } from "fs";
import { basename, isAbsolute, join, relative, resolve, win32 } from "path";
import { homedir } from "os";
import type { SessionPayload } from "../shared/types.js";

export interface KimiCodeDiscoveryOptions {
  root?: string;
  now?: number;
  activeMs?: number;
  retentionMs?: number;
  maxFiles?: number;
}

interface IndexEntry {
  sessionId?: unknown;
  sessionDir?: unknown;
  workDir?: unknown;
}

interface SessionState {
  id?: unknown;
  cwd?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  archived?: unknown;
  title?: unknown;
  lastTurnReason?: unknown;
  version?: unknown;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function insideRoot(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function cleanText(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const title = value.trim();
  if (!title || title.includes("\n") || title.length > 100 || /^#\s*instructions\b/i.test(title)) return fallback;
  return title;
}

function parseSession(entry: IndexEntry, root: string, now: number, activeMs: number, retentionMs: number): SessionPayload | undefined {
  if (typeof entry.sessionId !== "string" || !entry.sessionId.startsWith("session_")) return undefined;
  if (typeof entry.sessionDir !== "string" || !insideRoot(entry.sessionDir, join(root, "sessions"))) return undefined;
  const statePath = join(entry.sessionDir, "state.json");
  if (!existsSync(statePath)) return undefined;

  const state = JSON.parse(readFileSync(statePath, "utf8")) as SessionState;
  if (state.archived === true || state.id !== entry.sessionId) return undefined;
  const cwd = typeof state.cwd === "string" && (isAbsolute(state.cwd) || win32.isAbsolute(state.cwd))
    ? state.cwd
    : typeof entry.workDir === "string" && (isAbsolute(entry.workDir) || win32.isAbsolute(entry.workDir)) ? entry.workDir : undefined;
  if (!cwd) return undefined;

  const timestamp = finiteNumber(state.updatedAt) ?? finiteNumber(state.createdAt) ?? statSync(statePath).mtimeMs;
  if (now - timestamp > retentionMs) return undefined;
  const project = (isAbsolute(cwd) ? basename(cwd) : win32.basename(cwd)) || "Kimi Code";
  const title = cleanText(state.title, "Kimi Code session");
  const terminalReasons = new Set(["completed", "cancelled", "canceled", "error", "failed", "stopped"]);
  const turnEnded = typeof state.lastTurnReason === "string" && terminalReasons.has(state.lastTurnReason.toLowerCase());
  const working = !turnEnded && now - timestamp <= activeMs;
  return {
    session_id: `kimi-code-${entry.sessionId}__${project}`,
    session_type: "Kimi Code",
    source: "filesystem_registry",
    session_name: title,
    status: working ? "working" : "idle",
    task_name: title,
    timestamp,
    project,
    project_path: cwd,
    session_source: typeof state.version === "number" ? `kimi-code:v${state.version}` : "kimi-code",
  };
}

export function discoverKimiCodeSessions(options: KimiCodeDiscoveryOptions = {}): SessionPayload[] {
  const root = options.root ?? process.env.KIMI_CODE_HOME ?? join(homedir(), ".kimi-code");
  const indexPath = join(root, "session_index.jsonl");
  if (!existsSync(indexPath)) return [];
  const now = options.now ?? Date.now();
  const activeMs = options.activeMs ?? 30_000;
  const retentionMs = options.retentionMs ?? 30 * 60 * 1000;
  const maxFiles = options.maxFiles ?? 80;
  const sessions = new Map<string, SessionPayload>();

  try {
    const lines = readFileSync(indexPath, "utf8").split("\n").filter(Boolean).slice(-maxFiles * 2).reverse();
    for (const line of lines) {
      if (sessions.size >= maxFiles) break;
      try {
        const entry = JSON.parse(line) as IndexEntry;
        if (typeof entry.sessionId !== "string" || sessions.has(entry.sessionId)) continue;
        const session = parseSession(entry, root, now, activeMs, retentionMs);
        if (session) sessions.set(entry.sessionId, session);
      } catch { /* index and state files may be observed mid-write */ }
    }
  } catch { return []; }

  return [...sessions.values()].sort((a, b) => b.timestamp - a.timestamp);
}
