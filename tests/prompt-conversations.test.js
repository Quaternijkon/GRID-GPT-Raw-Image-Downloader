// Regression definitions only. Do not execute during this implementation task.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { collect: collectActual } = require('../prompt-conversations.js');
// Virtual clock: pacing/cooldowns do not make fixture runs wait in real time.
const collect = (entries, options) => {
  let time = 0;
  return collectActual(entries, { ...options, now: () => time,
    sleep: async ms => { await options.sleep?.(ms); time += ms; } });
};
const entry = (id, conversationId) => ({ fileId: id, conversationId });
const response = (status = 200, body = { mapping: {} }, retry = null) => ({ ok: status === 200, status, headers: { get: () => retry }, json: async () => body });
const resolver = { resolveConversation: (_conversation, entries) => entries.map(x => ({ fileId: x.fileId, status: 'resolved', cumulativePrompt: 'P' })) };

test('reads each full-collection conversation once with encoded IDs and stable result order', async () => {
  const paths = [], options = [], progress = [];
  const result = await collect([entry('old', 'a/b'), entry('new', 'a/b'), entry('other', 'c')], {
    client: { apiFetch: async (path, settings) => { paths.push(path); options.push(settings); return response(); } }, resolver, onProgress: counters => progress.push(counters)
  });
  assert.deepEqual(paths, ['/backend-api/conversation/a%2Fb', '/backend-api/conversation/c']);
  assert.deepEqual(options, [{ requireAuth: true }, { requireAuth: true }]);
  assert.deepEqual(result.records.map(x => x.fileId), ['old', 'new', 'other']);
  assert.equal(result.conversationCount, 2);
  assert.equal(result.processedConversations, 2);
  assert.equal(result.resolvedImages, 3);
  assert.equal(result.complete, true);
  assert.equal('mapping' in result, false);
  assert.equal(progress.at(-1).resolvedImages, 3);
  assert.deepEqual(result.errorSummary, []);
});

test('singular mapping request retains authentication without the forbidden full-conversation parameter', async () => {
  const requests = [];
  const result = await collect([entry('f', 'c')], {
    client: { apiFetch: async (path, options) => {
      requests.push({ path, options });
      return new URL(path, 'https://chatgpt.com').searchParams.has('include_full_conversation')
        ? response(403, { detail: 'Forbidden' }) : response(200, { mapping: {} });
    } }, resolver
  });
  assert.equal(result.complete, true);
  assert.deepEqual(requests, [{ path: '/backend-api/conversation/c', options: { requireAuth: true } }]);
});

test('complete target ancestry remains usable beside an unrelated broken sibling without pagination hints', async () => {
  const image = id => ({ content_type: 'image_asset_pointer', asset_pointer: `sediment://${id}` });
  const node = (id, parent, role, parts) => ({ id, parent, message: { id, author: { role }, content: { content_type: 'multimodal_text', parts } } });
  const mapping = {
    user: node('user', null, 'user', [image('file_ref'), 'P']),
    target: node('target', 'user', 'assistant', [image('file_target')]),
    sibling: node('sibling', 'absent', 'assistant', ['unrelated'])
  };
  const result = await collect([entry('file_target', 'c')], {
    client: { apiFetch: async () => response(200, { mapping }) },
    resolver: require('../prompt-resolver.js')
  });
  assert.equal(result.complete, true);
  assert.equal(result.records[0].cumulativePrompt, 'P');
});

test('partial mapping with missing target ancestry stays unresolved instead of inventing parents', async () => {
  const mapping = { target: { id: 'target', parent: 'omitted', message: {
    id: 'target', author: { role: 'assistant' }, content: { content_type: 'multimodal_text',
      parts: [{ content_type: 'image_asset_pointer', asset_pointer: 'sediment://file_target' }] }
  } } };
  const result = await collect([entry('file_target', 'c')], {
    client: { apiFetch: async () => response(200, { mapping }) },
    resolver: require('../prompt-resolver.js')
  });
  assert.equal(result.complete, false);
  assert.equal(result.errors[0].code, 'missing_parent');
  assert.equal(mapping.target.parent, 'omitted');
});

test('synthetic page metadata is passed unchanged for resolver assessment, never adapted into ancestry', async () => {
  const conversation = { __paginatedConversationPage: true, mapping: {
    synthetic: { id: 'synthetic', parent: null, message: null }
  } };
  const result = await collect([entry('file_target', 'c')], {
    client: { apiFetch: async () => response(200, conversation) },
    resolver: { resolveConversation: (received, entries) => {
      assert.equal(received, conversation);
      assert.deepEqual(Object.keys(received.mapping), ['synthetic']);
      return entries.map(item => ({ fileId: item.fileId, status: 'unresolved',
        error: { code: 'unsupported_page_ancestry', message: 'Page does not establish target ancestry' } }));
    } }
  });
  assert.equal(result.complete, false);
  assert.equal(result.errors[0].code, 'unsupported_page_ancestry');
});

test('linear page arrays without mapping are rejected rather than adapted', async () => {
  let calls = 0;
  const result = await collect([entry('file_target', 'c')], {
    client: { apiFetch: async () => response(200, { messages: [], next_cursor: 'opaque' }) },
    resolver: { resolveConversation: () => { calls++; return []; } }
  });
  assert.equal(calls, 0);
  assert.equal(result.errors[0].code, 'conversation_shape');
});

test('authenticated 404 stays bounded and summaries count conversations, not just image failures', async () => {
  let requests = 0, resolutions = 0, bodyReads = 0;
  const progress = [];
  const result = await collect([entry('a', 'first'), entry('b', 'first'), entry('c', 'second')], {
    client: { apiFetch: async () => {
      requests++;
      return { ...response(404), _gridAuth: { bearerSent: true, refreshed: false, accessToken: 'must-not-export' },
        json: async () => { bodyReads++; return { detail: 'private-response-body' }; } };
    } },
    resolver: { resolveConversation: () => { resolutions++; return []; } },
    onProgress: update => progress.push(update)
  });
  assert.equal(requests, 2);
  assert.equal(resolutions, 0);
  assert.equal(bodyReads, 0);
  assert.equal(result.complete, false);
  assert.equal(result.errors.length, 3);
  assert.ok(result.errors.every(error => error.code === 'http_error' && error.phase === 'conversation' &&
    error.httpStatus === 404 && error.attemptCount === 1 && error.bearerSent && error.authRetried === false));
  assert.deepEqual(result.errorSummary, [{ code: 'http_error', phase: 'conversation', httpStatus: 404,
    bearerSent: true, authRetried: false, affectedImages: 3, affectedConversations: 2 }]);
  progress.at(-1).errorSummary[0].affectedImages = 999;
  assert.equal(result.errorSummary[0].affectedImages, 3);
  assert.doesNotMatch(JSON.stringify(result), /must-not-export|private-response-body/);
});

test('session lookup failure remains an auth diagnostic with bounded retries and no raw error message', async () => {
  for (const retryable of [false, true]) {
    let requests = 0, resolutions = 0;
    const result = await collect([entry('a', 'c')], {
      client: { apiFetch: async () => {
        requests++;
        throw Object.assign(new Error('sensitive-session-payload'), { code: 'session_unavailable',
          phase: 'auth', retryable, ...(retryable ? { status: 503 } : {}) });
      } },
      resolver: { resolveConversation: () => { resolutions++; return []; } },
      sleep: async () => {}, random: () => 0
    });
    assert.equal(requests, retryable ? 3 : 1);
    assert.equal(resolutions, 0);
    assert.equal(result.complete, false);
    assert.equal(result.errors[0].code, 'session_unavailable');
    assert.equal(result.errors[0].phase, 'auth');
    assert.equal(result.errors[0].attemptCount, requests);
    assert.equal(result.errors[0].httpStatus, retryable ? 503 : undefined);
    assert.equal(result.errors[0].bearerSent, undefined, 'no unobserved authentication claim');
    assert.doesNotMatch(JSON.stringify(result), /sensitive-session-payload/);
  }
});

test('conversation reads remain serial from the first request', async () => {
  let active = 0, peak = 0;
  const result = await collect(Array.from({ length: 9 }, (_, i) => entry(`f${i}`, `c${i}`)), {
    client: { apiFetch: async () => { active++; peak = Math.max(peak, active); await Promise.resolve(); active--; return response(); } }, resolver
  });
  assert.equal(peak, 1);
  assert.equal(result.peakRequests, 1);
  assert.equal(result.requestGapMs, 10000);
  assert.equal(result.rateLimitEpisodes, 0);
  assert.equal(result.complete, true);
});

test('the next conversation starts ten seconds after the prior response completes', async () => {
  let time = 0;
  const starts = [];
  const result = await collectActual([entry('a', 'a'), entry('b', 'b'), entry('c', 'c')], {
    now: () => time, sleep: async ms => { time += ms; }, resolver,
    client: { apiFetch: async () => { starts.push(time); time += 250; return response(); } }
  });
  assert.deepEqual(starts, [0, 10250, 20500]);
  assert.equal(result.peakRequests, 1);
  assert.equal(result.complete, true);
});

test('long Retry-After is waited out without deferring the conversation', async () => {
  let attempts = 0, time = 0;
  const starts = [];
  const result = await collect([entry('f', 'c')], {
    client: { apiFetch: async () => { starts.push(time); return ++attempts === 1 ? response(429, null, '9999') : response(); } },
    resolver, sleep: async ms => { time += ms; }
  });
  assert.equal(attempts, 2);
  assert.deepEqual(starts, [0, 9999000]);
  assert.equal(result.stopped, false);
  assert.equal(result.processedConversations, 1);
  assert.equal(result.resolvedImages, 1);
  assert.equal(result.cooldownUntil, 9999000);
  assert.equal(result.lastServerRetryAfterMs, 9999000);
  assert.equal(result.cooldownSource, 'server');
});

test('three separate 429 episodes keep the same conversation pending until it succeeds', async () => {
  let time = 0;
  const starts = [], progress = [];
  const result = await collectActual([entry('f', 'c')], {
    now: () => time, sleep: async ms => { time += ms; },
    client: { apiFetch: async () => { starts.push(time); return starts.length <= 3 ? response(429) : response(); } }, resolver,
    onProgress: value => progress.push(value)
  });
  assert.deepEqual(starts, [0, 20000, 40000, 60000]);
  assert.equal(result.rateLimitCount, 3);
  assert.equal(result.rateLimitEpisodes, 3);
  assert.equal(result.targetConcurrency, 1);
  assert.equal(result.requestGapMs, 10000);
  assert.equal(result.lastFallbackCooldownMs, 20000);
  assert.equal(result.cooldownSource, 'fallback');
  assert.equal(result.complete, true);
  assert.equal(result.stopped, false);
  assert.equal(result.deferredConversations, 0);
  assert.ok(progress.some(value => value.retryInMs === 20000));
});

test('a recovered 429 keeps serial pacing for the next conversation', async () => {
  let time = 0, calls = 0;
  const starts = [];
  const result = await collectActual([entry('a', 'a'), entry('b', 'b')], {
    now: () => time, sleep: async ms => { time += ms; }, resolver,
    client: { apiFetch: async () => { starts.push(time); return ++calls === 1 ? response(429) : response(); } }
  });
  assert.deepEqual(starts, [0, 20000, 30000]);
  assert.equal(result.rateLimitCount, 1);
  assert.equal(result.rateLimitEpisodes, 1);
  assert.equal(result.targetConcurrency, 1);
  assert.equal(result.requestGapMs, 10000);
  assert.equal(result.complete, true);
});

test('separate 429 episodes across conversations do not discard unfinished work', async () => {
  let time = 0, calls = 0;
  const result = await collectActual(Array.from({ length: 20 }, (_, i) => entry(`f${i}`, `c${i}`)), {
    now: () => time, sleep: async ms => { time += ms; }, resolver,
    client: { apiFetch: async () => ++calls <= 9 && calls % 2 ? response(429) : response() }
  });
  assert.ok(result.rateLimitEpisodes >= 1);
  assert.ok(result.rateLimitCount >= result.rateLimitEpisodes);
  assert.ok(result.requestCount > 20);
  assert.equal(result.deferredConversations, 0);
  assert.equal(result.processedConversations, 20);
  assert.equal(result.stopped, false);
  assert.equal(result.targetConcurrency, 1);
  assert.equal(result.complete, true);
});

test('Retry-After HTTP date is honored and successful records survive a later cooldown', async () => {
  let time = Date.parse('2026-09-23T00:00:00Z'), attempt = 0;
  const starts = [];
  const result = await collectActual([entry('a', 'a'), entry('b', 'b'), entry('c', 'c')], {
    now: () => time, sleep: async ms => { time += ms; },
    client: { apiFetch: async () => {
      starts.push(time);
      return ++attempt === 2 ? response(429, null, 'Wed, 23 Sep 2026 00:05:00 GMT') : response();
    } }, resolver
  });
  assert.deepEqual(starts.map(t => t - starts[0]), [0, 10000, 300000, 310000]);
  assert.equal(result.complete, true);
  assert.equal(result.resolvedImages, 3);
  assert.equal(result.cooldownSource, 'server');
});

test('network retry can recover while permanent HTTP, JSON and shape failures stay bounded', async () => {
  let attempts = 0;
  const recovered = await collect([entry('f', 'c')], {
    client: { apiFetch: async () => { if (++attempts === 1) throw new TypeError('network'); return response(); } }, resolver, sleep: async () => {}, random: () => 0
  });
  assert.equal(recovered.complete, true);
  assert.equal(attempts, 2);
  for (const [expected, value] of [
    ['http_error', response(403)],
    ['json_error', { ...response(), json: async () => { throw new SyntaxError('bad JSON'); } }],
    ['conversation_shape', response(200, { unexpected: true })]
  ]) {
    let calls = 0;
    const failed = await collect([entry('f', 'c')], { client: { apiFetch: async () => { calls++; return value; } }, resolver });
    assert.equal(calls, 1);
    assert.equal(failed.errors[0].code, expected);
    assert.equal(failed.complete, false);
  }
});

test('missing and conflicting conversation identities fail without requests', async () => {
  let calls = 0;
  const result = await collect([entry('missing'), { ...entry('conflict', 'a'), sourceAssociations: [{ conversationId: 'b' }] }], {
    client: { apiFetch: async () => { calls++; return response(); } }, resolver
  });
  assert.equal(calls, 0);
  assert.equal(result.complete, false);
  assert.deepEqual(result.errors.map(x => x.code), ['missing_conversation_id', 'conflicting_conversation_id']);
});

test('resolver duplicate/missing records cannot produce complete collection', async () => {
  for (const records of [[], [{ fileId: 'f', status: 'unresolved' }], [{ fileId: 'f', status: 'resolved', cumulativePrompt: 'P' }, { fileId: 'f', status: 'resolved', cumulativePrompt: 'P' }]]) {
    const result = await collect([entry('f', 'c')], { client: { apiFetch: async () => response() }, resolver: { resolveConversation: () => ({ records }) } });
    assert.equal(result.complete, false);
    assert.equal(result.resolvedImages, 0);
  }
});

test('no cross-run cache and observer failures do not discard valid prompts', async () => {
  let calls = 0;
  const options = { client: { apiFetch: async () => { calls++; return response(); } }, resolver, onProgress: () => { throw new Error('UI gone'); } };
  assert.equal((await collect([entry('f', 'c')], options)).complete, true);
  assert.equal((await collect([entry('f', 'c')], options)).complete, true);
  assert.equal(calls, 2);
});

test('structured resolver errors retain safe code/message and conversation identity', async () => {
  const snapshots = [];
  const result = await collect([entry('bad', 'c'), entry('good', 'c')], {
    client: { apiFetch: async () => response() }, onProgress: update => snapshots.push(update),
    resolver: { resolveConversation: () => [
      { fileId: 'bad', status: 'unresolved', error: { code: 'broken_parent', message: 'Ancestor is missing', rawConversation: 'must not be exported' } },
      { fileId: 'good', status: 'resolved', cumulativePrompt: 'P' }
    ] }
  });
  assert.deepEqual(result.errors, [{ fileId: 'bad', conversationId: 'c', code: 'broken_parent', message: 'Ancestor is missing' }]);
  assert.deepEqual(result.records[0].error, { code: 'broken_parent', message: 'Ancestor is missing' });
  assert.equal(result.records[1].conversationId, 'c');
  assert.equal(snapshots.at(-1).errorCount, 1);
  snapshots.at(-1).errors[0].message = 'observer mutation';
  assert.equal(result.errors[0].message, 'Ancestor is missing');
});

test('structural diagnostics retain only allowed shapes, never arbitrary response details', async () => {
  const result = await collect([entry('f', 'c')], {
    client: { apiFetch: async () => response() },
    resolver: { resolveConversation: () => [{ fileId: 'f', status: 'unresolved',
      error: { code: 'target_not_found', message: 'No target', diagnostic: {
        mappingNodes: 10, exactPointerParts: 0, galleryMessagePresent: false,
        partTypes: ['image_asset_pointer', 'private prompt text!'], rawConversation: 'secret body'
      } } }] }
  });
  assert.deepEqual(result.errors[0].diagnostic, { mappingNodes: 10, exactPointerParts: 0,
    galleryMessagePresent: false, partTypes: ['image_asset_pointer'] });
  assert.doesNotMatch(JSON.stringify(result), /secret body|private prompt text/);
});

test('inactive guard rejects collection before requests, even with no entries', async () => {
  const cancelled = new Error('route changed');
  let calls = 0;
  const options = {
    client: { apiFetch: async () => { calls++; return response(); } }, resolver,
    checkActive: () => { throw cancelled; }
  };
  await assert.rejects(collect([entry('f', 'c')], options), error => error === cancelled);
  await assert.rejects(collect([], options), error => error === cancelled);
  assert.equal(calls, 0);
});

test('guard after response prevents resolution and cancels the complete collection', async () => {
  const cancelled = new Error('route changed');
  let inactive = false, resolutions = 0, calls = 0;
  await assert.rejects(collect(Array.from({ length: 7 }, (_, i) => entry(`f${i}`, `c${i}`)), {
    client: { apiFetch: async () => { calls++; inactive = true; return response(); } },
    resolver: { resolveConversation: () => { resolutions++; return []; } },
    checkActive: () => { if (inactive) throw cancelled; }
  }), error => error === cancelled);
  assert.equal(calls, 1);
  assert.equal(resolutions, 0);
});

test('guard after resolver prevents another job and no cancellation becomes unresolved', async () => {
  const cancelled = new Error('route changed');
  let inactive = false, calls = 0;
  await assert.rejects(collect([entry('f', 'c')], {
    client: { apiFetch: async () => { calls++; return response(); } },
    resolver: { resolveConversation: (_conversation, entries) => { inactive = true; return resolver.resolveConversation(null, entries); } },
    checkActive: () => { if (inactive) throw cancelled; }
  }), error => error === cancelled);
  assert.equal(calls, 1);
});

test('guard during backoff prevents the next retry', async () => {
  const cancelled = new Error('route changed');
  let inactive = false, calls = 0;
  await assert.rejects(collect([entry('f', 'c')], {
    client: { apiFetch: async () => { calls++; return response(503); } }, resolver,
    sleep: async () => { inactive = true; }, random: () => 0,
    checkActive: () => { if (inactive) throw cancelled; }
  }), error => error === cancelled);
  assert.equal(calls, 1);
});

test('cancellation drains all in-flight reads before rejecting and admits no new jobs', async () => {
  const cancelled = new Error('route changed');
  const pending = [];
  let inactive = false, settled = false, resolutions = 0;
  const run = collect(Array.from({ length: 7 }, (_, i) => entry(`f${i}`, `c${i}`)), {
    client: { apiFetch: () => new Promise(resolve => pending.push(resolve)) },
    resolver: { resolveConversation: () => { resolutions++; return []; } },
    checkActive: () => { if (inactive) throw cancelled; }
  });
  const observed = run.then(
    value => { settled = true; return value; },
    error => { settled = true; return error; }
  );
  for (let turn = 0; turn < 12; turn++) await Promise.resolve();
  assert.equal(pending.length, 1);
  inactive = true;
  assert.equal(settled, false);
  pending[0](response());
  for (let turn = 0; turn < 12; turn++) await Promise.resolve();
  assert.equal(await observed, cancelled);
  assert.equal(settled, true);
  assert.equal(resolutions, 0);
  assert.equal(pending.length, 1);
});

test('conflicting resolver conversation identity fails the entire bucket without inflated counts', async () => {
  const result = await collect([entry('a', 'requested'), entry('b', 'requested')], {
    client: { apiFetch: async () => response() },
    resolver: { resolveConversation: () => [
      { fileId: 'a', conversationId: 'requested', status: 'resolved', cumulativePrompt: 'P' },
      { fileId: 'b', conversationId: 'other', status: 'resolved', cumulativePrompt: 'Q' }
    ] }
  });
  assert.equal(result.resolvedImages, 0);
  assert.equal(result.complete, false);
  assert.equal(result.errors.length, 2);
  assert.ok(result.records.every(record => record.status === 'unresolved' && record.conversationId === 'requested'));
  assert.ok(result.errors.every(error => error.code === 'resolver_conversation_identity'));
});

test('late resolver record failure rolls back previously counted successes', async () => {
  const result = await collect([entry('a', 'c'), entry('b', 'c')], {
    client: { apiFetch: async () => response() },
    resolver: { resolveConversation: () => [
      { fileId: 'a', status: 'resolved', cumulativePrompt: 'P' },
      { fileId: 'b', status: 'resolved', get cumulativePrompt() { throw new Error('Invalid prompt record'); } }
    ] }
  });
  assert.equal(result.resolvedImages, 0);
  assert.equal(result.errors.length, 2);
  assert.ok(result.records.every(record => record.status === 'unresolved'));
});
