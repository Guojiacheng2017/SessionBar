import { existsSync, readFileSync } from "node:fs";
import { writePrivateState } from "../shared/privateState.js";
import type { PlanRow } from "./planTypes.js";

export interface ProviderLastGoodState {
  rows: PlanRow[];
  seenAt: Record<string, number>;
}

export function providerLastGoodKey(row: PlanRow): string {
  return `${row.provider}:${row.form}:${row.label}`;
}

export function retainProviderLastGood(
  previous: ProviderLastGoodState,
  freshRows: readonly PlanRow[],
  now: number,
  maxAgeMs: number,
): ProviderLastGoodState {
  const failures = new Map(freshRows.filter(row => row.collectionError).map(row => [providerLastGoodKey(row), row]));
  const successful = freshRows.filter(row => !row.collectionError);
  const fresh = new Map(successful.map(row => [providerLastGoodKey(row), row]));
  const seenAt = { ...previous.seenAt };
  const rows: PlanRow[] = successful.map(row => {
    const key = providerLastGoodKey(row);
    // Re-aggregating an observation must not make its upstream data younger.
    const lastSeenAt = Number.isFinite(row.lastSeenAt) && row.lastSeenAt! >= 0
      ? Math.min(row.lastSeenAt!, now)
      : now;
    seenAt[key] = lastSeenAt;
    return { ...row, stale: false, lastSeenAt };
  });
  for (const row of previous.rows) {
    const key = providerLastGoodKey(row);
    if (fresh.has(key)) continue;
    const lastSeenAt = seenAt[key] ?? row.lastSeenAt;
    if (!Number.isFinite(lastSeenAt) || now - Number(lastSeenAt) > maxAgeMs) {
      delete seenAt[key];
      continue;
    }
    rows.push({ ...row, stale: true, lastSeenAt: Number(lastSeenAt), collectionError: failures.get(key)?.collectionError });
  }
  for (const [key, failure] of failures) {
    if (!rows.some(row => providerLastGoodKey(row) === key)) rows.push({ ...failure, stale: true, lastSeenAt: undefined });
  }
  return { rows, seenAt };
}

export function loadProviderLastGood(path: string, now: number, maxAgeMs: number): ProviderLastGoodState {
  if (!existsSync(path)) return { rows: [], seenAt: {} };
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<ProviderLastGoodState>;
    if (!Array.isArray(value.rows) || !value.seenAt || typeof value.seenAt !== "object") return { rows: [], seenAt: {} };
    return retainProviderLastGood({ rows: value.rows.filter(isPlanRow), seenAt: numericSeenAt(value.seenAt) }, [], now, maxAgeMs);
  } catch {
    return { rows: [], seenAt: {} };
  }
}

export function saveProviderLastGood(path: string, state: ProviderLastGoodState): void {
  try {
    writePrivateState(path, JSON.stringify(state));
  } catch {
    // Provider polling must remain available when its optional cache cannot be written.
  }
}

function isPlanRow(value: unknown): value is PlanRow {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<PlanRow>;
  return (row.form === "subscription" || row.form === "api")
    && typeof row.provider === "string" && typeof row.label === "string"
    && (row.level === "green" || row.level === "yellow" || row.level === "red");
}

function numericSeenAt(value: object): Record<string, number> {
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] => Number.isFinite(entry[1])));
}
