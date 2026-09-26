// Regression definitions for importing a prior result without replaying image downloads.
// Do not execute as part of this implementation task.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const retry = require('../prompt-retry.js');

const report = () => ({ schemaVersion: 4, extensionVersion: '1.9.10',
  createdAt: '2026-09-25T00:00:00Z', page: 'https://chatgpt.com/images/',
  scope: 'generated-images', savePrompts: true, images: [
    { sequence: 68, fileId: 'file_000000003f9071fdaeb1333ac2b5a412',
      conversationId: 'untrusted', status: 'queued', groupName: '未解析', promptStatus: 'unresolved',
      promptError: { code: 'target_not_found', message: 'Absent' },
      promptSource: { conversationId: '6a0ec392-502c-8332-8013-ca4f1df10cb5' },
      downloadId: 68,
      name: '000068-example.png', relativePath: 'chatgpt-images-1.9.10/未解析/000068-example.png' },
    { sequence: 69, fileId: 'file_000000003f9071fdaeb1333ac2b5a413',
      status: 'queued', promptStatus: 'resolved' }
  ] });

test('selects only unresolved exact image identities and conversations', () => {
  const plan = retry.plan(report(), 'chatgpt-images-1.9.10', 'https://chatgpt.com/images/');
  assert.equal(plan.entries.length, 1);
  assert.equal(plan.conversationCount, 1);
  assert.equal(plan.entries[0].sequence, 68);
  assert.equal(retry.promptFileName(68), '000068-prompt.txt');
  assert.equal(JSON.stringify(plan).includes('untrusted'), false);
});

test('rejects mismatched page, directory and tampered unresolved paths', () => {
  assert.throws(() => retry.plan(report(), 'other-folder', 'https://chatgpt.com/images/'));
  assert.throws(() => retry.plan(report(), 'chatgpt-images-1.9.10', 'https://chatgpt.com/library/'));
  const altered = report();
  altered.images[0].relativePath = 'chatgpt-images-1.9.10/0000/000068-example.png';
  assert.throws(() => retry.plan(altered, 'chatgpt-images-1.9.10', 'https://chatgpt.com/images/'));
});

test('never accepts duplicate file or sequence identities', () => {
  const altered = report();
  altered.images.push({ ...altered.images[0] });
  assert.throws(() => retry.plan(altered, 'chatgpt-images-1.9.10', 'https://chatgpt.com/images/'));
});

test('a later retry reads only remaining failures from the last retry report', () => {
  const previous = report();
  const failed = previous.images[0];
  const newer = { schemaVersion: 1, kind: 'prompt-retry-results',
    extensionVersion: '1.9.11', createdAt: '2026-09-26T00:00:00Z',
    page: previous.page, scope: previous.scope, folder: 'chatgpt-images-1.9.10',
    images: [
      { sequence: failed.sequence, fileId: failed.fileId,
        conversationId: failed.promptSource.conversationId,
        sourceDownloadId: failed.downloadId,
        imageRelativePath: failed.relativePath, promptStatus: 'unresolved', promptError: failed.promptError },
      { sequence: 69, fileId: 'file_000000003f9071fdaeb1333ac2b5a413',
        conversationId: failed.promptSource.conversationId,
        sourceDownloadId: 69,
        imageRelativePath: 'chatgpt-images-1.9.10/未解析/000069-done.png',
        promptStatus: 'resolved', saveStatus: 'queued' }
    ] };
  assert.deepEqual(retry.plan(newer, newer.folder, newer.page).entries.map(item => item.sequence), [68]);
});
