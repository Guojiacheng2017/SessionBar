import assert from "node:assert/strict";
import test from "node:test";
import {
  parseCCSwitchProviderOutput,
  readCCSwitchDeepSeekConfig,
} from "../dist/ccSwitchAdapter.js";
import { pollProvider } from "../dist/providerAdapters.js";

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
    label: "DeepSeek API (CC Switch)",
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
});

test("DeepSeek poll keeps the CC Switch source label", async () => {
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
  assert.equal(result.signals[0].label, "DeepSeek API (CC Switch) CNY");
});
