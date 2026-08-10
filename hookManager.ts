// Hook injection and teardown for Claude Code, Codex, Gemini CLI, and Copilot.
// Extracted from cli.ts to keep the CLI entry point focused on command dispatch.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = parseInt(process.env.PORT || "8989", 10);

export type SetupResult = { name: string; path: string; added: number };

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export function commandFor(agent: string, label: string, reportPath: string, status: string, task: string, hookEvent: string): string {
  return `SESSIONBAR_AGENT=${agent} SESSIONBAR_SESSION_TYPE=${shellEscape(label)} SESSIONBAR_HOOK_EVENT=${shellEscape(hookEvent)} ${shellEscape(reportPath)} ${status} ${task} ${String(PORT)}`;
}

export function isSessionbarCommandFor(command: string, agent: string): boolean {
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

export function setupClaudeHooks(global: boolean, reportPath: string): SetupResult {
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

export function setupCodexHooks(global: boolean, reportPath: string): SetupResult {
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

export function setupGeminiHooks(global: boolean, reportPath: string): SetupResult {
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

export function setupCopilotHooks(global: boolean, reportPath: string): SetupResult {
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

export function teardownClaudeHooks(global: boolean): number {
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

export function teardownCodexHooks(global: boolean): number {
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

export function teardownGeminiHooks(global: boolean): number {
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

export function teardownCopilotHooks(global: boolean): number {
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

// ── WorkBuddy (CodeBuddy) ──

export function setupWorkbuddyHooks(global: boolean, reportPath: string): SetupResult {
  const settingsPath = global
    ? join(homedir(), ".codebuddy", "settings.json")
    : join(process.cwd(), ".codebuddy", "settings.json");

  const settings = readJsonFile(settingsPath);
  if (!settings.hooks) settings.hooks = {};

  type HookDef = { matcher: string; hooks: Array<{ type: string; command: string }> };
  const hookDefs: Record<string, HookDef[]> = {
    SessionStart: [{ matcher: "", hooks: [{ type: "command", command: commandFor("workbuddy", "Workbuddy", reportPath, "working", "'Working'", "SessionStart") }] }],
    PreToolUse: [{ matcher: "", hooks: [{ type: "command", command: commandFor("workbuddy", "Workbuddy", reportPath, "working", "\"${CODEBUDDY_TOOL_NAME:-Working}\"", "PreToolUse") }] }],
    Stop: [{ matcher: "", hooks: [{ type: "command", command: commandFor("workbuddy", "Workbuddy", reportPath, "idle", "'Ready'", "Stop") }] }],
    SessionEnd: [{ matcher: "", hooks: [{ type: "command", command: commandFor("workbuddy", "Workbuddy", reportPath, "idle", "'Session ended'", "SessionEnd") }] }],
  };

  let added = 0;
  for (const [event, defs] of Object.entries(hookDefs)) {
    if (!settings.hooks[event]) settings.hooks[event] = [];
    const already = settings.hooks[event].some((d: any) =>
      d.hooks?.some?.((h: any) => isSessionbarCommandFor(h.command || "", "workbuddy"))
    );
    if (!already) {
      settings.hooks[event].push(...(defs as any));
      added += defs.length;
    }
  }

  writeJsonFile(settingsPath, settings);
  return { name: "Workbuddy", path: settingsPath, added };
}

export function teardownWorkbuddyHooks(global: boolean): number {
  const settingsPath = global
    ? join(homedir(), ".codebuddy", "settings.json")
    : join(process.cwd(), ".codebuddy", "settings.json");
  const settings = readJsonFile(settingsPath);
  if (!settings.hooks) return 0;
  let removed = 0;
  for (const event of Object.keys(settings.hooks)) {
    const before = settings.hooks[event].length;
    settings.hooks[event] = settings.hooks[event].filter((d: any) =>
      !d.hooks?.some?.((h: any) => isSessionbarCommandFor(h.command || "", "workbuddy"))
    );
    removed += before - settings.hooks[event].length;
    if (settings.hooks[event].length === 0) delete settings.hooks[event];
  }
  if (removed > 0) writeJsonFile(settingsPath, settings);
  return removed;
}

export function teardownHooks(global: boolean, quiet = false) {
  const removed = teardownClaudeHooks(global) + teardownCodexHooks(global) + teardownGeminiHooks(global) + teardownCopilotHooks(global) + teardownWorkbuddyHooks(global);
  if (removed > 0 && !quiet) console.log(`Removed ${removed} hook${removed === 1 ? "" : "s"}.`);
}

/** Silently inject Claude hooks on server ready — no console output. */
export function injectHooksOnServerReady(global: boolean) {
  const reportPath = join(dirname(__dirname), "report.sh");
  setupClaudeHooks(global, reportPath);
}

export async function setupHooks(global: boolean) {
  const reportPath = join(dirname(__dirname), "report.sh");
  const targets = [
    setupClaudeHooks(global, reportPath),
    setupCodexHooks(global, reportPath),
    setupGeminiHooks(global, reportPath),
    setupCopilotHooks(global, reportPath),
    setupWorkbuddyHooks(global, reportPath),
  ];
  for (const target of targets) {
    console.log(`${target.added > 0 ? "Installed" : "Already configured"} ${target.name} → ${target.path}`);
  }
}
