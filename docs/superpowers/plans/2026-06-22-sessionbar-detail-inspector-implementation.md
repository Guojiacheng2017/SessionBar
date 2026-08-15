# SessionBar Detail Inspector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the approved SessionBar selected-session inspector in the OpenTUI monitor: compact session sidebar, unread update markers, Details Scope Bar, and a visual Overview with Primary Stage plus Priority Rail.

**Architecture:** Put deterministic inspector formatting and unread-state transitions in a pure `sessionInspector.ts` module with Node tests. Wire those helpers into `openTuiMonitor.ts` so OpenTUI owns layout/navigation while the helper module owns session-derived display content. Keep hooks/model behavior deterministic and avoid natural-language inference.

**Tech Stack:** TypeScript ES modules, Node built-in `node:test`, OpenTUI `@opentui/core`, existing Express session relay.

---

## File Structure

- Create `sessionInspector.ts`: pure helpers for session fingerprints, unread tracking, scope-tab navigation, session handles, and detail content rendering.
- Create `test/sessionInspector.test.mjs`: Node test suite that imports compiled helpers from `dist/sessions/sessionInspector.js`.
- Modify `package.json`: add `npm test` using the existing TypeScript build plus Node's built-in test runner.
- Modify `openTuiMonitor.ts`: add `detailTab`, unread state, scope-tab key handling, compact unread sidebar markers, details panel sizing, and inspector content.
- Leave `server.ts`, `report.sh`, and `types.ts` data contracts unchanged unless the tests expose a compile requirement.
- Regenerate `dist/` by running `npm run build`.

## Task 1: Add Inspector Tests And Helper Module

**Files:**
- Create: `test/sessionInspector.test.mjs`
- Create: `sessionInspector.ts`
- Modify: `package.json`

- [x] **Step 1: Add the failing test file and test script**

`package.json` should contain:

```json
"scripts": {
  "build": "tsc",
  "start": "node dist/cli/cli.js",
  "test": "npm run build && node --test test/sessionInspector.test.mjs"
}
```

Create `test/sessionInspector.test.mjs` with these tests:

```js
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSessionDetailContent,
  detailTabByNumber,
  nextDetailTab,
  sessionFingerprint,
  sessionHandle,
  updateUnreadSessionState,
} from "../dist/sessions/sessionInspector.js";

const baseSession = {
  session_id: "codex-019ed3a2-a7ab-7a90-a6da-c1535a35afd0__Vision-Dash",
  session_type: "Codex",
  status: "working",
  task_name: "running: npm run build",
  activity_tail: ["tool: npm run build", "done: apply patch"],
  context_percent: 72,
  tokens: 1700000,
  turns: 34,
  timestamp: 1_700_000_000_000,
  project: "Vision-Dash",
  project_path: "/Users/jcus/Documents/Jcus/Vision-Dash",
};

test("session handles are compact and stable for sidebar use", () => {
  assert.equal(sessionHandle(baseSession, 18), "019ed3a2-a7...afd0");
  assert.equal(sessionHandle({ ...baseSession, session_id: "claude-demo-abc123__Vision-Dash" }, 12), "demo-abc123");
});

test("unread state ignores initial load, marks changed unselected sessions, and clears focused session", () => {
  const initial = updateUnreadSessionState({
    previousFingerprints: new Map(),
    previousUnread: new Set(),
    initialized: false,
    sessions: [baseSession],
    selectedSessionId: baseSession.session_id,
  });
  assert.equal(initial.initialized, true);
  assert.deepEqual([...initial.unreadSessionIds], []);

  const changed = { ...baseSession, task_name: "running: npm test", timestamp: baseSession.timestamp + 1 };
  const marked = updateUnreadSessionState({
    previousFingerprints: initial.fingerprints,
    previousUnread: initial.unreadSessionIds,
    initialized: initial.initialized,
    sessions: [changed],
    selectedSessionId: null,
  });
  assert.equal(marked.unreadSessionIds.has(baseSession.session_id), true);

  const cleared = updateUnreadSessionState({
    previousFingerprints: marked.fingerprints,
    previousUnread: marked.unreadSessionIds,
    initialized: marked.initialized,
    sessions: [changed],
    selectedSessionId: baseSession.session_id,
  });
  assert.deepEqual([...cleared.unreadSessionIds], []);
});

test("overview renders one workflow primary stage with a fixed priority rail", () => {
  const content = buildSessionDetailContent(baseSession, "overview", 88, baseSession.timestamp + 37_000);
  assert.match(content, /Overview \| Activity \| Usage \| Events \| Raw/);
  assert.match(content, /WORKFLOW CHAIN/);
  assert.match(content, /running: npm run build/);
  assert.match(content, /PRIORITY RAIL/);
  assert.match(content, /Activity/);
  assert.match(content, /Pressure/);
  assert.match(content, /Status/);
});

test("alerts outrank activity in overview priority rail", () => {
  const content = buildSessionDetailContent(
    { ...baseSession, status: "error", task_name: "TypeScript build failed" },
    "overview",
    88,
    baseSession.timestamp + 37_000,
  );
  assert.ok(content.indexOf("Attention") < content.indexOf("Activity"));
});

test("scope tabs cycle and numeric keys map deterministically", () => {
  assert.equal(nextDetailTab("overview", 1), "activity");
  assert.equal(nextDetailTab("raw", 1), "overview");
  assert.equal(nextDetailTab("overview", -1), "raw");
  assert.equal(detailTabByNumber("3"), "usage");
  assert.equal(detailTabByNumber("9"), null);
});

test("raw tab includes full session id while overview keeps it compact", () => {
  const overview = buildSessionDetailContent(baseSession, "overview", 88, baseSession.timestamp + 37_000);
  const raw = buildSessionDetailContent(baseSession, "raw", 88, baseSession.timestamp + 37_000);
  assert.equal(overview.includes(baseSession.session_id), false);
  assert.equal(raw.includes(baseSession.session_id), true);
});

test("fingerprints change on deterministic snapshot fields", () => {
  assert.notEqual(
    sessionFingerprint(baseSession),
    sessionFingerprint({ ...baseSession, tokens: baseSession.tokens + 1 }),
  );
});
```

- [x] **Step 2: Run the tests and verify RED**

Run:

```bash
npm test
```

Expected: failure because `dist/sessions/sessionInspector.js` does not exist yet.

- [x] **Step 3: Create the pure helper module**

Create `sessionInspector.ts` with:

```ts
import type { SessionPayload } from "./types.js";

export type DetailTab = "overview" | "activity" | "usage" | "events" | "raw";

export const DETAIL_TABS: readonly DetailTab[] = ["overview", "activity", "usage", "events", "raw"];

export interface UnreadUpdateInput {
  previousFingerprints: ReadonlyMap<string, string>;
  previousUnread: ReadonlySet<string>;
  initialized: boolean;
  sessions: readonly SessionPayload[];
  selectedSessionId: string | null;
}

export interface UnreadUpdateResult {
  fingerprints: Map<string, string>;
  unreadSessionIds: Set<string>;
  initialized: boolean;
}

export function sessionFingerprint(session: SessionPayload): string;
export function updateUnreadSessionState(input: UnreadUpdateInput): UnreadUpdateResult;
export function sessionHandle(session: SessionPayload, max?: number): string;
export function nextDetailTab(current: DetailTab, delta: number): DetailTab;
export function detailTabByNumber(value: string): DetailTab | null;
export function buildSessionDetailContent(session: SessionPayload, tab: DetailTab, width: number, now?: number): string;
```

The implementation must:

- fingerprint only deterministic payload fields: `session_id`, `session_type`, `status`, `task_name`, `activity_tail`, `progress`, `context_percent`, `tokens`, `turns`, `timestamp`, `project`, `project_path`;
- treat first load as already seen;
- mark changed sessions unread only when they are not the selected session;
- clear unread when the changed or existing session is selected;
- keep Overview compact by using `sessionHandle` instead of full IDs;
- put full IDs only in Raw;
- render Overview as a two-column text layout with `WORKFLOW CHAIN` left and `PRIORITY RAIL` right when width allows, falling back to stacked sections on narrow widths.

- [x] **Step 4: Run tests and verify GREEN**

Run:

```bash
npm test
```

Expected: all `sessionInspector` tests pass.

## Task 2: Wire Inspector Into OpenTUI

**Files:**
- Modify: `openTuiMonitor.ts`
- Generated by build: `dist/tui/openTuiMonitor.js`, `dist/sessions/sessionInspector.js`, `dist/shared/types.js`, `dist/cli/cli.js`, `dist/server/server.js`

- [x] **Step 1: Add state fields and imports**

`openTuiMonitor.ts` imports:

```ts
import {
  buildSessionDetailContent,
  detailTabByNumber,
  nextDetailTab,
  sessionHandle,
  updateUnreadSessionState,
  type DetailTab,
} from "./sessionInspector.js";
```

`MonitorState` gains:

```ts
detailTab: DetailTab;
sessionFingerprints: Map<string, string>;
unreadSessionIds: Set<string>;
unreadInitialized: boolean;
```

Initial state uses:

```ts
detailTab: "overview",
sessionFingerprints: new Map(),
unreadSessionIds: new Set(),
unreadInitialized: false,
```

- [x] **Step 2: Make the session sidebar compact and update-aware**

`SessionRow` gains:

```ts
unread: boolean;
```

`sessionRows()` uses:

```ts
session: sessionHandle(session, sessionIdColumnMax(renderer)),
marker: selected ? ">" : state.unreadSessionIds.has(session.session_id) ? "*" : "",
unread: state.unreadSessionIds.has(session.session_id),
```

`sessionTableContent()` uses bold attributes when selected or unread:

```ts
const attrs = selected || row.unread ? TextAttributes.BOLD : TextAttributes.NONE;
```

The table remains one row per session and does not add task/activity columns.

- [x] **Step 3: Clear unread on focus and track changes on fetch**

At the end of `clampState()`, remove the selected session from unread:

```ts
const unreadSessionIds = new Set(state.unreadSessionIds);
if (selectedId) unreadSessionIds.delete(selectedId);
return { ...state, projectCursorKey, projectFocusKey, selectedIdx, selectedId, detailId, unreadSessionIds };
```

`fetchIntoState()` computes unread transitions before clamping:

```ts
const unread = updateUnreadSessionState({
  previousFingerprints: state.sessionFingerprints,
  previousUnread: state.unreadSessionIds,
  initialized: state.unreadInitialized,
  sessions: nextSessions,
  selectedSessionId: state.selectedId,
});
return clampState({
  ...state,
  sessions: nextSessions,
  errorMsg: result.error,
  sessionFingerprints: unread.fingerprints,
  unreadSessionIds: unread.unreadSessionIds,
  unreadInitialized: unread.initialized,
});
```

- [x] **Step 4: Add Details Scope Bar navigation**

Key handling supports:

```ts
Tab or ] -> next detail tab
[ -> previous detail tab
1..5 -> Overview, Activity, Usage, Events, Raw
```

The footer in project-focus mode mentions:

```text
Tab detail tab  1-5 scope
```

- [x] **Step 5: Render the modular Details inspector**

When a session is selected:

```ts
const detailWidth = estimatedDetailsWidth(renderer);
const details = buildSessionDetailContent(selected, state.detailTab, detailWidth);
refs.detailsBox.title = `Details / Session · ${titleCase(state.detailTab)}`;
refs.detailsText.content = details;
```

When no session is selected, project details remain available.

Change the lower body flex ratio so sessions behave like a sidebar:

```ts
sessionsBox.flexGrow = 1;
detailsBox.flexGrow = 2;
```

- [x] **Step 6: Run build and tests**

Run:

```bash
npm test
npm run build
```

Expected: both commands complete successfully.

## Task 3: Manual Smoke Verification

**Files:**
- No source files unless smoke verification exposes a bug.

- [x] **Step 1: Render static helper output for narrow and wide widths**

Run:

```bash
node -e "import('./dist/sessions/sessionInspector.js').then(({buildSessionDetailContent})=>{const s={session_id:'codex-demo-1234567890__Vision-Dash',session_type:'Codex',status:'working',task_name:'running: npm run build',activity_tail:['tool: npm run build'],context_percent:72,tokens:1700000,turns:34,timestamp:Date.now()-37000,project:'Vision-Dash',project_path:'/Users/jcus/Documents/Jcus/Vision-Dash'}; console.log(buildSessionDetailContent(s,'overview',88)); console.log('--- narrow ---'); console.log(buildSessionDetailContent(s,'overview',44));})"
```

Expected: wide output has Primary Stage plus Priority Rail; narrow output stacks sections without full raw session ID.

- [x] **Step 2: Check final status**

Run:

```bash
git status --short
```

Expected: only intentional implementation files are modified or created.

## Self-Review Checklist

- Spec coverage: sidebar unread markers, scope tabs, overview primary stage, priority rail, full IDs only in Raw, deterministic no-model state are covered.
- Placeholder scan: no unresolved placeholder markers should remain in the plan.
- Type consistency: `DetailTab`, `UnreadUpdateInput`, and `buildSessionDetailContent()` are defined before OpenTUI uses them.
- TDD order: tests and `npm test` RED happen before `sessionInspector.ts` production implementation.
