const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const webcrypto = require('node:crypto').webcrypto;
const promptGroups = require('../prompt-groups.js');

function fixture({ progressRecords = [], imagePayload = null, videoPayload = null, promptsFromConversation = false,
  videoReportedSizeBytes = null, unresolvedFirst = false } = {}) {
  const downloads = [], objectUrls = new Map(), revoked = [], elements = new Map(), cleanupCalls = [];
  const storedProgress = [...progressRecords];
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAaX2RUAAAAAASUVORK5CYII=', 'base64');
  const mp4 = Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0]);
  class TestURL extends URL {
    static createObjectURL(blob) {
      const url = `blob:https://grok.com/01234567-89ab-cdef-0123-${String(objectUrls.size + 1).padStart(12, '0')}`;
      objectUrls.set(url, blob);
      return url;
    }
    static revokeObjectURL(url) { revoked.push(url); }
  }
  const media = [
    { assetId: 'asset_000000001', createTime: '2026-09-01T00:00:00Z', mimeType: 'image/png',
      key: 'users/owner/generated/asset_000000001/image.png',
      fileSource: 'IMAGINE_GENERATED_FILE_SOURCE', mediaGenInput: { textToImage: { prompt: 'Blue mountain' } } },
    { assetId: 'asset_000000002', createTime: '2026-09-02T00:00:00Z', mimeType: 'video/mp4',
      key: 'users/owner/generated/asset_000000002/video.mp4',
      fileSource: 'IMAGINE_GENERATED_FILE_SOURCE', sizeBytes: videoReportedSizeBytes,
      mediaGenInput: { textToVideo: { prompt: 'Move the clouds' } } }
  ];
  if (promptsFromConversation) for (const [index, asset] of media.entries()) {
    asset.mediaGenInput = undefined;
    asset.sourceConversationId = 'conversation_00000001';
    asset.responseId = `output_00000${index + 1}`;
  }
  if (unresolvedFirst) {
    media[0].mediaGenInput = undefined;
    media[0].sourceConversationId = undefined;
  }
  const chrome = { runtime: {
    getManifest: () => ({ version: '2.0.2' }),
    sendMessage(message, callback) {
      if (message.action === 'getGrokProgress') { callback({ status: 'found', records: storedProgress }); return; }
      if (message.action === 'getMediaRetryCheckpoint') { callback({ status: 'missing', checkpoint: null }); return; }
      if (message.action === 'saveMediaRetryCheckpoint') { callback({ status: 'saved' }); return; }
      if (message.action === 'getGrokDownloadState') { callback({ status: 'complete', exists: true }); return; }
      if (message.action === 'grokDownload') {
        downloads.push(message);
        const root = message.groupName === '未解析' ? `${message.folder}/未解析` :
          message.groupName ? `${message.folder}/${message.groupName}` : message.folder;
        const relativePath = `${root}/${message.name}`;
        if (message.kind === 'media') storedProgress.push({ kind: 'media', sequence: message.sequence,
          mediaId: message.mediaId, mediaType: message.mediaType, status: 'complete', relativePath });
        if (message.kind === 'prompt') storedProgress.push({ kind: 'prompt', groupName: message.groupName,
          status: 'complete' });
        callback({ ok: true, downloadId: downloads.length, relativePath });
        return;
      }
      if (message.action === 'cleanupGrokRecovery') {
        cleanupCalls.push(message); callback({ status: 'saved', cleanupStatus: 'old-file-removed' }); return;
      }
      callback({ status: 'invalid' });
    }
  } };
  const context = vm.createContext({
    URL: TestURL, Blob, Response, TextEncoder, crypto: webcrypto, chrome, console,
    location: { pathname: '/imagine', href: 'https://grok.com/imagine' },
    document: { body: { appendChild(node) { node.isConnected = true; elements.set(node.id, node); } },
      createElement() { return { style: {}, remove() { this.isConnected = false; } }; } },
    MutationObserver: class { observe() {} }, window: { addEventListener() {} },
    setInterval: () => 0, clearInterval: () => {}, setTimeout, clearTimeout,
    fetch: async url => {
      const path = new URL(url).pathname;
      if (path === '/rest/assets') return Response.json({ assets: media, nextPageToken: null });
      if (path.endsWith('/responses')) return Response.json({ responses: [
        { responseId: 'user_00000001', sender: 'human', message: 'Blue mountain' },
        { responseId: 'output_000001', parentResponseId: 'user_00000001', sender: 'ASSISTANT',
          fileAttachments: [{ assetId: 'asset_000000001' }] },
        { responseId: 'user_00000002', parentResponseId: 'output_000001', sender: 'human', message: 'Move the clouds' },
        { responseId: 'output_000002', parentResponseId: 'user_00000002', sender: 'assistant',
          fileAttachmentsMetadata: [{ assetId: 'asset_000000002' }] }
      ] });
      if (path.endsWith('image.png')) {
        assert.equal(new URL(url).hostname, 'assets.grok.com');
        return new Response(imagePayload || png, { headers: { 'content-type': 'image/png' } });
      }
      if (path.endsWith('video.mp4')) {
        assert.equal(new URL(url).hostname, 'assets.grok.com');
        return new Response(videoPayload || mp4, { headers: { 'content-type': 'video/mp4' } });
      }
      throw new Error(`Unexpected fetch ${url}`);
    }
  });
  for (const file of ['original-images.js', 'download-queue.js', 'prompt-groups.js',
    'grok-media.js', 'grok-content.js']) vm.runInContext(fs.readFileSync(file, 'utf8'), context);
  return { context, downloads, objectUrls, revoked, png, mp4, elements, cleanupCalls };
}

test('Grok flow saves original image/video bytes, direct prompts, and an explicit result report', async () => {
  const fixtureData = fixture();
  const { context, downloads, objectUrls, revoked, png, mp4, elements } = fixtureData;
  assert.ok(elements.get('grid-grok-export'), 'Grok page should display its export button');
  const report = await context.ChatGPTGrokExport.run('owned', {
    folder: 'grok-media', after: 0, mode: 'auto', images: true, videos: true, prompts: true
  }, () => {});
  assert.equal(report.pagination.provider, 'assets-v2');
  assert.equal(report.discovered, 2);
  assert.equal(report.selected, 2);
  assert.equal(report.queued, 2);
  assert.equal(report.completed, 2);
  assert.equal(report.failed, 0);
  assert.equal(report.promptFilesQueued, 2);
  assert.equal(report.progressAtFinish.completedThrough, 2);
  assert.equal(report.downloadPerformance.mode, 'auto');
  assert.equal(report.downloadPerformance.peakActive, 2);
  const mediaCalls = downloads.filter(item => item.kind === 'media');
  assert.deepEqual(Array.from(report.media, item => item.mediaType), ['image', 'video']);
  const callsByType = new Map(mediaCalls.map(item => [item.mediaType, item]));
  assert.deepEqual(Buffer.from(await objectUrls.get(callsByType.get('image').url).arrayBuffer()), png);
  assert.deepEqual(Buffer.from(await objectUrls.get(callsByType.get('video').url).arrayBuffer()), mp4);
  assert.equal(revoked.length, 2);
  assert.ok(downloads.filter(item => item.kind === 'prompt').every(item => item.name === 'prompt.txt'));
  assert.equal(downloads.at(-1).kind, 'report');
  const exported = JSON.parse(decodeURIComponent(downloads.at(-1).url.split(',').slice(1).join(',')));
  assert.equal(exported.completed, 2);
  assert.doesNotMatch(JSON.stringify(exported), /https:\/\/assets\.grok\.com/);
});

test('manual Grok concurrency one remains serial and keeps media order', async () => {
  const { context } = fixture();
  const report = await context.ChatGPTGrokExport.run('owned', {
    folder: 'grok-media', after: 0, mode: 'manual', images: true, videos: true,
    prompts: false, concurrency: 1
  }, () => {});
  assert.equal(report.downloadPerformance.mode, 'manual');
  assert.equal(report.downloadPerformance.peakActive, 1);
  assert.deepEqual(Array.from(report.media, item => item.sequence), [1, 2]);
});

test('Grok Auto limits planned memory when a video is much larger than an image', async () => {
  const { context } = fixture({ videoReportedSizeBytes: 200 * 1048576 });
  const report = await context.ChatGPTGrokExport.run('owned', {
    folder: 'grok-media', after: 0, mode: 'auto', images: true, videos: true,
    prompts: false, concurrency: 'auto'
  }, () => {});
  assert.equal(report.downloadPerformance.peakActive, 1);
  assert.ok(report.downloadPerformance.peakActiveBytes <= report.downloadPerformance.memoryBudgetBytes);
  assert.equal(report.completed, 2);
});

test('Grok flow recovers missing prompts from the exact Imagine conversation responses', async () => {
  const { context, downloads } = fixture({ promptsFromConversation: true });
  const report = await context.ChatGPTGrokExport.run('owned', {
    folder: 'grok-media', after: 0, mode: 'auto', images: true, videos: true, prompts: true
  }, () => {});
  assert.equal(report.promptCollection.resolved, 2);
  assert.equal(report.promptCollection.unresolved, 0);
  assert.equal(report.promptFilesQueued, 2);
  assert.ok(report.media.every(item => item.promptStatus === 'resolved'));
  assert.ok(downloads.filter(item => item.kind === 'media').every(item => item.groupName?.startsWith('p-')));
});

test('Grok automatic resume skips completed IDs and keeps stable sequence numbers', async () => {
  const { context, downloads } = fixture({ progressRecords: [{ kind: 'media', mediaId: 'asset_000000001',
    mediaType: 'image', status: 'complete', sequence: 1,
    relativePath: 'grok-media/000001-asset_000000001.png' }] });
  const report = await context.ChatGPTGrokExport.run('owned', {
    folder: 'grok-media', after: 0, mode: 'auto', images: true, videos: true, prompts: false
  }, () => {});
  assert.equal(report.selected, 1);
  assert.equal(report.media[0].sequence, 2);
  assert.equal(downloads.filter(item => item.kind === 'media').length, 1);
});

test('Grok prompt mode repairs missing prompt files without redownloading completed media', async () => {
  const imageGroup = promptGroups.groupIdentity('Blue mountain').groupName;
  const videoGroup = promptGroups.groupIdentity('Move the clouds').groupName;
  const { context, downloads } = fixture({ progressRecords: [
    { kind: 'media', sequence: 1, mediaId: 'asset_000000001', mediaType: 'image', status: 'complete',
      relativePath: `grok-media/${imageGroup}/000001-asset_000000001.png` },
    { kind: 'media', sequence: 2, mediaId: 'asset_000000002', mediaType: 'video', status: 'complete',
      relativePath: `grok-media/${videoGroup}/000002-asset_000000002.mp4` }
  ] });
  const report = await context.ChatGPTGrokExport.run('owned', {
    folder: 'grok-media', after: 0, mode: 'auto', images: true, videos: true, prompts: true
  }, () => {});
  assert.equal(report.selected, 0);
  assert.equal(report.promptFilesQueued, 2);
  assert.equal(report.progressAtStart.completedThrough, 2);
  assert.equal(downloads.filter(item => item.kind === 'media').length, 0);
});

test('Grok first-run unresolved media is stored under the chosen folder', async () => {
  const { context, downloads } = fixture({ unresolvedFirst: true });
  const report = await context.ChatGPTGrokExport.run('owned', {
    folder: 'grok-media', after: 0, mode: 'auto', images: true, videos: false, prompts: true
  }, () => {});
  assert.equal(report.media[0].relativePath, 'grok-media/未解析/000001-asset_000000001.png');
  assert.equal(report.media[0].promptStatus, 'unresolved');
  assert.equal(report.status, 'partial');
  assert.equal(downloads.find(item => item.kind === 'media').groupName, '未解析');
});

test('Grok prompt recovery moves a completed media identity out of the recovery folder', async () => {
  const { context, downloads, cleanupCalls } = fixture({ progressRecords: [{
    kind: 'media', sequence: 1, mediaId: 'asset_000000001', mediaType: 'image', status: 'complete',
    downloadId: 90, relativePath: 'grok-media/未解析/000001-asset_000000001.png'
  }] });
  const report = await context.ChatGPTGrokExport.run('owned', {
    folder: 'grok-media', after: 0, mode: 'auto', images: true, videos: false, prompts: true
  }, () => {});
  assert.equal(report.selected, 1);
  assert.equal(report.media[0].cleanupStatus, 'old-file-removed');
  assert.equal(downloads.find(item => item.kind === 'media').retry, true);
  assert.equal(cleanupCalls.length, 1);
  assert.equal(cleanupCalls[0].oldDownloadId, 90);
  assert.equal(downloads.filter(item => item.kind === 'media').length, 1);
});

test('Grok recovered success has the same final media identity and path as first-run success', async () => {
  const options = { folder: 'grok-media', after: 0, mode: 'auto',
    images: true, videos: false, prompts: true };
  const fresh = await fixture().context.ChatGPTGrokExport.run('owned', options, () => {});
  const recovered = await fixture({ progressRecords: [{
    kind: 'media', sequence: 1, mediaId: 'asset_000000001', mediaType: 'image', status: 'complete',
    downloadId: 90, relativePath: 'grok-media/未解析/000001-asset_000000001.png'
  }] }).context.ChatGPTGrokExport.run('owned', options, () => {});
  const stable = item => ({ sequence: item.sequence, mediaId: item.mediaId,
    mediaType: item.mediaType, relativePath: item.relativePath, groupName: item.groupName,
    promptStatus: item.promptStatus, bytes: item.bytes, sha256: item.sha256 });
  assert.deepEqual(stable(recovered.media[0]), stable(fresh.media[0]));
  assert.equal(recovered.media[0].cleanupStatus, 'old-file-removed');
});

test('failed Grok prompt relocation keeps the previous unresolved original in place', async () => {
  const { context, downloads, cleanupCalls } = fixture({
    imagePayload: Buffer.from('<html>not an image</html>'),
    progressRecords: [{ kind: 'media', sequence: 1, mediaId: 'asset_000000001',
      mediaType: 'image', status: 'complete', downloadId: 90,
      relativePath: 'grok-media/未解析/000001-asset_000000001.png' }]
  });
  const report = await context.ChatGPTGrokExport.run('owned', {
    folder: 'grok-media', after: 0, mode: 'auto', images: true, videos: false, prompts: true
  }, () => {});
  assert.equal(report.failed, 1);
  assert.equal(report.media[0].status, 'failed');
  assert.equal(downloads.filter(item => item.kind === 'media').length, 0);
  assert.equal(cleanupCalls.length, 0);
});

test('Grok legacy sibling recovery is moved into the same folder if the prompt remains unresolved', async () => {
  const { context, downloads, cleanupCalls } = fixture({ unresolvedFirst: true, progressRecords: [{
    kind: 'media', sequence: 1, mediaId: 'asset_000000001', mediaType: 'image', status: 'complete',
    downloadId: 90, relativePath: 'grok-media-recovery/未解析/000001-asset_000000001.png'
  }] });
  const report = await context.ChatGPTGrokExport.run('owned', {
    folder: 'grok-media', after: 0, mode: 'auto', images: true, videos: false, prompts: true
  }, () => {});
  assert.equal(report.selected, 1);
  assert.equal(report.media[0].relativePath, 'grok-media/未解析/000001-asset_000000001.png');
  assert.equal(report.media[0].cleanupStatus, 'old-file-removed');
  assert.equal(cleanupCalls[0].groupName, '未解析');
  assert.equal(downloads.filter(item => item.kind === 'media').length, 1);
});

test('Grok rejects mislabeled video bytes, reports partial failure, and saves no preview', async () => {
  const { context, downloads } = fixture({ videoPayload: Buffer.from('<html>login required</html>') });
  const report = await context.ChatGPTGrokExport.run('owned', {
    folder: 'grok-media', after: 0, mode: 'auto', images: true, videos: true, prompts: false
  }, () => {});
  assert.equal(report.completed, 1);
  assert.equal(report.failed, 1);
  assert.match(report.media[1].error, /do not match/);
  assert.equal(downloads.filter(item => item.kind === 'media').length, 1);
  assert.equal(downloads.at(-1).kind, 'report');
});
