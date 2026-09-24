const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function page({ pathname = '/images/', sendMessage = (_msg, cb) => cb?.({}), timers = null } = {}) {
  const elements = new Map();
  const observers = [];
  const window = { addEventListener() {} };
  const location = { pathname, href: `https://chatgpt.com${pathname}` };
  const document = {
    body: { appendChild(el) { elements.set(el.id || 'modal', el); } },
    getElementById(id) { return elements.get(id); },
    createElement() {
      const children = new Map();
      return { style: {}, dataset: {}, textContent: '', value: '',
        attachShadow() {
          this.shadowRoot = { innerHTML: '', querySelector: this.querySelector.bind(this) };
          return this.shadowRoot;
        },
        remove() { elements.delete(this.id || 'modal'); },
        querySelector(id) {
          if (!children.has(id)) children.set(id, { value: '', textContent: '',
            attributes: {}, setAttribute(name, value) { this.attributes[name] = value; },
            getAttribute(name) { return this.attributes[name]; },
            focus() {}, select() {}, addEventListener() {}, disabled: false,
            open: false, showModal() { this.open = true; }, close() { this.open = false; } });
          return children.get(id);
        }, addEventListener() {} };
    }
  };
  const chrome = { runtime: { sendMessage } };
  const context = vm.createContext({ document, chrome, location, window, console, URL, Blob,
    setTimeout: timers ? (fn, ms) => { timers.push({ fn, ms }); return timers.length; } : setTimeout,
    clearTimeout, setInterval: () => 0, clearInterval,
    MutationObserver: class { constructor(fn) { observers.push(fn); } observe() {} disconnect() {} }
  });
  vm.runInContext(fs.readFileSync('original-images.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('image-lists.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('download-queue.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('image-numbering.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('download-progress.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('prompt-resolver.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('prompt-groups.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('prompt-conversations.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('content.js', 'utf8'), context);
  return { context, elements, location, observers, chrome };
}

test('native link belonging to a different image must not replace the DOM file ID', () => {
  const { context } = page();
  const card = { textContent: '', querySelector() { return { href: 'https://chatgpt.com/backend-api/files/file_other/download', getAttribute() { return ''; } }; },
    querySelectorAll() { return [1, 2]; } };
  const img = { src: 'https://chatgpt.com/backend-api/estuary/content?id=file_actual%23thumbnail', naturalWidth: 512, naturalHeight: 512,
    closest() { return card; } };
  context.mainFixture = { querySelectorAll() { return [img]; } };
  const entries = vm.runInContext('collectDomCandidates(mainFixture)', context);
  assert.equal(entries[0].fileId, 'file_actual');
  assert.equal(entries[0].candidates.some(c => c.role === 'original'), false);
});

test('worker success without a download ID must be rejected', async () => {
  const { context } = page({ sendMessage: (_msg, cb) => cb({ ok: true }) });
  await assert.rejects(vm.runInContext("requestDownload('data:image/png;base64,AA==', 'a.png', 'folder')", context), /download ID/i);
});

test('missing worker response times out instead of hanging forever', async () => {
  const timers = [];
  const { context } = page({ timers, sendMessage() {} });
  const promise = vm.runInContext("requestDownload('data:image/png;base64,AA==', 'a.png', 'folder')", context);
  assert.ok(timers.some(t => t.ms >= 1000), 'worker call must register a timeout');
  const rejected = assert.rejects(promise, /timed out/i);
  timers.find(t => t.ms >= 1000).fn();
  await rejected;
});

test('folder chooser uses the name accepted by the worker', async () => {
  const { context, elements } = page({ sendMessage: (msg, cb) => {
    cb(msg.action === 'getDownloadFolder' ? { folder: 'default' } : { status: 'saved', folder: 'normalized' });
  } });
  const selection = vm.runInContext('chooseDownloadLocation()', context);
  await new Promise(setImmediate);
  const modal = elements.get('modal');
  modal.querySelector('#bulk-dl-folder').value = '..original';
  await modal.querySelector('#bulk-dl-ok').onclick();
  assert.equal(await selection, 'normalized');
});

test('storage errors keep chooser open with a visible error', async () => {
  const { context, elements, chrome } = page();
  chrome.runtime.sendMessage = (msg, cb) => {
    if (msg.action === 'getDownloadFolder') cb({ folder: 'default' });
    else {
      chrome.runtime.lastError = { message: 'Storage unavailable' };
      cb();
      delete chrome.runtime.lastError;
    }
  };
  let finished = false;
  const selection = vm.runInContext('chooseDownloadLocation()', context).then(() => { finished = true; });
  await new Promise(setImmediate);
  const modal = elements.get('modal');
  await modal.querySelector('#bulk-dl-ok').onclick();
  await new Promise(setImmediate);
  assert.equal(finished, false);
  assert.match(modal.querySelector('#bulk-dl-error').textContent, /Storage unavailable/);
  modal.querySelector('#bulk-dl-cancel').onclick();
  await selection;
});

test('SPA route guard adds, relabels and removes the button on supported routes only', () => {
  const { elements, location, observers } = page({ pathname: '/' });
  assert.equal(elements.has('cgpt-bulk-btn'), false);
  location.pathname = '/images'; location.href = 'https://chatgpt.com/images';
  observers.forEach(fn => fn());
  assert.match(elements.get('cgpt-bulk-btn')?.textContent || '', /Images/);
  location.pathname = '/library/d/abc'; location.href = 'https://chatgpt.com/library/d/abc';
  observers.forEach(fn => fn());
  assert.match(elements.get('cgpt-bulk-btn')?.textContent || '', /Folder/);
  location.pathname = '/c/abc'; location.href = 'https://chatgpt.com/c/abc';
  observers.forEach(fn => fn());
  assert.equal(elements.has('cgpt-bulk-btn'), false);
});

test('DOM fallback scrolls actual vertical scrollers, not overflow-hidden or visible containers', () => {
  const { context } = page();
  const hidden = { scrollTop: 0, scrollHeight: 1000, clientHeight: 100, overflowY: 'hidden' };
  const scroller = { scrollTop: 0, scrollHeight: 1000, clientHeight: 100, overflowY: 'auto' };
  const main = { scrollTop: 0, scrollHeight: 1000, clientHeight: 100, overflowY: 'visible', querySelectorAll: () => [hidden, scroller] };
  const root = { scrollTop: 0, scrollHeight: 2000, clientHeight: 500, overflowY: 'visible' };
  context.document.querySelector = () => main;
  context.document.scrollingElement = root;
  context.getComputedStyle = el => ({ overflowY: el.overflowY });
  const result = vm.runInContext('scrollImageView()', context);
  assert.equal(hidden.scrollTop, 0);
  assert.equal(main.scrollTop, 0);
  assert.ok(scroller.scrollTop > 0);
  assert.ok(root.scrollTop > 0);
  assert.equal(result.atBottom, false);
});


test('folder chooser stores the chosen concurrency and rejects invalid limits', async () => {
  const writes = [];
  const { context, elements } = page({ sendMessage: (msg, cb) => {
    if (msg.action === 'getDownloadFolder') cb({ folder: 'images', concurrency: 4 });
    else { writes.push(msg); cb({ status: 'saved', folder: 'images', concurrency: msg.concurrency }); }
  } });
  const selection = vm.runInContext('chooseDownloadLocation()', context);
  await new Promise(setImmediate);
  const modal = elements.get('modal');
  const input = modal.querySelector('#bulk-dl-concurrency');
  assert.equal(input.value, '4');
  input.value = '13';
  await modal.querySelector('#bulk-dl-ok').onclick();
  assert.equal(writes.length, 0);
  assert.match(modal.querySelector('#bulk-dl-error').textContent, /1 to 12/);
  input.value = '8';
  await modal.querySelector('#bulk-dl-ok').onclick();
  assert.equal(await selection, 'images');
  assert.equal(writes[0].concurrency, 8);
  assert.equal(vm.runInContext('selectedConcurrency', context), 8);
});


test('download boundary is explicit per run and is not sent to persistent preferences', async () => {
  const writes = [];
  const { context, elements } = page({ sendMessage: (msg, cb) => {
    if (msg.action === 'getDownloadFolder') cb({ folder: 'images', concurrency: 6 });
    else { writes.push(msg); cb({ status: 'saved', folder: 'images', concurrency: 6 }); }
  } });
  let selected = vm.runInContext('chooseDownloadLocation()', context);
  await new Promise(setImmediate);
  let modal = elements.get('modal');
  const boundary = modal.shadowRoot.querySelector('#bulk-dl-after');
  assert.equal(boundary.value, '0');
  boundary.value = '1600';
  await modal.shadowRoot.querySelector('#bulk-dl-ok').onclick();
  await selected;
  assert.equal(vm.runInContext('selectedAfterSequence', context), 1600);
  assert.equal(Object.hasOwn(writes[0], 'afterSequence'), false);
  selected = vm.runInContext('chooseDownloadLocation()', context);
  await new Promise(setImmediate);
  modal = elements.get('modal');
  assert.equal(modal.shadowRoot.querySelector('#bulk-dl-after').value, '0');
  modal.shadowRoot.querySelector('#bulk-dl-cancel').onclick();
  await selected;
});

test('保存提示词 is a per-dialog opt-in and never enters stored preferences', async () => {
  const writes = [];
  const { context, elements } = page({ sendMessage: (message, callback) => {
    if (message.action === 'getDownloadFolder') callback({ folder: 'images', concurrency: 6, savePrompts: true });
    else { writes.push(message); callback({ status: 'saved', folder: 'images', concurrency: 6 }); }
  } });
  let selected = vm.runInContext('chooseDownloadLocation()', context);
  await new Promise(setImmediate);
  let modal = elements.get('modal');
  let toggle = modal.shadowRoot.querySelector('#bulk-dl-prompts');
  assert.equal(toggle.getAttribute('aria-pressed'), 'false');
  toggle.onclick();
  assert.equal(toggle.getAttribute('aria-pressed'), 'true');
  await modal.shadowRoot.querySelector('#bulk-dl-ok').onclick();
  await selected;
  assert.equal(vm.runInContext('selectedSavePrompts', context), true);
  assert.equal(Object.hasOwn(writes[0], 'savePrompts'), false);
  selected = vm.runInContext('chooseDownloadLocation()', context);
  await new Promise(setImmediate);
  modal = elements.get('modal');
  toggle = modal.shadowRoot.querySelector('#bulk-dl-prompts');
  assert.equal(toggle.getAttribute('aria-pressed'), 'false');
  assert.equal(vm.runInContext('selectedSavePrompts', context), false);
  modal.shadowRoot.querySelector('#bulk-dl-cancel').onclick();
  await selected;
});
