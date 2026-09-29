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
const GROK_ID = /^[A-Za-z0-9_-]{8,128}$/;
const GROK_GROUP = /^p-[0-9a-f]{32}-[0-9a-f]+$/;
const grokProgressPrefix = (scope, folder, savePrompts) =>
  `grokDownloadProgress:${scope}\n${folder}\n${savePrompts ? 'prompts' : 'media'}\n`;
function grokRecoveryPath(relativePath, folder, sequence, mediaId, legacyOnly = false) {
  if (typeof relativePath !== 'string') return false;
  const leaf = `${String(sequence).padStart(6, '0')}-${String(mediaId).slice(0, 32)}.`;
  const roots = legacyOnly ? [`${folder}-recovery/未解析/`] :
    [`${folder}/未解析/`, `${folder}-recovery/未解析/`];
  return roots.some(root => relativePath.startsWith(root + leaf) &&
    /^(?:png|jpe?g|webp|gif|avif|mp4|webm)$/i.test(relativePath.slice((root + leaf).length)));
}
const grokBlobUrl = value => typeof value === 'string' &&
  (new RegExp(`^blob:(?:https://grok\\.com|chrome-extension://${chrome.runtime.id || 'GRID_EXTENSION_ID'})/[0-9a-f-]{36}$`, 'i')).test(value);
const grokPageScope = url => {
  try {
    const page = new URL(url);
    if (page.origin !== 'https://grok.com' || !/^\/imagine(?:\/|$)/.test(page.pathname)) return null;
    return /^\/imagine\/(?:saved|favorites)(?:\/|$)/.test(page.pathname) ? 'liked' : 'owned';
  } catch (_) { return null; }
};
const geminiSender = url => {
  try { const page = new URL(url); return page.origin === 'https://gemini.google.com'; }
  catch (_) { return false; }
};
const GEMINI_ID = /^rc_[a-f0-9]{16}(?:-[a-f0-9]{32})?$/;
const geminiPrefix = (folder, prompts) => `geminiDownloadProgress:${folder}\n${prompts ? 'prompts' : 'images'}\n`;
const geminiRecoveryPath = (path, folder, sequence, id) => {
  const prefix = `${folder}/未解析/${String(sequence).padStart(6, '0')}-${id}.`;
  return typeof path === 'string' && path.startsWith(prefix) &&
    /^(?:png|jpg|webp|gif|avif)$/.test(path.slice(prefix.length));
};
const geminiMediaUrl = value => {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
    ['lh3.googleusercontent.com', 'lh3.google.com'].includes(url.hostname) &&
    /^\/(?:gg|rd-gg)\/[A-Za-z0-9_-]{40,}(?:=(?:d-I|s0-d-I))?$/.test(url.pathname) &&
    (!url.search || url.search === '?alr=yes') && !url.hash; }
  catch (_) { return false; }
};
function geminiImageFormat(bytes, reportedType) {
  const b = bytes;
  if (b.length >= 8 && b[0] === 137 && b[1] === 80 && b[2] === 78 && b[3] === 71 &&
      b[4] === 13 && b[5] === 10 && b[6] === 26 && b[7] === 10) return ['image/png', 'png'];
  if (b.length >= 3 && b[0] === 255 && b[1] === 216 && b[2] === 255) return ['image/jpeg', 'jpg'];
  const ascii = (start, end) => String.fromCharCode(...b.subarray(start, end));
  if (b.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return ['image/webp', 'webp'];
  if (b.length >= 6 && ['GIF87a', 'GIF89a'].includes(ascii(0, 6))) return ['image/gif', 'gif'];
  if (b.length >= 12 && ascii(4, 8) === 'ftyp' && ['avif', 'avis'].includes(ascii(8, 12))) return ['image/avif', 'avif'];
  throw new Error(`Gemini 原图字节不是支持的图片格式（${reportedType || 'unknown'}）`);
}
async function geminiOriginal(baseUrl) {
  if (!geminiMediaUrl(baseUrl) || !baseUrl.startsWith('https://lh3.googleusercontent.com/gg/') ||
      baseUrl.includes('=') || baseUrl.includes('?')) throw new Error('Gemini 原图地址无效');
  let url = `${baseUrl}=d-I?alr=yes`;
  const seen = new Set();
  for (let step = 0; step < 8; step++) {
    if (!geminiMediaUrl(url) || seen.has(url)) throw new Error('Gemini 原图跳转地址无效或重复');
    seen.add(url);
    const response = await fetch(url, { credentials: 'omit' });
    if (!response.ok) throw Object.assign(new Error(`Gemini 原图 HTTP ${response.status}`), { httpStatus: response.status });
    if (!geminiMediaUrl(response.url)) throw new Error('Gemini 原图响应跳转到非媒体地址');
    const type = (response.headers.get('content-type') || '').split(';')[0].toLowerCase();
    if (type === 'text/plain') {
      if (Number(response.headers.get('content-length')) > 4096) throw new Error('Gemini 原图跳转响应过大');
      const next = (await response.text()).trim();
      if (next.length > 4096) throw new Error('Gemini 原图跳转响应过大');
      if (!geminiMediaUrl(next)) throw new Error('Gemini 原图跳转到非媒体地址');
      url = next; continue;
    }
    const buffer = await response.arrayBuffer();
    if (!buffer.byteLength || buffer.byteLength > 40 * 1048576) throw new Error('Gemini 原图字节大小异常');
    const bytes = new Uint8Array(buffer);
    const [mimeType, extension] = geminiImageFormat(bytes, type);
    let base64 = '';
    for (let offset = 0; offset < bytes.length; offset += 32766)
      base64 += btoa(String.fromCharCode(...bytes.subarray(offset, offset + 32766)));
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    const sha256 = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    return { dataUrl: `data:${mimeType};base64,${base64}`, bytes: bytes.length, mimeType, extension, sha256,
      sourceHost: new URL(response.url).hostname, retrievalAttempts: seen.size };
  }
  throw new Error('Gemini 原图跳转次数过多');
}
async function geminiOriginalWithRecovery(baseUrl) {
  const errors = [];
  for (let round = 1; round <= 3; round++) {
    try {
      const image = await geminiOriginal(baseUrl);
      return { ...image, recoveryRounds: round - 1, retrievalErrors: errors };
    } catch (error) {
      errors.push({ message: error.message, status: error.httpStatus || null });
      if (round === 3 || error.httpStatus && ![408, 429, 500, 502, 503, 504].includes(error.httpStatus) ||
          /无效|非媒体|不是支持|大小异常|次数过多/.test(error.message)) {
        error.retrievalErrors = errors;
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** (round - 1)));
    }
  }
}
const chromeCall = (fn, arg) => new Promise((resolve, reject) => fn(arg, result => {
  const error = chrome.runtime.lastError;
  if (error) reject(new Error(error.message)); else resolve(result);
}));

function checkpointPage(value) {
  try {
    const url = new URL(value);
    return url.origin === 'https://chatgpt.com' && /^\/(?:images|library)(?:\/|$)/.test(url.pathname)
      ? url.origin + url.pathname : null;
  } catch (_) { return null; }
}

const checkpointStorageKey = checkpoint => `${checkpointPage(checkpoint.page)}\n${checkpoint.folder}`;
const progressPage = value => checkpointPage(value)?.replace(/\/$/, '') || null;
const progressPrefix = (page, folder, savePrompts) =>
  `gridDownloadProgress:${page}\n${folder}\n${savePrompts ? 'prompts' : 'images'}\n`;

function downloadPathMatches(filename, relativePath) {
  if (typeof filename !== 'string') return true;
  const actual = filename.replace(/\\/g, '/');
  if (actual.endsWith(`/${relativePath}`)) return true;
  const slash = relativePath.lastIndexOf('/');
  const dot = relativePath.lastIndexOf('.');
  if (dot <= slash) return false;
  const prefix = `/${relativePath.slice(0, dot)} (`;
  const suffix = `)${relativePath.slice(dot)}`;
  if (!actual.includes(prefix) || !actual.endsWith(suffix)) return false;
  const number = actual.slice(actual.lastIndexOf(prefix) + prefix.length, -suffix.length);
  return /^[1-9]\d*$/.test(number);
}

async function recoverLegacyProgress(values, page, folder, savePrompts, images, prompts) {
  const index = Object.values(values?.canonicalIndexes || {}).find(value =>
    value?.kind === 'grid-canonical-index' && value.layoutVersion === 2 &&
    progressPage(value.page) === page && value.folder === folder &&
    Array.isArray(value.images) && value.images.length <= 5000);
  if (!index) return { images, prompts };
  const prefix = progressPrefix(page, folder, savePrompts);
  const existingSequences = new Set(images.map(item => item.sequence));
  const existingGroups = new Set(prompts.map(item => item.groupName));
  const missingImages = index.images.filter(item => item?.status === 'available' &&
    Boolean(item.groupName) === savePrompts && !existingSequences.has(item.sequence) &&
    Number.isSafeInteger(item.sequence) && item.sequence >= 1 && item.sequence <= 999999 &&
    /^file[_-][A-Za-z0-9_-]{3,100}$/.test(item.fileId) &&
    typeof item.relativePath === 'string' &&
    (item.relativePath.startsWith(`${folder}/`) || item.relativePath.startsWith(`${folder}-recovery/`)));
  const missingGroups = savePrompts ? [...new Set(index.images.filter(item => item?.promptStatus === 'resolved' &&
    /^p-[0-9a-f]{32}-[0-9a-f]+$/.test(item.groupName) && !existingGroups.has(item.groupName))
    .map(item => item.groupName))] : [];
  if (!missingImages.length && !missingGroups.length) return { images, prompts };
  const history = await new Promise((resolve, reject) => chrome.downloads.search({ state: 'complete', limit: 0 }, items => {
    const error = chrome.runtime.lastError;
    if (error) reject(new Error(error.message));
    else resolve((items || []).filter(item => Number.isInteger(item?.id) && item.id >= 0 &&
      item.state === 'complete' && item.exists !== false && typeof item.filename === 'string' &&
      (item.filename.replace(/\\/g, '/').includes(`/${folder}/`) ||
        item.filename.replace(/\\/g, '/').includes(`/${folder}-recovery/`))));
  }));
  const match = path => history.find(item => downloadPathMatches(item.filename, path));
  const writes = {};
  for (const item of missingImages) {
    const download = match(item.relativePath);
    if (!download) continue;
    const record = { sequence: item.sequence, fileId: item.fileId,
      downloadId: download.id, relativePath: item.relativePath };
    writes[`${prefix}${item.sequence}`] = record;
    images.push(record);
  }
  for (const groupName of missingGroups) {
    const relativePath = `${folder}/${groupName}/prompt.txt`;
    const download = match(relativePath);
    if (!download) continue;
    const record = { groupName, downloadId: download.id, relativePath };
    writes[`${prefix}prompt:${groupName}`] = record;
    prompts.push(record);
  }
  if (Object.keys(writes).length) await new Promise((resolve, reject) =>
    chrome.storage.local.set(writes, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message)); else resolve();
    }));
  return { images, prompts };
}

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
  const grokScope = grokPageScope(sender.url);
  const geminiPage = geminiSender(sender.url);
  const chatgptSender = (() => {
    try { return new URL(sender.url).origin === 'https://chatgpt.com'; }
    catch (_) { return false; }
  })();
  if (!msg || typeof msg !== 'object' || (!chatgptSender && !grokScope && !geminiPage)) {
    sendResponse({ ok: false, error: 'Invalid extension request' });
    return false;
  }
  try {
    if (geminiPage) {
      (async () => {
        const folder = msg.folder;
        const validFolder = typeof folder === 'string' && sanitizeSegment(folder, 'gemini-images') === folder;
        const group = msg.groupName;
        const validGroup = group === undefined || group === '未解析' || GROK_GROUP.test(group);
        if (msg.action === 'getGeminiSettings') {
          const value = await chromeCall((keys, cb) => chrome.storage.local.get(keys, cb), ['geminiSettings']);
          return { status: 'found', folder: sanitizeSegment(value?.geminiSettings?.folder, 'gemini-images'),
            concurrency: normalizeConcurrency(value?.geminiSettings?.concurrency) };
        }
        if (msg.action === 'setGeminiSettings') {
          if (!validFolder) throw new Error('Invalid Gemini folder name');
          const concurrency = normalizeConcurrency(msg.concurrency);
          await chromeCall((data, cb) => chrome.storage.local.set(data, cb),
            { geminiSettings: { folder, concurrency } });
          return { status: 'saved', folder, concurrency };
        }
        if (msg.action === 'getGeminiProgress') {
          if (!validFolder || typeof msg.savePrompts !== 'boolean') throw new Error('Invalid Gemini progress request');
          const values = await chromeCall((keys, cb) => chrome.storage.local.get(keys, cb), null);
          const prefix = geminiPrefix(folder, msg.savePrompts);
          const stored = Object.entries(values || {}).filter(([key]) => key.startsWith(prefix))
            .map(([, value]) => value).filter(value => Number.isInteger(value?.downloadId) && value.downloadId >= 0 &&
              typeof value.relativePath === 'string' && value.relativePath.startsWith(`${folder}/`) &&
              (value.kind === 'media' && GEMINI_ID.test(value.mediaId) && Number.isSafeInteger(value.sequence) &&
                value.sequence >= 1 && value.sequence <= 999999 ||
                value.kind === 'prompt' && GROK_GROUP.test(value.groupName)));
          const records = [];
          for (let offset = 0; offset < stored.length; offset += 24) {
            const batch = await Promise.all(stored.slice(offset, offset + 24).map(async value => {
              const items = await chromeCall((query, cb) => chrome.downloads.search(query, cb), { id: value.downloadId });
              const item = items?.[0];
              return { ...value, status: item?.state === 'complete' && item.exists === true &&
                typeof item.filename === 'string' && downloadPathMatches(item.filename, value.relativePath) ? 'complete' :
                item?.state === 'in_progress' ? 'in_progress' : 'missing' };
            }));
            records.push(...batch);
          }
          return { status: 'found', records };
        }
        if (msg.action === 'getGeminiDownloadState') {
          if (!Number.isInteger(msg.downloadId) || msg.downloadId < 0 ||
              typeof msg.relativePath !== 'string' || !/^[^\\\x00-\x1f]+$/.test(msg.relativePath))
            throw new Error('Invalid Gemini download state request');
          const items = await chromeCall((query, cb) => chrome.downloads.search(query, cb), { id: msg.downloadId });
          const item = items?.[0];
          return { status: item?.state || 'missing', exists: item?.exists === true &&
            typeof item.filename === 'string' && downloadPathMatches(item.filename, msg.relativePath) };
        }
        if (msg.action === 'showDownloadFolder') {
          chrome.downloads.showDefaultFolder(); return { status: 'opened' };
        }
        if (msg.action === 'geminiDownload') {
          const kind = msg.kind;
          if (!validFolder || !validGroup) throw new Error('Invalid Gemini download folder');
          let name = msg.name, url = msg.url, asset;
          if (kind === 'media') {
            if (!GEMINI_ID.test(msg.mediaId) || !Number.isSafeInteger(msg.sequence) ||
                msg.sequence < 1 || msg.sequence > 999999 || typeof msg.savePrompts !== 'boolean' ||
                (msg.savePrompts ? !(group === '未解析' || GROK_GROUP.test(group)) : group !== undefined) ||
                !geminiMediaUrl(url) || msg.retry !== undefined && msg.retry !== true)
              throw new Error('Invalid Gemini image request');
            asset = await geminiOriginalWithRecovery(url);
            name = `${String(msg.sequence).padStart(6, '0')}-${msg.mediaId}.${asset.extension}`;
            url = asset.dataUrl;
          } else if (kind === 'prompt') {
            if (!GROK_GROUP.test(group) || name !== 'prompt.txt' ||
                !/^data:text\/plain;charset=utf-8,/.test(url || '') || url.length > 300000)
              throw new Error('Invalid Gemini prompt request');
          } else if (kind === 'report') {
            if (group !== undefined || name !== 'gemini-download-results.json' ||
                !/^data:application\/json;charset=utf-8,/.test(url || '') || url.length > 5000000)
              throw new Error('Invalid Gemini report request');
          } else throw new Error('Unsupported Gemini download kind');
          const directory = group ? `${folder}/${group}` : folder;
          const relativePath = `${directory}/${name}`;
          const previous = msg.previousRecovery;
          if (previous !== undefined && !(kind === 'media' && msg.savePrompts &&
              Number.isInteger(previous?.downloadId) && previous.downloadId >= 0 &&
              geminiRecoveryPath(previous.relativePath, folder, msg.sequence, msg.mediaId)))
            throw new Error('Invalid Gemini recovery path');
          const downloadId = await chromeCall((options, cb) => chrome.downloads.download(options, cb),
            { url, filename: relativePath, conflictAction: kind === 'report' || kind === 'prompt' || msg.retry ? 'overwrite' : 'uniquify' });
          if (!Number.isInteger(downloadId) || downloadId < 0) throw new Error('Chrome returned no download ID');
          const receipt = { ok: true, downloadId, relativePath,
            ...(asset ? { bytes: asset.bytes, mimeType: asset.mimeType, sha256: asset.sha256,
              sourceHost: asset.sourceHost, retrievalAttempts: asset.retrievalAttempts,
              recoveryRounds: asset.recoveryRounds, retrievalErrors: asset.retrievalErrors } : {}) };
          if (kind === 'report') return receipt;
          const key = `${geminiPrefix(folder, kind === 'prompt' || msg.savePrompts)}${kind === 'prompt' ? `prompt:${group}` : `media:${msg.mediaId}`}`;
          const record = { kind, downloadId, relativePath,
            ...(kind === 'media' ? { sequence: msg.sequence, mediaId: msg.mediaId,
              ...(previous ? { previousRecovery: previous } : {}) } : { groupName: group }) };
          try { await chromeCall((data, cb) => chrome.storage.local.set(data, cb), { [key]: record }); }
          catch (error) { receipt.trackingError = error.message; }
          return receipt;
        }
        if (msg.action === 'cleanupGeminiRecovery') {
          if (!validFolder || !GEMINI_ID.test(msg.mediaId) || !Number.isInteger(msg.oldDownloadId) ||
              !Number.isInteger(msg.newDownloadId) || typeof msg.oldRelativePath !== 'string' ||
              !msg.oldRelativePath.startsWith(`${folder}/未解析/`)) throw new Error('Invalid Gemini cleanup');
          const values = await chromeCall((keys, cb) => chrome.storage.local.get(keys, cb), null);
          const saved = Object.entries(values || {}).filter(([key]) => key.startsWith(geminiPrefix(folder, true)))
            .map(([, record]) => record).find(record => record?.kind === 'media' &&
              record.mediaId === msg.mediaId && record.downloadId === msg.newDownloadId);
          if (!saved || saved.relativePath.startsWith(`${folder}/未解析/`) ||
              saved.previousRecovery?.downloadId !== msg.oldDownloadId ||
              saved.previousRecovery?.relativePath !== msg.oldRelativePath ||
              !geminiRecoveryPath(msg.oldRelativePath, folder, saved.sequence, msg.mediaId))
            throw new Error('Gemini cleanup is not tracked for this replacement');
          const oldItems = await chromeCall((query, cb) => chrome.downloads.search(query, cb), { id: msg.oldDownloadId });
          const newItems = await chromeCall((query, cb) => chrome.downloads.search(query, cb), { id: msg.newDownloadId });
          if (newItems?.[0]?.state !== 'complete' || newItems[0].exists !== true ||
              oldItems?.[0]?.state !== 'complete' || oldItems[0].exists !== true ||
              typeof oldItems[0].filename !== 'string' || typeof newItems[0].filename !== 'string' ||
              !downloadPathMatches(oldItems[0].filename, msg.oldRelativePath) ||
              !downloadPathMatches(newItems[0].filename, saved.relativePath)) throw new Error('Gemini cleanup files are incomplete');
          await chromeCall((id, cb) => chrome.downloads.removeFile(id, cb), msg.oldDownloadId);
          chrome.downloads.erase({ id: msg.oldDownloadId }, () => { void chrome.runtime.lastError; });
          delete saved.previousRecovery;
          await chromeCall((data, cb) => chrome.storage.local.set(data, cb),
            { [`${geminiPrefix(folder, true)}media:${msg.mediaId}`]: saved });
          return { status: 'cleaned', cleanupStatus: 'old-file-removed' };
        }
        throw new Error('Unsupported Gemini action');
      })().then(sendResponse, error => sendResponse({ ok: false, status: 'error', error: error.message }));
      return true;
    }
    if (grokScope) {
      if (msg.action === 'showDownloadFolder') {
        chrome.downloads.showDefaultFolder();
        sendResponse({ status: 'opened' });
        return false;
      }
      if (msg.action === 'getGrokSettings') {
        chrome.storage.local.get(['grokSettings'], values => {
          const error = chrome.runtime.lastError;
          const saved = values?.grokSettings || {};
          sendResponse(error ? { status: 'error', error: error.message } : {
            status: 'found', folder: sanitizeSegment(saved.folder, 'grok-media'),
            concurrency: normalizeConcurrency(saved.concurrency)
          });
        });
        return true;
      }
      if (msg.action === 'setGrokSettings') {
        if (typeof msg.folder !== 'string' || sanitizeSegment(msg.folder, 'grok-media') !== msg.folder) {
          sendResponse({ status: 'invalid', error: 'Invalid Grok folder name' }); return false;
        }
        const concurrency = normalizeConcurrency(msg.concurrency);
        chrome.storage.local.set({ grokSettings: { folder: msg.folder, concurrency } }, () => {
          const error = chrome.runtime.lastError;
          sendResponse(error ? { status: 'error', error: error.message } :
            { status: 'saved', folder: msg.folder, concurrency });
        });
        return true;
      }
      if (msg.action === 'grokDownload') {
        const folder = msg.folder, kind = msg.kind, name = msg.name;
        const validFolder = typeof folder === 'string' && sanitizeSegment(folder, 'grok-media') === folder;
        const validName = typeof name === 'string' && name.length > 0 && name.length <= 190 &&
          !/[\\/\x00-\x1f]/.test(name) && name !== '.' && name !== '..';
        const group = msg.groupName;
        const validGroup = group === undefined || group === '未解析' || GROK_GROUP.test(group);
        const validMedia = kind === 'media' && GROK_ID.test(msg.mediaId) &&
          Number.isSafeInteger(msg.sequence) && msg.sequence >= 1 && msg.sequence <= 999999 &&
          ['image', 'video'].includes(msg.mediaType) &&
          typeof msg.savePrompts === 'boolean' &&
          grokBlobUrl(msg.url) &&
          (msg.mediaType === 'image' ? /^\d{6}-.+\.(?:png|jpe?g|webp|gif|avif)$/i :
            /^\d{6}-.+\.(?:mp4|webm)$/i).test(name) &&
          (msg.savePrompts ? group === '未解析' || GROK_GROUP.test(group) : group === undefined);
        const validRetry = msg.retry === undefined || kind === 'media' && msg.retry === true;
        const validPrompt = kind === 'prompt' && GROK_GROUP.test(group) && name === 'prompt.txt' &&
          /^data:text\/plain;charset=utf-8,/.test(msg.url || '');
        const validReport = kind === 'report' && group === undefined &&
          name === 'grok-download-results.json' && /^data:application\/json;charset=utf-8,/.test(msg.url || '');
        const previous = msg.previousRecovery;
        const validPrevious = previous === undefined || kind === 'media' && msg.savePrompts === true &&
          (GROK_GROUP.test(group) || group === '未解析') &&
          Number.isInteger(previous?.downloadId) && previous.downloadId >= 0 &&
          grokRecoveryPath(previous.relativePath, folder, msg.sequence, msg.mediaId, group === '未解析');
        if (!validFolder || !validName || !validGroup || !validPrevious || !validRetry ||
            !(validMedia || validPrompt || validReport)) {
          sendResponse({ ok: false, error: 'Invalid Grok download request' }); return false;
        }
        const directory = group === '未解析' ? `${folder}/未解析` :
          group ? `${folder}/${group}` : folder;
        const relativePath = `${directory}/${name}`;
        chrome.downloads.download({ url: msg.url, filename: relativePath,
          conflictAction: kind === 'prompt' || msg.retry === true ? 'overwrite' : 'uniquify' }, downloadId => {
          const error = chrome.runtime.lastError;
          if (!Number.isInteger(downloadId) || downloadId < 0) {
            sendResponse({ ok: false, error: error?.message || 'Chrome returned no download ID' }); return;
          }
          const receipt = { ok: true, downloadId, relativePath };
          if (kind === 'report') { sendResponse(receipt); return; }
          const key = `${grokProgressPrefix(grokScope, folder, kind === 'prompt' || msg.savePrompts)}${kind === 'prompt' ? `prompt:${group}` : `media:${msg.mediaId}`}`;
          const record = { kind, downloadId, relativePath,
            ...(kind === 'media' ? { sequence: msg.sequence, mediaId: msg.mediaId,
              mediaType: msg.mediaType,
              ...(previous ? { previousRecovery: { downloadId: previous.downloadId,
                relativePath: previous.relativePath } } : {}) } : { groupName: group }) };
          chrome.storage.local.set({ [key]: record }, () => {
            const storageError = chrome.runtime.lastError;
            sendResponse({ ...receipt, ...(storageError ? { trackingError: storageError.message } : {}) });
          });
        });
        return true;
      }
      if (msg.action === 'getGrokDownloadState') {
        if (!Number.isInteger(msg.downloadId) || msg.downloadId < 0 ||
            typeof msg.relativePath !== 'string' || !/^[^\\/]+\/.+/.test(msg.relativePath) ||
            /(?:^|\/)\.\.?\//.test(msg.relativePath)) {
          sendResponse({ status: 'invalid' }); return false;
        }
        chrome.downloads.search({ id: msg.downloadId }, items => {
          const error = chrome.runtime.lastError;
          const item = items?.[0];
          sendResponse(error ? { status: 'error', error: error.message } :
            { status: item?.state || 'missing', exists: item?.exists === true &&
              typeof item.filename === 'string' && downloadPathMatches(item.filename, msg.relativePath) });
        });
        return true;
      }
      if (msg.action === 'cleanupGrokRecovery') {
        const folder = msg.folder, id = msg.mediaId, groupName = msg.groupName;
        if (typeof folder !== 'string' || sanitizeSegment(folder, 'grok-media') !== folder ||
            !GROK_ID.test(id) || !(GROK_GROUP.test(groupName) || groupName === '未解析') ||
            !Number.isSafeInteger(msg.sequence) || msg.sequence < 1 || msg.sequence > 999999 ||
            !Number.isInteger(msg.oldDownloadId) || msg.oldDownloadId < 0 ||
            !Number.isInteger(msg.newDownloadId) || msg.newDownloadId < 0 ||
            msg.oldDownloadId === msg.newDownloadId ||
            !grokRecoveryPath(msg.oldRelativePath, folder, msg.sequence, id,
              groupName === '未解析')) {
          sendResponse({ status: 'invalid', error: 'Invalid Grok recovery cleanup' }); return false;
        }
        const key = `${grokProgressPrefix(grokScope, folder, true)}media:${id}`;
        const search = downloadId => new Promise((resolve, reject) =>
          chrome.downloads.search({ id: downloadId }, items => {
            const error = chrome.runtime.lastError;
            if (error) reject(new Error(error.message)); else resolve(items?.[0]);
          }));
        void (async () => {
          const saved = await new Promise((resolve, reject) => chrome.storage.local.get([key], values => {
            const error = chrome.runtime.lastError;
            if (error) reject(new Error(error.message)); else resolve(values?.[key]);
          }));
          if (saved?.downloadId !== msg.newDownloadId || saved.mediaId !== id ||
              saved.sequence !== msg.sequence ||
              !saved.relativePath?.startsWith(`${folder}/${groupName}/`) ||
              saved.relativePath === msg.oldRelativePath) {
            throw new Error('New grouped download is not tracked');
          }
          const newer = await search(msg.newDownloadId);
          if (newer?.state !== 'complete' || newer.exists !== true ||
              typeof newer.filename !== 'string' ||
              !downloadPathMatches(newer.filename, saved.relativePath)) {
            throw new Error('New grouped download is not complete');
          }
          const old = await search(msg.oldDownloadId);
          const finishCleanup = async cleanupStatus => {
            if (saved.previousRecovery) {
              const { previousRecovery, ...clean } = saved;
              await new Promise((resolve, reject) => chrome.storage.local.set({ [key]: clean }, () => {
                const error = chrome.runtime.lastError;
                if (error) reject(new Error(error.message)); else resolve();
              }));
            }
            sendResponse({ status: 'saved', cleanupStatus });
          };
          if (!old || old.exists === false) {
            await finishCleanup('old-file-missing'); return;
          }
          if (old.state !== 'complete' || typeof old.filename !== 'string' ||
              !downloadPathMatches(old.filename, msg.oldRelativePath)) {
            throw new Error('Old recovery download does not match its expected path');
          }
          await new Promise((resolve, reject) => chrome.downloads.removeFile(msg.oldDownloadId, () => {
            const error = chrome.runtime.lastError;
            if (error) reject(new Error(error.message)); else resolve();
          }));
          chrome.downloads.erase({ id: msg.oldDownloadId }, () => {
            void chrome.runtime.lastError;
            void finishCleanup('old-file-removed').catch(error =>
              sendResponse({ status: 'error', error: error.message }));
          });
        })().catch(error => sendResponse({ status: 'error', error: error.message }));
        return true;
      }
      if (msg.action === 'getGrokProgress') {
        const folder = msg.folder;
        if (typeof folder !== 'string' || sanitizeSegment(folder, 'grok-media') !== folder ||
            typeof msg.savePrompts !== 'boolean') {
          sendResponse({ status: 'invalid', error: 'Invalid Grok progress folder' }); return false;
        }
        const prefix = grokProgressPrefix(grokScope, folder, msg.savePrompts);
        chrome.storage.local.get(null, async values => {
          const readError = chrome.runtime.lastError;
          if (readError) { sendResponse({ status: 'error', error: readError.message }); return; }
          const stored = Object.entries(values || {}).filter(([key]) => key.startsWith(prefix))
            .map(([, record]) => record).filter(record => Number.isInteger(record?.downloadId) &&
              record.downloadId >= 0 && typeof record.relativePath === 'string' &&
              (record.relativePath.startsWith(`${folder}/`) || record.relativePath.startsWith(`${folder}-recovery/`)) &&
              (record.kind === 'media' && Number.isSafeInteger(record.sequence) &&
                record.sequence >= 1 && record.sequence <= 999999 && GROK_ID.test(record.mediaId) &&
                ['image', 'video'].includes(record.mediaType) ||
                record.kind === 'prompt' && GROK_GROUP.test(record.groupName)));
          try {
            const checked = [];
            for (let offset = 0; offset < stored.length; offset += 24) {
              const batch = stored.slice(offset, offset + 24);
              checked.push(...await Promise.all(batch.map(record => new Promise((resolve, reject) => {
                chrome.downloads.search({ id: record.downloadId }, items => {
                  const error = chrome.runtime.lastError;
                  if (error) { reject(new Error(error.message)); return; }
                  const item = items?.[0];
                  resolve({ ...record, status: item?.state === 'complete' &&
                    item.exists === true && typeof item.filename === 'string' &&
                    downloadPathMatches(item.filename, record.relativePath)
                    ? 'complete' : item?.state === 'in_progress' ? 'in_progress' : 'missing' });
                });
              }))));
            }
            sendResponse({ status: 'found', records: checked });
          } catch (error) { sendResponse({ status: 'error', error: error.message }); }
        });
        return true;
      }
      sendResponse({ status: 'invalid', error: 'Unsupported Grok action' });
      return false;
    }
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
      const canonicalIndex = msg.kind === 'canonical-index';
      const tracking = msg.tracking;
      const promptTracking = msg.promptTracking;
      const senderPage = progressPage(sender.url);
      const validTracking = tracking === undefined || (!prompt && !retryPrompt &&
        !canonicalIndex && /^data:image\//i.test(msg.url) &&
        senderPage && progressPage(tracking?.page) === senderPage &&
        Number.isSafeInteger(tracking?.sequence) && tracking.sequence >= 1 && tracking.sequence <= 999999 &&
        /^file[_-][A-Za-z0-9_-]{3,100}$/.test(tracking?.fileId) &&
        typeof tracking?.savePrompts === 'boolean');
      const validPromptTracking = promptTracking === undefined || (prompt && validGroupName &&
        promptTracking?.groupName === msg.groupName &&
        senderPage && progressPage(promptTracking?.page) === senderPage);
      const validRetrySequence = Number.isSafeInteger(msg.retrySequence) && msg.retrySequence >= 1 && msg.retrySequence <= 999999;
      const replaceDownloadId = msg.replaceDownloadId;
      const validReplacement = replaceDownloadId === undefined || Number.isInteger(replaceDownloadId) && replaceDownloadId >= 0;
      const validType = typeof msg.url === 'string' && (prompt || retryPrompt
        ? /^data:text\/plain;charset=utf-8(?:;base64)?,/i.test(msg.url)
        : /^data:(?:image\/(?:png|jpeg|webp|gif|avif|bmp)|application\/json)[;,]/i.test(msg.url));
      if (!validType || !validTracking || !validPromptTracking || (tracking && promptTracking) ||
          (hasGroup && !validGroup) || !validReplacement ||
          (msg.unresolved !== undefined && !unresolved) ||
          (unresolved && (hasGroup || prompt || (!retryPrompt && !/^data:image\//i.test(msg.url)))) ||
          (retryPrompt && (!unresolved || !validRetrySequence ||
            msg.name !== `${String(msg.retrySequence).padStart(6, '0')}-prompt.txt` || msg.conflictAction !== 'overwrite')) ||
          (retryImage && (!/^data:image\//i.test(msg.url) || msg.conflictAction !== 'overwrite')) ||
          (relocateImage && (!/^data:image\//i.test(msg.url) || replaceDownloadId === undefined ||
            !validGroup || msg.conflictAction !== 'overwrite')) ||
          (canonicalIndex && (msg.name !== 'grid-index.json' || !/^data:application\/json/i.test(msg.url) ||
            hasGroup || unresolved || msg.conflictAction !== 'overwrite')) ||
          (!retryPrompt && msg.retrySequence !== undefined) ||
          (replaceDownloadId !== undefined && (prompt || retryPrompt || retryImage || unresolved || !validGroup)) ||
          (prompt ? (!validGroup || msg.name !== 'prompt.txt' || msg.conflictAction !== 'overwrite')
            : (!retryPrompt && !retryImage && !relocateImage && !canonicalIndex && msg.conflictAction !== undefined && msg.conflictAction !== 'uniquify')) ||
          msg.overwrite !== undefined ||
          typeof msg.name !== 'string' || !msg.name || /[\\/]/.test(msg.name) ||
          msg.name === '.' || msg.name === '..' ||
          typeof msg.folder !== 'string' || !msg.folder || sanitizeSegment(msg.folder, 'chatgpt-images') !== msg.folder) {
        sendResponse({ ok: false, error: 'Invalid download request' });
        return false;
      }
      const directory = unresolved ? `${msg.folder}/未解析`
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
          if (!prompt && !retryPrompt && !canonicalIndex && !filenameFallback && /invalid filename|filename.*invalid|文件名.*无效/i.test(message)) {
            attemptDownload(fallbackName, true);
          } else sendResponse({ ok: false, error: message });
        };
        try {
          const relativePath = `${directory}/${name}`;
          chrome.downloads.download({ url: msg.url, filename: relativePath,
            conflictAction: prompt || retryPrompt || retryImage || relocateImage || canonicalIndex ? 'overwrite' : 'uniquify' }, downloadId => {
            const error = chrome.runtime.lastError;
            if (Number.isInteger(downloadId) && downloadId >= 0) {
              const respondAccepted = extra => {
                const receipt = { ok: true, downloadId, filename: name, filenameFallback, relativePath, ...extra };
                if (!tracking && !promptTracking) { sendResponse(receipt); return; }
                const key = tracking
                  ? progressPrefix(progressPage(tracking.page), msg.folder, tracking.savePrompts) + tracking.sequence
                  : progressPrefix(progressPage(promptTracking.page), msg.folder, true) + `prompt:${promptTracking.groupName}`;
                const record = tracking
                  ? { sequence: tracking.sequence, fileId: tracking.fileId, downloadId, relativePath }
                  : { groupName: promptTracking.groupName, downloadId, relativePath };
                chrome.storage.local.set({ [key]: record }, () => {
                  const storageError = chrome.runtime.lastError;
                  sendResponse({ ...receipt, ...(storageError ? { trackingError: storageError.message } : {}) });
                });
              };
              if (replaceDownloadId === undefined && !retryImage) {
                respondAccepted();
                return;
              }
              const startedAt = Date.now();
              const finish = (ok, extra = {}) => ok
                ? respondAccepted({ replacedDownloadId: replaceDownloadId, ...extra })
                : sendResponse({ ok, downloadId, filename: name, filenameFallback,
                  relativePath, replacedDownloadId: replaceDownloadId, ...extra });
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

    if (msg.action === 'getDownloadProgress') {
      const page = progressPage(msg.page);
      const folder = msg.folder;
      if (!page || page !== progressPage(sender.url) || typeof folder !== 'string' || sanitizeSegment(folder, 'chatgpt-images') !== folder ||
          typeof msg.savePrompts !== 'boolean') {
        sendResponse({ status: 'invalid', error: 'Invalid progress scope' }); return false;
      }
      const prefix = progressPrefix(page, folder, msg.savePrompts);
      chrome.storage.local.get(null, async values => {
        const readError = chrome.runtime.lastError;
        if (readError) { sendResponse({ status: 'error', error: readError.message }); return; }
        const baseline = values?.[`${prefix}baseline`];
        let imageRecords = Object.entries(values || {}).filter(([key]) => key.startsWith(prefix) && key !== `${prefix}baseline`)
          .map(([, record]) => record).filter(record => Number.isSafeInteger(record?.sequence) &&
            /^file[_-][A-Za-z0-9_-]{3,100}$/.test(record.fileId) &&
            Number.isInteger(record.downloadId) && record.downloadId >= 0 &&
            typeof record.relativePath === 'string' &&
            (record.relativePath.startsWith(`${folder}/`) || record.relativePath.startsWith(`${folder}-recovery/`)));
        let promptRecords = msg.savePrompts ? Object.entries(values || {})
          .filter(([key]) => key.startsWith(`${prefix}prompt:`)).map(([, record]) => record)
          .filter(record => /^p-[0-9a-f]{32}-[0-9a-f]+$/.test(record?.groupName) &&
            Number.isInteger(record.downloadId) && record.downloadId >= 0 &&
            record.relativePath === `${folder}/${record.groupName}/prompt.txt`) : [];
        try {
          ({ images: imageRecords, prompts: promptRecords } = await recoverLegacyProgress(values, page,
            folder, msg.savePrompts, imageRecords, promptRecords));
          const checked = [];
          const records = [...imageRecords, ...promptRecords];
          for (let start = 0; start < records.length; start += 24) {
            const batch = records.slice(start, start + 24);
            checked.push(...await Promise.all(batch.map(record => new Promise((resolve, reject) => {
              chrome.downloads.search({ id: record.downloadId }, items => {
                const searchError = chrome.runtime.lastError;
                if (searchError) { reject(new Error(searchError.message)); return; }
                const item = items?.[0];
                const pathMatches = downloadPathMatches(item?.filename, record.relativePath);
                resolve({ ...(record.groupName ? { groupName: record.groupName } :
                  { sequence: record.sequence, fileId: record.fileId }),
                  status: item?.state === 'complete'
                    ? item.exists !== false && pathMatches ? 'complete' : 'missing'
                    : item?.state || 'missing' });
              });
            }))));
          }
          sendResponse({ status: 'found', records: checked.filter(record => record.sequence),
            promptRecords: checked.filter(record => record.groupName),
            baseline: Number.isSafeInteger(baseline?.sequence) &&
              /^file[_-][A-Za-z0-9_-]{3,100}$/.test(baseline?.fileId) ? baseline : null });
        } catch (error) { sendResponse({ status: 'error', error: error.message }); }
      });
      return true;
    }

    if (msg.action === 'setDownloadBaseline') {
      const page = progressPage(msg.page);
      const folder = msg.folder;
      if (!page || page !== progressPage(sender.url) || typeof folder !== 'string' || sanitizeSegment(folder, 'chatgpt-images') !== folder ||
          typeof msg.savePrompts !== 'boolean' || !Number.isSafeInteger(msg.sequence) ||
          msg.sequence < 1 || msg.sequence > 999999 ||
          !/^file[_-][A-Za-z0-9_-]{3,100}$/.test(msg.fileId)) {
        sendResponse({ status: 'invalid', error: 'Invalid download baseline' }); return false;
      }
      const key = `${progressPrefix(page, folder, msg.savePrompts)}baseline`;
      chrome.storage.local.set({ [key]: { sequence: msg.sequence, fileId: msg.fileId } }, () => {
        const error = chrome.runtime.lastError;
        sendResponse(error ? { status: 'error', error: error.message } : { status: 'saved' });
      });
      return true;
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

    if (msg.action === 'getCanonicalIndex') {
      const page = checkpointPage(msg.page);
      const folder = typeof msg.folder === 'string' ? sanitizeSegment(msg.folder, 'chatgpt-images') : null;
      if (!page || !folder || folder !== msg.folder) { sendResponse({ status: 'invalid', index: null }); return false; }
      chrome.storage.local.get(['canonicalIndexes'], res => {
        const error = chrome.runtime.lastError;
        const index = res?.canonicalIndexes?.[`${page}\n${folder}`];
        sendResponse(error ? { status: 'error', error: error.message } :
          { status: index ? 'found' : 'missing', index: index || null });
      });
      return true;
    }

    if (msg.action === 'saveCanonicalIndex') {
      const index = msg.index;
      const page = checkpointPage(index?.page);
      if (!index || index.kind !== 'grid-canonical-index' || index.layoutVersion !== 2 || !page ||
          typeof index.folder !== 'string' || sanitizeSegment(index.folder, 'chatgpt-images') !== index.folder ||
          !Array.isArray(index.images) || index.images.length > 5000 || JSON.stringify(index).length > 5 * 1024 * 1024) {
        sendResponse({ status: 'invalid', error: 'Invalid canonical index' }); return false;
      }
      const ids = new Set(), sequences = new Set();
      if (!index.images.every(item => Number.isSafeInteger(item?.sequence) && item.sequence >= 1 &&
          /^file[_-][A-Za-z0-9_-]{8,100}$/.test(item.fileId) && !ids.has(item.fileId) && !sequences.has(item.sequence) &&
          typeof item.relativePath === 'string' && (item.relativePath.startsWith(`${index.folder}/`) ||
            item.relativePath.startsWith(`${index.folder}-recovery/`)) && ['available', 'failed'].includes(item.status) &&
          (ids.add(item.fileId), sequences.add(item.sequence), true))) {
        sendResponse({ status: 'invalid', error: 'Invalid canonical image entry' }); return false;
      }
      chrome.storage.local.get(['canonicalIndexes'], res => {
        const readError = chrome.runtime.lastError;
        if (readError) { sendResponse({ status: 'error', error: readError.message }); return; }
        const values = res?.canonicalIndexes && typeof res.canonicalIndexes === 'object' ? { ...res.canonicalIndexes } : {};
        values[`${page}\n${index.folder}`] = index;
        const ordered = Object.entries(values).slice(-10);
        chrome.storage.local.set({ canonicalIndexes: Object.fromEntries(ordered) }, () => {
          const error = chrome.runtime.lastError;
          sendResponse(error ? { status: 'error', error: error.message } : { status: 'saved', count: index.images.length });
        });
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
