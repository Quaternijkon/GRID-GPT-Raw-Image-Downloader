// Regression definitions only; execution is left to the user.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const queue = require('../download-queue.js');
const tick = () => new Promise(setImmediate);

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

test('worker pool overlaps tasks without exceeding the configured bound', async () => {
  const gates = Array.from({ length: 5 }, deferred);
  const started = [];
  let snapshot;
  const work = queue.run([0, 1, 2, 3, 4], async i => {
    started.push(i);
    await gates[i].promise;
    return `image-${i}`;
  }, { concurrency: 2, onProgress: p => { snapshot = p; } });
  await tick();
  assert.deepEqual(started, [0, 1]);
  assert.equal(snapshot.active, 2);
  gates[1].resolve();
  await tick();
  assert.deepEqual(started, [0, 1, 2]);
  gates[2].resolve();
  await tick();
  assert.deepEqual(started, [0, 1, 2, 3]);
  gates[0].resolve(); gates[3].resolve(); gates[4].resolve();
  const results = await work;
  assert.deepEqual(results.map(r => r.value), ['image-0', 'image-1', 'image-2', 'image-3', 'image-4']);
  assert.equal(snapshot.peakActive, 2);
  assert.equal(snapshot.completed, 5);
  assert.equal(snapshot.active, 0);
});

test('one failed task does not stop the queue or reorder successful records', async () => {
  const results = await queue.run([0, 1, 2, 3], async i => {
    await tick();
    if (i === 1) throw new Error('one image failed');
    return i;
  }, { concurrency: 3 });
  assert.deepEqual(results.map(r => r.status), ['fulfilled', 'rejected', 'fulfilled', 'fulfilled']);
  assert.match(results[1].reason.message, /one image failed/);
  assert.equal(results[3].value, 3);
});

test('concurrency one is serial and empty queues do not invoke tasks', async () => {
  let active = 0, peak = 0;
  await queue.run([1, 2, 3], async () => {
    peak = Math.max(peak, ++active);
    await tick();
    active--;
  }, { concurrency: 1 });
  assert.equal(peak, 1);
  assert.deepEqual(await queue.run([], () => { throw new Error('must not run'); }), []);
});

test('concurrency preferences default to Auto and bound manual settings at twelve', () => {
  assert.equal(queue.normalizeConcurrency(undefined), 'auto');
  assert.equal(queue.normalizeConcurrency('bad'), 'auto');
  assert.equal(queue.normalizeConcurrency(0), 'auto');
  assert.equal(queue.normalizeConcurrency('8'), 8);
  assert.equal(queue.normalizeConcurrency(999), 12);
});

test('a failing progress renderer cannot abandon pending image tasks', async () => {
  const results = await queue.run([1, 2, 3], async i => i, {
    concurrency: 2, onProgress: () => { throw new Error('render failed'); }
  });
  assert.deepEqual(results.map(r => r.value), [1, 2, 3]);
});
