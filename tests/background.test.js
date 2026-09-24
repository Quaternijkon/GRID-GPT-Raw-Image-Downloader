const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function worker({ storageError = false, downloadId = 1, downloadHook } = {}) {
  let listener;
  const settings = {};
  const chrome = {
    runtime: { onMessage: { addListener(fn) { listener = fn; } }, onInstalled: { addListener() {} } },
    downloads: { download(opts, callback) {
      if (downloadHook) downloadHook(opts, callback, chrome);
      else callback(downloadId);
    } },
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
  const context = vm.createContext({ chrome, console });
  context.importScripts = file => vm.runInContext(fs.readFileSync(file, 'utf8'), context);
  vm.runInContext(fs.readFileSync('background.js', 'utf8'), context);
  return message => new Promise(resolve => listener(message, { url: 'https://chatgpt.com/images' }, resolve));
}

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
