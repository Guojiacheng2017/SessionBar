import assert from "node:assert/strict";
import test from "node:test";
import { visibleCodexSessions } from "../dist/sessions/codexRecoveredSessions.js";

const ROOT = "11111111-1111-4111-8111-111111111111";
const CHILD = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const session = (id, extra = {}) => ({
  session_id: `${id}__atlas`, session_type: "Codex", source: "hook",
  status: "idle", task_name: "Ready", timestamp: 1000,
  project: "atlas", project_path: "/projects/atlas", ...extra,
});
const evidence = (primary = [], children = []) => ({ primaryIds: new Set(primary), subagentIds: new Set(children) });
const recovered = rows => new Set(rows.map(row => row.session_id));

test("six marker-only same-name sessions stay hidden while a verified unnamed primary stays visible", () => {
  const known = session(ROOT);
  const ghosts = Array.from({ length: 6 }, (_, i) => session(`00000000-0000-4000-8000-${String(i).padStart(12, "0")}`));
  const rows = [known, ...ghosts];
  assert.deepEqual(visibleCodexSessions(rows, evidence([ROOT]), recovered(rows)), [known]);
  assert.equal(rows.length, 7, "recovery evidence changes visibility, not stored sessions");
});

test("native confirmation must match the exact thread UUID, not a name or shared workspace", () => {
  const rows = [session(ROOT), session(OTHER)];
  assert.deepEqual(visibleCodexSessions(rows, evidence([OTHER]), recovered(rows)), [rows[1]]);
  assert.deepEqual(visibleCodexSessions(rows, evidence(), recovered(rows)), []);
});

test("native UUID confirmation preserves canonical hook and discovery session IDs", () => {
  const rows = [session(`codex-${ROOT}`), session(`${OTHER}-deadbeef`)];
  assert.deepEqual(visibleCodexSessions(rows, evidence([ROOT, OTHER]), recovered(rows)), rows);
});

test("proven subagents are excluded even after live reports or conflicting primary observations", () => {
  const rows = [session(ROOT), session(CHILD), session(OTHER)];
  assert.deepEqual(visibleCodexSessions(rows, evidence([ROOT, CHILD, OTHER], [CHILD])), [rows[0], rows[2]]);
});

test("internal services keep their rows when older APIs label them as generic subagents", () => {
  const service = session(ROOT, { session_kind: "background", session_service: "guardian" });
  const worker = session(CHILD);
  const inferredPrediction = session(OTHER, { session_kind: "background", session_service: "composer_predictions" });
  assert.deepEqual(visibleCodexSessions([service, worker, inferredPrediction], evidence([], [ROOT, CHILD, OTHER])), [service]);
});

test("a fresh unnamed Working hook is visible even without a persisted native transcript", () => {
  const row = session(ROOT, { status: "working", timestamp: Date.now() });
  assert.deepEqual(visibleCodexSessions([row], evidence()), [row]);
  assert.deepEqual(visibleCodexSessions([row], evidence([ROOT])), [row]);
  assert.equal(row.session_name, undefined);
});

test("local Codex evidence never filters remote sessions or other harnesses", () => {
  const rows = [session(CHILD, { origin: "remote", harness_instance_id: "other-host" }), session(CHILD, { session_type: "Claude Code" }), session(CHILD, { session_type: "DeepSeek Harness" })];
  assert.deepEqual(visibleCodexSessions(rows, evidence([], [CHILD])), rows);
});

test("filtering preserves input state, evidence, and order of surviving sessions", () => {
  const rows = [session(OTHER), session(CHILD), session(ROOT)];
  const observed = evidence([ROOT, OTHER]);
  const before = structuredClone({ rows, observed });
  assert.deepEqual(visibleCodexSessions(rows, observed, recovered(rows)), [rows[0], rows[2]]);
  assert.deepEqual({ rows, observed }, before);
});
