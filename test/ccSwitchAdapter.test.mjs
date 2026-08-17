import assert from "node:assert/strict";
import test from "node:test";
import {
  parseCCSwitchProviderOutput,
  parseCCSwitchKimiProviderOutput,
  readCCSwitchDeepSeekConfig,
  readCCSwitchKimiConfig,
} from "../dist/providers/ccSwitchAdapter.js";

import { pollProvider } from "../dist/providers/providerAdapters.js";

test("CC Switch provider output becomes a DeepSeek balance config", () => {
  const config = parseCCSwitchProviderOutput(JSON.stringify([{
    id: "deepseek-id",
    name: "DeepSeek",
    app_type: "claude",
    api_key: "ccswitch-secret",
    base_url: "https://api.deepseek.com/anthropic",
  }]));

  assert.deepEqual(config, {
    id: "ccswitch-deepseek",
    provider: "deepseek",
    api_key: "ccswitch-secret",
    label: "DeepSeek API",
    target: "Claude Code",
    base_url: "https://api.deepseek.com",
  });
});

test("CC Switch provider output ignores non-DeepSeek or non-Claude rows", () => {
  assert.equal(parseCCSwitchProviderOutput(JSON.stringify([{
    id: "kimi-id",
    name: "Kimi",
    app_type: "claude",
    api_key: "secret",
    base_url: "https://api.moonshot.ai",
  }])), null);
  assert.equal(parseCCSwitchProviderOutput(JSON.stringify([{
    id: "deepseek-id",
    name: "DeepSeek",
    app_type: "codex",
    api_key: "secret",
    base_url: "https://api.deepseek.com",
  }])), null);
});

test("CC Switch Kimi provider output becomes a Kimi balance config", () => {
  const config = parseCCSwitchKimiProviderOutput(JSON.stringify([{
    id: "kimi-id",
    name: "Kimi",
    app_type: "claude-desktop",
    api_key: "ccswitch-kimi-secret",
    base_url: "https://api.moonshot.cn/anthropic",
  }]));

  assert.deepEqual(config, {
    id: "ccswitch-kimi",
    provider: "kimi",
    api_key: "ccswitch-kimi-secret",
    label: "Kimi API",
    target: "Kimi",
    base_url: "https://api.moonshot.cn",
  });
});

test("CC Switch Kimi provider output requires a Kimi app and token", () => {
  assert.equal(parseCCSwitchKimiProviderOutput(JSON.stringify([{
    name: "DeepSeek",
    app_type: "claude",
    api_key: "secret",
    base_url: "https://api.deepseek.com",
  }])), null);
  assert.equal(parseCCSwitchKimiProviderOutput(JSON.stringify([{
    name: "Kimi",
    app_type: "codex",
    api_key: "secret",
    base_url: "https://api.moonshot.ai",
  }])), null);
  assert.equal(parseCCSwitchKimiProviderOutput(JSON.stringify([{
    name: "Kimi",
    app_type: "claude-desktop",
    api_key: "",
    base_url: "https://api.moonshot.ai",
  }])), null);
});

test("CC Switch provider output requires a usable auth token", () => {
  assert.equal(parseCCSwitchProviderOutput(JSON.stringify([{
    id: "deepseek-id",
    name: "DeepSeek",
    app_type: "claude",
    api_key: "",
    base_url: "https://api.deepseek.com/anthropic",
  }])), null);
  assert.equal(parseCCSwitchProviderOutput("not json"), null);
});

test("missing CC Switch database is an optional source", async () => {
  assert.equal(await readCCSwitchDeepSeekConfig("/definitely/missing/sessionbar-home"), null);
  assert.equal(await readCCSwitchKimiConfig("/definitely/missing/sessionbar-home"), null);
});

test("DeepSeek poll labels the official API as the metric source", async () => {
  const config = parseCCSwitchProviderOutput(JSON.stringify([{
    name: "DeepSeek",
    app_type: "claude",
    api_key: "ccswitch-secret",
    base_url: "https://api.deepseek.com/anthropic",
  }]));
  assert.ok(config);
  const result = await pollProvider(config, async () => new Response(JSON.stringify({
    is_available: true,
    balance_infos: [{ currency: "CNY", total_balance: "298.87" }],
  })));
  assert.equal(result.signals[0].label, "DeepSeek API CNY");
});

test("Kimi poll labels the official API as the metric source", async () => {
  const config = parseCCSwitchKimiProviderOutput(JSON.stringify([{
    name: "Kimi",
    app_type: "claude-desktop",
    api_key: "ccswitch-kimi-secret",
    base_url: "https://api.moonshot.cn/anthropic",
  }]));
  assert.ok(config);
  const result = await pollProvider(config, async (url, init) => {
    assert.equal(String(url), "https://api.moonshot.cn/v1/users/me/balance");
    assert.equal(init.headers.Authorization, "Bearer ccswitch-kimi-secret");
    return new Response(JSON.stringify({
      code: 0,
      data: { available_balance: 42.5 },
      status: true,
    }));
  });
  assert.equal(result.signals[0].label, "Kimi API");
  assert.equal(result.signals[0].unit, "CNY");
});
