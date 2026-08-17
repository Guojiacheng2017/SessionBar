import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, basename } from "path";
import { homedir } from "os";
import type { SessionPayload } from "../shared/types.js";

export interface ClaudeDesktopDiscoveryOptions {
  root?: string | string[];
  configRoot?: string;
  now?: number;
  activeMs?: number;
  windowMs?: number;
  maxFiles?: number;
}

function modelProvider(model: string): string | undefined {
  if (/^kimi(?:-|$)|moonshot/i.test(model)) return "kimi";
  if (/^claude|anthropic/i.test(model)) return "anthropic";
  return undefined;
}

function projectPath(value: unknown, sessionRoot: string): string | undefined {
  if (typeof value === "string" && value.startsWith("/")) {
    const normalized = value.replace(/\\/g, "/");
    if (!normalized.startsWith(sessionRoot.replace(/\\/g, "/"))) return value;
  }
  return undefined;
}

function parseSession(value: unknown, file: string, now: number, activeMs: number, root: string, modelAliases: ReadonlyMap<string, string>): SessionPayload | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  if (item.isArchived === true) return undefined;
  const id = typeof item.sessionId === "string" ? item.sessionId : undefined;
  if (!id || !id.startsWith("local_")) return undefined;
  const model = typeof item.model === "string" ? item.model : "";
  const displayModel = modelAliases.get(model) || model;
  const lastActivity = typeof item.lastActivityAt === "number" ? item.lastActivityAt : undefined;
  const created = typeof item.createdAt === "number" ? item.createdAt : undefined;
  const timestamp = lastActivity || created || statSync(file).mtimeMs;
  const selected = Array.isArray(item.userSelectedFolders) ? item.userSelectedFolders.find(v => typeof v === "string") : undefined;
  const cwd = projectPath(selected, root) || projectPath(item.cwd, root);
  const project = cwd ? basename(cwd) : typeof item.title === "string" ? item.title : "Claude Desktop";
  const working = now - timestamp <= activeMs;
  const provider = modelProvider(displayModel);
  return {
    session_id: `claude-desktop-${id}__${project}`,
    session_type: "Claude Desktop",
    source: "native_registry",
    status: working ? "working" : "idle",
    task_name: typeof item.title === "string" && item.title.trim() ? item.title.trim() : working ? "Active Claude Desktop session" : "Ready",
    timestamp,
    project,
    project_path: cwd,
    model_provider: provider,
    session_name: typeof item.title === "string" ? item.title : undefined,
    session_source: displayModel ? `model:${displayModel}` : undefined,
  };
}

function readModelAliases(configRoot: string): Map<string, string> {
  const aliases = new Map<string, string>();
  if (!existsSync(configRoot)) return aliases;
  for (const entry of readdirSync(configRoot, { withFileTypes: true }).slice(0, 40)) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      const value = JSON.parse(readFileSync(join(configRoot, entry.name), "utf8")) as Record<string, unknown>;
      if (!Array.isArray(value.inferenceModels)) continue;
      for (const model of value.inferenceModels) {
        if (!model || typeof model !== "object") continue;
        const item = model as Record<string, unknown>;
        if (typeof item.name === "string" && typeof item.labelOverride === "string") {
          aliases.set(item.name, item.labelOverride);
        }
      }
    } catch { /* ignore malformed optional model catalogs */ }
  }
  return aliases;
}

function jsonFiles(root: string, windowMs: number, now: number, depth = 0): Array<{ path: string; mtimeMs: number }> {
  const files: Array<{ path: string; mtimeMs: number }> = [];
  if (!existsSync(root)) return files;
  if (depth > 6) return files;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const file = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...jsonFiles(file, windowMs, now, depth + 1));
      continue;
    }
    if (!entry.isFile() || !entry.name.startsWith("local_") || !entry.name.endsWith(".json")) continue;
    try {
      const mtimeMs = statSync(file).mtimeMs;
      if (now - mtimeMs <= windowMs) files.push({ path: file, mtimeMs });
    } catch { /* ignore files removed during scan */ }
  }
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export function discoverClaudeDesktopSessions(options: ClaudeDesktopDiscoveryOptions = {}): SessionPayload[] {
  const now = options.now ?? Date.now();
  const roots = options.root ? (Array.isArray(options.root) ? options.root : [options.root]) : [
    join(homedir(), "Library", "Application Support", "Claude-3p", "local-agent-mode-sessions"),
    join(homedir(), "Library", "Application Support", "Claude-3p", "claude-code-sessions"),
  ];
  const configRoot = options.configRoot ?? join(homedir(), "Library", "Application Support", "Claude-3p", "configLibrary");
  const modelAliases = readModelAliases(configRoot);
  const windowMs = options.windowMs ?? 24 * 60 * 60 * 1000;
  const activeMs = options.activeMs ?? 10 * 60 * 1000;
  const maxFiles = options.maxFiles ?? 80;
  const result: SessionPayload[] = [];
  const files = roots.flatMap(root => jsonFiles(root, windowMs, now)).sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const file of files.slice(0, maxFiles)) {
    try {
      const parsed = parseSession(JSON.parse(readFileSync(file.path, "utf8")), file.path, now, activeMs, roots[0], modelAliases);
      if (parsed) result.push(parsed);
    } catch { /* ignore malformed or partial snapshots */ }
  }
  return result;
}
