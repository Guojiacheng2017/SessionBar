import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { codexNativeSource } from "../dist/shared/codexServices.js";
import { codexThreadMetadata } from "../dist/sessions/codexAppServer.js";
import { createCodexServiceOrigins } from "../dist/sessions/codexServiceOrigins.js";
import { sessionDisplayName } from "../dist/tui/displayUtils.js";

const id = index => `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`;
const session = (index, source) => ({ session_id: `${id(index)}__Project`, session_type: "Codex", status: "idle", task_name: "Ready", session_source: source });

test("native internal sources retain their service identity instead of becoming user subagents", () => {
  const sources = [
    [{ internal: "guardian" }, "guardian", "Approval review"],
    [{ subagent: { other: "guardian" } }, "guardian", "Approval review"],
    [{ subAgent: "review" }, "review", "Code review service"],
    [{ subagent: "compact" }, "compaction", "Context compaction"],
    [{ internal: "memory_consolidation" }, "memory_consolidation", "Memory consolidation"],
    [{ subagent: "memory_consolidation" }, "memory_consolidation", "Memory consolidation"],
  ];
  for (const [source, expected, label] of sources) {
    assert.equal(codexNativeSource("subagent", source), expected);
    const metadata = codexThreadMetadata({ id: id(1), source, threadSource: "subagent", cwd: "/Project", updatedAt: 1 });
    assert.equal(metadata.source, expected);
    assert.equal(metadata.isSubagent, false);
    assert.equal(sessionDisplayName({ session_service: expected }), label);
  }
  assert.equal(codexNativeSource({ subagent: { other: "unknown-service" } }), undefined);
  assert.equal(codexThreadMetadata({ id: id(2), source: { subAgent: { thread_spawn: { parent_thread_id: id(1) } } }, cwd: "/Project", updatedAt: 1 }).isSubagent, true);
});

test("all known service classifications survive restart and missing native logs without creating session rows", t => {
  const root = mkdtempSync(join(tmpdir(), "sessionbar-service-origins-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cachePath = join(root, "origins.json");
  const desktop = new Map([[id(1), "mcp_extension_host"]]);
  const predictions = new Map([[id(2), "composer_predictions"]]);
  const create = () => createCodexServiceOrigins({ cachePath, readDesktop: () => desktop, readPredictions: () => predictions });
  const tracker = create();
  const rows = [session(1), session(2), session(3, "review"), session(4, "guardian"), session(5, "compact"), session(6, "memory_consolidation")];
  tracker.classify(rows, 1000);
  assert.ok(rows.every(row => row.session_kind === "background"));
  assert.deepEqual(rows.map(row => row.session_service), ["mcp_extension_host", "composer_predictions", "review", "guardian", "compaction", "memory_consolidation"]);
  assert.equal(JSON.parse(readFileSync(cachePath, "utf8")).entries.length, 6);
  desktop.clear(); predictions.clear();
  const restored = rows.map((_, index) => session(index + 1));
  create().classify(restored, 2000);
  assert.equal(restored.length, 6);
  assert.deepEqual(restored.map(row => row.session_service), rows.map(row => row.session_service));
});

test("native user metadata, original names and ordinary subagent ownership are preserved", t => {
  const root = mkdtempSync(join(tmpdir(), "sessionbar-service-origins-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tracker = createCodexServiceOrigins({ cachePath: join(root, "origins.json"), readDesktop: () => new Map(), readPredictions: () => new Map() });
  tracker.observe(id(1), { internal: "guardian" }, 1000);
  tracker.observe(id(2), { subagent: { thread_spawn: { parent_thread_id: id(1) } } }, 1000);
  const named = { ...session(1), session_name: "Original service title" };
  const worker = session(2);
  const user = { ...session(3, "vscode"), session_name: "Review guardian compaction results" };
  const unknown = session(4);
  tracker.classify([named, worker, user, unknown], 1000);
  assert.equal(named.session_service, "guardian");
  assert.equal(sessionDisplayName(named), "Original service title");
  assert.equal(worker.session_service, undefined);
  assert.equal(user.session_kind, "user");
  assert.equal(unknown.session_kind, "unknown");
  const corrected = { ...session(1, "vscode"), session_name: "A real user chat" };
  tracker.classify([corrected], 2000);
  assert.equal(corrected.session_kind, "user");
  assert.equal(corrected.session_service, undefined);
});

test("looks up only reported native IDs and decodes internal DB sources when the protocol omitted them", t => {
  const root = mkdtempSync(join(tmpdir(), "sessionbar-native-service-sources-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = join(root, "state.sqlite");
  execFileSync("sqlite3", [db, "CREATE TABLE threads (id TEXT PRIMARY KEY, source TEXT);"]);
  const sources = [{ subagent: { other: "guardian" } }, { subagent: "review" }, { subagent: "compact" }, { internal: "memory_consolidation" }, "vscode", { subagent: { thread_spawn: { parent_thread_id: id(5) } } }];
  for (const [index, source] of sources.entries()) {
    const stored = typeof source === "string" ? source : JSON.stringify(source);
    execFileSync("sqlite3", [db, `INSERT INTO threads VALUES ('${id(index + 1)}','${stored.replaceAll("'", "''")}');`]);
  }
  const before = readFileSync(db);
  const tracker = createCodexServiceOrigins({ cachePath: join(root, "origins.json"), nativeDbPath: db,
    readDesktop: () => new Map(), readPredictions: () => new Map() });
  const rows = sources.slice(0, 5).map((_, index) => session(index + 1));
  tracker.classify(rows, 1000);
  assert.deepEqual(rows.map(row => row.session_service), ["guardian", "review", "compaction", "memory_consolidation", undefined]);
  assert.equal(rows[4].session_kind, "user");
  assert.equal(rows.length, 5, "an unrelated native worker is never discovered by classification");
  assert.deepEqual(readFileSync(db), before, "the native DB remains read-only");
});
