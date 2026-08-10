import type { SessionAgentSignalInput } from "./types.js";

export type ProviderId = "deepseek" | "minimax" | "kimi" | "xai" | "openai" | "anthropic";

export interface ProviderConfig {
  id: string;
  provider: ProviderId;
  api_key: string;
  label: string;
  target: string;
  team_id?: string;
  base_url?: string;
}

export type PublicProviderConfig = Omit<ProviderConfig, "api_key">;

export interface ProviderPollResult {
  config: PublicProviderConfig;
  signals: SessionAgentSignalInput[];
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type Env = Readonly<Record<string, string | undefined>>;

const DEFAULTS: Record<ProviderId, { label: string; target: string; baseUrl: string }> = {
  deepseek: { label: "DeepSeek API", target: "DeepSeek", baseUrl: "https://api.deepseek.com" },
  minimax: { label: "MiniMax Token Plan", target: "MiniMax", baseUrl: "https://www.minimaxi.com" },
  kimi: { label: "Kimi API", target: "Kimi", baseUrl: "https://api.moonshot.ai" },
  xai: { label: "xAI API", target: "Grok,xAI", baseUrl: "https://management-api.x.ai" },
  openai: { label: "OpenAI API", target: "OpenAI,Codex", baseUrl: "https://api.openai.com" },
  anthropic: { label: "Anthropic API", target: "Anthropic,Claude", baseUrl: "https://api.anthropic.com" },
};

export function providerConfigsFromEnv(env: Env): ProviderConfig[] {
  const configs: ProviderConfig[] = [];
  const deepseekKey = first(env, ["SESSIONBAR_DEEPSEEK_API_KEY", "DEEPSEEK_API_KEY"]);
  const minimaxKey = first(env, ["SESSIONBAR_MINIMAX_TOKEN_PLAN_KEY", "MINIMAX_TOKEN_PLAN_KEY"]);
  const kimiKey = first(env, ["SESSIONBAR_KIMI_API_KEY", "KIMI_API_KEY", "MOONSHOT_API_KEY"]);
  const xaiKey = first(env, ["SESSIONBAR_XAI_MANAGEMENT_API_KEY", "XAI_MANAGEMENT_API_KEY"]);
  const openaiKey = first(env, ["SESSIONBAR_OPENAI_ADMIN_KEY", "OPENAI_ADMIN_KEY"]);
  const anthropicKey = first(env, ["SESSIONBAR_ANTHROPIC_ADMIN_KEY", "ANTHROPIC_ADMIN_KEY"]);

  if (deepseekKey) configs.push(makeConfig("deepseek", deepseekKey, env));
  if (minimaxKey) configs.push(makeConfig("minimax", minimaxKey, env));
  if (kimiKey) configs.push(makeConfig("kimi", kimiKey, env));
  if (xaiKey && first(env, ["SESSIONBAR_XAI_TEAM_ID", "XAI_TEAM_ID"])) configs.push(makeConfig("xai", xaiKey, env));
  if (openaiKey) configs.push(makeConfig("openai", openaiKey, env));
  if (anthropicKey) configs.push(makeConfig("anthropic", anthropicKey, env));
  return configs;
}

export async function pollProvider(
  config: ProviderConfig,
  fetchImpl: FetchLike = globalThis.fetch,
  now = Date.now(),
): Promise<ProviderPollResult> {
  try {
    let signals: SessionAgentSignalInput[];
    switch (config.provider) {
      case "deepseek":
        signals = parseDeepSeekBalance(
          await getJson(fetchImpl, urlFor(config, "/user/balance"), bearerHeaders(config)),
          config.label,
        );
        break;
      case "minimax":
        signals = parseMiniMaxTokenPlan(await getJson(fetchImpl, urlFor(config, "/v1/token_plan/remains"), bearerHeaders(config)));
        break;
      case "kimi":
        signals = parseKimiBalance(
          await getJson(fetchImpl, urlFor(config, "/v1/users/me/balance"), bearerHeaders(config)),
          config.label,
        );
        break;
      case "xai":
        signals = parseXaiPrepaidBalance(await getJson(
          fetchImpl,
          `${urlFor(config, "")}/v1/billing/teams/${encodeURIComponent(config.team_id || "")}/prepaid/balance`,
          bearerHeaders(config),
        ));
        break;
      case "openai":
        signals = parseOpenAIUsage(await getJson(
          fetchImpl,
          openAIUsageUrl(config, now),
          bearerHeaders(config),
        ));
        break;
      case "anthropic":
        signals = parseAnthropicUsage(await getJson(
          fetchImpl,
          anthropicUsageUrl(config, now),
          {
            "x-api-key": config.api_key,
            "anthropic-version": "2023-06-01",
          },
        ));
        break;
    }
    return { config: publicConfig(config), signals };
  } catch (error) {
    return {
      config: publicConfig(config),
      signals: [healthSignal(config, errorCode(error))],
    };
  }
}

export function parseDeepSeekBalance(body: unknown, label = DEFAULTS.deepseek.label): SessionAgentSignalInput[] {
  const payload = asRecord(body);
  const available = payload?.is_available !== false;
  const balances = Array.isArray(payload?.balance_infos) ? payload.balance_infos : [];
  const signals = balances.flatMap((item): SessionAgentSignalInput[] => {
    const info = asRecord(item);
    const currency = shortString(info?.currency);
    const remaining = nonNegativeNumber(info?.total_balance);
    if (!currency || remaining === undefined) return [];
    return [{
      signal: `deepseek.balance.${currency}`,
      kind: "balance",
      source: "provider_api",
      scope: "account",
      remaining,
      unit: currency,
      status: available ? "ok" : "insufficient",
      label: `${label} ${currency}`,
    }];
  });
  return signals.length > 0 ? signals : [healthSignalForLabel("deepseek", label, available ? "empty" : "insufficient")];
}

export function parseMiniMaxTokenPlan(body: unknown, label = DEFAULTS.minimax.label): SessionAgentSignalInput[] {
  const fields = findQuotaFields(body);
  if (!fields || (fields.used === undefined && fields.remaining === undefined && fields.limit === undefined)) {
    return [healthSignalForLabel("minimax", label, "empty")];
  }
  return [{
    signal: "minimax.quota",
    kind: "quota",
    source: "provider_api",
    scope: "account",
    ...(fields.used === undefined ? {} : { used: fields.used }),
    ...(fields.remaining === undefined ? {} : { remaining: fields.remaining }),
    ...(fields.limit === undefined ? {} : { limit: fields.limit }),
    unit: "tokens",
    status: "ok",
    ...(fields.resetAt === undefined ? {} : { reset_at: fields.resetAt }),
    label,
  }];
}

export function parseKimiBalance(body: unknown, label = DEFAULTS.kimi.label): SessionAgentSignalInput[] {
  const data = asRecord(asRecord(body)?.data);
  const remaining = nonNegativeNumber(data?.available_balance);
  if (remaining === undefined) return [healthSignalForLabel("kimi", label, "empty")];
  return [{
    signal: "kimi.balance",
    kind: "balance",
    source: "provider_api",
    scope: "account",
    remaining,
    unit: "USD",
    status: remaining > 0 ? "ok" : "insufficient",
    label,
  }];
}

export function parseXaiPrepaidBalance(body: unknown, label = DEFAULTS.xai.label): SessionAgentSignalInput[] {
  const payload = asRecord(body);
  const total = asRecord(payload?.total);
  const cents = nonNegativeNumber(total?.val ?? payload?.total);
  if (cents === undefined) return [healthSignalForLabel("xai", label, "empty")];
  return [{
    signal: "xai.balance",
    kind: "balance",
    source: "provider_api",
    scope: "account",
    remaining: cents / 100,
    unit: "USD",
    status: "ok",
    label,
  }];
}

export function parseOpenAIUsage(body: unknown, label = "OpenAI API today"): SessionAgentSignalInput[] {
  const usage = aggregateTokenUsage(body);
  return [{
    signal: "openai.usage",
    kind: "usage",
    source: "provider_api",
    scope: "account",
    used: usage.input + usage.output,
    unit: "tokens",
    status: "ok",
    label,
  }];
}

export function parseAnthropicUsage(body: unknown, label = "Anthropic API today"): SessionAgentSignalInput[] {
  const usage = aggregateTokenUsage(body);
  return [{
    signal: "anthropic.usage",
    kind: "usage",
    source: "provider_api",
    scope: "account",
    used: usage.input + usage.output,
    unit: "tokens",
    status: "ok",
    label,
  }];
}

function makeConfig(provider: ProviderId, apiKey: string, env: Env): ProviderConfig {
  const defaults = DEFAULTS[provider];
  const prefix = provider.toUpperCase();
  return {
    id: provider,
    provider,
    api_key: apiKey,
    label: env[`SESSIONBAR_${prefix}_LABEL`] || defaults.label,
    target: env[`SESSIONBAR_${prefix}_TARGET`] || defaults.target,
    team_id: provider === "xai" ? first(env, ["SESSIONBAR_XAI_TEAM_ID", "XAI_TEAM_ID"]) : undefined,
    base_url: env[`SESSIONBAR_${prefix}_BASE_URL`] || defaults.baseUrl,
  };
}

function publicConfig(config: ProviderConfig): PublicProviderConfig {
  const { api_key: _apiKey, ...safe } = config;
  return safe;
}

function bearerHeaders(config: ProviderConfig): HeadersInit {
  return { Authorization: `Bearer ${config.api_key}` };
}

async function getJson(fetchImpl: FetchLike, url: string, headers: HeadersInit): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetchImpl(url, { method: "GET", headers, signal: controller.signal });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new ProviderRequestError(response.status);
    return body;
  } finally {
    clearTimeout(timeout);
  }
}

function urlFor(config: ProviderConfig, path: string): string {
  return `${(config.base_url || DEFAULTS[config.provider].baseUrl).replace(/\/$/, "")}${path}`;
}

function openAIUsageUrl(config: ProviderConfig, now: number): string {
  const start = Math.floor((now - 24 * 60 * 60 * 1000) / 1000);
  const end = Math.floor(now / 1000);
  return `${urlFor(config, "/v1/organization/usage/completions")}?start_time=${start}&end_time=${end}&bucket_width=1d&limit=1`;
}

function anthropicUsageUrl(config: ProviderConfig, now: number): string {
  const start = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const end = new Date(now).toISOString();
  return `${urlFor(config, "/v1/organizations/usage_report/messages")}?starting_at=${encodeURIComponent(start)}&ending_at=${encodeURIComponent(end)}&bucket_width=1d`;
}

function healthSignal(config: ProviderConfig, code: string): SessionAgentSignalInput {
  return healthSignalForLabel(config.provider, config.label, code);
}

function healthSignalForLabel(provider: ProviderId, label: string, code: string): SessionAgentSignalInput {
  return {
    signal: `${provider}.health`,
    kind: "service_health",
    source: "provider_api",
    scope: "account",
    status: "error",
    error_code: code,
    label,
  };
}

function findQuotaFields(value: unknown, depth = 0): { used?: number; remaining?: number; limit?: number; resetAt?: number } | null {
  if (depth > 5 || value === null || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findQuotaFields(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  const record = value as Record<string, unknown>;
  const used = firstNumber(record, ["used", "used_tokens", "consumed", "consumed_tokens"]);
  const remaining = firstNumber(record, ["remaining", "remain", "remains", "available", "available_tokens"]);
  const limit = firstNumber(record, ["limit", "total", "quota", "total_tokens"]);
  const resetAt = firstTimestamp(record, ["reset_at", "resetAt", "reset_time", "resetTime"]);
  if (used !== undefined || remaining !== undefined || limit !== undefined) return { used, remaining, limit, resetAt };
  for (const child of Object.values(record)) {
    const found = findQuotaFields(child, depth + 1);
    if (found) return found;
  }
  return null;
}

function aggregateTokenUsage(value: unknown): { input: number; output: number } {
  let input = 0;
  let output = 0;
  const visit = (item: unknown, depth: number) => {
    if (depth > 8 || item === null || typeof item !== "object") return;
    if (Array.isArray(item)) {
      for (const child of item) visit(child, depth + 1);
      return;
    }
    const record = item as Record<string, unknown>;
    const inputValue = firstNumber(record, ["input_tokens", "inputTokens", "prompt_tokens", "promptTokens"]);
    const outputValue = firstNumber(record, ["output_tokens", "outputTokens", "completion_tokens", "completionTokens"]);
    if (inputValue !== undefined) input += inputValue;
    if (outputValue !== undefined) output += outputValue;
    for (const [key, child] of Object.entries(record)) {
      if (key !== "input_tokens" && key !== "output_tokens" && key !== "inputTokens" && key !== "outputTokens" && key !== "prompt_tokens" && key !== "promptTokens" && key !== "completion_tokens" && key !== "completionTokens") {
        visit(child, depth + 1);
      }
    }
  };
  visit(value, 0);
  return { input, output };
}

function firstNumber(record: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = nonNegativeNumber(record[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function firstTimestamp(record: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    const numeric = nonNegativeNumber(value);
    if (numeric !== undefined) return numeric;
    if (typeof value === "string") {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
    }
  }
  return undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : undefined;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  }
  return undefined;
}

function shortString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() && value.length <= 32 ? value.trim() : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function first(env: Env, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

function errorCode(error: unknown): string {
  if (error instanceof ProviderRequestError) return error.code;
  if (error instanceof DOMException && error.name === "AbortError") return "TIMEOUT";
  return "NETWORK_ERROR";
}

class ProviderRequestError extends Error {
  readonly code: string;

  constructor(status: number) {
    super(`Provider request failed with HTTP ${status}`);
    this.code = `HTTP_${status}`;
  }
}
