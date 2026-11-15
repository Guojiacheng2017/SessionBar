import assert from "node:assert/strict";
import test from "node:test";
import { parseColor } from "@opentui/core";
import { providerCardText, providerLeftText, providerLevelLabel, providerResetText } from "../dist/providers/providerPresentation.js";
import { providerUsageDisplayTrend } from "../dist/providers/providerUsageMetrics.js";
import { providerDetailText, providerTableColumns, providerUsageMeter, providerUsageSparkline, providerWorkspaceLayout } from "../dist/tui/providerInspector.js";
import { monitorVisibleModel, providerTableContent } from "../dist/tui/openTuiMonitor.js";
import { TERMINAL_COLORS } from "../dist/tui/terminalTheme.js";
const row = (patch = {}) => ({
    provider: "openai", label: "OpenAI Subscription", form: "subscription", level: "green",
    pacing: "Observing", cardTiming: "Card expires in 1d", autoResetIn: "unblocked in 7d",
    sustainableRate: 0, actualVsSustainable: null, projectedCapHitAt: null,
    used: 32, remaining: 68, limit: 100, unit: "%", ...patch,
});
const renderer = (width, height) => ({ width, height });
const text = (cell) => cell?.map(chunk => chunk.text).join("") ?? "";
test("Web and terminal provider labels share quota precision, levels and reset wording", () => {
    assert.equal(providerLeftText(row()), "32/100 % used");
    assert.equal(providerLeftText(row({ form: "api", unit: "CNY", remaining: 231.63 })), "231.63 CNY left");
    assert.equal(providerLeftText(row({ form: "api", used: undefined, remaining: undefined, limit: undefined })), "\u2014");
    assert.equal(providerLevelLabel(row()), "Healthy");
    assert.equal(providerLevelLabel(row({ level: "yellow" })), "Watch");
    assert.equal(providerLevelLabel(row({ level: "red" })), "Critical");
    assert.equal(providerLevelLabel(row({ stale: true })), "Stale");
    assert.equal(providerLevelLabel(row({ collectionError: "Timed out" })), "Timed out");
    assert.equal(providerResetText("unblocked in 7d"), "resets in 7d");
    assert.equal(providerCardText("Card expires in 1d"), "expires in 1d");
    assert.equal(providerCardText("No cards"), "0 cards left");
    assert.equal(providerCardText("3 cards left · Use card now"), "3 cards left · Use card now");
    assert.equal(providerCardText("1 card left · Card expires in 1d"), "1 card left · expires in 1d");
    assert.equal(providerCardText("Cards unknown"), "Cards unknown");
    assert.equal(providerCardText("0 cards left · Card expired 2d ago"), "0 cards left · expired 2d ago");
});
test("provider quota labels preserve missing and non-finite balances", () => {
    for (const value of [undefined, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
        assert.equal(providerLeftText(row({ remaining: value, used: undefined, limit: undefined })), "\u2014");
        assert.equal(providerLeftText(row({ form: "api", remaining: value, used: undefined, limit: undefined })), "\u2014");
    }
    assert.equal(providerLeftText(row({ used: undefined, remaining: 0 })), "0 % left");
    assert.equal(providerLeftText(row({ form: "api", unit: "USD", remaining: 0 })), "0 USD left");
});
test("daily history uses the latest seven days and monthly cumulative keeps its full cycle", () => {
    const points = Array.from({ length: 30 }, (_, index) => index);
    const labels = points.map(String);
    const daily = { kind: "bars", days: 30, points, labels };
    const original = structuredClone(daily);
    const display = providerUsageDisplayTrend(row({ usageTrend: daily }), "token");
    assert.deepEqual(display?.points, points.slice(-7));
    assert.deepEqual(display?.labels, labels.slice(-7));
    assert.equal(display?.days, 7);
    assert.equal(daily.points.length, 30);
    assert.deepEqual(daily, original);
    const monthly = { kind: "line", days: 30, points, labels };
    const monthlyDisplay = providerUsageDisplayTrend(row({ usageTrend: monthly }), "token");
    assert.deepEqual(monthlyDisplay?.points, points);
    assert.equal(monthlyDisplay, monthly);
});
test("sparse monthly observations are not lost between fixed sparkline sample indices", () => {
    const points = Array(30).fill(null);
    points[27] = 0;
    points[28] = 100;
    const sparse = row({ provider: "github", usageTrend: { kind: "line", days: 30, points, unit: "AI credits" } });
    const spark = providerUsageSparkline(sparse, "token");
    assert.match(spark, /\u2581/);
    assert.match(spark, /\u2588/);
    assert.ok(spark.length <= 7);
});
test("provider table matches Web column order at full width and adapts without clipping", () => {
    const rows = [row(), row({ provider: "deepseek", label: "DeepSeek API CNY", form: "api", unit: "CNY", remaining: 231.63 })];
    const wide = providerTableContent(rows, renderer(150, 36), undefined, 0, "token");
    assert.deepEqual(wide[0].map(text), ["Provider", "Quota / Usage", "Level", "Usage", "Reset", "Card"]);
    assert.match(text(wide[1][2]), /Healthy/);
    assert.match(text(wide[1][4]), /resets in 7d/);
    assert.match(text(wide[1][5]), /expires in 1d/);
    for (const width of [40, 60, 80, 100, 120, 150, 200]) {
        const columns = providerTableColumns(width - 4);
        assert.ok(columns.reduce((sum, column) => sum + column.width, 0) + (columns.length - 1) * 2 <= width - 4);
        const content = providerTableContent(rows, renderer(width, 36), undefined, 0, "token");
        for (const cells of content)
            for (let i = 0; i < cells.length; i++) {
                assert.ok(text(cells[i]).split("\n").every(line => line.length <= columns[i].width), `cell overflow at ${width}`);
            }
    }
});
test("provider details preserve missing values, normalize labels and show readable native charts", () => {
    const detail = providerDetailText(row({ usageTrend: { kind: "bars", days: 7, unit: "tokens", points: [20, null, 40, 0, 80, 60, 100] } }), "token", 110);
    assert.match(detail, /Healthy/);
    assert.match(detail, /resets in 7d/);
    assert.match(detail, /Last 7 days/);
    assert.match(detail, /tokens/);
    assert.match(detail, /\u2588/);
    const unknown = providerDetailText(row({ used: undefined, remaining: undefined, limit: undefined, usageTrend: undefined }), "token", 110);
    assert.doesNotMatch(unknown, /Remaining\s+0|Used\s+0|Limit\s+0/);
    for (const width of [24, 38, 74, 110]) {
        assert.ok(providerDetailText(row(), "token", width).split("\n").every(line => line.length <= width));
    }
});
test("quota meters consistently fill remaining capacity and label the direction", () => {
    assert.equal(providerUsageMeter(row(), 16), "\u2588\u2588\u2588\u2588\u2500\u2500  68% left");
    assert.equal(providerUsageMeter(row({ used: undefined, limit: undefined, remaining: 15 }), 16), "\u2588\u2500\u2500\u2500\u2500\u2500  15% left");
    assert.match(providerUsageMeter(row({ used: 0, remaining: 200, limit: 200, unit: "AI credits" }), 24), /^\u2588+ 100% left$/);
    assert.match(providerUsageMeter(row({ used: 80, remaining: undefined, limit: 200, unit: "credits" }), 24), /60% left$/);
    for (const remaining of [0, 15, 68, 100]) {
        assert.equal(providerUsageMeter(row({ remaining }), 16).split(" ")[0].length, 6, "track geometry does not change with the percentage label");
    }
});
test("quota meters keep unknown balances absent and do not hide depletion or overage", () => {
    assert.equal(providerUsageMeter(row({ form: "api", remaining: 527.96, used: undefined, limit: undefined, unit: "CNY" }), 24), "");
    assert.equal(providerUsageMeter(row({ used: undefined, remaining: undefined }), 24), "");
    assert.equal(providerUsageMeter(row({ remaining: Number.NaN, used: undefined }), 24), "");
    assert.equal(providerUsageMeter(row({ form: "api", unit: "credits", limit: 0 }), 24), "");
    assert.equal(providerUsageMeter(row({ form: "api", unit: "credits", limit: Number.POSITIVE_INFINITY }), 24), "");
    assert.match(providerUsageMeter(row({ used: 100, remaining: 0 }), 24), /^\u2500+\s+0% left$/);
    assert.match(providerUsageMeter(row({ used: 140, remaining: -40 }), 24), /^\u2500+\s+-40% left$/);
    assert.match(providerUsageMeter(row({ remaining: 120, used: 0 }), 24), /^\u2588+ 120% left$/);
});
test("provider quota and status share colors in the list and details while tracks stay neutral", () => {
    const cases = [
        [{}, TERMINAL_COLORS.working],
        [{ level: "yellow" }, TERMINAL_COLORS.blocked],
        [{ level: "red" }, TERMINAL_COLORS.error],
        [{ form: "api" }, TERMINAL_COLORS.cyan],
        [{ level: "red", stale: true }, TERMINAL_COLORS.muted],
        [{ level: "green", collectionError: "Query failed" }, TERMINAL_COLORS.error],
    ];
    for (const [patch, shade] of cases) {
        const provider = row({ usageTrend: { kind: "bars", days: 7, points: [1, null, 3, 0, 8, 2, 6], unit: "tokens" }, ...patch });
        const state = {
            sessions: [], providers: [provider], view: "providers", filterText: "", filterActive: false,
            projectCursorKey: null, projectFocusKey: null, selectedIdx: -1, selectedId: null, detailId: null, detailTab: "overview",
            sessionFingerprints: new Map(), unreadSessionIds: new Set(), unreadInitialized: false, sseMode: false,
        };
        const model = monitorVisibleModel(state, renderer(150, 42));
        const quota = model.providersContent[1][1] ?? [];
        const fill = quota.find(chunk => chunk.text.includes("\u2588"));
        const track = quota.find(chunk => chunk.text.includes("\u2500"));
        assert.deepEqual(fill?.fg?.toInts(), parseColor(shade).toInts(), `quota fill for ${JSON.stringify(patch)}`);
        assert.deepEqual(track?.fg?.toInts(), parseColor(TERMINAL_COLORS.dim).toInts(), "empty track stays neutral");
        assert.equal(typeof model.detailsContent, "object", "details retain semantic color chunks");
        if (typeof model.detailsContent === "string")
            continue;
        const meterIndex = model.detailsContent.chunks.findIndex(chunk => chunk.text.includes("68% left"));
        assert.ok(meterIndex >= 2, "details expose the remaining-quota label");
        const detailMeter = model.detailsContent.chunks.slice(meterIndex - 2, meterIndex + 1);
        const detailFill = detailMeter.find(chunk => chunk.text.includes("\u2588"));
        const detailTrack = detailMeter.find(chunk => chunk.text.includes("\u2500"));
        const status = model.detailsContent.chunks.find(chunk => chunk.text.includes(providerLevelLabel(provider)));
        const history = model.detailsContent.chunks.find(chunk => chunk.text === "Last 7 days / tokens");
        assert.deepEqual(detailFill?.fg?.toInts(), parseColor(shade).toInts(), "details use the same quota fill");
        assert.deepEqual(detailTrack?.fg?.toInts(), parseColor(TERMINAL_COLORS.dim).toInts());
        assert.deepEqual(status?.fg?.toInts(), parseColor(shade).toInts(), "details use the same status color");
        assert.deepEqual(history?.fg?.toInts(), parseColor(provider.stale || provider.collectionError ? TERMINAL_COLORS.muted : TERMINAL_COLORS.cyan).toInts(), "usage history stays separate from quota health");
    }
});
test("colored provider details wrap long facts without losing source text", () => {
    for (const width of [24, 38, 74, 110]) {
        const provider = row({
            level: "yellow", measuredRateLabel: "a long observed rate with explicit units and observation scope",
            usageTrend: { kind: "bars", days: 7, points: [1, null, 3, 0, 8, 2, 6], unit: "tokens", source: "Synthetic usage history ".repeat(8) },
        });
        const detail = providerDetailText(provider, "token", width);
        assert.ok(detail.split("\n").every(line => line.length <= width));
        assert.match(detail.replaceAll("\n", ""), /Synthetic usage history/);
    }
});
test("provider layout gives the table full width while retaining a scrollable detail area", () => {
    for (const [width, height] of [[40, 20], [80, 24], [120, 36], [150, 48]]) {
        const layout = providerWorkspaceLayout(width, height, 5);
        assert.equal(layout.width, width - 2);
        assert.ok(layout.visibleRows >= 1);
        assert.ok(layout.tableHeight >= 5);
        assert.ok(layout.tableHeight + 1 + 5 <= height - 8);
    }
    const state = {
        sessions: [], providers: [row()], view: "providers", filterText: "", filterActive: false,
        projectCursorKey: null, projectFocusKey: null, selectedIdx: -1, selectedId: null, detailId: null, detailTab: "overview",
        sessionFingerprints: new Map(), unreadSessionIds: new Set(), unreadInitialized: false, sseMode: false,
    };
    const model = monitorVisibleModel(state, renderer(120, 36));
    assert.equal(model.sessionsWidth, 118);
    assert.equal(model.detailsWidth, 118);
    assert.match(model.detailsTitle, /Tokens/);
});
test("provider viewport fits complete three-line entries before details", () => {
    assert.equal(providerWorkspaceLayout(150, 42, 5).tableHeight, 20);
    assert.equal(providerWorkspaceLayout(80, 24, 9).visibleRows, 1);
    const compact = providerWorkspaceLayout(40, 20, 9);
    assert.equal(compact.visibleRows, 1);
    assert.equal(compact.tableHeight, 6);
});
