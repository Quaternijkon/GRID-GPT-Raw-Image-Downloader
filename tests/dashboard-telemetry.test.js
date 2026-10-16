const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createDisplayTelemetry } = require('../download-progress.js');

test('dashboard uses wall-clock samples and only estimates ETA after enough completed work', () => {
  let time = 0;
  const monitor = createDisplayTelemetry({ now: () => time });
  assert.equal(monitor.observe({ stage: 'collecting', completed: 0 }), null);
  let view = monitor.observe({ stage: 'images', bytes: 0, completed: 0, total: 12,
    phase: 'transferring' });
  assert.equal(view.etaMs, null);
  for (let count = 1; count <= 5; count++) {
    time += 3000;
    view = monitor.observe({ stage: 'images', bytes: count * 2 * 1048576,
      completed: count, total: 12, phase: 'transferring' });
  }
  assert.equal(view.samples.length, 16);
  assert.equal(view.remaining, 7);
  assert.equal(view.averageRate, 10 * 1048576 / 15);
  assert.ok(view.etaMs > 0);
  assert.equal(view.finishAt, time + view.etaMs);
  time += 1000;
  view = monitor.observe({ stage: 'images', bytes: 10 * 1048576, completed: 5,
    total: 12, phase: 'cooldown', retrying: 1 });
  assert.equal(view.etaMs, null);
  time += 16000;
  view = monitor.observe({ stage: 'images', bytes: 10 * 1048576, completed: 5,
    total: 12, phase: 'transferring' });
  assert.equal(view.etaMs, null, 'stalled work must not retain a stale finish time');
  time += 90000;
  view = monitor.observe({ stage: 'images', bytes: 10 * 1048576, completed: 5,
    total: 12, phase: 'transferring' });
  assert.equal(view.samples.length, 60);
  assert.equal(view.currentRate, 0);
  assert.equal(view.peakRate, 0);
});

test('heatmap counts each completion once per second and keeps true idle cells', () => {
  let time = 0;
  const monitor = createDisplayTelemetry({ now: () => time });
  monitor.observe({ stage: 'images', bytes: 0, completed: 0 });
  time = 5000;
  let view = monitor.observe({ stage: 'images', bytes: 20 * 1048576, completed: 10 });
  assert.equal(view.currentRate, 4 * 1048576);
  assert.equal(view.itemRate, 2);
  assert.equal(view.itemSamples.length, 60);
  assert.equal(view.itemSamples.at(-1).rate, 10);
  assert.equal(view.itemSamples[0].observed, false);
  view = monitor.observe({ stage: 'images', bytes: 20 * 1048576, completed: 10 });
  assert.equal(view.itemSamples.at(-1).rate, 10, 'rendering again cannot count the same tasks twice');
  time = 5200;
  view = monitor.observe({ stage: 'images', bytes: 30 * 1048576, completed: 13 });
  assert.equal(view.itemSamples.at(-1).rate, 13);
  time = 10000;
  view = monitor.observe({ stage: 'images', bytes: 30 * 1048576, completed: 13 });
  assert.equal(view.currentRate, 0);
  assert.equal(view.itemRate, 0);
  assert.equal(view.itemSamples.at(-6).rate, 13);
  time = 70000;
  view = monitor.observe({ stage: 'images', bytes: 30 * 1048576, completed: 13 });
  assert.equal(view.itemSamples.filter(sample => sample.rate > 0).length, 0);
  assert.ok(view.itemSamples.every(sample => sample.observed));
});
