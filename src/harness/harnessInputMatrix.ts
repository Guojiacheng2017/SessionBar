import type { HarnessInputTransport } from "./harnessSourceIdentity.js";

export type HarnessInputContract =
  | "native_hook_payload"
  | "session_snapshot"
  | "session_registry"
  | "event_log"
  | "usage_log"
  | "protocol_metadata"
  | "otlp_spans";

export interface HarnessInputDefinition {
  harness: string;
  label: string;
  transport: HarnessInputTransport;
  contract: HarnessInputContract;
  role: "primary" | "fallback" | "enrichment";
  adapter: string;
  artifact?: string;
  notes?: string;
}

export const HARNESS_INPUT_MATRIX: readonly HarnessInputDefinition[] = [
  { harness: "dsh", label: "DeepSeek Harness", transport: "filesystem", contract: "session_snapshot", role: "primary", adapter: "deepseekHarnessDiscovery", artifact: "dsh-projection-checkpoint", notes: "Read-only versioned projection checkpoints, not DeepSeek API balance; cached state is not live process liveness." },
  { harness: "codex", label: "Codex CLI / App", transport: "hook", contract: "native_hook_payload", role: "primary", adapter: "adaptNativeHookPayload" },
  { harness: "codex", label: "Codex CLI / App", transport: "filesystem", contract: "event_log", role: "fallback", adapter: "codex JSONL adapter", artifact: "codex-session-jsonl" },
  { harness: "codex", label: "Codex App", transport: "protocol", contract: "protocol_metadata", role: "enrichment", adapter: "codex app-server", notes: "Thread names and account usage; not session liveness." },
  { harness: "claude-code", label: "Claude Code", transport: "hook", contract: "native_hook_payload", role: "primary", adapter: "adaptNativeHookPayload" },
  { harness: "claude-code", label: "Claude Code", transport: "filesystem", contract: "usage_log", role: "enrichment", adapter: "sessionUsageImporter", notes: "Token history only; Hook remains the session state source." },
  { harness: "claude-desktop", label: "Claude Desktop", transport: "filesystem", contract: "session_snapshot", role: "primary", adapter: "claudeDesktopDiscovery", artifact: "claude-desktop-session-snapshot", notes: "Desktop exposes no SessionBar Hook; read-only app snapshot files are required." },
  { harness: "workbuddy-desktop", label: "WorkBuddy Desktop", transport: "filesystem", contract: "session_registry", role: "primary", adapter: "workbuddyDesktopDiscovery", artifact: "workbuddy-desktop-live-registry", notes: "Desktop registry and bounded transcript metadata; traces are excluded." },
  { harness: "workbuddy-desktop", label: "WorkBuddy Desktop", transport: "filesystem", contract: "session_registry", role: "fallback", adapter: "workbuddyDesktopDiscovery", artifact: "workbuddy-desktop-database", notes: "Read-only SQLite session snapshots; DB/WAL notifications use bounded reconciliation. Shared-memory writes are not watched." },
  { harness: "codebuddy-cli", label: "CodeBuddy CLI", transport: "hook", contract: "native_hook_payload", role: "primary", adapter: "adaptNativeHookPayload" },
  { harness: "gemini", label: "Gemini CLI", transport: "hook", contract: "native_hook_payload", role: "primary", adapter: "adaptNativeHookPayload" },
  { harness: "kimi-code", label: "Kimi Code CLI / Desktop", transport: "hook", contract: "native_hook_payload", role: "primary", adapter: "nativeHarnessBridge", notes: "Shared user config.toml; client_type retained; no inferred usage or quota." },
  { harness: "kimi-code", label: "Kimi Code", transport: "filesystem", contract: "session_registry", role: "fallback", adapter: "kimiCodeDiscovery", artifact: "kimi-code-session-index", notes: "Reads v2 session metadata only; prompt content is excluded. Never overwrites Hook status." },
  { harness: "zcode", label: "ZCode", transport: "hook", contract: "native_hook_payload", role: "primary", adapter: "nativeHarnessBridge", notes: "User-level config.json process hooks only; project hooks are ignored upstream. Not the Z.ai API provider." },
  { harness: "copilot", label: "GitHub Copilot CLI", transport: "hook", contract: "native_hook_payload", role: "primary", adapter: "adaptNativeHookPayload" },
  { harness: "cursor", label: "Cursor", transport: "hook", contract: "native_hook_payload", role: "primary", adapter: "adaptNativeHookPayload", notes: "conversation_id is the native session identity; model/model_id preserves Grok provider identity without changing the Cursor harness." },
  { harness: "pi", label: "Pi Agent", transport: "hook", contract: "native_hook_payload", role: "primary", adapter: "Pi extension bridge", notes: "Extension callbacks are normalized as Hook events; no polling." },
  { harness: "remote", label: "Registered remote harness", transport: "otlp", contract: "otlp_spans", role: "primary", adapter: "OTLP telemetry adapter" },
];

export function harnessInputsFor(harness: string): HarnessInputDefinition[] {
  return HARNESS_INPUT_MATRIX.filter(input => input.harness === harness);
}
