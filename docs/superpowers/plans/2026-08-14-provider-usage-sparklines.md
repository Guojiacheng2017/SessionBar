# Provider Usage Sparklines Implementation Plan

**Goal:** Add a compact Usage column between Level and Reset without changing the existing Providers table layout.

**Architecture:** Persist one rolling daily history per provider row in SessionBar's home directory. Derive seven-day consumption bars from balance decreases or used-counter increases, and derive a 30-day cumulative line for GitHub Copilot. Attach normalized trend data to provider rows before sending `/providers/live`; render dependency-free CSS bars or inline SVG.

**Tech Stack:** TypeScript, Node.js filesystem APIs, server-rendered HTML strings, CSS, Node test runner.

---

### Task 1: Define and calculate provider usage history

**Files:**
- Create: `providerUsageHistory.ts`
- Modify: `planTypes.ts`
- Test: `test/providerUsageHistory.test.mjs`

1. Add failing tests for seven-day balance/used deltas, reset-safe clamping, and a 30-day Copilot series.
2. Add `ProviderUsageTrend` to `PlanRow`.
3. Implement stable row keys, local-day buckets, rolling persistence, and trend decoration.
4. Run the focused history tests.

### Task 2: Feed history from provider refreshes

**Files:**
- Modify: `server.ts`
- Test: `test/serverProviders.test.mjs`

1. Add a failing aggregation/decorating integration assertion.
2. Record current provider rows after every provider refresh.
3. Decorate `/providers/live` rows from the persisted history.
4. Keep session advisor rows free of presentation-only history.

### Task 3: Render the inline Usage column

**Files:**
- Modify: `webComponents.ts`
- Modify: `web.css`
- Test: `test/webComponents.test.mjs`

1. Add failing markup tests for column order, exactly seven bars, a 30-day line, and missing-data placeholders.
2. Render CSS bars for seven-day subscription/API use and an inline SVG line for Copilot.
3. Shift Reset and Card right by updating the six-column grid; hide Usage/Reset/Card together on narrow screens.
4. Add accessible labels/tooltips without visible chart values or axes.

### Task 4: Verify

**Files:**
- Verify: all changed files

1. Run focused tests.
2. Run `npm test`.
3. Inspect the generated markup/CSS and, if the app browser can reach the dynamic local port, visually validate light/dark themes and responsive behavior.
