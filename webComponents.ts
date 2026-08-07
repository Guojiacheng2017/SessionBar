import type { SessionPayload } from "./types.js";

export const UI = {
  app: "flex flex-col h-screen px-6 py-5 gap-3.5 max-w-[1180px] mx-auto",
  topbar: "flex items-center justify-between gap-4 shrink-0",
  brand: "text-[17px] font-bold tracking-[-0.3px] text-white",
  connection: "mono text-[11px] text-green bg-green/10 border border-green/20 rounded-full px-2.5 py-1",
  connectionOffline: "mono text-[11px] text-muted bg-muted/10 border border-muted/15 rounded-full px-2.5 py-1",
  statusSummary: "flex items-center gap-x-4 gap-y-2 shrink-0 min-h-6 flex-wrap text-[12px] text-muted",
  statusItem: "inline-flex items-center gap-2 whitespace-nowrap",
  statusValue: "text-white font-semibold tabular-nums",
  statusDot: "w-[7px] h-[7px] rounded-full shrink-0",
  toolbar: "flex gap-2 items-center shrink-0",
  filter: "flex-1 px-3 py-2 bg-surface border border-border rounded-lg text-[12px] text-gray-200 outline-none focus:border-accent/50 focus:ring-[3px] focus:ring-accent/10 transition",
  filterHint: "text-[11px] text-muted whitespace-nowrap tabular-nums",
  panel: "border border-border rounded-xl bg-surface flex flex-col overflow-hidden shadow-[0_12px_32px_rgba(0,0,0,0.12)]",
  panelHeader: "flex items-center justify-between gap-3 px-3.5 py-2.5 border-b border-border shrink-0 select-none bg-white/[0.015]",
  panelTitle: "mono text-[10px] font-semibold text-muted uppercase tracking-[0.6px]",
  panelBody: "flex-1 overflow-y-auto thin-scroll",
  row: "flex items-center gap-3 px-3.5 py-2 min-h-[42px] cursor-pointer border-b border-white/[0.04] text-[12px] row-transition hover:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/50",
  rowSelected: "bg-accent/[0.09]",
  rowBlocked: "row-blocked",
  empty: "text-center text-muted text-[12px] py-10 px-4",
  detailBody: "flex-1 overflow-y-auto thin-scroll px-4 py-4",
  detailList: "grid grid-cols-[74px_minmax(0,1fr)] gap-x-3 gap-y-2 text-[12px] leading-[1.6]",
  detailLabel: "text-[10px] text-muted uppercase tracking-[0.4px]",
  detailValue: "mono text-[11px] text-gray-200 break-words",
  tab: "detail-tab cursor-pointer text-[10px] px-2 py-1 rounded-md text-muted hover:text-gray-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50",
  tabActive: "bg-accent/20 text-accent",
  footer: "text-[11px] text-muted shrink-0 truncate",
} as const;

const FAVICONS: Record<string, string> = {
  "Claude Code": "claude.ai", "Gemini CLI": "gemini.google.com",
  Codex: "openai.com", Copilot: "github.com", OpenCode: "",
  Pi: "pi.ai", "Pi Agent": "pi.dev",
  "Kimi CLI": "kimi.moonshot.cn", "Qwen CLI": "tongyi.aliyun.com",
  "DeepSeek CLI": "deepseek.com", Windsurf: "codeium.com", Cursor: "cursor.com",
  Workbuddy: "workbuddy.ai", Minimax: "minimax.io", OpenDesign: "",
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
  return status === "working" ? "bg-accent dot-working"
    : status === "idle" ? "bg-green"
      : status === "blocked" ? "bg-amber dot-blocked"
        : "bg-red";
}

export function statusDotMarkup(status: string): string {
  return `<span class="${cx(UI.statusDot, statusTone(status))}" role="img" aria-label="${escapeHtml(statusLabel(status))}"></span>`;
}

export function iconMarkup(type: string, cache = new Map<string, string>()): string {
  const cached = cache.get(type);
  if (cached) return cached;
  const domain = FAVICONS[type];
  const html = domain
    ? `<img class="w-4 h-4 rounded-[3px] shrink-0" src="https://www.google.com/s2/favicons?domain=${domain}&sz=32" alt="${escapeHtml(type)}">`
    : `<span class="w-4 h-4 rounded-[3px] shrink-0 bg-white/10 text-[8px] inline-flex items-center justify-center text-muted" aria-label="${escapeHtml(type)}">${escapeHtml(type.slice(0, 1))}</span>`;
  cache.set(type, html);
  return html;
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
  if (counts.working > 0) items.push(summaryItem(counts.working, "working", "working"));
  if (counts.blocked > 0) items.push(summaryItem(counts.blocked, "blocked", "blocked"));
  if (counts.error > 0) items.push(summaryItem(counts.error, counts.error === 1 ? "error" : "errors", "error"));
  if (counts.idle > 0) items.push(summaryItem(counts.idle, "idle", "idle"));
  return `<div class="${UI.statusSummary}" aria-label="${escapeHtml(items.map(() => "session status").join(", "))}">${items.join('<span class="text-muted/40" aria-hidden="true">·</span>')}</div>`;
}

export function detailListMarkup(rows: Array<{ label: string; value: string }>, extraClass = ""): string {
  return `<dl class="${cx(UI.detailList, extraClass)}">${rows.map(row =>
    `<dt class="${UI.detailLabel}">${escapeHtml(row.label)}</dt><dd class="${UI.detailValue}">${escapeHtml(row.value)}</dd>`
  ).join("")}</dl>`;
}

export function tabsMarkup(tabs: string[], activeIndex: number): string {
  return tabs.map((tab, index) =>
    `<button type="button" class="${cx(UI.tab, index === activeIndex && UI.tabActive)}" data-tab="${index}">${escapeHtml(tab)}</button>`
  ).join("");
}
