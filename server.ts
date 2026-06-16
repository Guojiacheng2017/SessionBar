import express from "express";
import cors from "cors";
import { writeFileSync, unlinkSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, Dirent } from "fs";
import { join, dirname, basename } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { createHash } from "crypto";
import { SessionPayload } from "./types.js";
import { syncToICloud } from "./icloud.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
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

if (!existsSync(HOME)) mkdirSync(HOME, { recursive: true });
if (!existsSync(SESSION_ID_DIR)) mkdirSync(SESSION_ID_DIR, { recursive: true });

function cleanup() {
  clearInterval(heartbeatInterval);
  clearInterval(purgeInterval);
  try { unlinkSync(PID_FILE); } catch { /* ignore */ }
}

const sessions: Record<string, SessionPayload> = {};
const sseClients = new Set<express.Response>();

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

function validatePayload(body: any): body is SessionPayload {
  if (!body || typeof body !== "object") return false;
  if (typeof body.session_id !== "string" || !body.session_id) return false;
  if (typeof body.session_type !== "string" || !body.session_type) return false;
  if (!["idle", "working", "blocked", "error"].includes(body.status)) return false;
  if (body.progress !== undefined && (typeof body.progress !== "number" || body.progress < 0 || body.progress > 1)) return false;
  if (body.context_percent !== undefined && (typeof body.context_percent !== "number" || body.context_percent < 0 || body.context_percent > 100)) return false;
  if (body.tokens !== undefined && (typeof body.tokens !== "number" || body.tokens < 0)) return false;
  if (body.turns !== undefined && (typeof body.turns !== "number" || body.turns < 0)) return false;
  if (typeof body.task_name !== "string" || body.task_name.length > 500) return false;
  if (body.project !== undefined && typeof body.project !== "string") return false;
  if (body.project_path !== undefined && typeof body.project_path !== "string") return false;
  return true;
}

function markerScopeSuffix(file: string): string {
  const scopeKey = file.replace(/^sessionbar-id-/, "");
  return createHash("md5").update(scopeKey).digest("hex").slice(0, 8);
}

function scopedSessionId(sid: string, file: string): string {
  const suffix = markerScopeSuffix(file);
  const sep = sid.indexOf("__");
  const raw = sep === -1 ? sid : sid.slice(0, sep);
  const project = sep === -1 ? "" : sid.slice(sep);
  return raw.endsWith(`-${suffix}`) ? sid : `${raw}-${suffix}${project}`;
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

  const discovered = new Set<string>();
  for (const file of files.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 80)) {
    const first = readFirstJsonLine(file.path);
    const meta = first?.type === "session_meta" ? first.payload : null;
    if (!isCodexTopLevel(meta)) continue;

    const project = basename(meta.cwd);
    const sid = `codex-${meta.id}__${project}`;
    discovered.add(sid);
    const isActive = now - file.mtimeMs <= CODEX_ACTIVE_MS;
    sessions[sid] = {
      session_id: sid,
      session_type: "Codex",
      status: isActive ? "working" : "idle",
      task_name: isActive ? "Active Codex session" : "Ready",
      timestamp: file.mtimeMs,
      project,
      project_path: meta.cwd,
    };
  }

  for (const id of Object.keys(sessions)) {
    if (/^codex-[0-9a-f-]{36}__/.test(id) && !discovered.has(id)) {
      delete sessions[id];
    }
  }
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
const heartbeatInterval = setInterval(() => {
  for (const c of sseClients) {
    try { c.write(":\n"); } catch {
      sseClients.delete(c);
    }
  }
}, 15_000);

// Auto-purge: only remove sessions whose owning CLI session has ended.
// Sessions stay alive while the CLI process is open — even if idle for minutes.
const purgeInterval = setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const id of Object.keys(sessions)) {
    const s = sessions[id];
    // Case 1: Explicit SessionEnd — remove after 5s grace so TUI can show final state
    if (s.status === "idle" && s.task_name === "Session ended" && now - s.timestamp > 5_000) {
      delete sessions[id];
      changed = true;
      console.log(`[purge] ${id} (ended)`);
    }
    // Case 2: Crash recovery — no heartbeat in 5min means the CLI process is gone
    else if (now - s.timestamp > 300_000) {
      delete sessions[id];
      changed = true;
      console.log(`[purge] ${id} (timeout — assumed crashed)`);
    }
  }
  if (changed) {
    broadcastSSE();
    if (process.env.SESSIONBAR_ICLOUD) syncToICloud(sorted());
  }
}, 10_000);

// POST: session reports its status
app.post("/session/status", (req, res) => {
  if (!validatePayload(req.body)) {
    res.status(400).json({ ok: false, error: "invalid payload" });
    return;
  }
  const data = req.body;
  const prev = sessions[data.session_id];
  sessions[data.session_id] = {
    session_id: data.session_id,
    session_type: data.session_type,
    status: data.status,
    task_name: data.task_name,
    progress: data.progress,
    context_percent: data.context_percent ?? prev?.context_percent,
    tokens: data.tokens ?? prev?.tokens,
    turns: data.turns ?? prev?.turns,
    timestamp: Date.now(),
    project: data.project || prev?.project,
    project_path: data.project_path || prev?.project_path,
  };
  console.log(`[session] ${data.session_id} → ${data.status}`);
  broadcastSSE();
  if (process.env.SESSIONBAR_ICLOUD) syncToICloud(sorted());
  res.json({ ok: true });
});

// GET: current state
app.get("/sessions/live", (_req, res) => {
  res.json(sorted());
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
    console.log(`[session] ${id} → removed`);
    broadcastSSE();
    if (process.env.SESSIONBAR_ICLOUD) syncToICloud(sorted());
  }
  res.json({ ok: true });
});

app.listen(PORT, HOST, () => {
  writeFileSync(PID_FILE, String(process.pid));
  console.log(`SessionBar on http://${HOST}:${PORT}`);
  if (WEB_ENABLED) console.log(`Dashboard: http://${HOST}:${PORT}`);
  recoverSessions();
});

process.on("SIGTERM", () => { cleanup(); process.exit(0); });
process.on("SIGINT", () => { cleanup(); process.exit(0); });
process.on("uncaughtException", () => { cleanup(); process.exit(1); });
