import assert from 'node:assert/strict';
import test from 'node:test';
import { codexExecutionEvents, claudeExecutionEvents } from '../dist/agents/nativeExecutionEvents.js';
import { LiveExecutionTracker } from '../dist/agents/liveExecutionTracker.js';

const at = n => new Date(n).toISOString();
const codex = (sequence, type, payload, time = sequence * 1000) => ({ sequence, value: { type, timestamp: at(time), payload } });
const claude = (sequence, role, content, time = sequence * 1000, extra = {}) => ({ sequence, value: { type: role, sessionId: 'root', cwd: '/probe', timestamp: at(time), message: { role, content }, ...extra } });
const use = (id, name, input = {}) => ({ type: 'tool_use', id, name, input });
const result = (id, content = 'ok', extra = {}) => ({ type: 'tool_result', tool_use_id: id, content, ...extra });
const agent = (id = 'main', parent = null) => ({ agent_id: id, identity: { session_id: 'session', native_agent_id: id }, name: id, role: parent ? 'subagent' : 'primary', parent_agent_id: parent, status: 'working' });
const ev = (sequence, kind, call_id, time, label = 'Bash') => ({ event_id: `e${sequence}:${kind}`, sequence, kind, call_id, at: time, label });
const input = (agents, events) => ({ agents, details: new Map(agents.map(a => [a.agent_id, { execution: { events: events[a.agent_id] || [], truncated_before: false } }])) });

test('Codex preserves native correlation and publishes a plan only after its tool result', () => {
  const rows = [codex(1, 'response_item', { type: 'function_call', name: 'update_plan', call_id: 'p1', arguments: JSON.stringify({ plan: [{ step: 'Prepare', status: 'in_progress' }, { step: 'Verify', status: 'pending' }], private: 'PRIVATE' }) }),
    codex(2, 'response_item', { type: 'function_call_output', call_id: 'p1', output: 'Plan updated' }),
    codex(3, 'response_item', { type: 'function_call', name: 'exec_command', call_id: 'a', arguments: 'PRIVATE ARGS' }),
    codex(4, 'response_item', { type: 'function_call_output', call_id: 'a', output: 'PRIVATE OUTPUT' })];
  assert.equal(codexExecutionEvents(rows.slice(0, 1)).some(e => e.kind === 'plan'), false);
  const events = codexExecutionEvents(rows);
  assert.deepEqual(events.find(e => e.kind === 'plan').phases.map(p => [p.label, p.state]), [['Prepare', 'in_progress'], ['Verify', 'pending']]);
  assert.equal(events.find(e => e.sequence === 4).call_id, 'a');
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE/);
});

test('only native execution boundaries produce run spans, separate from call dispatch', () => {
  const events = codexExecutionEvents([codex(1, 'response_item', { type: 'function_call', name: 'exec_command', call_id: 'a' }),
    codex(2, 'event_msg', { type: 'exec_command_begin', call_id: 'a' }),
    codex(3, 'event_msg', { type: 'exec_command_end', call_id: 'a', exit_code: 1 }),
    codex(4, 'response_item', { type: 'function_call_output', call_id: 'a' })]);
  assert.deepEqual(events.map(e => e.kind), ['call.start', 'run.start', 'run.end', 'call.end']);
  assert.equal(events.find(e => e.kind === 'run.end').outcome, 'failed');
});

test('Codex completed command items preserve native bounds without exporting commands or result bodies', () => {
  const item = (sequence, extra = {}, thread = 'native-root') => codex(sequence, 'event_msg', {
    type: 'item_completed', thread_id: thread, turn_id: 'turn', started_at_ms: 1100, completed_at_ms: 1800,
    item: { type: 'CommandExecution', id: 'exec-native', status: 'completed', command: 'PRIVATE COMMAND', stdout: 'PRIVATE OUTPUT', exit_code: 0, ...extra },
  }, 2000);
  const events = codexExecutionEvents([item(1), item(2, {}, 'foreign')], { nativeId: 'native-root' });
  assert.deepEqual(events.map(e => [e.kind, e.call_id, e.at]), [['run.start', 'exec-native', 1100], ['run.end', 'exec-native', 1800]]);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE|foreign/);
  assert.equal(events.some(e => e.kind === 'phase' || e.kind === 'plan'), false);
  const partial = item(3); partial.value.payload.started_at_ms = null;
  assert.deepEqual(codexExecutionEvents([partial], { nativeId: 'native-root' }).map(e => [e.kind, e.at]), [['run.end', 1800]]);
  const missingEnd = item(4); missingEnd.value.payload.completed_at_ms = null;
  assert.deepEqual(codexExecutionEvents([missingEnd], { nativeId: 'native-root' }).map(e => [e.kind, e.at]), [['run.start', 1100], ['run.end', null]], 'a completed item with no end clock cannot remain open');
});

test('Codex native agent activities correlate per child and never turn unspecified waits into dependencies', () => {
  const a = '22222222-2222-4222-8222-222222222222', b = '33333333-3333-4333-8333-333333333333';
  const activity = (sequence, kind, id, call) => codex(sequence, 'event_msg', {
    type: 'item_completed', thread_id: 'native-root', started_at_ms: sequence * 1000, completed_at_ms: sequence * 1000,
    item: { type: 'SubAgentActivity', id: call, kind, agent_thread_id: id, agent_path: `/root/${id === a ? 'branch_a' : 'branch_b'}` },
  });
  const rows = [activity(1, 'started', a, 'spawn-a'), activity(2, 'started', b, 'spawn-b'),
    activity(3, 'completed', a, 'done-a'), activity(4, 'completed', b, 'done-b'),
    codex(5, 'event_msg', { type: 'item_completed', thread_id: 'native-root', started_at_ms: 2000, completed_at_ms: 4000,
      item: { type: 'CollabAgentToolCall', id: 'wait', tool: 'wait', status: 'completed', receiver_thread_ids: [], agents_states: {} } })];
  const events = codexExecutionEvents(rows, { nativeId: 'native-root' });
  assert.deepEqual(events.filter(e => e.kind.startsWith('agent.')).map(e => [e.kind, e.target_native_id, e.call_id]), [
    ['agent.start', a, 'spawn-a'], ['agent.start', b, 'spawn-b'], ['agent.end', a, 'spawn-a'], ['agent.end', b, 'spawn-b'],
  ]);
  assert.equal(events.some(e => e.kind === 'phase' || e.kind === 'plan'), false, 'native activity and a wait with no targets cannot invent business phases or edges');
  const resumed = activity(6, 'started', a, 'resume-a');
  const completed = activity(7, 'completed', a, 'done-again');
  const current = codexExecutionEvents([completed], { nativeId: 'native-root', knownAgentStarts: [events[0], ...codexExecutionEvents([resumed], { nativeId: 'native-root' })] });
  assert.equal(current[0].call_id, 'resume-a');
});

test('Codex v1 native coordination carries exact wait target UUIDs and completion states without prompts', () => {
  const a = '22222222-2222-4222-8222-222222222222', b = '33333333-3333-4333-8333-333333333333';
  const item = (sequence, tool, id, targets, states) => codex(sequence, 'event_msg', {
    type: 'item_completed', thread_id: 'native-root', started_at_ms: sequence * 1000, completed_at_ms: sequence * 1000 + 100,
    item: { type: 'CollabAgentToolCall', id, tool, status: 'completed', sender_thread_id: 'native-root', receiver_thread_ids: targets,
      receiver_agents: targets.map(thread_id => ({ thread_id, agent_nickname: thread_id === a ? 'Left' : 'Right' })),
      agents_states: states, prompt: 'PRIVATE PROMPT' },
  });
  const rows = [item(1, 'spawn_agent', 'spawn-a', [a], { [a]: 'pending_init' }),
    item(2, 'spawn_agent', 'spawn-b', [b], { [b]: 'pending_init' }),
    item(3, 'wait', 'wait-a', [a], { [a]: { completed: 'PRIVATE RESULT' }, [b]: { completed: 'PRIVATE FOREIGN STATE' } }),
    item(4, 'wait', 'wait-b', [b], { [b]: 'running' })];
  const events = codexExecutionEvents(rows, { nativeId: 'native-root' });
  assert.deepEqual(events.filter(e => e.kind === 'agent.start').map(e => [e.target_native_id, e.call_id]), [[a, 'spawn-a'], [b, 'spawn-b']]);
  assert.deepEqual(events.filter(e => e.kind === 'agent.end').map(e => [e.target_native_id, e.call_id]), [[a, 'spawn-a']]);
  assert.equal(events.some(e => e.wait_for_native_ids), false, 'completed receiver IDs are returned results, not the full requested set');
  assert.deepEqual(events.filter(e => e.label === 'Native wait').map(e => [e.kind, e.call_id, e.wait_result_native_ids]), [
    ['call.start', 'wait-a', undefined], ['call.end', 'wait-a', [a]], ['call.start', 'wait-b', undefined], ['call.end', 'wait-b', [b]],
  ]);
  assert.equal(events.some(e => e.kind === 'phase' || e.kind === 'plan'), false);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE/);
  rows[2].value.payload.item.status = 'failed';
  assert.equal(codexExecutionEvents(rows, { nativeId: 'native-root' }).some(e => e.call_id === 'wait-a'), false);
});

test('wait target references stay separate from business phase prerequisites and reject foreign lanes', () => {
  const tracker = new LiveExecutionTracker('native-wait');
  const agents = [agent(), agent('left', 'main')];
  tracker.observe(input(agents, {}), 1000);
  tracker.observe(input(agents, { main: [{ ...ev(1, 'call.start', 'wait', 1100, 'Native wait'), wait_for_agent_ids: ['left', 'foreign'] }] }), 1200);
  const view = tracker.view('session', 1200), span = view.spans.find(s => s.label === 'Native wait');
  assert.deepEqual(span.wait_for_agent_ids, ['left']);
  assert.equal(span.unresolved_wait_targets, 1);
  assert.equal(view.phases.length, 0);
});

test('native stream cursors do not collide with transcript byte offsets or erase requested targets on completion',()=>{
 const tracker=new LiveExecutionTracker('stream-cursor'),agents=[agent(),agent('left','main'),agent('right','main')];
 tracker.observe(input(agents,{main:[ev(100000,'call.start','old',900)]}),1000);
 tracker.observe(input(agents,{main:[ev(100000,'call.start','old',900),{...ev(1,'call.start','wait',1100,'Native wait'),cursor_scope:'stream-one',wait_for_agent_ids:['left','right']}]}),1200);
 tracker.observe(input(agents,{main:[{...ev(2,'call.end','wait',1300,'Native wait'),cursor_scope:'stream-one',wait_result_agent_ids:['left']}]}),1400);
 const span=tracker.view('session',1400).spans.find(s=>s.label==='Native wait');assert.ok(span);assert.deepEqual(span.wait_for_agent_ids,['left','right']);assert.deepEqual(span.wait_result_agent_ids,['left']);
});

test('capture EOF cannot leave an unreturned native wait apparently running',()=>{
 const tracker=new LiveExecutionTracker('closed-stream'),agents=[agent(),agent('left','main')];tracker.observe(input(agents,{}),1000);
 const captured=input(agents,{main:[{...ev(1,'call.start','wait',1100,'Native wait'),cursor_scope:'capture',wait_for_agent_ids:['left']}]});
 captured.details.get('main').execution.closed_scopes=['capture'];tracker.observe(captured,1200);
 const span=tracker.view('session',1200).spans[0];assert.equal(span.state,'unknown');assert.equal(span.ended_at,null);assert.match(tracker.view('session',1200).notes.join(' '),/capture ended/);
});

test('a failed executor wrapper is not a successful native plan update', () => {
  const events = codexExecutionEvents([
    codex(1, 'response_item', { type: 'custom_tool_call', name: 'exec', call_id: 'attempt', input: 'PRIVATE JAVASCRIPT' }),
    codex(2, 'response_item', { type: 'custom_tool_call_output', call_id: 'attempt', output: [
      { type: 'input_text', text: 'Script failed\nWall time 0.0 seconds\nOutput:\n' },
      { type: 'input_text', text: 'PRIVATE TypeError: tools.update_plan is not a function' },
    ] }),
  ]);
  assert.equal(events.find(e => e.kind === 'call.end').outcome, 'failed');
  assert.equal(events.some(e => e.kind === 'plan' || e.kind === 'phase'), false);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE/);
});

test('Claude confirms TaskCreate and TaskUpdate with native task IDs and exact tool-use IDs', () => {
  const rows = [claude(1, 'assistant', [use('c1', 'TaskCreate', { subject: 'Prepare probe', description: 'PRIVATE DESCRIPTION' })]),
    claude(2, 'user', [result('c1', 'Task #1 created successfully: Prepare probe')]),
    claude(3, 'assistant', [use('u1', 'TaskUpdate', { taskId: '1', status: 'in_progress', addBlockedBy: ['2'] })]),
    claude(4, 'user', [result('u1', 'Updated task #1 status')]),
    claude(5, 'assistant', [use('b1', 'Bash', { command: 'PRIVATE COMMAND' }), use('b2', 'Bash')]),
    claude(6, 'user', [result('b2')]), claude(7, 'user', [result('b1')])];
  const events = claudeExecutionEvents(rows, { sessionId: 'root', primary: true });
  const phases = events.filter(e => e.kind === 'phase');
  assert.deepEqual(phases.map(e => [e.phase.id, e.phase.label, e.phase.state]), [['1', 'Prepare probe', 'pending'], ['1', undefined, 'in_progress']]);
  assert.deepEqual(phases[1].phase.depends_on, ['2']);
  assert.deepEqual(events.filter(e => e.kind === 'call.end').slice(-2).map(e => e.call_id), ['b2', 'b1']);
  assert.equal(events.some(e => e.kind.startsWith('run.')), false);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE/);
});

test('rejected task mutations and hidden or foreign transcript rows cannot advance phases', () => {
  const rows = [claude(1, 'assistant', [use('c', 'TaskCreate', { subject: 'Rejected' })]),
    claude(2, 'user', [result('c', 'Task #1 created successfully: Rejected', { is_error: true })]),
    claude(3, 'assistant', [use('hidden', 'TaskCreate', { subject: 'PRIVATE' })], 3000, { isVisible: false }),
    claude(4, 'assistant', [use('foreign', 'Bash')], 4000, { sessionId: 'other' })];
  const events = claudeExecutionEvents(rows, { sessionId: 'root', primary: true });
  assert.equal(events.some(e => e.kind === 'phase'), false);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE|foreign|hidden/);
});

test('Claude async agent lifetimes use native launch metadata and the matching queued completion', () => {
  const rows = [claude(1, 'assistant', [use('spawn', 'Agent', { subagent_type: 'probe-left', prompt: 'PRIVATE PROMPT' })]),
    claude(2, 'user', [result('spawn', 'PRIVATE OUTPUT')], 2000, { toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'worker-a' } }),
    { sequence: 3, value: { type: 'queue-operation', operation: 'enqueue', sessionId: 'root', timestamp: at(3000), content: '<task-notification>\n<task-id>worker-a</task-id>\n<tool-use-id>spawn</tool-use-id>\n<status>completed</status>\n<result>PRIVATE RESULT</result></task-notification>' } },
    { sequence: 4, value: { type: 'queue-operation', operation: 'enqueue', sessionId: 'root', timestamp: at(4000), content: '<task-notification><task-id>worker-a</task-id><tool-use-id>spawn</tool-use-id><status>completed</status></task-notification>' } }];
  const events = claudeExecutionEvents(rows, { sessionId: 'root', primary: true });
  assert.deepEqual(events.filter(e => e.kind.startsWith('agent.')).map(e => [e.kind, e.target_native_id, e.call_id, e.at]), [['agent.start', 'worker-a', 'spawn', 2000], ['agent.end', 'worker-a', 'spawn', 3000]]);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE/);
  const forged = rows.slice(0, 2).concat({ sequence: 5, value: { type: 'user', sessionId: 'root', timestamp: at(5000), message: { role: 'user', content: '<task-notification><task-id>worker-a</task-id><tool-use-id>spawn</tool-use-id><status>completed</status></task-notification>' } } });
  assert.equal(claudeExecutionEvents(forged, { sessionId: 'root', primary: true }).some(e => e.kind === 'agent.end'), false);
});

test('Claude typed task results take precedence over localized display text and reject mismatches', () => {
  const rows = [claude(1, 'assistant', [use('create', 'TaskCreate', { subject: 'Native task' })]),
    claude(2, 'user', [result('create', 'localized text')], 2000, { toolUseResult: { task: { id: '7', subject: 'Native task' } } }),
    claude(3, 'assistant', [use('update', 'TaskUpdate', { taskId: '7', status: 'in_progress', addBlockedBy: ['2'] })]),
    claude(4, 'user', [result('update', 'localized text')], 4000, { toolUseResult: { success: true, taskId: '7', updatedFields: ['status', 'blockedBy'], statusChange: { from: 'pending', to: 'in_progress' } } })];
  const phases = claudeExecutionEvents(rows, { sessionId: 'root', primary: true }).filter(e => e.kind === 'phase');
  assert.deepEqual(phases.map(e => [e.phase.id, e.phase.state]), [['7', 'pending'], ['7', 'in_progress']]);
  assert.deepEqual(phases[1].phase.depends_on, ['2']);
  rows[3].value.toolUseResult.taskId = 'another-task';
  rows[3].value.message.content[0].content = 'Updated task #7 status';
  assert.equal(claudeExecutionEvents(rows, { sessionId: 'root', primary: true }).filter(e => e.kind === 'phase').length, 1);
});

test('agent lifetimes are assigned to the native child and counted separately from tool execution', () => {
  const tracker = new LiveExecutionTracker('native-claude');
  const agents = [agent(), agent('left', 'main'), agent('right', 'main')];
  tracker.observe(input(agents, {}), 1000);
  const events = [
    { ...ev(1, 'agent.start', 'spawn-left', 1100, 'probe-left'), target_agent_id: 'left' },
    { ...ev(2, 'agent.start', 'spawn-right', 1200, 'probe-right'), target_agent_id: 'right' },
    { ...ev(3, 'agent.start', 'foreign-spawn', 1300), target_agent_id: 'foreign-session-agent' },
  ];
  tracker.observe(input(agents, { main: events }), 1400);
  const view = tracker.view('session', 1400);
  assert.equal(view.max_parallel_agents, 2);
  assert.equal(view.max_parallel_execution, null);
  assert.deepEqual(view.spans.map(span => span.agent_id), ['left', 'right']);
});

test('live observation establishes a watermark and never replays old events', () => {
  const tracker = new LiveExecutionTracker('epoch');
  tracker.observe(input([agent()], { main: [ev(1, 'call.start', 'old', 100)] }), 1000);
  assert.deepEqual(tracker.view('session', 1000).spans, []);
  tracker.observe(input([agent()], { main: [ev(1, 'call.start', 'old', 100), ev(2, 'call.start', 'new', 1100), ev(3, 'call.end', 'new', 1200)] }), 1300);
  const view = tracker.view('session', 1300);
  assert.equal(view.spans.length, 1);
  assert.deepEqual([view.spans[0].started_at, view.spans[0].ended_at], [1100, 1200]);
  assert.equal(view.observed_since, 1000);
});

test('in-flight call overlap does not claim verified parallel execution', () => {
  const tracker = new LiveExecutionTracker('epoch');
  tracker.observe(input([agent()], { main: [] }), 1000);
  tracker.observe(input([agent()], { main: [ev(1, 'call.start', 'a', 1100), ev(2, 'call.start', 'b', 1200), ev(3, 'call.end', 'b', 1300), ev(4, 'call.end', 'a', 1400)] }), 1500);
  const view = tracker.view('session', 1500);
  assert.equal(view.max_concurrent_calls, 2);
  assert.equal(view.max_parallel_execution, null);
  assert.deepEqual(view.spans.map(s => s.kind), ['call', 'call']);
});

test('two explicit execute entries report overlap while both runs are still open', () => {
  const tracker = new LiveExecutionTracker('pi-calibration');
  tracker.observe(input([agent()], {}), 1000);
  const events = [ev(1, 'run.start', 'prepare', 1100), ev(2, 'run.end', 'prepare', 1200),
    ev(3, 'call.start', 'batch', 1250), ev(4, 'run.start', 'batch/1', 1300), ev(5, 'run.start', 'batch/2', 1301)];
  tracker.observe(input([agent()], { main: events }), 1400);
  assert.equal(tracker.view('session', 1400).max_parallel_execution, 2);
  tracker.observe(input([agent()], { main: [...events, ev(6, 'run.end', 'batch/1', 1500)] }), 1600);
  assert.equal(tracker.view('session', 1600).max_parallel_execution, 2);
});

test('an explicit run start is evidence, while a lost or start-less run stays unknown', () => {
  const tracker = new LiveExecutionTracker('pi-calibration');
  tracker.observe(input([agent()], {}), 1000);
  const events = [ev(1, 'run.start', 'one', 1100), ev(2, 'run.end', 'missing-start', 1200)];
  tracker.observe(input([agent()], { main: events }), 1300);
  assert.equal(tracker.view('session', 1300).max_parallel_execution, 1);
  tracker.observe(input([], {}), 1400, [{ session_id: 'session' }]);
  assert.equal(tracker.view('session', 1400).max_parallel_execution, null);
  assert.equal(tracker.view('session', 1400).spans.find(span => span.started_at === 1100).ended_at, null);
});

test('a terminal agent without an execution end cannot remain running forever', () => {
  const tracker = new LiveExecutionTracker('pi-calibration');
  tracker.observe(input([agent()], {}), 1000);
  const events = [ev(1, 'run.start', 'unfinished', 1100)];
  tracker.observe(input([agent()], { main: events }), 1200);
  tracker.observe(input([{ ...agent(), status: 'idle', lifecycle: 'completed' }], { main: events }), 1300);
  const view = tracker.view('session', 1400);
  assert.equal(view.max_parallel_execution, null);
  assert.equal(view.spans[0].state, 'unknown');
  assert.equal(view.spans[0].ended_at, null);
});

test('matching is namespaced by agent, even when native IDs and tool names are reused', () => {
  const tracker = new LiveExecutionTracker('epoch'), agents = [agent(), agent('child', 'main')];
  tracker.observe(input(agents, {}), 1000);
  tracker.observe(input(agents, { main: [ev(1, 'call.start', 'same', 1100)], child: [ev(1, 'call.start', 'same', 1200), ev(2, 'call.end', 'same', 1300)] }), 1400);
  const view = tracker.view('session', 1400);
  assert.equal(view.spans.find(s => s.agent_id === 'main').ended_at, null);
  assert.equal(view.spans.find(s => s.agent_id === 'child').ended_at, 1300);
});

test('late results without an observed start remain partial, never fabricate a duration', () => {
  const tracker = new LiveExecutionTracker('epoch'); tracker.observe(input([agent()], {}), 1000);
  tracker.observe(input([agent()], { main: [ev(1, 'call.end', 'unknown-start', 1200)] }), 1300);
  const span = tracker.view('session', 1300).spans[0];
  assert.equal(span.started_at, null); assert.equal(span.ended_at, 1200);
});

test('a newly discovered agent contributes only events from the live observation window', () => {
  const tracker = new LiveExecutionTracker('epoch'); tracker.observe(input([agent()], {}), 1000);
  tracker.observe(input([agent(), agent('child', 'main')], { child: [ev(1, 'call.start', 'past', 900), ev(2, 'call.start', 'new', 1100)] }), 1200);
  assert.equal(tracker.view('session', 1200).spans.length, 1);
  assert.match(tracker.view('session', 1200).spans[0].span_id, /new/);
});

test('phase progression follows reported task state and retains explicit dependency direction', () => {
  const tracker = new LiveExecutionTracker('epoch'); tracker.observe(input([agent()], {}), 1000);
  const events = [{ ...ev(1, 'phase', undefined, 1100), phase: { id: 'a', label: 'Prepare', state: 'pending' } },
    { ...ev(2, 'phase', undefined, 1200), phase: { id: 'b', label: 'Verify', state: 'pending', depends_on: ['a'] } },
    { ...ev(3, 'phase', undefined, 1300), phase: { id: 'a', state: 'in_progress' } },
    { ...ev(4, 'phase', undefined, 1400), phase: { id: 'a', state: 'completed' } }];
  tracker.observe(input([agent()], { main: events }), 1500);
  const phases = tracker.view('session', 1500).phases;
  assert.deepEqual(phases.map(p => [p.label, p.state]), [['Prepare', 'completed'], ['Verify', 'pending']]);
  assert.deepEqual([phases[0].started_at, phases[0].ended_at], [1300, 1400]);
  assert.deepEqual(phases[1].depends_on, [phases[0].phase_id]);
});

test('an unchanged completed-task acknowledgement does not move its actual completion boundary', () => {
  const tracker = new LiveExecutionTracker('epoch'); tracker.observe(input([agent()], {}), 1000);
  tracker.observe(input([agent()], { main: [{ ...ev(1, 'phase', undefined, 1100), phase: { id: 'a', label: 'Prepare', state: 'in_progress' } },
    { ...ev(2, 'phase', undefined, 1200), phase: { id: 'a', state: 'completed' } },
    { ...ev(3, 'phase', undefined, 1500), phase: { id: 'a', state: 'completed' } }] }), 1600);
  assert.equal(tracker.view('session', 1600).phases[0].ended_at, 1200);
});

test('an agent leaving observation cannot leave an apparently running interval behind', () => {
  const tracker = new LiveExecutionTracker('epoch'); tracker.observe(input([agent(), agent('child', 'main')], {}), 1000);
  tracker.observe(input([agent(), agent('child', 'main')], { child: [ev(1, 'call.start', 'a', 1100)] }), 1200);
  tracker.observe(input([agent()], {}), 1400);
  const span = tracker.view('session', 1400).spans[0];
  assert.equal(span.state, 'unknown'); assert.equal(span.ended_at, null);
});

test('a missing end timestamp never contributes an invented duration or execution overlap', () => {
  const tracker = new LiveExecutionTracker('epoch'); tracker.observe(input([agent()], {}), 1000);
  tracker.observe(input([agent()], { main: [ev(1, 'run.start', 'a', 1100), ev(2, 'run.end', 'a', null)] }), 1500);
  assert.equal(tracker.view('session', 1500).max_parallel_execution, null);
});

test('unsupported harnesses are identified instead of waiting indefinitely for native events', () => {
  const tracker = new LiveExecutionTracker('epoch');
  tracker.observe({ agents: [], details: new Map(), coverage: { session: 'unsupported' } }, 1000, [{ session_id: 'session' }]);
  assert.equal(tracker.view('session', 1000).availability, 'unsupported');
});

test('a native plan snapshot replaces removed phases and preserves unchanged start boundaries', () => {
  const tracker = new LiveExecutionTracker('epoch'); tracker.observe(input([agent()], {}), 1000);
  tracker.observe(input([agent()], { main: [{ ...ev(1, 'plan', undefined, 1100), phases: [{ id: 'a', label: 'Prepare', state: 'pending' }, { id: 'b', label: 'Verify', state: 'in_progress' }] }] }), 1200);
  tracker.observe(input([agent()], { main: [{ ...ev(2, 'plan', undefined, 1300), phases: [{ id: 'b', label: 'Verify', state: 'in_progress' }] }] }), 1400);
  const phases = tracker.view('session', 1400).phases;
  assert.equal(phases.length, 1); assert.equal(phases[0].label, 'Verify'); assert.equal(phases[0].started_at, 1100);
});
