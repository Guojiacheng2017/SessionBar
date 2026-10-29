import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parse, stringify } from "smol-toml";
import type { SetupResult } from "./hookManager.js";
import { KIMI_HOOK_EVENTS, ZCODE_HOOK_EVENTS } from "./nativeHarnessBridge.js";

const START = "\n# >>> SessionBar Kimi hooks >>>\n";
const END = "# <<< SessionBar Kimi hooks <<<\n";
const kimiPath = () => join(process.env.KIMI_CODE_HOME || join(homedir(), ".kimi-code"), "config.toml");
const zcodePath = () => join(process.env.SESSIONBAR_ZCODE_HOME || join(homedir(), ".zcode"), "cli", "config.json");
const bridgePath = (reportPath: string) => join(dirname(reportPath), "dist", "hooks", "nativeHarnessBridge.js");
const parseKimiConfig = (content: string) => parse(content, { integersAsBigInt: true });

function writeConfig(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.sessionbar-${process.pid}.tmp`;
  try {
    writeFileSync(temp, content, { mode: 0o600 });
    renameSync(temp, path);
  } finally { if (existsSync(temp)) unlinkSync(temp); }
}

function shellQuote(value: string): string {
  return process.platform === "win32" ? `"${value.replace(/"/g, '""')}"` : `'${value.replace(/'/g, "'\\''")}'`;
}

function removeKimiBlock(content: string): { content: string; removed: number } {
  const blocks = [...content.matchAll(/\r?\n# >>> SessionBar Kimi hooks >>>\r?\n([\s\S]*?)# <<< SessionBar Kimi hooks <<<(?:\r?\n|$)/g)];
  if (blocks.length) {
    let clean = content;
    let removed = 0;
    for (const match of blocks.reverse()) {
      const block = parseKimiConfig(match[1]);
      if (Object.keys(block).length !== 1 || !Array.isArray(block.hooks) || !block.hooks.every(isOurKimiRule)) throw new Error("Modified managed block");
      removed += block.hooks.length;
      clean = clean.slice(0, match.index) + clean.slice(match.index! + match[0].length);
    }
    return { content: clean, removed };
  }
  if (content.includes("# >>> SessionBar Kimi hooks >>>") || content.includes("# <<< SessionBar Kimi hooks <<<")) throw new Error("Incomplete managed block");
  // Formatters can discard comments. In that case identify owned rules through
  // parsed TOML rather than appending duplicates or deleting whole sections.
  const config = parseKimiConfig(content);
  if (!Array.isArray(config.hooks)) return { content, removed: 0 };
  const remaining = config.hooks.filter(hook => !isOurKimiRule(hook));
  const removed = config.hooks.length - remaining.length;
  if (!removed) return { content, removed: 0 };
  if (remaining.length) config.hooks = remaining; else delete config.hooks;
  return { content: stringify(config, { numbersAsFloat: true }), removed };
}

function isOurKimiRule(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const rule = value as Record<string, unknown>;
  return typeof rule.event === "string" && (KIMI_HOOK_EVENTS as readonly string[]).includes(rule.event)
    && typeof rule.command === "string" && /nativeHarnessBridge\.js['"]?(?:\s|$)/.test(rule.command)
    && /(?:^|\s)['"]?--sessionbar-harness['"]?\s+['"]?kimi-code['"]?(?:\s|$)/.test(rule.command)
    && Object.keys(rule).every(key => ["event", "command", "matcher", "timeout"].includes(key));
}

export function setupKimiCodeHooks(global: boolean, reportPath: string): SetupResult {
  const path = kimiPath();
  const result: SetupResult = { name: "Kimi Code", path, added: 0 };
  if (!global) return { ...result, skipped: "Kimi hooks require user scope" };
  try {
    const original = existsSync(path) ? readFileSync(path, "utf8") : "";
    parseKimiConfig(original);
    const base = removeKimiBlock(original).content;
    const command = [process.execPath, bridgePath(reportPath), "--sessionbar-harness", "kimi-code"].map(shellQuote).join(" ");
    const hooks = KIMI_HOOK_EVENTS.map(event => ({ event, command, timeout: 3 }));
    const content = base + START + stringify({ hooks }) + END;
    parseKimiConfig(content);
    if (content !== original) writeConfig(path, content);
    return { ...result, added: original === content ? 0 : hooks.length };
  } catch { return { ...result, skipped: "Kimi config could not be safely updated" }; }
}

export function teardownKimiCodeHooks(global: boolean): number {
  const path = kimiPath();
  if (!global || !existsSync(path)) return 0;
  try {
    const original = readFileSync(path, "utf8");
    parseKimiConfig(original);
    const clean = removeKimiBlock(original);
    parseKimiConfig(clean.content);
    if (clean.removed) writeConfig(path, clean.content);
    return clean.removed;
  } catch { return 0; }
}

function isOurZCodeHook(hook: any): boolean {
  return hook?.type === "process" && Array.isArray(hook.args)
    && hook.args[1] === "--sessionbar-harness" && hook.args[2] === "zcode"
    && typeof hook.args[0] === "string" && /(?:^|[/\\])nativeHarnessBridge\.js$/.test(hook.args[0]);
}

function removeZCodeHooks(config: any): number {
  let removed = 0;
  const events = config.hooks?.events;
  if (!events || typeof events !== "object" || Array.isArray(events)) return 0;
  for (const [event, definitions] of Object.entries(events)) {
    if (!Array.isArray(definitions)) continue;
    for (const definition of definitions) {
      if (!Array.isArray(definition?.hooks)) continue;
      definition.hooks = definition.hooks.filter((hook: unknown) => {
        if (!isOurZCodeHook(hook)) return true;
        removed++;
        return false;
      });
    }
    events[event] = definitions.filter(def => !Array.isArray(def?.hooks) || def.hooks.length);
    if (!events[event].length) delete events[event];
  }
  return removed;
}

export function setupZCodeHooks(global: boolean, reportPath: string): SetupResult {
  const path = zcodePath();
  const result: SetupResult = { name: "ZCode", path, added: 0 };
  if (!global) return { ...result, skipped: "ZCode ignores project-level hooks; use user scope" };
  try {
    const original = existsSync(path) ? readFileSync(path, "utf8") : "{}";
    const config = JSON.parse(original);
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Invalid config");
    if (config.hooks !== undefined && (!config.hooks || typeof config.hooks !== "object" || Array.isArray(config.hooks))) throw new Error("Invalid hooks");
    config.hooks ??= {};
    if (config.hooks.enabled === false) return { ...result, skipped: "ZCode hooks are disabled by the user" };
    if (config.hooks.events !== undefined && (!config.hooks.events || typeof config.hooks.events !== "object" || Array.isArray(config.hooks.events))) throw new Error("Invalid events");
    config.hooks.events ??= {};
    if (config.hooks.enabled !== true && Object.keys(config.hooks.events).length) return { ...result, skipped: "Enable ZCode user hooks before adding SessionBar" };
    const before = JSON.stringify(config);
    const removed = removeZCodeHooks(config);
    config.hooks.enabled = true;
    for (const event of ZCODE_HOOK_EVENTS) {
      config.hooks.events[event] ??= [];
      if (!Array.isArray(config.hooks.events[event])) throw new Error("Invalid event hooks");
      config.hooks.events[event].push({ matcher: "", hooks: [{ type: "process", command: process.execPath,
        args: [bridgePath(reportPath), "--sessionbar-harness", "zcode"], enabled: true, timeoutMs: 3000 }] });
    }
    const changed = before !== JSON.stringify(config);
    if (changed) writeConfig(path, JSON.stringify(config, null, 2) + "\n");
    return { ...result, added: changed ? Math.max(0, ZCODE_HOOK_EVENTS.length - removed) : 0 };
  } catch { return { ...result, skipped: "ZCode config could not be safely updated" }; }
}

export function teardownZCodeHooks(global: boolean): number {
  const path = zcodePath();
  if (!global || !existsSync(path)) return 0;
  try {
    const config = JSON.parse(readFileSync(path, "utf8"));
    const removed = removeZCodeHooks(config);
    if (removed) {
      writeConfig(path, JSON.stringify(config, null, 2) + "\n");
    }
    return removed;
  } catch { return 0; }
}
