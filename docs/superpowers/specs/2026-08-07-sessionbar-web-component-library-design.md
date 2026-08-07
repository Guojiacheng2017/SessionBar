# SessionBar Web Component Library and Monitor Layout

## Goal

Improve the Web dashboard's visual clarity by first consolidating its hand-authored Tailwind implementation into a small, reusable component layer, then using that layer to strengthen the monitor-style hierarchy. The current SSE transport, session payload, filtering behavior, and detail tabs remain unchanged.

## Current context

- Web entry point: `index.html`.
- Browser rendering and interaction: `app.ts`.
- Styling is currently Tailwind Play CDN plus long utility-class strings in HTML templates.
- There is no shared Web component vocabulary; panels, headers, rows, badges, and detail lists repeat ad hoc class combinations.
- The worktree already contains unrelated/uncommitted changes. This task must avoid overwriting them.

## Design direction

The page should read as a compact command center:

1. Header: SessionBar identity and local connection state.
2. Status summary: inline text counts with small semantic status dots.
3. Toolbar: filtering and filter result hint.
4. Workspace: project navigation, primary session list, and contextual detail panel.
5. Footer: interaction hint and connection/lifecycle message.

The status summary must not render a horizontal progress bar or proportional segment bar. A state such as `7 sessions · 1 working · 6 idle` remains text-first, with color used only for status dots or labels. Per-session progress in the detail view is an independent data point and is not part of this removal.

## Component layer

Create a local Web styling layer while keeping vanilla TypeScript. Component styles should be semantic wrappers around the existing Tailwind design tokens rather than a new framework.

### Tokens

Centralize canvas, panel, elevated panel, border, primary text, muted text, accent, and status colors. Also define spacing, radius, row-height, focus-ring, and transition tokens. Existing dark palette values should be preserved initially; the goal is consistency before visual restyling.

### Reusable primitives

- `AppShell`: page width, padding, vertical rhythm, and responsive behavior.
- `Panel` and `PanelHeader`: shared panel surface, border, clipping, heading treatment, and scroll region.
- `StatusSummary`: inline total/status counts; no fill bar.
- `StatusDot` and `StatusBadge`: shared working, idle, blocked, and error variants.
- `Toolbar` and `FilterInput`: input, focus ring, and result hint.
- `ProjectRow` and `SessionRow`: shared row height, alignment, hover, selected, blocked, and focus states.
- `DetailList`, `DetailTabs`, and `EmptyState`: consistent inspector typography and empty states.

The TypeScript render functions should supply data and variants; repeated layout/styling strings should move into the component layer. Component names are implementation guidance, not a requirement to introduce React.

## Layout behavior

- Projects remains the filtering/navigation context on desktop, with a clear selected state.
- Sessions is the primary working surface and receives the strongest visual emphasis.
- Details remains contextual and only competes visually when a session is selected.
- Panel headers, row density, and typography use the same component primitives.
- At mobile widths, the session list remains primary and session details continue to use the existing overlay behavior; project context and filter state must not disappear without an equivalent cue.

## Interaction and accessibility

- Preserve current click behavior for project filtering, session selection, detail tabs, and Escape-to-clear filtering.
- Preserve SSE reconnect and disconnected states.
- Interactive rows and tabs must expose visible hover/focus/selected states.
- Status colors must be paired with text or accessible labels; color alone is not the status contract.
- Respect `prefers-reduced-motion` for working/blocked indicators.

## Non-goals

- No React or routing migration.
- No change to the server API, session schema, provider polling, or TUI.
- No new provider features, charts, or workflow semantics.
- No removal of per-session progress data from the detail inspector unless it is separately requested.

## Verification

1. Build the Web TypeScript output and run the existing tests available in `0agentbar`.
2. Run the local dashboard with representative working/idle/blocked/error sessions.
3. Capture desktop and mobile screenshots before/after the component migration.
4. Check that the status summary contains no horizontal progress/segment bar.
5. Verify project filtering, session selection, detail tabs, reconnect presentation, Escape clearing, and mobile detail overlay.
6. Remove temporary screenshots and QA artifacts unless explicitly requested to keep them.

## Acceptance criteria

- The Web UI uses shared local component styles for panels, headers, rows, statuses, toolbar controls, and detail content.
- The visual hierarchy clearly prioritizes active sessions and selected context.
- `7 sessions 1 working 6 idle` is readable as an inline summary without a progress bar.
- Existing data and interactions continue to work.
- Desktop and mobile screenshots show no clipped content, accidental overflow, or inconsistent repeated component styling.
