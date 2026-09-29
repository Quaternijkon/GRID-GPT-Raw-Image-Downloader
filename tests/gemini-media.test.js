const { test } = require('node:test');
const assert = require('node:assert/strict');
const gemini = require('../gemini-media.js');

const image = (chat, response, resource, seconds) => [
  [`c_${chat}`, `r_${response}`], [seconds, 0], 1, null,
  [null, `https://lh3.googleusercontent.com/gg/${'A'.repeat(50)}${resource}`],
  `rc_${resource}`, null, null, null, null, `stable-asset-${resource}`
];
const wrap = (rpc, value) => `)]}'\n\n${JSON.stringify([['wrb.fr', rpc, JSON.stringify(value), null, null, null, 'generic']])}\n`;

test('Gemini Library RPC paginates all images and assigns stable global numbers', async () => {
  const calls = [];
  const first = image('a'.repeat(16), '1'.repeat(16), 'f'.repeat(16), 200);
  const second = image('b'.repeat(16), '2'.repeat(16), 'e'.repeat(16), 100);
  const result = await gemini.collect(async (url, options) => {
    const args = JSON.parse(JSON.parse(new URLSearchParams(options.body).get('f.req'))[0][0][1]);
    calls.push({ host: new URL(url).host, token: new URLSearchParams(options.body).get('at'), cursor: args[2] });
    return { ok: true, text: async () => wrap('jGArJ', calls.length === 1 ? [[first], 'next'] : [[second], null]) };
  }, { token: 'test-token' });
  assert.deepEqual(calls.map(call => call.cursor), [null, 'next']);
  assert.ok(calls.every(call => call.host === 'gemini.google.com' && call.token === 'test-token'));
  assert.deepEqual(result.entries.map(entry => entry.id), [`rc_${'e'.repeat(16)}`, `rc_${'f'.repeat(16)}`]);
  assert.deepEqual(result.entries.map(entry => entry.sequence), [1, 2]);
  assert.equal(result.pagination.complete, true);
});

test('Gemini prompt extraction matches the exact response in its own conversation', async () => {
  const entry = gemini.parseEntry(image('a'.repeat(16), '1'.repeat(16), 'f'.repeat(16), 200));
  const other = gemini.parseEntry(image('a'.repeat(16), '2'.repeat(16), 'e'.repeat(16), 201));
  const fetchImpl = async (_url, options) => {
    const args = JSON.parse(JSON.parse(new URLSearchParams(options.body).get('f.req'))[0][0][1]);
    assert.equal(args[0], `c_${'a'.repeat(16)}`);
    return { ok: true, text: async () => wrap('hNvQHb', [[
      [null, [null, `r_${'1'.repeat(16)}`], [['First prompt']], null, null],
      [null, [null, `r_${'2'.repeat(16)}`], [['Second prompt']], null, null]
    ], null, null, []]) };
  };
  const result = await gemini.resolvePrompts(fetchImpl, [entry, other], { token: 'test-token' });
  assert.equal(result.resolved, 2);
  assert.deepEqual([entry.prompt, other.prompt], ['First prompt', 'Second prompt']);
});

test('Gemini rejects external media hosts and incomplete pagination', async () => {
  assert.equal(gemini.supported('/images'), false);
  assert.equal(gemini.imageUrl('https://evil.example/gg/' + 'A'.repeat(50)), null);
  assert.equal(gemini.imageUrl('https://lh3.googleusercontent.com/gg/' + 'A'.repeat(50) + '=w320'), null);
  await assert.rejects(gemini.collect(async () => ({ ok: true,
    text: async () => wrap('jGArJ', [[], 'cursor']) }), { token: 'test-token' }), /分页游标/);
});

test('Gemini automatically merges refreshed URLs for the same asset without losing its original sequence', async () => {
  const older = image('a'.repeat(16), '1'.repeat(16), 'f'.repeat(16), 100);
  const refreshed = image('a'.repeat(16), '1'.repeat(16), 'f'.repeat(16), 106);
  refreshed[4][1] = `https://lh3.googleusercontent.com/gg/${'B'.repeat(66)}`;
  const pages = [[[older], 'next'], [[refreshed], null]];
  let call = 0;
  const result = await gemini.collect(async () => ({ ok: true, text: async () => wrap('jGArJ', pages[call++]) }),
    { token: 'test-token' });
  assert.equal(result.pagination.records, 2);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].id, `rc_${'f'.repeat(16)}`);
  assert.equal(result.entries[0].time, 100000);
  assert.equal(result.entries[0].url, refreshed[4][1]);
});

test('Gemini preserves distinct assets that share a resource ID and answer', async () => {
  const first = image('a'.repeat(16), '1'.repeat(16), 'f'.repeat(16), 100);
  const second = image('a'.repeat(16), '1'.repeat(16), 'f'.repeat(16), 106);
  second[4][1] = `https://lh3.googleusercontent.com/gg/${'B'.repeat(66)}`;
  second[10] = 'another-stable-asset-variant';
  const collect = async records => gemini.collect(async () => ({ ok: true,
    text: async () => wrap('jGArJ', [records, null]) }), { token: 'test-token' });
  const one = await collect([first, second]);
  const two = await collect([second, first]);
  assert.equal(one.entries.length, 2);
  assert.deepEqual(one.entries.map(entry => entry.id), two.entries.map(entry => entry.id));
  assert.ok(one.entries.every(entry => /^rc_[a-f0-9]{16}-[a-f0-9]{32}$/.test(entry.id)));
  assert.deepEqual(one.entries.map(entry => entry.sequence), [1, 2]);
});

test('Gemini waits and automatically resumes a temporarily empty list response', async () => {
  let calls = 0;
  const waits = [], notices = [];
  const result = await gemini.collect(async () => {
    calls++;
    return { ok: true, text: async () => calls < 3
      ? `)]}'\n\n${JSON.stringify([['wrb.fr', 'jGArJ', null]])}\n`
      : wrap('jGArJ', [[image('a'.repeat(16), '1'.repeat(16), 'f'.repeat(16), 100)], null]) };
  }, { token: 'test-token', delay: async ms => { waits.push(ms); },
    onProgress: update => { if (update.retry) notices.push(update.retry.attempt); } });
  assert.equal(calls, 3);
  assert.deepEqual(waits, [1000, 2000]);
  assert.deepEqual(notices, [1, 2]);
  assert.equal(result.entries.length, 1);
});
