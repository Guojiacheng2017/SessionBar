import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const agents = await import("../dist/tui/agentInspector.js").catch(() => ({}));
const providers = await import("../dist/tui/providerInspector.js").catch(() => ({}));
const monitor = await import("../dist/tui/openTuiMonitor.js");
const example = name => JSON.parse(readFileSync(new URL(`./fixtures/agents/${name}.example.json`, import.meta.url), "utf8"));

test("agent terminal list uses real identities, session scope and filter", () => {
  assert.equal(typeof agents.agentList, "function");
  const snapshot = example("snapshot");
  const rows = agents.agentList(snapshot, ["session-a1"], "");
  assert.equal(rows.length, 2);
  assert.ok(rows.every(agent => agent.role === "subagent" && agent.identity.session_id === "session-a1"));
  assert.equal(agents.agentList(null, [], "").length, 0);
  assert.equal(agents.agentList(snapshot, ["session-a1"], "Verifier").length, 1);
});

test("agent detail includes native conversation, graph and events without synthetic progress", () => {
  assert.equal(typeof agents.agentDetailText, "function");
  const snapshot = example("snapshot"), detail = example("agent-detail");
  const selected = { agent: snapshot.agents.find(item => item.agent_id === detail.agent_id), snapshot, detail, loading: false, error: null };
  const conversation = agents.agentDetailText(selected, "conversation", 48);
  assert.match(conversation, /Inspect the synthetic contract/);
  assert.match(conversation, /assistant/);
  const flow = agents.agentDetailText(selected, "workflow", 48);
  assert.match(flow, /Inspect contract/);
  assert.match(flow, /tool.execute/);
  assert.ok(flow.split("\n").every(line => line.length <= 48));
  for (const availability of ["unsupported", "unknown", "redacted"]) {
    const empty = structuredClone(selected);
    empty.detail.conversation = { availability, items: [], next_cursor: null, truncated_before: false };
    assert.equal(agents.agentDetailText(empty, "conversation", 48), "");
  }
  selected.detail.conversation.items[0].text = "safe\x1b[2J unsafe";
  assert.doesNotMatch(agents.agentDetailText(selected, "conversation", 48), /\x1b/);
  selected.error = "Refresh failed";
  const retained = agents.agentDetailText(selected, "conversation", 48);
  assert.match(retained, /Refresh failed/);
  assert.match(retained, /Checking parent and session references/);
});

test("provider terminal detail shares the WebUI metric selector and leaves gaps empty", () => {
  assert.equal(typeof providers.providerDetailText, "function");
  const row = { provider: "openai", label: "OpenAI", form: "api", level: "green", unit: "USD", usageTrends: {
    token: { kind: "bars", days: 7, unit: "tokens", points: [20, null, 40] },
    cash: { kind: "bars", days: 7, unit: "USD", points: [1, 2, 3] },
  } };
  assert.match(providers.providerDetailText(row, "token", 48), /tokens/);
  assert.match(providers.providerDetailText(row, "cash", 48), /USD/);
  assert.doesNotMatch(providers.providerDetailText(row, "cash", 48), /remaining 0|used 0/);
  assert.equal(providers.providerDetailText(undefined, "percentage", 48), "");
  assert.ok(providers.providerDetailText(row, "token", 28).split("\n").every(line => line.length <= 28));
  assert.match(providers.providerDetailText({ ...row, stale: true, collectionError: "Timed out" }, "cash", 48), /Timed out\nSTALE/);
});

test("monitor exposes Agent scopes, empty unsupported content and independent provider details", () => {
  const snapshot = example("snapshot"), detail = example("agent-detail");
  const state = {
    sessions: [], providers: [], view: "agents", filterText: "", filterActive: false,
    agentSnapshot: snapshot, agentTab: "conversation",
    agentSelection: { agent: snapshot.agents.find(item => item.agent_id === detail.agent_id), snapshot, detail, loading: false, error: null },
  };
  const model = monitor.monitorVisibleModel(state, { width: 140, height: 36 });
  assert.equal(model.view, "agents");
  assert.match(model.detailsContent, /Inspect the synthetic contract/);
  assert.equal(model.providersVisible, false);
  const unavailable = structuredClone(state);
  unavailable.agentSelection.detail.conversation = { availability: "unsupported", items: [], next_cursor: null, truncated_before: false };
  assert.equal(monitor.monitorVisibleModel(unavailable, { width: 80, height: 24 }).detailsContent, "");
  assert.equal(monitor.nextVisibleFreshnessDelay(state, { width: 140, height: 36 }, Date.now()), undefined);
  assert.equal(monitor.nextViewFromMonitorKey("sessions", { name: "A", raw: "A" }), "agents");
  assert.equal(monitor.nextViewFromMonitorKey("agents", { name: "A", raw: "A" }), "sessions");
  const providerModel = monitor.monitorVisibleModel({ ...state, view: "providers", providers: [{ provider: "openai", label: "OpenAI", form: "api", unit: "USD", remaining: 7, level: "green" }], providerUsageMode: "cash" }, { width: 140, height: 36 });
  assert.match(providerModel.detailsContent, /Remaining\s+7 USD/);
  assert.match(providerModel.detailsTitle, /Cash/);
});
