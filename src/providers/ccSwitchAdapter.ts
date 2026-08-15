import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ProviderConfig } from "./providerAdapters.js";

const execFileAsync = promisify(execFile);
const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com";
const DEFAULT_KIMI_BASE_URL = "https://api.moonshot.ai";
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
const KIMI_PROVIDER_QUERY = `
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
  WHERE app_type IN ('claude', 'claude-desktop')
    AND is_current = 1
    AND lower(name) LIKE '%kimi%'
  ORDER BY CASE app_type WHEN 'claude' THEN 0 ELSE 1 END
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

/** Convert the active CC Switch Kimi provider into an Open Platform config. */
export function parseCCSwitchKimiProviderOutput(stdout: string): ProviderConfig | null {
  const row = parseProviderRow(stdout);
  const name = stringValue(row?.name);
  const appType = stringValue(row?.app_type);
  const apiKey = stringValue(row?.api_key);
  if (!name?.toLowerCase().includes("kimi") || !["claude", "claude-desktop"].includes(appType || "") || !apiKey) {
    return null;
  }

  return {
    id: "ccswitch-kimi",
    provider: "kimi",
    api_key: apiKey,
    label: "Kimi API (CC Switch)",
    target: "Kimi",
    base_url: kimiBaseUrl(stringValue(row?.base_url)),
  };
}

/** Read the active DeepSeek provider from CC Switch without modifying its DB. */
export async function readCCSwitchDeepSeekConfig(home = homedir()): Promise<ProviderConfig | null> {
  return readCCSwitchConfig(home, DEEPSEEK_PROVIDER_QUERY, parseCCSwitchProviderOutput);
}

/** Read the active Kimi provider from CC Switch without modifying its DB. */
export async function readCCSwitchKimiConfig(home = homedir()): Promise<ProviderConfig | null> {
  return readCCSwitchConfig(home, KIMI_PROVIDER_QUERY, parseCCSwitchKimiProviderOutput);
}

async function readCCSwitchConfig(
  home: string,
  query: string,
  parser: (stdout: string) => ProviderConfig | null,
): Promise<ProviderConfig | null> {
  const dbPath = join(home, ".cc-switch", "cc-switch.db");
  if (!existsSync(dbPath)) return null;
  try {
    const result = await execFileAsync("sqlite3", ["-json", dbPath, query], {
      maxBuffer: 64 * 1024,
    });
    return parser(String(result.stdout));
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

function kimiBaseUrl(value: string | undefined): string {
  if (!value) return DEFAULT_KIMI_BASE_URL;
  try {
    const url = new URL(value);
    if (url.hostname === "api.moonshot.ai" || url.hostname === "api.moonshot.cn") return url.origin;
    return DEFAULT_KIMI_BASE_URL;
  } catch {
    return DEFAULT_KIMI_BASE_URL;
  }
}

function parseProviderRow(stdout: string): CcSwitchProviderRow | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  return asRecord(parsed[0]) as CcSwitchProviderRow | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
