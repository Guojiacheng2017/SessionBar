import assert from 'node:assert/strict';
import test from 'node:test';
import { createCompositeAgentCollector } from '../dist/agents/agentCollector.js';
import { agentId } from '../dist/shared/agentContract.js';
import { AgentService } from '../dist/agents/agentService.js';

const session = (id, type = 'Codex', extra = {}) => ({ session_id: id, session_type: type,
  project_path: '/fixture/project', project: 'Fixture', status: 'idle', task_name: 'Test', timestamp: 1000, ...extra });
function resultFor(sessions, source = 'test') {
  const agents = sessions.map(s => {
    const identity = { source_id: source, session_id: s.session_id, native_agent_id: 'same-native-id', generation: 'persistent' };
    return { agent_id: agentId(identity), identity, role: 'subagent', parent_agent_id: null,
      name: source, provider_id: null, avatar: null, status: 'working', lifecycle: 'active', updated_at: 1000 };
  });
  return { agents, coverage: Object.fromEntries(sessions.map(s => [s.session_id, 'partial'])),
    details: new Map(agents.map(a => [a.agent_id, {
      conversation: { availability: 'available', items: [{ message_id: 'message', sequence: 1, role: 'assistant', text: a.identity.source_id, content_state: 'complete', occurred_at: 1000 }], truncated_before: false },
      workflow: { availability: 'unsupported', items: [], truncated_before: false }, workflow_graph: { availability: 'unsupported', graph: null },
    }])) };
}

test('dispatches only each harness local sessions and preserves distinct identities and details', async () => {
  const rows = [session('codex'), session('claude', 'Claude Code'), session('dsh', 'DeepSeek Harness'), session('remote', 'Codex', { origin: 'remote' }), session('other', 'Claude Desktop')];
  const calls = [];
  const collector = createCompositeAgentCollector(['Codex', 'Claude Code', 'DeepSeek Harness'].map(type => ({ sessionTypes: [type],
    collector: { collect: async (group, now) => { calls.push([type, group.map(s => s.session_id), now]); return resultFor(group, type); } },
  })));
  const service = new AgentService({ getSessions: () => rows, collector, now: () => 5000 });
  const snapshot = await service.snapshot();
  assert.deepEqual(calls, [['Codex', ['codex'], 5000], ['Claude Code', ['claude'], 5000], ['DeepSeek Harness', ['dsh'], 5000]]);
  assert.equal(snapshot.agents.length, 3);
  assert.equal(new Set(snapshot.agents.map(a => a.agent_id)).size, 3);
  assert.equal(snapshot.sessions.find(s => s.session_id === 'remote').agents_coverage, 'unsupported');
  assert.equal(snapshot.sessions.find(s => s.session_id === 'other').agents_coverage, 'unsupported');
  for (const agent of snapshot.agents) {
    const detail = await service.detail({ stream_id: snapshot.stream_id, revision: snapshot.revision, session_id: agent.identity.session_id, agent_id: agent.agent_id });
    assert.equal(detail.conversation.items[0].text, agent.identity.source_id);
  }
});

test('independent harness reads begin concurrently and unneeded sources are not called', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const calls = [];
  const collector = createCompositeAgentCollector(['Codex', 'Claude Code', 'DeepSeek Harness'].map(type => ({ sessionTypes: [type],
    collector: { collect: async rows => { calls.push(type); await gate; return resultFor(rows, type); } },
  })));
  const pending = collector.collect([session('c'), session('a', 'Claude Code')]);
  assert.deepEqual(calls, ['Codex', 'Claude Code']);
  release(); assert.equal((await pending).agents.length, 2);
});

test('one failed source retains only its last good scope without blocking other harness updates', async () => {
  let failing = false, label = 'first';
  const rows = [session('codex'), session('claude', 'Claude Code')];
  const collector = createCompositeAgentCollector([
    { sessionTypes: ['Codex'], collector: { collect: async rows => { const result = resultFor(rows, 'codex'); result.agents[0].name = label; return result; } } },
    { sessionTypes: ['Claude Code'], collector: { collect: async rows => { if (failing) throw new Error('unreadable'); return resultFor(rows, 'claude'); } } },
  ]);
  const before = await collector.collect(rows);
  before.agents.find(a => a.identity.source_id === 'claude').name = 'consumer mutation';
  failing = true; label = 'updated';
  const after = await collector.collect(rows);
  assert.equal(after.agents.find(a => a.identity.source_id === 'codex').name, 'updated');
  const stale = after.agents.find(a => a.identity.source_id === 'claude');
  assert.equal(stale.name, 'claude'); assert.equal(stale.status, 'unknown'); assert.equal(stale.updated_at, 1000);
  assert.equal(after.coverage.claude, 'partial');
  assert.equal(after.details.get(stale.agent_id).conversation.items[0].text, 'claude');
  failing = false;
  assert.equal((await collector.collect(rows)).agents.find(a => a.identity.source_id === 'claude').status, 'working');
});

test('fresh failures are unknown rather than an observed empty roster', async () => {
  const collector = createCompositeAgentCollector([{ sessionTypes: ['Claude Code'], collector: { collect: async () => { throw new Error('unavailable'); } } }]);
  const result = await collector.collect([session('a', 'Claude Code'), session('b', 'Codex')]);
  assert.deepEqual(result.coverage, { a: 'unknown', b: 'unsupported' });
  assert.deepEqual(result.agents, []);
});

test('malformed or foreign-scope observations do not contaminate other harnesses', async () => {
  const rows = [session('codex'), session('claude', 'Claude Code')];
  const collector = createCompositeAgentCollector([
    { sessionTypes: ['Codex'], collector: { collect: async rows => resultFor(rows, 'codex') } },
    { sessionTypes: ['Claude Code'], collector: { collect: async () => resultFor([rows[0]], 'claude') } },
  ]);
  const result = await collector.collect(rows);
  assert.equal(result.agents.length, 1); assert.equal(result.agents[0].identity.source_id, 'codex');
  assert.equal(result.coverage.claude, 'unknown'); assert.equal(result.details.size, 1);
});

test('removed or reassigned sessions cannot resurrect cached agents after a source failure', async () => {
  let failing = false;
  const collector = createCompositeAgentCollector([{ sessionTypes: ['Codex'], collector: { collect: async rows => {
    if (failing) throw new Error('unavailable'); return resultFor(rows);
  } } }]);
  await collector.collect([session('a'), session('b')]);
  failing = true;
  assert.equal((await collector.collect([session('a')])).agents.length, 1);
  const restored = await collector.collect([session('a'), session('b')]);
  assert.equal(restored.agents.length, 1); assert.equal(restored.coverage.b, 'unknown');
  assert.equal((await collector.collect([session('a', 'Codex', { project_path: '/different' })])).agents.length, 0);
  assert.equal((await collector.collect([session('a')])).agents.length, 0);
  failing = false; await collector.collect([session('a')]);
  await collector.collect([]); failing = true;
  assert.equal((await collector.collect([session('a')])).agents.length, 0);
});

test('returned detail mutations cannot change source caches and unrelated detail keys are excluded', async () => {
  let failing = false;
  const collector = createCompositeAgentCollector([{ sessionTypes: ['Codex'], collector: { collect: async rows => {
    if (failing) throw new Error('unavailable');
    const result = resultFor(rows); result.details.set('foreign', result.details.values().next().value); return result;
  } } }]);
  const first = await collector.collect([session('a')]);
  assert.equal(first.details.has('foreign'), false);
  first.details.values().next().value.conversation.items[0].text = 'mutation'; failing = true;
  assert.equal((await collector.collect([session('a')])).details.values().next().value.conversation.items[0].text, 'test');
});

test('duplicate or empty harness routes fail before any collector runs', () => {
  const collector = { collect: async () => { throw new Error('not called'); } };
  assert.throws(() => createCompositeAgentCollector([{ sessionTypes: ['Codex'], collector }, { sessionTypes: ['codex'], collector }]), /Ambiguous/);
  assert.throws(() => createCompositeAgentCollector([{ sessionTypes: [' '], collector }]), /Ambiguous/);
});
