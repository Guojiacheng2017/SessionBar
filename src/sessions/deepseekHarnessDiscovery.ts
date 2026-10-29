import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, win32 } from "node:path";
import type { SessionPayload } from "../shared/types.js";

export interface DeepSeekHarnessDiscoveryOptions {
  root?: string;
  now?: number;
  activeMs?: number;
  retentionMs?: number;
  maxFiles?: number;
  paths?: readonly string[];
}

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  return value && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};
}
function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
function rowValue(rows: ObjectValue, key: string, version: number): unknown {
  const row = object(rows[key]);
  return row.ver === version && count(row.seq) !== undefined ? row.val : undefined;
}

export function deepSeekHarnessCheckpointRoot(root = join(homedir(), ".dsh")): string {
  return join(root, "storages", "session_projcache", "sessions");
}

/** Read only DSH's compact persisted projections, never credentials or full event logs. */
export function discoverDeepSeekHarnessSessions(options: DeepSeekHarnessDiscoveryOptions = {}): SessionPayload[] {
  const root = options.root ?? join(homedir(), ".dsh");
  const directory = deepSeekHarnessCheckpointRoot(root);
  if (!existsSync(directory)) return [];
  const now = options.now ?? Date.now();
  const retentionMs = options.retentionMs ?? 30 * 60_000;
  const activeMs = options.activeMs ?? 30_000;
  const workspacePath = join(root, "storages", "workspace.json");
  const workspace = existsSync(workspacePath) ? object(JSON.parse(readFileSync(workspacePath, "utf8"))) : {};
  const archivedIds = object(workspace.global).archivedSessionIds;
  const archived = new Set(Array.isArray(archivedIds) ? archivedIds.filter(id => typeof id === "string") : []);
  const paths = options.paths ?? readdirSync(directory).map(file => join(directory, file));
  const candidates = [...new Set(paths)].flatMap(file => {
    if (dirname(resolve(file)) !== resolve(directory) || !/^[\w-]+\.json$/.test(basename(file))) return [];
    try {
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024 || now - stat.mtimeMs > retentionMs || stat.mtimeMs > now + 1000) return [];
      return [{ file, timestamp: stat.mtimeMs }];
    } catch { return []; }
  }).sort((a, b) => b.timestamp - a.timestamp).slice(0, options.maxFiles ?? 80);

  return candidates.flatMap(({ file, timestamp }): SessionPayload[] => {
    try {
      const id = basename(file, ".json");
      if (archived.has(id)) return [];
      const document = object(JSON.parse(readFileSync(file, "utf8")));
      const record = object(document.record);
      const identity = object(record.identity);
      const rows = object(record.rows);
      // Projection versions are internal DSH schemas: refuse unverified generations.
      if (document.version !== 7 || identity.formatVersion !== 4 || count(identity.createdAt) === undefined) return [];
      if (object(rowValue(rows, "subagent", 2)).identity) return [];
      const cwd = identity.cwd;
      if (typeof cwd !== "string" || (!cwd.startsWith("/") && !win32.isAbsolute(cwd))) return [];
      const project = (win32.isAbsolute(cwd) && !cwd.startsWith("/") ? win32.basename(cwd) : basename(cwd)) || "DSH";
      const titleValue = rowValue(rows, "title", 1);
      const title = typeof titleValue === "string" && titleValue.trim() && !/[\r\n]/.test(titleValue)
        ? titleValue.trim().slice(0, 100) : "DeepSeek Harness session";
      const boundary = object(rowValue(rows, "turnBoundary", 2));
      const questions = object(object(rowValue(rows, "userQuestions", 2)).questions).active;
      const recent = now - timestamp <= activeMs;
      const status = recent && Array.isArray(questions) && questions.length ? "blocked"
        : recent && count(boundary.openTurnStartSeq) !== undefined ? "working" : "idle";
      const session: SessionPayload = {
        session_id: `dsh-${id}__${project}`,
        session_type: "DeepSeek Harness",
        source: "filesystem_snapshot",
        session_source: "dsh:projection-cache:v7",
        session_name: title,
        task_name: title,
        status,
        timestamp,
        project,
        project_path: cwd,
      };
      const totals = object(object(rowValue(rows, "tokenUsage", 2)).totals);
      const buckets = [totals.uncachedInputTokens, totals.outputTokens, totals.cacheReadTokens, totals.cacheWriteTokens];
      if (buckets.every(value => count(value) !== undefined)) {
        [session.input_tokens, session.output_tokens, session.cache_read_tokens, session.cache_write_tokens] = buckets as number[];
        session.tokens = (buckets as number[]).reduce((sum, value) => sum + value, 0);
      }
      session.turns = count(object(rowValue(rows, "sessionStats", 1)).turns);
      const pressure = object(rowValue(rows, "contextPressure", 5));
      const used = count(pressure.pressureTokens);
      const limit = count(pressure.contextWindow);
      if (used !== undefined && limit !== undefined && limit > 0) session.context_percent = Math.min(100, used / limit * 100);
      return [session];
    } catch { return []; }
  });
}
