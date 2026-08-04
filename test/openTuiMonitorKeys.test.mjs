import assert from "node:assert/strict";
import test from "node:test";
import { nextDetailTabFromMonitorKey, nextViewFromMonitorKey } from "../dist/openTuiMonitor.js";

const key = (name, sequence = name, raw = sequence) => ({ name, sequence, raw });

test("monitor scope keys map tab, brackets, and numbers to detail tabs", () => {
  assert.equal(nextDetailTabFromMonitorKey("overview", key("tab", "\t")), "activity");
  assert.equal(nextDetailTabFromMonitorKey("activity", key("]", "]")), "usage");
  assert.equal(nextDetailTabFromMonitorKey("activity", key("[", "[")), "overview");
  assert.equal(nextDetailTabFromMonitorKey("usage", key("]", "]")), "flow");
  assert.equal(nextDetailTabFromMonitorKey("overview", key("4", "4")), "flow");
  assert.equal(nextDetailTabFromMonitorKey("overview", key("5", "5")), "raw");
});

test("monitor scope keys ignore unrelated or modified keys", () => {
  assert.equal(nextDetailTabFromMonitorKey("overview", key("x", "x")), null);
  assert.equal(nextDetailTabFromMonitorKey("overview", { ...key("3", "3"), ctrl: true }), null);
});

test("monitor v/P toggles between sessions and providers views", () => {
  assert.equal(nextViewFromMonitorKey("sessions", key("v", "v")), "providers");
  assert.equal(nextViewFromMonitorKey("providers", key("v", "v")), "sessions");
  assert.equal(nextViewFromMonitorKey("sessions", key("P", "P")), "providers");
  assert.equal(nextViewFromMonitorKey("providers", key("P", "P")), "sessions");
});

test("monitor view toggle ignores unrelated or modified keys", () => {
  assert.equal(nextViewFromMonitorKey("sessions", key("x", "x")), null);
  assert.equal(nextViewFromMonitorKey("sessions", { ...key("v", "v"), ctrl: true }), null);
});

