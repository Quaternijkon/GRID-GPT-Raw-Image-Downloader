const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('Gemini one-click unresolved recovery uses the saved folder and prompt mode', async () => {
  const id = `rc_${'a'.repeat(16)}`;
  const mounted = new Map();
  const element = key => ({ id: key, dataset: {}, style: {}, hidden: false, checked: false,
    value: ['mode', 'concurrency-mode'].includes(key) ? 'auto' : key === 'after' ? '0' : '',
    textContent: '', addEventListener() {}, showModal() { this.open = true; },
    close() { this.open = false; }, remove() {} });
  const document = { body: { appendChild(node) { mounted.set(node.id, node); } },
    createElement() {
      const host = element('');
      host.attachShadow = () => {
        const children = new Map(), dialog = element('dialog');
        const root = { set innerHTML(html) {
          for (const match of html.matchAll(/\bid="([^"]+)"/g)) children.set(match[1], element(match[1]));
        }, getElementById: key => children.get(key),
        querySelector: selector => selector === 'dialog' ? dialog : null };
        host.shadowRoot = root;
        return root;
      };
      return host;
    } };
  const chrome = { runtime: { sendMessage(message, callback) {
    if (message.action === 'getGeminiSettings') return callback({ status: 'found', folder: 'gemini-images', concurrency: 'auto' });
    if (message.action === 'getGeminiProgress') return callback({ status: 'found', records: [] });
    if (message.action === 'getMediaRetryCheckpoint') return callback({ status: 'found', checkpoint: {
      schemaVersion: 1, scope: 'library', folder: 'gemini-retry', failed: [], unresolved: [id] } });
    if (message.action === 'setGeminiSettings') return callback({ status: 'saved',
      folder: message.folder, concurrency: message.concurrency });
    callback({ status: 'invalid', error: `Unexpected action ${message.action}` });
  } } };
  const context = vm.createContext({ chrome, document, console, URL, TextEncoder,
    location: { pathname: '/library', href: 'https://gemini.google.com/library' },
    window: { addEventListener() {} }, MutationObserver: class { observe() {} disconnect() {} },
    setTimeout, clearTimeout, setInterval: () => 0,
    GRIDGeminiMedia: { supported: () => true } });
  for (const file of ['original-images.js', 'download-queue.js', 'download-progress.js',
    'prompt-groups.js', 'media-export-ui.js', 'gemini-content.js'])
    vm.runInContext(fs.readFileSync(file, 'utf8'), context);
  const selection = context.GRIDGeminiExport.settings();
  await new Promise(setImmediate);
  const el = key => mounted.get('grid-gemini-dialog').shadowRoot.getElementById(key);
  assert.equal(el('retry-prompts').hidden, false);
  el('retry-prompts').onclick();
  assert.equal(el('folder').value, 'gemini-retry');
  assert.equal(el('prompts').checked, true);
  await el('start').onclick();
  const options = await selection;
  assert.equal(options.mode, 'report');
  assert.deepEqual(Array.from(options.retryIds), [id]);
});
