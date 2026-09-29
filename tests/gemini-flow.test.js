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
    if (message.action === 'getMediaRetryCheckpoint') return callback({ status: 'missing', checkpoint: null });
    if (message.action === 'saveMediaRetryCheckpoint') return callback({ status: 'saved' });
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

test('Gemini relocation converges on the one-shot folder layout after an interrupted cleanup', async () => {
  const groups = require('../prompt-groups.js');
  const entry = { id: `rc_${'a'.repeat(16)}`, chatId: `c_${'1'.repeat(16)}`,
    responseId: `r_${'1'.repeat(16)}`, sequence: 1, prompt: 'Exact recovered prompt' };
  const groupName = groups.groupIdentity(entry.prompt).groupName;
  const oldPath = `gemini-images/未解析/000001-${entry.id}.png`;
  const groupedPath = `gemini-images/${groupName}/000001-${entry.id}.png`;
  const promptPath = `gemini-images/${groupName}/prompt.txt`;
  const reportPath = 'gemini-images/gemini-download-results.json';
  const files = new Set([oldPath]);
  const records = [{ kind: 'media', mediaId: entry.id, sequence: 1, status: 'complete',
    downloadId: 90, relativePath: oldPath }];
  const mediaCalls = [], cleanupCalls = [];
  let failCleanup = true, missingPrompt = false, nextId = 90;
  const chrome = { runtime: { getManifest: () => ({ version: '3.0.3' }), sendMessage(message, callback) {
    if (message.action === 'getMediaRetryCheckpoint') return callback({ status: 'missing', checkpoint: null });
    if (message.action === 'saveMediaRetryCheckpoint') return callback({ status: 'saved' });
    if (message.action === 'getGeminiProgress') return callback({ status: 'found', records: records.map(x => ({ ...x })) });
    if (message.action === 'getGeminiDownloadState') return callback({ status: 'complete', exists: true });
    if (message.action === 'geminiDownload') {
      nextId++;
      if (message.kind === 'media') {
        mediaCalls.push(message);
        files.add(groupedPath);
        records[0] = { kind: 'media', mediaId: entry.id, sequence: 1, status: 'complete',
          downloadId: nextId, relativePath: groupedPath, previousRecovery: message.previousRecovery };
        return callback({ ok: true, downloadId: nextId, relativePath: groupedPath,
          bytes: 100, mimeType: 'image/png', sha256: 'a'.repeat(64) });
      }
      if (message.kind === 'prompt') {
        files.add(promptPath);
        records.push({ kind: 'prompt', groupName, status: 'complete', downloadId: nextId,
          relativePath: promptPath });
        return callback({ ok: true, downloadId: nextId, relativePath: promptPath });
      }
      files.add(reportPath);
      return callback({ ok: true, downloadId: nextId, relativePath: reportPath });
    }
    if (message.action === 'cleanupGeminiRecovery') {
      cleanupCalls.push(message);
      if (failCleanup) return callback({ status: 'error', error: 'Cleanup interrupted' });
      files.delete(oldPath);
      delete records[0].previousRecovery;
      return callback({ status: 'cleaned', cleanupStatus: 'old-file-removed' });
    }
    callback({ status: 'invalid', error: `Unexpected action ${message.action}` });
  } } };
  const context = vm.createContext({ chrome, console, URL, TextEncoder, navigator: {}, fetch: async () => {
    throw new Error('Unexpected direct fetch');
  }, location: { href: 'https://gemini.google.com/library', pathname: '/library' },
  document: { body: { appendChild(node) { node.isConnected = true; } },
    createElement() { return { style: {}, remove() { this.isConnected = false; } }; } },
  window: { addEventListener() {} }, MutationObserver: class { observe() {} },
  setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
  GRIDGeminiMedia: { supported: () => true, collect: async () => ({ entries: [entry], token: 'secret',
    pagination: { complete: true, pages: 1, images: 1 } }),
    resolvePrompts: async () => ({ chats: 1, resolved: missingPrompt ? 0 : 1,
      unresolved: missingPrompt ? 1 : 0, failures: [] }) }, GRIDMediaExportUI: {} });
  for (const file of ['original-images.js', 'download-queue.js', 'prompt-groups.js', 'gemini-content.js'])
    vm.runInContext(fs.readFileSync(file, 'utf8'), context);
  const options = { folder: 'gemini-images', after: 0, mode: 'auto', prompts: true, concurrency: 'auto' };
  const first = await context.GRIDGeminiExport.run(options, () => {});
  assert.equal(first.selected, 1);
  assert.equal(first.images[0].cleanupStatus, 'failed');
  assert.equal(first.layoutIssues, 1);
  assert.equal(first.status, 'partial');
  assert.equal(mediaCalls[0].previousRecovery.relativePath, oldPath);
  assert.deepEqual([...files].sort(), [groupedPath, oldPath, promptPath, reportPath].sort());

  failCleanup = false;
  const second = await context.GRIDGeminiExport.run(options, () => {});
  assert.equal(second.selected, 0);
  assert.equal(second.recoveryCleanup[0].status, 'old-file-removed');
  assert.equal(second.layoutIssues, 0);
  assert.equal(second.status, 'complete');
  assert.equal(mediaCalls.length, 1);
  assert.equal(cleanupCalls.length, 2);
  assert.deepEqual([...files].sort(), [groupedPath, promptPath, reportPath].sort());

  missingPrompt = true;
  entry.prompt = null;
  const third = await context.GRIDGeminiExport.run(options, () => {});
  assert.equal(third.selected, 0);
  assert.equal(third.status, 'partial');
  assert.equal(third.unresolvedPrompts, 1);
  assert.equal(mediaCalls.length, 1);
  assert.deepEqual([...files].sort(), [groupedPath, promptPath, reportPath].sort());
});
