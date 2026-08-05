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
  assert.equal(content[0][1][0].text, "Form");
  assert.equal(content[0][2][0].text, "Left");
  assert.match(content[1][0][0].text, /Anthropic Subscription/);
  assert.equal(content[1][1][0].text, "Subscription");
  assert.equal(content[1][2][0].text, "—"); // subscription row has no numeric remaining
  assert.equal(content[2][0][0].text, "OpenAI");
  assert.equal(content[2][1][0].text, "API");
  assert.equal(content[2][2][0].text, "1.2M tokens left");
});

test("provider table uses compact 4-column layout on narrow terminals", () => {
  const renderer = { width: 80, height: 40 };
  const content = providerTableContent([subscriptionRow()], renderer);
  assert.equal(content.length, 2); // header + 1 row
  assert.equal(content[0].length, 4);
  assert.equal(content[0][0][0].text, "Provider");
  assert.equal(content[0][1][0].text, "Form");
  assert.equal(content[0][2][0].text, "Left");
  assert.equal(content[0][3][0].text, "Reset");
  assert.equal(content[1].length, 4);
});

