const { test } = require('node:test');
const assert = require('node:assert/strict');
const lists = require('../image-lists.js');
const path = '/backend-api/my/recent/image_gen?limit=100';
const rows = (start, count) => Array.from({ length: count }, (_, i) => ({ id: `file_${start + i}`, title: `image ${start + i}` }));
const options = { wait: async () => {} };

test('observed items/cursor shape paginates past 2,000 with opaque cursor encoding intact', async () => {
  let pages = 0;
  const cursors = Array.from({ length: 21 }, (_, i) => `opaque ${i}+/=${'x'.repeat(530)}`);
  const result = await lists.collect(async url => {
    const cursor = new URL(url).searchParams.get('after');
    assert.equal(cursor, pages ? cursors[pages - 1] : null);
    const start = pages++ * 100;
    return Response.json({ items: rows(start, Math.min(100, 2137 - start)), cursor: cursors[pages - 1] || null });
  }, path, options);
  assert.equal(result.items.length, 2137);
  assert.equal(result._pagination.pages, 22);
  assert.equal(result._pagination.complete, true);
});

test('a short intermediate page with a cursor is not mistaken for the last page', async () => {
  let page = 0;
  const result = await lists.collect(async () => Response.json(++page === 1
    ? { items: rows(0, 37), cursor: 'more' } : { items: rows(37, 100), cursor: null }), path, options);
  assert.equal(result.items.length, 137);
  assert.equal(result._pagination.complete, true);
});

test('a full last page with null cursor completes without re-requesting page one', async () => {
  let requests = 0;
  const result = await lists.collect(async () => { requests++; return Response.json({ items: rows(0, 100), cursor: null }); }, path, options);
  assert.equal(requests, 1);
  assert.equal(result._pagination.complete, true);
});

test('overlapping pages deduplicate IDs and retain refreshed records', async () => {
  let page = 0;
  const result = await lists.collect(async () => Response.json(++page === 1
    ? { items: rows(0, 100), cursor: 'more' }
    : { items: rows(90, 100).map(r => ({ ...r, title: 'refreshed' })), cursor: null }), path, options);
  assert.equal(result.items.length, 190);
  assert.equal(result._pagination.received, 200);
  assert.equal(result.items[90].title, 'refreshed');
});

test('middle-page failure preserves earlier images and records incomplete collection', async () => {
  let requests = 0;
  const result = await lists.collect(async () => ++requests === 1
    ? Response.json({ items: rows(0, 100), cursor: 'next' }) : new Response('', { status: 503 }), path, { ...options, maxRetries: 2 });
  assert.equal(requests, 4);
  assert.equal(result.items.length, 100);
  assert.equal(result._pagination.complete, false);
  assert.equal(result._pagination.retries, 2);
  assert.match(result._pagination.errors[0].message, /503/);
});

test('429 retries the same cursor with Retry-After before continuing', async () => {
  const waits = [];
  const urls = [];
  const result = await lists.collect(async url => {
    urls.push(url);
    return urls.length === 1 ? new Response('', { status: 429, headers: { 'retry-after': '2' } })
      : Response.json({ items: rows(0, 100), cursor: null });
  }, path, { wait: async ms => waits.push(ms) });
  assert.equal(urls[0], urls[1]);
  assert.deepEqual(waits, [2000]);
  assert.equal(result._pagination.complete, true);
});

test('repeated cursors stop with an explicit incomplete result', async () => {
  let requests = 0;
  const result = await lists.collect(async () => Response.json({ items: rows(requests++ * 100, 100), cursor: 'same' }), path, options);
  assert.equal(requests, 2);
  assert.equal(result.items.length, 200);
  assert.equal(result._pagination.complete, false);
  assert.equal(result._pagination.stopReason, 'repeated_cursor');
});

test('ignored pagination that returns the same page under new cursors cannot loop', async () => {
  let requests = 0;
  const result = await lists.collect(async () => Response.json({ items: rows(0, 100), cursor: `token-${requests++}` }), path, options);
  assert.equal(requests, 2);
  assert.equal(result.items.length, 100);
  assert.equal(result._pagination.stopReason, 'repeated_page');
});

test('missing continuation on a full cursor page is partial, not a silent 100-image success', async () => {
  const result = await lists.collect(async () => Response.json({ items: rows(0, 100) }), path, options);
  assert.equal(result.items.length, 100);
  assert.equal(result._pagination.complete, false);
  assert.equal(result._pagination.stopReason, 'missing_cursor');
});

test('malformed response and terminal HTTP errors do not look like empty completed lists', async () => {
  const malformed = await lists.collect(async () => Response.json({ unexpected: [] }), path, options);
  assert.equal(malformed._pagination.complete, false);
  const forbidden = await lists.collect(async () => new Response('', { status: 422 }), path, options);
  assert.equal(forbidden._pagination.complete, false);
  assert.equal(forbidden._pagination.retries, 0);
  assert.match(forbidden._pagination.errors[0].message, /422/);
});

test('offset pagination survives a server page cap below the requested limit', async () => {
  const offsets = [];
  const result = await lists.collect(async url => {
    const parsed = new URL(url);
    const offset = Number(parsed.searchParams.get('offset') || 0);
    assert.equal(parsed.searchParams.get('parent_directory_id'), 'folder');
    assert.equal(parsed.searchParams.get('categories'), 'image');
    offsets.push(offset);
    return Response.json({ nodes: rows(offset, Math.min(25, 137 - offset)) });
  }, '/backend-api/files/library/nodes?parent_directory_id=folder&categories=image&limit=100', { ...options, mode: 'offset' });
  assert.deepEqual(offsets, [0, 25, 50, 75, 100, 125, 137]);
  assert.equal(result.items.length, 137);
  assert.equal(result._pagination.complete, true);
});

test('null totals cannot silently terminate a nonempty cursor chain', async () => {
  let page = 0;
  const result = await lists.collect(async () => Response.json({ items: rows(page++ * 100, 100), total: null, cursor: page === 1 ? 'next' : null }), path, options);
  assert.equal(result.items.length, 200);
  assert.equal(result._pagination.complete, true);
});

test('navigation aborts page requests rather than mixing view contexts', async () => {
  let requests = 0;
  await assert.rejects(lists.collect(async () => {
    requests++; return Response.json({ items: rows(0, 100), cursor: 'next' });
  }, path, { ...options, checkActive: () => { if (requests) throw new Error('Page changed'); } }), /Page changed/);
  assert.equal(requests, 1);
});

test('DOM supplement retains over 2,000 virtualized images across more than 25 passes', async () => {
  let page = 0;
  const result = await lists.collectDom({
    ...options,
    snapshot: () => rows(page * 20, 20).map(r => ({ fileId: r.id })),
    scroll: () => {
      const atBottom = page === 100;
      if (!atBottom) page++;
      return { atBottom, extent: '5000' };
    }
  });
  assert.equal(result.entries.length, 2020);
  assert.ok(result.passes > 100);
  assert.equal(result.stopReason, 'dom_stable_best_effort');
  assert.equal(result.exhausted, false, 'DOM stabilization cannot certify completeness');
});

test('DOM does not settle during transient idle passes before more images load', async () => {
  let pass = 0;
  const result = await lists.collectDom({
    ...options,
    snapshot: () => rows(0, pass < 6 ? 20 : 40).map(r => ({ fileId: r.id })),
    scroll: () => { pass++; return { atBottom: true, extent: '5000' }; }
  });
  assert.equal(result.entries.length, 40);
});


test('native image endpoint ignores cursor but advances with after', async () => {
  let calls = 0;
  const result = await lists.collect(async url => {
    const after = new URL(url).searchParams.get('after');
    const offset = after === 'second-page' ? 100 : 0;
    calls++;
    return Response.json({ items: rows(offset, 100), cursor: offset ? null : 'second-page' });
  }, path, options);
  assert.equal(result.items.length, 200);
  assert.equal(result._pagination.complete, true);
  assert.equal(result._pagination.continuationParameter, 'after');
  assert.equal(calls, 2);
});

test('empty DOM fallback stops promptly even if a container never reaches bottom', async () => {
  const result = await lists.collectDom({ ...options, snapshot: () => [],
    scroll: () => ({ atBottom: false, extent: '1000', position: '0' }) });
  assert.ok(result.passes <= 6);
  assert.equal(result.stopReason, 'no_image_candidates');
});

test('non-scrollable stalled containers cannot force 2,000 fallback passes', async () => {
  const result = await lists.collectDom({ ...options,
    snapshot: () => [{ fileId: 'file_first' }],
    scroll: () => ({ atBottom: false, extent: '1000', position: '0' }) });
  assert.ok(result.passes <= 10);
  assert.equal(result.stopReason, 'dom_stalled');
});

test('continuously changing layouts are still bounded by elapsed fallback time', async () => {
  let now = 0;
  const result = await lists.collectDom({
    now: () => now, maxDurationMs: 1500,
    wait: async ms => { now += ms; },
    snapshot: () => [{ fileId: `file_${now}` }],
    scroll: () => ({ atBottom: false, extent: String(now), position: String(now) })
  });
  assert.ok(result.passes <= 5);
  assert.equal(result.stopReason, 'time_limit');
});
