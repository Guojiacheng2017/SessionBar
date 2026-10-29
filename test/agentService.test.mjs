import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentService, AgentServiceError, agentProjectId } from '../dist/agents/agentService.js';
import { agentId } from '../dist/shared/agentContract.js';

function fixture(options = {}) {
  let now = 1000;
  let calls = 0;
  const sessions = ['one', 'two'].map((name, index) => ({
    session_id: `session-${name}`, session_type: 'Codex', session_name: name,
    project: 'Same name', project_path: `/work/${index}`, status: 'working',
    task_name: 'Inspect synthetic data', timestamp: 1000,
  }));
  const agents = sessions.map((session, index) => {
    const identity = { source_id: 'source-test', session_id: session.session_id, native_agent_id: `child-${index}`, generation: 'persistent' };
    return {
      agent_id: agentId(identity), identity, role: 'subagent', parent_agent_id: null,
      name: `Worker ${index}`, provider_id: 'openai', avatar: null,
      status: 'working', lifecycle: 'active', updated_at: 1000,
    };
  });
  const details = new Map(agents.map(agent => [agent.agent_id, {
    conversation: { availability: 'available', truncated_before: false, items: Array.from({ length: 5 }, (_, index) => ({
      message_id: `m-${index}`, sequence: index, role: 'assistant', text: `${agent.name} message ${index}`,
      content_state: 'complete', occurred_at: 1000 + index,
    })) },
    workflow: { availability: 'available', truncated_before: true, items: Array.from({ length: 5 }, (_, index) => ({
      event_id: `e-${index}`, sequence: index, stage: 'tool.execute', label: `Event ${index}`, occurred_at: 1000 + index,
    })) },
    workflow_graph: { availability: 'unsupported', graph: null },
  }]));
  const collected = { agents, coverage: Object.fromEntries(sessions.map(s => [s.session_id, 'complete'])), details };
  const service = new AgentService({
    getSessions: () => sessions,
    collector: { collect: async () => { calls++; return collected; } },
    now: () => now, streamId: 'stream-test', pageSize: 2, refreshMs: 0,
    ...options,
  });
  return { service, sessions, collected, agents, details, advance: ms => { now += ms; }, calls: () => calls };
}

const requestFor = (snapshot, agent) => ({ stream_id: snapshot.stream_id, revision: snapshot.revision, session_id: agent.identity.session_id, agent_id: agent.agent_id });
const errorIs = (status, code) => error => error instanceof AgentServiceError && error.status === status && error.code === code;

test('unchanged reads and reordered entities keep revision; details-only edits advance it', async () => {
  const f = fixture();
  const first = await f.service.snapshot();
  f.sessions.reverse();
  f.agents.reverse();
  f.collected.details = new Map([...f.details].reverse());
  const second = await f.service.snapshot();
  assert.deepEqual(second, first);
  f.details.get(f.agents[0].agent_id).conversation.items[0].text = 'Updated visible message';
  const third = await f.service.snapshot();
  assert.equal(third.revision, first.revision + 1);
  assert.deepEqual(third.agents, first.agents);
});

test('simultaneous reads share one collection and cached reads honor the interval', async () => {
  const base = fixture();
  let release;
  let calls = 0;
  let now = 100;
  const gate = new Promise(resolve => { release = resolve; });
  const service = new AgentService({
    getSessions: () => base.sessions,
    collector: { collect: async () => { calls++; await gate; return base.collected; } },
    now: () => now, refreshMs: 4000,
  });
  const pending = [service.snapshot(), service.snapshot(), service.snapshot()];
  assert.equal(calls, 1);
  release();
  const [a, b, c] = await Promise.all(pending);
  assert.deepEqual(a, b); assert.deepEqual(b, c);
  assert.notStrictEqual(a, b);
  now += 3999;
  await service.snapshot();
  assert.equal(calls, 1);
  now += 1;
  await service.snapshot();
  assert.equal(calls, 2);
});

test('failed collection can recover without retaining a rejected single-flight promise', async () => {
  const f = fixture();
  let fail = true;
  const service = new AgentService({
    getSessions: () => f.sessions,
    collector: { collect: async () => { if (fail) throw new Error('fixture failure'); return f.collected; } },
  });
  await assert.rejects(service.snapshot(), /fixture failure/);
  fail = false;
  assert.equal((await service.snapshot()).agents.length, 2);
});

test('conversation and workflow paginate independently without duplicate entries', async () => {
  const f = fixture();
  const snapshot = await f.service.snapshot();
  const request = requestFor(snapshot, f.agents[0]);
  const first = await f.service.detail(request);
  const second = await f.service.detail({ ...request, conversation_cursor: first.conversation.next_cursor });
  assert.deepEqual(first.conversation.items.map(item => item.sequence), [0, 1]);
  assert.deepEqual(second.conversation.items.map(item => item.sequence), [2, 3]);
  assert.deepEqual(second.workflow, first.workflow);
  assert.equal(second.workflow.truncated_before, true);
  const third = await f.service.detail({ ...request, conversation_cursor: second.conversation.next_cursor, workflow_cursor: first.workflow.next_cursor });
  assert.deepEqual(third.conversation.items.map(item => item.sequence), [4]);
  assert.equal(third.conversation.next_cursor, null);
  assert.deepEqual(third.workflow.items.map(item => item.sequence), [2, 3]);
  const all = [...first.conversation.items, ...second.conversation.items, ...third.conversation.items];
  assert.equal(new Set(all.map(item => item.message_id)).size, 5);
});

test('cursor is bound to agent, resource, revision, and signature', async () => {
  const f = fixture();
  const snapshot = await f.service.snapshot();
  const request = requestFor(snapshot, f.agents[0]);
  const first = await f.service.detail(request);
  const cursor = first.conversation.next_cursor;
  await assert.rejects(f.service.detail({ ...requestFor(snapshot, f.agents[1]), conversation_cursor: cursor }), errorIs(400, 'invalid_cursor'));
  await assert.rejects(f.service.detail({ ...request, workflow_cursor: cursor }), errorIs(400, 'invalid_cursor'));
  for (const invalid of [cursor.slice(0, -1) + (cursor.endsWith('0') ? '1' : '0'), cursor + '.extra', 'not-a-cursor', 'x'.repeat(2049)]) {
    await assert.rejects(f.service.detail({ ...request, conversation_cursor: invalid }), errorIs(400, 'invalid_cursor'));
  }
  f.agents[0].name = 'Renamed';
  const next = await f.service.snapshot();
  await assert.rejects(f.service.detail({ ...request, revision: next.revision, conversation_cursor: cursor }), errorIs(400, 'invalid_cursor'));
});

test('cursor from another receiver cannot be replayed even with matching stream label', async () => {
  const a = fixture();
  const b = fixture();
  const snapshot = await a.service.snapshot();
  const request = requestFor(snapshot, a.agents[0]);
  const page = await a.service.detail(request);
  await b.service.snapshot();
  await assert.rejects(b.service.detail({ ...request, conversation_cursor: page.conversation.next_cursor }), errorIs(400, 'invalid_cursor'));
});

test('frozen revision retains original pages after newer content arrives', async () => {
  const f = fixture();
  const snapshot = await f.service.snapshot();
  const request = requestFor(snapshot, f.agents[0]);
  const first = await f.service.detail(request);
  f.details.get(f.agents[0].agent_id).conversation.items[2].text = 'Changed in next revision';
  const current = await f.service.snapshot();
  const oldPage = await f.service.detail({ ...request, conversation_cursor: first.conversation.next_cursor });
  assert.equal(oldPage.conversation.items[0].text, 'Worker 0 message 2');
  const newFirst = await f.service.detail({ ...request, revision: current.revision });
  const newPage = await f.service.detail({ ...request, revision: current.revision, conversation_cursor: newFirst.conversation.next_cursor });
  assert.equal(newPage.conversation.items[0].text, 'Changed in next revision');
});

test('detail rejects cross-session, absent agent, unknown revision, and new stream', async () => {
  const f = fixture();
  const snapshot = await f.service.snapshot();
  const request = requestFor(snapshot, f.agents[0]);
  await assert.rejects(f.service.detail({ ...request, session_id: f.sessions[1].session_id }), errorIs(404, 'agent_not_found'));
  await assert.rejects(f.service.detail({ ...request, agent_id: 'missing' }), errorIs(404, 'agent_not_found'));
  await assert.rejects(f.service.detail({ ...request, revision: 999 }), errorIs(410, 'snapshot_expired'));
  await assert.rejects(f.service.detail({ ...request, stream_id: 'new-stream' }), errorIs(410, 'snapshot_expired'));
});

test('removed agent cannot be read through its old frozen revision', async () => {
  const f = fixture();
  const snapshot = await f.service.snapshot();
  const request = requestFor(snapshot, f.agents[0]);
  f.collected.agents = f.collected.agents.filter(agent => agent.agent_id !== request.agent_id);
  await f.service.snapshot();
  await assert.rejects(f.service.detail(request), errorIs(404, 'agent_not_found'));
});

test('history TTL expires old pages while preserving current unchanged content', async () => {
  const f = fixture({ historyMs: 100 });
  const old = await f.service.snapshot();
  const request = requestFor(old, f.agents[0]);
  f.advance(50);
  f.agents[0].name = 'New name';
  const current = await f.service.snapshot();
  await f.service.detail(request);
  f.advance(51);
  await assert.rejects(f.service.detail(request), errorIs(410, 'snapshot_expired'));
  f.advance(1000);
  assert.equal((await f.service.detail({ ...request, revision: current.revision })).revision, current.revision);
});

test('history count bound retires oldest snapshots', async () => {
  const f = fixture({ historyLimit: 2 });
  const first = await f.service.snapshot();
  const request = requestFor(first, f.agents[0]);
  f.agents[0].name = 'Second';
  const second = await f.service.snapshot();
  f.agents[0].name = 'Third';
  await f.service.snapshot();
  await assert.rejects(f.service.detail(request), errorIs(410, 'snapshot_expired'));
  assert.equal((await f.service.detail({ ...request, revision: second.revision })).revision, second.revision);
});

test('a recently advertised unchanged snapshot does not expire as soon as data changes', async () => {
  const f = fixture({ historyMs: 100, refreshMs: 0 });
  await f.service.snapshot();
  f.advance(1000);
  const advertised = await f.service.snapshot();
  f.advance(1);
  f.agents[0].name = 'New data after a long quiet period';
  await f.service.snapshot();
  const retained = await f.service.detail(requestFor(advertised, f.agents[0]));
  assert.equal(retained.revision, advertised.revision);
});

test('over-budget snapshots fail explicitly without corrupting the last retained state', async () => {
  const f = fixture({ historyBytes: 10000 });
  const snapshot = await f.service.snapshot();
  const source = f.details.get(f.agents[0].agent_id);
  const before = source.conversation.items[0].text;
  source.conversation.items[0].text = 'x'.repeat(16000);
  await assert.rejects(f.service.snapshot(), errorIs(503, 'agent_data_limit'));
  source.conversation.items[0].text = before;
  assert.deepEqual(await f.service.snapshot(), snapshot);
});

test('service owns frozen copies and never exposes mutable collector or session objects', async () => {
  const f = fixture();
  const sessionsBefore = structuredClone(f.sessions);
  const collectedBefore = structuredClone(f.collected);
  const first = await f.service.snapshot();
  const request = requestFor(first, f.agents[0]);
  const detail = await f.service.detail(request);
  first.agents[0].name = 'Consumer edit';
  first.sessions[0].name = 'Consumer edit';
  detail.conversation.items[0].text = 'Consumer edit';
  assert.deepEqual(f.sessions, sessionsBefore);
  assert.deepEqual(f.collected, collectedBefore);
  assert.notEqual((await f.service.snapshot()).agents[0].name, 'Consumer edit');
  assert.notEqual((await f.service.detail(request)).conversation.items[0].text, 'Consumer edit');
});

test('missing details remain unknown and do not masquerade as empty available history', async () => {
  const f = fixture();
  f.details.delete(f.agents[0].agent_id);
  const snapshot = await f.service.snapshot();
  const detail = await f.service.detail(requestFor(snapshot, f.agents[0]));
  assert.deepEqual(detail.conversation, { availability: 'unknown', items: [], truncated_before: false, next_cursor: null });
  assert.deepEqual(detail.workflow_graph, { availability: 'unknown', graph: null });
});

test('project identity isolates names, remote harnesses, and unknown workspace paths', () => {
  const base = fixture().sessions[0];
  const local = agentProjectId(base);
  assert.equal(agentProjectId({ ...base, project: 'Renamed', session_id: 'other', project_path: `${base.project_path}/` }), local);
  assert.notEqual(agentProjectId({ ...base, project_path: '/other/workspace' }), local);
  const remote = agentProjectId({ ...base, origin: 'remote', harness_instance_id: 'host-a' });
  assert.notEqual(remote, local);
  assert.notEqual(agentProjectId({ ...base, origin: 'remote', harness_instance_id: 'host-b' }), remote);
  assert.equal(agentProjectId({ ...base, project_path: undefined }), null);
  assert.equal(agentProjectId({ ...base, project_path: undefined, project: undefined }), null);
});

test('sessions without a verified workspace remain unassigned instead of creating phantom projects', async () => {
  const f = fixture();
  f.sessions[0].project_path = undefined;
  f.sessions[1].project_path = undefined;
  const snapshot = await f.service.snapshot();
  assert.equal(snapshot.projects.length, 0);
  assert.ok(snapshot.sessions.every(session => session.project_id === null));
});

test('root workspace remains one project across sessions', () => {
  const base = { ...fixture().sessions[0], project_path: '/' };
  assert.equal(agentProjectId(base), agentProjectId({ ...base, session_id: 'another-session' }));
});

test('invalid page sizes are rejected before any source read', () => {
  for (const pageSize of [0, -1, 201, 1.5, NaN]) assert.throws(() => fixture({ pageSize }), /invalid agent page size/);
});
