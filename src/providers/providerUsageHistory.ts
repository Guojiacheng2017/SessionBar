import { existsSync, readFileSync, renameSync, writeFileSync } from "fs";
import type { PlanRow, ProviderUsageTrend } from "./planTypes.js";
import { usageModeForUnit, withProviderUsageTrend } from "./providerUsageMetrics.js";

interface DailySample {
  day: string;
  first: number;
  latest: number;
  consumed?: number;
}

interface ProviderHistoryEntry {
  metric: "used" | "remaining";
  samples: DailySample[];
}

export type ProviderUsageHistory = Record<string, ProviderHistoryEntry>;

const MAX_HISTORY_DAYS = 35;

export function providerUsageKey(row: PlanRow): string {
  return `${row.provider.toLocaleLowerCase()}:${row.form}:${normalizeHistoryLabel(row.label)}`;
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
      const accumulated = current.consumed
        ?? consumptionDelta(entry.metric, current.first, current.latest);
      current.consumed = accumulated + consumptionDelta(entry.metric, current.latest, reading.value);
      current.latest = reading.value;
    } else {
      entry.samples.push({
        day,
        first: reading.value,
        latest: reading.value,
        consumed: 0,
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
    const tokenTrend = row.usageTrend?.unit === "tokens" && row.usageTrend.points.some(point => point !== null)
      ? row.usageTrend
      : undefined;
    const line = isCopilot(row);
    const days = line ? 30 : 7;
    const entry = history[providerUsageKey(row)];
    const samples = new Map(entry?.samples.map(sample => [sample.day, sample]) ?? []);
    const labels = recentDayKeys(now, days);
    const points = labels.map(day => {
      const sample = samples.get(day);
      if (!sample || !entry) return null;
      if (line) return entry.metric === "used" ? sample.latest : null;
      return sample.consumed
        ?? consumptionDelta(entry.metric, sample.first, sample.latest);
    });
    let decorated: PlanRow;
    if (tokenTrend) {
      decorated = withProviderUsageTrend(row, "token", tokenTrend);
    } else {
      const usageTrend: ProviderUsageTrend = {
        kind: line ? "line" : "bars",
        days,
        points,
        labels,
        ...(row.unit ? { unit: row.unit } : {}),
      };
      const mode = usageModeForUnit(usageTrend.unit);
      decorated = mode ? withProviderUsageTrend(row, mode, usageTrend) : { ...row, usageTrend };
    }

    const percentage = percentageTrend(row, entry, labels);
    return percentage
      ? withProviderUsageTrend(decorated, "percentage", percentage, false)
      : decorated;
  });
}

function percentageTrend(
  row: PlanRow,
  entry: ProviderHistoryEntry | undefined,
  labels: string[],
): ProviderUsageTrend | undefined {
  const current = currentUsagePercent(row);
  if (current === undefined) return undefined;
  const samples = new Map(entry?.samples.map(sample => [sample.day, sample]) ?? []);
  const points: Array<number | null> = labels.map(day => {
    const sample = samples.get(day);
    if (!sample || !entry) return null;
    const consumed = sample.consumed
      ?? consumptionDelta(entry.metric, sample.first, sample.latest);
    return percentOfLimit(row, consumed);
  });
  const hasPercentageSample: boolean = points.some(point => point !== null);
  if (!hasPercentageSample) points[points.length - 1] = current;
  return { kind: "bars", days: 7, points, labels, unit: "%" };
}

function currentUsagePercent(row: PlanRow): number | undefined {
  const limit = Number(row.limit);
  if (Number.isFinite(row.used) && Number.isFinite(limit) && limit > 0) {
    return clampPercent(Number(row.used) / limit * 100);
  }
  if (Number.isFinite(row.remaining) && Number.isFinite(limit) && limit > 0) {
    return clampPercent((limit - Number(row.remaining)) / limit * 100);
  }
  return undefined;
}

function percentOfLimit(row: PlanRow, value: number): number | null {
  const limit = Number(row.limit);
  if (!Number.isFinite(limit) || limit <= 0) return null;
  return clampPercent(value / limit * 100);
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

export function loadProviderUsageHistory(path: string): ProviderUsageHistory {
  if (!existsSync(path)) return {};
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? normalizeHistoryKeys(value as ProviderUsageHistory)
      : {};
  } catch {
    return {};
  }
}

function normalizeHistoryLabel(label: string): string {
  return label
    .toLocaleLowerCase()
    .replace(/\s*\(\s*cc\s*switch\s*\)\s*/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeHistoryKeys(history: ProviderUsageHistory): ProviderUsageHistory {
  const normalized: ProviderUsageHistory = {};
  for (const [key, entry] of Object.entries(history)) {
    const firstSeparator = key.indexOf(":");
    const secondSeparator = key.indexOf(":", firstSeparator + 1);
    const canonicalKey = firstSeparator >= 0 && secondSeparator >= 0
      ? `${key.slice(0, secondSeparator + 1)}${normalizeHistoryLabel(key.slice(secondSeparator + 1))}`
      : key;
    const existing = normalized[canonicalKey];
    normalized[canonicalKey] = existing && existing.metric === entry.metric
      ? mergeHistoryEntries(existing, entry)
      : structuredClone(entry);
  }
  return normalized;
}

function mergeHistoryEntries(
  existing: ProviderHistoryEntry,
  incoming: ProviderHistoryEntry,
): ProviderHistoryEntry {
  const samples = new Map(existing.samples.map(sample => [sample.day, structuredClone(sample)]));
  for (const sample of incoming.samples) {
    const current = samples.get(sample.day);
    if (!current || sampleConsumption(incoming.metric, sample) > sampleConsumption(existing.metric, current)) {
      samples.set(sample.day, structuredClone(sample));
    }
  }
  return {
    metric: existing.metric,
    samples: [...samples.values()]
      .sort((left, right) => left.day.localeCompare(right.day))
      .slice(-MAX_HISTORY_DAYS),
  };
}

function sampleConsumption(metric: "used" | "remaining", sample: DailySample): number {
  return sample.consumed ?? consumptionDelta(metric, sample.first, sample.latest);
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

function consumptionDelta(metric: "used" | "remaining", previous: number, next: number): number {
  const delta = metric === "remaining" ? previous - next : next - previous;
  return Math.max(0, finite(delta));
}
