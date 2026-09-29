// Regression definitions only; not executed during the 1.8.0 implementation.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function panelFixture(now = () => Date.now()) {
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
  return { panel: context.ChatGPTDownloadProgress.createPanel({ now }), get: id => elements.get(id) };
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
    assert.equal(get('prompt-error-count').textContent, '1 条提示词未解析');
    assert.equal(get('prompt-save-error-count').textContent, '2 个提示词文件保存失败');
    assert.doesNotMatch(get('compact').textContent, /MiB\/s|ETA/);
    assert.equal(get('track').attributes['aria-label'], '提示词恢复进度');
    panel.destroy();
  });
}

test('image stage restores transfer dashboard and retains separate prompt-save failures', () => {
  let time = 0;
  const { panel, get } = panelFixture(() => time);
  panel.update({ stage: 'prompt-save', totalImages: 3, resolvedImages: 3, promptSaveErrors: 1 });
  panel.update({ stage: 'images', total: 2, completed: 1, bytes: 1048576 });
  time = 1000;
  panel.update({ stage: 'images', total: 2, completed: 2, bytes: 2097152 });
  assert.equal(get('chart').attributes.hidden, undefined);
  assert.equal(get('transfer-stats').hidden, false);
  assert.equal(get('prompt-stats').hidden, true);
  assert.equal(get('prompt-errors').hidden, false);
  assert.equal(get('count').textContent, '2');
  assert.equal(get('speed').textContent, '1.0 MiB/s');
  assert.match(get('compact').textContent, /MiB\/s/);
  assert.equal(get('track').attributes['aria-label'], '图片任务进度');
  panel.destroy();
});

test('blocked prompt stage exposes failure and permits closing without claiming image completion', () => {
  const { panel, get } = panelFixture();
  panel.update({ stage: 'prompts', phase: 'blocked', finished: true,
    totalImages: 10, resolvedImages: 9, promptErrors: 1 });
  assert.equal(get('phase').textContent, '已阻止');
  assert.equal(get('close').disabled, false);
  assert.equal(get('percent').textContent, '90.0%');
  assert.match(get('compact').textContent, /已阻止/);
  assert.doesNotMatch(get('compact').textContent, /MiB\/s/);
  panel.destroy();
});

test('unknown list size and zero alerts do not masquerade as completed downloads', () => {
  const { panel, get } = panelFixture();
  panel.update({ stage: 'collecting', phase: 'collecting', completed: 0 });
  assert.equal(get('count').textContent, '正在建立任务清单');
  assert.equal(get('track').hidden, true);
  assert.equal(get('status').hidden, true);
  assert.equal(get('forecast-block').hidden, true);
  panel.update({ stage: 'images', phase: 'transferring', total: 10, completed: 1, failed: 1 });
  assert.equal(get('failed').hidden, false);
  assert.equal(get('alert').hidden, false);
  assert.match(get('eta').textContent, /计算中/);
  panel.destroy();
});

test('forecast and optional concurrency details use processed tasks without claiming disk completion', () => {
  let time = 0;
  const { panel, get } = panelFixture(() => time);
  panel.update({ stage: 'images', phase: 'transferring', total: 12, completed: 0,
    bytes: 0, active: 4, limit: 8 });
  for (let count = 1; count <= 5; count++) {
    time += 3000;
    panel.update({ stage: 'images', phase: 'transferring', total: 12,
      completed: count, bytes: count * 1048576, active: 4, limit: 6 });
  }
  assert.equal(get('forecast-block').hidden, false);
  assert.match(get('finish-time').textContent, /预计本轮处理至/);
  assert.equal(get('advanced').hidden, false);
  assert.match(get('worker-target').attributes.points, /,/);
  assert.equal(get('queue-done-label').textContent, '已处理 5');
  assert.equal(get('queue-working-label').textContent, '处理中 4');
  assert.equal(get('queue-pending-label').textContent, '待处理 3');
  assert.match(get('queue-bar').attributes['aria-label'], /已处理 5/);
  panel.update({ phase: 'cooldown', retrying: 1 });
  assert.equal(get('forecast-block').hidden, true);
  assert.equal(get('eta').textContent, '等待恢复');
  panel.destroy();
});
