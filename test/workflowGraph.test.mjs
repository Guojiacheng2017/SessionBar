import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { sessionWorkflowGraph, reportedWorkflowGraph, layoutWorkflowGraph, groupWorkflowEvents } from "../dist/shared/workflowGraph.js";
import { sessionFlowMarkup, workflowGraphMarkup, workflowHistoryMarkup } from "../dist/web/workflowViews.js";
const { createMarkupCommitter } = await import("../dist/web/markupCommitter.js").catch(() => ({}));

const session = { session_id: "session-a1", session_type: "Codex", status: "working", task_name: "Design", timestamp: 1000 };
const snapshot = () => JSON.parse(readFileSync(new URL("./fixtures/agents/snapshot.example.json", import.meta.url), "utf8"));
const graph = (nodes, edges = []) => reportedWorkflowGraph({ nodes: nodes.map(id => ({ id, label: id })), edges });
const event = (id, stage, label, at) => ({ id, stage, label, occurredAt: at });

test("session flow uses the explicit graph, including isolated nodes and explicitly empty graphs", () => {
  const result = sessionWorkflowGraph({ ...session, flow: { nodes: [{ id: "only", label: "Only reported step" }], edges: [] } }, snapshot());
  assert.equal(result.kind, "workflow");
  assert.deepEqual(result.nodes.map(node => node.id), ["only"]);
  assert.equal(result.edges.length, 0);
  assert.equal(sessionWorkflowGraph({ ...session, flow: { nodes: [], edges: [] } }, snapshot()).nodes.length, 0);
});

test("agent topology retains nested parents and never connects an unknown parent to the primary", () => {
  const live = snapshot();
  const orphan = { ...live.agents[1], agent_id: "orphan", parent_agent_id: null, name: "Unknown parent" };
  live.agents.push(orphan);
  const result = sessionWorkflowGraph(session, live);
  assert.equal(result.kind, "agents");
  assert.equal(result.nodes.length, 4);
  assert.equal(result.edges.length, 2);
  assert.equal(result.edges.some(edge => edge.from === live.agents[1].agent_id && edge.to === live.agents[2].agent_id), true);
  assert.equal(result.edges.some(edge => edge.to === "orphan"), false);
  assert.match(result.notes.join(" "), /parent.*not observed/i);
  assert.equal(result.nodes.some(node => node.id === live.agents.find(agent => agent.identity.session_id !== session.session_id).agent_id), false);
});

test("event-only sessions never acquire invented dependency edges", () => {
  const value = { ...session, workflow_events: [{ timestamp: 1000, raw_event: "PreToolUse", canonical_stage_id: "tool.execute.before" }] };
  assert.equal(sessionWorkflowGraph(value, null), null);
  const markup = sessionFlowMarkup(value, null);
  assert.match(markup, /Observed events/);
  assert.match(markup, /dependencies.*not reported/i);
  assert.doesNotMatch(markup, /data-flow-node|data-flow-edge/);
});

test("invalid and duplicate graph references are disclosed without fabricating nodes", () => {
  const result = reportedWorkflowGraph({ nodes: [{ id: "a" }, { id: "a" }, { id: "b" }], edges: [{ from: "a", to: "missing" }, { from: "a", to: "b", label: "handoff" }] });
  assert.deepEqual(result.nodes.map(node => node.id), ["a", "b"]);
  assert.deepEqual(result.edges.map(edge => [edge.from, edge.to]), [["a", "b"]]);
  assert.match(result.notes.join(" "), /duplicate/i);
  assert.match(result.notes.join(" "), /unreported/i);
});

test("graph bounds are visible and preserve referential integrity", () => {
  const result = graph(Array.from({ length: 180 }, (_, i) => `n${i}`), Array.from({ length: 179 }, (_, i) => ({ from: `n${i}`, to: `n${i + 1}` })));
  assert.ok(result.nodes.length < 180);
  assert.match(result.notes.join(" "), /180/);
  const ids = new Set(result.nodes.map(node => node.id));
  assert.ok(result.edges.every(edge => ids.has(edge.from) && ids.has(edge.to)));
});

test("layered layout expresses a fork and join without node overlap", () => {
  const value = graph(["start", "left", "right", "join", "isolated"], [{ from: "start", to: "left" }, { from: "start", to: "right" }, { from: "left", to: "join" }, { from: "right", to: "join" }]);
  const layout = layoutWorkflowGraph(value);
  const nodes = Object.fromEntries(layout.nodes.map(node => [node.id, node]));
  assert.ok(nodes.start.x < nodes.left.x);
  assert.equal(nodes.left.x, nodes.right.x);
  assert.ok(nodes.left.x < nodes.join.x);
  for (const a of layout.nodes) for (const b of layout.nodes) {
    if (a === b) continue;
    assert.ok(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y, `${a.id} overlaps ${b.id}`);
  }
  assert.deepEqual(layoutWorkflowGraph(value), layout);
  assert.equal(layout.edges.length, 4);
});

test("cycles, self-loops and disconnected nodes stay visible and produce finite geometry", () => {
  const layout = layoutWorkflowGraph(graph(["a", "b", "c", "island"], [{ from: "a", to: "b" }, { from: "b", to: "a" }, { from: "b", to: "c" }, { from: "c", to: "c" }]));
  assert.equal(layout.nodes.length, 4);
  assert.equal(layout.edges.length, 4);
  assert.ok(layout.edges.some(edge => edge.loop));
  assert.ok(layout.edges.every(edge => !/NaN|Infinity/.test(edge.path)));
  assert.ok(Number.isFinite(layout.width) && Number.isFinite(layout.height));
});

test("only consecutive equal events coalesce, retaining counts and time ranges", () => {
  const result = groupWorkflowEvents([event("a", "tool.start", "shell", 1000), event("b", "tool.start", "shell", 1200), event("c", "permission", "Allow?", 1500), event("d", "tool.start", "shell", 1800)]);
  assert.deepEqual(result.map(item => [item.count, item.firstAt, item.lastAt]), [[2, 1000, 1200], [1, 1500, 1500], [1, 1800, 1800]]);
  assert.equal(groupWorkflowEvents([event("x", "tool", "shell", null)])[0].firstAt, null);
});

test("rendered graph exposes every connection label and escapes all source strings", () => {
  const value = reportedWorkflowGraph({ nodes: [{ id: 'a"', label: "<script>bad()</script>", status: 'working" onfocus="bad()' }, { id: "b", label: "Review", status: "completed" }], edges: [{ from: 'a"', to: "b", label: "<img src=x>" }] });
  const markup = workflowGraphMarkup(value, 'scope"');
  assert.match(markup, /&lt;script&gt;/);
  assert.match(markup, /&lt;img/);
  assert.doesNotMatch(markup, /<script>|<img src=x| onfocus="bad/);
  assert.match(markup, /data-flow-edge/);
  assert.match(markup, /aria-label="Zoom in"/);
  assert.match(markup, /Connections/);
  assert.match(markup, /completed/);
});

test("missing timestamps never become duration bars or an epoch-zero timeline", () => {
  const markup = workflowHistoryMarkup([event("a", "tool.start", "shell", null), event("b", "tool.complete", "shell", null)], "unknown-time");
  assert.match(markup, /Time not reported/);
  assert.doesNotMatch(markup, /1970|data-timeline-point/);
});

test("a timed history renders observed points, keeps raw labels and states the retained window", () => {
  const markup = workflowHistoryMarkup([event("a", "tool.start", "<shell>", 1000), event("b", "tool.complete", "shell", 6000)], "timed");
  assert.match(markup, /data-timeline-point/);
  assert.match(markup, /&lt;shell&gt;/);
  assert.match(markup, /retained/i);
  assert.doesNotMatch(markup, /thinking|duration bar/i);
});

test("identical source updates retain interactive graph state even after its DOM changes", () => {
  assert.equal(typeof createMarkupCommitter, "function");
  const target = { innerHTML: "", firstChild: {} };
  const commit = createMarkupCommitter();
  assert.equal(commit(target, "graph at 100%"), true);
  target.innerHTML = "graph at 120% with an expanded inspector";
  assert.equal(commit(target, "graph at 100%"), false);
  assert.equal(target.innerHTML, "graph at 120% with an expanded inspector");
  assert.equal(commit(target, "new graph"), true);
  assert.equal(target.innerHTML, "new graph");
});

test("a system monitor replacing the detail root invalidates the old session markup cache", () => {
  assert.equal(typeof createMarkupCommitter, "function");
  const target = { innerHTML: "", firstChild: {} };
  const commit = createMarkupCommitter();
  commit(target, "session flow");
  target.innerHTML = "system monitor";
  target.firstChild = {};
  assert.equal(commit(target, "session flow"), true);
  assert.equal(target.innerHTML, "session flow");
});

test("avatar load attributes do not cause a graph subtree replacement", () => {
  assert.equal(typeof createMarkupCommitter, "function");
  const target = { innerHTML: '<span data-loaded="true">Avatar</span>', firstChild: {} };
  const commit = createMarkupCommitter(markup => markup.replace(' data-loaded="true"', ""));
  assert.equal(commit(target, "<span>Avatar</span>"), false);
  assert.match(target.innerHTML, /data-loaded/);
});
