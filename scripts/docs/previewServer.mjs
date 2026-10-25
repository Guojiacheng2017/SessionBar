import express from "express";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { sampleData } from "./sampleData.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const home = process.env.SESSIONBAR_PREVIEW_HOME || join(homedir(), ".sessionbar", "readme-preview");
mkdirSync(home, { recursive: true, mode: 0o700 });
const xtermModule = process.env.SESSIONBAR_XTERM_MODULE;
const xtermCss = process.env.SESSIONBAR_XTERM_CSS;
if (!xtermModule || !xtermCss) throw new Error("Provide xterm module and stylesheet paths");
const app = express();
const terminals = new Map();
const sessionStreams = new Set();
let streamsEnabled = true;
function terminalOptions(req) {
  const view = (req.params.view || req.query.view) === "landing" ? "landing" : "monitor";
  const dimension = (value, fallback, min, max) => {
    const number = Number(value);
    return Number.isInteger(number) && number >= min && number <= max ? number : fallback;
  };
  const cols = dimension(req.query.cols, view === "landing" ? 84 : 140, 40, 240);
  const rows = dimension(req.query.rows, 44, 16, 80);
  return { view, cols, rows, key: `${view}:${cols}:${rows}` };
}
app.use(express.json({ limit: "32kb" }));
// Preview-only fault injection; never mounted by the production relay.
// 仅用于预览的故障注入，不会挂载到生产服务。
app.post("/__preview/connection", (req, res) => {
  streamsEnabled = req.body.online === true;
  if (!streamsEnabled) for (const stream of sessionStreams) stream.end();
  res.json({ online: streamsEnabled });
});
app.get("/health", (_req, res) => res.json({ service: "sessionbar", port: server.address().port, web: true }));
app.get("/system/live", (_req, res) => res.json({ system: sampleData().system }));
app.get("/providers/live", (_req, res) => res.json({ providers: sampleData().providers }));
app.get("/sessions/live", (_req, res) => res.json(sampleData().sessions));
app.get("/sessions/stream", (req, res) => {
  if (!streamsEnabled) return res.sendStatus(503);
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  sessionStreams.add(res);
  res.write(`data: ${JSON.stringify(sampleData().sessions)}\n\n`);
  const timer = setInterval(() => res.write(": keepalive\n\n"), 15_000);
  req.on("close", () => { clearInterval(timer); sessionStreams.delete(res); });
});
app.get("/__preview/xterm.js", (_req, res) => res.type("text/javascript").send(readFileSync(xtermModule)));
app.get("/__preview/xterm.css", (_req, res) => res.type("text/css").send(readFileSync(xtermCss)));
app.use("/__preview", express.static(dirname(xtermModule)));
app.post("/__preview/input/:view", (req, res) => {
  if (typeof req.body.key === "string" && req.body.key.length < 1024) terminals.get(terminalOptions(req).key)?.child.stdin.write(`${JSON.stringify(req.body.key)}\n`);
  res.json({ ok: true });
});
app.get("/__preview/output/:view", (req, res) => {
  if (req.params.view !== "landing" && req.params.view !== "monitor") return res.sendStatus(404);
  const { view, cols, rows, key } = terminalOptions(req);
  let terminal = terminals.get(key);
  if (!terminal || terminal.child.exitCode !== null || terminal.child.signalCode !== null) {
    const child = spawn(process.env.SESSIONBAR_PREVIEW_PYTHON || "python3", [
      join(root, "scripts/docs/ptyBridge.py"), String(rows), String(cols),
      "bun", join(root, "scripts/docs/tuiPreview.mjs"), view,
    ], { cwd: root, env: { ...process.env, SESSIONBAR_PREVIEW_PORT: String(server.address().port) }, stdio: ["pipe", "pipe", "pipe"] });
    terminal = { child, chunks: [], clients: new Set() };
    terminals.set(key, terminal);
    child.stdout.on("data", bytes => {
      const chunk = bytes.toString("base64");
      terminal.chunks.push(chunk);
      for (const client of terminal.clients) client.write(`data: ${JSON.stringify(chunk)}\n\n`);
    });
    child.stderr.on("data", bytes => console.error(bytes.toString()));
  }
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  terminal.clients.add(res);
  for (const chunk of terminal.chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  req.on("close", () => terminal.clients.delete(res));
});
app.get("/__preview/terminal", (req, res) => {
  const { view, cols, rows } = terminalOptions(req);
  res.type("html").send(`<!doctype html><html><head><link rel="stylesheet" href="/__preview/xterm.css">
  <style>body{margin:0;background:#1e2022;padding:20px;width:max-content}#terminal{width:max-content}</style></head>
  <body><div id="terminal"></div><script type="module">
  import xterm from '/__preview/xterm.js';
  const term = new xterm.Terminal({cols:${cols},rows:${rows},fontSize:14,
    fontFamily:'Menlo, monospace',lineHeight:1.18,scrollback:0,allowTransparency:true,
    theme:{background:'#1e2022',foreground:'#e5e7eb',cursor:'#1e2022'}});
  term.open(document.getElementById('terminal')); window.term = term;
  term.onData(key => fetch('/__preview/input/${view}?cols=${cols}&rows=${rows}',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({key})}));
  const stream = new EventSource('/__preview/output/${view}?cols=${cols}&rows=${rows}');
  stream.onmessage = event => term.write(Uint8Array.from(atob(JSON.parse(event.data)),c=>c.charCodeAt(0)));
  </script></body></html>`);
});
app.use(express.static(join(root, "public")));
app.use("/dist", express.static(join(root, "dist")));
const server = app.listen(0, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${server.address().port}`;
  writeFileSync(join(home, "url"), url, { mode: 0o600 });
  console.log(`Documentation preview: ${url}`);
});
server.on("error", error => {
  console.error(`Could not start documentation preview: ${error.message}`);
  process.exitCode = 1;
});
function stop() {
  for (const terminal of terminals.values()) terminal.child.kill("SIGTERM");
  server.closeAllConnections();
  server.close(() => process.exit(0));
}
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
