import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { agentId, SCHEMA } from "../dist/shared/agentContract.js";
import { AgentClient } from "../dist/web/agentClient.js";
import { sessionFlowMarkup } from "../dist/web/workflowViews.js";
import {
  agentProjectKey, UNASSIGNED_PROJECT_KEY, sessionAgentRoster, projectAgentRoster, agentAvatarMarkup,
  agentRosterMarkup, agentDetailMarkup, mergeAgentDetailPage, withoutAgentAvatarLoadState,
} from "../dist/web/agentViews.js";

const example = name => JSON.parse(readFileSync(new URL(`./fixtures/agents/${name}.example.json`, import.meta.url), "utf8"));
const snapshot = () => ({ ...example("snapshot"), schema_version: SCHEMA });
const detail = () => ({ ...example("agent-detail"), schema_version: SCHEMA });
const sessions = () => snapshot().sessions.map(item => ({
  session_id: item.session_id, session_type: "Codex", session_name: item.name,
  project: "atlas", project_path: item.project_id === "project-remote-b" ? "/remote/atlas" : "/local/atlas",
  status: "working", task_name: "Testing", timestamp: 1000,
}));
const reply = value => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function settled(client) {
  for (let attempt = 0; attempt < 30; attempt++) {
    if (!client.selected?.loading) return;
    await new Promise(setImmediate);
  }
  assert.fail("Agent request did not settle");
}

test("same-name projects use canonical identities, with source/path fallback", () => {
  const live = snapshot();
  const rows = sessions();
  assert.equal(agentProjectKey(rows[0], live), agentProjectKey(rows[1], live));
  assert.notEqual(agentProjectKey(rows[0], live), agentProjectKey(rows[2], live));
  assert.notEqual(agentProjectKey(rows[0], null), agentProjectKey(rows[2], null));
  assert.notEqual(agentProjectKey(rows[0], null), agentProjectKey({ ...rows[0], origin: "remote", harness_instance_id: "host-two" }, null));
  assert.equal(agentProjectKey({ ...rows[0], project_path: undefined }, null), UNASSIGNED_PROJECT_KEY);
  assert.equal(agentProjectKey({ ...rows[1], project_path: undefined }, null), UNASSIGNED_PROJECT_KEY);
  assert.equal(agentProjectKey({ ...rows[0], project_path: "/" }, null), agentProjectKey({ ...rows[1], project_path: "/" }, null));
  assert.equal(agentProjectKey({ ...rows[0], project_path: "/" }, live), UNASSIGNED_PROJECT_KEY);
});

test('unassigned sessions share a labeled bucket without inventing a canonical project', () => {
  const live = snapshot();
  const rows = sessions().map(row => ({ ...row, project: undefined, project_path: undefined }));
  live.sessions.forEach(session => { session.project_id = null; });
  for (const row of rows) assert.equal(agentProjectKey(row, live), UNASSIGNED_PROJECT_KEY);
  // Newly supplied paths may arrive before the independent agent snapshot.
  const restored = { ...rows[0], project_path: '/verified/workspace' };
  assert.notEqual(agentProjectKey(restored, live), UNASSIGNED_PROJECT_KEY);
});

test("project and session avatar projections retain nested subagents and stable identity", () => {
  const live = snapshot();
  const session = sessionAgentRoster(live, "session-a1");
  const project = projectAgentRoster(live, sessions().slice(0, 2));
  assert.equal(session.items.length, 2);
  assert.equal(project.items.length, 3);
  const nested = session.items.find(item => item.name === "Verifier");
  assert.deepEqual(nested, project.items.find(item => item.agent_id === nested.agent_id));
  assert.equal(agentAvatarMarkup(nested), agentAvatarMarkup(project.items.find(item => item.agent_id === nested.agent_id)));
  assert.equal(sessionAgentRoster(null, "session-a1"), null);
  assert.equal(sessionAgentRoster(live, "not-in-snapshot"), null);
});

test("generated avatars are deterministic local markup and never include source content", () => {
  const item = sessionAgentRoster(snapshot(), "session-a1").items[0];
  item.avatar = { kind: "generated", seed: '"><script>bad()</script>' };
  const markup = agentAvatarMarkup(item);
  assert.equal(markup, agentAvatarMarkup(item));
  assert.doesNotMatch(markup, /script|https?:|bad\(\)/);
  assert.match(markup, /<svg/);
  assert.match(markup, /aria-hidden="true"/);
});

test("native assets use local themed image requests with a stable code fallback", () => {
  const agent = { agent_id: "native-worker", avatar: { kind: "asset", asset_id: "native-original" } };
  const markup = agentAvatarMarkup(agent);
  assert.match(markup, /<picture/);
  assert.match(markup, /media="\(prefers-color-scheme: dark\)"/);
  assert.match(markup, /srcset="\/agents\/avatar\?asset_id=native-original&amp;theme=dark"/);
  assert.match(markup, /src="\/agents\/avatar\?asset_id=native-original&amp;theme=light"/);
  const fallback = agentAvatarMarkup({ ...agent, avatar: null });
  assert.ok(markup.includes(`<span class="agent-avatar-fallback">${fallback}</span>`));
  assert.doesNotMatch(markup, /data-agent-avatar-state="loaded"/);
  assert.equal(agentAvatarMarkup({ ...agent, name: "Renamed", status: "working" }), markup);
});

test("asset IDs remain opaque query data and cannot inject markup or remote URLs", () => {
  const assetId = 'https://remote.invalid/avatar.svg?x=" onerror="bad()&other=1#fragment';
  const markup = agentAvatarMarkup({ agent_id: "worker", avatar: { kind: "asset", asset_id: assetId } });
  const source = /<img[^>]+ src="([^"]+)"/.exec(markup)[1].replaceAll("&amp;", "&");
  const url = new URL(source, "https://sessionbar.invalid");
  assert.equal(url.origin, "https://sessionbar.invalid");
  assert.equal(url.pathname, "/agents/avatar");
  assert.equal(url.searchParams.get("asset_id"), assetId);
  assert.equal(url.searchParams.get("theme"), "light");
  assert.equal([...url.searchParams].length, 2);
  assert.doesNotMatch(markup, /(?:src|srcset)="https?:| onerror="|<script|<img src=x/);
});

test("missing or unusable assets keep the same identity-based generated fallback", () => {
  const agent = { agent_id: "worker", avatar: null };
  const expected = agentAvatarMarkup(agent);
  for (const assetId of ["", "  ", "x".repeat(257), null]) {
    assert.equal(agentAvatarMarkup({ ...agent, avatar: { kind: "asset", asset_id: assetId } }), expected);
  }
  assert.equal(agentAvatarMarkup({ ...agent, avatar: { kind: "generated", seed: agent.agent_id } }), expected);
});

test("project, session and detail use the exact same supplied native asset", () => {
  const live = snapshot();
  const agent = live.agents[1];
  agent.avatar = { kind: "asset", asset_id: "original-source-avatar" };
  const session = sessionAgentRoster(live, "session-a1").items.find(item => item.agent_id === agent.agent_id);
  const project = projectAgentRoster(live, sessions().slice(0, 2)).items.find(item => item.agent_id === agent.agent_id);
  const markup = agentAvatarMarkup(session);
  assert.equal(agentAvatarMarkup(project), markup);
  const detailMarkup = agentDetailMarkup({ agent, snapshot: live, detail: null, loading: false, error: null }, "overview");
  assert.ok(detailMarkup.includes(markup));
});

test("Flow agent nodes reuse the source-selected avatar and the shared failure fallback", () => {
  const live = snapshot();
  live.agents[1].avatar = { kind: "asset", asset_id: "workflow-original-avatar" };
  const markup = sessionFlowMarkup(sessions()[0], live, agentAvatarMarkup);
  assert.match(markup, /asset_id=workflow-original-avatar/);
  assert.match(markup, /agent-avatar-fallback/);
  assert.match(markup, /data-agent-id=/);
});

test("native load state does not change the render comparison or other state attributes", () => {
  const markup = agentAvatarMarkup({ agent_id: "worker", avatar: { kind: "asset", asset_id: "original-source-avatar" } });
  for (const state of ["loaded", "failed"]) {
    const rendered = markup.replace('data-agent-avatar=""', `data-agent-avatar="" data-agent-avatar-state="${state}"`);
    assert.equal(withoutAgentAvatarLoadState(rendered), markup);
  }
  assert.equal(withoutAgentAvatarLoadState('<span data-agent-status="working" aria-pressed="true"></span>'), '<span data-agent-status="working" aria-pressed="true"></span>');
});

test("avatar controls escape identity and name and disclose overflow", () => {
  const base = sessionAgentRoster(snapshot(), "session-a1").items[0];
  const items = Array.from({ length: 9 }, (_, i) => ({ ...base, agent_id: `id-${i}-"`, name: '<img src=x onerror="bad()">' }));
  const roster = { coverage: "partial", items };
  const markup = agentRosterMarkup(roster, 'scope"', items[0].agent_id);
  assert.equal((markup.match(/data-agent-id=/g) || []).length, 6);
  assert.match(markup, />\+3<\/button>/);
  assert.match(markup, /&lt;img/);
  assert.doesNotMatch(markup, /<img/);
  assert.match(markup, /aria-pressed="true"/);
  assert.equal((agentRosterMarkup(roster, "scope", null, true).match(/data-agent-id=/g) || []).length, 9);
  assert.match(agentRosterMarkup({ coverage: "unknown", items: [] }, "scope", null), /not observed/);
  assert.match(agentRosterMarkup({ coverage: "complete", items: [] }, "scope", null), /No sub-agents/);
});

test("agent messages and workflow labels render as escaped text", () => {
  const live = snapshot();
  const value = detail();
  value.conversation.items[0].text = '<img src=x onerror="bad()">\nsecond line';
  value.workflow.items[0].label = "<script>bad()</script>";
  const view = { agent: live.agents[1], snapshot: live, detail: value, loading: false, error: null };
  assert.match(agentDetailMarkup(view, "conversation"), /&lt;img/);
  assert.doesNotMatch(agentDetailMarkup(view, "conversation"), /<img/);
  assert.match(agentDetailMarkup(view, "workflow"), /&lt;script&gt;/);
  assert.doesNotMatch(agentDetailMarkup(view, "workflow"), /<script>/);
  value.conversation.items[0].content_state = "redacted";
  value.conversation.items[0].text = "";
  assert.match(agentDetailMarkup(view, "conversation"), /Message hidden/);
});

test("graph availability does not hide an available event history", () => {
  const live = snapshot();
  const value = detail();
  value.workflow_graph = { availability: "unsupported", graph: null };
  const markup = agentDetailMarkup({ agent: live.agents[1], snapshot: live, detail: value, loading: false, error: null }, "workflow");
  assert.match(markup, /does not provide a workflow graph/);
  assert.match(markup, /Started contract review/);
});

test("agent workflow event details start folded beneath the graph", () => {
  const live = snapshot();
  const markup = agentDetailMarkup({ agent: live.agents[1], snapshot: live, detail: detail(), loading: false, error: null }, "workflow");
  assert.match(markup, /<details class="workflow-history-disclosure"><summary>Observed events/);
  assert.doesNotMatch(markup, /<details[^>]*\bopen\b/);
});

test("load more merges only its requested resource without duplicating repeated items", () => {
  const previous = detail();
  previous.conversation.next_cursor = "next-conversation";
  const incoming = structuredClone(previous);
  incoming.conversation.next_cursor = null;
  incoming.conversation.items = [previous.conversation.items[1], { ...previous.conversation.items[1], message_id: "msg-3", sequence: 3 }];
  incoming.workflow.items[0].label = "This repeated sibling page is ignored";
  const merged = mergeAgentDetailPage(previous, incoming, "conversation");
  assert.equal(merged.conversation.items.length, 3);
  assert.equal(merged.workflow.items[0].label, previous.workflow.items[0].label);
  assert.equal(previous.conversation.items.length, 2);
});

test("pagination rejects wrong scope, repeated cursor, conflicting duplicates, and backwards sequence", () => {
  const previous = detail();
  previous.conversation.next_cursor = "cursor";
  const incoming = structuredClone(previous);
  assert.throws(() => mergeAgentDetailPage(previous, incoming, "conversation"), /did not advance/);
  incoming.conversation.next_cursor = null;
  incoming.agent_id = "wrong";
  assert.throws(() => mergeAgentDetailPage(previous, incoming, "conversation"), /different view/);
  incoming.agent_id = previous.agent_id;
  incoming.conversation.items[0].text = "changed";
  assert.throws(() => mergeAgentDetailPage(previous, incoming, "conversation"), /Conflicting/);
  incoming.conversation.items = [{ ...previous.conversation.items[0], message_id: "backwards", sequence: 0 }];
  assert.throws(() => mergeAgentDetailPage(previous, incoming, "conversation"), /Out-of-order/);
});

test("snapshot refresh is single-flight and preserves last good state on optional API failure", async t => {
  let calls = 0;
  let response = deferred();
  const client = new AgentClient(async () => { calls++; return response.promise; }, () => {});
  t.after(() => client.stop());
  const first = client.refreshSnapshot();
  assert.strictEqual(client.refreshSnapshot(), first);
  assert.equal(calls, 1);
  response.resolve(reply(snapshot()));
  await first;
  const previous = structuredClone(client.snapshot);
  response = deferred();
  const failed = client.refreshSnapshot();
  response.resolve(new Response("", { status: 404 }));
  await failed;
  assert.deepEqual(client.snapshot, previous);
});

test("pending agent detail remains bound to its frozen snapshot after unrelated updates", async t => {
  let live = snapshot();
  const waiting = deferred();
  const client = new AgentClient(async url => url === "/agents/live" ? reply(live) : waiting.promise, () => {});
  t.after(() => client.stop());
  await client.refreshSnapshot();
  client.select(live.agents[1].agent_id);
  live = { ...live, revision: live.revision + 1 };
  await client.refreshSnapshot();
  waiting.resolve(reply(detail()));
  await settled(client);
  assert.equal(client.snapshot.revision, 11);
  assert.equal(client.selected.snapshot.revision, 10);
  assert.equal(client.selected.detail.revision, 10);
  assert.equal(client.selected.error, null);
});

test("late response from a previous agent cannot replace the newly selected agent", async t => {
  const live = snapshot();
  const first = deferred();
  const second = deferred();
  const signals = [];
  const client = new AgentClient(async (url, options) => {
    if (url === "/agents/live") return reply(live);
    signals.push(options.signal);
    const id = new URL(url, "http://local.invalid").searchParams.get("agent_id");
    return id === live.agents[1].agent_id ? first.promise : second.promise;
  }, () => {});
  t.after(() => client.stop());
  await client.refreshSnapshot();
  client.select(live.agents[1].agent_id);
  client.select(live.agents[2].agent_id);
  assert.equal(signals[0].aborted, true);
  second.resolve(reply({ ...detail(), agent_id: live.agents[2].agent_id }));
  await settled(client);
  first.resolve(reply(detail()));
  await new Promise(setImmediate);
  assert.equal(client.selected.agent.agent_id, live.agents[2].agent_id);
  assert.equal(client.selected.detail.agent_id, live.agents[2].agent_id);
});

test("pagination query tracks each cursor and does not duplicate the sibling history", async t => {
  const live = snapshot();
  const queries = [];
  const base = detail();
  base.conversation.next_cursor = "conversation-page-two";
  base.workflow.next_cursor = "workflow-page-two";
  const client = new AgentClient(async url => {
    if (url === "/agents/live") return reply(live);
    const query = new URL(url, "http://local.invalid").searchParams;
    queries.push(query);
    const page = structuredClone(base);
    if (query.has("conversation_cursor")) {
      page.conversation.items = [{ ...base.conversation.items[1], message_id: "m3", sequence: 3 }];
      page.conversation.next_cursor = null;
    }
    if (query.has("workflow_cursor")) {
      page.workflow.items = [{ ...base.workflow.items[1], event_id: "e3", sequence: 3 }];
      page.workflow.next_cursor = null;
    }
    return reply(page);
  }, () => {});
  t.after(() => client.stop());
  await client.refreshSnapshot();
  client.select(live.agents[1].agent_id);
  await settled(client);
  assert.equal(queries[0].has("conversation_cursor"), false);
  await client.loadMore("conversation");
  assert.equal(queries[1].get("conversation_cursor"), "conversation-page-two");
  assert.equal(queries[1].has("workflow_cursor"), false);
  assert.equal(client.selected.detail.conversation.items.length, 3);
  assert.equal(client.selected.detail.workflow.items.length, 2);
  await client.loadMore("workflow");
  assert.equal(queries[2].get("conversation_cursor"), "conversation-page-two");
  assert.equal(queries[2].get("workflow_cursor"), "workflow-page-two");
  assert.equal(client.selected.detail.conversation.items.length, 3);
  assert.equal(client.selected.detail.workflow.items.length, 3);
});

test("expired frozen view refreshes roster and asks for explicit detail refresh", async t => {
  let live = snapshot();
  let expired = true;
  const client = new AgentClient(async url => {
    if (url === "/agents/live") return reply(live);
    if (expired) { live = { ...live, revision: 11 }; return new Response("", { status: 410 }); }
    return reply({ ...detail(), revision: 11 });
  }, () => {});
  t.after(() => client.stop());
  await client.refreshSnapshot();
  client.select(live.agents[1].agent_id);
  await settled(client);
  assert.equal(client.snapshot.revision, 11);
  assert.equal(client.selected.snapshot.revision, 10);
  assert.match(client.selected.error, /expired/);
  expired = false;
  await client.refreshDetail();
  await settled(client);
  assert.equal(client.selected.detail.revision, 11);
});

test("a removed agent or new stream clears old detail selection", async t => {
  let live = snapshot();
  const client = new AgentClient(async url => url === "/agents/live" ? reply(live) : reply(detail()), () => {});
  t.after(() => client.stop());
  await client.refreshSnapshot();
  client.select(live.agents[2].agent_id);
  await settled(client);
  live = { ...live, revision: 11, agents: live.agents.filter(item => item.agent_id !== live.agents[2].agent_id) };
  await client.refreshSnapshot();
  assert.equal(client.selected, null);
  client.select(live.agents[1].agent_id);
  await settled(client);
  live = { ...live, stream_id: "new-stream", revision: 0 };
  await client.refreshSnapshot();
  assert.equal(client.selected, null);
});

test("malformed detail fails closed instead of rendering another agent's messages", async t => {
  const live = snapshot();
  const client = new AgentClient(async url => url === "/agents/live" ? reply(live) : reply({ ...detail(), agent_id: agentId({ ...live.agents[1].identity, native_agent_id: "wrong" }) }), () => {});
  t.after(() => client.stop());
  await client.refreshSnapshot();
  client.select(live.agents[1].agent_id);
  await settled(client);
  assert.equal(client.selected.detail, null);
  assert.match(client.selected.error, /could not be loaded/);
});
