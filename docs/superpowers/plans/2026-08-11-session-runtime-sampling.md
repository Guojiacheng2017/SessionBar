# Stable Session Runtime Sampling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move runtime measurement from hook-triggered snapshots to restart-safe, periodic server sampling of each active session's process tree.

**Architecture:** The hook reports and persists a root PID. A pure runtime sampler parses one host process-table snapshot and derives each registered session tree's CPU, RSS, memory percentage, and process count. `server.ts` schedules non-overlapping samples and updates SSE state; Web switches between single-session actual usage and multi-session contribution views.

**Tech Stack:** Bash 3.2-compatible hook, Node.js child processes and `os.totalmem`, TypeScript, Express/SSE, Node test runner, plain HTML/CSS components.

## Global Constraints

- Preserve all unrelated dirty-worktree changes.
- Do not invent GPU usage; keep it unavailable unless an integration reports it.
- Runtime sampling must not update session activity timestamps.
- Read the process table once per sampling interval, not once per session.
- The default sampling interval is 2,000 ms and passes may not overlap.
- Web shows actual utilization for one sample and contribution shares only for two or more samples.
- TUI keeps fixed-width progress bars.

---

### Task 1: Persist and validate the session process root

**Files:**
- Modify: `types.ts`
- Modify: `sessionPayload.ts`
- Modify: `report.sh`
- Modify: `sessionMarkers.ts`
- Test: `test/sessionPayload.test.mjs`
- Test: `test/reportSh.test.mjs`
- Test: `test/sessionMarkers.test.mjs`

**Interfaces:**
- Produces: `SessionPayload.process_pid?: number`
- Produces: `sessionbar-process-<scope>` sidecar containing one positive integer
- Produces: paired cleanup from `removeSessionMarkerFiles` and `pruneSessionMarkerFiles`

- [ ] **Step 1: Write failing payload tests**

```js
assert.equal(validateSessionPayload({ ...basePayload, process_pid: 4242 }), true);
assert.equal(validateSessionPayload({ ...basePayload, process_pid: 0 }), false);
assert.equal(validateSessionPayload({ ...basePayload, process_pid: 1.5 }), false);
assert.equal(mergeSessionPayload(prev, { ...basePayload }, now).process_pid, 4242);
```

- [ ] **Step 2: Write failing hook and marker tests**

Run `report.sh` with `SESSIONBAR_PROCESS_PID=4242`; assert the POST contains `process_pid: 4242`, the sidecar contains `4242\n`, and deletion/pruning removes both files.

- [ ] **Step 3: Verify RED**

Run: `npm test -- --test-name-pattern='process root|process marker|process_pid'`

Expected: FAIL because the payload field and sidecar lifecycle do not exist.

- [ ] **Step 4: Add the minimal contract and sidecar implementation**

Add `process_pid?: number` to `SessionPayload`; validate positive integers and preserve the previous PID when omitted. In `report.sh`, resolve the override or owning agent ancestor, atomically write the sidecar, add `process_pid` to `EXTRA_FIELDS`, and remove hook-local automatic `ps` sampling. Keep explicitly supplied runtime overrides valid. Extend marker cleanup to remove the paired process marker.

- [ ] **Step 5: Verify GREEN**

Run: `npm test -- --test-name-pattern='process root|process marker|process_pid'`

- [ ] **Step 6: Commit the isolated change**

```bash
git add types.ts sessionPayload.ts report.sh sessionMarkers.ts test/sessionPayload.test.mjs test/reportSh.test.mjs test/sessionMarkers.test.mjs
git commit -m "feat: persist session process roots"
```

### Task 2: Build the process-tree sampler

**Files:**
- Create: `runtimeSampler.ts`
- Create: `test/runtimeSampler.test.mjs`

**Interfaces:**
- Produces: `parseProcessTable(text: string): ProcessRecord[]`
- Produces: `sampleProcessTree(records, rootPid, totalMemoryBytes, sampledAt): SessionRuntimeSnapshot | undefined`
- Produces: `sampleRegisteredProcesses(roots, options?): Promise<Map<number, SessionRuntimeSnapshot>>`

- [ ] **Step 1: Write failing parser and tree tests**

```js
const records = parseProcessTable(`100 1 12.5 1000\n101 100 7.5 2000\n102 101 2.0 3000\n`);
assert.deepEqual(sampleProcessTree(records, 100, 100_000_000, 1234), {
  cpu_percent: 22,
  memory_bytes: 6_144_000,
  memory_percent: 6.144,
  process_count: 3,
  sampled_at: 1234,
});
assert.equal(sampleProcessTree(records, 999, 100_000_000, 1234), undefined);
```

- [ ] **Step 2: Verify RED**

Run: `npm run build && node --test test/runtimeSampler.test.mjs`

Expected: FAIL because `runtimeSampler.js` does not exist.

- [ ] **Step 3: Implement pure parsing and aggregation**

Parse `pid ppid %cpu rss` rows, reject malformed records, traverse descendants without double-counting, sum CPU and RSS, convert RSS KiB to bytes, and derive memory percentage from host memory.

- [ ] **Step 4: Implement one-command host sampling**

Use `execFile("ps", ["-axo", "pid=,ppid=,%cpu=,rss="], ...)` once, then reuse the parsed records for every root. Return an empty map when no roots exist and reject command errors so the caller can preserve its last snapshot.

- [ ] **Step 5: Verify GREEN and edge cases**

Run: `npm run build && node --test test/runtimeSampler.test.mjs`

Cover malformed lines, zero total memory, missing roots, and descendant cycles.

- [ ] **Step 6: Commit the isolated change**

```bash
git add runtimeSampler.ts test/runtimeSampler.test.mjs
git commit -m "feat: sample session process trees"
```

### Task 3: Own runtime sampling in the server lifecycle

**Files:**
- Modify: `server.ts`
- Test: `test/serverRuntime.test.mjs`

**Interfaces:**
- Consumes: `sampleRegisteredProcesses(roots, options)` from Task 2
- Produces: `applyRuntimeSamples(sessions, samples, sampledRoots): boolean`
- Produces: direct-run interval controlled by `SESSIONBAR_RUNTIME_SAMPLE_MS`, default `2000`

- [ ] **Step 1: Write failing state-update tests**

Create active, idle, sampled, and dead-root sessions. Assert active sessions receive samples without changing `timestamp`; idle sessions are excluded; dead active roots lose stale server snapshots; unchanged metrics do not report a visible change solely because `sampled_at` advanced.

- [ ] **Step 2: Verify RED**

Run: `npm run build && node --test test/serverRuntime.test.mjs`

Expected: FAIL because no server runtime updater exists.

- [ ] **Step 3: Restore process roots and add the sampling loop**

Read each process sidecar during recovery. Collect unique active PIDs, skip overlapping passes, apply returned snapshots, and broadcast SSE only when metrics or availability changed. Start the loop with the HTTP server and clear it in `cleanup()`.

- [ ] **Step 4: Verify GREEN**

Run: `npm run build && node --test test/serverRuntime.test.mjs`

- [ ] **Step 5: Commit the isolated change**

```bash
git add server.ts test/serverRuntime.test.mjs
git commit -m "feat: continuously sample active session resources"
```

### Task 4: Correct single-sample and contribution semantics

**Files:**
- Modify: `runtimeUsage.ts`
- Modify: `webComponents.ts`
- Modify: `web.css`
- Test: `test/runtimeUsage.test.mjs`
- Test: `test/webComponents.test.mjs`

**Interfaces:**
- Consumes: continuously refreshed `SessionPayload.runtime`
- Produces: `runtimeContributionsMarkup` with actual mode for one sample and contribution mode for multiple samples

- [ ] **Step 1: Write failing single-sample Web test**

```js
const html = runtimeContributionsMarkup([workingSession({
  cpu_percent: 22,
  memory_percent: 1,
  memory_bytes: 196 * 1024 * 1024,
  process_count: 1,
})]);
assert.match(html, /current usage/);
assert.match(html, />22%</);
assert.doesNotMatch(html, /100% contribution/);
assert.match(html, />1 process</);
```

- [ ] **Step 2: Verify RED**

Run: `npm run build && node --test test/webComponents.test.mjs test/runtimeUsage.test.mjs`

Expected: FAIL because the one-column matrix currently converts every nonzero value to a 100% share.

- [ ] **Step 3: Implement both display modes**

For one sample, use CPU/GPU/MEM percentages as fill widths and show real values in cells. Render process count as a neutral count cell without a percentage fill. For two or more samples, retain row-normalized shares and include exact values in labels/tooltips.

- [ ] **Step 4: Verify GREEN**

Run: `npm run build && node --test test/webComponents.test.mjs test/runtimeUsage.test.mjs test/openTuiMonitorLayout.test.mjs`

- [ ] **Step 5: Commit the isolated change**

```bash
git add runtimeUsage.ts webComponents.ts web.css test/runtimeUsage.test.mjs test/webComponents.test.mjs
git commit -m "fix: distinguish usage from runtime contribution"
```

### Task 5: Full verification and rendered QA

**Files:**
- Verify only; do not commit generated screenshots or temporary scripts.

**Interfaces:**
- Consumes: complete Tasks 1-4 implementation
- Produces: test, shell, and rendered evidence

- [ ] **Step 1: Run automated verification**

```bash
npm test
bash -n report.sh
git diff --check
```

- [ ] **Step 2: Verify the live flow at `http://127.0.0.1:8989`**

The flow under test is: an active hook session registers a PID -> the server samples it without another hook -> Details / Runtime replaces waiting with current usage -> a second sampled session switches the matrix to contribution mode.

- [ ] **Step 3: Check browser health**

Verify page identity, meaningful DOM, no framework overlay, no relevant console errors, desktop screenshot evidence, and at least one live state transition.

- [ ] **Step 4: Inspect the final diff**

Confirm no unrelated dirty-worktree changes were staged, removed, or reformatted.
