// SessionBar web dashboard — browser-side ES module
// Connects to /sessions/stream (SSE) and renders project-grouped agent cards
import type { SessionPayload } from "./types.js";

// ── DOM refs ──

const container = document.getElementById("agent-container")!;
const statsRow = document.getElementById("stats-row")!;
const filterInput = document.getElementById("filter-input") as HTMLInputElement;
const filterHint = document.getElementById("filter-hint")!;

// ── State ──

let disconnectedBanner: HTMLDivElement | null = null;
let expandedId: string | null = null;
let lastSessions: SessionPayload[] = []; // cached for instant filter re-render

// ── Utilities ──

function extractProject(s: SessionPayload): string {
  if (s.project) return s.project;
  if (s.project_path) {
    const parts = s.project_path.split("/");
    return parts[parts.length - 1] || s.project_path;
  }
  const sid = s.session_id || "";
  const sep = sid.indexOf("__");
  if (sep !== -1) return sid.slice(sep + 2);
  const cleaned = sid.replace(/^(claude|gemini|codex|copilot|opencode|pi|kimi|qwen|deepseek|windsurf|cursor)-/, "");
  const parsed = cleaned.replace(/-\d+-\d+$/, "");
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(parsed)) {
    return "unknown";
  }
  return parsed || "?";
}

const TYPE_ICONS: Record<string, string> = {
  "Claude Code": "♆",
  "Gemini CLI": "◇",
  Codex: "▷",
  Copilot: "◎",
  OpenCode: "□",
  Pi: "π",
  "Kimi CLI": "❖",
  "Qwen CLI": "⬡",
  "DeepSeek CLI": "◆",
  Windsurf: "♒",
  Cursor: "➤",
};

function typeIcon(t: string): string {
  return TYPE_ICONS[t] || "○";
}

function age(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 10) return "now";
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

function statusLabel(s: string): string {
  const m: Record<string, string> = {
    working: "Running",
    idle: "Idle",
    blocked: "Awaiting",
    error: "Error",
  };
  return m[s] || s;
}

function statusChar(s: string): string {
  if (s === "working") return "R";
  if (s === "idle") return "I";
  if (s === "blocked") return "A";
  return "E";
}

// ── Disconnected banner ──

function showDisconnected(msg: string) {
  if (!disconnectedBanner) {
    disconnectedBanner = document.createElement("div");
    disconnectedBanner.className = "disconnected-banner";
    container.prepend(disconnectedBanner);
  }
  disconnectedBanner.textContent = msg;
}

function hideDisconnected() {
  if (disconnectedBanner) {
    disconnectedBanner.remove();
    disconnectedBanner = null;
  }
}

// ── Render ──

function render(sessions: SessionPayload[]) {
  hideDisconnected();

  const q = filterInput.value.trim().toLowerCase();

  // Filter
  let shown = sessions;
  if (q) {
    shown = sessions.filter(
      (s) =>
        extractProject(s).toLowerCase().includes(q) ||
        (s.task_name || "").toLowerCase().includes(q) ||
        (s.session_type || "").toLowerCase().includes(q)
    );
    filterHint.textContent = `${shown.length}/${sessions.length} sessions`;
    filterHint.classList.add("visible");
  } else {
    filterHint.classList.remove("visible");
  }

  // ── Stats bar ──

  const working = sessions.filter((s) => s.status === "working").length;
  const errored = sessions.filter((s) => s.status === "error").length;
  const blocked = sessions.filter((s) => s.status === "blocked").length;
  const idle = sessions.filter((s) => s.status === "idle").length;

  statsRow.innerHTML =
    `<span class="stat"><span class="val">${sessions.length}</span> session${sessions.length !== 1 ? "s" : ""}</span>` +
    (working > 0
      ? `<span class="stat working"><span class="val">${working}</span> working</span>`
      : "") +
    (errored > 0
      ? `<span class="stat error"><span class="val">${errored}</span> error</span>`
      : "") +
    (blocked > 0
      ? `<span class="stat blocked"><span class="val">${blocked}</span> blocked</span>`
      : "") +
    (idle > 0
      ? `<span class="stat idle"><span class="val">${idle}</span> idle</span>`
      : "");

  // ── Empty state ──

  if (shown.length === 0) {
    if (q) {
      container.innerHTML =
        '<div class="empty-state">No sessions match "' +
        escapeHtml(q) +
        '"</div>';
    } else {
      container.innerHTML =
        '<div class="empty-state">Waiting for sessions<span class="dot"></span><span class="dot"></span><span class="dot"></span></div>';
    }
    return;
  }

  // ── Project grouping ──

  const groups = new Map<string, SessionPayload[]>();
  for (const s of shown) {
    const proj = extractProject(s);
    if (!groups.has(proj)) groups.set(proj, []);
    groups.get(proj)!.push(s);
  }

  // Sort groups by most-recently-active first
  const sortedGroups = new Map(
    [...groups.entries()].sort((a, b) => {
      const aMax = Math.max(...a[1].map((s) => s.timestamp || 0));
      const bMax = Math.max(...b[1].map((s) => s.timestamp || 0));
      return bMax - aMax;
    })
  );

  const useGroups = shown.length > 3 && sortedGroups.size > 1;

  // ── Build DOM ──

  // Track existing cards by session_id
  const existing = new Map<string, HTMLElement>();
  container.querySelectorAll(".agent-card").forEach((el) => {
    const id = (el as HTMLElement).dataset.sessionId;
    if (id) existing.set(id, el as HTMLElement);
  });

  const seen = new Set<string>();
  const fragment = document.createDocumentFragment();

  if (useGroups) {
    for (const [proj, ss] of sortedGroups) {
      // Project group header
      const group = document.createElement("div");
      group.className = "project-group";
      group.dataset.project = proj;

      const icon = typeIcon(ss[0]?.session_type || "?");
      const header = document.createElement("div");
      header.className = "project-header";
      header.innerHTML = `<span class="project-icon">${icon}</span><span class="project-name">${escapeHtml(proj)}</span><span class="project-count">— ${ss.length} session${ss.length !== 1 ? "s" : ""}</span>`;
      group.appendChild(header);

      for (const s of ss) {
        seen.add(s.session_id);
        group.appendChild(ensureCard(s, existing.get(s.session_id)));
      }

      fragment.appendChild(group);
    }
  } else {
    // Flat list (no group headers)
    for (const s of shown) {
      seen.add(s.session_id);
      fragment.appendChild(ensureCard(s, existing.get(s.session_id)));
    }
  }

  container.innerHTML = "";
  container.appendChild(fragment);

  // Remove stale cards that were in `existing` but not in `seen`
  // (They were already dropped when we set container.innerHTML = "")
}

function ensureCard(
  s: SessionPayload,
  existingEl: HTMLElement | undefined
): HTMLElement {
  const proj = extractProject(s);
  const ico = typeIcon(s.session_type || "?");
  const label = statusLabel(s.status);
  const sc = statusChar(s.status);
  const ts = s.timestamp || Date.now();
  const isExpanded = expandedId === s.session_id;

  // If we have an existing card, update it in place
  if (existingEl) {
    existingEl.dataset.sessionId = s.session_id;
    // Update status indicator
    const indicator = existingEl.querySelector(".status-indicator")!;
    indicator.className = "status-indicator " + s.status;
    indicator.setAttribute("aria-label", `Status: ${label}`);
    indicator.setAttribute("title", `Status: ${label}`);
    indicator.textContent = sc;
    // Update info
    existingEl.querySelector(".info-type")!.textContent = `${ico} ${s.session_type || "?"}`;
    existingEl.querySelector(".info-project")!.textContent = proj;
    existingEl.querySelector(".info-task")!.textContent = s.task_name || "";
    existingEl.querySelector(".info-sid")!.textContent = s.session_id;
    // Update meta
    existingEl.querySelector(".meta-age")!.textContent = age(ts);
    const metaStatus = existingEl.querySelector(".meta-status")!;
    metaStatus.className = "meta-status " + s.status;
    metaStatus.textContent = label;
    // Update progress
    updateProgress(existingEl, s);
    // Update detail if open
    updateDetail(existingEl, s, isExpanded);
    return existingEl;
  }

  // Create new card
  const card = document.createElement("div");
  card.className = "agent-card";
  card.dataset.sessionId = s.session_id;
  card.addEventListener("click", () => {
    expandedId = expandedId === s.session_id ? null : s.session_id;
    // Re-render just this card's detail
    const detail = card.querySelector(".card-detail")!;
    if (expandedId === s.session_id) {
      detail.classList.add("open");
      fillDetail(detail, s);
    } else {
      detail.classList.remove("open");
    }
  });

  card.innerHTML =
    '<div class="card-header">' +
    `<div class="status-indicator ${s.status}" role="img" aria-label="Status: ${label}" title="Status: ${label}">${sc}</div>` +
    '<div class="info">' +
    '<div class="info-row">' +
    `<span class="info-type">${ico} ${escapeHtml(s.session_type || "?")}</span>` +
    `<span class="info-project">${escapeHtml(proj)}</span>` +
    "</div>" +
    `<div class="info-task">${escapeHtml(s.task_name || "")}</div>` +
    `<div class="info-sid">${escapeHtml(s.session_id)}</div>` +
    "</div>" +
    '<div class="card-meta">' +
    `<span class="meta-age">${age(ts)}</span>` +
    `<span class="meta-status ${s.status}">${label}</span>` +
    "</div>" +
    "</div>" +
    '<div class="progress-bar-container" style="display:none">' +
    '<div class="progress-track"><div class="progress-fill" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-label="Task progress" style="width:0%"></div></div>' +
    '<div class="progress-pct"></div>' +
    "</div>" +
    `<div class="card-detail${isExpanded ? " open" : ""}"></div>`;

  updateProgress(card, s);
  const detailEl = card.querySelector(".card-detail")!;
  fillDetail(detailEl, s);

  return card;
}

function updateProgress(card: HTMLElement, s: SessionPayload) {
  const container = card.querySelector(".progress-bar-container") as HTMLElement;
  const fill = card.querySelector(".progress-fill") as HTMLElement;
  const pctEl = card.querySelector(".progress-pct") as HTMLElement;

  if (s.progress !== undefined) {
    const pct = Math.round(s.progress * 100);
    container.style.display = "flex";
    fill.style.width = `${pct}%`;
    fill.setAttribute("aria-valuenow", String(pct));
    pctEl.textContent = `${pct}%`;
  } else {
    container.style.display = "none";
  }
}

function fillDetail(detailEl: Element, s: SessionPayload) {
  const proj = extractProject(s);
  const ts = s.timestamp || Date.now();
  const elapsed = age(ts);
  const label = statusLabel(s.status);

  detailEl.innerHTML =
    '<div class="detail-row"><span class="detail-label">Session ID</span><span class="detail-value">' +
    escapeHtml(s.session_id) +
    "</span></div>" +
    '<div class="detail-row"><span class="detail-label">Project</span><span class="detail-value">' +
    escapeHtml(s.project_path || proj) +
    "</span></div>" +
    '<div class="detail-row"><span class="detail-label">Status</span><span class="detail-value">' +
    label +
    "</span></div>" +
    '<div class="detail-row"><span class="detail-label">Active</span><span class="detail-value">' +
    elapsed +
    "</span></div>" +
    (s.progress !== undefined
      ? '<div class="detail-row"><span class="detail-label">Progress</span><span class="detail-value">' +
        Math.round(s.progress * 100) +
        "%</span></div>"
      : "");
}

function updateDetail(
  card: HTMLElement,
  s: SessionPayload,
  isOpen: boolean
) {
  const detail = card.querySelector(".card-detail")!;
  if (isOpen) {
    detail.classList.add("open");
    fillDetail(detail, s);
  } else {
    detail.classList.remove("open");
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── Connect SSE ──

function connect() {
  const es = new EventSource("/sessions/stream");

  es.onmessage = (e) => {
    try {
      lastSessions = JSON.parse(e.data);
      render(lastSessions);
    } catch {
      // ignore malformed frames
    }
  };

  es.onerror = () => {
    showDisconnected("Disconnected — retrying…");
  };

  // Clean up on page unload
  window.addEventListener("beforeunload", () => es.close());
}

// ── Filter input ──

filterInput.addEventListener("input", () => {
  // Instant re-render from cached sessions for responsive filtering
  if (lastSessions.length > 0) render(lastSessions);
});

// ── Init ──

connect();
