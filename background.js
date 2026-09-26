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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object' || !sender.url?.startsWith('https://chatgpt.com/')) {
    sendResponse({ ok: false, error: 'Invalid extension request' });
    return false;
  }
  try {
    if (msg.action === 'downloadFile') {
      // Acknowledge actual API acceptance/errors, not just receipt of a message.
      const hasGroup = msg.groupNumber !== undefined;
      const validGroup = hasGroup && Number.isSafeInteger(msg.groupNumber) && msg.groupNumber >= 0;
      const unresolved = msg.unresolved === true;
      const prompt = msg.kind === 'prompt';
      const retryPrompt = msg.kind === 'retry-prompt';
      const validRetrySequence = Number.isSafeInteger(msg.retrySequence) && msg.retrySequence >= 1 && msg.retrySequence <= 999999;
      const validType = typeof msg.url === 'string' && (prompt || retryPrompt
        ? /^data:text\/plain;charset=utf-8(?:;base64)?,/i.test(msg.url)
        : /^data:(?:image\/(?:png|jpeg|webp|gif|avif|bmp)|application\/json)[;,]/i.test(msg.url));
      if (!validType || (hasGroup && !validGroup) ||
          (msg.unresolved !== undefined && !unresolved) ||
          (unresolved && (hasGroup || prompt || (!retryPrompt && !/^data:image\//i.test(msg.url)))) ||
          (retryPrompt && (!unresolved || !validRetrySequence ||
            msg.name !== `${String(msg.retrySequence).padStart(6, '0')}-prompt.txt` || msg.conflictAction !== 'overwrite')) ||
          (!retryPrompt && msg.retrySequence !== undefined) ||
          (prompt ? (!validGroup || msg.name !== 'prompt.txt' || msg.conflictAction !== 'overwrite')
            : (!retryPrompt && msg.conflictAction !== undefined && msg.conflictAction !== 'uniquify')) ||
          msg.overwrite !== undefined ||
          typeof msg.name !== 'string' || !msg.name || /[\\/]/.test(msg.name) ||
          msg.name === '.' || msg.name === '..' ||
          typeof msg.folder !== 'string' || !msg.folder || sanitizeSegment(msg.folder, 'chatgpt-images') !== msg.folder) {
        sendResponse({ ok: false, error: 'Invalid download request' });
        return false;
      }
      const directory = unresolved ? `${msg.folder}/未解析`
        : validGroup ? `${msg.folder}/${String(msg.groupNumber).padStart(4, '0')}` : msg.folder;
      const extension = msg.name.match(/\.(png|jpe?g|webp|gif|avif|bmp|json)$/i)?.[0]?.toLowerCase() ||
        (msg.url.startsWith('data:application/json') ? '.json' : '.bin');
      const fallbackName = typeof msg.fallbackName === 'string' &&
        /^[a-z0-9_-]{1,100}\.(png|jpe?g|webp|gif|avif|bmp|json)$/i.test(msg.fallbackName)
        ? msg.fallbackName : `download-${Date.now().toString(36)}${extension}`;
      const attemptDownload = (name, filenameFallback = false) => {
        const fail = message => {
          // Only repeat an explicitly rejected filename. Never retry an accepted
          // download or an uncertain timeout, which could create duplicate files.
          if (!prompt && !filenameFallback && /invalid filename|filename.*invalid|文件名.*无效/i.test(message)) {
            attemptDownload(fallbackName, true);
          } else sendResponse({ ok: false, error: message });
        };
        try {
          const relativePath = `${directory}/${name}`;
          chrome.downloads.download({ url: msg.url, filename: relativePath,
            conflictAction: prompt || retryPrompt ? 'overwrite' : 'uniquify' }, downloadId => {
            const error = chrome.runtime.lastError;
            if (Number.isInteger(downloadId) && downloadId >= 0) {
              sendResponse({ ok: true, downloadId, filename: name, filenameFallback, relativePath });
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
