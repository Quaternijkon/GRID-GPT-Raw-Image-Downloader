// Regression definitions only; not executed during the 1.8.0 implementation.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function panelFixture() {
  const elements = new Map();
  function element() {
    return { style: {}, dataset: {}, attributes: {}, textContent: '', hidden: false,
      setAttribute(name, value) { this.attributes[name] = value; },
      removeAttribute(name) { delete this.attributes[name]; }, remove() {} };
  }
  const root = { set innerHTML(html) {
    for (const match of html.matchAll(/\bid="([^"]+)"/g)) elements.set(match[1], element());
  }, getElementById: id => elements.get(id) };
  const host = { ...element(), attachShadow: () => root };
  const context = { document: { createElement: () => host, documentElement: {}, body: { appendChild() {} } },
    window: {}, MutationObserver: class { observe() {} disconnect() {} } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../download-progress.js'), 'utf8'), context);
  return { panel: context.ChatGPTDownloadProgress.createPanel(), get: id => elements.get(id) };
}

for (const stage of ['prompts', 'grouping', 'prompt-save']) {
  test(`${stage} shows prompt progress without image network statistics`, () => {
    const { panel, get } = panelFixture();
    panel.update({ stage, totalImages: 1602, resolvedImages: 1600,
      processedConversations: 399, totalConversations: 400, groupCount: 121,
      selectedGroupCount: 2, total: 2, speed: 1048576, etaMs: 1000,
      promptErrors: [{ code: 'unsupported_mapping' }], promptSaveErrors: 2 });
    assert.equal(get('chart').attributes.hidden, '');
    assert.equal(get('transfer-stats').hidden, true);
    assert.equal(get('prompt-stats').hidden, false);
    assert.equal(get('conversations').textContent, '399 / 400');
    assert.equal(get('groups').textContent, '121 / 2');
    assert.equal(get('selected-images').textContent, '2');
    assert.equal(get('prompt-error-count').textContent, '1 prompt resolution errors');
    assert.equal(get('prompt-save-error-count').textContent, '2 prompt save errors');
    assert.doesNotMatch(get('compact').textContent, /MiB\/s|ETA/);
    assert.equal(get('track').attributes['aria-label'], 'Image prompts resolved');
    panel.destroy();
  });
}

test('image stage restores transfer dashboard and retains separate prompt-save failures', () => {
  const { panel, get } = panelFixture();
  panel.update({ stage: 'prompt-save', totalImages: 3, resolvedImages: 3, promptSaveErrors: 1 });
  panel.update({ stage: 'images', total: 2, completed: 1, speed: 1048576, etaMs: 1000 });
  assert.equal(get('chart').attributes.hidden, undefined);
  assert.equal(get('transfer-stats').hidden, false);
  assert.equal(get('prompt-stats').hidden, true);
  assert.equal(get('prompt-errors').hidden, false);
  assert.equal(get('count').textContent, '1');
  assert.equal(get('speed').textContent, '1.0 MiB/s');
  assert.match(get('compact').textContent, /MiB\/s/);
  assert.equal(get('track').attributes['aria-label'], 'Image tasks processed');
  panel.destroy();
});

test('blocked prompt stage exposes failure and permits closing without claiming image completion', () => {
  const { panel, get } = panelFixture();
  panel.update({ stage: 'prompts', phase: 'blocked', finished: true,
    totalImages: 10, resolvedImages: 9, promptErrors: 1 });
  assert.equal(get('phase').textContent, 'BLOCKED');
  assert.equal(get('close').disabled, false);
  assert.equal(get('percent').textContent, '90.0%');
  assert.match(get('compact').textContent, /blocked/);
  assert.doesNotMatch(get('compact').textContent, /MiB\/s/);
  panel.destroy();
});
