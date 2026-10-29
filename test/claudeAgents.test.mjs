import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createClaudeAgentCollector } from '../dist/agents/claudeAgents.js';
import { assertSnapshot, SCHEMA } from '../dist/shared/agentContract.js';

const ROOT = '11111111-1111-4111-8111-111111111111';
const OTHER = '44444444-4444-4444-8444-444444444444';
const CHILD = 'a1234567890abcdef';
const NESTED = 'a9876543210fedcba';
const NOW = Date.UTC(2026, 9, 28, 12);
const CWD = '/synthetic/atlas';
const session = (extra = {}) => ({
  session_id: `${ROOT}__atlas`, session_type: 'Claude Code', source: 'hook',
  session_name: 'Design', status: 'working', task_name: 'Build', timestamp: NOW,
  project: 'atlas', project_path: CWD, ...extra,
});
const message = (number, role, content, extra = {}, messageExtra = {}) => ({
  sessionId: ROOT, agentId: CHILD, isSidechain: true, cwd: CWD,
  parentUuid: number ? `message-${number - 1}` : null, uuid: `message-${number}`,
  timestamp: new Date(NOW + number).toISOString(), type: role,
  message: { role, content, ...messageExtra }, ...extra,
});
const tool = (id, name = 'Read') => ({ type: 'tool_use', id, name, input: { PRIVATE: 'TOOL ARGUMENTS' } });
const collector = (root, extra = {}) => createClaudeAgentCollector({ root, sourceId: 'test-local-claude', ...extra });
const childOf = (result, id = CHILD) => result.agents.find(agent => agent.identity.native_agent_id === id);
const childDetail = (result, id = CHILD) => result.details.get(childOf(result, id).agent_id);
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'claude-agent-fixture-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function write(path, content, mtime = NOW) {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content); await utimes(path, new Date(mtime), new Date(mtime));
  return path;
}
async function log(root, records = [message(0, 'user', 'Visible task')], { id = CHILD, rootId = ROOT, project = '-synthetic-atlas', meta = { agentType: 'Explore', spawnDepth: 1, toolUseId: 'spawn-1' }, mtime = NOW, suffix = '\n' } = {}) {
  const path = join(root, project, rootId, 'subagents', `agent-${id}.jsonl`);
  await write(path, records.map(row => JSON.stringify(row)).join('\n') + suffix, mtime);
  if (meta !== null) await write(path.replace(/\.jsonl$/, '.meta.json'), JSON.stringify(meta), mtime);
  return path;
}
async function parentLog(root, records, project = '-synthetic-atlas') {
  return write(join(root, project, `${ROOT}.jsonl`), records.map(row => JSON.stringify(row)).join('\n') + '\n');
}
function valid(result, sessions = [session()]) {
  assertSnapshot({ schema_version: SCHEMA, kind: 'snapshot', stream_id: 'test', revision: 0, projects: [],
    sessions: sessions.map(s => ({ session_id: s.session_id, project_id: null, name: s.session_name, agents_coverage: result.coverage[s.session_id] })), agents: result.agents });
}

test('primary-only Claude runs expose task progression and calls before any agent is spawned', async t => {
  const root = await fixture(t);
  const primary = (number, role, content) => message(number, role, content, { isSidechain: false, agentId: undefined });
  await parentLog(root, [primary(0, 'user', 'PRIVATE PROMPT'),
    primary(1, 'assistant', [{ type: 'tool_use', id: 'create', name: 'TaskCreate', input: { subject: 'Prepare probe', description: 'PRIVATE DESCRIPTION' } }]),
    primary(2, 'user', [{ type: 'tool_result', tool_use_id: 'create', content: 'Task #1 created successfully: Prepare probe' }])]);
  const result = await collector(root).collect([session()], NOW);
  const main = result.agents.find(a => a.role === 'primary');
  assert.ok(main);
  const events = result.details.get(main.agent_id).execution.events;
  assert.equal(events.find(e => e.kind === 'phase').phase.label, 'Prepare probe');
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE/);
});

test('native async launch creates a metadata-only child lane before its transcript is readable', async t => {
  const root = await fixture(t);
  const primary = (number, role, content, extra = {}) => message(number, role, content, { isSidechain: false, agentId: undefined, ...extra });
  await parentLog(root, [primary(0, 'user', 'PRIVATE PROMPT'),
    primary(1, 'assistant', [{ type: 'tool_use', id: 'spawn-1', name: 'Agent', input: { subagent_type: 'probe-left', prompt: 'PRIVATE CHILD PROMPT' } }]),
    primary(2, 'user', [{ type: 'tool_result', tool_use_id: 'spawn-1', content: 'PRIVATE OUTPUT' }], { toolUseResult: { isAsync: true, status: 'async_launched', agentId: CHILD } })]);
  const read = collector(root);
  let result = await read.collect([session()], NOW + 3);
  valid(result);
  assert.equal(childOf(result).name, 'probe-left');
  assert.equal(childDetail(result).conversation.availability, 'unknown');
  const main = result.agents.find(a => a.role === 'primary');
  const start = result.details.get(main.agent_id).execution.events.find(e => e.kind === 'agent.start');
  assert.equal(start.target_agent_id, childOf(result).agent_id);
  await parentLog(root, [primary(0, 'user', 'PRIVATE PROMPT'),
    primary(1, 'assistant', [{ type: 'tool_use', id: 'spawn-1', name: 'Agent', input: { subagent_type: 'probe-left' } }]),
    primary(2, 'user', [{ type: 'tool_result', tool_use_id: 'spawn-1', content: 'launched' }], { toolUseResult: { isAsync: true, status: 'async_launched', agentId: CHILD } }),
    { type: 'queue-operation', operation: 'enqueue', sessionId: ROOT, timestamp: new Date(NOW + 4).toISOString(), content: `<task-notification><task-id>${CHILD}</task-id><tool-use-id>spawn-1</tool-use-id><status>completed</status><result>PRIVATE RESULT</result></task-notification>` }]);
  result = await read.collect([session()], NOW + 5);
  assert.equal(childOf(result).lifecycle, 'completed');
  assert.equal(childOf(result).status, 'idle');
  assert.doesNotMatch(JSON.stringify(result.details.get(main.agent_id).execution), /PRIVATE/);
});

test('an observed async launch remains matchable when later output pushes it outside the tail window', async t => {
  const root = await fixture(t);
  const primary = (number, role, content, extra = {}) => message(number, role, content, { isSidechain: false, agentId: undefined, ...extra });
  const records = [primary(0, 'user', 'PRIVATE'), { type: 'diagnostic', data: 'x'.repeat(70000) },
    primary(1, 'assistant', [{ type: 'tool_use', id: 'spawn', name: 'Agent', input: { subagent_type: 'probe-left' } }]),
    primary(2, 'user', [{ type: 'tool_result', tool_use_id: 'spawn', content: 'launched' }], { toolUseResult: { isAsync: true, status: 'async_launched', agentId: CHILD } })];
  await parentLog(root, records);
  const read = collector(root, { maxBytes: 2048 });
  let result = await read.collect([session()], NOW + 3);
  const mainId = result.agents.find(a => a.role === 'primary').agent_id;
  assert.equal(result.details.get(mainId).execution.events.some(e => e.kind === 'agent.start'), true);
  records.push({ type: 'diagnostic', data: 'y'.repeat(8000) }, { type: 'queue-operation', operation: 'enqueue', sessionId: ROOT, timestamp: new Date(NOW + 4).toISOString(), content: `<task-notification><task-id>${CHILD}</task-id><tool-use-id>spawn</tool-use-id><status>completed</status></task-notification>` });
  await parentLog(root, records);
  result = await read.collect([session()], NOW + 5);
  assert.equal(result.details.get(mainId).execution.events.some(e => e.kind === 'agent.end'), true);
  assert.equal(childOf(result).lifecycle, 'completed');
});

test('keeps canonical root identity and uses explicit spawn calls for nested parents', async t => {
  const root = await fixture(t);
  await parentLog(root, [message(0, 'assistant', [tool('spawn-1', 'Agent')], { isSidechain: false, agentId: undefined })]);
  await log(root, [message(0, 'user', 'Visible task'), message(1, 'assistant', [tool('spawn-2', 'Task')])], { meta: { agentType: 'Explore', name: 'Reviewer', toolUseId: 'spawn-1', spawnDepth: 1 } });
  await log(root, [message(0, 'user', 'Nested task', { agentId: NESTED })], { id: NESTED, meta: { agentType: 'general-purpose', toolUseId: 'spawn-2', spawnDepth: 2 } });
  const result = await collector(root).collect([session()], NOW);
  valid(result);
  assert.equal(result.agents.length, 3);
  assert.equal(childOf(result).name, 'Reviewer');
  assert.equal(childOf(result).parent_agent_id, childOf(result, ROOT).agent_id);
  assert.equal(childOf(result, NESTED).parent_agent_id, childOf(result).agent_id);
  assert.ok(result.agents.every(agent => agent.identity.session_id === session().session_id));
  assert.equal(result.coverage[session().session_id], 'partial');
});

test('missing or ambiguous nested spawn ownership does not infer a parent from message parentUuid', async t => {
  const root = await fixture(t);
  await log(root, [message(0, 'user', 'Nested task', { parentUuid: ROOT })], { meta: { agentType: 'Explore', spawnDepth: 2, toolUseId: 'unobserved' } });
  const result = await collector(root).collect([session()], NOW);
  valid(result);
  assert.equal(childOf(result).parent_agent_id, null);
});

test('exports only child-visible dialogue and tool names; no reasoning, inherited, metadata or tool contents', async t => {
  const root = await fixture(t);
  await log(root, [
    message(0, 'user', 'Visible task'),
    message(1, 'system', 'PRIVATE SYSTEM'),
    message(2, 'developer', 'PRIVATE DEVELOPER'),
    message(3, 'assistant', [{ type: 'thinking', thinking: 'PRIVATE REASONING' }, { type: 'text', text: 'Visible answer' }]),
    message(4, 'user', 'PRIVATE META', { isMeta: true }),
    message(5, 'assistant', 'PRIVATE SYNTHETIC', { isSynthetic: true }),
    message(6, 'user', 'PRIVATE COMPACTION', { isCompactSummary: true }),
    message(7, 'assistant', 'PRIVATE HIDDEN', { isVisible: false }),
    message(8, 'user', 'PRIVATE PARENT', { isSidechain: false }),
    message(9, 'assistant', 'PRIVATE OTHER CHILD', { agentId: NESTED }),
    message(10, 'assistant', 'PRIVATE OTHER SESSION', { sessionId: OTHER }),
    message(11, 'assistant', [tool('read-1')]),
    message(12, 'user', [{ type: 'tool_result', tool_use_id: 'read-1', content: 'PRIVATE TOOL OUTPUT' }, { type: 'text', text: 'PRIVATE TOOL CONTEXT' }]),
    { ...message(13, 'user', 'PRIVATE ATTACHMENT'), type: 'attachment', renderedRole: 'user' },
    { ...message(14, 'assistant', 'PRIVATE API'), type: 'api_request', params: { messages: 'PRIVATE API PARAMS' } },
    message(15, 'assistant', [{ type: 'text', text: 'Visible final' }], {}, { stop_reason: 'end_turn' }),
  ]);
  const result = await collector(root).collect([session()], NOW);
  const detail = childDetail(result);
  assert.deepEqual(detail.conversation.items.map(row => row.text), ['Visible task', 'Visible answer', 'Visible final']);
  assert.deepEqual(detail.workflow.items.map(row => [row.stage, row.label]), [['tool.start', 'Read'], ['tool.complete', 'Read'], ['turn.complete', 'Turn finished']]);
  assert.doesNotMatch(JSON.stringify(detail), /PRIVATE/);
  assert.deepEqual(detail.workflow_graph, { availability: 'unsupported', graph: null });
  assert.equal(childOf(result).lifecycle, 'active');
  assert.equal(childOf(result).status, 'idle');
});

test('only explicit finished or stopped metadata proves agent lifecycle completion', async t => {
  const root = await fixture(t);
  await log(root, [message(0, 'assistant', 'Answer', {}, { stop_reason: 'end_turn' })], { meta: { agentType: 'Explore', spawnDepth: 1, finished: true } });
  await log(root, [message(0, 'user', 'Cancelled task', { agentId: NESTED })], { id: NESTED, meta: { agentType: 'Plan', spawnDepth: 1, stoppedByUser: true, finished: true } });
  const result = await collector(root).collect([session()], NOW);
  valid(result);
  assert.equal(childOf(result).lifecycle, 'completed');
  assert.equal(childOf(result, NESTED).lifecycle, 'cancelled');
  assert.equal(childOf(result, NESTED).status, 'idle');
});

test('keeps model provider distinct from harness and does not mislabel CLI color as native artwork', async t => {
  const root = await fixture(t);
  await log(root, undefined, { meta: { agentType: 'Explore', spawnDepth: 1, color: 'blue', spinner: 'flower' } });
  const read = collector(root);
  const unknown = await read.collect([session()], NOW);
  assert.ok(unknown.agents.every(agent => agent.provider_id === null && agent.avatar === null));
  const explicit = await read.collect([session({ model_provider: 'custom-provider' })], NOW);
  assert.ok(explicit.agents.every(agent => agent.provider_id === 'custom-provider' && agent.avatar === null));
});

test('supports only local Claude Code aliases, excluding desktop, other harnesses and remote sessions', async t => {
  const root = await fixture(t); await log(root);
  for (const session_type of ['Claude Code', 'claude', 'claude-code']) {
    const current = session({ session_type });
    const result = await collector(root).collect([current], NOW); valid(result, [current]);
    assert.equal(result.agents.length, 2);
  }
  for (const extra of [{ session_type: 'Codex' }, { session_type: 'DeepSeek' }, { session_type: 'Claude Desktop' }, { origin: 'remote' }]) {
    const current = session(extra);
    const result = await collector(root).collect([current], NOW); valid(result, [current]);
    assert.equal(result.agents.length, 0); assert.equal(result.coverage[current.session_id], 'unsupported');
  }
});

test('isolates different roots, wrong cwd, mismatched native IDs and ambiguous canonical sessions', async t => {
  const root = await fixture(t);
  await log(root, [message(0, 'user', 'Wrong root', { sessionId: OTHER })]);
  assert.equal((await collector(root).collect([session()], NOW)).agents.length, 0);
  await log(root, [message(0, 'user', 'Wrong cwd', { cwd: '/another/project' })]);
  assert.equal((await collector(root).collect([session()], NOW)).agents.length, 0);
  await log(root, [message(0, 'user', 'Wrong child', { agentId: NESTED })]);
  assert.equal((await collector(root).collect([session()], NOW)).agents.length, 0);
  await log(root);
  const sessions = [session(), session({ session_id: `alias-${ROOT}__atlas` })];
  const result = await collector(root).collect(sessions, NOW); valid(result, sessions);
  assert.equal(result.agents.length, 0);
});

test('UUID in project suffix does not obscure the native root and namespace changes agent identity', async t => {
  const root = await fixture(t); await log(root);
  const current = session({ session_id: `${ROOT}__${OTHER}` });
  const first = await collector(root).collect([current], NOW); valid(first, [current]);
  const second = await collector(root, { sourceId: 'other-local-machine' }).collect([current], NOW);
  assert.equal(first.agents.length, 2);
  assert.notEqual(childOf(first).agent_id, childOf(second).agent_id);
  assert.equal(childOf(first).identity.native_agent_id, childOf(second).identity.native_agent_id);
});

test('same root in multiple project stores is ambiguous even when children have distinct IDs', async t => {
  const root = await fixture(t); await log(root);
  await log(root, [message(0, 'user', 'Other store', { agentId: NESTED })], { id: NESTED, project: '-another-store' });
  const result = await collector(root).collect([session()], NOW); valid(result);
  assert.equal(result.agents.length, 0);
});

test('sidecar changes update cached names and lifecycle without transcript changes', async t => {
  const root = await fixture(t); const path = await log(root);
  const read = collector(root); const initial = await read.collect([session()], NOW);
  await write(path.replace(/\.jsonl$/, '.meta.json'), JSON.stringify({ name: 'Renamed', finished: true, spawnDepth: 1 }), NOW + 1);
  const next = await read.collect([session()], NOW + 1); valid(next);
  assert.equal(childOf(next).agent_id, childOf(initial).agent_id);
  assert.equal(childOf(next).name, 'Renamed'); assert.equal(childOf(next).lifecycle, 'completed');
  childDetail(next).conversation.items[0].text = 'Mutation';
  assert.equal(childDetail(await read.collect([session()], NOW + 2)).conversation.items[0].text, 'Visible task');
});

test('unreadable subagent directory retains last-good children with partial coverage and unknown liveness', async t => {
  const root = await fixture(t); const path = await log(root); const directory = join(path, '..');
  const read = collector(root); await read.collect([session()], NOW);
  await chmod(directory, 0o000);
  t.after(() => chmod(directory, 0o700).catch(() => {}));
  const result = await read.collect([session()], NOW + 1);
  await chmod(directory, 0o700);
  valid(result);
  assert.equal(result.agents.length, 2);
  assert.equal(childOf(result).status, 'unknown');
  assert.equal(result.coverage[session().session_id], 'partial');
  assert.equal(childDetail(result).conversation.items[0].text, 'Visible task');
});

test('corrupt sidecar retains last-good data until a complete replacement is readable', async t => {
  const root = await fixture(t); const path = await log(root);
  const read = collector(root); await read.collect([session()], NOW);
  await write(path.replace(/\.jsonl$/, '.meta.json'), '{', NOW + 1);
  const failed = await read.collect([session()], NOW + 1); valid(failed);
  assert.equal(childOf(failed).status, 'unknown');
  assert.equal(childDetail(failed).conversation.items[0].text, 'Visible task');
  await write(path.replace(/\.jsonl$/, '.meta.json'), JSON.stringify({ name: 'Recovered', spawnDepth: 1 }), NOW + 2);
  const recovered = await read.collect([session()], NOW + 2);
  assert.equal(childOf(recovered).name, 'Recovered'); assert.equal(childOf(recovered).status, 'working');
});

test('deleting a child file and deleting its entire root directory both remove cached agents', async t => {
  const root = await fixture(t); const path = await log(root);
  const read = collector(root); await read.collect([session()], NOW);
  await unlink(path);
  assert.equal((await read.collect([session()], NOW + 1)).agents.length, 0);
  await log(root); await read.collect([session()], NOW + 2);
  await rm(join(path, '..', '..'), { recursive: true });
  const result = await read.collect([session()], NOW + 3); valid(result);
  assert.equal(result.agents.length, 0);
});

test('stale activity becomes unknown and entries outside the discovery window expire from cache', async t => {
  const root = await fixture(t); await log(root);
  const read = collector(root, { activeMs: 100, windowMs: 1000 });
  assert.equal(childOf(await read.collect([session()], NOW)).status, 'working');
  assert.equal(childOf(await read.collect([session()], NOW + 101)).status, 'unknown');
  assert.equal((await read.collect([session()], NOW + 1001)).agents.length, 0);
});

test('missing data stays unknown, an empty observed subagent directory is partial, unsupported stays unsupported', async t => {
  const root = await fixture(t);
  const absent = await collector(root).collect([session()], NOW); valid(absent);
  assert.equal(absent.coverage[session().session_id], 'unknown');
  await mkdir(join(root, '-synthetic-atlas', ROOT, 'subagents'), { recursive: true });
  const empty = await collector(root).collect([session()], NOW); valid(empty);
  assert.equal(empty.coverage[session().session_id], 'partial'); assert.deepEqual(empty.agents, []);
});

test('bounded tail skips partial records, keeps stable byte sequences, and deduplicates UUIDs', async t => {
  const root = await fixture(t);
  const records = [message(0, 'user', 'Initial task'), message(1, 'assistant', 'x'.repeat(5000)), message(2, 'assistant', 'First visible tail'), message(3, 'assistant', 'Second visible tail'), message(3, 'assistant', 'Duplicate UUID')];
  const path = await log(root, records, { suffix: '\n{"incomplete":' });
  const read = collector(root, { maxBytes: 1500 });
  const result = await read.collect([session()], NOW); valid(result);
  const detail = childDetail(result);
  assert.equal(detail.conversation.truncated_before, true);
  assert.deepEqual(detail.conversation.items.map(row => row.text), ['First visible tail', 'Second visible tail']);
  assert.ok(detail.conversation.items[1].sequence > detail.conversation.items[0].sequence);
  await write(path, records.map(row => JSON.stringify(row)).join('\n') + '\n' + JSON.stringify(message(4, 'assistant', 'Last tail')) + '\n', NOW + 1);
  const next = childDetail(await read.collect([session()], NOW + 1));
  assert.equal(next.conversation.items.find(row => row.message_id === 'message-3').sequence, detail.conversation.items[1].sequence);
});

test('bounds roster and history without claiming complete coverage', async t => {
  const root = await fixture(t);
  await log(root, Array.from({ length: 510 }, (_, index) => message(index, index ? 'assistant' : 'user', `Visible ${index}`)));
  await log(root, [message(0, 'user', 'Second child', { agentId: NESTED })], { id: NESTED, mtime: NOW - 1 });
  const result = await collector(root, { maxFiles: 1 }).collect([session()], NOW); valid(result);
  assert.equal(result.agents.length, 2);
  assert.equal(childDetail(result).conversation.items.length, 500);
  assert.equal(childDetail(result).conversation.truncated_before, true);
  assert.equal(result.coverage[session().session_id], 'partial');
});

test('does not traverse symlinked project directories or subagent files', async t => {
  const root = await fixture(t), outside = await fixture(t); const path = await log(outside);
  await symlink(join(outside, '-synthetic-atlas'), join(root, '-symlinked-project'));
  assert.equal((await collector(root).collect([session()], NOW)).agents.length, 0);
  const dir = join(root, '-synthetic-atlas', ROOT, 'subagents');
  await mkdir(dir, { recursive: true }); await symlink(path, join(dir, `agent-${CHILD}.jsonl`));
  assert.equal((await collector(root).collect([session()], NOW)).agents.length, 0);
});

test('removing or reassigning the root session does not resurrect cached children', async t => {
  const root = await fixture(t); await log(root); const read = collector(root);
  await read.collect([session()], NOW);
  assert.equal((await read.collect([], NOW + 1)).agents.length, 0);
  const reassigned = session({ project_path: '/unrelated/project' });
  assert.equal((await read.collect([reassigned], NOW + 2)).agents.length, 0);
});

test('forks and transcripts without a proven independent beginning expose roster but no inherited details', async t => {
  const root = await fixture(t);
  for (const [first, meta] of [
    [message(0, 'user', 'PRIVATE INHERITED'), { agentType: 'fork', spawnDepth: 1 }],
    [message(0, 'user', 'PRIVATE INHERITED', { parentUuid: 'unseen-parent' }), { agentType: 'Explore', spawnDepth: 1 }],
    [message(0, 'assistant', 'PRIVATE INHERITED'), { agentType: 'Explore', spawnDepth: 1 }],
  ]) {
    await log(root, [first, message(1, 'assistant', [tool('private-tool')])], { meta });
    const result = await collector(root).collect([session()], NOW); valid(result);
    assert.equal(result.agents.length, 2); assert.equal(childOf(result).parent_agent_id, childOf(result, ROOT).agent_id);
    assert.deepEqual(childDetail(result).conversation, { availability: 'unknown', items: [], truncated_before: false });
    assert.deepEqual(childDetail(result).workflow, { availability: 'unknown', items: [], truncated_before: false });
    assert.doesNotMatch(JSON.stringify(childDetail(result)), /PRIVATE|private-tool/);
  }
});

test('cyclic and ambiguous spawn evidence never creates cyclic parent relations', async t => {
  const root = await fixture(t);
  await log(root, [message(0, 'user', 'Task'), message(1, 'assistant', [tool('spawn-2', 'Agent')])], { meta: { agentType: 'Explore', spawnDepth: 2, toolUseId: 'spawn-1' } });
  await log(root, [message(0, 'user', 'Nested task', { agentId: NESTED }), message(1, 'assistant', [tool('spawn-1', 'Agent')], { agentId: NESTED })], { id: NESTED, meta: { agentType: 'Explore', spawnDepth: 2, toolUseId: 'spawn-2' } });
  const result = await collector(root).collect([session()], NOW); valid(result);
  assert.equal(childOf(result).parent_agent_id, null); assert.equal(childOf(result, NESTED).parent_agent_id, null);
  await parentLog(root, [message(0, 'assistant', [tool('spawn-1', 'Agent')], { isSidechain: false, agentId: undefined })]);
  const ambiguous = await collector(root).collect([session()], NOW); valid(ambiguous);
  assert.equal(childOf(ambiguous).parent_agent_id, null);
});
