import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ProviderConfig } from "./providerAdapters.js";

const execFileAsync = promisify(execFile);
const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com";
const DEEPSEEK_PROVIDER_QUERY = `
  SELECT
    id,
    name,
    app_type,
    COALESCE(
      json_extract(settings_config, '$.env.ANTHROPIC_AUTH_TOKEN'),
      json_extract(settings_config, '$.env.ANTHROPIC_API_KEY')
    ) AS api_key,
    json_extract(settings_config, '$.env.ANTHROPIC_BASE_URL') AS base_url
  FROM providers
  WHERE app_type = 'claude'
    AND is_current = 1
    AND lower(name) LIKE '%deepseek%'
  LIMIT 1;
`;

interface CcSwitchProviderRow {
  name?: unknown;
  app_type?: unknown;
  api_key?: unknown;
  base_url?: unknown;
}

/** Convert CC Switch's redacted-free sqlite JSON output into a provider config. */
export function parseCCSwitchProviderOutput(stdout: string): ProviderConfig | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const row = asRecord(parsed[0]) as CcSwitchProviderRow | null;
  const name = stringValue(row?.name);
  const appType = stringValue(row?.app_type);
  const apiKey = stringValue(row?.api_key);
  if (!name?.toLowerCase().includes("deepseek") || appType !== "claude" || !apiKey) return null;

  return {
    id: "ccswitch-deepseek",
    provider: "deepseek",
    api_key: apiKey,
    label: "DeepSeek API (CC Switch)",
    // CC Switch's active Claude provider is the source for Claude Code sessions.
    target: "Claude Code",
    base_url: deepSeekBaseUrl(stringValue(row?.base_url)),
  };
}

/** Read the active DeepSeek provider from CC Switch without modifying its DB. */
export async function readCCSwitchDeepSeekConfig(home = homedir()): Promise<ProviderConfig | null> {
  const dbPath = join(home, ".cc-switch", "cc-switch.db");
  if (!existsSync(dbPath)) return null;
  try {
    const result = await execFileAsync("sqlite3", ["-json", dbPath, DEEPSEEK_PROVIDER_QUERY], {
      maxBuffer: 64 * 1024,
    });
    return parseCCSwitchProviderOutput(String(result.stdout));
  } catch {
    // CC Switch is an optional local source. Missing sqlite3, a locked DB, or
    // an older schema must not affect SessionBar's normal provider polling.
    return null;
  }
}

function deepSeekBaseUrl(value: string | undefined): string {
  if (!value) return DEFAULT_DEEPSEEK_BASE_URL;
  try {
    const url = new URL(value);
    return url.hostname === "api.deepseek.com" ? url.origin : DEFAULT_DEEPSEEK_BASE_URL;
  } catch {
    return DEFAULT_DEEPSEEK_BASE_URL;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
