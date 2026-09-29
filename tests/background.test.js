const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const webcrypto = require('node:crypto').webcrypto;

function worker({ storageError = false, downloadId = 1, downloadHook, fetchImpl,
  downloadStates = new Map(), downloadHistory = [], removed = [], erased = [] } = {}) {
  let listener;
  const settings = {};
  const chrome = {
    runtime: { onMessage: { addListener(fn) { listener = fn; } }, onInstalled: { addListener() {} } },
    downloads: { download(opts, callback) {
      if (downloadHook) downloadHook(opts, callback, chrome);
      else callback(downloadId);
    }, search(query, callback) { callback(query.id === undefined ? downloadHistory :
      [downloadStates.get(query.id) || { id: query.id, state: 'complete' }]); },
    cancel(_id, callback) { callback(); }, removeFile(id, callback) { removed.push(id); callback(); },
    erase(query, callback) { erased.push(query.id); callback([{ id: query.id }]); } },
    storage: { local: {
      set(data, callback) {
        if (storageError) chrome.runtime.lastError = { message: 'Storage unavailable' };
        else Object.assign(settings, data);
        callback(); delete chrome.runtime.lastError;
      }, get(_keys, callback) {
        if (storageError) chrome.runtime.lastError = { message: 'Storage unavailable' };
        callback({ ...settings }); delete chrome.runtime.lastError;
      }
    } }
  };
  const context = vm.createContext({ chrome, console, URL, setTimeout, clearTimeout, Date,
    crypto: webcrypto, btoa, fetch: fetchImpl });
  context.importScripts = file => vm.runInContext(fs.readFileSync(file, 'utf8'), context);
  vm.runInContext(fs.readFileSync('background.js', 'utf8'), context);
  return (message, senderUrl = 'https://chatgpt.com/images') =>
    new Promise(resolve => listener(message, { url: senderUrl }, resolve));
}

test('Gemini worker validates a full size image redirect, exact bytes, and tracked destination', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAaX2RUAAAAAASUVORK5CYII=', 'base64');
  const base = `https://lh3.googleusercontent.com/gg/${'A'.repeat(50)}`;
  const redirectUrl = `https://lh3.google.com/rd-gg/${'B'.repeat(50)}=s0-d-I?alr=yes`;
  const finalUrl = `https://lh3.googleusercontent.com/rd-gg/${'C'.repeat(50)}=s0-d-I?alr=yes`;
  const calls = [], downloads = [];
  const send = worker({ fetchImpl: async (url, options) => {
    calls.push({ url, credentials: options.credentials });
    if (url === `${base}=d-I?alr=yes`) return { ok: true, status: 200, url,
      headers: { get: key => key === 'content-type' ? 'text/plain' : null }, text: async () => redirectUrl };
    if (url === redirectUrl) return { ok: true, status: 200, url,
      headers: { get: key => key === 'content-type' ? 'text/plain' : null }, text: async () => finalUrl };
    if (url === finalUrl && options.credentials !== 'include') return { ok: false, status: 403, url,
      headers: { get: () => 'text/html' } };
    if (url === finalUrl) return { ok: true, status: 200, url,
      headers: { get: key => key === 'content-type' ? 'image/png' : null },
      arrayBuffer: async () => png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) };
    throw new Error(`Unexpected image fetch ${url}`);
  }, downloadHook: (options, callback) => { downloads.push(options); callback(87); },
  downloadStates: new Map([[87, { id: 87, state: 'complete', exists: true,
    filename: `/Downloads/gemini-images/000001-rc_${'f'.repeat(16)}.png` }]]) });
  const page = 'https://gemini.google.com/library';
  const result = await send({ action: 'geminiDownload', kind: 'media', folder: 'gemini-images',
    sequence: 1, mediaId: `rc_${'f'.repeat(16)}`, savePrompts: false, url: base }, page);
  assert.equal(result.ok, true);
  assert.equal(result.bytes, png.length);
  assert.equal(result.mimeType, 'image/png');
  assert.deepEqual(calls, [
    { url: `${base}=d-I?alr=yes`, credentials: 'omit' },
    { url: redirectUrl, credentials: 'include' },
    { url: finalUrl, credentials: 'include' }
  ]);
  assert.deepEqual(Buffer.from(downloads[0].url.split(',')[1], 'base64'), png);
  assert.equal(downloads[0].filename, `gemini-images/000001-rc_${'f'.repeat(16)}.png`);
  const variantId = `rc_${'f'.repeat(16)}-${'a'.repeat(32)}`;
  const variant = await send({ action: 'geminiDownload', kind: 'media', folder: 'gemini-images',
    sequence: 2, mediaId: variantId, savePrompts: false, url: base }, page);
  assert.equal(variant.ok, true);
  assert.equal(downloads[1].filename, `gemini-images/000002-${variantId}.png`);
  const progress = await send({ action: 'getGeminiProgress', folder: 'gemini-images', savePrompts: false }, page);
  assert.equal(progress.records[0].status, 'complete');
  assert.equal((await send({ action: 'geminiDownload', kind: 'media', folder: 'gemini-images',
    sequence: 1, mediaId: `rc_${'f'.repeat(16)}`, savePrompts: false,
    url: 'https://evil.example/image' }, page)).ok, false);
});

test('Gemini rejects an external redirect before any credentialed media request', async () => {
  const base = `https://lh3.googleusercontent.com/gg/${'A'.repeat(50)}`;
  const calls = [];
  const send = worker({ fetchImpl: async (url, options) => {
    calls.push({ url, credentials: options.credentials });
    return { ok: true, status: 200, url,
      headers: { get: key => key === 'content-type' ? 'text/plain' : null },
      text: async () => 'https://unrelated.example/private.png' };
  } });
  const result = await send({ action: 'geminiDownload', kind: 'media', folder: 'gemini-images',
    sequence: 1, mediaId: `rc_${'f'.repeat(16)}`, savePrompts: false, url: base },
  'https://gemini.google.com/library');
  assert.equal(result.ok, false);
  assert.match(result.error, /非媒体地址/);
  assert.deepEqual(calls, [{ url: `${base}=d-I?alr=yes`, credentials: 'omit' }]);
});

test('Gemini cleanup is idempotent when a prior attempt already removed the unresolved file', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAaX2RUAAAAAASUVORK5CYII=', 'base64');
  const base = `https://lh3.googleusercontent.com/gg/${'A'.repeat(50)}`;
  const mediaId = `rc_${'f'.repeat(16)}`;
  const groupName = 'p-0123456789abcdef0123456789abcdef-a';
  const oldRelativePath = `gemini-images/未解析/000001-${mediaId}.png`;
  const newRelativePath = `gemini-images/${groupName}/000001-${mediaId}.png`;
  const removed = [];
  const states = new Map([
    [90, { id: 90, state: 'complete', exists: false, filename: `/Downloads/${oldRelativePath}` }],
    [91, { id: 91, state: 'complete', exists: true, filename: `/Downloads/${newRelativePath}` }]
  ]);
  const send = worker({ downloadId: 91, removed, downloadStates: states,
    fetchImpl: async url => ({ ok: true, status: 200, url,
      headers: { get: key => key === 'content-type' ? 'image/png' : null },
      arrayBuffer: async () => png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) }) });
  const page = 'https://gemini.google.com/library';
  const download = await send({ action: 'geminiDownload', kind: 'media', folder: 'gemini-images',
    sequence: 1, mediaId, savePrompts: true, groupName, url: base, retry: true,
    previousRecovery: { downloadId: 90, relativePath: oldRelativePath } }, page);
  assert.equal(download.relativePath, newRelativePath);
  const cleanup = await send({ action: 'cleanupGeminiRecovery', folder: 'gemini-images',
    mediaId, oldDownloadId: 90, oldRelativePath, newDownloadId: 91 }, page);
  assert.equal(cleanup.cleanupStatus, 'old-file-already-absent');
  assert.deepEqual(removed, []);
  const progress = await send({ action: 'getGeminiProgress', folder: 'gemini-images', savePrompts: true }, page);
  assert.equal(progress.records[0].previousRecovery, undefined);
});

test('Gemini keeps the unresolved original until its grouped replacement is complete', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAaX2RUAAAAAASUVORK5CYII=', 'base64');
  const mediaId = `rc_${'f'.repeat(16)}`;
  const groupName = 'p-0123456789abcdef0123456789abcdef-a';
  const oldRelativePath = `gemini-images/未解析/000001-${mediaId}.png`;
  const newRelativePath = `gemini-images/${groupName}/000001-${mediaId}.png`;
  const states = new Map([
    [90, { id: 90, state: 'complete', exists: true, filename: `/Downloads/${oldRelativePath}` }],
    [91, { id: 91, state: 'in_progress', exists: false, filename: `/Downloads/${newRelativePath}` }]
  ]);
  const removed = [];
  const send = worker({ downloadId: 91, removed, downloadStates: states,
    fetchImpl: async url => ({ ok: true, status: 200, url,
      headers: { get: key => key === 'content-type' ? 'image/png' : null },
      arrayBuffer: async () => png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) }) });
  const page = 'https://gemini.google.com/library';
  await send({ action: 'geminiDownload', kind: 'media', folder: 'gemini-images', sequence: 1,
    mediaId, savePrompts: true, groupName,
    url: `https://lh3.googleusercontent.com/gg/${'A'.repeat(50)}`, retry: true,
    previousRecovery: { downloadId: 90, relativePath: oldRelativePath } }, page);
  const cleanup = { action: 'cleanupGeminiRecovery', folder: 'gemini-images', mediaId,
    oldDownloadId: 90, oldRelativePath, newDownloadId: 91 };
  assert.equal((await send(cleanup, page)).ok, false);
  assert.deepEqual(removed, []);
  states.set(91, { id: 91, state: 'complete', exists: true, filename: `/Downloads/${newRelativePath}` });
  assert.equal((await send(cleanup, page)).cleanupStatus, 'old-file-removed');
  assert.deepEqual(removed, [90]);
  const progress = await send({ action: 'getGeminiProgress', folder: 'gemini-images', savePrompts: true }, page);
  assert.equal(progress.records[0].previousRecovery, undefined);
});

test('Grok downloads are isolated to Grok Imagine and validate media, prompt, and report paths', async () => {
  const calls = [];
  const send = worker({ downloadHook: (options, callback) => { calls.push(options); callback(calls.length); } });
  const page = 'https://grok.com/imagine/saved';
  const url = 'blob:https://grok.com/01234567-89ab-cdef-0123-456789abcdef';
  const groupName = 'p-0123456789abcdef0123456789abcdef-a';
  const image = { action: 'grokDownload', kind: 'media', folder: 'grok-media',
    sequence: 1, mediaId: 'asset_000000001', mediaType: 'image', savePrompts: true, groupName,
    name: '000001-asset_000000001.png', url };
  assert.equal((await send(image, page)).relativePath,
    `grok-media/${groupName}/000001-asset_000000001.png`);
  assert.equal(calls[0].conflictAction, 'uniquify');
  assert.equal((await send({ ...image, retry: true }, page)).ok, true);
  assert.equal(calls.at(-1).conflictAction, 'overwrite');
  assert.equal((await send({ ...image, mediaType: 'video' }, page)).ok, false);
  assert.equal((await send({ ...image, name: '../bad.png' }, page)).ok, false);
  assert.equal((await send({ ...image, url: 'blob:https://evil.example/01234567-89ab-cdef-0123-456789abcdef' }, page)).ok, false);
  assert.equal((await send(image, 'https://chatgpt.com/images')).status, 'unknown');
  assert.equal((await send({ action: 'downloadFile', folder: 'grok-media', name: 'bad.png',
    url: 'data:image/png;base64,AA==' }, page)).status, 'invalid');
  assert.equal((await send({ action: 'grokDownload', kind: 'prompt', folder: 'grok-media', groupName,
    name: 'prompt.txt', url: 'data:text/plain;charset=utf-8,hello' }, page)).ok, true);
  assert.equal(calls.at(-1).conflictAction, 'overwrite');
  assert.equal((await send({ action: 'grokDownload', kind: 'prompt', folder: 'grok-media', groupName,
    name: 'prompt.txt', retry: true, url: 'data:text/plain;charset=utf-8,hello' }, page)).ok, false);
  assert.equal((await send({ action: 'grokDownload', kind: 'report', folder: 'grok-media',
    name: 'grok-download-results.json', url: 'data:application/json;charset=utf-8,%7B%7D' }, page)).ok, true);
  assert.equal(calls.at(-1).conflictAction, 'uniquify');
});

test('Grok progress requires Chrome completion and separates owned from saved media', async () => {
  const states = new Map([[77, { id: 77, state: 'complete', exists: true,
    filename: '/Downloads/grok-media/000001-asset_000000001.mp4' }]]);
  const send = worker({ downloadId: 77, downloadStates: states });
  const saved = 'https://grok.com/imagine/saved';
  const image = { action: 'grokDownload', kind: 'media', folder: 'grok-media',
    sequence: 1, mediaId: 'asset_000000001', mediaType: 'video', savePrompts: false,
    name: '000001-asset_000000001.mp4',
    url: 'blob:https://grok.com/01234567-89ab-cdef-0123-456789abcdef' };
  assert.equal((await send(image, saved)).ok, true);
  const query = { action: 'getGrokProgress', folder: 'grok-media', savePrompts: false };
  assert.equal((await send(query, saved)).records[0].status, 'complete');
  assert.equal((await send({ ...query, savePrompts: true }, saved)).records.length, 0);
  assert.equal((await send(query, 'https://grok.com/imagine')).records.length, 0);
  states.set(77, { id: 77, state: 'complete', exists: false });
  assert.equal((await send(query, saved)).records[0].status, 'missing');
});

test('Grok concurrency preference is persisted separately from the ChatGPT setting', async () => {
  const send = worker();
  const grokPage = 'https://grok.com/imagine';
  assert.equal((await send({ action: 'getGrokSettings' }, grokPage)).concurrency, 'auto');
  assert.equal((await send({ action: 'setGrokSettings', folder: 'grok-media', concurrency: 4 }, grokPage)).concurrency, 4);
  assert.equal((await send({ action: 'getGrokSettings' }, grokPage)).concurrency, 4);
  assert.equal((await send({ action: 'getDownloadFolder' })).concurrency, 'auto');
  assert.equal((await send({ action: 'setGrokSettings', folder: 'grok-media', concurrency: 'auto' }, grokPage)).concurrency, 'auto');
});

test('Grok recovery cleanup removes only the verified old file after the grouped replacement completes', async () => {
  const groupName = 'p-0123456789abcdef0123456789abcdef-a';
  const oldRelativePath = 'grok-media-recovery/未解析/000001-asset_000000001.png';
  const newRelativePath = `grok-media/${groupName}/000001-asset_000000001.png`;
  const removed = [], erased = [];
  const send = worker({ downloadId: 91, removed, erased, downloadStates: new Map([
    [90, { id: 90, state: 'complete', exists: true, filename: `/Downloads/${oldRelativePath}` }],
    [91, { id: 91, state: 'complete', exists: true, filename: `/Downloads/${newRelativePath}` }]
  ]) });
  const page = 'https://grok.com/imagine';
  assert.equal((await send({ action: 'grokDownload', kind: 'media', folder: 'grok-media',
    savePrompts: true, groupName, sequence: 1, mediaId: 'asset_000000001', mediaType: 'image',
    name: '000001-asset_000000001.png',
    previousRecovery: { downloadId: 90, relativePath: oldRelativePath },
    url: 'blob:https://grok.com/01234567-89ab-cdef-0123-456789abcdef' }, page)).ok, true);
  const cleanup = { action: 'cleanupGrokRecovery', folder: 'grok-media', sequence: 1,
    mediaId: 'asset_000000001', groupName, oldDownloadId: 90, oldRelativePath,
    newDownloadId: 91 };
  assert.equal((await send({ ...cleanup, oldRelativePath: 'grok-media/other.png' }, page)).status, 'invalid');
  assert.deepEqual(removed, []);
  assert.equal((await send(cleanup, page)).cleanupStatus, 'old-file-removed');
  assert.deepEqual(removed, [90]);
  assert.deepEqual(erased, [90]);
  const progress = await send({ action: 'getGrokProgress', folder: 'grok-media', savePrompts: true }, page);
  assert.equal(progress.records[0].previousRecovery, undefined);
});

test('Grok moves an old sibling recovery file into the in-folder unresolved destination', async () => {
  const oldRelativePath = 'grok-media-recovery/未解析/000001-asset_000000001.png';
  const newRelativePath = 'grok-media/未解析/000001-asset_000000001.png';
  const removed = [];
  const send = worker({ downloadId: 91, removed, downloadStates: new Map([
    [90, { id: 90, state: 'complete', exists: true, filename: `/Downloads/${oldRelativePath}` }],
    [91, { id: 91, state: 'complete', exists: true, filename: `/Downloads/${newRelativePath}` }]
  ]) });
  const page = 'https://grok.com/imagine';
  const saved = await send({ action: 'grokDownload', kind: 'media', folder: 'grok-media',
    savePrompts: true, groupName: '未解析', sequence: 1, mediaId: 'asset_000000001',
    mediaType: 'image', retry: true, name: '000001-asset_000000001.png',
    previousRecovery: { downloadId: 90, relativePath: oldRelativePath },
    url: 'blob:https://grok.com/01234567-89ab-cdef-0123-456789abcdef' }, page);
  assert.equal(saved.relativePath, newRelativePath);
  const cleanup = await send({ action: 'cleanupGrokRecovery', folder: 'grok-media',
    sequence: 1, mediaId: 'asset_000000001', groupName: '未解析', oldDownloadId: 90,
    oldRelativePath, newDownloadId: 91 }, page);
  assert.equal(cleanup.cleanupStatus, 'old-file-removed');
  assert.deepEqual(removed, [90]);
});

test('Grok prompt recovery removes an unresolved file from the same output folder', async () => {
  const groupName = 'p-0123456789abcdef0123456789abcdef-a';
  const oldRelativePath = 'grok-media/未解析/000001-asset_000000001.png';
  const newRelativePath = `grok-media/${groupName}/000001-asset_000000001.png`;
  const removed = [];
  const send = worker({ downloadId: 91, removed, downloadStates: new Map([
    [90, { id: 90, state: 'complete', exists: true, filename: `/Downloads/${oldRelativePath}` }],
    [91, { id: 91, state: 'complete', exists: true, filename: `/Downloads/${newRelativePath}` }]
  ]) });
  const page = 'https://grok.com/imagine';
  assert.equal((await send({ action: 'grokDownload', kind: 'media', folder: 'grok-media',
    savePrompts: true, groupName, sequence: 1, mediaId: 'asset_000000001',
    mediaType: 'image', retry: true, name: '000001-asset_000000001.png',
    previousRecovery: { downloadId: 90, relativePath: oldRelativePath },
    url: 'blob:https://grok.com/01234567-89ab-cdef-0123-456789abcdef' }, page)).ok, true);
  const cleanup = await send({ action: 'cleanupGrokRecovery', folder: 'grok-media',
    sequence: 1, mediaId: 'asset_000000001', groupName, oldDownloadId: 90,
    oldRelativePath, newDownloadId: 91 }, page);
  assert.equal(cleanup.cleanupStatus, 'old-file-removed');
  assert.deepEqual(removed, [90]);
});

test('worker reports failed storage writes/reads rather than claiming saved', async () => {
  const send = worker({ storageError: true });
  assert.equal((await send({ action: 'setDownloadFolder', folder: 'folder' })).error, 'Storage unavailable');
  assert.equal((await send({ action: 'getDownloadFolder' })).error, 'Storage unavailable');
});

test('worker normalizes unsafe, reserved and long Unicode folder names', async () => {
  const send = worker();
  const normalized = await send({ action: 'setDownloadFolder', folder: '..CON' });
  assert.equal(normalized.folder, 'chatgpt-images_CON');
  const unicode = await send({ action: 'setDownloadFolder', folder: '图'.repeat(120) });
  assert.ok(Buffer.byteLength(unicode.folder) <= 180);
});

test('worker rejects missing download IDs and malformed messages', async () => {
  const send = worker({ downloadId: null });
  const result = await send({ action: 'downloadFile', url: 'data:image/png;base64,AA==', name: 'a.png', folder: 'folder' });
  assert.equal(result.ok, false);
  assert.match(result.error, /download ID/);
  assert.equal((await send(null)).ok, false);
});


// Added for 1.4.2; execution is left to the user.
test('only explicit invalid filename errors trigger one safe-name retry', async () => {
  const names = [];
  const send = worker({ downloadHook: (opts, callback, chrome) => {
    names.push(opts.filename);
    delete chrome.runtime.lastError;
    if (names.length === 1) chrome.runtime.lastError = { message: 'Invalid filename' };
    callback(names.length === 1 ? undefined : 7);
    delete chrome.runtime.lastError;
  } });
  const result = await send({ action: 'downloadFile', url: 'data:image/png;base64,AA==',
    name: 'original.png', fallbackName: 'file_abc123.png', folder: 'folder' });
  assert.deepEqual(names, ['folder/original.png', 'folder/file_abc123.png']);
  assert.equal(result.downloadId, 7);
  assert.equal(result.filename, 'file_abc123.png');
  assert.equal(result.filenameFallback, true);
});

test('non-filename download failures are not retried, avoiding duplicate requests', async () => {
  let calls = 0;
  const send = worker({ downloadHook: (_opts, callback, chrome) => {
    calls++; chrome.runtime.lastError = { message: 'Download rejected by browser' };
    callback(); delete chrome.runtime.lastError;
  } });
  const result = await send({ action: 'downloadFile', url: 'data:image/png;base64,AA==', name: 'image.png', folder: 'folder' });
  assert.equal(result.ok, false);
  assert.equal(calls, 1);
});


test('parallel-download preference is bounded and persisted with the folder', async () => {
  const send = worker();
  assert.equal((await send({ action: 'getDownloadFolder' })).concurrency, 'auto');
  const saved = await send({ action: 'setDownloadFolder', folder: 'images', concurrency: 999 });
  assert.equal(saved.concurrency, 12);
  const restored = await send({ action: 'getDownloadFolder' });
  assert.equal(restored.concurrency, 12);
  assert.equal(restored.folder, 'images');
});

test('Auto preference is persisted without coercing it into a manual limit', async () => {
  const send = worker();
  const saved = await send({ action: 'setDownloadFolder', folder: 'images', concurrency: 'auto' });
  assert.equal(saved.concurrency, 'auto');
  assert.equal((await send({ action: 'getDownloadFolder' })).concurrency, 'auto');
});

test('automatic progress waits for disk completion and keeps page, folder, and prompt mode separate', async () => {
  const states = new Map([[12, { id: 12, state: 'in_progress' }]]);
  const send = worker({ downloadId: 12, downloadStates: states });
  const page = 'https://chatgpt.com/images/';
  const tracking = { page, sequence: 3, fileId: 'file_abc123', savePrompts: false };
  assert.equal((await send({ action: 'downloadFile', folder: 'images', name: '000003-image.png',
    url: 'data:image/png;base64,AA==', tracking })).ok, true);
  const query = { action: 'getDownloadProgress', page, folder: 'images', savePrompts: false };
  assert.equal((await send(query)).records[0].status, 'in_progress');
  states.set(12, { id: 12, state: 'complete', exists: true, filename: '/Downloads/images/000003-image.png' });
  assert.equal((await send(query)).records[0].status, 'complete');
  states.set(12, { id: 12, state: 'complete', exists: true, filename: '/Downloads/images/000003-image (1).png' });
  assert.equal((await send(query)).records[0].status, 'complete');
  states.set(12, { id: 12, state: 'complete', exists: true, filename: '/Downloads/other/000003-image.png' });
  assert.notEqual((await send(query)).records[0].status, 'complete');
  states.set(12, { id: 12, state: 'complete', exists: false });
  assert.notEqual((await send(query)).records[0].status, 'complete');
  assert.equal((await send({ ...query, folder: 'other' })).records.length, 0);
  assert.equal((await send({ ...query, savePrompts: true })).records.length, 0);
  assert.equal((await send({ ...query, page: 'https://chatgpt.com/library/d/abc' })).status, 'invalid');
});

test('manual boundary and prompt file progress are stored for automatic resume', async () => {
  const send = worker();
  const page = 'https://chatgpt.com/images/';
  assert.equal((await send({ action: 'setDownloadBaseline', page, folder: 'images',
    savePrompts: true, sequence: 2, fileId: 'file_abc123' })).status, 'saved');
  const groupName = 'p-0123456789abcdef0123456789abcdef-a';
  assert.equal((await send({ action: 'downloadFile', page, folder: 'images', kind: 'prompt',
    groupName, name: 'prompt.txt', conflictAction: 'overwrite',
    url: 'data:text/plain;charset=utf-8,hi', promptTracking: { page, groupName } })).ok, true);
  const response = await send({ action: 'getDownloadProgress', page, folder: 'images', savePrompts: true });
  assert.equal(response.baseline.sequence, 2);
  assert.equal(response.promptRecords[0].groupName, groupName);
  assert.equal(response.promptRecords[0].status, 'complete');
});

test('automatic progress recovers pre-upgrade completed files from the canonical index and Chrome history', async () => {
  const send = worker({ downloadHistory: [
    { id: 41, state: 'complete', exists: true, filename: '/Downloads/images/000001-old.png' },
    { id: 42, state: 'complete', exists: false, filename: '/Downloads/images/000002-old.png' }
  ], downloadStates: new Map([[41, { id: 41, state: 'complete', exists: true,
    filename: '/Downloads/images/000001-old.png' }]]) });
  const page = 'https://chatgpt.com/images/';
  const index = { kind: 'grid-canonical-index', layoutVersion: 2, page, folder: 'images',
    images: [
      { sequence: 1, fileId: 'file_000000001', status: 'available', groupName: null,
        relativePath: 'images/000001-old.png' },
      { sequence: 2, fileId: 'file_000000002', status: 'available', groupName: null,
        relativePath: 'images/000002-old.png' }
    ] };
  assert.equal((await send({ action: 'saveCanonicalIndex', index })).status, 'saved');
  const query = { action: 'getDownloadProgress', page, folder: 'images', savePrompts: false };
  const first = await send(query);
  assert.equal(first.records.length, 1);
  assert.equal(first.records[0].sequence, 1);
  assert.equal(first.records[0].status, 'complete');
  assert.equal((await send(query)).records.length, 1, 'migration is persisted for later runs');
});

test('pre-upgrade prompt groups are recognized only when their TXT download is complete', async () => {
  const groupName = 'p-0123456789abcdef0123456789abcdef-a';
  const imagePath = `images/${groupName}/000001-old.png`;
  const promptPath = `images/${groupName}/prompt.txt`;
  const history = [
    { id: 51, state: 'complete', exists: true, filename: `/Downloads/${imagePath}` },
    { id: 52, state: 'complete', exists: true, filename: `/Downloads/${promptPath}` }
  ];
  const send = worker({ downloadHistory: history,
    downloadStates: new Map(history.map(item => [item.id, item])) });
  const page = 'https://chatgpt.com/images/';
  assert.equal((await send({ action: 'saveCanonicalIndex', index: {
    kind: 'grid-canonical-index', layoutVersion: 2, page, folder: 'images', images: [
      { sequence: 1, fileId: 'file_000000001', status: 'available', groupName,
        promptStatus: 'resolved', relativePath: imagePath }
    ] } })).status, 'saved');
  const progress = await send({ action: 'getDownloadProgress', page, folder: 'images', savePrompts: true });
  assert.equal(progress.records[0].status, 'complete');
  assert.equal(progress.promptRecords[0].groupName, groupName);
  assert.equal(progress.promptRecords[0].status, 'complete');
});

test('prompt retry checkpoints are validated, scoped by page and replaceable', async () => {
  const send = worker();
  const checkpoint = { schemaVersion: 1, kind: 'prompt-retry-results', extensionVersion: '1.9.16',
    createdAt: '2026-09-26T00:00:00Z', page: 'https://chatgpt.com/images/', scope: 'generated-images',
    folder: 'images', images: [{ sequence: 68, fileId: 'file_000000003f9071fdaeb1333ac2b5a412',
      conversationId: '6a0ec392-502c-8332-8013-ca4f1df10cb5',
      sourceDownloadId: 68,
      imageRelativePath: 'images/未解析/000068-example.png', promptStatus: 'unresolved',
      promptError: { code: 'target_not_found', message: 'Missing' } }] };
  assert.equal((await send({ action: 'savePromptRetryCheckpoint', checkpoint })).count, 1);
  assert.equal((await send({ action: 'getPromptRetryCheckpoint', page: checkpoint.page })).checkpoint.images.length, 1);
  assert.equal((await send({ action: 'getPromptRetryCheckpoint', page: 'https://chatgpt.com/library/' })).checkpoint, null);
  assert.equal((await send({ action: 'savePromptRetryCheckpoint', checkpoint: {
    ...checkpoint, images: [{ ...checkpoint.images[0], imageRelativePath: 'images/../escape.png' }]
  } })).status, 'invalid');
  assert.equal((await send({ action: 'savePromptRetryCheckpoint', checkpoint: { ...checkpoint, images: [] },
    processedFileIds: [checkpoint.images[0].fileId] })).count, 0);
  assert.equal((await send({ action: 'getPromptRetryCheckpoint', page: checkpoint.page })).checkpoint, null);
});

test('failed original checkpoints retain exact destination groups and clear recovered identities', async () => {
  const send = worker();
  const checkpoint = { schemaVersion: 1, kind: 'image-retry-checkpoint', extensionVersion: '1.9.18',
    createdAt: '2026-09-27T00:00:00Z', page: 'https://chatgpt.com/images/', scope: 'generated-images',
    folder: 'images', savePrompts: true, images: [{ sequence: 5, fileId: 'file_000000003f9071fdaeb1333ac2b5a412',
      originalName: 'example.png', groupName: 'p-0123456789abcdef0123456789abcdef-a', promptStatus: 'resolved' }] };
  assert.equal((await send({ action: 'saveImageRetryCheckpoint', checkpoint })).count, 1);
  assert.equal((await send({ action: 'getImageRetryCheckpoint', page: checkpoint.page })).checkpoint.images[0].groupName,
    checkpoint.images[0].groupName);
  assert.equal((await send({ action: 'saveImageRetryCheckpoint', checkpoint: { ...checkpoint, images: [] },
    processedFileIds: [checkpoint.images[0].fileId] })).count, 0);
});

test('canonical index is validated, stored by route and folder, and overwritten at a fixed path', async () => {
  const calls = [];
  const send = worker({ downloadHook: (opts, callback) => { calls.push(opts); callback(93); } });
  const index = { kind: 'grid-canonical-index', layoutVersion: 2,
    groupingRuleVersion: 'rule', page: 'https://chatgpt.com/images/', scope: 'generated-images', folder: 'images',
    imageCount: 1, images: [{ sequence: 1, fileId: 'file_000000003f9071fdaeb1333ac2b5a412',
      name: '000001-example.png', relativePath: 'images/p-0123456789abcdef0123456789abcdef-a/000001-example.png',
      status: 'available', groupName: 'p-0123456789abcdef0123456789abcdef-a', promptStatus: 'resolved' }] };
  assert.equal((await send({ action: 'saveCanonicalIndex', index })).count, 1);
  assert.equal((await send({ action: 'getCanonicalIndex', page: index.page, folder: index.folder })).index.images.length, 1);
  const downloaded = await send({ action: 'downloadFile', kind: 'canonical-index', conflictAction: 'overwrite',
    folder: 'images', name: 'grid-index.json', url: 'data:application/json,%7B%7D' });
  assert.equal(downloaded.relativePath, 'images/grid-index.json');
  assert.equal(calls[0].conflictAction, 'overwrite');
});

// Prompt export regression definitions only; not executed during implementation.
test('group paths are constructed from safe integers and images stay uniquify', async () => {
  const calls = [];
  const send = worker({ downloadHook: (opts, callback) => { calls.push(opts); callback(8); } });
  for (const groupNumber of [0, 19, 10000, Number.MAX_SAFE_INTEGER]) {
    const result = await send({ action: 'downloadFile', folder: 'images', groupNumber,
      name: '000001-image.png', url: 'data:image/png;base64,AA==' });
    assert.equal(result.relativePath, `images/${String(groupNumber).padStart(4, '0')}/000001-image.png`);
    assert.equal(result.filename, '000001-image.png');
    assert.equal(calls.at(-1).conflictAction, 'uniquify');
  }
});

test('only fixed UTF-8 prompt.txt inside a numeric group can overwrite', async () => {
  const calls = [];
  const send = worker({ downloadHook: (opts, callback) => { calls.push(opts); callback(9); } });
  const request = { action: 'downloadFile', kind: 'prompt', folder: 'images', groupNumber: 0,
    name: 'prompt.txt', conflictAction: 'overwrite', url: 'data:text/plain;charset=utf-8,%E4%BD%A0%0A' };
  assert.equal((await send(request)).relativePath, 'images/0000/prompt.txt');
  assert.equal(calls[0].conflictAction, 'overwrite');
  assert.equal((await send({ ...request, url: 'data:text/plain;charset=utf-8;base64,YQo=' })).ok, true);
  for (const changes of [
    { groupNumber: undefined }, { groupNumber: -1 }, { groupNumber: 0.5 },
    { groupNumber: '0000' }, { groupNumber: Number.MAX_SAFE_INTEGER + 1 },
    { groupNumber: '../x' }, { name: '../prompt.txt' }, { name: 'other.txt' },
    { folder: 'images/0000' }, { conflictAction: 'uniquify' }, { conflictAction: undefined },
    { kind: undefined }, { url: 'data:text/plain,hello' },
    { url: 'data:text/html;charset=utf-8,hello' }, { url: 'data:image/png;base64,AA==' }
  ]) assert.equal((await send({ ...request, ...changes })).ok, false, JSON.stringify(changes));
  assert.equal(calls.length, 2);
  for (const url of ['data:image/png;base64,AA==', 'data:application/json,%7B%7D']) {
    assert.equal((await send({ action: 'downloadFile', folder: 'images', name: 'a.png',
      url, conflictAction: 'overwrite' })).ok, false);
    assert.equal((await send({ action: 'downloadFile', folder: 'images', name: 'a.png',
      url, overwrite: true })).ok, false);
  }
});

test('content-addressed prompt groups and completed replacement cleanup preserve the final path', async () => {
  const calls = [];
  const send = worker({ downloadHook: (opts, callback) => { calls.push(opts); callback(91); } });
  const groupName = 'p-0123456789abcdef0123456789abcdef-a';
  const prompt = await send({ action: 'downloadFile', kind: 'prompt', folder: 'images', groupName,
    name: 'prompt.txt', conflictAction: 'overwrite', url: 'data:text/plain;charset=utf-8,P' });
  assert.equal(prompt.relativePath, `images/${groupName}/prompt.txt`);
  const image = await send({ action: 'downloadFile', kind: 'relocate-image', conflictAction: 'overwrite',
    folder: 'images', groupName, name: '000068-example.png', replaceDownloadId: 12,
    url: 'data:image/png;base64,AA==' });
  assert.equal(image.relativePath, `images/${groupName}/000068-example.png`);
  assert.equal(image.replacementCompleted, true);
  assert.equal(image.cleanupStatus, 'old-file-removed');
  assert.equal(calls[1].conflictAction, 'overwrite');
});

test('failed-original retry overwrites the exact destination and waits for completion', async () => {
  const calls = [];
  const send = worker({ downloadHook: (opts, callback) => { calls.push(opts); callback(92); } });
  const result = await send({ action: 'downloadFile', kind: 'retry-image', conflictAction: 'overwrite',
    folder: 'images', unresolved: true, name: '000068-example.png', url: 'data:image/png;base64,AA==' });
  assert.equal(result.relativePath, 'images/未解析/000068-example.png');
  assert.equal(result.retryCompleted, true);
  assert.equal(calls[0].conflictAction, 'overwrite');
  const groupName = 'p-0123456789abcdef0123456789abcdef-a';
  const grouped = await send({ action: 'downloadFile', kind: 'retry-image', conflictAction: 'overwrite',
    folder: 'images', groupName, name: '000069-example.png', url: 'data:image/png;base64,AA==' });
  assert.equal(grouped.relativePath, `images/${groupName}/000069-example.png`);
  assert.equal(calls[1].conflictAction, 'overwrite');
});

test('prompt filename rejection has no duplicate-name fallback, image fallback keeps its group', async () => {
  const calls = [];
  const send = worker({ downloadHook: (opts, callback, chrome) => {
    calls.push(opts.filename);
    chrome.runtime.lastError = { message: 'Invalid filename' };
    callback(); delete chrome.runtime.lastError;
  } });
  const result = await send({ action: 'downloadFile', kind: 'prompt', folder: 'images',
    groupNumber: 19, name: 'prompt.txt', conflictAction: 'overwrite',
    url: 'data:text/plain;charset=utf-8,a%0A', fallbackName: 'fallback.json' });
  assert.equal(result.ok, false);
  assert.deepEqual(calls, ['images/0019/prompt.txt']);
  await send({ action: 'downloadFile', folder: 'images', groupNumber: 19,
    name: '000002-image.png', fallbackName: '000002-file_abc123.png', url: 'data:image/png;base64,AA==' });
  assert.deepEqual(calls.slice(1), ['images/0019/000002-image.png', 'images/0019/000002-file_abc123.png']);
});

test('unresolved destination is a fixed image-only folder with no overwrite or arbitrary paths', async () => {
  const calls = [];
  const send = worker({ downloadHook: (options, callback) => { calls.push(options); callback(12); } });
  const request = { action: 'downloadFile', folder: 'images', unresolved: true,
    name: '000002-image.png', url: 'data:image/png;base64,AA==' };
  assert.equal((await send(request)).relativePath, 'images/未解析/000002-image.png');
  assert.equal(calls[0].conflictAction, 'uniquify');
  for (const change of [{ groupNumber: 0 }, { unresolved: '../escape' }, { unresolved: false },
    { conflictAction: 'overwrite' }, { url: 'data:application/json,%7B%7D' },
    { kind: 'prompt', name: 'prompt.txt', url: 'data:text/plain;charset=utf-8,P', conflictAction: 'overwrite' }]) {
    assert.equal((await send({ ...request, ...change })).ok, false);
  }
  assert.equal(calls.length, 1);
});

test('invalid filename retry stays in unresolved and preserves the global prefix', async () => {
  const calls = [];
  const send = worker({ downloadHook: (options, callback, chrome) => {
    calls.push(options.filename);
    if (calls.length === 1) {
      chrome.runtime.lastError = { message: 'Invalid filename' };
      callback(); delete chrome.runtime.lastError;
    } else callback(13);
  } });
  const result = await send({ action: 'downloadFile', folder: 'images', unresolved: true,
    name: '000002-image.png', fallbackName: '000002-file_test.png', url: 'data:image/png;base64,AA==' });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ['images/未解析/000002-image.png', 'images/未解析/000002-file_test.png']);
});
