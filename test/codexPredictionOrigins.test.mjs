import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { correlateCodexPredictionOrigins, createCodexPredictionOriginsReader } from "../dist/sessions/codexPredictionOrigins.js";

const parent = "22222222-2222-4222-8222-222222222222";
const processId = "pid:123:desktop";
const at = 1_793_206_903_000;
const time = (at + 300).toString(16).padStart(12, "0");
const child = `${time.slice(0, 8)}-${time.slice(8)}-7000-8000-000000000001`;
const other = `${time.slice(0, 8)}-${time.slice(8)}-7000-8000-000000000002`;
function events(id = child) {
  return [
    { id: 1, ts: at / 1000, ts_nanos: 274_613_000, process_uuid: processId, thread_id: parent,
      target: "codex_app_server::request_processors::thread_lifecycle",
      message: `composing running thread resume response thread_id=${parent} active_turn_present=false` },
    { id: 2, ts: at / 1000, ts_nanos: 278_428_000, process_uuid: processId, thread_id: null,
      target: "codex_app_server::message_processor",
      message: 'app-server request: thread/sample connection_id=ConnectionId(0) request_id=String("thread/sample:44444444-4444-4444-8444-444444444444")' },
    { id: 3, ts: at / 1000, ts_nanos: 320_925_000, process_uuid: processId, thread_id: id,
      target: "codex_models_manager::manager",
      message: `thread_spawn{otel.name="thread_spawn"}:session_init:apply_rollout_reconstruction{thread_id=${id} rollout_item_count=301}:list_models{refresh_strategy=offline}: models cache: evaluating cache eligibility client_version="0.165.0"` },
  ];
}

test("links the Desktop prediction request to its temporary child, never its parent", () => {
  const origins = correlateCodexPredictionOrigins(events());
  assert.deepEqual(origins.map(origin => origin.threadId), [child]);
  assert.equal(origins[0].observedAt, at + 320.925);
});

test("does not guess from keywords, another process, or ambiguous concurrent thread creation", () => {
  const rows = events();
  assert.deepEqual(correlateCodexPredictionOrigins(rows.filter(row => row.id !== 2)), []);
  assert.deepEqual(correlateCodexPredictionOrigins(rows.map(row => row.id === 3 ? { ...row, process_uuid: "another-process" } : row)), []);
  assert.deepEqual(correlateCodexPredictionOrigins([...rows, { ...events(other)[2], id: 4 }]), []);
  assert.deepEqual(correlateCodexPredictionOrigins([...rows.map(row => row.id === 3 ? { ...row, id: 5 } : row), { ...rows[1], id: 4, message: "app-server request: thread/start connection_id=ConnectionId(0)", ts_nanos: 300_000_000 }]), []);
  assert.deepEqual(correlateCodexPredictionOrigins(rows.filter(row => row.id !== 1)), []);
  assert.deepEqual(correlateCodexPredictionOrigins(events(parent)), [], "the resumed parent never becomes the temporary child");
  assert.deepEqual(correlateCodexPredictionOrigins(events("11111111-1111-4111-8111-111111111111")), [], "an older or unsupported ID cannot be inferred from timing");
});

test("reads native metadata without modifying it and preserves classification after logs are pruned and the reader restarts", t => {
  const root = mkdtempSync(join(tmpdir(), "sessionbar-prediction-origins-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = join(root, "logs.sqlite");
  const cachePath = join(root, "state", "origins.json");
  execFileSync("sqlite3", [db, "CREATE TABLE logs (id INTEGER PRIMARY KEY, ts INTEGER, ts_nanos INTEGER, target TEXT, feedback_log_body TEXT, thread_id TEXT, process_uuid TEXT);"]);
  for (const row of events()) {
    const sql = `INSERT INTO logs VALUES (${row.id},${row.ts},${row.ts_nanos},'${row.target}','${row.message.replaceAll("'", "''")}',${row.thread_id ? `'${row.thread_id}'` : "NULL"},'${row.process_uuid}');`;
    execFileSync("sqlite3", [db, sql]);
  }
  const before = readFileSync(db);
  const read = createCodexPredictionOriginsReader({ logsPath: db, cachePath });
  assert.equal(read(at + 500).get(child), undefined, "wait until the matching window closes");
  assert.equal(read(at + 5500).get(child), "composer_predictions");
  assert.deepEqual(readFileSync(db), before);
  const cached = JSON.parse(readFileSync(cachePath, "utf8"));
  assert.deepEqual(cached.entries, [{ threadId: child, observedAt: at + 320.925 }]);
  execFileSync("sqlite3", [db, "DELETE FROM logs;"]);
  assert.equal(createCodexPredictionOriginsReader({ logsPath: db, cachePath })(at + 6500).get(child), "composer_predictions");
});
