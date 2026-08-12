# System Efficiency Monitor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace per-session process-tree sampling with a cached, two-second system efficiency snapshot covering CPU, load, memory, network, and SessionBar server usage.

**Architecture:** A focused `systemSampler.ts` reads cumulative OS counters and derives rates without knowing about sessions. `server.ts` owns one non-overlapping sampler and exposes its cached value through `/system/live`; TUI and Web consumers read that value independently from session discovery and render only changed visible models.

**Tech Stack:** TypeScript 5.7, Node.js 22 APIs, Express 5, OpenTUI 0.4, Node test runner, macOS `netstat` adapter

## Global Constraints

- Sample once every two seconds by default, with no overlapping passes.
- Never invoke session discovery, session sorting, session SSE, or iCloud sync because a system metric changed.
- Do not execute full process-table commands for runtime monitoring.
- Use direct Node APIs for CPU, load, memory, and SessionBar process metrics.
- Network collection must be bounded, exclude loopback, tolerate unsupported platforms, and return unavailable data on failure.
- Keep the existing SessionBar monitoring theme and project/session/details hierarchy.
- Preserve unrelated uncommitted changes in `app.ts`, `cli.ts`, `landingMenu.ts`, Web files, and their tests.

---

## File Map

- Create `systemSampler.ts`: pure counter calculations, macOS network adapter, and the stateful non-overlapping sampler.
- Create `test/systemSampler.test.mjs`: deterministic CPU, network, memory, process, failure, and overlap tests.
- Modify `types.ts`: add the server-level `SystemEfficiencySnapshot` contract.
- Modify `server.ts`: own cached system state, lifecycle, and `/system/live`; remove per-session sampling lifecycle.
- Replace `test/serverRuntime.test.mjs` with server-level system endpoint and isolation tests after preserving any marker recovery coverage that is not runtime-specific.
- Modify `cli.ts`: fetch the lightweight system endpoint and pass snapshots to the monitor.
- Modify `openTuiMonitor.ts`: store and render the fixed `System` panel and suppress unchanged redraws.
- Modify `test/openTuiMonitorLayout.test.mjs`: verify system panel geometry and formatting.
- Modify `test/cliLifecycle.test.mjs`: verify system fetch wiring and shutdown behavior.
- Modify `app.ts`, `webComponents.ts`, `web.css`, and `test/webComponents.test.mjs`: replace the per-session runtime matrix with one system health section while preserving current local edits.
- Delete `runtimeSampler.ts`, `runtimeUsage.ts`, `test/runtimeSampler.test.mjs`, and `test/runtimeUsage.test.mjs` after all imports are removed.
- Modify `sessionMarkers.ts`, `sessionPayload.ts`, `report.sh`, `types.ts`, and related tests only to remove obsolete automatic PID/runtime persistence; retain transitional payload acceptance if shell integrations still explicitly send runtime data.

---

### Task 1: Standalone System Sampler

**Files:**
- Create: `systemSampler.ts`
- Create: `test/systemSampler.test.mjs`
- Modify: `types.ts`

**Interfaces:**
- Produces: `SystemEfficiencySnapshot` in `types.ts`.
- Produces: `CpuTimes`, `NetworkCounters`, `SystemSampleInput`, and `deriveSystemSnapshot(previous, current)` in `systemSampler.ts`.
- Produces: `createSystemSampler(options): { sample(): Promise<SystemEfficiencySnapshot | undefined>; latest(): SystemEfficiencySnapshot | undefined; stop(): void }`.

- [ ] **Step 1: Add failing deterministic delta tests**

Create tests that use two synthetic observations and assert the exact contract:

```js
const first = observation({
  monotonic_ms: 1_000,
  cpu: { idle: 700, total: 1_000 },
  network: { received_bytes: 10_000, transmitted_bytes: 4_000 },
  process_cpu_micros: 1_000_000,
});
const second = observation({
  monotonic_ms: 3_000,
  cpu: { idle: 800, total: 1_400 },
  network: { received_bytes: 14_000, transmitted_bytes: 5_000 },
  process_cpu_micros: 1_500_000,
});
const snapshot = deriveSystemSnapshot(first, second);
assert.equal(snapshot.cpu_percent, 75);
assert.equal(snapshot.network_down_bytes_per_second, 2_000);
assert.equal(snapshot.network_up_bytes_per_second, 500);
assert.equal(snapshot.server_cpu_percent, 25);
```

Also assert first-sample rates are `undefined`, negative/reset counters are unavailable, memory percentage is clamped, network failure does not erase other metrics, and a second `sample()` call made during an unresolved first call returns without starting another collection.

- [ ] **Step 2: Run the focused test and confirm failure**

Run: `npm run build && node --test test/systemSampler.test.mjs`

Expected: FAIL because `systemSampler.js` and `SystemEfficiencySnapshot` do not exist.

- [ ] **Step 3: Add the snapshot type and pure derivation functions**

Add this exact type to `types.ts`:

```ts
export interface SystemEfficiencySnapshot {
  cpu_percent?: number;
  load_average: [number, number, number];
  memory_used_bytes: number;
  memory_total_bytes: number;
  memory_percent: number;
  network_down_bytes_per_second?: number;
  network_up_bytes_per_second?: number;
  server_cpu_percent?: number;
  server_memory_bytes: number;
  sampled_at: number;
}
```

Implement deltas using monotonic elapsed time. Sum every field from `os.cpus()[].times`, use `(totalDelta - idleDelta) / totalDelta`, and use `process.cpuUsage()` microseconds divided by elapsed microseconds for SessionBar CPU.

- [ ] **Step 4: Implement the bounded macOS network collector**

Use `execFile("netstat", ["-ibn"], { encoding: "utf8", timeout: 750, maxBuffer: 1024 * 1024 })`. Parse the header positions for `Name`, `Ibytes`, and `Obytes`; for each non-loopback interface retain the maximum valid cumulative counters seen across its address rows, then sum interfaces. On unsupported platforms or command failure, return `undefined`.

- [ ] **Step 5: Implement the stateful non-overlapping sampler**

`sample()` captures Node CPU/load/memory/process values even if network collection fails, derives from the prior observation, stores the latest immutable snapshot, and clears its in-flight guard in `finally`. `stop()` prevents future scheduled work but does not own a timer yet.

- [ ] **Step 6: Run focused tests and typecheck**

Run: `npm run build && node --test test/systemSampler.test.mjs`

Expected: PASS, including overlap and counter reset cases.

- [ ] **Step 7: Commit**

```bash
git add types.ts systemSampler.ts test/systemSampler.test.mjs
git commit -m "feat: add low-overhead system sampler"
```

---

### Task 2: Server Cache and Isolated Endpoint

**Files:**
- Modify: `server.ts`
- Modify: `test/serverRuntime.test.mjs`

**Interfaces:**
- Consumes: `createSystemSampler()` and `SystemEfficiencySnapshot` from Task 1.
- Produces: `parseSystemSampleMs(value): number` and `GET /system/live` returning `{ system: SystemEfficiencySnapshot | null }`.

- [ ] **Step 1: Replace runtime server tests with system lifecycle tests**

Keep interval validation but rename it for `SESSIONBAR_SYSTEM_SAMPLE_MS`. Start an isolated server with a fake `netstat` executable or injected fixture and assert:

```js
const body = await fetch(`${baseUrl}/system/live`).then(response => response.json());
assert.equal(typeof body.system.memory_total_bytes, "number");
assert.equal(typeof body.system.server_memory_bytes, "number");
assert.equal(Array.isArray(body.system.load_average), true);
```

Add an isolation assertion by recording Codex session directory reads or an exported discovery counter, fetching `/system/live` repeatedly across two samples, and asserting the discovery count does not increase because of sampling.

- [ ] **Step 2: Run the server test and confirm failure**

Run: `npm run build && node --test test/serverRuntime.test.mjs`

Expected: FAIL because `/system/live` does not exist and the old runtime timer still runs.

- [ ] **Step 3: Wire one cached sampler into server lifecycle**

Replace `RUNTIME_SAMPLE_MS`, `runtimeSampleInterval`, and `sampleSessionRuntimes()` with:

```ts
const SYSTEM_SAMPLE_MS = parseSystemSampleMs(process.env.SESSIONBAR_SYSTEM_SAMPLE_MS);
const systemSampler = createSystemSampler();
let systemSampleInterval: NodeJS.Timeout | undefined;

async function sampleSystem(): Promise<void> {
  await systemSampler.sample();
}
```

Start one immediate sample plus `setInterval` only in direct-run mode. Cleanup clears the interval and calls `systemSampler.stop()`.

- [ ] **Step 4: Add the cache-only endpoint**

Implement:

```ts
app.get("/system/live", (_req, res) => {
  res.json({ system: systemSampler.latest() ?? null });
});
```

Do not call `sorted()`, `refreshCodexSessions()`, `broadcastSSE()`, or `syncToICloud()` from the sampler or endpoint.

- [ ] **Step 5: Remove the per-session sampling path from `server.ts`**

Delete `sampleRegisteredProcesses` import, `applyRuntimeSamples`, `activeRuntimeRoots`, `sampleSessionRuntimes`, and their timer state. Leave session discovery behavior otherwise unchanged in this task.

- [ ] **Step 6: Run focused server tests**

Run: `npm run build && node --test test/serverRuntime.test.mjs test/sessionMarkers.test.mjs`

Expected: PASS; no full `ps` process table is spawned.

- [ ] **Step 7: Commit**

```bash
git add server.ts test/serverRuntime.test.mjs
git commit -m "feat: expose cached system efficiency metrics"
```

---

### Task 3: TUI System Panel and Stable Rendering

**Files:**
- Modify: `cli.ts`
- Modify: `openTuiMonitor.ts`
- Modify: `test/openTuiMonitorLayout.test.mjs`
- Modify: `test/cliLifecycle.test.mjs`

**Interfaces:**
- Consumes: `GET /system/live` from Task 2.
- Produces: `fetchSystem(): Promise<SystemEfficiencySnapshot | undefined>` in monitor options.
- Produces: `systemOverviewText(snapshot, width, now?): string`.
- Produces: a stable visible-model fingerprint used to suppress unchanged `requestRender()` calls.

- [ ] **Step 1: Add failing formatter and render-suppression tests**

Assert a fixed six-row panel with deterministic values:

```js
const text = systemOverviewText({
  cpu_percent: 37.5,
  load_average: [3.19, 3.9, 3.44],
  memory_used_bytes: 12.8 * GIB,
  memory_total_bytes: 16 * GIB,
  memory_percent: 80,
  network_down_bytes_per_second: 80_000,
  network_up_bytes_per_second: 10_000,
  server_cpu_percent: 1.8,
  server_memory_bytes: 79 * MIB,
  sampled_at: 10_000,
}, 44, 11_000);
assert.match(text, /CPU.*37\.5%/);
assert.match(text, /Load.*3\.19.*3\.90.*3\.44/);
assert.match(text, /Network.*80\.0 KB\/s.*10\.0 KB\/s/);
assert.equal(text.split("\n").length, 6);
```

Add a render harness assertion that two identical state updates invoke `requestRender()` once, while a changed selection or snapshot invokes it again.

- [ ] **Step 2: Run focused TUI tests and confirm failure**

Run: `npm run build && node --test test/openTuiMonitorLayout.test.mjs test/cliLifecycle.test.mjs`

Expected: FAIL because system data is not part of monitor state.

- [ ] **Step 3: Fetch system state independently in `cli.ts`**

Add `${API_BASE}/system/live` and parse only a structurally valid snapshot. Pass `fetchSystem` into `runOpenTuiMonitor`; do not append system metrics to each session. Fetch sessions and system data concurrently with `Promise.allSettled` so a metrics failure cannot hide session data.

- [ ] **Step 4: Replace the runtime overview with a fixed System panel**

Add `system?: SystemEfficiencySnapshot` to `MonitorState`. When no project or session is selected, render `systemOverviewText` in the right details panel and title it `Details / System`. Use fixed-width bars from the existing palette and stable labels `CPU`, `Load`, `Memory`, `Network`, `SessionBar`, and `Sample`.

- [ ] **Step 5: Separate data polling from repainting**

Remove the unconditional render call driven by the `renderMs` tick. Route input, resize, session fetch completion, provider fetch completion, and changed system fetch completion through one `update()` that computes a visible fingerprint. Call `updateRefs()` and `renderer.requestRender()` only when that fingerprint differs; do not include raw wall-clock milliseconds in the fingerprint.

Freshness text changes only at whole-second boundaries and can schedule one lightweight display update per second without fetching data or rebuilding session discovery.

- [ ] **Step 6: Run focused TUI tests**

Run: `npm run build && node --test test/openTuiMonitorLayout.test.mjs test/openTuiMonitorKeys.test.mjs test/cliLifecycle.test.mjs`

Expected: PASS with fixed geometry and no render on unchanged state.

- [ ] **Step 7: Commit without absorbing unrelated local edits**

Review `git diff -- cli.ts` carefully and stage only this task's hunks if pre-existing edits remain.

```bash
git add openTuiMonitor.ts test/openTuiMonitorLayout.test.mjs
git add -p cli.ts test/cliLifecycle.test.mjs
git commit -m "feat: show stable system health in monitor"
```

---

### Task 4: Web System Health and Runtime Code Retirement

**Files:**
- Modify: `app.ts`
- Modify: `webComponents.ts`
- Modify: `web.css`
- Modify: `test/webComponents.test.mjs`
- Modify: `sessionPayload.ts`
- Modify: `sessionMarkers.ts`
- Modify: `report.sh`
- Modify: `test/sessionPayload.test.mjs`
- Modify: `test/sessionMarkers.test.mjs`
- Modify: `test/reportSh.test.mjs`
- Delete: `runtimeSampler.ts`
- Delete: `runtimeUsage.ts`
- Delete: `test/runtimeSampler.test.mjs`
- Delete: `test/runtimeUsage.test.mjs`

**Interfaces:**
- Consumes: `SystemEfficiencySnapshot` and `/system/live`.
- Produces: `systemEfficiencyMarkup(snapshot): string`.
- Retires: automatic `process_pid` sidecars and per-session runtime aggregation.

- [ ] **Step 1: Add failing Web system component tests**

Replace runtime matrix expectations with one global section:

```js
const html = systemEfficiencyMarkup(snapshot);
assert.match(html, /System/);
assert.match(html, /CPU/);
assert.match(html, /Memory/);
assert.match(html, /Network/);
assert.match(html, /SessionBar/);
assert.doesNotMatch(html, /runtime-matrix-session/);
```

Also test `undefined` snapshot renders `System metrics unavailable` without an empty per-session contribution grid.

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `npm run build && node --test test/webComponents.test.mjs test/sessionPayload.test.mjs test/sessionMarkers.test.mjs test/reportSh.test.mjs`

Expected: FAIL until the Web renderer and transitional payload behavior are updated.

- [ ] **Step 3: Replace the Web runtime matrix**

Fetch `/system/live` on the existing dashboard refresh schedule and render a compact global health band using semantic meter rows. Keep current uncommitted provider-icon and layout edits. Remove runtime contribution CSS only after `rg "runtime-contributions|runtime-matrix"` finds no remaining imports or markup.

- [ ] **Step 4: Remove automatic PID persistence and reporting**

Stop writing or recovering `sessionbar-process-*` files. Remove automatic process PID lookup from `report.sh`. Keep explicit `runtime` payload parsing for one compatibility cycle only when fields are supplied by an integration; document through tests that these values are accepted but ignored by the system monitor.

- [ ] **Step 5: Delete obsolete modules and tests**

Delete `runtimeSampler.ts`, `runtimeUsage.ts`, and their focused tests after replacing all production imports. Run:

```bash
rg -n "sampleRegisteredProcesses|aggregateRuntimeUsage|runtimeOverviewText|sessionbar-process-" . --glob '!docs/**'
```

Expected: no production references.

- [ ] **Step 6: Run affected tests**

Run: `npm run build && node --test test/webComponents.test.mjs test/sessionPayload.test.mjs test/sessionMarkers.test.mjs test/reportSh.test.mjs`

Expected: PASS with system-level presentation and no PID sidecar creation.

- [ ] **Step 7: Commit while preserving unrelated dirty hunks**

```bash
git add -p app.ts webComponents.ts web.css test/webComponents.test.mjs
git add sessionPayload.ts sessionMarkers.ts report.sh test/sessionPayload.test.mjs test/sessionMarkers.test.mjs test/reportSh.test.mjs
git add -u runtimeSampler.ts runtimeUsage.ts test/runtimeSampler.test.mjs test/runtimeUsage.test.mjs
git commit -m "refactor: retire per-session runtime monitoring"
```

---

### Task 5: Full Verification and Energy Regression Check

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-08-12-system-efficiency-monitor-design.md` only if verified behavior differs from the approved design.

**Interfaces:**
- Verifies all interfaces produced by Tasks 1-4.

- [ ] **Step 1: Run static and full automated verification**

Run:

```bash
npm run build
npm test
sh -n report.sh
git diff --check
```

Expected: all commands exit zero.

- [ ] **Step 2: Verify no old high-frequency process scan remains**

Run:

```bash
rg -n "ps -axo|PROCESS_TABLE_ARGS|SESSIONBAR_RUNTIME_SAMPLE_MS|startRuntimeSampling|runtimeSampleInterval" . --glob '!docs/**'
```

Expected: no matches.

- [ ] **Step 3: Verify endpoint isolation manually**

Start the server with a temporary `SESSIONBAR_HOME`, request `/system/live` repeatedly for at least six seconds, and confirm the response updates while server logs show no Codex discovery triggered by those requests. Request `/sessions/live` separately and confirm session discovery still returns sessions.

- [ ] **Step 4: Compare process impact over matching samples**

With one active project and the monitor open, collect at least ten one-second observations of the SessionBar server using macOS `top -pid <pid> -l 10 -s 1 -stats pid,cpu,mem,power`. Confirm there is no repeating spike caused by `ps -axo`, record median CPU and POWER, and compare against the recorded pre-change spikes of approximately 28% CPU / 28 POWER.

- [ ] **Step 5: Exercise TUI stability**

Open the monitor for at least 30 seconds at a fixed terminal size. Confirm no full-screen flicker, selection remains stable across system samples, the project/session/details hierarchy still works, and changing CPU/network values do not resize panel rows.

- [ ] **Step 6: Update user-facing documentation**

Document the global System panel, two-second cached sampling, supported macOS network rates, and removal of per-session process attribution. Do not claim disk, battery, GPU, or per-session resource metrics.

- [ ] **Step 7: Commit final verification documentation**

```bash
git add README.md docs/superpowers/specs/2026-08-12-system-efficiency-monitor-design.md
git commit -m "docs: document system efficiency monitoring"
```
