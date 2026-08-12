import assert from "node:assert/strict";
import test from "node:test";
import {
  createSingleFlightRefresh,
  createVisibleModelUpdater,
  monitorBodyLayout,
  monitorVisibleModel,
  nextVisibleFreshnessDelay,
  preserveSystemSnapshot,
  providerSummaryLine,
  providerTableContent,
  runtimeOverviewText,
  systemOverviewText,
  visibleModelFingerprint,
} from "../dist/openTuiMonitor.js";

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

function systemSnapshot(overrides = {}) {
  return {
    cpu_percent: 37.5,
    load_average: [3.19, 3.9, 3.44],
    memory_used_bytes: 12.8 * GIB,
    memory_total_bytes: 16 * GIB,
    memory_percent: 80,
    network_down_bytes_per_second: 80_000,
    network_up_bytes_per_second: 10_000,
    server_cpu_percent: 1.8,
    server_memory_bytes: 79 * MIB,
    sampled_at: 10_000,
    ...overrides,
  };
}

test("monitor body layout gives the session sidebar a stable monitor width", () => {
  const layout = monitorBodyLayout(154);
  assert.equal(layout.sidebarPanelWidth, 46);
  assert.equal(layout.sidebarLineWidth, 42);
  assert.ok(layout.detailPanelWidth >= 90);
  assert.equal(layout.sidebarPanelWidth + layout.gap + layout.detailPanelWidth, layout.bodyWidth);
});

test("monitor body layout keeps narrow terminals usable", () => {
  const layout = monitorBodyLayout(80);
  assert.ok(layout.sidebarPanelWidth >= 24);
  assert.ok(layout.sidebarLineWidth >= 20);
  assert.ok(layout.detailContentWidth >= 32);
  assert.equal(layout.sidebarPanelWidth + layout.gap + layout.detailPanelWidth, layout.bodyWidth);
});

test("monitor body layout fits every panel within a 40-column renderer", () => {
  const layout = monitorBodyLayout(40);
  assert.ok(layout.bodyWidth <= 38);
  assert.ok(layout.sidebarPanelWidth > 0);
  assert.ok(layout.detailPanelWidth > 0);
  assert.equal(layout.sidebarPanelWidth + layout.gap + layout.detailPanelWidth, layout.bodyWidth);
  assert.ok(layout.detailContentWidth <= layout.detailPanelWidth - 4);
  assert.ok(systemOverviewText(systemSnapshot(), layout.detailContentWidth, 11_000)
    .split("\n").every(line => line.length <= layout.detailContentWidth));
});

test("runtime overview uses fixed-width progress bars instead of a sparkline", () => {
  const content = runtimeOverviewText([
    {
      session_id: "codex-a",
      status: "working",
      session_type: "Codex",
      task_name: "running",
      timestamp: 1,
      runtime: { cpu_percent: 50, memory_percent: 20, memory_bytes: 768 * 1024 * 1024, process_count: 2 },
    },
  ], 60);
  assert.match(content, /RUNTIME \/ ALL ACTIVE SESSIONS/);
  assert.match(content, /CPU\s+50%\s+██████████/);
  assert.match(content, /MEM\s+768 MB/);
  assert.doesNotMatch(content, /░░▒▓|sparkline/i);
});

test("system overview renders a deterministic six-row efficiency panel", () => {
  const text = systemOverviewText(systemSnapshot(), 44, 11_000);
  assert.match(text, /CPU.*37\.5%/);
  assert.match(text, /Load.*3\.19.*3\.90.*3\.44/);
  assert.match(text, /Memory.*12\.8 GB.*16 GB.*80\.0%/);
  assert.match(text, /Network.*80\.0 KB\/s.*10\.0 KB\/s/);
  assert.match(text, /SessionBar.*1\.8%.*79 MB/);
  assert.match(text, /Sample.*1s/);
  assert.equal(text.split("\n").length, 6);
  assert.ok(text.split("\n").every(line => line.length <= 44));
});

test("system overview remains six visual rows at 32 columns", () => {
  const lines = systemOverviewText(systemSnapshot(), 32, 11_000).split("\n");
  assert.equal(lines.length, 6);
  assert.ok(lines.every(line => line.length <= 32));
  assert.deepEqual(lines.map(line => line.split(/\s+/)[0]), ["CPU", "Load", "Memory", "Network", "SessionBar", "Sample"]);
});

test("visible model updater suppresses identical renders and repaints visible changes", () => {
  const renderer = {
    renders: [],
    requestRender(model) { this.renders.push(model); },
  };
  const update = createVisibleModelUpdater(model => renderer.requestRender(model));
  const base = {
    view: "sessions",
    selectedId: "session-a",
    system: systemSnapshot(),
    freshnessSecond: 1,
  };

  update(base);
  update({ ...base, system: systemSnapshot() });
  assert.equal(renderer.renders.length, 1);

  update({ ...base, selectedId: "session-b" });
  assert.equal(renderer.renders.length, 2);

  const changedSystem = { ...base, selectedId: "session-b", system: systemSnapshot({ cpu_percent: 38 }) };
  update(changedSystem);
  assert.equal(renderer.renders.length, 3);
  assert.notEqual(visibleModelFingerprint(base), visibleModelFingerprint(changedSystem));
});

function monitorState(overrides = {}) {
  const sessions = [
    { session_id: "a", session_type: "Codex", status: "working", task_name: "visible", project: "Shown", timestamp: 1_000 },
    { session_id: "b", session_type: "Claude Code", status: "idle", task_name: "hidden", project: "Hidden", timestamp: 2_000 },
  ];
  return {
    sessions,
    system: systemSnapshot({ sampled_at: 10_000 }),
    filterText: "Shown",
    filterActive: false,
    projectCursorKey: "name:Shown",
    projectFocusKey: null,
    selectedIdx: -1,
    selectedId: null,
    detailId: null,
    detailTab: "overview",
    unreadSessionIds: new Set(),
    view: "sessions",
    providers: [],
    ...overrides,
  };
}

test("monitor visible model fingerprints formatted freshness, not wall-clock seconds", () => {
  const renderer = { width: 100, height: 30 };
  const state = monitorState();
  assert.equal(
    visibleModelFingerprint(monitorVisibleModel(state, renderer, 10_100)),
    visibleModelFingerprint(monitorVisibleModel(state, renderer, 10_900)),
  );
  assert.notEqual(
    visibleModelFingerprint(monitorVisibleModel(state, renderer, 10_900)),
    visibleModelFingerprint(monitorVisibleModel(state, renderer, 11_000)),
  );
});

test("monitor visible model ignores filtered and non-painted session changes", () => {
  const renderer = { width: 100, height: 30 };
  const state = monitorState();
  const hiddenChanged = monitorState({
    sessions: [state.sessions[0], { ...state.sessions[1], task_name: "changed out of view", tokens: 999 }],
  });
  const visibleNonPaintedChanged = monitorState({
    sessions: [{ ...state.sessions[0], tokens: 999 }, state.sessions[1]],
  });
  assert.equal(
    visibleModelFingerprint(monitorVisibleModel(state, renderer, 10_100)),
    visibleModelFingerprint(monitorVisibleModel(hiddenChanged, renderer, 10_100)),
  );
  assert.equal(
    visibleModelFingerprint(monitorVisibleModel(state, renderer, 10_100)),
    visibleModelFingerprint(monitorVisibleModel(visibleNonPaintedChanged, renderer, 10_100)),
  );
});

test("monitor visible model ignores off-window and inactive-tab fields", () => {
  const renderer = { width: 100, height: 21 };
  const sessions = Array.from({ length: 8 }, (_, index) => ({
    session_id: `s-${index}`,
    session_type: "Codex",
    status: "working",
    task_name: `task-${index}`,
    project: "Shown",
    timestamp: 1_000,
  }));
  const root = monitorState({ sessions, filterText: "", projectCursorKey: "name:Shown" });
  const offWindowChanged = monitorState({
    ...root,
    sessions: sessions.map((session, index) => index === 7 ? { ...session, task_name: "off-window changed" } : session),
  });
  assert.equal(
    visibleModelFingerprint(monitorVisibleModel(root, renderer, 10_100)),
    visibleModelFingerprint(monitorVisibleModel(offWindowChanged, renderer, 10_100)),
  );

  const focused = monitorState({
    sessions,
    filterText: "",
    projectCursorKey: "name:Shown",
    projectFocusKey: "name:Shown",
    selectedIdx: 0,
    selectedId: "s-0",
    detailId: "s-0",
    detailTab: "overview",
  });
  const inactiveTabChanged = monitorState({
    ...focused,
    sessions: [{ ...sessions[0], debug_blob: "raw-only" }, ...sessions.slice(1)],
  });
  assert.equal(
    visibleModelFingerprint(monitorVisibleModel(focused, renderer, 10_100)),
    visibleModelFingerprint(monitorVisibleModel(inactiveTabChanged, renderer, 10_100)),
  );
});

test("next visible freshness update waits until formatted output changes", () => {
  const renderer = { width: 100, height: 30 };
  assert.equal(nextVisibleFreshnessDelay(monitorState(), renderer, 10_100), 900);
  assert.equal(nextVisibleFreshnessDelay(monitorState({ system: undefined }), renderer, 2_100), 8_900);
  assert.equal(nextVisibleFreshnessDelay(monitorState({ view: "providers" }), renderer, 10_100), undefined);
});

test("single-flight refresh skips overlapping poll and supersedes it for manual refresh", async () => {
  const pending = [];
  const applied = [];
  const refresh = createSingleFlightRefresh(
    () => new Promise(resolve => pending.push(resolve)),
    value => applied.push(value),
  );

  const first = refresh("poll");
  const skipped = refresh("poll");
  const manual = refresh("manual");
  assert.equal(await skipped, false);
  assert.equal(pending.length, 1);

  pending[0]("old");
  assert.equal(await first, false);
  await Promise.resolve();
  assert.equal(pending.length, 2);
  pending[1]("new");
  assert.equal(await manual, true);
  assert.deepEqual(applied, ["new"]);
});

test("missing or malformed system results preserve the last good snapshot", () => {
  const snapshot = systemSnapshot();
  assert.equal(preserveSystemSnapshot(snapshot, undefined), snapshot);
  assert.equal(preserveSystemSnapshot(snapshot, systemSnapshot({ cpu_percent: 42 })).cpu_percent, 42);
});

function subscriptionRow(overrides = {}) {
  return {
    form: "subscription",
    provider: "anthropic",
    label: "Anthropic Subscription (5h)",
    level: "green",
    pacing: "ok",
    cardTiming: "reset 3d",
    autoResetIn: "5h",
    sustainableRate: 10,
    actualVsSustainable: null,
    projectedCapHitAt: null,
    ...overrides,
  };
}

function apiRow(overrides = {}) {
  return {
    form: "api",
    provider: "openai",
    label: "OpenAI",
    level: "green",
    pacing: "",
    cardTiming: "",
    autoResetIn: "",
    sustainableRate: 0,
    actualVsSustainable: null,
    projectedCapHitAt: null,
    remaining: 1_200_000,
    used: 800_000,
    limit: 2_000_000,
    unit: "tokens",
    ...overrides,
  };
}

test("provider summary line renders subscription rows with level/pacing/card/reset", () => {
  const line = providerSummaryLine(subscriptionRow());
  assert.match(line, /Subscription/);
  assert.match(line, /level green/);
  assert.match(line, /pacing ok/);
  assert.match(line, /card reset 3d/);
  assert.match(line, /reset 5h/);
});

test("provider summary line renders api rows with remaining/used/limit/unit", () => {
  const line = providerSummaryLine(apiRow());
  assert.match(line, /API/);
  assert.match(line, /remaining 1.2M/);
  assert.match(line, /used 800K/);
  assert.match(line, /limit 2M/);
  assert.match(line, /tokens/);
});

test("provider summary and table show usage for a subscription with a live limit", () => {
  const row = subscriptionRow({
    provider: "github",
    label: "GitHub Copilot Pro+",
    used: 2325,
    remaining: 4674.5,
    limit: 7000,
    unit: "AI credits",
  });
  const line = providerSummaryLine(row);
  assert.match(line, /used 2.3K\/7K AI credits/);
  const content = providerTableContent([row], { width: 120, height: 40 });
  assert.equal(content[1][1][0].text, "2.3K\/7K AI credits");
});

test("provider table shows No quota data when there are no rows", () => {
  const renderer = { width: 120, height: 40 };
  const content = providerTableContent([], renderer);
  assert.equal(content.length, 1);
  assert.equal(content[0][0][0].text, "No quota data");
});

test("provider table shows the fetch error instead of No quota data when providersError is set", () => {
  const renderer = { width: 120, height: 40 };
  const content = providerTableContent([], renderer, "HTTP 500");
  assert.equal(content.length, 1);
  assert.equal(content[0][0][0].text, "HTTP 500");
});

test("provider table renders a header plus one row per PlanRow with columns", () => {
  const renderer = { width: 120, height: 40 };
  const rows = [subscriptionRow(), apiRow()];
  const content = providerTableContent(rows, renderer);
  assert.equal(content.length, 3); // header + 2 rows
  assert.equal(content[0][0][0].text, "Provider");
  assert.equal(content[0][1][0].text, "Left");
  assert.equal(content[0][2][0].text, "Level");
  assert.equal(content[0][3][0].text, "Reset");
  assert.equal(content[0][4][0].text, "Card");
  assert.match(content[1][0][0].text, /Anthropic Subscription/);
  assert.equal(content[1][1][0].text, "—"); // subscription row has no numeric remaining
  assert.equal(content[2][0][0].text, "OpenAI");
  assert.equal(content[2][1][0].text, "1.2M tokens left");
});

test("provider table uses compact 3-column layout on narrow terminals", () => {
  const renderer = { width: 80, height: 40 };
  const content = providerTableContent([subscriptionRow()], renderer);
  assert.equal(content.length, 2); // header + 1 row
  assert.equal(content[0].length, 3);
  assert.equal(content[0][0][0].text, "Provider");
  assert.equal(content[0][1][0].text, "Left");
  assert.equal(content[0][2][0].text, "Reset");
  assert.equal(content[1].length, 3);
});
