import assert from "node:assert/strict";
import test from "node:test";
import {
  countSessions,
  createWebSystemMonitor,
  escapeHtml,
  projectIconListMarkup,
  providerTableMarkup,
  statusDotMarkup,
  statusSummaryMarkup,
  systemEfficiencyMarkup,
} from "../dist/webComponents.js";
import { isSystemEfficiencySnapshot } from "../dist/types.js";

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

function systemSnapshot(cpuPercent, sampledAt = 10_000) {
  return {
    cpu_percent: cpuPercent,
    load_average: [3.19, 3.9, 3.44],
    memory_used_bytes: 12.8 * GIB,
    memory_total_bytes: 16 * GIB,
    memory_percent: 80,
    network_down_bytes_per_second: 80_000,
    network_up_bytes_per_second: 10_000,
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

test("renders provider loading, empty, and error states", () => {
  assert.match(providerTableMarkup([], { loading: true }), /Loading provider quota/);
  assert.match(providerTableMarkup([]), /No quota data/);
  assert.match(providerTableMarkup([], { error: "request failed <now>" }), /request failed &lt;now&gt;/);
  assert.match(providerTableMarkup([], { error: "request failed" }), /data-providers-retry/);
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
    server_cpu_percent: 1.8,
    server_memory_bytes: 79 * 1024 ** 2,
    sampled_at: 10_000,
  }, 12_000);

  assert.match(html, /System/);
  assert.match(html, /CPU/);
  assert.match(html, /Memory/);
  assert.match(html, /Network/);
  assert.match(html, /SessionBar/);
  assert.match(html, /Sample/);
  assert.match(html, /2s ago/);
  assert.match(html, /37\.5%/);
  assert.match(html, /12\.8 GB.*16 GB.*80\.0%/);
  assert.match(html, /80\.0 KB\/s.*10\.0 KB\/s/);
  assert.equal((html.match(/<meter/g) || []).length, 4);
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
  assert.equal(isSystemEfficiencySnapshot({ ...systemSnapshot(37.5), load_average: "3.19" }), false);
  assert.equal(isSystemEfficiencySnapshot({ ...systemSnapshot(37.5), load_average: [3.19, "3.9", 3.44] }), false);
  assert.equal(isSystemEfficiencySnapshot({ ...systemSnapshot(37.5), memory_total_bytes: undefined }), false);
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
