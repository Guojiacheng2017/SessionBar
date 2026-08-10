import { StyledText, TextAttributes, type TextChunk } from "@opentui/core";
import type { SessionPayload } from "./types.js";
import { sessionDisplayName } from "./displayUtils.js";

export type DetailTab = "overview" | "activity" | "usage" | "flow" | "raw";

export const DETAIL_TABS: readonly DetailTab[] = ["overview", "activity", "usage", "flow", "raw"];

export interface UnreadUpdateInput {
  previousFingerprints: ReadonlyMap<string, string>;
  previousUnread: ReadonlySet<string>;
  initialized: boolean;
  sessions: readonly SessionPayload[];
  selectedSessionId: string | null;
}

export interface UnreadUpdateResult {
  fingerprints: Map<string, string>;
  unreadSessionIds: Set<string>;
  initialized: boolean;
}

export interface SessionSidebarLineOptions {
  selected: boolean;
  unread: boolean;
  width: number;
  now?: number;
}

const AGENT_PREFIX = /^(claude|codex|gemini|copilot|opencode|pi|kimi|qwen|deepseek|windsurf|cursor)-/i;

export function sessionFingerprint(session: SessionPayload): string {
  return JSON.stringify([
    session.session_id,
    session.session_type,
    session.session_name ?? null,
    session.status,
    session.task_name,
    session.activity_tail ?? [],
    session.plan_signal ?? [],
    session.flow ?? null,
    session.progress ?? null,
    session.context_percent ?? null,
    session.tokens ?? null,
    session.turns ?? null,
    session.input_tokens ?? null,
    session.output_tokens ?? null,
    session.cache_read_tokens ?? null,
    session.cache_write_tokens ?? null,
    session.token_rate ?? null,
    session.quota_percent ?? null,
    session.quota_reset ?? null,
    session.agent_signals ?? [],
    session.workflow_events ?? [],
    session.unknown_events ?? [],
    session.timestamp,
    session.project ?? null,
    session.project_path ?? null,
  ]);
}

export function updateUnreadSessionState(input: UnreadUpdateInput): UnreadUpdateResult {
  const fingerprints = new Map<string, string>();
  const liveIds = new Set<string>();
  const unreadSessionIds = new Set(input.previousUnread);

  for (const session of input.sessions) {
    const id = session.session_id;
    liveIds.add(id);
    const nextFingerprint = sessionFingerprint(session);
    const previousFingerprint = input.previousFingerprints.get(id);
    fingerprints.set(id, nextFingerprint);

    if (id === input.selectedSessionId) {
      unreadSessionIds.delete(id);
      continue;
    }

    if (input.initialized && previousFingerprint !== nextFingerprint) {
      unreadSessionIds.add(id);
    }
  }

  for (const id of unreadSessionIds) {
    if (!liveIds.has(id)) unreadSessionIds.delete(id);
  }

  return {
    fingerprints,
    unreadSessionIds,
    initialized: true,
  };
}

export function sessionHandle(session: SessionPayload, max = 18): string {
  const raw = String(session.session_id || "?").split("__")[0] || "?";
  const cleaned = raw.replace(AGENT_PREFIX, "");
  if (cleaned.length <= max) return cleaned;

  const uuid = cleaned.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0];
  if (uuid && max >= 18) return `${uuid.slice(0, 11)}...${uuid.slice(-4)}`;

  return truncateMiddle(cleaned, max);
}

export function nextDetailTab(current: DetailTab, delta: number): DetailTab {
  const currentIndex = DETAIL_TABS.indexOf(current);
  const safeIndex = currentIndex === -1 ? 0 : currentIndex;
  const nextIndex = (safeIndex + delta + DETAIL_TABS.length) % DETAIL_TABS.length;
  return DETAIL_TABS[nextIndex]!;
}

export function detailTabByNumber(value: string): DetailTab | null {
  const index = Number.parseInt(value, 10) - 1;
  return Number.isInteger(index) && index >= 0 && index < DETAIL_TABS.length
    ? DETAIL_TABS[index]!
    : null;
}

export function buildSessionSidebarLine(session: SessionPayload, opts: SessionSidebarLineOptions): string {
  const width = Math.max(16, Math.floor(opts.width));
  const marker = opts.selected ? ">" : opts.unread ? "*" : " ";
  const ageText = age(session.timestamp, opts.now ?? Date.now());
  const suffix = ` ${ageText}`;
  const prefix = `${marker} ${statusLabel(session.status)} `;
  const nameWidth = Math.max(4, width - prefix.length - suffix.length);
  return truncatePlain(`${prefix}${truncatePlain(sessionDisplayName(session), nameWidth)}${suffix}`, width);
}

export function buildSessionDetailContent(
  session: SessionPayload,
  tab: DetailTab,
  width: number,
  now = Date.now(),
): string {
  return buildSessionDetailChunks(session, tab, width, now).chunks.map(chunk => chunk.text).join("");
}

export function buildSessionDetailChunks(
  session: SessionPayload,
  tab: DetailTab,
  width: number,
  now = Date.now(),
): StyledText {
  const safeWidth = Math.max(32, Math.floor(width));
  const chunks: TextChunk[] = [];
  chunks.push(plainChunk(`${detailHeader(session, now, safeWidth)}\n`));
  const attention = attentionLine(session);
  if (attention) chunks.push(plainChunk(`${attention}\n`));
  chunks.push(...buildDetailScopeBarChunks(tab));
  chunks.push(plainChunk("\n\n"));

  const lines: string[] = [];
  if (tab === "overview") lines.push(...overviewLines(session, safeWidth, now));
  else if (tab === "activity") lines.push(...activityLines(session, safeWidth, now));
  else if (tab === "usage") lines.push(...usageLines(session, safeWidth, now));
  else if (tab === "flow") lines.push(...flowLines(session, safeWidth, now));
  else lines.push(...rawLines(session));

  const body = tab === "raw"
    ? lines.join("\n")
    : lines.map(line => truncatePlain(line, safeWidth)).join("\n");
  chunks.push(plainChunk(body));
  return new StyledText(chunks);
}

function detailHeader(session: SessionPayload, now: number, width: number): string {
  return truncatePlain(
    `${agentName(session)} | ${sessionHandle(session, 18)} | ${statusLabel(session.status)} | fresh ${age(session.timestamp, now)}`,
    width,
  );
}

export function buildDetailScopeBarChunks(activeTab: DetailTab): TextChunk[] {
  const chunks: TextChunk[] = [];
  for (let i = 0; i < DETAIL_TABS.length; i++) {
    const tab = DETAIL_TABS[i]!;
    if (i > 0) chunks.push(plainChunk(" | "));
    chunks.push(plainChunk(tabTitle(tab), tab === activeTab ? TextAttributes.INVERSE | TextAttributes.BOLD : TextAttributes.NONE));
  }
  return chunks;
}

function tabTitle(tab: DetailTab): string {
  return tab[0]!.toUpperCase() + tab.slice(1);
}

function plainChunk(text: string, attributes = TextAttributes.NONE): TextChunk {
  return { __isChunk: true, text, attributes };
}

function overviewLines(session: SessionPayload, _width: number, now: number): string[] {
  const status = statusLabel(session.status);
  const activity = currentActivity(session) || defaultActivity(session.status);
  const lastDone = lastCompletedActivity(session);
  const source = session.source ? sourceLabel(session.source) : "--";
  return [
    ...boxSection("NOW", [
      `${status} ${activity}`,
      lastDone ? `last done: ${lastDone}` : "last done: --",
      `source: ${source}`,
    ], _width),
    "",
    ...tableSection("PRESSURE", ["Metric", "Value"], pressureRows(session, now), _width),
    "",
    ...boxSection("ATTENTION", [attentionSummary(session)], _width),
  ];
}

function activityLines(session: SessionPayload, width: number, now: number): string[] {
  const lines: string[] = [];
  const plan = (session.plan_signal ?? []).filter(item => item && String(item.text || "").trim());
  if (plan.length > 0) {
    lines.push(...tableSection(
      "PLAN SIGNAL",
      ["State", "Signal", "Age"],
      plan.slice(0, 4).map(item => [item.state, item.text, item.age || "--"]),
      width,
    ));
    lines.push("");
  }

  const events = historyEvents(session, now);
  const rows = events.length === 0
    ? [["--", "no recent activity events", "--"]]
    : events.slice(0, 8).map(event => [event.kind, event.text, event.age]);
  lines.push(...tableSection("HISTORY EVENTS", ["Kind", "Event", "Age"], rows, width));
  return lines;
}

function usageLines(session: SessionPayload, width: number, now: number): string[] {
  const lines = tableSection("USAGE", ["Metric", "Value", "Detail"], usageRows(session, width), width);
  const signals = providerSignalRows(session, now);
  return signals.length > 0
    ? [...lines, "", ...tableSection("PROVIDER SIGNALS", ["Source", "Value", "Usage", "Reset"], signals, width)]
    : lines;
}

function flowLines(session: SessionPayload, width: number, now: number): string[] {
  const graph = session.flow;
  const edges = graph?.edges ?? [];
  if (graph && edges.length > 0) {
    const labels = new Map((graph.nodes ?? []).map(node => [node.id, node.label || node.id]));
    return boxSection(
      "FLOW GRAPH",
      edges.slice(0, 10).map(edge => {
        const from = labels.get(edge.from) || edge.from;
        const to = labels.get(edge.to) || edge.to;
        const label = edge.label ? ` (${edge.label})` : "";
        return `${from} -> ${to}${label}`;
      }),
      width,
    );
  }

  const workflow = session.workflow_events ?? [];
  if (workflow.length > 0) {
    return tableSection(
      "WORKFLOW EVENTS",
      ["Stage", "Raw", "Age", "Type"],
      workflow.slice(-10).reverse().map(event => [
        event.canonical_stage_id,
        event.raw_event,
        workflowAge(event.timestamp, now),
        `${event.mapping_type}/${event.confidence}`,
      ]),
      width,
    );
  }

  return boxSection("FLOW SIGNAL", [
    "no structured flow reported",
    "waiting for workflow hook events",
  ], width);
}

function rawLines(session: SessionPayload): string[] {
  return [
    "RAW SESSION",
    ...JSON.stringify(session, null, 2).split("\n"),
  ];
}

function attentionLine(session: SessionPayload): string {
  if (session.status !== "blocked" && session.status !== "error") return "";
  return `Attention: ${statusLabel(session.status)} - ${currentActivity(session) || defaultActivity(session.status)}`;
}

function agentName(session: SessionPayload): string {
  return (session.session_type || "?").replace(/\s+Code$/i, "").replace(/\s+CLI$/i, "").replace(/\s+/g, " ");
}

function statusLabel(status: SessionPayload["status"]): string {
  if (status === "working") return "WORK";
  if (status === "blocked") return "WAIT";
  if (status === "error") return "ERR";
  return "IDLE";
}

function defaultActivity(status: SessionPayload["status"]): string {
  if (status === "working") return "active";
  if (status === "blocked") return "waiting for input";
  if (status === "error") return "needs attention";
  return "ready";
}

function currentActivity(session: SessionPayload): string {
  return String(session.task_name || "").trim();
}

interface HistoryEvent {
  kind: string;
  text: string;
  age: string;
}

function lastCompletedActivity(session: SessionPayload): string {
  return (session.activity_tail ?? [])
    .slice()
    .reverse()
    .find(line => /^done:/i.test(line)) || "";
}

function sourceLabel(source: NonNullable<SessionPayload["source"]>): string {
  return source === "codex_jsonl" ? "codex jsonl" : source;
}

function attentionSummary(session: SessionPayload): string {
  if (session.status !== "blocked" && session.status !== "error") return "none";
  return `${statusLabel(session.status)} ${currentActivity(session) || defaultActivity(session.status)}`;
}

function historyEvents(session: SessionPayload, now: number): HistoryEvent[] {
  const events: HistoryEvent[] = [];
  const activity = currentActivity(session);
  if (activity) {
    events.push({
      kind: session.status === "working" ? "run" : statusLabel(session.status).toLowerCase(),
      text: activity,
      age: age(session.timestamp, now),
    });
  }

  for (const line of (session.activity_tail ?? []).slice().reverse()) {
    const parsed = parseActivityLine(line);
    events.push({ ...parsed, age: "--" });
  }
  return events;
}

function parseActivityLine(line: string): Pick<HistoryEvent, "kind" | "text"> {
  const match = /^([a-z][\w -]*):\s*(.*)$/i.exec(line.trim());
  if (!match) return { kind: "event", text: line };
  return {
    kind: match[1]!.toLowerCase().replace(/\s+/g, "_"),
    text: match[2] || line,
  };
}

function pressureRows(session: SessionPayload, now: number): string[][] {
  const context = contextPercent(session);
  const tokens = session.tokens;
  const turns = session.turns;
  return [
    ["Context", context === undefined ? "--" : `${Math.round(context)}%`],
    ["Tokens", tokens === undefined ? "--" : compactNumber(tokens)],
    ["Turns", turns === undefined ? "--" : String(Math.round(turns))],
    ["Age", age(session.timestamp, now)],
  ];
}

function usageRows(session: SessionPayload, width: number): string[][] {
  const context = contextPercent(session);
  const tokens = session.tokens;
  const turns = session.turns;
  const input = session.input_tokens;
  const output = session.output_tokens;
  const cacheRead = session.cache_read_tokens;
  const cacheWrite = session.cache_write_tokens;
  const rate = session.token_rate;
  const quota = session.quota_percent === undefined ? "--" : `${Math.round(session.quota_percent)}%`;
  const reset = session.quota_reset && session.quota_reset.trim() ? session.quota_reset.trim() : "--";
  const contextBarWidth = Math.min(22, Math.max(8, width - 32));

  return [
    ["Context", context === undefined ? "--" : `${Math.round(context)}%`, bar(context, contextBarWidth)],
    ["Tokens", tokens === undefined ? "--" : compactNumber(tokens), `in ${displayNumber(input)} out ${displayNumber(output)}`],
    ["Turns", turns === undefined ? "--" : String(Math.round(turns)), `rate ${displayRate(rate)}`],
    ["Cache", cacheRead === undefined && cacheWrite === undefined ? "--" : compactNumber((cacheRead ?? 0) + (cacheWrite ?? 0)), `read ${displayNumber(cacheRead)} write ${displayNumber(cacheWrite)}`],
    ["Quota", quota, `reset ${reset}`],
  ];
}

function providerSignalRows(session: SessionPayload, now: number): string[][] {
  return (session.agent_signals ?? [])
    .filter(signal => signal.balance !== undefined
      || signal.remaining !== undefined
      || signal.used_percent !== undefined
      || signal.used !== undefined
      || signal.limit !== undefined
      || signal.status !== undefined)
    .slice()
    .reverse()
    .slice(0, 4)
    .map(signal => [
      truncatePlain(signal.label || signal.source || signal.signal, 32),
      displayProviderValue(signal),
      displayProviderUsage(signal),
      displayResetAt(signal.reset_at, now),
    ]);
}

function displayProviderValue(signal: NonNullable<SessionPayload["agent_signals"]>[number]): string {
  const remaining = signal.remaining ?? signal.balance;
  if (remaining !== undefined) return displayBalance(remaining, signal.unit ?? signal.balance_unit);
  const isHealthSignal = signal.kind === "service_health" || signal.error_code !== undefined;
  if (signal.status && isHealthSignal) return signal.error_code ? `${signal.status} (${signal.error_code})` : signal.status;
  return "--";
}

function displayProviderUsage(signal: NonNullable<SessionPayload["agent_signals"]>[number]): string {
  if (signal.used_percent !== undefined) return `${Math.round(signal.used_percent)}% used`;
  if (signal.used !== undefined && signal.limit !== undefined) {
    return `${displayNumber(signal.used)}/${displayNumber(signal.limit)}${signal.unit ? ` ${signal.unit}` : ""}`;
  }
  if (signal.used !== undefined) return `used ${displayNumber(signal.used)}${signal.unit ? ` ${signal.unit}` : ""}`;
  if (signal.limit !== undefined) return `limit ${displayNumber(signal.limit)}${signal.unit ? ` ${signal.unit}` : ""}`;
  return "--";
}

function displayBalance(value: number | undefined, unit: string | undefined): string {
  if (value === undefined) return "--";
  const amount = value < 1000 ? value.toFixed(2) : compactNumber(value);
  return unit ? `${amount} ${unit}` : amount;
}

function displayResetAt(timestamp: number | undefined, now: number): string {
  if (timestamp === undefined) return "--";
  const millis = timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp;
  const seconds = Math.max(0, Math.floor((millis - now) / 1000));
  if (seconds < 60) return `in ${seconds}s`;
  if (seconds < 3600) return `in ${Math.floor(seconds / 60)}m`;
  return `in ${Math.floor(seconds / 3600)}h`;
}

function boxSection(title: string, body: readonly string[], width: number): string[] {
  const lineWidth = Math.max(16, Math.floor(width));
  const cellWidth = Math.max(2, lineWidth - 4);
  const lines = body.length > 0 ? body : [""];
  return [
    titledBorder(title, lineWidth),
    ...lines.map(line => `| ${padRight(truncatePlain(line, cellWidth), cellWidth)} |`),
    horizontalBorder(lineWidth),
  ];
}

function tableSection(title: string, headers: readonly string[], rows: readonly (readonly string[])[], width: number): string[] {
  const safeWidth = Math.max(16, Math.floor(width));
  const colCount = Math.max(1, headers.length);
  const maxContentWidth = Math.max(colCount, safeWidth - (colCount * 3 + 1));
  const desired = headers.map((header, index) =>
    Math.max(String(header).length, ...rows.map(row => String(row[index] ?? "").length)),
  );
  const minimum = headers.map(header => Math.max(1, Math.min(String(header).length, 6)));
  const widths = desired.map((value, index) => Math.max(minimum[index]!, value));

  while (sum(widths) > maxContentWidth) {
    let shrinkIndex = -1;
    for (let i = 0; i < widths.length; i++) {
      if (widths[i]! <= minimum[i]!) continue;
      if (shrinkIndex === -1 || widths[i]! > widths[shrinkIndex]!) shrinkIndex = i;
    }
    if (shrinkIndex === -1) break;
    widths[shrinkIndex]!--;
  }

  const renderRow = (cells: readonly string[]) =>
    `| ${widths.map((colWidth, index) => padRight(truncatePlain(String(cells[index] ?? ""), colWidth), colWidth)).join(" | ")} |`;

  const minTitleWidth = Math.min(safeWidth, title.length + 4);
  let tableWidth = renderRow(headers).length;
  if (tableWidth < minTitleWidth) {
    widths[widths.length - 1] = widths[widths.length - 1]! + (minTitleWidth - tableWidth);
    tableWidth = renderRow(headers).length;
  }

  return [
    titledBorder(title, tableWidth),
    renderRow(headers),
    horizontalBorder(tableWidth),
    ...rows.map(row => renderRow(row)),
    horizontalBorder(tableWidth),
  ];
}

function titledBorder(title: string, width: number): string {
  const innerWidth = Math.max(2, width - 2);
  const label = ` ${truncatePlain(title, Math.max(1, innerWidth - 2))} `;
  if (label.length >= innerWidth) return `+${truncatePlain(label, innerWidth)}+`;
  return `+${label}${"-".repeat(innerWidth - label.length)}+`;
}

function horizontalBorder(width: number): string {
  return `+${"-".repeat(Math.max(2, width - 2))}+`;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function age(timestamp: number | undefined, now: number): string {
  const seconds = Math.max(0, Math.floor((now - (timestamp || now)) / 1000));
  if (seconds < 10) return "now";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

function workflowAge(timestamp: number | undefined, now: number): string {
  const seconds = Math.max(0, Math.floor((now - (timestamp || now)) / 1000));
  if (seconds < 1) return "now";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

function contextPercent(session: SessionPayload): number | undefined {
  const raw = session.context_percent;
  if (raw === undefined) return undefined;
  return Math.max(0, Math.min(100, raw <= 1 && raw >= 0 ? raw * 100 : raw));
}

function displayNumber(value: number | undefined): string {
  return value === undefined ? "--" : compactNumber(value);
}

function displayRate(value: number | undefined): string {
  return value === undefined ? "--" : `${compactNumber(value)}/m`;
}

function compactNumber(value: number): string {
  if (value >= 1_000_000) return formatScaledNumber(value / 1_000_000, "M");
  if (value >= 1_000) return formatScaledNumber(value / 1_000, "k");
  return String(Math.round(value));
}

function formatScaledNumber(value: number, suffix: string): string {
  const text = value < 100 ? value.toFixed(1).replace(/\.0$/, "") : value.toFixed(0);
  return `${text}${suffix}`;
}

function bar(value: number | undefined, width: number): string {
  const safeWidth = Math.max(1, width);
  if (value === undefined) return `[${"-".repeat(safeWidth)}]`;
  const filled = Math.round((Math.max(0, Math.min(100, value)) / 100) * safeWidth);
  return `[${"#".repeat(filled)}${"-".repeat(Math.max(0, safeWidth - filled))}]`;
}

function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 3) return text.slice(0, max);
  const keep = max - 3;
  const head = Math.max(1, Math.ceil(keep * 0.58));
  const tail = Math.max(1, keep - head);
  return `${text.slice(0, head)}...${text.slice(-tail)}`;
}

function truncatePlain(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 3) return text.slice(0, max);
  return `${text.slice(0, max - 3)}...`;
}

function padRight(text: string, width: number): string {
  const clipped = truncatePlain(text, width);
  return clipped + " ".repeat(Math.max(0, width - clipped.length));
}
