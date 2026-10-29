import assert from 'node:assert/strict';
import test from 'node:test';
import { createSingleFlightTask } from '../dist/runtime/singleFlightTask.js';

test('simultaneous scheduled and manual refresh share one task and recover after failure', async () => {
  let count = 0;
  let release;
  const task = createSingleFlightTask(() => { count++; return new Promise((resolve, reject) => { release = count === 1 ? reject : resolve; }); });
  const first = task.run();
  const second = task.run();
  assert.equal(first, second);
  assert.equal(count, 1);
  release(new Error('fixture'));
  await assert.rejects(first, /fixture/);
  const third = task.run();
  assert.equal(count, 2);
  release();
  await third;
});
test('closing waits for active work and rejects new work without launching it', async () => {
  let release;
  let count = 0;
  const task = createSingleFlightTask(() => { count++; return new Promise(resolve => { release = resolve; }); });
  const active = task.run();
  let stopped = false;
  const close = task.close().then(() => { stopped = true; });
  await task.run();
  assert.equal(count, 1);
  assert.equal(stopped, false);
  release();
  await Promise.all([active, close]);
  assert.equal(stopped, true);
});
