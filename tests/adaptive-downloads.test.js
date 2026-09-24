// Regression definitions only. User performs execution/functional verification.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const queue = require('../download-queue.js');
const progress = require('../download-progress.js');
const MiB = 1048576;
const good = { status: 'queued', bytes: MiB, width: 512, height: 512, retrievalAttempts: 1 };

test('Auto probes above twelve when throughput grows and backs off once per congestion window', () => {
  let time = 0;
  const c = queue.createController({ now: () => time, memoryBudgetBytes: 512 * MiB });
  assert.equal(c.snapshot().concurrency, 8);
  for (let round = 0; round < 2; round++) {
    const active = c.snapshot().concurrency;
    for (let i = 0; i < active; i++) c.observe(good, 800);
    time += 4000;
    c.sample({ active, pending: 1000 });
  }
  const before = c.snapshot().concurrency;
  assert.ok(before > 12);
  c.congest('429', time + 3000);
  const decreased = c.snapshot().concurrency;
  assert.ok(decreased < before);
  c.congest('another 429', time + 3000);
  assert.equal(c.snapshot().concurrency, decreased);
  assert.equal(c.snapshot().coolingDown, true);
  time += 3000;
  assert.equal(c.snapshot().coolingDown, false);
});

test('latency inflation without useful throughput gain reduces Auto concurrency', () => {
  let time = 0;
  const c = queue.createController({ now: () => time });
  for (let i = 0; i < 8; i++) c.observe(good, 800);
  time = 4000;
  c.sample({ active: 8, pending: 1000 });
  const before = c.snapshot().concurrency;
  for (let i = 0; i < 8; i++) c.observe(good, 2200);
  time = 8000;
  c.sample({ active: before, pending: 1000 });
  assert.ok(c.snapshot().concurrency < before);
  assert.match(c.snapshot().reason, /Latency/);
});

test('large image working-set estimates lower the Auto admission ceiling', () => {
  const c = queue.createController({ memoryBudgetBytes: 128 * MiB });
  c.observe({ ...good, bytes: 40 * MiB, width: 4000, height: 4000 }, 1000);
  assert.equal(c.snapshot().concurrency, 1);
  assert.equal(c.snapshot().memoryLimit, 1);
});

test('manual limits remain fixed while server cooldown still applies', () => {
  let time = 0;
  const c = queue.createController({ concurrency: 12, now: () => time });
  c.congest('429', time + 2000);
  assert.equal(c.snapshot().concurrency, 12);
  assert.equal(c.snapshot().coolingDown, true);
  time = 2000;
  assert.equal(c.snapshot().coolingDown, false);
});

test('rate meter uses recent response bytes and suppresses ETA when completions stall', () => {
  let time = 0;
  const meter = progress.createMeter({ now: () => time });
  meter.transfer(8 * MiB);
  time = 2000;
  meter.transfer(8 * MiB); meter.complete(4);
  assert.equal(meter.snapshot(12).speed, 8 * MiB);
  assert.equal(meter.snapshot(12).etaMs, 4000);
  time = 14000;
  assert.equal(meter.snapshot(12).speed, 0);
  assert.equal(meter.snapshot(12).etaMs, null);
  meter.stop(); time += 10000;
  assert.equal(meter.snapshot(12).elapsedMs, 14000);
});

test('elapsed formatting handles minute/hour ranges and unavailable estimates', () => {
  assert.equal(progress.duration(65000), '01:05');
  assert.equal(progress.duration(3665000), '1:01:05');
  assert.equal(progress.duration(Infinity), '—');
});
