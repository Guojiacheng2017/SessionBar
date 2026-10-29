import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, utimes, unlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createCodexAgentCollector } from '../dist/agents/codexAgents.js';
import { CodexStreamRecorder } from '../dist/agents/codexStream.js';
import { captureCodexHook } from '../dist/agents/codexHooks.js';
import { AgentService } from '../dist/agents/agentService.js';
import { assertSnapshot, agentId, SCHEMA } from '../dist/shared/agentContract.js';

const ROOT = '11111111-1111-4111-8111-111111111111';
const CHILD = '22222222-2222-4222-8222-222222222222';
const NESTED = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4444-8444-444444444444';
const NOW = Date.UTC(2026, 9, 26, 12);
const session = (id = ROOT, extra = {}) => ({
  session_id: `codex-${id}-hook1234__atlas`, session_type: 'Codex', source: 'hook',
  session_name: 'Design', status: 'working', task_name: 'Build', timestamp: NOW,
  project: 'atlas', project_path: '/synthetic/atlas', ...extra,
});
const meta = (id = CHILD, parent = ROOT, extra = {}) => ({
  timestamp: new Date(NOW).toISOString(), ordinal: 0, type: 'session_meta', payload: {
    id, originator: 'codex', cwd: '/synthetic/atlas', thread_source: 'subagent', model_provider: 'openai',
    source: { subagent: { thread_spawn: { parent_thread_id: parent, depth: 1, agent_path: '/root/reviewer', agent_nickname: 'Reviewer', agent_role: null } } },
    ...extra,
  },
});
const row = (ordinal, type, payload) => ({ ordinal, type, timestamp: new Date(NOW + ordinal).toISOString(), payload });
const message = (ordinal, role, text, extra = {}) => row(ordinal, 'response_item', {
  type: 'message', role, id: `message-${ordinal}`, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }], ...extra,
});
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'codex-agent-fixture-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function log(root, name, records, mtime = NOW, suffix = '\n') {
  const file = join(root, name);
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, records.map(item => JSON.stringify(item)).join('\n') + suffix);
  await utimes(file, new Date(mtime), new Date(mtime));
  return file;
}
const collector = (root, extra = {}) => createCodexAgentCollector({ root, sourceId: 'test-local-codex', ...extra });
const childOf = (result, id = CHILD) => result.agents.find(a => a.identity.native_agent_id === id);

test('normal sessions join automatic hook targets to exact native completion IDs and resume only active work on first Flow read',async t=>{
 const root=await fixture(t),hooks=join(root,'hooks'),turn=OTHER,cwd='/synthetic/atlas';
 const head=meta(ROOT,undefined,{thread_source:'cli',source:'cli'}),native=join(root,'root.jsonl');
 const started=row(1,'event_msg',{type:'task_started',turn_id:turn});
 const spawn=row(2,'event_msg',{type:'item_completed',thread_id:ROOT,started_at_ms:NOW+2,completed_at_ms:NOW+2,item:{id:'spawn',type:'CollabAgentToolCall',tool:'spawn_agent',sender_thread_id:ROOT,receiver_thread_ids:[CHILD],status:'completed'}});
 const wrapper=row(3,'response_item',{type:'function_call',name:'wait_agent',call_id:'native-wait',arguments:'{}'});
 await log(root,'root.jsonl',[head,started,spawn,wrapper]);await log(root,'child.jsonl',[meta(),row(3,'event_msg',{type:'task_started',turn_id:NESTED})]);
 assert.equal(captureCodexHook({root:hooks,sessionsRoot:root,raw:{session_id:ROOT,turn_id:turn,cwd,transcript_path:native,hook_event_name:'PreToolUse',tool_name:'multi_agent_v1wait_agent',tool_use_id:'native-wait',tool_input:{targets:[CHILD]}},now:NOW+4}),true);
 let now=NOW+100;const read=collector(root,{hookRoot:hooks});const service=new AgentService({getSessions:()=>[session()],collector:read,now:()=>now,refreshMs:0});
 const active=await service.execution(session().session_id);assert.equal(active.spans.filter(s=>s.kind==='agent'&&s.state==='open').length,1);const waiting=active.spans.find(s=>s.label==='Native wait');assert.ok(waiting);assert.equal(waiting.wait_for_agent_ids.length,1);assert.equal(waiting.state,'open');
 const complete=row(110,'event_msg',{type:'item_completed',thread_id:ROOT,started_at_ms:NOW+5,completed_at_ms:NOW+110,item:{id:'native-wait',type:'CollabAgentToolCall',tool:'wait',sender_thread_id:ROOT,receiver_thread_ids:[CHILD],agents_states:{[CHILD]:{completed:'PRIVATE'}},status:'completed'}});
 await log(root,'root.jsonl',[head,started,spawn,wrapper,complete,row(111,'response_item',{type:'function_call_output',call_id:'native-wait',output:'Result returned'})],NOW+111);now=NOW+120;const done=await service.execution(session().session_id);const waits=done.spans.filter(s=>s.label==='Native wait');assert.equal(waits.length,1);assert.equal(waits[0].state,'completed');assert.equal(waits[0].started_at,NOW+4);assert.equal(waits[0].ended_at,NOW+110);assert.equal(waits[0].wait_for_agent_ids.length,1);assert.equal(waits[0].wait_result_agent_ids.length,1);
 const cold=new AgentService({getSessions:()=>[session()],collector:collector(root,{hookRoot:hooks}),now:()=>now,refreshMs:0});assert.equal((await cold.execution(session().session_id)).spans.length,0,'completed history remains outside the initial live state');
});

test('primary-only Codex runs expose native execution metadata without requiring a child agent', async t => {
  const root = await fixture(t);
  await log(root, 'primary.jsonl', [meta(ROOT, undefined, { thread_source: 'cli', source: 'cli' }),
    row(1, 'response_item', { type: 'function_call', name: 'exec_command', call_id: 'probe-call', arguments: 'PRIVATE' }),
    row(2, 'response_item', { type: 'function_call_output', call_id: 'probe-call', output: 'PRIVATE' })]);
  const result = await collector(root).collect([session()], NOW);
  const primary = result.agents.find(a => a.role === 'primary');
  assert.ok(primary);
  const events = result.details.get(primary.agent_id).execution.events;
  assert.deepEqual(events.map(e => [e.kind, e.call_id]), [['call.start', 'probe-call'], ['call.end', 'probe-call']]);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE/);
});

test('native agent activities establish validated child lanes before worker logs and survive a retained-window boundary', async t => {
  const root = await fixture(t);
  const activity = (ordinal, kind, id) => row(ordinal, 'event_msg', { type: 'item_completed', thread_id: ROOT,
    started_at_ms: NOW + ordinal, completed_at_ms: NOW + ordinal,
    item: { type: 'SubAgentActivity', id, kind, agent_thread_id: CHILD, agent_path: '/root/native_worker' } });
  const head = meta(ROOT, undefined, { thread_source: 'cli', source: 'cli' });
  const read = collector(root, { maxBytes: 1024 });
  await log(root, 'root.jsonl', [head, activity(1, 'started', 'native-spawn')]);
  const before = await read.collect([session()], NOW + 5);
  const worker = childOf(before);
  assert.ok(worker, 'the native child ID is available before its transcript');
  assert.equal(worker.parent_agent_id, childOf(before, ROOT).agent_id);
  assert.equal(worker.status, 'working');
  assert.equal(before.details.get(worker.agent_id).conversation.availability, 'unknown');
  const start = before.details.get(childOf(before, ROOT).agent_id).execution.events.find(e => e.kind === 'agent.start');
  assert.equal(start.target_agent_id, worker.agent_id);
  const padding = row(2, 'response_item', { type: 'reasoning', text: 'PRIVATE'.repeat(2000) });
  await log(root, 'root.jsonl', [head, activity(1, 'started', 'native-spawn'), padding, activity(3, 'completed', 'native-complete')], NOW + 10);
  const after = await read.collect([session()], NOW + 15);
  const events = after.details.get(childOf(after, ROOT).agent_id).execution.events;
  assert.equal(events.find(e => e.kind === 'agent.end').call_id, 'native-spawn');
  assert.equal(childOf(after).status, 'idle');
  assert.equal(childOf(after).lifecycle, 'active', 'task completion does not terminate a reusable Codex agent');
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE/);
  await log(root, 'child.jsonl', [meta(), row(1, 'event_msg', { type: 'task_complete' })], NOW + 20);
  const discovered = await read.collect([session()], NOW + 25);
  assert.equal(childOf(discovered).agent_id, worker.agent_id);
});

test('native activity cannot adopt another session worker or export a foreign completed command', async t => {
  const root = await fixture(t);
  await log(root, 'root.jsonl', [meta(ROOT, undefined, { thread_source: 'cli', source: 'cli' }),
    row(1, 'event_msg', { type: 'item_completed', thread_id: ROOT, started_at_ms: NOW + 1, completed_at_ms: NOW + 1,
      item: { type: 'SubAgentActivity', id: 'spoof', kind: 'started', agent_thread_id: CHILD, agent_path: '/root/spoof' } }),
    row(2, 'event_msg', { type: 'item_completed', thread_id: OTHER, started_at_ms: NOW + 1, completed_at_ms: NOW + 2,
      item: { type: 'CommandExecution', id: 'foreign', status: 'completed', exit_code: 0 } })]);
  await log(root, 'other-worker.jsonl', [meta(CHILD, OTHER)]);
  const result = await collector(root).collect([session()], NOW + 5);
  assert.equal(childOf(result), undefined);
  const events = result.details.get(childOf(result, ROOT).agent_id).execution.events;
  assert.equal(events.some(e => e.target_agent_id || e.kind.startsWith('run.')), false);
});

test('native wait UUIDs canonicalize only to workers owned by the same Codex session', async t => {
  const root = await fixture(t);
  const item = (ordinal, tool, targets) => row(ordinal, 'event_msg', { type: 'item_completed', thread_id: ROOT, started_at_ms: NOW + ordinal,
    completed_at_ms: NOW + ordinal, item: { type: 'CollabAgentToolCall', id: tool, tool, status: 'completed', sender_thread_id: ROOT,
      receiver_thread_ids: targets, agents_states: {} } });
  await log(root, 'root.jsonl', [meta(ROOT, undefined, { thread_source: 'cli', source: 'cli' }), item(1, 'spawn_agent', [CHILD]), item(2, 'wait', [CHILD, OTHER])]);
  await log(root, 'foreign.jsonl', [meta(OTHER, NESTED)]);
  const result = await collector(root).collect([session()], NOW + 10);
  const wait = result.details.get(childOf(result, ROOT).agent_id).execution.events.find(e => e.wait_result_agent_ids);
  assert.deepEqual(result.details.get(childOf(result, ROOT).agent_id).execution.events.find(e=>e.wait_result_agent_ids).wait_result_agent_ids, [childOf(result).agent_id]);
  assert.equal(wait.wait_for_agent_ids, undefined);
  assert.equal(wait.unresolved_wait_targets, 1);
  assert.equal(childOf(result, OTHER), undefined);
});

test('native Plan-mode text is acknowledged without exporting its body or inventing execution phases', async t => {
  const root = await fixture(t);
  await log(root, 'root.jsonl', [meta(ROOT, undefined, { thread_source: 'cli', source: 'cli' }),
    row(1, 'event_msg', { type: 'item_completed', thread_id: ROOT, started_at_ms: NOW, completed_at_ms: NOW + 1,
      item: { type: 'Plan', id: 'native-proposed-plan', text: 'PRIVATE PROPOSED PLAN' } })]);
  const result = await collector(root).collect([session()], NOW + 5);
  const detail = result.details.get(childOf(result, ROOT).agent_id);
  assert.equal(detail.workflow.items.find(item => item.stage === 'plan.proposed').label, 'Native proposed plan');
  assert.match(detail.execution.notes.join(' '), /proposed plan text/i);
  assert.equal(detail.execution.events.some(e => e.kind === 'plan' || e.kind === 'phase'), false);
  assert.doesNotMatch(JSON.stringify(detail), /PRIVATE/);
});

test('a validated native stream overrides returned-only disk waits without replacing requested targets', async t => {
  const root=await fixture(t),streamRoot=join(root,'streams');
  await log(root,'root.jsonl',[meta(ROOT,undefined,{thread_source:'cli',source:'cli'}),row(1,'event_msg',{type:'item_completed',thread_id:ROOT,started_at_ms:NOW+1,completed_at_ms:NOW+2,
    item:{type:'CollabAgentToolCall',id:'disk-wait',tool:'wait',status:'completed',sender_thread_id:ROOT,receiver_thread_ids:[CHILD],agents_states:{}}})]);
  await log(root,'child.jsonl',[meta()]);await log(root,'nested.jsonl',[meta(NESTED,ROOT)]);
  const writer=new CodexStreamRecorder({root:streamRoot,cwd:'/synthetic/atlas'});
  writer.write({type:'thread.started',thread_id:ROOT},NOW);
  const frame=(phase,targets)=>({type:`item.${phase}`,item:{id:'wait-one',type:'collab_tool_call',tool:'wait',status:phase==='started'?'in_progress':'completed',sender_thread_id:ROOT,receiver_thread_ids:targets}});
  writer.write(frame('started',[CHILD,NESTED]),NOW+1);writer.write(frame('completed',[CHILD]),NOW+2);writer.close();
  const result=await collector(root,{streamRoot}).collect([session()],NOW+10);
  const waits=result.details.get(childOf(result,ROOT).agent_id).execution.events.filter(e=>e.label==='Native wait');
  assert.equal(waits.length,2);assert.ok(waits[0].cursor_scope);assert.notEqual(waits[0].call_id,'disk-wait');
  assert.deepEqual(waits[1].wait_for_agent_ids,[childOf(result).agent_id,childOf(result,NESTED).agent_id]);
  assert.deepEqual(waits[1].wait_result_agent_ids,[childOf(result).agent_id]);
});
function valid(result, sessions = [session()]) {
  assertSnapshot({ schema_version: SCHEMA, kind: 'snapshot', stream_id: 'test', revision: 0,
    projects: [], sessions: sessions.map(s => ({ session_id: s.session_id, project_id: null, name: s.session_name, agents_coverage: result.coverage[s.session_id] })), agents: result.agents });
}

test('discovers explicit nested workers under the canonical hook session without adding sessions', async t => {
  const root = await fixture(t);
  await log(root, 'child.jsonl', [meta(), row(1, 'event_msg', { type: 'task_started' }), message(2, 'user', 'Review this change')]);
  await log(root, 'nested.jsonl', [meta(NESTED, CHILD), message(1, 'assistant', 'Review complete', { phase: 'final_answer' }), row(2, 'event_msg', { type: 'task_complete' })]);
  const result = await collector(root).collect([session()], NOW);
  valid(result);
  assert.equal(result.agents.length, 3);
  assert.equal(childOf(result).parent_agent_id, childOf(result, ROOT).agent_id);
  assert.equal(childOf(result, NESTED).parent_agent_id, childOf(result).agent_id);
  assert.ok(result.agents.every(a => a.identity.session_id === session().session_id));
  assert.equal(childOf(result).name, 'Reviewer');
  assert.equal(childOf(result).status, 'working');
  assert.equal(childOf(result, NESTED).lifecycle, 'active', 'turn completion is not agent completion');
  assert.equal(childOf(result, NESTED).status, 'idle');
  assert.equal(result.coverage[session().session_id], 'partial', 'bounded filesystem reads cannot prove exhaustive coverage');
});

test('native avatars resolve by child UUID independently of labels and canonical session IDs', async t => {
  const root = await fixture(t);
  await log(root, 'child.jsonl', [meta()]);
  await log(root, 'nested.jsonl', [meta(NESTED, CHILD)]);
  const observed = [];
  const avatarSource = { forAgent: async id => { observed.push(id); return { kind: 'asset', asset_id: `native-${id}` }; } };
  const read = collector(root, { avatarSource });
  const initial = await read.collect([session()], NOW);
  valid(initial);
  assert.deepEqual(observed.sort(), [CHILD, NESTED].sort());
  assert.equal(childOf(initial, ROOT).avatar, null);
  assert.deepEqual(childOf(initial).avatar, { kind: 'asset', asset_id: `native-${CHILD}` });
  const renamed = await read.collect([session(ROOT, { session_id: 'renamed-' + ROOT, session_name: 'New title' })], NOW);
  assert.deepEqual(childOf(renamed).avatar, childOf(initial).avatar);
  assert.notEqual(childOf(renamed).agent_id, childOf(initial).agent_id);
});

test('missing or failing native artwork does not remove agents or visible detail', async t => {
  const root = await fixture(t);
  await log(root, 'child.jsonl', [meta(), message(1, 'assistant', 'Visible answer')]);
  for (const forAgent of [async () => null, async () => { throw new Error('native resources unavailable'); }]) {
    const result = await collector(root, { avatarSource: { forAgent } }).collect([session()], NOW);
    valid(result);
    assert.equal(childOf(result).avatar, null);
    assert.equal(result.details.get(childOf(result).agent_id).conversation.items[0].text, 'Visible answer');
  }
});

test('only exports visible messages and omits inherited history, internal reasoning, tool arguments and output', async t => {
  const root = await fixture(t);
  await log(root, 'child.jsonl', [
    meta(CHILD, ROOT, { forked_from_id: ROOT, subagent_history_start_ordinal: 5 }),
    message(1, 'user', 'PRIVATE PARENT MESSAGE'),
    message(2, 'assistant', 'PRIVATE PARENT ANSWER'),
    row(3, 'response_item', { type: 'reasoning', text: 'PRIVATE REASONING' }),
    message(5, 'developer', 'PRIVATE DEVELOPER'),
    message(6, 'system', 'PRIVATE SYSTEM'),
    message(7, 'assistant', 'PRIVATE ANALYSIS', { channel: 'analysis' }),
    message(8, 'assistant', 'PRIVATE PHASE', { phase: 'analysis' }),
    message(9, 'user', 'Visible task'),
    row(10, 'response_item', { type: 'function_call', name: 'exec_command', call_id: 'call-1', arguments: 'PRIVATE ARGS' }),
    row(11, 'response_item', { type: 'function_call_output', call_id: 'call-1', output: 'PRIVATE OUTPUT' }),
    message(12, 'assistant', 'Visible commentary', { phase: 'commentary' }),
    message(13, 'assistant', 'Visible final', { phase: 'final_answer' }),
  ]);
  const result = await collector(root).collect([session()], NOW);
  const detail = result.details.get(childOf(result).agent_id);
  assert.deepEqual(detail.conversation.items.map(m => m.text), ['Visible task', 'Visible commentary', 'Visible final']);
  assert.deepEqual(detail.workflow.items.map(e => e.stage), ['tool.start', 'tool.complete']);
  assert.deepEqual(detail.workflow.items.map(e => e.label), ['exec_command', 'exec_command']);
  assert.doesNotMatch(JSON.stringify(detail), /PRIVATE/);
  assert.deepEqual(detail.workflow_graph, { availability: 'unsupported', graph: null });
});

test('hides inherited history when a fork lacks a usable history boundary', async t => {
  const root = await fixture(t);
  await log(root, 'child.jsonl', [meta(CHILD, ROOT, { forked_from_id: ROOT }), message(1, 'user', 'Parent context')]);
  const result = await collector(root).collect([session()], NOW);
  assert.equal(result.details.get(childOf(result).agent_id).conversation.availability, 'unknown');
  assert.deepEqual(result.details.get(childOf(result).agent_id).conversation.items, []);
});

test('does not guess history position when boundary exists but records lack ordinals', async t => {
  const root = await fixture(t);
  const inherited = message(1, 'user', 'Unattributable context'); delete inherited.ordinal;
  await log(root, 'child.jsonl', [meta(CHILD, ROOT, { subagent_history_start_ordinal: 10 }), inherited]);
  const result = await collector(root).collect([session()], NOW);
  assert.equal(result.details.get(childOf(result).agent_id).conversation.availability, 'unknown');
});

test('canonical response messages do not duplicate event messages and repeated canonical text remains distinct', async t => {
  const root = await fixture(t);
  await log(root, 'child.jsonl', [meta(),
    row(1, 'event_msg', { type: 'user_message', message: 'Hello' }), message(2, 'user', 'Hello'),
    row(3, 'event_msg', { type: 'agent_message', message: 'Done' }), message(4, 'assistant', 'Done'), message(5, 'assistant', 'Done'),
  ]);
  const result = await collector(root).collect([session()], NOW);
  assert.deepEqual(result.details.get(childOf(result).agent_id).conversation.items.map(m => m.text), ['Hello', 'Done', 'Done']);
});

test('mixed streams retain new event-only tail messages and repeated text at later times', async t => {
  const root = await fixture(t);
  const later = row(5, 'event_msg', { type: 'agent_message', message: 'Done' });
  later.timestamp = new Date(NOW + 60_000).toISOString();
  await log(root, 'child.jsonl', [meta(), message(1, 'assistant', 'Done'),
    row(2, 'event_msg', { type: 'agent_message', message: 'Done' }),
    row(3, 'event_msg', { type: 'task_started' }),
    row(4, 'event_msg', { type: 'agent_message', message: 'New event-only answer' }), later,
  ]);
  const result = await collector(root).collect([session()], NOW);
  assert.deepEqual(result.details.get(childOf(result).agent_id).conversation.items.map(m => m.text), ['Done', 'New event-only answer', 'Done']);
});

test('event-only older logs remain readable and timestamps do not determine sequence', async t => {
  const root = await fixture(t);
  const first = row(1, 'event_msg', { type: 'user_message', message: 'First' }); delete first.ordinal;
  const second = row(2, 'event_msg', { type: 'agent_message', message: 'Second' }); delete second.ordinal; second.timestamp = 'invalid';
  await log(root, 'child.jsonl', [meta(), first, second]);
  const result = await collector(root).collect([session()], NOW);
  const items = result.details.get(childOf(result).agent_id).conversation.items;
  assert.deepEqual(items.map(m => m.text), ['First', 'Second']);
  assert.ok(items[1].sequence > items[0].sequence);
  assert.equal(items[1].occurred_at, null);
});

test('mixed ordinal and older records preserve file ordering in one sequence space', async t => {
  const root = await fixture(t);
  const first = message(1, 'user', 'First old format'); delete first.ordinal;
  await log(root, 'child.jsonl', [meta(), first, message(2, 'assistant', 'Second with ordinal'), message(3, 'user', 'Third with ordinal')]);
  const result = await collector(root).collect([session()], NOW);
  const items = result.details.get(childOf(result).agent_id).conversation.items;
  assert.deepEqual(items.map(m => m.text), ['First old format', 'Second with ordinal', 'Third with ordinal']);
  assert.ok(items.every((item, index) => !index || item.sequence > items[index - 1].sequence));
});

test('inter-agent task messages are visible as incoming messages', async t => {
  const root = await fixture(t);
  await log(root, 'child.jsonl', [meta(), row(1, 'response_item', { type: 'agent_message', id: 'task-1', author: '/root', recipient: '/root/reviewer', content: [{ type: 'input_text', text: 'Review synthetic references' }] })]);
  const result = await collector(root).collect([session()], NOW);
  assert.deepEqual(result.details.get(childOf(result).agent_id).conversation.items.map(m => [m.role, m.text]), [['user', 'Review synthetic references']]);
});

test('outgoing agent messages retain assistant role and unrelated recipients are omitted', async t => {
  const root = await fixture(t);
  const routed = (ordinal, author, recipient, text) => row(ordinal, 'response_item', { type: 'agent_message', id: `routed-${ordinal}`, author, recipient, content: [{ type: 'input_text', text }] });
  await log(root, 'child.jsonl', [meta(),
    routed(1, '/root/reviewer', '/root', 'My answer'),
    routed(2, '/root', '/root/other', 'Someone else task'),
    routed(3, '/root', '/root/reviewer', 'My task'),
  ]);
  const result = await collector(root).collect([session()], NOW);
  assert.deepEqual(result.details.get(childOf(result).agent_id).conversation.items.map(m => [m.role, m.text]), [['assistant', 'My answer'], ['user', 'My task']]);
});

test('excludes internal guardian, unparented workers, and unresolved ancestry', async t => {
  const root = await fixture(t);
  await log(root, 'guardian.jsonl', [meta(CHILD, ROOT, { source: { subagent: { other: 'guardian' } } })]);
  await log(root, 'orphan.jsonl', [meta(NESTED, OTHER)]);
  await log(root, 'unparented.jsonl', [meta(OTHER, 'not-a-uuid')]);
  const result = await collector(root).collect([session()], NOW);
  assert.deepEqual(result.agents, []);
  assert.equal(result.coverage[session().session_id], 'partial');
});

test('cycles and self-parent are not attached to any root session', async t => {
  const root = await fixture(t);
  await log(root, 'child.jsonl', [meta(CHILD, NESTED)]);
  await log(root, 'nested.jsonl', [meta(NESTED, CHILD)]);
  await log(root, 'self.jsonl', [meta(OTHER, OTHER)]);
  const result = await collector(root).collect([session()], NOW);
  assert.deepEqual(result.agents, []);
});

test('remote sessions and other providers are not matched to local Codex UUIDs', async t => {
  const root = await fixture(t);
  await log(root, 'child.jsonl', [meta()]);
  for (const input of [session(ROOT, { origin: 'remote' }), session(ROOT, { session_type: 'Claude Code' })]) {
    const result = await collector(root).collect([input], NOW);
    assert.equal(result.coverage[input.session_id], 'unsupported');
    assert.deepEqual(result.agents, []);
  }
});

test('ambiguous canonical aliases are not arbitrarily selected, including three aliases', async t => {
  const root = await fixture(t);
  await log(root, 'child.jsonl', [meta()]);
  const aliases = [1, 2, 3].map(n => session(ROOT, { session_id: `codex-${ROOT}-alias${n}__atlas` }));
  const result = await collector(root).collect(aliases, NOW);
  assert.deepEqual(result.agents, []);
  assert.ok(Object.values(result.coverage).every(value => value === 'unknown'));
});

test('missing root is unknown and scan limits never become confirmed zero', async t => {
  const root = await fixture(t);
  assert.equal((await collector(join(root, 'missing')).collect([session()], NOW)).coverage[session().session_id], 'unknown');
  await log(root, 'newer-internal.jsonl', [meta(OTHER, ROOT, { source: { subagent: { other: 'guardian' } } })], NOW + 1);
  await log(root, 'worker.jsonl', [meta()]);
  const result = await collector(root, { maxFiles: 1 }).collect([session()], NOW);
  assert.deepEqual(result.agents, []);
  assert.equal(result.coverage[session().session_id], 'partial');
});

test('retained terminal agent remains visible and a stale turn becomes unknown, not completed', async t => {
  const root = await fixture(t);
  await log(root, 'child.jsonl', [meta(), row(1, 'event_msg', { type: 'task_started' })], NOW - 200_000);
  await log(root, 'terminal.jsonl', [meta(NESTED, ROOT), row(1, 'event_msg', { type: 'agent_completed' })], NOW - 200_000);
  const result = await collector(root).collect([session()], NOW);
  valid(result);
  assert.equal(childOf(result).status, 'unknown');
  assert.equal(childOf(result).lifecycle, 'active');
  assert.equal(childOf(result, NESTED).lifecycle, 'completed');
  assert.equal(childOf(result, ROOT).status, 'working');
});

test('calendar layout is discovered, unchanged samples are stable, returned data does not alias cache', async t => {
  const root = await fixture(t);
  await log(root, '2026/10/26/child.jsonl', [meta(), message(1, 'user', 'Original')]);
  const c = collector(root);
  const first = await c.collect([session()], NOW);
  const second = await c.collect([session()], NOW + 1000);
  assert.deepEqual(first, second);
  first.details.get(childOf(first).agent_id).conversation.items[0].text = 'Consumer mutation';
  assert.equal((await c.collect([session()], NOW + 1000)).details.get(childOf(second).agent_id).conversation.items[0].text, 'Original');
});

test('cache refreshes on file growth and deleted files leave the current retained view', async t => {
  const root = await fixture(t);
  const file = await log(root, 'child.jsonl', [meta(), message(1, 'user', 'First')]);
  const c = collector(root);
  const first = await c.collect([session()], NOW);
  await log(root, 'child.jsonl', [meta(), message(1, 'user', 'First'), message(2, 'assistant', 'Second')], NOW + 1);
  const next = await c.collect([session()], NOW + 1);
  assert.equal(next.details.get(childOf(next).agent_id).conversation.items.length, 2);
  assert.equal(first.details.get(childOf(first).agent_id).conversation.items.length, 1);
  await unlink(file);
  assert.deepEqual((await c.collect([session()], NOW + 2)).agents, []);
});

test('temporary file read failures preserve last-good agents with unknown status', async t => {
  const root = await fixture(t);
  const file = await log(root, 'child.jsonl', [meta(), row(1, 'event_msg', { type: 'task_started' }), message(2, 'user', 'Retained task')]);
  const c = collector(root);
  const first = await c.collect([session()], NOW);
  await chmod(file, 0);
  try {
    const retained = await c.collect([session()], NOW + 1);
    assert.equal(childOf(retained).agent_id, childOf(first).agent_id);
    assert.equal(childOf(retained).status, 'unknown');
    assert.equal(retained.coverage[session().session_id], 'partial');
    assert.deepEqual(retained.details.get(childOf(retained).agent_id), first.details.get(childOf(first).agent_id));
  } finally { await chmod(file, 0o600); }
  assert.equal(childOf(await c.collect([session()], NOW + 2)).status, 'working');
});

test('temporary directory read failures retain known agents until an explicit deletion is observed', async t => {
  const root = await fixture(t);
  await log(root, 'child.jsonl', [meta(), row(1, 'event_msg', { type: 'task_started' })]);
  const c = collector(root);
  await c.collect([session()], NOW);
  await chmod(root, 0);
  try {
    const retained = await c.collect([session()], NOW + 1);
    assert.equal(childOf(retained).status, 'unknown');
    assert.equal(retained.coverage[session().session_id], 'partial');
  } finally { await chmod(root, 0o700); }
  await unlink(join(root, 'child.jsonl'));
  assert.deepEqual((await c.collect([session()], NOW + 2)).agents, []);
});

test('incomplete replacement metadata does not erase a last-good roster', async t => {
  const root = await fixture(t);
  const file = await log(root, 'child.jsonl', [meta(), message(1, 'user', 'Retained')]);
  const c = collector(root);
  await c.collect([session()], NOW);
  await writeFile(file, '{"type":"session_meta"');
  await utimes(file, new Date(NOW + 1), new Date(NOW + 1));
  const retained = await c.collect([session()], NOW + 1);
  assert.equal(childOf(retained).status, 'unknown');
  assert.equal(retained.details.get(childOf(retained).agent_id).conversation.items[0].text, 'Retained');
});

test('tail retention and item limits report truncation and preserve stable message identities', async t => {
  const root = await fixture(t);
  await log(root, 'child.jsonl', [meta(), ...Array.from({ length: 520 }, (_, i) => message(i + 1, 'user', `Message ${i + 1}`))]);
  const c = collector(root, { maxBytes: 2 * 1024 * 1024 });
  const full = await c.collect([session()], NOW);
  const page = full.details.get(childOf(full).agent_id).conversation;
  assert.equal(page.items.length, 500);
  assert.equal(page.truncated_before, true);
  assert.equal(page.items[0].message_id, 'message-21');
  const tail = await collector(root, { maxBytes: 4096 }).collect([session()], NOW);
  const retained = tail.details.get(childOf(tail).agent_id).conversation;
  assert.equal(retained.truncated_before, true);
  assert.equal(retained.items.at(-1).message_id, page.items.at(-1).message_id);
  assert.equal(retained.items.at(-1).sequence, page.items.at(-1).sequence);
});

test('oversized text is marked truncated and malformed/incomplete lines are ignored', async t => {
  const root = await fixture(t);
  const file = await log(root, 'child.jsonl', [meta(), message(1, 'assistant', 'x'.repeat(17000))]);
  await writeFile(file, '\n{broken}\n{"type":"response_item"', { flag: 'a' });
  await utimes(file, new Date(NOW), new Date(NOW));
  const result = await collector(root).collect([session()], NOW);
  const items = result.details.get(childOf(result).agent_id).conversation.items;
  assert.equal(items.length, 1);
  assert.equal(items[0].text.length, 16000);
  assert.equal(items[0].content_state, 'truncated');
});

test('namespace changes isolate otherwise identical native agents', async t => {
  const root = await fixture(t);
  await log(root, 'child.jsonl', [meta()]);
  const a = await collector(root).collect([session()], NOW);
  const b = await collector(root, { sourceId: 'another-host-codex' }).collect([session()], NOW);
  assert.notEqual(childOf(a).agent_id, childOf(b).agent_id);
  assert.equal(childOf(a).agent_id, agentId(childOf(a).identity));
});
