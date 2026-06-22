# SessionBar Detail Inspector Design Checkpoint

Date: 2026-06-22

## Purpose

SessionBar is a high-density, deterministic monitor for local multi-agent coding sessions. The current design checkpoint focuses on the selected-session experience: how the outer session list, the Details module, and the Details Overview view should relate.

This is not an implementation plan. It captures the product and UI direction that has been agreed so far, plus the areas intentionally left open for later design.

## Core Constraints

- SessionBar does not have model intelligence. It must not infer state from natural-language text.
- Hooks and agent integrations should provide deterministic facts through snapshots and events.
- Snapshot data represents the current state of a session.
- Event data represents history, activity, and future workflow visualization input.
- Raw text or payloads may be shown for debugging, but they do not drive state.
- The minimum monitored unit is a session.
- The UI should be high-density and useful for monitoring, but should not let long text or full session IDs destabilize layout.

## Screen-Level Model

The overall screen remains a hybrid global monitor:

- All projects and sessions can be visible.
- The current project/session is the focus.
- A breadcrumb-style navigator communicates scope.

The agreed breadcrumb shape is:

```text
All Projects / Project / Agent / Session
```

The breadcrumb is not a filesystem path. Branch and worktree are not part of the primary navigation because the monitored unit is session. Branch/worktree can appear as secondary attributes elsewhere.

## Outer Session Sidebar

The outer Session Sidebar is screen-level navigation. It answers:

```text
Which session is selected?
```

Rules:

- One line per session.
- Rows do not expand.
- Metrics, raw activity, and long task text do not belong here.
- Full session IDs do not belong here.
- Use compact handles for session identity.
- If a session receives a new snapshot or event, mark the row with an unread/bold/update indicator.
- Focusing that session clears the unread/update indicator.
- Status glyph/color remains visible and stable.

The sidebar is not the Details module. It only selects the object that Details inspects.

## Details Module

Details is the rich inspector for the selected session. It answers:

```text
What is happening inside this session?
```

Details has three layers:

```text
Detail Header
Detail Scope Bar
Detail Body
```

### Detail Header

The header shows compact identity and freshness:

```text
Agent · session-handle · status · freshness
```

Example:

```text
Claude · 61a677... · IDLE · fresh 37s
```

The header should not show full raw IDs unless space and context make it clearly useful. Full IDs belong in Raw or explicit inspect/copy affordances.

### Detail Scope Bar

The approved scope bar tabs are:

```text
Overview | Activity | Usage | Events | Raw
```

Scope Bar responsibility:

- It switches views of the selected session.
- It does not switch sessions.
- It is local to the Details module.
- The first implementation should be keyboard-first. Mouse support can be an enhancement, not a dependency.

Tab responsibilities:

- Overview: default adaptive visual inspector for the selected session.
- Activity: current and recent execution activity, such as tool chains and running commands.
- Usage: context, tokens, turns, rates, and pressure metrics.
- Events: deterministic event timeline and future workflow visualizations.
- Raw: raw facts and debug payloads that do not drive state.

## Details Overview

Overview uses a Primary Stage plus a fixed narrow Priority Rail.

```text
┌──────────────────────────────────────────────┬──────────────┐
│ Primary Stage                                │ Priority Rail │
│ one dominant visual                          │ fixed narrow  │
│ adaptive by session status                   │ summaries     │
└──────────────────────────────────────────────┴──────────────┘
```

### Primary Stage

Overview has exactly one large focal visualization. This avoids an uncoordinated grid of equally weighted boxes.

The Primary Stage changes content by session status:

- working: Workflow Chain
- idle: Health and lifecycle summary
- blocked: Attention state
- error: Failure state

Only the working state has been detailed enough for design commitment:

```text
working -> Workflow Chain
```

The working Primary Stage should show the deterministic running chain, such as:

```text
session_start -> tool_start -> running
                 exec_command
                 npm run build
                 elapsed 01:12
```

Live canvas, Mermaid-like graph rendering, images, or larger workflow visualization should not live in Overview. Those belong in a separate tab or future Activity/Events expansion.

Idle, blocked, and error Primary Stage visuals are intentionally not finalized in this checkpoint.

### Priority Rail

The Priority Rail is fixed-width and never competes with the Primary Stage.

It is a skim layer and route map to deeper tabs. It should not expand just because content changes.

Priority order:

1. Attention or Alerts, when present
2. Events or Activity preview
3. Pressure compact summary
4. Status or Freshness compact summary

When there is no alert, Events/Activity preview is likely the most useful rail content because active sessions continuously produce updates.

When there is an alert, Attention moves to the top and becomes visually prominent inside the rail, without changing the rail width.

## Events and Workflow Direction

Events are not merely tail text. They are a future visualization source.

The UI should leave room for:

- ASCII timeline
- compact workflow graph
- Mermaid-like workflow rendering
- image or canvas-based workflow view, if a future frontend supports it

This checkpoint does not finalize the event schema. At the design level, events should be deterministic and structured enough that future visualizations do not require model interpretation.

## Data Display Rules

- Missing metrics render as quiet placeholders, not fake values.
- Natural-language text does not drive state.
- Long activity text does not enter the sidebar.
- Raw payloads stay in Raw or Events.
- Details may show rich information, but Overview should keep one clear focal point.
- The sidebar and the Details Scope Bar must not duplicate responsibilities.

## Non-Goals For This Checkpoint

- Finalizing hook implementation.
- Finalizing the event schema.
- Designing the full Activity, Usage, Events, or Raw tabs in detail.
- Finalizing idle, blocked, or error Primary Stage visuals.
- Choosing exact colors, glyphs, or animations.
- Implementing mouse support.
- Committing to orbit, pet, Mermaid, or any ambient visualization as part of Overview.

## Open Design Areas

The following are deliberately left for subsequent design passes:

- Exact field list for the Session Sidebar row.
- Idle Primary Stage visual.
- Blocked Primary Stage visual.
- Error Primary Stage visual.
- Activity tab layout.
- Usage tab layout.
- Events tab layout and graph/workflow representation.
- Raw tab structure.
- Keyboard shortcuts for Scope Bar navigation.
- How project-level alerts appear when a session is selected.

## Testing Implications

Future implementation should be testable without relying on visual inspection alone:

- Snapshot-to-sidebar unread state should have deterministic tests.
- Details Scope Bar should switch local detail views without changing selected session.
- Overview should select the correct Primary Stage mode from session status.
- Priority Rail ordering should be tested for normal, warning, and error states.
- Missing metrics should render quiet placeholders.
- Long session IDs and long raw text should not expand sidebar rows or destabilize Overview layout.

