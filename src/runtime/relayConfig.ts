import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writePrivateState } from "../shared/privateState.js";

type RelayEnv = Readonly<Record<string, string | undefined>>;

// Startup environment that affects provider discovery, collection, or transport.
// Keep presentation flags and launcher-injected PORT/WEB/BUN_REEXEC out: attaching
// a different view must not look like a different provider configuration.
const CONFIG_KEYS = new Set([
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "all_proxy", "no_proxy",
  "NODE_OPTIONS", "NODE_USE_ENV_PROXY", "NODE_USE_SYSTEM_CA", "NODE_EXTRA_CA_CERTS",
  "NODE_TLS_REJECT_UNAUTHORIZED", "SSL_CERT_FILE", "SSL_CERT_DIR", "OPENSSL_CONF",
  "HOME", "USERPROFILE", "PATH", "XDG_CONFIG_HOME", "CODEX_HOME", "WORKBUDDY_HOME", "KIMI_CODE_HOME",
  "SESSIONBAR_PROVIDER_POLL", "SESSIONBAR_PROVIDER_POLL_MS", "SESSIONBAR_CCSWITCH",
  "SESSIONBAR_GROK_BILLING", "SESSIONBAR_GROK_BIN", "SESSIONBAR_WORKBUDDY_BALANCE_COMMAND",
  "SESSIONBAR_KIMI_ACCESS_TOKEN", "KIMI_ACCESS_TOKEN",
  "DEEPSEEK_API_KEY", "MINIMAX_TOKEN_PLAN_KEY", "KIMI_API_KEY", "MOONSHOT_API_KEY",
  "XAI_MANAGEMENT_API_KEY", "XAI_TEAM_ID", "OPENAI_ADMIN_KEY", "ANTHROPIC_ADMIN_KEY",
  "SESSIONBAR_DEEPSEEK_API_KEY", "SESSIONBAR_MINIMAX_TOKEN_PLAN_KEY", "SESSIONBAR_KIMI_API_KEY",
  "SESSIONBAR_XAI_MANAGEMENT_API_KEY", "SESSIONBAR_XAI_TEAM_ID",
  "SESSIONBAR_OPENAI_ADMIN_KEY", "SESSIONBAR_ANTHROPIC_ADMIN_KEY",
]);

for (const provider of ["DEEPSEEK", "MINIMAX", "KIMI", "XAI", "OPENAI", "ANTHROPIC"]) {
  for (const field of ["LABEL", "TARGET", "BASE_URL"]) CONFIG_KEYS.add(`SESSIONBAR_${provider}_${field}`);
}

/**
 * Private comparison value, never a public revision. A hash of low-entropy
 * secrets can still be guessed; only store it in SessionBar's private state.
 * Do not include it in health responses, logs, diagnostics, or telemetry.
 * Unset and empty are distinct because transport implementations may treat an
 * explicitly empty lowercase proxy variable as overriding an uppercase value.
 */
export function relayConfigId(env: RelayEnv = process.env): string {
  const entries = [...CONFIG_KEYS].sort().map(key => [key, env[key] ?? null]);
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

/** Call only when a Relay owns its instance lock, never when a client attaches. */
export function recordRelayConfig(home: string, env: RelayEnv, pid = process.pid): { revision: string } {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid Relay PID");
  const revision = randomUUID();
  const fingerprint = relayConfigId({ ...env });
  writePrivateState(join(home, "startup-config.json"), JSON.stringify({ version: 1, pid, revision, fingerprint }));
  // The public revision is random, so it reveals no configuration or secret hash.
  return { revision };
}

/**
 * Compare a client's environment with the identified Relay's private startup
 * record. This is read-only: a mismatch requires an explicit Relay restart.
 * Missing/old records and ownership races are unknown, not a mismatch.
 */
export function readRelayConfigMatch(
  home: string,
  env: RelayEnv,
  pid: number,
  revision: string,
): boolean | undefined {
  try {
    const record = JSON.parse(readFileSync(join(home, "startup-config.json"), "utf8"));
    if (record?.version !== 1 || !Number.isSafeInteger(pid) || pid <= 0
      || record.pid !== pid || !revision || record.revision !== revision
      || typeof record.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(record.fingerprint)) return undefined;
    return record.fingerprint === relayConfigId(env);
  } catch {
    return undefined;
  }
}
