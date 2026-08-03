# SessionBar Hook Event Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the first event-first hook input layer while preserving current snapshot hook behavior.

**Architecture:** Add a small `hookEvents.ts` schema/adapter module and a pure `sessionReducer.ts`. Existing `/session/status` payloads stay accepted, but `mergeSessionPayload()` converts them into hook events before reducing into `SessionPayload`. Provider limit signals are kept as agent-level signals and do not become session token usage.

**Tech Stack:** TypeScript, Node test runner, existing Express relay and OpenTUI renderer.

---

### Task 1: Hook Event Schema

**Files:**
- Create: `hookEvents.ts`
- Test: `test/hookEvents.test.mjs`

- [ ] Write tests proving legacy snapshot payloads normalize into `session_status`, `activity_event`, and `usage_snapshot` events, and unknown native payloads normalize into an `unknown` event.
- [ ] Implement `HookEvent` union types and `sessionSnapshotToHookEvents()`.
- [ ] Verify with `npm test`.

### Task 2: Session Reducer

**Files:**
- Create: `sessionReducer.ts`
- Modify: `types.ts`
- Test: `test/sessionReducer.test.mjs`

- [ ] Write tests proving `usage_snapshot` updates session-local token fields and computes `token_rate` from deltas.
- [ ] Write tests proving `agent_signal` is preserved as agent-level data without setting session quota fields.
- [ ] Write tests proving `unknown` events are retained without blocking state updates.
- [ ] Implement reducer and minimal state fields: `agent_signals`, `unknown_events`.
- [ ] Verify with `npm test`.

### Task 3: Snapshot Compatibility Wiring

**Files:**
- Modify: `sessionPayload.ts`
- Test: `test/sessionPayload.test.mjs`

- [ ] Write/update tests proving existing `/session/status` snapshot merge behavior still preserves current session fields.
- [ ] Route `mergeSessionPayload()` through `sessionSnapshotToHookEvents()` and `reduceSessionEvents()`.
- [ ] Keep legacy `quota_percent` / `quota_reset` snapshot fields compatible for now, but do not derive them from `agent_signal`.
- [ ] Verify with `npm test`.

### Task 4: Final Verification

**Files:**
- All implementation files above.

- [ ] Run `npm test`.
- [ ] Inspect `git diff --stat`.
- [ ] Confirm no unrelated dirty files were reverted or reformatted.
