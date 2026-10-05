const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function indexedDBFixture() {
  const records = new Map();
  let created = false, failure = null, closes = 0;
  const db = {
    objectStoreNames: { contains: () => created },
    createObjectStore: () => { created = true; },
    close: () => { closes++; },
    transaction(_name, mode) {
      const transaction = { objectStore: () => ({
        get(folder) {
          const request = {};
          queueMicrotask(() => {
            if (failure === 'read') { transaction.error = new Error('Read failed'); transaction.onabort?.(); return; }
            request.result = records.get(folder); request.onsuccess?.(); transaction.oncomplete?.();
          });
          return request;
        },
        put(record, folder) {
          queueMicrotask(() => {
            if (failure === 'write') { transaction.error = new Error('Write failed'); transaction.onabort?.(); return; }
            assert.equal(mode, 'readwrite'); records.set(folder, structuredClone(record)); transaction.oncomplete?.();
          });
        }
      }) };
      return transaction;
    }
  };
  const indexedDB = { open() {
    const request = {};
    queueMicrotask(() => {
      if (failure === 'open') { request.error = new Error('Open failed'); request.onerror?.(); return; }
      request.result = db;
      if (!created) request.onupgradeneeded?.();
      request.onsuccess?.();
    });
    return request;
  } };
  const context = vm.createContext({ indexedDB, setTimeout, clearTimeout });
  vm.runInContext(fs.readFileSync('media-index-store.js', 'utf8'), context);
  return { store: context.GRIDMediaIndexStore, records, fail: value => { failure = value; }, closes: () => closes };
}

test('IndexedDB stores large root documents without evicting prior roots and waits for transaction completion', async () => {
  const fixture = indexedDBFixture();
  const body = 'x'.repeat(3 * 1048576);
  for (let i = 0; i < 10; i++) await fixture.store.write(`export-${i}`, { document: { body }, publishedExact: true });
  assert.equal((await fixture.store.read('export-0')).document.body.length, body.length);
  assert.equal(fixture.records.size, 10);
  assert.equal(fixture.closes(), 11);
});

test('failed durable open, read and write transactions surface errors and preserve the previous record', async () => {
  const fixture = indexedDBFixture();
  await fixture.store.write('export', { document: { media: ['known'] }, publishedExact: true });
  fixture.fail('write');
  await assert.rejects(fixture.store.write('export', { document: { media: ['partial'] } }), /Write failed/);
  assert.deepEqual(fixture.records.get('export').document.media, ['known']);
  fixture.fail('read'); await assert.rejects(fixture.store.read('export'), /Read failed/);
  fixture.fail('open'); await assert.rejects(fixture.store.read('export'), /Open failed/);
});
