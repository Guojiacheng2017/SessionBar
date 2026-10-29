import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import express from 'express';
import { AgentService, AgentServiceError } from '../dist/agents/agentService.js';
import { createAgentRouter } from '../dist/server/agentRoutes.js';
import { agentId } from '../dist/shared/agentContract.js';

function fixture() {
  const session = { session_id: 'session-route', session_type: 'Codex', project: 'Fixture', project_path: '/fixture', status: 'working', task_name: 'Synthetic', timestamp: 1000 };
  const identity = { source_id: 'test', session_id: session.session_id, native_agent_id: 'worker', generation: 'persistent' };
  const agent = { agent_id: agentId(identity), identity, role: 'subagent', parent_agent_id: null, name: 'Worker', provider_id: null, avatar: null, status: 'idle', lifecycle: 'active', updated_at: 1000 };
  const detail = {
    execution: { events: [], truncated_before: false },
    conversation: { availability: 'available', items: [{ message_id: 'm-1', sequence: 0, role: 'assistant', text: 'Synthetic message', content_state: 'complete', occurred_at: 1000 }], truncated_before: false },
    workflow: { availability: 'unsupported', items: [], truncated_before: false },
    workflow_graph: { availability: 'unsupported', graph: null },
  };
  let now = 1000;
  const service = new AgentService({ getSessions: () => [session], collector: { collect: async () => ({ agents: [agent], coverage: { [session.session_id]: 'complete' }, details: new Map([[agent.agent_id, detail]]) }) }, streamId: 'route-stream', now: () => now, refreshMs: 0 });
  return { service, session, agent, detail, setNow: value => { now = value; } };
}

async function serve(t, service, authorize, avatars) {
  const app = express();
  if (authorize) app.use(authorize);
  app.use('/agents', createAgentRouter(service, avatars));
  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(0, '127.0.0.1', error => error ? reject(error) : resolve(listener));
    listener.once('error', reject);
  });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

function query(snapshot, session, agent, overrides = {}) {
  return new URLSearchParams({ stream_id: snapshot.stream_id, revision: String(snapshot.revision), session_id: session.session_id, agent_id: agent.agent_id, ...overrides });
}

test('read routes return versioned snapshot and exact agent detail with no-store', async t => {
  const f = fixture();
  const url = await serve(t, f.service);
  const live = await fetch(`${url}/agents/live`);
  assert.equal(live.status, 200);
  assert.equal(live.headers.get('cache-control'), 'no-store');
  const snapshot = await live.json();
  assert.equal(snapshot.kind, 'snapshot');
  assert.equal(snapshot.agents[0].agent_id, f.agent.agent_id);
  const detailResponse = await fetch(`${url}/agents/detail?${query(snapshot, f.session, f.agent)}`);
  assert.equal(detailResponse.status, 200);
  assert.equal(detailResponse.headers.get('cache-control'), 'no-store');
  const detail = await detailResponse.json();
  assert.equal(detail.kind, 'agent_detail');
  assert.equal(detail.agent_id, f.agent.agent_id);
  assert.equal(detail.conversation.items[0].text, 'Synthetic message');
});

test('live execution route observes later changes without replaying baseline or changing frozen detail shape', async t => {
  const f = fixture();
  f.detail.execution.events = [{ event_id: 'old', sequence: 1, at: 500, kind: 'call.start', call_id: 'old', label: 'Bash' }];
  const url = await serve(t, f.service), query = new URLSearchParams({ session_id: f.session.session_id });
  const initial = await fetch(`${url}/agents/execution?${query}`);
  assert.equal(initial.status, 200); assert.equal(initial.headers.get('cache-control'), 'no-store');
  assert.deepEqual((await initial.json()).spans, []);
  f.detail.execution.events.push({ event_id: 'new-start', sequence: 2, at: 1100, kind: 'call.start', call_id: 'new', label: 'Bash' },
    { event_id: 'new-end', sequence: 3, at: 1900, kind: 'call.end', call_id: 'new', label: 'Bash', outcome: 'completed' });
  f.setNow(2000);
  const current = await (await fetch(`${url}/agents/execution?${query}`)).json();
  assert.equal(current.spans.length, 1);
  assert.deepEqual([current.spans[0].started_at, current.spans[0].ended_at], [1100, 1900]);
  assert.doesNotMatch(JSON.stringify(current), /Synthetic message|\/fixture/);
  assert.equal((await fetch(`${url}/agents/execution?session_id=missing`)).status, 404);
  assert.equal((await fetch(`${url}/agents/execution?session_id=a&session_id=b`)).status, 400);
});

test('execution observation inherits authentication before reading native data', async t => {
  let reads = 0;
  const url = await serve(t, { execution: async () => { reads++; } }, (_req, res) => res.status(403).end());
  assert.equal((await fetch(`${url}/agents/execution?session_id=session-route`)).status, 403);
  assert.equal(reads, 0);
});

test('native avatar route returns the original selected SVG and theme without executable document permissions', async t => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>';
  const observed = [];
  const url = await serve(t, fixture().service, undefined, { getAsset: async (id, theme) => { observed.push([id, theme]); return svg; } });
  for (const theme of ['light', 'dark']) {
    const response = await fetch(`${url}/agents/avatar?asset_id=codex-native-example&theme=${theme}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^image\/svg\+xml/);
    assert.equal(response.headers.get('cache-control'), 'private, max-age=86400, immutable');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.match(response.headers.get('content-security-policy'), /default-src 'none'; sandbox/);
    assert.equal(await response.text(), svg);
  }
  assert.deepEqual(observed, [['codex-native-example', 'light'], ['codex-native-example', 'dark']]);
});

test('avatar requests reject path/URL input, duplicate fields, and invalid themes before asset lookup', async t => {
  let calls = 0;
  const url = await serve(t, fixture().service, undefined, { getAsset: async () => { calls++; return null; } });
  for (const query of ['', 'asset_id=..%2Fsecret', 'asset_id=https%3A%2F%2Fexample.com', 'asset_id=a&asset_id=b',
    'asset_id=a&theme=auto', 'asset_id=a&theme=light&theme=dark', 'asset_id=' + 'a'.repeat(257)]) {
    const response = await fetch(`${url}/agents/avatar?${query}`);
    assert.equal(response.status, 400, query);
    assert.deepEqual(await response.json(), { error: 'invalid_request' });
  }
  assert.equal(calls, 0);
});

test('unavailable or failed native resources return safe errors for browser fallback', async t => {
  for (const source of [undefined, { getAsset: async () => null }, { getAsset: async () => { throw new Error('/private/user/SECRET'); } }]) {
    const url = await serve(t, fixture().service, undefined, source);
    const response = await fetch(`${url}/agents/avatar?asset_id=unknown`);
    assert.ok([404, 503].includes(response.status));
    assert.doesNotMatch(await response.text(), /private|SECRET/);
  }
});

test('avatar route inherits authentication before reading any local resources', async t => {
  let calls = 0;
  const url = await serve(t, fixture().service, (_req, res) => res.status(403).end(), { getAsset: async () => { calls++; return null; } });
  assert.equal((await fetch(`${url}/agents/avatar?asset_id=native-asset`)).status, 403);
  assert.equal(calls, 0);
});

test('detail route rejects malformed query shapes before calling service', async t => {
  const f = fixture();
  const snapshot = await f.service.snapshot();
  let calls = 0;
  const service = { snapshot: () => f.service.snapshot(), detail: async () => { calls++; throw new Error('must not run'); } };
  const url = await serve(t, service);
  const cases = [
    '',
    query(snapshot, f.session, f.agent, { revision: '-1' }),
    query(snapshot, f.session, f.agent, { revision: '1.5' }),
    query(snapshot, f.session, f.agent, { revision: '01' }),
    query(snapshot, f.session, f.agent, { revision: '9007199254740992' }),
    query(snapshot, f.session, f.agent, { session_id: ' ' }),
    query(snapshot, f.session, f.agent, { conversation_cursor: '' }),
    query(snapshot, f.session, f.agent, { workflow_cursor: 'x'.repeat(2049) }),
    `${query(snapshot, f.session, f.agent)}&session_id=second`,
    `${query(snapshot, f.session, f.agent)}&revision=2`,
  ];
  for (const queryString of cases) {
    const response = await fetch(`${url}/agents/detail?${queryString}`);
    assert.equal(response.status, 400, String(queryString));
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { error: 'invalid_request' });
  }
  assert.equal(calls, 0);
});

test('scope, retention, and cursor errors preserve distinct HTTP status codes', async t => {
  const f = fixture();
  const snapshot = await f.service.snapshot();
  const url = await serve(t, f.service);
  for (const [overrides, status, code] of [
    [{ agent_id: 'missing' }, 404, 'agent_not_found'],
    [{ session_id: 'other' }, 404, 'agent_not_found'],
    [{ stream_id: 'expired' }, 410, 'snapshot_expired'],
    [{ revision: '999' }, 410, 'snapshot_expired'],
    [{ conversation_cursor: 'invalid' }, 400, 'invalid_cursor'],
  ]) {
    const response = await fetch(`${url}/agents/detail?${query(snapshot, f.session, f.agent, overrides)}`);
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { error: code });
  }
});

test('unexpected failures never expose transcript text or local filesystem paths', async t => {
  const failure = async () => { throw new Error('/private/user/session.jsonl SECRET TRANSCRIPT'); };
  const url = await serve(t, { snapshot: failure, detail: failure });
  for (const path of ['/agents/live', '/agents/detail?stream_id=test&revision=1&session_id=session&agent_id=agent']) {
    const response = await fetch(url + path);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { error: 'agents_unavailable' });
  }
});

test('explicit resource limit is returned as a safe service error', async t => {
  const url = await serve(t, { snapshot: async () => { throw new AgentServiceError(503, 'agent_data_limit'); } });
  const response = await fetch(`${url}/agents/live`);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'agent_data_limit' });
});

test('host authentication middleware prevents reads before router source access', async t => {
  let calls = 0;
  const url = await serve(t, { snapshot: async () => { calls++; return {}; } }, (_req, res) => res.status(403).json({ error: 'read_scope_required' }));
  const response = await fetch(`${url}/agents/live`);
  assert.equal(response.status, 403);
  assert.equal(calls, 0);
});

test('production mount inherits existing authentication and read scope boundaries', () => {
  const source = readFileSync(new URL('../src/server/server.ts', import.meta.url), 'utf8');
  const mount = source.indexOf('app.use("/agents"');
  assert.ok(mount > source.indexOf('app.use(requireAuth)'), 'agent router must be after authentication');
  assert.ok(mount > source.indexOf('app.use(requireDeviceScope("read"))'), 'agent router must be after read scope');
});
