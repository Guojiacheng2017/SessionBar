#!/usr/bin/env node

import { execSync, spawn } from "child_process";
import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync, openSync, closeSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { createInterface } from "readline";
import { runOpenTuiMonitor } from "./openTuiMonitor.js";
import { pruneSessionMarkerFiles } from "./sessionMarkers.js";

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

function strip(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function pad(s: string, n: number): string {
  return s + " ".repeat(Math.max(0, n - strip(s)));
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

function truncateAnsi(s: string, max: number): string {
  if (max <= 0) return "";
  if (strip(s) <= max) return s;
  let out = "";
  let visible = 0;
  for (let i = 0; i < s.length && visible < Math.max(0, max - 1); i++) {
    if (s[i] === "\x1b" && s[i + 1] === "[") {
      const end = s.indexOf("m", i);
      if (end === -1) break;
      out += s.slice(i, end + 1);
      i = end;
      continue;
    }
    out += s[i];
    visible++;
  }
  return out + "…" + _D;
}

function age(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 10) return `${CC.CY}now`;  // caller appends _D
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

function typeIcon(t: string): string {
  const m: Record<string, string> = {
    "Claude Code": "♆",
    "Gemini CLI": "◇",
    "Codex": "▷",
    "Copilot": "◎",
    "OpenCode": "□",
    "Pi": "π",
    "Kimi CLI": "❖",
    "Qwen CLI": "⬡",
    "DeepSeek CLI": "◆",
    "Windsurf": "♒",
    "Cursor": "➤",
  };
  return m[t] || "○";
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
  const cleaned = sid.replace(/^(claude|gemini|codex|copilot|opencode|pi|kimi|qwen|deepseek|windsurf|cursor)-/, "");
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
  return pad(truncateAnsi(s, w), w);
}

function rightCell(s: string, w: number): string {
  const clipped = truncateAnsi(s, w);
  return " ".repeat(Math.max(0, w - strip(clipped))) + clipped;
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
  const cleaned = rawSessionId(s).replace(/^(claude|codex|gemini|copilot|opencode|pi|kimi|qwen|deepseek|windsurf|cursor)-/i, "");
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
  return truncateAnsi(parts.join(` ${_K}·${_D} `), max);
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
    .map(([type, count]) => `${typeIcon(type)}${count > 1 ? count : ""}`)
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

function renderDetailsPanel(
  scopeSessions: any[],
  allSessions: any[],
  selected: any | null,
  frame: number,
  w: number,
  totalRows: number,
): string[] {
  const title = selected ? "Details / Session" : "Details / Project";
  const content = selected
    ? renderSelectedSessionLines(selected, frame, w)
    : renderProjectDetailsLines(scopeSessions, allSessions, w);
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
  return `${cell("", c.marker)}${cell(`${_B}Project${_D}`, c.project)} ${cell(`${_B}Agent${_D}`, c.agent)} ${cell(`${_B}Session${_D}`, c.session)} ${cell(`${_B}Task${_D}`, c.task)} ${cell(`${_B}Status${_D}`, c.status)} ${cell(`${_B}Stats${_D}`, c.stats)} ${rightCell(`${_B}Age${_D}`, c.age)}`;
}

function sessionTableRow(s: any, frame: number, w: number, idx: number, selected: boolean): string {
  const c = sessionTableLayout(w);
  const style = statusStyle(s.status);
  const pulse = s.status === "working" ? PULSE(frame + idx) : style.icon;
  const marker = selected ? `${_BL}>${_D}` : " ";
  const project = projectLabel(s);
  const agent = `${typeIcon(s.session_type || "?")} ${agentName(s.session_type || "?", c.agent - 2)}`;
  const task = s.task_name || `${_K}no task reported${_D}`;
  const status = `${style.c}${pulse} ${statusShort(s.status)}${_D}`;
  const stats = sessionStatsText(s, c.stats);
  const row = `${cell(marker, c.marker)}${cell(project, c.project)} ${cell(agent, c.agent)} ${cell(sessionShortId(s, c.session), c.session)} ${cell(task, c.task)} ${cell(status, c.status)} ${cell(stats, c.stats)} ${rightCell(`${_K}${age(s.timestamp || Date.now())}${_D}`, c.age)}`;
  return panelRow(selected ? `${_B}${row}${_D}` : row, w);
}

function renderSelectedSessionLines(s: any, frame: number, w: number): string[] {
  const style = statusStyle(s.status);
  const pulse = s.status === "working" ? PULSE(frame) : style.icon;
  return [
    `${_B}PROJECT${_D} ${projectLabel(s)}  ${_K}·${_D}  ${displayPath(projectPathLabel(s), Math.max(10, w - 38))}`,
    `${_B}SESSION${_D} ${sessionShortId(s, 22)}  ${_K}·${_D}  ${typeIcon(s.session_type || "?")} ${agentName(s.session_type || "?", 16)}  ${_K}·${_D}  ${style.c}${pulse} ${statusShort(s.status)}${_D}  ${_K}updated${_D} ${age(s.timestamp || Date.now())}${_D}`,
    `${_K}task${_D} ${truncateAnsi(s.task_name || "no task reported", Math.max(8, w - 13))}`,
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

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
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
  const ico = typeIcon(s.session_type || "?");
  const style = S[s.status as keyof typeof S] || S.idle;
  const statusLabel = style.label || s.status;
  const pulseChar = s.status === "working" ? PULSE(frame % 4) : style.icon;
  const pathDisplay = tailText(s.project_path || proj, Math.max(8, w - 12));

  const lines: string[] = [
    `${ico}  ${_B}${s.session_type || "?"}${_D}`,
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
    const titleVis = strip(title);
    const rightVis = strip(rightInfo);
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
      renderDetailsPanel(projectSessions, shown, projectFocusKey ? detailSession : null, frame, detailsW, lowerRows),
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
	    const detailRows = selectedSessionN && bodyRows >= 12
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
	          `${projectMarker} ${typeIcon(ss[0]?.session_type || "?")} ${_B}${projectLabel(ss[0])}${_D} ${_K}─ ${ss.length} session${ss.length !== 1 ? "s" : ""}${_D}`,
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
    if (selectedSessionN && detailRows > 0) {
      write(panelRow("", totalW));
      write(panelTop(detailId ? "Detail" : "Inspector", totalW));
      const detailContent = renderDetailLines(selectedSessionN, frame, totalW);
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

function applyFilter(sessions: any[], q: string): any[] {
  if (!q) return sessions;
  const lower = q.toLowerCase();
  return sessions.filter((s: any) =>
    extractProject(s).toLowerCase().includes(lower) ||
    (s.task_name || "").toLowerCase().includes(lower) ||
    (s.session_type || "").toLowerCase().includes(lower)
  );
}

function selectionIndex(filtered: any[], selectedId: string | null, fallbackIdx: number): number {
  if (filtered.length === 0) return 0;
  if (selectedId) {
    const byId = filtered.findIndex((s: any) => s.session_id === selectedId);
    if (byId !== -1) return byId;
  }
  return Math.max(0, Math.min(fallbackIdx, filtered.length - 1));
}

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
      fetchProviders: async () => {
        try {
          const resp = await fetch(`${API_BASE}/providers/live`);
          if (!resp.ok) return [];
          const data = await resp.json();
          return Array.isArray(data?.providers) ? data.providers : [];
        } catch {
          return [];
        }
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

  // Enter alternate screen, disable cursor
  process.stdout.write("\x1b[?1049h\x1b[?25l");

  let stdinRaw = false;
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    stdinRaw = true;
  }

  let running = true;
  let frame = 0;
  let selectedIdx = 0;
  let selectedId: string | null = null;
  let detailId: string | null = null;
  let projectIdx = 0;
  let projectCursorKey: string | null = null;
  let projectFocusKey: string | null = null;
  let filterText = "";
  let filterActive = false;
  let sessions: any[] = [];
  let stats = computeStats(sessions);
  let errorMsg: string | undefined;
  let pendingFetch = true;
  let forceRefresh = false;
  let lastFingerprint = "";
  let lastCols = 0;
  let lastRows = 0;

  const stop = () => {
    if (!running) return;
    running = false;
    process.stdout.write("\x1b[?25h\x1b[?1049l");
    if (stdinRaw) {
      try { process.stdin.setRawMode(false); } catch { /* */ }
      process.stdin.pause();
    }
  };

  // Parse ANSI escape sequences and key presses
  let escapeBuf = "";
  const currentShown = () => applyFilter(sessions, filterText);
  const currentGroups = () => groupByProject(currentShown());
  const currentProjectKeys = () => [...currentGroups().keys()];
  const setProjectFromKeys = (idx: number) => {
    const keys = currentProjectKeys();
    if (keys.length === 0) {
      projectIdx = 0;
      projectCursorKey = null;
      projectFocusKey = null;
      selectedIdx = 0;
      selectedId = null;
      detailId = null;
      return;
    }
    projectIdx = Math.max(0, Math.min(keys.length - 1, idx));
    projectCursorKey = keys[projectIdx] || null;
  };
  const moveProject = (delta: number) => {
    const keys = currentProjectKeys();
    const byKey = projectCursorKey ? keys.indexOf(projectCursorKey) : -1;
    const base = byKey === -1 ? projectIdx : byKey;
    setProjectFromKeys(base + delta);
    forceRefresh = true;
  };
  const focusedSessions = () => {
    if (!projectFocusKey) return currentShown();
    return currentGroups().get(projectFocusKey) || [];
  };
  const setSelectedFromFocused = (idx: number) => {
    const filtered = focusedSessions();
    if (filtered.length === 0) {
      selectedIdx = 0;
      selectedId = null;
      detailId = null;
      return;
    }
    selectedIdx = Math.max(0, Math.min(filtered.length - 1, idx));
    selectedId = filtered[selectedIdx]?.session_id || null;
  };
  const moveSelection = (delta: number) => {
    if (!projectFocusKey) {
      moveProject(delta);
      return;
    }
    const filtered = focusedSessions();
    if (filtered.length === 0) {
      selectedIdx = 0;
      selectedId = null;
    } else {
      selectedIdx = Math.max(0, Math.min(filtered.length - 1, selectionIndex(filtered, selectedId, selectedIdx) + delta));
      selectedId = filtered[selectedIdx]?.session_id || null;
    }
    forceRefresh = true;
  };
  const focusProject = () => {
    const groups = currentGroups();
    const keys = [...groups.keys()];
    if (keys.length === 0) return;
    if (!projectCursorKey || !groups.has(projectCursorKey)) setProjectFromKeys(projectIdx);
    projectFocusKey = projectCursorKey || keys[0] || null;
    const ss = projectFocusKey ? groups.get(projectFocusKey) || [] : [];
    selectedIdx = 0;
    selectedId = ss[0]?.session_id || null;
    detailId = null;
    forceRefresh = true;
  };
  const clearProjectFocus = () => {
    projectFocusKey = null;
    selectedIdx = -1;
    selectedId = null;
    detailId = null;
    forceRefresh = true;
  };

  const onKey = (buf: Buffer) => {
    const raw = buf.toString();

    if (filterActive) {
      // Filter input mode
      if (raw === "\x1b" || raw === "\x03") {
        // Esc or Ctrl+C: clear filter
        filterActive = false;
        filterText = "";
        selectedIdx = 0;
        selectedId = null;
        detailId = null;
        projectFocusKey = null;
        projectIdx = 0;
        projectCursorKey = null;
        forceRefresh = true;
        return;
      }
      if (raw === "\r" || raw === "\n") {
        // Enter: accept filter
        filterActive = false;
        selectedIdx = 0;
        selectedId = null;
        detailId = null;
        projectFocusKey = null;
        projectIdx = 0;
        projectCursorKey = null;
        forceRefresh = true;
        return;
      }
      if (raw === "\x7f" || raw === "\b") {
        // Backspace
        filterText = filterText.slice(0, -1);
        selectedIdx = 0;
        selectedId = null;
        detailId = null;
        projectFocusKey = null;
        projectIdx = 0;
        projectCursorKey = null;
        forceRefresh = true;
        return;
      }
      // Printable chars
      if (raw.length === 1 && raw >= " " && raw <= "~") {
        filterText += raw;
        selectedIdx = 0;
        selectedId = null;
        detailId = null;
        projectFocusKey = null;
        projectIdx = 0;
        projectCursorKey = null;
        forceRefresh = true;
        return;
      }
      return; // ignore other keys in filter mode
    }

    // Normal mode
    if (raw === "q" || raw === "Q" || raw === "\x03") {
      stop();
      return;
    }

    if (raw === "\x1b[A" || raw === "\x1bOA") {
      escapeBuf = "";
      moveSelection(-1);
      return;
    }
    if (raw === "\x1b[B" || raw === "\x1bOB") {
      escapeBuf = "";
      moveSelection(1);
      return;
    }

    if (raw === "\x1b") {
      escapeBuf = "\x1b";
      return;
    }

    if (escapeBuf) {
      escapeBuf += raw;
      // Arrow up: \x1b[A, Arrow down: \x1b[B
      if (escapeBuf === "\x1b[A" || escapeBuf === "\x1bOA") {
        moveSelection(-1);
      } else if (escapeBuf === "\x1b[B" || escapeBuf === "\x1bOB") {
        moveSelection(1);
      }
      escapeBuf = "";
      return;
    }

    // Single-key commands
    if (raw === "k" || raw === "K") {
      moveSelection(-1);
      return;
    }
    if (raw === "j" || raw === "J") {
      moveSelection(1);
      return;
    }
    if (raw === "g") {
      if (projectFocusKey) setSelectedFromFocused(0);
      else setProjectFromKeys(0);
      forceRefresh = true;
      return;
    }
    if (raw === "G") {
      if (projectFocusKey) {
        const f2 = focusedSessions();
        setSelectedFromFocused(Math.max(0, f2.length - 1));
      } else {
        const keys = currentProjectKeys();
        setProjectFromKeys(Math.max(0, keys.length - 1));
      }
      forceRefresh = true;
      return;
    }
    if (raw === "a" || raw === "A" || raw === "\x7f" || raw === "\b") {
      clearProjectFocus();
      return;
    }
    if (raw === "\r" || raw === "\n") {
      // Enter first opens a project. Inside a project it toggles session detail.
      if (!projectFocusKey) {
        focusProject();
        return;
      }
      const filtered = focusedSessions();
      selectedIdx = selectionIndex(filtered, selectedId, selectedIdx);
      const s = filtered[selectedIdx];
      if (s) {
        selectedId = s.session_id || null;
        detailId = detailId === s.session_id ? null : s.session_id;
        forceRefresh = true;
      }
      return;
    }
    if (raw === "/") {
      filterActive = true;
      filterText = "";
      clearProjectFocus();
      forceRefresh = true;
      return;
    }
    if (raw === "r" || raw === "R") {
      pendingFetch = true;
      forceRefresh = true;
      return;
    }
    if (raw === "w" || raw === "W") {
      void openWebDashboard();
      return;
    }
  };
  process.stdin.on("data", onKey);

  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  process.once("SIGHUP", stop);
  // SIGCONT: restore terminal state after Ctrl+Z / fg resume
  process.on("SIGCONT", () => {
    process.stdout.write("\x1b[?1049h\x1b[?25l"); // re-enter alt screen, re-hide cursor
    pendingFetch = true;
    forceRefresh = true;
  });
  process.once("uncaughtException", (err) => {
    stop();
    console.error("Fatal:", err);
    process.exit(1);
  });

  // Render loop: monitor-style split cadence. Render remains smooth even when
  // collection is slower, and collection cannot make layout timing jitter.
  const renderDelay = tuiRenderMs;
  const pollDelay = tuiPollMs;
  let lastFetch = 0;
  let lastRender = 0;

  while (running) {
    const now = Date.now();

    // Fetch if needed
    if (pendingFetch || now - lastFetch >= pollDelay || forceRefresh) {
        try {
          const result = await fetchSessions();
          const newStats = computeStats(result.sessions);
          if (newStats.fingerprint !== stats.fingerprint || forceRefresh) {
            sessions = result.sessions;
            stats = newStats;
            errorMsg = result.error;
          }
          lastFetch = now;
          pendingFetch = false;
        } catch { /* keep old sessions on fetch error */ }
    }

	    // Clamp project/session selection independently.
	    const filtered = applyFilter(sessions, filterText);
	    const groups = groupByProject(filtered);
	    const keys = [...groups.keys()];
	    if (keys.length === 0) {
	      projectIdx = 0;
	      projectCursorKey = null;
	      projectFocusKey = null;
	      selectedIdx = -1;
	      selectedId = null;
	      detailId = null;
	    } else {
	      const byProjectKey = projectCursorKey ? keys.indexOf(projectCursorKey as string) : -1;
	      projectIdx = byProjectKey === -1 ? Math.max(0, Math.min(projectIdx, keys.length - 1)) : byProjectKey;
	      projectCursorKey = keys[projectIdx] || null;
	      if (projectFocusKey && !groups.has(projectFocusKey as string)) {
	        projectFocusKey = null;
	        selectedIdx = -1;
	        selectedId = null;
	        detailId = null;
	      }
	      if (projectFocusKey) {
	        const projectSessions = groups.get(projectFocusKey as string) || [];
	        selectedIdx = selectionIndex(projectSessions, selectedId, selectedIdx);
	        selectedId = projectSessions[selectedIdx]?.session_id || null;
	      } else {
	        selectedIdx = -1;
	        selectedId = null;
	        detailId = null;
	      }
	    }
	    if (detailId && !sessions.some((s: any) => s.session_id === detailId)) detailId = null;

    const cols = process.stdout.columns || 80;
    const rows = process.stdout.rows || 24;
    const sizeChanged = cols !== lastCols || rows !== lastRows;
    const needsAnim = animateTui && stats.working > 0;
    const cadenceDue = now - lastRender >= renderDelay;
    const shouldRender = forceRefresh || sizeChanged || stats.fingerprint !== lastFingerprint || needsAnim || cadenceDue;

    // Render
    if (shouldRender) {
      try {
	        renderFrame(sessions, frame, {
	          selectedIdx,
	          detailId,
	          projectIdx,
	          projectCursorKey,
	          projectFocusKey,
	          filterText: filterActive ? filterText : (filterText || ""),
	          errorMsg,
	          stats,
        });
      } catch { /* skip frame on render error */ }
      lastFingerprint = stats.fingerprint;
      lastCols = cols;
      lastRows = rows;
      lastRender = now;
    }
    frame++;

    if (forceRefresh) {
      forceRefresh = false;
      await new Promise(r => setTimeout(r, 50));
    } else {
      await new Promise(r => setTimeout(r, renderDelay));
    }
  }

  // Cleanup
  process.stdin.removeListener("data", onKey);
  if (stdinRaw) {
    try { process.stdin.setRawMode(false); } catch { /* */ }
  }
}

async function setupHooks(global: boolean) {
  const reportPath = join(dirname(__dirname), "report.sh");
  const targets = [
    setupClaudeHooks(global, reportPath),
    setupCodexHooks(global, reportPath),
    setupGeminiHooks(global, reportPath),
    setupCopilotHooks(global, reportPath),
  ];
  for (const target of targets) {
    console.log(`${target.added > 0 ? "Installed" : "Already configured"} ${target.name} → ${target.path}`);
  }
}

function teardownClaudeHooks(global: boolean): number {
  const settingsPath = global
    ? join(homedir(), ".claude", "settings.json")
    : join(process.cwd(), ".claude", "settings.json");
  const settings = readJsonFile(settingsPath);
  if (!settings.hooks) return 0;
  let removed = 0;
  for (const event of Object.keys(settings.hooks)) {
    const before = settings.hooks[event].length;
    settings.hooks[event] = settings.hooks[event].filter((d: any) =>
      !d.hooks?.some?.((h: any) => isSessionbarCommandFor(h.command || "", "claude"))
    );
    removed += before - settings.hooks[event].length;
    if (settings.hooks[event].length === 0) delete settings.hooks[event];
  }
  if (removed > 0) writeJsonFile(settingsPath, settings);
  return removed;
}

function teardownCodexHooks(global: boolean): number {
  const hooksPath = global
    ? join(homedir(), ".codex", "hooks.json")
    : join(process.cwd(), ".codex", "hooks.json");
  const config = readJsonFile(hooksPath);
  if (!config.hooks) return 0;
  let removed = 0;
  for (const event of Object.keys(config.hooks)) {
    const before = config.hooks[event].length;
    config.hooks[event] = config.hooks[event].filter((d: any) =>
      !d.hooks?.some?.((h: any) => isSessionbarCommandFor(h.command || "", "codex"))
    );
    removed += before - config.hooks[event].length;
    if (config.hooks[event].length === 0) delete config.hooks[event];
  }
  if (removed > 0) writeJsonFile(hooksPath, config);
  return removed;
}

function teardownGeminiHooks(global: boolean): number {
  const settingsPath = global
    ? join(homedir(), ".gemini", "settings.json")
    : join(process.cwd(), ".gemini", "settings.json");
  const settings = readJsonFile(settingsPath);
  if (!settings.hooks) return 0;
  let removed = 0;
  for (const event of Object.keys(settings.hooks)) {
    const before = settings.hooks[event].length;
    settings.hooks[event] = settings.hooks[event].filter((d: any) =>
      !d.hooks?.some?.((h: any) => isSessionbarCommandFor(h.command || "", "gemini"))
    );
    removed += before - settings.hooks[event].length;
    if (settings.hooks[event].length === 0) delete settings.hooks[event];
  }
  if (removed > 0) writeJsonFile(settingsPath, settings);
  return removed;
}

function teardownCopilotHooks(global: boolean): number {
  const hooksPath = global
    ? join(homedir(), ".copilot", "hooks", "agentbar.json")
    : join(process.cwd(), ".github", "hooks", "agentbar.json");
  const config = readJsonFile(hooksPath);
  if (!config.hooks) return 0;
  let removed = 0;
  for (const event of Object.keys(config.hooks)) {
    const before = config.hooks[event].length;
    config.hooks[event] = config.hooks[event].filter((h: any) =>
      !isSessionbarCommandFor(h.command || "", "copilot")
    );
    removed += before - config.hooks[event].length;
    if (config.hooks[event].length === 0) delete config.hooks[event];
  }
  if (removed > 0) writeJsonFile(hooksPath, config);
  return removed;
}

function teardownHooks(global: boolean, quiet = false) {
  const removed = teardownClaudeHooks(global) + teardownCodexHooks(global) + teardownGeminiHooks(global) + teardownCopilotHooks(global);
  if (removed > 0 && !quiet) console.log(`Removed ${removed} hook${removed === 1 ? "" : "s"}.`);
}

async function injectHooksOnServerReady(global: boolean) {
  const reportPath = join(dirname(__dirname), "report.sh");
  // Only inject Claude hooks — Codex/Gemini/Copilot managed via explicit setup
  const result = setupClaudeHooks(global, reportPath);
  if (result.added > 0) console.log(`Injected hooks → ${result.path}`);
}

type SetupResult = { name: string; path: string; added: number };

function commandFor(agent: string, label: string, reportPath: string, status: string, task: string, hookEvent: string): string {
  return `SESSIONBAR_AGENT=${agent} SESSIONBAR_SESSION_TYPE=${shellEscape(label)} SESSIONBAR_HOOK_EVENT=${shellEscape(hookEvent)} ${shellEscape(reportPath)} ${status} ${task} ${String(PORT)}`;
}

function isSessionbarCommandFor(command: string, agent: string): boolean {
  return /(^|\/)report\.sh(\s|$)/.test(command || "") && new RegExp(`\\b(SESSIONBAR_AGENT|AGENTBAR_AGENT)=${agent}\\b`).test(command || "");
}

function readJsonFile(path: string): any {
  try { return JSON.parse(readFileSync(path, "utf-8")); } catch { return {}; }
}

function writeJsonFile(path: string, value: any) {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function setupClaudeHooks(global: boolean, reportPath: string): SetupResult {
  const settingsPath = global
    ? join(homedir(), ".claude", "settings.json")
    : join(process.cwd(), ".claude", "settings.json");

  const settings = readJsonFile(settingsPath);
  if (!settings.hooks) settings.hooks = {};

  type HookDef = { matcher: string; hooks: Array<{ type: string; command: string }> };
  const hookDefs: Record<string, HookDef[]> = {
    SessionStart: [{ matcher: "", hooks: [{ type: "command", command: commandFor("claude", "Claude Code", reportPath, "working", "'Working'", "SessionStart") }] }],
    PreToolUse: [{ matcher: "", hooks: [{ type: "command", command: commandFor("claude", "Claude Code", reportPath, "working", "\"${CLAUDE_TOOL_NAME:-Working}\"", "PreToolUse") }] }],
    Stop: [{ matcher: "", hooks: [{ type: "command", command: commandFor("claude", "Claude Code", reportPath, "idle", "'Ready'", "Stop") }] }],
    SessionEnd: [{ matcher: "", hooks: [{ type: "command", command: commandFor("claude", "Claude Code", reportPath, "idle", "'Session ended'", "SessionEnd") }] }],
  };

  let added = 0;
  for (const [event, defs] of Object.entries(hookDefs)) {
    if (!settings.hooks[event]) settings.hooks[event] = [];
    const already = settings.hooks[event].some((d: any) =>
      d.hooks?.some?.((h: any) => isSessionbarCommandFor(h.command || "", "claude"))
    );
    if (!already) {
      settings.hooks[event].push(...(defs as any));
      added += defs.length;
    }
  }

  writeJsonFile(settingsPath, settings);
  return { name: "Claude Code", path: settingsPath, added };
}

function setupCodexHooks(global: boolean, reportPath: string): SetupResult {
  const hooksPath = global
    ? join(homedir(), ".codex", "hooks.json")
    : join(process.cwd(), ".codex", "hooks.json");
  const config = readJsonFile(hooksPath);
  if (!config.hooks) config.hooks = {};

  const hookDefs: Record<string, any[]> = {
    SessionStart: [{ matcher: "", hooks: [{ type: "command", command: commandFor("codex", "Codex", reportPath, "working", "'Working'", "SessionStart") }] }],
    PreToolUse: [{ matcher: "", hooks: [{ type: "command", command: commandFor("codex", "Codex", reportPath, "working", "\"${CODEX_TOOL_NAME:-Working}\"", "PreToolUse") }] }],
    PermissionRequest: [{ matcher: "", hooks: [{ type: "command", command: commandFor("codex", "Codex", reportPath, "blocked", "'Waiting for permission'", "PermissionRequest") }] }],
    Stop: [{ hooks: [{ type: "command", command: commandFor("codex", "Codex", reportPath, "idle", "'Ready'", "Stop") }] }],
  };

  let added = 0;
  for (const [event, defs] of Object.entries(hookDefs)) {
    if (!config.hooks[event]) config.hooks[event] = [];
    const already = config.hooks[event].some((d: any) =>
      d.hooks?.some?.((h: any) => isSessionbarCommandFor(h.command || "", "codex"))
    );
    if (!already) {
      config.hooks[event].push(...defs);
      added += defs.length;
    }
  }

  writeJsonFile(hooksPath, config);
  return { name: "Codex", path: hooksPath, added };
}

function setupGeminiHooks(global: boolean, reportPath: string): SetupResult {
  const settingsPath = global
    ? join(homedir(), ".gemini", "settings.json")
    : join(process.cwd(), ".gemini", "settings.json");
  const settings = readJsonFile(settingsPath);
  if (!settings.hooks) settings.hooks = {};

  const hookDefs: Record<string, any[]> = {
    BeforeModel: [{ matcher: ".*", hooks: [{ type: "command", command: commandFor("gemini", "Gemini CLI", reportPath, "working", "'Thinking'", "BeforeModel") }] }],
    BeforeTool: [{ matcher: ".*", hooks: [{ type: "command", command: commandFor("gemini", "Gemini CLI", reportPath, "working", "'Using tool'", "BeforeTool") }] }],
    AfterTool: [{ matcher: ".*", hooks: [{ type: "command", command: commandFor("gemini", "Gemini CLI", reportPath, "working", "'Analyzing tool results'", "AfterTool") }] }],
    SessionEnd: [{ matcher: ".*", hooks: [{ type: "command", command: commandFor("gemini", "Gemini CLI", reportPath, "idle", "'Session ended'", "SessionEnd") }] }],
  };

  let added = 0;
  for (const [event, defs] of Object.entries(hookDefs)) {
    if (!settings.hooks[event]) settings.hooks[event] = [];
    const already = settings.hooks[event].some((d: any) =>
      d.hooks?.some?.((h: any) => isSessionbarCommandFor(h.command || "", "gemini"))
    );
    if (!already) {
      settings.hooks[event].push(...defs);
      added += defs.length;
    }
  }

  writeJsonFile(settingsPath, settings);
  return { name: "Gemini CLI", path: settingsPath, added };
}

function setupCopilotHooks(global: boolean, reportPath: string): SetupResult {
  const hooksPath = global
    ? join(homedir(), ".copilot", "hooks", "agentbar.json")
    : join(process.cwd(), ".github", "hooks", "agentbar.json");
  const config = readJsonFile(hooksPath);
  config.version = config.version || 1;
  if (!config.hooks) config.hooks = {};

  const hookDefs: Record<string, any[]> = {
    SessionStart: [{ type: "command", command: commandFor("copilot", "Copilot", reportPath, "working", "'Working'", "sessionStart") }],
    PreToolUse: [{ type: "command", command: commandFor("copilot", "Copilot", reportPath, "working", "\"${COPILOT_TOOL_NAME:-Working}\"", "preToolUse") }],
    PermissionRequest: [{ type: "command", command: commandFor("copilot", "Copilot", reportPath, "blocked", "'Waiting for permission'", "PermissionRequest") }],
    AgentStop: [{ type: "command", command: commandFor("copilot", "Copilot", reportPath, "idle", "'Ready'", "AgentStop") }],
    SessionEnd: [{ type: "command", command: commandFor("copilot", "Copilot", reportPath, "idle", "'Session ended'", "sessionEnd") }],
  };

  let added = 0;
  for (const [event, defs] of Object.entries(hookDefs)) {
    if (!config.hooks[event]) config.hooks[event] = [];
    const already = config.hooks[event].some((h: any) => isSessionbarCommandFor(h.command || "", "copilot"));
    if (!already) {
      config.hooks[event].push(...defs);
      added += defs.length;
    }
  }

  writeJsonFile(hooksPath, config);
  return { name: "Copilot", path: hooksPath, added };
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

function panelTop(title: string, w: number, right?: string): string {
  const boxW = Math.max(2, w - 2);
  const innerW = Math.max(0, boxW - 2);
  const titleText = `─ ${truncateAnsi(title, Math.max(0, innerW - 1))} `;
  const rightMax = Math.max(0, innerW - strip(titleText) - 1);
  const rightText = right && rightMax > 0 ? ` ${truncateAnsi(right, Math.max(0, rightMax - 2))} ` : "";
  const fill = Math.max(0, innerW - strip(titleText) - strip(rightText));
  return `  ${_K}╭${titleText}${"─".repeat(fill)}${rightText}╮${_D}`;
}
function panelBot(w: number): string {
  return `  ${_K}╰${"─".repeat(Math.max(0, w - 4))}╯${_D}`;
}
function panelRow(content: string, w: number): string {
  const available = Math.max(0, w - 8);
  const clipped = truncateAnsi(content, available);
  const vis = strip(clipped);
  return `  ${_K}│${_D}  ${clipped}${" ".repeat(Math.max(0, available - vis))}  ${_K}│${_D}`;
}

const RAINBOW: string[] = _COLOR ? [
  "\x1b[1;31m",  // red
  "\x1b[1;91m",  // orange
  "\x1b[1;33m",  // yellow
  "\x1b[1;93m",  // gold
  "\x1b[1;32m",  // green
  "\x1b[1;92m",  // lime
  "\x1b[1;36m",  // cyan
  "\x1b[1;94m",  // blue
  "\x1b[1;35m",  // magenta
  "\x1b[1;95m",  // pink
] : ["", "", "", "", "", "", "", "", "", ""];

// ANSI Shadow figlet font — compact enough for the landing page.
const BLOCK: Record<string, string[]> = {
  S: ["███████╗", "██╔════╝", "███████╗", "╚════██║", "███████║", "╚══════╝"],
  E: ["███████╗", "██╔════╝", "█████╗  ", "██╔══╝  ", "███████╗", "╚══════╝"],
  I: ["██╗", "██║", "██║", "██║", "██║", "╚═╝"],
  O: [" ██████╗ ", "██╔═══██╗", "██║   ██║", "██║   ██║", "╚██████╔╝", " ╚═════╝ "],
  N: ["███╗   ██╗", "████╗  ██║", "██╔██╗ ██║", "██║╚██╗██║", "██║ ╚████║", "╚═╝  ╚═══╝"],
  B: ["██████╗ ", "██╔══██╗", "██████╔╝", "██╔══██╗", "██████╔╝", "╚═════╝ "],
  A: [" █████╗ ", "██╔══██╗", "███████║", "██╔══██║", "██║  ██║", "╚═╝  ╚═╝"],
  R: ["██████╗ ", "██╔══██╗", "██████╔╝", "██╔══██╗", "██║  ██║", "╚═╝  ╚═╝"],
};

function logoLines(w: number): string[] {
  if (w < 65) {
    const text = "SessionBar";
    let line = "  ";
    for (let i = 0; i < text.length; i++) line += `${RAINBOW[i % RAINBOW.length]}${text[i]}${_D}`;
    return ["", line, ""];
  }
  const topRow = "SESSION";
  const botRow = "BAR";
  const gap = "  ";
  const lines: string[] = ["", ""];
  for (let r = 0; r < 6; r++) {
    let line = "  ";
    for (let i = 0; i < topRow.length; i++) line += `${RAINBOW[i]}${BLOCK[topRow[i]][r]}${_D}${gap}`;
    lines.push(line);
  }
  lines.push("");
  for (let r = 0; r < 6; r++) {
    let line = "  ";
    for (let i = 0; i < botRow.length; i++) line += `${RAINBOW[i + 7]}${BLOCK[botRow[i]][r]}${_D}${gap}`;
    lines.push(line);
  }
  lines.push("");
  lines.push(`  ${_K}AI CLI Session Monitor${_D}`);
  lines.push("");
  return lines;
}

async function menu() {
  // Opening SessionBar should bring the local service up. Setup only controls
  // hook focus, not whether the background service exists.
  await ensureAppRunning(true);

  let menuRunning = true;
  let menuSessions: any[] = [];
  let menuServerRunning = false;
  let needsRender = true;
  let selectedAction = 0;
  let menuRaw = false;
  let menuScreen = false;
  let menuFrameLines = 0;
  const menuKeyQueue: string[] = [];

  const setMenuRaw = (enabled: boolean) => {
    if (!process.stdin.isTTY) return;
    if (enabled && !menuRaw) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      menuRaw = true;
    } else if (!enabled && menuRaw) {
      try { process.stdin.setRawMode(false); } catch { /* */ }
      process.stdin.pause();
      menuRaw = false;
    }
  };

  const setMenuScreen = (enabled: boolean) => {
    if (!_TTY) return;
    if (enabled && !menuScreen) {
      process.stdout.write("\x1b[?25l");
      menuScreen = true;
    } else if (!enabled && menuScreen) {
      process.stdout.write("\x1b[?25h");
      menuScreen = false;
      menuFrameLines = 0;
    }
  };

  const clearMenuFrame = () => {
    if (!_TTY || menuFrameLines <= 0) return;
    process.stdout.write(`\x1b[${menuFrameLines}F\x1b[J`);
    menuFrameLines = 0;
  };

  const suspendLandingForAction = () => {
    clearMenuFrame();
    setMenuScreen(false);
  };

  const menuCleanup = () => {
    menuRunning = false;
    setMenuRaw(false);
    setMenuScreen(false);
    teardownHooks(true, true);
    if (!menuScreen) process.stdout.write("\x1b[?25h"); // ensure cursor visible
    process.exit(0);
  };
  process.once("SIGINT", menuCleanup);
  process.once("SIGTERM", menuCleanup);

  const menuActions = () => [
    { key: "1", label: "monitor", desc: "Open live TUI dashboard", enabled: true },
    { key: "2", label: "setup", desc: "Choose local/global hook focus", enabled: true },
    { key: "3", label: "status", desc: "Print current sessions", enabled: true },
    { key: "w", label: "web", desc: "Open browser dashboard", enabled: true },
  ];

  const renderLanding = async () => {
    setMenuScreen(true);
    const result = await fetchSessions();
    menuSessions = result.error ? [] : result.sessions;
    menuServerRunning = !result.error || pidAlive();

    if (_TTY && menuFrameLines > 0) process.stdout.write(`\x1b[${menuFrameLines}F\x1b[J`);
    else console.log("");
    let printed = _TTY && menuFrameLines > 0 ? 0 : 1;
    const out = (line = "") => {
      console.log(line);
      printed++;
    };

    const working = menuSessions.filter((s: any) => s.status === "working").length;
    const errored = menuSessions.filter((s: any) => s.status === "error").length;
    const blocked = menuSessions.filter((s: any) => s.status === "blocked").length;
    const idle = menuSessions.filter((s: any) => s.status === "idle").length;
    const status = menuServerRunning ? `${_GN}online${_D}` : `${_K}offline${_D}`;
    const activity = [
      working > 0 ? `${_BL}${working} working${_D}` : "",
      blocked > 0 ? `${_YL}${blocked} blocked${_D}` : "",
      errored > 0 ? `${_RD}${errored} error${_D}` : "",
      idle > 0 ? `${_K}${idle} idle${_D}` : "",
    ].filter(Boolean).join(` ${_K}|${_D} `);

    const w = Math.min((process.stdout.columns || 80) - 4, 76);
    const canShowLogo = (process.stdout.rows || 24) >= 28 && w >= 65;
    if (canShowLogo) {
      for (const line of logoLines(w)) out(line);
    } else {
      const title = "SessionBar";
      let line = "";
      for (let i = 0; i < title.length; i++) line += `${RAINBOW[i % RAINBOW.length]}${_B}${title[i]}${_D}`;
      out(`  ${line} ${_K}local multi-agent session monitor${_D}`);
      out(`  ${_K}${"─".repeat(Math.max(20, w))}${_D}`);
    }

    const dot = menuServerRunning ? `${_GN}●${_D}` : `${_K}○${_D}`;
    out(`${panelTop("Status", w)}`);
    let statusLine = `${dot} ${status}    ${_K}:${PORT}${_D}    ${_B}${menuSessions.length}${_D} session${menuSessions.length !== 1 ? "s" : ""}`;
    if (activity) statusLine += `    ${activity}`;
    out(panelRow(statusLine, w));
    if (result.error) out(panelRow(`${_RD}${result.error}${_D}`, w));
    out(panelBot(w));

    if (menuSessions.length > 0) {
      out("");
      out(panelTop("Sessions", w));
      for (const s of menuSessions.slice(0, 4)) {
        const style = S[s.status as keyof typeof S] || S.idle;
        const sd = `${style.c}${style.icon}${_D}`;
        const ai = `${typeIcon(s.session_type || "?")} ${agentName(s.session_type || "?", 12)}`;
        const line = `${sd} ${ai.padEnd(14)} ${projectLabel(s).padEnd(16)} ${statusShort(s.status).padEnd(5)} ${age(s.timestamp || Date.now()).padStart(4)}`;
        out(panelRow(line, w));
      }
      if (menuSessions.length > 4) out(panelRow(`${_K}+${menuSessions.length - 4} more sessions${_D}`, w));
      out(panelBot(w));
    }

    out("");
    out(panelTop("Commands", w));
    const actions = menuActions();
    selectedAction = Math.max(0, Math.min(selectedAction, actions.length - 1));
    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];
      const marker = i === selectedAction ? `${_B}${_BL}>${_D}` : " ";
      const key = action.key.toUpperCase();
      const label = `${key}. ${action.label}`.padEnd(12);
      const row = action.enabled
        ? `${marker} ${_B}${label}${_D} ${_K}${action.desc}${_D}`
        : `${marker} ${_K}${label} ${action.desc}${_D}`;
      out(panelRow(row, w));
    }
    out(panelRow(`${_K}↑↓/jk select  Enter run  R refresh  Q quit${_D}`, w));
    out(panelBot(w));
    out("");
    if (_TTY) process.stdout.write("\x1b[J");
    menuFrameLines = printed;
  };

  const parseMenuKeys = (raw: string): string[] => {
    const keys: string[] = [];
    for (let i = 0; i < raw.length; i++) {
      if (raw.startsWith("\x1b[A", i) || raw.startsWith("\x1bOA", i)) {
        keys.push("up");
        i += raw[i + 1] === "[" ? 2 : 2;
        continue;
      }
      if (raw.startsWith("\x1b[B", i) || raw.startsWith("\x1bOB", i)) {
        keys.push("down");
        i += raw[i + 1] === "[" ? 2 : 2;
        continue;
      }
      const ch = raw[i];
      if (ch === "\x03") keys.push("q");
      else if (ch === "\r" || ch === "\n") keys.push("enter");
      else if (ch === "k" || ch === "K") keys.push("up");
      else if (ch === "j" || ch === "J") keys.push("down");
      else if ("123qrRwW".includes(ch)) keys.push(ch.toLowerCase());
    }
    return keys;
  };

  const readMenuKey = async (): Promise<string> => {
    const queued = menuKeyQueue.shift();
    if (queued) return queued;
    if (!process.stdin.isTTY) return (await ask("> ")).trim().toLowerCase();
    setMenuRaw(true);
    return new Promise(resolve => {
      const onData = (buf: Buffer) => {
        menuKeyQueue.push(...parseMenuKeys(buf.toString()));
        resolve(menuKeyQueue.shift() || "");
      };
      process.stdin.once("data", onData);
    });
  };

  const runAction = async (key: string) => {
    setMenuRaw(false);
    if (key === "1") {
      suspendLandingForAction();
      await watch();
      needsRender = true;
      return;
    }
    if (key === "2") {
      suspendLandingForAction();
      console.log("\nSessionBar service starts automatically when the app opens.");
      console.log("Setup only chooses which Claude Code sessions report into it.\n");
      const a = await ask("[l] Local focus  |  [g] Global focus\n> ");
      await setupHooks(a.toLowerCase().startsWith("g"));
      await ask("\nPress enter...");
      needsRender = true;
      return;
    }
    if (key === "3") {
      suspendLandingForAction();
      console.log();
      try { render(menuSessions, 0); } catch { /* render failed */ }
      await ask("");
      needsRender = true;
      return;
    }
    if (key === "w" || key === "web") {
      suspendLandingForAction();
      useWeb = true;
      if (menuServerRunning) stopServer();
      await delay(300);
      if (!startServer() || !(await waitForReady())) {
        console.log("\nServer failed to start.");
        await ask("\nPress enter...");
        needsRender = true;
        return;
      }
      await injectHooksOnServerReady(true);
      console.log(`\nDashboard: ${API_BASE}`);
      spawn("open", [API_BASE], { detached: true, stdio: "ignore" }).unref();
      await ask("\nPress enter...");
      needsRender = true;
      return;
    }
  };

  while (menuRunning) {
    if (needsRender) {
      await renderLanding();
      needsRender = false;
    }

    const c = await readMenuKey();
    if (!c) continue;
    if (c === "q" || c === "quit") { menuRunning = false; break; }
    if (c === "up") {
      selectedAction = (selectedAction + menuActions().length - 1) % menuActions().length;
      needsRender = true;
      continue;
    }
    if (c === "down") {
      selectedAction = (selectedAction + 1) % menuActions().length;
      needsRender = true;
      continue;
    }
    if (c === "enter") {
      await runAction(menuActions()[selectedAction].key);
      continue;
    }
    if (c === "r" || c === "refresh") {
      needsRender = true;
      continue;
    }
    if (["1", "2", "3", "w", "web"].includes(c)) {
      await runAction(c);
      continue;
    }
    // Ignore unbound keys in the landing menu. This keeps the inline frame stable
    // even if a key repeats or multiple bytes arrive in one terminal read.
  }
  setMenuRaw(false);
  setMenuScreen(false);
  teardownHooks(true, true);
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
      await menu();
  }
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
