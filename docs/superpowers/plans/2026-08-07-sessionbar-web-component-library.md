# SessionBar Web Component Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Consolidate the Web dashboard's hand-authored Tailwind into reusable local component helpers and improve the monitor hierarchy while keeping the existing data and interactions intact.

**Architecture:** Keep vanilla TypeScript and the Tailwind Play CDN. Add a root-level `webComponents.ts` module that owns class compositions, escaping, status summaries, icons, detail lists, and tabs. Add `web.css` for shared animation, scrollbar, overlay, and responsive rules that do not belong in individual templates. `app.ts` remains the state/SSE coordinator and uses the component module instead of embedding repeated long utility strings.

**Tech Stack:** Vanilla TypeScript, Tailwind Play CDN, semantic HTML, Node test runner, Playwright CLI screenshots.

## Global Constraints

- Do not change the server API, session schema, provider polling, TUI, or SSE transport.
- Preserve existing project filtering, session selection, detail tabs, Escape-to-clear, reconnect presentation, and mobile detail overlay behavior.
- The status summary must not render a horizontal progress bar or proportional segment bar.
- Keep per-session progress data in the detail inspector; only the global status summary bar is removed.
- Preserve existing dark palette values initially; improve consistency and hierarchy before introducing new colors.
- Do not overwrite unrelated uncommitted changes in the `0agentbar` worktree.

---

### Task 1: Add the local Tailwind component vocabulary

**Files:**
- Create: `webComponents.ts`
- Create: `web.css`
- Modify: `index.html` to load `web.css` and use the shared shell/panel classes
- Test: `test/webComponents.test.mjs`

**Interfaces:**
- `app.ts` consumes `UI`, `cx`, `escapeHtml`, `iconMarkup`, `statusLabel`, `countSessions`, `statusSummaryMarkup`, `detailListMarkup`, and `tabsMarkup` from `webComponents.ts`.
- `webComponents.ts` produces deterministic HTML strings and class compositions; it must not read from the DOM or mutate state.

- [ ] **Step 1: Define reusable class compositions and pure rendering helpers**

Create `webComponents.ts` with these exact exports:

```ts
export const UI: {
  app: string;
  topbar: string;
  brand: string;
  connection: string;
  connectionOffline: string;
  statusSummary: string;
  statusItem: string;
  statusValue: string;
  statusDot: string;
  toolbar: string;
  filter: string;
  filterHint: string;
  panel: string;
  panelHeader: string;
  panelTitle: string;
  panelBody: string;
  row: string;
  rowSelected: string;
  rowBlocked: string;
  empty: string;
  detailBody: string;
  detailList: string;
  detailLabel: string;
  detailValue: string;
  tab: string;
  tabActive: string;
  footer: string;
};

export function cx(...parts: Array<string | false | null | undefined>): string;
export function escapeHtml(value: string): string;
export function statusLabel(status: string): string;
export function iconMarkup(type: string, cache?: Map<string, string>): string;

export interface SessionCounts {
  total: number;
  working: number;
  blocked: number;
  error: number;
  idle: number;
}

export function countSessions(sessions: Array<{ status?: string }>): SessionCounts;
export function statusSummaryMarkup(counts: SessionCounts): string;
export function detailListMarkup(rows: Array<{ label: string; value: string }>, extraClass?: string): string;
export function tabsMarkup(tabs: string[], activeIndex: number): string;
```

`statusSummaryMarkup` must render the total and non-zero status counts as inline items separated by a text separator. It must not contain an element with `role="progressbar"`, `id="segments"`, `style="width:..."`, or a flex-based proportional segment.

- [ ] **Step 2: Add shared non-utility CSS**

Move the existing animation, scrollbar, overlay, and reduced-motion rules into `web.css`. Add only shared component behavior: focus-visible outlines, panel scroll regions, row transitions, status dot animation, mobile panel sizing, and overlay layout. Keep Tailwind utility composition in `UI`; do not create a second color system.

- [ ] **Step 3: Write focused helper tests**

Create `test/webComponents.test.mjs` using `node:test` and `node:assert/strict`:

```js
test("renders status counts without a global progress bar", () => {
  const html = statusSummaryMarkup({ total: 7, working: 1, blocked: 0, error: 0, idle: 6 });
  assert.match(html, /7/);
  assert.match(html, /1/);
  assert.match(html, /6/);
  assert.doesNotMatch(html, /progressbar|segments|width:/i);
});

test("omits zero status categories", () => {
  const html = statusSummaryMarkup({ total: 1, working: 0, blocked: 0, error: 0, idle: 1 });
  assert.doesNotMatch(html, /working|blocked|error/i);
  assert.match(html, /idle/);
});

test("escapes dynamic labels", () => {
  assert.equal(escapeHtml('<script>"x"</script>'), '&lt;script&gt;&quot;x&quot;&lt;/script&gt;');
});
```

- [ ] **Step 4: Build and run the focused tests**

Run: `npm run build && node --test test/webComponents.test.mjs`

Expected: TypeScript compilation succeeds and all focused component tests pass.

- [ ] **Step 5: Commit the component layer**

```bash
git add webComponents.ts web.css index.html test/webComponents.test.mjs
git commit -m "refactor: add web component primitives"
```

---

### Task 2: Migrate the dashboard renderer to shared components

**Files:**
- Modify: `app.ts`
- Test: `test/webComponents.test.mjs` only if a pure helper regression is discovered

**Interfaces:**
- `app.ts` imports the exact exports from Task 1.
- The existing `render`, `detailHTML`, `showMobileDetail`, and `connect` functions remain the stateful entry points.

- [ ] **Step 1: Replace duplicated utilities and icon rendering**

Remove local `FAVICONS`, `_iconCache`, `icon`, `h`, and `slabel` implementations from `app.ts`. Import `iconMarkup`, `escapeHtml`, and `statusLabel`; keep a local `iconCache` map and pass it to `iconMarkup`.

- [ ] **Step 2: Replace detail list markup**

Use `detailListMarkup` for Overview, Activity, Usage, and project detail fields. Preserve the existing labels and values. Keep the existing per-session progress bars in Overview and Activity, but style their surrounding layout through the shared detail classes.

- [ ] **Step 3: Replace global segment rendering with the text-only summary**

Remove the `segments` DOM reference and all `segments.innerHTML` code. Replace the count calculation with:

```ts
const counts = countSessions(sessions);
countsEl.innerHTML = statusSummaryMarkup(counts);
```

The resulting markup must display `7 sessions`, `1 working`, and `6 idle` inline when those are the active counts, without a progress/segment element.

- [ ] **Step 4: Migrate panel, row, tabs, and empty-state classes**

Replace long repeated template class strings with `UI.panel`, `UI.panelHeader`, `UI.row`, `UI.rowSelected`, `UI.rowBlocked`, `UI.detailBody`, `UI.empty`, and `tabsMarkup`. Add semantic `aria-label` text to status dots and preserve `data-project`, `data-sid`, and `data-tab` hooks.

- [ ] **Step 5: Build and run the existing test suite**

Run: `npm test`

Expected: existing tests pass, including the newly compiled component module. If the package test script does not include the focused component test, run `node --test test/*.test.mjs` as the explicit verification command.

- [ ] **Step 6: Commit the renderer migration**

```bash
git add app.ts
git commit -m "refactor: render dashboard with shared components"
```

---

### Task 3: Verify monitor hierarchy and responsive behavior

**Files:**
- Modify: `index.html` only for semantic labels, layout hooks, or responsive corrections found during browser verification
- Modify: `web.css` for visual corrections found during screenshot comparison
- Modify: `app.ts` only for interaction or accessible-state corrections found during browser verification

**Interfaces:**
- Browser verification consumes the running local dashboard and representative session payloads through the existing `/session/status` endpoint.
- No new API or fixture format is introduced.

- [ ] **Step 1: Start the local Web server with an isolated runtime directory**

Run from `0agentbar`:

```bash
SESSIONBAR_WEB=1 SESSIONBAR_PROVIDER_POLL=0 SESSIONBAR_CODEX_DISCOVERY_MS=1 SESSIONBAR_HOME=/private/tmp/vision-dash-sessionbar IDLE_SHUTDOWN_MS=600000 PORT=8990 node dist/server.js
```

- [ ] **Step 2: Load representative sessions**

Post seven sessions containing one `working` session and six `idle` sessions, plus at least one `blocked` or `error` session in a second pass. Confirm the UI uses the real SSE stream and does not rely on static HTML data.

- [ ] **Step 3: Capture desktop and mobile screenshots**

Use the Playwright CLI wrapper after checking `command -v npx`. Capture one desktop screenshot at approximately 1280×900 and one mobile screenshot at approximately 390×844 into a temporary QA directory. Inspect both with `view_image`.

- [ ] **Step 4: Exercise the interaction path**

Verify project click filtering, session selection, detail tab switching, Escape-to-clear, disconnected banner presentation, and mobile detail overlay. Re-snapshot after each state-changing interaction.

- [ ] **Step 5: Check the acceptance conditions**

Confirm:

- the status summary has no progress/segment bar;
- active sessions are visually more prominent than idle sessions;
- panels and rows share consistent spacing, borders, type, and focus states;
- mobile retains project/filter context and has no horizontal overflow;
- the global status summary has no accidental copy changes beyond the intended inline treatment;
- per-session detail progress remains available.

- [ ] **Step 6: Remove temporary QA artifacts and report remaining deviations**

Delete temporary screenshots created only for QA, preserve no generated artifacts in the repository unless explicitly requested, and record any intentional visual deviation in the final handoff.

