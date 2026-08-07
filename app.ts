// SessionBar web dashboard — Tailwind + vanilla TS
import type { SessionPayload } from "./types.js";
import {
  UI,
  countSessions,
  cx,
  detailListMarkup,
  escapeHtml,
  iconMarkup,
  statusDotMarkup,
  statusLabel,
  statusSummaryMarkup,
  tabsMarkup,
} from "./webComponents.js";

const portEl   = document.getElementById("port")!;
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

let disconnectedBanner: HTMLDivElement | null = null;
let selectedId: string | null = null;
let focusedProject: string | null = null;
let detailTab = 0; // 0=overview 1=activity 2=usage 3=flow 4=raw
let lastSessions: SessionPayload[] = [];
const iconCache = new Map<string, string>();

function extractProject(s: SessionPayload): string {
  if (s.project) return s.project;
  if (s.project_path) {
    const p = s.project_path.split("/");
    return p[p.length - 1] || s.project_path;
  }
  const sid = s.session_id || "";
  const sep = sid.indexOf("__");
  if (sep !== -1) return sid.slice(sep + 2);
  return sid.replace(/^(claude|gemini|codex|copilot|opencode|pi-agent|pi|kimi|qwen|deepseek|windsurf|cursor|workbuddy|minimax|opendesign)-/, "")
    .replace(/-\d+-\d+$/, "") || "?";
}

function icon(t: string): string {
  return iconMarkup(t, iconCache);
}

function age(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 10) return "now";
  if (s < 60) return s + "s";
  if (s < 3600) return Math.floor(s / 60) + "m";
  return Math.floor(s / 3600) + "h";
}

function detailHTML(s: SessionPayload): string {
  const p = extractProject(s);
  const ts = s.timestamp || Date.now();

  if (detailTab === 1) { // Activity
    const rows = [
      { label: "Task", value: s.task_name || "—" },
      { label: "Status", value: statusLabel(s.status) },
      { label: "Active", value: `${age(ts)} ago` },
    ];
    let d = detailListMarkup(rows);
    if (s.progress!==undefined) {
      const pct = Math.round(s.progress*100);
      d+=`<div class="flex items-center gap-2.5 my-4"><span class="text-[10px] text-muted uppercase tracking-[0.4px] w-[74px] shrink-0">Progress</span><div class="flex-1 h-1 bg-white/5 rounded-sm overflow-hidden"><div class="h-full bg-gradient-to-r from-[#5b8def] to-accent rounded-sm" style="width:${pct}%"></div></div><span class="mono text-[11px] text-muted">${pct}%</span></div>`;
    }
    d+=detailListMarkup([{ label: "Source", value: s.source || "—" }]);
    return d;
  }

  if (detailTab === 2) { // Usage
    const ctx = (s as any).context_percent;
    const tokens = (s as any).context_tokens;
    const turns = (s as any).turns;
    return detailListMarkup([
      { label: "Context", value: ctx!==undefined ? Math.round(ctx)+"%" : "—" },
      { label: "Tokens", value: tokens!==undefined ? String(tokens) : "—" },
      { label: "Turns", value: turns!==undefined ? String(turns) : "—" },
    ]);
  }

  if (detailTab === 3) { // Flow
    const rows = (s as any).advisorRows as any[]|undefined;
    if (!rows||rows.length===0) return `<div class="${UI.empty}">No flow data</div>`;
    let d = '<div class="text-[11px] leading-[1.8]">';
    for (const r of rows) {
      d+=`<div class="flex gap-2 py-1.5 border-b border-white/[0.04]"><span class="text-muted shrink-0">${escapeHtml(r.form||"?")}</span><span class="truncate">${escapeHtml(r.label||"?")}</span></div>`;
    }
    d+="</div>";
    return d;
  }

  if (detailTab === 4) { // Raw
    return `<pre class="mono text-[10px] text-gray-200 whitespace-pre-wrap break-all leading-[1.5]">${escapeHtml(JSON.stringify(s,null,2))}</pre>`;
  }

  // Overview (0, default)
  let d = detailListMarkup([
    { label: "Type", value: s.session_type || "?" },
    { label: "Project", value: s.project_path || p },
    { label: "Status", value: statusLabel(s.status) },
    { label: "Active", value: `${age(ts)} ago` },
    ...(s.task_name ? [{ label: "Task", value: s.task_name }] : []),
  ]);
  if (s.progress!==undefined) {
    const pct = Math.round(s.progress*100);
    d+=`<div class="flex items-center gap-2.5 my-4"><span class="text-[10px] text-muted uppercase tracking-[0.4px] w-[74px] shrink-0">Progress</span><div class="flex-1 h-1 bg-white/5 rounded-sm overflow-hidden"><div class="h-full bg-gradient-to-r from-[#5b8def] to-accent rounded-sm" style="width:${pct}%"></div></div><span class="mono text-[11px] text-muted">${pct}%</span></div>`;
  }
  d+=detailListMarkup([{ label: "ID", value: s.session_id }], "mt-3");
  return d;
}

function showMobileDetail(s: SessionPayload) {
  const existing = document.querySelector(".detail-overlay");
  if (existing) existing.remove();
  const ov = document.createElement("div");
  ov.className = "detail-overlay";
  ov.innerHTML =
    `<div class="overlay-header"><span>${escapeHtml(s.session_type||"Session")} / ${escapeHtml(extractProject(s))}</span><button class="overlay-close" aria-label="Close details">&times;</button></div>` +
    `<div class="overlay-body">${detailHTML(s)}</div>`;
  ov.querySelector("button")!.addEventListener("click", (e) => { e.stopPropagation(); ov.remove(); });
  ov.addEventListener("click", (e) => { if (e.target===ov) ov.remove(); });
  document.body.appendChild(ov);
}

// ── Disconnected ──

function showBanner(msg: string) {
  if (!disconnectedBanner) {
    disconnectedBanner = document.createElement("div");
    disconnectedBanner.className = "bg-red/90 text-white text-center text-[12px] font-semibold px-3.5 py-2 rounded-lg shrink-0 shadow-[0_8px_24px_rgba(217,74,62,0.18)]";
    document.getElementById("app")!.prepend(disconnectedBanner);
  }
  disconnectedBanner.textContent = msg;
}
function hideBanner() { if (disconnectedBanner) { disconnectedBanner.remove(); disconnectedBanner = null; } }

// ── Render ──

function render(sessions: SessionPayload[]) {
  hideBanner();
  const q = filterInput.value.trim().toLowerCase();

  let shown = sessions;
  if (q) {
    shown = sessions.filter(s =>
      extractProject(s).toLowerCase().includes(q) ||
      (s.task_name||"").toLowerCase().includes(q) ||
      (s.session_type||"").toLowerCase().includes(q));
    filterHint.textContent = shown.length + "/" + sessions.length + " sessions";
  } else { filterHint.textContent = ""; }

  // Port
  portEl.textContent = ":" + location.port;
  portEl.className = UI.connection;

  // Status summary — intentionally text-only; no proportional progress bar.
  countsEl.innerHTML = statusSummaryMarkup(countSessions(sessions));

  // Projects
  const groups = new Map<string,SessionPayload[]>();
  for (const s of shown) {
    const p = extractProject(s);
    if (!groups.has(p)) groups.set(p,[]);
    groups.get(p)!.push(s);
  }
  const sorted = [...groups.entries()].sort((a,b)=>Math.max(...b[1].map(s=>s.timestamp||0))-Math.max(...a[1].map(s=>s.timestamp||0)));

  projectsHdr.innerHTML = `<span class="${UI.panelTitle}">Projects (${sorted.length})</span>`;
  let pH = "";
  for (const [proj, ss] of sorted) {
    const ws = ss.filter(s=>s.status==="working").length;
    const bs = ss.filter(s=>s.status==="blocked").length;
    const es = ss.filter(s=>s.status==="error").length;
    const parts: string[] = [];
    if (ws>0) parts.push(ws+" work");
    if (bs>0) parts.push(bs+" wait");
    if (es>0) parts.push(es+" err");
    if (parts.length===0) parts.push("idle");
    const icons = [...new Set(ss.map(s=>s.session_type||"?"))].map(t=>icon(t)).filter(Boolean).join("");
    const path = (ss[0]?.project_path||"").split("/").slice(-2).join("/");
    const maxTs = Math.max(...ss.map(s=>s.timestamp||0));
    const projectStatus = ws > 0 ? "working" : bs > 0 ? "blocked" : es > 0 ? "error" : "idle";
    const sel = proj===focusedProject ? UI.rowSelected : "";

    pH += `<button type="button" class="${cx(UI.row, "w-full text-left", sel)}" data-project="${escapeHtml(proj)}" aria-pressed="${proj===focusedProject}">`
      +statusDotMarkup(projectStatus)
      +`<span class="flex-[2] font-medium truncate">${escapeHtml(proj)}</span>`
      +`<span class="w-7 text-right shrink-0 text-muted text-[11px]">${ss.length}</span>`
      +`<span class="w-[74px] shrink-0 flex items-center gap-0.5">${icons}</span>`
      +`<span class="w-[60px] shrink-0 text-muted text-[11px]">${parts.join(" ")}</span>`
      +`<span class="flex-[1.3] text-muted text-[11px] truncate">${escapeHtml(path)}</span>`
      +`<span class="w-8 text-right shrink-0 text-muted text-[11px]">${age(maxTs)}</span>`
      +"</button>";
  }
  projectsBody.innerHTML = pH || `<div class="${UI.empty}">No projects</div>`;
  projectsBody.querySelectorAll("[data-project]").forEach(el=>{el.addEventListener("click",()=>{
    focusedProject = (el as HTMLElement).dataset.project === focusedProject ? null : (el as HTMLElement).dataset.project!;
    selectedId = null;
    render(lastSessions);
  })});

  // Sessions
  const scope = focusedProject ? shown.filter(s=>extractProject(s)===focusedProject) : shown;
  if (selectedId && !scope.find(s=>s.session_id===selectedId)) selectedId = null;
  const sSorted = [...scope].sort((a,b)=>(b.timestamp||0)-(a.timestamp||0));

  sessionsHdr.innerHTML = `<span class="${UI.panelTitle}">${focusedProject ? `Sessions / ${escapeHtml(focusedProject)}` : `All Sessions (${sSorted.length})`}</span>`;
  let sH = "";
  for (const s of sSorted) {
    const st = s.status||"idle";
    const sel = s.session_id===selectedId ? UI.rowSelected : "";
    const blk = st==="blocked" ? UI.rowBlocked : "";
    sH += `<button type="button" class="${cx(UI.row, "w-full text-left", sel, blk)}" data-sid="${escapeHtml(s.session_id)}">`
      +`<span class="w-[22px] shrink-0">${icon(s.session_type||"?")}</span>`
      +statusDotMarkup(st)
      +`<span class="flex-1 font-medium truncate">${escapeHtml(s.session_type||"?")}</span>`
      +`<span class="w-[88px] shrink-0 text-muted text-[11px] truncate">${escapeHtml(extractProject(s))}</span>`
      +`<span class="w-[62px] shrink-0 text-muted text-[11px]">${statusLabel(st)}</span>`
      +`<span class="w-[34px] text-right shrink-0 text-muted text-[11px]">${age(s.timestamp||Date.now())}</span>`
      +"</button>";
  }
  sessionsBody.innerHTML = sH || `<div class="${UI.empty}">No sessions</div>`;
  sessionsBody.querySelectorAll("[data-sid]").forEach(el=>{el.addEventListener("click",()=>{
    const sid = (el as HTMLElement).dataset.sid||null;
    if (window.innerWidth < 1024) {
      const s = scope.find(s=>s.session_id===sid);
      if (s) showMobileDetail(s);
    } else {
      selectedId = sid;
      render(lastSessions);
    }
  })});

  // Detail — desktop
  const sel = selectedId ? sSorted.find(s=>s.session_id===selectedId) : null;
  if (sel) {
    const tabs = ["Overview","Activity","Usage","Flow","Raw"];
    detailHdr.innerHTML =
      `<span class="${UI.panelTitle}">Details / ${escapeHtml(sel.session_type||"Session")}</span>` +
      `<span class="flex gap-1">${tabsMarkup(tabs, detailTab)}</span>`;
    detailHdr.querySelectorAll(".detail-tab").forEach(el=>{el.addEventListener("click",()=>{
      detailTab = parseInt((el as HTMLElement).dataset.tab||"0");
      render(lastSessions);
    })});
    detailBody.innerHTML = detailHTML(sel);
  } else if (focusedProject) {
    detailHdr.innerHTML = `<span class="${UI.panelTitle}">Details / Project</span>`;
    const agents = [...new Set(scope.map(s=>s.session_type||"?"))].join(", ");
    detailBody.innerHTML = detailListMarkup([
      { label: "Project", value: focusedProject },
      { label: "Sessions", value: String(scope.length) },
      { label: "Agents", value: agents },
      { label: "Path", value: scope[0]?.project_path || "" },
    ]);
  } else {
    detailHdr.innerHTML = `<span class="${UI.panelTitle}">Details</span>`;
    detailBody.innerHTML = `<div class="${UI.empty}">Select a session to view details</div>`;
  }

  // Footer
  if (q) footerEl.textContent = `${shown.length}/${sessions.length} sessions  Esc to clear`;
  else if (focusedProject) footerEl.textContent = "Click project again to show all";
  else footerEl.textContent = "Click a project to filter · Click a session for details";
}

// ── SSE ──

function connect() {
  const es = new EventSource("/sessions/stream");
  es.onmessage = e => { try { lastSessions = JSON.parse(e.data); render(lastSessions); } catch { /* */ } };
  es.onerror = () => {
    portEl.textContent = "offline";
    portEl.className = UI.connectionOffline;
    showBanner("Disconnected — retrying…");
  };
  window.addEventListener("beforeunload", () => es.close());
}

filterInput.addEventListener("input", () => { if (lastSessions.length) render(lastSessions); });
filterInput.addEventListener("keydown", e => { if (e.key==="Escape") { filterInput.value=""; focusedProject=null; if (lastSessions.length) render(lastSessions); } });

connect();
