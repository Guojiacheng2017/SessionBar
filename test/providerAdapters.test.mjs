import assert from "node:assert/strict";
import test from "node:test";
import {
  parseAnthropicUsage,
  parseDeepSeekBalance,
  parseKimiBalance,
  parseMiniMaxTokenPlan,
  parseOpenAIUsage,
  parseXaiPrepaidBalance,
  pollProvider,
  providerConfigsFromEnv,
} from "../dist/providerAdapters.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("provider config reads explicit keys and never treats ordinary API keys as admin keys", () => {
  const configs = providerConfigsFromEnv({
    SESSIONBAR_DEEPSEEK_API_KEY: "deepseek-secret",
    SESSIONBAR_MINIMAX_TOKEN_PLAN_KEY: "minimax-secret",
    SESSIONBAR_KIMI_API_KEY: "kimi-secret",
    XAI_MANAGEMENT_API_KEY: "xai-secret",
    XAI_TEAM_ID: "team-1",
    OPENAI_API_KEY: "ordinary-openai-key",
    ANTHROPIC_API_KEY: "ordinary-anthropic-key",
    SESSIONBAR_OPENAI_ADMIN_KEY: "openai-admin-secret",
    SESSIONBAR_ANTHROPIC_ADMIN_KEY: "anthropic-admin-secret",
  });

  assert.deepEqual(configs.map(config => config.provider), [
    "deepseek",
    "minimax",
    "kimi",
    "xai",
    "openai",
    "anthropic",
  ]);
  assert.equal(configs.find(config => config.provider === "xai").team_id, "team-1");
  assert.equal(configs.find(config => config.provider === "openai").api_key, "openai-admin-secret");
  assert.equal(configs.find(config => config.provider === "anthropic").api_key, "anthropic-admin-secret");
  assert.equal(JSON.stringify(configs).includes("ordinary-openai-key"), false);
});

test("DeepSeek balance response becomes an account balance signal", async () => {
  const calls = [];
  const config = providerConfigsFromEnv({ SESSIONBAR_DEEPSEEK_API_KEY: "deepseek-secret" })[0];
  const result = await pollProvider(config, async (url, init) => {
    calls.push({ url: String(url), init });
    return jsonResponse({
      is_available: true,
      balance_infos: [
        { currency: "CNY", total_balance: "110.00" },
        { currency: "USD", total_balance: "2.50" },
      ],
    });
  }, 1_700_000_000_000);

  assert.equal(calls[0].url, "https://api.deepseek.com/user/balance");
  assert.equal(calls[0].init.headers.Authorization, "Bearer deepseek-secret");
  assert.deepEqual(result.signals, [
    {
      signal: "deepseek.balance.CNY",
      kind: "balance",
      source: "provider_api",
      scope: "account",
      remaining: 110,
      unit: "CNY",
      status: "ok",
      label: "DeepSeek API CNY",
    },
    {
      signal: "deepseek.balance.USD",
      kind: "balance",
      source: "provider_api",
      scope: "account",
      remaining: 2.5,
      unit: "USD",
      status: "ok",
      label: "DeepSeek API USD",
    },
  ]);
});

test("MiniMax Token Plan response becomes a quota signal", () => {
  const signals = parseMiniMaxTokenPlan({
    data: {
      remaining: 750000,
      used: 250000,
      limit: 1000000,
      reset_at: 1_700_018_000,
    },
  });

  assert.deepEqual(signals, [{
    signal: "minimax.quota",
    kind: "quota",
    source: "provider_api",
    scope: "account",
    used: 250000,
    remaining: 750000,
    limit: 1000000,
    unit: "tokens",
    status: "ok",
    reset_at: 1_700_018_000,
    label: "MiniMax Token Plan",
  }]);
});

test("Kimi balance response becomes an available USD balance signal", () => {
  assert.deepEqual(parseKimiBalance({
    code: 0,
    data: { available_balance: 49.58894, voucher_balance: 46.58893, cash_balance: 3.00001 },
    status: true,
  }), [{
    signal: "kimi.balance",
    kind: "balance",
    source: "provider_api",
    scope: "account",
    remaining: 49.58894,
    unit: "USD",
    status: "ok",
    label: "Kimi API",
  }]);
});

test("xAI prepaid balance converts USD cents to a balance signal", () => {
  const signals = parseXaiPrepaidBalance({ total: { val: "12345" } });
  assert.deepEqual(signals, [{
    signal: "xai.balance",
    kind: "balance",
    source: "provider_api",
    scope: "account",
    remaining: 123.45,
    unit: "USD",
    status: "ok",
    label: "xAI API",
  }]);
});

test("OpenAI and Anthropic admin reports become usage signals, not balances", () => {
  assert.deepEqual(parseOpenAIUsage({
    data: [{ results: [{ input_tokens: 1000, output_tokens: 500, input_cached_tokens: 200 }] }],
  }), [{
    signal: "openai.usage",
    kind: "usage",
    source: "provider_api",
    scope: "account",
    used: 1500,
    unit: "tokens",
    status: "ok",
    label: "OpenAI API today",
  }]);

  assert.deepEqual(parseAnthropicUsage({
    data: [{ results: [{ input_tokens: 2000, output_tokens: 700, cache_read_input_tokens: 300 }] }],
  }), [{
    signal: "anthropic.usage",
    kind: "usage",
    source: "provider_api",
    scope: "account",
    used: 2700,
    unit: "tokens",
    status: "ok",
    label: "Anthropic API today",
  }]);
});

test("provider request failures become a redacted health signal", async () => {
  const config = providerConfigsFromEnv({ SESSIONBAR_DEEPSEEK_API_KEY: "deepseek-secret" })[0];
  const result = await pollProvider(config, async () => jsonResponse({ error: "secret details" }, 429));

  assert.equal(result.signals.length, 1);
  assert.deepEqual(result.signals[0], {
    signal: "deepseek.health",
    kind: "service_health",
    source: "provider_api",
    scope: "account",
    status: "error",
    error_code: "HTTP_429",
    label: "DeepSeek API",
  });
  assert.equal(JSON.stringify(result).includes("secret details"), false);
  assert.equal(JSON.stringify(result).includes("deepseek-secret"), false);
});
