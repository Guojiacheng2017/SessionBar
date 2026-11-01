import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  codexDailyQuota,
  decorateProviderUsageFromSessions,
  parseSessionUsageLine,
  syncSessionUsage,
  loadSessionUsageState,
} from "../dist/sessions/sessionUsageImporter.js";

// Quota-only excerpts from the Sep 11 logs; no conversation or credentials.
const recordedQuota = [
  ["2026-09-11T02:13:53.358Z", 92, 1789437788],
  ["2026-09-11T02:28:15.420Z", 93, 1789437788],
  ["2026-09-11T07:39:10.152Z", 99, 1789437788],
  ["2026-09-11T07:42:34.214Z", 100, 1789437788],
  ["2026-09-11T08:07:15.742Z", 0, 1789718831],
  ["2026-09-11T08:10:01.382Z", 1, 1789718831],
  ["2026-09-11T09:35:16.677Z", 5, 1789718831],
  ["2026-09-11T09:35:18.825Z", 4, 1789718830],
  ["2026-09-11T09:35:24.215Z", 5, 1789718831],
  ["2026-09-11T15:47:03.027Z", 6, 1789718830],
];
function quotaLine([timestamp, used, expiry]) {
  return JSON.stringify({timestamp, type: "event_msg", payload: {
    type: "token_count", rate_limits: {limit_id: "codex",
      primary: {used_percent: used, window_minutes: 10080, resets_at: expiry}},
  }}) + "\n";
}
function importerFixture(now) {
  const root = mkdtempSync(join(tmpdir(), "quota-regression-"));
  const codexDir = join(root, "codex");
  const claudeDir = join(root, "claude");
  mkdirSync(codexDir); mkdirSync(claudeDir);
  return {statePath: join(root, "state.json"), codexDir, claudeDir, now};
}

test("real quota logs progress from 13 to 14 through incremental reads and disk reload", () => {
  const options = importerFixture(Date.parse("2026-09-11T15:59:00Z"));
  const file = join(options.codexDir, "a.jsonl");
  writeFileSync(file, recordedQuota.slice(0, -1).map(quotaLine).join(""));
  let state = syncSessionUsage(options);
  assert.equal(codexDailyQuota(state, options.now).at(-1), 13);
  const finalLine = quotaLine(recordedQuota.at(-1));
  appendFileSync(file, finalLine.slice(0, -1));
  state = syncSessionUsage(options);
  assert.equal(codexDailyQuota(state, options.now).at(-1), 13, "incomplete JSONL must wait");
  appendFileSync(file, "\n");
  state = syncSessionUsage(options);
  assert.equal(codexDailyQuota(state, options.now).at(-1), 14);
  assert.deepEqual(loadSessionUsageState(options.statePath), state);
  assert.deepEqual(syncSessionUsage(options), state, "restart must not recount");
  writeFileSync(join(options.codexDir, "duplicate.jsonl"), recordedQuota.map(quotaLine).join(""));
  assert.equal(codexDailyQuota(syncSessionUsage(options), options.now).at(-1), 14);
});

test("a partial first window and a later partial window never imply an unseen zero", () => {
  const at = new Date(2026, 8, 12, 12).getTime();
  const quota = [6, 26, 0, 6].map((used, index) => ({
    at: at + index * 60000, used, endsAt: at + (index < 2 ? 3 : 7) * 86400000,
  }));
  assert.equal(codexDailyQuota({files: {a: {offset: 0, quota}}, daily: {}}, at).at(-1), 26);
});

test("cross-day usage uses the previous observation without moving earlier consumption", () => {
  const at = new Date(2026, 8, 12, 0).getTime();
  const quota = [
    {at: at - 120000, used: 10, endsAt: at + 3*86400000},
    {at: at - 60000, used: 20, endsAt: at + 3*86400000},
    {at: at + 60000, used: 25, endsAt: at + 3*86400000},
    {at: at + 120000, used: 0, endsAt: at + 7*86400000},
    {at: at + 180000, used: 3, endsAt: at + 7*86400000},
  ];
  assert.deepEqual(codexDailyQuota({files: {a: {offset: 0, quota}}, daily: {}}, at).slice(-2), [10, 8]);
});

test("invalid quota expiry cannot create a synthetic window", () => {
  const now = Date.parse("2026-09-11T12:00:00Z");
  for (const expiry of [null, "", false, 0, -1, "1789718831"]) {
    const options = importerFixture(now);
    writeFileSync(join(options.codexDir, "a.jsonl"),
      quotaLine(["2026-09-11T10:00:00Z", 90, expiry]));
    assert.ok(codexDailyQuota(syncSessionUsage(options), now).every(value => value === null),
      "invalid expiry: " + JSON.stringify(expiry));
  }
});

test("account quota observations retain both portions of a day and ignore repeated stale reports", () => {
  const at = new Date(2026, 8, 11, 10).getTime();
  const observation = (minute, used, endsAt) => ({at: at + minute * 60000, used, endsAt});
  const state = { daily: {}, files: {
    a: {offset: 0, quota: [
      observation(0, 92, at + 3*86400000), observation(1, 100, at + 3*86400000),
      observation(2, 0, at + 7*86400000), observation(3, 5, at + 7*86400000),
      observation(5, 6, at + 7*86400000),
    ]},
    b: {offset: 0, quota: [
      observation(4, 4, at + 7*86400000 + 1000),
      observation(4.5, 5, at + 7*86400000 + 1000),
    ]},
  }};
  assert.equal(codexDailyQuota(state, at).at(-1), 14);
  const [row] = decorateProviderUsageFromSessions([{
    provider: "openai", form: "subscription", unit: "%",
  }], state, at);
  assert.equal(row.usageTrends.percentage.points.at(-1), 14);
});

test("expiry drift across session logs does not split one weekly quota window", () => {
  const at = new Date(2026, 9, 13, 9).getTime();
  const expiry = at + 5 * 86400000;
  const state = { daily: {}, files: {
    a: {offset: 0, quota: [
      {at, used: 6, endsAt: expiry},
      {at: at + 60_000, used: 65, endsAt: expiry + 55_000},
    ]},
    b: {offset: 0, quota: [
      {at: at + 120_000, used: 49, endsAt: expiry + 83_000},
    ]},
  }};

  assert.equal(codexDailyQuota(state, at).at(-1), 59);
});

test("expiry drift across an hour boundary keeps one weekly quota window", () => {
  const at = new Date(2026, 9, 13, 9).getTime();
  const expiry = new Date(2026, 9, 18, 11, 59, 40).getTime();
  const quota = [
    {at, used: 20, endsAt: expiry},
    {at: at + 60_000, used: 30, endsAt: expiry + 40_000},
  ];

  assert.equal(codexDailyQuota({files: {a: {offset: 0, quota}}, daily: {}}, at).at(-1), 10);
});

test("expiry drift across the half-hour rounding boundary keeps one window", () => {
  const at = new Date(2026, 9, 13, 9).getTime();
  const expiry = new Date(2026, 9, 18, 11, 29, 40).getTime();
  const quota = [
    { at, used: 20, endsAt: expiry },
    { at: at + 60_000, used: 30, endsAt: expiry + 40_000 },
  ];
  assert.equal(codexDailyQuota({ files: { a: { offset: 0, quota } }, daily: {} }, at).at(-1), 10);
});

test("a new expiry with only a partial reading does not fabricate an unseen zero", () => {
  const at = new Date(2026, 8, 12, 10).getTime();
  const quota = [
    { at, used: 6, endsAt: at + 3 * 86400000 },
    { at: at + 60_000, used: 26, endsAt: at + 3 * 86400000 },
    { at: at + 120_000, used: 10, endsAt: at + 7 * 86400000 },
    { at: at + 180_000, used: 14, endsAt: at + 7 * 86400000 },
  ];
  assert.equal(codexDailyQuota({ files: { a: { offset: 0, quota } }, daily: {} }, at).at(-1), 24);
});

test("ambiguous native counter decreases stay unknown rather than freezing later days at zero", () => {
  const at = new Date(2026, 9, 30, 10).getTime();
  const day = 86400000;
  const endsAt = at + 5 * day;
  const quota = [
    { at, used: 75, endsAt },
    { at: at + 60_000, used: 81, endsAt },
    { at: at + 120_000, used: 40, endsAt },
    { at: at + 180_000, used: 62, endsAt },
    { at: at + day, used: 66, endsAt },
  ];
  assert.deepEqual(codexDailyQuota({ files: { a: { offset: 0, quota } }, daily: {} }, at + day).slice(-2), [null, null]);
});

test("cross-file counter decreases cannot freeze a later day at a known zero", () => {
  const at = new Date(2026, 9, 30, 10).getTime();
  const day = 86_400_000;
  const endsAt = at + 5 * day;
  const state = { daily: {}, files: {
    a: { offset: 0, quota: [
      { at, used: 75, endsAt }, { at: at + 60_000, used: 81, endsAt },
    ] },
    b: { offset: 0, quota: [
      { at: at + day, used: 40, endsAt }, { at: at + day + 60_000, used: 62, endsAt },
    ] },
    c: { offset: 0, quota: [
      { at: at + 2 * day, used: 0, endsAt: endsAt + 7 * day },
      { at: at + 2 * day + 60_000, used: 5, endsAt: endsAt + 7 * day },
    ] },
  } };
  assert.deepEqual(codexDailyQuota(state, at + 2 * day).slice(-3), [6, null, 5]);
});

test("a growing counter in another file below an earlier peak is ambiguous even on the same day", () => {
  const at = new Date(2026, 9, 30, 10).getTime();
  const endsAt = at + 5 * 86_400_000;
  const state = { daily: {}, files: {
    a: { offset: 0, quota: [
      { at, used: 75, endsAt }, { at: at + 60_000, used: 81, endsAt },
    ] },
    b: { offset: 0, quota: [
      { at: at + 120_000, used: 40, endsAt }, { at: at + 180_000, used: 62, endsAt },
    ] },
  } };
  assert.equal(codexDailyQuota(state, at).at(-1), null);
});

test("a restarted file remains ambiguous after reaching or exceeding another file's earlier peak", () => {
  const at = new Date(2026, 9, 30, 10).getTime();
  const endsAt = at + 5 * 86_400_000;
  for (const used of [81, 90]) {
    assert.equal(codexDailyQuota({ daily: {}, files: {
      a: { offset: 0, quota: [
        { at, used: 75, endsAt }, { at: at + 60_000, used: 81, endsAt },
      ] },
      b: { offset: 0, quota: [
        { at: at + 120_000, used: 40, endsAt }, { at: at + 180_000, used, endsAt },
      ] },
    } }, at).at(-1), null);
  }
});

test("a source seen before another file's peak cannot freeze its later growth at zero", () => {
  const at = new Date(2026, 9, 30, 10).getTime();
  const day = 86_400_000;
  const endsAt = at + 5 * day;
  const state = { daily: {}, files: {
    b: { offset: 0, quota: [
      { at, used: 40, endsAt }, { at: at + day, used: 62, endsAt },
    ] },
    a: { offset: 0, quota: [
      { at: at + 60_000, used: 75, endsAt }, { at: at + 120_000, used: 81, endsAt },
    ] },
  } };
  assert.deepEqual(codexDailyQuota(state, at + day).slice(-2), [41, null]);
});

test("ten quota windows accumulate without resetting the daily total", () => {
  const at = new Date(2026, 8, 11, 10).getTime();
  const quota = [];
  for (let n = 0; n < 10; n++) {
    quota.push({ at: at + n*120000, used: 0, endsAt: at + (n+1)*86400000 });
    quota.push({ at: at + n*120000+60000, used: 100, endsAt: at + (n+1)*86400000 });
  }
  assert.equal(codexDailyQuota({files: {a: {offset: 0, quota}}, daily: {}}, at).at(-1), 1000);
});

test("existing token cursors can import quota history without recounting tokens", () => {
  const root = mkdtempSync(join(tmpdir(), "sessionbar-quota-import-"));
  const codex = join(root, "codex");
  const claude = join(root, "claude");
  mkdirSync(codex); mkdirSync(claude);
  const at = new Date(2026, 8, 11, 10).getTime();
  const log = join(codex, "session.jsonl");
  const lines = [92, 100, 0, 6].map((used, n) => JSON.stringify({
    timestamp: new Date(at+n*60000).toISOString(), type: "event_msg",
    payload: {type: "token_count", info: {last_token_usage: {total_tokens: 10}},
      rate_limits: {limit_id: "codex", primary: {
        used_percent: used, window_minutes: 10080,
        resets_at: (at+(n<2?3:7)*86400000)/1000,
      }}},
  })).join("\n")+"\n";
  writeFileSync(log, lines);
  const statePath = join(root, "state.json");
  writeFileSync(statePath, JSON.stringify({files: {[log]: {offset: Buffer.byteLength(lines)}}, daily: {openai: {"2026-09-11":40}}}));
  const options = {statePath, codexDir: codex, claudeDir: claude, now: at};
  const state = syncSessionUsage(options);
  assert.equal(state.daily.openai["2026-09-11"], 40);
  assert.equal(codexDailyQuota(state, at).at(-1), 14);
  assert.deepEqual(syncSessionUsage(options), state);
});

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
  assert.equal(decorated.usageTrends.cash.unit, "CNY");
  assert.equal(decorated.usageTrends.cash.points.at(-1), 4.2);
  assert.equal(decorated.usageTrends.token.points.at(-1), 42);
});
