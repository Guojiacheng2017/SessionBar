/** Native service identities shared by discovery, classification and both UIs. */
export const CODEX_SERVICE_LABELS = {
  mcp_extension_host: "MCP tool host",
  composer_predictions: "Input suggestions",
  review: "Code review service",
  guardian: "Approval review",
  compaction: "Context compaction",
  memory_consolidation: "Memory consolidation",
} as const;

export type CodexBackgroundService = keyof typeof CODEX_SERVICE_LABELS;
export const CODEX_USER_SOURCES = new Set(["user", "cli", "vscode", "exec", "appServer"]);

function record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string" && value.length <= 2048 && value.startsWith("{")) {
    try { value = JSON.parse(value); } catch { return undefined; }
  }
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function serviceName(value: unknown): CodexBackgroundService | undefined {
  if (value === "compact") return "compaction";
  return typeof value === "string" && Object.hasOwn(CODEX_SERVICE_LABELS, value) ? value as CodexBackgroundService : undefined;
}

/** Recognize only native enum shapes, never arbitrary prompt/title keywords. */
export function codexBackgroundService(value: unknown): CodexBackgroundService | undefined {
  const direct = serviceName(value);
  if (direct) return direct;
  const source = record(value);
  const child = source?.subagent ?? source?.subAgent;
  return serviceName(source?.internal) ?? serviceName(child) ?? serviceName(record(child)?.other);
}

export function codexNativeSource(...values: unknown[]): string | undefined {
  for (const value of values) {
    const service = codexBackgroundService(value);
    if (service) return service;
  }
  return values.find((value): value is string => typeof value === "string" && !!value.trim()
    && value.length <= 128 && !value.startsWith("{"))?.trim();
}

export function codexHasSubagentSource(...values: unknown[]): boolean {
  return values.some(value => value === "subagent" || value === "subAgent"
    || record(value)?.subagent !== undefined || record(value)?.subAgent !== undefined);
}
