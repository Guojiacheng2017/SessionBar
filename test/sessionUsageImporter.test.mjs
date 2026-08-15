import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decorateProviderUsageFromSessions,
  parseSessionUsageLine,
  syncSessionUsage,
} from "../dist/sessions/sessionUsageImporter.js";

test("parses Codex last-token usage without recounting cumulative totals", () => {
  const cursor = { offset: 0 };
  parseSessionUsageLine(JSON.stringify({ type: "session_meta", payload: { model_provider: "openai" } }), "codex", cursor);
  const event = parseSessionUsageLine(JSON.stringify({
    timestamp: "2026-08-14T01:00:00Z",
    type: "event_msg",
    payload: { type: "token_count", info: { last_token_usage: { total_tokens: 123 } } },
  }), "codex", cursor);
  assert.equal(event.provider, "openai");
  assert.equal(event.tokens, 123);
});

test("parses Claude usage by model provider and permits message-id deduplication", () => {
  const cursor = { offset: 0, seen: [] };
  const line = JSON.stringify({
    timestamp: "2026-08-14T02:00:00Z",
    type: "assistant",
    message: { id: "msg-1", model: "deepseek-v4", usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 5 } },
  });
  const event = parseSessionUsageLine(line, "claude", cursor);
  assert.deepEqual({ provider: event.provider, tokens: event.tokens, eventId: event.eventId }, { provider: "deepseek", tokens: 17, eventId: "msg-1" });
  cursor.seen.push(event.eventId);
  assert.equal(parseSessionUsageLine(line, "claude", cursor), undefined);
});

test("initial scan imports history and later scans consume only appended lines", () => {
  const root = mkdtempSync(join(tmpdir(), "sessionbar-usage-"));
  const codex = join(root, "codex");
  const claude = join(root, "claude");
  mkdirSync(codex); mkdirSync(claude);
  const log = join(codex, "session.jsonl");
  const meta = JSON.stringify({ type: "session_meta", payload: { model_provider: "openai" } });
  const usage = tokens => JSON.stringify({ timestamp: "2026-08-14T03:00:00Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { total_tokens: tokens } } } });
  writeFileSync(log, `${meta}\n${usage(20)}\n`);
  const options = { statePath: join(root, "state.json"), codexDir: codex, claudeDir: claude, now: Date.parse("2026-08-14T12:00:00Z") };
  let state = syncSessionUsage(options);
  assert.equal(state.daily.openai["2026-08-14"], 20);
  state = syncSessionUsage(options);
  assert.equal(state.daily.openai["2026-08-14"], 20);
  appendFileSync(log, `${usage(7)}\n`);
  state = syncSessionUsage(options);
  assert.equal(state.daily.openai["2026-08-14"], 27);
});

test("local session totals do not replace OpenAI official usage history", () => {
  const officialTrend = { kind: "bars", days: 7, points: [null, null, null, null, null, 4_000_000, 7_000_000], unit: "tokens" };
  const row = { provider: "openai", label: "OpenAI Subscription", usageTrend: officialTrend };
  const [decorated] = decorateProviderUsageFromSessions([row], { files: {}, daily: { openai: { "2026-08-14": 42 } } }, Date.parse("2026-08-14T12:00:00Z"));
  assert.deepEqual(decorated.usageTrend, officialTrend);
});

test("local Kimi token totals replace its balance placeholder", () => {
  const row = { provider: "kimi", label: "Kimi API", usageTrend: { kind: "bars", days: 7, points: Array(7).fill(null), unit: "tokens" } };
  const [decorated] = decorateProviderUsageFromSessions([row], { files: {}, daily: { kimi: { "2026-08-14": 42 } } }, Date.parse("2026-08-14T12:00:00Z"));
  assert.equal(decorated.usageTrend.unit, "tokens");
  assert.equal(decorated.usageTrend.points.at(-1), 42);
});

test("local token samples take priority over Kimi monetary fallback", () => {
  const row = { form: "api", provider: "kimi", label: "Kimi API", unit: "CNY", usageTrend: { kind: "bars", days: 7, points: [null, null, null, null, null, null, 4.2], unit: "CNY" } };
  const [decorated] = decorateProviderUsageFromSessions([row], { files: {}, daily: { kimi: { "2026-08-14": 42 } } }, Date.parse("2026-08-14T12:00:00Z"));
  assert.equal(decorated.usageTrend.unit, "tokens");
  assert.equal(decorated.usageTrend.points.at(-1), 42);
});
