// Landing menu — interactive terminal UI for SessionBar.
// Extracted from cli.ts to separate presentation from orchestration.
//
// Exports pure rendering primitives (panelTop/Bot/Row, logoLines) that are
// also re-used by cli.ts's status/watch renderFrame. The menu orchestrator
// (runLandingMenu) accepts a dependency-injection config so cli.ts can wire
// in server lifecycle, hook management, and navigation actions without
// creating circular imports.

import { stripAnsi, truncateAnsi } from "./displayUtils.js";

// ---- ANSI helpers (self-contained — no external color constants) ----------

const ANSI_BOLD = "\x1b[1m";
const ANSI_RESET = "\x1b[0m";
const ANSI_GRAY = "\x1b[38;5;245m";
const ANSI_BLUE = "\x1b[34m";
const ANSI_GREEN = "\x1b[32m";
const ANSI_YELLOW = "\x1b[33m";
const ANSI_RED = "\x1b[1;31m";

// ---- Rainbow palette -----------------------------------------------------

export function createRainbow(colorEnabled: boolean): string[] {
  return colorEnabled ? [
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
}

// ---- ANSI Shadow figlet font ---------------------------------------------

export const BLOCK: Record<string, string[]> = {
  S: ["███████╗", "██╔════╝", "███████╗", "╚════██║", "███████║", "╚══════╝"],
  E: ["███████╗", "██╔════╝", "█████╗  ", "██╔══╝  ", "███████╗", "╚══════╝"],
  I: ["██╗", "██║", "██║", "██║", "██║", "╚═╝"],
  O: [" ██████╗ ", "██╔═══██╗", "██║   ██║", "██║   ██║", "╚██████╔╝", " ╚═════╝ "],
  N: ["███╗   ██╗", "████╗  ██║", "██╔██╗ ██║", "██║╚██╗██║", "██║ ╚████║", "╚═╝  ╚═══╝"],
  B: ["██████╗ ", "██╔══██╗", "██████╔╝", "██╔══██╗", "██████╔╝", "╚═════╝ "],
  A: [" █████╗ ", "██╔══██╗", "███████║", "██╔══██║", "██║  ██║", "╚═╝  ╚═╝"],
  R: ["██████╗ ", "██╔══██╗", "██████╔╝", "██╔══██╗", "██║  ██║", "╚═╝  ╚═╝"],
};

// ---- ASCII logo ----------------------------------------------------------

export function logoLines(w: number, rainbow: string[], reset: string): string[] {
  if (w < 65) {
    const text = "SessionBar";
    let line = "  ";
    for (let i = 0; i < text.length; i++) line += `${rainbow[i % rainbow.length]}${text[i]}${reset}`;
    return ["", line, ""];
  }
  const topRow = "SESSION";
  const botRow = "BAR";
  const gap = "  ";
  const lines: string[] = ["", ""];
  for (let r = 0; r < 6; r++) {
    let line = "  ";
    for (let i = 0; i < topRow.length; i++) line += `${rainbow[i]}${BLOCK[topRow[i]][r]}${reset}${gap}`;
    lines.push(line);
  }
  lines.push("");
  for (let r = 0; r < 6; r++) {
    let line = "  ";
    for (let i = 0; i < botRow.length; i++) line += `${rainbow[i + 7]}${BLOCK[botRow[i]][r]}${reset}${gap}`;
    lines.push(line);
  }
  lines.push("");
  lines.push(`  ${ANSI_GRAY}AI CLI Session Monitor${reset}`);
  lines.push("");
  return lines;
}

// ---- Panel drawing primitives --------------------------------------------

export function panelTop(title: string, w: number, gray: string, reset: string, right?: string): string {
  const boxW = Math.max(2, w - 2);
  const innerW = Math.max(0, boxW - 2);
  const titleText = `─ ${truncateAnsi(title, Math.max(0, innerW - 1), reset)} `;
  const rightMax = Math.max(0, innerW - stripAnsi(titleText) - 1);
  const rightText = right && rightMax > 0 ? ` ${truncateAnsi(right, Math.max(0, rightMax - 2), reset)} ` : "";
  const fill = Math.max(0, innerW - stripAnsi(titleText) - stripAnsi(rightText));
  return `  ${gray}╭${titleText}${"─".repeat(fill)}${rightText}╮${reset}`;
}

export function panelBot(w: number, gray: string, reset: string): string {
  return `  ${gray}╰${"─".repeat(Math.max(0, w - 4))}╯${reset}`;
}

export function panelRow(content: string, w: number, gray: string, reset: string): string {
  const available = Math.max(0, w - 8);
  const clipped = truncateAnsi(content, available, reset);
  const vis = stripAnsi(clipped);
  return `  ${gray}│${reset}  ${clipped}${" ".repeat(Math.max(0, available - vis))}  ${gray}│${reset}`;
}

// ---- Key parsing ---------------------------------------------------------

export function parseLandingKeys(raw: string): string[] {
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
}

// ---- Action descriptors --------------------------------------------------

export interface LandingAction {
  key: string;
  label: string;
  desc: string;
  enabled: boolean;
}

export function landingActions(): LandingAction[] {
  return [
    { key: "1", label: "monitor", desc: "Open live TUI dashboard", enabled: true },
    { key: "2", label: "setup", desc: "Choose local/global hook focus", enabled: true },
    { key: "3", label: "status", desc: "Print current sessions", enabled: true },
    { key: "w", label: "web", desc: "Open browser dashboard", enabled: true },
  ];
}

// ---- Dependency-injection interface --------------------------------------

export interface LandingMenuDeps {
  // ANSI rendering config
  tty: boolean;
  colorEnabled: boolean;

  // Display formatting
  formatAge: (timestamp: number, now?: number) => string;
  agentName: (type: string, w?: number) => string;

  // Domain-specific formatters (local to cli.ts — not in displayUtils)
  projectLabel: (s: any) => string;
  statusShort: (status: string) => string;
  statusStyle: (status: string) => { c: string; icon: string; label: string };

  // Server lifecycle
  ensureAppRunning: (quiet: boolean) => Promise<boolean>;
  fetchSessions: () => Promise<{ sessions: any[]; error?: string }>;
  pidAlive: () => boolean;

  // Navigation actions — each callback handles its own terminal suspend/resume
  launchMonitor: () => Promise<void>;
  launchSetup: () => Promise<void>;
  launchStatus: (sessions: any[]) => Promise<void>;
  launchWeb: (serverRunning: boolean) => Promise<void>;

  // Cleanup
  teardownHooks: (global: boolean, quiet?: boolean) => void;

  // Config
  port: number;
}

// ---- Main orchestrator ---------------------------------------------------

export async function runLandingMenu(deps: LandingMenuDeps): Promise<void> {
  const {
    tty, colorEnabled,
    formatAge, agentName,
    projectLabel, statusShort, statusStyle,
    ensureAppRunning, fetchSessions, pidAlive,
    launchMonitor, launchSetup, launchStatus, launchWeb,
    teardownHooks,
    port,
  } = deps;

  // ---- Colour palette ----------------------------------------------------
  const B = colorEnabled ? ANSI_BOLD : "";
  const D = colorEnabled ? ANSI_RESET : "";
  const K = colorEnabled ? ANSI_GRAY : "";
  const BL = colorEnabled ? ANSI_BLUE : "";
  const GN = colorEnabled ? ANSI_GREEN : "";
  const YL = colorEnabled ? ANSI_YELLOW : "";
  const RD = colorEnabled ? ANSI_RED : "";

  const RAINBOW = createRainbow(colorEnabled);

  // ---- State -------------------------------------------------------------
  let menuRunning = true;
  let menuSessions: any[] = [];
  let menuServerRunning = false;
  let needsRender = true;
  let selectedAction = 0;
  let menuRaw = false;
  let menuScreen = false;
  let menuFrameLines = 0;
  const menuKeyQueue: string[] = [];

  // ---- Terminal control --------------------------------------------------
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
    if (!tty) return;
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
    if (!tty || menuFrameLines <= 0) return;
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

  // ---- Render the landing page -------------------------------------------
  const renderLanding = async () => {
    setMenuScreen(true);
    const result = await fetchSessions();
    menuSessions = result.error ? [] : result.sessions;
    menuServerRunning = !result.error || pidAlive();

    if (tty && menuFrameLines > 0) process.stdout.write(`\x1b[${menuFrameLines}F\x1b[J`);
    else console.log("");
    let printed = tty && menuFrameLines > 0 ? 0 : 1;
    const out = (line = "") => {
      console.log(line);
      printed++;
    };

    const working = menuSessions.filter((s: any) => s.status === "working").length;
    const errored = menuSessions.filter((s: any) => s.status === "error").length;
    const blocked = menuSessions.filter((s: any) => s.status === "blocked").length;
    const idle = menuSessions.filter((s: any) => s.status === "idle").length;
    const status = menuServerRunning ? `${GN}online${D}` : `${K}offline${D}`;
    const activity = [
      working > 0 ? `${BL}${working} working${D}` : "",
      blocked > 0 ? `${YL}${blocked} blocked${D}` : "",
      errored > 0 ? `${RD}${errored} error${D}` : "",
      idle > 0 ? `${K}${idle} idle${D}` : "",
    ].filter(Boolean).join(` ${K}|${D} `);

    const w = Math.min((process.stdout.columns || 80) - 4, 76);
    const canShowLogo = (process.stdout.rows || 24) >= 28 && w >= 65;
    if (canShowLogo) {
      for (const line of logoLines(w, RAINBOW, D)) out(line);
    } else {
      const title = "SessionBar";
      let line = "";
      for (let i = 0; i < title.length; i++) line += `${RAINBOW[i % RAINBOW.length]}${B}${title[i]}${D}`;
      out(`  ${line} ${K}local multi-agent session monitor${D}`);
      out(`  ${K}${"─".repeat(Math.max(20, w))}${D}`);
    }

    const dot = menuServerRunning ? `${GN}●${D}` : `${K}○${D}`;
    out(`${panelTop("Status", w, K, D)}`);
    let statusLine = `${dot} ${status}    ${K}:${port}${D}    ${B}${menuSessions.length}${D} session${menuSessions.length !== 1 ? "s" : ""}`;
    if (activity) statusLine += `    ${activity}`;
    out(panelRow(statusLine, w, K, D));
    if (result.error) out(panelRow(`${RD}${result.error}${D}`, w, K, D));
    out(panelBot(w, K, D));

    if (menuSessions.length > 0) {
      out("");
      out(panelTop("Sessions", w, K, D));
      for (const s of menuSessions.slice(0, 4)) {
        const style = statusStyle(s.status);
        const sd = `${style.c}${style.icon}${D}`;
        const ai = `${agentName(s.session_type || "?", 12)}`;
        const line = `${sd} ${ai.padEnd(14)} ${projectLabel(s).padEnd(16)} ${statusShort(s.status).padEnd(5)} ${formatAge(s.timestamp || Date.now()).padStart(4)}`;
        out(panelRow(line, w, K, D));
      }
      if (menuSessions.length > 4) out(panelRow(`${K}+${menuSessions.length - 4} more sessions${D}`, w, K, D));
      out(panelBot(w, K, D));
    }

    out("");
    out(panelTop("Commands", w, K, D));
    const actions = landingActions();
    selectedAction = Math.max(0, Math.min(selectedAction, actions.length - 1));
    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];
      const marker = i === selectedAction ? `${B}${BL}>${D}` : " ";
      const key = action.key.toUpperCase();
      const label = `${key}. ${action.label}`.padEnd(12);
      const row = action.enabled
        ? `${marker} ${B}${label}${D} ${K}${action.desc}${D}`
        : `${marker} ${K}${label} ${action.desc}${D}`;
      out(panelRow(row, w, K, D));
    }
    out(panelRow(`${K}↑↓/jk select  Enter run  R refresh  Q quit${D}`, w, K, D));
    out(panelBot(w, K, D));
    out("");
    if (tty) process.stdout.write("\x1b[J");
    menuFrameLines = printed;
  };

  // ---- Key input ---------------------------------------------------------
  const readMenuKey = async (): Promise<string> => {
    const queued = menuKeyQueue.shift();
    if (queued) return queued;
    if (!process.stdin.isTTY) return (await ask("> ")).trim().toLowerCase();
    setMenuRaw(true);
    return new Promise(resolve => {
      const onData = (buf: Buffer) => {
        menuKeyQueue.push(...parseLandingKeys(buf.toString()));
        resolve(menuKeyQueue.shift() || "");
      };
      process.stdin.once("data", onData);
    });
  };

  // ---- Action dispatch ---------------------------------------------------
  const runAction = async (key: string) => {
    setMenuRaw(false);
    if (key === "1") {
      suspendLandingForAction();
      await launchMonitor();
      needsRender = true;
      return;
    }
    if (key === "2") {
      suspendLandingForAction();
      await launchSetup();
      needsRender = true;
      return;
    }
    if (key === "3") {
      suspendLandingForAction();
      await launchStatus(menuSessions);
      needsRender = true;
      return;
    }
    if (key === "w" || key === "web") {
      suspendLandingForAction();
      await launchWeb(menuServerRunning);
      needsRender = true;
      return;
    }
  };

  // ---- Event loop --------------------------------------------------------
  await ensureAppRunning(true);
  // The landing TUI can wait on keyboard input for an arbitrary amount of
  // time, so keep the relay aware that this terminal is still a client.
  const menuHeartbeat = setInterval(() => {
    void fetchSessions();
  }, 10_000);

  while (menuRunning) {
    if (needsRender) {
      await renderLanding();
      needsRender = false;
    }

    const c = await readMenuKey();
    if (!c) continue;
    if (c === "q" || c === "quit") { menuRunning = false; break; }
    if (c === "up") {
      selectedAction = (selectedAction + landingActions().length - 1) % landingActions().length;
      needsRender = true;
      continue;
    }
    if (c === "down") {
      selectedAction = (selectedAction + 1) % landingActions().length;
      needsRender = true;
      continue;
    }
    if (c === "enter") {
      await runAction(landingActions()[selectedAction].key);
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
  }
  clearInterval(menuHeartbeat);
  setMenuRaw(false);
  setMenuScreen(false);
  teardownHooks(true, true);
}

// ---- readline helper (kept here to avoid importing readline in cli.ts) ---

async function ask(q: string): Promise<string> {
  // Dynamic import — avoid loading readline module when not needed
  const { createInterface } = await import("readline");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(q, ans => { rl.close(); resolve(ans.trim()); });
  });
}
