import {
  BoxRenderable,
  ScrollBoxRenderable,
  TextAttributes,
  TextRenderable,
  TextTableRenderable,
  RGBA,
  StyledText,
  createCliRenderer,
  parseColor,
  type CliRenderer,
  type KeyEvent,
  type MouseEvent,
  type TextChunk,
  type TextTableContent,
} from "@opentui/core";
import type { PlanRow, ProviderUsageMode } from "../providers/planTypes.js";
import { providerDisplayLabel, providerUsageDisplayTrend } from "../providers/providerUsageMetrics.js";
import { providerCardText, providerLeftText, providerLevelLabel, providerPresentationTone, providerResetText } from "../providers/providerPresentation.js";
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
import { TERMINAL_COLORS } from "./terminalTheme.js";
import { AgentClient, type AgentSelection } from "../web/agentClient.js";
import type { Snapshot } from "../shared/agentContract.js";
import { AGENT_DETAIL_TABS, agentDetailText, agentList, type AgentDetailTab } from "./agentInspector.js";
import { PROVIDER_USAGE_MODES, buildProviderDetailChunks, providerQuotaColor, providerTableColumns, providerUsageMeterChunks, providerUsageSparkline, providerWorkspaceLayout } from "./providerInspector.js";
import { terminalText } from "./terminalText.js";

export type MonitorView = "sessions" | "providers" | "agents";
type MonitorList = "projects" | "sessions" | "providers" | "agents";
export type MonitorAction =
  | { type: "view"; view: MonitorView }
  | { type: "back" }
  | { type: "project"; key: string }
  | { type: "session"; id: string }
  | { type: "provider"; key: string }
  | { type: "mode"; mode: ProviderUsageMode }
  | { type: "agent"; id: string }
  | { type: "step"; list: MonitorList; delta: number; pageSize?: number };

interface InteractiveTable {
  content: TextTableContent;
  actions: Array<MonitorAction | null>;
}

interface MonitorButton {
  box: BoxRenderable;
  label: TextRenderable;
  active: boolean;
  hovered: boolean;
}

interface MonitorTableHover {
  content: TextTableContent;
  column: number;
  row?: number;
  actionKey?: string;
}

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
  initialView?: MonitorView;
  agentRequest?: typeof fetch;
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
  sessionScrollOffset?: number;
  selectedId: string | null;
  detailId: string | null;
  detailTab: DetailTab;
  sessionFingerprints: Map<string, string>;
  unreadSessionIds: Set<string>;
  unreadInitialized: boolean;
  sseMode: boolean;
  view: MonitorView;
  providers: PlanRow[];
  providersError?: string;
  providerIndex?: number;
  providerUsageMode?: ProviderUsageMode;
  agentSnapshot?: Snapshot | null;
  agentSelection?: AgentSelection | null;
  agentCursorId?: string | null;
  agentTab?: AgentDetailTab;
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
  body: BoxRenderable;
  title: TextRenderable;
  online: TextRenderable;
  activity: TextRenderable;
  viewButtons: Map<MonitorView, MonitorButton>;
  viewNavigation: BoxRenderable;
  backButton: MonitorButton;
  providerModes: BoxRenderable;
  providerModeButtons: Map<ProviderUsageMode, MonitorButton>;
  model?: MonitorVisibleModel;
  projectsBox: BoxRenderable;
  projectsTable: TextTableRenderable;
  sessionsBox: BoxRenderable;
  sessionsTable: TextTableRenderable;
  providersTable: TextTableRenderable;
  tableHovers: Map<TextTableRenderable, MonitorTableHover>;
  detailsBox: BoxRenderable;
  detailsScroll: ScrollBoxRenderable;
  detailsText: TextRenderable;
  detailsScrollKey?: string;
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

export interface MonitorWorkspaceLayout {
  direction: "row" | "column";
  projectWidth: number | "100%";
  projectHeight: number | "100%";
  sessionsWidth: number | "100%";
  sessionsHeight: number | "100%" | "auto";
  detailsWidth: number | "100%";
  detailsHeight: number | "100%" | "auto";
}

export interface MonitorVisibleModel {
  view: MonitorView;
  width: number;
  height: number;
  title: string;
  online: string;
  activity: string;
  projectsVisible: boolean;
  projectsTitle: string;
  projectsContent: TextTableContent;
  projectActions?: Array<MonitorAction | null>;
  sessionsWidth: number;
  sessionsTitle: string;
  sessionsVisible: boolean;
  sessionsContent: TextTableContent;
  sessionActions?: Array<MonitorAction | null>;
  providersVisible: boolean;
  providersContent: TextTableContent;
  providerActions?: Array<MonitorAction | null>;
  providersHeight?: number;
  providerUsageMode?: ProviderUsageMode;
  detailsVisible: boolean;
  detailsWidth: number;
  detailsTitle: string;
  detailsContent: string | StyledText;
  detailsScrollKey: string;
  footer: string;
  footerError: boolean;
  focusRegion: "projects" | "sessions" | "details" | "providers" | "agents";
}

const PALETTE = {
  bg: "transparent",
  panel: "transparent",
  fg: RGBA.defaultForeground(),
  muted: TERMINAL_COLORS.muted,
  dim: TERMINAL_COLORS.dim,
  border: TERMINAL_COLORS.border,
  accent: TERMINAL_COLORS.accent,
  green: TERMINAL_COLORS.working,
  yellow: TERMINAL_COLORS.blocked,
  red: TERMINAL_COLORS.error,
  cyan: TERMINAL_COLORS.cyan,
  selectionFg: "#111319",
} as const;

const COLOR_CACHE = new Map<string, ReturnType<typeof parseColor>>();
const BRAND_COLORS = TERMINAL_COLORS.brand;

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

function brandHeaderContent(title: string): StyledText {
  const suffix = title.replace(/^SessionBar\s*/i, "");
  const chunks = [..."SessionBar"].map((letter, index) => chunk(
    letter,
    BRAND_COLORS[index % BRAND_COLORS.length],
    TextAttributes.BOLD,
  ));
  if (suffix) chunks.push(chunk(`  ${suffix}`, PALETTE.muted, TextAttributes.BOLD));
  return new StyledText(chunks);
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
  if (status === "working") return PALETTE.green;
  if (status === "blocked") return PALETTE.yellow;
  if (status === "error") return PALETTE.red;
  return PALETTE.muted;
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

function providerSelectionKey(row: PlanRow): string {
  return JSON.stringify([row.provider, row.form, row.label, row.unit]);
}

export function applyMonitorAction(state: Readonly<MonitorState>, action: MonitorAction): MonitorState {
  if (action.type === "view") return clampState({ ...state, view: action.view, filterText: "", filterActive: false });
  if (action.type === "back") return state.view === "sessions" ? clearProjectFocus(state) : { ...state };
  if (action.type === "mode") return state.view === "providers" ? { ...state, providerUsageMode: action.mode, filterActive: false } : { ...state };
  if (action.type === "provider" && state.view === "providers") {
    const index = providerRowsForState(state).findIndex(row => providerSelectionKey(row) === action.key);
    return index < 0 ? { ...state } : { ...state, providerIndex: index, filterActive: false };
  }
  if (action.type === "project" && state.view === "sessions") {
    const groups = groupByProject(applyFilter(state.sessions, state.filterText));
    return groups.has(action.key) ? focusProject({ ...state, projectCursorKey: action.key, filterActive: false }) : { ...state };
  }
  if (action.type === "session" && state.view === "sessions") {
    const groups = groupByProject(applyFilter(state.sessions, state.filterText));
    for (const [key, sessions] of groups) {
      const index = sessions.findIndex(session => session.session_id === action.id);
      if (index >= 0) return clampState({ ...state, projectCursorKey: key, projectFocusKey: key,
        selectedIdx: index, selectedId: action.id, detailId: action.id, filterActive: false });
    }
  }
  if (action.type === "agent" && state.view === "agents" && agentsForState(state).some(agent => agent.agent_id === action.id)) {
    return { ...state, agentCursorId: action.id, filterActive: false };
  }
  if (action.type === "step") {
    if (action.list === "projects" && state.view === "sessions") return moveProject(state, action.delta);
    if (action.list === "sessions" && state.view === "sessions") {
      if (state.projectFocusKey) return moveSession(state, action.delta);
      const count = applyFilter(state.sessions, state.filterText).length;
      const maximum = Math.max(0, count - Math.max(1, action.pageSize ?? 1));
      const current = Math.max(0, Math.min(maximum, state.sessionScrollOffset ?? 0));
      return { ...state, sessionScrollOffset: Math.max(0, Math.min(maximum, current + action.delta)) };
    }
    if (action.list === "providers" && state.view === "providers") {
      const count = providerRowsForState(state).length;
      const current = Math.max(0, Math.min(Math.max(0, count - 1), state.providerIndex ?? 0));
      return { ...state, providerIndex: Math.max(0, Math.min(Math.max(0, count - 1), current + action.delta)) };
    }
    if (action.list === "agents" && state.view === "agents") {
      const rows = agentsForState(state);
      const current = Math.max(0, rows.findIndex(agent => agent.agent_id === state.agentCursorId));
      const selected = rows[Math.max(0, Math.min(rows.length - 1, current + action.delta))];
      if (selected) return { ...state, agentCursorId: selected.agent_id };
    }
  }
  return { ...state };
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
    detailContentWidth: detailTextWidth(detailPanelWidth),
  };
}

function compactHeight(rendererHeight: number): boolean {
  return Number.isFinite(rendererHeight) && rendererHeight <= 30;
}

function detailTextWidth(panelWidth: number): number {
  // Keep a scrollbar column reserved so appearing scrollbars cannot change wrapping.
  return Math.max(1, panelWidth - 5);
}

export function monitorWorkspaceLayout(rendererWidth: number, rendererHeight = 40, drilldown = false): MonitorWorkspaceLayout {
  const workspaceWidth = Math.max(20, Math.floor(rendererWidth) - 2);
  if (rendererWidth < 120) {
    if (compactHeight(rendererHeight) && drilldown && rendererWidth >= 70) {
      const sessionsWidth = clampNumber(Math.round(workspaceWidth * 0.38), 28, 36);
      return {
        direction: "row",
        projectWidth: "100%",
        projectHeight: "100%",
        sessionsWidth,
        sessionsHeight: "100%",
        detailsWidth: Math.max(32, workspaceWidth - sessionsWidth - 1),
        detailsHeight: "100%",
      };
    }
    if (compactHeight(rendererHeight)) {
      return {
        direction: "column",
        projectWidth: "100%",
        projectHeight: drilldown ? "100%" : 7,
        sessionsWidth: "100%",
        sessionsHeight: drilldown ? rendererHeight <= 24 ? 5 : 7 : "auto",
        detailsWidth: "100%",
        detailsHeight: "auto",
      };
    }
    return {
      direction: "column",
      projectWidth: "100%",
      projectHeight: 8,
      sessionsWidth: "100%",
      sessionsHeight: 9,
      detailsWidth: "100%",
      detailsHeight: "auto",
    };
  }
  const projectWidth = clampNumber(Math.round(workspaceWidth * 0.2), 26, 34);
  const sessionsWidth = clampNumber(Math.round(workspaceWidth * 0.28), 34, 44);
  return {
    direction: "row",
    projectWidth,
    projectHeight: "100%",
    sessionsWidth,
    sessionsHeight: "100%",
    detailsWidth: Math.max(36, workspaceWidth - projectWidth - sessionsWidth - 2),
    detailsHeight: "100%",
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
    const marker = key === state.projectFocusKey ? "◆" : key === state.projectCursorKey ? "›" : "";
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

function visibleProjectWindow(rows: readonly ProjectRow[], state: Readonly<MonitorState>, renderer: CliRenderer): readonly ProjectRow[] {
  const workspace = monitorWorkspaceLayout(renderer.width, renderer.height, Boolean(state.projectFocusKey));
  const paneHeight = typeof workspace.projectHeight === "number" ? workspace.projectHeight : Math.max(1, renderer.height - 8);
  // Reserve borders, vertical padding and the table header before windowing.
  // 先扣除边框、垂直内边距和表头，再计算可见行数。
  const capacity = Math.max(1, paneHeight - 5);
  const slots = Math.max(1, Math.min(6, capacity - (rows.length > capacity ? 1 : 0)));
  const selectedIndex = state.projectCursorKey ? rows.findIndex(row => row.key === state.projectCursorKey) : 0;
  return visibleWindow(rows, selectedIndex, slots);
}

function visibleSessionWindow<T>(rows: readonly T[], state: Readonly<MonitorState>, renderer: CliRenderer): readonly T[] {
  const selectedIndex = state.projectFocusKey ? Math.max(0, state.selectedIdx) : 0;
  const workspace = monitorWorkspaceLayout(renderer.width, renderer.height, Boolean(state.projectFocusKey));
  const bodyHeight = Math.max(1, renderer.height - 8);
  const paneHeight = typeof workspace.sessionsHeight === "number" ? workspace.sessionsHeight
    : workspace.direction === "row" ? bodyHeight
      : bodyHeight - (typeof workspace.projectHeight === "number" ? workspace.projectHeight : 0) - 1;
  const verticalChrome = renderer.width < 70 && compactHeight(renderer.height) ? 2 : 4;
  const capacity = Math.max(1, paneHeight - verticalChrome);
  const slots = Math.max(1, capacity - (rows.length > capacity ? 1 : 0));
  const offset = Math.max(0, Math.min(state.sessionScrollOffset ?? 0, rows.length - slots));
  return state.projectFocusKey ? visibleWindow(rows, selectedIndex, slots) : rows.slice(offset, offset + slots);
}

function projectTableModel(rows: readonly ProjectRow[], state: Readonly<MonitorState>, renderer: CliRenderer): InteractiveTable {
  const sidebar = monitorWorkspaceLayout(renderer.width, renderer.height, Boolean(state.projectFocusKey)).direction === "row";
  const compact = renderer.width < 100;
  const content: TextTableContent = sidebar
    ? [[header(""), header("Project"), header("#"), header("Age")]]
    : compact
    ? [[header(""), header("Project"), header("Sessions"), header("Agents"), header("Status")]]
    : [[header(""), header("Project"), header("Sessions"), header("Agents"), header("Status"), header("Path"), header("Age")]];
  const actions: Array<MonitorAction | null> = [null];
  if (rows.length === 0) return { content: [[cell("No projects reporting yet", PALETTE.muted)]], actions };

  const visible = visibleProjectWindow(rows, state, renderer);
  for (const row of visible) {
    actions.push({ type: "project", key: row.key });
    const selected = row.key === state.projectCursorKey;
    const strong = selected ? TextAttributes.BOLD : TextAttributes.NONE;
    const base = [
      cell(row.marker, row.marker ? PALETTE.accent : PALETTE.muted, strong),
      cell(row.project, PALETTE.fg, strong),
      cell(row.sessions, PALETTE.fg, strong),
      cell(row.agents, PALETTE.cyan, strong),
      cell(row.status, PALETTE.fg, strong),
    ];
    content.push(sidebar ? [base[0]!, base[1]!, base[2]!, cell(row.age, PALETTE.muted, strong)] : compact ? base : [
      ...base,
      cell(row.path, PALETTE.muted, strong),
      cell(row.age, PALETTE.muted, strong),
    ]);
  }
  if (visible.length < rows.length) {
    content.push([cell(`... ${rows.length - visible.length} more project${rows.length - visible.length === 1 ? "" : "s"}`, PALETTE.muted)]);
    actions.push(null);
  }
  return { content, actions };
}

function sessionTableModel(rows: readonly SessionRow[], state: Readonly<MonitorState>, renderer: CliRenderer, now = Date.now()): InteractiveTable {
  const content: TextTableContent = [];
  const actions: Array<MonitorAction | null> = [];
  if (rows.length === 0) return { content: [[cell(state.filterText ? "No sessions match the current filter" : "No sessions reporting yet", PALETTE.muted)]], actions: [null] };

  const workspace = monitorWorkspaceLayout(renderer.width, renderer.height, Boolean(state.projectFocusKey));
  const visible = visibleSessionWindow(rows, state, renderer);
  const lineWidth = Math.max(1, (typeof workspace.sessionsWidth === "number" ? workspace.sessionsWidth : renderer.width - 2) - 4);
  for (const row of visible) {
    actions.push({ type: "session", id: row.key });
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
    actions.push(null);
  }
  return { content, actions };
}

export function providerSummaryLine(row: PlanRow): string {
  const form = providerFormLabel(row);
  const label = providerDisplayLabel(row);
  if (row.collectionError) return `${label} ${form} | ${row.collectionError}`;
  if (row.stale) return `${label} ${form} | STALE`;
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
    row.measuredRateLabel
      ? `rate ${row.measuredRateLabel}`
      : row.measuredRate !== undefined && row.measuredRate > 0 ? `rate ${compactNumber(row.measuredRate)}${row.unit || "units"}/h avg` : "",
    row.pacing ? `pacing ${row.pacing}` : "",
    row.cardTiming ? `card ${row.cardTiming}` : "",
    row.autoResetIn ? `reset ${row.autoResetIn}` : "",
  ].filter(Boolean);
  return parts.length ? `${label} ${form} | ${parts.join(" · ")}` : `${label} ${form}`;
}

function providerFormLabel(row: PlanRow): string {
  return row.form === "api" ? "API" : "Subscription";
}

export function providerTableContent(rows: readonly PlanRow[], renderer: CliRenderer, error?: string, selectedIndex?: number, mode: ProviderUsageMode = "token"): TextTableContent {
  return providerTableModel(rows, renderer, error, selectedIndex, mode).content;
}

function providerTableModel(rows: readonly PlanRow[], renderer: CliRenderer, error?: string, selectedIndex?: number, mode: ProviderUsageMode = "token"): InteractiveTable {
  if (error) return { content: [[cell(error, PALETTE.red)]], actions: [null] };
  if (rows.length === 0) return { content: [[cell("No quota data", PALETTE.muted)]], actions: [null] };
  const columns = providerTableColumns(Math.max(1, renderer.width - 4));
  const content: TextTableContent = [columns.map(column => header(truncatePlain(column.label, column.width)))];
  const actions: Array<MonitorAction | null> = [null];
  const visible = selectedIndex === undefined ? rows : visibleWindow(rows, selectedIndex, Math.max(1, renderer.height - 12));
  for (const row of visible) {
    actions.push({ type: "provider", key: providerSelectionKey(row) });
    const selected = selectedIndex !== undefined && rows.indexOf(row) === selectedIndex;
    const tone = providerPresentationTone(row);
    const rowFg = providerQuotaColor(row);
    const trend = providerUsageDisplayTrend(row, mode);
    content.push(columns.map(column => {
      const fit = (value: string) => truncatePlain(terminalText(value).replace(/\s+/g, " "), column.width);
      if (column.key === "provider") return [
        chunk(`${fit(`${selectedIndex === undefined ? "" : selected ? "> " : "  "}${providerDisplayLabel(row)}`)}\n`, PALETTE.fg, selected ? TextAttributes.BOLD : TextAttributes.NONE),
        chunk(`${fit(`  ${providerFormLabel(row)}`)}\n`, PALETTE.muted),
      ];
      if (column.key === "quota") {
        const quota = column.width < 24 ? providerLeftText(row).replace(/ AI credits\b/i, " credits") : providerLeftText(row);
        return [chunk(`${fit(quota)}\n`, rowFg), ...providerUsageMeterChunks(row, column.width)];
      }
      if (column.key === "level") return cell(providerLevelLabel(row).split(" \u00b7 ").map(fit).slice(0, 2).join("\n"), rowFg);
      if (column.key === "usage") {
        const unit = trend?.unit?.replace(/^AI credits$/i, "credits") || (trend ? (trend.kind === "line" ? "30d" : "7d") : "");
        return cell(`${fit(providerUsageSparkline(row, mode))}\n${fit(unit)}`, tone === "neutral" || row.collectionError ? PALETTE.muted : PALETTE.cyan);
      }
      if (column.key === "reset") return cell(fit(providerResetText(row.autoResetIn || "\u2014")), PALETTE.muted);
      return cell(fit(providerCardText(row.cardTiming || "\u2014")), PALETTE.muted);
    }));
  }
  return { content, actions };
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
  if (counts.working) return { score, label: `${counts.working} working`, color: PALETTE.green };
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

export function fitPanelTitle(title: string, panelWidth: number): string {
  return truncatePlain(title, Math.max(4, Math.floor(panelWidth) - 4));
}

function shortcutFooter(width: number, scope: "projects" | "sessions" | "details" | "providers" | "agents"): string {
  const variants: Record<typeof scope, string[]> = {
    providers: [
      "↑↓ provider · 1 tokens 2 cash 3 % · Tab mode · PgUp/Dn details · r refresh · w web · v back · q quit",
      "↑↓ · Tab mode · PgUp/Dn details · r refresh · v back · q quit",
      "↑↓ · Tab · PgUp/Dn · v back · q",
    ],
    agents: [
      "↑↓ agent · 1-3/Tab scope · PgUp/Dn scroll · n more · r refresh · Esc sessions · q quit",
      "↑↓ · Tab scope · n more · r refresh · Esc back · q quit",
      "↑↓ · Tab scope · n more · Esc back",
    ],
    projects: [
      "↑↓ project · Enter open · A agents · v providers · / filter · w web · q quit",
      "↑↓ project · ↵ open · A agents · v providers · / filter · q quit",
      "↑↓ move · ↵ open · v view · q quit",
      "↑↓ · ↵ open · q",
    ],
    sessions: [
      "↑↓ session · A agents · PgUp/PgDn details · Enter focus · Esc projects · r refresh · v providers · / filter · w web · q quit",
      "↑↓ session · PgUp/PgDn details · Esc projects · q quit",
      "↑↓ · PgUp/PgDn details · Esc back",
      "↑↓ · PgUp/Dn · Esc",
    ],
    details: [
      "PgUp/PgDn scroll · Home/End · Tab/[ ] scope · 1-5 tab · Esc sessions · r refresh · v providers · w web · q quit",
      "PgUp/PgDn scroll · Tab scope · Esc/a back · q quit",
      "PgUp/PgDn · Esc back · q quit",
      "PgUp/Dn · Esc",
    ],
  };
  const budget = Math.max(12, width - 2);
  return variants[scope].find(value => value.length <= budget)
    ?? truncatePlain(variants[scope].at(-1)!, budget);
}

function plainMouseClick(event: MouseEvent): boolean {
  return event.button === 0 && !event.modifiers.shift && !event.modifiers.alt && !event.modifiers.ctrl;
}

function bindMonitorClick(
  target: BoxRenderable | TextTableRenderable,
  actionAt: (event: MouseEvent) => MonitorAction | undefined,
  onAction?: (action: MonitorAction) => void,
  onHover?: (event?: MouseEvent) => void,
): void {
  if (!onAction) return;
  let pressed: { action: string; x: number; y: number } | undefined;
  target.onMouseDown = event => {
    const action = plainMouseClick(event) ? actionAt(event) : undefined;
    pressed = action ? { action: JSON.stringify(action), x: event.x, y: event.y } : undefined;
    if (pressed) event.preventDefault();
  };
  target.onMouseUp = event => {
    const previous = pressed;
    pressed = undefined;
    // Text selection marks even a stationary table mouse-up as dragging.
    if (!previous || event.x !== previous.x || event.y !== previous.y) return;
    const action = plainMouseClick(event) ? actionAt(event) : undefined;
    if (!action || previous.action !== JSON.stringify(action)) return;
    event.stopPropagation();
    onAction(action);
  };
  target.onMouseOver = event => onHover?.(event);
  target.onMouseMove = event => onHover?.(event);
  target.onMouseDrag = () => { pressed = undefined; onHover?.(); };
  target.onMouseOut = event => {
    pressed = undefined;
    const inside = event.x >= target.screenX && event.x < target.screenX + target.width
      && event.y >= target.screenY && event.y < target.screenY + target.height;
    onHover?.(inside ? event : undefined);
  };
}

function tableRowAt(table: TextTableRenderable, event: MouseEvent): number | undefined {
  if (event.x < table.screenX || event.x >= table.screenX + table.width || event.y < table.screenY || event.y >= table.screenY + table.height) return;
  let top = table.screenY;
  for (let index = 0; index < table.content.length; index++) {
    const lines = table.content[index]!.map(cell => (cell ?? []).map(chunk => chunk.text).join("").split("\n").length);
    const height = Math.max(1, ...lines) + 2 * table.cellPaddingY;
    if (event.y < top + height) return index;
    top += height;
  }
}

function tableActionAt(table: TextTableRenderable, actions: Array<MonitorAction | null>, event: MouseEvent): MonitorAction | undefined {
  const row = tableRowAt(table, event);
  return row === undefined ? undefined : actions[row] ?? undefined;
}

function paintMonitorButton(button: MonitorButton): void {
  button.label.fg = color(button.active || button.hovered ? PALETTE.fg : PALETTE.muted);
  button.label.attributes = (button.active ? TextAttributes.BOLD | TextAttributes.UNDERLINE : TextAttributes.NONE)
    | (button.hovered ? TextAttributes.INVERSE | TextAttributes.BOLD : TextAttributes.NONE);
}

function paintMonitorTable(table: TextTableRenderable, hover: MonitorTableHover): void {
  table.content = hover.row === undefined ? hover.content : hover.content.map((cells, index) => index !== hover.row ? cells
    : cells.map((cell, column) => column !== hover.column ? cell : cell?.map((chunk, part) => part ? chunk : {
      ...chunk, attributes: (chunk.attributes ?? TextAttributes.NONE) | TextAttributes.BOLD | TextAttributes.UNDERLINE,
    })));
}

function setMonitorTableContent(refs: MonitorRefs, table: TextTableRenderable, content: TextTableContent, actions: Array<MonitorAction | null> = []): void {
  const hover = refs.tableHovers.get(table)!;
  hover.content = content;
  const action = hover.row === undefined ? undefined : actions[hover.row];
  if (!table.visible || !action || JSON.stringify(action) !== hover.actionKey) {
    hover.row = undefined;
    hover.actionKey = undefined;
  }
  paintMonitorTable(table, hover);
}

export function createMonitorView(renderer: CliRenderer, opts: Pick<OpenTuiMonitorOptions, "port" | "getPort">, onAction?: (action: MonitorAction) => void): MonitorRefs {
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

  const mouseButton = (parent: BoxRenderable, id: string, text: string, width: number, action: MonitorAction): MonitorButton => {
    const box = new BoxRenderable(renderer, { id, height: 1, width, flexShrink: 0, alignItems: "center", justifyContent: "center", backgroundColor: PALETTE.bg });
    const label = new TextRenderable(renderer, { content: ` ${text} `, height: 1, fg: PALETTE.muted, selectable: false });
    box.add(label);
    parent.add(box);
    const button = { box, label, active: false, hovered: false };
    bindMonitorClick(box, () => box.visible ? action : undefined, onAction, event => {
      const hovered = Boolean(event) && box.visible;
      if (button.hovered === hovered) return;
      button.hovered = hovered;
      paintMonitorButton(button);
    });
    return button;
  };
  const viewNavigation = new BoxRenderable(renderer, { id: "sessionbar-navigation", height: 1, width: 31, flexShrink: 0, flexDirection: "row", gap: 1 });
  headerBox.add(viewNavigation);
  const backButton = mouseButton(viewNavigation, "sessionbar-back", "\u2190", 3, { type: "back" });
  backButton.box.visible = false;
  const viewButtons = new Map<MonitorView, MonitorButton>();
  for (const [view, label] of [["sessions", "Sessions"], ["providers", "Providers"], ["agents", "Agents"]] as const) {
    viewButtons.set(view, mouseButton(viewNavigation, `sessionbar-view-${view}`, label, label.length + 2, { type: "view", view }));
  }
  headerBox.add(online);

  const activityRow = new BoxRenderable(renderer, { id: "sessionbar-activity-row", width: "100%", height: 1, flexDirection: "row", gap: 1 });
  const activity = new TextRenderable(renderer, {
    id: "sessionbar-activity",
    content: "",
    fg: PALETTE.muted,
    bg: PALETTE.bg,
    selectable: false,
    truncate: true,
    height: 1,
    flexGrow: 1,
    flexShrink: 1,
  });
  activityRow.add(activity);
  const providerModes = new BoxRenderable(renderer, { id: "sessionbar-provider-modes", height: 1, width: 33, flexDirection: "row", gap: 1, flexShrink: 0, visible: false });
  activityRow.add(providerModes);
  const providerModeButtons = new Map<ProviderUsageMode, MonitorButton>();
  for (const [mode, label] of [["token", "Token"], ["cash", "Cash"], ["percentage", "Percentage"]] as const) {
    providerModeButtons.set(mode, mouseButton(providerModes, `sessionbar-mode-${mode}`, label, label.length + 4, { type: "mode", mode }));
  }

  const projectsBox = new BoxRenderable(renderer, {
    id: "sessionbar-projects-box",
    title: "Projects",
    titleColor: PALETTE.fg,
    border: true,
    borderStyle: "rounded",
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
    selectionBg: PALETTE.accent,
    selectionFg: PALETTE.selectionFg,
  });
  projectsBox.add(projectsTable);

  const body = new BoxRenderable(renderer, {
    id: "sessionbar-body",
    width: "100%",
    flexBasis: 0,
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
    borderStyle: "rounded",
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
    selectionBg: PALETTE.accent,
    selectionFg: PALETTE.selectionFg,
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
    columnGap: 2,
    cellPadding: 0,
    border: false,
    showBorders: false,
    fg: PALETTE.fg,
    bg: PALETTE.panel,
    selectionBg: PALETTE.accent,
    selectionFg: PALETTE.selectionFg,
    visible: false,
  });
  sessionsBox.add(providersTable);

  const detailsBox = new BoxRenderable(renderer, {
    id: "sessionbar-details-box",
    title: "Details / Project",
    titleColor: PALETTE.fg,
    border: true,
    borderStyle: "rounded",
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
    height: "auto",
    fg: PALETTE.fg,
    bg: PALETTE.panel,
    wrapMode: "word",
    selectable: true,
    selectionBg: PALETTE.accent,
    selectionFg: PALETTE.selectionFg,
  });
  const detailsScroll = new ScrollBoxRenderable(renderer, {
    id: "sessionbar-details-scroll",
    width: "100%",
    height: "100%",
    scrollX: false,
    scrollY: true,
    stickyScroll: false,
    viewportCulling: true,
    backgroundColor: PALETTE.panel,
  });
  detailsScroll.add(detailsText);
  detailsBox.add(detailsScroll);

  body.add(projectsBox);
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
  root.add(activityRow);
  root.add(body);
  root.add(footer);

  const refs: MonitorRefs = {
    root,
    body,
    title,
    online,
    activity,
    viewButtons,
    viewNavigation,
    backButton,
    providerModes,
    providerModeButtons,
    projectsBox,
    projectsTable,
    sessionsBox,
    sessionsTable,
    providersTable,
    tableHovers: new Map(),
    detailsBox,
    detailsScroll,
    detailsText,
    footer,
  };
  for (const table of [projectsTable, sessionsTable, providersTable]) {
    refs.tableHovers.set(table, { content: [], column: table === projectsTable ? 1 : 0 });
  }
  const bindTable = (container: BoxRenderable, activeTable: () => TextTableRenderable, actions: () => Array<MonitorAction | null>, list: () => MonitorList) => {
    bindMonitorClick(container, event => tableActionAt(activeTable(), actions(), event), onAction, event => {
      const table = activeTable();
      const hover = refs.tableHovers.get(table)!;
      const candidate = event ? tableRowAt(table, event) : undefined;
      const action = candidate === undefined ? undefined : actions()[candidate];
      const row = action ? candidate : undefined;
      const actionKey = action ? JSON.stringify(action) : undefined;
      if (hover.row === row && hover.actionKey === actionKey) return;
      hover.row = row;
      hover.actionKey = actionKey;
      paintMonitorTable(table, hover);
    });
    if (!onAction) return;
    container.onMouseScroll = event => {
      if (event.modifiers.shift || event.modifiers.alt || event.modifiers.ctrl || !actions().some(Boolean)) return;
      if (event.scroll?.direction !== "up" && event.scroll?.direction !== "down") return;
      event.stopPropagation();
      onAction({ type: "step", list: list(), delta: event.scroll.direction === "up" ? -1 : 1, pageSize: actions().filter(Boolean).length });
    };
  };
  bindTable(projectsBox, () => projectsTable, () => refs.model?.projectActions ?? [], () => "projects");
  bindTable(sessionsBox,
    () => refs.model?.view === "providers" ? providersTable : sessionsTable,
    () => (refs.model?.view === "providers" ? refs.model.providerActions : refs.model?.sessionActions) ?? [],
    () => refs.model?.view === "providers" ? "providers" : refs.model?.view === "agents" ? "agents" : "sessions");
  return refs;
}

function providerRowsForState(state: Readonly<MonitorState>): PlanRow[] {
  const query = state.filterText.toLowerCase();
  return state.providers.filter(row => !query || `${row.provider} ${row.label} ${row.form}`.toLowerCase().includes(query));
}

function agentScopeForState(state: Readonly<MonitorState>): string[] {
  return state.detailId ? [state.detailId]
    : state.projectFocusKey ? selectedProjectSessions(state).map(session => session.session_id) : [];
}

function agentsForState(state: Readonly<MonitorState>) {
  return agentList(state.agentSnapshot, agentScopeForState(state), state.filterText);
}

export function monitorVisibleModel(
  state: Readonly<MonitorState>,
  renderer: CliRenderer,
  now = Date.now(),
  opts?: RuntimeDisplayOptions,
): MonitorVisibleModel {
  const port = displayPort(opts);
  const layout = monitorBodyLayout(renderer.width);
  if (state.view === "agents") {
    const rows = agentsForState(state);
    const selectedId = state.agentCursorId ?? state.agentSelection?.agent.agent_id ?? rows[0]?.agent_id;
    const selectedIndex = Math.max(0, rows.findIndex(agent => agent.agent_id === selectedId));
    const selected = state.agentSelection && rows.some(agent => agent.agent_id === state.agentSelection!.agent.agent_id) ? state.agentSelection : null;
    const narrow = renderer.width < 90;
    const listWidth = narrow ? layout.bodyWidth : layout.sidebarPanelWidth;
    const detailWidth = narrow ? layout.bodyWidth : layout.detailPanelWidth;
    const tab = state.agentTab ?? "overview";
    const visible = visibleWindow(rows, selectedIndex, narrow ? 4 : Math.max(2, renderer.height - 10));
    const content: TextTableContent = rows.length ? [[header("Agent"), header("Status"), header("Provider")], ...visible.map(agent => [
      cell(`${agent.agent_id === rows[selectedIndex]?.agent_id ? "> " : "  "}${terminalText(agent.name)}`, PALETTE.fg),
      cell(["completed", "cancelled", "failed"].includes(agent.lifecycle) ? agent.lifecycle : agent.status, statusColor(agent.status)),
      cell(terminalText(agent.provider_id), PALETTE.muted),
    ])] : [];
    const scope = new Set(agentScopeForState(state));
    const coverage = [...new Set(state.agentSnapshot?.sessions.filter(session => !scope.size || scope.has(session.session_id)).map(session => session.agents_coverage) ?? [])].join(" / ");
    return {
      view: "agents", width: renderer.width, height: renderer.height,
      title: "SessionBar [Agents]", online: `online :${port || ""}`,
      activity: state.agentSnapshot ? `${rows.length} observed sub-agents${coverage ? `  ${coverage}` : ""}` : "",
      projectsVisible: false, projectsTitle: "", projectsContent: [],
      sessionsWidth: listWidth, sessionsTitle: fitPanelTitle("Agents", listWidth), sessionsVisible: true, sessionsContent: content,
      sessionActions: rows.length ? [null, ...visible.map(agent => ({ type: "agent" as const, id: agent.agent_id }))] : [],
      providersVisible: false, providersContent: [], detailsVisible: true, detailsWidth: detailWidth,
      detailsTitle: fitPanelTitle(`Agent / ${tab[0]!.toUpperCase() + tab.slice(1)}`, detailWidth),
      detailsContent: agentDetailText(selected, tab, detailTextWidth(detailWidth)),
      detailsScrollKey: `agent:${selected?.agent.agent_id ?? ""}:${tab}`,
      footer: state.filterActive ? `/${state.filterText}_  Esc clear  Enter accept` : shortcutFooter(renderer.width, "agents"),
      footerError: false, focusRegion: "agents",
    };
  }
  if (state.view === "providers") {
    const providers = providerRowsForState(state);
    const apiCount = providers.filter(row => row.form === "api").length;
    const subCount = providers.length - apiCount;
    const error = state.providersError;
    const workspace = providerWorkspaceLayout(renderer.width, renderer.height, providers.length);
    const listWidth = workspace.width;
    const detailWidth = workspace.width;
    const selectedIndex = Math.max(0, Math.min(state.providerIndex ?? 0, providers.length - 1));
    const usageMode = state.providerUsageMode ?? "token";
    const table = providerTableModel(providers, { width: listWidth, height: workspace.visibleRows + 12 } as CliRenderer, error, selectedIndex, usageMode);
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
      sessionsWidth: listWidth,
      sessionsTitle: fitPanelTitle(`Providers (${providers.length})`, listWidth),
      sessionsVisible: false,
      sessionsContent: [],
      providersVisible: true,
      providersContent: table.content,
      providerActions: table.actions,
      providersHeight: workspace.tableHeight,
      providerUsageMode: usageMode,
      detailsVisible: providers.length > 0,
      detailsWidth: detailWidth,
      detailsTitle: fitPanelTitle(`Provider / ${usageMode === "percentage" ? "Percentage" : usageMode === "token" ? "Tokens" : "Cash"}`, detailWidth),
      detailsContent: buildProviderDetailChunks(providers[selectedIndex], usageMode, detailTextWidth(detailWidth)),
      detailsScrollKey: `providers:${providers[selectedIndex]?.provider}:${selectedIndex}:${usageMode}`,
      footer: state.errorMsg ? `! ${state.errorMsg}` : state.filterActive ? `/${state.filterText}_  Esc clear  Enter accept` : shortcutFooter(renderer.width, "providers"),
      footerError: Boolean(state.errorMsg),
      focusRegion: "providers",
    };
  }
  const shown = applyFilter(state.sessions, state.filterText);
  const groups = groupByProject(shown);
  const counts = statusCounts(state.sessions);
  const projectData = projectRows(groups, state, now);
  const scopeSessions = selectedProjectSessions(state);
  const sessionData = sessionRows(state.projectFocusKey ? scopeSessions : shown, state);
  const projects = projectTableModel(projectData, state, renderer);
  const sessions = sessionTableModel(sessionData, state, renderer, now);
  const selected = selectedSession(state);
  const workspace = monitorWorkspaceLayout(renderer.width, renderer.height, Boolean(state.projectFocusKey));
  const shortWindow = compactHeight(renderer.height) && renderer.width < 120;
  const drilldown = shortWindow && Boolean(state.projectFocusKey);
  const detailOnly = Boolean(state.detailId) && renderer.width < 70 && renderer.height <= 24;
  const panelWidth = (width: number | `${number}%`) => typeof width === "number" ? width : layout.bodyWidth;
  const detailPanelWidth = panelWidth(workspace.detailsWidth);
  const projectPanelWidth = panelWidth(workspace.projectWidth);
  const sessionPanelWidth = panelWidth(workspace.sessionsWidth);
  const detailWidth = detailTextWidth(detailPanelWidth);
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

  const focusRegion = state.detailId ? "details" : state.projectFocusKey ? "sessions" : "projects";
  const footer = state.errorMsg
    ? `! ${state.errorMsg}`
    : state.filterActive
      ? `/${state.filterText}_  ${shown.length}/${state.sessions.length} sessions  Esc clear  Enter accept`
      : shortcutFooter(renderer.width, focusRegion);

  return {
    view: state.view,
    width: renderer.width,
    height: renderer.height,
    title: "SessionBar [Sessions]",
    online: `online :${port || ""}`,
    activity,
    projectsVisible: !drilldown,
    projectsTitle: fitPanelTitle(`${focusRegion === "projects" ? "› " : ""}Projects (${groups.size})`, projectPanelWidth),
    projectsContent: projects.content,
    projectActions: projects.actions,
    sessionsWidth: panelWidth(workspace.sessionsWidth),
    sessionsTitle: fitPanelTitle(`${focusRegion === "sessions" ? "› " : ""}${sessionTitle}`, sessionPanelWidth),
    sessionsVisible: !detailOnly,
    sessionsContent: detailOnly ? [] : sessions.content,
    sessionActions: detailOnly ? [] : sessions.actions,
    providersVisible: false,
    providersContent: [],
    detailsVisible: !shortWindow || drilldown,
    detailsWidth: detailPanelWidth,
    detailsTitle: fitPanelTitle(selected
      ? `${focusRegion === "details" ? "› " : ""}Details / Session / ${detailTabTitle(state.detailTab)}`
      : state.projectFocusKey ? "Details / Project" : "Details / System", detailPanelWidth),
    detailsContent: details,
    detailsScrollKey: selected
      ? `session:${selected.session_id}:${state.detailTab}`
      : state.projectFocusKey
        ? `project:${state.projectFocusKey}`
        : "system",
    footer,
    footerError: Boolean(state.errorMsg),
    focusRegion,
  };
}

export function renderMonitorView(refs: MonitorRefs, model: MonitorVisibleModel): void {
  refs.model = model;
  const compactSecondary = model.view === "providers" ? model.height <= 36 : model.view !== "sessions" && model.width < 90;
  refs.sessionsBox.paddingY = compactSecondary || (model.view === "sessions" && model.width < 70 && compactHeight(model.height)) ? 0 : 1;
  refs.detailsBox.paddingY = compactSecondary || (model.view === "sessions" && compactHeight(model.height)) ? 0 : 1;
  refs.title.content = brandHeaderContent("SessionBar");
  refs.online.content = model.online;
  refs.online.visible = model.width >= 60;
  const canGoBack = model.view === "sessions" && model.focusRegion !== "projects";
  refs.backButton.box.visible = canGoBack;
  if (!canGoBack) refs.backButton.hovered = false;
  paintMonitorButton(refs.backButton);
  const viewLabels: Record<MonitorView, string> = model.width < 48
    ? { sessions: "Sess", providers: "Prov", agents: "Agents" }
    : { sessions: "Sessions", providers: "Providers", agents: "Agents" };
  let navigationWidth = 2 + (canGoBack ? 4 : 0);
  for (const [view, button] of refs.viewButtons) {
    const label = viewLabels[view];
    button.box.width = label.length + 2;
    button.label.content = ` ${label} `;
    navigationWidth += label.length + 2;
    button.active = view === model.view;
    paintMonitorButton(button);
  }
  refs.viewNavigation.width = navigationWidth;
  refs.activity.content = model.activity;
  refs.activity.visible = true;
  refs.providerModes.visible = model.view === "providers";
  if (model.view === "providers") {
    const prefix = model.width >= 100 ? model.activity : model.width >= 60 ? model.activity.split("  ")[0] : "";
    const labels: Record<ProviderUsageMode, string> = { token: "Token", cash: "Cash", percentage: "Percentage" };
    refs.activity.content = prefix;
    refs.activity.visible = Boolean(prefix);
    for (const [mode, button] of refs.providerModeButtons) {
      const active = mode === model.providerUsageMode;
      button.label.content = ` ${labels[mode]} `;
      button.active = active;
      paintMonitorButton(button);
    }
  } else {
    for (const button of refs.providerModeButtons.values()) {
      button.hovered = false;
      paintMonitorButton(button);
    }
  }
  refs.projectsBox.visible = model.projectsVisible;
  refs.projectsBox.title = model.projectsTitle;
  refs.projectsBox.borderColor = model.focusRegion === "projects" ? color(PALETTE.accent) : color(PALETTE.border);
  refs.projectsBox.titleColor = model.focusRegion === "projects" ? color(PALETTE.accent) : color(PALETTE.fg);
  setMonitorTableContent(refs, refs.projectsTable, model.projectsContent, model.projectActions);
  if (model.view === "sessions") {
    const drilldown = model.focusRegion === "sessions" || model.focusRegion === "details";
    const workspace = monitorWorkspaceLayout(model.width, model.height, drilldown);
    refs.body.flexDirection = workspace.direction;
    refs.projectsBox.width = workspace.projectWidth;
    refs.projectsBox.height = workspace.projectHeight;
    refs.sessionsBox.width = workspace.sessionsWidth;
    refs.sessionsBox.height = workspace.sessionsHeight;
    refs.sessionsBox.flexGrow = compactHeight(model.height) && model.width < 120 && !drilldown ? 1 : 0;
    refs.detailsBox.width = workspace.detailsWidth;
    refs.detailsBox.height = workspace.detailsHeight;
  } else if (model.view === "providers") {
    refs.body.flexDirection = "column";
    refs.sessionsBox.width = "100%";
    refs.sessionsBox.height = model.providersHeight ?? 7;
    refs.sessionsBox.flexGrow = 0;
    refs.detailsBox.width = "100%";
    refs.detailsBox.height = "auto";
    refs.detailsBox.flexGrow = 1;
  } else {
    const narrow = model.width < 90;
    refs.body.flexDirection = narrow ? "column" : "row";
    refs.sessionsBox.width = narrow ? "100%" : model.sessionsWidth;
    refs.sessionsBox.height = narrow ? Math.max(4, Math.min(6, model.height - 14)) : "100%";
    refs.sessionsBox.flexGrow = 0;
    refs.detailsBox.width = narrow ? "100%" : model.detailsWidth;
    refs.detailsBox.height = narrow ? "auto" : "100%";
    refs.detailsBox.flexGrow = 1;
  }
  // Numeric widths disable shrinking in OpenTUI; restore it after layout changes.
  refs.detailsBox.flexShrink = 1;
  refs.sessionsBox.title = model.sessionsTitle;
  refs.sessionsBox.visible = model.view !== "sessions" || model.sessionsVisible;
  refs.sessionsBox.borderColor = model.focusRegion === "sessions" || model.focusRegion === "providers" || model.focusRegion === "agents" ? color(PALETTE.accent) : color(PALETTE.border);
  refs.sessionsBox.titleColor = model.focusRegion === "sessions" || model.focusRegion === "providers" || model.focusRegion === "agents" ? color(PALETTE.accent) : color(PALETTE.fg);
  refs.sessionsTable.visible = model.sessionsVisible;
  setMonitorTableContent(refs, refs.sessionsTable, model.sessionsContent, model.sessionActions);
  refs.providersTable.visible = model.providersVisible;
  setMonitorTableContent(refs, refs.providersTable, model.providersContent, model.providerActions);
  refs.detailsBox.visible = model.detailsVisible;
  refs.detailsBox.title = model.detailsTitle;
  refs.detailsBox.borderColor = model.focusRegion === "details" ? color(PALETTE.accent) : color(PALETTE.border);
  refs.detailsBox.titleColor = model.focusRegion === "details" ? color(PALETTE.accent) : color(PALETTE.fg);
  refs.detailsText.content = model.detailsContent;
  refs.detailsText.width = detailTextWidth(model.detailsWidth);
  if (refs.detailsScrollKey !== model.detailsScrollKey) {
    refs.detailsScroll.scrollTo({ x: 0, y: 0 });
    refs.detailsScrollKey = model.detailsScrollKey;
  }
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
  current: MonitorView,
  key: MonitorKeyLike,
): MonitorView | null {
  const normalized = {
    ...key,
    raw: key.raw || "",
    sequence: key.sequence || "",
    ctrl: Boolean(key.ctrl),
    meta: Boolean(key.meta),
    option: Boolean(key.option),
  } as KeyEvent;
  const char = printableChar(normalized);
  if (char === "A") return current === "agents" ? "sessions" : "agents";
  if (char === "v" || char === "P") return current === "providers" ? "sessions" : "providers";
  return null;
}

export type DetailsScrollAction = "page-up" | "page-down" | "top" | "bottom";

export function detailsScrollActionFromMonitorKey(key: MonitorKeyLike): DetailsScrollAction | null {
  if (key.ctrl || key.meta || key.option) return null;
  if (key.name === "pageup" || key.name === "kppageup") return "page-up";
  if (key.name === "pagedown" || key.name === "kppagedown") return "page-down";
  if (key.name === "home") return "top";
  if (key.name === "end") return "bottom";
  return null;
}

function scrollDetails(refs: MonitorRefs, key: KeyEvent): boolean {
  const action = detailsScrollActionFromMonitorKey(key);
  if (!action) return false;
  if (action === "top") refs.detailsScroll.scrollTo({ x: 0, y: 0 });
  else if (action === "bottom") refs.detailsScroll.scrollTo({ x: 0, y: refs.detailsScroll.scrollHeight });
  else refs.detailsScroll.scrollBy(action === "page-up" ? -0.8 : 0.8, "viewport");
  return true;
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
  const visibleProjects = new Set(visibleProjectWindow(projectData, state, renderer).map(row => row.key));
  let deadline: number | undefined;
  for (const [key, sessions] of groups.entries()) {
    if (visibleProjects.has(key)) deadline = earlierDeadline(deadline, nextAgeChangeAt(latestTimestamp(sessions), now), now);
  }

  const scope = state.projectFocusKey ? selectedProjectSessions(state) : shown;
  for (const session of visibleSessionWindow(scope, state, renderer)) {
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
  if (state.view === "providers" || state.view === "agents") return undefined;
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
    useMouse: true,
    enableMouseMovement: true,
    consoleMode: "disabled",
  });

  return mountOpenTuiMonitor(renderer, opts);
}

export function mountOpenTuiMonitor(renderer: CliRenderer, opts: OpenTuiMonitorOptions): Promise<void> {
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
      view: opts.initialView ?? "sessions",
      providers: [],
      providersError: undefined,
    });
    let disposed = false;
    let freshnessTimer: ReturnType<typeof setTimeout> | undefined;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let terminalFocused = true;
    const refs = createMonitorView(renderer, opts, handleMouseAction);

    const requestVisibleUpdate = createVisibleModelUpdater((model: MonitorVisibleModel) => {
      renderMonitorView(refs, model);
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
    let agentClient: AgentClient | undefined;
    if (opts.agentRequest) {
      agentClient = new AgentClient(opts.agentRequest, () => {
        update(current => ({ ...current, agentSnapshot: agentClient!.snapshot, agentSelection: agentClient!.selected }));
      });
    }
    const refreshAgents = async () => {
      await agentClient?.refreshSnapshot();
      if (disposed || state.view !== "agents") return;
      const rows = agentsForState(state);
      if (!rows.some(agent => agent.agent_id === agentClient?.selected?.agent.agent_id)) {
        const selected = rows.find(agent => agent.agent_id === state.agentCursorId) ?? rows[0];
        if (selected) agentClient?.select(selected.agent_id);
      }
    };
    function handleMouseAction(action: MonitorAction) {
      if (disposed) return;
      const previousView = state.view;
      const previousAgent = state.agentCursorId;
      update(current => applyMonitorAction(current, action));
      if (state.view === "providers" && previousView !== "providers") void refreshProviders("manual");
      if (state.view === "agents") {
        if (previousView !== "agents") void refreshAgents();
        else if (state.agentCursorId && state.agentCursorId !== previousAgent) agentClient?.select(state.agentCursorId);
      }
    }
    const close = () => {
      if (disposed) return;
      disposed = true;
      if (pollTimer) clearTimeout(pollTimer);
      if (freshnessTimer) clearTimeout(freshnessTimer);
      opts.closeTransport?.();
      agentClient?.stop();
      renderer.keyInput.off("keypress", keyHandler);
      renderer.off("resize", resizeHandler);
      renderer.off("focus", focusHandler);
      renderer.off("blur", blurHandler);
      refs.root.destroyRecursively();
      renderer.destroy();
      resolve();
    };
    const keyHandler = (key: KeyEvent) => {
      if ((key.ctrl && key.name === "c") || (!state.filterActive && key.name === "q")) {
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

      const nextView = nextViewFromMonitorKey(state.view, key);
      if (nextView) {
        update(current => ({ ...current, view: nextView, filterText: "", filterActive: false }));
        if (nextView === "agents") void refreshAgents();
        if (nextView === "providers") void refreshProviders("manual");
        return;
      }

      if (state.view === "agents") {
        if (scrollDetails(refs, key)) { renderer.requestRender(); return; }
        const rows = agentsForState(state);
        const char = printableChar(key);
        const tab = state.agentTab ?? "overview";
        const number = /^[1-3]$/.test(char) ? Number(char) - 1 : -1;
        if (number >= 0 || key.name === "tab" || char === "[" || char === "]") {
          const index = number >= 0 ? number : (AGENT_DETAIL_TABS.indexOf(tab) + (char === "[" ? 2 : 1)) % 3;
          update(current => ({ ...current, agentTab: AGENT_DETAIL_TABS[index] }));
        } else if (["up", "down", "j", "k"].includes(key.name) || isEnter(key)) {
          const current = Math.max(0, rows.findIndex(agent => agent.agent_id === (state.agentCursorId ?? agentClient?.selected?.agent.agent_id)));
          const index = Math.max(0, Math.min(rows.length - 1, current + (["up", "k"].includes(key.name) ? -1 : isEnter(key) ? 0 : 1)));
          const agent = rows[index];
          if (agent) {
            update(current => ({ ...current, agentCursorId: agent.agent_id }));
            agentClient?.select(agent.agent_id);
          }
        } else if (key.name === "n" && tab !== "overview") void agentClient?.loadMore(tab === "conversation" ? "conversation" : "workflow");
        else if (key.name === "r") {
          if (agentClient?.selected) void agentClient.refreshDetail();
          else void refreshAgents();
        } else if (key.name === "escape" || isBackspace(key)) {
          agentClient?.clearSelection();
          update(current => ({ ...current, view: "sessions", filterText: "" }));
        } else if (char === "/") update(current => ({ ...current, filterActive: true, filterText: "" }));
        else if (key.name === "w") void opts.openWebDashboard();
        return;
      }

      if (state.view === "providers") {
        if (scrollDetails(refs, key)) { renderer.requestRender(); return; }
        const char = printableChar(key);
        const mode = state.providerUsageMode ?? "token";
        const number = /^[1-3]$/.test(char) ? Number(char) - 1 : -1;
        if (number >= 0 || key.name === "tab" || char === "[" || char === "]") {
          const index = number >= 0 ? number : (PROVIDER_USAGE_MODES.indexOf(mode) + (char === "[" ? 2 : 1)) % 3;
          update(current => ({ ...current, providerUsageMode: PROVIDER_USAGE_MODES[index] }));
        } else if (["up", "down", "j", "k"].includes(key.name)) {
          update(current => applyMonitorAction(current, { type: "step", list: "providers", delta: ["up", "k"].includes(key.name) ? -1 : 1 }));
        } else if (key.name === "r") void refreshProviders("manual");
        else if (char === "/") update(current => ({ ...current, filterActive: true, filterText: "" }));
        else if (key.name === "escape") update(current => ({ ...current, view: "sessions", filterText: "" }));
        else if (key.name === "w") void opts.openWebDashboard();
        return;
      }

      if (state.projectFocusKey && scrollDetails(refs, key)) {
        renderer.requestRender();
        return;
      }

      const nextTab = nextDetailTabFromMonitorKey(state.detailTab, key);
      if (state.projectFocusKey && nextTab) {
        update(current => clampState({ ...current, detailTab: nextTab }));
        return;
      }

      if (key.name === "up" || key.name === "k") update(current => moveSession(current, -1));
      else if (key.name === "down" || key.name === "j") update(current => moveSession(current, 1));
      else if (isEnter(key)) update(toggleDetail);
      else if (key.name === "a" || key.name === "escape" || isBackspace(key)) update(clearProjectFocus);
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
      if (state.view === "agents") void refreshAgents();
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
    if (state.view === "agents") void refreshAgents();
    schedulePoll();
  });
}
