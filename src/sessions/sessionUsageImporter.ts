import { existsSync, openSync, readFileSync, readSync, closeSync, readdirSync, statSync, writeFileSync, renameSync } from "fs";
import { join } from "path";
import type { PlanRow } from "../providers/planTypes.js";
import { withProviderUsageTrend } from "../providers/providerUsageMetrics.js";

interface FileCursor {
  offset: number;
  provider?: string;
  seen?: string[];
}

export interface SessionUsageState {
  files: Record<string, FileCursor>;
  daily: Record<string, Record<string, number>>;
}

export interface SessionUsageImporterOptions {
  statePath: string;
  codexDir: string;
  claudeDir: string;
  now?: number;
}

const DAY_MS = 86_400_000;
const MAX_SEEN_IDS = 4000;

export function syncSessionUsage(options: SessionUsageImporterOptions): SessionUsageState {
  const now = options.now ?? Date.now();
  const state = loadSessionUsageState(options.statePath);
  const files = [
    ...recentJsonlFiles(options.codexDir, now),
    ...recentJsonlFiles(options.claudeDir, now),
  ];
  for (const path of files) ingestFile(path, path.startsWith(options.codexDir) ? "codex" : "claude", state);
  pruneDaily(state, now);
  saveSessionUsageState(options.statePath, state);
  return state;
}

export function decorateProviderUsageFromSessions(rows: readonly PlanRow[], state: SessionUsageState, now = Date.now()): PlanRow[] {
  const days = recentDayKeys(now, 7);
  return rows.map(row => {
    const provider = canonicalProvider(row.provider || row.label);
    const isCopilot = /github|copilot/i.test(`${row.provider} ${row.label}`);
    const existingTokenTrend = row.usageTrends?.token
      ?? (row.usageTrend?.unit === "tokens" ? row.usageTrend : undefined);
    const hasTokenTrend = existingTokenTrend?.points.some(point => point !== null) === true;
    if (isCopilot || !provider) return row;
    if (hasTokenTrend && existingTokenTrend) return withProviderUsageTrend(row, "token", existingTokenTrend);
    const totals = provider ? state.daily[provider] : undefined;
    const points = days.map(day => totals?.[day] ?? null);
    if (!points.some(point => point !== null)) return row;
    return withProviderUsageTrend(row, "token", { kind: "bars", days: 7, points, labels: days, unit: "tokens" });
  });
}

export function parseSessionUsageLine(
  line: string,
  kind: "codex" | "claude",
  cursor: FileCursor,
): { day: string; provider: string; tokens: number; eventId?: string } | undefined {
  let item: any;
  try { item = JSON.parse(line); } catch { return undefined; }
  if (kind === "codex") {
    if (item?.type === "session_meta") cursor.provider = canonicalProvider(item?.payload?.model_provider) ?? "openai";
    if (item?.type !== "event_msg" || item?.payload?.type !== "token_count") return undefined;
    const usage = item?.payload?.info?.last_token_usage;
    const tokens = finiteNonNegative(usage?.total_tokens)
      ?? sumUsage(usage, ["input_tokens", "output_tokens"]);
    return usageEvent(item.timestamp, cursor.provider ?? "openai", tokens);
  }
  if (item?.type !== "assistant" || !item?.message?.usage) return undefined;
  const eventId = typeof item.message.id === "string" ? item.message.id : undefined;
  if (eventId && cursor.seen?.includes(eventId)) return undefined;
  const provider = canonicalProvider(item.message.model);
  const tokens = sumUsage(item.message.usage, [
    "input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens",
  ]);
  if (!provider) return undefined;
  return { ...usageEvent(item.timestamp, provider, tokens), eventId } as any;
}

export function loadSessionUsageState(path: string): SessionUsageState {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed && typeof parsed === "object") return { files: parsed.files ?? {}, daily: parsed.daily ?? {} };
  } catch { /* first run or damaged optional cache */ }
  return { files: {}, daily: {} };
}

function ingestFile(path: string, kind: "codex" | "claude", state: SessionUsageState): void {
  let stat;
  try { stat = statSync(path); } catch { return; }
  const cursor = state.files[path] ?? { offset: 0, seen: [] };
  if (cursor.offset > stat.size) cursor.offset = 0;
  if (cursor.offset === stat.size) return;
  let fd: number | undefined;
  try {
    const buffer = Buffer.alloc(stat.size - cursor.offset);
    fd = openSync(path, "r");
    const bytes = readSync(fd, buffer, 0, buffer.length, cursor.offset);
    const chunk = buffer.subarray(0, bytes);
    const lastNewline = chunk.lastIndexOf(10);
    if (lastNewline < 0) return;
    const text = chunk.subarray(0, lastNewline).toString("utf8");
    for (const line of text.split("\n")) {
      const event = parseSessionUsageLine(line, kind, cursor);
      if (!event) continue;
      state.daily[event.provider] ??= {};
      state.daily[event.provider][event.day] = (state.daily[event.provider][event.day] ?? 0) + event.tokens;
      if (event.eventId) {
        cursor.seen ??= [];
        cursor.seen.push(event.eventId);
        cursor.seen = cursor.seen.slice(-MAX_SEEN_IDS);
      }
    }
    cursor.offset += lastNewline + 1;
    state.files[path] = cursor;
  } catch { /* unreadable logs must not affect provider monitoring */ }
  finally { if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ } }
}

function recentJsonlFiles(root: string, now: number): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth < 0 || !existsSync(dir)) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path, depth - 1);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        try { if (now - statSync(path).mtimeMs <= 7 * DAY_MS) out.push(path); } catch { /* skip */ }
      }
    }
  };
  walk(root, 8);
  return out;
}

function saveSessionUsageState(path: string, state: SessionUsageState): void {
  try {
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, JSON.stringify(state));
    renameSync(temporary, path);
  } catch { /* optional cache */ }
}

function usageEvent(timestamp: unknown, provider: string, tokens: number | undefined) {
  if (tokens === undefined || tokens <= 0) return undefined;
  const time = Date.parse(String(timestamp ?? ""));
  if (!Number.isFinite(time)) return undefined;
  return { day: localDayKey(time), provider, tokens };
}

function sumUsage(value: any, keys: string[]): number | undefined {
  let found = false;
  let total = 0;
  for (const key of keys) {
    const number = finiteNonNegative(value?.[key]);
    if (number !== undefined) { found = true; total += number; }
  }
  return found ? total : undefined;
}

function finiteNonNegative(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function canonicalProvider(value: unknown): string | undefined {
  const text = String(value ?? "").toLocaleLowerCase();
  if (/deepseek/.test(text)) return "deepseek";
  if (/kimi|moonshot/.test(text)) return "kimi";
  if (/zhipu|\bglm\b/.test(text)) return "glm";
  if (/claude|anthropic/.test(text)) return "anthropic";
  if (/gemini|google/.test(text)) return "google";
  if (/gpt|openai|codex/.test(text)) return "openai";
  return undefined;
}

function localDayKey(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function recentDayKeys(now: number, count: number): string[] {
  const cursor = new Date(now); cursor.setHours(12, 0, 0, 0);
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(cursor); date.setDate(cursor.getDate() - (count - index - 1));
    return localDayKey(date.getTime());
  });
}

function pruneDaily(state: SessionUsageState, now: number): void {
  const keep = new Set(recentDayKeys(now, 7));
  for (const totals of Object.values(state.daily)) {
    for (const day of Object.keys(totals)) if (!keep.has(day)) delete totals[day];
  }
}
