const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function page(checkpoint = null) {
  const mounted = new Map(), writes = [];
  const element = id => ({ id, value: ['mode', 'concurrency-mode'].includes(id) ? 'auto' :
    id === 'after' ? '0' : '', checked: ['images', 'videos'].includes(id), hidden: false,
    disabled: false, style: {}, dataset: {}, textContent: '', isConnected: true,
    addEventListener() {}, remove() { this.isConnected = false; },
    showModal() { this.open = true; }, close() { this.open = false; } });
  const document = { body: { appendChild(node) { mounted.set(node.id, node); } },
    createElement() {
      const host = element('');
      host.attachShadow = () => {
        const children = new Map();
        const root = { set innerHTML(html) {
          for (const match of html.matchAll(/\bid="([^"]+)"/g)) children.set(match[1], element(match[1]));
        }, getElementById: id => children.get(id),
        querySelector: selector => selector === 'dialog' ? dialog : null };
        const dialog = element('dialog');
        host.shadowRoot = root;
        return root;
      };
      return host;
    }
  };
  const chrome = { runtime: { getManifest: () => ({ version: '2.0.2' }),
    sendMessage(message, callback) {
      if (message.action === 'getGrokSettings') callback({ status: 'found', folder: 'grok-media', concurrency: 4 });
      else if (message.action === 'getGrokProgress') callback({ status: 'found', records: [] });
      else if (message.action === 'getMediaRetryCheckpoint') callback(checkpoint
        ? { status: 'found', checkpoint } : { status: 'missing', checkpoint: null });
      else if (message.action === 'setGrokSettings') {
        writes.push(message);
        callback({ status: 'saved', folder: message.folder, concurrency: message.concurrency });
      } else callback({ status: 'invalid' });
    } } };
  const context = vm.createContext({ chrome, document, console, URL, TextEncoder, Blob,
    location: { pathname: '/imagine', href: 'https://grok.com/imagine' },
    window: { addEventListener() {} }, MutationObserver: class { observe() {} },
    setTimeout, clearTimeout, setInterval: () => 0 });
  for (const file of ['original-images.js', 'download-queue.js', 'download-progress.js', 'prompt-groups.js', 'media-export-ui.js',
    'grok-media.js', 'grok-content.js']) vm.runInContext(fs.readFileSync(file, 'utf8'), context);
  return { context, mounted, writes };
}

test('Grok settings restore manual concurrency, validate the limit, and persist the selection', async () => {
  const { context, mounted, writes } = page();
  const selection = context.ChatGPTGrokExport.settings('owned');
  await new Promise(setImmediate);
  const root = mounted.get('grid-grok-dialog').shadowRoot;
  const el = id => root.getElementById(id);
  assert.equal(el('concurrency-mode').value, 'manual');
  assert.equal(el('concurrency').value, '4');
  el('concurrency').value = '13';
  await el('start').onclick();
  assert.equal(writes.length, 0);
  assert.match(el('error').textContent, /1–12/);
  el('concurrency').value = '8';
  await el('start').onclick();
  const result = await selection;
  assert.equal(result.concurrency, 8);
  assert.equal(writes[0].concurrency, 8);
});

test('Grok one-click recovery selects only saved failed media and restores its directory', async () => {
  const id = 'asset_000000001';
  const { context, mounted } = page({ schemaVersion: 1, scope: 'owned',
    folder: 'grok-media-retry', failed: [id], unresolved: [] });
  const selection = context.ChatGPTGrokExport.settings('owned');
  await new Promise(setImmediate);
  const el = key => mounted.get('grid-grok-dialog').shadowRoot.getElementById(key);
  assert.equal(el('retry-images').hidden, false);
  el('retry-images').onclick();
  assert.equal(el('folder').value, 'grok-media-retry');
  await el('start').onclick();
  const options = await selection;
  assert.equal(options.mode, 'report');
  assert.deepEqual(Array.from(options.retryIds), [id]);
});
