import { existsSync, readFileSync, renameSync, writeFileSync } from "fs";
import type { PlanRow, ProviderUsageTrend } from "./planTypes.js";

interface DailySample {
  day: string;
  first: number;
  latest: number;
}

interface ProviderHistoryEntry {
  metric: "used" | "remaining";
  samples: DailySample[];
}

export type ProviderUsageHistory = Record<string, ProviderHistoryEntry>;

const MAX_HISTORY_DAYS = 35;

export function providerUsageKey(row: PlanRow): string {
  return `${row.provider.toLocaleLowerCase()}:${row.form}:${row.label.toLocaleLowerCase()}`;
}

export function recordProviderUsage(
  history: ProviderUsageHistory,
  rows: readonly PlanRow[],
  now = Date.now(),
): ProviderUsageHistory {
  const next: ProviderUsageHistory = structuredClone(history);
  const day = localDayKey(now);
  for (const row of rows) {
    const reading = metricReading(row);
    if (!reading) continue;
    const key = providerUsageKey(row);
    const existing = next[key];
    const entry: ProviderHistoryEntry = existing?.metric === reading.metric
      ? existing
      : { metric: reading.metric, samples: [] };
    const current = entry.samples.at(-1);
    if (current?.day === day) {
      current.latest = reading.value;
    } else {
      entry.samples.push({
        day,
        first: reading.value,
        latest: reading.value,
      });
    }
    entry.samples = entry.samples.slice(-MAX_HISTORY_DAYS);
    next[key] = entry;
  }
  return next;
}

export function decorateProviderUsage(
  rows: readonly PlanRow[],
  history: ProviderUsageHistory,
  now = Date.now(),
): PlanRow[] {
  return rows.map(row => {
    if (row.usageTrend?.unit === "tokens" && row.usageTrend.points.some(point => point !== null)) return row;
    const line = isCopilot(row);
    const days = line ? 30 : 7;
    const entry = history[providerUsageKey(row)];
    const samples = new Map(entry?.samples.map(sample => [sample.day, sample]) ?? []);
    const labels = recentDayKeys(now, days);
    const points = labels.map(day => {
      const sample = samples.get(day);
      if (!sample || !entry) return null;
      if (line) return entry.metric === "used" ? sample.latest : null;
      const delta = entry.metric === "remaining"
        ? sample.first - sample.latest
        : sample.latest - sample.first;
      return Math.max(0, finite(delta));
    });
    const usageTrend: ProviderUsageTrend = {
      kind: line ? "line" : "bars",
      days,
      points,
      labels,
      ...(row.unit ? { unit: row.unit } : {}),
    };
    return { ...row, usageTrend };
  });
}

export function loadProviderUsageHistory(path: string): ProviderUsageHistory {
  if (!existsSync(path)) return {};
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as ProviderUsageHistory
      : {};
  } catch {
    return {};
  }
}

export function saveProviderUsageHistory(path: string, history: ProviderUsageHistory): void {
  const temporary = `${path}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(history));
    renameSync(temporary, path);
  } catch {
    // Usage history is an enhancement; provider refreshes must remain available.
  }
}

function metricReading(row: PlanRow): { metric: "used" | "remaining"; value: number } | undefined {
  if (Number.isFinite(row.used)) return { metric: "used", value: Number(row.used) };
  if (Number.isFinite(row.remaining)) return { metric: "remaining", value: Number(row.remaining) };
  return undefined;
}

function isCopilot(row: PlanRow): boolean {
  return row.provider.toLocaleLowerCase() === "github" || /copilot/i.test(row.label);
}

function localDayKey(timestamp: number): string {
  const date = new Date(timestamp);
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((value, index) => index === 0 ? String(value) : String(value).padStart(2, "0"))
    .join("-");
}

function recentDayKeys(now: number, count: number): string[] {
  const cursor = new Date(now);
  cursor.setHours(12, 0, 0, 0);
  const result: string[] = [];
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const day = new Date(cursor);
    day.setDate(cursor.getDate() - offset);
    result.push(localDayKey(day.getTime()));
  }
  return result;
}

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}
