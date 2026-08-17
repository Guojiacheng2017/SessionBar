import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import * as webComponents from "../dist/web/webComponents.js";
import {
  countSessions,
  createWebSystemMonitor,
  escapeHtml,
  iconMarkup,
  projectIconListMarkup,
  providerTableMarkup,
  statusDotMarkup,
  statusSummaryMarkup,
  systemEfficiencyMarkup,
} from "../dist/web/webComponents.js";

const providerDailyUsageMarkup = webComponents.providerDailyUsageMarkup ?? (() => "");

const appSource = readFileSync(new URL("../src/web/app.ts", import.meta.url), "utf8");

test("web polling backs off while the page is hidden", () => {
  assert.match(appSource, /document\.hidden \? 15_000 : 2_000/);
  assert.match(appSource, /document\.hidden \? 300_000 : 60_000/);
  assert.match(appSource, /visibilitychange/);
});

test("provider usage mode is persisted and controls both provider renderers", () => {
  assert.match(appSource, /sessionbar:provider-usage-mode/);
  assert.match(appSource, /providerDailyUsageMarkup\(providers, providerUsageMode\)/);
  assert.match(appSource, /usageMode: providerUsageMode/);
  assert.match(appSource, /localStorage\.setItem\(PROVIDER_USAGE_MODE_KEY, mode\)/);
});
import { isSystemEfficiencySnapshot } from "../dist/shared/types.js";
import { UI } from "../dist/web/webComponents.js";

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

test("main workspace panels use the shared panel card treatment", () => {
  assert.match(UI.panel, /\bpanel-card\b/);
  assert.doesNotMatch(UI.panel, /shadow-\[/);
});

function systemSnapshot(cpuPercent, sampledAt = 10_000) {
  return {
    cpu_percent: cpuPercent,
    load_average: [3.19, 3.9, 3.44],
    memory_used_bytes: 12.8 * GIB,
    memory_total_bytes: 16 * GIB,
    memory_percent: 80,
    network_down_bytes_per_second: 80_000,
    network_up_bytes_per_second: 10_000,
    device_temperature_celsius: 70.6,
    battery_temperature_celsius: 30.9,
    server_cpu_percent: 1.8,
    server_memory_bytes: 79 * MIB,
    sampled_at: sampledAt,
  };
}

function deferredSystemRequests() {
  const pending = [];
  return {
    pending,
    request(signal) {
      return new Promise(resolve => pending.push({ signal, resolve }));
    },
  };
}

test("renders status counts without a global progress bar", () => {
  const html = statusSummaryMarkup({ total: 7, working: 1, blocked: 0, error: 0, idle: 6 });
  assert.match(html, /7/);
  assert.match(html, /1/);
  assert.match(html, /6/);
  assert.doesNotMatch(html, /progressbar|segments|width:/i);
});

test("omits zero status categories", () => {
  const html = statusSummaryMarkup({ total: 1, working: 0, blocked: 0, error: 0, idle: 1 });
  assert.doesNotMatch(html, /working|blocked|error/i);
  assert.match(html, /idle/);
});

test("counts unknown session states as idle for a stable summary", () => {
  assert.deepEqual(countSessions([
    { status: "working" },
    { status: "idle" },
    { status: undefined },
  ]), { total: 3, working: 1, blocked: 0, error: 0, idle: 2 });
});

test("escapes dynamic labels", () => {
  assert.equal(escapeHtml('<script>"x"</script>'), '&lt;script&gt;&quot;x&quot;&lt;/script&gt;');
});

test("renders one project icon per session without a numeric count", () => {
  const types = ["Claude Code", "Codex", "Gemini CLI", "Copilot", "Cursor"];
  const compact = projectIconListMarkup(types);
  assert.equal((compact.match(/project-icon-item/g) || []).length, types.length);
  assert.doesNotMatch(compact, /project-icon-more|>\+2</);
  assert.match(compact, /style="z-index:5"[^>]*title="Claude Code"/);
  assert.match(compact, /style="z-index:1"[^>]*title="Cursor"/);

  const expanded = projectIconListMarkup(types);
  assert.equal((expanded.match(/project-icon-item/g) || []).length, types.length);
  assert.doesNotMatch(expanded, /project-icon-more/);
});

test("uses green for working and blue for idle status dots", () => {
  assert.match(statusDotMarkup("working"), /bg-green/);
  assert.match(statusDotMarkup("idle"), /bg-accent/);
  assert.doesNotMatch(statusDotMarkup("working"), /bg-accent/);
  assert.doesNotMatch(statusDotMarkup("idle"), /bg-green/);
});

test("renders provider subscription and API rows with semantic columns", () => {
  const html = providerTableMarkup([
    {
      form: "subscription",
      provider: "anthropic",
      label: "Claude · 5h",
      level: "green",
      pacing: "steady",
      cardTiming: "weekly",
      autoResetIn: "in 2h",
      sustainableRate: 1,
      actualVsSustainable: null,
      projectedCapHitAt: null,
      remaining: 72,
      limit: 100,
    },
    {
      form: "api",
      provider: "openai",
      label: "Codex API",
      level: "yellow",
      pacing: "—",
      cardTiming: "",
      autoResetIn: "",
      sustainableRate: 0,
      actualVsSustainable: null,
      projectedCapHitAt: null,
      remaining: 18,
      unit: "USD",
    },
  ]);
  assert.match(html, /Provider/);
  assert.match(html, /Claude · 5h/);
  assert.match(html, /Subscription/);
  assert.match(html, /Codex API/);
  assert.match(html, /API/);
  assert.match(html, /72%/);
  assert.match(html, /18 USD left/);
  assert.match(html, /Healthy/);
});

test("renders provider names with the shared session icon renderer", () => {
  const iconCache = new Map();
  const base = {
    form: "subscription",
    level: "green",
    pacing: "",
    cardTiming: "",
    autoResetIn: "",
    sustainableRate: 0,
    actualVsSustainable: null,
    projectedCapHitAt: null,
  };
  const html = providerTableMarkup([
    { ...base, provider: "anthropic", label: "Claude Subscription" },
    { ...base, provider: "openai", label: "OpenAI Subscription" },
    { ...base, provider: "github", label: "GitHub Copilot Pro" },
  ], { iconCache });

  assert.equal((html.match(/provider-icon/g) || []).length, 3);
  assert.match(html, /alt="Claude Code"/);
  assert.match(html, /alt="Codex"/);
  assert.match(html, /alt="Copilot"/);
  assert.deepEqual([...iconCache.keys()], ["Claude Code", "Codex", "Copilot"]);
});

test("renders the bundled WorkBuddy Desktop icon", () => {
  const html = iconMarkup("WorkBuddy Desktop");
  assert.match(html, /provider-icons\/workbuddy\.svg/);
});

test("distinguishes Claude Desktop from Claude Code with a monitor badge", () => {
  const desktop = iconMarkup("Claude Desktop");
  const cli = iconMarkup("Claude Code");
  assert.match(desktop, /claude-color\.png/);
  assert.match(desktop, /agent-icon-badge--desktop/);
  assert.doesNotMatch(cli, /agent-icon-badge/);
});

test("renders live AI credit usage for a subscription row", () => {
  const html = providerTableMarkup([{
    form: "subscription",
    provider: "github",
    label: "GitHub Copilot Pro+",
    level: "green",
    pacing: "",
    cardTiming: "",
    autoResetIn: "in 21d",
    sustainableRate: 0,
    actualVsSustainable: null,
    projectedCapHitAt: null,
    used: 2325,
    remaining: 4674.5,
    limit: 7000,
    unit: "AI credits",
  }]);
  assert.match(html, /2\.3K\/7K AI credits/);
});

test("renders Usage between Level and Reset with seven unlabeled daily bars", () => {
  const html = providerTableMarkup([{
    form: "api",
    provider: "deepseek",
    label: "DeepSeek API CNY",
    level: "green",
    pacing: "",
    cardTiming: "",
    autoResetIn: "",
    sustainableRate: 0,
    actualVsSustainable: null,
    projectedCapHitAt: null,
    remaining: 257,
    unit: "CNY",
    usageTrend: {
      kind: "bars",
      days: 7,
      points: [1, 3, 2, 4, 0, null, 5],
      labels: ["Aug 8", "Aug 9", "Aug 10", "Aug 11", "Aug 12", "Aug 13", "Aug 14"],
      unit: "CNY",
    },
  }]);
  assert.match(html, />DeepSeek API</);
  assert.doesNotMatch(html, />DeepSeek API CNY</);
  assert.match(html, /Level<\/span><span role="columnheader">Usage<\/span><span role="columnheader">Reset/);
  assert.equal((html.match(/provider-usage-bar\b/g) || []).length, 7);
  assert.doesNotMatch(html, />\s*(?:1|2|3|4|5)\s*</);
  assert.match(html, /data-tooltip="Aug 14 · 5\.00 CNY"/);
  assert.match(html, /tabindex="0"/);
  assert.match(html, /aria-label="Aug 13 · No data"/);
});

test("formats monetary usage tooltips without floating-point tails", () => {
  const html = providerTableMarkup([{
    form: "api",
    provider: "kimi",
    label: "Kimi API CN",
    level: "green",
    pacing: "",
    cardTiming: "",
    autoResetIn: "",
    sustainableRate: 0,
    actualVsSustainable: null,
    projectedCapHitAt: null,
    remaining: 122.08951,
    unit: "CNY",
    usageTrend: {
      kind: "bars",
      days: 7,
      points: [null, null, null, null, null, null, 21.67542999999999],
      labels: ["Aug 8", "Aug 9", "Aug 10", "Aug 11", "Aug 12", "Aug 13", "Aug 14"],
      unit: "CNY",
    },
  }]);

  assert.match(html, /data-tooltip="Aug 14 · 21\.68 CNY"/);
  assert.doesNotMatch(html, /21\.67542999999999/);
});

test("renders Copilot usage as a line and missing data as a quiet placeholder", () => {
  const base = {
    form: "subscription",
    level: "green",
    pacing: "",
    cardTiming: "",
    autoResetIn: "",
    sustainableRate: 0,
    actualVsSustainable: null,
    projectedCapHitAt: null,
  };
  const html = providerTableMarkup([
    {
      ...base,
      provider: "github",
      label: "GitHub Copilot Pro",
      usageTrend: { kind: "line", days: 30, points: Array.from({ length: 30 }, (_, index) => index), unit: "AI credits" },
    },
    { ...base, form: "api", provider: "kimi", label: "Kimi API", usageTrend: { kind: "bars", days: 7, points: Array(7).fill(null) } },
  ]);
  assert.match(html, /provider-usage-line/);
  assert.match(html, /<polyline/);
  assert.match(html, /provider-usage-empty/);
});

test("renders provider loading, empty, and error states", () => {
  assert.match(providerTableMarkup([], { loading: true }), /Loading provider quota/);
  assert.match(providerTableMarkup([]), /No quota data/);
  assert.match(providerTableMarkup([], { error: "request failed <now>" }), /request failed &lt;now&gt;/);
  assert.match(providerTableMarkup([], { error: "request failed" }), /data-providers-retry/);
});

test("renders one deduplicated overall daily usage line grouped by unit", () => {
  const today = "2026-08-17";
  const yesterday = "2026-08-16";
  const trend = (points, unit, kind = "bars") => ({ kind, days: kind === "line" ? 30 : 7, points, labels: kind === "line" ? [yesterday, today] : [today], unit });
  const rows = [
    { provider: "openai", label: "OpenAI 5h", usageTrend: trend([1_000_000], "tokens") },
    { provider: "openai", label: "OpenAI weekly", usageTrend: trend([1_000_000], "tokens") },
    { provider: "kimi", label: "Kimi API", usageTrend: trend([200_000], "tokens") },
    { provider: "github", label: "Copilot", usageTrend: trend([100, 125], "AI credits", "line") },
    { provider: "workbuddy", label: "WorkBuddy", usageTrend: trend([5], "credits") },
    { provider: "deepseek", label: "DeepSeek", usageTrend: trend([8.42], "CNY") },
    { provider: "moonshot", label: "Moonshot", usageTrend: trend([1.06], "USD") },
    { provider: "custom", label: "Custom", usageTrend: trend([12], "requests") },
  ];

  const html = providerDailyUsageMarkup(rows, "token");
  assert.match(html, /Today/);
  assert.match(html, /1\.2M tokens/);
  assert.match(html, /125 AI credits/);
  assert.match(html, /5 credits/);
  assert.match(html, /¥8\.42 CNY/);
  assert.match(html, /\$1\.06 USD/);
  assert.match(html, /12 requests/);
  assert.equal((html.match(/daily-usage-plus/g) || []).length, 5);
});

test("provider metric mode switches the entire provider usage presentation", () => {
  const token = { kind: "bars", days: 7, points: [null, null, null, null, null, null, 125_000], unit: "tokens", source: "CC Switch" };
  const cash = { kind: "bars", days: 7, points: [null, null, null, null, null, null, 4.25], unit: "CNY" };
  const row = {
    form: "api",
    provider: "deepseek",
    label: "DeepSeek API",
    level: "green",
    pacing: "",
    cardTiming: "",
    autoResetIn: "",
    sustainableRate: 0,
    actualVsSustainable: null,
    projectedCapHitAt: null,
    remaining: 247.1,
    unit: "CNY",
    usageTrend: token,
    usageTrends: { token, cash },
  };

  const tokenTable = providerTableMarkup([row], { usageMode: "token" });
  const cashTable = providerTableMarkup([row], { usageMode: "cash" });
  assert.match(tokenTable, /125K tokens/);
  assert.match(tokenTable, /CC Switch/);
  assert.doesNotMatch(tokenTable, /4\.25 CNY/);
  assert.match(cashTable, /4\.25 CNY/);
  assert.doesNotMatch(cashTable, /CC Switch/);
  assert.doesNotMatch(cashTable, /125K tokens/);
  assert.match(tokenTable, /247\.1 CNY left/);
  assert.match(cashTable, /247\.1 CNY left/);

  assert.match(providerDailyUsageMarkup([row], "token"), /125K tokens/);
  assert.doesNotMatch(providerDailyUsageMarkup([row], "token"), /4\.25 CNY/);
  assert.match(providerDailyUsageMarkup([row], "cash"), /¥4\.25 CNY/);
  assert.doesNotMatch(providerDailyUsageMarkup([row], "cash"), /125K tokens/);
});

test("provider metric mode keeps native-only credit metrics visible", () => {
  const credits = { kind: "line", days: 30, points: [10, 12], unit: "AI credits" };
  const row = { provider: "github", label: "Copilot", usageTrend: credits };
  assert.match(providerDailyUsageMarkup([row], "token"), /12 AI credits/);
  assert.match(providerDailyUsageMarkup([row], "cash"), /12 AI credits/);
});

test("percentage mode keeps cash metrics and shows token or credit providers as percentages", () => {
  const token = { kind: "bars", days: 7, points: [1_000_000], unit: "tokens" };
  const percentage = { kind: "bars", days: 7, points: [53], unit: "%" };
  const cash = { kind: "bars", days: 7, points: [4.25], unit: "CNY" };
  const base = {
    form: "subscription",
    level: "green",
    pacing: "",
    cardTiming: "",
    autoResetIn: "",
    sustainableRate: 0,
    actualVsSustainable: null,
    projectedCapHitAt: null,
  };
  const rows = [
    { ...base, provider: "openai", label: "OpenAI Subscription", usageTrend: token, usageTrends: { token, percentage } },
    { ...base, form: "api", provider: "deepseek", label: "DeepSeek API", usageTrend: cash, usageTrends: { cash } },
  ];

  const table = providerTableMarkup(rows, { usageMode: "percentage" });
  assert.match(table, /53%/);
  assert.match(table, /--usage-height:53%/);
  assert.match(table, /4\.25 CNY/);
  assert.doesNotMatch(table, /1M tokens/);

  const summary = providerDailyUsageMarkup(rows, "percentage");
  assert.match(summary, /Current/);
  assert.match(summary, /OpenAI 53%/);
  assert.match(summary, /¥4\.25 CNY/);
  assert.doesNotMatch(summary, /57\.25%/);
});

test("renders a quiet daily usage fallback when today has no data", () => {
  const html = providerDailyUsageMarkup([{
    provider: "openai",
    label: "OpenAI",
    usageTrend: { kind: "bars", days: 7, points: [10, null], labels: ["2026-08-16", "2026-08-17"], unit: "tokens" },
  }], "token");
  assert.match(html, /Today/);
  assert.match(html, /No usage data yet/);
  assert.doesNotMatch(html, /10 tokens/);
});

test("renders one global system efficiency band", () => {
  const html = systemEfficiencyMarkup({
    cpu_percent: 37.5,
    load_average: [3.19, 3.9, 3.44],
    memory_used_bytes: 12.8 * 1024 ** 3,
    memory_total_bytes: 16 * 1024 ** 3,
    memory_percent: 80,
    network_down_bytes_per_second: 80_000,
    network_up_bytes_per_second: 10_000,
    device_temperature_celsius: 70.6,
    battery_temperature_celsius: 30.9,
    server_cpu_percent: 1.8,
    server_memory_bytes: 79 * 1024 ** 2,
    sampled_at: 10_000,
  }, 12_000);

  assert.match(html, /System/);
  assert.match(html, /CPU/);
  assert.match(html, /Memory/);
  assert.match(html, /Load Average/);
  assert.match(html, /1 min.*3\.19.*5 min.*3\.90.*15 min.*3\.44/s);
  assert.equal((html.match(/system-efficiency-load-row/g) || []).length, 3);
  assert.match(html, /Running or waiting tasks · compare with CPU cores/);
  assert.doesNotMatch(html, /system-efficiency-triple/);
  assert.match(html, /Device \/ CPU.*70\.6°C/s);
  assert.match(html, /Battery.*30\.9°C/s);
  assert.match(html, /Download.*80\.0 KB\/s/s);
  assert.match(html, /Upload.*10\.0 KB\/s/s);
  assert.doesNotMatch(html, /SessionBar/);
  assert.match(html, /Sample/);
  assert.match(html, /2s ago/);
  assert.match(html, /37\.5%/);
  assert.match(html, /80\.0%.*12\.8 GB.*16 GB/s);
  assert.equal((html.match(/<meter/g) || []).length, 2);
  assert.match(html, /system-efficiency-primary/);
  assert.match(html, /system-efficiency-secondary/);
  assert.match(html, /system-efficiency-freshness[^>]*>Sample · 2s ago/);
  assert.match(html, /system-efficiency-card is-warning/);
  assert.doesNotMatch(html, /runtime-matrix-session/);
});

test("renders an unavailable global system state without a session grid", () => {
  const html = systemEfficiencyMarkup(undefined);

  assert.match(html, /System metrics unavailable/);
  assert.match(html, /Sample/);
  assert.match(html, /Unavailable/);
  assert.doesNotMatch(html, /runtime-contributions|runtime-matrix|<meter/);
});

test("shared system snapshot validation rejects malformed successful payloads", () => {
  assert.equal(isSystemEfficiencySnapshot(systemSnapshot(37.5)), true);
  assert.equal(isSystemEfficiencySnapshot({
    ...systemSnapshot(37.5),
    device_temperature_celsius: 70.6,
    battery_temperature_celsius: 30.9,
  }), true);
  assert.equal(isSystemEfficiencySnapshot({ ...systemSnapshot(37.5), load_average: "3.19" }), false);
  assert.equal(isSystemEfficiencySnapshot({ ...systemSnapshot(37.5), load_average: [3.19, "3.9", 3.44] }), false);
  assert.equal(isSystemEfficiencySnapshot({ ...systemSnapshot(37.5), memory_total_bytes: undefined }), false);
  assert.equal(isSystemEfficiencySnapshot({ ...systemSnapshot(37.5), device_temperature_celsius: Number.NaN }), false);
  assert.equal(isSystemEfficiencySnapshot({ ...systemSnapshot(37.5), battery_temperature_celsius: Number.POSITIVE_INFINITY }), false);
});

test("system polling updates only its region and preserves the last good snapshot", async () => {
  const detailHeader = { innerHTML: "old header" };
  const detailBody = { innerHTML: "old body" };
  const sessionRegion = { innerHTML: "session rows", focused: true };
  const requests = deferredSystemRequests();
  const monitor = createWebSystemMonitor({
    detailHeader,
    detailBody,
    isVisible: () => true,
    request: signal => requests.request(signal),
  });

  monitor.render();
  assert.match(detailBody.innerHTML, /System metrics unavailable/);
  const first = monitor.refresh();
  requests.pending[0].resolve({ system: systemSnapshot(37.5) });
  assert.equal(await first, true);
  assert.match(detailBody.innerHTML, /37\.5%/);
  const lastGood = detailBody.innerHTML;

  const malformed = monitor.refresh();
  requests.pending[1].resolve({ system: { cpu_percent: 99 } });
  assert.equal(await malformed, false);
  assert.equal(detailBody.innerHTML, lastGood);
  assert.deepEqual(sessionRegion, { innerHTML: "session rows", focused: true });
  monitor.stop();
});

test("system freshness advances on its own deadline without rebuilding session UI", async () => {
  let now = 10_500;
  let scheduled;
  let scheduledDelay;
  const detailHeader = { innerHTML: "" };
  const detailBody = { innerHTML: "" };
  const sessionRegion = { innerHTML: "session rows" };
  const requests = deferredSystemRequests();
  const monitor = createWebSystemMonitor({
    detailHeader,
    detailBody,
    isVisible: () => true,
    request: signal => requests.request(signal),
    now: () => now,
    schedule(callback, delayMs) {
      scheduled = callback;
      scheduledDelay = delayMs;
      return 1;
    },
    cancelSchedule() {},
  });

  const refresh = monitor.refresh();
  requests.pending[0].resolve({ system: systemSnapshot(37.5, 10_000) });
  assert.equal(await refresh, true);
  assert.match(detailBody.innerHTML, /Sample.*now/s);
  assert.equal(scheduledDelay, 500);

  now = 11_000;
  scheduled();
  assert.match(detailBody.innerHTML, /Sample.*1s ago/s);
  assert.deepEqual(sessionRegion, { innerHTML: "session rows" });
  monitor.stop();
});

test("system polling does not overwrite an active session or project detail", async () => {
  let visible = false;
  const detailHeader = { innerHTML: "Details / Session" };
  const detailBody = { innerHTML: "focused session" };
  const requests = deferredSystemRequests();
  const monitor = createWebSystemMonitor({
    detailHeader,
    detailBody,
    isVisible: () => visible,
    request: signal => requests.request(signal),
  });

  const refresh = monitor.refresh();
  requests.pending[0].resolve({ system: systemSnapshot(42) });
  assert.equal(await refresh, true);
  assert.deepEqual(
    { header: detailHeader.innerHTML, body: detailBody.innerHTML },
    { header: "Details / Session", body: "focused session" },
  );

  visible = true;
  assert.equal(monitor.render(), true);
  assert.match(detailHeader.innerHTML, /Details \/ System/);
  assert.match(detailBody.innerHTML, /42\.0%/);
  monitor.stop();
});

test("newer system responses win even when an aborted request resolves later", async () => {
  const detailHeader = { innerHTML: "" };
  const detailBody = { innerHTML: "" };
  const requests = deferredSystemRequests();
  const monitor = createWebSystemMonitor({
    detailHeader,
    detailBody,
    isVisible: () => true,
    request: signal => requests.request(signal),
  });

  const older = monitor.refresh();
  const newer = monitor.refresh();
  assert.equal(requests.pending[0].signal.aborted, true);
  requests.pending[1].resolve({ system: systemSnapshot(60, 20_000) });
  assert.equal(await newer, true);
  requests.pending[0].resolve({ system: systemSnapshot(10, 10_000) });
  assert.equal(await older, false);
  assert.match(detailBody.innerHTML, /60\.0%/);
  assert.doesNotMatch(detailBody.innerHTML, /10\.0%/);
  monitor.stop();
});

test("stopping system polling aborts in-flight work and blocks late updates", async () => {
  const detailHeader = { innerHTML: "header" };
  const detailBody = { innerHTML: "body" };
  const requests = deferredSystemRequests();
  const monitor = createWebSystemMonitor({
    detailHeader,
    detailBody,
    isVisible: () => true,
    request: signal => requests.request(signal),
  });

  const refresh = monitor.refresh();
  monitor.stop();
  assert.equal(requests.pending[0].signal.aborted, true);
  requests.pending[0].resolve({ system: systemSnapshot(99) });
  assert.equal(await refresh, false);
  assert.equal(detailBody.innerHTML, "body");
  assert.equal(await monitor.refresh(), false);
});
