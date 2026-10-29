#!/usr/bin/env node

import { execFileSync, execSync, spawn } from "child_process";
import { readFileSync, unlinkSync, existsSync, openSync, closeSync, statSync, fchmodSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { createInterface } from "readline";
import { ensurePrivateDirectory } from "../shared/privateState.js";
import { createSSETransport, type SSETransport } from "../tui/sseTransport.js";
import { terminalAnsiTheme } from "../tui/terminalTheme.js";
import { pruneSessionMarkerFiles } from "../sessions/sessionMarkers.js";
import {
  detectHarnessAvailability,
  setupHooks,
  teardownHooks,
  injectHooksOnServerReady,
  type HarnessRegistryEntry,
} from "../hooks/hookManager.js";
import {
  age as formatAge,
  agentName as compactAgentName,
  sessionDisplayName,
  sessionProjectName,
  statusLabel,
  stripAnsi,
} from "../tui/displayUtils.js";
import { isSystemEfficiencySnapshot, type SystemEfficiencySnapshot } from "../shared/types.js";
import { acquireAppClient, configuredPort, readRuntimeState, releaseAppClient } from "../server/runtimeState.js";
import { readSettings, updateSettings } from "../server/settings.js";
import {
  runLandingMenu,
  type LandingMenuDeps,
} from "./landingMenu.js";
import { promptSetupFocus } from "./setupFocusPrompt.js";
import { fetchRelayHealth, relayNodeExecutable, stopRelayProcess, waitForChildSpawn } from "../server/relayLifecycle.js";
import { localFetch } from "../runtime/networkRuntime.js";
import { readRelayConfigMatch } from "../runtime/relayConfig.js";
import type { MonitorView } from "../tui/openTuiMonitor.js";
import { isCodexTraceInvocation, traceCodex } from "./codexTrace.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOME = process.env.SESSIONBAR_HOME || process.env.AGENTBAR_HOME || join(homedir(), ".sessionbar");
const PID_FILE = join(HOME, "server.pid");
const LOG_FILE = join(HOME, "server.log");
const SESSION_ID_DIR = join(HOME, "sessions");
const EXPLICIT_PORT = configuredPort();
let PORT = EXPLICIT_PORT || readRuntimeState(HOME)?.port || 0;
const API_HOST = process.env.SESSIONBAR_HOST || "127.0.0.1";

async function relayFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const token = process.env.SESSIONBAR_DEVICE_TOKEN;
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return localFetch(url, { ...init, headers });
}

function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer.exe" : "xdg-open";
  const child = spawn(command, [url], { detached: true, stdio: "ignore" });
  child.on("error", () => console.error(`Open this URL in your browser: ${url}`));
  child.unref();
}

function currentBuildId(): string {
  const serverPath = join(__dirname, "..", "server", "server.js");
  const stat = statSync(serverPath);
  return `${stat.size}:${Math.trunc(stat.mtimeMs)}`;
}

function refreshRuntimePort(): number {
  PORT = EXPLICIT_PORT || readRuntimeState(HOME)?.port || PORT;
  return PORT;
}

function apiBase(): string {
  return `http://${API_HOST}:${refreshRuntimePort()}`;
}

function sessionsApi(): string {
  return `${apiBase()}/sessions/live`;
}

const args = process.argv.slice(2);
const cmd = args[0];
const useICloud = args.includes("--icloud") || !!process.env.SESSIONBAR_ICLOUD;
let useWeb = args.includes("--web") || process.env.SESSIONBAR_WEB === "1";
const noAnim = args.includes("--no-animation") || !!process.env.NO_COLOR || process.env.TERM === "dumb";
const animateTui = process.env.SESSIONBAR_ANIMATE === "1" && !noAnim;
const refreshEnv = parseInt(process.env.SESSIONBAR_TUI_REFRESH_MS || "500", 10);
const pollEnv = parseInt(process.env.SESSIONBAR_TUI_POLL_MS || "1000", 10);
const tuiRenderMs = Number.isFinite(refreshEnv) ? Math.max(100, refreshEnv) : 500;
const tuiPollMs = Number.isFinite(pollEnv) ? Math.max(100, pollEnv) : 1000;

function ensureDir() {
  ensurePrivateDirectory(HOME);
  ensurePrivateDirectory(SESSION_ID_DIR);
}

function pidAlive(): boolean {
  try {
    const pid = readRuntimeState(HOME)?.pid || parseInt(readFileSync(PID_FILE, "utf-8").trim().split("|")[0], 10);
    if (!pid) return false;
    process.kill(pid, 0);  // signal 0 checks existence
    // Cross-check: verify the PID actually belongs to a sessionbar server
    try {
      let cmd = "";
      if (process.platform === "linux") {
        cmd = `cat /proc/${pid}/comm 2>/dev/null`;
      } else {
        // macOS / BSD
        cmd = `ps -p ${pid} -o comm= 2>/dev/null`;
      }
      const out = execSync(cmd, { encoding: "utf-8", timeout: 1000 }).trim();
      if (out && !out.includes("node") && !out.includes("sessionbar")) {
        // PID exists but doesn't belong to us — stale
        try { unlinkSync(PID_FILE); } catch { /* */ }
        return false;
      }
    } catch {
      // Restricted environments may allow signal 0 but deny process inspection.
      // Treat the PID as alive; API polling will decide whether the server is usable.
      return true;
    }
    return true;
  } catch { return false; }
}

async function startServer(quiet = false): Promise<boolean> {
  ensureDir();
  if (pidAlive()) return true;
  const js = join(__dirname, "..", "server", "server.js");
  if (!existsSync(js)) {
    console.error(`Server binary not found: ${js}`);
    return false;
  }
  let fd: number;
  try {
    fd = openSync(LOG_FILE, "a", 0o600);
    if (process.platform !== "win32") fchmodSync(fd, 0o600);
  } catch (e: any) {
    if (!quiet) console.error(`Cannot open server log: ${e?.message || e}`);
    return false;
  }
  const env: Record<string, string> = { ...process.env, SESSIONBAR_PORT: String(EXPLICIT_PORT ?? 0) };
  if (useICloud) env.SESSIONBAR_ICLOUD = "1";
  if (useWeb) env.SESSIONBAR_WEB = "1";
  try {
    const executable = relayNodeExecutable(process.execPath, isBunRuntime(), process.env);
    const proc = spawn(executable, [js], { detached: true, stdio: ["ignore", fd, fd], env });
    await waitForChildSpawn(proc);
    return true;
  } catch (e: any) {
    if (!quiet) console.error(`Cannot start server: ${e?.message || e}`);
    return false;
  } finally {
    try { closeSync(fd); } catch { /* */ }
  }
}

function relayOwner(): string | undefined {
  try {
    const owner = readFileSync(PID_FILE, "utf8").trim();
    const pid = Number(owner.split("|")[0]);
    return Number.isSafeInteger(pid) && pid > 0 ? owner : undefined;
  } catch { return undefined; }
}

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function verifyRelayOwner(pid: number): Promise<boolean> {
  try {
    if (Number(readFileSync(join(HOME, "server.lock"), "utf8").trim()) !== pid) return false;
  } catch { return false; }
  const state = readRuntimeState(HOME);
  if (state?.pid === pid) {
    const health = await fetchRelayHealth(relayFetch, `http://${API_HOST}:${state.port}/health`);
    if (health?.service === "sessionbar" && health.pid === pid && health.port === state.port) return true;
  }
  // An unavailable API is not proof of ownership. Verify the exact server
  // entry point before signalling; never kill an arbitrary reused Node PID.
  try {
    const command = execFileSync("ps", ["-ww", "-p", String(pid), "-o", "args="], { encoding: "utf8", timeout: 1_000 }).trim();
    return command.endsWith(join(__dirname, "..", "server", "server.js"));
  } catch { return false; }
}

async function restartServerProcess(quiet = false): Promise<boolean> {
  if (!existsSync(PID_FILE)) {
    // A Relay can own its lock before publishing its PID/port, or during
    // shutdown. Missing markers alone must not be reported as a stopped owner.
    try {
      const lockedPid = Number(readFileSync(join(HOME, "server.lock"), "utf8").trim());
      if (Number.isSafeInteger(lockedPid) && lockedPid > 0 && processExists(lockedPid)) {
        if (!quiet) console.error("Relay ownership is incomplete; wait for startup or shutdown to finish.");
        return false;
      }
    } catch { /* no lock */ }
    return true;
  }
  const owner = relayOwner();
  const result = owner ? await stopRelayProcess({
    pid: Number(owner.split("|")[0]), owner, readOwner: relayOwner,
    isAlive: processExists, verifyOwner: verifyRelayOwner,
    signal: (pid, signal) => process.kill(pid, signal),
  }) : "unverified";
  if (result === "stopped") return true;
  if (!quiet) console.error(`Relay did not stop (${result}); its state was preserved.`);
  return false;
}

async function stopServer(quiet = false): Promise<boolean> {
  const hadPid = existsSync(PID_FILE);
  if (!await restartServerProcess(quiet)) return false;
  if (!hadPid) { if (!quiet) console.log("Not running."); return true; }
  teardownHooks(true, quiet);
  if (!quiet) console.log("Stopped.");
  return true;
}

async function requestSessions(): Promise<{ sessions: any[], error?: string }> {
  try {
    const resp = await relayFetch(sessionsApi());
    if (!resp.ok) return { sessions: [], error: `HTTP ${resp.status}` };
    const data = await resp.json();
    if (!Array.isArray(data)) return { sessions: [], error: "invalid response" };
    return { sessions: data };
  } catch (e: any) {
    const code = e?.cause?.code || e?.code;
    const message = e?.message || "unreachable";
    return { sessions: [], error: code ? `${code}: ${message}` : message };
  }
}

async function fetchSessions(): Promise<{ sessions: any[], error?: string }> {
  const first = await requestSessions();
  if (!first.error) return first;
  if (!(await ensureServerRunning(true))) return first;
  return requestSessions();
}

async function fetchSystem(): Promise<SystemEfficiencySnapshot | undefined> {
  const resp = await relayFetch(`${apiBase()}/system/live`);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();
  if (!isSystemEfficiencySnapshot(data.system)) throw new Error("invalid system response");
  return data.system;
}

async function fetchHealth(): Promise<any> {
  return fetchRelayHealth(relayFetch, `${apiBase()}/health`);
}

async function fetchWebStatus(): Promise<boolean> {
  const data = await fetchHealth();
  return data?.service === "sessionbar" && data?.web === true;
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let warnedStartupEnvironment = false;

async function waitForReady(attempts = 15): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    try {
      const state = readRuntimeState(HOME);
      if (state?.port) {
        const health = await fetchRelayHealth(relayFetch, `http://${API_HOST}:${state.port}/health`);
        if (
          health?.service === "sessionbar"
          && health?.pid === state.pid
          && health?.port === state.port
          && health.build_id === currentBuildId()
        ) {
          PORT = health.port;
          if (!warnedStartupEnvironment && readRelayConfigMatch(HOME, process.env, state.pid, health.config_revision) === false) {
            warnedStartupEnvironment = true;
            console.error("Running Relay keeps its startup environment; use sessionbar restart to apply changes.");
          }
          return true;
        }
      }
    } catch { /* retry */ }
    await delay(i === 0 ? 300 : 150); // first poll waits for spawned process to boot
  }
  return false;
}

async function ensureServerRunning(quiet = false): Promise<boolean> {
  ensureDir();
  if (await waitForReady(1)) return true;
  if (pidAlive()) {
    if (await waitForReady(4)) return true;
    // A live PID without a reachable API or matching build is not useful. Restart the build.
    // only after bounded retries rule out a transient sleep or scheduling gap.
    if (!await restartServerProcess(quiet)) return false;
  }
  if (!await startServer(quiet)) return false;
  return waitForReady();
}

// Hook registration belongs to an open SessionBar app, not to the relay
// itself. Service-only commands can therefore start or inspect the relay
// without adding work to every agent harness invocation.
async function ensureAppRunning(quiet = false): Promise<boolean> {
  const ready = await ensureServerRunning(quiet);
  if (ready) {
    acquireAppClient(HOME);
    await injectHooksOnServerReady(true);
  }
  return ready;
}

async function releaseAppHooks(global = true, quiet = true): Promise<void> {
  if (!releaseAppClient(HOME)) return;
  teardownHooks(global, quiet);
  try {
    await relayFetch(`${apiBase()}/lifecycle/unobserved`, { method: "POST" });
  } catch { /* relay is already unavailable */ }
}

function isBunRuntime(): boolean {
  return !!(process.versions as Record<string, string | undefined>).bun;
}

function bunMonitorArgs(view: MonitorView): string[] {
  const base = cmd === "monitor" || cmd === "watch" ? args : ["monitor", ...args.filter(arg => arg.startsWith("--"))];
  const clean = base.filter((arg, index) => arg !== "--view" && !arg.startsWith("--view=") && base[index - 1] !== "--view");
  return [...clean, "--view", view];
}

async function relaunchMonitorWithBun(view: MonitorView): Promise<boolean> {
  if (isBunRuntime() || process.env.SESSIONBAR_BUN_REEXEC === "1") return false;
  return new Promise((resolve, reject) => {
    const proc = spawn("bun", [fileURLToPath(import.meta.url), ...bunMonitorArgs(view)], {
      stdio: "inherit",
      env: { ...process.env, SESSIONBAR_BUN_REEXEC: "1", SESSIONBAR_NODE_EXEC_PATH: process.execPath },
    });
    proc.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") resolve(false);
      else reject(err);
    });
    proc.on("exit", (code) => {
      process.exitCode = code ?? 0;
      resolve(true);
    });
  });
}

function isOpenTuiRuntimeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("OpenTUI native FFI is not available") || message.includes("Failed to initialize OpenTUI render library");
}

async function openWebDashboard() {
  useWeb = true;
  if (!await ensureServerRunning()) {
    console.error("Server failed to start.");
    return;
  }
  await injectHooksOnServerReady(true);
  openBrowser(apiBase());
}

// ANSI codes — auto-disabled if terminal lacks color support
// Respects NO_COLOR (https://no-color.org), TERM=dumb, and non-TTY output
const _COLOR = !process.env.NO_COLOR && process.env.TERM !== "dumb" && !!process.stdout.isTTY;
const _TTY = !!process.stdout.isTTY; // gate screen-control sequences (cursor, clear) for pipe/redirect
const _THEME = terminalAnsiTheme(_COLOR);
const _B = _THEME.bold;
const _D = _THEME.reset;
const _K = _THEME.muted;
const _GN = _THEME.working;
const _YL = _THEME.blocked;
const _RD = _THEME.error;

const S = {
  working: { c: _GN, icon: "●", label: "RUNNING" },
  idle:    { c: _THEME.idle, icon: "○", label: "IDLE" },
  blocked: { c: _YL, icon: "◈", label: "AWAITING" },
  error:   { c: _RD, icon: "▲", label: "ERROR" },
};

function pad(s: string, n: number): string {
  return s + " ".repeat(Math.max(0, n - stripAnsi(s)));
}

function age(timestamp: number): string {
  return formatAge(timestamp);
}

function agentName(type: string, max = 12): string {
  const name = compactAgentName(type);
  return name.length > max ? `${name.slice(0, Math.max(0, max - 1))}…` : name;
}

function projectLabel(session: any): string {
  return sessionProjectName(session);
}

function statusShort(status: string): string {
  return statusLabel(status);
}

// Stable one-shot output for `status` and non-TTY monitor invocations.
// Interactive layout belongs exclusively to OpenTUI.
function render(sessions: any[], _frame = 0, errorMsg?: string): void {
  if (errorMsg) console.error(errorMsg);
  const ordered = [...sessions].sort((a, b) => {
    const projectOrder = projectLabel(a).localeCompare(projectLabel(b));
    return projectOrder || sessionDisplayName(a).localeCompare(sessionDisplayName(b));
  });
  const projects = new Map<string, any[]>();
  for (const session of ordered) {
    const project = projectLabel(session);
    const rows = projects.get(project) ?? [];
    rows.push(session);
    projects.set(project, rows);
  }

  console.log(`${sessions.length} session${sessions.length === 1 ? "" : "s"} · ${projects.size} project${projects.size === 1 ? "" : "s"}`);
  for (const [project, rows] of projects) {
    console.log(`${_B}${project}${_D}`);
    for (const session of rows) {
      const style = S[session.status as keyof typeof S] || S.idle;
      const state = `${style.c}${style.icon} ${statusShort(session.status)}${_D}`;
      const name = sessionDisplayName(session);
      const agent = agentName(session.session_type || "?");
      console.log(`  ${pad(state, 10)} ${pad(agent, 14)} ${name} ${_K}${age(session.timestamp || Date.now())}${_D}`);
    }
  }
}

// ── watch() — full-screen interactive TUI ──

// ── SSE stream reader ──

async function startSSE(signal: AbortSignal): Promise<ReadableStreamDefaultReader<string> | null> {
  try {
    const resp = await relayFetch(`${apiBase()}/sessions/stream`, { signal });
    if (!resp.ok || !resp.body) return null;
    const reader = resp.body
      .pipeThrough(new TextDecoderStream())
      .getReader();
    return reader;
  } catch { return null; }
}

function monitorViewArg(): MonitorView {
  const view = argValue("--view");
  return view === "agents" || view === "providers" ? view : "sessions";
}

async function watch(initialView: MonitorView = monitorViewArg()) {
  if (!process.stdout.isTTY) {
    const result = await fetchSessions();
    render(result.sessions, 0, result.error);
    return;
  }

  if (await relaunchMonitorWithBun(initialView)) return;

  // SSE-aware fetch wrapper: toggles between REST polling and SSE push
  let sse = false;
  let sseTransport: SSETransport<any[]> | null = null;

  const closeSSETransport = () => {
    sseTransport?.close();
    sseTransport = null;
  };

  const sseToggleFetch: typeof fetchSessions = async () => {
    if (!sse) return fetchSessions();
    if (!sseTransport) sseTransport = createSSETransport(startSSE);
    const data = await sseTransport.next(tuiRenderMs);
    if (data === "closed") { closeSSETransport(); sse = false; return { sessions: [], error: "SSE lost" }; }
    if (data === "timeout") return { sessions: [], unchanged: true };
    return { sessions: data as any[], error: undefined };
  };

  const toggleSSE = (): boolean => {
    sse = !sse;
    if (!sse) closeSSETransport();
    return sse;
  };

  try {
    const { runOpenTuiMonitor } = await import("../tui/openTuiMonitor.js");
    await runOpenTuiMonitor({
      fetchSessions: sseToggleFetch,
      fetchSystem,
      initialView,
      agentRequest: (input, init) => {
        const path = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        return relayFetch(new URL(path, apiBase()).href, init);
      },
      fetchProviders: async () => {
        const resp = await relayFetch(`${apiBase()}/providers/live`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        if (data.initializing) throw new Error("Initializing...");
        return Array.isArray(data?.providers) ? data.providers : [];
      },
      openWebDashboard,
      renderMs: tuiRenderMs,
      pollMs: tuiPollMs,
      backgroundPollMs: 10_000,
      port: PORT,
      getPort: refreshRuntimePort,
      apiHost: API_HOST,
      stateDir: HOME,
      animate: animateTui,
      toggleSSE,
      isSSE: () => sse,
      closeTransport: closeSSETransport,
    });
  } catch (error) {
    if (!isOpenTuiRuntimeError(error)) throw error;
    console.error("OpenTUI monitor requires Bun's native FFI runtime. Install Bun or run: bun dist/cli/cli.js monitor");
    process.exitCode = 1;
  } finally {
    closeSSETransport();
  }
  return;
}

async function ask(q: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(q, ans => { rl.close(); resolve(ans); }));
}

async function setup() {
  const isGlobal = args.includes("--global") || args.includes("--focus-global")
    ? true
    : args.includes("--project") || args.includes("--local") || args.includes("--focus-local")
      ? false
      : null;
  if (isGlobal !== null) {
    await setupHooks(isGlobal);
    return;
  }
  console.log("SessionBar service starts automatically when the app opens.\nSetup configures supported local agent hooks: Claude Code, Codex, Gemini CLI, and Copilot.\n");
  console.log("Local focus uses this project's agent config files; global focus uses home agent config files.");
  const focus = await promptSetupFocus();
  if (focus === "cancel") return;
  await setupHooks(focus === "global");
}

function renderHarnessAvailability(rows: HarnessRegistryEntry[]) {
  const widths = {
    name: Math.max(7, ...rows.map(row => row.name.length)),
    status: 9,
    kind: Math.max(4, ...rows.map(row => row.kind.length)),
    signal: Math.max(6, ...rows.map(row => harnessSignal(row).length)),
  };
  const line = (name: string, status: string, kind: string, signal: string, detail: string) =>
    `${pad(name, widths.name)}  ${pad(status, widths.status)}  ${pad(kind, widths.kind)}  ${pad(signal, widths.signal)}  ${detail}`;

  console.log(line("Harness", "Status", "Kind", "Signal", "Detail"));
  console.log(line("-".repeat(widths.name), "-".repeat(widths.status), "-".repeat(widths.kind), "-".repeat(widths.signal), "------"));
  for (const row of rows) {
    console.log(line(row.name, row.available ? "yes" : "no", row.kind, harnessSignal(row), harnessDetail(row)));
  }
}

function harnessSignal(row: HarnessRegistryEntry): string {
  return row.commandFound || row.commands.join(", ");
}

function harnessDetail(row: HarnessRegistryEntry): string {
  return `${row.configPath || ""}${row.configExists ? "" : " (missing)"}`;
}

function harnesses() {
  renderHarnessAvailability(detectHarnessAvailability());
}

function argValue(name: string): string | undefined {
  const prefix = `${name}=`;
  const inline = args.find(arg => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

// ---- Landing menu wiring -----------------------------------------------

function buildLandingDeps(): LandingMenuDeps {
  return {
    tty: _TTY,
    colorEnabled: _COLOR,
    animateLogo: !noAnim && process.env.SESSIONBAR_ANIMATE !== "0",
    formatAge: (ts) => age(ts),
    agentName,
    projectLabel,
    statusShort,
    statusStyle: (status) => S[status as keyof typeof S] || S.idle,
    ensureAppRunning,
    fetchSessions,
    fetchWebStatus,
    pidAlive,
    launchMonitor: watch,
    launchCommand: async command => {
      if (command === "harnesses") harnesses();
      await ask("\nPress enter...");
    },
    launchSetup: async () => {
      console.log("\nSessionBar service starts automatically when the app opens.");
      console.log("Setup chooses local or global reporting for supported harnesses.\n");
      const focus = await promptSetupFocus();
      if (focus === "cancel") return;
      await setupHooks(focus === "global");
      await ask("\nPress enter...");
    },
    launchStatus: async (sessions) => {
      console.log();
      try { render(sessions, 0); } catch { /* render failed */ }
      await ask("");
    },
    launchWeb: openWebDashboard,
    launchSettings: async () => {
      const current = readSettings(HOME);
      console.log("\nSessionBar settings\n");
      console.log(`1. Auto-consume reset cards  [${current.autoConsumeResetCards ? "ON" : "OFF"}]`);
      console.log("   Consume the nearest OpenAI/Codex reset card when it has 5 minutes left.");
      console.log("   This can spend a real provider credit. Default: OFF.\n");
      const choice = await ask("[1] Toggle  |  [Enter] Back\n> ");
      if (choice.trim() === "1") {
        if (!current.autoConsumeResetCards) {
          const confirmation = await ask("Type ENABLE to allow real reset-card consumption, or press enter to cancel.\n> ");
          if (confirmation.trim() !== "ENABLE") {
            console.log("\nUnchanged: auto-consume reset cards remains OFF.");
            await ask("Press enter...");
            return;
          }
        }
        const next = updateSettings(HOME, { autoConsumeResetCards: !current.autoConsumeResetCards });
        console.log(`\nAuto-consume reset cards: ${next.autoConsumeResetCards ? "ON" : "OFF"}`);
        try {
          await relayFetch(`${apiBase()}/providers/refresh`, { method: "POST" });
        } catch { /* the next provider poll will pick up the setting */ }
        await ask("Press enter...");
      }
    },
    teardownHooks: releaseAppHooks,
    getPort: refreshRuntimePort,
  };
}
async function status() {
  ensureDir();
  let result = await fetchSessions();
  if (result.error?.startsWith("EPERM:")) {
    console.error(`Server unreachable: ${result.error}`);
    return;
  }
  if (result.error && !pidAlive()) {
    console.log("Server not running. Starting...");
    if (!await startServer() || !(await waitForReady())) {
      console.error("Server failed to start.");
      return;
    }
    result = await fetchSessions();
  }
  if (result.error) {
    console.error(`Server unreachable: ${result.error}`);
    return;
  }
  if (result.sessions.length === 0) {
    console.log("No active sessions.\n");
  } else {
    render(result.sessions, 0, result.error);
  }
}

function pruneMaxAgeMs(): number {
  const explicit = args.find(arg => arg.startsWith("--max-age-ms="))?.slice("--max-age-ms=".length);
  const raw = explicit || process.env.SESSIONBAR_PRUNE_MS || "300000";
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 300_000;
}

async function pruneMarkers(): Promise<void> {
  ensureDir();
  if (pidAlive()) {
    if (!await stopServer()) { process.exitCode = 1; return; }
  }
  const maxAgeMs = pruneMaxAgeMs();
  const result = pruneSessionMarkerFiles(SESSION_ID_DIR, { maxAgeMs });
  console.log(`Pruned ${result.removed.length} stale session marker${result.removed.length === 1 ? "" : "s"} older than ${Math.round(maxAgeMs / 1000)}s.`);
  for (const item of result.removed) {
    console.log(`- ${item.file}`);
  }
}

async function main() {
  switch (cmd) {
    case "trace": {
      const nativeArgs = args.slice(2);
      if (args[1] !== "codex" || !isCodexTraceInvocation(nativeArgs)) {
        console.error("Usage: sessionbar trace codex exec --json [Codex arguments]\n       sessionbar trace codex app-server --listen stdio://");
        process.exitCode = 2; break;
      }
      process.exitCode = await traceCodex({ binary: process.env.SESSIONBAR_CODEX_BIN || process.env.CODEX_APP_RUNTIME_CLI_PATH || "codex", args: nativeArgs,
        cwd: process.cwd(), eventsRoot: process.env.SESSIONBAR_CODEX_EVENTS_DIR || join(HOME, "codex-events") });
      break;
    }
    case "web":
      useWeb = true;
      ensureDir();
      if (!await ensureServerRunning()) {
        console.error("Server failed to start.");
        process.exitCode = 1;
        break;
      }
      await injectHooksOnServerReady(true);
      console.log(`SessionBar server started on :${PORT}`);
      console.log(`Dashboard: ${apiBase()}`);
      openBrowser(apiBase());
      break;
    case "start":
      if (await waitForReady(1)) { console.log("Already running."); break; }
      if (!await ensureServerRunning()) {
        console.error("Server failed to start.");
        process.exitCode = 1;
        break;
      }
      console.log(`SessionBar server started on :${PORT}`);
      if (useWeb) console.log(`Dashboard: ${apiBase()}`);
      break;
    case "stop":
      if (!await stopServer()) process.exitCode = 1;
      break;
    case "restart":
      if (!await restartServerProcess() || !await startServer() || !await waitForReady()) {
        console.error("Server failed to restart.");
        process.exitCode = 1;
        break;
      }
      console.log(`SessionBar server restarted on :${PORT}`);
      break;
    case "prune":
      await pruneMarkers();
      break;
    case "setup":
      await setup();
      break;
    case "harnesses":
    case "harness":
      harnesses();
      break;
    case "status":
      await status();
      break;
    case "watch":
    case "monitor":
    case "providers":
    case "agents":
      if (!await ensureAppRunning()) {
        console.error("Server failed to start.");
        process.exitCode = 1;
        break;
      }
      try {
        await watch(cmd === "providers" || cmd === "agents" ? cmd : monitorViewArg());
      } finally {
        await releaseAppHooks(true, true);
      }
      break;
    default:
      await runLandingMenu(buildLandingDeps());
  }
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
