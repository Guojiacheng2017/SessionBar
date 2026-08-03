import assert from "node:assert/strict";
import test from "node:test";
import { monitorBodyLayout } from "../dist/openTuiMonitor.js";

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
