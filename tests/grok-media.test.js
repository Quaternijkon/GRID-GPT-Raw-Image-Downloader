const { test } = require('node:test');
const assert = require('node:assert/strict');
const grok = require('../grok-media.js');

const imagePost = (id, createTime, extras = {}) => ({ id, createTime,
  mediaType: 'MEDIA_POST_TYPE_IMAGE', mediaUrl: `https://assets.grok.com/generated/${id}/image.jpg`,
  prompt: 'A cat in space', ...extras });
const videoPost = (id, createTime, extras = {}) => ({ id, createTime,
  mediaType: 'MEDIA_POST_TYPE_VIDEO', mediaUrl: `https://imagine-public.x.ai/share-videos/${id}.mp4`,
  ...extras });

test('Grok routes choose owned creations or saved media without affecting other pages', () => {
  assert.equal(grok.scope('/imagine'), 'owned');
  assert.equal(grok.scope('/imagine/post/abc'), 'owned');
  assert.equal(grok.scope('/imagine/saved'), 'liked');
  assert.equal(grok.scope('/imagine/favorites'), 'liked');
  assert.equal(grok.scope('/conversation/abc'), null);
});

test('complete Grok pagination retains image, video, child, prompt, and stable global order', async () => {
  const bodies = [];
  const pages = [
    { posts: [videoPost('video_000001', '2026-09-02T00:00:00Z', { originalPrompt: 'Make it move' }),
      imagePost('parent_00001', '2026-09-01T00:00:00Z', {
        childPosts: [videoPost('child_000001', '2026-09-01T00:00:01Z', { prompt: 'Animated cat' })]
      })], nextCursor: 'cursor-2' },
    { posts: [imagePost('image_000001', '2026-08-01T00:00:00Z')], nextCursor: null }
  ];
  const result = await grok.collect(async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    return { ok: true, status: 200, json: async () => pages[bodies.length - 1] };
  }, 'liked');
  assert.deepEqual(bodies.map(body => body.filter.source),
    ['MEDIA_POST_SOURCE_LIKED', 'MEDIA_POST_SOURCE_LIKED']);
  assert.equal(bodies[1].cursor, 'cursor-2');
  assert.equal(result.pagination.complete, true);
  assert.deepEqual(result.entries.map(entry => entry.id),
    ['image_000001', 'parent_00001', 'child_000001', 'video_000001']);
  assert.deepEqual(result.entries.map(entry => entry.sequence), [1, 2, 3, 4]);
  assert.equal(result.entries[2].prompt, 'Animated cat');
  assert.equal(result.entries[3].prompt, 'Make it move');
});

test('current Grok assets API paginates Imagine images and videos with exact input prompts', async () => {
  const requests = [];
  const pages = [
    { assets: [{ assetId: 'asset_000000002', createTime: '2026-09-02T00:00:00Z',
      mimeType: 'video/mp4', key: 'https://assets.grok.com/generated/asset_000000002/video.mp4',
      sizeBytes: 73400320,
      fileSource: 'IMAGINE_GENERATED_FILE_SOURCE',
      mediaGenInput: { textToVideo: { prompt: 'Run through rain' } } }], nextPageToken: 'page-two' },
    { assets: [{ assetId: 'asset_000000001', createTime: '2026-09-01T00:00:00Z',
      mimeType: 'image/jpeg', key: 'https://assets.grok.com/generated/asset_000000001/image.jpg',
      fileSource: 'IMAGINE_GENERATED_FILE_SOURCE',
      mediaGenInput: { textToImage: { prompt: 'Blue mountain' } } },
      { assetId: 'asset_uploaded01', createTime: '2026-09-03T00:00:00Z',
        mimeType: 'image/jpeg', key: 'https://assets.grok.com/uploaded.jpg',
        fileSource: 'SELF_UPLOAD_FILE_SOURCE' }], nextPageToken: null }
  ];
  const result = await grok.collectAssets(async (url, options) => {
    requests.push({ url: new URL(url), options });
    return { ok: true, status: 200, json: async () => pages[requests.length - 1] };
  });
  assert.equal(requests[0].url.pathname, '/rest/assets');
  assert.equal(requests[0].url.searchParams.get('workspaceKind'), 'WORKSPACE_KIND_IMAGINE_ALL');
  assert.equal(requests[1].url.searchParams.get('pageToken'), 'page-two');
  assert.deepEqual(result.entries.map(entry => [entry.id, entry.kind, entry.prompt]), [
    ['asset_000000001', 'image', 'Blue mountain'],
    ['asset_000000002', 'video', 'Run through rain']
  ]);
  assert.equal(result.pagination.provider, 'assets-v2');
  assert.equal(result.entries[1].reportedSizeBytes, 73400320);
});

test('current Grok collection falls back to post API when assets API is unavailable', async () => {
  const paths = [];
  const result = await grok.collectCurrent(async (url, options) => {
    const path = new URL(url).pathname;
    paths.push(path);
    if (path === '/rest/assets') return { ok: false, status: 404 };
    assert.equal(JSON.parse(options.body).filter.source, 'MEDIA_POST_SOURCE_OWNED');
    return { ok: true, status: 200,
      json: async () => ({ posts: [imagePost('image_000001', '2026-09-01T00:00:00Z')], nextCursor: null }) };
  }, 'owned');
  assert.deepEqual(paths, ['/rest/assets', '/rest/media/post/list']);
  assert.equal(result.entries.length, 1);
  assert.equal(result.pagination.provider, 'media-posts');
});

test('Grok authentication or verification failure stops without probing another API', async () => {
  const paths = [];
  await assert.rejects(grok.collectCurrent(async url => {
    paths.push(new URL(url).pathname);
    return { ok: false, status: 403 };
  }, 'owned'), /HTTP 403/);
  assert.deepEqual(paths, ['/rest/assets']);
});

test('saved Grok scope prefers liked posts and never substitutes the owned asset list', async () => {
  const requests = [];
  const result = await grok.collectCurrent(async (url, options) => {
    requests.push(new URL(url).pathname);
    assert.equal(JSON.parse(options.body).filter.source, 'MEDIA_POST_SOURCE_LIKED');
    return { ok: true, status: 200, json: async () => ({
      posts: [videoPost('video_000001', '2026-09-01T00:00:00Z')], nextCursor: null }) };
  }, 'liked');
  assert.deepEqual(requests, ['/rest/media/post/list']);
  assert.equal(result.entries[0].id, 'video_000001');
});

test('Grok list failures and unstable identity never become a false completed export', async () => {
  await assert.rejects(grok.collect(async () => ({ ok: false, status: 401 }), 'owned'), /HTTP 401/);
  await assert.rejects(grok.collect(async () => ({ ok: true, status: 200,
    json: async () => ({ items: [] }) }), 'owned'), /posts array/);
  await assert.rejects(grok.collect(async () => ({ ok: true, status: 200,
    json: async () => ({ posts: [], nextCursor: 'same' }) }), 'owned'), /repeated a cursor/);
  assert.throws(() => grok.entriesFromPosts([imagePost('image_000001', null)]), /unstable/);
  const missing = grok.entriesFromPosts([imagePost('image_000001', '2026-09-01T00:00:00Z',
    { mediaUrl: '', thumbnailImageUrl: 'https://assets.grok.com/preview.jpg' })]);
  assert.match(missing[0].sourceError, /No permitted original/);
});

test('a later Grok assets page failure remains partial and does not fall back to another list', async () => {
  const paths = [];
  await assert.rejects(grok.collectCurrent(async url => {
    const parsed = new URL(url);
    paths.push(parsed.pathname);
    if (!parsed.searchParams.has('pageToken')) return { ok: true, status: 200,
      json: async () => ({ assets: [{ assetId: 'asset_000000001', createTime: '2026-09-01T00:00:00Z',
        mimeType: 'image/jpeg', key: 'https://assets.grok.com/generated/image.jpg',
        fileSource: 'IMAGINE_GENERATED_FILE_SOURCE' }], nextPageToken: 'next' }) };
    return { ok: false, status: 403 };
  }, 'owned'), /page 2 returned HTTP 403/);
  assert.deepEqual(paths, ['/rest/assets', '/rest/assets']);
});

test('media URL rules reject external hosts, credentials, and preview variants', () => {
  assert.ok(grok.mediaUrl('https://assets.grok.com/generated/abc/image.jpg'));
  assert.equal(grok.mediaUrl('users/owner/generated/asset/image.jpg'),
    'https://assets.grok.com/users/owner/generated/asset/image.jpg');
  assert.equal(grok.mediaUrl('https://evil.example/image.jpg'), null);
  assert.equal(grok.mediaUrl('https://user:pass@grok.com/image.jpg'), null);
  assert.equal(grok.mediaUrl('https://assets.grok.com/generated/abc/preview.jpg'), null);
  assert.equal(grok.mediaUrl('http://assets.grok.com/image.jpg'), null);
});

test('original media retrieval checks byte signature and does not re-encode video or image', async () => {
  const mp4 = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0]);
  const entry = { kind: 'video', candidates: ['https://assets.grok.com/generated/video_000001/video.mp4'] };
  const asset = await grok.fetchOriginal(entry, { fetchImpl: async url => ({ ok: true, status: 200, url,
    blob: async () => new Blob([mp4], { type: 'application/octet-stream' }) }) });
  assert.equal(asset.extension, 'mp4');
  assert.equal(asset.blob.size, mp4.length);
  assert.deepEqual(new Uint8Array(await asset.blob.arrayBuffer()), mp4);
  await assert.rejects(grok.fetchOriginal({ kind: 'image', candidates: entry.candidates }, {
    fetchImpl: async url => ({ ok: true, status: 200, url,
      blob: async () => new Blob(['<html>unauthorized</html>'], { type: 'image/jpeg' }) })
  }), /do not match/);
});

test('Grok Imagine prompts are linked to the exact output asset and its human parent', async () => {
  const responses = [
    { responseId: 'user_00000001', sender: 'human', message: 'First prompt' },
    { responseId: 'output_000001', parentResponseId: 'user_00000001', sender: 'ASSISTANT',
      message: 'media', fileAttachmentsMetadata: [{ assetId: 'asset_000000001' }] },
    { responseId: 'user_00000002', parentResponseId: 'output_000001', sender: 'human', message: 'Second prompt' },
    { responseId: 'output_000002', parentResponseId: 'user_00000002', sender: 'assistant',
      message: 'media', fileAttachments: [{ assetId: 'asset_000000002' }] }
  ];
  const entries = [
    { id: 'asset_000000001', sourceConversationId: 'conversation_00000001', sourceResponseId: 'output_000001', prompt: null },
    { id: 'asset_000000002', sourceConversationId: 'conversation_00000001', prompt: null }
  ];
  let calls = 0;
  const result = await grok.resolvePrompts(entries, { fetchImpl: async url => {
    calls++;
    assert.match(url, /\/rest\/app-chat\/conversations\/conversation_00000001\/responses/);
    return { ok: true, status: 200, json: async () => ({ responses }) };
  } });
  assert.equal(calls, 1);
  assert.equal(result.resolved, 2);
  assert.deepEqual(entries.map(entry => entry.prompt), ['First prompt', 'Second prompt']);
  assert.deepEqual(entries.map(entry => entry.promptSource),
    ['conversation.user.message', 'conversation.user.message']);
  assert.equal(entries[1].promptProvenance.inputResponseId, 'user_00000002');
});

test('Grok prompt resolver leaves absent or ambiguous ancestry unresolved', async () => {
  const entry = { id: 'asset_000000001', sourceConversationId: 'conversation_00000001', prompt: null };
  const result = await grok.resolvePrompts([entry], { fetchImpl: async () => ({ ok: true, status: 200,
    json: async () => ({ responses: [
      { responseId: 'user_00000001', sender: 'human', message: 'Do not guess me' },
      { responseId: 'output_000001', parentResponseId: 'user_00000001', sender: 'assistant',
        fileAttachments: [{ assetId: 'asset_other0001' }] }
    ] }) }) });
  assert.equal(result.unresolved, 1);
  assert.equal(entry.promptError.code, 'target_not_found');
  assert.equal(entry.prompt, null);
});

test('Grok prompt authentication failure stops before more conversations are requested', async () => {
  const entries = [
    { id: 'asset_000000001', sourceConversationId: 'conversation_00000001', prompt: null },
    { id: 'asset_000000002', sourceConversationId: 'conversation_00000002', prompt: null }
  ];
  let calls = 0;
  await assert.rejects(grok.resolvePrompts(entries, { fetchImpl: async () => {
    calls++;
    return { ok: false, status: 403 };
  } }), /HTTP 403/);
  assert.equal(calls, 1);
});
