# SessionBar Refine Resume Checkpoint

Date: 2026-06-22

## Current State

Work stopped during a TDD refine pass for the OpenTUI SessionBar UI.

Completed in this pass:

- Details Overview no longer exposes wireframe labels:
  - removed visible `Header:`
  - removed visible `Scope:`
  - removed `PRIMARY STAGE`
  - removed `PRIORITY RAIL`
- Session sidebar formatter was added:
  - `buildSessionSidebarLine()`
  - compact line shape like `> WORK 019ed3a2-a7...afd0 37s`
  - avoids repeated Project/Agent/Status table columns
- OpenTUI session list was wired to the compact sidebar line.
- Tests were green at 10 passing tests after those changes.

## Exact Stop Point

The latest edit added this new RED test in `test/sessionInspector.test.mjs`:

```js
test("workflow overview does not invent synthetic lifecycle events", () => {
  const content = buildSessionDetailContent(baseSession, "overview", 88, baseSession.timestamp + 37_000);
  assert.doesNotMatch(content, /session_start|tool_start/);
  assert.match(content, /tool: npm run build/);
  assert.match(content, /done: apply patch/);
});
```

This test has not been run yet because the user asked to save state and stop.

Expected next step after resume:

```bash
npm test
```

Expected result:

- RED failure because `sessionInspector.ts` still emits synthetic lifecycle text:
  - `session_start -> tool_start -> running`

Then implement the minimal fix:

- Remove invented workflow lifecycle text from `primaryStageLines()`.
- Use only deterministic hook/session data:
  - `task_name`
  - `activity_tail`
  - status/freshness/usage metrics

## Files Involved

- `sessionInspector.ts`
- `openTuiMonitor.ts`
- `test/sessionInspector.test.mjs`

## User Direction To Preserve

- Need many refinements.
- Follow TDD.
- Do not let design/wireframe labels leak into TUI content.
- Sidebar should be a compact monitor list, not a repeated table.
- SessionBar has no model capability; do not infer or invent workflow events.
