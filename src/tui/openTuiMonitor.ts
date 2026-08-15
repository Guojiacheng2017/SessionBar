import {
  BoxRenderable,
  TextAttributes,
  TextRenderable,
  TextTableRenderable,
  RGBA,
  StyledText,
  createCliRenderer,
  parseColor,
  type CliRenderer,
  type KeyEvent,
  type TextChunk,
  type TextTableContent,
} from "@opentui/core";
import type { PlanRow } from "../providers/planTypes.js";
import type { SessionPayload, SystemEfficiencySnapshot } from "../shared/types.js";
import {
  buildSessionDetailChunks,
  buildSessionSidebarLine,
  detailTabByNumber,
  nextDetailTab,
  updateUnreadSessionState,
  type DetailTab,
} from "../sessions/sessionInspector.js";
import {
  age,
  compactNumber,
  truncatePlain,
  agentName,
  firstFiniteNumber,
  clampNumber,
} from "./displayUtils.js";
import {
  projectName,
  compactPath,
  rawProjectPath,
  projectPathSummary,
  groupByProject as groupSessionsByProject,
} from "../shared/projectUtils.js";

type Session = SessionPayload;
export interface SessionFetchResult {
  sessions: Session[];
  error?: string;
  unchanged?: boolean;
}

export type FetchSessions = () => Promise<SessionFetchResult>;

export interface OpenTuiMonitorOptions {
  fetchSessions: FetchSessions;
  fetchSystem: () => Promise<SystemEfficiencySnapshot | undefined>;
  fetchProviders?: () => Promise<PlanRow[]>;
  openWebDashboard: () => Promise<void>;
  renderMs: number;
  pollMs: number;
  backgroundPollMs?: number;
  port: number;
  getPort?: () => number;
  apiHost: string;
  stateDir: string;
  animate: boolean;
  toggleSSE?: () => boolean;
  isSSE?: () => boolean;
  closeTransport?: () => void;
}

export function monitorPollDelay(focused: boolean, foregroundMs: number, backgroundMs = 10_000): number {
  return focused ? foregroundMs : Math.max(foregroundMs, backgroundMs);
}

type RuntimeDisplayOptions = Pick<OpenTuiMonitorOptions, "apiHost" | "port" | "getPort" | "stateDir">;

function displayPort(opts?: Pick<OpenTuiMonitorOptions, "port" | "getPort">): number {
  return opts?.getPort?.() ?? opts?.port ?? 0;
}

interface MonitorState {
  sessions: Session[];
  system?: SystemEfficiencySnapshot;
  errorMsg?: string;
  filterText: string;
  filterActive: boolean;
  projectCursorKey: string | null;
  projectFocusKey: string | null;
  selectedIdx: number;
  selectedId: string | null;
  detailId: string | null;
  detailTab: DetailTab;
  sessionFingerprints: Map<string, string>;
  unreadSessionIds: Set<string>;
  unreadInitialized: boolean;
  sseMode: boolean;
  view: "sessions" | "providers";
  providers: PlanRow[];
  providersError?: string;
}

interface ProjectRow {
  key: string;
  marker: string;
  project: string;
  sessions: number;
  agents: string;
  status: string;
  path: string;
  age: string;
}

interface SessionRow {
  key: string;
  source: Session;
  statusKind: Session["status"];
  unread: boolean;
}

interface MonitorRefs {
  root: BoxRenderable;
  title: TextRenderable;
  online: TextRenderable;
  activity: TextRenderable;
  projectsBox: BoxRenderable;
  projectsTable: TextTableRenderable;
  sessionsBox: BoxRenderable;
  sessionsTable: TextTableRenderable;
  providersTable: TextTableRenderable;
  detailsBox: BoxRenderable;
  detailsText: TextRenderable;
  footer: TextRenderable;
}

type PaletteColor = string | RGBA;

export interface MonitorBodyLayout {
  bodyWidth: number;
  gap: number;
  sidebarPanelWidth: number;
  detailPanelWidth: number;
  sidebarLineWidth: number;
  detailContentWidth: number;
}

export interface MonitorVisibleModel {
  view: "sessions" | "providers";
  width: number;
  height: number;
  title: string;
  online: string;
  activity: string;
  projectsVisible: boolean;
  projectsTitle: string;
  projectsContent: TextTableContent;
  sessionsWidth: number;
  sessionsTitle: string;
  sessionsVisible: boolean;
  sessionsContent: TextTableContent;
  providersVisible: boolean;
  providersContent: TextTableContent;
  detailsVisible: boolean;
  detailsWidth: number;
  detailsTitle: string;
  detailsContent: string | StyledText;
  footer: string;
  footerError: boolean;
}

const PALETTE = {
  bg: "transparent",
  panel: "transparent",
  fg: RGBA.defaultForeground(),
  muted: "#a2abb8",
  dim: "#596170",
  border: "#303846",
  blue: "#6aa8ff",
  green: "#64d38a",
  yellow: "#e3bd5b",
  red: "#ff6b63",
  cyan: "#68cfd8",
} as const;

const COLOR_CACHE = new Map<string, ReturnType<typeof parseColor>>();

function normalizedVisibleValue(value: unknown): unknown {
  if (value instanceof Map) {
    return [...value.entries()]
      .map(([key, entry]) => [String(key), normalizedVisibleValue(entry)])
      .sort(([left], [right]) => String(left).localeCompare(String(right)));
  }
  if (value instanceof Set) {
    return [...value].map(normalizedVisibleValue).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  }
  if (Array.isArray(value)) return value.map(normalizedVisibleValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalizedVisibleValue(entry)]),
    );
  }
  return value;
}

export function visibleModelFingerprint(model: unknown): string {
  return JSON.stringify(normalizedVisibleValue(model));
}

export function createVisibleModelUpdater<T>(render: (model: T) => void): (model: T) => boolean {
  let previousFingerprint: string | undefined;
  return model => {
    const fingerprint = visibleModelFingerprint(model);
    if (fingerprint === previousFingerprint) return false;
    previousFingerprint = fingerprint;
    render(model);
    return true;
  };
}

function color(value: PaletteColor) {
  if (value instanceof RGBA) return value;
  let parsed = COLOR_CACHE.get(value);
  if (!parsed) {
    parsed = parseColor(value);
    COLOR_CACHE.set(value, parsed);
  }
  return parsed;
}

function chunk(text: string, fg?: PaletteColor, attributes = TextAttributes.NONE): TextChunk {
  const value: TextChunk = { __isChunk: true, text };
  if (fg) value.fg = color(fg);
  if (attributes !== TextAttributes.NONE) value.attributes = attributes;
  return value;
}

function cell(text: unknown, fg?: PaletteColor, attributes = TextAttributes.NONE): TextChunk[] {
  return [chunk(String(text ?? ""), fg, attributes)];
}

function header(text: string): TextChunk[] {
  return cell(text, PALETTE.fg, TextAttributes.BOLD);
}

function projectKey(s: Session): string {
  const path = rawProjectPath(s);
  return path ? `path:${compactPath(path)}` : `name:${projectName(s)}`;
}

function statusLabel(status: string): string {
  if (status === "working") return "RUN";
  if (status === "blocked") return "WAIT";
  if (status === "error") return "ERR";
  return "IDLE";
}

function statusColor(status: string): string {
  if (status === "working") return PALETTE.blue;
  if (status === "blocked") return PALETTE.yellow;
  if (status === "error") return PALETTE.red;
  return PALETTE.green;
}

function defaultActivity(status: string): string {
  if (status === "working") return "active";
  if (status === "blocked") return "waiting for input";
  if (status === "error") return "needs attention";
  return "ready";
}

function activityText(s: Session): string {
  const detail = (s.task_name || "").trim() || defaultActivity(s.status);
  const progress = firstFiniteNumber(s.progress);
  if (progress === undefined) return detail;
  const pct = progress <= 1 && progress >= 0 ? progress * 100 : progress;
  return `${detail} ${Math.round(Math.max(0, Math.min(100, pct)))}%`;
}

function statusCounts(sessions: readonly Session[]) {
  let working = 0;
  let idle = 0;
  let blocked = 0;
  let errored = 0;
  for (const s of sessions) {
    if (s.status === "working") working++;
    else if (s.status === "blocked") blocked++;
    else if (s.status === "error") errored++;
    else idle++;
  }
  return { working, idle, blocked, errored, total: sessions.length };
}

function inlineStatus(sessions: readonly Session[]): string {
  const counts = statusCounts(sessions);
  const parts = [
    counts.working > 0 ? `${counts.working} work` : "",
    counts.blocked > 0 ? `${counts.blocked} wait` : "",
    counts.errored > 0 ? `${counts.errored} err` : "",
    counts.idle > 0 ? `${counts.idle} idle` : "",
  ].filter(Boolean);
  return parts.join(", ") || "none";
}

function latestTimestamp(sessions: readonly Session[]): number {
  return sessions.length > 0 ? Math.max(...sessions.map(s => s.timestamp || 0)) : Date.now();
}

function groupByProject(sessions: readonly Session[]): Map<string, Session[]> {
  return groupSessionsByProject(sessions) as unknown as Map<string, Session[]>;
}

function applyFilter(sessions: readonly Session[], filterText: string): Session[] {
  if (!filterText) return [...sessions];
  const q = filterText.toLowerCase();
  return sessions.filter(s =>
    projectName(s).toLowerCase().includes(q) ||
    (s.project_path || "").toLowerCase().includes(q) ||
    (s.session_name || "").toLowerCase().includes(q) ||
    (s.task_name || "").toLowerCase().includes(q) ||
    (s.session_type || "").toLowerCase().includes(q)
  );
}

function projectKeys(state: Readonly<MonitorState>): string[] {
  return [...groupByProject(applyFilter(state.sessions, state.filterText)).keys()];
}

function clampState(state: MonitorState): MonitorState {
  const filtered = applyFilter(state.sessions, state.filterText);
  const groups = groupByProject(filtered);
  const keys = [...groups.keys()];
  if (keys.length === 0) {
    return {
      ...state,
      projectCursorKey: null,
      projectFocusKey: null,
      selectedIdx: -1,
      selectedId: null,
      detailId: null,
    };
  }

  const projectCursorKey = state.projectCursorKey && groups.has(state.projectCursorKey)
    ? state.projectCursorKey
    : keys[0] || null;
  let projectFocusKey = state.projectFocusKey && groups.has(state.projectFocusKey)
    ? state.projectFocusKey
    : null;
  let selectedIdx = state.selectedIdx;
  let selectedId = state.selectedId;
  let detailId = state.detailId;

  if (!projectFocusKey) {
    selectedIdx = -1;
    selectedId = null;
    detailId = null;
  } else {
    const sessions = groups.get(projectFocusKey) || [];
    const byId = selectedId ? sessions.findIndex(s => s.session_id === selectedId) : -1;
    selectedIdx = byId >= 0 ? byId : Math.max(0, Math.min(selectedIdx, sessions.length - 1));
    selectedId = sessions[selectedIdx]?.session_id || null;
    if (detailId && !sessions.some(s => s.session_id === detailId)) detailId = null;
    if (sessions.length === 0) projectFocusKey = null;
  }

  const unreadSessionIds = new Set(state.unreadSessionIds);
  if (selectedId) unreadSessionIds.delete(selectedId);

  return { ...state, projectCursorKey, projectFocusKey, selectedIdx, selectedId, detailId, unreadSessionIds };
}

function moveProject(state: Readonly<MonitorState>, delta: number): MonitorState {
  const keys = projectKeys(state);
  if (keys.length === 0) return clampState({ ...state });
  const current = state.projectCursorKey ? keys.indexOf(state.projectCursorKey) : -1;
  const next = Math.max(0, Math.min(keys.length - 1, (current >= 0 ? current : 0) + delta));
  return clampState({ ...state, projectCursorKey: keys[next] || null });
}

function selectedProjectSessions(state: Readonly<MonitorState>): Session[] {
  const shown = applyFilter(state.sessions, state.filterText);
  const groups = groupByProject(shown);
  const key = state.projectFocusKey || state.projectCursorKey;
  return key ? groups.get(key) || [] : shown;
}

function moveSession(state: Readonly<MonitorState>, delta: number): MonitorState {
  if (!state.projectFocusKey) return moveProject(state, delta);
  const sessions = selectedProjectSessions(state);
  if (sessions.length === 0) return clampState({ ...state });
  const byId = state.selectedId ? sessions.findIndex(s => s.session_id === state.selectedId) : -1;
  const base = byId >= 0 ? byId : Math.max(0, state.selectedIdx);
  const selectedIdx = Math.max(0, Math.min(sessions.length - 1, base + delta));
  return clampState({
    ...state,
    selectedIdx,
    selectedId: sessions[selectedIdx]?.session_id || null,
  });
}

function focusProject(state: Readonly<MonitorState>): MonitorState {
  const groups = groupByProject(applyFilter(state.sessions, state.filterText));
  const keys = [...groups.keys()];
  const projectFocusKey = state.projectCursorKey && groups.has(state.projectCursorKey)
    ? state.projectCursorKey
    : keys[0] || null;
  const sessions = projectFocusKey ? groups.get(projectFocusKey) || [] : [];
  return clampState({
    ...state,
    projectCursorKey: projectFocusKey,
    projectFocusKey,
    selectedIdx: sessions.length > 0 ? 0 : -1,
    selectedId: sessions[0]?.session_id || null,
    detailId: null,
  });
}

function toggleDetail(state: Readonly<MonitorState>): MonitorState {
  if (!state.projectFocusKey) return focusProject(state);
  const sessions = selectedProjectSessions(state);
  const selected = sessions[Math.max(0, state.selectedIdx)];
  if (!selected) return clampState({ ...state });
  return clampState({
    ...state,
    selectedId: selected.session_id,
    detailId: state.detailId === selected.session_id ? null : selected.session_id,
  });
}

function clearProjectFocus(state: Readonly<MonitorState>): MonitorState {
  return clampState({
    ...state,
    projectFocusKey: null,
    selectedIdx: -1,
    selectedId: null,
    detailId: null,
  });
}

function contextPercent(s: Session): number | undefined {
  const raw = firstFiniteNumber(s.context_percent, (s as any).context_pct, (s as any).context);
  if (raw === undefined) return undefined;
  return Math.max(0, Math.min(100, raw <= 1 && raw >= 0 ? raw * 100 : raw));
}

export function monitorBodyLayout(rendererWidth: number): MonitorBodyLayout {
  const bodyWidth = Math.max(20, Math.floor(rendererWidth) - 2);
  const gap = bodyWidth >= 48 ? 1 : 0;
  const minDetail = bodyWidth >= 90 ? 44 : 32;
  const minSidebar = bodyWidth >= 90 ? 34 : 24;
  const maxSidebar = bodyWidth >= 140 ? 46 : 42;
  const available = bodyWidth - gap;
  const effectiveMinDetail = Math.min(minDetail, Math.max(10, available - 12));
  const effectiveMinSidebar = Math.min(minSidebar, Math.max(10, available - effectiveMinDetail));
  const sidebarMax = Math.max(effectiveMinSidebar, Math.min(maxSidebar, available - effectiveMinDetail));
  const sidebarPanelWidth = clampNumber(Math.round(bodyWidth * 0.31), effectiveMinSidebar, sidebarMax);
  const detailPanelWidth = available - sidebarPanelWidth;

  return {
    bodyWidth,
    gap,
    sidebarPanelWidth,
    detailPanelWidth,
    sidebarLineWidth: Math.max(1, sidebarPanelWidth - 4),
    detailContentWidth: Math.max(1, detailPanelWidth - 4),
  };
}

function sessionIdLabel(s: Session): string {
  return String(s.session_id || "?").split("__")[0]!;
}

function agentsText(sessions: readonly Session[]): string {
  const counts = new Map<string, number>();
  for (const s of sessions) {
    const type = s.session_type || "?";
    counts.set(type, (counts.get(type) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([type, count]) => `${agentName(type)}${count > 1 ? ` x${count}` : ""}`)
    .join(", ");
}

function projectRows(groups: Map<string, Session[]>, state: Readonly<MonitorState>, now = Date.now()): ProjectRow[] {
  return [...groups.entries()].map(([key, sessions]) => {
    const sample = sessions[0]!;
    const marker = key === state.projectFocusKey ? "*" : key === state.projectCursorKey ? ">" : "";
    return {
      key,
      marker,
      project: projectName(sample),
      sessions: sessions.length,
      agents: agentsText(sessions),
      status: inlineStatus(sessions),
      path: projectPathSummary(sessions),
      age: age(latestTimestamp(sessions), now),
    };
  });
}

function sessionRows(sessions: readonly Session[], state: Readonly<MonitorState>): SessionRow[] {
  return sessions.map((session, index) => {
    const unread = state.unreadSessionIds.has(session.session_id);
    return {
      key: session.session_id || `${projectKey(session)}:${index}`,
      source: session,
      statusKind: session.status,
      unread,
    };
  });
}

function visibleWindow<T>(rows: readonly T[], selectedIndex: number, slots: number): readonly T[] {
  if (rows.length <= slots || slots <= 0) return rows;
  const safeSelected = Math.max(0, Math.min(rows.length - 1, selectedIndex));
  let offset = Math.max(0, safeSelected - Math.floor(slots / 2));
  offset = Math.min(offset, Math.max(0, rows.length - slots));
  return rows.slice(offset, offset + slots);
}

function projectTableContent(rows: readonly ProjectRow[], state: Readonly<MonitorState>, renderer: CliRenderer): TextTableContent {
  const compact = renderer.width < 100;
  const content: TextTableContent = compact
    ? [[header(""), header("Project"), header("Sessions"), header("Agents"), header("Status")]]
    : [[header(""), header("Project"), header("Sessions"), header("Agents"), header("Status"), header("Path"), header("Age")]];
  if (rows.length === 0) return [[cell("No projects reporting yet", PALETTE.muted)]];

  const selectedIndex = state.projectCursorKey ? rows.findIndex(row => row.key === state.projectCursorKey) : 0;
  const slots = Math.max(2, Math.min(6, renderer.height - 13));
  const visible = visibleWindow(rows, selectedIndex, slots);
  for (const row of visible) {
    const selected = row.key === state.projectCursorKey;
    const strong = selected ? TextAttributes.BOLD : TextAttributes.NONE;
    const base = [
      cell(row.marker, row.marker ? PALETTE.blue : PALETTE.muted, strong),
      cell(row.project, PALETTE.fg, strong),
      cell(row.sessions, PALETTE.fg, strong),
      cell(row.agents, PALETTE.cyan, strong),
      cell(row.status, PALETTE.fg, strong),
    ];
    content.push(compact ? base : [
      ...base,
      cell(row.path, PALETTE.muted, strong),
      cell(row.age, PALETTE.muted, strong),
    ]);
  }
  if (visible.length < rows.length) {
    content.push([cell(`... ${rows.length - visible.length} more project${rows.length - visible.length === 1 ? "" : "s"}`, PALETTE.muted)]);
  }
  return content;
}

function sessionTableContent(rows: readonly SessionRow[], state: Readonly<MonitorState>, renderer: CliRenderer, now = Date.now()): TextTableContent {
  const content: TextTableContent = [];
  if (rows.length === 0) return [[cell(state.filterText ? "No sessions match the current filter" : "No sessions reporting yet", PALETTE.muted)]];

  const selectedIndex = state.projectFocusKey ? Math.max(0, state.selectedIdx) : 0;
  const slots = Math.max(4, renderer.height - 17);
  const visible = visibleWindow(rows, selectedIndex, slots);
  const lineWidth = monitorBodyLayout(renderer.width).sidebarLineWidth;
  for (const row of visible) {
    const selected = state.projectFocusKey && row.key === state.selectedId;
    const attrs = selected || row.unread ? TextAttributes.BOLD : TextAttributes.NONE;
    const fg = row.unread && !selected ? PALETTE.yellow : selected ? PALETTE.fg : statusColor(row.statusKind);
    content.push([cell(buildSessionSidebarLine(row.source, {
      selected: Boolean(selected),
      unread: row.unread,
      width: lineWidth,
      now,
    }), fg, attrs)]);
  }
  if (visible.length < rows.length) {
    content.push([cell(`... ${rows.length - visible.length} more session${rows.length - visible.length === 1 ? "" : "s"}`, PALETTE.muted)]);
  }
  return content;
}

export function providerSummaryLine(row: PlanRow): string {
  const form = providerFormLabel(row);
  const label = row.label || row.provider || "?";
  if (row.form === "api") {
    const unit = row.unit ? ` ${row.unit}` : "";
    const parts = [
      row.remaining !== undefined ? `remaining ${compactNumber(row.remaining)}${unit}` : "",
      row.used !== undefined ? `used ${compactNumber(row.used)}${unit}` : "",
      row.limit !== undefined ? `limit ${compactNumber(row.limit)}${unit}` : "",
    ].filter(Boolean);
    return parts.length ? `${label} ${form} | ${parts.join(" · ")}` : `${label} ${form}`;
  }
  const unit = row.unit ? ` ${row.unit}` : "";
  const parts = [
    row.used !== undefined && row.limit !== undefined ? `used ${compactNumber(row.used)}/${compactNumber(row.limit)}${unit}` : "",
    row.remaining !== undefined && row.limit !== undefined && row.used === undefined ? `${Math.round(row.remaining)}% left` : "",
    row.level ? `level ${row.level}` : "",
    row.pacing ? `pacing ${row.pacing}` : "",
    row.cardTiming ? `card ${row.cardTiming}` : "",
    row.autoResetIn ? `reset ${row.autoResetIn}` : "",
  ].filter(Boolean);
  return parts.length ? `${label} ${form} | ${parts.join(" · ")}` : `${label} ${form}`;
}

function providerFormLabel(row: PlanRow): string {
  return row.form === "api" ? "API" : "Subscription";
}

function providerLeftText(row: PlanRow): string {
  if (row.form === "api") {
    const unit = row.unit ? ` ${row.unit}` : "";
    if (row.remaining !== undefined) return `${compactNumber(row.remaining)}${unit} left`;
    if (row.used !== undefined && row.limit !== undefined) return `${compactNumber(row.used)}/${compactNumber(row.limit)}${unit}`;
    if (row.used !== undefined) return `${compactNumber(row.used)} used`;
    if (row.limit !== undefined) return `${compactNumber(row.limit)} limit`;
    return "—";
  }
  const unit = row.unit ? ` ${row.unit}` : "";
  if (row.used !== undefined && row.limit !== undefined) {
    return `${compactNumber(row.used)}/${compactNumber(row.limit)}${unit}`;
  }
  return row.remaining !== undefined ? `${Math.round(row.remaining)}%` : "—";
}

function levelColor(level: string): string {
  if (level === "red") return PALETTE.red;
  if (level === "yellow") return PALETTE.yellow;
  return PALETTE.green;
}

export function providerTableContent(rows: readonly PlanRow[], renderer: CliRenderer, error?: string): TextTableContent {
  if (error) return [[cell(error, PALETTE.red)]];
  if (rows.length === 0) return [[cell("No quota data", PALETTE.muted)]];
  const compact = renderer.width < 100;
  const content: TextTableContent = compact
    ? [[header("Provider"), header("Left"), header("Reset")]]
    : [[header("Provider"), header("Left"), header("Level"), header("Reset"), header("Card")]];
  const visible = rows;
  for (const row of visible) {
    const rowFg = row.form === "api" ? PALETTE.cyan : levelColor(row.level);
    const providerCell = cell(row.label || row.provider || "?", PALETTE.fg);
    const leftCell = cell(providerLeftText(row), rowFg);
    const resetCell = cell(row.autoResetIn || "", PALETTE.muted);
    content.push(compact
      ? [providerCell, leftCell, resetCell]
      : [
          providerCell,
          leftCell,
          cell(row.form === "api" ? "" : row.level, row.form === "api" ? PALETTE.muted : rowFg),
          resetCell,
          cell(row.form === "api" ? "" : row.cardTiming || "", PALETTE.muted),
        ]);
  }
  return content;
}


function healthScore(sessions: readonly Session[], now = Date.now()): { score: number; label: string; color: string } {
  if (sessions.length === 0) return { score: 0, label: "waiting for sessions", color: PALETTE.muted };
  const counts = statusCounts(sessions);
  const stale = sessions.filter(s => now - (s.timestamp || 0) > 120_000).length;
  const highContext = sessions.filter(s => (contextPercent(s) || 0) >= 85).length;
  const penalty = counts.errored * 35 + counts.blocked * 20 + stale * 10 + highContext * 8;
  const score = Math.max(0, Math.min(100, 100 - penalty));
  if (counts.errored) return { score, label: `${counts.errored} error`, color: PALETTE.red };
  if (counts.blocked) return { score, label: `${counts.blocked} blocked`, color: PALETTE.yellow };
  if (highContext) return { score, label: `${highContext} high context`, color: PALETTE.yellow };
  if (counts.working) return { score, label: `${counts.working} working`, color: PALETTE.blue };
  return { score, label: "stable", color: PALETTE.green };
}

function selectedSession(state: Readonly<MonitorState>): Session | null {
  if (!state.projectFocusKey) return null;
  const sessions = selectedProjectSessions(state);
  if (state.detailId) return sessions.find(s => s.session_id === state.detailId) || null;
  return sessions[Math.max(0, state.selectedIdx)] || null;
}

function activityForDisplay(s: Session): string {
  const activity = activityText(s);
  return s.status === "idle" && /^ready$/i.test(activity) ? "" : activity;
}

function activitySessions(scope: readonly Session[]): Session[] {
  const rank: Record<string, number> = { working: 3, blocked: 2, error: 1, idle: 0 };
  return [...scope]
    .filter(s => s.status !== "idle" || !!activityForDisplay(s))
    .sort((a, b) =>
      (rank[b.status] ?? 0) - (rank[a.status] ?? 0) ||
      (b.timestamp || 0) - (a.timestamp || 0) ||
      sessionIdLabel(a).localeCompare(sessionIdLabel(b))
    );
}

function projectActivityLines(scope: readonly Session[]): string[] {
  const active = activitySessions(scope).slice(0, 4);
  if (active.length === 0) return ["activity none"];
  return [
    "activity",
    ...active.map(s => `  ${statusLabel(s.status)} ${agentName(s.session_type)} ${truncatePlain(activityForDisplay(s) || statusLabel(s.status), 96)}`),
  ];
}

function projectTailLines(scope: readonly Session[]): string[] {
  const source = activitySessions(scope).find(s => s.activity_tail && s.activity_tail.length > 0);
  const tail = source?.activity_tail?.slice(-4) || [];
  if (tail.length === 0) return [];
  return [
    "",
    "tail",
    ...tail.map(line => `  ${truncatePlain(line, 120)}`),
  ];
}

function detailTextForProject(
  scope: readonly Session[],
  all: readonly Session[],
  opts: RuntimeDisplayOptions,
  now = Date.now(),
): string {
  if (scope.length === 0) {
    return [
      "PROJECT none selected",
      `All sessions ${all.length}`,
      "",
      `API ${opts.apiHost}:${displayPort(opts)}`,
      `State ${compactPath(opts.stateDir)}`,
    ].join("\n");
  }

  const sample = scope[0]!;
  const health = healthScore(scope, now);
  return [
    `PROJECT ${projectName(sample)}`,
    `path ${projectPathSummary(scope)}`,
    `sessions ${scope.length}`,
    `agents ${agentsText(scope)}`,
    `status ${inlineStatus(scope)}`,
    `health ${health.score} | ${health.label}`,
    `latest ${age(latestTimestamp(scope), now)}`,
    "",
    ...projectActivityLines(scope),
    ...projectTailLines(scope),
    "",
    `API ${opts.apiHost}:${displayPort(opts)}`,
    `State ${compactPath(opts.stateDir)}`,
  ].join("\n");
}

const SYSTEM_DASHBOARD_MIN_WIDTH = 64;
const SYSTEM_DASHBOARD_GAP = 3;
const SYSTEM_DASHBOARD_LABEL_WIDTH = 12;

function systemDashboardColumns(width: number): { left: number; gap: number; right: number } {
  const gap = SYSTEM_DASHBOARD_GAP;
  const left = Math.floor((width - gap) / 2);
  return { left, gap, right: width - left - gap };
}

function systemDashboardPair(left: string, right: string, width: number, alignRight = false): string {
  const columns = systemDashboardColumns(width);
  const leftText = truncatePlain(left, columns.left).padEnd(columns.left);
  const rightValue = truncatePlain(right, columns.right);
  const rightText = alignRight ? rightValue.padStart(columns.right) : rightValue;
  return truncatePlain(`${leftText}${" ".repeat(columns.gap)}${rightText}`, width);
}

function systemDashboardMetricLine(label: string, left: string, right: string, width: number): string {
  const labelWidth = Math.min(SYSTEM_DASHBOARD_LABEL_WIDTH, Math.max(1, width));
  const contentWidth = Math.max(1, width - labelWidth);
  const content = systemDashboardPair(left, right, contentWidth);
  return truncatePlain(`${truncatePlain(label, labelWidth).padEnd(labelWidth)}${content}`, width);
}

function systemMetricColor(value: number | undefined): PaletteColor {
  if (value === undefined || !Number.isFinite(value)) return PALETTE.muted;
  if (value >= 90) return PALETTE.red;
  if (value >= 70) return PALETTE.yellow;
  return PALETTE.green;
}

function systemMetricStatus(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "UNAVAILABLE";
  if (value >= 90) return "CRITICAL";
  if (value >= 70) return "HIGH";
  return "NORMAL";
}

function systemFreshnessColor(sampleAge: number | undefined): PaletteColor {
  if (sampleAge === undefined) return PALETTE.muted;
  if (sampleAge <= 5) return PALETTE.green;
  if (sampleAge <= 15) return PALETTE.yellow;
  return PALETTE.red;
}

function systemTemperatureColor(
  value: number | undefined,
  warning: number,
  critical: number,
): PaletteColor {
  if (value === undefined || !Number.isFinite(value)) return PALETTE.muted;
  if (value >= critical) return PALETTE.red;
  if (value >= warning) return PALETTE.yellow;
  return PALETTE.green;
}

function formatTemperature(value: number | undefined): string {
  return value === undefined || !Number.isFinite(value) ? "—" : `${value.toFixed(1)}°C`;
}

function systemOverviewLines(
  snapshot: SystemEfficiencySnapshot | undefined,
  width: number,
  now: number,
): string[] {
  const safeWidth = Math.max(1, Math.floor(width));
  const barWidth = Math.max(3, Math.min(12, safeWidth - 28));
  const cpu = snapshot?.cpu_percent;
  const memory = snapshot?.memory_percent;
  const load = snapshot?.load_average;
  const sampleAge = snapshot ? Math.max(0, Math.floor((now - snapshot.sampled_at) / 1000)) : undefined;

  if (safeWidth < SYSTEM_DASHBOARD_MIN_WIDTH) {
    const compact = safeWidth < 40;
    const loadValues = load?.map(value => value.toFixed(2)) ?? ["—", "—", "—"];
    return (compact
      ? [
          `CPU ${percentValue(cpu)} ${systemProgressBar(cpu, 100, barWidth)}`,
          "Load Average",
          `  1m   ${loadValues[0]}`,
          `  5m   ${loadValues[1]}`,
          ` 15m   ${loadValues[2]}`,
          "Tasks running/waiting vs cores",
          `Memory ${compactBytes(snapshot?.memory_used_bytes)}/${compactBytes(snapshot?.memory_total_bytes)} ${percentValue(memory)}`,
          `Download ${compactByteRate(snapshot?.network_down_bytes_per_second)}`,
          `Upload ${compactByteRate(snapshot?.network_up_bytes_per_second)}`,
          `Device ${formatTemperature(snapshot?.device_temperature_celsius)}`,
          `Battery ${formatTemperature(snapshot?.battery_temperature_celsius)}`,
          `Sample ${sampleAge === undefined ? "waiting" : `${sampleAge}s ago`}`,
        ]
      : [
          `CPU        ${percentValue(cpu)} ${systemProgressBar(cpu, 100, barWidth)}`,
          "Load Average",
          `  1m       ${loadValues[0]}`,
          `  5m       ${loadValues[1]}`,
          ` 15m       ${loadValues[2]}`,
          "Tasks running/waiting vs cores",
          `Memory     ${formatSystemBytes(snapshot?.memory_used_bytes)} / ${formatSystemBytes(snapshot?.memory_total_bytes)} ${percentValue(memory)} ${systemProgressBar(memory, 100, barWidth)}`,
          `Download   ${formatByteRate(snapshot?.network_down_bytes_per_second)}`,
          `Upload     ${formatByteRate(snapshot?.network_up_bytes_per_second)}`,
          `Device     ${formatTemperature(snapshot?.device_temperature_celsius)}`,
          `Battery    ${formatTemperature(snapshot?.battery_temperature_celsius)}`,
          `Sample     ${sampleAge === undefined ? "waiting" : `${sampleAge}s ago`}`,
        ]).map(line => truncatePlain(line, safeWidth));
  }

  const dashboardBarWidth = Math.max(8, Math.min(18, systemDashboardColumns(safeWidth).left));
  const freshness = sampleAge === undefined ? "WAITING" : `LIVE ${sampleAge}s`;
  const loadValues = load?.map(value => value.toFixed(2)) ?? ["—", "—", "—"];
  return [
    systemDashboardPair("SYSTEM / HOST", freshness, safeWidth, true),
    "",
    systemDashboardPair("CPU / HOST", "MEMORY", safeWidth),
    systemDashboardPair(percentValue(cpu), percentValue(memory), safeWidth),
    systemDashboardPair(
      systemProgressBar(cpu, 100, dashboardBarWidth),
      systemProgressBar(memory, 100, dashboardBarWidth),
      safeWidth,
    ),
    systemDashboardPair(
      systemMetricStatus(cpu),
      `${formatSystemBytes(snapshot?.memory_used_bytes)} / ${formatSystemBytes(snapshot?.memory_total_bytes)}`,
      safeWidth,
    ),
    "",
    "LOAD AVERAGE",
    `  1 min  ${loadValues[0]}`,
    `  5 min  ${loadValues[1]}`,
    ` 15 min  ${loadValues[2]}`,
    "Running or waiting tasks · compare with CPU cores",
    "─".repeat(safeWidth),
    "TEMPERATURE",
    systemDashboardPair("DEVICE / CPU", "BATTERY", safeWidth),
    systemDashboardPair(
      formatTemperature(snapshot?.device_temperature_celsius),
      formatTemperature(snapshot?.battery_temperature_celsius),
      safeWidth,
    ),
    systemDashboardMetricLine(
      "DOWNLOAD",
      formatByteRate(snapshot?.network_down_bytes_per_second),
      "",
      safeWidth,
    ),
    systemDashboardMetricLine(
      "UPLOAD",
      formatByteRate(snapshot?.network_up_bytes_per_second),
      "",
      safeWidth,
    ),
  ].map(line => truncatePlain(line, safeWidth));
}

export function systemOverviewText(
  snapshot: SystemEfficiencySnapshot | undefined,
  width = 44,
  now = Date.now(),
): string {
  return systemOverviewLines(snapshot, width, now).join("\n");
}

function pushSystemLine(chunks: TextChunk[], parts: readonly TextChunk[], addNewline: boolean): void {
  chunks.push(...parts);
  if (addNewline) chunks.push(chunk("\n"));
}

export function systemOverviewContent(
  snapshot: SystemEfficiencySnapshot | undefined,
  width = 44,
  now = Date.now(),
): string | StyledText {
  const safeWidth = Math.max(1, Math.floor(width));
  if (safeWidth < SYSTEM_DASHBOARD_MIN_WIDTH) {
    return systemOverviewText(snapshot, safeWidth, now);
  }

  const lines = systemOverviewLines(snapshot, safeWidth, now);
  const columns = systemDashboardColumns(safeWidth);
  const rightStart = columns.left + columns.gap;
  const labelWidth = Math.min(SYSTEM_DASHBOARD_LABEL_WIDTH, safeWidth);
  const cpuColor = systemMetricColor(snapshot?.cpu_percent);
  const memoryColor = systemMetricColor(snapshot?.memory_percent);
  const deviceTemperatureColor = systemTemperatureColor(snapshot?.device_temperature_celsius, 70, 85);
  const batteryTemperatureColor = systemTemperatureColor(snapshot?.battery_temperature_celsius, 35, 45);
  const sampleAge = snapshot ? Math.max(0, Math.floor((now - snapshot.sampled_at) / 1000)) : undefined;
  const chunks: TextChunk[] = [];

  const paired = (line: string, leftColor: PaletteColor, rightColor: PaletteColor, attributes = TextAttributes.NONE): TextChunk[] => [
    chunk(line.slice(0, columns.left), leftColor, attributes),
    chunk(line.slice(columns.left, rightStart), PALETTE.dim),
    chunk(line.slice(rightStart), rightColor, attributes),
  ];

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const addNewline = index < lines.length - 1;
    if (index === 0) {
      pushSystemLine(chunks, paired(line, PALETTE.fg, systemFreshnessColor(sampleAge), TextAttributes.BOLD), addNewline);
    } else if (index === 2) {
      pushSystemLine(chunks, paired(line, PALETTE.muted, PALETTE.muted, TextAttributes.BOLD), addNewline);
    } else if (index >= 3 && index <= 5) {
      pushSystemLine(chunks, paired(line, cpuColor, memoryColor, index === 3 ? TextAttributes.BOLD : TextAttributes.NONE), addNewline);
    } else if (index === 7) {
      pushSystemLine(chunks, [chunk(line, PALETTE.muted, TextAttributes.BOLD)], addNewline);
    } else if (index >= 8 && index <= 10) {
      pushSystemLine(chunks, [chunk(line, PALETTE.fg, TextAttributes.BOLD)], addNewline);
    } else if (index === 11) {
      pushSystemLine(chunks, [chunk(line, PALETTE.muted)], addNewline);
    } else if (index === 12) {
      pushSystemLine(chunks, [chunk(line, PALETTE.dim)], addNewline);
    } else if (index === 13) {
      pushSystemLine(chunks, [chunk(line, PALETTE.muted, TextAttributes.BOLD)], addNewline);
    } else if (index === 14) {
      pushSystemLine(chunks, paired(line, PALETTE.muted, PALETTE.muted, TextAttributes.BOLD), addNewline);
    } else if (index === 15) {
      pushSystemLine(chunks, paired(line, deviceTemperatureColor, batteryTemperatureColor, TextAttributes.BOLD), addNewline);
    } else if (index === 16 || index === 17) {
      pushSystemLine(chunks, [chunk(line.slice(0, labelWidth), PALETTE.muted, TextAttributes.BOLD), chunk(line.slice(labelWidth), PALETTE.cyan)], addNewline);
    } else {
      pushSystemLine(chunks, [chunk(line)], addNewline);
    }
  }

  return new StyledText(chunks);
}

function percentValue(value: number | undefined): string {
  return value === undefined ? "—" : `${value.toFixed(1)}%`;
}

function formatByteRate(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value) || value < 0) return "—";
  if (value < 1000) return `${value.toFixed(1)} B/s`;
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)} KB/s`;
  if (value < 1_000_000_000) return `${(value / 1_000_000).toFixed(1)} MB/s`;
  return `${(value / 1_000_000_000).toFixed(1)} GB/s`;
}

function compactBytes(value: number | undefined): string {
  return formatSystemBytes(value).replace(" ", "");
}

function compactByteRate(value: number | undefined): string {
  return formatByteRate(value).replace(" ", "");
}

function systemProgressBar(value: number | undefined, max: number, width: number): string {
  const safeWidth = Math.max(1, Math.floor(width));
  if (value === undefined || !Number.isFinite(value) || !Number.isFinite(max) || max <= 0) {
    return "·".repeat(safeWidth);
  }
  const filled = Math.max(0, Math.min(safeWidth, Math.round((value / max) * safeWidth)));
  return "█".repeat(filled) + "░".repeat(safeWidth - filled);
}

function formatSystemBytes(value: number | undefined): string {
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

function detailTextForSession(session: Session, tab: DetailTab, width: number, now = Date.now()): StyledText {
  return buildSessionDetailChunks(session, tab, width, now);
}

function detailTabTitle(tab: DetailTab): string {
  return tab[0]!.toUpperCase() + tab.slice(1);
}

function createRefs(renderer: CliRenderer, opts: OpenTuiMonitorOptions): MonitorRefs {
  renderer.setBackgroundColor(PALETTE.bg);

  const root = new BoxRenderable(renderer, {
    id: "sessionbar-root",
    width: "100%",
    height: "100%",
    flexDirection: "column",
    padding: 1,
    gap: 1,
    backgroundColor: PALETTE.bg,
  });
  renderer.root.add(root);

  const headerBox = new BoxRenderable(renderer, {
    id: "sessionbar-header",
    width: "100%",
    height: 1,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    backgroundColor: PALETTE.bg,
  });
  const title = new TextRenderable(renderer, {
    id: "sessionbar-title",
    content: "SessionBar",
    fg: PALETTE.fg,
    bg: PALETTE.bg,
    attributes: TextAttributes.BOLD,
    selectable: false,
  });
  const online = new TextRenderable(renderer, {
    id: "sessionbar-online",
    content: `online :${displayPort(opts)}`,
    fg: PALETTE.green,
    bg: PALETTE.bg,
    selectable: false,
  });
  headerBox.add(title);
  headerBox.add(online);

  const activity = new TextRenderable(renderer, {
    id: "sessionbar-activity",
    content: "",
    fg: PALETTE.muted,
    bg: PALETTE.bg,
    selectable: false,
    truncate: true,
  });

  const projectsBox = new BoxRenderable(renderer, {
    id: "sessionbar-projects-box",
    title: "Projects",
    titleColor: PALETTE.fg,
    border: true,
    borderStyle: "single",
    borderColor: PALETTE.border,
    width: "100%",
    height: 9,
    padding: 1,
    overflow: "hidden",
    backgroundColor: PALETTE.panel,
  });
  const projectsTable = new TextTableRenderable(renderer, {
    id: "sessionbar-projects",
    width: "100%",
    height: "100%",
    content: [],
    wrapMode: "none",
    columnWidthMode: "full",
    columnFitter: "proportional",
    columnGap: 1,
    border: false,
    showBorders: false,
    fg: PALETTE.fg,
    bg: PALETTE.panel,
  });
  projectsBox.add(projectsTable);

  const body = new BoxRenderable(renderer, {
    id: "sessionbar-body",
    width: "100%",
    flexGrow: 1,
    flexShrink: 1,
    flexDirection: "row",
    gap: 1,
    overflow: "hidden",
    backgroundColor: PALETTE.bg,
  });

  const sessionsBox = new BoxRenderable(renderer, {
    id: "sessionbar-sessions-box",
    title: "All Sessions",
    titleColor: PALETTE.fg,
    border: true,
    borderStyle: "single",
    borderColor: PALETTE.border,
    width: 46,
    flexGrow: 0,
    flexShrink: 0,
    padding: 1,
    overflow: "hidden",
    backgroundColor: PALETTE.panel,
  });
  const sessionsTable = new TextTableRenderable(renderer, {
    id: "sessionbar-sessions",
    width: "100%",
    height: "100%",
    content: [],
    wrapMode: "none",
    columnWidthMode: "full",
    columnFitter: "proportional",
    columnGap: 1,
    border: false,
    showBorders: false,
    fg: PALETTE.fg,
    bg: PALETTE.panel,
  });
  sessionsBox.add(sessionsTable);

  const providersTable = new TextTableRenderable(renderer, {
    id: "sessionbar-providers",
    width: "100%",
    height: "100%",
    content: [],
    wrapMode: "none",
    columnWidthMode: "full",
    columnFitter: "proportional",
    columnGap: 1,
    border: false,
    showBorders: false,
    fg: PALETTE.fg,
    bg: PALETTE.panel,
    visible: false,
  });
  sessionsBox.add(providersTable);

  const detailsBox = new BoxRenderable(renderer, {
    id: "sessionbar-details-box",
    title: "Details / Project",
    titleColor: PALETTE.fg,
    border: true,
    borderStyle: "single",
    borderColor: PALETTE.border,
    flexGrow: 1,
    flexShrink: 1,
    padding: 1,
    overflow: "hidden",
    backgroundColor: PALETTE.panel,
  });
  const detailsText = new TextRenderable(renderer, {
    id: "sessionbar-details",
    content: "",
    width: "100%",
    height: "100%",
    fg: PALETTE.fg,
    bg: PALETTE.panel,
    wrapMode: "word",
    selectable: true,
  });
  detailsBox.add(detailsText);

  body.add(sessionsBox);
  body.add(detailsBox);

  const footer = new TextRenderable(renderer, {
    id: "sessionbar-footer",
    content: "",
    fg: PALETTE.muted,
    bg: PALETTE.bg,
    selectable: false,
    truncate: true,
  });

  root.add(headerBox);
  root.add(activity);
  root.add(projectsBox);
  root.add(body);
  root.add(footer);

  return {
    root,
    title,
    online,
    activity,
    projectsBox,
    projectsTable,
    sessionsBox,
    sessionsTable,
    providersTable,
    detailsBox,
    detailsText,
    footer,
  };
}

export function monitorVisibleModel(
  state: Readonly<MonitorState>,
  renderer: CliRenderer,
  now = Date.now(),
  opts?: RuntimeDisplayOptions,
): MonitorVisibleModel {
  const port = displayPort(opts);
  const layout = monitorBodyLayout(renderer.width);
  if (state.view === "providers") {
    const providers = state.providers || [];
    const apiCount = providers.filter(row => row.form === "api").length;
    const subCount = providers.length - apiCount;
    const error = state.providersError;
    return {
      view: state.view,
      width: renderer.width,
      height: renderer.height,
      title: "SessionBar [Providers]",
      online: `online :${port || ""}`,
      activity: error
        ? "provider fetch failed"
        : [
            `${providers.length} provider${providers.length !== 1 ? "s" : ""}`,
            subCount > 0 ? `${subCount} subscription` : "",
            apiCount > 0 ? `${apiCount} api` : "",
          ].filter(Boolean).join("  "),
      projectsVisible: false,
      projectsTitle: "",
      projectsContent: [],
      sessionsWidth: layout.bodyWidth,
      sessionsTitle: `Providers (${providers.length})`,
      sessionsVisible: false,
      sessionsContent: [],
      providersVisible: true,
      providersContent: providerTableContent(providers, renderer, error),
      detailsVisible: false,
      detailsWidth: layout.detailPanelWidth,
      detailsTitle: "",
      detailsContent: "",
      footer: state.errorMsg ? `! ${state.errorMsg}` : "v / P  switch to sessions  r refresh  / filter  w web  q quit",
      footerError: Boolean(state.errorMsg),
    };
  }
  const shown = applyFilter(state.sessions, state.filterText);
  const groups = groupByProject(shown);
  const counts = statusCounts(state.sessions);
  const projectData = projectRows(groups, state, now);
  const scopeSessions = selectedProjectSessions(state);
  const sessionData = sessionRows(state.projectFocusKey ? scopeSessions : shown, state);
  const selected = selectedSession(state);
  const detailWidth = layout.detailContentWidth;
  const details = selected
    ? detailTextForSession(selected, state.detailTab, detailWidth, now)
    : state.projectFocusKey
      ? detailTextForProject(scopeSessions, shown, {
          apiHost: opts?.apiHost ?? "",
          port,
          getPort: opts?.getPort,
          stateDir: opts?.stateDir ?? "",
        }, now)
      : systemOverviewContent(state.system, detailWidth, now);
  const sessionTitle = state.projectFocusKey && scopeSessions[0]
    ? `Sessions / ${projectName(scopeSessions[0])}`
    : "All Sessions";

  const activity = [
    `${counts.total} session${counts.total !== 1 ? "s" : ""}`,
    counts.working > 0 ? `${counts.working} working` : "",
    counts.blocked > 0 ? `${counts.blocked} blocked` : "",
    counts.errored > 0 ? `${counts.errored} error` : "",
    counts.idle > 0 ? `${counts.idle} idle` : "",
    groups.size > 1 ? `${groups.size} projects` : "",
  ].filter(Boolean).join("  ");

  const footer = state.errorMsg
    ? `! ${state.errorMsg}`
    : state.filterActive
      ? `/${state.filterText}_  ${shown.length}/${state.sessions.length} sessions  Esc clear  Enter accept`
      : state.projectFocusKey
        ? "Up/Down session  Tab detail tab  1-5 scope  a/Backspace all projects  r refresh  v providers  / filter  w web  q quit"
        : "Up/Down project  Enter open project  r refresh  v providers  / filter  w web  q quit";

  return {
    view: state.view,
    width: renderer.width,
    height: renderer.height,
    title: "SessionBar [Sessions]",
    online: `online :${port || ""}`,
    activity,
    projectsVisible: true,
    projectsTitle: `Projects (${groups.size})`,
    projectsContent: projectTableContent(projectData, state, renderer),
    sessionsWidth: layout.sidebarPanelWidth,
    sessionsTitle: sessionTitle,
    sessionsVisible: true,
    sessionsContent: sessionTableContent(sessionData, state, renderer, now),
    providersVisible: false,
    providersContent: [],
    detailsVisible: true,
    detailsWidth: layout.detailPanelWidth,
    detailsTitle: selected
      ? `Details / Session / ${detailTabTitle(state.detailTab)}`
      : state.projectFocusKey ? "Details / Project" : "Details / System",
    detailsContent: details,
    footer,
    footerError: Boolean(state.errorMsg),
  };
}

function updateRefs(refs: MonitorRefs, model: MonitorVisibleModel): void {
  refs.title.content = model.title;
  refs.online.content = model.online;
  refs.activity.content = model.activity;
  refs.projectsBox.visible = model.projectsVisible;
  refs.projectsBox.title = model.projectsTitle;
  refs.projectsTable.content = model.projectsContent;
  refs.sessionsBox.width = model.sessionsWidth;
  refs.sessionsBox.title = model.sessionsTitle;
  refs.sessionsTable.visible = model.sessionsVisible;
  refs.sessionsTable.content = model.sessionsContent;
  refs.providersTable.visible = model.providersVisible;
  refs.providersTable.content = model.providersContent;
  refs.detailsBox.visible = model.detailsVisible;
  refs.detailsBox.width = model.detailsWidth;
  refs.detailsBox.title = model.detailsTitle;
  refs.detailsText.content = model.detailsContent;
  refs.footer.content = model.footer;
  refs.footer.fg = model.footerError ? PALETTE.red : PALETTE.muted;
}

function printableChar(key: KeyEvent): string {
  if (key.ctrl || key.meta || key.option) return "";
  const raw = key.raw || key.sequence || "";
  if (raw.length === 1 && raw >= " " && raw !== "\x7f") return raw;
  if (key.name.length === 1 && key.name >= " " && key.name !== "\x7f") return key.name;
  return "";
}

function isEnter(key: KeyEvent): boolean {
  return key.name === "return" || key.name === "linefeed" || key.name === "enter";
}

function isBackspace(key: KeyEvent): boolean {
  return key.name === "backspace" || key.name === "delete" || key.sequence === "\x7f";
}

type MonitorKeyLike = Pick<KeyEvent, "name"> & Partial<Pick<KeyEvent, "raw" | "sequence" | "ctrl" | "meta" | "option">>;

export function nextDetailTabFromMonitorKey(current: DetailTab, key: MonitorKeyLike): DetailTab | null {
  const normalized = {
    ...key,
    raw: key.raw || "",
    sequence: key.sequence || "",
    ctrl: Boolean(key.ctrl),
    meta: Boolean(key.meta),
    option: Boolean(key.option),
  } as KeyEvent;
  const scopeChar = printableChar(normalized);
  const numberedTab = detailTabByNumber(scopeChar);
  if (numberedTab) return numberedTab;
  if (normalized.name === "tab" || normalized.sequence === "\t" || scopeChar === "]") {
    return nextDetailTab(current, 1);
  }
  if (scopeChar === "[") return nextDetailTab(current, -1);
  return null;
}

export function nextViewFromMonitorKey(
  current: "sessions" | "providers",
  key: MonitorKeyLike,
): "sessions" | "providers" | null {
  const normalized = {
    ...key,
    raw: key.raw || "",
    sequence: key.sequence || "",
    ctrl: Boolean(key.ctrl),
    meta: Boolean(key.meta),
    option: Boolean(key.option),
  } as KeyEvent;
  const char = printableChar(normalized);
  if (char === "v" || char === "P") return current === "providers" ? "sessions" : "providers";
  return null;
}

function nextAgeChangeAt(timestamp: number, now: number): number {
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 10) return Math.max(now + 1, timestamp + 10_000);
  if (seconds < 60) return timestamp + (seconds + 1) * 1000;
  if (seconds < 3600) return timestamp + (Math.floor(seconds / 60) + 1) * 60_000;
  return timestamp + (Math.floor(seconds / 3600) + 1) * 3_600_000;
}

function nextWorkflowAgeChangeAt(timestamp: number, now: number): number {
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 60) return Math.max(now + 1, timestamp + (seconds + 1) * 1000);
  if (seconds < 3600) return timestamp + (Math.floor(seconds / 60) + 1) * 60_000;
  return timestamp + (Math.floor(seconds / 3600) + 1) * 3_600_000;
}

function nextResetChangeAt(resetAt: number, now: number): number | undefined {
  const millis = resetAt < 1_000_000_000_000 ? resetAt * 1000 : resetAt;
  const seconds = Math.max(0, Math.floor((millis - now) / 1000));
  if (seconds <= 0) return undefined;
  if (seconds < 60) return millis - seconds * 1000 + 1;
  if (seconds < 3600) return millis - Math.floor(seconds / 60) * 60_000 + 1;
  return millis - Math.floor(seconds / 3600) * 3_600_000 + 1;
}

function earlierDeadline(current: number | undefined, candidate: number | undefined, now: number): number | undefined {
  if (candidate === undefined || !Number.isFinite(candidate) || candidate <= now) return current;
  return current === undefined ? candidate : Math.min(current, candidate);
}

function visibleSessionAgeDeadline(
  state: Readonly<MonitorState>,
  renderer: CliRenderer,
  now: number,
): number | undefined {
  const shown = applyFilter(state.sessions, state.filterText);
  const groups = groupByProject(shown);
  const projectData = projectRows(groups, state, 0);
  const projectIndex = state.projectCursorKey ? projectData.findIndex(row => row.key === state.projectCursorKey) : 0;
  const projectSlots = Math.max(2, Math.min(6, renderer.height - 13));
  const visibleProjects = new Set(visibleWindow(projectData, projectIndex, projectSlots).map(row => row.key));
  let deadline: number | undefined;
  for (const [key, sessions] of groups.entries()) {
    if (visibleProjects.has(key)) deadline = earlierDeadline(deadline, nextAgeChangeAt(latestTimestamp(sessions), now), now);
  }

  const scope = state.projectFocusKey ? selectedProjectSessions(state) : shown;
  const selectedIndex = state.projectFocusKey ? Math.max(0, state.selectedIdx) : 0;
  const sessionSlots = Math.max(4, renderer.height - 17);
  for (const session of visibleWindow(scope, selectedIndex, sessionSlots)) {
    if (session.timestamp) deadline = earlierDeadline(deadline, nextAgeChangeAt(session.timestamp, now), now);
  }

  const selected = selectedSession(state);
  if (selected?.timestamp) deadline = earlierDeadline(deadline, nextAgeChangeAt(selected.timestamp, now), now);
  return deadline;
}

function activeDetailDeadline(state: Readonly<MonitorState>, now: number): number | undefined {
  const session = selectedSession(state);
  if (!session) return undefined;
  let deadline: number | undefined;
  if (state.detailTab === "flow" && !(session.flow?.edges?.length)) {
    const workflow = session.workflow_events ?? [];
    const firstVisible = Math.max(0, workflow.length - 10);
    for (let index = firstVisible; index < workflow.length; index++) {
      const timestamp = workflow[index]?.timestamp;
      if (timestamp) deadline = earlierDeadline(deadline, nextWorkflowAgeChangeAt(timestamp, now), now);
    }
  } else if (state.detailTab === "usage") {
    const signals = session.agent_signals ?? [];
    let visible = 0;
    for (let index = signals.length - 1; index >= 0 && visible < 4; index--) {
      const signal = signals[index]!;
      const paintsRow = signal.balance !== undefined
        || signal.remaining !== undefined
        || signal.used_percent !== undefined
        || signal.used !== undefined
        || signal.limit !== undefined
        || signal.status !== undefined;
      if (!paintsRow) continue;
      visible++;
      if (signal.reset_at !== undefined) {
        deadline = earlierDeadline(deadline, nextResetChangeAt(signal.reset_at, now), now);
      }
    }
  }
  return deadline;
}

export function nextVisibleFreshnessDelay(
  state: Readonly<MonitorState>,
  renderer: CliRenderer,
  now = Date.now(),
  _opts?: RuntimeDisplayOptions,
): number | undefined {
  if (state.view === "providers") return undefined;
  let deadline = visibleSessionAgeDeadline(state, renderer, now);
  deadline = earlierDeadline(deadline, activeDetailDeadline(state, now), now);
  if (!state.projectFocusKey && state.system) {
    const timestamp = state.system.sampled_at;
    const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
    deadline = earlierDeadline(deadline, timestamp + (seconds + 1) * 1000, now);
  }
  return deadline === undefined ? undefined : Math.max(1, deadline - now);
}

export function createSingleFlightRefresh<T>(
  fetchValue: () => Promise<T>,
  applyValue: (value: T) => void,
): (reason: "poll" | "manual") => Promise<boolean> {
  let active = false;
  let generation = 0;
  let queuedManual: Array<(applied: boolean) => void> = [];

  const start = async (token: number): Promise<boolean> => {
    let applied = false;
    try {
      const value = await fetchValue();
      if (token === generation) {
        applyValue(value);
        applied = true;
      }
      return applied;
    } finally {
      active = false;
      if (queuedManual.length > 0) {
        const waiters = queuedManual;
        queuedManual = [];
        active = true;
        void start(generation).then(
          result => waiters.forEach(resolve => resolve(result)),
          () => waiters.forEach(resolve => resolve(false)),
        );
      }
    }
  };

  return reason => {
    if (!active) {
      active = true;
      return start(++generation);
    }
    if (reason === "poll") return Promise.resolve(false);
    generation++;
    return new Promise(resolve => queuedManual.push(resolve));
  };
}

function applySessionFetch(
  state: Readonly<MonitorState>,
  result: SessionFetchResult,
): MonitorState {
  const sessions = result.sessions.length > 0 || !result.error
    ? preserveSessionDetailSnapshots(state.sessions, result.sessions)
    : state.sessions;
  const unread = updateUnreadSessionState({
    previousFingerprints: state.sessionFingerprints,
    previousUnread: state.unreadSessionIds,
    initialized: state.unreadInitialized,
    sessions,
    selectedSessionId: state.selectedId,
  });
  return clampState({
    ...state,
    sessions,
    errorMsg: result.error,
    sessionFingerprints: unread.fingerprints,
    unreadSessionIds: unread.unreadSessionIds,
    unreadInitialized: unread.initialized,
  });
}

export function preserveSessionDetailSnapshots(
  previous: readonly Session[],
  next: readonly Session[],
): Session[] {
  const previousById = new Map(previous.map(session => [session.session_id, session]));
  return next.map(session => {
    const prior = previousById.get(session.session_id);
    return prior ? { ...prior, ...session } : session;
  });
}

export function createIndependentMonitorRefresh(
  fetchSessions: FetchSessions,
  fetchSystem: () => Promise<SystemEfficiencySnapshot | undefined>,
  applySessions: (result: SessionFetchResult) => void,
  applySystem: (result: SystemEfficiencySnapshot | undefined) => void,
): (reason: "poll" | "manual") => void {
  const refreshSessions = createSingleFlightRefresh(
    async () => {
      try {
        return await fetchSessions();
      } catch (error) {
        return { sessions: [], error: errorMessage(error) };
      }
    },
    result => {
      if (!result.unchanged) applySessions(result);
    },
  );
  const refreshSystem = createSingleFlightRefresh(
    async () => {
      try {
        return await fetchSystem();
      } catch {
        return undefined;
      }
    },
    applySystem,
  );

  return reason => {
    void refreshSessions(reason);
    void refreshSystem(reason);
  };
}

export function preserveSystemSnapshot(
  previous: SystemEfficiencySnapshot | undefined,
  next: SystemEfficiencySnapshot | undefined,
): SystemEfficiencySnapshot | undefined {
  return next ?? previous;
}

interface ProviderFetchResult {
  providers?: PlanRow[];
  error?: string;
}

async function fetchProviderState(opts: OpenTuiMonitorOptions): Promise<ProviderFetchResult> {
  if (!opts.fetchProviders) return {};
  try {
    const providers = await opts.fetchProviders();
    return { providers };
  } catch (error) {
    return { error: errorMessage(error) };
  }
}

function applyProviderFetch(state: Readonly<MonitorState>, fetched: ProviderFetchResult): MonitorState {
  return clampState({
    ...state,
    providers: fetched.providers ?? state.providers,
    providersError: fetched.error,
  });
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

export async function runOpenTuiMonitor(opts: OpenTuiMonitorOptions): Promise<void> {
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    clearOnShutdown: true,
    screenMode: "alternate-screen",
    backgroundColor: PALETTE.bg,
    targetFps: Math.max(1, Math.min(60, Math.round(1000 / opts.renderMs))),
    maxFps: 60,
    useMouse: false,
    consoleMode: "disabled",
  });

  return new Promise<void>((resolve) => {
    let state: MonitorState = clampState({
      sessions: [],
      system: undefined,
      filterText: "",
      filterActive: false,
      projectCursorKey: null,
      projectFocusKey: null,
      selectedIdx: -1,
      selectedId: null,
      detailId: null,
      detailTab: "overview",
      sessionFingerprints: new Map(),
      unreadSessionIds: new Set(),
      unreadInitialized: false,
      sseMode: false,
      view: "sessions",
      providers: [],
      providersError: undefined,
    });
    let disposed = false;
    let freshnessTimer: ReturnType<typeof setTimeout> | undefined;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let terminalFocused = true;
    const refs = createRefs(renderer, opts);

    const requestVisibleUpdate = createVisibleModelUpdater((model: MonitorVisibleModel) => {
      updateRefs(refs, model);
      renderer.requestRender();
    });
    const render = () => {
      if (!disposed) requestVisibleUpdate(monitorVisibleModel(state, renderer, Date.now(), opts));
    };
    const update = (updater: (state: Readonly<MonitorState>) => MonitorState) => {
      if (disposed) return;
      state = clampState(updater(state));
      render();
      scheduleFreshnessUpdate();
    };
    const resizeHandler = () => update(current => ({ ...current }));
    const scheduleFreshnessUpdate = () => {
      if (freshnessTimer) clearTimeout(freshnessTimer);
      const delayMs = nextVisibleFreshnessDelay(state, renderer, Date.now(), opts);
      if (delayMs === undefined) {
        freshnessTimer = undefined;
        return;
      }
      freshnessTimer = setTimeout(() => {
        render();
        if (!disposed) scheduleFreshnessUpdate();
      }, delayMs);
    };
    const refreshMonitor = createIndependentMonitorRefresh(
      opts.fetchSessions,
      opts.fetchSystem,
      fetched => update(current => applySessionFetch(current, fetched)),
      fetched => update(current => ({
        ...current,
        system: preserveSystemSnapshot(current.system, fetched),
      })),
    );
    const refreshProviders = createSingleFlightRefresh(
      () => fetchProviderState(opts),
      fetched => update(current => applyProviderFetch(current, fetched)),
    );
    const close = () => {
      if (disposed) return;
      disposed = true;
      if (pollTimer) clearTimeout(pollTimer);
      if (freshnessTimer) clearTimeout(freshnessTimer);
      opts.closeTransport?.();
      renderer.keyInput.off("keypress", keyHandler);
      renderer.off("resize", resizeHandler);
      renderer.off("focus", focusHandler);
      renderer.off("blur", blurHandler);
      refs.root.destroyRecursively();
      renderer.destroy();
      resolve();
    };
    const keyHandler = (key: KeyEvent) => {
      if ((key.ctrl && key.name === "c") || key.name === "q") {
        close();
        return;
      }

      if (state.filterActive) {
        if (key.name === "escape") {
          update(current => clampState({ ...current, filterActive: false, filterText: "" }));
          return;
        }
        if (isEnter(key)) {
          update(current => clampState({ ...current, filterActive: false }));
          return;
        }
        if (isBackspace(key)) {
          update(current => clampState({ ...current, filterText: current.filterText.slice(0, -1) }));
          return;
        }
        const char = printableChar(key);
        if (char) update(current => clampState({ ...current, filterText: current.filterText + char }));
        return;
      }

      const nextTab = nextDetailTabFromMonitorKey(state.detailTab, key);
      if (state.projectFocusKey && nextTab) {
        update(current => clampState({ ...current, detailTab: nextTab }));
        return;
      }

      const nextView = nextViewFromMonitorKey(state.view, key);
      if (nextView) {
        update(current => clampState({ ...current, view: nextView }));
        return;
      }

      if (key.name === "up" || key.name === "k") update(current => moveSession(current, -1));
      else if (key.name === "down" || key.name === "j") update(current => moveSession(current, 1));
      else if (isEnter(key)) update(toggleDetail);
      else if (key.name === "a" || isBackspace(key)) update(clearProjectFocus);
      else if (key.name === "g") {
        update(current => {
          const keys = projectKeys(current);
          if (current.projectFocusKey) {
            const sessions = selectedProjectSessions(current);
            return clampState({ ...current, selectedIdx: 0, selectedId: sessions[0]?.session_id || null });
          }
          return clampState({ ...current, projectCursorKey: keys[0] || null });
        });
      } else if (key.name === "r") {
        void refreshMonitor("manual");
        void refreshProviders("manual");
      } else if (key.name === "/" || key.sequence === "/") {
        update(current => clearProjectFocus({ ...current, filterActive: true, filterText: "" }));
      } else if (key.name === "w") {
        void opts.openWebDashboard();
      } else if (key.name === "s") {
        update(current => {
          if (!opts.toggleSSE) return current;
          const next = opts.toggleSSE();
          return clampState({ ...current, sseMode: next });
        });
      }
    };

    const schedulePoll = () => {
      if (disposed) return;
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = setTimeout(() => {
        pollTimer = undefined;
        void runPoll();
      }, monitorPollDelay(terminalFocused, opts.pollMs, opts.backgroundPollMs));
    };
    const runPoll = async () => {
      void refreshMonitor("poll");
      if (state.view === "providers") void refreshProviders("poll");
      schedulePoll();
    };
    const focusHandler = () => {
      terminalFocused = true;
      void runPoll();
    };
    const blurHandler = () => {
      terminalFocused = false;
      schedulePoll();
    };

    renderer.keyInput.on("keypress", keyHandler);
    renderer.on("resize", resizeHandler);
    renderer.on("focus", focusHandler);
    renderer.on("blur", blurHandler);
    renderer.start();
    render();
    scheduleFreshnessUpdate();
    void refreshMonitor("poll");
    void refreshProviders("poll");
    schedulePoll();
  });
}
