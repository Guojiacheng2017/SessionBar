import assert from "node:assert/strict";
import test from "node:test";
import {
  countSessions,
  escapeHtml,
  projectIconListMarkup,
  providerTableMarkup,
  runtimeContributionsMarkup,
  statusDotMarkup,
  statusSummaryMarkup,
} from "../dist/webComponents.js";

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

test("renders a runtime contributions matrix for active sessions", () => {
  const html = runtimeContributionsMarkup([
    {
      session_id: "codex-a__Vision-Dash",
      session_name: "Build dashboard",
      project: "Vision-Dash",
      status: "working",
      runtime: { cpu_percent: 30, memory_percent: 5, process_count: 2 },
    },
    {
      session_id: "claude-b__Vision-Dash",
      project: "Vision-Dash",
      status: "working",
      runtime: { cpu_percent: 10, memory_percent: 15, process_count: 1 },
    },
  ]);
  assert.match(html, /runtime-contributions/);
  assert.match(html, /Build dashboard/);
  assert.match(html, /CPU/);
  assert.match(html, /MEM/);
  assert.match(html, /75%/);
  assert.match(html, /25%/);
  assert.match(html, /Waiting for runtime samples|sampled/);
});
