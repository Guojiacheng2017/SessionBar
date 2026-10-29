import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, utimes, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import test from 'node:test';
import { createDeepSeekAgentCollector } from '../dist/agents/deepseekAgents.js';
import { assertSnapshot, assertAgentDetail, SCHEMA } from '../dist/shared/agentContract.js';

const NOW = Date.UTC(2026, 9, 28, 8);
const CWD = '/synthetic/Project';
const ROOT = 'session-root', CHILD = 'session-worker', NESTED = 'session-nested';
const session = (extra = {}) => ({ session_id: `dsh-${ROOT}__Project`, session_type: 'DeepSeek Harness', session_name: 'Design',
  project: 'Project', project_path: CWD, source: 'filesystem_snapshot', status: 'working', task_name: 'Design', timestamp: NOW, ...extra });
const entry = (id = CHILD, extra = {}) => ({ version: 0, childId: id, childCreatedAt: NOW - 900, mode: 'continuable', label: 'Reviewer', ...extra });
const row = (ver, val, seq = 50) => ({ ver, seq, val });
function checkpoint(id = ROOT, children = [], extra = {}) {
  return { version: 7, record: {
    identity: { formatVersion: 4, createdAt: id === ROOT ? NOW - 1000 : NOW - 900, cwd: CWD, isSeeded: false, inheritedEventCount: 0 },
    rows: {
      subagent: row(2, id === ROOT ? {} : { identity: { mode: 'continuable', label: 'Reviewer', seq: 0 } }),
      subagentCatalog: row(6, { inheritedEventCount: 0, ...(children.length ? { head: { values: children } } : {}) }),
      turnBoundary: row(2, { openTurnStartSeq: null, lastStepStartSeq: null, lastStepBoundary: null, lastTurn: 0 }),
      subagentTiming: row(3, { descriptorSeen: id !== ROOT, settledMs: 0 }),
      userQuestions: row(2, { inheritedEventCount: 0, questions: { active: [] } }),
      ...extra,
    },
  } };
}
const event = (seq, type, data = {}, extra = {}) => ({ seq, type, data, time: NOW - 100 + seq, ...extra });
const descriptor = (seq = 0, mode = 'continuable') => event(seq, 'subagent/descriptor', { version: 3, mode, label: 'Reviewer', provider: 'local' });
const message = (seq, role, body, extra = {}) => {
  const value = { id: `msg-${seq}`, role, source: { kind: role === 'user' ? 'user' : 'model', provider: 'deepseek', model: 'test' }, content: [{ type: 'text', text: body }], ...extra };
  return event(seq, `${role}/message`, role === 'user' ? value : { message: value }, { surfaceOp: 'append' });
};
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-agents-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function saveCheckpoint(root, id, document = checkpoint(id), mtime = NOW) {
  const file = join(root, 'storages/session_projcache/sessions', `${id}.json`);
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, typeof document === 'string' ? document : JSON.stringify(document));
  await utimes(file, new Date(mtime), new Date(mtime));
  return file;
}
async function log(root, id, events, { header = {}, mtime = NOW, torn = false, singleFrame = false } = {}) {
  const meta = { type: 'session', version: 4, id, createdAt: id === ROOT ? NOW - 1000 : NOW - 900, cwd: CWD, isSeeded: false,
    delegationDepth: id === ROOT ? 0 : 1, ...(id === ROOT ? {} : { parentSession: ROOT, origin: 'subagent' }), ...header };
  const file = join(root, 'sessions', '--synthetic-Project--', id, 'session.v4.jsonl.zstd');
  await mkdir(join(file, '..'), { recursive: true });
  const rows = [meta, ...events];
  const bytes = singleFrame ? zstdCompressSync(Buffer.from(rows.map(value => JSON.stringify(value)).join('\n') + '\n'))
    : Buffer.concat(rows.map(value => zstdCompressSync(Buffer.from(JSON.stringify(value) + '\n'))));
  await writeFile(file, torn ? Buffer.concat([bytes, zstdCompressSync(Buffer.from('incomplete')).subarray(0, 6)]) : bytes);
  await utimes(file, new Date(mtime), new Date(mtime));
  return file;
}
const collector = (root, extra = {}) => createDeepSeekAgentCollector({ root, sourceId: 'test-local-dsh', ...extra });
const agent = (result, id = CHILD) => result.agents.find(value => value.identity.native_agent_id === id);
const detail = (result, id = CHILD) => result.details.get(agent(result, id).agent_id);
function valid(result, sessions = [session()]) {
  const snapshot = { schema_version: SCHEMA, kind: 'snapshot', stream_id: 'test', revision: 0, projects: [],
    sessions: sessions.map(value => ({ session_id: value.session_id, project_id: null, name: 'Test', agents_coverage: result.coverage[value.session_id] })), agents: result.agents };
  assertSnapshot(snapshot);
  for (const value of result.agents) {
    const resource = result.details.get(value.agent_id);
    const scope = { kind: 'agent', session_id: value.identity.session_id, agent_id: value.agent_id };
    assertAgentDetail({ schema_version: SCHEMA, kind: 'agent_detail', stream_id: 'test', revision: 0,
      agent_id: value.agent_id, conversation: { ...resource.conversation, items: resource.conversation.items.slice(0, 200), next_cursor: null },
      workflow: { ...resource.workflow, items: resource.workflow.items.slice(0, 200), next_cursor: null }, workflow_graph: resource.workflow_graph }, snapshot, scope);
  }
}
async function pair(root, child = checkpoint(CHILD)) {
  await saveCheckpoint(root, ROOT, checkpoint(ROOT, [entry()]));
  await saveCheckpoint(root, CHILD, child);
}

test('parent-owned v6 catalogs preserve canonical identity, nested links, and native team metadata', async t => {
  const root = await fixture(t);
  const primary = checkpoint(ROOT, [entry()], { agentTeam: row(4, { id: ROOT, members: [
    { id: CHILD, name: 'Team reviewer', description: 'PRIVATE', provider: 'deepseek', context: 'fresh', phase: 'active' },
    { id: 'orphan', name: 'Unproven parent', provider: 'deepseek', phase: 'active' },
  ] }) });
  await saveCheckpoint(root, ROOT, primary);
  await saveCheckpoint(root, CHILD, checkpoint(CHILD, [entry(NESTED)]));
  await saveCheckpoint(root, NESTED);
  await saveCheckpoint(root, 'orphan');
  const result = await collector(root).collect([session()], NOW);
  valid(result);
  assert.equal(result.agents.length, 3);
  assert.equal(agent(result).name, 'Team reviewer');
  assert.equal(agent(result).provider_id, 'deepseek');
  assert.equal(agent(result).parent_agent_id, agent(result, ROOT).agent_id);
  assert.equal(agent(result, NESTED).parent_agent_id, agent(result).agent_id);
  assert.ok(result.agents.every(value => value.identity.session_id === session().session_id && value.avatar === null));
  assert.equal(agent(result).identity.generation, String(NOW - 900));
  assert.equal(result.coverage[session().session_id], 'partial');
  assert.ok(!JSON.stringify(result.agents).includes('PRIVATE'));
});

test('decodes every independent zstd frame and exposes only append-origin own visible messages', async t => {
  const root = await fixture(t);
  const child = checkpoint(CHILD);
  child.record.identity.isSeeded = true;
  child.record.identity.inheritedEventCount = 2;
  child.record.rows.subagent.val.identity.seq = 3;
  child.record.rows.subagentCatalog.val.inheritedEventCount = 2;
  await pair(root, child);
  await log(root, CHILD, [
    message(0, 'user', 'PRIVATE inherited prompt'), message(1, 'assistant', 'PRIVATE ancestor'),
    event(2, 'session/end-seed', { inherited: true }), descriptor(3), event(4, 'turn/start'),
    message(5, 'user', 'Review this change'), message(6, 'assistant', 'Ready', { content: [
      { type: 'reasoning', text: 'PRIVATE thought' }, { type: 'text', text: 'Ready' },
      { type: 'tool-call', id: 'call-1', name: 'read_file', arguments: 'PRIVATE args' },
    ] }),
    event(7, 'tool/call', { callId: 'call-1', args: 'PRIVATE args' }),
    event(8, 'tool/result', { message: { source: { kind: 'tool', callId: 'call-1' }, content: [{ type: 'text', text: 'PRIVATE result' }] } }, { surfaceOp: 'append' }),
    { ...message(9, 'assistant', 'PRIVATE replacement'), surfaceOp: { op: 'replace', startSeq: 5, endSeq: 6 } },
    message(10, 'user', 'PRIVATE internal context', { source: { kind: 'hook' } }),
    event(11, 'developer/message', { message: { content: [{ type: 'text', text: 'PRIVATE policy' }] } }),
    event(12, 'assistant/attempt', { stream: [{ text: 'PRIVATE stream' }] }),
    event(13, 'turn/end', { reason: { kind: 'completed' } }),
  ], { header: { isSeeded: true } });
  const result = await collector(root).collect([session()], NOW);
  valid(result);
  assert.deepEqual(detail(result).conversation.items.map(value => value.text), ['Review this change', 'Ready']);
  assert.equal(detail(result).conversation.availability, 'available');
  assert.deepEqual(detail(result).workflow.items.map(value => value.stage), ['turn.start', 'tool.start', 'tool.complete', 'turn.complete']);
  assert.equal(detail(result).workflow.items[1].label, 'read_file');
  assert.deepEqual(detail(result).execution.events.map(event => [event.kind, event.call_id]), [['call.start', 'call-1'], ['call.end', 'call-1']]);
  assert.equal(detail(result).workflow_graph.availability, 'unsupported');
  assert.ok(!JSON.stringify([...result.details.values()]).includes('PRIVATE'));
});

test('turn completion is not continuable agent completion, and stale working state becomes unknown', async t => {
  const root = await fixture(t);
  const child = checkpoint(CHILD, [], { turnBoundary: row(2, { openTurnStartSeq: 1 }) });
  await pair(root, child);
  const read = collector(root);
  assert.equal(agent(await read.collect([session()], NOW)).status, 'working');
  assert.equal(agent(await read.collect([session()], NOW + 60_000)).status, 'unknown');
  child.record.rows.turnBoundary.val.openTurnStartSeq = null;
  child.record.rows.subagentTiming.val.lastTurnCompleted = true;
  await saveCheckpoint(root, CHILD, child, NOW + 60_000);
  const finished = agent(await read.collect([session()], NOW + 60_000));
  assert.equal(finished.status, 'idle');
  assert.equal(finished.lifecycle, 'active');
  child.record.rows.subagent.val.identity.mode = 'one-shot';
  await saveCheckpoint(root, ROOT, checkpoint(ROOT, [entry(CHILD, { mode: 'one-shot' })]), NOW + 60_000);
  await saveCheckpoint(root, CHILD, child, NOW + 60_001);
  assert.equal(agent(await read.collect([session()], NOW + 60_001)).lifecycle, 'completed');
});

test('unknown schema versions and seed boundaries cannot expose dialogue', async t => {
  const root = await fixture(t);
  await pair(root);
  await log(root, CHILD, [descriptor(), message(1, 'assistant', 'PRIVATE wrong generation')], { header: { version: 5 } });
  const read = collector(root);
  assert.equal(detail(await read.collect([session()], NOW)).conversation.availability, 'unknown');
  const seeded = checkpoint(CHILD);
  seeded.record.identity.isSeeded = true;
  seeded.record.identity.inheritedEventCount = 2;
  seeded.record.rows.subagent.val.identity.seq = 3;
  await saveCheckpoint(root, CHILD, seeded, NOW + 1);
  await log(root, CHILD, [message(0, 'user', 'PRIVATE inherited'), descriptor(1), message(2, 'assistant', 'PRIVATE uncertain')], { header: { isSeeded: true }, mtime: NOW + 1 });
  assert.equal(detail(await read.collect([session()], NOW + 1)).conversation.items.length, 0);
  const future = checkpoint(ROOT, [entry()]); future.version = 8;
  await saveCheckpoint(root, ROOT, future, NOW + 2);
  const result = await read.collect([session()], NOW + 2);
  assert.equal(result.agents.length, 0);
  assert.equal(result.coverage[session().session_id], 'unsupported');
});

test('reused child ids and mismatched transcript parent/cwd do not cross session boundaries', async t => {
  const root = await fixture(t);
  const child = checkpoint(CHILD); child.record.identity.createdAt++;
  await pair(root, child);
  const read = collector(root);
  assert.equal(agent(await read.collect([session()], NOW)), undefined);
  await saveCheckpoint(root, CHILD, checkpoint(CHILD), NOW + 1);
  await log(root, CHILD, [descriptor(), message(1, 'assistant', 'PRIVATE other parent')], { header: { parentSession: 'other' } });
  assert.equal(detail(await read.collect([session()], NOW + 1)).conversation.items.length, 0);
  await log(root, CHILD, [descriptor(), message(1, 'assistant', 'PRIVATE other directory')], { header: { cwd: '/elsewhere' }, mtime: NOW + 2 });
  assert.equal(detail(await read.collect([session()], NOW + 2)).conversation.items.length, 0);
});

test('cycles and multiple claimed parents are blocked without attaching orphans', async t => {
  const root = await fixture(t);
  await saveCheckpoint(root, ROOT, checkpoint(ROOT, [entry(), entry(NESTED)]));
  await saveCheckpoint(root, CHILD, checkpoint(CHILD, [entry(NESTED)]));
  await saveCheckpoint(root, NESTED, checkpoint(NESTED, [entry(ROOT, { childCreatedAt: NOW - 1000 })]));
  await saveCheckpoint(root, 'orphan');
  const result = await collector(root).collect([session()], NOW);
  valid(result);
  assert.deepEqual(result.agents.map(value => value.identity.native_agent_id), [ROOT, CHILD]);
});

test('unknown/external catalog entries retain explicit identity without inventing local dialogue', async t => {
  const root = await fixture(t);
  await saveCheckpoint(root, ROOT, checkpoint(ROOT, [entry('external-worker', { version: 2, mode: 'external' }), entry('unknown-worker', { version: 1, mode: 'unknown' })]));
  const result = await collector(root).collect([session()], NOW);
  valid(result);
  assert.equal(result.agents.length, 3);
  assert.equal(detail(result, 'external-worker').conversation.availability, 'unsupported');
  assert.equal(agent(result, 'unknown-worker').status, 'unknown');
});

test('retention, file-count and decoded-byte limits preserve bounded partial metadata', async t => {
  const root = await fixture(t);
  await pair(root);
  assert.equal((await collector(root, { maxFiles: 1 }).collect([session()], NOW)).agents.length, 1);
  assert.equal((await collector(root, { windowMs: 10 }).collect([session()], NOW + 20)).agents.length, 0);
  await log(root, CHILD, [descriptor(), message(1, 'assistant', 'x'.repeat(100_000))], { singleFrame: true });
  const limited = await collector(root, { maxBytes: 2048 }).collect([session()], NOW);
  assert.equal(limited.agents.length, 2);
  assert.equal(detail(limited).conversation.availability, 'unknown');
});

test('torn appends report an empty unknown resource and recover after a complete write', async t => {
  const root = await fixture(t);
  await pair(root);
  await log(root, CHILD, [descriptor(), message(1, 'assistant', 'Visible prefix')], { torn: true });
  const read = collector(root);
  const result = await read.collect([session()], NOW);
  valid(result);
  assert.deepEqual(detail(result).conversation.items, []);
  assert.equal(detail(result).conversation.availability, 'unknown');
  await log(root, CHILD, [descriptor(), message(1, 'assistant', 'Visible prefix')], { mtime: NOW + 1 });
  const repaired = await read.collect([session()], NOW + 1);
  valid(repaired);
  assert.deepEqual(detail(repaired).conversation.items.map(value => value.text), ['Visible prefix']);
});

test('transient checkpoint writes retain uncertain cached metadata, then recover and remove departed members', async t => {
  const root = await fixture(t);
  await pair(root);
  await log(root, CHILD, [descriptor(), message(1, 'assistant', 'Visible')]);
  const read = collector(root);
  const first = await read.collect([session()], NOW);
  first.agents[1].name = 'caller mutation';
  await saveCheckpoint(root, CHILD, '{', NOW + 1);
  const partial = await read.collect([session()], NOW + 1);
  valid(partial);
  assert.equal(agent(partial).status, 'unknown');
  assert.equal(agent(partial).name, 'Reviewer');
  assert.equal(detail(partial).conversation.availability, 'unknown');
  await saveCheckpoint(root, CHILD, checkpoint(CHILD), NOW + 2);
  assert.equal(detail(await read.collect([session()], NOW + 2)).conversation.availability, 'available');
  await saveCheckpoint(root, ROOT, checkpoint(ROOT), NOW + 3);
  assert.equal((await read.collect([session()], NOW + 3)).agents.length, 1);
  assert.equal((await read.collect([], NOW + 3)).agents.length, 0);
});

test('cached transcripts never follow reused identity generations', async t => {
  const root = await fixture(t);
  await pair(root);
  await log(root, CHILD, [descriptor(), message(1, 'assistant', 'PRIVATE previous incarnation')]);
  const read = collector(root);
  const before = await read.collect([session()], NOW);
  const child = checkpoint(CHILD); child.record.identity.createdAt = NOW;
  await saveCheckpoint(root, ROOT, checkpoint(ROOT, [entry(CHILD, { childCreatedAt: NOW })]), NOW + 1);
  await saveCheckpoint(root, CHILD, child, NOW + 1);
  const after = await read.collect([session()], NOW + 1);
  assert.notEqual(agent(before).agent_id, agent(after).agent_id);
  assert.equal(detail(after).conversation.items.length, 0);
});

test('only local canonical DSH sessions are eligible, with source-scoped stable ids', async t => {
  const root = await fixture(t);
  await pair(root);
  for (const extra of [{ origin: 'remote' }, { session_type: 'Codex' }, { project_path: '/other' }, { session_id: 'dsh-../escape__Project' }]) {
    const result = await collector(root).collect([session(extra)], NOW);
    assert.equal(result.agents.length, 0);
  }
  const a = await collector(root).collect([session({ session_type: 'dsh' })], NOW);
  const b = await collector(root, { sourceId: 'another-host' }).collect([session()], NOW);
  assert.notEqual(agent(a).agent_id, agent(b).agent_id);
});

test('symlinked checkpoints and log directories are not followed', async t => {
  const root = await fixture(t);
  await pair(root);
  const original = await saveCheckpoint(root, 'copy', checkpoint(CHILD));
  const childPath = join(root, 'storages/session_projcache/sessions', `${CHILD}.json`);
  await rm(childPath); await symlink(original, childPath);
  const result = await collector(root).collect([session()], NOW);
  assert.equal(agent(result).status, 'unknown');
  assert.equal(detail(result).conversation.items.length, 0);
  await rm(childPath); await saveCheckpoint(root, CHILD);
  const outside = await fixture(t);
  await log(outside, CHILD, [descriptor(), message(1, 'assistant', 'PRIVATE linked log')]);
  await symlink(join(outside, 'sessions'), join(root, 'sessions'));
  const linked = await collector(root).collect([session()], NOW);
  assert.equal(detail(linked).conversation.items.length, 0);
});

test('message retention and long text limits are explicit', async t => {
  const root = await fixture(t);
  await pair(root);
  await log(root, CHILD, [descriptor(), ...Array.from({ length: 502 }, (_, i) => message(i + 1, 'assistant', i === 501 ? 'x'.repeat(17_000) : `Reply ${i}`))], { singleFrame: true });
  const result = await collector(root).collect([session()], NOW);
  assert.equal(detail(result).conversation.items.length, 500);
  assert.equal(detail(result).conversation.truncated_before, true);
  assert.equal(detail(result).conversation.items.at(-1).text.length, 16000);
  assert.equal(detail(result).conversation.items.at(-1).content_state, 'truncated');
});

test('chunked catalogs preserve previous chunks and refuse an unverified catalog schema', async t => {
  const root = await fixture(t);
  const primary = checkpoint(ROOT);
  primary.record.rows.subagentCatalog.val.head = { values: [entry(NESTED)], previous: { values: [entry()] } };
  await saveCheckpoint(root, ROOT, primary); await saveCheckpoint(root, CHILD); await saveCheckpoint(root, NESTED);
  const read = collector(root);
  assert.equal((await read.collect([session()], NOW)).agents.length, 3);
  primary.record.rows.subagentCatalog.ver = 7;
  await saveCheckpoint(root, ROOT, primary, NOW + 1);
  const unknown = await read.collect([session()], NOW + 1);
  assert.equal(unknown.agents.length, 1);
  assert.equal(unknown.coverage[session().session_id], 'partial');
});

test('deleted checkpoints and transcripts are evicted immediately, without cached content resurrection', async t => {
  const root = await fixture(t);
  await pair(root);
  const file = await log(root, CHILD, [descriptor(), message(1, 'assistant', 'PRIVATE deleted log')]);
  const read = collector(root);
  assert.equal(detail(await read.collect([session()], NOW)).conversation.items.length, 1);
  await rm(file);
  const removedLog = await read.collect([session()], NOW + 1);
  valid(removedLog);
  assert.equal(detail(removedLog).conversation.items.length, 0);
  await rm(join(root, 'storages/session_projcache/sessions', `${CHILD}.json`));
  const removedChild = await read.collect([session()], NOW + 2);
  valid(removedChild);
  assert.equal(agent(removedChild).status, 'unknown', 'parent catalog still proves a child identity');
  assert.equal(detail(removedChild).conversation.items.length, 0);
  await rm(join(root, 'storages/session_projcache/sessions', `${ROOT}.json`));
  const removedRoot = await read.collect([session()], NOW + 3);
  valid(removedRoot);
  assert.equal(removedRoot.agents.length, 0);
});

test('missing and malformed turn boundaries never imply idle', async t => {
  const root = await fixture(t);
  for (const value of [{}, { openTurnStartSeq: 'running' }, { openTurnStartSeq: -1 }]) {
    await pair(root, checkpoint(CHILD, [], { turnBoundary: row(2, value) }));
    const result = await collector(root).collect([session()], NOW);
    valid(result);
    assert.equal(agent(result).status, 'unknown');
  }
});
