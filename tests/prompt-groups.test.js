// Regression definitions only. Do not execute during this implementation task.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const groups = require('../prompt-groups.js');
const entries = count => Array.from({ length: count }, (_, i) => ({ fileId: `file_${i}`, sequence: i + 1 }));
const records = texts => texts.map((text, i) => ({ fileId: `file_${i}`, status: 'resolved', cumulativePrompt: text }));

test('normalization joins original segments before newline normalization and final trim', () => {
  assert.equal(groups.normalizePrompt('  Base \r\nline ', [{ text: ' Edit\rline  ' }]), 'Base \nline \n\n Edit\nline');
  assert.equal(groups.normalizePrompt('P', [' E ']), 'P\n\n E');
  assert.throws(() => groups.normalizePrompt('P', [null]), /original text/);
});

test('exact text reuse crosses conversations, preserving global queue order', () => {
  const input = entries(4).map((entry, i) => ({ ...entry, conversationId: `conversation_${i}` }));
  const result = groups.plan(input, records(['P', 'P\n\nE', 'P', 'p']));
  assert.deepEqual(result.all.map(x => x.groupNumber), [0, 1, 0, 2]);
  assert.deepEqual(result.selected.map(x => x.sequence), [1, 2, 3, 4]);
  assert.deepEqual(result.groups.map(x => x.groupName),
    ['P', 'P\n\nE', 'p'].map(text => groups.groupIdentity(text).groupName));
  assert.equal(result.groups[0].promptText, 'P\n');
  assert.equal(result.groups[1].promptText, 'P\n\nE\n');
  assert.equal(input[0].groupNumber, undefined);
});

test('incremental filtering follows full grouping and reuses old prompt groups', () => {
  const result = groups.plan(entries(5), records(['P', 'Q', 'P', 'P', 'R']), { afterSequence: 3 });
  assert.deepEqual(result.selected.map(x => [x.sequence, x.groupName]), [
    [4, groups.groupIdentity('P').groupName], [5, groups.groupIdentity('R').groupName]
  ]);
  assert.deepEqual(result.selectedGroups.map(x => x.groupNumber), [0, 2]);
  assert.equal(result.groupCount, 3);
  assert.equal(result.selectedGroupCount, 2);
  assert.equal(groups.plan(entries(5), records(['P', 'Q', 'P', 'P', 'R']), { afterSequence: 5 }).selectedGroupCount, 0);
});

test('whitespace inside segments and capitalization remain significant', () => {
  const result = groups.plan(entries(4), records(['a b', 'a  b', 'A b', 'a\n\nb']));
  assert.equal(result.groupCount, 4);
});

test('unknown, empty, duplicate and invalid prompts only isolate affected images', () => {
  const input = entries(2), valid = records(['P', 'Q']);
  for (const incomplete of [
    [valid[1]], records(['', 'Q']), [valid[0], ...valid],
    [{ ...valid[0], basePrompt: 'other' }, valid[1]], records([' P ', 'Q']),
    [{ ...valid[0], status: 'unresolved', error: { code: 'unknown_shape', message: 'Unsupported shape' } }, valid[1]]
  ]) {
    const result = groups.plan(input, incomplete);
    assert.equal(result.unresolvedCount, 1);
    assert.equal(result.all[0].groupName, '未解析');
    assert.equal(result.all[0].groupNumber, undefined);
    assert.ok(result.all[0].promptError.message);
    assert.equal(result.all[0].cumulativePrompt, null);
    assert.equal(result.all[1].groupName, groups.groupIdentity('Q').groupName);
    assert.equal(result.groups.length, 1);
    assert.equal(result.groups[0].text, 'Q');
  }
});

test('all-unknown or malformed prompt records keep image selection without any TXT groups', () => {
  for (const data of [[], null, [null, { fileId: 'unrelated', status: 'resolved', cumulativePrompt: 'P' }]]) {
    const result = groups.plan(entries(3), data, { afterSequence: 1 });
    assert.equal(result.unresolvedCount, 3);
    assert.equal(result.selectedUnresolvedCount, 2);
    assert.deepEqual(result.selected.map(x => x.sequence), [2, 3]);
    assert.deepEqual(result.selectedGroups, []);
  }
});

test('unknown history and selected unknowns preserve cutoff and resolved prompt reuse', () => {
  const input = records(['P', 'Q', 'P', 'Q']);
  input[1] = { fileId: 'file_1', status: 'unresolved', error: { code: 'http_error', message: 'HTTP 429' } };
  input[3] = { fileId: 'file_3', status: 'unresolved', error: { code: 'conversation_deferred', message: 'Deferred' } };
  const result = groups.plan(entries(4), input, { afterSequence: 2 });
  assert.deepEqual(result.selected.map(x => [x.sequence, x.groupName]),
    [[3, groups.groupIdentity('P').groupName], [4, '未解析']]);
  assert.equal(result.selectedUnresolvedCount, 1);
  assert.equal(result.selectedGroups.length, 1);
  assert.equal(result.all[1].promptError.code, 'http_error');
  assert.equal(result.all[3].promptError.code, 'conversation_deferred');
});

test('requires complete global order and valid exclusive boundaries', () => {
  assert.throws(() => groups.plan(entries(2).reverse(), records(['P', 'Q'])), /global order/);
  for (const afterSequence of [-1, 3, 0.5, '1']) assert.throws(() => groups.plan(entries(2), records(['P', 'Q']), { afterSequence }), /boundary/);
  assert.deepEqual(groups.plan([], []).groups, []);
});

test('folder identity is stable and independent of collection order or size', () => {
  const count = 10001;
  const result = groups.plan(entries(count), records(Array.from({ length: count }, (_, i) => `P${i}`)));
  assert.equal(result.groups[0].groupName, groups.groupIdentity('P0').groupName);
  assert.equal(result.groups[9999].groupName, groups.groupIdentity('P9999').groupName);
  assert.equal(result.groups[10000].groupName, groups.groupIdentity('P10000').groupName);
  assert.equal(groups.groupIdentity('P').groupName, groups.plan(entries(1), records(['P'])).groups[0].groupName);
});
