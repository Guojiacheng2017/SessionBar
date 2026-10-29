import assert from "node:assert/strict";
import test from "node:test";
import { mergeSessionPayload, validateSessionPayload } from "../dist/sessions/sessionPayload.js";
import { observeHarness } from "../dist/harness/harnessObservation.js";

const observation = { schema_version: 1, harness_id: "codex", host_id: "host", instance_id: "cli", source_kind: "hook", source_epoch: "boot1", sequence: 2, event_id: "event2", evidence: "explicit", capabilities: { usage: "unknown", workflow: "supported" } };
const report = { session_id: "s", session_type: "Codex", status: "idle", task_name: "Ready", observation };

test("observation metadata is validated at report ingress", () => {
  assert.equal(validateSessionPayload(report), true);
  for (const patch of [{ schema_version: 2 }, { sequence: -1 }, { sequence: 1.5 }, { host_id: "" }, { source_kind: "magic" }, { evidence: "guess" }, { capabilities: { usage: false } }]) {
    assert.equal(validateSessionPayload({ ...report, observation: { ...observation, ...patch } }), false);
  }
});

test("duplicate and late reports cannot overwrite session facts", () => {
  const first = mergeSessionPayload(undefined, { ...report, tokens: 100, quota_percent: 20 }, 1000);
  const duplicate = mergeSessionPayload(first, { ...report, status: "working", tokens: 0 }, 2000);
  assert.deepEqual(duplicate, first);
  const late = mergeSessionPayload(first, { ...report, status: "working", tokens: 1, quota_percent: 99, hook_event: "PreToolUse", observation: { ...observation, sequence: 1, event_id: "event1" } }, 3000);
  assert.equal(late.status, "idle");
  assert.equal(late.tokens, 100);
  assert.equal(late.quota_percent, 20);
  assert.equal(late.timestamp, 1000);
  assert.equal(late.workflow_events.length, 1);
  assert.equal(mergeSessionPayload(late, { ...report, hook_event: "PreToolUse", observation: { ...observation, sequence: 1, event_id: "event1" } }, 4000).workflow_events.length, 1);
});

test("source epochs and hosts scope ordering; missing usage remains unknown", () => {
  const first = mergeSessionPayload(undefined, report, 1000);
  assert.equal(first.tokens, undefined);
  assert.equal(first.observation.capabilities.usage, "unknown");
  const reboot = mergeSessionPayload(first, { ...report, status: "working", observation: { ...observation, source_epoch: "boot2", sequence: 0 } }, 2000);
  assert.equal(reboot.status, "working");
  const old = mergeSessionPayload(reboot, { ...report, observation: { ...observation, sequence: 99, event_id: "late-old" } }, 3000);
  assert.equal(old.status, "working");
  const otherHost = mergeSessionPayload(reboot, { ...report, observation: { ...observation, host_id: "other", sequence: 0 } }, 4000);
  assert.equal(otherHost.status, "idle");
  assert.equal(first.observation.source_epoch, "boot1");
});

test("cursor state is bounded and cannot be supplied by a report", () => {
  assert.equal(validateSessionPayload({ ...report, observation_cursors: [] }), false);
  let cursors = [];
  for (let i = 0; i < 100; i++) cursors = observeHarness(cursors, { ...observation, sequence: i, event_id: String(i) }).cursors;
  assert.equal(cursors[0].seen.length, 64);
  for (let i = 0; i < 30; i++) cursors = observeHarness(cursors, { ...observation, host_id: String(i) }).cursors;
  assert.equal(cursors.length, 16);
});

test("unsequenced reports are not deduplicated by identical text or timestamps", () => {
  const unsequenced = { ...observation, sequence: undefined, event_id: undefined };
  const first = mergeSessionPayload(undefined, { ...report, observation: unsequenced, hook_event: "PreToolUse" }, 1000);
  const second = mergeSessionPayload(first, { ...report, observation: unsequenced, hook_event: "PreToolUse" }, 1000);
  assert.equal(second.workflow_events.length, 2);
});
