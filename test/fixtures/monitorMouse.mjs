import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { BoxRenderable, ScrollBoxRenderable, TextAttributes, TextRenderable, TextTableRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import * as monitor from "../../dist/tui/openTuiMonitor.js";
assert.equal(typeof monitor.mountOpenTuiMonitor, "function", "monitor can mount with an existing native renderer");
const provider = (index) => ({
    provider: `fixture-${index}`, label: `Provider ${index}`, form: "subscription", level: "green",
    used: index, remaining: 100 - index, limit: 100, unit: "%", pacing: "Observing",
    cardTiming: "No cards", autoResetIn: "unblocked in 3d", sustainableRate: 0, actualVsSustainable: null, projectedCapHitAt: null,
    usageTrends: {
        token: { kind: "bars", days: 7, points: [10, 20, null, 0, 50, 25, 80], unit: "tokens", source: "Fixture history ".repeat(12) },
        cash: { kind: "bars", days: 7, points: [1, 2, null, 0, 5, 2.5, 8], unit: "USD", source: "Fixture history ".repeat(12) },
    },
});
const sessions = [
    { session_id: "a1", project: "Alpha", task_name: "fixture alpha one", session_type: "Codex", status: "working", timestamp: Date.now() },
    { session_id: "a2", project: "Alpha", task_name: "fixture alpha two", session_type: "Codex", status: "idle", timestamp: Date.now() },
    { session_id: "b1", project: "Beta", task_name: "fixture beta one", session_type: "Claude Code", status: "working", timestamp: Date.now() },
    { session_id: "b2", project: "Beta", task_name: "fixture beta two", session_type: "Claude Code", status: "idle", timestamp: Date.now() },
];
function encode(frame) {
    return frame.lines.map(line => line.spans.map(span => ({ text: span.text, fg: span.fg.intent === "default" ? null : span.fg.toInts(), bg: span.bg.intent === "default" || span.bg.a === 0 ? null : span.bg.toInts(), attributes: span.attributes, underline: Boolean(span.attributes & TextAttributes.UNDERLINE), inverse: Boolean(span.attributes & TextAttributes.INVERSE) })));
}
const frames = [];
for (const [width, height] of [[140, 40], [80, 24], [48, 24], [40, 24], [40, 20]]) {
    const setup = await createTestRenderer({ width, height, useMouse: true, enableMouseMovement: true, kittyKeyboard: true, consoleMode: "disabled", backgroundColor: "transparent" });
    let providers = Array.from({ length: 9 }, (_, index) => provider(index));
    let closed = 0;
    let providerReads = 0;
    let sessionReads = 0;
    const mounted = monitor.mountOpenTuiMonitor(setup.renderer, {
        fetchSessions: async () => { sessionReads++; return { sessions }; }, fetchSystem: async () => undefined,
        fetchProviders: async () => { providerReads++; return providers; }, openWebDashboard: async () => { },
        renderMs: 500, pollMs: 60_000, backgroundPollMs: 60_000, animate: false,
        port: 62507, apiHost: "127.0.0.1", stateDir: "fixture-only", initialView: "providers",
        closeTransport: () => { closed++; },
    });
    const node = (id) => {
        const target = setup.renderer.root.findDescendantById(id);
        assert.ok(target, `${id} exists`);
        return target;
    };
    const detail = () => {
        const target = node("sessionbar-details");
        assert.ok(target instanceof TextRenderable);
        return target.content.chunks.map(chunk => chunk.text).join("");
    };
    const title = () => {
        const target = node("sessionbar-details-box");
        assert.ok(target instanceof BoxRenderable);
        return target.title ?? "";
    };
    const waitFor = async (label, predicate) => {
        try {
            await setup.waitFor(predicate);
        }
        catch (error) {
            throw new Error(`${label} at ${width}x${height}: ${detail().split("\n")[0]}`, { cause: error });
        }
    };
    const click = async (id, paddedEdge = false) => {
        const target = node(id);
        assert.ok(target.screenX >= 0 && target.screenX + target.width <= width, `${id} fits horizontally at ${width}`);
        assert.ok(target.screenY >= 0 && target.screenY + target.height <= height, `${id} fits vertically at ${width}`);
        await setup.mockMouse.click(target.screenX + (paddedEdge ? 0 : Math.floor(target.width / 2)), target.screenY);
        await setup.flush();
    };
    try {
        await waitFor("initial provider", () => detail().includes("Provider 0"));
        await setup.flush();
        let buttonHover = "";
        let buttonHoverSpans = [];
        const readsBeforeHover = [providerReads, sessionReads];
        const textLabel = (id) => {
            const label = node(id).getChildren().find(child => child instanceof TextRenderable);
            assert.ok(label instanceof TextRenderable);
            return label;
        };
        for (const id of ["sessionbar-view-sessions", "sessionbar-view-providers", "sessionbar-view-agents", "sessionbar-mode-cash"]) {
            const target = node(id);
            const label = textLabel(id);
            const labelText = label.content.chunks.map(chunk => chunk.text).join("");
            assert.match(labelText, /^ .+ $/, `${id} keeps padding on both sides`);
            assert.ok(target.width >= labelText.trim().length + 2);
            await setup.mockMouse.moveTo(target.screenX, target.screenY);
            await setup.flush();
            assert.ok(label.attributes & TextAttributes.INVERSE, `${id} visibly responds to hover`);
            assert.ok(setup.captureSpans().lines.some(line => line.spans.some(span => span.text.includes(labelText.trim()) && Boolean(span.attributes & TextAttributes.INVERSE))), "hover is present in the actual native frame");
            if (id === "sessionbar-view-sessions") {
                buttonHover = setup.captureCharFrame();
                buttonHoverSpans = encode(setup.captureSpans());
            }
            assert.match(title(), /Tokens/, "hover does not switch metric or view");
            await setup.mockMouse.moveTo(0, height - 1);
            await setup.flush();
            assert.equal(label.attributes & TextAttributes.INVERSE, 0, "button hover clears on leave");
        }
        const hoverTable = node("sessionbar-providers");
        assert.ok(hoverTable instanceof TextTableRenderable);
        const rowIndex = height > 24 ? 2 : 1;
        const rowY = hoverTable.screenY + (height > 24 ? 4 : 1);
        const quotaColors = hoverTable.content[rowIndex][1]?.map(chunk => chunk.fg?.toInts());
        await setup.mockMouse.moveTo(hoverTable.screenX + 2, rowY);
        await setup.flush();
        assert.ok((hoverTable.content[rowIndex][0]?.[0].attributes ?? 0) & TextAttributes.UNDERLINE, "row hover highlights the name");
        assert.deepEqual(hoverTable.content[rowIndex][1]?.map(chunk => chunk.fg?.toInts()), quotaColors, "hover retains quota status colors");
        const hoveredContent = hoverTable.content;
        await setup.mockMouse.moveTo(hoverTable.screenX + 4, rowY);
        assert.equal(hoverTable.content, hoveredContent, `same-line move at ${width}x${height}`);
        await setup.mockMouse.moveTo(hoverTable.screenX + 4, rowY + 1);
        assert.equal(hoverTable.content, hoveredContent, `second-line move at ${width}x${height}`);
        await setup.mockMouse.moveTo(hoverTable.screenX + 4, rowY + 2);
        assert.equal(hoverTable.content, hoveredContent, `third-line move at ${width}x${height}`);
        await setup.flush();
        assert.equal(hoverTable.content, hoveredContent, `moving within one provider does not rebuild its table at ${width}x${height}, table y=${hoverTable.screenY} h=${hoverTable.height}, row y=${rowY}`);
        assert.match(detail(), /^Provider 0\n/, "hover does not select a provider");
        const hover = setup.captureCharFrame();
        const hoverSpans = encode(setup.captureSpans());
        await setup.mockMouse.moveTo(hoverTable.screenX + 2, hoverTable.screenY);
        await setup.flush();
        assert.equal((hoverTable.content[rowIndex][0]?.[0].attributes ?? 0) & TextAttributes.UNDERLINE, 0, "header does not retain row hover");
        await setup.mockMouse.moveTo(0, height - 1);
        await setup.flush();
        assert.deepEqual([providerReads, sessionReads], readsBeforeHover, "hover never fetches data");
        await click("sessionbar-mode-cash", true);
        assert.match(title(), /Cash/, "button padding is clickable");
        setup.mockInput.pressKey("1");
        await setup.flush();
        await click("sessionbar-mode-cash");
        assert.match(title(), /Cash/);
        assert.match(detail(), /USD/);
        const cash = setup.captureCharFrame();
        const cashSpans = encode(setup.captureSpans());
        setup.mockInput.pressKey("1");
        await setup.flush();
        assert.match(title(), /Tokens/, "keyboard still works after mouse selection");
        let table = node("sessionbar-providers");
        await setup.mockMouse.scroll(table.screenX + 2, table.screenY + 1, "down");
        await setup.flush();
        assert.match(detail(), /^Provider 1\n/);
        await setup.mockMouse.click(table.screenX + 2, table.screenY);
        await setup.flush();
        assert.match(detail(), /^Provider 1\n/, "column header is not a provider");
        await setup.mockMouse.click(table.screenX + 2, table.screenY + 2);
        await setup.flush();
        assert.match(detail(), height <= 24 ? /^Provider 1\n/ : /^Provider 0\n/, "second visual line selects the same logical row");
        if (height > 24) {
            await setup.mockMouse.scroll(table.screenX + 2, table.screenY + 1, "down");
            await setup.flush();
            assert.match(detail(), /^Provider 1\n/);
            await setup.mockMouse.click(table.screenX + 2, table.screenY + 3);
            await setup.flush();
            assert.match(detail(), /^Provider 0\n/, "third visual line still belongs to the first provider");
            await setup.mockMouse.click(table.screenX + 2, table.screenY + 4);
            await setup.flush();
            assert.match(detail(), /^Provider 1\n/, "next provider starts on the fourth line after the header");
        }
        if (height > 20) {
            const before = detail();
            await setup.mockMouse.click(table.screenX + 2, table.screenY + 3, 2);
            await setup.mockMouse.click(table.screenX + 2, table.screenY + 3, 0, { modifiers: { ctrl: true } });
            await setup.mockMouse.drag(table.screenX + 2, table.screenY + 1, table.screenX + 2, table.screenY + 3);
            await setup.flush();
            assert.equal(detail(), before, "right click, modified click and dragging do not select rows");
        }
        const scroll = node("sessionbar-details-scroll");
        assert.ok(scroll instanceof ScrollBoxRenderable);
        await setup.mockMouse.scroll(scroll.screenX + 2, scroll.screenY + 1, "down");
        await setup.flush();
        assert.ok(scroll.scrollTop > 0, "wheel scrolls actual details");
        await click("sessionbar-mode-cash");
        assert.equal(scroll.scrollTop, 0, "changing metric resets details scroll");
        await click("sessionbar-view-sessions", true);
        await waitFor("projects view", () => node("sessionbar-projects-box").visible);
        const projects = node("sessionbar-projects");
        assert.ok(projects instanceof TextTableRenderable);
        await setup.mockMouse.moveTo(projects.screenX + 3, projects.screenY + 2);
        await setup.flush();
        assert.ok((projects.content[2][1]?.[0].attributes ?? 0) & TextAttributes.UNDERLINE, "projects have hover feedback");
        await setup.mockMouse.click(projects.screenX + 3, projects.screenY + 2);
        await setup.flush();
        const sessionBox = node("sessionbar-sessions-box");
        assert.ok(sessionBox instanceof BoxRenderable);
        assert.match(sessionBox.title ?? "", /Beta/);
        const sessionTable = node("sessionbar-sessions");
        assert.ok(sessionTable instanceof TextTableRenderable);
        await setup.mockMouse.moveTo(sessionTable.screenX + 3, sessionTable.screenY + 1);
        await setup.flush();
        assert.ok((sessionTable.content[1][0]?.[0].attributes ?? 0) & TextAttributes.UNDERLINE, "sessions have hover feedback");
        await setup.mockMouse.click(sessionTable.screenX + 3, sessionTable.screenY + 1);
        await setup.flush();
        assert.match(detail(), /fixture beta two/);
        let selectedSession = setup.captureCharFrame();
        if (width < 70 && height <= 24) {
            const detailsScroll = node("sessionbar-details-scroll");
            assert.ok(detailsScroll instanceof ScrollBoxRenderable);
            assert.equal(sessionBox.visible, false, "compact details expand instead of keeping an unusable list split");
            assert.ok(detailsScroll.height >= 8);
            for (let i = 0; i < 12 && !selectedSession.includes("fixture beta two"); i++) {
                await setup.mockMouse.scroll(detailsScroll.screenX + 2, detailsScroll.screenY + 2, "down");
                await setup.flush();
                selectedSession = setup.captureCharFrame();
            }
            assert.match(selectedSession, /fixture beta two/, "compact session selection shows its details on screen");
        }
        const selectedSessionSpans = encode(setup.captureSpans());
        await click("sessionbar-back", true);
        assert.equal(node("sessionbar-projects-box").visible, true);
        assert.match(sessionBox.title ?? "", /All Sessions/);
        await click("sessionbar-view-agents");
        await setup.flush();
        await click("sessionbar-view-providers");
        await waitFor("return to providers", () => detail().includes("Provider"));
        setup.mockInput.pressKey("/");
        await setup.mockInput.typeText("Provider 7");
        setup.mockInput.pressEnter();
        await setup.flush();
        table = node("sessionbar-providers");
        await setup.mockMouse.click(table.screenX + 2, table.screenY + 2);
        await setup.flush();
        assert.match(detail(), /^Provider 7\n/, "filtered rows select the original provider identity");
        setup.mockInput.pressKey("/");
        setup.mockInput.pressEscape();
        await setup.flush();
        providers = [provider(0), provider(1)];
        setup.mockInput.pressKey("r");
        await waitFor("two-row refresh", () => sessionBox.title?.includes("(2)") === true);
        await setup.flush();
        table = node("sessionbar-providers");
        await setup.mockMouse.scroll(table.screenX + 2, table.screenY + 1, "up");
        await setup.flush();
        assert.match(detail(), /^Provider 0\n/);
        await setup.mockMouse.scroll(table.screenX + 2, table.screenY + 1, "down");
        await setup.flush();
        assert.match(detail(), /^Provider 1\n/);
        await setup.mockMouse.moveTo(table.screenX + 2, table.screenY + 1);
        await setup.flush();
        await setup.mockMouse.pressDown(table.screenX + 2, table.screenY + 1);
        providers = [provider(2), provider(3)];
        setup.mockInput.pressKey("r");
        await waitFor("refresh during press", () => detail().startsWith("Provider 3\n"));
        await setup.flush();
        assert.ok(table instanceof TextTableRenderable);
        assert.equal((table.content[1][0]?.[0].attributes ?? 0) & TextAttributes.UNDERLINE, 0, "replacement rows do not inherit stale hover");
        await setup.mockMouse.release(table.screenX + 2, table.screenY + 1);
        await setup.flush();
        assert.match(detail(), /^Provider 3\n/, "a refresh during a mouse press cannot select a different row");
        frames.push({ width, height, cash, cashSpans, selectedSession, selectedSessionSpans, hover, hoverSpans, buttonHover, buttonHoverSpans });
    }
    finally {
        setup.mockInput.pressCtrlC();
        await mounted;
        assert.equal(closed, 1);
    }
}
if (process.argv[2])
    writeFileSync(process.argv[2], JSON.stringify(frames, null, 2));
process.stdout.write(JSON.stringify({ viewports: frames.map(frame => `${frame.width}x${frame.height}`), checks: ["view tabs", "provider mode click", "three-line provider row", "filtered identity", "project and session click", "back", "list wheel", "details wheel", "keyboard retained", "drag and modifiers ignored", "refresh during click", "padded button hit area", "button and row hover", "same-row hover dedupe", "no hover fetch", "cleanup"] }));
