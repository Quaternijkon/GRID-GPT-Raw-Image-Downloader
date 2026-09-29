const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('Gemini flow resumes by verified identity and writes grouped image, prompt, and report', async () => {
  const downloads = [];
  const first = { id: `rc_${'a'.repeat(16)}`, chatId: `c_${'1'.repeat(16)}`,
    responseId: `r_${'1'.repeat(16)}`, sequence: 1, prompt: 'First prompt' };
  const second = { id: `rc_${'b'.repeat(16)}`, chatId: `c_${'2'.repeat(16)}`,
    responseId: `r_${'2'.repeat(16)}`, sequence: 2, prompt: 'Second prompt' };
  const groups = require('../prompt-groups.js');
  const firstGroup = groups.groupIdentity(first.prompt).groupName;
  const progress = [{ kind: 'media', mediaId: first.id, sequence: 1, status: 'complete',
    relativePath: `gemini-images/${firstGroup}/000001-${first.id}.png` }];
  const chrome = { runtime: { getManifest: () => ({ version: '3.0.0' }), sendMessage(message, callback) {
    if (message.action === 'getGeminiProgress') return callback({ status: 'found', records: progress });
    if (message.action === 'getGeminiDownloadState') return callback({ status: 'complete', exists: true });
    if (message.action === 'geminiDownload') {
      downloads.push(message);
      const path = `${message.folder}/${message.groupName ? `${message.groupName}/` : ''}${message.kind === 'media'
        ? `000002-${message.mediaId}.png` : message.name}`;
      if (message.kind === 'media') progress.push({ kind: 'media', mediaId: message.mediaId,
        sequence: message.sequence, status: 'complete', relativePath: path });
      if (message.kind === 'prompt') progress.push({ kind: 'prompt', groupName: message.groupName,
        status: 'complete', relativePath: path });
      callback({ ok: true, downloadId: downloads.length, relativePath: path, bytes: 123,
        mimeType: 'image/png', sha256: 'a'.repeat(64), sourceHost: 'lh3.googleusercontent.com',
        retrievalAttempts: 2 });
    }
  } } };
  const mounted = [];
  const context = vm.createContext({ chrome, console, URL, TextEncoder, navigator: {}, fetch: async () => {
    throw new Error('Unexpected direct fetch');
  },
    location: { href: 'https://gemini.google.com/library', pathname: '/library' },
    document: { body: { appendChild(node) { node.isConnected = true; mounted.push(node); } },
      createElement() { return { style: {}, remove() { this.isConnected = false; } }; } },
    window: { addEventListener() {} }, MutationObserver: class { observe() {} },
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
    GRIDGeminiMedia: { supported: () => true, collect: async () => ({ entries: [first, second],
      token: 'secret', pagination: { complete: true, pages: 1, images: 2 } }),
    resolvePrompts: async () => ({ chats: 2, resolved: 2, unresolved: 0, failures: [] }) },
    GRIDMediaExportUI: {} });
  for (const file of ['original-images.js', 'download-queue.js', 'prompt-groups.js', 'gemini-content.js'])
    vm.runInContext(fs.readFileSync(file, 'utf8'), context);
  assert.equal(mounted[0].id, 'grid-gemini-export');
  const report = await context.GRIDGeminiExport.run({ folder: 'gemini-images', after: 0,
    mode: 'auto', prompts: true, concurrency: 'auto' }, () => {});
  assert.equal(report.selected, 1);
  assert.equal(report.completed, 1);
  assert.equal(report.failed, 0);
  assert.equal(report.progressAtFinish.completedThrough, 2);
  assert.equal(report.downloadPerformance.mode, 'auto');
  assert.deepEqual(downloads.filter(item => item.kind === 'media').map(item => item.mediaId), [second.id]);
  assert.equal(downloads.find(item => item.kind === 'media').groupName,
    groups.groupIdentity(second.prompt).groupName);
  assert.equal(downloads.at(-1).kind, 'report');
});
