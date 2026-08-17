import { isSystemEfficiencySnapshot, type SessionPayload, type SystemEfficiencySnapshot } from "../shared/types.js";
import type { PlanRow, ProviderUsageMode } from "../providers/planTypes.js";
import { providerDisplayLabel, providerUsageTrendForMode } from "../providers/providerUsageMetrics.js";
import { compactNumber } from "../tui/displayUtils.js";

export const UI = {
  app: "flex flex-col h-screen px-6 py-5 gap-3.5 max-w-[1180px] mx-auto",
  topbar: "flex items-center justify-between gap-4 shrink-0",
  brand: "text-[17px] font-bold tracking-[-0.3px] text-ink-strong",
  connection: "mono text-[12px] text-green bg-green/10 border border-green/20 rounded-full px-2.5 py-1",
  connectionOffline: "mono text-[12px] text-muted bg-muted/10 border border-muted/15 rounded-full px-2.5 py-1",
  statusSummary: "flex items-center gap-x-4 gap-y-2 shrink-0 min-h-7 flex-wrap text-[13px] text-muted",
  statusItem: "inline-flex items-center gap-2 whitespace-nowrap",
  statusValue: "text-[14px] text-ink-strong font-semibold tabular-nums",
  statusDot: "w-2 h-2 rounded-full shrink-0",
  toolbar: "flex gap-2 items-center shrink-0",
  filter: "flex-1 px-3.5 py-2.5 bg-surface border border-border rounded-lg text-[13px] text-ink outline-none focus:border-accent/50 focus:ring-[3px] focus:ring-accent/10 transition",
  filterHint: "text-[12px] text-muted whitespace-nowrap tabular-nums",
  panel: "panel-card border border-border rounded-xl bg-surface flex flex-col overflow-hidden",
  panelHeader: "flex items-center justify-between gap-3 px-3.5 py-2.5 border-b border-border shrink-0 select-none bg-surface-highlight",
  panelTitle: "mono text-[11px] font-semibold text-muted uppercase tracking-[0.65px]",
  panelBody: "flex-1 overflow-y-auto thin-scroll",
  row: "flex items-center gap-3.5 px-4 py-2.5 min-h-[48px] cursor-pointer border-b border-line-subtle text-[13px] row-transition hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/50",
  projectIconSlot: "project-icon-slot w-[86px] shrink-0 relative flex items-center justify-end",
  projectIconStack: "project-icon-stack",
  projectIconItem: "project-icon-item",
  rowSelected: "bg-accent/[0.09]",
  rowBlocked: "row-blocked",
  empty: "text-center text-muted text-[13px] py-10 px-4",
  detailBody: "flex-1 overflow-y-auto thin-scroll px-4 py-4",
  detailList: "grid grid-cols-[80px_minmax(0,1fr)] gap-x-3 gap-y-2.5 text-[13px] leading-[1.7]",
  detailLabel: "text-[11px] text-muted uppercase tracking-[0.4px]",
  detailValue: "mono text-[12px] text-ink break-words",
  tab: "detail-tab cursor-pointer text-[11px] px-2.5 py-1.5 rounded-md text-muted hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50",
  tabActive: "bg-accent/20 text-accent",
  footer: "text-[12px] text-muted shrink-0 truncate",
} as const;

export interface ProviderTableState {
  loading?: boolean;
  error?: string;
  iconCache?: Map<string, string>;
  usageMode?: ProviderUsageMode;
}

// LobeHub icon CDN — light variant for dark backgrounds, dark variant for light.
// https://lobehub.com/icons/<name>
const ICON_CDN = "https://cdn.jsdelivr.net/npm/@lobehub/icons-static-png@latest";

const ICONS: Record<string, string> = {
  "Claude Code": "claude",
  "Claude Desktop": "claude",
  Codex: "openai",
  "Gemini CLI": "gemini",
  Copilot: "copilot",
  "DeepSeek CLI": "deepseek",
  "Kimi CLI": "moonshot",
  "Qwen CLI": "qwen",
  Windsurf: "windsurf",
  Cursor: "cursor",
  Pi: "pi",
  "Pi Agent": "pi",
  Workbuddy: "workbuddy",
  Minimax: "minimax",
  OpenCode: "",
};

const COLOR_ICONS = new Set(["claude", "copilot", "deepseek", "gemini", "minimax", "qwen"]);

// Fallback: Google Favicon for agents not yet in LobeHub
const FAVICONS: Record<string, string> = {};
const LOCAL_ICONS: Record<string, string> = {
  "WorkBuddy Desktop": "/provider-icons/workbuddy.svg",
};

const PROVIDER_ICON_TYPES: Record<string, string> = {
  anthropic: "Claude Code",
  openai: "Codex",
  github: "Copilot",
  deepseek: "DeepSeek CLI",
  kimi: "Kimi CLI",
  workbuddy: "WorkBuddy Desktop",
};

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function statusLabel(status: string): string {
  return { working: "Working", idle: "Idle", blocked: "Awaiting", error: "Error" }[status] || status;
}

function statusTone(status: string): string {
  return status === "working" ? "bg-green dot-working"
    : status === "idle" ? "bg-accent"
      : status === "blocked" ? "bg-amber dot-blocked"
        : "bg-red";
}

export function statusDotMarkup(status: string): string {
  return `<span class="${cx(UI.statusDot, statusTone(status))}" role="img" aria-label="${escapeHtml(statusLabel(status))}"></span>`;
}

export function iconMarkup(type: string, cache = new Map<string, string>()): string {
  const cached = cache.get(type);
  if (cached) return cached;
  const name = ICONS[type];
  const domain = FAVICONS[type];
  const local = LOCAL_ICONS[type];
  let html: string;
  if (local) {
    html = `<img class="w-[18px] h-[18px] rounded-[3px] shrink-0" src="${local}" alt="${escapeHtml(type)}">`;
  } else if (name) {
    const asset = COLOR_ICONS.has(name) ? `${name}-color` : name;
    html = `<picture><source srcset="${ICON_CDN}/light/${asset}.png" media="(prefers-color-scheme: light)"><img class="w-[18px] h-[18px] rounded-[3px] shrink-0" src="${ICON_CDN}/dark/${asset}.png" alt="${escapeHtml(type)}"></picture>`;
  } else if (domain) {
    html = `<img class="w-[18px] h-[18px] rounded-[3px] shrink-0" src="https://www.google.com/s2/favicons?domain=${domain}&sz=32" alt="${escapeHtml(type)}">`;
  } else {
    html = `<span class="w-[18px] h-[18px] rounded-[3px] shrink-0 bg-icon text-[9px] inline-flex items-center justify-center text-muted" aria-label="${escapeHtml(type)}">${escapeHtml(type.slice(0, 1))}</span>`;
  }
  if (type === "Claude Desktop") {
    html = `<span class="agent-icon agent-icon--badged">${html}<span class="agent-icon-badge agent-icon-badge--desktop" aria-hidden="true"></span></span>`;
  }
  cache.set(type, html);
  return html;
}

export function projectIconListMarkup(types: string[], cache = new Map<string, string>()): string {
  const icons = types.map((type, index) =>
    `<span class="${UI.projectIconItem}" style="z-index:${types.length - index}" title="${escapeHtml(type)}">${iconMarkup(type, cache)}</span>`
  ).join("");
  return icons;
}

export interface SessionCounts {
  total: number;
  working: number;
  blocked: number;
  error: number;
  idle: number;
}

export function countSessions(sessions: Array<Pick<SessionPayload, "status">>): SessionCounts {
  return sessions.reduce<SessionCounts>((counts, session) => {
    counts.total += 1;
    if (session.status === "working") counts.working += 1;
    else if (session.status === "blocked") counts.blocked += 1;
    else if (session.status === "error") counts.error += 1;
    else counts.idle += 1;
    return counts;
  }, { total: 0, working: 0, blocked: 0, error: 0, idle: 0 });
}

function summaryItem(value: number, label: string, status?: string): string {
  const dot = status ? statusDotMarkup(status) : "";
  return `<span class="${UI.statusItem}">${dot}<b class="${UI.statusValue}">${value}</b><span>${label}</span></span>`;
}

export function statusSummaryMarkup(counts: SessionCounts): string {
  const items = [summaryItem(counts.total, counts.total === 1 ? "session" : "sessions")];
  const labels = [`${counts.total} ${counts.total === 1 ? "session" : "sessions"}`];
  if (counts.working > 0) { items.push(summaryItem(counts.working, "working", "working")); labels.push(`${counts.working} working`); }
  if (counts.blocked > 0) { items.push(summaryItem(counts.blocked, "blocked", "blocked")); labels.push(`${counts.blocked} blocked`); }
  if (counts.error > 0) { items.push(summaryItem(counts.error, counts.error === 1 ? "error" : "errors", "error")); labels.push(`${counts.error} ${counts.error === 1 ? "error" : "errors"}`); }
  if (counts.idle > 0) { items.push(summaryItem(counts.idle, "idle", "idle")); labels.push(`${counts.idle} idle`); }
  return `<div class="${UI.statusSummary}" aria-label="${escapeHtml(labels.join(", "))}">${items.join('<span class="text-muted/40" aria-hidden="true">·</span>')}</div>`;
}

export function detailListMarkup(rows: Array<{ label: string; value: string }>, extraClass = ""): string {
  return `<dl class="${cx(UI.detailList, extraClass)}">${rows.map(row =>
    `<dt class="${UI.detailLabel}">${escapeHtml(row.label)}</dt><dd class="${UI.detailValue}">${escapeHtml(row.value)}</dd>`
  ).join("")}</dl>`;
}

export function systemEfficiencyMarkup(
  snapshot: SystemEfficiencySnapshot | undefined,
  now = Date.now(),
): string {
  if (!snapshot) {
    return `<section class="system-efficiency system-efficiency-empty" aria-label="System health">
      <div class="system-efficiency-head"><strong>System</strong><span>Global health</span></div>
      <div class="system-efficiency-unavailable" role="status">System metrics unavailable</div>
      <div class="system-efficiency-rows">${systemInfoRow("Sample", "Unavailable")}</div>
    </section>`;
  }

  const cpu = clampPercent(snapshot.cpu_percent);
  const memory = clampPercent(snapshot.memory_percent);
  const memoryDetail = `${formatBytes(snapshot.memory_used_bytes)} / ${formatBytes(snapshot.memory_total_bytes)}`;
  const loadValues = snapshot.load_average.map(value => value.toFixed(2));
  return `<section class="system-efficiency" aria-label="System health">
    <div class="system-efficiency-head">
      <div><strong>System</strong><span>Global health</span></div>
      <span class="system-efficiency-freshness">Sample · ${escapeHtml(sampleFreshness(snapshot.sampled_at, now))}</span>
    </div>
    <div class="system-efficiency-primary">
      ${systemMetricCard("CPU / Host", percentLabel(cpu), systemMetricStatus(cpu), cpu, 100)}
      ${systemMetricCard("Memory", percentLabel(memory), memoryDetail, memory, 100)}
    </div>
    <div class="system-efficiency-group">
      <div class="system-efficiency-load-head">
        <span class="system-efficiency-group-label">Load Average</span>
        <span class="system-efficiency-group-help">Running or waiting tasks · compare with CPU cores</span>
      </div>
      <dl class="system-efficiency-load-values">
        <div class="system-efficiency-load-row"><dt>1 min</dt><dd>${loadValues[0] ?? "—"}</dd></div>
        <div class="system-efficiency-load-row"><dt>5 min</dt><dd>${loadValues[1] ?? "—"}</dd></div>
        <div class="system-efficiency-load-row"><dt>15 min</dt><dd>${loadValues[2] ?? "—"}</dd></div>
      </dl>
    </div>
    <div class="system-efficiency-secondary system-efficiency-temperatures">
      ${systemTemperatureCard("Device / CPU", snapshot.device_temperature_celsius, 70, 85)}
      ${systemTemperatureCard("Battery", snapshot.battery_temperature_celsius, 35, 45)}
    </div>
    <div class="system-efficiency-secondary system-efficiency-network">
      ${systemInfoCard("Download", formatByteRate(snapshot.network_down_bytes_per_second))}
      ${systemInfoCard("Upload", formatByteRate(snapshot.network_up_bytes_per_second))}
    </div>
  </section>`;
}

interface HtmlRegion {
  innerHTML: string;
}

export interface WebSystemMonitorOptions {
  detailHeader: HtmlRegion;
  detailBody: HtmlRegion;
  isVisible: () => boolean;
  request: (signal: AbortSignal) => Promise<unknown>;
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  cancelSchedule?: (handle: ReturnType<typeof setTimeout>) => void;
}

export interface WebSystemMonitor {
  render(): boolean;
  refresh(): Promise<boolean>;
  stop(): void;
}

export function createWebSystemMonitor(options: WebSystemMonitorOptions): WebSystemMonitor {
  let snapshot: SystemEfficiencySnapshot | undefined;
  let activeController: AbortController | undefined;
  let generation = 0;
  let stopped = false;
  let freshnessTimer: ReturnType<typeof setTimeout> | undefined;
  const now = options.now ?? (() => Date.now());
  const schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const cancelSchedule = options.cancelSchedule ?? (handle => clearTimeout(handle));

  function clearFreshnessTimer(): void {
    if (freshnessTimer === undefined) return;
    cancelSchedule(freshnessTimer);
    freshnessTimer = undefined;
  }

  function scheduleFreshnessUpdate(): void {
    clearFreshnessTimer();
    if (stopped || !snapshot || !options.isVisible()) return;
    freshnessTimer = schedule(() => {
      freshnessTimer = undefined;
      render();
    }, nextSampleFreshnessDelay(snapshot.sampled_at, now()));
  }

  function render(): boolean {
    if (!options.isVisible()) {
      clearFreshnessTimer();
      return false;
    }
    options.detailHeader.innerHTML = `<span class="${UI.panelTitle}">Details / System</span>`;
    options.detailBody.innerHTML = systemEfficiencyMarkup(snapshot, now());
    scheduleFreshnessUpdate();
    return true;
  }

  async function refresh(): Promise<boolean> {
    if (stopped) return false;

    const requestGeneration = ++generation;
    activeController?.abort();
    const controller = new AbortController();
    activeController = controller;

    try {
      const payload = await options.request(controller.signal);
      if (stopped || controller.signal.aborted || requestGeneration !== generation) return false;
      if (!payload || typeof payload !== "object") return false;
      const nextSnapshot = (payload as Record<string, unknown>).system;
      if (!isSystemEfficiencySnapshot(nextSnapshot)) return false;

      snapshot = nextSnapshot;
      render();
      return true;
    } catch {
      return false;
    } finally {
      if (activeController === controller) activeController = undefined;
    }
  }

  function stop(): void {
    if (stopped) return;
    stopped = true;
    generation += 1;
    clearFreshnessTimer();
    activeController?.abort();
    activeController = undefined;
  }

  return { render, refresh, stop };
}

function systemMetricCard(label: string, value: string, detail: string, meterValue: number | undefined, max: number): string {
  const ratio = meterValue === undefined ? undefined : meterValue / max * 100;
  const state = ratio === undefined ? "is-unavailable" : ratio >= 90 ? "is-critical" : ratio >= 75 ? "is-warning" : "is-normal";
  const meter = meterValue === undefined
    ? `<span class="system-efficiency-meter is-unavailable" aria-hidden="true"></span>`
    : `<meter class="system-efficiency-meter" min="0" max="${max}" value="${meterValue}" aria-label="${escapeHtml(label)}: ${escapeHtml(value)}; ${escapeHtml(detail)}"></meter>`;
  return `<article class="system-efficiency-card ${state}">
    <span class="system-efficiency-label">${escapeHtml(label)}</span>
    <strong class="system-efficiency-card-value">${escapeHtml(value)}</strong>
    <span class="system-efficiency-card-detail">${escapeHtml(detail)}</span>
    ${meter}
  </article>`;
}

function systemInfoCard(label: string, value: string, state = "is-normal"): string {
  return `<article class="system-efficiency-card system-efficiency-info-card ${state}">
    <span class="system-efficiency-label">${escapeHtml(label)}</span>
    <strong class="system-efficiency-card-value">${escapeHtml(value)}</strong>
  </article>`;
}

function systemTemperatureCard(label: string, value: number | undefined, warning: number, critical: number): string {
  const state = value === undefined || !Number.isFinite(value)
    ? "is-unavailable"
    : value >= critical ? "is-critical" : value >= warning ? "is-warning" : "is-normal";
  const formatted = value === undefined || !Number.isFinite(value) ? "—" : `${value.toFixed(1)}°C`;
  return systemInfoCard(label, formatted, state);
}

function systemMetricStatus(value: number | undefined): string {
  if (value === undefined) return "Unavailable";
  if (value >= 90) return "Critical";
  if (value >= 70) return "High";
  return "Normal";
}

function systemInfoRow(label: string, value: string): string {
  return `<div class="system-efficiency-row system-efficiency-info-row"><span class="system-efficiency-label">${escapeHtml(label)}</span><span class="system-efficiency-info-spacer" aria-hidden="true"></span><span class="system-efficiency-value">${escapeHtml(value)}</span></div>`;
}

function sampleFreshness(sampledAt: number, now: number): string {
  if (!Number.isFinite(sampledAt) || !Number.isFinite(now)) return "Unavailable";
  const seconds = Math.max(0, Math.floor((now - sampledAt) / 1_000));
  return seconds === 0 ? "now" : `${seconds}s ago`;
}

function nextSampleFreshnessDelay(sampledAt: number, now: number): number {
  if (!Number.isFinite(sampledAt) || !Number.isFinite(now)) return 1_000;
  const ageMs = Math.max(0, now - sampledAt);
  return Math.max(1, 1_000 - (ageMs % 1_000));
}

function clampPercent(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.min(100, value));
}

function percentLabel(value: number | undefined): string {
  return value === undefined ? "—" : `${value.toFixed(1)}%`;
}

function formatBytes(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value) || value < 0) return "—";
  if (value < 1024) return `${Math.round(value)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let scaled = value;
  let unit = "B";
  for (const next of units) {
    scaled /= 1024;
    unit = next;
    if (scaled < 1024 || next === units.at(-1)) break;
  }
  const digits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
  return `${scaled.toFixed(digits).replace(/\.0+$/, "")} ${unit}`;
}

function formatByteRate(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value) || value < 0) return "—";
  if (value < 1_000) return `${value.toFixed(1)} B/s`;
  if (value < 1_000_000) return `${(value / 1_000).toFixed(1)} KB/s`;
  if (value < 1_000_000_000) return `${(value / 1_000_000).toFixed(1)} MB/s`;
  return `${(value / 1_000_000_000).toFixed(1)} GB/s`;
}

export function tabsMarkup(tabs: string[], activeIndex: number): string {
  return tabs.map((tab, index) =>
    `<button type="button" class="${cx(UI.tab, index === activeIndex && UI.tabActive, index === activeIndex && "detail-tab-active")}" data-tab="${index}" aria-selected="${index === activeIndex}">${escapeHtml(tab)}</button>`
  ).join("");
}

function providerFormLabel(row: PlanRow): string {
  return row.form === "api" ? "API" : "Subscription";
}

function providerLeftText(row: PlanRow): string {
  if (row.form === "api") {
    const unit = row.unit ? ` ${row.unit}` : "";
    if (row.remaining !== undefined) return `${formatProviderNumber(row.remaining)}${unit} left`;
    if (row.used !== undefined && row.limit !== undefined) return `${formatProviderNumber(row.used)}/${formatProviderNumber(row.limit)}${unit}`;
    if (row.used !== undefined) return `${formatProviderNumber(row.used)}${unit} used`;
    if (row.limit !== undefined) return `${formatProviderNumber(row.limit)}${unit} limit`;
    return "—";
  }
  const unit = row.unit ? ` ${row.unit}` : "";
  if (row.used !== undefined && row.limit !== undefined) {
    return `${compactNumber(row.used)}/${compactNumber(row.limit)}${unit}`;
  }
  return row.remaining !== undefined ? `${Math.round(row.remaining)}%` : "—";
}

function formatProviderNumber(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 5, useGrouping: false });
}

function providerLevelLabel(row: PlanRow): string {
  return row.form === "api" ? "—" : row.level === "green" ? "Healthy" : row.level === "yellow" ? "Watch" : "Critical";
}

function providerResetText(value: string): string {
  return value.replace(/^unblocked\s+in\s+/i, "resets in ");
}

function providerCardText(value: string): string {
  return value.replace(/^card\s+/i, "");
}

function providerIconType(row: PlanRow): string {
  return PROVIDER_ICON_TYPES[row.provider.toLocaleLowerCase()] || row.provider || row.label || "?";
}

function providerUsageValue(value: number, unit?: string): string {
  if (unit === "CNY" || unit === "USD") {
    return `${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${unit}`;
  }
  if (unit === "%") return `${formatProviderNumber(value)}%`;
  return `${compactNumber(value)}${unit ? ` ${unit}` : ""}`;
}

function providerUsageMarkup(row: PlanRow, mode: ProviderUsageMode): string {
  const trend = providerUsageTrendForMode(row, mode);
  if (!trend || trend.points.every(point => point === null)) {
    return `<span class="provider-usage provider-usage-empty" role="cell" aria-label="Usage history unavailable"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></span>`;
  }
  const values = trend.points.filter((point): point is number => point !== null && Number.isFinite(point));
  if (trend.kind === "line") {
    if (values.length < 2) {
      return `<span class="provider-usage provider-usage-empty" role="cell" aria-label="Collecting usage history"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></span>`;
    }
    const max = Math.max(...values);
    const min = Math.min(...values);
    const range = Math.max(1, max - min);
    const denominator = Math.max(1, trend.points.length - 1);
    const points = trend.points.flatMap((point, index) => point === null ? [] : [
      `${(index / denominator * 100).toFixed(2)},${(18 - ((point - min) / range) * 16).toFixed(2)}`,
    ]).join(" ");
    return `<span class="provider-usage provider-usage-line" role="cell" aria-label="${trend.days}-day usage trend"><svg viewBox="0 0 100 20" preserveAspectRatio="none" aria-hidden="true"><polyline points="${points}" /></svg></span>`;
  }
  const max = trend.unit === "%" ? 100 : Math.max(1, ...values);
  const bars = trend.points.map((point, index) => {
    const height = point === null ? 0 : Math.max(point > 0 ? 12 : 4, Math.round(point / max * 100));
    const label = trend.labels?.[index] || `Day ${index + 1}`;
    const value = point === null ? "No data" : providerUsageValue(point, trend.unit);
    const tooltip = escapeHtml(`${label} · ${value}`);
    return `<i class="provider-usage-bar${point === null ? " is-missing" : ""}" style="--usage-height:${height}%" data-tooltip="${tooltip}" aria-label="${tooltip}" tabindex="0"></i>`;
  }).join("");
  return `<span class="provider-usage provider-usage-bars" role="cell" aria-label="${trend.days}-day usage trend">${bars}</span>`;
}

interface DailyUsageEntry {
  value: number;
  unit: string;
  rank: number;
  label: string;
}

function dailyUsageEntry(row: PlanRow, mode: ProviderUsageMode): DailyUsageEntry | undefined {
  const trend = providerUsageTrendForMode(row, mode);
  const unit = trend?.unit?.trim();
  if (!trend || !unit) return undefined;
  const value = trend.points.at(-1);
  if (value === null || value === undefined) return undefined;
  const normalized = /^tokens?$/i.test(unit) ? "tokens"
    : /^cny$/i.test(unit) ? "CNY"
      : /^usd$/i.test(unit) ? "USD"
        : unit;
  const rank = normalized === "tokens" ? 0
    : /credits?/i.test(normalized) ? 1
      : normalized === "CNY" || normalized === "USD" ? 2
        : normalized === "%" ? 3
          : 4;
  return { value, unit: normalized, rank, label: providerMetricLabel(row) };
}

function providerMetricLabel(row: PlanRow): string {
  if (row.provider.toLocaleLowerCase() === "github") return "Copilot";
  return (row.label || row.provider)
    .replace(/\s+(?:Subscription|API)(?:\s*\([^)]*\))?$/i, "")
    .trim();
}

function dailyUsageValue(entry: DailyUsageEntry): string {
  if (entry.unit === "CNY" || entry.unit === "USD") {
    const symbol = entry.unit === "CNY" ? "¥" : "$";
    return `${symbol}${entry.value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 5 })} ${entry.unit}`;
  }
  if (entry.unit === "%") return `${entry.label} ${formatProviderNumber(entry.value)}%`;
  return `${compactNumber(entry.value)} ${entry.unit}`;
}

export function providerDailyUsageMarkup(rows: readonly PlanRow[], mode: ProviderUsageMode = "token"): string {
  const byProvider = new Map<string, DailyUsageEntry>();
  for (const row of rows) {
    const entry = dailyUsageEntry(row, mode);
    if (!entry) continue;
    const provider = (row.provider || row.label).toLocaleLowerCase();
    const previous = byProvider.get(provider);
    if (!previous || entry.rank < previous.rank) byProvider.set(provider, entry);
  }

  const selected = [...byProvider.values()];
  const percentageValues = mode === "percentage"
    ? selected
      .filter(entry => entry.unit === "%")
      .sort((a, b) => a.label.localeCompare(b.label))
      .map(entry => `<span class="daily-usage-value">${escapeHtml(dailyUsageValue(entry))}</span>`)
    : [];
  const totals = new Map<string, DailyUsageEntry>();
  for (const entry of selected) {
    if (mode === "percentage" && entry.unit === "%") continue;
    const previous = totals.get(entry.unit);
    totals.set(entry.unit, previous ? { ...entry, value: previous.value + entry.value } : { ...entry });
  }
  const values = [...percentageValues, ...[...totals.values()]
    .sort((a, b) => a.rank - b.rank || a.unit.localeCompare(b.unit))
    .map(entry => `<span class="daily-usage-value">${escapeHtml(dailyUsageValue(entry))}</span>`)];
  const content = values.length > 0
    ? values.join(`<span class="daily-usage-plus" aria-hidden="true">+</span>`)
    : `<span class="daily-usage-empty">No usage data yet</span>`;
  return `<span class="daily-usage-label">${mode === "percentage" ? "Current" : "Today"}</span>${content}`;
}

export function providerTableMarkup(rows: readonly PlanRow[], state: ProviderTableState = {}): string {
  if (state.loading) {
    return `<div class="provider-state" role="status"><span class="provider-skeleton"></span><span>Loading provider quota…</span></div>`;
  }
  if (state.error) {
    return `<div class="provider-state provider-error" role="alert"><span>${escapeHtml(state.error)}</span><button type="button" class="provider-retry" data-providers-retry>Retry</button></div>`;
  }
  if (rows.length === 0) {
    return `<div class="provider-state"><strong>No quota data</strong><span>Provider credentials or subscription data are not available yet.</span></div>`;
  }

  return `<div class="provider-table" role="table" aria-label="Provider quota">
    <div class="provider-row provider-row-head" role="row">
      <span role="columnheader">Provider</span><span role="columnheader">Left</span><span role="columnheader">Level</span><span role="columnheader">Usage</span><span role="columnheader">Reset</span><span role="columnheader">Card</span>
    </div>
    ${rows.map(row => {
      const tone = row.form === "api" ? "api" : row.level;
      const label = providerDisplayLabel(row);
      const form = providerFormLabel(row);
      const hasFormInLabel = label.toLocaleLowerCase().includes(form.toLocaleLowerCase());
      const usageSource = providerUsageTrendForMode(row, state.usageMode ?? "token")?.source;
      const providerMeta = [hasFormInLabel ? "" : form, usageSource].filter(Boolean).join(" / ");
      const iconType = providerIconType(row);
      return `<div class="provider-row" role="row">
        <span class="provider-name" role="cell"><span class="provider-icon">${iconMarkup(iconType, state.iconCache)}</span><span class="provider-name-copy">${escapeHtml(label)}${providerMeta ? `<small>${escapeHtml(providerMeta)}</small>` : ""}</span></span>
        <span class="provider-left provider-left-${tone}" role="cell">${escapeHtml(providerLeftText(row))}</span>
        <span class="provider-level provider-level-${tone}" role="cell">${escapeHtml(providerLevelLabel(row))}</span>
        ${providerUsageMarkup(row, state.usageMode ?? "token")}
        <span class="provider-reset" role="cell">${escapeHtml(providerResetText(row.autoResetIn || "—"))}</span>
        <span class="provider-card" role="cell">${escapeHtml(providerCardText(row.cardTiming || "—"))}</span>
      </div>`;
    }).join("")}
  </div>`;
}
