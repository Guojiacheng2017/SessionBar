// Hook injection and teardown for Claude Code, Codex, Gemini CLI, and Copilot.
// Extracted from cli.ts to keep the CLI entry point focused on command dispatch.

import { accessSync, constants, readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { setupKimiCodeHooks, teardownKimiCodeHooks, setupZCodeHooks, teardownZCodeHooks } from "./kimiZcodeHooks.js";
export { setupKimiCodeHooks, teardownKimiCodeHooks, setupZCodeHooks, teardownZCodeHooks };

const __dirname = dirname(fileURLToPath(import.meta.url));

export type SetupResult = { name: string; path: string; added: number; skipped?: string };
export type HarnessRegistryEntry = {
  id: string;
  name: string;
  supported: boolean;
  available: boolean;
  kind: string;
  commands: string[];
  commandFound?: string;
  configPath?: string;
  configExists?: boolean;
};

type HarnessDefinition = {
  id: string;
  name: string;
  commands: string[];
  localConfigPaths: () => string[];
  availability?: () => { available: boolean; configPath?: string; configExists?: boolean; commandFound?: string };
};

export const MAINSTREAM_HARNESSES: HarnessDefinition[] = [
  {
    id: "kimi-code",
    name: "Kimi Code CLI / Desktop",
    commands: ["kimi"],
    localConfigPaths: () => [join(process.env.KIMI_CODE_HOME || join(homedir(), ".kimi-code"), "config.toml")],
  },
  {
    id: "zcode",
    name: "ZCode",
    commands: ["zcode"],
    localConfigPaths: () => [join(process.env.SESSIONBAR_ZCODE_HOME || join(homedir(), ".zcode"), "cli", "config.json")],
    availability: () => {
      const app = "/Applications/ZCode.app";
      const configPath = join(process.env.SESSIONBAR_ZCODE_HOME || join(homedir(), ".zcode"), "cli", "config.json");
      return { available: existsSync(app) || existsSync(configPath), configPath,
        configExists: existsSync(configPath), commandFound: existsSync(app) ? app : undefined };
    },
  },
  {
    id: "dsh",
    name: "DeepSeek Harness",
    commands: ["dsh", "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness"],
    localConfigPaths: () => [process.env.SESSIONBAR_DSH_HOME || join(homedir(), ".dsh")],
    availability: () => {
      const app = "/Applications/DeepSeek Harness.app";
      const data = process.env.SESSIONBAR_DSH_HOME || join(homedir(), ".dsh");
      return { available: existsSync(app) || existsSync(data), configPath: data,
        configExists: existsSync(data), commandFound: existsSync(app) ? app : undefined };
    },
  },
  {
    id: "claude",
    name: "Claude Code",
    commands: ["claude"],
    localConfigPaths: () => [join(process.cwd(), ".claude", "settings.json"), join(homedir(), ".claude", "settings.json")],
  },
  {
    id: "codex",
    name: "Codex",
    commands: ["codex"],
    localConfigPaths: () => [join(process.cwd(), ".codex", "hooks.json"), join(homedir(), ".codex", "hooks.json")],
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    commands: ["gemini"],
    localConfigPaths: () => [join(process.cwd(), ".gemini", "settings.json"), join(homedir(), ".gemini", "settings.json")],
  },
  {
    id: "copilot",
    name: "GitHub Copilot CLI",
    commands: ["copilot", "gh"],
    localConfigPaths: () => [join(process.cwd(), ".github", "hooks", "agentbar.json"), join(homedir(), ".copilot", "hooks", "agentbar.json")],
  },
  {
    id: "cursor",
    name: "Cursor",
    commands: ["cursor"],
    localConfigPaths: () => [join(process.cwd(), ".cursor", "hooks.json"), join(homedir(), ".cursor", "hooks.json")],
    availability: () => {
      const app = "/Applications/Cursor.app";
      const projectConfig = join(process.cwd(), ".cursor", "hooks.json");
      const globalConfig = join(homedir(), ".cursor", "hooks.json");
      const configPath = [projectConfig, globalConfig].find(existsSync) || projectConfig;
      const appExists = existsSync(app);
      return {
        available: appExists || existsSync(configPath) || executableOnPath("cursor"),
        configPath,
        configExists: existsSync(configPath),
        commandFound: appExists ? app : undefined,
      };
    },
  },
  {
    id: "pi",
    name: "Pi Agent",
    commands: ["pi"],
    localConfigPaths: () => [join(process.cwd(), ".pi", "extensions", "sessionbar.ts"), join(homedir(), ".pi", "agent", "extensions", "sessionbar.ts")],
  },
  {
    id: "codebuddy-cli",
    name: "CodeBuddy CLI",
    commands: ["codebuddy"],
    localConfigPaths: () => [join(process.cwd(), ".codebuddy", "settings.json"), join(homedir(), ".codebuddy", "settings.json")],
  },
  {
    id: "workbuddy-desktop",
    name: "WorkBuddy Desktop",
    commands: ["/Applications/WorkBuddy.app/Contents/MacOS/WorkBuddy"],
    localConfigPaths: () => [join(homedir(), ".workbuddy")],
    availability: () => {
      const app = "/Applications/WorkBuddy.app";
      const data = join(homedir(), ".workbuddy");
      const appExists = existsSync(app);
      const dataExists = existsSync(data);
      return { available: appExists || dataExists, configPath: data, configExists: dataExists, commandFound: appExists ? app : undefined };
    },
  },
];

function executableOnPath(command: string): boolean {
  if (command.includes("/")) {
    try {
      accessSync(command, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  const paths = (process.env.PATH || "").split(":").filter(Boolean);
  return paths.some(dir => {
    try {
      accessSync(join(dir, command), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

export function detectHarnessAvailability(): HarnessRegistryEntry[] {
  return MAINSTREAM_HARNESSES.map(harness => {
    const localConfigPaths = harness.localConfigPaths();
    const custom = harness.availability?.();
    const configPath = custom?.configPath || localConfigPaths.find(existsSync) || localConfigPaths[0];
    const configExists = custom?.configExists ?? existsSync(configPath);
    const commandFound = custom?.commandFound || harness.commands.find(executableOnPath);
    return {
      id: harness.id,
      name: harness.name,
      supported: true,
      available: configExists || !!commandFound,
      kind: "installed",
      configPath,
      configExists,
      commands: harness.commands,
      commandFound,
    };
  });
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export function commandFor(agent: string, label: string, reportPath: string, status: string, task: string, hookEvent: string): string {
  return `SESSIONBAR_AGENT=${agent} SESSIONBAR_SESSION_TYPE=${shellEscape(label)} SESSIONBAR_HOOK_EVENT=${shellEscape(hookEvent)} ${shellEscape(reportPath)} ${status} ${task}`;
}

export function isSessionbarCommandFor(command: string, agent: string): boolean {
  const value = command || "";
  const report = /(?:^|[\s/'"])report\.sh(?:['"])?(?=\s|$)/.test(value);
  const assignment = new RegExp(`(?:^|\\s)(?:SESSIONBAR_AGENT|AGENTBAR_AGENT)=['"]?${agent}['"]?(?=\\s|$)`).test(value);
  return report && assignment;
}

/** Remove duplicate SessionBar command entries while preserving one entry. */
export function dedupeSessionbarHooks(config: any, agent: string): number {
  let removed = 0;
  const visit = (value: any): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      const seen = new Set<string>();
      for (let i = value.length - 1; i >= 0; i--) {
        const entry = value[i];
        const commands = entry?.hooks && Array.isArray(entry.hooks)
          ? entry.hooks.map((hook: any) => hook?.command).filter((command: any): command is string => typeof command === "string")
          : typeof entry?.command === "string" ? [entry.command] : [];
        const duplicate = commands.some((command: string) => {
          if (!isSessionbarCommandFor(command, agent)) return false;
          if (seen.has(command)) return true;
          seen.add(command);
          return false;
        });
        if (duplicate) { value.splice(i, 1); removed++; }
      }
      value.forEach(visit);
      return;
    }
    Object.values(value).forEach(visit);
  };
  visit(config);
  return removed;
}

/** Remove pre-agent-marker SessionBar hooks without touching unrelated commands. */
export function removeLegacyClaudeSessionbarHooks(hooks: any, reportPath = join(__dirname, "..", "..", "report.sh")): number {
  if (!hooks || typeof hooks !== "object") return 0;
  const invocations = [reportPath, shellEscape(reportPath)];
  if (!/[\\$`]/.test(reportPath)) invocations.push(JSON.stringify(reportPath));
  let removed = 0;
  for (const event of Object.keys(hooks)) {
    if (!Array.isArray(hooks[event])) continue;
    for (const definition of hooks[event]) {
      if (!Array.isArray(definition?.hooks)) continue;
      definition.hooks = definition.hooks.filter((hook: any) => {
        const command = typeof hook?.command === "string" ? hook.command : "";
        const isLegacy = invocations.some(prefix => command.startsWith(prefix)
          && (command.length === prefix.length || /^\s/.test(command.slice(prefix.length))))
          && !/(?:^|\s)(?:SESSIONBAR_AGENT|AGENTBAR_AGENT)=/.test(command);
        if (isLegacy) removed += 1;
        return !isLegacy;
      });
    }
    hooks[event] = hooks[event].filter((definition: any) => !Array.isArray(definition?.hooks) || definition.hooks.length > 0);
    if (hooks[event].length === 0) delete hooks[event];
  }
  return removed;
}

function migrateStaticPortCommands(value: unknown): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach(migrateStaticPortCommands);
    return;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.command === "string" && /(^|\/)report\.sh(\s|$)/.test(record.command)) {
    record.command = record.command.replace(/\s+[0-9]{1,5}\s*$/, "");
  }
  Object.values(record).forEach(migrateStaticPortCommands);
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
  migrateStaticPortCommands(settings);
  if (!settings.hooks) settings.hooks = {};
  removeLegacyClaudeSessionbarHooks(settings.hooks, reportPath);

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
  migrateStaticPortCommands(config);
  if (!config.hooks) config.hooks = {};

  const hookDefs: Record<string, any[]> = {
    SessionStart: [{ matcher: "", hooks: [{ type: "command", command: commandFor("codex", "Codex", reportPath, "working", "'Working'", "SessionStart") }] }],
    PreToolUse: [{ matcher: "", hooks: [{ type: "command", command: commandFor("codex", "Codex", reportPath, "working", "\"${CODEX_TOOL_NAME:-Working}\"", "PreToolUse") }] }],
    PermissionRequest: [{ matcher: "", hooks: [{ type: "command", command: commandFor("codex", "Codex", reportPath, "blocked", "'Waiting for permission'", "PermissionRequest") }] }],
    Stop: [{ hooks: [{ type: "command", command: commandFor("codex", "Codex", reportPath, "idle", "'Ready'", "Stop") }] }],
    SessionEnd: [{ hooks: [{ type: "command", command: commandFor("codex", "Codex", reportPath, "idle", "'Session ended'", "SessionEnd") }] }],
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
  migrateStaticPortCommands(settings);
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
  migrateStaticPortCommands(config);
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

export function setupCursorHooks(global: boolean, reportPath: string): SetupResult {
  const hooksPath = global
    ? join(homedir(), ".cursor", "hooks.json")
    : join(process.cwd(), ".cursor", "hooks.json");
  const config = readJsonFile(hooksPath);
  migrateStaticPortCommands(config);
  config.version = 1;
  if (!config.hooks) config.hooks = {};

  const hookDefs: Record<string, { command: string }[]> = {
    sessionStart: [{ command: commandFor("cursor", "Cursor", reportPath, "working", "'Working'", "sessionStart") }],
    preToolUse: [{ command: commandFor("cursor", "Cursor", reportPath, "working", "'Using tool'", "preToolUse") }],
    postToolUse: [{ command: commandFor("cursor", "Cursor", reportPath, "working", "'Analyzing tool results'", "postToolUse") }],
    stop: [{ command: commandFor("cursor", "Cursor", reportPath, "idle", "'Ready'", "stop") }],
    sessionEnd: [{ command: commandFor("cursor", "Cursor", reportPath, "idle", "'Session ended'", "sessionEnd") }],
  };

  let added = 0;
  for (const [event, defs] of Object.entries(hookDefs)) {
    if (!config.hooks[event]) config.hooks[event] = [];
    if (!config.hooks[event].some((hook: any) => isSessionbarCommandFor(hook.command || "", "cursor"))) {
      config.hooks[event].push(...defs);
      added += defs.length;
    }
  }

  writeJsonFile(hooksPath, config);
  return { name: "Cursor", path: hooksPath, added };
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

export function teardownCursorHooks(global: boolean): number {
  const hooksPath = global
    ? join(homedir(), ".cursor", "hooks.json")
    : join(process.cwd(), ".cursor", "hooks.json");
  const config = readJsonFile(hooksPath);
  if (!config.hooks) return 0;
  let removed = 0;
  for (const event of Object.keys(config.hooks)) {
    const before = config.hooks[event].length;
    config.hooks[event] = config.hooks[event].filter((hook: any) =>
      !isSessionbarCommandFor(hook.command || "", "cursor")
    );
    removed += before - config.hooks[event].length;
    if (config.hooks[event].length === 0) delete config.hooks[event];
  }
  if (removed > 0) writeJsonFile(hooksPath, config);
  return removed;
}

const PI_EXTENSION_MARKER = "// Generated by SessionBar. Do not edit; run sessionbar setup to refresh.";

export function piExtensionSource(reportPath: string): string {
  return `${PI_EXTENSION_MARKER}
import { spawn } from "node:child_process";
import { basename } from "node:path";

const reportPath = ${JSON.stringify(reportPath)};

function sessionId(ctx: any): string {
  const file = ctx.sessionManager.getSessionFile?.();
  return file ? basename(file, ".jsonl") : \`pi-\${process.pid}\`;
}

function report(event: string, status: string, task: string, ctx: any): void {
  const usage = ctx.getContextUsage?.();
  const name = ctx.sessionManager.getSessionName?.();
  const env: Record<string, string | undefined> = {
    ...process.env,
    SESSIONBAR_AGENT: "pi",
    SESSIONBAR_SESSION_TYPE: "Pi Agent",
    SESSIONBAR_SESSION_ID: sessionId(ctx),
    SESSIONBAR_PROJECT_DIR: ctx.cwd,
    SESSIONBAR_HOOK_EVENT: event,
  };
  if (name) env.SESSIONBAR_SESSION_NAME = name;
  if (usage?.tokens != null) env.SESSIONBAR_TOKENS = String(usage.tokens);
  if (usage?.percent != null) env.SESSIONBAR_CONTEXT_PERCENT = String(usage.percent);
  const child = spawn(reportPath, [status, task], { env, stdio: "ignore", detached: true });
  child.unref();
}

export default function sessionbarPiExtension(pi: any): void {
  pi.on("session_start", (_event: any, ctx: any) => report("session_start", "idle", "Ready", ctx));
  pi.on("before_agent_start", (_event: any, ctx: any) => report("before_agent_start", "working", "Handling prompt", ctx));
  pi.on("agent_start", (_event: any, ctx: any) => report("agent_start", "working", "Agent running", ctx));
  pi.on("tool_execution_start", (event: any, ctx: any) => report("tool_execution_start", "working", \`running: \${event.toolName || "tool"}\`, ctx));
  pi.on("tool_execution_end", (event: any, ctx: any) => report("tool_execution_end", event.isError ? "error" : "working", event.isError ? \`failed: \${event.toolName || "tool"}\` : \`done: \${event.toolName || "tool"}\`, ctx));
  pi.on("session_before_compact", (_event: any, ctx: any) => report("session_before_compact", "working", "Compacting context", ctx));
  pi.on("session_compact", (_event: any, ctx: any) => report("session_compact", "working", "Context compacted", ctx));
  pi.on("agent_end", (_event: any, ctx: any) => report("agent_end", "idle", "Ready", ctx));
  pi.on("agent_settled", (_event: any, ctx: any) => report("agent_settled", "idle", "Ready", ctx));
  pi.on("session_shutdown", (_event: any, ctx: any) => report("session_shutdown", "idle", "Session ended", ctx));
}
`;
}

function piExtensionPath(global: boolean): string {
  return global
    ? join(homedir(), ".pi", "agent", "extensions", "sessionbar.ts")
    : join(process.cwd(), ".pi", "extensions", "sessionbar.ts");
}

export function setupPiHooks(global: boolean, reportPath: string): SetupResult {
  const path = piExtensionPath(global);
  const source = piExtensionSource(reportPath);
  if (existsSync(path) && readFileSync(path, "utf8") === source) return { name: "Pi Agent", path, added: 0 };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source);
  return { name: "Pi Agent", path, added: 1 };
}

export function teardownPiHooks(global: boolean): number {
  const path = piExtensionPath(global);
  if (!existsSync(path) || !readFileSync(path, "utf8").startsWith(PI_EXTENSION_MARKER)) return 0;
  unlinkSync(path);
  return 1;
}

// ── WorkBuddy (CodeBuddy) ──

export function setupCodeBuddyHooks(global: boolean, reportPath: string): SetupResult {
  const settingsPath = global
    ? join(homedir(), ".codebuddy", "settings.json")
    : join(process.cwd(), ".codebuddy", "settings.json");

  const settings = readJsonFile(settingsPath);
  dedupeSessionbarHooks(settings, "codebuddy");
  migrateStaticPortCommands(settings);
  if (!settings.hooks) settings.hooks = {};

  type HookDef = { matcher: string; hooks: Array<{ type: string; command: string }> };
  const hookDefs: Record<string, HookDef[]> = {
    SessionStart: [{ matcher: "", hooks: [{ type: "command", command: commandFor("codebuddy", "CodeBuddy CLI", reportPath, "working", "'Working'", "SessionStart") }] }],
    PreToolUse: [{ matcher: "", hooks: [{ type: "command", command: commandFor("codebuddy", "CodeBuddy CLI", reportPath, "working", "\"${CODEBUDDY_TOOL_NAME:-Working}\"", "PreToolUse") }] }],
    Stop: [{ matcher: "", hooks: [{ type: "command", command: commandFor("codebuddy", "CodeBuddy CLI", reportPath, "idle", "'Ready'", "Stop") }] }],
    SessionEnd: [{ matcher: "", hooks: [{ type: "command", command: commandFor("codebuddy", "CodeBuddy CLI", reportPath, "idle", "'Session ended'", "SessionEnd") }] }],
  };

  let added = 0;
  for (const [event, defs] of Object.entries(hookDefs)) {
    if (!settings.hooks[event]) settings.hooks[event] = [];
    const already = settings.hooks[event].some((d: any) =>
      d.hooks?.some?.((h: any) => isSessionbarCommandFor(h.command || "", "codebuddy"))
    );
    if (!already) {
      settings.hooks[event].push(...(defs as any));
      added += defs.length;
    }
  }

  writeJsonFile(settingsPath, settings);
  return { name: "CodeBuddy CLI", path: settingsPath, added };
}

export const setupWorkbuddyHooks = setupCodeBuddyHooks;

export function teardownCodeBuddyHooks(global: boolean): number {
  const settingsPath = global
    ? join(homedir(), ".codebuddy", "settings.json")
    : join(process.cwd(), ".codebuddy", "settings.json");
  const settings = readJsonFile(settingsPath);
  if (!settings.hooks) return 0;
  let removed = 0;
  for (const event of Object.keys(settings.hooks)) {
    const before = settings.hooks[event].length;
    settings.hooks[event] = settings.hooks[event].filter((d: any) =>
      !d.hooks?.some?.((h: any) => isSessionbarCommandFor(h.command || "", "codebuddy"))
    );
    removed += before - settings.hooks[event].length;
    if (settings.hooks[event].length === 0) delete settings.hooks[event];
  }
  if (removed > 0) writeJsonFile(settingsPath, settings);
  return removed;
}

export const teardownWorkbuddyHooks = teardownCodeBuddyHooks;

export function teardownHooks(global: boolean, quiet = false) {
  const removed = teardownClaudeHooks(global) + teardownCodexHooks(global) + teardownGeminiHooks(global) + teardownCopilotHooks(global) + teardownCursorHooks(global) + teardownPiHooks(global) + teardownCodeBuddyHooks(global) + teardownKimiCodeHooks(global) + teardownZCodeHooks(global);
  if (removed > 0 && !quiet) console.log(`Removed ${removed} hook${removed === 1 ? "" : "s"}.`);
}

/** Silently inject Claude hooks on server ready — no console output. */
export function injectHooksOnServerReady(global: boolean) {
  const reportPath = join(__dirname, "..", "..", "report.sh");
  setupClaudeHooks(global, reportPath);
  setupCodexHooks(global, reportPath);
  setupGeminiHooks(global, reportPath);
  setupCopilotHooks(global, reportPath);
  setupCursorHooks(global, reportPath);
  setupPiHooks(global, reportPath);
  setupCodeBuddyHooks(global, reportPath);
  const available = detectHarnessAvailability();
  if (available.some(row => row.id === "kimi-code" && row.available)) setupKimiCodeHooks(global, reportPath);
  if (available.some(row => row.id === "zcode" && row.available)) setupZCodeHooks(global, reportPath);
}

export async function setupHooks(global: boolean) {
  const reportPath = join(__dirname, "..", "..", "report.sh");
  const targets = [
    setupClaudeHooks(global, reportPath),
    setupCodexHooks(global, reportPath),
    setupGeminiHooks(global, reportPath),
    setupCopilotHooks(global, reportPath),
    setupCursorHooks(global, reportPath),
    setupPiHooks(global, reportPath),
    setupCodeBuddyHooks(global, reportPath),
    setupKimiCodeHooks(global, reportPath),
    setupZCodeHooks(global, reportPath),
  ];
  for (const target of targets) {
    console.log(target.skipped ? `Skipped ${target.name}: ${target.skipped}` : `${target.added > 0 ? "Installed" : "Already configured"} ${target.name} → ${target.path}`);
  }
}
