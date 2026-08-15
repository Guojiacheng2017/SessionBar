import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { PlanRow } from "./planTypes.js";

const execFileAsync = promisify(execFile);

export type CcSwitchUsage = Record<string, Record<string, number>>;

// CC Switch stores both proxied API requests and normalized CLI session imports.
// Reading both mirrors its Usage view: provider IDs cover API traffic, while
// synthetic IDs such as `_codex_session` carry Codex's historical token usage.
const SEVEN_DAY_USAGE_QUERY = `
  SELECT
    date(l.created_at, 'unixepoch', 'localtime') AS day,
    COALESCE(p.name, l.provider_id) AS provider_name,
    l.model AS model,
    SUM(l.input_tokens + l.output_tokens + l.cache_read_tokens + l.cache_creation_tokens) AS tokens
  FROM proxy_request_logs l
  LEFT JOIN providers p ON p.id = l.provider_id AND p.app_type = l.app_type
  WHERE l.created_at >= unixepoch('now', '-7 days', 'localtime', 'start of day', 'utc')
  GROUP BY day, l.provider_id, l.app_type, l.model
  ORDER BY day;
`;

export function parseCCSwitchUsageOutput(stdout: string): CcSwitchUsage {
  let rows: unknown;
  try { rows = JSON.parse(stdout); } catch { return {}; }
  if (!Array.isArray(rows)) return {};

  const usage: CcSwitchUsage = {};
  for (const value of rows) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    const day = typeof row.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(row.day) ? row.day : undefined;
    const provider = canonicalProvider(`${row.provider_name ?? ""} ${row.model ?? ""}`);
    const tokens = Number(row.tokens);
    if (!day || !provider || !Number.isFinite(tokens) || tokens < 0) continue;
    usage[provider] ??= {};
    usage[provider][day] = (usage[provider][day] ?? 0) + tokens;
  }
  return usage;
}

/** Read CC Switch's normalized proxy history without modifying its database. */
export async function readCCSwitchUsage(home = homedir()): Promise<CcSwitchUsage | null> {
  const dbPath = join(home, ".cc-switch", "cc-switch.db");
  if (!existsSync(dbPath)) return null;
  try {
    const result = await execFileAsync("sqlite3", ["-json", dbPath, SEVEN_DAY_USAGE_QUERY], { maxBuffer: 1024 * 1024 });
    return parseCCSwitchUsageOutput(String(result.stdout || "[]"));
  } catch {
    return null;
  }
}

export function decorateApiUsageFromCCSwitch(
  rows: readonly PlanRow[],
  usage: CcSwitchUsage,
  now = Date.now(),
): PlanRow[] {
  const days = recentDayKeys(now, 7);
  return rows.map(row => {
    if (/github|copilot/i.test(`${row.provider} ${row.label}`)) return row;
    const provider = canonicalProvider(`${row.provider} ${row.label}`);
    const totals = provider ? usage[provider] : undefined;
    const points = days.map(day => totals?.[day] ?? null);
    if (!points.some(point => point !== null)) {
      if (row.form !== "subscription" || row.usageTrend?.unit === "tokens") return row;
      return { ...row, usageTrend: { kind: "bars", days: 7, points, labels: days, unit: "tokens" } };
    }
    return { ...row, usageTrend: { kind: "bars", days: 7, points, labels: days, unit: "tokens" } };
  });
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

function recentDayKeys(now: number, count: number): string[] {
  const cursor = new Date(now);
  cursor.setHours(12, 0, 0, 0);
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(cursor);
    date.setDate(cursor.getDate() - (count - index - 1));
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  });
}
