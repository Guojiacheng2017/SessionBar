# Session Runtime Sampling Design

## Goal

Make runtime resource data stable across hook events and SessionBar server restarts, while keeping Web and TUI resource semantics honest and easy to read.

## Root cause

`report.sh` currently samples one process only when a hook fires. The server keeps that snapshot only in memory and exits after 30 seconds without a client. On restart, session markers restore session identity but not the process root or runtime sample. This produces intermittent `Waiting for runtime samples` states and under-counts child processes.

## Architecture

The hook owns process discovery; the server owns resource sampling.

- `report.sh` resolves the owning agent PID, posts it as `process_pid`, and stores it in a sidecar marker next to the existing session marker. Explicit integration-provided runtime values remain accepted, but the hook no longer invokes `ps` to create its own automatic snapshot.
- The server restores `process_pid` from the sidecar after restart and runs one non-overlapping process-table sample every two seconds.
- Each sample reads the process table once, finds every registered root PID and descendant, and computes CPU, resident memory, memory percentage, and process count. GPU remains unknown unless an integration explicitly provides it.
- Runtime updates do not change session activity timestamps. A missing/dead root removes the server-generated runtime snapshot so stale data is never shown as current.
- Sampling and parsing live in a focused `runtimeSampler.ts` module; server lifecycle wiring remains in `server.ts`.

## Data contract

`SessionPayload` gains optional `process_pid: number`. It must be a positive integer. `runtime` remains optional and keeps the existing snapshot shape.

The PID sidecar uses the same marker suffix as the session marker:

```text
sessionbar-id-<scope>       # existing session id
sessionbar-process-<scope>  # one positive integer PID
```

Removing or pruning a session marker also removes its paired process marker.

## Resource semantics

- CPU is the sum of `ps %cpu` for the root and descendants, matching familiar per-process CPU semantics.
- Memory bytes is the sum of RSS for the tree. Memory percent is that total divided by host physical memory.
- Process count is the number of live processes in the tree.
- GPU is not fabricated. It stays unavailable unless reported by a platform/integration adapter.

## Web presentation

- Zero samples: keep the waiting state, but it should now be short-lived only when no PID is known or the process has ended.
- One sampled session: cells show actual usage (`22%`, `196 MB`, `1 process`) and use capacity bars for CPU/GPU/MEM. The UI must not claim `100% contribution` merely because only one sample exists.
- Two or more sampled sessions: retain the contribution matrix. Each cell shows that session's share of the row total; the row label shows the aggregate actual usage.

## TUI presentation

Keep fixed-width progress bars. They consume the same server snapshots as Web and do not use contribution percentages or sparklines.

## Failure handling

- Invalid PIDs are rejected at the payload boundary and ignored in marker recovery.
- A sampling command failure leaves the previous sample intact for that tick and retries on the next interval.
- A successful process-table read that cannot find a registered active PID clears that session's server-generated snapshot.
- Sampling passes never overlap.

## Verification

- Unit tests cover process-table parsing, descendant aggregation, dead roots, and per-tick session updates.
- Payload and shell tests cover PID validation, reporting, persistence, and cleanup.
- Web tests distinguish single-session actual usage from multi-session contribution mode.
- Existing TUI runtime-bar tests remain green.
- Full build/tests, shell syntax validation, and rendered browser checks complete the change.
