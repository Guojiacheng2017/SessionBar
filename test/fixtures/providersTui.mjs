import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { createTestRenderer } from "@opentui/core/testing";
import { TextAttributes } from "@opentui/core";
import { createMonitorView, monitorVisibleModel, renderMonitorView } from "../../dist/tui/openTuiMonitor.js";
const row = (patch) => ({
    provider: "fixture", label: "Fixture", form: "subscription", level: "green", used: 1, limit: 100, remaining: 99, unit: "%",
    pacing: "Observing", cardTiming: "No cards", autoResetIn: "unblocked in 3d 12h",
    sustainableRate: 0, actualVsSustainable: null, projectedCapHitAt: null,
    usageTrends: {
        token: { kind: "bars", days: 7, points: [0, 12000, 32000, null, 18000, 55000, 24000], unit: "tokens", labels: Array.from({ length: 7 }, (_, i) => `2026-10-${25 + i}`), source: "Fixture session usage" },
        cash: { kind: "bars", days: 7, points: [0, 1.25, 2.5, null, 0.75, 4.25, 2.12], unit: "USD" },
    }, ...patch,
});
const providers = [
    row({ label: "Three-in-One Subscription", provider: "anthropic" }),
    row({ label: "OpenAI Subscription", provider: "openai", used: 32, remaining: 68, level: "red", cardTiming: "Card expires in 1d", autoResetIn: "unblocked in 7d" }),
    row({ label: "GitHub Copilot Individual", provider: "github", used: 2800, limit: 7000, remaining: 4200, unit: "AI credits",
        usageTrend: { kind: "line", days: 30, unit: "AI credits", points: Array.from({ length: 30 }, (_, i) => i < 5 ? null : 100 * (i - 1)), source: "Copilot billing" }, usageTrends: undefined }),
    row({ label: "WorkBuddy Desktop", provider: "workbuddy", form: "api", used: 2.12, limit: undefined, remaining: undefined, unit: "USD", autoResetIn: "", cardTiming: "", pacing: "" }),
    row({ label: "DeepSeek API CNY", provider: "deepseek", form: "api", used: undefined, limit: undefined, remaining: 53.52, unit: "CNY", autoResetIn: "", cardTiming: "", pacing: "" }),
];
function encode(frame) {
    return frame.lines.map(line => line.spans.map(span => ({ text: span.text, fg: span.fg.intent === "default" ? null : span.fg.toInts(), bg: span.bg.intent === "default" || span.bg.a === 0 ? null : span.bg.toInts(), attributes: span.attributes, underline: Boolean(span.attributes & TextAttributes.UNDERLINE) })));
}
const frames = [];
for (const [width, height] of [[150, 42], [114, 42], [90, 30], [80, 24], [60, 24], [48, 24], [48, 20], [40, 24], [40, 20]]) {
    const setup = await createTestRenderer({ width, height, consoleMode: "disabled", backgroundColor: "transparent" });
    const refs = createMonitorView(setup.renderer, { port: 62507 });
    const state = {
        sessions: [], providers, view: "providers", filterText: "", filterActive: false,
        projectCursorKey: null, projectFocusKey: null, selectedIdx: -1, selectedId: null, detailId: null, detailTab: "overview",
        sessionFingerprints: new Map(), unreadSessionIds: new Set(), unreadInitialized: false, sseMode: false,
    };
    const paint = async (patch = {}) => {
        renderMonitorView(refs, monitorVisibleModel({ ...state, ...patch }, setup.renderer, 1_000, { port: 62507, apiHost: "127.0.0.1", stateDir: "fixture-only" }));
        setup.renderer.requestRender();
        await setup.flush();
        return setup.captureCharFrame();
    };
    try {
        const normal = await paint();
        const normalSpans = encode(setup.captureSpans());
        assert.match(normal, /Quota \/ Usage/);
        assert.ok(Boolean((refs.providerModeButtons.get("token")?.label.attributes ?? 0) & TextAttributes.UNDERLINE), "active Token segment");
        if (width >= 80)
            assert.doesNotMatch(normal, /7d t\.\.\.|30d \.\.\./, "metric units must remain readable");
        assert.ok(refs.sessionsBox.screenX === 1 && refs.sessionsBox.width === width - 2, `full-width table at ${width}`);
        assert.ok(refs.detailsBox.screenY >= refs.sessionsBox.screenY + refs.sessionsBox.height, `stacked details at ${width}`);
        for (const panel of [refs.sessionsBox, refs.detailsBox, refs.footer]) {
            assert.ok(panel.screenY >= 0 && panel.screenY + panel.height <= height, `vertical bounds at ${width}`);
            assert.ok(panel.screenX >= 0 && panel.screenX + panel.width <= width, `horizontal bounds at ${width}`);
        }
        if (width >= 114) {
            const lines = normal.split("\n");
            const first = lines.findIndex(line => line.includes("Three-in-One"));
            const second = lines.findIndex(line => line.includes("OpenAI Subscription"));
            assert.equal(second - first, 3, "provider names are three terminal lines apart");
            const tableLine = lines[first + 2].slice(refs.providersTable.screenX, refs.providersTable.screenX + refs.providersTable.width);
            assert.equal(tableLine.trim(), "", "provider separator stays empty");
            assert.match(normal, /Healthy/);
            assert.match(normal, /Critical/);
            assert.match(normal, /resets in 7d/);
            assert.match(normal, /Card/);
            assert.match(normal, /32\/100 % used/);
            assert.match(normal, /credits/);
        }
        if (width === 80) {
            assert.match(normal, /Remaining\s+99%/);
            assert.match(normal, /Used\s+1%/);
            assert.match(normal, /Limit\s+100%/);
        }
        assert.match(refs.footer.content.chunks.map(chunk => chunk.text).join(""), /PgUp\/Dn/);
        const balances = await paint({ providers: [
                row({ label: "OpenAI Subscription", used: undefined, limit: undefined, remaining: 15, level: "red" }),
                row({ label: "GitHub Copilot Individual", used: 0, limit: 200, remaining: 200, unit: "AI credits" }),
                row({ label: "WorkBuddy Desktop", form: "api", used: 2477.27, remaining: undefined, limit: undefined, unit: "credits" }),
                row({ label: "DeepSeek API", form: "api", used: undefined, remaining: 527.96, limit: undefined, unit: "CNY" }),
                row({ label: "Three-in-One Subscription", stale: true }),
            ], providerIndex: 0 });
        const balancesSpans = encode(setup.captureSpans());
        assert.match(balances, /15% left/, "remaining-only percentages have a quota meter");
        if (width >= 114) {
            assert.match(balances, /100% left/, "zero observed usage leaves the quota bar full");
            assert.match(balances, /99% left/, "retained stale quota is still labeled as remaining");
        }
        const cash = await paint({ providerIndex: 4, providerUsageMode: "cash" });
        assert.match(cash, /> DeepSeek/);
        assert.match(cash, /53\.52 CNY/);
        assert.match(cash, /Cash/);
        assert.ok(Boolean((refs.providerModeButtons.get("cash")?.label.attributes ?? 0) & TextAttributes.UNDERLINE), "active Cash segment");
        const cashSpans = encode(setup.captureSpans());
        const monthly = await paint({ providerIndex: 2, providerUsageMode: "token" });
        assert.match(monthly, /Copilot/);
        assert.match(refs.detailsText.content.chunks.map(chunk => chunk.text).join(""), /Monthly cumulative/);
        const missing = await paint({ providers: [row({ used: undefined, remaining: undefined, limit: undefined, usageTrends: undefined, usageTrend: undefined })] });
        assert.doesNotMatch(missing, /Remaining\s+0|Used\s+0/);
        const unavailable = await paint({ providers: [row({ label: "OpenAI Subscription", stale: true, collectionError: "Query unavailable", level: "red" })] });
        const unavailableSpans = encode(setup.captureSpans());
        assert.match(refs.detailsText.content.chunks.map(chunk => chunk.text).join(""), /Query unavailable/);
        const empty = await paint({ providers: [] });
        assert.match(empty, /No quota data/);
        assert.equal(refs.detailsBox.visible, false);
        frames.push({ width, height, normal, cash, unavailable, balances, normalSpans, cashSpans, unavailableSpans, balancesSpans });
    }
    finally {
        refs.root.destroyRecursively();
        setup.renderer.destroy();
    }
}
if (process.argv[2])
    writeFileSync(process.argv[2], JSON.stringify(frames, null, 2));
process.stdout.write(JSON.stringify({ viewports: frames.map(frame => `${frame.width}x${frame.height}`), checks: ["column bounds", "full-width table", "stacked details", "selection window", "cash mode", "monthly cumulative", "missing values", "empty state"] }));
