import type { PlanRow } from "./planTypes.js";
import { compactNumber } from "../tui/displayUtils.js";

const finite = (value: number | undefined): value is number => typeof value === "number" && Number.isFinite(value);

function formatProviderNumber(value: number, maximumFractionDigits = 5): string {
  return value.toLocaleString("en-US", { maximumFractionDigits, useGrouping: false });
}

export function providerLeftText(row: PlanRow): string {
  const unit = row.unit ? ` ${row.unit}` : "";
  if (row.form === "api") {
    const digits = row.unit === "CNY" || row.unit === "USD" ? 2 : 5;
    if (finite(row.remaining)) return `${formatProviderNumber(row.remaining, digits)}${unit} left`;
    if (finite(row.used) && finite(row.limit)) return `${formatProviderNumber(row.used, digits)}/${formatProviderNumber(row.limit, digits)}${unit} used`;
    if (finite(row.used)) return `${formatProviderNumber(row.used, digits)}${unit} used`;
    if (finite(row.limit)) return `${formatProviderNumber(row.limit, digits)}${unit} limit`;
    return "\u2014";
  }
  if (finite(row.used) && finite(row.limit)) return `${compactNumber(row.used)}/${compactNumber(row.limit)}${unit} used`;
  return finite(row.remaining) ? `${compactNumber(row.remaining)}${unit || "%"} left` : "\u2014";
}

export function providerLevelLabel(row: PlanRow): string {
  if (row.collectionError) return row.collectionError;
  if (row.stale) return "Stale";
  if (row.form === "api") return "\u2014";
  const level = row.level === "green" ? "Healthy" : row.level === "yellow" ? "Watch" : "Critical";
  if (row.measuredRateLabel) return `${level} \u00b7 ${row.measuredRateLabel}`;
  if (!finite(row.measuredRate) || row.measuredRate <= 0) return level;
  return `${level} \u00b7 ${formatProviderNumber(row.measuredRate, 2)}${row.unit || "units"}/h avg`;
}

export function providerPresentationTone(row: PlanRow): "neutral" | "api" | PlanRow["level"] {
  if (row.stale) return "neutral";
  if (row.collectionError) return "red";
  return row.form === "api" ? "api" : row.level;
}

export function providerRemainingPercent(row: PlanRow): number | undefined {
  if (finite(row.remaining) && row.unit === "%") return row.remaining;
  if (!finite(row.limit) || row.limit <= 0) return undefined;
  if (finite(row.remaining)) return row.remaining / row.limit * 100;
  if (finite(row.used)) return (1 - row.used / row.limit) * 100;
  return undefined;
}

export function providerResetText(value: string): string {
  return value.replace(/^unblocked\s+in\s+/i, "resets in ");
}

export function providerCardText(value: string): string {
  return value.replace(/^No cards$/i, "0 cards left").replace(/(^| · )card\s+/gi, "$1");
}

export function providerUsageValue(value: number, unit?: string): string {
  if (unit === "CNY" || unit === "USD") {
    return `${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${unit}`;
  }
  if (unit === "%") return `${formatProviderNumber(value)}%`;
  return `${compactNumber(value)}${unit ? ` ${unit}` : ""}`;
}
