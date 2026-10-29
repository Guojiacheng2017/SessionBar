import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { recoverSessionProjects } from "../dist/sessions/recoveredSessionProjects.js";

const PATH = "/projects/atlas";
const OTHER_PATH = "/other/atlas";
const hash = path => createHash("md5").update(path + "\n").digest("hex");
const marker = (path = PATH, agent = "codex", suffix = "session-1234567890abcdef") => `sessionbar-id-${agent}-${hash(path)}-${suffix}`;
const session = (id, extra = {}) => ({ session_id: id, session_type: "Codex", source: "hook", status: "idle", task_name: "Ready", timestamp: 1000, ...extra });
const known = (path = PATH) => session("known", { project: "atlas", project_path: path });

test("six restored sessions recover the known full project path without changing their identities or state", () => {
  const sessions = { known: known() };
  const markers = new Map();
  for (let i = 0; i < 6; i++) {
    const id = `restored-${i}__atlas`;
    sessions[id] = session(id);
    markers.set(id, [marker()]);
  }
  const originalIds = Object.values(sessions).map(item => item.session_id);
  const originalMarkers = structuredClone(markers);
  recoverSessionProjects(sessions, markers);
  assert.deepEqual(Object.values(sessions).map(item => item.session_id), originalIds);
  assert.deepEqual(new Set(Object.values(sessions).map(item => item.project_path)), new Set([PATH]));
  assert.ok(Object.values(sessions).every(item => item.project === "atlas" && item.timestamp === 1000 && item.status === "idle"));
  assert.deepEqual(markers, originalMarkers);
});

test("same-name projects stay separate and a marker chooses its matching full path", () => {
  const sessions = { first: known(), second: session("second", { project: "atlas", project_path: OTHER_PATH }), left: session("left"), right: session("right") };
  recoverSessionProjects(sessions, new Map([["left", [marker(PATH)]], ["right", [marker(OTHER_PATH)]]]));
  assert.equal(sessions.left.project_path, PATH);
  assert.equal(sessions.right.project_path, OTHER_PATH);
  assert.notEqual(sessions.left.project_path, sessions.right.project_path);
});

test("remote paths cannot establish a local project and remote targets are never enriched", () => {
  const local = session("local");
  const remote = session("remote", { origin: "remote" });
  const sessions = { remoteKnown: { ...known(), origin: "remote" }, local, remote };
  const markers = new Map([["local", [marker()]], ["remote", [marker()]]]);
  recoverSessionProjects(sessions, markers);
  assert.equal(local.project_path, undefined);
  sessions.localKnown = known();
  recoverSessionProjects(sessions, markers);
  assert.equal(local.project_path, PATH);
  assert.equal(remote.project_path, undefined);
});

test("conflicting hashes for one recovered session stay unresolved", () => {
  const sessions = { first: known(), second: session("second", { project_path: OTHER_PATH }), child: session("child") };
  recoverSessionProjects(sessions, new Map([["child", [marker(PATH), marker(OTHER_PATH)]]]));
  assert.equal(sessions.child.project_path, undefined);
  assert.equal(sessions.child.project, undefined);
});

test("unknown, cksum, truncated and mixed marker formats never fall back to the project label", () => {
  const invalid = [
    [],
    ["sessionbar-id-codex-1234567890-session-1234567890abcdef"],
    ["sessionbar-id-codex-project-notty-123"],
    [`sessionbar-id-codex-${hash(PATH).slice(0, 16)}-notty-123`],
    [marker(), "unrecognized-marker"],
    [`/tmp/${marker()}`],
  ];
  for (const files of invalid) {
    const sessions = { known: known(), child: session("child__atlas", { project: "atlas" }) };
    recoverSessionProjects(sessions, new Map([[sessions.child.session_id, files]]));
    assert.equal(sessions.child.project_path, undefined);
  }
});

test("existing paths and project labels remain authoritative even if a marker disagrees", () => {
  const sessions = { known: known(), child: session("child", { project: "My label", project_path: OTHER_PATH }) };
  recoverSessionProjects(sessions, new Map([["child", [marker()]]]));
  assert.equal(sessions.child.project_path, OTHER_PATH);
  assert.equal(sessions.child.project, "My label");
  delete sessions.child.project_path;
  recoverSessionProjects(sessions, new Map([["child", [marker()]]]));
  assert.equal(sessions.child.project_path, PATH);
  assert.equal(sessions.child.project, "My label");
});

test("only known absolute paths are candidates and matching labels are insufficient", () => {
  const sessions = { relative: known("atlas"), named: session("named", { project: "atlas" }), child: session("child") };
  recoverSessionProjects(sessions, new Map([["child", [marker("atlas")]]]));
  assert.equal(sessions.child.project_path, undefined);
});

test("canonical recovered IDs are matched exactly without guessing UUID or suffix aliases", () => {
  const sessions = { known: known(), child: session("original-scope__atlas"), other: session("original__atlas") };
  recoverSessionProjects(sessions, new Map([["original-scope__atlas", [marker()]]]));
  assert.equal(sessions.child.project_path, PATH);
  assert.equal(sessions.other.project_path, undefined);
});

test("duplicate observations of one path and repeated matching markers are unambiguous", () => {
  const sessions = { first: known(), second: session("second", { project_path: PATH }), child: session("child") };
  recoverSessionProjects(sessions, new Map([["child", [marker(), marker(PATH, "claude-code", "notty-123")]]]));
  assert.equal(sessions.child.project_path, PATH);
});

test("supports the recorded session, terminal and nonterminal marker formats across harnesses", () => {
  for (const [agent, suffix] of [["codex", "session-1234567890abcdef"], ["claude", "notty-123"], ["kimi-code", "0123456789abcdef0123456789abcdef"]]) {
    const sessions = { known: known(), child: session("child", { session_type: agent }) };
    recoverSessionProjects(sessions, new Map([["child", [marker(PATH, agent, suffix)]]]));
    assert.equal(sessions.child.project_path, PATH);
  }
});

test("hashes the original path bytes including the newline, preserving root and trailing slash", () => {
  for (const path of ["/", "/projects/空间/", "/projects/atlas/"]) {
    const sessions = { known: known(path), child: session("child") };
    recoverSessionProjects(sessions, new Map([["child", [marker(path)]]]));
    assert.equal(sessions.child.project_path, path);
    assert.ok(sessions.child.project);
  }
  const sessions = { known: known(), child: session("child") };
  const withoutNewline = createHash("md5").update(PATH).digest("hex");
  recoverSessionProjects(sessions, new Map([["child", [`sessionbar-id-codex-${withoutNewline}-notty-123`]]]));
  assert.equal(sessions.child.project_path, undefined);
});
