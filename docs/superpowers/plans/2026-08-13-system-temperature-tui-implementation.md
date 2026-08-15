# System Temperature TUI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add cached device and battery temperatures to `Details / System`, split network download/upload into separate rows, and remove the SessionBar self-usage row.

**Architecture:** A server-side macOS collector reads optional CPU/SoC temperature from an installed `macmon` binary and battery temperature from `ioreg`, caching results for 30 seconds. The existing two-second `SystemSampler` incorporates cached optional fields into `SystemEfficiencySnapshot`; OpenTUI renders them responsively without new UI timers or animation.

**Tech Stack:** TypeScript, Node `execFile`, macOS `macmon`/`ioreg`, `@opentui/core`, Node test runner.

## Global Constraints

- Never invoke `sudo`, install a sensor dependency, or infer Celsius from thermal pressure.
- Temperature commands are bounded and run no more than once per 30 seconds.
- Missing or failed sources render as `—` and preserve the last valid cached value.
- Keep `server_cpu_percent` and `server_memory_bytes` in the API for compatibility, but do not render them in TUI System details.
- Render `DOWNLOAD` and `UPLOAD` as separate rows at every supported width.
- Preserve the current transparent background, semantic palette, visible-model deduplication, and two-second system sampling cadence.
- Preserve all unrelated uncommitted runtime-port, settings, quota, Web, and CLI changes.

---

### Task 1: Cached macOS Temperature Collector

**Files:**
- Create: `temperatureCollector.ts`
- Create: `test/temperatureCollector.test.mjs`

**Interfaces:**
- Produces: `TemperatureReadings`, `parseMacmonTemperature()`, `parseBatteryTemperature()`, and `createTemperatureCollector()`.
- Consumes: optional `macmon` JSON and `AppleSmartBattery.Temperature` output.

- [x] **Step 1: Write failing parser and cache tests**

Cover valid/invalid macmon JSON, battery hundredths-of-a-degree conversion, non-darwin no-op behavior, 30-second command throttling, partial source failures, and preservation of the last valid value.

- [x] **Step 2: Run the focused test and verify failure**

Run: `npm run build && node --test test/temperatureCollector.test.mjs`

Expected: FAIL because `temperatureCollector.ts` does not exist.

- [x] **Step 3: Implement the bounded collector**

Use `execFile` directly with no shell. Run `macmon pipe -s 1 -i 1000` and `/usr/sbin/ioreg -l -r -c AppleSmartBattery -w 0` concurrently, enforce command timeouts/max buffers, validate plausible Celsius values, and cache attempts for 30 seconds.

- [x] **Step 4: Run the focused test and verify pass**

Run: `npm run build && node --test test/temperatureCollector.test.mjs`

Expected: all collector tests PASS.

### Task 2: System Snapshot Temperature Contract

**Files:**
- Modify: `types.ts:78-112`
- Modify: `systemSampler.ts:15-335`
- Modify: `test/systemSampler.test.mjs`
- Modify: `test/webComponents.test.mjs:220-230`

**Interfaces:**
- Consumes: `createTemperatureCollector(): () => Promise<TemperatureReadings | undefined>`.
- Produces: optional `device_temperature_celsius` and `battery_temperature_celsius` fields in `SystemEfficiencySnapshot` and `/system/live`.

- [x] **Step 1: Write failing snapshot and validation tests**

Assert that temperatures flow into derived snapshots, transient missing readings preserve the previous values, valid optional temperatures pass `isSystemEfficiencySnapshot`, and non-finite temperatures fail validation.

- [x] **Step 2: Run focused tests and verify failure**

Run: `npm run build && node --test test/systemSampler.test.mjs test/webComponents.test.mjs`

Expected: FAIL because the contract and sampler do not expose temperature fields.

- [x] **Step 3: Extend the contract and sampler**

Add both optional finite-number fields, initialize one cached collector per sampler, collect it alongside network counters, and carry the last valid temperature through transient failures. Do not change server polling or renderer clocks.

- [x] **Step 4: Run focused tests and verify pass**

Run: `npm run build && node --test test/systemSampler.test.mjs test/webComponents.test.mjs`

Expected: all focused tests PASS.

### Task 3: Temperature and Split Network TUI

**Files:**
- Modify: `openTuiMonitor.ts:740-940`
- Modify: `test/openTuiMonitorLayout.test.mjs:20-110`

**Interfaces:**
- Consumes: optional temperature fields from `SystemEfficiencySnapshot`.
- Produces: wide 15-row System dashboard and compact 8-row fallback with no SessionBar row.

- [x] **Step 1: Write failing responsive-layout tests**

At 84 columns assert `DEVICE / CPU`, `BATTERY`, `DOWNLOAD`, and `UPLOAD` are separate lines and `SESSIONBAR` is absent. At 44 and 32 columns assert stable eight-row output, width bounds, separate network rows, temperature rows, and no self-usage row.

- [x] **Step 2: Run focused tests and verify failure**

Run: `npm run build && node --test test/openTuiMonitorLayout.test.mjs`

Expected: FAIL because the current panel still renders one Network row and one SessionBar row.

- [x] **Step 3: Implement responsive temperature presentation**

Format finite values with one decimal and `°C`. Use green/yellow/red device thresholds at 70/85°C and battery thresholds at 35/45°C. Keep unavailable values muted, preserve StyledText/plain-text parity, and do not add renderables, timers, or animation.

- [x] **Step 4: Run focused tests and verify pass**

Run: `npm run build && node --test test/openTuiMonitorLayout.test.mjs`

Expected: all layout tests PASS.

### Task 4: Verification

**Files:**
- Verify all modified files; do not stage unrelated changes.

- [x] **Step 1: Run formatting and full tests**

Run: `git diff --check` and `npm test`.

Expected: no whitespace errors and all tests PASS.

- [x] **Step 2: Verify live cached temperatures**

Build and restart the local SessionBar server, confirm `/system/live` returns plausible optional temperatures, then launch the TUI and inspect wide and compact System details.

- [x] **Step 3: Review energy boundary**

Confirm collector tests prove at most one command pair per 30 seconds and source inspection shows no new interval, renderer loop, or session discovery trigger.

### Task 5: Clarify Load Average in TUI and Web

**Files:**
- Modify: `openTuiMonitor.ts`
- Modify: `webComponents.ts`
- Modify: `web.css`
- Modify: `test/openTuiMonitorLayout.test.mjs`
- Modify: `test/webComponents.test.mjs`

- [x] **Step 1: Add failing presentation tests**

Assert that 1m, 5m, and 15m values render on separate rows in both interfaces and that an always-visible explanation identifies them as running or CPU-waiting tasks to compare with CPU cores.

- [x] **Step 2: Implement the shared information hierarchy**

Replace the horizontal triple with one compact vertical load group. Keep the full explanation in WebUI and a width-safe equivalent in compact TUI layouts; do not add hover-only help, timers, or new sampling behavior.

- [x] **Step 3: Run focused and full verification**

Run the two layout/component test files, `git diff --check`, and the full test suite.
