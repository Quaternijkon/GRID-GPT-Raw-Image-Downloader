// Stateless numbering regression definitions. Execution is left to the user.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const numbering = require('../image-numbering.js');
const originals = require('../original-images.js');
const list = items => ({ items, _pagination: { complete: true } });
const item = (id, created_at, title = id) => ({ id, created_at, title });
const signature = result => result.all.map(x => [x.fileId, x.sequence, x.name]);

test('oldest-first numbering is independent of API order and locale', () => {
  const rows = [item('file_z', '2026-01-01T00:00:00Z'), item('file_a', '2026-01-01T00:00:00Z'), item('file_new', '2026-02-01T00:00:00Z')];
  const first = numbering.plan(list(rows), originals);
  const second = numbering.plan(list([...rows].reverse()), originals);
  assert.deepEqual(signature(first), signature(second));
  assert.deepEqual(first.all.map(x => x.fileId), ['file_a', 'file_z', 'file_new']);
});

test('appending newer images preserves existing numbers and uses absolute incremental prefixes', () => {
  const old = [item('file_b', 1767225601), item('file_a', 1767225600)];
  const baseline = numbering.plan(list(old), originals);
  const next = numbering.plan(list([item('file_c', 1767225602), ...old]), originals, { after: 2 });
  assert.deepEqual(signature(next).slice(0, 2), signature(baseline));
  assert.equal(next.selected.length, 1);
  assert.equal(next.selected[0].sequence, 3);
  assert.equal(next.summary.boundary.fileId, 'file_b');
  assert.equal(originals.filename(next.selected[0].name, 'image/png', next.selected[0].sequence - 1, numbering.WIDTH), '000003-file_c.png');
});

test('timestamp units, timezones and sub-millisecond precision normalize consistently', () => {
  assert.equal(numbering.creationTime('2026-01-01T00:00:00Z'), numbering.creationTime(1767225600));
  assert.equal(numbering.creationTime(1767225600000), numbering.creationTime('2026-01-01T08:00:00+08:00'));
  assert.equal(numbering.creationTime('1767225600.123456'), numbering.creationTime('2026-01-01T00:00:00.123456Z'));
  const result = numbering.plan(list([
    item('file_a', '2026-01-01T00:00:00.000002Z'), item('file_z', '2026-01-01T00:00:00.000001Z')
  ]), originals);
  assert.equal(result.all[0].fileId, 'file_z');
  assert.equal(numbering.creationTime('2026-01-01T00:00:00'), null);
  assert.equal(numbering.creationTime('2026-02-30T00:00:00Z'), null);
  assert.equal(numbering.creationTime(0), null);
});

test('partial lists and missing/conflicting time or identity block numbering', () => {
  assert.throws(() => numbering.plan({ items: [], _pagination: { complete: false } }, originals), /Cannot assign/);
  assert.throws(() => numbering.plan(list([{ id: 'file_a' }]), originals), /lack reliable/);
  assert.throws(() => numbering.plan(list([{ title: 'no ID', created_at: 1767225600 }]), originals), /lack reliable/);
  assert.throws(() => numbering.plan(list([item('file_a', 1767225600), item('file_a', 1767225601)]), originals), /lack reliable/);
});

test('duplicate records are deduplicated and names do not depend on arrival order', () => {
  const rows = [item('file_a', 1767225600, 'Z title'), item('file_a', 1767225600, 'A title')];
  assert.deepEqual(signature(numbering.plan(list(rows), originals)), signature(numbering.plan(list([...rows].reverse()), originals)));
  assert.equal(numbering.plan(list(rows), originals).all.length, 1);
});

test('exclusive boundary supports none/all and rejects an impossible checkpoint', () => {
  const rows = list([item('file_a', 1767225600), item('file_b', 1767225601)]);
  assert.equal(numbering.plan(rows, originals, { after: 0 }).selected.length, 2);
  assert.equal(numbering.plan(rows, originals, { after: 2 }).selected.length, 0);
  assert.throws(() => numbering.plan(rows, originals, { after: 3 }), /exceeds/);
  assert.equal(numbering.parseBoundary('001600'), 1600);
  for (const invalid of ['-1', '2.5', '', '1e3', 'NaN', '1000000']) assert.throws(() => numbering.parseBoundary(invalid));
});
