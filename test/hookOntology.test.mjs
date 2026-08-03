import assert from "node:assert/strict";
import test from "node:test";
import {
  HOOK_ONTOLOGY_VERSION,
  canonicalHookStages,
  hookEventMappings,
  mapHookEvent,
} from "../dist/hookOntology.js";

test("compaction and compression hooks map to one canonical workflow stage", () => {
  const examples = [
    ["Claude Code", "PreCompact"],
    ["Codex CLI", "PreCompact"],
    ["Codex App", "PreCompact"],
    ["Factory Droid", "PreCompact"],
    ["Kimi Code CLI", "PreCompact"],
    ["Gemini CLI", "PreCompress"],
    ["Cursor", "preCompact"],
    ["Pi", "session_before_compact"],
  ];

  for (const [agent, rawEvent] of examples) {
    const mapping = mapHookEvent(agent, rawEvent);
    assert.equal(mapping.canonical_stage_id, "context.compact.before", `${agent}:${rawEvent}`);
    assert.equal(mapping.mapping_type, "same_concept", `${agent}:${rawEvent}`);
    assert.equal(mapping.confidence, "high", `${agent}:${rawEvent}`);
  }
});

test("tool hooks normalize by concept while preserving known subtypes", () => {
  assert.equal(mapHookEvent("Claude Code", "PreToolUse").canonical_stage_id, "tool.execute.before");
  assert.equal(mapHookEvent("Gemini CLI", "BeforeTool").canonical_stage_id, "tool.execute.before");
  assert.equal(mapHookEvent("OpenCode", "tool.execute.before").canonical_stage_id, "tool.execute.before");
  assert.equal(mapHookEvent("Pi", "tool_call").canonical_stage_id, "tool.execute.before");

  const shell = mapHookEvent("Cursor", "beforeShellExecution");
  assert.equal(shell.canonical_stage_id, "tool.execute.before");
  assert.equal(shell.mapping_type, "subtype");
  assert.equal(shell.confidence, "high");
});

test("ambiguous workflow-neighborhood hooks stay explicit", () => {
  const context = mapHookEvent("Pi", "context");
  assert.equal(context.canonical_stage_id, "context.snapshot");
  assert.equal(context.mapping_type, "same_neighborhood");
  assert.equal(context.confidence, "medium");

  const tree = mapHookEvent("Pi", "session_before_tree");
  assert.equal(tree.canonical_stage_id, "context.tree.before");
  assert.equal(tree.mapping_type, "weak");
  assert.equal(tree.confidence, "low");
});

test("unknown agent events remain unmapped instead of being inferred", () => {
  const mapping = mapHookEvent("Claude Code", "DefinitelyNotARealHook");

  assert.equal(mapping.canonical_stage_id, "unmapped");
  assert.equal(mapping.mapping_type, "unmapped");
  assert.equal(mapping.confidence, "none");
  assert.equal(mapping.agent, "Claude Code");
  assert.equal(mapping.raw_event, "DefinitelyNotARealHook");
});

test("Antigravity remains unconfirmed until a stable cached event schema exists", () => {
  const mapping = mapHookEvent("Antigravity", "SessionStart");

  assert.equal(mapping.canonical_stage_id, "unconfirmed");
  assert.equal(mapping.mapping_type, "unavailable");
  assert.equal(mapping.confidence, "none");
  assert.match(mapping.notes, /stable event schema/i);
});

test("ontology exports every reviewed mapping and canonical stage metadata", () => {
  assert.match(HOOK_ONTOLOGY_VERSION, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(hookEventMappings.length >= 116);

  const duplicateKeys = new Set();
  for (const mapping of hookEventMappings) {
    const key = `${mapping.agent}\0${mapping.raw_event}`;
    assert.equal(duplicateKeys.has(key), false, `duplicate mapping ${mapping.agent}:${mapping.raw_event}`);
    duplicateKeys.add(key);
    assert.ok(canonicalHookStages[mapping.canonical_stage_id], `missing stage ${mapping.canonical_stage_id}`);
  }

  assert.equal(canonicalHookStages["context.compact.before"].category, "context");
  assert.equal(canonicalHookStages["context.compact.before"].direction, "before");
});
