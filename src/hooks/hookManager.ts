// Hook injection and teardown for Claude Code, Codex, Gemini CLI, and Copilot.
// Extracted from cli.ts to keep the CLI entry point focused on command dispatch.

import { accessSync, constants, readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export type SetupResult = { name: string; path: string; added: number };
export type HarnessScope = "local" | "remote";
export type HarnessRegistryEntry = {
  id: string;
  name: string;
  scope: HarnessScope;
  supported: boolean;
  available: boolean;
  configurable: boolean;
  kind: string;
  commands: string[];
  commandFound?: string;
  configPath?: string;
  configExists?: boolean;
  configKeys?: string[];
};

type HarnessDefinition = {
  id: string;
  name: string;
  commands: string[];
  localConfigPaths: () => string[];
  remoteConfigKeys: string[];
  availability?: () => { available: boolean; configPath?: string; configExists?: boolean; commandFound?: string };
};

export const MAINSTREAM_HARNESSES: HarnessDefinition[] = [
  {
    id: "claude",
    name: "Claude Code",
    commands: ["claude"],
    localConfigPaths: () => [join(process.cwd(), ".claude", "settings.json"), join(homedir(), ".claude", "settings.json")],
    remoteConfigKeys: ["ANTHROPIC_API_KEY", "CLAUDE_API_KEY", "SESSIONBAR_CLAUDE_REMOTE_URL", "HARNESS_CLAUDE_REMOTE_URL"],
  },
  {
    id: "codex",
    name: "Codex",
    commands: ["codex"],
    localConfigPaths: () => [join(process.cwd(), ".codex", "hooks.json"), join(homedir(), ".codex", "hooks.json")],
    remoteConfigKeys: ["OPENAI_API_KEY", "SESSIONBAR_CODEX_REMOTE_URL", "HARNESS_CODEX_REMOTE_URL"],
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    commands: ["gemini"],
    localConfigPaths: () => [join(process.cwd(), ".gemini", "settings.json"), join(homedir(), ".gemini", "settings.json")],
    remoteConfigKeys: ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "SESSIONBAR_GEMINI_REMOTE_URL", "HARNESS_GEMINI_REMOTE_URL"],
  },
  {
    id: "copilot",
    name: "GitHub Copilot CLI",
    commands: ["copilot", "gh"],
    localConfigPaths: () => [join(process.cwd(), ".github", "hooks", "agentbar.json"), join(homedir(), ".copilot", "hooks", "agentbar.json")],
    remoteConfigKeys: ["GITHUB_TOKEN", "GH_TOKEN", "SESSIONBAR_COPILOT_REMOTE_URL", "HARNESS_COPILOT_REMOTE_URL"],
  },
  {
    id: "codebuddy-cli",
    name: "CodeBuddy CLI",
    commands: ["codebuddy"],
    localConfigPaths: () => [join(process.cwd(), ".codebuddy", "settings.json"), join(homedir(), ".codebuddy", "settings.json")],
    remoteConfigKeys: ["CODEBUDDY_API_KEY", "WORKBUDDY_API_KEY", "SESSIONBAR_WORKBUDDY_REMOTE_URL", "HARNESS_WORKBUDDY_REMOTE_URL"],
  },
  {
    id: "workbuddy-desktop",
    name: "WorkBuddy Desktop",
    commands: ["/Applications/WorkBuddy.app/Contents/MacOS/WorkBuddy"],
    localConfigPaths: () => [join(homedir(), ".workbuddy")],
    remoteConfigKeys: ["SESSIONBAR_WORKBUDDY_REMOTE_URL", "HARNESS_WORKBUDDY_REMOTE_URL"],
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

export function detectHarnessAvailability(scope: HarnessScope): HarnessRegistryEntry[] {
  return MAINSTREAM_HARNESSES.map(harness => {
    if (scope === "remote") {
      return {
        id: harness.id,
        name: harness.name,
        scope,
        supported: true,
        available: false,
        configurable: true,
        kind: "cloud/self-hosted",
        commands: harness.commands,
        configKeys: harness.remoteConfigKeys,
      };
    }
    const localConfigPaths = harness.localConfigPaths();
    const custom = harness.availability?.();
    const configPath = custom?.configPath || localConfigPaths.find(existsSync) || localConfigPaths[0];
    const configExists = custom?.configExists ?? existsSync(configPath);
    const commandFound = custom?.commandFound || harness.commands.find(executableOnPath);
    return {
      id: harness.id,
      name: harness.name,
      scope,
      supported: true,
      available: configExists || !!commandFound,
      configurable: false,
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
  const removed = teardownClaudeHooks(global) + teardownCodexHooks(global) + teardownGeminiHooks(global) + teardownCopilotHooks(global) + teardownCodeBuddyHooks(global);
  if (removed > 0 && !quiet) console.log(`Removed ${removed} hook${removed === 1 ? "" : "s"}.`);
}

/** Silently inject Claude hooks on server ready — no console output. */
export function injectHooksOnServerReady(global: boolean) {
  const reportPath = join(__dirname, "..", "..", "report.sh");
  setupClaudeHooks(global, reportPath);
  setupCodexHooks(global, reportPath);
  setupGeminiHooks(global, reportPath);
  setupCopilotHooks(global, reportPath);
  setupCodeBuddyHooks(global, reportPath);
}

export async function setupHooks(global: boolean) {
  const reportPath = join(__dirname, "..", "..", "report.sh");
  const targets = [
    setupClaudeHooks(global, reportPath),
    setupCodexHooks(global, reportPath),
    setupGeminiHooks(global, reportPath),
    setupCopilotHooks(global, reportPath),
    setupCodeBuddyHooks(global, reportPath),
  ];
  for (const target of targets) {
    console.log(`${target.added > 0 ? "Installed" : "Already configured"} ${target.name} → ${target.path}`);
  }
}
