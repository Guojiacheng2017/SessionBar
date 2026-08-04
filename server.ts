import express from "express";
import cors from "cors";
import { writeFileSync, unlinkSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, openSync, readSync, closeSync, Dirent } from "fs";
import { join, dirname, basename, resolve } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { SessionPayload } from "./types.js";
import { mergeSessionPayload, validateSessionPayload } from "./sessionPayload.js";
import { syncToICloud } from "./icloud.js";
import { removeSessionMarkerFiles, scopedSessionId } from "./sessionMarkers.js";
import { mergeCodexDiscovery } from "./codexSessionMerge.js";
import { pollProvider, providerConfigsFromEnv } from "./providerAdapters.js";
import { applyProviderPollResults } from "./providerMonitor.js";
import { computeAdvisorRows } from "./quotaAdvisor.js";
import { computePlanRows } from "./planAdvisor.js";
import type { PlanRow } from "./planTypes.js";
import { RateBuffer } from "./rateBuffer.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Start the HTTP server + polling loops only when run directly
// (`node dist/server.js`, how cli.ts spawns it) — not when the module is
// imported by tests. Otherwise app.listen would bind the port and the timers
// would hold the test process's event loop open.
const isDirectRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const PORT = parseInt(process.env.PORT || "8989", 10);
const HOST = process.env.SESSIONBAR_HOST || "127.0.0.1";

const app = express();
app.use(express.json());
app.use(cors({
  origin(origin, callback) {
    callback(null, isAllowedOrigin(origin));
  },
}));

function isAllowedOrigin(origin?: string): boolean {
  if (!origin) return true;
  try {
    const url = new URL(origin);
    const localHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
    return localHosts.has(url.hostname);
  } catch {
    return false;
  }
}

// Extended feature: web dashboard (opt-in via SESSIONBAR_WEB=1)
const WEB_ENABLED = process.env.SESSIONBAR_WEB === "1";
if (WEB_ENABLED) {
  const staticRoot = join(__dirname, ".."); // up from dist/ to project root
  app.use(express.static(staticRoot));
  app.get("/", (_req, res) => {
    res.sendFile(join(staticRoot, "index.html"));
  });
}

const HOME = process.env.SESSIONBAR_HOME || process.env.AGENTBAR_HOME || join(homedir(), ".sessionbar");
const PID_FILE = join(HOME, "server.pid");
const SESSION_ID_DIR = join(HOME, "sessions");
const CODEX_HOME = process.env.CODEX_HOME || join(homedir(), ".codex");
const CODEX_SESSION_DIR = join(CODEX_HOME, "sessions");
const CODEX_DISCOVERY_WINDOW_MS = parseInt(process.env.SESSIONBAR_CODEX_DISCOVERY_MS || String(24 * 60 * 60 * 1000), 10);
const CODEX_ACTIVE_MS = parseInt(process.env.SESSIONBAR_CODEX_ACTIVE_MS || String(10 * 60 * 1000), 10);
const ACTIVITY_TAIL_BYTES = parseInt(process.env.SESSIONBAR_ACTIVITY_TAIL_BYTES || String(192 * 1024), 10);
const PROVIDER_POLL_ENABLED = process.env.SESSIONBAR_PROVIDER_POLL !== "0";
const PROVIDER_POLL_MS = Math.max(30_000, parseInt(process.env.SESSIONBAR_PROVIDER_POLL_MS || String(5 * 60 * 1000), 10));
const providerConfigs = PROVIDER_POLL_ENABLED ? providerConfigsFromEnv(process.env) : [];
let providerPollInterval: NodeJS.Timeout | undefined;

if (!existsSync(HOME)) mkdirSync(HOME, { recursive: true });
if (!existsSync(SESSION_ID_DIR)) mkdirSync(SESSION_ID_DIR, { recursive: true });

function cleanup() {
  clearInterval(heartbeatInterval);
  clearInterval(purgeInterval);
  if (providerPollInterval) clearInterval(providerPollInterval);
  removeClaudeHooks();
  try { unlinkSync(PID_FILE); } catch { /* ignore */ }
}

function removeClaudeHooks() {
  const settingsPath = join(homedir(), ".claude", "settings.json");
  let settings: any;
  try {
    settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
  } catch { return; }
  if (!settings.hooks) return;

  let changed = false;
  for (const event of Object.keys(settings.hooks)) {
    const before = settings.hooks[event].length;
    settings.hooks[event] = settings.hooks[event].filter((d: any) => {
      return !d.hooks?.some?.((h: any) => {
        const cmd = h.command || "";
        return /(^|\/)report\.sh(\s|$)/.test(cmd) && /\bSESSIONBAR_AGENT=claude\b/.test(cmd);
      });
    });
    if (settings.hooks[event].length !== before) changed = true;
    if (settings.hooks[event].length === 0) delete settings.hooks[event];
  }

  if (changed) {
    try {
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
      console.log("[cleanup] removed Claude hooks");
    } catch { /* ignore */ }
  }
}

const sessions: Record<string, SessionPayload> = {};
const sseClients = new Set<express.Response>();

const rateBuffers = new Map<string, RateBuffer>();

// Global subscription plan rows, refreshed on every provider poll cycle.
let subscriptionRows: PlanRow[] = [];
export function getSubscriptionRows(): PlanRow[] { return subscriptionRows; }

/**
 * Merge global subscription rows with every session's display-only "api" rows
 * (advisorRows entries where form === "api"). Rows are deduped by
 * `${provider}:${form}:${label}` — keep the first occurrence — so the same
 * provider/form/label reported by multiple sessions collapses to one row, while
 * distinct subscription rows (e.g. Anthropic 5h vs weekly, different labels)
 * and subscription vs api forms of the same provider are all preserved.
 */
export function aggregateProviders(
  subscriptionRows: PlanRow[],
  sessions: Record<string, SessionPayload>,
): PlanRow[] {
  const apiRows = Object.values(sessions)
    .flatMap(s => s.advisorRows?.filter(r => r.form === "api") ?? []);
  const seen = new Map<string, PlanRow>();
  for (const row of [...subscriptionRows, ...apiRows]) {
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
  switch (row.provider.toLowerCase()) {
    case "openai":
      return /codex|openai|chatgpt/.test(type);
    case "anthropic":
      return /claude|anthropic/.test(type);
    case "kimi":
      return /kimi|moonshot/.test(type);
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

function advisorFingerprint(): string {
  const snapshot: Record<string, unknown> = {};
  for (const id of Object.keys(sessions)) snapshot[id] = sessions[id].advisorRows;
  return JSON.stringify(snapshot);
}

async function refreshProviderSignals() {
  const now = Date.now();
  let changed = false;
  if (providerConfigs.length > 0) {
    const results = await Promise.all(providerConfigs.map(config => pollProvider(config)));
    changed = applyProviderPollResults(sessions, results);
  }
  // Refresh global subscription rows every poll — adapters read their own
  // credential files, so rows appear regardless of providerConfigs.
  subscriptionRows = await computePlanRows({ now });
  // Advisor is computed regardless of providerConfigs — subscription adapters
  // (wham/anthropic/kimi) read their own credential files, so a user with only
  // ~/.codex/auth.json still gets subscription rows even when no provider API
  // keys are configured.
  const before = advisorFingerprint();
  for (const session of Object.values(sessions)) {
    const apiRows = await computeAdvisorRows(session, rateBuffers, now);
    session.advisorRows = sessionAdvisorRows(session, apiRows, subscriptionRows);
  }
  // Broadcast when provider signals OR advisor rows changed (card expiry / reset
  // countdowns move even when provider signals are stable).
  if (!changed && advisorFingerprint() === before) return;
  broadcastSSE();
  if (process.env.SESSIONBAR_ICLOUD) syncToICloud(sorted());
}

function startProviderPolling() {
  // Start unconditionally — refreshProviderSignals gates the provider poll on
  // providerConfigs internally, so the advisor still ticks (card expiry / reset
  // countdowns) even when no provider API keys are configured.
  void refreshProviderSignals();
  providerPollInterval = setInterval(() => void refreshProviderSignals(), PROVIDER_POLL_MS);
}

function sorted(): SessionPayload[] {
  refreshCodexSessions();
  dedupeSessions();
  return Object.values(sessions).sort((a, b) =>
    stableSessionSortKey(a).localeCompare(stableSessionSortKey(b))
  );
}

function broadcastSSE() {
  const data = `data: ${JSON.stringify(sorted())}\n\n`;
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

function readFirstJsonLine(path: string): any | null {
  try {
    const first = readFileSync(path, "utf-8").split("\n", 1)[0];
    return first ? JSON.parse(first) : null;
  } catch {
    return null;
  }
}

function isCodexTopLevel(meta: any): boolean {
  if (!meta || typeof meta !== "object") return false;
  if (typeof meta.cwd !== "string" || !meta.cwd) return false;
  if (typeof meta.id !== "string" || !meta.id) return false;
  if (!String(meta.originator || "").toLowerCase().includes("codex")) return false;
  if (meta.thread_source === "subagent" || meta.source?.subagent) return false;
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

function codexActivityFromJsonl(path: string, isActive: boolean): { taskName: string; tail: string[] } {
  if (!isActive) return { taskName: "Ready", tail: [] };

  const lines = readTail(path, ACTIVITY_TAIL_BYTES).split("\n").filter(Boolean);
  const pending = new Map<string, string>();
  const calls = new Map<string, string>();
  const tail: string[] = [];
  const pushTail = (line: string) => {
    const clean = compactLine(line, 160);
    if (!clean || tail.at(-1) === clean) return;
    tail.push(clean);
  };

  for (const line of lines) {
    let item: any;
    try { item = JSON.parse(line); } catch { continue; }
    const payload = item?.payload || {};

    if (item.type === "response_item" && payload.type === "function_call") {
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
  if (pendingLabel) return { taskName: `running: ${pendingLabel}`, tail: recent };
  return { taskName: recent.at(-1) || "Active Codex session", tail: recent };
}

function refreshCodexSessions() {
  const now = Date.now();
  const files: Array<{ path: string; mtimeMs: number }> = [];
  const all: string[] = [];
  collectJsonlFiles(CODEX_SESSION_DIR, 3, all);
  for (const path of all) {
    try {
      const stat = statSync(path);
      if (now - stat.mtimeMs <= CODEX_DISCOVERY_WINDOW_MS) files.push({ path, mtimeMs: stat.mtimeMs });
    } catch { /* skip unreadable files */ }
  }

  const discoveries: SessionPayload[] = [];
  for (const file of files.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 80)) {
    const first = readFirstJsonLine(file.path);
    const meta = first?.type === "session_meta" ? first.payload : null;
    if (!isCodexTopLevel(meta)) continue;

    const project = basename(meta.cwd);
    const sid = `codex-${meta.id}__${project}`;
    const isActive = now - file.mtimeMs <= CODEX_ACTIVE_MS;
    const activity = codexActivityFromJsonl(file.path, isActive);
    discoveries.push({
      session_id: sid,
      session_type: "Codex",
      source: "codex_jsonl",
      status: isActive ? "working" : "idle",
      task_name: activity.taskName,
      activity_tail: activity.tail,
      timestamp: file.mtimeMs,
      project,
      project_path: meta.cwd,
    });
  }

  mergeCodexDiscovery(sessions, discoveries);
}

// Recover sessions that were already running before the server started.
// ID file existence IS the liveness signal — report.sh deletes it on SessionEnd.
// (The PID embedded in session_id is the shell $$ at creation time, long dead;
//  don't check it — the ID file alone tells us the session is open.)
// Crash safety: if Claude Code dies without SessionEnd, the 5-min purge removes it.
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
        if (sessions[sid]) continue;

        const type = markerAgent(f);
        const typeMap: Record<string, string> = {
          claude: "Claude Code", gemini: "Gemini CLI",
          codex: "Codex", copilot: "Copilot",
        };
        sessions[sid] = {
          session_id: sid,
          session_type: typeMap[type] || type,
          source: "hook",
          status: "idle",
          task_name: "Ready",
          timestamp: Date.now(),
        };
        console.log(`[recover] ${sid}`);
      } catch { /* corrupt ID file, skip */ }
    }
    if (Object.keys(sessions).length > 0) {
      broadcastSSE();
      if (process.env.SESSIONBAR_ICLOUD) syncToICloud(sorted());
    }
  } catch { /* state dir not readable */ }
}

// SSE heartbeat — detect dead connections
let heartbeatInterval: NodeJS.Timeout | undefined;
let purgeInterval: NodeJS.Timeout | undefined;
if (isDirectRun) {
  heartbeatInterval = setInterval(() => {
    for (const c of sseClients) {
      try { c.write(":\n"); } catch {
        sseClients.delete(c);
      }
    }
  }, 15_000);

  // Auto-purge: only remove sessions whose owning CLI session has ended.
  // Sessions stay alive while the CLI process is open — even if idle for minutes.
  purgeInterval = setInterval(() => {
    const now = Date.now();
    let changed = false;
    for (const id of Object.keys(sessions)) {
      const s = sessions[id];
      // Case 1: Explicit SessionEnd — remove after 5s grace so TUI can show final state
      if (s.status === "idle" && s.task_name === "Session ended" && now - s.timestamp > 5_000) {
        delete sessions[id];
        removeSessionMarkerFiles(SESSION_ID_DIR, id);
        changed = true;
        console.log(`[purge] ${id} (ended)`);
      }
      // Case 2: Crash recovery — no heartbeat in 5min means the CLI process is gone
      else if (now - s.timestamp > 300_000) {
        delete sessions[id];
        removeSessionMarkerFiles(SESSION_ID_DIR, id);
        changed = true;
        console.log(`[purge] ${id} (timeout — assumed crashed)`);
      }
    }
    if (changed) {
      broadcastSSE();
      if (process.env.SESSIONBAR_ICLOUD) syncToICloud(sorted());
    }
  }, 10_000);
}

// POST: session reports its status
app.post("/session/status", (req, res) => {
  if (!validateSessionPayload(req.body)) {
    res.status(400).json({ ok: false, error: "invalid payload" });
    return;
  }
  const data = req.body;
  const prev = sessions[data.session_id];
  sessions[data.session_id] = mergeSessionPayload(prev, data, Date.now());
  console.log(`[session] ${data.session_id} → ${data.status}`);
  broadcastSSE();
  if (process.env.SESSIONBAR_ICLOUD) syncToICloud(sorted());
  res.json({ ok: true });
});

// GET: current state
app.get("/sessions/live", (_req, res) => {
  res.json(sorted());
});

// GET: aggregated provider plan rows (subscription + per-session api rows)
app.get("/providers/live", (_req, res) => {
  res.json({ providers: aggregateProviders(subscriptionRows, sessions) });
});

// GET: SSE stream
app.get("/sessions/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });
  res.on("error", () => { sseClients.delete(res); });
  sseClients.add(res);
  req.on("close", () => sseClients.delete(res));
  // Controlled reconnection: retry every 5s with jitter (EventSource spec)
  res.write("retry: 5000\n\n");
  res.write(`data: ${JSON.stringify(sorted())}\n\n`);
});

// DELETE: session explicitly removed
app.delete("/session/:id", (req, res) => {
  const id = req.params.id;
  if (sessions[id]) {
    delete sessions[id];
    removeSessionMarkerFiles(SESSION_ID_DIR, id);
    console.log(`[session] ${id} → removed`);
    broadcastSSE();
    if (process.env.SESSIONBAR_ICLOUD) syncToICloud(sorted());
  }
  res.json({ ok: true });
});

if (isDirectRun) {
  app.listen(PORT, HOST, () => {
    writeFileSync(PID_FILE, String(process.pid));
    console.log(`SessionBar on http://${HOST}:${PORT}`);
    if (WEB_ENABLED) console.log(`Dashboard: http://${HOST}:${PORT}`);
    recoverSessions();
    startProviderPolling();
  });

  process.on("SIGTERM", () => { cleanup(); process.exit(0); });
  process.on("SIGINT", () => { cleanup(); process.exit(0); });
  process.on("uncaughtException", () => { cleanup(); process.exit(1); });
}
