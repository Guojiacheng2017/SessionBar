#!/usr/bin/env node

import { execSync, spawn } from "child_process";
import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync, openSync, closeSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { createInterface } from "readline";
import { runOpenTuiMonitor } from "./openTuiMonitor.js";
import { pruneSessionMarkerFiles } from "./sessionMarkers.js";
import {
  setupHooks,
  teardownHooks,
  injectHooksOnServerReady,
} from "./hookManager.js";
import { sessionDisplayName, stripAnsi, truncateAnsi } from "./displayUtils.js";
import { aggregateRuntimeUsage, formatRuntimeBytes, runtimeProgressBar } from "./runtimeUsage.js";
import type { SystemEfficiencySnapshot } from "./types.js";
import {
  createRainbow,
  panelTop as _panelTop,
  panelBot as _panelBot,
  panelRow as _panelRow,
  runLandingMenu,
  type LandingMenuDeps,
} from "./landingMenu.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOME = process.env.SESSIONBAR_HOME || process.env.AGENTBAR_HOME || join(homedir(), ".sessionbar");
const PID_FILE = join(HOME, "server.pid");
const LOG_FILE = join(HOME, "server.log");
const SESSION_ID_DIR = join(HOME, "sessions");
const PORT = parseInt(process.env.PORT || "8989", 10);
const API_HOST = process.env.SESSIONBAR_HOST || "127.0.0.1";
const API_BASE = `http://${API_HOST}:${PORT}`;
const API = `${API_BASE}/sessions/live`;

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
  if (!existsSync(HOME)) mkdirSync(HOME, { recursive: true });
  if (!existsSync(SESSION_ID_DIR)) mkdirSync(SESSION_ID_DIR, { recursive: true });
}

function pidAlive(): boolean {
  try {
    const raw = readFileSync(PID_FILE, "utf-8").trim();
    const pid = parseInt(raw.split("|")[0], 10);
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

function startServer(quiet = false): boolean {
  ensureDir();
  if (pidAlive()) return true;
  const js = join(__dirname, "server.js");
  if (!existsSync(js)) {
    console.error(`Server binary not found: ${js}`);
    return false;
  }
  let fd: number;
  try {
    fd = openSync(LOG_FILE, "a");
  } catch (e: any) {
    if (!quiet) console.error(`Cannot open server log: ${e?.message || e}`);
    return false;
  }
  const env: Record<string, string> = { ...process.env, PORT: String(PORT) };
  if (useICloud) env.SESSIONBAR_ICLOUD = "1";
  if (useWeb) env.SESSIONBAR_WEB = "1";
  try {
    const proc = spawn("node", [js], { detached: true, stdio: ["ignore", fd, fd], env });
    proc.unref();
    // Write a provisional PID; callers poll the API before reporting success.
    writeFileSync(PID_FILE, `${proc.pid}|node|${Date.now()}`);
    return true;
  } catch (e: any) {
    if (!quiet) console.error(`Cannot start server: ${e?.message || e}`);
    return false;
  } finally {
    try { closeSync(fd); } catch { /* */ }
  }
}

function stopServer(quiet = false) {
  if (!existsSync(PID_FILE)) { if (!quiet) console.log("Not running."); return; }
  teardownHooks(true, quiet);
  try {
    process.kill(parseInt(readFileSync(PID_FILE, "utf-8").trim().split("|")[0], 10), "SIGTERM");
    if (!quiet) console.log("Stopped.");
  } catch { /* */ }
  try { unlinkSync(PID_FILE); } catch { /* */ }
}

async function fetchSessions(): Promise<{ sessions: any[], error?: string }> {
  try {
    const resp = await fetch(API);
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

function isSystemEfficiencySnapshot(value: unknown): value is SystemEfficiencySnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Record<string, unknown>;
  const load = snapshot.load_average;
  const requiredNumbers = [
    snapshot.memory_used_bytes,
    snapshot.memory_total_bytes,
    snapshot.memory_percent,
    snapshot.server_memory_bytes,
    snapshot.sampled_at,
  ];
  const optionalNumbers = [
    snapshot.cpu_percent,
    snapshot.network_down_bytes_per_second,
    snapshot.network_up_bytes_per_second,
    snapshot.server_cpu_percent,
  ];
  return Array.isArray(load)
    && load.length === 3
    && load.every(item => typeof item === "number" && Number.isFinite(item))
    && requiredNumbers.every(item => typeof item === "number" && Number.isFinite(item))
    && optionalNumbers.every(item => item === undefined || (typeof item === "number" && Number.isFinite(item)));
}

async function fetchSystem(): Promise<SystemEfficiencySnapshot | undefined> {
  const resp = await fetch(`${API_BASE}/system/live`);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();
  return isSystemEfficiencySnapshot(data.system) ? data.system : undefined;
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function waitForReady(attempts = 30): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    try { const r = await fetch(API); if (r.ok) return true; } catch { /* */ }
    await delay(100);
  }
  return false;
}

async function ensureServerRunning(quiet = false): Promise<boolean> {
  ensureDir();
  if (await waitForReady(1)) return true;
  if (pidAlive()) {
    // A live PID without a reachable API is not useful for the app. Restart it
    // so opening SessionBar consistently brings up the service.
    stopServer(true);
    await delay(300);
  }
  if (!startServer(quiet)) return false;
  return waitForReady();
}

// Hook registration belongs to an open SessionBar app, not to the relay
// itself. Service-only commands can therefore start or inspect the relay
// without adding work to every agent harness invocation.
async function ensureAppRunning(quiet = false): Promise<boolean> {
  const ready = await ensureServerRunning(quiet);
  if (ready) await injectHooksOnServerReady(true);
  return ready;
}

function isBunRuntime(): boolean {
  return !!(process.versions as Record<string, string | undefined>).bun;
}

function bunMonitorArgs(): string[] {
  if (cmd === "monitor" || cmd === "watch") return args;
  return ["monitor", ...args.filter(arg => arg.startsWith("--"))];
}

async function relaunchMonitorWithBun(): Promise<boolean> {
  if (isBunRuntime() || process.env.SESSIONBAR_BUN_REEXEC === "1") return false;
  return new Promise((resolve, reject) => {
    const proc = spawn("bun", [fileURLToPath(import.meta.url), ...bunMonitorArgs()], {
      stdio: "inherit",
      env: { ...process.env, SESSIONBAR_BUN_REEXEC: "1" },
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
  if (!useWeb) {
    useWeb = true;
    if (pidAlive()) stopServer(true);
    await delay(300);
    startServer();
    if (await waitForReady()) await injectHooksOnServerReady(true);
  }
  spawn("open", [API_BASE], { detached: true, stdio: "ignore" }).unref();
}

// ANSI codes — auto-disabled if terminal lacks color support
// Respects NO_COLOR (https://no-color.org), TERM=dumb, and non-TTY output
const _COLOR = !process.env.NO_COLOR && process.env.TERM !== "dumb" && !!process.stdout.isTTY;
const _TTY = !!process.stdout.isTTY; // gate screen-control sequences (cursor, clear) for pipe/redirect
const _B = _COLOR ? "\x1b[1m" : "";
const _D = _COLOR ? "\x1b[0m" : "";
const _K = _COLOR ? "\x1b[38;5;245m" : ""; // explicit gray (~#8a8a8a) replacing dim for WCAG contrast
const _BL = _COLOR ? "\x1b[34m" : "";
const _GN = _COLOR ? "\x1b[32m" : "";
const _YL = _COLOR ? "\x1b[33m" : "";
const _RD = _COLOR ? "\x1b[1;31m" : ""; // bold red for WCAG 1.4.3 contrast minimum
const _CY = _COLOR ? "\x1b[36m" : "";

let CC = {
  B: _B, D: _D, K: _K, BL: _BL, GN: _GN, YL: _YL, RD: _RD, CY: _CY,
};

const S = {
  working: { c: _BL, icon: "●", label: "RUNNING" },
  idle:    { c: _GN, icon: "○", label: "IDLE" },
  blocked: { c: _YL, icon: "◈", label: "AWAITING" },
  error:   { c: _RD, icon: "▲", label: "ERROR" },
};

function pad(s: string, n: number): string {
  return s + " ".repeat(Math.max(0, n - stripAnsi(s)));
}

function truncateText(s: string, max: number): string {
  if (max <= 0) return "";
  if (s.length <= max) return s;
  if (max === 1) return "…";
  return s.slice(0, max - 1) + "…";
}

function tailText(s: string, max: number): string {
  if (max <= 0) return "";
  if (s.length <= max) return s;
  if (max <= 2) return s.slice(-max);
  return "…" + s.slice(-(max - 1));
}

function age(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 10) return `${CC.CY}now`;  // caller appends _D
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

function extractProject(s: any): string {
  // Use explicit project field from payload if available
  if (s.project) return s.project;
  // Derive from full path if available
  if (s.project_path) {
    const parts = s.project_path.split("/");
    return parts[parts.length - 1] || s.project_path;
  }
  const sid = s.session_id || "";
  // Embedded format: {uuid}__{project}
  const sep = sid.indexOf("__");
  if (sep !== -1) return sid.slice(sep + 2);
  // Legacy format: "{type}-{project}-{pid}-{random}"
  const cleaned = sid.replace(/^(claude|gemini|codex|copilot|opencode|pi-agent|pi|kimi|qwen|deepseek|windsurf|cursor|workbuddy|minimax)-/, "");
  const parsed = cleaned.replace(/-\d+-\d+$/, "");
  // If parsed is a UUID (contains only hex + dashes), project is unknown
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(parsed)) {
    return s.project_path || "unknown";
  }
  return parsed || sid;
}

function pathTail(path: string): string {
  const parts = path.replace(/\/+$/, "").split("/").filter(Boolean);
  return parts.at(-1) || path;
}

function rawProjectPath(s: any): string {
  return typeof s.project_path === "string" ? s.project_path.trim() : "";
}

function compactUserPath(path: string): string {
  const clean = path.replace(/\/+$/, "") || path;
  const home = homedir().replace(/\/+$/, "");
  return clean === home ? "~" : clean.startsWith(`${home}/`) ? `~${clean.slice(home.length)}` : clean;
}

function projectKey(s: any): string {
  const path = rawProjectPath(s);
  return path ? `path:${compactUserPath(path)}` : `name:${projectLabel(s)}`;
}

function projectLabel(s: any): string {
  return s.project || extractProject(s);
}

function projectPathLabel(s: any): string {
  return s.project_path || projectLabel(s);
}

function uniqueProjectPathsByName(sessions: any[]): Map<string, string> {
  const paths = new Map<string, Set<string>>();
  for (const s of sessions) {
    const path = rawProjectPath(s);
    if (!path) continue;
    const name = s.project || pathTail(path);
    if (!paths.has(name)) paths.set(name, new Set());
    paths.get(name)!.add(compactUserPath(path));
  }
  const unique = new Map<string, string>();
  for (const [name, values] of paths.entries()) {
    if (values.size === 1) unique.set(name, [...values][0]!);
  }
  return unique;
}

function projectGroupKey(s: any, uniquePaths: Map<string, string>): string {
  const path = rawProjectPath(s);
  if (path) return `path:${compactUserPath(path)}`;
  const name = projectLabel(s);
  const inferred = uniquePaths.get(name);
  return inferred ? `path:${inferred}` : `name:${name}`;
}

function projectPathSummary(sessions: any[]): string {
  if (sessions.length === 0) return "unknown";
  const paths = [...new Set(sessions.map(rawProjectPath).filter(Boolean).map(compactUserPath))];
  if (paths.length === 0) return projectPathLabel(sessions[0]);
  return paths.length === 1 ? paths[0]! : `${paths[0]} +${paths.length - 1}`;
}

function statusStyle(status: string) {
  return S[status as keyof typeof S] || S.idle;
}

function statusShort(status: string): string {
  if (status === "working") return "WORK";
  if (status === "blocked") return "WAIT";
  if (status === "error") return "ERR";
  return "IDLE";
}

function statusCounts(sessions: any[]) {
  let working = 0, idle = 0, blocked = 0, errored = 0;
  for (const s of sessions) {
    if (s.status === "working") working++;
    else if (s.status === "blocked") blocked++;
    else if (s.status === "error") errored++;
    else idle++;
  }
  return { working, idle, blocked, errored, total: sessions.length };
}

function inlineStatus(sessions: any[]): string {
  const c = statusCounts(sessions);
  const parts = [
    c.working > 0 ? `${_BL}${c.working} work${_D}` : "",
    c.blocked > 0 ? `${_YL}${c.blocked} wait${_D}` : "",
    c.errored > 0 ? `${_RD}${c.errored} err${_D}` : "",
    c.idle > 0 ? `${_GN}${c.idle} idle${_D}` : "",
  ].filter(Boolean);
  return parts.join(` ${_K}·${_D} `) || `${_K}none${_D}`;
}

function cell(s: string, w: number): string {
  return pad(truncateAnsi(s, w, _D), w);
}

function rightCell(s: string, w: number): string {
  const clipped = truncateAnsi(s, w, _D);
  return " ".repeat(Math.max(0, w - stripAnsi(clipped))) + clipped;
}

function displayPath(p: string, max: number): string {
  const home = homedir();
  const compact = p.startsWith(home) ? `~${p.slice(home.length)}` : p;
  return tailText(compact, max);
}

function agentName(t: string, max = 12): string {
  const compact = (t || "?")
    .replace(/\s+Code$/i, "")
    .replace(/\s+CLI$/i, "")
    .replace(/\s+/g, " ");
  return truncateText(compact, max);
}

function rawSessionId(s: any): string {
  return String(s.session_id || "").split("__")[0] || "?";
}

function sessionShortId(s: any, max = 8): string {
  const cleaned = rawSessionId(s).replace(/^(claude|codex|gemini|copilot|opencode|pi-agent|pi|kimi|qwen|deepseek|windsurf|cursor|workbuddy|minimax)-/i, "");
  const scoped = /-([0-9a-f]{8})$/i.exec(cleaned);
  if (scoped) {
    if (max <= 12) return scoped[1].slice(0, max);
    const prefixW = Math.max(1, max - 9);
    return truncateText(`${cleaned.slice(0, prefixW)}-${scoped[1]}`, max);
  }
  return truncateText(cleaned, max);
}

function firstFiniteNumber(...values: any[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function compactNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(Math.round(n));
}

function sessionContextPercent(s: any): number | undefined {
  const raw = firstFiniteNumber(s.context_percent, s.context_pct, s.context);
  if (raw === undefined) return undefined;
  const pct = raw <= 1 && raw >= 0 ? raw * 100 : raw;
  return Math.max(0, Math.min(100, pct));
}

function sessionStatsText(s: any, max = 18): string {
  const context = sessionContextPercent(s);
  const tokens = firstFiniteNumber(s.tokens, s.token_count, s.total_tokens);
  const turns = firstFiniteNumber(s.turns, s.turn_count);
  const parts = [
    context === undefined ? `${_K}ctx --${_D}` : `${Math.round(context)}% ctx`,
    tokens === undefined ? `${_K}tok --${_D}` : `${compactNumber(tokens)} tok`,
    turns === undefined ? `${_K}turn --${_D}` : `${Math.round(turns)} turn`,
  ];
  return truncateAnsi(parts.join(` ${_K}·${_D} `), max, _D);
}

function sessionHealth(sessions: any[]) {
  if (sessions.length === 0) {
    return { score: 0, icon: "○", color: _K, label: "waiting for sessions" };
  }
  const now = Date.now();
  const counts = statusCounts(sessions);
  const stale = sessions.filter((s: any) => now - (s.timestamp || 0) > 120_000).length;
  const contextRisk = sessions.filter((s: any) => {
    const pct = sessionContextPercent(s);
    return pct !== undefined && pct >= 85;
  }).length;
  const penalty = counts.errored * 35 + counts.blocked * 20 + stale * 10 + contextRisk * 8;
  const score = Math.max(0, Math.min(100, 100 - penalty));
  if (counts.errored > 0) return { score, icon: "▲", color: _RD, label: `${counts.errored} session error` };
  if (counts.blocked > 0) return { score, icon: "◈", color: _YL, label: `${counts.blocked} blocked` };
  if (contextRisk > 0) return { score, icon: "◆", color: _YL, label: `${contextRisk} high context` };
  if (stale > 0) return { score, icon: "○", color: _K, label: `${stale} stale` };
  if (counts.working > 0) return { score, icon: "●", color: _BL, label: `${counts.working} working` };
  return { score, icon: "●", color: _GN, label: "stable" };
}

function agentIcons(sessions: any[], max = 10): string {
  const counts = new Map<string, number>();
  for (const s of sessions) {
    const type = s.session_type || "?";
    counts.set(type, (counts.get(type) || 0) + 1);
  }
  const out = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([_type, count]) => `${count > 1 ? count : ""}`)
    .join(" ");
  return truncateText(out, max);
}

function latestTimestamp(sessions: any[]): number {
  return sessions.length > 0
    ? Math.max(...sessions.map((s: any) => s.timestamp || 0))
    : Date.now();
}

function projectTableLayout(w: number) {
  const available = Math.max(42, w - 8);
  const marker = 2;
  const project = available >= 128 ? 24 : available >= 100 ? 20 : 16;
  const sessions = 8;
  const agents = available >= 112 ? 18 : 14;
  const status = available >= 112 ? 22 : 16;
  const ageW = 5;
  const gaps = 5;
  const path = Math.max(8, available - marker - project - sessions - agents - status - ageW - gaps);
  return { marker, project, sessions, agents, status, path, age: ageW };
}

function projectTableHeader(w: number): string {
  const c = projectTableLayout(w);
  return `${cell("", c.marker)}${cell(`${_B}Project${_D}`, c.project)} ${cell(`${_B}Sessions${_D}`, c.sessions)} ${cell(`${_B}Agents${_D}`, c.agents)} ${cell(`${_B}Status${_D}`, c.status)} ${cell(`${_B}Path${_D}`, c.path)} ${rightCell(`${_B}Age${_D}`, c.age)}`;
}

function projectTableRow(
  key: string,
  sessions: any[],
  cursorKey: string | null,
  focusKey: string | null,
  w: number,
): string {
  const c = projectTableLayout(w);
  const sample = sessions[0];
  const marker = key === focusKey ? `${_BL}●${_D}` : key === cursorKey ? `${_BL}>${_D}` : " ";
  const row = `${cell(marker, c.marker)}${cell(projectLabel(sample), c.project)} ${cell(String(sessions.length), c.sessions)} ${cell(agentIcons(sessions, c.agents), c.agents)} ${cell(inlineStatus(sessions), c.status)} ${cell(displayPath(projectPathSummary(sessions), c.path), c.path)} ${rightCell(`${_K}${age(latestTimestamp(sessions))}${_D}`, c.age)}`;
  return panelRow(key === cursorKey ? `${_B}${row}${_D}` : row, w);
}

function renderProjectsPanel(
  groups: Map<string, any[]>,
  cursorKey: string | null,
  focusKey: string | null,
  w: number,
  totalRows: number,
): string[] {
  const contentRows = Math.max(1, totalRows - 2);
  const lines = [panelTop("Projects", w, `${groups.size} project${groups.size !== 1 ? "s" : ""}`)];
  lines.push(panelRow(projectTableHeader(w), w));

  const entries = [...groups.entries()];
  if (entries.length === 0) {
    lines.push(panelRow(`${_K}No projects reporting yet${_D}`, w));
  } else {
    const selected = cursorKey ? entries.findIndex(([key]) => key === cursorKey) : 0;
    const safeSel = Math.max(0, selected);
    const rowSlots = Math.max(0, contentRows - 1);
    let offset = Math.max(0, safeSel - Math.floor(rowSlots / 2));
    offset = Math.min(offset, Math.max(0, entries.length - rowSlots));
    const hasOverflow = entries.length > rowSlots && rowSlots > 1;
    const visible = entries.slice(offset, offset + (hasOverflow ? rowSlots - 1 : rowSlots));
    for (const [key, ss] of visible) {
      lines.push(projectTableRow(key, ss, cursorKey, focusKey, w));
    }
    if (hasOverflow) {
      const hidden = entries.length - visible.length;
      lines.push(panelRow(`${_K}... ${hidden} more project${hidden !== 1 ? "s" : ""}${_D}`, w));
    }
  }

  while (lines.length < totalRows - 1) lines.push(panelRow("", w));
  lines.push(panelBot(w));
  return lines.slice(0, totalRows);
}

function renderProjectDetailsLines(
  scopeSessions: any[],
  allSessions: any[],
  w: number,
): string[] {
  const stats = computeStats(scopeSessions);
  const health = sessionHealth(scopeSessions);
  const sample = scopeSessions[0];
  if (!sample) {
    return [
      `${_B}PROJECT${_D} ${_K}none selected${_D}`,
      `${_K}Sessions${_D} 0`,
      `${_K}All sessions${_D} ${allSessions.length}`,
      "",
      `${_K}API${_D} ${API_HOST}:${PORT}`,
      `${_K}State${_D} ${displayPath(HOME, Math.max(8, w - 10))}`,
    ];
  }

  return [
    `${_B}PROJECT${_D} ${projectLabel(sample)}`,
    `${_K}path${_D} ${displayPath(projectPathSummary(scopeSessions), Math.max(8, w - 8))}`,
    `${_K}sessions${_D} ${stats.total}  ${_K}agents${_D} ${agentIcons(scopeSessions, Math.max(8, w - 22))}`,
    `${_K}status${_D} ${inlineStatus(scopeSessions)}`,
    `${_K}health${_D} ${health.color}${health.icon} ${String(health.score).padStart(3)}${_D} ${health.label}`,
    `${_K}latest${_D} ${age(latestTimestamp(scopeSessions))}${_D}`,
    "",
    `${_K}API${_D} ${API_HOST}:${PORT}`,
    `${_K}State${_D} ${displayPath(HOME, Math.max(8, w - 10))}`,
  ];
}

function renderRuntimeDetailsLines(sessions: any[], w: number): string[] {
  const usage = aggregateRuntimeUsage(sessions);
  const barWidth = Math.max(8, Math.min(18, Math.floor(w / 4)));
  const value = (number: number | undefined, suffix = "") => number === undefined ? "—" : `${Math.round(number)}${suffix}`;
  const lines = [
    `${_B}RUNTIME${_D} ${_K}all active sessions${_D}`,
    `${_K}active${_D} ${usage.activeSessions}  ${_K}sampled${_D} ${usage.sampledSessions}`,
    "",
    `${_K}CPU${_D}  ${value(usage.cpuPercent, "%")} ${runtimeProgressBar(usage.cpuPercent, 100, barWidth)}`,
    `${_K}GPU${_D}  ${usage.hasGpuData ? value(usage.gpuPercent, "%") : "—"} ${runtimeProgressBar(usage.gpuPercent, 100, barWidth)}`,
    `${_K}MEM${_D}  ${formatRuntimeBytes(usage.memoryBytes)} ${runtimeProgressBar(usage.memoryPercent, 100, barWidth)}`,
    `${_K}PROC${_D} ${value(usage.processCount)} ${runtimeProgressBar(usage.processCount, Math.max(16, usage.processCount || 16), barWidth)}`,
  ];
  if (usage.activeSessions === 0) lines.push("", `${_K}no active session resources${_D}`);
  else if (usage.sampledSessions === 0) lines.push("", `${_K}waiting for runtime samples${_D}`);
  return lines;
}

function renderDetailsPanel(
  scopeSessions: any[],
  allSessions: any[],
  selected: any | null,
  frame: number,
  w: number,
  totalRows: number,
  projectFocused: boolean,
): string[] {
  const title = selected ? "Details / Session" : projectFocused ? "Details / Project" : "Details / Runtime";
  const content = selected
    ? renderSelectedSessionLines(selected, frame, w)
    : projectFocused ? renderProjectDetailsLines(scopeSessions, allSessions, w) : renderRuntimeDetailsLines(allSessions, w);
  return panelBlock(title, w, content, Math.max(1, totalRows - 2));
}

function panelBlock(title: string, w: number, content: string[], rows: number, right?: string): string[] {
  const lines = [panelTop(title, w, right)];
  const visible = content.length > rows && rows > 0
    ? [...content.slice(0, rows - 1), `${_K}... ${content.length - rows + 1} more${_D}`]
    : content;
  for (let i = 0; i < rows; i++) lines.push(panelRow(visible[i] || "", w));
  lines.push(panelBot(w));
  return lines;
}

function composeColumns(columns: string[][]): string[] {
  const rows = Math.max(...columns.map(c => c.length));
  const out: string[] = [];
  for (let r = 0; r < rows; r++) out.push(columns.map(c => c[r] || "").join(" "));
  return out;
}

function sessionTableLayout(w: number) {
  const available = Math.max(42, w - 8);
  const marker = 2;
  const project = available >= 118 ? 22 : available >= 92 ? 18 : 14;
  const agent = available >= 118 ? 14 : available >= 92 ? 12 : 10;
  const session = available >= 104 ? 12 : 10;
  const status = available >= 92 ? 10 : 8;
  const stats = available >= 118 ? 20 : available >= 96 ? 14 : 10;
  const ageW = 5;
  const gaps = 6;
  const task = Math.max(8, available - marker - project - agent - session - status - stats - ageW - gaps);
  return { marker, project, agent, session, task, status, stats, age: ageW };
}

function sessionTableHeader(w: number): string {
  const c = sessionTableLayout(w);
  return `${cell("", c.marker)}${cell(`${_B}Project${_D}`, c.project)} ${cell(`${_B}Agent${_D}`, c.agent)} ${cell(`${_B}Name${_D}`, c.session)} ${cell(`${_B}Task${_D}`, c.task)} ${cell(`${_B}Status${_D}`, c.status)} ${cell(`${_B}Stats${_D}`, c.stats)} ${rightCell(`${_B}Age${_D}`, c.age)}`;
}

function sessionTableRow(s: any, frame: number, w: number, idx: number, selected: boolean): string {
  const c = sessionTableLayout(w);
  const style = statusStyle(s.status);
  const pulse = s.status === "working" ? PULSE(frame + idx) : style.icon;
  const marker = selected ? `${_BL}>${_D}` : " ";
  const project = projectLabel(s);
  const agent = `${agentName(s.session_type || "?", c.agent - 2)}`;
  const task = s.task_name || `${_K}no task reported${_D}`;
  const status = `${style.c}${pulse} ${statusShort(s.status)}${_D}`;
  const stats = sessionStatsText(s, c.stats);
  const row = `${cell(marker, c.marker)}${cell(project, c.project)} ${cell(agent, c.agent)} ${cell(sessionDisplayName(s), c.session)} ${cell(task, c.task)} ${cell(status, c.status)} ${cell(stats, c.stats)} ${rightCell(`${_K}${age(s.timestamp || Date.now())}${_D}`, c.age)}`;
  return panelRow(selected ? `${_B}${row}${_D}` : row, w);
}

function renderSelectedSessionLines(s: any, frame: number, w: number): string[] {
  const style = statusStyle(s.status);
  const pulse = s.status === "working" ? PULSE(frame) : style.icon;
  return [
    `${_B}PROJECT${_D} ${projectLabel(s)}  ${_K}·${_D}  ${displayPath(projectPathLabel(s), Math.max(10, w - 38))}`,
    `${_B}SESSION${_D} ${sessionShortId(s, 22)}  ${_K}·${_D}  ${agentName(s.session_type || "?", 16)}  ${_K}·${_D}  ${style.c}${pulse} ${statusShort(s.status)}${_D}  ${_K}updated${_D} ${age(s.timestamp || Date.now())}${_D}`,
    `${_K}task${_D} ${truncateAnsi(s.task_name || "no task reported", Math.max(8, w - 13), _D)}`,
    `${_K}stats${_D} ${sessionStatsText(s, Math.max(8, w - 10))}`,
    `${_K}id${_D} ${truncateText(String(s.session_id || "?"), Math.max(8, w - 9))}`,
  ];
}

function renderSessionsPanel(
  allSessions: any[],
  shown: any[],
  selectedIdx: number,
  selected: any | null,
  frame: number,
  w: number,
  totalRows: number,
  title: string,
  showDetail = true,
): string[] {
  const contentRows = Math.max(1, totalRows - 2);
  const lines = [panelTop(title, w, shown.length !== allSessions.length ? `${shown.length}/${allSessions.length}` : undefined)];

  const hasSelection = selectedIdx >= 0 && !!selected;
  const detail = showDetail && hasSelection && contentRows >= 10 ? renderSelectedSessionLines(selected, frame, w).slice(0, Math.min(5, contentRows - 6)) : [];
  const detailSpace = detail.length > 0 ? detail.length + 1 : 0;
  const tableRows = Math.max(0, contentRows - 1 - detailSpace);

  lines.push(panelRow(sessionTableHeader(w), w));
  if (shown.length === 0) {
    lines.push(panelRow(`${_K}No sessions match the current filter${_D}`, w));
    for (let i = 1; i < tableRows; i++) lines.push(panelRow("", w));
  } else {
    const safeSel = hasSelection ? Math.max(0, Math.min(selectedIdx, shown.length - 1)) : -1;
    let offset = Math.max(0, safeSel - Math.floor(tableRows / 2));
    offset = Math.min(offset, Math.max(0, shown.length - tableRows));
    const visible = shown.slice(offset, offset + tableRows);
    for (let i = 0; i < visible.length; i++) {
      const absolute = offset + i;
      lines.push(sessionTableRow(visible[i], frame, w, absolute, absolute === safeSel));
    }
    for (let i = visible.length; i < tableRows; i++) lines.push(panelRow("", w));
  }

  if (detail.length > 0) {
    lines.push(panelRow(`${_K}${"─".repeat(Math.max(1, w - 8))}${_D}`, w));
    for (const line of detail) lines.push(panelRow(line, w));
  }

  while (lines.length < totalRows - 1) lines.push(panelRow("", w));
  lines.push(panelBot(w));
  return lines.slice(0, totalRows);
}

// ── TUI helpers ──

const PULSE_FRAMES = ["●", "◉", "◎", "◉"]; // 4-frame pulse for working — never collides with idle ○
const PULSE = (i: number) => animateTui ? PULSE_FRAMES[i % PULSE_FRAMES.length] : "●";

function groupByProject(sessions: any[]): Map<string, any[]> {
  const groups = new Map<string, any[]>();
  const uniquePaths = uniqueProjectPathsByName(sessions);
  for (const s of sessions) {
    const proj = projectGroupKey(s, uniquePaths);
    if (!groups.has(proj)) groups.set(proj, []);
    groups.get(proj)!.push(s);
  }
  // Keep project order stable. Heartbeats should update age/status, not move rows.
  return new Map(
    [...groups.entries()].sort((a, b) =>
      projectLabel(a[1][0]).localeCompare(projectLabel(b[1][0])) || a[0].localeCompare(b[0])
    )
  );
}

interface SessionStats {
  working: number;
  idle: number;
  blocked: number;
  errored: number;
  total: number;
  groups: Map<string, any[]>;
  fingerprint: string;
}

function computeStats(sessions: any[]): SessionStats {
  let working = 0, idle = 0, blocked = 0, errored = 0;
  const ids: string[] = new Array(sessions.length);
  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    if (s.status === "working") working++;
    else if (s.status === "idle") idle++;
    else if (s.status === "blocked") blocked++;
    else if (s.status === "error") errored++;
    const timestampBucket = Math.floor((s.timestamp || 0) / tuiRenderMs);
    const context = sessionContextPercent(s);
    const tokens = firstFiniteNumber(s.tokens, s.token_count, s.total_tokens);
    const turns = firstFiniteNumber(s.turns, s.turn_count);
    ids[i] = [
      projectKey(s),
      s.session_id || "",
      s.session_type || "",
      s.status || "",
      s.task_name || "",
      timestampBucket,
      context === undefined ? "" : Math.round(context),
      tokens === undefined ? "" : Math.round(tokens),
      turns === undefined ? "" : Math.round(turns),
    ].join(":");
  }
  return {
    working, idle, blocked, errored,
    total: sessions.length,
    groups: groupByProject(sessions),
    fingerprint: ids.join("\x1f"),
  };
}

function layoutBudget(
  totalCols: number,
  termRows: number,
): {
  desktop: boolean;
  totalW: number;
  bodyRows: number;
} {
  const totalW = Math.max(40, totalCols - 4); // margin, no upper cap for wide terminals
  const desktop = totalW >= 100;
  const headerRows = 2;  // title + status bar
  const footerRows = 2;
  const bodyRows = Math.max(4, termRows - headerRows - footerRows);

  return { desktop, totalW, bodyRows };
}

// ── Right-panel content builders ──

function renderDetailLines(s: any, frame: number, w: number): string[] {
  const proj = extractProject(s);
  const style = S[s.status as keyof typeof S] || S.idle;
  const statusLabel = style.label || s.status;
  const pulseChar = s.status === "working" ? PULSE(frame % 4) : style.icon;
  const pathDisplay = tailText(s.project_path || proj, Math.max(8, w - 12));

  const lines: string[] = [
    `${_B}${s.session_type || "?"}${_D}`,
    `${_K}Project:${_D} ${proj}`,
    `${_K}Path:${_D} ${pathDisplay}`,
    `${pulseChar}  ${style.c}${statusLabel}${_D}  ${_K}·${_D}  ${s.task_name || ""}`,
    `${_K}Active:${_D} ${age(s.timestamp || Date.now())}${_D}`,
  ];

  if (s.progress !== undefined) {
    const pct = Math.round(s.progress * 100);
    const barW = Math.min(16, w - 16);
    const filled = Math.round(s.progress * barW);
    const bar = `${_BL}${"█".repeat(filled)}${_D}${_K}${"░".repeat(barW - filled)}${_D}`;
    lines.push(`${_K}Progress:${_D} ${bar} ${pct}%`);
  }

  lines.push(`${_K}ID:${_D} ${truncateText(s.session_id, Math.max(8, w - 10))}`);
  return lines;
}

function renderFrame(
  sessions: any[],
  frame: number,
  opts?: {
    selectedIdx?: number;
    detailId?: string | null;
    projectIdx?: number;
    projectCursorKey?: string | null;
    projectFocusKey?: string | null;
    filterText?: string;
    errorMsg?: string;
    stats?: SessionStats;
  }
) {
  const sel = opts?.selectedIdx ?? -1;
  const detailId = opts?.detailId ?? null;
  const projectIdx = opts?.projectIdx ?? 0;
  const projectFocusKey = opts?.projectFocusKey ?? null;
  const filterText = opts?.filterText ?? "";
  const errorMsg = opts?.errorMsg;
  const stats = opts?.stats ?? computeStats(sessions);
  const filterActive = filterText.length > 0;

  // Apply filter
  let shown = sessions;
  if (filterActive) {
    const q = filterText.toLowerCase();
    shown = sessions.filter((s: any) =>
      extractProject(s).toLowerCase().includes(q) ||
      sessionDisplayName(s).toLowerCase().includes(q) ||
      (s.task_name || "").toLowerCase().includes(q) ||
      (s.session_type || "").toLowerCase().includes(q)
    );
  }
  const shownGroups = groupByProject(shown);
  const projectKeys = [...shownGroups.keys()];
  const projectCursorKey = opts?.projectCursorKey ?? projectKeys[Math.max(0, Math.min(projectIdx, projectKeys.length - 1))] ?? null;
  const focusedSessions = projectFocusKey ? shownGroups.get(projectFocusKey) || [] : shown;
  const selectedSession = projectFocusKey ? (focusedSessions[sel] || focusedSessions[0] || null) : null;
  const detailSession = detailId
    ? sessions.find((s: any) => s.session_id === detailId) || selectedSession
    : selectedSession;

  const totalCols = process.stdout.columns || 80;
  const termRows = process.stdout.rows || 24;
  const budget = layoutBudget(totalCols, termRows);
  const { desktop, totalW, bodyRows } = budget;

  // Tiny terminal — one-liner
  if (totalW < 40 || termRows < 10) {
    process.stdout.write(`${_TTY ? "\x1b[H" : ""}${_B}SessionBar${_D}  ${stats.total}s  ${stats.working}w${_TTY ? "\x1b[K\n\x1b[J" : "\n"}`);
    return;
  }

  const write = _TTY
    ? (s: string) => process.stdout.write(`${s}\x1b[K\n`)
    : (s: string) => process.stdout.write(`${s}\n`);
  if (_TTY) process.stdout.write("\x1b[H");

  // ── Aggregate stats ──
  const { working, errored, blocked, idle, groups } = stats;

  // ── Header (2 rows, compact) ──
  let title = "  ";
  const name = "SessionBar";
  for (let i = 0; i < name.length; i++) title += `${RAINBOW[i % RAINBOW.length]}${_B}${name[i]}${_D}`;
  if (desktop) {
    // Right-align server info on the title row to save space
    const rightInfo = `${_GN}●${_D} online ${_K}:${PORT}${_D}`;
    const titleVis = stripAnsi(title);
    const rightVis = stripAnsi(rightInfo);
    const pad = Math.max(1, totalW - titleVis - rightVis + 1);
    write(title + " ".repeat(pad) + rightInfo);
  } else {
    write(title);
  }

  // Stats bar
  let statusBar = `  ${sessions.length} session${sessions.length !== 1 ? "s" : ""}`;
  if (working > 0) statusBar += `  ${_BL}${working} working${_D}`;
  if (errored > 0) statusBar += `  ${_RD}${errored} error${_D}`;
  if (blocked > 0) statusBar += `  ${_YL}${blocked} blocked${_D}`;
  if (idle > 0) statusBar += `  ${_K}${idle} idle${_D}`;
  if (groups.size > 1) statusBar += `  ${_K}·${_D} ${groups.size} projects`;
  write(statusBar);

  if (desktop) {
    // Desktop hierarchy: Projects -> Sessions -> Details.
    let printed = 0;
    const printLines = (lines: string[]) => {
      for (const line of lines) write(line);
      printed += lines.length;
    };
    const gap = () => {
      if (printed < bodyRows) {
        write("");
        printed++;
      }
    };

    const projectPanelRows = Math.max(4, Math.min(bodyRows >= 28 ? 9 : 7, bodyRows - 7));
    printLines(renderProjectsPanel(shownGroups, projectCursorKey, projectFocusKey, totalW, projectPanelRows));
    if (bodyRows - printed >= 6) gap();

    const selectedProjectKey = projectFocusKey || projectCursorKey;
    const projectSessions = selectedProjectKey ? shownGroups.get(selectedProjectKey) || [] : shown;
    const sessionTitle = projectSessions[0]
      ? `Sessions / ${projectLabel(projectSessions[0])}`
      : "Sessions";
    const lowerRows = Math.max(4, bodyRows - printed);
    const detailsW = Math.max(34, Math.floor((totalW - 1) * 0.34));
    const sessionsW = totalW - detailsW - 1;
    const blocks = [
      renderSessionsPanel(shown, projectSessions, projectFocusKey ? sel : -1, projectFocusKey ? detailSession : null, frame, sessionsW, lowerRows, sessionTitle, false),
      renderDetailsPanel(projectSessions, shown, projectFocusKey ? detailSession : null, frame, detailsW, lowerRows, Boolean(projectFocusKey)),
    ];
    printLines(composeColumns(blocks));

    for (let i = printed; i < bodyRows; i++) write("");
  } else {
    // ═══════════════════════════════════════════════════
    // NARROW: single-column layout (< 100 cols)
    // ═══════════════════════════════════════════════════

	    const listSessionsN = focusedSessions;
	    const selectedSessionN = projectFocusKey ? detailSession : null;
	    const detailBody = 8;
	    const showRuntimeN = !projectFocusKey && bodyRows >= 12;
	    const detailRows = (selectedSessionN || showRuntimeN) && bodyRows >= 12
	      ? Math.min(detailBody, Math.floor(bodyRows * 0.42))
	      : 0;
    const sessionsBody = bodyRows - detailRows - (detailRows > 0 ? 1 : 0);

	    write(panelTop(
	      projectFocusKey && listSessionsN[0]
	        ? `Sessions / ${projectLabel(listSessionsN[0])}`
	        : shown.length !== sessions.length
	          ? `All Sessions (${shown.length}/${sessions.length})`
	          : "All Sessions",
	      totalW
	    ));

	    const listRows = Math.max(1, sessionsBody - 2); // minus panel header + panel bot
	    const useGroupsN = !projectFocusKey && sessions.length > 3 && groupByProject(shown).size > 1;
	    const showTypeN = totalW >= 70;
	    const showTaskFullN = totalW >= 45;

    if (useGroupsN) {
	      const grp = groupByProject(shown);
	      let rowIdx = 0;
	      let fIdx = 0;
	      const lines: string[] = [];

	      for (const [proj, ss] of grp) {
	        if (rowIdx >= listRows) break;
	        const projectMarker = proj === projectFocusKey ? `${_BL}●${_D}` : proj === projectCursorKey ? `${_BL}>${_D}` : " ";
	        lines.push(panelRow(
	          `${projectMarker} ${_B}${projectLabel(ss[0])}${_D} ${_K}─ ${ss.length} session${ss.length !== 1 ? "s" : ""}${_D}`,
	          totalW
	        ));
	        rowIdx++;
	        for (const s of ss) {
	          if (rowIdx >= listRows) break;
	          const marker = projectFocusKey && fIdx === sel ? `${_B}${_BL}>${_D}` : " ";
	          lines.push(sessionRow(s, frame, totalW, fIdx, marker, showTypeN, showTaskFullN));
          rowIdx++;
          fIdx++;
        }
      }
      const overflow = fIdx > 0 && rowIdx >= listRows ? shown.length - fIdx : 0;
      for (const l of lines) write(l);
      if (overflow > 0) write(panelRow(`${_K}... and ${overflow} more${_D}`, totalW));
      for (let i = lines.length + (overflow > 0 ? 1 : 0); i < listRows; i++) write(panelRow("", totalW));
	    } else {
	      const overflow = listSessionsN.length - listRows;
	      const showN = Math.min(listSessionsN.length, listRows - (overflow > 0 ? 1 : 0));
	      for (let i = 0; i < showN; i++) {
	        const s = listSessionsN[i];
	        if (!s) continue;
	        const marker = projectFocusKey && i === sel ? `${_B}${_BL}>${_D}` : " ";
	        write(sessionRow(s, frame, totalW, i, marker, showTypeN, showTaskFullN));
	      }
      if (overflow > 0) write(panelRow(`${_K}... and ${overflow} more${_D}`, totalW));
      for (let i = showN + (overflow > 0 ? 1 : 0); i < listRows; i++) write(panelRow("", totalW));
    }

    write(panelBot(totalW));

    // ── Detail panel (below sessions in narrow mode) ──
    if ((selectedSessionN || showRuntimeN) && detailRows > 0) {
      write(panelRow("", totalW));
      const detailTitle = selectedSessionN ? (detailId ? "Detail" : "Inspector") : "Details / Runtime";
      write(panelTop(detailTitle, totalW));
      const detailContent = selectedSessionN
        ? renderDetailLines(selectedSessionN, frame, totalW)
        : renderRuntimeDetailsLines(shown, totalW);
      for (const l of detailContent.slice(0, detailRows - 1)) write(panelRow(l, totalW));
      for (let i = Math.min(detailContent.length, detailRows - 1); i < detailRows - 1; i++) write(panelRow("", totalW));
      write(panelBot(totalW));
    }
  }

  // ── Footer ──
  write(`\x1b[K`);
  if (errorMsg) {
    write(`  ${_RD}⚠ ${errorMsg}${_D}`);
  } else if (filterActive) {
    write(`  ${_B}/${filterText}_${_D}  ${_K}${shown.length}/${sessions.length} sessions  (Esc clear)${_D}`);
  } else {
    // Adaptive footer using totalW for threshold
    if (totalW >= 100) {
	      const nav = projectFocusKey
	        ? `${_K}↑↓${_D} session  ${_K}Enter${_D} detail  ${_K}a/⌫${_D} all projects`
	        : `${_K}↑↓${_D} project  ${_K}Enter${_D} open project`;
	      write(`  ${nav}  ${_K}r${_D} refresh  ${_K}/${_D} filter  ${_K}w${_D} web  ${_K}q${_D} quit`);
    } else if (totalW >= 70) {
	      const nav = projectFocusKey ? `${_K}↑↓${_D} session  ${_K}a${_D} all` : `${_K}↑↓${_D} project  ${_K}Enter${_D} open`;
	      write(`  ${nav}  ${_K}/${_D} filter  ${_K}r${_D} refresh  ${_K}q${_D} quit`);
    } else {
	      write(`  ${_K}↑↓${_D} ${projectFocusKey ? "session" : "project"}  ${_K}q${_D} quit`);
    }
  }
  if (_TTY) process.stdout.write("\x1b[J");


}

function sessionRow(
  s: any,
  frame: number,
  w: number,
  idx: number,
  marker: string,
  showType: boolean,
  showTaskFull: boolean
): string {
  const style = S[s.status as keyof typeof S] || S.idle;
  const active = s.status === "working";
  const sd = active
    ? `${style.c}${PULSE(frame + idx)}${_D}`
    : `${style.c}${style.icon}${_D}`;
  const proj = extractProject(s);
  const task = s.task_name || "";
  const stChar = active ? "R" : s.status === "idle" ? "I" : s.status === "blocked" ? "A" : "E";
  const stColor = active ? `${_BL}` : s.status === "idle" ? `${_K}` : s.status === "blocked" ? `${_YL}` : `${_RD}`;

  // Build row from columns based on width
  const projCol = proj.slice(0, 16);
  const projPadded = projCol.length < 16 ? projCol + " ".repeat(16 - projCol.length) : projCol;

  let content: string;
  if (showType) {
    // Wide: icon+status, project(16), task(fill), status_char, age, type
    const typeCol = (s.session_type || "?").slice(0, 12);
    const taskMax = Math.max(4, w - 22 - 16 - 4 - 14);
    const taskCol = task.length > taskMax ? task.slice(0, taskMax - 1) + "…" : task;
    const taskPadded = taskCol.length < taskMax ? taskCol + " ".repeat(taskMax - taskCol.length) : taskCol;
    content = `${marker}${sd} ${projPadded} ${taskPadded} ${stColor}${stChar}${_D} ${_K}${age(s.timestamp || Date.now())}${_D}  ${_K}${typeCol}${_D}`;
  } else if (showTaskFull) {
    // Medium: icon+status, project(16), task(fill), status_char, age
    const taskMax = Math.max(4, w - 22 - 16 - 4);
    const taskCol = task.length > taskMax ? task.slice(0, taskMax - 1) + "…" : task;
    const taskPadded = taskCol.length < taskMax ? taskCol + " ".repeat(taskMax - taskCol.length) : taskCol;
    content = `${marker}${sd} ${projPadded} ${taskPadded} ${stColor}${stChar}${_D} ${_K}${age(s.timestamp || Date.now())}${_D}`;
  } else {
    // Narrow: icon+status, project(12), task (short), age
    const projShort = proj.slice(0, 12);
    const projShortPadded = projShort.length < 12 ? projShort + " ".repeat(12 - projShort.length) : projShort;
    const taskMax = Math.max(3, w - 22 - 12 - 4);
    const taskCol = task.length > taskMax ? task.slice(0, taskMax - 1) + "…" : task;
    content = `${marker}${sd} ${projShortPadded} ${_K}·${_D} ${taskCol} ${stColor}${stChar}${_D} ${_K}${age(s.timestamp || Date.now())}${_D}`;
  }

  return panelRow(content, w);
}

// One-shot render entry for non-interactive status output.
function render(sessions: any[], frame: number, errorMsg?: string) {
  renderFrame(sessions, frame, { errorMsg });
}

// ── watch() — full-screen interactive TUI ──

// ── SSE stream reader ──

async function startSSE(): Promise<ReadableStreamDefaultReader<string> | null> {
  try {
    const resp = await fetch(`${API_BASE}/sessions/stream`);
    if (!resp.ok || !resp.body) return null;
    const reader = resp.body
      .pipeThrough(new TextDecoderStream())
      .getReader();
    return reader;
  } catch { return null; }
}

async function readSSE(
  reader: ReadableStreamDefaultReader<string>,
  timeoutMs = 30000,
): Promise<any[] | "timeout" | "closed"> {
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let result: ReadableStreamReadResult<string>;
    try {
      result = await reader.read();
    } catch {
      return "closed";
    }
    if (result.done) return "closed";
    buffer += result.value;
    // Extract complete SSE events (delimited by \n\n)
    while (true) {
      const idx = buffer.indexOf("\n\n");
      if (idx === -1) break;
      const event = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const dataLine = event.split("\n").find((l: string) => l.startsWith("data: "));
      if (dataLine) {
        try {
          return JSON.parse(dataLine.slice(6));
        } catch { /* skip malformed event, continue parsing buffer */ }
      }
    }
  }
  return "timeout";
}

async function watch() {
  if (!process.stdout.isTTY) {
    const result = await fetchSessions();
    render(result.sessions, 0, result.error);
    return;
  }

  if (await relaunchMonitorWithBun()) return;

  // SSE-aware fetch wrapper: toggles between REST polling and SSE push
  let sse = false;
  let sseReader: ReadableStreamDefaultReader<string> | null = null;

  const sseToggleFetch: typeof fetchSessions = async () => {
    if (!sse) return fetchSessions();
    if (!sseReader) {
      sseReader = await startSSE();
      if (!sseReader) return { sessions: [], error: "SSE connect failed" };
    }
    const data = await readSSE(sseReader, tuiRenderMs);
    if (data === "closed") { sseReader = null; sse = false; return { sessions: [], error: "SSE lost" }; }
    if (data === "timeout") return { sessions: [], error: undefined };
    return { sessions: data as any[], error: undefined };
  };

  const toggleSSE = (): boolean => {
    sse = !sse;
    if (!sse && sseReader) { try { sseReader.cancel(); } catch { /* */ } sseReader = null; }
    return sse;
  };

  try {
    await runOpenTuiMonitor({
      fetchSessions: sseToggleFetch,
      fetchSystem,
      fetchProviders: async () => {
        const resp = await fetch(`${API_BASE}/providers/live`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        if (data.initializing) throw new Error("Initializing...");
        return Array.isArray(data?.providers) ? data.providers : [];
      },
      openWebDashboard,
      renderMs: tuiRenderMs,
      pollMs: tuiPollMs,
      port: PORT,
      apiHost: API_HOST,
      stateDir: HOME,
      animate: animateTui,
      toggleSSE,
      isSSE: () => sse,
    });
  } catch (error) {
    if (!isOpenTuiRuntimeError(error)) throw error;
    console.error("OpenTUI monitor requires Bun's native FFI runtime. Install Bun or run: bun dist/cli.js monitor");
    process.exitCode = 1;
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
  const ans = await ask("[l] Local focus (this project agent config files)  |  [g] Global focus (home agent config files)\n> ");
  const global = ans.toLowerCase().startsWith("g");
  await setupHooks(global);
}

// ---- Terminal UI theme wrappers (bind cli.ts ANSI constants) ----

function panelTop(title: string, w: number, right?: string): string {
  return _panelTop(title, w, _K, _D, right);
}
function panelBot(w: number): string {
  return _panelBot(w, _K, _D);
}
function panelRow(content: string, w: number): string {
  return _panelRow(content, w, _K, _D);
}

const RAINBOW = createRainbow(_COLOR);

// ---- Landing menu wiring -----------------------------------------------

function buildLandingDeps(): LandingMenuDeps {
  return {
    tty: _TTY,
    colorEnabled: _COLOR,
    formatAge: (ts) => age(ts),
    agentName,
    projectLabel,
    statusShort,
    statusStyle: (status) => S[status as keyof typeof S] || S.idle,
    ensureAppRunning,
    fetchSessions,
    pidAlive,
    launchMonitor: watch,
    launchSetup: async () => {
      console.log("\nSessionBar service starts automatically when the app opens.");
      console.log("Setup only chooses which Claude Code sessions report into it.\n");
      const a = await ask("[l] Local focus  |  [g] Global focus\n> ");
      await setupHooks(a.toLowerCase().startsWith("g"));
      await ask("\nPress enter...");
    },
    launchStatus: async (sessions) => {
      console.log();
      try { render(sessions, 0); } catch { /* render failed */ }
      await ask("");
    },
    launchWeb: async (serverRunning) => {
      useWeb = true;
      if (serverRunning) stopServer();
      await delay(300);
      if (!startServer() || !(await waitForReady())) {
        console.log("\nServer failed to start.");
        await ask("\nPress enter...");
        return;
      }
      await injectHooksOnServerReady(true);
      console.log(`\nDashboard: ${API_BASE}`);
      spawn("open", [API_BASE], { detached: true, stdio: "ignore" }).unref();
      await ask("\nPress enter...");
    },
    teardownHooks,
    port: PORT,
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
    if (!startServer() || !(await waitForReady())) {
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

function pruneMarkers() {
  ensureDir();
  if (pidAlive()) {
    stopServer(true);
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
    case "web":
      useWeb = true;
      ensureDir();
      if (pidAlive()) {
        stopServer(true);
        await delay(300);
      }
      if (!startServer() || !(await waitForReady())) {
        console.error("Server failed to start.");
        process.exitCode = 1;
        break;
      }
      await injectHooksOnServerReady(true);
      console.log(`SessionBar server started on :${PORT}`);
      console.log(`Dashboard: ${API_BASE}`);
      spawn("open", [API_BASE], { detached: true, stdio: "ignore" }).unref();
      break;
    case "start":
      if (await waitForReady(1)) { console.log("Already running."); break; }
      if (!await ensureServerRunning()) {
        console.error("Server failed to start.");
        process.exitCode = 1;
        break;
      }
      console.log(`SessionBar server started on :${PORT}`);
      if (useWeb) console.log(`Dashboard: ${API_BASE}`);
      break;
    case "stop":
      stopServer();
      break;
    case "prune":
      pruneMarkers();
      break;
    case "setup":
      await setup();
      break;
    case "status":
      await status();
      break;
    case "watch":
    case "monitor":
      if (!await ensureAppRunning()) {
        console.error("Server failed to start.");
        process.exitCode = 1;
        break;
      }
      await watch();
      teardownHooks(true, true);
      break;
    default:
      await runLandingMenu(buildLandingDeps());
  }
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
