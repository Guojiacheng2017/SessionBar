import assert from "node:assert/strict";
import test from "node:test";
import { monitorBodyLayout, providerSummaryLine, providerTableContent } from "../dist/openTuiMonitor.js";

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

function subscriptionRow(overrides = {}) {
  return {
    form: "subscription",
    provider: "anthropic",
    label: "Anthropic 订阅 (5h)",
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
  assert.match(line, /订阅/);
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

test("provider table shows 无额度数据 when there are no rows", () => {
  const renderer = { width: 120, height: 40 };
  const content = providerTableContent([], renderer);
  assert.equal(content.length, 1);
  assert.equal(content[0][0][0].text, "无额度数据");
});

test("provider table renders one row per PlanRow", () => {
  const renderer = { width: 120, height: 40 };
  const rows = [subscriptionRow(), apiRow()];
  const content = providerTableContent(rows, renderer);
  assert.equal(content.length, 2);
  assert.match(content[0][0][0].text, /订阅/);
  assert.match(content[1][0][0].text, /API/);
});

