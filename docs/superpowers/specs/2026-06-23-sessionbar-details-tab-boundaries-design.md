# SessionBar Details Tab Boundaries Design

Date: 2026-06-23

## Purpose

This design refines the Details module from the 2026-06-22 checkpoint. The earlier checkpoint explored a richer inspector with a Primary Stage and Priority Rail. The current direction is more constrained: Details is a terminal-sized inspector panel, not a full dashboard.

The goal is to make each Details tab answer a different question without duplicating the same state in different visual styles.

## Core Constraints

- SessionBar has no model intelligence.
- Hooks and integrations provide deterministic snapshots and events.
- The UI must not invent lifecycle nodes, future steps, or inferred workflow structure.
- Long text should not destabilize the right-side terminal panel.
- The minimum monitored unit remains session.
- Missing metrics render as quiet placeholders, not fake values.

## Details Model

The Details module keeps the existing local scope bar:

```text
Overview | Activity | Usage | Flow | Raw
```

`Flow` replaces the previous broad `Events` label for this refinement because it better names the future visual graph/workflow role. If the implementation keeps `Events` for compatibility, the responsibility is the same as `Flow`.

The shared header remains compact:

```text
Agent | session-handle | status | freshness | project
```

The full raw session ID belongs in Raw or explicit copy/inspect affordances, not in the normal header.

## Tab Responsibilities

### Overview

Overview is the default tab. It answers:

```text
What is this session doing right now?
```

Overview should be compact and readable in the right-side inspector panel. It should not include a workflow graph or long event stream.

Content:

- current state card
- latest reliable running or completed activity
- freshness/source signal
- compact pressure or usage strip
- attention/alert summary when present

The state card may use a visually distinct status badge, but the content should stay factual:

```text
WORK
running: wait agent
last done: git diff --stat HEAD
source: hook snapshot
```

### Activity

Activity answers:

```text
What happened recently in this session?
```

Activity is a short history view, not a console emulator and not a workflow graph.

Content:

- recent history events
- optional plan signal when a deterministic plan/checklist exists
- short event labels, ages, and summaries

Example:

```text
Plan
  now   refine Details tab design
  next  write spec after approval

History
  run   wait agent                  now
  done  git diff --stat HEAD        33s
  user  需要很多 refine              2m
```

Rules:

- Do not show a fixed `Session path` module.
- Do not show guessed nodes like `next` unless they come from a real plan/checklist source.
- Do not duplicate the Overview state card.
- Do not include long command output. Long tails belong in Raw.

### Usage

Usage answers:

```text
How much context, token, turn, or quota pressure exists?
```

This pass only commits the boundary, not the final layout. Usage may be sparse at first. Sparse data is acceptable if the layout remains stable.

Content candidates:

- context percentage or placeholder
- input/output/cache tokens when available
- turn count
- rate or recent token delta when available
- quota/reset information when provided by integrations

### Flow

Flow answers:

```text
How are structured events connected?
```

This is where the previous fancy connection graph belongs.

Flow can show a compact graph, loop, Mermaid-like representation, or other visual relationship view, but only when the event stream provides enough structure to determine nodes and edges.

Rules:

- Do not draw inferred future nodes.
- Do not force all agents into one fake lifecycle.
- If the event data is insufficient, fall back to a plain event list.
- Future workflow/loop visualization belongs here, not in Overview or Activity.

Example when structure is known:

```text
user_turn -> tool_start -> tool_done -> agent_update -> running
```

Example fallback:

```text
33s done  git diff --stat HEAD
34s done  git diff --name-only HEAD
1m  agent npm test passed
```

### Raw

Raw answers:

```text
What exact data did SessionBar receive?
```

Raw owns verbosity.

Content:

- full command output tail
- complete event payloads
- raw hook snapshots
- full session ID
- debug-only fields

Raw may be noisy and scrollable. It should not influence the layout or density of Overview and Activity.

## Removed Module: Session Path

The fixed `Session path` module is removed from the design.

It looked like:

```text
start
user turn
tool done
running
next
```

Reasons:

- It repeats history events in another visual style.
- It consumes space in a small terminal panel.
- It implies a universal lifecycle that different agents may not share.
- `next` is often a prediction, and SessionBar must not infer predictions.

If hooks later provide a real workflow graph, it should appear in Flow.

## Data Rules

- Snapshot data drives Overview.
- Event data drives Activity and Flow.
- Raw text is displayed in Raw and should not be parsed as state unless an integration explicitly defines that parser.
- Agent-specific adapters inside SessionBar may normalize hook facts into the shared session model.
- Normalization must be deterministic and testable.

## Layout Rules

- Details must fit a right-side terminal panel.
- Tabs should not assume a full browser dashboard width.
- Long content must truncate, wrap in controlled areas, or move to Raw.
- Header and scope bar stay stable across tabs.
- Overview and Activity should not show the same facts with different decoration.
- Flow is optional/fallback-driven, so it must not be required for a useful Details view.

## Testing Implications

Implementation should include tests for:

- Overview renders current state from snapshot data.
- Activity renders recent events without adding a fixed Session path.
- Activity shows plan signal only when deterministic plan data exists.
- Flow renders a graph only when structured nodes/edges are available.
- Flow falls back to an event list when structure is missing.
- Raw contains long output and raw payloads that are excluded from Overview and Activity.
- Missing usage metrics render placeholders without breaking layout.
- Long session IDs do not expand the header or sidebar.

## Non-Goals

- Implementing Mermaid or graph rendering in this pass.
- Finalizing Usage layout.
- Finalizing exact glyphs, colors, or animation.
- Parsing natural-language agent text as state.
- Adding model-based summarization.
