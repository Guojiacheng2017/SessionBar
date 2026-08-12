# System Efficiency Monitor Design

## Goal

Replace SessionBar's costly and unreliable per-session process-tree sampling with a low-overhead system health snapshot. The monitor should show the machine's overall CPU, load, memory, and network activity together with the SessionBar server's own CPU and memory usage.

The sampling path must remain independent from session discovery and UI rendering so a metric update cannot trigger a Codex rollout scan or a full session broadcast.

## Scope

The first version exposes:

- total system CPU utilization
- load averages for 1, 5, and 15 minutes
- used and total physical memory, plus utilization percentage
- aggregate network download and upload throughput
- SessionBar server CPU utilization and resident memory
- sample timestamp and freshness

Disk, battery, GPU, top processes, and per-session resource attribution are out of scope.

## Architecture

Add one long-lived `SystemSampler` owned by the server process.

- It samples once every two seconds by default.
- Sampling passes never overlap.
- It stores only the latest immutable snapshot in memory.
- HTTP, TUI, and Web consumers read that cached snapshot; they never execute system commands themselves.
- Updating the snapshot does not call session sorting, session discovery, or the session SSE broadcaster.
- Session discovery remains event-driven where possible and uses its own bounded refresh schedule.

The sampler captures cumulative counters and derives rates between consecutive samples. The first sample may omit CPU and network rates because no prior baseline exists.

## Collection Strategy

Prefer direct Node and operating-system interfaces for stable values:

- `os.cpus()` cumulative CPU times for total CPU utilization
- `os.loadavg()` for load averages
- `os.totalmem()` and `os.freemem()` for physical memory
- `process.cpuUsage()` and `process.memoryUsage().rss` for SessionBar itself

Network throughput needs platform-specific cumulative interface counters. On macOS, use one bounded adapter that reads interface byte counters and sums eligible non-loopback interfaces. The adapter returns cumulative receive/transmit bytes; the sampler computes bytes per second from elapsed monotonic time.

The network collector must have a timeout, tolerate unsupported platforms, and avoid shell pipelines. A failed network read leaves network rates unavailable for that sample without discarding CPU, memory, or server metrics.

## Data Contract

Introduce a server-level snapshot instead of embedding runtime data in each session:

```ts
interface SystemEfficiencySnapshot {
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

Expose the cached snapshot through a dedicated endpoint such as `GET /system`, or include it in a monitor-specific aggregate response. Do not attach identical host metrics to every `SessionPayload`.

## Retiring Per-session Runtime Sampling

Remove the server timer that executes `ps -axo pid=,ppid=,%cpu=,rss=` and the process-tree aggregation path.

- Stop using `process_pid` to drive automatic resource sampling.
- Remove automatic per-session `runtime` values and contribution calculations from monitor views.
- Retain backward-compatible payload parsing only if external hooks can still send these fields during a transition; they must not affect system sampling or discovery.
- Remove obsolete marker recovery and tests once no supported integration depends on them.

This explicitly avoids claiming that a shared terminal, agent subprocess, or reused PID belongs to one specific session.

## Monitor Presentation

Replace the current runtime panel with a compact `System` panel inspired by Mole's status presentation while preserving SessionBar's existing monitor theme.

For detail panels at least 64 columns wide, use a balanced dashboard layout:

- a quiet `SYSTEM / HOST` heading with sample freshness aligned to the right
- side-by-side CPU and memory metrics with prominent percentages, fixed-width bars, and semantic health colors
- a three-column load-average row labelled `1 min`, `5 min`, and `15 min`
- one network row that visually separates download and upload throughput
- one SessionBar row that shows server CPU and resident memory together

The dashboard is rendered as styled OpenTUI text within the existing details panel. It does not add nested bordered boxes, mouse handling, animation, history buffers, or another rendering loop. The current system snapshot remains the only data source.

For detail panels narrower than 64 columns, retain the compact fixed-row layout so the sessions sidebar and details panel remain usable:

- `CPU` with percentage and a fixed-width bar
- `Load` with 1m, 5m, and 15m values
- `Memory` with percentage, used/total values, and a fixed-width bar
- `Network` with down/up rates
- `SessionBar` with server CPU and RSS
- `Sample` with relative freshness or an unavailable state

All rows are width-bounded before they reach OpenTUI. Numeric changes must not alter panel geometry, and missing metrics render as unavailable values without collapsing a section.

The project/session/details hierarchy remains unchanged. System health is global context and must not be repeated in session details.

## Refresh and Rendering

Sampling, transport, and painting have separate clocks:

- sampler: two seconds
- session discovery: independent and slower/bounded
- UI animation/input: controlled by the TUI framework

The TUI compares the new system snapshot and session model with the previously rendered model. It requests a render only when visible data, selection, terminal size, or input state changes. A timer tick alone must not force a full redraw.

The Web page may poll the lightweight system endpoint or use a dedicated metrics event. System metric events must not reuse the session SSE path if that path sorts or refreshes sessions.

## Failure Handling

- A collector failure never terminates the server.
- A failed sample preserves the last good snapshot and exposes its increasing age.
- Counter resets, interface changes, negative deltas, and invalid elapsed time produce unavailable rates for one sample rather than negative throughput.
- CPU and percentage values are finite and clamped to valid ranges.
- The sampling timer is stopped during normal server shutdown.

## Verification

- Unit tests cover CPU deltas, network deltas, counter resets, first-sample behavior, memory calculations, process CPU deltas, and failed collectors.
- Server tests prove repeated system samples do not invoke session discovery, sorting, or session SSE broadcasts.
- Lifecycle tests prove only one non-overlapping sampler runs and shutdown clears it.
- TUI tests cover fixed panel geometry, unavailable values, and render suppression for unchanged snapshots.
- Energy verification compares the server before and after under the same session count, confirming removal of the two-second full-process-table spike.

## Migration Sequence

1. Add and test the standalone system sampler and data contract.
2. Expose the cached snapshot without touching the session response path.
3. Replace the TUI runtime panel with the system panel.
4. Update the Web consumer if it still exposes runtime metrics.
5. Remove per-session process sampling, marker recovery, aggregation code, and obsolete tests.
6. Profile the resulting server and verify discovery no longer runs because a metric changed.
