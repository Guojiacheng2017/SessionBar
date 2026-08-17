import type { PlanRow, ProviderUsageMode, ProviderUsageTrend } from "./planTypes.js";

export function providerDisplayLabel(row: Pick<PlanRow, "label" | "provider" | "unit">): string {
  const label = row.label || row.provider || "?";
  const unit = row.unit?.trim();
  if (!unit) return label;
  const suffix = ` ${unit}`;
  return label.toLocaleLowerCase().endsWith(suffix.toLocaleLowerCase())
    ? label.slice(0, -suffix.length)
    : label;
}

export function usageModeForUnit(unit: string | undefined): ProviderUsageMode | undefined {
  if (/^tokens?$/i.test(unit?.trim() ?? "")) return "token";
  if (/^(?:CNY|USD)$/i.test(unit?.trim() ?? "")) return "cash";
  return undefined;
}

export function withProviderUsageTrend(
  row: PlanRow,
  mode: ProviderUsageMode,
  trend: ProviderUsageTrend,
  makePrimary = true,
): PlanRow {
  const nativeMode = usageModeForUnit(row.usageTrend?.unit);
  const nativeTrend = nativeMode && row.usageTrend
    ? { [nativeMode]: row.usageTrend }
    : {};
  return {
    ...row,
    usageTrend: makePrimary ? trend : row.usageTrend,
    usageTrends: {
      ...nativeTrend,
      ...row.usageTrends,
      [mode]: trend,
    },
  };
}

/** Pick the requested metric when available, then retain a provider's native-only metric. */
export function providerUsageTrendForMode(
  row: PlanRow,
  mode: ProviderUsageMode,
): ProviderUsageTrend | undefined {
  if (mode === "percentage") {
    return row.usageTrends?.cash
      ?? row.usageTrends?.percentage
      ?? row.usageTrend
      ?? row.usageTrends?.token;
  }
  return row.usageTrends?.[mode]
    ?? row.usageTrend
    ?? row.usageTrends?.[mode === "token" ? "cash" : "token"]
    ?? row.usageTrends?.percentage;
}
