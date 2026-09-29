const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('Grok and Gemini progress feed the ChatGPT dashboard with separate prompt and media stages', () => {
  const panels = [];
  const context = vm.createContext({ Date, console,
    window: {}, document: {}, MutationObserver: class {} });
  vm.runInContext(fs.readFileSync('download-progress.js', 'utf8'), context);
  context.ChatGPTDownloadProgress.createPanel = options => {
    const panel = { options, states: [], update(state) { this.states.push({ ...state }); }, destroy() {} };
    panels.push(panel);
    return panel;
  };
  vm.runInContext(fs.readFileSync('media-export-ui.js', 'utf8'), context);
  for (const provider of ['Grok', 'Gemini']) {
    const ui = context.GRIDMediaExportUI.progress(provider, () => {}, { concurrency: 'auto' });
    ui.update('正在读取会话', { stage: 'prompts', phase: 'prompts',
      processedConversations: 3, totalConversations: 4, resolvedImages: 7, totalImages: 9,
      promptErrors: 2 });
    ui.update('正在下载', { stage: 'images', phase: 'transferring', total: 2, processed: 1,
      bytes: 1048576, queued: 1, failed: 0, active: 2, limit: 8,
      reason: 'Throughput growing', promptErrors: 2 });
    ui.update('导出完成', { stage: 'images', phase: 'completed with issues', total: 2,
      processed: 2, bytes: 2097152, queued: 2, failed: 0, warnings: 2 });
    ui.finish();
    const panel = panels.at(-1);
    const prompt = panel.states.find(state => state.stage === 'prompts');
    const transfer = panel.states.find(state => state.stage === 'images' && state.processed === 1);
    const done = panel.states.at(-1);
    assert.equal(panel.options.provider, provider);
    assert.equal(panel.options.mediaLabel, provider === 'Grok' ? '媒体' : '图片');
    assert.equal(prompt.resolvedImages, 7);
    assert.equal(prompt.completed, 0);
    assert.equal(transfer.completed, 1);
    assert.equal(transfer.bytes, 1048576);
    assert.ok(transfer.speed > 0);
    assert.equal(transfer.limit, 8);
    assert.equal(transfer.promptErrors, 2);
    assert.equal(done.finished, true);
    assert.equal(done.phase, 'completed with issues');
  }
});
