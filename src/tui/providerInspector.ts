import { StyledText, parseColor, type TextChunk } from "@opentui/core";
import type { PlanRow, ProviderUsageMode, ProviderUsageTrend } from "../providers/planTypes.js";
import { providerDisplayLabel, providerUsageDisplayTrend } from "../providers/providerUsageMetrics.js";
import { providerCardText, providerLevelLabel, providerPresentationTone, providerRemainingPercent, providerResetText, providerUsageValue } from "../providers/providerPresentation.js";
import { terminalText, wrapTerminalText } from "./terminalText.js";
import { TERMINAL_COLORS } from "./terminalTheme.js";

export const PROVIDER_USAGE_MODES: readonly ProviderUsageMode[] = ["token", "cash", "percentage"];

type ProviderColumnKey = "provider" | "quota" | "level" | "usage" | "reset" | "card";
const headings: Record<ProviderColumnKey, string> = { provider: "Provider", quota: "Quota / Usage", level: "Level", usage: "Usage", reset: "Reset", card: "Card" };

export function providerTableColumns(width: number): Array<{ key: ProviderColumnKey; label: string; width: number }> {
  const available = Math.max(1, Math.floor(width));
  const fixed: Array<[ProviderColumnKey, number]> = available >= 104
    ? [["quota", 24], ["level", 8], ["usage", 7], ["reset", 16], ["card", 16]]
    : available >= 88 ? [["quota", 22], ["level", 8], ["usage", 7], ["reset", 16]]
      : available >= 72 ? [["quota", 20], ["level", 8], ["usage", 7]]
        : available >= 58 ? [["quota", 20], ["usage", 7]]
          : available >= 28 ? [["quota", Math.min(22, Math.max(13, Math.floor(available * 0.46)))]] : [];
  const nameWidth = available - fixed.reduce((sum, [, size]) => sum + size, 0) - fixed.length * 2;
  return [["provider", nameWidth] as [ProviderColumnKey, number], ...fixed].map(([key, size]) => ({ key, label: headings[key], width: size }));
}

export function providerWorkspaceLayout(width: number, height: number, count: number) {
  const paddingY = height <= 36 ? 0 : 1;
  const overhead = 3 + 2 * paddingY;
  const bodyHeight = Math.max(1, height - 8);
  const minDetails = height <= 22 ? 5 : height <= 30 ? 8 : 9;
  const rowHeight = 3;
  const visibleRows = Math.max(1, Math.min(count, Math.floor((bodyHeight - minDetails - 1 - overhead) / rowHeight)));
  const tableHeight = visibleRows * rowHeight + overhead;
  return { width: Math.max(1, width - 2), tableHeight, paddingY, visibleRows };
}

export function providerQuotaColor(row: PlanRow): string {
  const tone = providerPresentationTone(row);
  if (tone === "neutral") return TERMINAL_COLORS.muted;
  if (tone === "api") return TERMINAL_COLORS.cyan;
  if (tone === "red") return TERMINAL_COLORS.error;
  if (tone === "yellow") return TERMINAL_COLORS.blocked;
  return TERMINAL_COLORS.working;
}

const colors = new Map<string, ReturnType<typeof parseColor>>();
function providerChunk(text: string, fg?: string): TextChunk {
  if (!fg) return { __isChunk: true, text };
  if (!colors.has(fg)) colors.set(fg, parseColor(fg));
  return { __isChunk: true, text, fg: colors.get(fg) };
}

export function providerUsageMeterChunks(row: PlanRow, width: number): TextChunk[] {
  const percent = providerRemainingPercent(row);
  if (percent === undefined || !Number.isFinite(percent)) return [];
  const label = `${Math.round(percent)}% left`;
  const labelWidth = Math.max(9, label.length);
  const size = Math.min(24, Math.floor(width) - labelWidth - 1);
  if (size < 1) return [];
  const filled = Math.round(size * Math.max(0, Math.min(1, percent / 100)));
  const fg = providerQuotaColor(row);
  return [
    providerChunk("\u2588".repeat(filled), fg),
    providerChunk("\u2500".repeat(size - filled), TERMINAL_COLORS.dim),
    providerChunk(` ${label.padStart(labelWidth)}`, fg),
  ];
}

export function providerUsageMeter(row: PlanRow, width: number): string {
  return providerUsageMeterChunks(row, width).map(chunk => chunk.text).join("");
}

export function providerUsageSparkline(row: PlanRow, mode: ProviderUsageMode): string {
  const trend = providerUsageDisplayTrend(row, mode);
  const values = trend?.points.filter((value): value is number => value !== null && Number.isFinite(value)) ?? [];
  if (!trend || !values.length || (trend.kind === "line" && values.length < 2)) return "\u2014";
  const low = trend.kind === "line" ? Math.min(...values) : 0;
  const range = Math.max(1, Math.max(...values) - low);
  const blocks = "\u2581\u2582\u2583\u2584\u2585\u2586\u2587\u2588";
  const points = trend.kind === "line" ? linePlotPoints(trend.points, 7) : trend.points;
  return points.map(value => value === null || !Number.isFinite(value) ? " " : blocks[Math.max(0, Math.min(7, Math.round((value - low) / range * 7)))]).join("");
}

function linePlotPoints(points: Array<number | null>, width: number): Array<number | null> {
  const first = points.findIndex(value => value !== null && Number.isFinite(value));
  if (first < 0) return [];
  const last = points.length - 1 - [...points].reverse().findIndex(value => value !== null && Number.isFinite(value));
  const observed = points.slice(first, last + 1);
  if (observed.length <= width) return observed;
  // Bucket actual observations rather than sampling indices that may all be missing.
  return Array.from({ length: width }, (_, i) => {
    let value: number | null = null;
    for (let index = Math.floor(i * observed.length / width); index < Math.floor((i + 1) * observed.length / width); index++) {
      const point = observed[index];
      if (point !== null && Number.isFinite(point)) value = point;
    }
    return value;
  });
}

function chartLines(trend: ProviderUsageTrend | undefined, width: number): string[] {
  if (!trend) return [];
  const values = trend.points.filter((value): value is number => value !== null && Number.isFinite(value));
  const title = `${trend.kind === "line" ? "Monthly cumulative" : "Last 7 days"}${trend.unit ? ` / ${trend.unit}` : ""}`;
  if (!values.length || (trend.kind === "line" && values.length < 2)) return [title];
  const points = trend.kind === "line" ? linePlotPoints(trend.points, Math.max(1, width)) : trend.points;
  const slot = Math.max(1, Math.min(trend.kind === "bars" ? 6 : 2, Math.floor(width / Math.max(1, points.length))));
  const low = trend.kind === "line" ? Math.min(...values) : 0;
  const range = Math.max(1, Math.max(...values) - low);
  const height = 6;
  const lines = [title, ""];
  for (let y = height - 1; y >= 0; y--) {
    lines.push(points.map(value => {
      if (value === null || !Number.isFinite(value)) return " ".repeat(slot);
      const level = Math.max(0, Math.min(height - 1, Math.round((value - low) / range * (height - 1))));
      const mark = trend.kind === "line" ? (y === level ? "\u25cf" : y === 0 ? "\u2500" : " ")
        : value > 0 && y <= level ? "\u2588" : y === 0 ? "\u2500" : " ";
      return mark.repeat(trend.kind === "bars" ? Math.max(1, slot - 1) : 1).padEnd(slot);
    }).join("").trimEnd());
  }
  const latest = trend.points.at(-1);
  if (latest !== null && latest !== undefined && Number.isFinite(latest)) lines.push("", `Latest  ${providerUsageValue(latest, trend.unit)}`);
  if (trend.labels?.length) lines.push(`${trend.labels[0]} - ${trend.labels.at(-1)}`);
  if (trend.source) lines.push(`Source  ${trend.source}`);
  return lines;
}

function wrapProviderRow(row: TextChunk[], width: number): TextChunk[][] {
  const chunks = row.map(chunk => ({ ...chunk, text: terminalText(chunk.text) }));
  const text = chunks.map(chunk => chunk.text).join("");
  let start = 0;
  return wrapTerminalText(text, width).split("\n").map(line => {
    const end = start + line.length;
    let offset = 0;
    const result: TextChunk[] = [];
    for (const chunk of chunks) {
      const from = Math.max(0, start - offset);
      const to = Math.min(chunk.text.length, end - offset);
      if (to > from) result.push({ ...chunk, text: chunk.text.slice(from, to) });
      offset += chunk.text.length;
    }
    start = end + (text[end] === "\n" ? 1 : 0);
    return result;
  });
}

export function buildProviderDetailChunks(row: PlanRow | undefined, mode: ProviderUsageMode, width: number): StyledText {
  if (!row) return new StyledText([]);
  const trend = providerUsageDisplayTrend(row, mode);
  const fg = providerQuotaColor(row);
  const muted = TERMINAL_COLORS.muted;
  const facts: TextChunk[][] = [];
  const fact = (text: string, color = fg) => facts.push([providerChunk(text, color)]);
  if (row.collectionError) fact(row.collectionError);
  if (row.stale) fact("STALE");
  for (const [label, value] of [["Remaining", row.remaining], ["Used", row.used], ["Limit", row.limit]] as const) {
    if (value !== undefined && Number.isFinite(value)) fact(`${label.padEnd(11)}${providerUsageValue(value, row.unit)}`);
  }
  const meter = providerUsageMeterChunks(row, Math.min(36, width));
  if (meter.length) facts.push(meter);
  facts.push([], [providerChunk(`Level      ${providerLevelLabel(row)}`, fg)]);
  if (row.pacing) fact(`Pacing     ${row.pacing}`, muted);
  if (row.autoResetIn) fact(`Reset      ${providerResetText(row.autoResetIn)}`, muted);
  if (row.cardTiming) fact(`Card       ${providerCardText(row.cardTiming)}`, muted);
  const form = row.form === "api" ? "API" : "Subscription";
  const label = providerDisplayLabel(row);
  const lines: TextChunk[][] = [[providerChunk(label)]];
  if (!label.toLowerCase().includes(form.toLowerCase())) lines.push([providerChunk(form, muted)]);
  if (width >= 58) lines.push([]);
  const historyColor = row.stale || row.collectionError ? muted : TERMINAL_COLORS.cyan;
  const chart = (size: number) => chartLines(trend, size).map(line => [providerChunk(line, historyColor)]);
  if (width >= 88 && trend) {
    const leftWidth = Math.min(48, Math.floor(width * 0.46));
    const rightWidth = width - leftWidth - 4;
    const left = facts.flatMap(line => wrapProviderRow(line, leftWidth));
    const right = chart(rightWidth).flatMap(line => wrapProviderRow(line, rightWidth));
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
      const a = left[i] ?? [], b = right[i] ?? [];
      const leftLength = a.reduce((sum, chunk) => sum + chunk.text.length, 0);
      lines.push(b.some(chunk => chunk.text.length) ? [...a, providerChunk(" ".repeat(Math.max(0, leftWidth - leftLength) + 4)), ...b] : a);
    }
  } else {
    lines.push(...facts, [], ...chart(width));
  }
  const wrapped = lines.flatMap(line => wrapProviderRow(line, width));
  return new StyledText(wrapped.flatMap((line, index) => index ? [providerChunk("\n"), ...line] : line));
}

export function providerDetailText(row: PlanRow | undefined, mode: ProviderUsageMode, width: number): string {
  return buildProviderDetailChunks(row, mode, width).chunks.map(chunk => chunk.text).join("");
}
