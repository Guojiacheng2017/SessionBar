import assert from "node:assert/strict";
import test from "node:test";
import { providerPreferenceKey, readInfrequentProviders, readProviderView, saveInfrequentProviders, saveProviderView, updateProviderFrequency } from "../dist/web/providerPreferences.js";
import { providerDailyUsageMarkup, providerTableMarkup } from "../dist/web/webComponents.js";
const copilot = {
    form: "subscription", provider: "github", label: "GitHub Copilot Individual",
    level: "green", pacing: "", cardTiming: "", autoResetIn: "in 3d",
    sustainableRate: 0, actualVsSustainable: null, projectedCapHitAt: null,
    used: 0, limit: 200, unit: "AI credits",
    usageTrend: { kind: "line", days: 30, points: [0, 0, 0], unit: "AI credits" },
};
const openai = {
    ...copilot, provider: "openai", label: "OpenAI Subscription", level: "red",
    used: 99, remaining: 1, limit: 100, unit: "%",
    usageTrend: { kind: "bars", days: 7, points: [1, 2, 3, 4, 5, 6, 7], unit: "%" },
};
test("infrequent providers follow frequent providers in both table and mobile gallery without losing data", () => {
    const rows = [copilot, openai];
    const html = providerTableMarkup(rows, {
        infrequentProviders: new Set(['["github","subscription","GitHub Copilot Individual"]']),
        view: "all",
    });
    const table = html.slice(0, html.indexOf('<div class="provider-gallery"'));
    const tabs = html.slice(html.indexOf('<div class="provider-gallery-tabs'), html.indexOf('<div class="provider-gallery-main'));
    const cards = html.slice(html.indexOf('<div class="provider-gallery-main'));
    for (const markup of [table, tabs, cards]) {
        assert.ok(markup.indexOf("OpenAI Subscription") < markup.indexOf("GitHub Copilot Individual"));
        assert.match(markup, /is-infrequent/);
    }
    assert.match(table, /0\/200 AI credits used/);
    assert.match(table, /Critical/);
    assert.match(table, /Infrequent/);
    assert.match(cards, /Infrequent/);
    assert.match(table, /provider-usage-line/);
    assert.deepEqual(rows, [copilot, openai], "rendering must not mutate the upstream snapshot");
    assert.match(providerDailyUsageMarkup(rows), /0 AI credits/);
});
test("zero usage and missing history do not silently disable a provider", () => {
    const html = providerTableMarkup([copilot, { ...openai, usageTrend: undefined }]);
    assert.doesNotMatch(html, /is-infrequent/);
    assert.doesNotMatch(html, /role="switch"|data-provider-frequency/);
    const editing = providerTableMarkup([copilot, { ...openai, usageTrend: undefined }], { editingFrequency: true });
    assert.equal((editing.match(/data-provider-frequency="[^"]*"[^>]*checked/g) || []).length, 4);
});
test("frequency switches escape provider labels and let an infrequent provider be enabled again", () => {
    const row = { ...copilot, label: 'Plan "quoted" <private>' };
    const html = providerTableMarkup([row], {
        infrequentProviders: new Set(['["github","subscription","Plan \\"quoted\\" <private>"]']),
        editingFrequency: true,
    });
    assert.match(html, /aria-label="Frequent provider: Plan &quot;quoted&quot; &lt;private&gt;"/);
    assert.doesNotMatch(html, /<private>| disabled[ >]/);
    assert.match(html, /title="Mark as frequent"/);
    assert.equal((html.match(/data-provider-frequency="[^"]*"[^>]*checked/g) || []).length, 0);
});
test("frequency preferences survive reloads, upstream refreshes and usage mode changes", () => {
    const data = new Map();
    const storage = {
        getItem: (key) => data.get(key) ?? null,
        setItem: (key, value) => { data.set(key, value); },
    };
    assert.equal(readInfrequentProviders(storage).size, 0);
    const preferences = new Set([providerPreferenceKey(copilot)]);
    assert.equal(saveInfrequentProviders(storage, preferences), true);
    const restored = readInfrequentProviders(storage);
    const refreshed = { ...copilot, used: 15, stale: true, usageTrend: undefined };
    assert.equal(restored.has(providerPreferenceKey(refreshed)), true);
    for (const usageMode of ["token", "cash", "percentage"]) {
        assert.match(providerTableMarkup([copilot], { infrequentProviders: restored, usageMode, view: "all" }), /is-infrequent/);
    }
    restored.delete(providerPreferenceKey(copilot));
    assert.equal(saveInfrequentProviders(storage, restored), true);
    assert.doesNotMatch(providerTableMarkup([copilot], { infrequentProviders: readInfrequentProviders(storage) }), /is-infrequent/);
});
test("frequent-use only filters desktop rows and mobile slides while All retains infrequent providers", () => {
    const infrequentProviders = new Set([providerPreferenceKey(copilot)]);
    const frequent = providerTableMarkup([copilot, openai], { infrequentProviders });
    assert.match(frequent, /OpenAI Subscription/);
    assert.doesNotMatch(frequent, /GitHub Copilot Individual|provider-usage-line|data-provider-frequency/);
    const all = providerTableMarkup([copilot, openai], { infrequentProviders, view: "all" });
    for (const section of [all.slice(0, all.indexOf('<div class="provider-gallery"')), all.slice(all.indexOf('<div class="provider-gallery"'))]) {
        assert.match(section, /GitHub Copilot Individual/);
        assert.match(section, /OpenAI Subscription/);
        assert.match(section, /is-infrequent/);
        assert.doesNotMatch(section, /data-provider-frequency/);
    }
});
test("editing temporarily includes all providers and reveals switches only until editing ends", () => {
    const infrequentProviders = new Set([providerPreferenceKey(copilot)]);
    const editing = providerTableMarkup([copilot, openai], { infrequentProviders, view: "frequent", editingFrequency: true });
    assert.match(editing, /GitHub Copilot Individual/);
    assert.equal((editing.match(/role="switch"/g) || []).length, 4);
    assert.equal((editing.match(/data-provider-frequency="[^"]*"[^>]*checked/g) || []).length, 2);
    const finished = providerTableMarkup([copilot, openai], { infrequentProviders, view: "frequent" });
    assert.doesNotMatch(finished, /GitHub Copilot Individual|data-provider-frequency/);
});
test("an empty frequent-only view has an All recovery action instead of claiming credentials are missing", () => {
    const html = providerTableMarkup([copilot], { infrequentProviders: new Set([providerPreferenceKey(copilot)]) });
    assert.match(html, /No frequent providers/);
    assert.match(html, /data-providers-show-all/);
    assert.doesNotMatch(html, /No quota data|credentials|data-provider-frequency/);
});
test("overall provider visibility defaults to frequent-use only and persists the All selection", () => {
    const data = new Map();
    const storage = {
        getItem: (key) => data.get(key) ?? null,
        setItem: (key, value) => { data.set(key, value); },
    };
    assert.equal(readProviderView(storage), "frequent");
    assert.equal(saveProviderView(storage, "all"), true);
    assert.equal(readProviderView(storage), "all");
    assert.equal(saveProviderView(storage, "frequent"), true);
    assert.equal(readProviderView(storage), "frequent");
    assert.equal(readProviderView({ getItem: () => "invalid" }), "frequent");
    assert.equal(readProviderView({ getItem: () => { throw new Error("Storage blocked"); } }), "frequent");
});
test("frequency preferences do not conflate API, subscription or distinct plans", () => {
    const keys = [copilot, { ...copilot, form: "api" }, { ...copilot, label: "GitHub Copilot Business" }, openai]
        .map(providerPreferenceKey);
    assert.equal(new Set(keys).size, 4);
});
test("unavailable or malformed preference storage leaves all providers usable", () => {
    const unavailable = {
        getItem: () => { throw new Error("Storage blocked"); },
        setItem: () => { throw new Error("Storage full"); },
    };
    assert.equal(readInfrequentProviders(unavailable).size, 0);
    assert.equal(saveInfrequentProviders(unavailable, new Set([providerPreferenceKey(copilot)])), false);
    for (const contents of ["broken", "null", "{}", '[false, 42, null]']) {
        assert.equal(readInfrequentProviders({ getItem: () => contents }).size, 0);
    }
});
test("a second tab changes only its own provider without overwriting a newer stored preference", () => {
    const data = new Map();
    const storage = {
        getItem: (key) => data.get(key) ?? null,
        setItem: (key, value) => { data.set(key, value); },
    };
    const firstTab = readInfrequentProviders(storage);
    const secondTab = readInfrequentProviders(storage);
    updateProviderFrequency(storage, providerPreferenceKey(copilot), false, firstTab);
    const secondUpdate = updateProviderFrequency(storage, providerPreferenceKey(openai), false, secondTab);
    assert.deepEqual([...secondUpdate.infrequentProviders].sort(), [providerPreferenceKey(copilot), providerPreferenceKey(openai)].sort());
    const firstUpdate = updateProviderFrequency(storage, providerPreferenceKey(copilot), true, firstTab);
    assert.deepEqual([...firstUpdate.infrequentProviders], [providerPreferenceKey(openai)]);
    assert.deepEqual([...readInfrequentProviders(storage)], [providerPreferenceKey(openai)]);
});
test("changing frequency while storage is blocked preserves other in-memory preferences", () => {
    const unavailable = {
        getItem: () => { throw new Error("Storage blocked"); },
        setItem: () => { throw new Error("Storage full"); },
    };
    const current = new Set([providerPreferenceKey(copilot)]);
    const updated = updateProviderFrequency(unavailable, providerPreferenceKey(openai), false, current);
    assert.deepEqual([...updated.infrequentProviders].sort(), [providerPreferenceKey(copilot), providerPreferenceKey(openai)].sort());
    assert.equal(current.size, 1, "a preference update must not mutate a snapshot used by another view");
});
test("readable but unwritable storage preserves earlier local choices and retries saving them together", () => {
    let raw = null;
    let writable = false;
    const storage = {
        getItem: () => raw,
        setItem: (_key, value) => {
            if (!writable)
                throw new Error("Storage full");
            raw = value;
        },
    };
    const first = updateProviderFrequency(storage, providerPreferenceKey(copilot), false, new Set());
    assert.equal(first.persisted, false);
    const second = updateProviderFrequency(storage, providerPreferenceKey(openai), false, first.infrequentProviders, first.persisted);
    assert.deepEqual([...second.infrequentProviders].sort(), [providerPreferenceKey(copilot), providerPreferenceKey(openai)].sort());
    assert.equal(second.persisted, false);
    writable = true;
    const recovered = updateProviderFrequency(storage, providerPreferenceKey(copilot), true, second.infrequentProviders, second.persisted);
    assert.equal(recovered.persisted, true);
    assert.deepEqual([...readInfrequentProviders(storage)], [providerPreferenceKey(openai)]);
});
