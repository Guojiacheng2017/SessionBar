import assert from "node:assert/strict";
import test from "node:test";
import { applyMonitorAction, monitorVisibleModel, nextVisibleFreshnessDelay } from "../dist/tui/openTuiMonitor.js";
const state = (patch = {}) => ({
    sessions: Array.from({ length: 20 }, (_, index) => ({ session_id: `s-${index}`, session_name: `Session ${index}`,
        session_type: "Codex", project: index < 10 ? "Alpha" : "Beta", status: "idle", task_name: `Task ${index}`, timestamp: 1_000 })),
    providers: [], view: "sessions", filterText: "", filterActive: false,
    projectCursorKey: "name:Alpha", projectFocusKey: null, selectedIdx: -1, selectedId: null, detailId: null, detailTab: "overview",
    sessionFingerprints: new Map(), unreadSessionIds: new Set(["s-12"]), unreadInitialized: false, sseMode: false, ...patch,
});
const renderer = { width: 80, height: 24 };
const provider = { provider: "fixture", label: "Fixture", form: "subscription", level: "green", unit: "%",
    pacing: "", cardTiming: "", autoResetIn: "", sustainableRate: 0, actualVsSustainable: null, projectedCapHitAt: null };
test("session click opens its real project and detail and clears only that unread session", () => {
    const next = applyMonitorAction(state(), { type: "session", id: "s-12" });
    assert.equal(next.projectFocusKey, "name:Beta");
    assert.equal(next.selectedIdx, 2);
    assert.equal(next.selectedId, "s-12");
    assert.equal(next.detailId, "s-12");
    assert.equal(next.unreadSessionIds.has("s-12"), false);
});
test("unknown, filtered or wrong-view rows cannot change selection", () => {
    const filtered = state({ filterText: "Alpha" });
    assert.deepEqual(applyMonitorAction(filtered, { type: "project", key: "name:Beta" }), filtered);
    assert.deepEqual(applyMonitorAction(filtered, { type: "session", id: "s-12" }), filtered);
    assert.deepEqual(applyMonitorAction(filtered, { type: "session", id: "missing" }), filtered);
    assert.deepEqual(applyMonitorAction(filtered, { type: "mode", mode: "cash" }), filtered);
});
test("wheel in All Sessions moves the visible window without opening a session", () => {
    const original = state();
    const next = applyMonitorAction(original, { type: "step", list: "sessions", delta: 1 });
    assert.equal(next.projectFocusKey, null);
    assert.equal(next.detailId, null);
    const first = (input) => monitorVisibleModel(input, renderer, 1_000).sessionsContent[0]?.[0]?.map(chunk => chunk.text).join("");
    assert.match(first(original) ?? "", /Session 0/);
    assert.match(first(next) ?? "", /Session 1/);
    assert.equal(applyMonitorAction(next, { type: "step", list: "sessions", delta: -1 }).sessionScrollOffset, 0);
});
test("scrolled All Sessions freshness schedules the visible 20s to 21s transition", () => {
    const now = 1_000_000;
    const scrolled = state({
        sessions: state().sessions.map((session, index) => ({
            ...session, project: "Alpha", timestamp: now - (index < 10 ? 1_000 : 20_000),
        })),
        sessionScrollOffset: 12,
    });
    const first = (time) => monitorVisibleModel(scrolled, renderer, time)
        .sessionsContent[0]?.[0]?.map(chunk => chunk.text).join("") ?? "";
    assert.match(first(now), /Session 12/);
    assert.match(first(now), /20s$/);
    assert.match(first(now + 1_000), /21s$/);
    assert.equal(nextVisibleFreshnessDelay(scrolled, renderer, now), 1_000);
});
test("clipped project rows do not schedule invisible per-second age updates", () => {
    const now = 1_000_000;
    const current = state({ sessions: state().sessions.map((session, index) => ({
            ...session, project: `Workspace_${index}`, timestamp: now - (index === 4 ? 20_000 : 120_000),
        })), projectCursorKey: "name:Workspace_0" });
    const model = monitorVisibleModel(current, renderer, now);
    assert.deepEqual(model.projectActions?.filter(action => action?.type === "project"), [{ type: "project", key: "name:Workspace_0" }]);
    assert.equal(nextVisibleFreshnessDelay(current, renderer, now), 60_000);
});
test("wheel clamps a provider cursor after a shorter refresh before moving it", () => {
    const next = applyMonitorAction(state({ view: "providers", providers: [provider, { ...provider, label: "Other" }], providerIndex: 20 }), { type: "step", list: "providers", delta: -1 });
    assert.equal(next.providerIndex, 0);
    assert.equal(next.providers[0], provider);
});
test("session wheel stores no invisible overscroll past its rendered page", () => {
    let current = state();
    const down = { type: "step", list: "sessions", delta: 1, pageSize: 7 };
    for (let i = 0; i < 30; i++)
        current = applyMonitorAction(current, down);
    assert.equal(current.sessionScrollOffset, 13);
    const up = { type: "step", list: "sessions", delta: -1, pageSize: 7 };
    assert.equal(applyMonitorAction(current, up).sessionScrollOffset, 12);
    assert.equal(applyMonitorAction(current, { ...up, pageSize: 10 }).sessionScrollOffset, 9, "resizing also starts from the displayed last page");
});
test("back leaves the project scope without dropping filters or usage mode", () => {
    const next = applyMonitorAction(state({ projectCursorKey: "name:Beta", projectFocusKey: "name:Beta", selectedIdx: 2,
        selectedId: "s-12", detailId: "s-12", providerUsageMode: "cash" }), { type: "back" });
    assert.equal(next.projectFocusKey, null);
    assert.equal(next.selectedId, null);
    assert.equal(next.detailId, null);
    assert.equal(next.providerUsageMode, "cash");
});
