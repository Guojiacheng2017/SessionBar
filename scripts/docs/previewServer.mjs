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
app.use(express.json({ limit: "32kb" }));
app.get("/health", (_req, res) => res.json({ service: "sessionbar", port: server.address().port, web: true }));
app.get("/system/live", (_req, res) => res.json({ system: sampleData().system }));
app.get("/providers/live", (_req, res) => res.json({ providers: sampleData().providers }));
app.get("/sessions/live", (_req, res) => res.json(sampleData().sessions));
app.get("/sessions/stream", (req, res) => {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  res.write(`data: ${JSON.stringify(sampleData().sessions)}\n\n`);
  const timer = setInterval(() => res.write(": keepalive\n\n"), 15_000);
  req.on("close", () => clearInterval(timer));
});
app.get("/__preview/xterm.js", (_req, res) => res.type("text/javascript").send(readFileSync(xtermModule)));
app.get("/__preview/xterm.css", (_req, res) => res.type("text/css").send(readFileSync(xtermCss)));
app.use("/__preview", express.static(dirname(xtermModule)));
app.post("/__preview/input/:view", (req, res) => {
  if (typeof req.body.key === "string" && req.body.key.length < 1024) terminals.get(req.params.view)?.child.stdin.write(`${JSON.stringify(req.body.key)}\n`);
  res.json({ ok: true });
});
app.get("/__preview/output/:view", (req, res) => {
  const view = req.params.view;
  if (view !== "landing" && view !== "monitor") return res.sendStatus(404);
  let terminal = terminals.get(view);
  if (!terminal) {
    const child = spawn(process.env.SESSIONBAR_PREVIEW_PYTHON || "python3", [
      join(root, "scripts/docs/ptyBridge.py"), "44", view === "landing" ? "84" : "140",
      "bun", join(root, "scripts/docs/tuiPreview.mjs"), view,
    ], { cwd: root, env: { ...process.env, SESSIONBAR_PREVIEW_PORT: String(server.address().port) }, stdio: ["pipe", "pipe", "pipe"] });
    terminal = { child, chunks: [], clients: new Set() };
    terminals.set(view, terminal);
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
  const view = req.query.view === "landing" ? "landing" : "monitor";
  res.type("html").send(`<!doctype html><html><head><link rel="stylesheet" href="/__preview/xterm.css">
  <style>body{margin:0;background:#1e2022;padding:20px;width:max-content}#terminal{width:max-content}</style></head>
  <body><div id="terminal"></div><script type="module">
  import xterm from '/__preview/xterm.js';
  const term = new xterm.Terminal({cols:${view === "landing" ? 84 : 140},rows:44,fontSize:14,
    fontFamily:'Menlo, monospace',lineHeight:1.18,scrollback:0,allowTransparency:true,
    theme:{background:'#1e2022',foreground:'#e5e7eb',cursor:'#1e2022'}});
  term.open(document.getElementById('terminal')); window.term = term;
  term.onData(key => fetch('/__preview/input/${view}',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({key})}));
  const stream = new EventSource('/__preview/output/${view}');
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
function stop() {
  for (const terminal of terminals.values()) terminal.child.kill("SIGTERM");
  server.closeAllConnections();
  server.close(() => process.exit(0));
}
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
