/**
 * Background service worker for GRID GPT Raw Image Downloader.
 *
 * Handles all chrome.downloads calls (required in MV3 for reliable subfolder paths).
 * Also handles showing the default Downloads folder and storing user-chosen folder name.
 */

importScripts('original-images.js');
importScripts('download-queue.js');
const sanitizeSegment = globalThis.ChatGPTOriginalImages.sanitizeSegment;
const normalizeConcurrency = globalThis.ChatGPTDownloadQueue.normalizeConcurrency;

function checkpointPage(value) {
  try {
    const url = new URL(value);
    return url.origin === 'https://chatgpt.com' && /^\/(?:images|library)(?:\/|$)/.test(url.pathname)
      ? url.origin + url.pathname : null;
  } catch (_) { return null; }
}

const checkpointStorageKey = checkpoint => `${checkpointPage(checkpoint.page)}\n${checkpoint.folder}`;

function validPromptRetryCheckpoint(value) {
  if (!value || value.schemaVersion !== 1 || value.kind !== 'prompt-retry-results' ||
      !checkpointPage(value.page) || typeof value.folder !== 'string' ||
      sanitizeSegment(value.folder, 'chatgpt-images') !== value.folder ||
      !Array.isArray(value.images) || value.images.length > 5000) return false;
  const sequences = new Set(), fileIds = new Set();
  return value.images.every(item => {
    const legacyPrefix = `${value.folder}/未解析/${String(item?.sequence).padStart(6, '0')}-`;
    const recoveryPrefix = `${value.folder}-recovery/未解析/${String(item?.sequence).padStart(6, '0')}-`;
    const prefix = typeof item?.imageRelativePath === 'string' && item.imageRelativePath.startsWith(recoveryPrefix)
      ? recoveryPrefix : legacyPrefix;
    const leaf = typeof item?.imageRelativePath === 'string' ? item.imageRelativePath.slice(prefix.length) : '';
    const valid = Number.isSafeInteger(item?.sequence) && item.sequence >= 1 && item.sequence <= 999999 &&
      !sequences.has(item.sequence) && /^file[_-][A-Za-z0-9_-]{8,100}$/.test(item.fileId) &&
      !fileIds.has(item.fileId) && /^[a-f0-9]{8}-[a-f0-9-]{20,60}$/i.test(item.conversationId) &&
      typeof item.imageRelativePath === 'string' && item.imageRelativePath.startsWith(prefix) &&
      leaf && !/[\\/]/.test(leaf) &&
      /\.(?:png|jpe?g|webp|gif|avif|bmp)$/i.test(item.imageRelativePath) &&
      Number.isInteger(item.sourceDownloadId) && item.sourceDownloadId >= 0 &&
      item.promptStatus === 'unresolved' && typeof item.promptError?.code === 'string';
    if (valid) { sequences.add(item.sequence); fileIds.add(item.fileId); }
    return valid;
  });
}

function validImageRetryCheckpoint(value) {
  if (!value || value.schemaVersion !== 1 || value.kind !== 'image-retry-checkpoint' ||
      !checkpointPage(value.page) || typeof value.folder !== 'string' ||
      sanitizeSegment(value.folder, 'chatgpt-images') !== value.folder ||
      !Array.isArray(value.images) || value.images.length > 5000) return false;
  const sequences = new Set(), fileIds = new Set();
  return value.images.every(item => {
    const validGroup = item?.groupName === null || item?.groupName === '未解析' ||
      typeof item?.groupName === 'string' && /^\d{4,}$/.test(item.groupName) ||
      typeof item?.groupName === 'string' && /^p-[0-9a-f]{32}-[0-9a-f]+$/.test(item.groupName);
    const valid = Number.isSafeInteger(item?.sequence) && item.sequence >= 1 && item.sequence <= 999999 &&
      !sequences.has(item.sequence) && /^file[_-][A-Za-z0-9_-]{8,100}$/.test(item.fileId) &&
      !fileIds.has(item.fileId) && typeof item.originalName === 'string' && item.originalName &&
      !/[\\/\x00-\x1f]/.test(item.originalName) && validGroup &&
      ['resolved', 'unresolved'].includes(item.promptStatus) &&
      (item.promptStatus === 'resolved' || typeof item.promptError?.code === 'string') &&
      (item.conversationId === undefined || /^[a-f0-9]{8}-[a-f0-9-]{20,60}$/i.test(item.conversationId));
    if (valid) { sequences.add(item.sequence); fileIds.add(item.fileId); }
    return valid;
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object' || !sender.url?.startsWith('https://chatgpt.com/')) {
    sendResponse({ ok: false, error: 'Invalid extension request' });
    return false;
  }
  try {
    if (msg.action === 'downloadFile') {
      // Acknowledge actual API acceptance/errors, not just receipt of a message.
      const hasGroupNumber = msg.groupNumber !== undefined;
      const hasGroupName = msg.groupName !== undefined;
      const validGroupNumber = hasGroupNumber && Number.isSafeInteger(msg.groupNumber) && msg.groupNumber >= 0;
      const validGroupName = hasGroupName && typeof msg.groupName === 'string' && /^p-[0-9a-f]{32}-[0-9a-f]+$/.test(msg.groupName);
      const hasGroup = hasGroupNumber || hasGroupName;
      const validGroup = (validGroupNumber || validGroupName) && !(hasGroupNumber && hasGroupName);
      const unresolved = msg.unresolved === true;
      const prompt = msg.kind === 'prompt';
      const retryPrompt = msg.kind === 'retry-prompt';
      const retryImage = msg.kind === 'retry-image';
      const relocateImage = msg.kind === 'relocate-image';
      const validRetrySequence = Number.isSafeInteger(msg.retrySequence) && msg.retrySequence >= 1 && msg.retrySequence <= 999999;
      const replaceDownloadId = msg.replaceDownloadId;
      const validReplacement = replaceDownloadId === undefined || Number.isInteger(replaceDownloadId) && replaceDownloadId >= 0;
      const validType = typeof msg.url === 'string' && (prompt || retryPrompt
        ? /^data:text\/plain;charset=utf-8(?:;base64)?,/i.test(msg.url)
        : /^data:(?:image\/(?:png|jpeg|webp|gif|avif|bmp)|application\/json)[;,]/i.test(msg.url));
      if (!validType || (hasGroup && !validGroup) || !validReplacement ||
          (msg.unresolved !== undefined && !unresolved) ||
          (unresolved && (hasGroup || prompt || (!retryPrompt && !/^data:image\//i.test(msg.url)))) ||
          (retryPrompt && (!unresolved || !validRetrySequence ||
            msg.name !== `${String(msg.retrySequence).padStart(6, '0')}-prompt.txt` || msg.conflictAction !== 'overwrite')) ||
          (retryImage && (!/^data:image\//i.test(msg.url) || msg.conflictAction !== 'overwrite')) ||
          (relocateImage && (!/^data:image\//i.test(msg.url) || replaceDownloadId === undefined ||
            !validGroup || msg.conflictAction !== 'overwrite')) ||
          (!retryPrompt && msg.retrySequence !== undefined) ||
          (replaceDownloadId !== undefined && (prompt || retryPrompt || retryImage || unresolved || !validGroup)) ||
          (prompt ? (!validGroup || msg.name !== 'prompt.txt' || msg.conflictAction !== 'overwrite')
            : (!retryPrompt && !retryImage && !relocateImage && msg.conflictAction !== undefined && msg.conflictAction !== 'uniquify')) ||
          msg.overwrite !== undefined ||
          typeof msg.name !== 'string' || !msg.name || /[\\/]/.test(msg.name) ||
          msg.name === '.' || msg.name === '..' ||
          typeof msg.folder !== 'string' || !msg.folder || sanitizeSegment(msg.folder, 'chatgpt-images') !== msg.folder) {
        sendResponse({ ok: false, error: 'Invalid download request' });
        return false;
      }
      const directory = unresolved ? `${msg.folder}-recovery/未解析`
        : validGroupName ? `${msg.folder}/${msg.groupName}`
          : validGroupNumber ? `${msg.folder}/${String(msg.groupNumber).padStart(4, '0')}` : msg.folder;
      const extension = msg.name.match(/\.(png|jpe?g|webp|gif|avif|bmp|json)$/i)?.[0]?.toLowerCase() ||
        (msg.url.startsWith('data:application/json') ? '.json' : '.bin');
      const fallbackName = typeof msg.fallbackName === 'string' &&
        /^[a-z0-9_-]{1,100}\.(png|jpe?g|webp|gif|avif|bmp|json)$/i.test(msg.fallbackName)
        ? msg.fallbackName : `download-${Date.now().toString(36)}${extension}`;
      const attemptDownload = (name, filenameFallback = false) => {
        const fail = message => {
          // Only repeat an explicitly rejected filename. Never retry an accepted
          // download or an uncertain timeout, which could create duplicate files.
          if (!prompt && !retryPrompt && !filenameFallback && /invalid filename|filename.*invalid|文件名.*无效/i.test(message)) {
            attemptDownload(fallbackName, true);
          } else sendResponse({ ok: false, error: message });
        };
        try {
          const relativePath = `${directory}/${name}`;
          chrome.downloads.download({ url: msg.url, filename: relativePath,
            conflictAction: prompt || retryPrompt || retryImage || relocateImage ? 'overwrite' : 'uniquify' }, downloadId => {
            const error = chrome.runtime.lastError;
            if (Number.isInteger(downloadId) && downloadId >= 0) {
              if (replaceDownloadId === undefined && !retryImage) {
                sendResponse({ ok: true, downloadId, filename: name, filenameFallback, relativePath });
                return;
              }
              const startedAt = Date.now();
              const finish = (ok, extra = {}) => sendResponse({ ok, downloadId, filename: name,
                filenameFallback, relativePath, replacedDownloadId: replaceDownloadId, ...extra });
              const abandonStandalone = message => chrome.downloads.cancel(downloadId, () => {
                void chrome.runtime.lastError;
                chrome.downloads.removeFile(downloadId, () => {
                  void chrome.runtime.lastError;
                  chrome.downloads.erase({ id: downloadId }, () => finish(false, { error: message }));
                });
              });
              if (replaceDownloadId === undefined) {
                const pollStandalone = () => chrome.downloads.search({ id: downloadId }, items => {
                  const searchError = chrome.runtime.lastError;
                  const item = items?.[0];
                  if (searchError || !item) { abandonStandalone(searchError?.message || 'Retry download disappeared'); return; }
                  if (item.state === 'complete') { finish(true, { retryCompleted: true }); return; }
                  if (item.state === 'interrupted') { abandonStandalone(item.error || 'Retry download was interrupted'); return; }
                  if (Date.now() - startedAt >= 55000) { abandonStandalone('Retry download did not finish before timeout'); return; }
                  setTimeout(pollStandalone, 250);
                });
                pollStandalone();
                return;
              }
              const removeOld = () => {
                const eraseOld = cleanupStatus => chrome.downloads.erase({ id: replaceDownloadId }, () =>
                  finish(true, { replacementCompleted: true, cleanupStatus }));
                const remove = () => chrome.downloads.removeFile(replaceDownloadId, () => {
                  const removalError = chrome.runtime.lastError;
                  if (removalError) {
                    abandonNew(`Replacement was saved, but the old unresolved file could not be removed: ${removalError.message}`);
                    return;
                  }
                  eraseOld('old-file-removed');
                });
                chrome.downloads.cancel(replaceDownloadId, () => { void chrome.runtime.lastError; remove(); });
              };
              const abandonNew = message => chrome.downloads.cancel(downloadId, () => {
                void chrome.runtime.lastError;
                chrome.downloads.removeFile(downloadId, () => {
                  void chrome.runtime.lastError;
                  chrome.downloads.erase({ id: downloadId }, () => finish(false, { error: message }));
                });
              });
              const poll = () => chrome.downloads.search({ id: downloadId }, items => {
                const searchError = chrome.runtime.lastError;
                const item = items?.[0];
                if (searchError || !item) { abandonNew(searchError?.message || 'Replacement download disappeared'); return; }
                if (item.state === 'complete') { removeOld(); return; }
                if (item.state === 'interrupted') { abandonNew(item.error || 'Replacement download was interrupted'); return; }
                if (Date.now() - startedAt >= 55000) { abandonNew('Replacement download did not finish before timeout'); return; }
                setTimeout(poll, 250);
              });
              poll();
            } else fail(error?.message || 'Chrome returned no download ID');
          });
        } catch (error) { fail(error.message); }
      };
      attemptDownload(msg.name);
      return true;
    }

    if (msg.action === 'showDefaultDownloadsFolder') {
      chrome.downloads.showDefaultFolder();
      sendResponse({ status: 'shown' });
      return false;
    }

    if (msg.action === 'getPromptRetryCheckpoint') {
      const page = checkpointPage(msg.page);
      if (!page) { sendResponse({ status: 'invalid', checkpoint: null }); return false; }
      chrome.storage.local.get(['promptRetryCheckpoints'], res => {
        const error = chrome.runtime.lastError;
        const checkpoint = Object.values(res?.promptRetryCheckpoints || {})
          .filter(item => validPromptRetryCheckpoint(item) && checkpointPage(item.page) === page)
          .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0];
        sendResponse(error ? { status: 'error', error: error.message } :
          { status: checkpoint && validPromptRetryCheckpoint(checkpoint) ? 'found' : 'missing',
            checkpoint: checkpoint && validPromptRetryCheckpoint(checkpoint) ? checkpoint : null });
      });
      return true;
    }

    if (msg.action === 'getImageRetryCheckpoint') {
      const page = checkpointPage(msg.page);
      if (!page) { sendResponse({ status: 'invalid', checkpoint: null }); return false; }
      chrome.storage.local.get(['imageRetryCheckpoints'], res => {
        const error = chrome.runtime.lastError;
        const checkpoint = Object.values(res?.imageRetryCheckpoints || {})
          .filter(item => validImageRetryCheckpoint(item) && checkpointPage(item.page) === page)
          .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0];
        sendResponse(error ? { status: 'error', error: error.message } :
          { status: checkpoint ? 'found' : 'missing', checkpoint: checkpoint || null });
      });
      return true;
    }

    if (msg.action === 'savePromptRetryCheckpoint') {
      const checkpoint = msg.checkpoint;
      const processedFileIds = Array.isArray(msg.processedFileIds) ? msg.processedFileIds : [];
      if (!validPromptRetryCheckpoint(checkpoint) || processedFileIds.length > 5000 ||
          processedFileIds.some(id => typeof id !== 'string' || !/^file[_-][A-Za-z0-9_-]{8,100}$/.test(id)) ||
          new Set(processedFileIds).size !== processedFileIds.length ||
          JSON.stringify(checkpoint).length > 2 * 1024 * 1024) {
        sendResponse({ status: 'invalid', error: 'Invalid prompt retry checkpoint' });
        return false;
      }
      const storageKey = checkpointStorageKey(checkpoint);
      chrome.storage.local.get(['promptRetryCheckpoints'], res => {
        const readError = chrome.runtime.lastError;
        if (readError) { sendResponse({ status: 'error', error: readError.message }); return; }
        const checkpoints = res?.promptRetryCheckpoints && typeof res.promptRetryCheckpoints === 'object'
          ? { ...res.promptRetryCheckpoints } : {};
        const previous = checkpoints[storageKey];
        const processed = new Set(processedFileIds);
        const incomingSequences = new Set(checkpoint.images.map(item => item.sequence));
        const retained = previous && validPromptRetryCheckpoint(previous) && previous.folder === checkpoint.folder
          ? previous.images.filter(item => !processed.has(item.fileId) && !incomingSequences.has(item.sequence)) : [];
        const combinedById = new Map(retained.map(item => [item.fileId, item]));
        for (const item of checkpoint.images) combinedById.set(item.fileId, item);
        const combined = { ...checkpoint, images: [...combinedById.values()].sort((a, b) => a.sequence - b.sequence) };
        if (!validPromptRetryCheckpoint(combined)) {
          sendResponse({ status: 'invalid', error: 'Merged prompt retry checkpoint is invalid' });
          return;
        }
        if (combined.images.length) checkpoints[storageKey] = combined;
        else delete checkpoints[storageKey];
        const ordered = Object.entries(checkpoints).sort((a, b) =>
          String(b[1]?.createdAt || '').localeCompare(String(a[1]?.createdAt || ''))).slice(0, 10);
        chrome.storage.local.set({ promptRetryCheckpoints: Object.fromEntries(ordered) }, () => {
          const error = chrome.runtime.lastError;
          sendResponse(error ? { status: 'error', error: error.message } :
            { status: 'saved', count: combined.images.length });
        });
      });
      return true;
    }

    if (msg.action === 'saveImageRetryCheckpoint') {
      const checkpoint = msg.checkpoint;
      const processedFileIds = Array.isArray(msg.processedFileIds) ? msg.processedFileIds : [];
      if (!validImageRetryCheckpoint(checkpoint) || processedFileIds.length > 5000 ||
          processedFileIds.some(id => typeof id !== 'string' || !/^file[_-][A-Za-z0-9_-]{8,100}$/.test(id)) ||
          new Set(processedFileIds).size !== processedFileIds.length ||
          JSON.stringify(checkpoint).length > 2 * 1024 * 1024) {
        sendResponse({ status: 'invalid', error: 'Invalid image retry checkpoint' });
        return false;
      }
      const storageKey = checkpointStorageKey(checkpoint);
      chrome.storage.local.get(['imageRetryCheckpoints'], res => {
        const readError = chrome.runtime.lastError;
        if (readError) { sendResponse({ status: 'error', error: readError.message }); return; }
        const checkpoints = res?.imageRetryCheckpoints && typeof res.imageRetryCheckpoints === 'object'
          ? { ...res.imageRetryCheckpoints } : {};
        const previous = checkpoints[storageKey];
        const processed = new Set(processedFileIds);
        const incomingSequences = new Set(checkpoint.images.map(item => item.sequence));
        const retained = previous && validImageRetryCheckpoint(previous) && previous.folder === checkpoint.folder
          ? previous.images.filter(item => !processed.has(item.fileId) && !incomingSequences.has(item.sequence)) : [];
        const combinedById = new Map(retained.map(item => [item.fileId, item]));
        for (const item of checkpoint.images) combinedById.set(item.fileId, item);
        const combined = { ...checkpoint, images: [...combinedById.values()].sort((a, b) => a.sequence - b.sequence) };
        if (!validImageRetryCheckpoint(combined)) {
          sendResponse({ status: 'invalid', error: 'Merged image retry checkpoint is invalid' });
          return;
        }
        if (combined.images.length) checkpoints[storageKey] = combined;
        else delete checkpoints[storageKey];
        const ordered = Object.entries(checkpoints).sort((a, b) =>
          String(b[1]?.createdAt || '').localeCompare(String(a[1]?.createdAt || ''))).slice(0, 10);
        chrome.storage.local.set({ imageRetryCheckpoints: Object.fromEntries(ordered) }, () => {
          const error = chrome.runtime.lastError;
          sendResponse(error ? { status: 'error', error: error.message } :
            { status: 'saved', count: combined.images.length });
        });
      });
      return true;
    }

    if (msg.action === 'getDownloadFolder') {
      chrome.storage.local.get(['downloadFolder', 'downloadConcurrency'], (res) => {
        const error = chrome.runtime.lastError;
        sendResponse(error ? { ok: false, error: error.message } :
          { folder: sanitizeSegment(res?.downloadFolder, 'chatgpt-images'),
            concurrency: normalizeConcurrency(res?.downloadConcurrency) });
      });
      return true;
    }

    if (msg.action === 'setDownloadFolder') {
      if (typeof msg.folder !== 'string') {
        sendResponse({ status: 'invalid', error: 'Invalid folder name' });
        return false;
      }
      const newFolder = sanitizeSegment(msg.folder, 'chatgpt-images');
      const concurrency = normalizeConcurrency(msg.concurrency);
      chrome.storage.local.set({ downloadFolder: newFolder, downloadConcurrency: concurrency }, () => {
        const error = chrome.runtime.lastError;
        sendResponse(error ? { status: 'error', error: error.message } : { status: 'saved', folder: newFolder, concurrency });
      });
      return true;
    }

    sendResponse({ status: 'unknown' });
    return false;
  } catch (error) {
    sendResponse({ ok: false, error: error.message });
    return false;
  }
});

chrome.runtime.onInstalled.addListener(() => {
  console.log('[GRID BG] Service worker installed/updated');
});
