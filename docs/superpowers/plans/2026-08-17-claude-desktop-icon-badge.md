# Claude Desktop Icon Badge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Distinguish Claude Desktop sessions from Claude Code sessions with a compact monitor badge.

**Architecture:** Extend the shared Web icon renderer with one badged icon type. Draw the badge with CSS so the UI does not depend on local application resources.

**Tech Stack:** TypeScript, HTML strings, CSS, Node test runner

## Global Constraints

- Keep the existing 18px icon footprint.
- Claude Code remains unbadged.
- Claude Desktop receives a lower-right monitor badge.
- Do not change provider icon semantics.

### Task 1: Shared icon badge

**Files:**
- Modify: `src/web/webComponents.ts`
- Modify: `public/web.css`
- Test: `test/webComponents.test.mjs`

- [ ] Add a failing test asserting that Claude Desktop uses the Claude asset and monitor badge while Claude Code has no badge.
- [ ] Run the focused test and verify failure.
- [ ] Add the Claude Desktop icon mapping and portable monitor badge markup/styles.
- [ ] Run focused and full tests.
