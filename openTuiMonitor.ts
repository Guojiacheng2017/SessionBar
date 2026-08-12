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
import type { PlanRow } from "./planTypes.js";
import type { SessionPayload, SystemEfficiencySnapshot } from "./types.js";
import {
  buildSessionDetailChunks,
  buildSessionSidebarLine,
  detailTabByNumber,
  nextDetailTab,
  updateUnreadSessionState,
  type DetailTab,
} from "./sessionInspector.js";
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
} from "./projectUtils.js";
import { aggregateRuntimeUsage, formatRuntimeBytes, runtimeProgressBar } from "./runtimeUsage.js";

type Session = SessionPayload;
type FetchSessions = () => Promise<{ sessions: Session[]; error?: string }>;

export interface OpenTuiMonitorOptions {
  fetchSessions: FetchSessions;
  fetchSystem: () => Promise<SystemEfficiencySnapshot | undefined>;
  fetchProviders?: () => Promise<PlanRow[]>;
  openWebDashboard: () => Promise<void>;
  renderMs: number;
  pollMs: number;
  port: number;
  apiHost: string;
  stateDir: string;
  animate: boolean;
  toggleSSE?: () => boolean;
  isSSE?: () => boolean;
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

type VisibleModel = Record<string, unknown>;

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
  const bodyWidth = Math.max(40, Math.floor(rendererWidth) - 2);
  const gap = bodyWidth >= 48 ? 1 : 0;
  const minDetail = bodyWidth >= 90 ? 44 : 32;
  const minSidebar = bodyWidth >= 90 ? 34 : 24;
  const maxSidebar = bodyWidth >= 140 ? 46 : 42;
  const sidebarMax = Math.max(minSidebar, Math.min(maxSidebar, bodyWidth - gap - minDetail));
  const sidebarPanelWidth = clampNumber(Math.round(bodyWidth * 0.31), minSidebar, sidebarMax);
  const detailPanelWidth = Math.max(minDetail, bodyWidth - sidebarPanelWidth - gap);

  return {
    bodyWidth,
    gap,
    sidebarPanelWidth,
    detailPanelWidth,
    sidebarLineWidth: Math.max(16, sidebarPanelWidth - 4),
    detailContentWidth: Math.max(32, detailPanelWidth - 4),
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

function projectRows(groups: Map<string, Session[]>, state: Readonly<MonitorState>): ProjectRow[] {
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
      age: age(latestTimestamp(sessions)),
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

function sessionTableContent(rows: readonly SessionRow[], state: Readonly<MonitorState>, renderer: CliRenderer): TextTableContent {
  const content: TextTableContent = [];
  if (rows.length === 0) return [[cell(state.filterText ? "No sessions match the current filter" : "No sessions reporting yet", PALETTE.muted)]];

  const selectedIndex = state.projectFocusKey ? Math.max(0, state.selectedIdx) : 0;
  const slots = Math.max(4, renderer.height - 17);
  const visible = visibleWindow(rows, selectedIndex, slots);
  const lineWidth = monitorBodyLayout(renderer.width).sidebarLineWidth;
  const now = Date.now();
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


function renderProvidersView(refs: MonitorRefs, renderer: CliRenderer, state: Readonly<MonitorState>, opts: OpenTuiMonitorOptions): void {
  const layout = monitorBodyLayout(renderer.width);
  const providers = state.providers || [];
  const apiCount = providers.filter(r => r.form === "api").length;
  const subCount = providers.length - apiCount;
  const error = state.providersError;

  refs.title.content = "SessionBar [Providers]";
  refs.online.content = `online :${opts.port}`;
  refs.projectsBox.visible = false;
  refs.activity.content = error
    ? "provider fetch failed"
    : [
        `${providers.length} provider${providers.length !== 1 ? "s" : ""}`,
        subCount > 0 ? `${subCount} subscription` : "",
        apiCount > 0 ? `${apiCount} api` : "",
      ].filter(Boolean).join("  ");
  refs.sessionsBox.title = `Providers (${providers.length})`;
  refs.sessionsBox.width = layout.bodyWidth;
  refs.detailsBox.visible = false;
  refs.sessionsTable.visible = false;
  refs.providersTable.visible = true;
  refs.providersTable.content = providerTableContent(providers, renderer, error);
  refs.footer.content = state.errorMsg ? `! ${state.errorMsg}` : "v / P  switch to sessions  r refresh  / filter  w web  q quit";
  refs.footer.fg = state.errorMsg ? PALETTE.red : PALETTE.muted;
}

function healthScore(sessions: readonly Session[]): { score: number; label: string; color: string } {
  if (sessions.length === 0) return { score: 0, label: "waiting for sessions", color: PALETTE.muted };
  const counts = statusCounts(sessions);
  const stale = sessions.filter(s => Date.now() - (s.timestamp || 0) > 120_000).length;
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

function detailTextForProject(scope: readonly Session[], all: readonly Session[], opts: OpenTuiMonitorOptions): string {
  if (scope.length === 0) {
    return [
      "PROJECT none selected",
      `All sessions ${all.length}`,
      "",
      `API ${opts.apiHost}:${opts.port}`,
      `State ${compactPath(opts.stateDir)}`,
    ].join("\n");
  }

  const sample = scope[0]!;
  const health = healthScore(scope);
  return [
    `PROJECT ${projectName(sample)}`,
    `path ${projectPathSummary(scope)}`,
    `sessions ${scope.length}`,
    `agents ${agentsText(scope)}`,
    `status ${inlineStatus(scope)}`,
    `health ${health.score} | ${health.label}`,
    `latest ${age(latestTimestamp(scope))}`,
    "",
    ...projectActivityLines(scope),
    ...projectTailLines(scope),
    "",
    `API ${opts.apiHost}:${opts.port}`,
    `State ${compactPath(opts.stateDir)}`,
  ].join("\n");
}

export function runtimeOverviewText(sessions: readonly Session[], width = 44): string {
  const usage = aggregateRuntimeUsage(sessions);
  const barWidth = Math.max(10, Math.min(20, Math.floor(width / 3)));
  const lines = [
    "RUNTIME / ALL ACTIVE SESSIONS",
    `active ${usage.activeSessions} | sampled ${usage.sampledSessions}`,
    "",
    `CPU  ${runtimeValue(usage.cpuPercent, "%")} ${runtimeProgressBar(usage.cpuPercent, 100, barWidth)}`,
    `GPU  ${usage.hasGpuData ? runtimeValue(usage.gpuPercent, "%") : "—"} ${runtimeProgressBar(usage.gpuPercent, 100, barWidth)}`,
    `MEM  ${formatRuntimeBytes(usage.memoryBytes)} ${runtimeProgressBar(usage.memoryPercent, 100, barWidth)}`,
    `PROC ${runtimeValue(usage.processCount, "")} ${runtimeProgressBar(usage.processCount, Math.max(16, usage.processCount || 16), barWidth)}`,
  ];
  if (usage.activeSessions === 0) lines.push("", "no active session resources");
  else if (usage.sampledSessions === 0) lines.push("", "waiting for runtime samples");
  else if (usage.sampledSessions < usage.activeSessions) lines.push("", `waiting for ${usage.activeSessions - usage.sampledSessions} sample${usage.activeSessions - usage.sampledSessions === 1 ? "" : "s"}`);
  return lines.join("\n");
}

export function systemOverviewText(
  snapshot: SystemEfficiencySnapshot | undefined,
  width = 44,
  now = Date.now(),
): string {
  const barWidth = Math.max(8, Math.min(16, Math.floor(width / 4)));
  const cpu = snapshot?.cpu_percent;
  const memory = snapshot?.memory_percent;
  const load = snapshot?.load_average;
  const sampleAge = snapshot ? Math.max(0, Math.floor((now - snapshot.sampled_at) / 1000)) : undefined;
  return [
    `CPU        ${percentValue(cpu)} ${runtimeProgressBar(cpu, 100, barWidth)}`,
    `Load       ${load ? load.map(value => value.toFixed(2)).join("  ") : "—  —  —"}`,
    `Memory     ${formatRuntimeBytes(snapshot?.memory_used_bytes)} / ${formatRuntimeBytes(snapshot?.memory_total_bytes)} ${percentValue(memory)} ${runtimeProgressBar(memory, 100, barWidth)}`,
    `Network    down ${formatByteRate(snapshot?.network_down_bytes_per_second)}  up ${formatByteRate(snapshot?.network_up_bytes_per_second)}`,
    `SessionBar CPU ${percentValue(snapshot?.server_cpu_percent)}  MEM ${formatRuntimeBytes(snapshot?.server_memory_bytes)}`,
    `Sample     ${sampleAge === undefined ? "waiting" : `${sampleAge}s ago`}`,
  ].join("\n");
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

function runtimeValue(value: number | undefined, suffix: string): string {
  return value === undefined ? "—" : `${Math.round(value)}${suffix}`;
}

function detailTextForSession(session: Session, tab: DetailTab, width: number): StyledText {
  return buildSessionDetailChunks(session, tab, width);
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
    content: `online :${opts.port}`,
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

function updateRefs(refs: MonitorRefs, renderer: CliRenderer, state: Readonly<MonitorState>, opts: OpenTuiMonitorOptions): void {
  if (state.view === "providers") {
    renderProvidersView(refs, renderer, state, opts);
    return;
  }
  refs.sessionsTable.visible = true;
  refs.providersTable.visible = false;
  refs.detailsBox.visible = true;
  refs.projectsBox.visible = true;
  const shown = applyFilter(state.sessions, state.filterText);
  const groups = groupByProject(shown);
  const counts = statusCounts(state.sessions);
  const projectData = projectRows(groups, state);
  const scopeSessions = selectedProjectSessions(state);
  const sessionData = sessionRows(state.projectFocusKey ? scopeSessions : shown, state);
  const selected = selectedSession(state);
  const layout = monitorBodyLayout(renderer.width);
  const detailWidth = layout.detailContentWidth;
  const details = selected
    ? detailTextForSession(selected, state.detailTab, detailWidth)
    : state.projectFocusKey
      ? detailTextForProject(scopeSessions, shown, opts)
      : systemOverviewText(state.system, detailWidth);
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

  refs.title.content = "SessionBar [Sessions]";
  refs.online.content = `online :${opts.port}`;
  refs.activity.content = activity;
  refs.projectsBox.title = `Projects (${groups.size})`;
  refs.projectsTable.content = projectTableContent(projectData, state, renderer);
  refs.sessionsBox.width = layout.sidebarPanelWidth;
  refs.detailsBox.width = layout.detailPanelWidth;
  refs.sessionsBox.title = sessionTitle;
  refs.sessionsTable.content = sessionTableContent(sessionData, state, renderer);
  refs.detailsBox.title = selected
    ? `Details / Session / ${detailTabTitle(state.detailTab)}`
    : state.projectFocusKey ? "Details / Project" : "Details / System";
  refs.detailsText.content = details;
  refs.footer.content = footer;
  refs.footer.fg = state.errorMsg ? PALETTE.red : PALETTE.muted;
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

function monitorVisibleModel(state: Readonly<MonitorState>, renderer: CliRenderer, now = Date.now()): VisibleModel {
  const common = {
    view: state.view,
    width: renderer.width,
    height: renderer.height,
    errorMsg: state.errorMsg,
  };
  if (state.view === "providers") {
    return {
      ...common,
      providers: state.providers,
      providersError: state.providersError,
    };
  }
  const shown = applyFilter(state.sessions, state.filterText);
  return {
    ...common,
    sessions: state.sessions,
    system: state.projectFocusKey ? undefined : state.system,
    filterText: state.filterText,
    filterActive: state.filterActive,
    projectCursorKey: state.projectCursorKey,
    projectFocusKey: state.projectFocusKey,
    selectedIdx: state.selectedIdx,
    selectedId: state.selectedId,
    detailId: state.detailId,
    detailTab: state.detailTab,
    unreadSessionIds: state.unreadSessionIds,
    freshnessSecond: shown.length > 0 || (!state.projectFocusKey && state.system)
      ? Math.floor(now / 1000)
      : undefined,
  };
}

async function fetchIntoState(
  opts: OpenTuiMonitorOptions,
  update: (updater: (state: Readonly<MonitorState>) => MonitorState) => void,
): Promise<void> {
  const [sessionResult, systemResult] = await Promise.allSettled([
    opts.fetchSessions(),
    opts.fetchSystem(),
  ]);
  const result = sessionResult.status === "fulfilled"
    ? sessionResult.value
    : { sessions: [], error: errorMessage(sessionResult.reason) };
  update(state => {
    const sessions = result.sessions.length > 0 || !result.error ? result.sessions : state.sessions;
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
      system: systemResult.status === "fulfilled" ? systemResult.value : state.system,
      errorMsg: result.error,
      sessionFingerprints: unread.fingerprints,
      unreadSessionIds: unread.unreadSessionIds,
      unreadInitialized: unread.initialized,
    });
  });
}

async function fetchProvidersIntoState(
  opts: OpenTuiMonitorOptions,
  update: (updater: (state: Readonly<MonitorState>) => MonitorState) => void,
): Promise<void> {
  if (!opts.fetchProviders) return;
  try {
    const providers = await opts.fetchProviders();
    update(state => clampState({ ...state, providers, providersError: undefined }));
  } catch (error) {
    update(state => clampState({ ...state, providersError: errorMessage(error) }));
  }
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
    const refs = createRefs(renderer, opts);

    const requestVisibleUpdate = createVisibleModelUpdater(() => {
      updateRefs(refs, renderer, state, opts);
      renderer.requestRender();
    });
    const render = () => {
      if (!disposed) requestVisibleUpdate(monitorVisibleModel(state, renderer));
    };
    const update = (updater: (state: Readonly<MonitorState>) => MonitorState) => {
      state = clampState(updater(state));
      render();
    };
    const resizeHandler = () => update(current => ({ ...current }));
    const scheduleFreshnessUpdate = () => {
      const delayMs = Math.max(1, 1000 - (Date.now() % 1000));
      freshnessTimer = setTimeout(() => {
        render();
        if (!disposed) scheduleFreshnessUpdate();
      }, delayMs);
    };
    const close = () => {
      if (disposed) return;
      disposed = true;
      clearInterval(poll);
      if (freshnessTimer) clearTimeout(freshnessTimer);
      renderer.keyInput.off("keypress", keyHandler);
      renderer.off("resize", resizeHandler);
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
        void fetchIntoState(opts, update);
        void fetchProvidersIntoState(opts, update);
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

    const poll = setInterval(() => {
      void fetchIntoState(opts, update);
      if (state.view === "providers") void fetchProvidersIntoState(opts, update);
    }, opts.pollMs);

    renderer.keyInput.on("keypress", keyHandler);
    renderer.on("resize", resizeHandler);
    renderer.start();
    render();
    scheduleFreshnessUpdate();
    void fetchIntoState(opts, update);
    void fetchProvidersIntoState(opts, update);
  });
}
