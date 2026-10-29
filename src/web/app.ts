// SessionBar web dashboard — Tailwind + vanilla TS
import { mountAppHeader } from "./appShell.js";
import type { SessionPayload } from "../shared/types.js";
import type { Snapshot } from "../shared/agentContract.js";
import { AgentClient } from "./agentClient.js";
import { installWorkflowCanvases, sessionFlowMarkup } from "./workflowViews.js";
import { createMarkupCommitter } from "./markupCommitter.js";
import { ExecutionClient } from "./executionClient.js";
import { executionTraceMarkup, installExecutionViews } from "./executionViews.js";
import { reportedWorkflowGraph } from "../shared/workflowGraph.js";
import { agentProjectKey, UNASSIGNED_PROJECT_KEY, agentAvatarMarkup, agentRosterMarkup, agentTabsMarkup, agentDetailMarkup, projectAgentRoster, sessionAgentRoster, installAgentAvatarFallbacks, syncAgentAvatars, withoutAgentAvatarLoadState, type AgentTab } from "./agentViews.js";
import type { PlanRow, ProviderUsageMode } from "../providers/planTypes.js";
import { sessionDisplayName, sessionListColumns, sessionServiceLabel } from "../tui/displayUtils.js";
import {
  UI,
  countSessions,
  createWebSystemMonitor,
  cx,
  detailListMarkup,
  escapeHtml,
  iconMarkup,
  projectIconListMarkup,
  providerDailyUsageMarkup,
  providerTableMarkup,
  sceneSummaryMarkup,
  statusDotMarkup,
  statusLabel,
  statusSummaryMarkup,
  tabsMarkup,
} from "./webComponents.js";

interface SplideInstance {
  index: number;
  sync(other: SplideInstance): SplideInstance;
  mount(): SplideInstance;
  destroy(completely?: boolean): void;
  go(control: number | string): SplideInstance;
  on(event: string, callback: (...args: unknown[]) => void): SplideInstance;
}

interface SplideConstructor {
  new (target: Element, options?: Record<string, unknown>): SplideInstance;
}

declare global {
  interface Window { Splide?: SplideConstructor; }
}

const appHeader = mountAppHeader("dashboard", "connecting");
const countsEl = document.getElementById("counts")!;
const projectsBody = document.getElementById("projects-body")!;
const projectsHdr  = document.getElementById("projects-header")!;
const sessionsBody = document.getElementById("sessions-body")!;
const sessionsHdr  = document.getElementById("sessions-header")!;
const detailBody   = document.getElementById("detail-body")!;
const detailHdr    = document.getElementById("detail-header")!;
const footerEl     = document.getElementById("footer")!;
const filterInput  = document.getElementById("filter") as HTMLInputElement;
const filterHint   = document.getElementById("filter-hint")!;
const sessionScene = document.getElementById("session-scene")!;
const sessionShell = document.getElementById("session-shell")!;
const sessionContent = document.getElementById("session-content")!;
const sessionCompact = document.getElementById("session-compact")!;
const sessionWorkspace = document.querySelector<HTMLElement>(".session-workspace")!;
const providersPanel = document.getElementById("providers-panel")!;
const providersSessionBar = document.getElementById("providers-session-bar")!;
const providersHeader = document.getElementById("providers-header")!;
const providersStatus = document.getElementById("providers-status")!;
const providersDailyUsage = document.getElementById("providers-daily-usage")!;
const providersBody = document.getElementById("providers-body")!;
const providerUsageModeButtons = [...document.querySelectorAll<HTMLButtonElement>("[data-provider-usage-mode]")];
const stopAgentAvatarFallbacks = installAgentAvatarFallbacks(document);

const disconnectedBanner = document.getElementById("connection-banner") as HTMLDivElement;
let sessionConnectionState: "connecting" | "online" | "offline" = "connecting";
let selectedId: string | null = null;
let focusedProject: string | null = null;
let expandedProjectIcons: string | null = null;
let detailTab = 0; // 0=overview 1=activity 2=usage 3=flow 4=raw
let lastSessions: SessionPayload[] = [];
let providers: PlanRow[] = [];
let providersInitializing = true;
let providersError: string | null = null;
let providersLoaded = false;
let providersFetchInFlight = false;
let providersRetryTimer: number | undefined;
let providerRefreshTimer: number | undefined;
let systemRefreshTimer: number | undefined;
let sessionAgeTimer: number | undefined;
let providerGalleryMain: SplideInstance | null = null;
let providerGalleryTabs: SplideInstance | null = null;
let providerGalleryIndex = 0;
const iconCache = new Map<string, string>();
const PROVIDER_USAGE_MODE_KEY = "sessionbar:provider-usage-mode";
let providerUsageMode = readProviderUsageMode();
let lastAgentSnapshot: Snapshot | null = null;
let agentDetailTab: AgentTab = "overview";
let agentRefreshTimer: number | undefined;
let agentDialog: HTMLDialogElement | null = null;
const expandedAgentRosters = new Set<string>();
const executionClient = new ExecutionClient(window.fetch.bind(window), () => { syncExecutionViews(); });
const agentClient = new AgentClient(window.fetch.bind(window), () => {
  const focusedSession = focusedProject ? lastSessions.find(session => agentProjectKey(session, lastAgentSnapshot) === focusedProject) : undefined;
  lastAgentSnapshot = agentClient.snapshot;
  if (focusedSession) focusedProject = agentProjectKey(focusedSession, lastAgentSnapshot);
  render(lastSessions);
});
function projectKey(session: SessionPayload): string { return agentProjectKey(session, lastAgentSnapshot); }
function focusedProjectName(): string {
  if (focusedProject === UNASSIGNED_PROJECT_KEY) return "Unassigned sessions";
  return lastSessions.find(session => projectKey(session) === focusedProject) ? extractProject(lastSessions.find(session => projectKey(session) === focusedProject)!) : "All sessions";
}

const commitMarkup = createMarkupCommitter<Element>(withoutAgentAvatarLoadState, syncAgentAvatars);
installWorkflowCanvases();
installExecutionViews();

function readProviderUsageMode(): ProviderUsageMode {
  try {
    const value = window.localStorage.getItem(PROVIDER_USAGE_MODE_KEY);
    if (value === "cash" || value === "percentage") return value;
  } catch { /* storage is optional */ }
  return "token";
}

function setProviderUsageMode(mode: ProviderUsageMode): void {
  providerUsageMode = mode;
  try { window.localStorage.setItem(PROVIDER_USAGE_MODE_KEY, mode); } catch { /* storage is optional */ }
  renderProviders();
}

const systemMonitor = createWebSystemMonitor({
  detailHeader: detailHdr,
  detailBody,
  isVisible: () => !selectedId && !focusedProject,
  request: async signal => {
    const response = await fetch("/system/live", {
      headers: { Accept: "application/json" },
      signal,
    });
    if (!response.ok) throw new Error(`System request failed (${response.status})`);
    return response.json();
  },
});

let sceneFrame = 0;
let sceneMeasureFrame = 0;
let sceneExpandedHeight = 0;
let sceneStart = 0;
let sceneDistance = 420;
let sceneHasMeasured = false;
let lastSceneScrollY = window.scrollY;
let lastSceneScrollAt = performance.now();
let sceneMomentumBypassUntil = 0;
const compactHeight = 56;
const sessionFadeEnd = 0.72;
const providersFadeEnd = 0.6;
const sceneHoldDistance = 24;
const sceneMomentumSpeed = 0.35;
const sceneMomentumGrace = 180;
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const providerGalleryMedia = window.matchMedia("(max-width: 640px)");

function extractProject(s: SessionPayload): string {
  if (projectKey(s) === UNASSIGNED_PROJECT_KEY) return "Unassigned sessions";
  if (s.project) return s.project;
  if (s.project_path) {
    const p = s.project_path.split("/");
    return p[p.length - 1] || s.project_path;
  }
  const sid = s.session_id || "";
  const sep = sid.indexOf("__");
  if (sep !== -1) return sid.slice(sep + 2);
  return sid.replace(/^(claude|gemini|codex|copilot|opencode|pi-agent|pi|kimi|qwen|deepseek|windsurf|cursor|workbuddy|minimax)-/, "")
    .replace(/-\d+-\d+$/, "") || "?";
}

function icon(t: string): string {
  return iconMarkup(t, iconCache);
}

function setProjectIconStackExpanded(stack: HTMLElement, expanded: boolean): void {
  const label = `${expanded ? "Collapse" : "Expand"} agent icons`;
  stack.classList.toggle("is-expanded", expanded);
  stack.setAttribute("aria-expanded", String(expanded));
  stack.setAttribute("aria-label", label);
  stack.setAttribute("title", label);
}

function age(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 10) return "now";
  if (s < 60) return s + "s";
  if (s < 3600) return Math.floor(s / 60) + "m";
  return Math.floor(s / 3600) + "h";
}

function ageLabel(ts: number): string {
  const value = age(ts);
  return value === "now" ? value : `${value} ago`;
}

function syncSessionWorkspace(): void {
  // Keep the desktop workspace stable while each panel owns its own scroll.
  // The mobile breakpoint keeps its compact height through CSS.
  sessionWorkspace.style.removeProperty("height");
}

function currentSceneSummaryMarkup(): string {
  const counts = countSessions(lastSessions);
  const selected = selectedId ? lastSessions.find(s => s.session_id === selectedId) : undefined;
  const current = selected ? sessionDisplayName(selected) : focusedProject ? focusedProjectName() : "All sessions";
  return sceneSummaryMarkup(counts, current);
}

function renderSceneSummary(): void {
  const markup = currentSceneSummaryMarkup();
  commitMarkup(sessionCompact, markup);
  commitMarkup(providersSessionBar, markup);
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function applySceneProgress(): void {
  // Ignore tiny wheel/touch movements so the current scene stays visually
  // stable until the user commits to the transition. A fast swipe/wheel
  // momentum temporarily bypasses the hold so it can carry the scene through.
  const holdDistance = performance.now() < sceneMomentumBypassUntil ? 0 : sceneHoldDistance;
  const sceneTravel = Math.max(1, sceneDistance - holdDistance);
  const scrollProgress = clamp((window.scrollY - sceneStart - holdDistance) / sceneTravel);
  const progress = reducedMotion.matches
    ? (scrollProgress >= 0.98 ? 1 : 0)
    : scrollProgress;
  const height = sceneExpandedHeight > 0 ? sceneExpandedHeight : compactHeight;
  sessionShell.style.height = `${Math.round(height)}px`;
  sessionShell.style.setProperty("--scene-progress", progress.toFixed(4));
  sessionShell.style.setProperty("--session-shift", `${Math.round(progress * -42)}px`);
  sessionShell.style.setProperty("--session-scale", `${(1 - progress * 0.06).toFixed(4)}`);
  const sessionOpacity = clamp(1 - progress / sessionFadeEnd);
  const providersOpacity = clamp(progress / providersFadeEnd);
  sessionShell.style.setProperty("--session-opacity", sessionOpacity.toFixed(4));
  sessionShell.style.setProperty("--compact-shift", `${Math.round((1 - progress) * -16)}px`);
  sessionShell.style.setProperty("--compact-opacity", progress > 0.01 ? "1" : "0");
  sessionCompact.style.visibility = progress > 0.01 ? "visible" : "hidden";
  providersPanel.style.setProperty("--providers-opacity", providersOpacity.toFixed(4));
  providersSessionBar.style.setProperty("--providers-bar-opacity", providersOpacity.toFixed(4));
  providersSessionBar.style.setProperty("--providers-bar-shift", `${Math.round((1 - providersOpacity) * 10)}px`);
  sessionContent.style.pointerEvents = progress >= sessionFadeEnd ? "none" : "";
}

function scheduleSceneProgress(): void {
  if (sceneFrame) return;
  sceneFrame = requestAnimationFrame(() => {
    sceneFrame = 0;
    applySceneProgress();
  });
}

function handleSceneScroll(): void {
  const now = performance.now();
  const elapsed = Math.max(8, now - lastSceneScrollAt);
  const deltaY = window.scrollY - lastSceneScrollY;
  const speed = Math.abs(deltaY) / elapsed;
  if (deltaY > 0 && speed >= sceneMomentumSpeed) {
    sceneMomentumBypassUntil = now + sceneMomentumGrace;
  }
  lastSceneScrollY = window.scrollY;
  lastSceneScrollAt = now;
  scheduleSceneProgress();
}

function measureScene(): void {
  const inTransition = sceneHasMeasured
    && window.scrollY > sceneStart + 4
    && window.scrollY < sceneStart + sceneDistance - 4;
  if (inTransition) {
    // A provider refresh can change document height while the user is
    // crossing the scene. Keep the current scene geometry until the motion
    // settles so the browser does not re-anchor the page mid-transition.
    applySceneProgress();
    return;
  }
  sceneExpandedHeight = Math.max(compactHeight, sessionContent.scrollHeight);
  const naturalStart = sessionScene.getBoundingClientRect().top + window.scrollY - 24;
  const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
  const preferredDistance = Math.min(280, Math.max(120, Math.round(sceneExpandedHeight * 0.28)));
  const earlyStart = maxScroll - preferredDistance;
  sceneStart = maxScroll > naturalStart && earlyStart < naturalStart
    ? Math.max(0, earlyStart)
    : naturalStart;
  sceneDistance = maxScroll > sceneStart ? maxScroll - sceneStart : 420;
  sceneHasMeasured = true;
  applySceneProgress();
}

function scheduleSceneMeasure(): void {
  if (sceneMeasureFrame) return;
  sceneMeasureFrame = requestAnimationFrame(() => {
    sceneMeasureFrame = 0;
    measureScene();
  });
}

function renderProviders(): void {
  const statusText = providersError ? "Unavailable" : providersInitializing ? "Loading" : "";
  providersStatus.textContent = statusText;
  providersStatus.className = `providers-status${providersError ? " providers-status-error" : providersInitializing ? " providers-status-loading" : ""}`;
  providersHeader.classList.toggle("is-error", Boolean(providersError));
  providersDailyUsage.innerHTML = providerDailyUsageMarkup(providers, providerUsageMode);
  for (const button of providerUsageModeButtons) {
    button.setAttribute("aria-pressed", String(button.dataset.providerUsageMode === providerUsageMode));
  }
  providersBody.innerHTML = providerTableMarkup(providers, {
    loading: providersInitializing,
    error: providersError || undefined,
    iconCache,
    usageMode: providerUsageMode,
  });
  mountProviderGallery();
  providersBody.querySelector("[data-providers-retry]")?.addEventListener("click", () => { void fetchProviders(); });
  if (sceneExpandedHeight > 0) scheduleSceneMeasure();
}

function mountProviderGallery(): void {
  if (providerGalleryMain) providerGalleryIndex = providerGalleryMain.index;
  providerGalleryMain?.destroy(true);
  providerGalleryTabs?.destroy(true);
  providerGalleryMain = null;
  providerGalleryTabs = null;
  if (!providerGalleryMedia.matches || !window.Splide || providers.length === 0) return;
  const mainElement = providersBody.querySelector(".provider-gallery-main");
  const tabsElement = providersBody.querySelector(".provider-gallery-tabs");
  if (!mainElement || !tabsElement) return;
  const tabs = new window.Splide(tabsElement, {
    autoWidth: true,
    gap: "6px",
    pagination: false,
    arrows: false,
    isNavigation: true,
    focus: "center",
    trimSpace: true,
    drag: "free",
    snap: true,
    keyboard: "focused",
    start: Math.min(providerGalleryIndex, providers.length - 1),
  });
  const main = new window.Splide(mainElement, {
    type: "slide",
    perPage: 1,
    gap: "10px",
    pagination: false,
    arrows: false,
    drag: true,
    speed: 320,
    flickMaxPages: 1,
    autoHeight: true,
    keyboard: "focused",
    start: Math.min(providerGalleryIndex, providers.length - 1),
  });
  main.sync(tabs);
  main.on("moved", (index) => { if (typeof index === "number") providerGalleryIndex = index; });
  main.mount();
  tabs.mount();
  tabsElement.addEventListener("click", event => {
    const tab = (event.target as Element | null)?.closest<HTMLElement>("[data-provider-gallery-index]");
    if (!tab) return;
    const index = Number(tab.dataset.providerGalleryIndex);
    if (!Number.isInteger(index)) return;
    providerGalleryIndex = index;
    main.go(index);
  }, { capture: true });
  providerGalleryMain = main;
  providerGalleryTabs = tabs;
}

async function fetchProviders(): Promise<void> {
  if (providersFetchInFlight) return;
  providersFetchInFlight = true;
  if (providersRetryTimer !== undefined) {
    window.clearTimeout(providersRetryTimer);
    providersRetryTimer = undefined;
  }
  providersInitializing = !providersLoaded && providers.length === 0 && !providersError;
  renderProviders();
  try {
    const response = await fetch("/providers/live", { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`Provider request failed (${response.status})`);
    const data = await response.json() as { providers?: PlanRow[]; initializing?: boolean };
    providers = Array.isArray(data.providers) ? data.providers : [];
    providersInitializing = data.initializing === true;
    providersLoaded = !providersInitializing;
    providersError = null;
  } catch (error) {
    providersInitializing = false;
    providersError = error instanceof Error ? error.message : "Provider request failed";
  } finally {
    providersFetchInFlight = false;
  }
  renderProviders();
  if (providersInitializing && providersRetryTimer === undefined) {
    providersRetryTimer = window.setTimeout(() => {
      providersRetryTimer = undefined;
      void fetchProviders();
    }, document.hidden ? 15_000 : 1_000);
  }
}

function formatMetric(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1).replace(/\.0$/, "")}B`;
  if (absolute >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (absolute >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return Math.round(value).toLocaleString();
}

function detailSectionMarkup(title: string, body: string, className = ""): string {
  return `<section class="detail-section${className ? ` ${className}` : ""}"><div class="detail-section-heading">${escapeHtml(title)}</div>${body}</section>`;
}

function detailEmptyMarkup(message: string, hint = ""): string {
  return `<div class="detail-empty"><strong>${escapeHtml(message)}</strong>${hint ? `<span>${escapeHtml(hint)}</span>` : ""}</div>`;
}

function defaultActivityLabel(status: string): string {
  if (status === "working") return "Active";
  if (status === "blocked") return "Waiting for input";
  if (status === "error") return "Needs attention";
  return "Ready";
}

function sourceLabel(source: SessionPayload["source"]): string {
  return source === "codex_jsonl" ? "Codex JSONL" : source || "Unknown source";
}

function lastCompletedActivity(session: SessionPayload): string {
  return (session.activity_tail ?? [])
    .slice()
    .reverse()
    .find(line => /^done:/i.test(line)) || "";
}

function parseActivityLine(line: string): { kind: string; text: string } {
  const match = /^([a-z][\w -]*):\s*(.*)$/i.exec(line.trim());
  if (!match) return { kind: "event", text: line };
  return { kind: match[1]!.replace(/\s+/g, " "), text: match[2] || line };
}

function detailFactMarkup(s: SessionPayload, timestamp: number): string {
  const status = s.status || "idle";
  return `<div class="detail-facts">
    <div class="detail-fact"><span class="detail-fact-label">Type</span><strong class="detail-fact-value">${escapeHtml(s.session_type || "?")}</strong></div>
    <div class="detail-fact"><span class="detail-fact-label">Status</span><strong class="detail-fact-value detail-fact-status">${statusDotMarkup(status)}<span>${escapeHtml(statusLabel(status))}</span></strong></div>
    <div class="detail-fact"><span class="detail-fact-label">Active</span><strong class="detail-fact-value detail-tabular">${escapeHtml(ageLabel(timestamp))}</strong></div>
  </div>`;
}

function detailPressureMarkup(s: SessionPayload): string {
  const metrics: Array<{ label: string; value: string; note?: string; meter?: number }> = [];
  if (s.context_percent !== undefined) metrics.push({ label: "Context", value: `${Math.round(s.context_percent)}%`, meter: s.context_percent });
  if (s.tokens !== undefined) metrics.push({ label: "Tokens", value: formatMetric(s.tokens), note: `in ${formatMetric(s.input_tokens)} · out ${formatMetric(s.output_tokens)}` });
  if (s.turns !== undefined) metrics.push({ label: "Turns", value: formatMetric(s.turns), note: s.token_rate !== undefined ? `${formatMetric(s.token_rate)} / min` : undefined });
  if (s.quota_percent !== undefined) metrics.push({ label: "Quota left", value: `${Math.round(s.quota_percent)}%`, note: s.quota_reset ? `reset ${s.quota_reset}` : undefined, meter: s.quota_percent });
  if (metrics.length === 0) return "";
  return detailSectionMarkup("Pressure", `<div class="detail-metric-grid">${metrics.map(metric =>
    `<div class="detail-metric"><span class="detail-metric-label">${escapeHtml(metric.label)}</span><strong class="detail-metric-value">${escapeHtml(metric.value)}</strong>${metric.note ? `<span class="detail-metric-note">${escapeHtml(metric.note)}</span>` : ""}${metric.meter !== undefined ? `<span class="detail-meter"><span style="width:${Math.min(100, Math.max(0, metric.meter))}%"></span></span>` : ""}</div>`
  ).join("")}</div>`);
}

function detailAttentionMarkup(s: SessionPayload): string {
  const status = s.status || "idle";
  const signal = (s.agent_signals ?? []).find(item => item.error_code || item.kind === "service_health" && item.status && !/ok|healthy/i.test(item.status));
  if (status !== "blocked" && status !== "error" && !signal) return "";
  const text = signal?.error_code ? `${signal.status || "Provider issue"} (${signal.error_code})` : signal?.status || s.task_name || defaultActivityLabel(status);
  return detailSectionMarkup("Attention", `<div class="detail-attention detail-attention-${status === "idle" ? "error" : status}">${statusDotMarkup(status === "idle" ? "error" : status)}<strong>${escapeHtml(statusLabel(status === "idle" ? "error" : status))}</strong><span>${escapeHtml(text)}</span></div>`, "detail-section-attention");
}

function detailIdentityMarkup(s: SessionPayload, project: string): string {
  const projectPath = s.project_path || project;
  const task = s.task_name?.trim();
  return detailSectionMarkup("Session", `<div class="detail-fields">
    <div class="detail-field"><span class="detail-field-label">Created by</span><span class="detail-field-value">${escapeHtml(s.session_kind === "background" ? `${s.session_type?.trim() || "Harness"} (automatic)` : s.session_kind === "user" ? "User" : "Unknown")}</span></div>
    ${s.session_service ? `<div class="detail-field"><span class="detail-field-label">Service</span><span class="detail-field-value">${escapeHtml(sessionServiceLabel(s.session_service) || s.session_service)}</span></div>` : ""}
    <div class="detail-field"><span class="detail-field-label">Project</span><span class="detail-field-value detail-mono" title="${escapeHtml(projectPath)}">${escapeHtml(projectPath)}</span></div>
    ${task ? `<div class="detail-field"><span class="detail-field-label">Task</span><span class="detail-field-value">${escapeHtml(task)}</span></div>` : ""}
    <div class="detail-field detail-field-id"><span class="detail-field-label">Session ID</span><span class="detail-field-value detail-mono" title="${escapeHtml(s.session_id)}">${escapeHtml(s.session_id)}</span></div>
  </div>`);
}

function sessionOriginLabel(s: SessionPayload): string {
  return s.session_kind === "background" ? "Harness-created" : s.session_kind === "user" ? "" : "Unknown origin";
}

function sessionOriginMarkup(s: SessionPayload): string {
  const label = sessionOriginLabel(s);
  const description = s.session_kind === "background"
    ? `Automatically created by ${s.session_type?.trim() || "the harness"}`
    : "User or harness creation has not been confirmed";
  return label ? `<span class="session-origin-badge" data-session-kind="${s.session_kind === "background" ? "background" : "unknown"}" title="${escapeHtml(description)}">${escapeHtml(label)}</span>` : "";
}

function detailOverviewMarkup(s: SessionPayload, project: string, timestamp: number): string {
  const status = s.status || "idle";
  const activity = s.task_name?.trim() || defaultActivityLabel(status);
  const lastDone = lastCompletedActivity(s);
  const source = sourceLabel(s.source);
  const nowBody = `<div class="detail-now-title">${statusDotMarkup(status)}<strong>${escapeHtml(activity)}</strong></div><div class="detail-now-meta"><span>source: ${escapeHtml(source)}</span><span>${lastDone ? `last done: ${escapeHtml(lastDone)}` : "no completed activity yet"}</span></div>${s.progress !== undefined ? `<div class="detail-progress"><span class="detail-field-label">Progress</span><div class="detail-progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(s.progress * 100)}"><span style="width:${Math.round(s.progress * 100)}%"></span></div><span class="detail-progress-value">${Math.round(s.progress * 100)}%</span></div>` : ""}`;
  return `<div class="detail-overview" aria-label="Session overview">${detailFactMarkup(s, timestamp)}${detailSectionMarkup("Now", nowBody, "detail-section-now")}${detailPressureMarkup(s)}${detailIdentityMarkup(s, project)}${detailAttentionMarkup(s)}</div>`;
}

function detailActivityMarkup(s: SessionPayload, timestamp: number): string {
  const plan = (s.plan_signal ?? []).filter(item => item && String(item.text || "").trim()).slice(0, 6);
  const activity = s.task_name?.trim() || defaultActivityLabel(s.status);
  const history = (s.activity_tail ?? []).slice().reverse();
  const planMarkup = plan.length === 0 ? "" : detailSectionMarkup("Plan signal", `<div class="detail-event-list">${plan.map(item =>
    `<div class="detail-event-row"><span class="detail-event-kind">${escapeHtml(item.state || "signal")}</span><span class="detail-event-text">${escapeHtml(item.text)}</span><span class="detail-event-age">${escapeHtml(item.age || "—")}</span></div>`
  ).join("")}</div>`);
  const historyMarkup = history.length === 0 ? detailEmptyMarkup("No recent activity", "The session has not reported activity events yet.") : `<div class="detail-event-list"><div class="detail-event-row detail-event-current"><span class="detail-event-kind">current</span><span class="detail-event-text">${escapeHtml(activity)}</span><span class="detail-event-age">${escapeHtml(ageLabel(timestamp))}</span></div>${history.map(line => {
    const parsed = parseActivityLine(line);
    return `<div class="detail-event-row"><span class="detail-event-kind">${escapeHtml(parsed.kind)}</span><span class="detail-event-text">${escapeHtml(parsed.text)}</span><span class="detail-event-age">—</span></div>`;
  }).join("")}</div>`;
  return `<div class="detail-tab-content">${planMarkup}${detailSectionMarkup("Recent activity", historyMarkup)}</div>`;
}

function detailUsageMarkup(s: SessionPayload): string {
  const metrics: Array<{ label: string; value: string; note?: string }> = [];
  if (s.context_percent !== undefined) metrics.push({ label: "Context", value: `${Math.round(s.context_percent)}%` });
  if (s.tokens !== undefined) metrics.push({ label: "Total tokens", value: formatMetric(s.tokens), note: `input ${formatMetric(s.input_tokens)} · output ${formatMetric(s.output_tokens)}` });
  if (s.turns !== undefined) metrics.push({ label: "Turns", value: formatMetric(s.turns), note: s.token_rate !== undefined ? `${formatMetric(s.token_rate)} tokens/min` : undefined });
  if (s.input_tokens !== undefined) metrics.push({ label: "Input", value: formatMetric(s.input_tokens) });
  if (s.output_tokens !== undefined) metrics.push({ label: "Output", value: formatMetric(s.output_tokens) });
  if (s.cache_read_tokens !== undefined) metrics.push({ label: "Cache read", value: formatMetric(s.cache_read_tokens) });
  if (s.cache_write_tokens !== undefined) metrics.push({ label: "Cache write", value: formatMetric(s.cache_write_tokens) });
  if (s.token_rate !== undefined && s.turns === undefined) metrics.push({ label: "Rate", value: `${formatMetric(s.token_rate)} / min` });
  if (s.quota_percent !== undefined) metrics.push({ label: "Quota left", value: `${Math.round(s.quota_percent)}%`, note: s.quota_reset ? `reset ${s.quota_reset}` : undefined });
  const usageBody = metrics.length === 0 ? detailEmptyMarkup("No usage data", "Usage snapshots have not been reported for this session.") : `<div class="detail-metric-grid detail-usage-grid">${metrics.map(metric => `<div class="detail-metric"><span class="detail-metric-label">${escapeHtml(metric.label)}</span><strong class="detail-metric-value">${escapeHtml(metric.value)}</strong>${metric.note ? `<span class="detail-metric-note">${escapeHtml(metric.note)}</span>` : ""}</div>`).join("")}</div>`;
  const signals = (s.agent_signals ?? []).filter(signal => signal.balance !== undefined || signal.remaining !== undefined || signal.used_percent !== undefined || signal.used !== undefined || signal.limit !== undefined || signal.status !== undefined).slice().reverse().slice(0, 6);
  const signalsBody = signals.length === 0 ? "" : detailSectionMarkup("Provider signals", `<div class="detail-signal-list">${signals.map(signal => {
    const value = signal.remaining ?? signal.balance;
    const valueText = value !== undefined ? `${formatMetric(value)}${signal.unit || signal.balance_unit ? ` ${signal.unit || signal.balance_unit}` : ""}` : signal.status || "—";
    const usage = signal.used_percent !== undefined ? `${Math.round(signal.used_percent)}% used` : signal.used !== undefined && signal.limit !== undefined ? `${formatMetric(signal.used)}/${formatMetric(signal.limit)}` : signal.used !== undefined ? `used ${formatMetric(signal.used)}` : "—";
    return `<div class="detail-signal-row"><span class="detail-signal-source">${escapeHtml(signal.label || signal.source || signal.signal)}</span><strong>${escapeHtml(valueText)}</strong><span>${escapeHtml(usage)}</span><span>${escapeHtml(signal.reset_at ? detailResetLabel(signal.reset_at) : "—")}</span></div>`;
  }).join("")}</div>`);
  return `<div class="detail-tab-content">${detailSectionMarkup("Usage", usageBody)}${signalsBody}</div>`;
}

function detailResetLabel(value: number): string {
  const millis = value < 1_000_000_000_000 ? value * 1000 : value;
  const seconds = Math.max(0, Math.floor((millis - Date.now()) / 1000));
  if (seconds < 60) return `in ${seconds}s`;
  if (seconds < 3600) return `in ${Math.floor(seconds / 60)}m`;
  return `in ${Math.floor(seconds / 3600)}h`;
}

function detailFlowMarkup(s: SessionPayload): string {
  return sessionFlowMarkup(s, lastAgentSnapshot, agentAvatarMarkup, null);
}

function syncExecutionViews(): void {
  const id = executionClient.sessionId;
  if (!id) return;
  const session = lastSessions.find(item => item.session_id === id);
  const graph = session?.flow ? reportedWorkflowGraph(session.flow) : null;
  for (const slot of document.querySelectorAll<HTMLElement>("[data-execution-session]")) {
    if (slot.dataset.executionSession === id) commitMarkup(slot, executionTraceMarkup(executionClient.value, executionClient.error, graph));
  }
}

function detailHTML(s: SessionPayload): string {
  const p = extractProject(s);
  const ts = s.timestamp || Date.now();
  if (detailTab === 1) return detailActivityMarkup(s, ts);
  if (detailTab === 2) return detailUsageMarkup(s);
  if (detailTab === 3) return detailFlowMarkup(s);
  if (detailTab === 4) return `<div class="detail-tab-content"><pre class="detail-raw mono">${escapeHtml(JSON.stringify(s, null, 2))}</pre></div>`;
  return detailOverviewMarkup(s, p, ts);
}

function showMobileDetail(s: SessionPayload) {
  const existing = document.querySelector(".detail-overlay");
  if (existing) existing.remove();
  const ov = document.createElement("div");
  ov.className = "detail-overlay";
  ov.dataset.sessionId = s.session_id;
  ov.innerHTML =
    `<div class="overlay-header"><span>${escapeHtml(s.session_type||"Session")} / ${escapeHtml(extractProject(s))}</span><button class="overlay-close" aria-label="Close details">&times;</button></div>` +
    `<div class="mobile-detail-tabs detail-tabs">${tabsMarkup(["Overview", "Activity", "Usage", "Flow", "Raw"], detailTab)}</div>` +
    `<div class="overlay-body">${detailHTML(s)}</div>`;
  ov.querySelector("button")!.addEventListener("click", (e) => { e.stopPropagation(); ov.remove(); executionClient.watch(null); });
  ov.addEventListener("click", (e) => {
    if (e.target === ov) { ov.remove(); executionClient.watch(null); return; }
    if (handleAgentAction(e)) return;
    const tab = (e.target as Element | null)?.closest<HTMLElement>(".detail-tab");
    if (!tab) return;
    detailTab = Number.parseInt(tab.dataset.tab || "0", 10);
    ov.querySelector(".mobile-detail-tabs")!.innerHTML = tabsMarkup(["Overview", "Activity", "Usage", "Flow", "Raw"], detailTab);
    ov.querySelector(".overlay-body")!.innerHTML = detailHTML(lastSessions.find(item => item.session_id === s.session_id) ?? s);
    executionClient.watch(detailTab === 3 ? s.session_id : null);
    syncExecutionViews();
  });
  document.body.appendChild(ov);
  executionClient.watch(detailTab === 3 ? s.session_id : null);
  syncExecutionViews();
}

function syncAgentDialog(): void {
  const selected = agentClient.selected;
  if (!selected || window.innerWidth >= 1024) {
    if (agentDialog?.open) agentDialog.close();
    return;
  }
  if (!agentDialog) {
    agentDialog = document.createElement("dialog");
    agentDialog.className = "agent-dialog";
    agentDialog.setAttribute("aria-label", "Agent details");
    agentDialog.innerHTML = '<div class="agent-dialog-top"><strong>Agent details</strong><button type="button" class="agent-action" data-agent-close aria-label="Close agent details">Close</button></div><div class="agent-dialog-tabs"></div><div class="agent-dialog-body"></div>';
    agentDialog.addEventListener("click", handleAgentAction);
    agentDialog.addEventListener("cancel", event => { event.preventDefault(); agentClient.clearSelection(); });
    document.body.appendChild(agentDialog);
  }
  commitMarkup(agentDialog.querySelector(".agent-dialog-tabs")!, agentTabsMarkup(agentDetailTab));
  commitMarkup(agentDialog.querySelector(".agent-dialog-body")!, agentDetailMarkup(selected, agentDetailTab));
  if (!agentDialog.open) {
    document.querySelector(".detail-overlay")?.remove();
    agentDialog.showModal();
  }
}

function handleAgentAction(event: Event): boolean {
  const target = event.target as Element | null;
  const avatar = target?.closest<HTMLElement>("[data-agent-id]");
  if (avatar) {
    const session = lastSessions.find(item => item.session_id === avatar.dataset.agentSession);
    if (!session || !avatar.dataset.agentId) return true;
    event.stopPropagation();
    const query = filterInput.value.trim().toLowerCase();
    if (query && ![extractProject(session), sessionDisplayName(session), session.task_name || "", session.session_type || ""].some(value => value.toLowerCase().includes(query))) filterInput.value = "";
    selectedId = session.session_id;
    if (focusedProject) focusedProject = projectKey(session);
    agentDetailTab = "overview";
    agentClient.select(avatar.dataset.agentId);
    return true;
  }
  const expand = target?.closest<HTMLElement>("[data-agent-expand]");
  if (expand?.dataset.agentExpand) {
    const key = expand.dataset.agentExpand;
    if (expandedAgentRosters.has(key)) expandedAgentRosters.delete(key);
    else expandedAgentRosters.add(key);
    render(lastSessions);
    return true;
  }
  const tab = target?.closest<HTMLElement>("[data-agent-tab]")?.dataset.agentTab;
  if (tab === "overview" || tab === "conversation" || tab === "workflow") {
    agentDetailTab = tab;
    render(lastSessions);
    return true;
  }
  const more = target?.closest<HTMLElement>("[data-agent-more]")?.dataset.agentMore;
  if (more === "conversation" || more === "workflow") { void agentClient.loadMore(more); return true; }
  if (target?.closest("[data-agent-refresh]")) { void agentClient.refreshDetail(); return true; }
  if (target?.closest("[data-agent-back]")) {
    const session = lastSessions.find(item => item.session_id === selectedId);
    agentClient.clearSelection();
    if (session && window.innerWidth < 1024) showMobileDetail(session);
    return true;
  }
  if (target?.closest("[data-agent-close]")) { agentClient.clearSelection(); return true; }
  return false;
}

function scheduleAgentRefresh(): void {
  if (agentRefreshTimer !== undefined) window.clearTimeout(agentRefreshTimer);
  agentRefreshTimer = undefined;
  if (document.hidden) return;
  agentRefreshTimer = window.setTimeout(() => {
    agentRefreshTimer = undefined;
    void Promise.allSettled([agentClient.refreshSnapshot(), executionClient.refresh()]).finally(scheduleAgentRefresh);
  }, 5000);
}

// ── Disconnected ──

function showBanner(msg: string) {
  disconnectedBanner.innerHTML = `<strong>Disconnected</strong><span>${escapeHtml(msg)}</span>`;
  disconnectedBanner.hidden = false;
}
function hideBanner() {
  disconnectedBanner.hidden = true;
  disconnectedBanner.replaceChildren();
}

function setSessionConnectionState(state: "connecting" | "online" | "offline") {
  if (sessionConnectionState === state) return;
  sessionConnectionState = state;
  appHeader.setConnectionState(state);
  if (state === "offline") {
    showBanner("Retrying automatically…");
    return;
  }
  if (state === "online") {
    hideBanner();
  }
}

// ── Render ──

function render(sessions: SessionPayload[]) {
  const q = filterInput.value.trim().toLowerCase();

  let shown = sessions;
  if (q) {
    shown = sessions.filter(s =>
      extractProject(s).toLowerCase().includes(q) ||
      sessionDisplayName(s).toLowerCase().includes(q) ||
      (s.task_name||"").toLowerCase().includes(q) ||
      (s.session_type||"").toLowerCase().includes(q));
    filterHint.textContent = shown.length + "/" + sessions.length + " sessions";
  } else { filterHint.textContent = ""; }

  if (focusedProject && !shown.some(s => projectKey(s) === focusedProject)) {
    focusedProject = null;
    selectedId = null;
  }

  // Status summary — intentionally text-only; no proportional progress bar.
  commitMarkup(countsEl, statusSummaryMarkup(countSessions(sessions)));
  renderSceneSummary();

  // Projects
  const groups = new Map<string,SessionPayload[]>();
  for (const s of shown) {
    const p = projectKey(s);
    if (!groups.has(p)) groups.set(p,[]);
    groups.get(p)!.push(s);
  }
  const sorted = [...groups.entries()].sort((a,b)=>
    Number(a[0] === UNASSIGNED_PROJECT_KEY) - Number(b[0] === UNASSIGNED_PROJECT_KEY)
    || Math.max(...b[1].map(s=>s.timestamp||0))-Math.max(...a[1].map(s=>s.timestamp||0)));

  const projectCount = sorted.filter(([key]) => key !== UNASSIGNED_PROJECT_KEY).length;
  commitMarkup(projectsHdr, `<span class="${UI.panelTitle}">Projects (${projectCount})</span>`);
  let pH = "";
  for (const [proj, ss] of sorted) {
    const projectName = proj === UNASSIGNED_PROJECT_KEY ? "Unassigned sessions" : extractProject(ss[0]!);
    const roster = projectAgentRoster(lastAgentSnapshot, ss);
    const rosterKey = `project:${proj}`;
    const ws = ss.filter(s=>s.status==="working").length;
    const bs = ss.filter(s=>s.status==="blocked").length;
    const es = ss.filter(s=>s.status==="error").length;
    const parts: string[] = [];
    if (ws>0) parts.push(ws+" work");
    if (bs>0) parts.push(bs+" wait");
    if (es>0) parts.push(es+" err");
    if (parts.length===0) parts.push("idle");
    const projectMeta = parts.join(" ");
    const maxTs = Math.max(...ss.map(s=>s.timestamp||0));
    const lastActive = age(maxTs || Date.now());
    const lastActiveLabel = lastActive === "now" ? "last active now" : `last active ${lastActive} ago`;
    const sessionTypes = ss.map(s=>s.session_type||"?");
    const iconsExpanded = expandedProjectIcons === proj;
    const icons = projectIconListMarkup(sessionTypes, iconCache);
    // The stack width includes its horizontal padding so each icon keeps its
    // full circular hit area while the group stays anchored to the right.
    const iconStackWidth = 33 + Math.max(0, sessionTypes.length - 1) * 24;
    const projectStatus = ws > 0 ? "working" : bs > 0 ? "blocked" : es > 0 ? "error" : "idle";
    const sel = proj===focusedProject ? UI.rowSelected : "";
    const iconActionLabel = iconsExpanded ? "Collapse agent icons" : "Expand agent icons";

    pH += `<div class="${cx(UI.row, "project-row agent-project-row w-full text-left", sel)}">`
      +`<button type="button" class="project-row-main row-select-button" data-project="${escapeHtml(proj)}" aria-pressed="${proj===focusedProject}">${statusDotMarkup(projectStatus)}<span class="project-row-name" title="${escapeHtml(ss[0]?.project_path || projectName)}">${escapeHtml(projectName)}</span></button>`
      +(roster ? `<div class="project-agent-slot">${agentRosterMarkup(roster, rosterKey, agentClient.selected?.agent.agent_id ?? null, expandedAgentRosters.has(rosterKey))}</div>` : `<span class="${UI.projectIconSlot}"><span class="${UI.projectIconStack}${iconsExpanded ? " is-expanded" : ""}${sessionTypes.length === 1 ? " is-single" : ""}" style="width:${iconStackWidth}px" data-project-icons="${escapeHtml(proj)}" role="button" tabindex="0" aria-expanded="${iconsExpanded}" aria-label="${iconActionLabel}" title="${iconActionLabel}">${icons}</span></span>`)
      +`<span class="project-row-meta" aria-label="${escapeHtml(`${projectMeta}, ${lastActiveLabel}`)}"><span class="project-row-status">${escapeHtml(projectMeta)}</span><span class="project-row-age">${escapeHtml(lastActive)}</span></span>`
      +"</div>";
  }
  commitMarkup(projectsBody, pH || `<div class="panel-empty"><strong>No projects</strong><span>Projects appear when a session reports its workspace.</span></div>`);

  // Sessions
  const scope = focusedProject ? shown.filter(s=>projectKey(s)===focusedProject) : shown;
  if (selectedId && !scope.find(s=>s.session_id===selectedId)) selectedId = null;
  if (agentClient.selected && agentClient.selected.agent.identity.session_id !== selectedId) agentClient.clearSelection(false);
  const sSorted = [...scope].sort((a,b)=>(b.timestamp||0)-(a.timestamp||0));
  syncSessionWorkspace();
  commitMarkup(sessionsHdr, `<span class="${UI.panelTitle}">${focusedProject ? `Sessions / ${escapeHtml(focusedProjectName())}` : `All Sessions (${sSorted.length})`}</span>`);
  let sH = "";
  for (const s of sSorted) {
    const st = s.status||"idle";
    const sel = s.session_id===selectedId ? UI.rowSelected : "";
    const blk = st==="blocked" ? UI.rowBlocked : "";
    const columns = sessionListColumns(s);
    const roster = sessionAgentRoster(lastAgentSnapshot, s.session_id);
    const rosterKey = `session:${s.session_id}`;
    sH += `<div class="${cx("session-entry", sel, blk)}"><button type="button" class="${cx(UI.row, "session-row w-full text-left", sel, blk)}" aria-pressed="${s.session_id === selectedId}" data-sid="${escapeHtml(s.session_id)}">`
      +`<span class="session-row-icon">${icon(s.session_type||"?")}</span>`
      +statusDotMarkup(st)
      +`<span class="session-row-name"><span>${escapeHtml(columns.name)}</span>${sessionOriginMarkup(s)}</span>`
      +`<span class="session-row-project" title="${escapeHtml(columns.project)}">${escapeHtml(projectKey(s) === UNASSIGNED_PROJECT_KEY ? "Unassigned" : columns.project)}</span>`
      +`<span class="session-row-status">${statusLabel(st)}</span>`
      +`<span class="session-row-age">${age(s.timestamp||Date.now())}</span>`
      +"</button>"
      +(roster ? `<div class="session-agent-slot">${agentRosterMarkup(roster, rosterKey, agentClient.selected?.agent.agent_id ?? null, expandedAgentRosters.has(rosterKey))}</div>` : "")
      +"</div>";
  }
  const emptySessionsTitle = q ? "No matching sessions" : "No sessions";
  const emptySessionsHint = q ? "Try another project, task, or type." : "Sessions appear when an agent reports activity.";
  commitMarkup(sessionsBody, sH || `<div class="panel-empty"><strong>${emptySessionsTitle}</strong><span>${emptySessionsHint}</span></div>`);

  // Detail — desktop
  const sel = selectedId ? sSorted.find(s=>s.session_id===selectedId) : null;
  if (sel && agentClient.selected) {
    commitMarkup(detailHdr, `<span class="${UI.panelTitle}">Details / Agent</span>${agentTabsMarkup(agentDetailTab)}`);
    commitMarkup(detailBody, agentDetailMarkup(agentClient.selected, agentDetailTab));
  } else if (sel) {
    const tabs = ["Overview","Activity","Usage","Flow","Raw"];
    commitMarkup(detailHdr,
      `<span class="${UI.panelTitle}">Details / ${escapeHtml(sel.session_type||"Session")}</span>` +
      `<span class="detail-tabs">${tabsMarkup(tabs, detailTab)}</span>`);
    commitMarkup(detailBody, detailHTML(sel));
  } else if (focusedProject) {
    commitMarkup(detailHdr, `<span class="${UI.panelTitle}">Details / Project</span>`);
    const agents = [...new Set(scope.map(s=>s.session_type||"?"))].join(", ");
    commitMarkup(detailBody, detailListMarkup([
      { label: "Project", value: focusedProjectName() },
      { label: "Sessions", value: String(scope.length) },
      { label: "Agents", value: agents },
      { label: "Path", value: scope[0]?.project_path || "" },
    ]));
  } else {
    systemMonitor.render();
  }

  syncAgentDialog();
  syncSessionWorkspace();
  const mobileDetail = document.querySelector<HTMLElement>(".detail-overlay");
  executionClient.watch(sel && !agentClient.selected && detailTab === 3 && (window.innerWidth >= 1024 || mobileDetail?.dataset.sessionId === sel.session_id) ? sel.session_id : null);
  syncExecutionViews();

  // Footer
  if (q) footerEl.textContent = `${shown.length}/${sessions.length} sessions  Esc to clear`;
  else if (focusedProject) footerEl.textContent = "Click project again to show all";
  else footerEl.textContent = "Click a project to filter · Click a session for details";
  if (sceneExpandedHeight === 0) scheduleSceneMeasure();
}

// ── SSE ──

function connect() {
  const es = new EventSource("/sessions/stream");
  es.onmessage = e => {
    try {
      const sessions = JSON.parse(e.data) as SessionPayload[];
      lastSessions = sessions;
      setSessionConnectionState("online");
      render(lastSessions);
    } catch { /* */ }
  };
  es.onerror = () => {
    setSessionConnectionState("offline");
  };
  window.addEventListener("beforeunload", () => es.close());
}

filterInput.addEventListener("input", () => { if (lastSessions.length) render(lastSessions); });
filterInput.addEventListener("keydown", e => { if (e.key==="Escape") { filterInput.value=""; focusedProject=null; if (lastSessions.length) render(lastSessions); } });
projectsBody.addEventListener("click", event => {
  if (handleAgentAction(event)) return;
  const target = event.target as Element | null;
  const stack = target?.closest<HTMLElement>("[data-project-icons]");
  if (stack) {
    event.stopPropagation();
    const project = stack.dataset.projectIcons!;
    expandedProjectIcons = expandedProjectIcons === project ? null : project;
    render(lastSessions);
    return;
  }
  const row = target?.closest<HTMLElement>("[data-project]");
  if (!row) return;
  focusedProject = row.dataset.project === focusedProject ? null : row.dataset.project!;
  selectedId = null;
  agentClient.clearSelection(false);
  expandedProjectIcons = null;
  render(lastSessions);
});
projectsBody.addEventListener("keydown", event => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const stack = (event.target as Element | null)?.closest<HTMLElement>("[data-project-icons]");
  if (!stack) return;
  event.preventDefault();
  expandedProjectIcons = expandedProjectIcons === stack.dataset.projectIcons ? null : stack.dataset.projectIcons!;
  render(lastSessions);
});
sessionsBody.addEventListener("click", event => {
  if (handleAgentAction(event)) return;
  const row = (event.target as Element | null)?.closest<HTMLElement>("[data-sid]");
  if (!row) return;
  const sid = row.dataset.sid || null;
  agentClient.clearSelection(false);
  selectedId = sid;
  if (window.innerWidth < 1024) {
    const session = lastSessions.find(item => item.session_id === sid);
    if (session) showMobileDetail(session);
    return;
  }
  selectedId = sid;
  render(lastSessions);
});
detailBody.addEventListener("click", handleAgentAction);
detailHdr.addEventListener("click", event => {
  if (handleAgentAction(event)) return;
  const tab = (event.target as Element | null)?.closest<HTMLElement>(".detail-tab");
  if (!tab) return;
  detailTab = Number.parseInt(tab.dataset.tab || "0", 10);
  render(lastSessions);
});
document.addEventListener("click", event => {
  if (!expandedProjectIcons) return;
  const target = event.target as Element | null;
  if (target?.closest("[data-project-icons]")) return;
  const expandedStack = [...projectsBody.querySelectorAll<HTMLElement>("[data-project-icons]")]
    .find(item => item.dataset.projectIcons === expandedProjectIcons);
  expandedProjectIcons = null;
  if (expandedStack) setProjectIconStackExpanded(expandedStack, false);
});

window.addEventListener("scroll", handleSceneScroll, { passive: true });
window.addEventListener("resize", () => {
  syncSessionWorkspace();
  syncAgentDialog();
  scheduleSceneMeasure();
});
reducedMotion.addEventListener("change", scheduleSceneMeasure);
providerGalleryMedia.addEventListener("change", mountProviderGallery);
for (const button of providerUsageModeButtons) {
  button.addEventListener("click", () => {
    const mode = button.dataset.providerUsageMode;
    if (mode === "token" || mode === "cash" || mode === "percentage") setProviderUsageMode(mode);
  });
}
renderSceneSummary();
renderProviders();
void fetchProviders();
void systemMonitor.refresh();
function scheduleProviderRefresh() {
  if (providerRefreshTimer !== undefined) window.clearTimeout(providerRefreshTimer);
  providerRefreshTimer = window.setTimeout(() => {
    providerRefreshTimer = undefined;
    void fetchProviders();
    scheduleProviderRefresh();
  }, document.hidden ? 300_000 : 60_000);
}

function scheduleSystemRefresh() {
  if (systemRefreshTimer !== undefined) window.clearTimeout(systemRefreshTimer);
  systemRefreshTimer = window.setTimeout(() => {
    systemRefreshTimer = undefined;
    void systemMonitor.refresh();
    scheduleSystemRefresh();
  }, document.hidden ? 15_000 : 2_000);
}

function scheduleSessionAgeRefresh() {
  if (sessionAgeTimer !== undefined) window.clearTimeout(sessionAgeTimer);
  sessionAgeTimer = window.setTimeout(() => {
    sessionAgeTimer = undefined;
    if (lastSessions.length) render(lastSessions);
    scheduleSessionAgeRefresh();
  }, document.hidden ? 15_000 : 1_000);
}

document.addEventListener("visibilitychange", () => {
  scheduleProviderRefresh();
  scheduleSystemRefresh();
  scheduleSessionAgeRefresh();
  scheduleAgentRefresh();
  if (!document.hidden) {
    void agentClient.refreshSnapshot();
    void systemMonitor.refresh();
    void fetchProviders();
  }
});
scheduleProviderRefresh();
scheduleSystemRefresh();
scheduleSessionAgeRefresh();
scheduleAgentRefresh();
if (!document.hidden) void agentClient.refreshSnapshot();
window.addEventListener("beforeunload", () => {
  agentClient.stop();
  executionClient.stop();
  stopAgentAvatarFallbacks();
  if (agentRefreshTimer !== undefined) window.clearTimeout(agentRefreshTimer);
  if (providerRefreshTimer !== undefined) window.clearTimeout(providerRefreshTimer);
  if (providersRetryTimer !== undefined) window.clearTimeout(providersRetryTimer);
  if (systemRefreshTimer !== undefined) window.clearTimeout(systemRefreshTimer);
  if (sessionAgeTimer !== undefined) window.clearTimeout(sessionAgeTimer);
  systemMonitor.stop();
});

connect();
