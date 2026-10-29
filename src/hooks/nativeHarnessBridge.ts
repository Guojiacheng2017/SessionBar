import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { request } from "node:http";
import { basename, isAbsolute, join, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { adaptNativeHookPayload } from "./hookAdapters.js";
import type { SessionReportPayload } from "../sessions/sessionPayload.js";

export const KIMI_HOOK_EVENTS = [
  "SessionStart", "UserPromptSubmit", "TurnStarted", "PreToolUse", "PostToolUse", "PostToolUseFailure",
  "PermissionRequest", "PermissionResult", "Stop", "StopFailure", "Interrupt", "PreCompact", "PostCompact", "SessionEnd",
] as const;
export const ZCODE_HOOK_EVENTS = [
  "SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolUse", "PostToolUseFailure", "Stop",
] as const;

function shortString(value: unknown, max = 128): string | undefined {
  return typeof value === "string" && value.trim() && value.length <= max && !/[\r\n\0]/.test(value) ? value.trim() : undefined;
}

/** Native metadata only: never forward prompts, tool output, credentials or guessed usage. */
export function nativeHarnessHookReport(harness: string, raw: unknown): SessionReportPayload | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const data = raw as Record<string, unknown>;
  const nativeId = shortString(data.session_id);
  const event = shortString(data.hook_event_name);
  const cwd = shortString(data.cwd, 2048);
  const events: readonly string[] = harness === "kimi-code" ? KIMI_HOOK_EVENTS : harness === "zcode" ? ZCODE_HOOK_EVENTS : [];
  if (!nativeId || !event || !cwd || (!isAbsolute(cwd) && !win32.isAbsolute(cwd)) || !events.includes(event)) return undefined;
  const client = shortString(data.client_type, 64);
  const type = harness === "zcode" ? "ZCode" : client === "kimi_code_cli" ? "Kimi CLI" : "Kimi Code";
  const adapted = adaptNativeHookPayload(type, { hook_event_name: event, tool_name: shortString(data.tool_name) });
  let status = adapted.status;
  let task = adapted.task_name;
  if (event === "SessionStart") { status = "idle"; task = "Ready"; }
  if (event === "Interrupt") { status = "idle"; task = "Interrupted"; }
  if (event === "PermissionResult") {
    if (data.decision === "approved") { status = "working"; task = "Permission granted"; }
    else if (data.decision === "denied") { status = "blocked"; task = "Permission denied"; }
    else if (data.decision === "error") { status = "error"; task = "Permission failed"; }
    else return undefined;
  }
  if (!status || !task) return undefined;
  const project = (isAbsolute(cwd) ? basename(cwd) : win32.basename(cwd)) || harness;
  const sessionId = `${harness}-${nativeId}__${project}`;
  if (sessionId.length > 256) return undefined;
  return {
    session_id: sessionId,
    session_type: type,
    session_name: shortString(data.session_title),
    source: "hook",
    session_source: `${harness}:hook${client ? `:${client}` : ""}`,
    status,
    task_name: task,
    project,
    project_path: cwd,
    hook_event: event,
  };
}

async function run(): Promise<void> {
  // The hook must never hold up a harness or write model-visible stdout.
  const deadline = setTimeout(() => process.exit(0), 2500);
  deadline.unref();
  try {
    const home = process.env.SESSIONBAR_HOME || process.env.AGENTBAR_HOME || join(homedir(), ".sessionbar");
    const value = process.env.SESSIONBAR_PORT || process.env.SESSION_BAR_PORT || readFileSync(join(home, "port"), "utf8").trim();
    if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) return;
    let input = "";
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) {
      input += chunk;
      if (Buffer.byteLength(input) > 256 * 1024) return;
    }
    const flag = process.argv.indexOf("--sessionbar-harness");
    const report = nativeHarnessHookReport(flag < 0 ? "" : process.argv[flag + 1], JSON.parse(input));
    if (!report) return;
    const body = JSON.stringify(report);
    await new Promise<void>(resolve => {
      const req = request({ hostname: "127.0.0.1", port: Number(value), path: "/session/status", method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }, timeout: 1500 }, res => {
        res.resume();
        res.on("end", resolve);
        res.on("error", () => resolve());
      });
      req.on("timeout", () => req.destroy());
      req.on("error", () => resolve());
      req.end(body);
    });
  } catch { /* Offline Relay, malformed input and unsupported events are fail-open. */ }
  finally { clearTimeout(deadline); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void run();
