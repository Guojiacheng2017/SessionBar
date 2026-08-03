import { mapHookEvent } from "./hookOntology.js";
import type { SessionStatus } from "./types.js";

export interface HookAdapterResult {
  hook_event?: string;
  status?: SessionStatus;
  task_name?: string;
  activity_tail?: string[];
  tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  turns?: number;
  context_percent?: number;
}

export function adaptNativeHookPayload(agentType: string, raw: unknown): HookAdapterResult {
  const hookEvent = rawHookEventName(raw);
  if (!hookEvent) return {};

  const result: HookAdapterResult = { hook_event: hookEvent };
  const usage = usageFields(raw);
  Object.assign(result, usage);

  const mapping = mapHookEvent(agentType, hookEvent);
  if (mapping.mapping_type === "unmapped" || mapping.mapping_type === "unavailable") {
    return stripEmpty(result);
  }

  const toolLabel = toolActionLabel(raw);
  const errorText = stringValue(raw, ["error", "error_message", "message"]);
  const promptText = stringValue(raw, ["prompt", "user_prompt", "userPrompt", "message"]);
  const status = statusForStage(mapping.canonical_stage_id);
  const taskName = taskNameForStage(mapping.canonical_stage_id, toolLabel, promptText);
  const activity = activityForStage(mapping.canonical_stage_id, toolLabel, errorText, promptText);

  if (status) result.status = status;
  if (taskName) result.task_name = taskName;
  if (activity) result.activity_tail = [activity];

  return stripEmpty(result);
}

export function rawHookEventName(raw: unknown): string | undefined {
  return stringValue(raw, ["event", "eventName", "hook_event", "hook_event_name", "hookEvent", "hookEventName"]);
}

function statusForStage(stageId: string): SessionStatus | undefined {
  switch (stageId) {
    case "permission.request":
    case "permission.denied":
      return "blocked";
    case "tool.execute.failed":
    case "agent.turn.stop_failed":
    case "session.interrupt":
      return "error";
    case "session.end":
    case "session.idle":
    case "agent.turn.stop":
      return "idle";
    case "session.start":
    case "prompt.submit":
    case "tool.execute.before":
    case "tool.selection.before":
    case "tool.execute.after":
    case "model.request.before":
    case "model.request.after":
    case "agent.loop.before":
    case "context.compact.before":
    case "context.compact.after":
    case "subagent.start":
      return "working";
    default:
      return undefined;
  }
}

function taskNameForStage(stageId: string, toolLabel: string | undefined, promptText: string | undefined): string | undefined {
  switch (stageId) {
    case "permission.request":
      return "Waiting for permission";
    case "permission.denied":
      return "Permission denied";
    case "tool.execute.before":
      return toolLabel ? `running: ${toolLabel}` : "Using tool";
    case "tool.selection.before":
      return "Selecting tool";
    case "tool.execute.after":
      return "Analyzing tool results";
    case "tool.execute.failed":
      return toolLabel ? `failed: ${toolLabel}` : "Tool failed";
    case "model.request.before":
      return "Thinking";
    case "model.request.after":
      return "Reading model response";
    case "context.compact.before":
      return "Compacting context";
    case "context.compact.after":
      return "Context compacted";
    case "prompt.submit":
      return promptText ? `user: ${compactLine(promptText)}` : "Handling prompt";
    case "agent.loop.before":
      return "Agent running";
    case "subagent.start":
      return "Subagent running";
    case "session.start":
      return "Working";
    case "session.end":
      return "Session ended";
    case "session.idle":
    case "agent.turn.stop":
      return "Ready";
    case "agent.turn.stop_failed":
      return "Stop failed";
    case "session.interrupt":
      return "Interrupted";
    default:
      return undefined;
  }
}

function activityForStage(
  stageId: string,
  toolLabel: string | undefined,
  errorText: string | undefined,
  promptText: string | undefined,
): string | undefined {
  switch (stageId) {
    case "permission.request":
      return "wait: permission";
    case "permission.denied":
      return "denied: permission";
    case "tool.execute.before":
      return `tool: ${toolLabel ?? "tool"}`;
    case "tool.execute.after":
      return `done: ${toolLabel ?? "tool"}`;
    case "tool.execute.failed":
      return `error: ${compactLine(errorText ?? toolLabel ?? "tool failed")}`;
    case "context.compact.before":
      return "context: compact";
    case "context.compact.after":
      return "context: compacted";
    case "prompt.submit":
      return promptText ? `user: ${compactLine(promptText)}` : "user: prompt";
    case "session.start":
      return "session: started";
    case "session.end":
      return "session: ended";
    case "agent.turn.stop":
    case "session.idle":
      return "session: ready";
    default:
      return undefined;
  }
}

function usageFields(raw: unknown): Partial<HookAdapterResult> {
  return stripEmpty({
    tokens: numberValue(raw, ["tokens", "total_tokens", "totalTokens", "token_count", "tokenCount"]),
    input_tokens: numberValue(raw, ["input_tokens", "inputTokens", "prompt_tokens", "promptTokens"]),
    output_tokens: numberValue(raw, ["output_tokens", "outputTokens", "completion_tokens", "completionTokens"]),
    cache_read_tokens: numberValue(raw, [
      "cache_read_tokens",
      "cacheReadTokens",
      "cached_input_tokens",
      "cachedInputTokens",
      "cacheRead",
    ]),
    cache_write_tokens: numberValue(raw, [
      "cache_write_tokens",
      "cacheWriteTokens",
      "cache_creation_input_tokens",
      "cacheCreationInputTokens",
      "cacheWrite",
    ]),
    turns: numberValue(raw, ["turns", "turn_count", "turnCount"]),
    context_percent: numberValue(raw, ["context_percent", "contextPercent"]),
  });
}

function toolActionLabel(raw: unknown): string | undefined {
  const command = stringValue(raw, ["command", "cmd", "shell_command", "shellCommand"]);
  if (command) return compactLine(command);
  const tool = stringValue(raw, ["tool_name", "toolName", "tool", "name"]);
  return tool ? compactLine(tool) : undefined;
}

function stringValue(raw: unknown, keys: readonly string[]): string | undefined {
  const value = findValue(raw, keys);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(raw: unknown, keys: readonly string[]): number | undefined {
  const value = findValue(raw, keys);
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return value;
}

function findValue(raw: unknown, keys: readonly string[], depth = 0): unknown {
  if (!raw || typeof raw !== "object" || depth > 4) return undefined;
  const record = raw as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (value === undefined) continue;
    if (typeof value !== "object" || value === null) return value;
    const nestedValue = findValue(value, keys, depth + 1);
    if (nestedValue !== undefined) return nestedValue;
  }

  for (const key of [
    "payload",
    "data",
    "hook",
    "event",
    "tool",
    "tool_input",
    "toolInput",
    "toolArgs",
    "input",
    "args",
    "arguments",
    "shell",
    "properties",
    "usage",
    "metrics",
    "stats",
  ]) {
    const nested = record[key];
    const value = findValue(nested, keys, depth + 1);
    if (value !== undefined) return value;
  }
  return undefined;
}

function compactLine(value: string, max = 120): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 3))}...`;
}

function stripEmpty<T extends object>(value: T): T {
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(value)) {
    if (record[key] === undefined) delete record[key];
  }
  return value;
}
