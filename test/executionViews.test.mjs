import assert from 'node:assert/strict';
import test from 'node:test';
import { executionTraceMarkup } from '../dist/web/executionViews.js';
import { ExecutionClient } from '../dist/web/executionClient.js';
const view = (extra = {}) => ({ schema_version: 'sessionbar.execution.v1', kind: 'execution', stream_id: 'epoch', revision: 1, session_id: 'session', observed_since: 1000, observed_at: 6000, availability: 'available', lanes: [{ agent_id: 'main', label: 'Main', status: 'working' }], phases: [], spans: [], max_concurrent_calls: 0, max_parallel_execution: null, notes: [], ...extra });
const reply = value => new Response(JSON.stringify(value));
const phase = (id, extra = {}) => ({ phase_id: id, agent_id: 'main', label: id, state: 'pending', declared_at: 1100, started_at: null, ended_at: null, depends_on: [], ...extra });

test('Gantt and the reported task DAG precede the collapsed tool use list', () => {
  const markup = executionTraceMarkup(view({
    phases: [phase('Prepare', { state: 'completed', started_at: 1200, ended_at: 2500 }), phase('Verify', { depends_on: ['Prepare'] })],
    spans: [{ span_id: 'a', agent_id: 'main', kind: 'call', label: 'Bash', started_at: 2000, ended_at: 4000, state: 'completed' }],
  }));
  assert.ok(markup.indexOf('Gantt') < markup.indexOf('Task DAG'));
  assert.ok(markup.indexOf('Task DAG') < markup.indexOf('Tool use list'));
  assert.match(markup, /data-phase-interval="Prepare"/);
  assert.match(markup, /data-flow-node="Prepare"/);
  assert.match(markup, /data-flow-node="Verify"/);
  assert.equal((markup.match(/data-flow-edge=/g) || []).length, 1);
  assert.doesNotMatch(markup, /data-phase-interval="Verify"/);
  assert.match(markup, /<details class="execution-interval-details"><summary>Tool use list/);
  assert.doesNotMatch(markup, /<details[^>]+\bopen\b|execution-phases/);
});

test('phase order and missing predecessors never manufacture DAG connections', () => {
  const markup = executionTraceMarkup(view({ phases: [phase('First'), phase('Second', { depends_on: ['missing'] })] }));
  assert.equal((markup.match(/data-flow-node=/g) || []).length, 2);
  assert.doesNotMatch(markup, /data-flow-edge=/);
  assert.match(markup, /unreported nodes/);
});

test('an explicit workflow graph stays primary when native execution is unavailable', () => {
  const graph = { kind: 'workflow', nodes: [{ id: 'reported', label: 'Reported task', subtitle: 'Reported step', status: 'pending' }], edges: [], notes: [] };
  const markup = executionTraceMarkup(view({ availability: 'unsupported' }), null, graph);
  assert.match(markup, /data-flow-node="reported"/);
  assert.match(markup, /not yet connected/);
  assert.doesNotMatch(markup, /<details[^>]*execution-topology/);
});

test('native agent overlap stays separate from command execution timing', () => {
  const markup = executionTraceMarkup(view({ max_parallel_agents: 2, spans: [{ span_id: 'agent-one', agent_id: 'main', kind: 'agent', label: 'probe-left', started_at: 2000, ended_at: null, state: 'open' }] }));
  assert.match(markup, /2<\/b> peak concurrent agents/);
  assert.match(markup, /Agent lifecycle/);
  assert.match(markup, /data-span-kind="agent"/);
  assert.match(markup, /Tool execution timing is not yet available/);
  assert.match(markup, /model and tool time/);
});

test('live trace distinguishes call intervals from verified execution and renders declared phase state', () => {
  const markup = executionTraceMarkup(view({ phases: [{ phase_id: 'p', agent_id: 'main', label: 'Prepare <probe>', state: 'in_progress', declared_at: 1100, started_at: 1200, ended_at: null, depends_on: [] }], spans: [{ span_id: 'a', agent_id: 'main', kind: 'call', label: 'Bash', started_at: 2000, ended_at: 4000, state: 'completed' }], max_concurrent_calls: 1 }));
  assert.match(markup, /Prepare &lt;probe&gt;/);
  assert.match(markup, /in_progress/);
  assert.match(markup, /dispatch.*result/i);
  assert.match(markup, /execution timing.*not.*available/i);
  assert.doesNotMatch(markup, /1 parallel executions/);
  assert.match(markup, /data-execution-span/);
});

test('a completed event without a start remains an untimed boundary, not a zero-origin duration', () => {
  const markup = executionTraceMarkup(view({ spans: [{ span_id: 'a', agent_id: 'main', kind: 'call', label: '<script>bad()</script>', started_at: null, ended_at: 4000, state: 'completed' }] }));
  assert.match(markup, /Start not observed/);
  assert.match(markup, /&lt;script&gt;/);
  assert.doesNotMatch(markup, /<script>|data-execution-span/);
});

test('fresh observation explains that previous log history is not replayed', () => {
  assert.match(executionTraceMarkup(view()), /history.*not replayed/i);
  assert.match(executionTraceMarkup(view()), /No new execution events/i);
});

test('observed Codex agent tasks do not fabricate a native plan or dependency DAG', () => {
  const markup = executionTraceMarkup(view({ max_parallel_agents: 2, spans: [
    { span_id: 'native-agent', agent_id: 'main', kind: 'agent', label: 'branch_a', started_at: 1100, ended_at: 1800, state: 'completed' },
  ] }));
  assert.match(markup, /No native phases reported/);
  assert.match(markup, /No native task dependencies reported/);
  assert.match(markup, /agent activity.*Gantt/i);
  assert.doesNotMatch(markup, /data-flow-edge=|data-flow-node=|0\/0/);
});

test('native command rows precede wrapper turns and call rows in a constrained Gantt', () => {
  const span = kind => ({ span_id: kind, agent_id: 'main', kind, label: kind, started_at: 1100, ended_at: 1800, state: 'completed' });
  const markup = executionTraceMarkup(view({ spans: ['turn', 'call', 'run'].map(span) }));
  assert.ok(markup.indexOf('data-span-kind="run"') < markup.indexOf('data-span-kind="turn"'));
  assert.ok(markup.indexOf('data-span-kind="run"') < markup.indexOf('data-span-kind="call"'));
});

test('a native wait DAG displays only explicit target references and preserves ordinary phases', () => {
  const markup = executionTraceMarkup(view({
    lanes: [{ agent_id: 'main', label: 'Coordinator', status: 'working' }, { agent_id: 'left', label: 'Left', status: 'working' }, { agent_id: 'right', label: 'Right', status: 'idle' }],
    phases: [{ phase_id: 'plan', agent_id: 'main', label: 'Parallel work', state: 'in_progress', declared_at: 1000, started_at: 1100, ended_at: null, depends_on: [] }],
    spans: [
      { span_id: 'wait-a', agent_id: 'main', kind: 'call', label: 'Native wait', started_at: 1200, ended_at: 1800, state: 'completed', wait_for_agent_ids: ['left'] },
      { span_id: 'wait-b', agent_id: 'main', kind: 'call', label: 'Native wait', started_at: 1900, ended_at: null, state: 'open', wait_for_agent_ids: ['right'], unresolved_wait_targets: 1 },
    ],
  }));
  assert.match(markup, /Native wait DAG/);
  assert.match(markup, /wait target/);
  assert.match(markup, /not.*business.*prerequisites/i);
  assert.match(markup, /unresolved/i);
  assert.equal((markup.match(/data-flow-edge=/g) || []).length, 2);
  assert.match(markup, /data-phase-interval="plan"/, 'native phase intervals remain in Gantt');
  assert.doesNotMatch(markup, /data-flow-node="plan"/);
});

test('returned-only wait results are visibly partial and never presented as the requested target set',()=>{
 const markup=executionTraceMarkup(view({lanes:[{agent_id:'main',label:'Coordinator',status:'idle'},{agent_id:'left',label:'Left',status:'idle'}],spans:[
  {span_id:'returned',agent_id:'main',kind:'call',label:'Native wait',started_at:1200,ended_at:1800,state:'completed',wait_result_agent_ids:['left']},
 ]}));
 assert.match(markup,/Returned wait results/);assert.match(markup,/full request.*unknown/i);assert.match(markup,/returned result/);
 assert.doesNotMatch(markup,/Native wait DAG|wait target<\/li>/);
 assert.equal((markup.match(/data-flow-edge=/g)||[]).length,1);
});

test('a harness without native execution integration has an explicit unsupported state', () => {
  assert.match(executionTraceMarkup(view({ availability: 'unsupported' })), /not yet connected/i);
});

test('execution reads are single-flight and cannot replace a newly selected session with a late response', async () => {
  let resolveFirst, calls = 0;
  const first = new Promise(resolve => { resolveFirst = resolve; });
  const client = new ExecutionClient(async url => { calls++; return url.includes('session_id=first') ? first : reply(view({ session_id: 'second' })); }, () => {});
  client.watch('first'); const pending = client.refresh();
  assert.equal(calls, 1);
  client.watch('second'); await client.refresh();
  resolveFirst(reply(view({ session_id: 'first' }))); await pending;
  assert.equal(client.value.session_id, 'second');
  client.stop();
});

test('a malformed or cross-session response never reaches the trace renderer', async () => {
  const client = new ExecutionClient(async () => reply(view({ session_id: 'other' })), () => {});
  client.watch('session'); await client.refresh();
  assert.equal(client.value, null); assert.ok(client.error);
  client.stop();
});

test('a transient read failure retains visible data with an explicit stale state', async () => {
  let fail = false;
  const client = new ExecutionClient(async () => { if (fail) throw Error('offline'); return reply(view()); }, () => {});
  client.watch('session'); await client.refresh(); fail = true; await client.refresh();
  assert.equal(client.value.session_id, 'session'); assert.ok(client.error);
  assert.match(executionTraceMarkup(client.value, client.error), /stale/i);
  client.stop();
});
