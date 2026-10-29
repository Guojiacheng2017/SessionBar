import express from "express";
import { unlinkSync, existsSync, readdirSync, readFileSync, statSync, openSync, readSync, closeSync, Dirent } from "fs";
import { join, dirname, basename, resolve } from "path";
import { homedir } from "os";
import { createHash } from "crypto";
import { fileURLToPath } from "url";
import { SessionPayload } from "../shared/types.js";
import { mergeSessionPayload, validateSessionPayload } from "../sessions/sessionPayload.js";
import { syncToICloud } from "./icloud.js";
import { removeSessionMarkerFiles, scopedSessionId } from "../sessions/sessionMarkers.js";
import { mergeCodexDiscovery, mergeCodexHookSession, mergeCodexThreadMetadata } from "../sessions/codexSessionMerge.js";
import { recoverSessionProjects } from "../sessions/recoveredSessionProjects.js";
import { codexSessionNativeId, visibleCodexSessions } from "../sessions/codexRecoveredSessions.js";
import { createCodexServiceOrigins } from "../sessions/codexServiceOrigins.js";
import { codexBackgroundService, codexHasSubagentSource, codexNativeSource } from "../shared/codexServices.js";
import { codexThreadMetadata, readCodexThreads, recentCodexThreadPaths, type CodexThreadMetadata } from "../sessions/codexAppServer.js";
import { pollProvider, providerConfigsFromEnv } from "../providers/providerAdapters.js";
import { readCCSwitchDeepSeekConfig, readCCSwitchKimiConfig } from "../providers/ccSwitchAdapter.js";
import { decorateApiUsageFromCCSwitch, readCCSwitchUsage, type CcSwitchUsage } from "../providers/ccSwitchUsage.js";
import { applyProviderPollResults } from "../providers/providerMonitor.js";
import { agentSignalToApiRow, computeAdvisorRows } from "../providers/quotaAdvisor.js";
import { computePlanRows } from "../providers/planAdvisor.js";
import type { PlanRow } from "../providers/planTypes.js";
import {
  decorateProviderUsage,
  loadProviderUsageHistory,
  recordProviderUsage,
  saveProviderUsageHistory,
} from "../providers/providerUsageHistory.js";
import { createSystemSampler } from "../system/systemSampler.js";
import { createTemperatureCollector } from "../system/temperatureCollector.js";
import { acquireInstanceLock, appClientCount, configuredPort, releaseRuntimeState, writeRuntimeState } from "./runtimeState.js";
import { disableAutoConsumeResetCards, readSettings } from "./settings.js";
import { decorateProviderUsageFromSessions, loadSessionUsageState, syncSessionUsage } from "../sessions/sessionUsageImporter.js";
import { discoverClaudeDesktopSessions } from "../sessions/claudeDesktopDiscovery.js";
import { discoverWorkBuddyDesktopSessions } from "../sessions/workbuddyDesktopDiscovery.js";
import { discoverKimiCodeSessions } from "../sessions/kimiCodeDiscovery.js";
import { deepSeekHarnessCheckpointRoot, discoverDeepSeekHarnessSessions } from "../sessions/deepseekHarnessDiscovery.js";
import { FileSourceRuntime, pathInsideRoot as pathInsideRuntimeRoot, stableFingerprint, type FileSourceAdapter, type SourceRead } from "../runtime/sourceRuntime.js";
import { ensurePrivateDirectory } from "../shared/privateState.js";
import { loadProviderLastGood, retainProviderLastGood, saveProviderLastGood } from "../providers/providerLastGood.js";
import { isLoopbackHost, localRequestBoundary } from "./localRequestBoundary.js";
import { closeProviderNetwork, providerNetworkStatus, refreshProviderNetwork } from "../runtime/networkRuntime.js";
import { recordRelayConfig } from "../runtime/relayConfig.js";
import { createSingleFlightTask } from "../runtime/singleFlightTask.js";
import { AgentService } from "../agents/agentService.js";
import { createCodexAgentCollector } from "../agents/codexAgents.js";
import { createCodexAvatarSource } from "../agents/codexNativeAvatars.js";
import { createCompositeAgentCollector } from "../agents/agentCollector.js";
import { createClaudeAgentCollector } from "../agents/claudeAgents.js";
import { createDeepSeekAgentCollector } from "../agents/deepseekAgents.js";
import { createAgentRouter } from "./agentRoutes.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Start the HTTP server + polling loops only when run directly
// (`node dist/server/server.js`, how cli.ts spawns it) — not when the module is
// imported by tests. Otherwise app.listen would bind the port and the timers
// would hold the test process's event loop open.
const isDirectRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const REQUESTED_PORT = configuredPort() ?? 0;
const HOST = process.env.SESSIONBAR_HOST || "127.0.0.1";
if (isDirectRun && !isLoopbackHost(HOST)) throw new Error("This release supports loopback HTTP only; LAN access is not released.");
const BUILD_ID = (() => {
  const stat = statSync(fileURLToPath(import.meta.url));
  return `${stat.size}:${Math.trunc(stat.mtimeMs)}`;
})();

const app = express();
app.disable("x-powered-by");
app.use(localRequestBoundary);
app.use(express.json());

// The dashboard shares the relay lifecycle. Keeping these routes registered
// avoids restarting a dynamically-bound server just to open the Web UI.
const projectRoot = join(__dirname, "..", "..");
const publicRoot = join(projectRoot, "public");
app.use(express.static(publicRoot));
app.use("/dist", express.static(join(projectRoot, "dist")));
app.get("/", (_req, res) => {
  res.sendFile("index.html", { root: publicRoot });
});

const HOME = process.env.SESSIONBAR_HOME || process.env.AGENTBAR_HOME || join(homedir(), ".sessionbar");
const SESSION_ID_DIR = join(HOME, "sessions");
const PROVIDER_USAGE_HISTORY_PATH = join(HOME, "provider-usage-history.json");
const PROVIDER_LAST_GOOD_PATH = join(HOME, "provider-last-good.json");
const PROVIDER_LAST_GOOD_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const CODEX_HOME = process.env.CODEX_HOME || join(homedir(), ".codex");
const CODEX_SESSION_DIR = join(CODEX_HOME, "sessions");
const CLAUDE_SESSION_DIR = join(homedir(), ".claude", "projects");
const SESSION_USAGE_STATE_PATH = join(HOME, "session-usage-history.json");
const WORKBUDDY_ROOT = process.env.WORKBUDDY_HOME || join(homedir(), ".workbuddy");
const KIMI_CODE_ROOT = process.env.KIMI_CODE_HOME || join(homedir(), ".kimi-code");
const DSH_ROOT = process.env.SESSIONBAR_DSH_HOME || join(homedir(), ".dsh");
let fileSourceRuntime: FileSourceRuntime | undefined;
export const SESSION_RETENTION_MS = 30 * 60 * 1000;
function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 2_147_483_647 ? parsed : fallback;
}
const UNOBSERVED_SHUTDOWN_MS = parsePositiveInteger(process.env.SESSIONBAR_IDLE_SHUTDOWN_MS, 5 * 60 * 1000);
const CODEX_DISCOVERY_WINDOW_MS = parseInt(process.env.SESSIONBAR_CODEX_DISCOVERY_MS || String(24 * 60 * 60 * 1000), 10);
const CODEX_ACTIVE_MS = parseInt(process.env.SESSIONBAR_CODEX_ACTIVE_MS || String(10 * 60 * 1000), 10);
const CLAUDE_DESKTOP_ROOT = process.env.SESSIONBAR_CLAUDE_DESKTOP_ROOT
  ? process.env.SESSIONBAR_CLAUDE_DESKTOP_ROOT
  : [join(homedir(), "Library", "Application Support", "Claude-3p", "local-agent-mode-sessions"), join(homedir(), "Library", "Application Support", "Claude-3p", "claude-code-sessions")];
const CLAUDE_DESKTOP_DISCOVERY_WINDOW_MS = parseInt(process.env.SESSIONBAR_CLAUDE_DESKTOP_DISCOVERY_MS || String(SESSION_RETENTION_MS), 10);
const CLAUDE_DESKTOP_ACTIVE_MS = parseInt(process.env.SESSIONBAR_CLAUDE_DESKTOP_ACTIVE_MS || String(10 * 60 * 1000), 10);
const CODEX_APP_SERVER_ENABLED = process.env.SESSIONBAR_CODEX_APP_SERVER !== "0";
const CODEX_METADATA_REFRESH_MS = Math.max(5_000, parseInt(process.env.SESSIONBAR_CODEX_METADATA_REFRESH_MS || "15000", 10));
const ACTIVITY_TAIL_BYTES = parseInt(process.env.SESSIONBAR_ACTIVITY_TAIL_BYTES || String(192 * 1024), 10);
const PROVIDER_POLL_ENABLED = process.env.SESSIONBAR_PROVIDER_POLL !== "0";
const PROVIDER_POLL_MS = Math.max(30_000, parseInt(process.env.SESSIONBAR_PROVIDER_POLL_MS || String(5 * 60 * 1000), 10));
const AUTO_CONSUME_PROVIDER_POLL_MS = 30_000;
const CCSWITCH_ENABLED = process.env.SESSIONBAR_CCSWITCH !== "0";
const envProviderConfigs = PROVIDER_POLL_ENABLED ? providerConfigsFromEnv(process.env) : [];
const DEFAULT_SYSTEM_SAMPLE_MS = 2000;
const MIN_SYSTEM_SAMPLE_MS = 100;
const MAX_SYSTEM_SAMPLE_MS = 2_147_483_647;
const SYSTEM_SAMPLE_MS = parseSystemSampleMs(process.env.SESSIONBAR_SYSTEM_SAMPLE_MS);
const BACKGROUND_SYSTEM_SAMPLE_MS = Math.max(SYSTEM_SAMPLE_MS, 15_000);
const SYSTEM_CLIENT_ACTIVE_MS = 10_000;
const systemSampler = createSystemSampler({ temperatureCollector: createTemperatureCollector() });
let providerPollInterval: NodeJS.Timeout | undefined;
let providerPollingActive = false;
let systemSampleTimer: NodeJS.Timeout | undefined;
let nextSystemSampleAt = 0;
let lastSystemClientAt = 0;
let instanceLock: number | undefined;
let configRevision: string | undefined;
let stopping = false;
const providerRefresh = createSingleFlightTask(collectProviderSignals);

export function parseSystemSampleMs(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= MIN_SYSTEM_SAMPLE_MS && parsed <= MAX_SYSTEM_SAMPLE_MS
    ? parsed
    : DEFAULT_SYSTEM_SAMPLE_MS;
}

export function systemSampleDelay(lastClientAt: number, now: number, foregroundMs: number, backgroundMs: number): number {
  return lastClientAt > 0 && now - lastClientAt <= SYSTEM_CLIENT_ACTIVE_MS
    ? foregroundMs
    : Math.max(foregroundMs, backgroundMs);
}

ensurePrivateDirectory(HOME);
ensurePrivateDirectory(SESSION_ID_DIR);

async function cleanup() {
  stopping = true;
  const draining = providerRefresh.close();
  clearInterval(heartbeatInterval);
  clearInterval(purgeInterval);
  providerPollingActive = false;
  if (providerPollInterval) clearTimeout(providerPollInterval);
  if (systemSampleTimer) clearTimeout(systemSampleTimer);
  if (unobservedShutdownTimer) clearTimeout(unobservedShutdownTimer);
  fileSourceRuntime?.close();
  systemSampler.stop();
  for (const client of sseClients) client.end();
  sseClients.clear();
  httpServer?.close();
  httpServer?.closeAllConnections();
  await closeProviderNetwork();
  let drainTimer: NodeJS.Timeout | undefined;
  await Promise.race([draining, new Promise<void>(resolve => { drainTimer = setTimeout(resolve, 3000); })]);
  if (drainTimer) clearTimeout(drainTimer);
  if (instanceLock !== undefined) {
    releaseRuntimeState(HOME, instanceLock);
    instanceLock = undefined;
  }
}

const sessions: Record<string, SessionPayload> = {};
const recoveredSessionMarkers = new Map<string, string[]>();
const pendingCodexRecovery = new Set<string>();
const knownCodexSubagents = new Set<string>();
const codexServiceOrigins = createCodexServiceOrigins({
  cachePath: join(HOME, "codex-service-origins.json"),
  predictionCachePath: join(HOME, "codex-prediction-origins.json"),
});
const sseClients = new Set<express.Response>();
let unobservedShutdownTimer: NodeJS.Timeout | undefined;

function scheduleShutdownIfUnobserved(): void {
  if (stopping) return;
  if (unobservedShutdownTimer) clearTimeout(unobservedShutdownTimer);
  unobservedShutdownTimer = setTimeout(() => {
    unobservedShutdownTimer = undefined;
    if (sseClients.size !== 0 || appClientCount(HOME) !== 0) return;
    console.log("[shutdown] reconnect grace expired with no clients");
    process.kill(process.pid, "SIGTERM");
  }, UNOBSERVED_SHUTDOWN_MS);
  unobservedShutdownTimer.unref();
}

export async function consumeSystemSample(
  sample: () => Promise<unknown>,
  log: (message: string, error: unknown) => void = (message, error) => console.error(message, error),
): Promise<void> {
  try {
    await sample();
  } catch (error) {
    log("[system] system sample failed", error);
  }
}

async function sampleSystem(): Promise<void> {
  await consumeSystemSample(() => systemSampler.sample());
}

function startSystemSampling(): void {
  void sampleSystem().finally(() => scheduleSystemSample());
}

function scheduleSystemSample(delayMs = systemSampleDelay(
  lastSystemClientAt,
  Date.now(),
  SYSTEM_SAMPLE_MS,
  BACKGROUND_SYSTEM_SAMPLE_MS,
)): void {
  if (stopping) return;
  if (systemSampleTimer) clearTimeout(systemSampleTimer);
  nextSystemSampleAt = Date.now() + delayMs;
  systemSampleTimer = setTimeout(async () => {
    nextSystemSampleAt = 0;
    await sampleSystem();
    scheduleSystemSample();
  }, delayMs);
}

// Global subscription plan rows, refreshed on every provider poll cycle.
// null means the first poll cycle hasn't completed yet — endpoints return
// an initializing indicator so the TUI can show "Initializing..." instead
// of "No quota data".
let providerLastGood = loadProviderLastGood(PROVIDER_LAST_GOOD_PATH, Date.now(), PROVIDER_LAST_GOOD_MAX_AGE_MS);
let subscriptionRows: PlanRow[] | null = providerLastGood.rows.length > 0 || !PROVIDER_POLL_ENABLED
  ? providerLastGood.rows.filter(row => row.form === "subscription") : null;
export function getSubscriptionRows(): PlanRow[] | null { return subscriptionRows; }

function providerRowKey(row: PlanRow): string {
  return `${row.provider}:${row.form}:${row.label}`;
}

export function retainRecentProviderRows(
  previousRows: readonly PlanRow[],
  freshRows: readonly PlanRow[],
  seenAt: Map<string, number>,
  now: number,
  maxAgeMs: number,
): PlanRow[] {
  const freshKeys = new Set<string>();
  for (const row of freshRows) {
    const key = providerRowKey(row);
    freshKeys.add(key);
    seenAt.set(key, now);
  }

  const retained = previousRows.filter(row => {
    const key = providerRowKey(row);
    if (freshKeys.has(key)) return false;
    const lastSeen = seenAt.get(key);
    if (lastSeen !== undefined && now - lastSeen <= maxAgeMs) return true;
    seenAt.delete(key);
    return false;
  });
  return [...freshRows, ...retained];
}

// Account-level API rows come directly from provider polling. They are kept
// separate from sessions so a provider balance does not need a matching
// session_type, and is not duplicated onto every session.
let providerApiRows: PlanRow[] = [];
let providerUsageHistory = loadProviderUsageHistory(PROVIDER_USAGE_HISTORY_PATH);
let sessionUsageState = loadSessionUsageState(SESSION_USAGE_STATE_PATH);
let ccSwitchUsage: CcSwitchUsage = {};
let sessionProviderRevision = 0;
let providerRevision = 0;
let providerHistoryRevision = 0;

/**
 * Merge global subscription rows, account-level provider API rows, and every
 * session's display-only "api" rows (advisorRows entries where form === "api").
 * Rows are deduped by
 * `${provider}:${form}:${label}` — keep the first occurrence — so the same
 * provider/form/label reported by multiple sessions collapses to one row, while
 * distinct subscription rows (e.g. Anthropic 5h vs weekly, different labels)
 * and subscription vs api forms of the same provider are all preserved.
 */
export function aggregateProviders(
  subscriptionRows: PlanRow[],
  sessions: Record<string, SessionPayload>,
  globalApiRows: PlanRow[] = [],
): PlanRow[] {
  const sessionApiRows = Object.values(sessions)
    .flatMap(s => s.advisorRows?.filter(r => r.form === "api") ?? []);
  const seen = new Map<string, PlanRow>();
  for (const row of [...subscriptionRows, ...globalApiRows, ...sessionApiRows]) {
    const key = `${row.provider}:${row.form}:${row.label}`;
    if (!seen.has(key)) seen.set(key, row);
  }
  return [...seen.values()];
}

/**
 * Whether a global subscription row belongs on a given session's advisor tab.
 * Maps subscription provider → session_type: codex/openai/chatgpt sessions get
 * the OpenAI subscription row, claude/anthropic sessions get the Anthropic one,
 * kimi/moonshot sessions get the Kimi one. Rows whose provider has no matching
 * session still show on the overview page (aggregateProviders reads subscription
 * rows globally, unaffected by this filter).
 */
export function matchesSessionProvider(row: PlanRow, session: SessionPayload): boolean {
  const type = (session.session_type || "").toLowerCase();
  const provider = (session.model_provider || "").toLowerCase();
  switch (row.provider.toLowerCase()) {
    case "openai":
      return /codex|openai|chatgpt/.test(type);
    case "anthropic":
      return /claude|anthropic/.test(type);
    case "kimi":
      return /kimi|moonshot/.test(type) || provider === "kimi";
    case "cursor":
      return /cursor/.test(type) || provider === "cursor";
    case "grok":
      return /grok/.test(type) || provider === "grok";
    case "three-in-one":
    case "threeinone":
    case "x-subscription":
      return /cursor|grok/.test(type) || provider === "cursor" || provider === "grok";
    default:
      return false;
  }
}

/**
 * Compose a session's advisor tab rows: its display-only api rows (derived from
 * agent signals) plus the global subscription rows that match the session's
 * provider. Embedding subscription rows in the session payload lets the session
 * detail advisor tab render them without the TUI needing global state.
 */
export function sessionAdvisorRows(
  session: SessionPayload,
  apiRows: PlanRow[],
  subscriptionRows: PlanRow[],
): PlanRow[] {
  return [...apiRows, ...subscriptionRows.filter(row => matchesSessionProvider(row, session))];
}

function refreshProviderSignals(): Promise<void> {
  return providerRefresh.run();
}

async function collectProviderSignals() {
  if (!PROVIDER_POLL_ENABLED || stopping) return;
  await refreshProviderNetwork();
  if (stopping) return;
  const now = Date.now();
  const sessionBefore = stableFingerprint(Object.values(sessions).map(session => ({
    id: session.session_id,
    signals: session.agent_signals,
    advisorRows: session.advisorRows,
  })));
  const providerBefore = stableFingerprint({ subscriptionRows, providerApiRows, ccSwitchUsage, sessionUsageState });
  const historyBefore = stableFingerprint(providerUsageHistory);
  const providerConfigs = await activeProviderConfigs();
  if (stopping) return;
  if (providerConfigs.length > 0) {
    const results = await Promise.all(providerConfigs.map(config => pollProvider(config)));
    if (stopping) return;
    providerApiRows = results
      .flatMap(result => result.signals.map(agentSignalToApiRow))
      .filter((row): row is PlanRow => row !== undefined);
    applyProviderPollResults(sessions, results);
  } else {
    providerApiRows = [];
  }
  // Refresh global subscription rows every poll — adapters read their own
  // credential files, so rows appear regardless of providerConfigs.
  const settings = readSettings(HOME);
  const freshSubscriptionRows = await computePlanRows({
    now,
    autoConsumeResetCards: settings.autoConsumeResetCards,
    consumptionStatePath: join(HOME, "reset-card-consumption.json"),
    onResetCardConsume: async result => {
      if (result.outcome !== "reset" && result.outcome !== "alreadyRedeemed") return;
      if (!readSettings(HOME).autoConsumeResetCards) return;
      disableAutoConsumeResetCards(HOME);
      console.log(`[provider] reset card ${result.outcome}; auto-consume disabled`);
    },
  });
  if (stopping) return;
  for (const session of Object.values(sessions)) session.advisorRows = computeAdvisorRows(session);
  const aggregatedRows = aggregateProviders(freshSubscriptionRows, sessions, providerApiRows);
  providerLastGood = retainProviderLastGood(providerLastGood, aggregatedRows, Date.now(), PROVIDER_LAST_GOOD_MAX_AGE_MS);
  saveProviderLastGood(PROVIDER_LAST_GOOD_PATH, providerLastGood);
  subscriptionRows = providerLastGood.rows.filter(row => row.form === "subscription");
  // Advisor is computed regardless of providerConfigs — subscription adapters
  // (wham/anthropic/kimi) read their own credential files, so a user with only
  // ~/.codex/auth.json still gets subscription rows even when no provider API
  // keys are configured.
  for (const session of Object.values(sessions)) {
    session.advisorRows = sessionAdvisorRows(session, session.advisorRows ?? [], subscriptionRows ?? []);
  }
  const nextProviderUsageHistory = recordProviderUsage(
    providerUsageHistory,
    aggregatedRows,
    now,
  );
  const historyChanged = stableFingerprint(nextProviderUsageHistory) !== historyBefore;
  providerUsageHistory = nextProviderUsageHistory;
  if (historyChanged) {
    providerHistoryRevision += 1;
    saveProviderUsageHistory(PROVIDER_USAGE_HISTORY_PATH, providerUsageHistory);
  }
  sessionUsageState = syncSessionUsage({
    statePath: SESSION_USAGE_STATE_PATH,
    codexDir: CODEX_SESSION_DIR,
    claudeDir: CLAUDE_SESSION_DIR,
    now,
  });
  if (CCSWITCH_ENABLED) {
    const usage = await readCCSwitchUsage();
    if (usage !== null) ccSwitchUsage = usage;
  }
  const sessionChanged = stableFingerprint(Object.values(sessions).map(session => ({
    id: session.session_id,
    signals: session.agent_signals,
    advisorRows: session.advisorRows,
  }))) !== sessionBefore;
  const providerChanged = stableFingerprint({ subscriptionRows, providerApiRows, ccSwitchUsage, sessionUsageState }) !== providerBefore;
  if (sessionChanged) sessionProviderRevision += 1;
  if (providerChanged) providerRevision += 1;
  if (!sessionChanged) return;
  broadcastSSE();
  if (process.env.SESSIONBAR_ICLOUD) syncToICloud(sorted());
}

async function activeProviderConfigs() {
  if (!PROVIDER_POLL_ENABLED) return [];
  const configs = [...envProviderConfigs];
  if (CCSWITCH_ENABLED && !configs.some(config => config.provider === "deepseek")) {
    const ccSwitchConfig = await readCCSwitchDeepSeekConfig();
    if (ccSwitchConfig) configs.push(ccSwitchConfig);
  }
  if (CCSWITCH_ENABLED && !configs.some(config => config.provider === "kimi")) {
    const ccSwitchConfig = await readCCSwitchKimiConfig();
    if (ccSwitchConfig) configs.push(ccSwitchConfig);
  }
  return configs;
}

function startProviderPolling() {
  if (!PROVIDER_POLL_ENABLED) return;
  // Start unconditionally — refreshProviderSignals resolves optional provider
  // sources internally, so the advisor still ticks (card expiry / reset
  // countdowns) even when no provider API keys are configured.
  providerPollingActive = true;
  void runProviderPoll();
}

async function runProviderPoll(): Promise<void> {
  try {
    await refreshProviderSignals();
  } catch (error) {
    console.error("[provider] refresh failed", error);
  } finally {
    if (providerPollingActive) {
      const delay = readSettings(HOME).autoConsumeResetCards
        ? AUTO_CONSUME_PROVIDER_POLL_MS
        : PROVIDER_POLL_MS;
      providerPollInterval = setTimeout(() => void runProviderPoll(), delay);
    }
  }
}

function sorted(): SessionPayload[] {
  refreshCodexMetadataIfDue();
  mergeCodexThreadMetadata(sessions, codexMetadataCache);
  codexServiceOrigins.classify(Object.values(sessions));
  recoverSessionProjects(sessions, recoveredSessionMarkers);
  dedupeSessions();
  for (const id of recoveredSessionMarkers.keys()) if (!sessions[id]) recoveredSessionMarkers.delete(id);
  for (const id of pendingCodexRecovery) if (!sessions[id]) pendingCodexRecovery.delete(id);
  const primaryIds = new Set(codexMetadataCache.filter(item => !item.isSubagent).map(item => item.threadId.toLowerCase()));
  for (const { session } of codexDiscoveryCache.values()) {
    const id = codexSessionNativeId(session.session_id);
    if (id) primaryIds.add(id);
  }
  const subagentIds = new Set([...knownCodexSubagents, ...codexMetadataCache.filter(item => item.isSubagent).map(item => item.threadId.toLowerCase())]);
  const visible = visibleCodexSessions(Object.values(sessions), { primaryIds, subagentIds }, pendingCodexRecovery);
  return visible.sort((a, b) =>
    stableSessionSortKey(a).localeCompare(stableSessionSortKey(b))
  );
}

const codexDiscoveryCache = new Map<string, { mtimeMs: number; session: SessionPayload }>();
let lastCodexMetadataAt = 0;
let codexMetadataRefreshInFlight = false;
let codexMetadataCache: CodexThreadMetadata[] = [];
const claudeDesktopDiscoveryIds = new Set<string>();
const workBuddyDesktopDiscoveryIds = new Set<string>();
const kimiCodeDiscoveryIds = new Set<string>();
const deepSeekHarnessDiscoveryIds = new Set<string>();

export function discoveryRefreshDue(lastRefreshAt: number, now: number, intervalMs: number): boolean {
  return lastRefreshAt <= 0 || now - lastRefreshAt >= intervalMs;
}

export function reconcileNativeRegistrySessions(
  target: Record<string, SessionPayload>,
  tracked: Set<string>,
  discoveries: readonly SessionPayload[],
  now = Date.now(),
): boolean {
  const live = new Set(discoveries.map(item => item.session_id));
  let changed = false;
  for (const id of tracked) {
    if (live.has(id)) continue;
    if (["native_registry", "filesystem_snapshot", "filesystem_registry"].includes(target[id]?.source ?? "")) {
      const previous = target[id];
      if (previous && (previous.status !== "idle" || previous.task_name !== "Session ended")) {
        target[id] = { ...previous, status: "idle", task_name: "Session ended", timestamp: now };
        changed = true;
      }
    }
    tracked.delete(id);
  }
  for (const discovery of discoveries) {
    const previous = target[discovery.session_id];
    if (!previous || stableFingerprint(previous) !== stableFingerprint(discovery)) {
      changed = true;
    }
    target[discovery.session_id] = discovery;
    tracked.add(discovery.session_id);
  }
  return changed;
}

export function codexMetadataRefreshDue(
  lastRefreshAt: number,
  inFlight: boolean,
  now: number,
  intervalMs: number,
): boolean {
  return !inFlight && discoveryRefreshDue(lastRefreshAt, now, intervalMs);
}

function refreshCodexMetadataIfDue(now = Date.now()): void {
  if (!CODEX_APP_SERVER_ENABLED) return;
  if (!codexMetadataRefreshDue(lastCodexMetadataAt, codexMetadataRefreshInFlight, now, CODEX_METADATA_REFRESH_MS)) return;
  lastCodexMetadataAt = now;
  codexMetadataRefreshInFlight = true;
  void readCodexThreads()
    .then(threads => {
      if (!threads.length) return;
      const resumedPaths = recentCodexThreadPaths(threads, now, SESSION_RETENTION_MS)
        .filter(path => pathInsideRuntimeRoot(path, CODEX_SESSION_DIR));
      if (resumedPaths.length) refreshCodexSessionPaths(resumedPaths, now);
      codexMetadataCache = threads.map(codexThreadMetadata);
      mergeCodexThreadMetadata(sessions, codexMetadataCache);
      broadcastSSE();
    })
    .catch(() => { /* JSONL discovery remains the fallback. */ })
    .finally(() => { codexMetadataRefreshInFlight = false; });
}

let lastBroadcastFingerprint: string | undefined;
function broadcastSSE() {
  const snapshot = sorted();
  const fingerprint = stableFingerprint(snapshot);
  if (fingerprint === lastBroadcastFingerprint) return;
  lastBroadcastFingerprint = fingerprint;
  const data = `data: ${JSON.stringify(snapshot)}\n\n`;
  for (const c of sseClients) {
    try { c.write(data); } catch {
      sseClients.delete(c);
    }
  }
}

function hasScopeSuffix(sid: string): boolean {
  const sep = sid.indexOf("__");
  const raw = sep === -1 ? sid : sid.slice(0, sep);
  return /-[a-f0-9]{8}$/.test(raw);
}

function unscopedSessionKey(sid: string): string {
  const sep = sid.indexOf("__");
  const raw = sep === -1 ? sid : sid.slice(0, sep);
  const project = sep === -1 ? "" : sid.slice(sep);
  return raw.replace(/-[a-f0-9]{8}$/, "") + project;
}

function markerAgent(file: string): string {
  return file.replace(/^sessionbar-id-/, "").split("-")[0] || "?";
}

function projectNameFromSession(s: SessionPayload): string {
  if (s.project) return s.project;
  if (s.project_path) return basename(s.project_path);
  const sep = s.session_id.indexOf("__");
  return sep === -1 ? "" : s.session_id.slice(sep + 2);
}

function stableSessionSortKey(s: SessionPayload): string {
  return [
    (s.project_path || s.project || projectNameFromSession(s)).toLowerCase(),
    (s.session_type || "").toLowerCase(),
    (s.session_id || "").toLowerCase(),
  ].join("\x1f");
}

function canonicalSessionKey(s: SessionPayload): string {
  const raw = s.session_id.split("__")[0] || s.session_id;
  const uuid = raw.match(/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:-[a-f0-9]{8})?$/i);
  if (uuid) return `${s.session_type}:${uuid[1].toLowerCase()}:${projectNameFromSession(s)}`;
  return `${s.session_type}:${s.session_id}`;
}

function sessionRank(s: SessionPayload): number {
  const statusScore: Record<string, number> = { working: 3, blocked: 2, error: 1, idle: 0 };
  return (statusScore[s.status] ?? 0) * 1_000_000_000_000 + (s.timestamp || 0);
}

function dedupeSessions() {
  const bestByKey = new Map<string, string>();
  for (const id of Object.keys(sessions)) {
    const key = canonicalSessionKey(sessions[id]);
    const prevId = bestByKey.get(key);
    if (!prevId) {
      bestByKey.set(key, id);
      continue;
    }
    const keepId = sessionRank(sessions[id]) > sessionRank(sessions[prevId]) ? id : prevId;
    const dropId = keepId === id ? prevId : id;
    delete sessions[dropId];
    bestByKey.set(key, keepId);
  }
}

type SessionIdentity = Pick<SessionPayload, "session_id" | "session_type"> &
  Partial<Pick<SessionPayload, "project" | "project_path" | "source">>;

function projectNameFromIdentity(s: SessionIdentity): string {
  if (s.project) return s.project;
  if (s.project_path) return basename(s.project_path);
  const sep = s.session_id.indexOf("__");
  return sep === -1 ? "" : s.session_id.slice(sep + 2);
}

function sameSessionProject(a: SessionIdentity, b: SessionIdentity): boolean {
  if (a.project_path && b.project_path) return a.project_path === b.project_path;
  return projectNameFromIdentity(a).toLowerCase() === projectNameFromIdentity(b).toLowerCase();
}

function sessionAgentSlug(sessionType: string): string {
  const type = sessionType.toLowerCase();
  if (type.includes("claude")) return "claude";
  if (type.includes("codex")) return "codex";
  if (type.includes("gemini")) return "gemini";
  if (type.includes("copilot")) return "copilot";
  return type.replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
}

function isStableSessionId(sessionId: string): boolean {
  const raw = sessionId.split("__")[0] || sessionId;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw);
}

export function migrateLegacyHookSessions(
  sessions: Record<string, SessionPayload>,
  incoming: SessionIdentity,
): string[] {
  if (!isStableSessionId(incoming.session_id)) return [];
  const project = projectNameFromIdentity(incoming).toLowerCase();
  const fallbackPrefix = `${sessionAgentSlug(incoming.session_type)}-${project}-`;
  const removed: string[] = [];

  for (const id of Object.keys(sessions)) {
    if (id === incoming.session_id) continue;
    const candidate = sessions[id];
    const raw = candidate.session_id.split("__")[0].toLowerCase();
    if (candidate.source !== "hook" || candidate.session_type.toLowerCase() !== incoming.session_type.toLowerCase()) continue;
    if (!sameSessionProject(candidate, incoming) || !raw.startsWith(fallbackPrefix)) continue;
    delete sessions[id];
    removeSessionMarkerFiles(SESSION_ID_DIR, candidate.session_id);
    removed.push(candidate.session_id);
  }
  return removed;
}

function collectJsonlFiles(dir: string, depth: number, out: string[]) {
  if (depth < 0 || !existsSync(dir)) return;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) collectJsonlFiles(path, depth - 1, out);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(path);
  }
}

export function recentCodexSessionDirs(base: string, now: number, windowMs: number): string[] {
  const dirs = [base];
  const start = new Date(now - Math.max(0, windowMs));
  const end = new Date(now);
  const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const last = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  while (cursor <= last) {
    dirs.push(join(
      base,
      String(cursor.getFullYear()),
      String(cursor.getMonth() + 1).padStart(2, "0"),
      String(cursor.getDate()).padStart(2, "0"),
    ));
    cursor.setDate(cursor.getDate() + 1);
  }
  return dirs;
}

export function readFirstJsonLine(path: string): any | null {
  let fd: number | undefined;
  try {
    const maxBytes = 64 * 1024;
    const buffer = Buffer.alloc(maxBytes);
    fd = openSync(path, "r");
    const bytes = readSync(fd, buffer, 0, maxBytes, 0);
    const text = buffer.toString("utf-8", 0, bytes);
    const newline = text.indexOf("\n");
    const first = newline >= 0 ? text.slice(0, newline) : text;
    return first ? JSON.parse(first) : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

function isCodexTopLevel(meta: any): boolean {
  if (!meta || typeof meta !== "object") return false;
  if (typeof meta.cwd !== "string" || !meta.cwd) return false;
  if (typeof meta.id !== "string" || !meta.id) return false;
  if (!String(meta.originator || "").toLowerCase().includes("codex")) return false;
  const nativeSource = codexNativeSource(meta.thread_source, meta.source);
  const service = codexBackgroundService(nativeSource);
  if (service) codexServiceOrigins.observe(meta.id, service);
  if (codexHasSubagentSource(meta.thread_source, meta.source) || meta.source?.internal !== undefined) {
    // Internal services enrich reports; only user workers belong in the subagent roster.
    if (!service && codexHasSubagentSource(meta.thread_source, meta.source)) knownCodexSubagents.add(meta.id.toLowerCase());
    return false;
  }
  return true;
}

function compactLine(value: unknown, max = 120): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 3))}...`;
}

function readTail(path: string, maxBytes: number): string {
  let fd: number | undefined;
  try {
    const stat = statSync(path);
    const size = Math.min(stat.size, Math.max(0, maxBytes));
    const start = Math.max(0, stat.size - size);
    const buffer = Buffer.alloc(size);
    fd = openSync(path, "r");
    readSync(fd, buffer, 0, size, start);
    const text = buffer.toString("utf-8");
    return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
  } catch {
    return "";
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

function latestCodexTurnActive(path: string): boolean {
  let fd: number | undefined;
  try {
    const size = statSync(path).size;
    const chunkSize = 64 * 1024;
    let end = size;
    let suffix = "";
    while (end > 0) {
      const start = Math.max(0, end - chunkSize);
      const buffer = Buffer.alloc(end - start);
      fd ??= openSync(path, "r");
      readSync(fd, buffer, 0, buffer.length, start);
      const text = buffer.toString("utf8") + suffix;
      const started = Math.max(text.lastIndexOf('"type":"task_started"'), text.lastIndexOf('"type": "task_started"'));
      const completed = Math.max(text.lastIndexOf('"type":"task_complete"'), text.lastIndexOf('"type": "task_complete"'));
      if (started >= 0 || completed >= 0) return started > completed;
      suffix = text.slice(0, 64);
      end = start;
    }
  } catch { /* malformed or concurrently removed log */ }
  finally { if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ } }
  return false;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part: any) =>
    part?.text || part?.input_text || part?.output_text || ""
  ).filter(Boolean).join(" ");
}

function commandLabel(name: string, args: unknown): string {
  if (name === "exec_command") {
    try {
      const parsed = typeof args === "string" ? JSON.parse(args) : args;
      if (parsed && typeof parsed.cmd === "string" && parsed.cmd.trim()) {
        return compactLine(parsed.cmd, 96);
      }
    } catch { /* fall through */ }
  }
  if (name === "write_stdin") return "terminal input";
  if (name === "apply_patch") return "apply patch";
  return name.replace(/^functions\./, "").replace(/_/g, " ");
}

export function codexActivityFromJsonl(path: string, isRecent: boolean): { taskName: string; tail: string[]; working: boolean } {
  if (!isRecent) return { taskName: "Ready", tail: [], working: false };

  const lines = readTail(path, ACTIVITY_TAIL_BYTES).split("\n").filter(Boolean);
  const pending = new Map<string, string>();
  const calls = new Map<string, string>();
  const tail: string[] = [];
  let turnActive = latestCodexTurnActive(path);
  const pushTail = (line: string) => {
    const clean = compactLine(line, 160);
    if (!clean || tail.at(-1) === clean) return;
    tail.push(clean);
  };

  for (const line of lines) {
    let item: any;
    try { item = JSON.parse(line); } catch { continue; }
    const payload = item?.payload || {};

    if (item.type === "event_msg" && payload.type === "task_started") {
      turnActive = true;
    } else if (item.type === "event_msg" && payload.type === "task_complete") {
      turnActive = false;
      pending.clear();
    } else if (item.type === "response_item" && payload.type === "function_call") {
      const label = commandLabel(payload.name || "tool", payload.arguments);
      if (payload.call_id) {
        pending.set(payload.call_id, label);
        calls.set(payload.call_id, label);
      }
      pushTail(`tool: ${label}`);
    } else if (item.type === "response_item" && payload.type === "custom_tool_call") {
      const label = commandLabel(payload.name || "tool", payload.input);
      if (payload.call_id) {
        pending.set(payload.call_id, label);
        calls.set(payload.call_id, label);
      }
      pushTail(`tool: ${label}`);
    } else if (item.type === "response_item" && payload.type === "function_call_output") {
      if (payload.call_id) pending.delete(payload.call_id);
      const label = payload.call_id ? calls.get(payload.call_id) : undefined;
      if (label) pushTail(`done: ${label}`);
    } else if (item.type === "response_item" && payload.type === "custom_tool_call_output") {
      if (payload.call_id) pending.delete(payload.call_id);
      const label = payload.call_id ? calls.get(payload.call_id) : undefined;
      if (label) pushTail(`done: ${label}`);
    } else if (item.type === "event_msg" && payload.type === "agent_message") {
      const message = compactLine(payload.message, 120);
      if (message) pushTail(`agent: ${message}`);
    } else if (item.type === "event_msg" && payload.type === "user_message") {
      const message = compactLine(payload.message, 120);
      if (message) pushTail(`user: ${message}`);
    } else if (item.type === "response_item" && payload.type === "message") {
      const message = compactLine(textFromContent(payload.content), 120);
      if (message) pushTail(`agent: ${message}`);
    }
  }

  const pendingLabel = [...pending.values()].at(-1);
  const recent = tail.slice(-5);
  if (pendingLabel) return { taskName: `running: ${pendingLabel}`, tail: recent, working: true };
  return {
    taskName: turnActive ? recent.at(-1) || "Active Codex session" : "Ready",
    tail: recent,
    working: turnActive,
  };
}

function refreshCodexSessions(now = Date.now()): boolean {
  const before = stableFingerprint(Object.values(sessions).filter(session => session.source === "codex_jsonl"));
  const files: Array<{ path: string; mtimeMs: number }> = [];
  const all: string[] = [];
  for (const dir of recentCodexSessionDirs(CODEX_SESSION_DIR, now, CODEX_DISCOVERY_WINDOW_MS)) {
    collectJsonlFiles(dir, 0, all);
  }
  for (const path of all) {
    try {
      const stat = statSync(path);
      if (now - stat.mtimeMs <= Math.min(CODEX_DISCOVERY_WINDOW_MS, SESSION_RETENTION_MS)) {
        files.push({ path, mtimeMs: stat.mtimeMs });
      }
    } catch { /* skip unreadable files */ }
  }

  const discoveries: SessionPayload[] = [];
  const livePaths = new Set<string>();
  for (const file of files.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 80)) {
    livePaths.add(file.path);
    const cached = codexDiscoveryCache.get(file.path);
    if (cached?.mtimeMs === file.mtimeMs) {
      discoveries.push({
        ...cached.session,
        status: now - file.mtimeMs <= CODEX_ACTIVE_MS ? cached.session.status : "idle",
        task_name: now - file.mtimeMs <= CODEX_ACTIVE_MS ? cached.session.task_name : "Ready",
        activity_tail: now - file.mtimeMs <= CODEX_ACTIVE_MS ? cached.session.activity_tail : [],
      });
      continue;
    }
    const first = readFirstJsonLine(file.path);
    const meta = first?.type === "session_meta" ? first.payload : null;
    if (!isCodexTopLevel(meta)) continue;

    const project = basename(meta.cwd);
    const sid = `codex-${meta.id}__${project}`;
    const isRecent = now - file.mtimeMs <= CODEX_ACTIVE_MS;
    const activity = codexActivityFromJsonl(file.path, isRecent);
    const session: SessionPayload = {
      session_id: sid,
      session_type: "Codex",
      source: "codex_jsonl",
      status: activity.working ? "working" : "idle",
      session_source: codexNativeSource(meta.thread_source, meta.source),
      task_name: activity.taskName,
      activity_tail: activity.tail,
      timestamp: file.mtimeMs,
      project,
      project_path: meta.cwd,
    };
    codexDiscoveryCache.set(file.path, { mtimeMs: file.mtimeMs, session });
    discoveries.push(session);
  }

  for (const path of codexDiscoveryCache.keys()) {
    if (!livePaths.has(path)) codexDiscoveryCache.delete(path);
  }

  mergeCodexDiscovery(sessions, discoveries);
  const after = stableFingerprint(Object.values(sessions).filter(session => session.source === "codex_jsonl"));
  return before !== after;
}

function refreshCodexSessionPaths(paths: readonly string[], now = Date.now()): boolean {
  const before = stableFingerprint(Object.values(sessions).filter(session => session.source === "codex_jsonl"));
  for (const path of paths) {
    let mtimeMs: number;
    try { mtimeMs = statSync(path).mtimeMs; }
    catch {
      codexDiscoveryCache.delete(path);
      continue;
    }
    if (now - mtimeMs > Math.min(CODEX_DISCOVERY_WINDOW_MS, SESSION_RETENTION_MS)) {
      codexDiscoveryCache.delete(path);
      continue;
    }
    const first = readFirstJsonLine(path);
    const meta = first?.type === "session_meta" ? first.payload : null;
    if (!isCodexTopLevel(meta)) continue;
    const project = basename(meta.cwd);
    const activity = codexActivityFromJsonl(path, now - mtimeMs <= CODEX_ACTIVE_MS);
    codexDiscoveryCache.set(path, {
      mtimeMs,
      session: {
        session_id: `codex-${meta.id}__${project}`,
        session_type: "Codex",
        source: "codex_jsonl",
        status: activity.working ? "working" : "idle",
        session_source: codexNativeSource(meta.thread_source, meta.source),
        task_name: activity.taskName,
        activity_tail: activity.tail,
        timestamp: mtimeMs,
        project,
        project_path: meta.cwd,
      },
    });
  }
  const discoveries: SessionPayload[] = [];
  for (const [path, cached] of codexDiscoveryCache) {
    if (now - cached.mtimeMs > Math.min(CODEX_DISCOVERY_WINDOW_MS, SESSION_RETENTION_MS)) {
      codexDiscoveryCache.delete(path);
      continue;
    }
    const active = now - cached.mtimeMs <= CODEX_ACTIVE_MS;
    discoveries.push(active ? cached.session : {
      ...cached.session,
      status: "idle",
      task_name: "Ready",
      activity_tail: [],
    });
  }
  mergeCodexDiscovery(sessions, discoveries);
  return before !== stableFingerprint(Object.values(sessions).filter(session => session.source === "codex_jsonl"));
}

function sourceRead<T>(roots: readonly string[], read: () => T): SourceRead<T> {
  try {
    for (const root of roots) {
      if (existsSync(root)) readdirSync(root, { withFileTypes: true });
    }
    return { ok: true, value: read() };
  } catch (error) {
    return { ok: false, error };
  }
}

function configureFileSourceRuntime(): FileSourceRuntime {
  const claudeRoots = Array.isArray(CLAUDE_DESKTOP_ROOT) ? CLAUDE_DESKTOP_ROOT : [CLAUDE_DESKTOP_ROOT];
  type RegistryRead = { discoveries: SessionPayload[]; targeted: boolean };
  const mergeTargeted = (discoveries: readonly SessionPayload[], tracked: Set<string>): boolean => {
    let changed = false;
    for (const discovery of discoveries) {
      const previous = sessions[discovery.session_id];
      if (!previous || stableFingerprint(previous) !== stableFingerprint(discovery)) changed = true;
      sessions[discovery.session_id] = discovery;
      tracked.add(discovery.session_id);
    }
    return changed;
  };
  const adapters: FileSourceAdapter<any>[] = [
    {
      id: "dsh-projection-checkpoints",
      lane: "session",
      roots: [deepSeekHarnessCheckpointRoot(DSH_ROOT), join(DSH_ROOT, "storages", "workspace.json")],
      accepts: path => path.endsWith(".json"),
      read: change => sourceRead([deepSeekHarnessCheckpointRoot(DSH_ROOT)], (): RegistryRead => {
        const checkpointRoot = deepSeekHarnessCheckpointRoot(DSH_ROOT);
        const targeted = change.kind === "targeted" && change.paths.every(path =>
          existsSync(path) && pathInsideRuntimeRoot(path, checkpointRoot));
        return { targeted, discoveries: discoverDeepSeekHarnessSessions({
          root: DSH_ROOT,
          now: Date.now(),
          retentionMs: SESSION_RETENTION_MS,
          ...(targeted ? { paths: change.paths } : {}),
        }) };
      }),
      apply: result => result.targeted
        ? mergeTargeted(result.discoveries, deepSeekHarnessDiscoveryIds)
        : reconcileNativeRegistrySessions(sessions, deepSeekHarnessDiscoveryIds, result.discoveries),
    },
    {
      id: "codex-session-files",
      lane: "session",
      roots: [CODEX_SESSION_DIR],
      accepts: path => path.endsWith(".jsonl"),
      read: change => sourceRead([CODEX_SESSION_DIR], () => change.kind === "targeted"
        ? refreshCodexSessionPaths(change.paths, Date.now())
        : refreshCodexSessions(Date.now())),
      apply: changed => changed,
    },
    {
      id: "claude-desktop-registry",
      lane: "session",
      roots: claudeRoots,
      accepts: path => basename(path).startsWith("local_") && path.endsWith(".json"),
      read: change => sourceRead(claudeRoots, (): RegistryRead => {
        const targeted = change.kind === "targeted" && change.paths.every(path => existsSync(path));
        return { targeted, discoveries: discoverClaudeDesktopSessions({
          root: CLAUDE_DESKTOP_ROOT,
          now: Date.now(),
          activeMs: CLAUDE_DESKTOP_ACTIVE_MS,
          windowMs: CLAUDE_DESKTOP_DISCOVERY_WINDOW_MS,
          ...(targeted ? { paths: change.paths } : {}),
        }) };
      }),
      apply: result => result.targeted
        ? mergeTargeted(result.discoveries, claudeDesktopDiscoveryIds)
        : reconcileNativeRegistrySessions(sessions, claudeDesktopDiscoveryIds, result.discoveries),
    },
    {
      id: "kimi-code-registry",
      lane: "session",
      roots: [KIMI_CODE_ROOT],
      accepts: path => path.endsWith("session_index.jsonl") || path.endsWith("state.json"),
      read: () => sourceRead([KIMI_CODE_ROOT], (): RegistryRead => ({
        targeted: false,
        discoveries: discoverKimiCodeSessions({
          root: KIMI_CODE_ROOT,
          now: Date.now(),
          retentionMs: SESSION_RETENTION_MS,
        }),
      })),
      apply: result => reconcileNativeRegistrySessions(sessions, kimiCodeDiscoveryIds,
        result.discoveries.filter((discovery: SessionPayload) => sessions[discovery.session_id]?.source !== "hook")),
    },
    {
      id: "workbuddy-desktop-registry",
      lane: "session",
      roots: [join(WORKBUDDY_ROOT, "sessions"), join(WORKBUDDY_ROOT, "app"), join(WORKBUDDY_ROOT, "projects"),
        join(WORKBUDDY_ROOT, "workbuddy.db"), join(WORKBUDDY_ROOT, "workbuddy.db-wal")],
      accepts: path => path.endsWith(".json") || path.endsWith(".jsonl")
        || basename(path) === "workbuddy.db" || basename(path) === "workbuddy.db-wal",
      read: change => sourceRead([WORKBUDDY_ROOT], (): RegistryRead => {
        const sessionsRoot = join(WORKBUDDY_ROOT, "sessions");
        const targeted = change.kind === "targeted"
          && change.paths.every(path => existsSync(path) && pathInsideRuntimeRoot(path, sessionsRoot));
        return { targeted, discoveries: discoverWorkBuddyDesktopSessions({
          root: WORKBUDDY_ROOT,
          now: Date.now(),
          ...(targeted ? { paths: change.paths } : {}),
        }) };
      }),
      apply: result => result.targeted
        ? mergeTargeted(result.discoveries, workBuddyDesktopDiscoveryIds)
        : reconcileNativeRegistrySessions(sessions, workBuddyDesktopDiscoveryIds, result.discoveries),
    },
  ];
  return new FileSourceRuntime(adapters, {
    debounceMs: 300,
    reconcileMs: 5 * 60_000,
    onChange: () => broadcastSSE(),
    onError: (sourceId, error) => console.error(`[runtime] ${sourceId} refresh failed; retaining last good snapshot`, error),
  });
}

// Recover sessions that were already running before the server started.
// Markers recover identities; Codex rows await native primary-session evidence.
// (The PID embedded in session_id is the shell $$ at creation time, long dead;
//  don't check it — the ID file alone tells us the session is open.)
// Crash safety: if an agent dies without SessionEnd, the in-memory retention
// window eventually removes it. A marker alone must not revive a Codex row.
function recoverSessions() {
  try {
    const files = readdirSync(SESSION_ID_DIR).filter(f => f.startsWith("sessionbar-id-"));
    const entries: Array<{ file: string; sid: string }> = [];
    const sidCounts = new Map<string, number>();
    for (const file of files) {
      try {
        const sid = readFileSync(join(SESSION_ID_DIR, file), "utf-8").trim();
        if (!sid) { try { unlinkSync(join(SESSION_ID_DIR, file)); } catch { /* */ } continue; }
        entries.push({ file, sid });
        sidCounts.set(sid, (sidCounts.get(sid) || 0) + 1);
      } catch { /* corrupt ID file, skip */ }
    }

    const recovered = entries.map(({ file, sid: storedSid }) => ({
      file,
      sid: (sidCounts.get(storedSid) || 0) > 1 ? scopedSessionId(storedSid, file) : storedSid,
    }));
    const scopedKeys = new Set(recovered.filter(e => hasScopeSuffix(e.sid)).map(e => unscopedSessionKey(e.sid)));

    for (const { file: f, sid } of recovered) {
      try {
        if (!hasScopeSuffix(sid) && scopedKeys.has(unscopedSessionKey(sid))) continue;
        const markers = recoveredSessionMarkers.get(sid) ?? [];
        if (!markers.includes(f)) markers.push(f);
        recoveredSessionMarkers.set(sid, markers);
        if (sessions[sid]) continue;

        const type = markerAgent(f);
        const recoveredSession: SessionPayload = {
          session_id: sid,
          session_type: canonicalMarkerSessionType(type),
          source: "hook",
          status: "idle",
          task_name: "Ready",
          timestamp: Date.now(),
        };
        if (type === "codex") {
          pendingCodexRecovery.add(sid);
          mergeCodexHookSession(sessions, recoveredSession);
        }
        else sessions[sid] = recoveredSession;
        console.log(`[recover] ${sid}`);
      } catch { /* corrupt ID file, skip */ }
    }
    if (Object.keys(sessions).length > 0) {
      broadcastSSE();
      if (process.env.SESSIONBAR_ICLOUD) syncToICloud(sorted());
    }
  } catch { /* state dir not readable */ }
}

export function canonicalMarkerSessionType(type: string): string {
  const typeMap: Record<string, string> = {
    claude: "Claude Code",
    gemini: "Gemini CLI",
    codex: "Codex",
    copilot: "Copilot",
    pi: "Pi Agent",
  };
  return typeMap[type.toLowerCase()] || type;
}

// SSE heartbeat — detect dead connections
let heartbeatInterval: NodeJS.Timeout | undefined;
let purgeInterval: NodeJS.Timeout | undefined;
if (isDirectRun) {
  fileSourceRuntime = configureFileSourceRuntime();
  fileSourceRuntime.start();
  void fileSourceRuntime.reconcile();
  heartbeatInterval = setInterval(() => {
    for (const c of sseClients) {
      try { c.write(":\n"); } catch {
        sseClients.delete(c);
      }
    }
  }, 15_000);

  // Ended and silent sessions remain visible as history for the retention window.
  purgeInterval = setInterval(() => {
    const now = Date.now();
    let changed = false;
    for (const id of Object.keys(sessions)) {
      const s = sessions[id];
      const reason = sessionPurgeReason(s, now, SESSION_RETENTION_MS);
      if (reason) {
        delete sessions[id];
        removeSessionMarkerFiles(SESSION_ID_DIR, id);
        changed = true;
        console.log(`[purge] ${id} (${reason})`);
      }
    }
    if (changed) {
      broadcastSSE();
      if (process.env.SESSIONBAR_ICLOUD) syncToICloud(sorted());
    }
  }, 10_000);
}

export function sessionPurgeReason(
  session: Pick<SessionPayload, "status" | "task_name" | "timestamp">,
  now: number,
  retentionMs: number,
): "ended" | "timeout — assumed crashed" | undefined {
  if (now - session.timestamp <= retentionMs) return undefined;
  return session.status === "idle" && session.task_name === "Session ended"
    ? "ended"
    : "timeout — assumed crashed";
}

// Pairing uses a separate, temporary LAN listener. It intentionally does not
// mount the dashboard or any authenticated SessionBar API.
app.get("/health", (_req, res) => {
  const address = httpServer?.address();
  res.json({
    service: "sessionbar",
    pid: process.pid,
    port: address && typeof address === "object" ? address.port : REQUESTED_PORT,
    web: true,
    web_clients: sseClients.size,
    build_id: BUILD_ID,
    config_revision: configRevision,
    runtime: { node: process.version, network: providerNetworkStatus(), stopping },
  });
});

app.post("/lifecycle/unobserved", (req, res) => {
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket?.remoteAddress ?? "")) {
    res.status(403).json({ ok: false, error: "loopback only" });
    return;
  }
  scheduleShutdownIfUnobserved();
  res.json({ ok: true, shutdown_in_ms: UNOBSERVED_SHUTDOWN_MS });
});

// POST: session reports its status
app.post("/session/status", (req, res) => {
  if (!validateSessionPayload(req.body)) {
    res.status(400).json({ ok: false, error: "invalid payload" });
    return;
  }
  const data = req.body;
  // A current native report is evidence even when no transcript was persisted.
  for (const id of pendingCodexRecovery) {
    if (id === data.session_id || (data.session_type.toLowerCase() === "codex"
      && codexSessionNativeId(id) && codexSessionNativeId(id) === codexSessionNativeId(data.session_id))) pendingCodexRecovery.delete(id);
  }
  migrateLegacyHookSessions(sessions, data);
  const prev = sessions[data.session_id];
  const merged = mergeSessionPayload(prev, data, Date.now());
  if (merged.session_type.toLowerCase() === "codex" && merged.source === "hook") mergeCodexHookSession(sessions, merged);
  else sessions[data.session_id] = merged;
  console.log(`[session] ${data.session_id} → ${data.status}`);
  broadcastSSE();
  if (process.env.SESSIONBAR_ICLOUD) syncToICloud(sorted());
  res.json({ ok: true });
});

// GET: current state
app.get("/sessions/live", (_req, res) => {
  res.json(sorted());
});

// Optional, pull-driven agent details share the existing read authorization.
// The session SSE payload and relay/network lifecycle remain independent.
const codexAvatars = createCodexAvatarSource();
app.use("/agents", createAgentRouter(new AgentService({
  getSessions: sorted,
  collector: createCompositeAgentCollector([
    { sessionTypes: ["Codex"], collector: createCodexAgentCollector({
      avatarSource: codexAvatars,
      root: CODEX_SESSION_DIR,
      streamRoot: process.env.SESSIONBAR_CODEX_EVENTS_DIR || join(HOME, "codex-events"),
      hookRoot: process.env.SESSIONBAR_CODEX_HOOK_EVENTS_DIR || join(HOME, "codex-hooks"),
      sourceId: `codex-local-${createHash("sha256").update(resolve(CODEX_HOME)).digest("hex").slice(0, 24)}`,
      windowMs: CODEX_DISCOVERY_WINDOW_MS,
      activeMs: CODEX_ACTIVE_MS,
    }) },
    { sessionTypes: ["Claude Code", "claude-code", "claude"], collector: createClaudeAgentCollector({
      root: CLAUDE_SESSION_DIR,
      sourceId: `claude-local-${createHash("sha256").update(resolve(CLAUDE_SESSION_DIR)).digest("hex").slice(0, 24)}`,
    }) },
    { sessionTypes: ["DeepSeek Harness", "dsh"], collector: createDeepSeekAgentCollector({
      root: DSH_ROOT,
      sourceId: `dsh-local-${createHash("sha256").update(resolve(DSH_ROOT)).digest("hex").slice(0, 24)}`,
    }) },
  ]),
}), codexAvatars));

app.get("/system/live", (_req, res) => {
  lastSystemClientAt = Date.now();
  if (nextSystemSampleAt === 0 || nextSystemSampleAt - lastSystemClientAt > SYSTEM_SAMPLE_MS) {
    scheduleSystemSample(SYSTEM_SAMPLE_MS);
  }
  res.json({ system: systemSampler.latest() ?? null });
});

// GET: aggregated provider plan rows (subscription + account/session API rows)
app.get("/providers/live", (_req, res) => {
  if (subscriptionRows === null) {
    res.json({ providers: [], initializing: true });
    return;
  }
  const rows = decorateProviderUsage(
    providerLastGood.rows.filter(row => Date.now() - (row.lastSeenAt ?? 0) <= PROVIDER_LAST_GOOD_MAX_AGE_MS),
    providerUsageHistory,
  );
  res.json({
    providers: decorateProviderUsageFromSessions(decorateApiUsageFromCCSwitch(rows, ccSwitchUsage), sessionUsageState),
    revision: providerRevision,
    session_revision: sessionProviderRevision,
    history_revision: providerHistoryRevision,
  });
});

// POST: refresh provider state after a local SessionBar setting changes.
app.post("/providers/refresh", async (_req, res) => {
  await refreshProviderSignals();
  res.json({ ok: true });
});

// GET: SSE stream
app.get("/sessions/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const disconnect = () => {
    if (!sseClients.delete(res)) return;
    if (sseClients.size === 0) scheduleShutdownIfUnobserved();
  };
  res.on("error", disconnect);
  if (unobservedShutdownTimer) {
    clearTimeout(unobservedShutdownTimer);
    unobservedShutdownTimer = undefined;
  }
  sseClients.add(res);
  req.on("close", disconnect);
  // Controlled reconnection: retry every 5s with jitter (EventSource spec)
  res.write("retry: 5000\n\n");
  res.write(`data: ${JSON.stringify(sorted())}\n\n`);
});

// DELETE: session explicitly removed
app.delete("/session/:id", (req, res) => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  if (sessions[id]) {
    delete sessions[id];
    removeSessionMarkerFiles(SESSION_ID_DIR, id);
    console.log(`[session] ${id} → removed`);
    broadcastSSE();
    if (process.env.SESSIONBAR_ICLOUD) syncToICloud(sorted());
  }
  res.json({ ok: true });
});

let httpServer: ReturnType<typeof app.listen> | undefined;
if (isDirectRun) {
  if (!isLoopbackHost(HOST)) {
    console.error("This release supports loopback HTTP only; LAN access is not released.");
    process.exit(2);
  }
  ensurePrivateDirectory(HOME);
  ensurePrivateDirectory(SESSION_ID_DIR);
  instanceLock = acquireInstanceLock(HOME);
  if (instanceLock === undefined) {
    console.error("SessionBar is already running on this machine.");
    process.exit(2);
  } else {
    configRevision = recordRelayConfig(HOME, process.env).revision;
    httpServer = app.listen(REQUESTED_PORT, HOST, () => {
      const address = httpServer?.address();
      const port = address && typeof address === "object" ? address.port : REQUESTED_PORT;
      writeRuntimeState(HOME, { pid: process.pid, port, started_at: Date.now() });
      console.log(`SessionBar on http://${HOST}:${port}`);
      console.log(`Dashboard: http://${HOST}:${port}`);
      recoverSessions();
      startSystemSampling();
      startProviderPolling();
    });
  }

  let shuttingDown = false;
  const shutdown = (reason: string, code: number, error?: unknown) => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (error) console.error(`[shutdown] ${reason}`, error);
    else console.log(`[shutdown] ${reason}`);
    void cleanup().then(() => process.exit(code), () => process.exit(code || 1));
  };

  httpServer?.on("error", error => shutdown("server error", 1, error));
  process.on("SIGTERM", () => shutdown("SIGTERM", 0));
  process.on("SIGINT", () => shutdown("SIGINT", 0));
  process.on("uncaughtException", error => shutdown("uncaughtException", 1, error));
  process.on("unhandledRejection", reason => shutdown("unhandledRejection", 1, reason));
}
