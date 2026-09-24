const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const images = require('../original-images.js');

const originalUrl = 'https://chatgpt.com/backend-api/estuary/content?id=file_abc123&sig=original';
const thumbnailUrl = 'https://chatgpt.com/backend-api/estuary/content?id=file_abc123%23thumbnail&sig=thumb';
const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAaX2RUAAAAAASUVORK5CYII=', 'base64');
const webpBytes = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEAAUAmJaQAA3AA/v89WAAAAA==', 'base64');
const imageResponse = (type = 'image/png') => new Response(type === 'image/webp' ? webpBytes : bytes, { headers: { 'content-type': type } });
const json = value => Response.json(value);
const missing = () => new Response('missing', { status: 404 });
const measure = async () => ({ width: 1536, height: 1024 });
const entry = () => images.fromItem({ url: thumbnailUrl, name: '测试图片.png' });

function client(fetchImpl) { return images.createClient({ fetchImpl, measure }); }

// Explicit session-auth regressions: definitions only; no execution in this change.
test('required authentication shares session lookup and sends bearer on every first backend request', async () => {
  const calls = [];
  const c = client(async (url, options) => {
    calls.push({ url, bearer: options.headers?.Authorization });
    if (url.endsWith('/api/auth/session')) return json({ accessToken: 'private-fixture-token' });
    assert.equal(options.headers?.Authorization, 'Bearer private-fixture-token');
    return json({ mapping: {} });
  });
  const responses = await Promise.all([
    c.apiFetch('/backend-api/conversation/a', { requireAuth: true }),
    c.apiFetch('/backend-api/conversation/b', { requireAuth: true })
  ]);
  responses.push(await c.apiFetch('/backend-api/conversation/c', { requireAuth: true }));
  assert.equal(calls.filter(call => call.url.endsWith('/api/auth/session')).length, 1);
  assert.ok(calls[0].url.endsWith('/api/auth/session'));
  for (const response of responses) {
    assert.deepEqual(response._gridAuth, { bearerSent: true, refreshed: false });
    assert.equal(JSON.stringify(response._gridAuth).includes('private-fixture-token'), false);
  }
});

test('required session failures are safe and never fall back to cookie-only conversation reads', async () => {
  const cases = [
    [() => json({}), false, undefined],
    [() => json({ accessToken: '   ' }), false, undefined],
    [() => new Response('sensitive body', { status: 404 }), false, 404],
    [() => new Response('sensitive body', { status: 503 }), true, 503],
    [() => new Response('sensitive body', { status: 429 }), true, 429],
    [() => new Response('sensitive body', { status: 200 }), false, undefined],
    [() => { throw new TypeError('sensitive body'); }, true, undefined]
  ];
  for (const [sessionResponse, retryable, status] of cases) {
    const calls = [];
    const c = client(async url => { calls.push(url); return sessionResponse(); });
    await assert.rejects(c.apiFetch('/backend-api/conversation/a', { requireAuth: true }), error => {
      assert.equal(error.code, 'session_unavailable');
      assert.equal(error.phase, 'auth');
      assert.equal(error.retryable, retryable);
      assert.equal(error.status, status);
      assert.equal(error.message.includes('sensitive body'), false);
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(calls.length, 1);
    assert.ok(calls[0].endsWith('/api/auth/session'));
  }
});

test('404 never refreshes or repeats backend requests, including required authentication', async () => {
  for (const requireAuth of [false, true]) {
    const calls = [];
    const c = client(async url => {
      calls.push(url);
      return url.endsWith('/api/auth/session') ? json({ accessToken: 'token' }) : missing();
    });
    const response = await c.apiFetch('/backend-api/conversation/a', { requireAuth });
    assert.equal(response.status, 404);
    assert.deepEqual(response._gridAuth, { bearerSent: requireAuth, refreshed: false });
    assert.equal(calls.filter(url => url.includes('/backend-api/')).length, 1);
    assert.equal(calls.filter(url => url.endsWith('/api/auth/session')).length, requireAuth ? 1 : 0);
  }
});

test('required authentication refreshes once on rejection and reports safe response diagnostics', async () => {
  let sessions = 0;
  const bearers = [];
  const c = client(async (url, options) => {
    if (url.endsWith('/api/auth/session')) return json({ accessToken: `token-${++sessions}` });
    bearers.push(options.headers?.Authorization);
    return new Response('', { status: 401 });
  });
  const response = await c.apiFetch('/backend-api/conversation/a', { requireAuth: true });
  assert.equal(response.status, 401);
  assert.equal(sessions, 2);
  assert.deepEqual(bearers, ['Bearer token-1', 'Bearer token-2']);
  assert.deepEqual(response._gridAuth, { bearerSent: true, refreshed: true });
});

test('optional authentication retains cookie-first behavior and failed-session HTTP response', async () => {
  const calls = [];
  const c = client(async (url, options) => {
    calls.push({ url, bearer: options.headers?.Authorization });
    return new Response('', { status: url.endsWith('/api/auth/session') ? 503 : 403 });
  });
  const response = await c.apiFetch('/backend-api/files/file_a/download');
  assert.equal(response.status, 403);
  assert.ok(calls[0].url.includes('/backend-api/'));
  assert.equal(calls[0].bearer, undefined);
  assert.equal(calls.length, 2);
  assert.deepEqual(response._gridAuth, { bearerSent: false, refreshed: false });
});

// Prompt provenance fixtures: definitions only, not executed during implementation.
test('API source associations preserve snake and camel fields without changing asset discovery', () => {
  const expected = { conversationId: 'conversation-a', messageId: 'message-a',
    generationId: 'generation-a', transformationId: 'transformation-a', assetPointer: 'sediment://file_abc123' };
  const snake = images.fromItem({ file_id: 'file_abc123', conversation_id: expected.conversationId,
    message_id: expected.messageId, generation_id: expected.generationId,
    transformation_id: expected.transformationId, asset_pointer: expected.assetPointer });
  const camel = images.fromItem({ file_id: 'file_abc123', ...expected });
  assert.deepEqual(snake.sourceAssociations, [expected]);
  assert.deepEqual(camel.sourceAssociations, [expected]);
  assert.equal(snake.fileId, 'file_abc123');
  assert.equal(snake.conversationId, expected.conversationId);
  assert.deepEqual(snake.candidates, []);
  assert.equal(images.fromItem({ asset_pointer: 'sediment://file_new' }), null);
});

test('duplicate asset sources retain conflicting associations without mixing conversation and message pairs', () => {
  const first = images.fromItem({ file_id: 'file_abc123', conversation_id: 'a', message_id: 'a-output' });
  const second = images.fromItem({ file_id: 'file_abc123', conversationId: 'b', messageId: 'b-output' });
  const result = images.merge([first, second, first]);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].sourceAssociations, [
    { conversationId: 'a', messageId: 'a-output' }, { conversationId: 'b', messageId: 'b-output' }
  ]);
  assert.equal(result[0].conversationId, 'a');
  assert.equal(result[0].messageId, 'a-output');
  result[0].sourceAssociations[0].messageId = 'changed';
  assert.equal(first.sourceAssociations[0].messageId, 'a-output');
});

test('missing source fields remain absent and a later source is retained without guessed links', () => {
  const first = images.fromItem({ file_id: 'file_abc123', conversation_id: 'a', message_id: {} });
  const second = images.fromItem({ file_id: 'file_abc123', message_id: 'output', generation_id: 42 });
  const merged = images.merge([first, second])[0];
  assert.deepEqual(merged.sourceAssociations, [{ conversationId: 'a' }, { messageId: 'output' }]);
  assert.equal(merged.messageId, undefined);
});

test('extract IDs from encoded thumbnails and legacy hyphenated IDs', () => {
  assert.equal(images.fileId(thumbnailUrl), 'file_abc123');
  assert.equal(images.fileId('/files/file-Ab12Cd/download'), 'file-Ab12Cd');
});

test('reject transformed/signed previews without rewriting signatures', () => {
  for (const url of [thumbnailUrl, thumbnailUrl.replace('%23', '%2523'),
    originalUrl + '&width=512', originalUrl + '#thumbnail',
    'https://files.oaiusercontent.com/preview/file_abc123.png']) {
    assert.equal(images.isPreview(url), true, url);
  }
  assert.equal(images.isPreview(originalUrl), false);
  assert.equal(images.allowedUrl('https://chatgpt.com.attacker.test/backend-api/file.png'), false);
  assert.equal(images.allowedUrl('https://example.com/?host=oaiusercontent.com'), false);
});

test('resolve JSON download_url then preserve original bytes and dimensions', async () => {
  const calls = [];
  const result = await client(async url => {
    calls.push(url);
    if (url.endsWith('/files/file_abc123/download')) return json({ download_url: originalUrl });
    assert.equal(url, originalUrl);
    return imageResponse();
  }).resolve(entry());
  assert.deepEqual(Buffer.from(await result.blob.arrayBuffer()), bytes);
  assert.equal(result.width, 1536);
  assert.equal(result.height, 1024);
  assert.equal(calls.length, 2);
  assert.equal(await images.fingerprint(result.blob), crypto.createHash('sha256').update(bytes).digest('hex'));
});

test('original WebP stays WebP, not a re-encoded PNG', async () => {
  const result = await client(async () => imageResponse('image/webp')).resolve(entry());
  assert.equal(result.blob.type, 'image/webp');
  assert.deepEqual(Buffer.from(await result.blob.arrayBuffer()), webpBytes);
  assert.equal(images.filename('photo.png', result.blob.type, 0), '0001-photo.webp');
});

test('handle direct-image legacy endpoint after primary endpoint is unavailable', async () => {
  const calls = [];
  const result = await client(async url => {
    calls.push(url);
    return url.includes('/files/download/') ? imageResponse() : missing();
  }).resolve(entry());
  assert.equal(calls.length, 2);
  assert.equal(result.source, 'file-download-endpoint');
});

test('never fetch a thumbnail even when original endpoints fail', async () => {
  const calls = [];
  await assert.rejects(client(async url => { calls.push(url); return missing(); }).resolve(entry()), /no thumbnail saved/);
  assert.equal(calls.includes(thumbnailUrl), false);
});

test('a signed unmarked resource is not proof of an original', async () => {
  const calls = [];
  await assert.rejects(client(async url => { calls.push(url); return missing(); })
    .resolve(images.fromItem({ url: originalUrl })), /no thumbnail saved/);
  assert.equal(calls.includes(originalUrl), false);
});

test('thumbnail returned by original resolver is rejected', async () => {
  let previewFetched = false;
  await assert.rejects(client(async url => {
    if (url === thumbnailUrl) previewFetched = true;
    return json({ download_url: thumbnailUrl });
  }).resolve(entry()), /Preview URL rejected/);
  assert.equal(previewFetched, false);
});

test('expired original does not hide another live explicit original', async () => {
  const expired = 'https://files.oaiusercontent.com/file_abc123.png?sig=expired';
  const good = 'https://files.oaiusercontent.com/file_abc123.png?sig=fresh';
  const entries = images.merge([
    images.fromItem({ original_url: expired }),
    images.fromItem({ encodings: { source: { path: good } } })
  ]);
  assert.equal(entries.length, 1);
  const calls = [];
  const result = await client(async url => {
    calls.push(url);
    return url === good ? imageResponse() : missing();
  }).resolve(entries[0]);
  assert.ok(calls.indexOf(expired) < calls.indexOf(good));
  assert.equal(result.blob.size, bytes.length);
});

test('authentication retry stays on ChatGPT; CDN receives no bearer or credentials', async () => {
  const cdn = 'https://files.oaiusercontent.com/file_abc123.png';
  const calls = [];
  const result = await client(async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/api/auth/session')) return json({ accessToken: 'test-only-token' });
    if (url === cdn) {
      assert.equal(options.headers?.Authorization, undefined);
      assert.equal(options.credentials, 'omit');
      return imageResponse();
    }
    if (options.headers?.Authorization === 'Bearer test-only-token') return json({ download_url: cdn });
    return new Response('unauthorized', { status: 401 });
  }).resolve(entry());
  assert.equal(result.blob.size, bytes.length);
  assert.equal(calls.filter(c => c.url.endsWith('/api/auth/session')).length, 1);
});

test('HTML fails, while decoder-only failure preserves a structurally complete PNG with warnings', async () => {
  await assert.rejects(client(async () => new Response('<html>Sign in</html>', {
    headers: { 'content-type': 'text/html' }
  })).resolve(entry()), /not a supported image/);
  const result = await images.createClient({ fetchImpl: async () => imageResponse(),
    measure: async () => { throw new Error('decoder unavailable'); }
  }).resolve(entry());
  assert.equal(result.validation, 'container-only');
  assert.match(result.warnings[0], /renderability is unverified/);
  assert.deepEqual(Buffer.from(await result.blob.arrayBuffer()), bytes);
});

test('legitimate small originals are accepted based on original endpoint provenance', async () => {
  const result = await images.createClient({ fetchImpl: async () => imageResponse(),
    measure: async () => ({ width: 256, height: 256 }) }).resolve(entry());
  assert.equal(result.width, 256);
});

test('reject backend requests and explicit originals on unrelated hosts', async () => {
  let calls = 0;
  const c = client(async () => { calls++; return imageResponse(); });
  await assert.rejects(c.apiFetch('https://example.com/backend-api/files'), /Invalid backend/);
  assert.equal(images.fromItem({ original_url: 'https://example.com/image.png' }), null);
  assert.equal(calls, 0);
});

test('filenames keep Unicode and match actual image MIME; each index is unique', () => {
  assert.equal(images.filename('中文.png', 'image/jpeg', 1), '0002-中文.jpg');
  assert.notEqual(images.filename('same.png', 'image/png', 0), images.filename('same.png', 'image/png', 1));
  assert.equal(images.filename('CON', 'image/png', 0), '0001-image_CON.png');
  assert.ok(!images.filename('../bad/name.png', 'image/png', 0).includes('/'));
});

test('opaque signatures and filenames do not turn originals into previews', () => {
  assert.equal(images.isPreview('https://files.oaiusercontent.com/original.png?sig=preview'), false);
  assert.equal(images.isPreview('https://files.oaiusercontent.com/my-thumbnail-study.png?sig=abc'), false);
  assert.equal(images.isPreview('https://chatgpt.com/backend-api/estuary/content?id=file_abc123&sig=thumbnail'), false);
});

test('file ID discovery ignores token text and prefers structured ID parameters', () => {
  assert.equal(images.fileId('https://files.oaiusercontent.com/photo.png?sig=file_wrong'), null);
  assert.equal(images.fileId('https://chatgpt.com/backend-api/estuary/content?sig=file_wrong&id=file_right%23thumbnail'), 'file_right');
});

test('explicit download link can itself return a JSON download descriptor', async () => {
  const descriptor = 'https://chatgpt.com/backend-api/files/library/download?node_id=abc';
  const c = client(async url => url === descriptor ? json({ download_url: originalUrl }) : imageResponse());
  const result = await c.resolve(images.fromItem({ download_url: descriptor }));
  assert.deepEqual(Buffer.from(await result.blob.arrayBuffer()), bytes);
});

test('download attachment MIME octet-stream is detected from original bytes', async () => {
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082', 'hex');
  const result = await client(async () => new Response(png, {
    headers: { 'content-type': 'application/octet-stream' }
  })).resolve(entry());
  assert.equal(result.blob.type, 'image/png');
  assert.deepEqual(Buffer.from(await result.blob.arrayBuffer()), png);
});

test('Unicode filenames fit filesystem byte limits', () => {
  const name = images.filename('图'.repeat(120) + '.png', 'image/png', 0);
  assert.ok(Buffer.byteLength(name, 'utf8') <= 255, `Filename is ${Buffer.byteLength(name)} bytes`);
});

test('temporary session lookup failure can recover on the next API call', async () => {
  let sessions = 0;
  const c = client(async (url, options) => {
    if (url.endsWith('/api/auth/session')) {
      sessions++;
      return sessions === 1 ? new Response('try later', { status: 503 }) : json({ accessToken: 'fresh' });
    }
    return options.headers?.Authorization === 'Bearer fresh' ? json({ items: [] }) : new Response('', { status: 401 });
  });
  assert.equal((await c.apiFetch('/backend-api/conversations')).status, 401);
  assert.equal((await c.apiFetch('/backend-api/conversations')).status, 200);
});

test('expired in-memory token is refreshed instead of failing the rest of a batch', async () => {
  let sessions = 0;
  const c = client(async (url, options) => {
    if (url.endsWith('/api/auth/session')) return json({ accessToken: ++sessions === 1 ? 'old' : 'new' });
    const expected = url.endsWith('/first') ? 'Bearer old' : 'Bearer new';
    return options.headers?.Authorization === expected ? json({ items: [] }) : new Response('', { status: 401 });
  });
  assert.equal((await c.apiFetch('/backend-api/first')).status, 200);
  assert.equal((await c.apiFetch('/backend-api/second')).status, 200);
  assert.equal(sessions, 2);
});

test('cyclic JSON download descriptors fail within a bounded number of requests', async () => {
  const url = 'https://chatgpt.com/backend-api/files/library/download?node_id=abc';
  let requests = 0;
  await assert.rejects(client(async () => { requests++; return json({ download_url: url }); })
    .resolve(images.fromItem({ download_url: url })), /cycle/);
  assert.equal(requests, 1);
});

test('declared MIME cannot disguise PNG bytes as a different original format', async () => {
  const result = await client(async () => new Response(bytes, { headers: { 'content-type': 'image/jpeg' } })).resolve(entry());
  assert.equal(result.blob.type, 'image/png');
  assert.deepEqual(Buffer.from(await result.blob.arrayBuffer()), bytes);
});


// Added for 1.4.2; execution is left to the user.
test('transient fetch failures retry original resolution with bounded backoff', async () => {
  let calls = 0;
  const waits = [];
  const c = images.createClient({ measure, wait: async ms => waits.push(ms), fetchImpl: async () => {
    if (++calls <= 2) throw new TypeError('Failed to fetch');
    return imageResponse();
  } });
  const result = await c.resolve(entry());
  assert.equal(result.retrievalAttempts, 2);
  assert.equal(result.retrievalErrors.length, 2);
  assert.equal(waits.length, 1);
  assert.deepEqual(Buffer.from(await result.blob.arrayBuffer()), bytes);
});

test('permanent CORS-like fetch errors stop after three resolution rounds', async () => {
  let calls = 0;
  const c = images.createClient({ measure, wait: async () => {}, fetchImpl: async () => {
    calls++; throw new TypeError('Failed to fetch');
  } });
  await assert.rejects(c.resolve(entry()), error => {
    assert.equal(error.retrievalAttempts, 3);
    assert.equal(error.details.length, 6);
    return /no thumbnail saved/.test(error.message);
  });
  assert.equal(calls, 6);
});

test('obviously truncated PNG is not saved when decoding also fails', async () => {
  const c = images.createClient({ maxAttempts: 1, fetchImpl: async () => new Response(bytes.subarray(0, -12), {
    headers: { 'content-type': 'image/png' }
  }), measure: async () => { throw new Error('bad image'); } });
  await assert.rejects(c.resolve(entry()), /container is incomplete or unsupported/);
});

test('expired signed link is resolved anew on a retry round', async () => {
  let descriptors = 0;
  const c = images.createClient({ measure, wait: async () => {}, fetchImpl: async url => {
    if (url.endsWith('/files/file_abc123/download')) {
      descriptors++;
      return json({ download_url: `https://files.oaiusercontent.com/image.png?sig=${descriptors}` });
    }
    if (url.includes('/files/download/')) return missing();
    return url.endsWith('sig=1') ? new Response('', { status: 403 }) : imageResponse();
  } });
  const result = await c.resolve(entry());
  assert.equal(descriptors, 2);
  assert.equal(result.retrievalAttempts, 2);
});

test('invisible format characters and Unicode noncharacters are removed from filenames', () => {
  assert.equal(images.filename('Terminol\u200b\u200bogy Guide.png', 'image/png', 0), '0001-Terminology Guide.png');
  assert.equal(images.sanitizeSegment('room \u2026'), 'room');
  assert.equal(images.sanitizeSegment('a\u202eb\ufeffc\uffff'), 'abc');
});


// Parallel-worker cooldown regression; not executed by the agent.
test('429 cooldown also gates requests from other image tasks', async () => {
  let clock = 0, notify;
  const limited = new Promise(resolve => { notify = resolve; });
  const waiting = [];
  const starts = [];
  const c = images.createClient({ measure, maxAttempts: 1, now: () => clock,
    wait: ms => new Promise(resolve => waiting.push({ ms, resolve })),
    onRateLimit: () => notify(),
    fetchImpl: async url => {
      starts.push({ url, time: clock });
      if (url.endsWith('/files/file_abc123/download')) return new Response('', {
        status: 429, headers: { 'retry-after': '2' }
      });
      if (url.includes('/files/download/')) return missing();
      return Response.json({ items: [] });
    }
  });
  const original = c.resolve(entry()).catch(error => error);
  await limited;
  const other = c.apiFetch('/backend-api/other-image');
  await new Promise(setImmediate);
  assert.equal(starts.some(s => s.url.endsWith('/other-image')), false);
  clock = 2000;
  for (const waiter of waiting) waiter.resolve();
  await Promise.all([original, other]);
  assert.equal(starts.find(s => s.url.endsWith('/other-image')).time, 2000);
});

test('streamed transfer instrumentation preserves exact original bytes', async () => {
  let received = 0;
  const c = images.createClient({ measure, fetchImpl: async () => imageResponse(), onTransfer: size => { received += size; } });
  const result = await c.resolve(entry());
  assert.deepEqual(Buffer.from(await result.blob.arrayBuffer()), bytes);
  assert.equal(received, bytes.length);
});
