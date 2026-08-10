import type { SessionPayload } from "./types.js";
import type { PlanRow } from "./planTypes.js";
import { compactNumber } from "./displayUtils.js";

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
  panel: "border border-border rounded-xl bg-surface flex flex-col overflow-hidden shadow-[0_12px_32px_rgba(0,0,0,0.12)]",
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
}

// LobeHub icon CDN — light variant for dark backgrounds, dark variant for light.
// https://lobehub.com/icons/<name>
const ICON_CDN = "https://cdn.jsdelivr.net/npm/@lobehub/icons-static-png@latest";

const ICONS: Record<string, string> = {
  "Claude Code": "claude",
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
  let html: string;
  if (name) {
    const asset = COLOR_ICONS.has(name) ? `${name}-color` : name;
    html = `<picture><source srcset="${ICON_CDN}/light/${asset}.png" media="(prefers-color-scheme: light)"><img class="w-[18px] h-[18px] rounded-[3px] shrink-0" src="${ICON_CDN}/dark/${asset}.png" alt="${escapeHtml(type)}"></picture>`;
  } else if (domain) {
    html = `<img class="w-[18px] h-[18px] rounded-[3px] shrink-0" src="https://www.google.com/s2/favicons?domain=${domain}&sz=32" alt="${escapeHtml(type)}">`;
  } else {
    html = `<span class="w-[18px] h-[18px] rounded-[3px] shrink-0 bg-icon text-[9px] inline-flex items-center justify-center text-muted" aria-label="${escapeHtml(type)}">${escapeHtml(type.slice(0, 1))}</span>`;
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
    if (row.remaining !== undefined) return `${row.remaining}${unit} left`;
    if (row.used !== undefined && row.limit !== undefined) return `${row.used}/${row.limit}${unit}`;
    if (row.used !== undefined) return `${row.used}${unit} used`;
    if (row.limit !== undefined) return `${row.limit}${unit} limit`;
    return "—";
  }
  const unit = row.unit ? ` ${row.unit}` : "";
  if (row.used !== undefined && row.limit !== undefined) {
    return `${compactNumber(row.used)}/${compactNumber(row.limit)}${unit}`;
  }
  return row.remaining !== undefined ? `${Math.round(row.remaining)}%` : "—";
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
      <span role="columnheader">Provider</span><span role="columnheader">Left</span><span role="columnheader">Level</span><span role="columnheader">Reset</span><span role="columnheader">Card</span>
    </div>
    ${rows.map(row => {
      const tone = row.form === "api" ? "api" : row.level;
      const label = row.label || row.provider || "?";
      const form = providerFormLabel(row);
      const hasFormInLabel = label.toLocaleLowerCase().includes(form.toLocaleLowerCase());
      return `<div class="provider-row" role="row">
        <span class="provider-name" role="cell">${escapeHtml(label)}${hasFormInLabel ? "" : `<small>${escapeHtml(form)}</small>`}</span>
        <span class="provider-left provider-left-${tone}" role="cell">${escapeHtml(providerLeftText(row))}</span>
        <span class="provider-level provider-level-${tone}" role="cell">${escapeHtml(providerLevelLabel(row))}</span>
        <span class="provider-reset" role="cell">${escapeHtml(providerResetText(row.autoResetIn || "—"))}</span>
        <span class="provider-card" role="cell">${escapeHtml(providerCardText(row.cardTiming || "—"))}</span>
      </div>`;
    }).join("")}
  </div>`;
}
