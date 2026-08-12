# Rich System TUI Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the sparse wide-screen `Details / System` text block with the approved balanced dashboard while preserving the compact narrow-terminal view and current sampling cost.

**Architecture:** Keep `/system/live`, `SystemEfficiencySnapshot`, polling, and render suppression unchanged. Build a deterministic responsive text layout in `openTuiMonitor.ts`; wide panels receive an OpenTUI `StyledText` presentation with semantic colors, while panels below 64 columns keep the six-row compact string.

**Tech Stack:** TypeScript, `@opentui/core` `StyledText`/`TextChunk`, Node test runner.

## Global Constraints

- Use only the existing `SystemEfficiencySnapshot`; do not add samplers, timers, history, animation, or mouse handling.
- Wide dashboard threshold is 64 detail-content columns.
- Every generated line must fit the supplied detail-content width.
- Missing metrics remain visible as unavailable values and never collapse layout geometry.
- Preserve the existing transparent/system-following background and current palette.
- Do not modify the user's unrelated Web or CLI changes.

---

### Task 1: Responsive System Dashboard

**Files:**
- Modify: `openTuiMonitor.ts:734-808`
- Test: `test/openTuiMonitorLayout.test.mjs:59-84`

**Interfaces:**
- Consumes: `SystemEfficiencySnapshot`, `truncatePlain()`, `StyledText`, `TextChunk`, and the existing `PALETTE`/`chunk()` helpers.
- Produces: `systemOverviewText(snapshot, width, now): string` with compact and wide layouts, plus `systemOverviewContent(snapshot, width, now): string | StyledText` for the visible model.

- [x] **Step 1: Write failing wide-layout and styled-content tests**

Add `systemOverviewContent` to the test import and add assertions equivalent to:

```js
test("system overview uses the balanced dashboard at wide widths", () => {
  const lines = systemOverviewText(systemSnapshot(), 84, 11_000).split("\n");
  assert.match(lines[0], /SYSTEM \/ HOST.*LIVE 1s/);
  assert.match(lines[2], /CPU \/ HOST.*MEMORY/);
  assert.match(lines[3], /37\.5%.*80\.0%/);
  assert.match(lines[7], /LOAD AVERAGE/);
  assert.match(lines[8], /1 min.*5 min.*15 min/);
  assert.match(lines.at(-2), /NETWORK.*80\.0 KB\/s.*10\.0 KB\/s/);
  assert.match(lines.at(-1), /SESSIONBAR.*1\.8%.*79 MB/);
  assert.ok(lines.every(line => line.length <= 84));
});

test("wide system overview uses styled OpenTUI content without changing text", () => {
  const content = systemOverviewContent(systemSnapshot(), 84, 11_000);
  assert.equal(typeof content, "object");
  assert.equal(content.chunks.map(chunk => chunk.text).join(""), systemOverviewText(systemSnapshot(), 84, 11_000));
  assert.ok(content.chunks.some(chunk => chunk.fg));
});
```

Keep the existing 44- and 32-column six-row tests unchanged so they define the compact fallback contract.

- [x] **Step 2: Run the focused test and verify failure**

Run: `npm run build && node --test test/openTuiMonitorLayout.test.mjs`

Expected: FAIL because `systemOverviewContent` is not exported and the 84-column output still uses six rows.

- [x] **Step 3: Implement deterministic compact and wide layouts**

In `openTuiMonitor.ts`, introduce a `SYSTEM_DASHBOARD_MIN_WIDTH = 64` constant and helpers with these signatures:

```ts
function systemOverviewLines(
  snapshot: SystemEfficiencySnapshot | undefined,
  width: number,
  now: number,
): string[];

function systemMetricColor(value: number | undefined): PaletteColor;

export function systemOverviewContent(
  snapshot: SystemEfficiencySnapshot | undefined,
  width?: number,
  now?: number,
): string | StyledText;
```

For `width < 64`, return the current six rows exactly. For wider values, build fixed-width paired columns with `padEnd()` and `truncatePlain()` and render this stable order:

```text
SYSTEM / HOST                                                    LIVE 1s

CPU / HOST                         MEMORY
37.5%                              80.0%
███████░░░░░░░░░░░                ███████████████░░░
NORMAL                             12.8 GB / 16 GB

LOAD AVERAGE
1 min  3.19           5 min  3.90          15 min  3.44
────────────────────────────────────────────────────────────────────────
NETWORK     down 80.0 KB/s                         up 10.0 KB/s
SESSIONBAR  CPU 1.8%                               MEM 79 MB
```

Color CPU and memory values/bars green below 70%, yellow from 70% through 89.9%, and red at 90% or above. Color freshness green through 5 seconds, yellow through 15 seconds, and red afterward. Use `PALETTE.muted` for labels and unavailable values. Construct a `StyledText` only for the wide layout and ensure its concatenated chunk text exactly matches `systemOverviewText()`.

- [x] **Step 4: Integrate styled content into the visible model**

Change the global-system branch in `monitorVisibleModel()` from:

```ts
: systemOverviewText(state.system, detailWidth, now);
```

to:

```ts
: systemOverviewContent(state.system, detailWidth, now);
```

Do not change `nextVisibleFreshnessDelay()`, `createIndependentMonitorRefresh()`, or renderer FPS/timer configuration.

- [x] **Step 5: Run focused tests and verify pass**

Run: `npm run build && node --test test/openTuiMonitorLayout.test.mjs`

Expected: all layout tests PASS, including compact six-row behavior, wide dashboard geometry, StyledText/plain-text parity, and visible-model fingerprint behavior.

- [x] **Step 6: Run the complete test suite**

Run: `npm test`

Expected: all tests PASS.

- [x] **Step 7: Inspect the TUI at desktop and narrow widths**

Run the existing CLI against the local server, confirm `Details / System` matches the approved A layout at a wide terminal, resize below the 64-column detail threshold, and confirm the compact six-row fallback remains readable without overlap.

- [x] **Step 8: Commit the implementation**

```bash
git add openTuiMonitor.ts test/openTuiMonitorLayout.test.mjs docs/superpowers/plans/2026-08-12-rich-system-tui-dashboard-implementation.md
git commit -m "feat: enrich system tui dashboard"
```
