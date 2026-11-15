import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { TextAttributes } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { applyMonitorAction, createMonitorView, monitorVisibleModel, renderMonitorView } from "../../dist/tui/openTuiMonitor.js";
const sessions = Array.from({ length: 5 }, (_, index) => ({
    session_id: `fixture-session-${index}`, session_name: `Fixture session ${index}`, session_type: "Codex",
    project: "Vision-Dash", project_path: "/fixture/vision-dash", status: index ? "idle" : "working",
    task_name: `Fixture task ${index}`, source: "hook", session_kind: "user", timestamp: 1_000,
}));
const providers = [0, 1].map(index => ({
    provider: `fixture-${index}`, label: `Provider ${index}`, form: "subscription", level: "green", unit: "%",
    used: 32, remaining: 68, limit: 100, pacing: "Observing", cardTiming: "No cards", autoResetIn: "resets in 7d",
    sustainableRate: 0, actualVsSustainable: null, projectedCapHitAt: null,
}));
function encode(frame) {
    return frame.lines.map(line => line.spans.map(span => ({
        text: span.text, fg: span.fg.intent === "default" ? null : span.fg.toInts(),
        bg: span.bg.intent === "default" || span.bg.a === 0 ? null : span.bg.toInts(), attributes: span.attributes,
        underline: Boolean(span.attributes & TextAttributes.UNDERLINE), inverse: Boolean(span.attributes & TextAttributes.INVERSE),
    })));
}
const mode = process.argv[2] ?? "layout";
const sizes = mode === "selection" ? [[140, 40], [110, 50], [80, 40], [80, 24]]
    : mode === "raw" ? [[110, 50], [80, 24], [40, 20]]
        : [[110, 50], [110, 51], [118, 60], [80, 40], [140, 40], [80, 24], [48, 24], [40, 20]];
const frames = [];
for (const [width, height] of sizes) {
    const setup = await createTestRenderer({ width, height, useMouse: true, enableMouseMovement: true, consoleMode: "disabled", backgroundColor: "transparent" });
    let state = {
        sessions, providers, view: "sessions", filterText: "", filterActive: false,
        projectCursorKey: null, projectFocusKey: null, selectedIdx: -1, selectedId: null, detailId: null, detailTab: "overview",
        sessionFingerprints: new Map(), unreadSessionIds: new Set(), unreadInitialized: false, sseMode: false,
    };
    let actions = 0;
    const refs = createMonitorView(setup.renderer, { port: 62507 }, action => {
        actions++;
        state = applyMonitorAction(state, action);
        paint();
    });
    const paint = () => renderMonitorView(refs, monitorVisibleModel(state, setup.renderer, 1_000, { port: 62507, apiHost: "fixture", stateDir: "fixture" }));
    const focusProject = () => {
        const model = monitorVisibleModel(state, setup.renderer, 1_000);
        const project = model.projectActions?.find(action => action?.type === "project");
        assert.ok(project);
        state = applyMonitorAction(state, project);
    };
    try {
        let detailsSelectedSpans = [];
        let providerSelectedSpans = [];
        focusProject();
        paint();
        await setup.flush();
        const before = setup.captureCharFrame();
        const beforeSpans = encode(setup.captureSpans());
        const geometry = {
            width, height, body: [refs.body.screenY, refs.body.height], details: [refs.detailsBox.screenY, refs.detailsBox.height],
            scroll: [refs.detailsScroll.screenY, refs.detailsScroll.height], viewport: [refs.detailsScroll.viewport.screenY, refs.detailsScroll.viewport.height, refs.detailsScroll.viewport.width],
            scrollHeight: refs.detailsScroll.scrollHeight, footer: [refs.footer.screenY, refs.footer.height],
        };
        if (mode === "diagnose") {
            refs.detailsScroll.scrollTo(100_000);
            await setup.flush();
            process.stdout.write(JSON.stringify({ ...geometry, scrollTop: refs.detailsScroll.scrollTop,
                scrollSize: refs.detailsScroll.verticalScrollBar.scrollSize, viewportSize: refs.detailsScroll.verticalScrollBar.viewportSize,
                text: [refs.detailsText.screenX, refs.detailsText.screenY, refs.detailsText.width, refs.detailsText.height, refs.detailsText.scrollY],
                bar: [refs.detailsScroll.verticalScrollBar.screenY, refs.detailsScroll.verticalScrollBar.height, refs.detailsScroll.verticalScrollBar.width],
                lines: refs.detailsText.lineCount, virtualLines: refs.detailsText.virtualLineCount,
            }) + "\n");
        }
        if (mode === "layout") {
            assert.ok(refs.detailsText.width <= refs.detailsScroll.viewport.width, "details text reserves the scrollbar column");
            assert.ok(refs.detailsScroll.scrollHeight <= Math.max(refs.detailsText.virtualLineCount, refs.detailsScroll.viewport.height), "scroll extent must not include phantom wrapped lines");
            assert.ok(refs.detailsBox.screenY + refs.detailsBox.height <= refs.body.screenY + refs.body.height, `details remain inside the workspace: ${JSON.stringify(geometry)}`);
            assert.ok(refs.detailsBox.screenY + refs.detailsBox.height < refs.footer.screenY, `details bottom border remains above the footer: ${JSON.stringify(geometry)}`);
            assert.ok(refs.detailsScroll.viewport.screenY + refs.detailsScroll.viewport.height < refs.detailsBox.screenY + refs.detailsBox.height, "viewport cannot cover its panel bottom border");
            assert.match(before.split("\n")[refs.detailsBox.screenY + refs.detailsBox.height - 1], /\u2570.*\u256f/, "the actual frame includes the complete details bottom border");
            assert.ok(refs.detailsScroll.scrollHeight > refs.detailsScroll.viewport.height, "overflow is owned by the scrollbar");
            const scrollX = refs.detailsScroll.viewport.screenX + 3;
            const scrollY = refs.detailsScroll.viewport.screenY + Math.min(2, refs.detailsScroll.viewport.height - 1);
            await setup.mockMouse.scroll(scrollX, scrollY, "down");
            await setup.flush();
            assert.ok(refs.detailsScroll.scrollTop > 0, `wheel scrolls the bounded details viewport at ${width}x${height}`);
            refs.detailsScroll.scrollTo(100_000);
            await setup.flush();
            assert.match(setup.captureCharFrame(), refs.detailsScroll.viewport.height >= 3 ? /ATTENTION/ : /\| none/, "the last details section is reachable");
            if (width === 110 && height === 50) {
                for (const [nextWidth, nextHeight] of [[140, 40], [80, 40], [110, 50]]) {
                    setup.resize(nextWidth, nextHeight);
                    paint();
                    await setup.flush();
                    assert.ok(refs.detailsText.width <= refs.detailsScroll.viewport.width, "resizing preserves the scrollbar width budget");
                    assert.ok(refs.detailsBox.screenY + refs.detailsBox.height < refs.footer.screenY, `resizing keeps details above footer: target=${nextWidth}x${nextHeight} renderer=${setup.renderer.width}x${setup.renderer.height} body=${refs.body.screenY},${refs.body.height} details=${refs.detailsBox.screenY},${refs.detailsBox.height} footer=${refs.footer.screenY}`);
                    refs.detailsScroll.scrollTo(100_000);
                    await setup.flush();
                    assert.match(setup.captureCharFrame(), /ATTENTION/, "the end remains accessible after changing the pane arrangement");
                }
            }
        }
        if (mode === "raw") {
            state = { ...state, detailTab: "raw", sessions: state.sessions.map(session => {
                    if (session.session_id !== state.selectedId)
                        return session;
                    const { task_name: _task, ...rest } = session;
                    return { ...rest, session_name: "LONG_RAW_VALUE_".repeat(24), task_name: "RAW_END" };
                }) };
            paint();
            await setup.flush();
            assert.ok(refs.detailsText.virtualLineCount > refs.detailsText.lineCount, "long raw fields wrap instead of being truncated");
            refs.detailsScroll.scrollTo(100_000);
            await setup.flush();
            assert.match(setup.captureCharFrame(), /RAW_END/, "the final Raw field is reachable after wrapping");
        }
        if (mode === "selection") {
            await setup.mockMouse.drag(refs.detailsText.screenX, refs.detailsText.screenY, refs.detailsText.screenX + 6, refs.detailsText.screenY);
            await setup.flush();
            assert.match(setup.renderer.getSelection()?.getSelectedText() ?? "", /Codex/, "details support native drag selection");
            assert.ok(setup.captureSpans().lines.some(line => line.spans.some(span => span.text.includes("Codex") && span.bg.intent !== "default" && span.bg.a > 0)), "selected details text has a visible background highlight");
            detailsSelectedSpans = encode(setup.captureSpans());
            setup.renderer.clearSelection();
            state = { ...state, view: "providers" };
            paint();
            await setup.flush();
            const table = refs.providersTable;
            const x = table.screenX + 1, y = table.screenY + (table.content.length > 2 ? 4 : 1);
            await setup.mockMouse.moveTo(x, y);
            await setup.flush();
            const beforeActions = actions;
            await setup.mockMouse.drag(x, y, x + 9, y);
            await setup.flush();
            const selected = setup.renderer.getSelection()?.getSelectedText() ?? "";
            assert.match(selected, /Provider/, "provider names remain selectable while hover is enabled");
            assert.ok(setup.captureSpans().lines.some(line => line.spans.some(span => /Provider/.test(span.text) && span.bg.intent !== "default" && span.bg.a > 0)), "selected provider text has a visible background highlight");
            assert.equal(actions, beforeActions, "dragging text cannot activate a provider");
            await setup.mockMouse.moveTo(x, table.screenY + 1);
            await setup.flush();
            assert.match(setup.renderer.getSelection()?.getSelectedText() ?? "", /Provider/, "later hover must not erase the selection");
            assert.ok(setup.captureSpans().lines.some(line => line.spans.some(span => /Provider/.test(span.text) && span.bg.intent !== "default" && span.bg.a > 0)), "hover preserves the rendered selection highlight");
            providerSelectedSpans = encode(setup.captureSpans());
        }
        frames.push({ width, height, before, beforeSpans, after: setup.captureCharFrame(), afterSpans: encode(setup.captureSpans()), geometry, detailsSelectedSpans, providerSelectedSpans });
    }
    finally {
        refs.root.destroyRecursively();
        setup.renderer.destroy();
    }
}
if (process.argv[3])
    writeFileSync(process.argv[3], JSON.stringify(frames, null, 2));
process.stdout.write(JSON.stringify({ mode, viewports: sizes.map(([width, height]) => `${width}x${height}`) }));
