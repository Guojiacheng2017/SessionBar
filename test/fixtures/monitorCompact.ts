import assert from "node:assert/strict";
import { mock } from "bun:test";
import * as core from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";

let activeRenderer: core.CliRenderer;
// Main owns renderer creation; replace only that factory in this fixture.
mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => activeRenderer }));
const { runOpenTuiMonitor } = await import("../../dist/tui/openTuiMonitor.js");
const sizes = [[80, 24], [48, 24], [40, 20]];
for (const [width, height] of sizes) {
  const sessions = Array.from({ length: 24 }, (_, index) => ({
    session_id: `fixture-${index}`, session_name: `Entry ${index}`, session_type: "Codex", status: "idle" as const,
    project: `Workspace_${Math.floor(index / 3)}`, task_name: `Task ${index}`, timestamp: Date.now(),
  }));
  const setup = await createTestRenderer({ width, height, useMouse: false, consoleMode: "disabled" });
  activeRenderer = setup.renderer;
  const running = runOpenTuiMonitor({
    fetchSessions: async () => ({ sessions }), fetchSystem: async () => undefined,
    fetchProviders: async () => [], openWebDashboard: async () => {},
    renderMs: 500, pollMs: 60_000, animate: false, port: 0, apiHost: "fixture.invalid", stateDir: "fixture-only",
  });
  const node = (id: string) => {
    const target = setup.renderer.root.findDescendantById(id);
    assert.ok(target, `${id} exists`);
    return target;
  };
  try {
    await setup.waitFor(() => setup.captureCharFrame().includes("Workspace_0"));
    for (let project = 0; project < 8; project++) {
      assert.ok(setup.captureCharFrame().includes(`Workspace_${project}`),
        `keyboard-selected project ${project} remains visible at ${width}x${height}`);
      if (project < 7) {
        setup.mockInput.pressArrow("down");
        await setup.flush();
      }
    }
    setup.mockInput.pressArrow("up");
    await setup.flush();
    assert.match(setup.captureCharFrame(), /Workspace_6/);
    setup.mockInput.pressArrow("down");
    setup.mockInput.pressEnter();
    await setup.flush();
    assert.equal(node("sessionbar-projects-box").visible, false);
    const details = node("sessionbar-details");
    assert.ok(details instanceof core.TextRenderable);
    assert.match(details.content.chunks.map(chunk => chunk.text).join(""), /fixture-21/);
    setup.mockInput.pressArrow("down");
    await setup.flush();
    assert.match(details.content.chunks.map(chunk => chunk.text).join(""), /fixture-22/);
    setup.mockInput.pressEscape();
    await setup.flush();
    assert.equal(node("sessionbar-projects-box").visible, true);
    assert.match(setup.captureCharFrame(), /Workspace_7/);
    setup.resize(140, 40);
    await setup.flush();
    setup.resize(width, height);
    await setup.flush();
    assert.match(setup.captureCharFrame(), /Workspace_7/, "resize preserves the visible project cursor");
  } finally {
    setup.mockInput.pressCtrlC();
    await running;
  }
}
process.stdout.write(JSON.stringify({ viewports: sizes.map(([width, height]) => `${width}x${height}`) }));
