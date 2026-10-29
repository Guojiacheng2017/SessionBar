import type { PlanRow, ProviderUsageMode } from "../providers/planTypes.js";
import { providerDisplayLabel, providerUsageTrendForMode } from "../providers/providerUsageMetrics.js";
import { compactNumber } from "./displayUtils.js";
import { wrapTerminalText } from "./terminalText.js";

export const PROVIDER_USAGE_MODES: readonly ProviderUsageMode[] = ["percentage", "token", "cash"];

export function providerDetailText(row: PlanRow | undefined, mode: ProviderUsageMode, width: number): string {
  if (!row) return "";
  const unit = row.unit ? ` ${row.unit}` : "";
  const lines = [providerDisplayLabel(row), row.form === "api" ? "API" : "Subscription", ""];
  if (row.collectionError) lines.push(row.collectionError);
  if (row.stale) lines.push("STALE");
  if (row.remaining !== undefined) lines.push(`Remaining  ${compactNumber(row.remaining)}${unit}`);
  if (row.used !== undefined) lines.push(`Used       ${compactNumber(row.used)}${unit}`);
  if (row.limit !== undefined) lines.push(`Limit      ${compactNumber(row.limit)}${unit}`);
  if (row.measuredRateLabel) lines.push(`Rate       ${row.measuredRateLabel}`);
  if (row.pacing) lines.push(`Pacing     ${row.pacing}`);
  if (row.autoResetIn) lines.push(`Reset      ${row.autoResetIn}`);
  if (row.cardTiming) lines.push(`Card       ${row.cardTiming}`);
  const trend = providerUsageTrendForMode(row, mode);
  if (trend) {
    const values = trend.points.filter((value): value is number => value !== null && Number.isFinite(value));
    const max = Math.max(1, ...values);
    const blocks = "\u2581\u2582\u2583\u2584\u2585\u2586\u2587\u2588";
    const chart = trend.points.map(value => value === null || !Number.isFinite(value) ? " " : blocks[Math.max(0, Math.min(7, Math.round(value / max * 7)))]).join("");
    lines.push("", `${trend.days}d / ${trend.unit || ""} / ${trend.kind === "line" ? "Cumulative" : "Daily"}`, chart);
    if (values.length) lines.push(`Latest     ${compactNumber(values.at(-1)!)} ${trend.unit || ""}`);
    if (trend.labels?.length) lines.push(`${trend.labels[0]} - ${trend.labels.at(-1)}`);
    if (trend.source) lines.push(`Source     ${trend.source}`);
  }
  return wrapTerminalText(lines.join("\n"), width);
}
