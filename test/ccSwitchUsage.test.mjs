import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decorateApiUsageFromCCSwitch,
  parseCCSwitchUsageOutput,
  readCCSwitchUsage,
} from "../dist/providers/ccSwitchUsage.js";

const now = Date.parse("2026-08-14T12:00:00+08:00");

test("CC Switch rows become seven local-day token totals by provider", () => {
  const usage = parseCCSwitchUsageOutput(JSON.stringify([
    { day: "2026-08-13", provider_name: "DeepSeek", model: "deepseek-chat", tokens: 120 },
    { day: "2026-08-14", provider_name: "DeepSeek", model: "deepseek-reasoner", tokens: 30 },
    { day: "2026-08-14", provider_name: "Zhipu GLM", model: "glm-4.5", tokens: 70 },
    { day: "2026-08-14", provider_name: "Kimi", model: "kimi-k2", tokens: 50 },
  ]));

  assert.deepEqual(usage.deepseek, { "2026-08-13": 120, "2026-08-14": 30 });
  assert.deepEqual(usage.glm, { "2026-08-14": 70 });
  assert.deepEqual(usage.kimi, { "2026-08-14": 50 });
});

test("CC Switch token history drives subscription usage while Copilot keeps official credits", () => {
  const empty = { kind: "bars", days: 7, points: Array(7).fill(null), unit: "tokens" };
  const official = { kind: "bars", days: 7, points: [1, 2, 3, 4, 5, 6, 7], unit: "%" };
  const rows = [
    { form: "api", provider: "deepseek", label: "DeepSeek API", usageTrend: empty },
    { form: "api", provider: "zhipu", label: "GLM API", usageTrend: empty },
    { form: "subscription", provider: "openai", label: "OpenAI Subscription", usageTrend: official },
    { form: "subscription", provider: "github", label: "GitHub Copilot Pro", usageTrend: { kind: "line", days: 30, points: [10], unit: "AI credits" } },
  ];

  const decorated = decorateApiUsageFromCCSwitch(rows, {
    deepseek: { "2026-08-13": 120, "2026-08-14": 30 },
    glm: { "2026-08-14": 70 },
    openai: { "2026-08-13": 400, "2026-08-14": 500 },
  }, now);

  assert.deepEqual(decorated[0].usageTrend.points.slice(-2), [120, 30]);
  assert.equal(decorated[0].usageTrend.unit, "tokens");
  assert.equal(decorated[0].usageTrend.source, "CC Switch");
  assert.equal(decorated[1].usageTrend.points.at(-1), 70);
  assert.deepEqual(decorated[2].usageTrend.points.slice(-2), [400, 500]);
  assert.equal(decorated[2].usageTrend.unit, "tokens");
  assert.deepEqual(decorated[3].usageTrend, { kind: "line", days: 30, points: [10], unit: "AI credits" });
});

test("CC Switch keeps monetary and token histories available together", () => {
  const cash = { kind: "bars", days: 7, points: [null, null, null, null, null, 2.5, 4.25], unit: "CNY" };
  const row = { form: "api", provider: "deepseek", label: "DeepSeek API", usageTrend: cash, usageTrends: { cash } };

  const [decorated] = decorateApiUsageFromCCSwitch([row], {
    deepseek: { "2026-08-14": 300 },
  }, now);

  assert.strictEqual(decorated.usageTrends.cash, cash);
  assert.equal(decorated.usageTrends.token.unit, "tokens");
  assert.equal(decorated.usageTrends.token.source, "CC Switch");
  assert.equal(decorated.usageTrends.token.points.at(-1), 300);
});

test("official OpenAI history uses CC Switch only for today's live total", () => {
  const official = {
    kind: "bars",
    days: 7,
    points: [null, null, null, null, null, 700, null],
    labels: ["2026-08-08", "2026-08-09", "2026-08-10", "2026-08-11", "2026-08-12", "2026-08-13", "2026-08-14"],
    unit: "tokens",
    source: "OpenAI API",
  };
  const row = {
    form: "subscription",
    provider: "openai",
    label: "OpenAI Subscription",
    usageTrend: official,
  };

  const [decorated] = decorateApiUsageFromCCSwitch([row], {
    openai: { "2026-08-13": 400, "2026-08-14": 500 },
  }, now);

  assert.deepEqual(decorated.usageTrend.points.slice(-2), [700, 500]);
  assert.equal(decorated.usageTrend.source, "OpenAI API + CC Switch today");
  assert.deepEqual(decorated.usageTrends.token, decorated.usageTrend);
});

test("API placeholder remains available for local fallback when CC Switch has no matching history", () => {
  const row = { form: "api", provider: "kimi", label: "Kimi API", usageTrend: { kind: "bars", days: 7, points: Array(7).fill(null) } };
  const [decorated] = decorateApiUsageFromCCSwitch([row], {}, now);
  assert.strictEqual(decorated, row);
});

test("reads provider proxy usage and CC Switch imported session history", async () => {
  const home = mkdtempSync(join(tmpdir(), "sessionbar-ccswitch-"));
  const dir = join(home, ".cc-switch");
  const db = join(dir, "cc-switch.db");
  mkdirSync(dir);
  execFileSync("sqlite3", [db, `
    CREATE TABLE providers (id TEXT, name TEXT, app_type TEXT, created_at INTEGER);
    CREATE TABLE proxy_request_logs (
      provider_id TEXT, app_type TEXT, model TEXT, input_tokens INTEGER,
      output_tokens INTEGER, cache_read_tokens INTEGER, cache_creation_tokens INTEGER,
      created_at INTEGER, data_source TEXT
    );
    INSERT INTO providers VALUES ('deepseek-id', 'DeepSeek', 'claude', unixepoch());
    INSERT INTO proxy_request_logs VALUES ('deepseek-id','claude','deepseek-chat',10,2,3,4,unixepoch(),'proxy');
    INSERT INTO proxy_request_logs VALUES ('_codex_session','codex','gpt-5.6',100,0,0,0,unixepoch(),'codex_session');
  `]);

  const usage = await readCCSwitchUsage(home);
  const today = new Date();
  const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  assert.deepEqual(usage, { deepseek: { [day]: 19 }, openai: { [day]: 100 } });
});
