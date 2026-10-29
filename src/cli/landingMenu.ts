// Landing menu — interactive terminal UI for SessionBar.
// Extracted from cli.ts to separate presentation from orchestration.
//
// Exports pure rendering primitives (panelTop/Bot/Row, logoLines) that are
// also re-used by cli.ts's status/watch renderFrame. The menu orchestrator
// (runLandingMenu) accepts a dependency-injection config so cli.ts can wire
// in server lifecycle, hook management, and navigation actions without
// creating circular imports.

import { stripAnsi, truncateAnsi } from "../tui/displayUtils.js";
import { terminalAnsiTheme } from "../tui/terminalTheme.js";
import { playWordmarkIntro, startWordmarkLoop, terminalWordmark } from "../tui/wordmark.js";
import { createParticleWordmark } from "../tui/particleWordmark.js";
import { deleteKittyImage, encodeKittyImage, probeTerminalGraphics, TerminalGraphicsReplies } from "../tui/terminalGraphics.js";
import type { TerminalGraphicsInfo } from "../tui/terminalGraphics.js";
import { LANDING_COMMANDS, LandingCommandInput, resolveLandingCommand, type LandingCommand } from "./landingCommand.js";

// ---- ANSI helpers (self-contained — no external color constants) ----------

const ANSI = terminalAnsiTheme(true);

// ---- Rainbow palette -----------------------------------------------------

export function createRainbow(colorEnabled: boolean): string[] {
  return [...terminalAnsiTheme(colorEnabled).rainbow];
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

export function logoLines(w: number, rainbow: string[], reset: string, progress = 1): string[] {
  const muted = reset ? ANSI.muted : "";
  const bold = reset ? ANSI.bold : "";
  if (w < 65) {
    const text = "SessionBar";
    let line = "  ";
    for (let i = 0; i < text.length; i++) line += `${rainbow[i % rainbow.length]}${bold}${text[i]}${reset}`;
    const descriptor = w >= 46 ? `  ${muted}multi-agent control room${reset}` : "";
    return ["", `${line}${descriptor}`, ""];
  }

  return ["", ...terminalWordmark(w, rainbow, reset, progress), "", `  ${muted}AI CLI Session Monitor${reset}`, ""];
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
    else if ("1234qrRwW".includes(ch)) keys.push(ch.toLowerCase());
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
    { key: "4", label: "settings", desc: "Configure SessionBar", enabled: true },
  ];
}

// ---- Dependency-injection interface --------------------------------------

export interface LandingMenuDeps {
  // ANSI rendering config
  tty: boolean;
  colorEnabled: boolean;
  animateLogo?: boolean;

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
  fetchWebStatus: () => Promise<boolean>;
  pidAlive: () => boolean;

  // Navigation actions — each callback handles its own terminal suspend/resume
  launchMonitor: (view?: "sessions" | "providers" | "agents") => Promise<void>;
  launchSetup: () => Promise<void>;
  launchStatus: (sessions: any[]) => Promise<void>;
  launchSettings: () => Promise<void>;
  launchWeb: () => Promise<void>;
  launchCommand?: (command: LandingCommand) => Promise<void>;

  // Cleanup
  teardownHooks: (global: boolean, quiet?: boolean) => Promise<void>;

  // Config
  getPort: () => number;
}

// ---- Main orchestrator ---------------------------------------------------

export async function runLandingMenu(deps: LandingMenuDeps): Promise<void> {
  const {
    tty, colorEnabled,
    formatAge, agentName,
    projectLabel, statusShort, statusStyle,
    ensureAppRunning, fetchSessions, fetchWebStatus, pidAlive,
    launchMonitor, launchSetup, launchStatus, launchSettings, launchWeb,
    teardownHooks,
    getPort,
  } = deps;

  // ---- Colour palette ----------------------------------------------------
  const theme = terminalAnsiTheme(colorEnabled);
  const B = theme.bold;
  const D = theme.reset;
  const K = theme.muted;
  const BL = theme.accent;
  const GN = theme.working;
  const YL = theme.blocked;
  const RD = theme.error;

  const RAINBOW = createRainbow(colorEnabled);

  // ---- State -------------------------------------------------------------
  let menuRunning = true;
  let menuSessions: any[] = [];
  let menuServerRunning = false;
  let menuWebRunning = false;
  let menuError: string | undefined;
  let needsRender = true;
  let selectedAction = 0;
  let menuRaw = false;
  let menuScreen = false;
  let menuFrameLines = 0;
  let logoIntroPlayed = false;
  let graphicsProbed = false;
  let graphicsInfo: TerminalGraphicsInfo | undefined;
  let imageVisible = false;
  let logoLoopFrame = 0;
  let startWaitingLogoLoop: (() => () => void) | undefined;
  let stopLogoLoop = () => {};
  const terminalReplies = new TerminalGraphicsReplies(undefined, process.stdout.columns || 80, process.stdout.rows || 24);
  const menuKeyQueue: string[] = [];
  const commandInput = new LandingCommandInput();
  let commandMessage = "";
  let paintCommandBox: (() => void) | undefined;
  let wakeMenuInput: (() => void) | undefined;
  let escapeTimer: ReturnType<typeof setTimeout> | undefined;
  const queueMenuInput = (text: string) => {
    menuKeyQueue.push(...commandInput.feed(text));
    wakeMenuInput?.();
  };
  const readMenuInput = (buf: Buffer) => {
    if (escapeTimer) clearTimeout(escapeTimer);
    queueMenuInput(terminalReplies.feed(buf.toString()));
    if (commandInput.active && buf.at(-1) === 27) {
      escapeTimer = setTimeout(() => queueMenuInput(terminalReplies.flushBareEscape()), 40);
    }
  };
  const clearLogoImage = () => {
    stopLogoLoop();
    if (imageVisible) process.stdout.write(deleteKittyImage(terminalReplies.imageId));
    imageVisible = false;
  };

  // ---- Terminal control --------------------------------------------------
  const setMenuRaw = (enabled: boolean) => {
    if (!process.stdin.isTTY) return;
    if (enabled && !menuRaw) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      menuRaw = true;
    } else if (!enabled && menuRaw) {
      if (escapeTimer) clearTimeout(escapeTimer);
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
      clearLogoImage();
      process.stdout.write("\x1b[?25h");
      menuScreen = false;
      menuFrameLines = 0;
    }
  };

  const clearMenuFrame = () => {
    clearLogoImage();
    if (!tty || menuFrameLines <= 0) return;
    process.stdout.write(`\x1b[${menuFrameLines}F\x1b[J`);
    menuFrameLines = 0;
  };

  const suspendLandingForAction = () => {
    clearMenuFrame();
    setMenuScreen(false);
  };

  const menuCleanup = async () => {
    menuRunning = false;
    setMenuRaw(false);
    setMenuScreen(false);
    await teardownHooks(true, true);
    if (!menuScreen) process.stdout.write("\x1b[?25h"); // ensure cursor visible
    process.exit(0);
  };

  process.once("SIGINT", menuCleanup);
  process.once("SIGTERM", menuCleanup);

  // ---- Render the landing page -------------------------------------------
  const refreshSessions = async () => {
    const [result, webRunning] = await Promise.all([fetchSessions(), fetchWebStatus()]);
    if (!result.error) menuSessions = result.sessions;
    menuServerRunning = !result.error || pidAlive();
    menuWebRunning = webRunning;
    menuError = result.error;
  };

  const renderLanding = async () => {
    setMenuScreen(true);
    const port = getPort();

    clearLogoImage();
    startWaitingLogoLoop = undefined;
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
      working > 0 ? `${GN}${working} working${D}` : "",
      blocked > 0 ? `${YL}${blocked} blocked${D}` : "",
      errored > 0 ? `${RD}${errored} error${D}` : "",
      idle > 0 ? `${theme.idle}${idle} idle${D}` : "",
    ].filter(Boolean).join(` ${K}|${D} `);

    const w = Math.min((process.stdout.columns || 80) - 4, 76);
    let previewCount = Math.min(menuSessions.length, 4);
    const panelRows = (count: number) => count > 0 ? count + 3 + Number(menuSessions.length > count) : 0;
    while (previewCount > 0 && 17 + panelRows(previewCount) + Number(Boolean(menuError))
      + logoLines(Math.min(w, 64), RAINBOW, D).length > (process.stdout.rows || 24)) previewCount--;
    const sessionPanelRows = panelRows(previewCount);
    const logoFits = (process.stdout.rows || 24) >= 17 + sessionPanelRows + Number(Boolean(menuError)) + logoLines(w, RAINBOW, D).length;
    const logoWidth = logoFits ? w : Math.min(w, 64);
    if (!graphicsProbed && logoWidth >= 65 && tty && process.stdin.isTTY && colorEnabled
      && process.env.TERM !== "dumb" && !process.env.TMUX && !process.env.STY) {
      graphicsProbed = true;
      setMenuRaw(true);
      graphicsInfo = await probeTerminalGraphics(terminalReplies, process.stdin, process.stdout, queueMenuInput);
    }
    const animateIntro = !logoIntroPlayed && logoWidth >= 65 && tty && process.stdin.isTTY
      && colorEnabled && deps.animateLogo !== false && menuKeyQueue.length === 0;
    logoIntroPlayed = true;
    const logoStartLine = printed;
    const logo = logoLines(logoWidth, RAINBOW, D, animateIntro ? 0 : 1);
    const imageRows = logo.length - 4;
    const particles = graphicsInfo && logoWidth >= 65
      ? createParticleWordmark(logoWidth - 4, imageRows, graphicsInfo.cell) : undefined;
    for (let row = 0; row < logo.length; row++) out(particles && row > 0 && row <= imageRows ? "" : logo[row]);

    const dot = menuServerRunning ? `${GN}●${D}` : `${K}○${D}`;
    out(`${panelTop("Status", w, K, D)}`);
    let statusLine = `${dot} ${status}    ${K}:${port}${D}    ${B}${menuSessions.length}${D} session${menuSessions.length !== 1 ? "s" : ""}`;
    if (activity) statusLine += `    ${activity}`;
    out(panelRow(statusLine, w, K, D));
    if (menuError) out(panelRow(`${RD}${menuError}${D}`, w, K, D));
    out(panelBot(w, K, D));

    if (previewCount > 0) {
      out("");
      out(panelTop("Sessions", w, K, D));
      for (const s of menuSessions.slice(0, previewCount)) {
        const style = statusStyle(s.status);
        const sd = `${style.c}${style.icon}${D}`;
        const ai = `${agentName(s.session_type || "?", 12)}`;
        const line = `${sd} ${ai.padEnd(14)} ${projectLabel(s).padEnd(16)} ${statusShort(s.status).padEnd(5)} ${formatAge(s.timestamp || Date.now()).padStart(4)}`;
        out(panelRow(line, w, K, D));
      }
      if (menuSessions.length > previewCount) out(panelRow(`${K}+${menuSessions.length - previewCount} more sessions${D}`, w, K, D));
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
    const webDot = menuWebRunning ? `${GN}●${D}` : `${K}○${D}`;
    const webState = menuWebRunning ? `${GN}online${D}` : `${K}offline${D}`;
    const webHint = menuWebRunning ? `http://127.0.0.1:${port}` : "start with: sessionbar web";
    out(panelRow(`  ${K}Web dashboard${D}  ${webDot} ${webState}  ${K}${webHint}${D}`, w, K, D));
    out(panelRow(`${K}↑↓/jk select  Enter run  : command  W web  Q quit${D}`, w, K, D));
    out(panelBot(w, K, D));
    const commandStartLine = printed;
    const commandLines = () => [
      panelTop(commandMessage ? `Command / ${commandMessage}` : "Command", w, commandInput.active ? BL : K, D),
      panelRow(commandInput.display(Math.max(1, w - 8)), w, commandInput.active ? BL : K, D),
      panelBot(w, commandInput.active ? BL : K, D),
    ];
    for (const line of commandLines()) out(line);
    out("");
    if (tty) process.stdout.write("\x1b[J");
    menuFrameLines = printed;
    paintCommandBox = () => {
      if (!tty) return;
      process.stdout.write(`\x1b[s\x1b[${printed - commandStartLine}F${commandLines().map(line => `\x1b[2K${line}`).join("\n")}\x1b[u`);
    };
    const writeParticleLogo = (frame: string) => {
      process.stdout.write(`\x1b[s\x1b[${printed - logoStartLine - 1}F\x1b[2C${frame}\x1b[u`);
      imageVisible = true;
    };
    const loopFrames = new Map<number, string>();
    const drawLoopFrame = (frame: number) => {
      if (!particles || !graphicsInfo) return;
      let encoded = loopFrames.get(frame);
      if (!encoded) {
        encoded = encodeKittyImage(particles.renderLoop(frame / 48, graphicsInfo.light), terminalReplies.imageId, logoWidth - 4, imageRows);
        loopFrames.set(frame, encoded);
      }
      writeParticleLogo(encoded);
    };
    const drawParticleLogo = (progress: number) => {
      if (!particles || !graphicsInfo) return;
      const frame = encodeKittyImage(particles.render(progress, graphicsInfo.light), terminalReplies.imageId, logoWidth - 4, imageRows);
      writeParticleLogo(frame);
    };
    if (particles) {
      if (!animateIntro && deps.animateLogo !== false) drawLoopFrame(logoLoopFrame);
      else drawParticleLogo(animateIntro ? 0 : 1);
    }
    if (animateIntro) {
      setMenuRaw(true);
      const onIntroKey = readMenuInput;
      process.stdin.on("data", onIntroKey);
      try {
        await playWordmarkIntro(progress => {
          if (particles) { drawParticleLogo(progress); return; }
          const lines = logoLines(logoWidth, RAINBOW, D, progress);
          process.stdout.write(`\x1b[s\x1b[${printed - logoStartLine}F${lines.map(line => `\x1b[2K${line}`).join("\n")}\x1b[u`);
        }, () => menuKeyQueue.length > 0 || !menuRunning);
      } finally {
        process.stdin.off("data", onIntroKey);
      }
    }
    if (particles && deps.animateLogo !== false) {
      startWaitingLogoLoop = () => startWordmarkLoop(frame => {
        logoLoopFrame = frame;
        drawLoopFrame(frame);
      }, logoLoopFrame);
    }
  };

  // ---- Key input ---------------------------------------------------------
  const readMenuKey = async (): Promise<string> => {
    const queued = menuKeyQueue.shift();
    if (queued) return queued;
    if (!process.stdin.isTTY) return `command:${await ask("> ")}`;
    setMenuRaw(true);
    return new Promise(resolve => {
      stopLogoLoop = startWaitingLogoLoop?.() || (() => {});
      const finish = () => {
        const key = menuKeyQueue.shift();
        if (!key) return;
        stopLogoLoop();
        process.stdin.off("data", onData);
        wakeMenuInput = undefined;
        resolve(key);
      };
      const onData = (buf: Buffer) => {
        readMenuInput(buf);
      };
      wakeMenuInput = finish;
      process.stdin.on("data", onData);
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
    if (key === "4") {
      suspendLandingForAction();
      await launchSettings();
      needsRender = true;
      return;
    }
    if (key === "w") {
      await launchWeb();
      await refreshSessions();
      needsRender = true;
      return;
    }
  };

  const runCommand = async (value: string) => {
    const command = resolveLandingCommand(value);
    commandMessage = "";
    if (!command) { commandMessage = "Unknown command"; paintCommandBox?.(); return; }
    if (command === "quit") { menuRunning = false; return; }
    if (command === "help") { commandMessage = LANDING_COMMANDS.join(" "); paintCommandBox?.(); return; }
    if (command === "refresh") { await refreshSessions(); needsRender = true; return; }
    if (command === "monitor" || command === "providers" || command === "agents") {
      setMenuRaw(false);
      suspendLandingForAction();
      await launchMonitor(command === "monitor" ? "sessions" : command);
      needsRender = true;
      return;
    }
    const action = { setup: "2", status: "3", settings: "4", web: "w" }[command as "setup" | "status" | "settings" | "web"];
    if (action) { await runAction(action); return; }
    if (deps.launchCommand) {
      setMenuRaw(false);
      suspendLandingForAction();
      await deps.launchCommand(command);
      needsRender = true;
    }
  };

  // ---- Event loop --------------------------------------------------------
  await ensureAppRunning(true);
  await refreshSessions(); // initial data load

  while (menuRunning) {
    if (needsRender) {
      await renderLanding();
      needsRender = false;
    }

    const c = await readMenuKey();
    if (!c) continue;
    if (c === "input") { commandMessage = ""; paintCommandBox?.(); continue; }
    if (c.startsWith("command:")) { await runCommand(c.slice(8)); continue; }
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
      await refreshSessions();
      needsRender = true;
      continue;
    }
    if (c === "w" || c === "web") {
      await runAction("w");
      continue;
    }
    if (["1", "2", "3", "4"].includes(c)) {
      await runAction(c);
      continue;
    }
  }
  setMenuRaw(false);
  setMenuScreen(false);
  await teardownHooks(true, true);
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
