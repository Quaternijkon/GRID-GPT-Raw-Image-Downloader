/**
 * GRID GPT Raw Image Downloader
 *
 * Pure client-side Manifest V3 Chrome extension.
 * Adds a floating button on https://chatgpt.com/library/* and /images/*.
 *
 * - Bulk downloads images from Library folders and the /images/ gallery
 * - Also downloads a metadata JSON with:
 *     • conversation create_time / update_time
 *     • folder & directory structure (files/library/nodes + directories/path)
 *     • conversations list
 * - Requires explicit user choice of subfolder via a modal "folder location chooser" before downloading. The chosen name (e.g. chatgpt-images or my-exports-2024) is used under the browser's default Downloads directory. A "Show my Downloads folder" button helps the user verify the location.
 *
 * Everything uses only your existing session + the internal APIs used by the ChatGPT web UI.
 * No external servers, no tracking.
 */

const originalImages = globalThis.ChatGPTOriginalImages;
const imageLists = globalThis.ChatGPTImageLists;
const downloadQueue = globalThis.ChatGPTDownloadQueue;
const imageNumbering = globalThis.ChatGPTImageNumbering;
let selectedAfterSequence = 0;
const promptResolver = globalThis.ChatGPTPromptResolver;
const promptGroups = globalThis.ChatGPTPromptGroups;
const promptConversations = globalThis.ChatGPTPromptConversations;
const promptRetry = globalThis.ChatGPTPromptRetry;
let selectedSavePrompts = false;
let selectedRetryPlan = null;
let selectedImageRetryPlan = null;
const downloadProgress = globalThis.ChatGPTDownloadProgress;
let selectedConcurrency = downloadQueue.DEFAULT_MODE;
let floatingProgress = null;
const extensionVersion = typeof chrome !== 'undefined' && chrome.runtime?.getManifest
  ? chrome.runtime.getManifest().version : 'development';
let activeRun = false;
let floatingButton = null;
let buttonRoute = null;

function promptFailureDetail(summary = []) {
  const issue = summary[0];
  if (!issue) return '';
  const http = issue.httpStatus ? ` HTTP ${issue.httpStatus}` : '';
  let cause;
  if (issue.code === 'session_unavailable') cause = `登录认证不可用${http}`;
  else if (issue.code === 'http_error') {
    const auth = issue.bearerSent === true ? '（已携带登录凭据）' : issue.bearerSent === false ? '（未携带登录凭据）' : '';
    cause = `会话读取${http}${auth}`;
  } else if (issue.code === 'fetch_error') cause = '会话请求发生网络错误';
  else cause = `提示词恢复错误：${issue.code}`;
  return `${cause}，涉及 ${issue.affectedConversations} 个会话 / ${issue.affectedImages} 张图片${summary.length > 1 ? '（另有其他错误，详见报告）' : ''}`;
}

function supportedPage() {
  return /^\/(images|library)(?:\/|$)/.test(location.pathname);
}

// DOM images are discovery hints only: their src/currentSrc is never downloaded.
function collectDomCandidates(main) {
  return Array.from(main.querySelectorAll('img[src]')).map((img, index) => {
    const src = img.currentSrc || img.src;
    if (!originalImages.allowedUrl(src)) return null;
    const width = img.naturalWidth || img.width;
    const height = img.naturalHeight || img.height;
    if (Math.max(width, height) <= 80) return null;
    const card = img.closest('figure, article, [role="listitem"]') || img.parentElement;
    const link = card?.querySelector('a[download][href]');
    const sourceId = originalImages.fileId(src);
    const linkId = originalImages.fileId(link?.href);
    // A grid card can contain multiple images and a link for only one of them.
    const sameImage = sourceId && linkId ? sourceId === linkId : card?.querySelectorAll('img').length === 1;
    const nativeLink = sameImage ? link : null;
    const textName = (card?.textContent || '').match(/([^\s"'\\/]+\.(?:png|jpg|jpeg|webp|gif))/i)?.[1];
    const entry = originalImages.fromItem({
      file_id: sourceId,
      url: src,
      download_url: nativeLink?.href,
      name: nativeLink?.getAttribute('download') || textName || img.alt || `chatgpt-image-${index + 1}`
    }, index, 'dom-download-link');
    if (entry) {
      entry.previewWidth = width;
      entry.previewHeight = height;
    }
    return entry;
  }).filter(Boolean);
}

function scrollImageView() {
  const current = document.querySelector('main') || document.body;
  const root = document.scrollingElement;
  const containers = new Set([root, current,
    ...current.querySelectorAll('[class*="overflow"], [class*="scroll"], [style*="overflow"]')]);
  const positions = [...containers].filter(el => el &&
    (el === root || /^(auto|scroll|overlay)$/.test(getComputedStyle(el).overflowY)) &&
    el.scrollHeight > (el.clientHeight || 0) + 2)
    .map(el => ({ el, top: el.scrollTop || 0,
      end: Math.max(0, el.scrollHeight - (el.clientHeight || 0)), height: el.scrollHeight }));
  const atBottom = positions.every(p => p.top >= p.end - 2);
  for (const p of positions) p.el.scrollTop = Math.min(p.end, p.top + Math.max(240, (p.el.clientHeight || 600) * 0.8));
  return { atBottom, extent: positions.map(p => p.height).join(','),
    position: positions.map(p => p.el.scrollTop).join(',') };
}

function sendToWorker(message, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Extension worker timed out; reload the extension and refresh this page.')), timeoutMs);
    try {
      if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) throw new Error('Extension worker unavailable');
      chrome.runtime.sendMessage(message, response => {
        // lastError must be read inside Chrome's callback, even if the timeout fired.
        const error = chrome.runtime.lastError;
        clearTimeout(timer);
        if (error || response?.error || !response) reject(new Error(error?.message || response?.error || 'Empty worker response'));
        else resolve(response);
      });
    } catch (error) {
      clearTimeout(timer);
      reject(error);
    }
  });
}

async function requestDownload(url, name, folder, { fallbackName, onAccepted, groupNumber, groupName, unresolved, kind, conflictAction, retrySequence, replaceDownloadId, workerTimeoutMs } = {}) {
  const response = await sendToWorker({ action: 'downloadFile', url, name, folder, fallbackName,
    ...(groupNumber !== undefined ? { groupNumber } : {}),
    ...(groupName !== undefined ? { groupName } : {}),
    ...(unresolved === true ? { unresolved: true } : {}),
    ...(retrySequence !== undefined ? { retrySequence } : {}),
    ...(replaceDownloadId !== undefined ? { replaceDownloadId } : {}),
    ...(kind ? { kind } : {}), ...(conflictAction ? { conflictAction } : {}) }, workerTimeoutMs || 60000);
  if (!response.ok) throw new Error('Download worker rejected the request');
  if (!Number.isInteger(response.downloadId) || response.downloadId < 0) throw new Error('Missing or invalid download ID');
  onAccepted?.(response);
  return response.downloadId;
}

async function requestPromptTextDownload(url, name, folder, options, checkActive = () => {}) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    checkActive();
    try { return { downloadId: await requestDownload(url, name, folder, options), attempts: attempt }; }
    catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise(resolve => setTimeout(resolve, attempt * 1000));
    }
  }
  throw Object.assign(lastError || new Error('Prompt text download failed'), { saveAttempts: 3 });
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('FileReader failed'));
    reader.readAsDataURL(blob);
  });
}

// Export only provenance for the selected prompt snapshot, never a complete
// conversation body or the text ignored while a generation was pending.
function promptSource(record) {
  if (!record) return null;
  return { conversationId: record.conversationId, taskRootMessageId: record.taskRootMessageId,
    taskKind: record.taskKind,
    referenceImages: record.referenceImages, nonImageAttachmentCount: record.nonImageAttachmentCount,
    sourceMessageIds: record.sourceMessageIds,
    outputMessageId: record.outputMessageId, outputAssetId: record.outputAssetId,
    duplicateOutputCount: record.duplicateOutputCount,
    identityWarning: record.identityWarning, galleryMessageId: record.galleryMessageId,
    branchPath: record.branchPath, ruleVersion: record.ruleVersion, adapterVersion: record.adapterVersion };
}

const AUTO_PROMPT_RETRY_CODES = new Set(['target_not_found', 'response_shape', 'json_error', 'conversation_shape']);

function summarizePromptErrors(errors) {
  const groups = new Map();
  for (const error of errors || []) {
    const context = { code: error.code || 'prompt_unresolved' };
    for (const key of ['phase', 'httpStatus', 'bearerSent', 'authRetried']) {
      if (error[key] !== undefined) context[key] = error[key];
    }
    const key = JSON.stringify(context);
    if (!groups.has(key)) groups.set(key, { ...context, affectedImages: 0, conversations: new Set() });
    const group = groups.get(key);
    group.affectedImages++;
    if (error.conversationId) group.conversations.add(error.conversationId);
  }
  return [...groups.values()].map(({ conversations, ...group }) => ({
    ...group, affectedConversations: conversations.size
  })).sort((a, b) => b.affectedImages - a.affectedImages);
}

async function collectPromptsWithRecovery(entries, options) {
  const primary = await promptConversations.collect(entries, options);
  if (options.autoRecovery === false) return { ...primary, autoRetryImages: 0, autoRetryConversations: 0 };
  const retryEntries = entries.filter((entry, index) =>
    primary.records[index]?.status === 'unresolved' &&
    AUTO_PROMPT_RETRY_CODES.has(primary.records[index]?.error?.code));
  if (!retryEntries.length) return { ...primary, autoRetryImages: 0, autoRetryConversations: 0 };
  options.checkActive?.();
  options.onAutoRetry?.({ images: retryEntries.length,
    conversations: new Set(retryEntries.map(entry => entry.conversationId || entry.conversation_id)).size });
  // Keep the same completion-to-next-request spacing across the pass boundary.
  await new Promise(resolve => setTimeout(resolve, primary.requestGapMs || 10000));
  options.checkActive?.();
  const baseResolved = primary.resolvedImages || 0;
  const retried = await promptConversations.collect(retryEntries, {
    ...options,
    onProgress: update => options.onProgress?.({ ...update, autoRetry: true,
      totalImages: entries.length, resolvedImages: baseResolved + update.resolvedImages })
  });
  const retryIds = new Set(retryEntries.map(entry => entry.fileId));
  const byId = new Map(retried.records.map(record => [record?.fileId, record]));
  const records = primary.records.map(record => retryIds.has(record?.fileId) ? byId.get(record.fileId) || record : record);
  const errors = [...(primary.errors || []).filter(error => !retryIds.has(error.fileId)), ...(retried.errors || [])];
  const resolvedImages = records.filter(record => record?.status === 'resolved').length;
  return { ...primary, records, errors, errorSummary: summarizePromptErrors(errors), resolvedImages,
    complete: errors.length === 0 && resolvedImages === entries.length,
    requestCount: (primary.requestCount || 0) + (retried.requestCount || 0),
    rateLimitCount: (primary.rateLimitCount || 0) + (retried.rateLimitCount || 0),
    rateLimitEpisodes: (primary.rateLimitEpisodes || 0) + (retried.rateLimitEpisodes || 0),
    peakRequests: Math.max(primary.peakRequests || 0, retried.peakRequests || 0),
    lastServerRetryAfterMs: retried.lastServerRetryAfterMs ?? primary.lastServerRetryAfterMs,
    lastFallbackCooldownMs: retried.lastFallbackCooldownMs || primary.lastFallbackCooldownMs,
    cooldownSource: retried.cooldownSource || primary.cooldownSource,
    autoRetryImages: retryEntries.length, autoRetryConversations: retried.conversationCount,
    autoRetryResolvedImages: retried.resolvedImages, autoRetryRequestCount: retried.requestCount };
}

function promptRetryCheckpoint(results, folder) {
  const images = (results.images || []).filter(item =>
    (item.promptStatus === 'unresolved' || item.saveStatus === 'failed') &&
    (item.status === undefined || item.status === 'queued')).map(item => {
      const conversationId = item.conversationId || item.promptSource?.conversationId;
      const imageRelativePath = item.imageRelativePath || item.relativePath ||
        `${folder}/未解析/${item.name || item.originalName || ''}`;
      if (!conversationId || !item.fileId || !Number.isSafeInteger(item.sequence)) return null;
      return { sequence: item.sequence, fileId: item.fileId, conversationId, imageRelativePath,
        ...(Number.isInteger(item.sourceDownloadId ?? item.downloadId)
          ? { sourceDownloadId: item.sourceDownloadId ?? item.downloadId } : {}),
        promptStatus: 'unresolved', promptError: item.promptError ||
          { code: 'prompt_save_failed', message: item.saveError || 'Prompt file was not saved' },
        ...(item.saveStatus === 'failed' ? { saveStatus: 'failed', saveError: item.saveError } : {}) };
    }).filter(Boolean);
  return { schemaVersion: 1, kind: 'prompt-retry-results', extensionVersion,
    createdAt: new Date().toISOString(), sourceReportCreatedAt: results.createdAt || null,
    sourceExtensionVersion: results.extensionVersion, page: results.page, scope: results.scope,
    folder, images };
}

async function persistPromptRetryCheckpoint(results, folder) {
  try {
    const checkpoint = promptRetryCheckpoint(results, folder);
    const processedFileIds = Array.isArray(results.processedFileIds) ? results.processedFileIds :
      (results.images || []).map(item => item.fileId).filter(Boolean);
    const response = await sendToWorker({ action: 'savePromptRetryCheckpoint', checkpoint, processedFileIds });
    return { saved: response.status === 'saved', count: response.count ?? checkpoint.images.length };
  } catch (error) {
    return { saved: false, count: 0, error: error.message };
  }
}

function imageRetryCheckpoint(results, folder) {
  const images = (results.images || []).filter(item => item.status === 'failed').map(item => ({
    sequence: item.sequence, fileId: item.fileId,
    originalName: item.originalName || item.name,
    groupName: results.savePrompts ? item.groupName || '未解析' : null,
    promptStatus: results.savePrompts ? item.promptStatus || 'unresolved' : 'resolved',
    ...(item.promptError ? { promptError: item.promptError } : {}),
    ...(item.promptSource?.conversationId ? { conversationId: item.promptSource.conversationId } : {})
  })).filter(item => item.originalName);
  return { schemaVersion: 1, kind: 'image-retry-checkpoint', extensionVersion,
    createdAt: new Date().toISOString(), page: results.page, scope: results.scope,
    folder, savePrompts: results.savePrompts === true, images };
}

async function persistImageRetryCheckpoint(results, folder) {
  try {
    const checkpoint = imageRetryCheckpoint(results, folder);
    const processedFileIds = (results.images || []).map(item => item.fileId).filter(Boolean);
    const response = await sendToWorker({ action: 'saveImageRetryCheckpoint', checkpoint, processedFileIds });
    return { saved: response.status === 'saved', count: response.count ?? checkpoint.images.length };
  } catch (error) {
    return { saved: false, count: 0, error: error.message };
  }
}

function planImageRetry(checkpoint, page) {
  if (!checkpoint || checkpoint.kind !== 'image-retry-checkpoint' || checkpoint.schemaVersion !== 1 ||
      !Array.isArray(checkpoint.images) || !checkpoint.images.length) throw new Error('没有可重试的原图失败项。');
  const expected = new URL(checkpoint.page), current = new URL(page);
  if (expected.origin !== current.origin || expected.pathname !== current.pathname || expected.origin !== 'https://chatgpt.com') {
    throw new Error('原图重试检查点与当前页面不匹配。');
  }
  return { ...checkpoint, entries: checkpoint.images.map(item => ({ ...item,
    imageName: item.originalName,
    ...(/^\d+$/.test(item.groupName || '') ? { groupNumber: Number(item.groupName) } : {}),
    candidates: [] })) };
}

function planImageRetryFromReport(report, folder, page) {
  if (!report || report.schemaVersion !== 4 || !Array.isArray(report.images)) return null;
  const failed = report.images.filter(item => item?.status === 'failed');
  if (!failed.length) return null;
  const previous = new URL(report.page), current = new URL(page);
  if (previous.origin !== 'https://chatgpt.com' || previous.origin !== current.origin ||
      previous.pathname !== current.pathname || typeof folder !== 'string' || !folder) {
    throw new Error('原图失败报告与当前页面或下载目录不匹配。');
  }
  const seen = new Set();
  const entries = failed.map(item => {
    const groupName = report.savePrompts ? item.groupName || '未解析' : null;
    const legacyGroup = typeof groupName === 'string' && /^\d+$/.test(groupName)
      ? Number(groupName) : undefined;
    if (!Number.isSafeInteger(item.sequence) || !/^file[_-][A-Za-z0-9_-]{8,100}$/.test(item.fileId) ||
        seen.has(item.fileId) || typeof (item.originalName || item.name) !== 'string' ||
        (groupName !== null && groupName !== '未解析' && legacyGroup === undefined &&
          !/^p-[0-9a-f]{32}-[0-9a-f]+$/.test(groupName))) {
      throw new Error('原图失败报告包含无效或冲突的图片身份。');
    }
    seen.add(item.fileId);
    return { sequence: item.sequence, fileId: item.fileId,
      originalName: item.originalName || item.name, imageName: item.originalName || item.name,
      groupName, ...(legacyGroup !== undefined ? { groupNumber: legacyGroup } : {}),
      promptStatus: report.savePrompts ? item.promptStatus || 'unresolved' : 'resolved',
      promptError: item.promptError, conversationId: item.promptSource?.conversationId, candidates: [] };
  });
  return { schemaVersion: 1, kind: 'image-retry-checkpoint', extensionVersion: report.extensionVersion,
    createdAt: report.createdAt, page: report.page, scope: report.scope, folder,
    savePrompts: report.savePrompts === true, entries, images: entries };
}

async function resolveOriginalForRecovery(client, entry, checkActive, onWait = () => {}) {
  let recoveryRounds = 0, totalAttempts = 0;
  const retrievalErrors = [];
  for (;;) {
    checkActive();
    try {
      const asset = await client.resolve({ fileId: entry.fileId, name: entry.imageName, candidates: [] });
      totalAttempts += asset.retrievalAttempts || 1;
      retrievalErrors.push(...(asset.retrievalErrors || []));
      return { ...asset, retrievalAttempts: totalAttempts, retrievalErrors, recoveryRounds };
    } catch (error) {
      totalAttempts += error?.retrievalAttempts || 1;
      retrievalErrors.push(...(error?.details || []));
      if (error?.retryable !== true || recoveryRounds >= 12) {
        error.retrievalAttempts = totalAttempts;
        error.details = retrievalErrors;
        error.recoveryRounds = recoveryRounds;
        throw error;
      }
      recoveryRounds++;
      const delayMs = Math.max(error.retryAfterMs || 0,
        Math.min(60000, 10000 * 2 ** Math.min(3, recoveryRounds - 1)));
      onWait({ recoveryRounds, delayMs });
      const deadline = Date.now() + delayMs;
      while (Date.now() < deadline) {
        checkActive();
        await new Promise(resolve => setTimeout(resolve, Math.min(1000, deadline - Date.now())));
      }
    }
  }
}

async function retryFailedImages(plan, { folder, ensureSameView, panel, status }) {
  const client = originalImages.createClient();
  const results = { schemaVersion: 1, kind: 'image-retry-results', extensionVersion,
    createdAt: new Date().toISOString(), page: plan.page, scope: plan.scope, folder,
    savePrompts: plan.savePrompts === true, selectedImages: plan.entries.length,
    queued: 0, failed: 0, imageDownloadsRequested: plan.entries.length, images: [] };
  status(`仅重试上次失败的 ${plan.entries.length} 张原图…`, 'images');
  panel.update({ stage: 'images', total: plan.entries.length, completed: 0, active: 1,
    queued: 0, failed: 0, retrying: 0, etaMs: null });
  for (let index = 0; index < plan.entries.length; index++) {
    ensureSameView();
    const entry = plan.entries[index];
    const record = { sequence: entry.sequence, fileId: entry.fileId,
      originalName: entry.originalName, groupName: entry.groupName,
      promptStatus: entry.promptStatus, promptError: entry.promptError,
      ...(entry.conversationId ? { promptSource: { conversationId: entry.conversationId } } : {}),
      status: 'failed', warnings: [] };
    try {
      const asset = await resolveOriginalForRecovery(client, entry, ensureSameView, wait =>
        panel.update({ stage: 'images', retrying: 1, etaMs: null,
          message: `原图 ${index + 1}/${plan.entries.length} 暂时失败，${Math.ceil(wait.delayMs / 1000)} 秒后进行第 ${wait.recoveryRounds} 轮恢复…` }));
      const name = originalImages.filename(entry.originalName, asset.blob.type,
        entry.sequence - 1, imageNumbering.WIDTH);
      const imageDataUrl = await blobToDataUrl(asset.blob);
      let receipt = null;
      record.downloadId = await requestDownload(imageDataUrl, name, folder, {
        kind: 'retry-image', conflictAction: 'overwrite', workerTimeoutMs: 90000,
        ...(entry.groupName === '未解析' ? { unresolved: true } :
          entry.groupNumber !== undefined ? { groupNumber: entry.groupNumber } :
            entry.groupName ? { groupName: entry.groupName } : {}),
        fallbackName: originalImages.filename(entry.fileId.slice(0, 64), asset.blob.type,
          entry.sequence - 1, imageNumbering.WIDTH),
        onAccepted: value => { receipt = value; }
      });
      Object.assign(record, { name: receipt?.filename || name,
        relativePath: receipt?.relativePath || `${folder}/${entry.groupName ? entry.groupName + '/' : ''}${name}`,
        bytes: asset.blob.size, mimeType: asset.blob.type, width: asset.width, height: asset.height,
        sha256: await originalImages.fingerprint(asset.blob), source: asset.source,
        verification: asset.verification, validation: asset.validation,
        retrievalAttempts: asset.retrievalAttempts, retrievalErrors: asset.retrievalErrors,
        recoveryRounds: asset.recoveryRounds, warnings: asset.warnings || [], status: 'queued' });
      results.queued++;
      if (entry.groupName === '未解析' && entry.conversationId) {
        await persistPromptRetryCheckpoint({ extensionVersion, createdAt: new Date().toISOString(),
          page: plan.page, scope: plan.scope, processedFileIds: [entry.fileId], images: [record] }, folder);
      }
    } catch (error) {
      record.error = error.message;
      record.retrievalAttempts = error.retrievalAttempts;
      record.retrievalErrors = error.details;
      record.recoveryRounds = error.recoveryRounds || 0;
      results.failed++;
    }
    results.images.push(record);
    panel.update({ stage: 'images', total: plan.entries.length, completed: index + 1,
      active: index + 1 < plan.entries.length ? 1 : 0, queued: results.queued,
      failed: results.failed, retrying: 0, etaMs: null,
      message: `原图重试 ${index + 1}/${plan.entries.length} · ${results.queued} 成功 · ${results.failed} 仍失败` });
  }
  results.imageRetryCheckpoint = await persistImageRetryCheckpoint(results, folder);
  const reportName = `chatgpt-image-retry-results-${Date.now()}.json`;
  await requestDownload('data:application/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(results, null, 2)),
    reportName, folder);
  panel.update({ stage: 'images', total: plan.entries.length, completed: plan.entries.length,
    active: 0, finished: true, queued: results.queued, failed: results.failed, retrying: 0,
    phase: results.failed ? 'completed with issues' : 'complete', etaMs: null,
    message: `原图定向重试完成：${results.queued} 张已排队，${results.failed} 张仍失败。未重新下载已成功图片；详见 ${reportName}。` });
}

async function retryFailedPrompts(plan, { folder, ensureSameView, panel, status }) {
  const startedAt = Date.now();
  const client = originalImages.createClient();
  const count = plan.entries.length;
  status(`仅重试上次失败的 ${count} 张图片，涉及 ${plan.conversationCount} 个会话…`, 'prompts');
  panel.update({ stage: 'prompts', totalImages: count, totalConversations: plan.conversationCount,
    processedConversations: 0, resolvedImages: 0, promptErrors: count, etaMs: null });
  const collected = await collectPromptsWithRecovery(plan.entries, {
    client, resolver: promptResolver, checkActive: ensureSameView, autoRecovery: false,
    onProgress: update => {
      const wait = update.retryInMs > 0 ? ` · 429 后等待 ${Math.ceil(update.retryInMs / 1000)} 秒` : '';
      panel.update({ stage: 'prompts', totalImages: count, totalConversations: plan.conversationCount,
        processedConversations: update.processedConversations, resolvedImages: update.resolvedImages,
        promptErrors: update.errors.length, etaMs: null,
        message: `${update.autoRetry ? '自动复核暂时缺失项' : '定向重试会话'} ${update.processedConversations}/${update.autoRetry ? update.conversationCount : plan.conversationCount} · 已恢复 ${update.resolvedImages}/${count}${wait}` });
    },
    onAutoRetry: update => panel.update({ stage: 'prompts', etaMs: null,
      message: `自动复核 ${update.images} 张可能暂时缺失的图片提示词（${update.conversations} 个会话）…` })
  });
  ensureSameView();
  const results = { schemaVersion: 1, kind: 'prompt-retry-results', extensionVersion,
    createdAt: new Date().toISOString(), sourceReportCreatedAt: plan.sourceReportCreatedAt,
    sourceExtensionVersion: plan.sourceExtensionVersion, page: plan.page, scope: plan.scope,
    folder, selectedImages: count, conversationCount: plan.conversationCount,
    requestCount: collected.requestCount, rateLimitCount: collected.rateLimitCount,
    autoRetryImages: collected.autoRetryImages, autoRetryConversations: collected.autoRetryConversations,
    autoRetryResolvedImages: collected.autoRetryResolvedImages, autoRetryRequestCount: collected.autoRetryRequestCount,
    requestGapMs: collected.requestGapMs, recovered: 0, unresolved: 0, saveFailed: 0,
    imageDownloadsRequested: 0, collectionErrors: collected.errors, images: [] };
  for (let i = 0; i < count; i++) {
    ensureSameView();
    const entry = plan.entries[i], record = collected.records[i];
    const item = { sequence: entry.sequence, fileId: entry.fileId,
      conversationId: entry.conversationId, imageRelativePath: entry.previousRelativePath,
      sourceDownloadId: entry.sourceDownloadId,
      previousError: entry.previousError, promptStatus: record?.status || 'unresolved',
      promptError: record?.status === 'resolved' ? null : record?.error || { code: 'missing_result', message: 'No prompt result returned' },
      ...(record?.diagnostic ? { diagnostic: record.diagnostic } : {}) };
    if (record?.status === 'resolved' && typeof record.cumulativePrompt === 'string' && record.cumulativePrompt.trim()) {
      const group = promptGroups.groupIdentity(record.cumulativePrompt);
      item.groupName = group.groupName;
      item.promptRelativePath = `${folder}/${group.groupName}/prompt.txt`;
      item.promptSource = promptSource(record);
      try {
        if (!Number.isInteger(entry.sourceDownloadId)) {
          throw new Error('Cannot replace the previous unresolved image because its Chrome download ID is missing');
        }
        const saved = await requestPromptTextDownload('data:text/plain;charset=utf-8,' + encodeURIComponent(group.promptText),
          'prompt.txt', folder, { kind: 'prompt', groupName: group.groupName, conflictAction: 'overwrite' }, ensureSameView);
        item.promptDownloadId = saved.downloadId;
        item.promptSaveAttempts = saved.attempts;
        results.imageDownloadsRequested++;
        const asset = await resolveOriginalForRecovery(client, entry, ensureSameView, wait =>
          panel.update({ stage: 'images', etaMs: null,
            message: `原图暂时失败，${Math.ceil(wait.delayMs / 1000)} 秒后进行第 ${wait.recoveryRounds} 轮恢复…` }));
        const imageName = originalImages.filename(entry.imageName, asset.blob.type, entry.sequence - 1, imageNumbering.WIDTH);
        const imageDataUrl = await blobToDataUrl(asset.blob);
        let replacementReceipt = null;
        item.imageDownloadId = await requestDownload(imageDataUrl, imageName, folder, {
          kind: 'relocate-image', conflictAction: 'overwrite', groupName: group.groupName, workerTimeoutMs: 90000,
          ...(Number.isInteger(entry.sourceDownloadId) ? { replaceDownloadId: entry.sourceDownloadId } : {}),
          fallbackName: originalImages.filename(entry.fileId.slice(0, 64), asset.blob.type,
            entry.sequence - 1, imageNumbering.WIDTH),
          onAccepted: receipt => { replacementReceipt = receipt; }
        });
        item.imageName = replacementReceipt?.filename || imageName;
        item.imageRelativePath = replacementReceipt?.relativePath || `${folder}/${group.groupName}/${item.imageName}`;
        item.sourceDownloadId = item.imageDownloadId;
        item.previousDownloadId = entry.sourceDownloadId;
        item.cleanupStatus = Number.isInteger(entry.sourceDownloadId)
          ? replacementReceipt?.cleanupStatus || 'replacement-completed' : 'source-download-id-missing';
        item.retrievalAttempts = asset.retrievalAttempts;
        item.retrievalErrors = asset.retrievalErrors;
        item.recoveryRounds = asset.recoveryRounds;
        item.saveStatus = 'queued';
        item.exactPlacement = true;
        results.recovered++;
      } catch (error) {
        item.saveStatus = 'failed'; item.saveError = error.message;
        item.saveAttempts = error.saveAttempts || item.promptSaveAttempts || 3;
        item.retrievalAttempts = error.retrievalAttempts;
        item.retrievalErrors = error.details;
        item.recoveryRounds = error.recoveryRounds;
        results.saveFailed++;
      }
    } else results.unresolved++;
    results.images.push(item);
    panel.update({ stage: 'prompt-save', totalImages: count, resolvedImages: results.recovered,
      promptErrors: results.unresolved + results.saveFailed,
      message: `提示词文件 ${i + 1}/${count} 已处理 · 已排队 ${results.recovered} · 仍未解析 ${results.unresolved} · 保存失败 ${results.saveFailed}` });
  }
  ensureSameView();
  const reportName = `chatgpt-prompt-retry-results-${Date.now()}.json`;
  results.retryCheckpoint = await persistPromptRetryCheckpoint(results, folder);
  await requestDownload('data:application/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(results, null, 2)), reportName, folder);
  panel.update({ stage: 'prompt-save', phase: results.unresolved || results.saveFailed ? 'completed with issues' : 'complete',
    finished: true, totalImages: count, resolvedImages: results.recovered,
    promptErrors: results.unresolved + results.saveFailed, etaMs: null,
    elapsedMs: Date.now() - startedAt,
    message: `定向重试完成：${results.recovered} 个提示词文件已排队，${results.unresolved} 张仍未解析，${results.saveFailed} 个保存失败。未请求任何原图；详见 ${reportName}。` });
}

function addBulkDownloadButton() {
  if (!document.body || !supportedPage() || document.getElementById('cgpt-bulk-btn')) return; // idempotent guard: prevents repeated remove/create churn from SPA mutations (the cause of load/reload browser crashes)

  if (floatingButton) {
    document.body.appendChild(floatingButton);
    return;
  }
  const btn = document.createElement('button');
  floatingButton = btn;
  btn.id = 'cgpt-bulk-btn';
  const pageLabel = location.pathname.includes('/images') ? 'Images' : 'Folder';
  btn.textContent = `⬇️ Bulk Download ${pageLabel} (+JSON)`;
  btn.style.cssText = `
    position: fixed;
    max-width: calc(100vw - 48px);
    white-space: normal;
    overflow-wrap: anywhere;
    bottom: 24px;
    right: 24px;
    z-index: 999999;
    background: #09694e;
    color: white;
    border: none;
    padding: 11px 16px;
    border-radius: 14px;
    font-size: 14px;
    font-weight: 600;
    box-shadow: 0 4px 12px rgba(0,0,0,0.25);
    cursor: pointer;
    font-family: system-ui, -apple-system, sans-serif;
  `;

  btn.onclick = async () => {
    if (activeRun || !supportedPage()) return;
    activeRun = true;
    const startUrl = location.href;
    const ensureSameView = () => {
      if (location.href !== startUrl) throw new Error('Page changed during export. Return to the intended view and retry.');
    };
    const originalText = btn.textContent;
    let panel = null, panelTimer, panelStarted = 0, meter = null, control = null;
    let repaintPanel = () => {};
    const status = (message, phase = 'collecting') => {
      btn.textContent = message;
      panel?.update({ message, phase, elapsedMs: Date.now() - panelStarted });
    };
    btn.disabled = true;
    btn.textContent = '📁 Choose download location...';

    try {
      // === MUST REQUIRE USER TO CHOOSE LOCATION ===
      // This launches the folder location chooser modal.
      // The user explicitly confirms the subfolder before any downloads start.
      const chosenFolder = await chooseDownloadLocation();

      if (!chosenFolder) {
        // User canceled the location picker
        btn.textContent = originalText;
        btn.disabled = false;
        return;
      }

      ensureSameView();
      // Use the user-chosen folder for this run (overrides any default)
      const DOWNLOAD_FOLDER = chosenFolder;
      const concurrency = downloadQueue.normalizeConcurrency(selectedConcurrency);
      const afterSequence = imageNumbering.parseBoundary(selectedAfterSequence);
      const savePrompts = selectedSavePrompts;

      floatingProgress?.destroy();
      panelStarted = Date.now();
      meter = downloadProgress.createMeter();
      panel = downloadProgress.createPanel({ theme: downloadDialogTheme, onClose: () => {
        if (activeRun) return;
        panel.destroy(); floatingProgress = null;
        btn.style.display = '';
        btn.textContent = `⬇️ Bulk Download ${location.pathname.startsWith('/images') ? 'Images' : 'Folder'} (+JSON)`;
      } });
      floatingProgress = panel;
      btn.style.display = 'none';
      panel.update({ mode: concurrency === 'auto' ? 'auto' : 'manual' });
      repaintPanel = () => panel.update({ ...meter.snapshot(), elapsedMs: Date.now() - panelStarted, etaMs: null });
      panelTimer = setInterval(() => repaintPanel(), 500);
      if (selectedImageRetryPlan) {
        await retryFailedImages(selectedImageRetryPlan, { folder: DOWNLOAD_FOLDER, ensureSameView, panel, status });
        btn.disabled = false;
        return;
      }
      if (selectedRetryPlan) {
        await retryFailedPrompts(selectedRetryPlan, { folder: DOWNLOAD_FOLDER, ensureSameView, panel, status });
        btn.disabled = false;
        return;
      }
      status('Reading all image pages before assigning numbers.');

      let rateLimitEvents = 0;
      let renderDownloadProgress = () => {};
      const client = originalImages.createClient({
        onTransfer: bytes => meter?.transfer(bytes),
        onRequestTiming: timing => control?.observeNetwork(timing),
        onRateLimit: event => {
          rateLimitEvents++;
          control?.congest('Server rate limit', event.until);
          renderDownloadProgress();
        }
      });
      const main = document.querySelector('main') || document.body;
      const entries = collectDomCandidates(main);
      const isImagesPage = location.pathname.startsWith('/images');

      // Download metadata JSON for conversation dates/times and folder structure.
      // Uses the same backend APIs the ChatGPT web UI calls (files/library/* for directories/folders + conversations list).
      // When the page context is authenticated, these calls succeed and the JSON is saved next to the images.
      let meta = {
        extensionVersion,
        downloadConcurrency: concurrency,
        afterSequence,
        savePrompts,
        scrapedAt: new Date().toISOString(),
        url: location.href,
        folderId: null,
        isImagesPage: isImagesPage,
        title: document.title
      };
      try {
        const folderIdMatch = location.pathname.match(/\/d\/([a-f0-9-]+)/i);
        meta.folderId = folderIdMatch ? folderIdMatch[1] : null;

        const apiCalls = [];
        const collectPages = (path, label, mode = 'cursor') => imageLists.collect(client.apiFetch, path, {
          mode, checkActive: ensureSameView,
          onProgress: progress => {
            status(`${label}: ${progress.unique} images · ${progress.pages} pages${progress.retrying ? ' · retrying' : ''}`);
          }
        });
        const folderId = meta.folderId;
        if (folderId) {
          apiCalls.push(
            client.apiFetch(`/backend-api/files/library/directories/path?directory_id=${folderId}`)
              .then(r => r.ok ? r.json() : {error: r.status}).then(d => ({ directoryPath: d })).catch(e => ({ directoryPath: {error: e.message} }))
          );
          apiCalls.push(
            collectPages(`/backend-api/files/library/nodes?parent_directory_id=${folderId}&limit=100`, 'Library records', 'offset').then(d => ({ nodes: d })).catch(e => ({ nodes: {error: e.message} }))
          );
          apiCalls.push(
            collectPages(`/backend-api/files/library/nodes?parent_directory_id=${folderId}&categories=image&limit=100`, 'Library images', 'offset').then(d => ({ imageNodes: d })).catch(e => ({ imageNodes: {error: e.message} }))
          );
        }
        // General conversations list (gives create_time / update_time for folders/conversations)
        apiCalls.push(
          client.apiFetch('/backend-api/conversations?offset=0&limit=100&order=updated&is_archived=false&hide_snorlax=true')
            .then(r => r.ok ? r.json() : {error: r.status}).then(d => ({ conversations: d })).catch(e => ({ conversations: {error: e.message} }))
        );
        // Recent image records supply file IDs and possible explicit original links.
        if (isImagesPage) {
          apiCalls.push(
            collectPages('/backend-api/my/recent/image_gen?limit=100', 'Gallery').then(d => ({ recentImageGen: d })).catch(e => ({ recentImageGen: {error: e.message} }))
          );
          // keep the old one as fallback (may 401)
          apiCalls.push(
            collectPages('/backend-api/my/recent/uploaded_images?limit=50&images_app_only=true', 'Uploads').then(d => ({ recentUploadedImages: d })).catch(e => ({ recentUploadedImages: {error: e.message} }))
          );
        }

        const apiResults = await Promise.all(apiCalls);
        apiResults.forEach(res => Object.assign(meta, res));

      } catch (error) {
        meta.retrievalError = error.message;
      }

      ensureSameView();
      const scope = meta.folderId ? `library-folder:${meta.folderId}` : isImagesPage ? 'generated-images' : 'unsupported-library-view';
      const primaryList = isImagesPage ? meta.recentImageGen : meta.imageNodes;
      const pagination = {};
      for (const key of ['recentImageGen', 'recentUploadedImages', 'imageNodes', 'nodes']) {
        if (meta[key]?._pagination) pagination[key] = meta[key]._pagination;
        else if (meta[key]?.error) pagination[key] = { complete: false, errors: [{ message: String(meta[key].error) }] };
      }
      const reportName = `chatgpt-${meta.folderId?.slice(0, 8) || 'images'}-download-results.json`;
      const exportJson = (value, name) => {
        ensureSameView();
        return requestDownload('data:application/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(value, null, 2)), name, DOWNLOAD_FOLDER);
      };
      const exportMetadata = async () => {
        try {
          await exportJson(meta, meta.folderId ? `chatgpt-folder-${meta.folderId.slice(0, 8)}-metadata.json` : `chatgpt-${isImagesPage ? 'images' : 'library'}-metadata.json`);
        } catch (error) { meta.exportError = error.message; }
      };

      let numbering;
      try {
        numbering = imageNumbering.plan(primaryList, originalImages, { after: afterSequence });
      } catch (error) {
        meta.numbering = { rule: imageNumbering.RULE, scope, afterSequence, blocked: true,
          error: error.message, issues: error.numberingIssues || [] };
        await exportMetadata();
        await exportJson({ schemaVersion: 4, extensionVersion, page: startUrl,
          status: 'numbering-blocked', savePrompts, scope, afterSequence,
          promptRuleVersion: promptResolver?.RULE_VERSION || null,
          groupingRuleVersion: promptGroups?.RULE_VERSION || null,
          prompts: { savePrompts, status: savePrompts ? 'not-started' : 'disabled',
            collectionErrors: [], saveErrors: [] }, numbering: meta.numbering, pagination,
          metadataExportError: meta.exportError || null,
          queued: 0, failed: 0, images: [] }, reportName);
        status(`No images downloaded: ${error.message}`, 'blocked');
        panel.update({ finished: true, etaMs: null });
        return;
      }

      // Supplemental sources may add original URLs for known IDs only. They must
      // never add images, change names or determine sequence numbers.
      const known = new Map(numbering.all.map(entry => [entry.fileId, entry]));
      for (const item of originalImages.itemsFrom(meta.recentUploadedImages)) {
        entries.push(originalImages.fromItem(item, 0, 'supplemental-api'));
      }
      if (isImagesPage) {
        try {
          const cached = JSON.parse(localStorage.getItem('oai/apps/recentImages') || 'null');
          for (const item of originalImages.itemsFrom(cached)) entries.push(originalImages.fromItem(item, 0, 'recentImages-storage'));
        } catch (_) { meta.cacheError = 'Recent image cache could not be read'; }
      }
      for (const hint of entries.filter(Boolean)) {
        const target = known.get(hint.fileId);
        if (target) target.candidates = originalImages.merge([target, hint])[0].candidates;
      }
      let files = numbering.selected;
      const numberingSummary = { ...numbering.summary, scope };
      meta.numbering = { ...numberingSummary, index: numbering.all.map(entry => ({
        sequence: entry.sequence, fileId: entry.fileId, name: entry.name,
        createdAt: entry.createdAt, creationTimeField: entry.creationTimeField,
        creationTimeNs: entry.creationTimeNs
      })) };
      const promptExport = {
        savePrompts, promptRuleVersion: promptResolver?.RULE_VERSION || null,
        adapterVersion: promptResolver?.ADAPTER_VERSION || null,
        groupingRuleVersion: promptGroups?.RULE_VERSION || null,
        scope, afterSequence, status: savePrompts ? 'collecting' : 'disabled',
        conversationSource: savePrompts ? 'backend' : null,
        groupCount: 0, selectedGroupCount: 0, collectionErrors: [], errorSummary: [], saveErrors: [], saves: []
      };
      meta.prompts = promptExport;
      let grouping = null;
      if (savePrompts) {
        // Inspect full history before the cutoff. Unknown prompts go to the fixed
        // fallback folder; known groups use first occurrence among resolved images.
        repaintPanel = () => panel.update({ elapsedMs: Date.now() - panelStarted });
        status('恢复所有图片的会话提示词…', 'prompts');
        panel.update({ stage: 'prompts', totalImages: numbering.all.length,
          resolvedImages: 0, processedConversations: 0, totalConversations: 0, etaMs: null });
        try {
          if (!promptResolver || !promptGroups || !promptConversations) throw new Error('Prompt helpers are unavailable; reload the extension and this page.');
          let collected;
          try { collected = await collectPromptsWithRecovery(numbering.all, {
            // Reuse the run's authenticated client for paced conversation reads.
            client, resolver: promptResolver, checkActive: ensureSameView,
            onProgress: update => {
              const detail = promptFailureDetail(update.errorSummary);
              const waiting = update.retryInMs > 0
                ? ` · 服务限流，${Math.ceil(update.retryInMs / 1000)} 秒后重试（${update.cooldownSource === 'server' ? '服务端要求' : '插件退避'}；不会跳过未读会话）` : '';
              const pacing = ` · 串行读取，间隔 ${Math.ceil(update.requestGapMs / 1000)} 秒`;
              const remaining = Math.max(0, (update.conversationCount || 0) - (update.processedConversations || 0) - 1);
              const lowerBound = remaining && update.requestGapMs > 0
                ? ` · 按当前间隔至少约 ${Math.ceil(remaining * update.requestGapMs / 60000)} 分钟` : '';
              panel.update({ stage: 'prompts', processedConversations: update.processedConversations,
                totalConversations: update.conversationCount, resolvedImages: update.resolvedImages,
                totalImages: numbering.all.length, promptErrors: update.errors || [], etaMs: null,
                message: `${update.autoRetry ? '自动复核暂时缺失项' : '恢复会话'} ${update.processedConversations || 0}/${update.conversationCount || 0} · 提示词 ${update.resolvedImages || 0}/${numbering.all.length}${waiting}${pacing}${lowerBound}${detail ? ` · ${detail}` : ''}` });
            },
            onAutoRetry: update => panel.update({ stage: 'prompts', etaMs: null,
              message: `自动复核 ${update.images} 张可能暂时缺失的图片提示词（${update.conversations} 个会话）…` })
          }); } catch (_) {
            ensureSameView(); // Navigation/cancellation must never become fallback downloads.
            const errors = numbering.all.map(entry => ({ fileId: entry.fileId,
              conversationId: entry.conversationId, code: 'prompt_collection_error',
              message: 'Unexpected prompt collection failure; image routed to the unresolved folder' }));
            collected = { complete: false, resolvedImages: 0, errors, errorSummary: [],
              records: errors.map(error => ({ ...error, status: 'unresolved', error: { code: error.code, message: error.message } })) };
          }
          ensureSameView();
          Object.assign(promptExport, { conversationCount: collected.conversationCount,
            processedConversations: collected.processedConversations,
            resolvedImages: collected.resolvedImages, totalImages: numbering.all.length,
            requestCount: collected.requestCount, rateLimitCount: collected.rateLimitCount,
            rateLimitEpisodes: collected.rateLimitEpisodes,
            autoRetryImages: collected.autoRetryImages,
            autoRetryConversations: collected.autoRetryConversations,
            autoRetryResolvedImages: collected.autoRetryResolvedImages,
            autoRetryRequestCount: collected.autoRetryRequestCount,
            deferredConversations: collected.deferredConversations,
            stopped: collected.stopped, stopReason: collected.stopReason,
            requestGapMs: collected.requestGapMs, targetConcurrency: collected.targetConcurrency,
            peakRequests: collected.peakRequests, cooldownUntil: collected.cooldownUntil,
            lastServerRetryAfterMs: collected.lastServerRetryAfterMs,
            lastFallbackCooldownMs: collected.lastFallbackCooldownMs,
            cooldownSource: collected.cooldownSource,
            collectionErrors: collected.errors || [], errorSummary: collected.errorSummary || [] });
          status('正在按全量提示词构建分组…', 'grouping');
          panel.update({ stage: 'grouping' });
          grouping = promptGroups.plan(numbering.all, collected.records, { afterSequence });
          files = grouping.selected;
          Object.assign(promptExport, { status: grouping.unresolvedCount ? 'partial' : 'resolved',
            issues: grouping.issues, unresolvedFolder: grouping.unresolvedFolder,
            unresolvedCount: grouping.unresolvedCount, selectedUnresolvedCount: grouping.selectedUnresolvedCount,
            resolvedImages: numbering.all.length - grouping.unresolvedCount,
            groupCount: grouping.groupCount,
            selectedGroupCount: grouping.selectedGroupCount,
            groups: grouping.groups.map(group => ({ groupNumber: group.groupNumber, groupName: group.groupName,
              firstSequence: group.entries[0]?.sequence, imageCount: group.entries.length,
              selectedCount: group.entries.filter(entry => entry.sequence > afterSequence).length })) });
          meta.numbering.index = grouping.all.map(entry => ({ sequence: entry.sequence,
            fileId: entry.fileId, name: entry.name, createdAt: entry.createdAt,
            creationTimeField: entry.creationTimeField, creationTimeNs: entry.creationTimeNs,
            groupNumber: entry.groupNumber, groupName: entry.groupName,
            promptStatus: entry.unresolved ? 'unresolved' : 'resolved', promptError: entry.promptError,
            promptSource: promptSource(entry.prompt) }));
          panel.update({ groupCount: grouping.groupCount, selectedGroupCount: grouping.selectedGroupCount,
            total: files.length, totalImages: numbering.all.length, resolvedImages: numbering.all.length - grouping.unresolvedCount,
            promptErrors: grouping.unresolvedCount,
            message: `全库 ${numbering.all.length} 张 · ${grouping.groupCount} 个提示词组 · 本次 ${files.length} 张 / ${grouping.selectedGroupCount} 组 · ${grouping.selectedUnresolvedCount} 张放入“未解析”` });
        } catch (error) {
          ensureSameView();
          promptExport.status = 'blocked';
          promptExport.error = error.message;
          promptExport.issues = error.promptIssues || error.groupingIssues || [];
          await exportMetadata();
          await exportJson({ schemaVersion: 4, extensionVersion, page: startUrl,
            status: 'prompts-blocked', savePrompts, promptRuleVersion: promptExport.promptRuleVersion,
            groupingRuleVersion: promptExport.groupingRuleVersion, scope, afterSequence,
            prompts: promptExport, numbering: numberingSummary, pagination,
            metadataExportError: meta.exportError || null, discovered: numbering.all.length,
            selected: numbering.selected.length, queued: 0, failed: 0, images: [] }, reportName);
          status(`未开始分组下载：${error.message}`, 'blocked');
          panel.update({ stage: 'prompts', promptErrors: Math.max(1, promptExport.issues.length,
            promptExport.collectionErrors.length), finished: true, etaMs: null });
          return;
        }
        // One generated TXT per touched group, before images. Only this exact
        // generated filename may overwrite; images continue to use uniquify.
        status('正在保存各组 prompt.txt…', 'prompt-save');
        panel.update({ stage: 'prompt-save' });
        for (const group of grouping.selectedGroups) {
          ensureSameView();
          const saved = { groupNumber: group.groupNumber, groupName: group.groupName,
            relativePath: `${DOWNLOAD_FOLDER}/${group.groupName}/prompt.txt`, status: 'failed' };
          try {
            const receipt = await requestPromptTextDownload('data:text/plain;charset=utf-8,' + encodeURIComponent(group.promptText),
              'prompt.txt', DOWNLOAD_FOLDER, { groupName: group.groupName, kind: 'prompt', conflictAction: 'overwrite' }, ensureSameView);
            saved.downloadId = receipt.downloadId;
            saved.attempts = receipt.attempts;
            saved.status = 'queued';
          } catch (error) {
            saved.error = error.message;
            saved.attempts = error.saveAttempts || 3;
            promptExport.saveErrors.push({ groupNumber: group.groupNumber, error: error.message });
          }
          promptExport.saves.push(saved);
          panel.update({ promptSaveErrors: promptExport.saveErrors.length,
            message: `prompt.txt ${promptExport.saves.length}/${grouping.selectedGroupCount} 已处理` });
        }
        promptExport.saveStatus = promptExport.saveErrors.length ? 'partial' : grouping.selectedGroups.length ? 'queued' : 'not-needed';
      }
      await exportMetadata();
      ensureSameView();
      const results = {
        extensionVersion,
        schemaVersion: 4, createdAt: new Date().toISOString(), page: startUrl,
        savePrompts, promptRuleVersion: promptExport.promptRuleVersion,
        groupingRuleVersion: promptExport.groupingRuleVersion, scope, afterSequence,
        groupCount: promptExport.groupCount, selectedGroupCount: promptExport.selectedGroupCount,
        prompts: promptExport,
        numbering: numberingSummary,
        qualityPolicy: 'Original endpoint or explicit original/download link; no preview fallback or re-encoding.',
        downloadStatusMeaning: 'queued means Chrome accepted the download; check browser Downloads for final completion.',
        metadataExportError: meta.exportError || null,
        cacheError: meta.cacheError || null,
        collectionIncomplete: false, pagination,
        discovered: numbering.all.length, selected: files.length, skipped: numbering.summary.skipped,
        queued: 0, failed: 0, warnings: 0, images: []
      };
      const downloadStartedAt = Date.now();
      meter = downloadProgress.createMeter();
      const deviceMemory = typeof navigator !== 'undefined' ? navigator.deviceMemory : undefined;
      control = downloadQueue.createController({ concurrency,
        memoryBudgetBytes: (deviceMemory && deviceMemory <= 4 ? 192 : deviceMemory >= 8 ? 512 : 384) * 1048576 });
      let receivedBytes = 0;
      let progress = { completed: 0, active: 0, peakActive: 0 };
      const retrying = new Set();
      renderDownloadProgress = () => {
        const telemetry = meter.snapshot(files.length), adaptive = control.snapshot();
        panel.update({ ...telemetry, stage: 'images', total: files.length, completed: progress.completed,
          active: progress.active, limit: adaptive.concurrency, mode: adaptive.mode,
          phase: adaptive.coolingDown ? 'cooldown' : 'transferring', reason: `${adaptive.phase} · ${adaptive.reason}`,
          elapsedMs: Date.now() - panelStarted, etaMs: adaptive.coolingDown ? null : telemetry.etaMs,
          queued: results.queued, failed: results.failed, warnings: results.warnings, retrying: retrying.size });
      };
      const MAX_ORIGINAL_RECOVERY_ROUNDS = 12;
      let recoveryTail = Promise.resolve();
      const waitWhileActive = async delayMs => {
        const deadline = Date.now() + delayMs;
        while (Date.now() < deadline) {
          ensureSameView();
          await new Promise(resolve => setTimeout(resolve, Math.min(1000, deadline - Date.now())));
        }
        ensureSameView();
      };
      const serializedRecovery = async (work, delayMs) => {
        const previous = recoveryTail;
        let release;
        recoveryTail = new Promise(resolve => { release = resolve; });
        await previous;
        try {
          await waitWhileActive(delayMs);
          return await work();
        } finally { release(); }
      };
      const resolveOriginalWithRecovery = async (entry, index) => {
        let recoveryRounds = 0, totalAttempts = 0, recoveryDelayMs = 0;
        const retrievalErrors = [];
        for (;;) {
          try {
            const work = () => client.resolve(entry, {
              onRetry: () => {
                retrying.add(index);
                renderDownloadProgress();
              }
            });
            const asset = recoveryRounds
              ? await serializedRecovery(work, recoveryDelayMs)
              : await work();
            totalAttempts += asset.retrievalAttempts || 1;
            retrievalErrors.push(...(asset.retrievalErrors || []));
            return { ...asset, retrievalAttempts: totalAttempts,
              retrievalErrors, recoveryRounds };
          } catch (error) {
            totalAttempts += error?.retrievalAttempts || 1;
            retrievalErrors.push(...(error?.details || []));
            if (error?.retryable !== true || recoveryRounds >= MAX_ORIGINAL_RECOVERY_ROUNDS) {
              error.retrievalAttempts = totalAttempts;
              error.details = retrievalErrors;
              error.recoveryRounds = recoveryRounds;
              throw error;
            }
            recoveryRounds++;
            recoveryDelayMs = Math.max(error.retryAfterMs || 0,
              Math.min(60000, 10000 * 2 ** Math.min(3, recoveryRounds - 1)));
            retrying.add(index);
            control.congest('Transient request errors', Date.now() + recoveryDelayMs);
            renderDownloadProgress();
          }
        }
      };
      repaintPanel = renderDownloadProgress;
      panel.update({ message: files.length ? `Original files ${files[0].sequence}–${files[files.length - 1].sequence} · ${results.skipped} earlier images skipped` : 'No images beyond the selected boundary.' });
      renderDownloadProgress();
      let outcomes;
      try {
        ensureSameView();
        outcomes = await downloadQueue.run(files, async (entry, index) => {
          const record = { sequence: entry.sequence, fileId: entry.fileId, createdAt: entry.createdAt,
            originalName: entry.name, name: entry.name, status: 'failed',
            warnings: entry.unresolved ? ['提示词无法恢复，目标目录为“未解析”；原因见 promptError。']
              : entry.prompt?.nonImageAttachmentCount ? ['含非图片附件；prompt.txt 仅保存聊天消息中的文字，未单独读取附件文件内容。'] : [],
            ...(savePrompts ? { groupNumber: entry.groupNumber, groupName: entry.groupName,
              promptStatus: entry.unresolved ? 'unresolved' : 'resolved', promptError: entry.promptError,
              promptSource: promptSource(entry.prompt) } : {}) };
          try {
            ensureSameView();
            const asset = await resolveOriginalWithRecovery(entry, index);
            receivedBytes += asset.blob.size;
            const name = originalImages.filename(entry.name, asset.blob.type, entry.sequence - 1, imageNumbering.WIDTH);
            Object.assign(record, {
              name, bytes: asset.blob.size, mimeType: asset.blob.type,
              width: asset.width, height: asset.height,
              sha256: await originalImages.fingerprint(asset.blob),
              source: asset.source, verification: asset.verification,
              validation: asset.validation, warnings: [...record.warnings, ...(asset.warnings || [])],
              retrievalAttempts: asset.retrievalAttempts, retrievalErrors: asset.retrievalErrors,
              recoveryRounds: asset.recoveryRounds
            });
            // Preserve exact bytes: no Canvas conversion, resizing or guessed extensions.
            const imageDataUrl = await blobToDataUrl(asset.blob);
            ensureSameView();
            record.relativePath = `${DOWNLOAD_FOLDER}/${savePrompts ? entry.groupName + '/' : ''}${name}`;
            record.downloadId = await requestDownload(imageDataUrl, name, DOWNLOAD_FOLDER, {
              ...(savePrompts ? { groupName: entry.unresolved ? undefined : entry.groupName, unresolved: entry.unresolved } : {}),
              fallbackName: originalImages.filename(entry.fileId.slice(0, 64), asset.blob.type, entry.sequence - 1, imageNumbering.WIDTH),
              onAccepted: receipt => {
                record.requestedName = name;
                record.name = receipt.filename || name;
                record.relativePath = receipt.relativePath || `${DOWNLOAD_FOLDER}/${savePrompts ? entry.groupName + '/' : ''}${record.name}`;
                if (receipt.filenameFallback) record.warnings.push('Chrome rejected the original filename; a safe ASCII filename was used.');
              }
            });
            record.status = 'queued';
            results.queued++;
            if (record.warnings.length) results.warnings++;
            if (savePrompts && entry.unresolved && record.promptSource?.conversationId) {
              await persistPromptRetryCheckpoint({ extensionVersion, createdAt: new Date().toISOString(),
                page: startUrl, scope, processedFileIds: [record.fileId], images: [record] }, DOWNLOAD_FOLDER);
            }
          } catch (error) {
            record.error = error?.message || String(error);
            record.retrievalAttempts = error?.retrievalAttempts || record.retrievalAttempts;
            record.retrievalErrors = error?.details || record.retrievalErrors;
            record.recoveryRounds = error?.recoveryRounds || record.recoveryRounds || 0;
            results.failed++;
          } finally {
            retrying.delete(index);
          }
          return record;
        }, {
          concurrency, controller: control,
          onProgress: update => {
            meter.complete(update.completed - progress.completed);
            progress = update; renderDownloadProgress();
          }
        });
      } finally {
        meter.stop();
        repaintPanel = () => panel.update({ elapsedMs: Date.now() - panelStarted });
        renderDownloadProgress = () => {};
      }
      results.images = outcomes.map((outcome, index) => outcome.status === 'fulfilled' ? outcome.value : {
        sequence: files[index].sequence, fileId: files[index].fileId, originalName: files[index].name, name: files[index].name,
        ...(savePrompts ? { groupNumber: files[index].groupNumber, groupName: files[index].groupName,
          promptStatus: files[index].unresolved ? 'unresolved' : 'resolved', promptError: files[index].promptError,
          promptSource: promptSource(files[index].prompt) } : {}),
        status: 'failed', warnings: [], error: outcome.reason?.message || String(outcome.reason)
      });
      // Reconcile the final counters even if a task threw outside its ordinary catch.
      results.queued = results.images.filter(record => record.status === 'queued').length;
      results.failed = results.images.length - results.queued;
      results.warnings = results.images.filter(record => record.status === 'queued' && record.warnings.length).length;
      results.downloadPerformance = { mode: control.snapshot().mode, requestedConcurrency: concurrency,
        concurrency: control.snapshot().concurrency, peakActive: progress.peakActive,
        elapsedMs: Date.now() - downloadStartedAt, receivedBytes, responseBytes: meter.snapshot(files.length).bytes,
        rateLimitEvents, adaptive: control.summary() };
      panel.update({ phase: 'finalizing', active: 0, etaMs: null, message: 'Writing the results report…' });
      if (savePrompts && results.images.length) {
        results.promptRetryCheckpoint = await persistPromptRetryCheckpoint(results, DOWNLOAD_FOLDER);
      }
      if (results.images.length) {
        results.imageRetryCheckpoint = await persistImageRetryCheckpoint(results, DOWNLOAD_FOLDER);
      }
      await exportJson(results, reportName);
      btn.textContent = files.length
        ? `${results.failed || results.warnings || meta.exportError || promptExport.saveErrors.length ? '⚠️' : '⬇️'} ${results.queued} originals queued, ${results.failed} failed, ${results.warnings} with warnings. Numbers ${files[0].sequence}–${files[files.length - 1].sequence}; skipped ${results.skipped}.${savePrompts ? ` ${grouping.selectedGroupCount} prompt groups, ${grouping.selectedUnresolvedCount} images in 未解析, ${promptExport.saveErrors.length} TXT failures.` : ''} See download-results.json${meta.exportError ? ' (metadata export failed)' : ''}`
        : `${meta.exportError ? '⚠️' : '✓'} No new images after ${afterSequence}; ${numbering.all.length} total. ${meta.exportError ? 'Metadata export failed; see results report.' : 'Metadata and results queued.'}`;
      panel.update({ ...meter.snapshot(files.length), elapsedMs: Date.now() - panelStarted,
        completed: files.length, total: files.length, active: 0, finished: true,
        phase: results.failed || results.warnings || meta.exportError || promptExport.saveErrors.length ? 'completed with issues' : 'complete',
        reason: files.length ? control.snapshot().reason : 'No new images',
        queued: results.queued, failed: results.failed, warnings: results.warnings, retrying: 0,
        message: btn.textContent });
      btn.disabled = false;
    } catch (e) {
      console.error('[ChatGPT Bulk] Error during bulk flow (button will be restored):', e);
      // Best effort restore so button isn't left stuck in loading/choose state
      if (btn) {
        btn.textContent = `⚠️ Export incomplete: ${e.message}. Click to retry.`;
        btn.disabled = false;
        panel?.update({ phase: 'error', finished: true, active: 0, etaMs: null, elapsedMs: Date.now() - panelStarted, message: e.message });
      }
    } finally {
      clearInterval(panelTimer);
      activeRun = false;
      btn.disabled = false;
      syncBulkButton();
    }
  };

  document.body.appendChild(btn);
}

/**
 * Shows a modal that forces the user to confirm / change the download subfolder.
 * This is the "folder location chooser".
 * Returns the chosen (sanitized) folder name, or null if canceled.
 */
function downloadDialogTheme() {
  for (const node of [document.documentElement, document.body]) {
    if (!node) continue;
    const declared = node.getAttribute?.('data-theme') || node.getAttribute?.('data-color-mode');
    if (declared === 'dark' || declared === 'light') return declared;
    if (node.classList?.contains('dark')) return 'dark';
    if (node.classList?.contains('light')) return 'light';
  }
  if (document.documentElement && typeof getComputedStyle === 'function') {
    const schemes = String(getComputedStyle(document.documentElement).colorScheme || '').split(/\s+/).filter(value => value === 'dark' || value === 'light');
    if (schemes.length === 1) return schemes[0];
  }
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

async function chooseDownloadLocation() {
  selectedSavePrompts = false; // Per-dialog opt-in, never a stored preference.
  selectedRetryPlan = null;
  selectedImageRetryPlan = null;
  return new Promise((resolve) => {
    let modal, themeObserver, systemTheme, syncTheme;
    const previousFocus = document.activeElement;
    const cleanup = () => {
      themeObserver?.disconnect();
      systemTheme?.removeEventListener?.('change', syncTheme);
      const dialog = modal?.shadowRoot?.querySelector('dialog');
      if (dialog?.open) dialog.close();
      modal?.remove();
    };
    try {
      modal = document.createElement('div');
      modal.style.cssText = 'all:initial;';
      const root = modal.attachShadow({ mode: 'open' });
      // Host-page selectors cannot reach these controls. Every visible state has
      // paired foreground/background colors rather than inheriting page text.
      root.innerHTML = `
        <style>
          :host {
            --dl-scheme:light; --dl-bg:#ffffff; --dl-text:#182923; --dl-muted:#596c62;
            --dl-input:#f7faf8; --dl-border:#b6c5bc; --dl-separator:#e3ebe6;
            --dl-secondary:#f0f5f2; --dl-hover:#e3eee8;
            --dl-accent:#087a58; --dl-accent-hover:#066345; --dl-on-accent:#ffffff;
            --dl-error:#a62e24; --dl-error-bg:#fff1ee; --dl-icon-bg:#e6f5ed;
            color-scheme:light;
          }
          :host([data-theme="dark"]) {
            --dl-scheme:dark; --dl-bg:#202923; --dl-text:#eff6f1; --dl-muted:#b0c1b6;
            --dl-input:#141d18; --dl-border:#61766a; --dl-separator:#3a4a40;
            --dl-secondary:#2c3931; --dl-hover:#3a4b40;
            --dl-accent:#70ddb0; --dl-accent-hover:#91e9c3; --dl-on-accent:#092f20;
            --dl-error:#ffb5a8; --dl-error-bg:#442b29; --dl-icon-bg:#2a4536;
            color-scheme:dark;
          }
          *, *::before, *::after { box-sizing:border-box; }
          dialog {
            position:fixed; inset:0; margin:auto; padding:0;
            width:min(480px, calc(100vw - 32px)); max-width:none;
            max-height:calc(100vh - 32px); max-height:calc(100dvh - 32px);
            overflow:auto; overscroll-behavior:contain;
            border:1px solid var(--dl-border); border-radius:20px;
            background:var(--dl-bg); color:var(--dl-text); color-scheme:var(--dl-scheme);
            box-shadow:0 24px 80px rgba(0,0,0,.32);
            font:400 14px/1.55 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
            text-align:left; letter-spacing:normal; direction:ltr;
          }
          dialog::backdrop { background:rgba(5,13,9,.65); }
          .panel { padding:24px; }
          .header { display:flex; gap:12px; align-items:center; margin-bottom:18px; }
          .icon { display:grid; place-items:center; width:42px; height:42px; flex:none;
            color:var(--dl-accent); background:var(--dl-icon-bg); border-radius:12px; }
          svg { width:22px; height:22px; display:block; }
          h2 { margin:0; color:var(--dl-text); font-size:20px; font-weight:650; line-height:1.3; }
          .eyebrow { margin:0 0 3px; color:var(--dl-muted); font-size:11px; letter-spacing:.06em; }
          p { margin:0; }
          .description, .hint { color:var(--dl-muted); }
          .description { margin-bottom:20px; }
          .hint { margin-top:6px; font-size:12px; }
          label { display:block; color:var(--dl-text); font-size:13px; font-weight:600; margin-bottom:7px; }
          input, button, select { font:inherit; letter-spacing:normal; }
          input, select {
            display:block; width:100%; min-width:0; min-height:44px; padding:10px 12px;
            border:1px solid var(--dl-border); border-radius:10px;
            background:var(--dl-input); color:var(--dl-text);
            -webkit-text-fill-color:var(--dl-text); caret-color:var(--dl-accent);
            color-scheme:inherit;
          }
          input::placeholder { color:var(--dl-muted); opacity:1; }
          input:disabled { color:var(--dl-muted); -webkit-text-fill-color:var(--dl-muted); cursor:wait; }
          input:focus-visible, button:focus-visible, select:focus-visible {
            outline:2px solid var(--dl-accent); outline-offset:3px;
          }
          .parallel { display:flex; align-items:center; gap:18px; margin:20px 0; padding-top:18px;
            border-top:1px solid var(--dl-separator); }
          .parallel > div { flex:1; }
          .parallel label { margin-bottom:0; }
          .parallel input { width:88px; flex:none; text-align:center; }
          .parallel select { width:150px; max-width:55%; flex:none; }
          .prompt-option { margin:20px 0; padding-top:18px; border-top:1px solid var(--dl-separator); }
          .prompt-toggle { width:100%; justify-content:space-between; }
          .prompt-toggle[aria-pressed="true"] { background:var(--dl-icon-bg); border-color:var(--dl-accent); color:var(--dl-accent); }
          [hidden] { display:none!important; }
          button {
            appearance:none; display:inline-flex; justify-content:center; align-items:center;
            min-height:42px; padding:9px 15px; border:1px solid var(--dl-border); border-radius:10px;
            background:var(--dl-secondary); color:var(--dl-text); -webkit-text-fill-color:currentColor;
            font-weight:600; cursor:pointer;
          }
          button:hover:not(:disabled) { background:var(--dl-hover); }
          button:disabled { opacity:.65; cursor:wait; }
          .close { margin-left:auto; min-width:36px; min-height:36px; padding:6px;
            border-color:transparent; background:transparent; color:var(--dl-muted); }
          .close svg { width:18px; height:18px; }
          .open-folder { width:100%; gap:8px; font-size:13px; }
          .open-folder svg { width:17px; height:17px; }
          .actions { display:flex; justify-content:flex-end; gap:10px; margin-top:22px;
            padding-top:18px; border-top:1px solid var(--dl-separator); }
          .primary { min-width:155px; background:var(--dl-accent); color:var(--dl-on-accent); border-color:transparent; }
          .primary:hover:not(:disabled) { background:var(--dl-accent-hover); }
          .error { margin-top:14px; padding:10px 12px; border-radius:8px; background:var(--dl-error-bg);
            color:var(--dl-error); font-size:12px; overflow-wrap:anywhere; }
          .error:empty { display:none; }
          .footnote { margin-top:12px; color:var(--dl-muted); font-size:11px; text-align:center; }
          @media (max-width:380px) {
            .panel { padding:18px; }
            .actions > button { flex:1; min-width:0; }
            h2 { font-size:18px; }
          }
          @media (forced-colors:active) {
            dialog, input, button, select { border:1px solid CanvasText; }
            input:focus-visible, button:focus-visible, select:focus-visible { outline-color:Highlight; }
          }
        </style>
        <dialog aria-labelledby="bulk-dl-title" aria-describedby="bulk-dl-description">
          <div class="panel">
            <header class="header">
              <span class="icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v11m-4-4 4 4 4-4M4 15v5h16v-5"/></svg></span>
              <div><p class="eyebrow">CHATGPT BULK DOWNLOADER</p><h2 id="bulk-dl-title">Download settings</h2></div>
              <button type="button" class="close" id="bulk-dl-close" aria-label="Close download settings"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button>
            </header>
            <p id="bulk-dl-description" class="description">Save original images and their metadata together in a subfolder of your browser’s Downloads location.</p>
            <label for="bulk-dl-folder">Download subfolder</label>
            <input type="text" id="bulk-dl-folder" placeholder="chatgpt-images" autocomplete="off" spellcheck="false" aria-describedby="bulk-dl-folder-hint" />
            <p id="bulk-dl-folder-hint" class="hint">Enter one folder name. It will be created if needed.</p>
            <div class="parallel">
              <div><label for="bulk-dl-after">Download after number</label><p id="bulk-dl-after-hint" class="hint">0 = all images. Enter 1600 to start at 1601.</p></div>
              <input type="number" id="bulk-dl-after" min="0" max="999999" step="1" value="0" aria-describedby="bulk-dl-after-hint bulk-dl-numbering-note" />
            </div>
            <p id="bulk-dl-numbering-note" class="hint">Oldest image = 000001. For your first export with this numbering, use 0 in a new folder. Older versions used a different order.</p>
            <div class="prompt-option">
              <button type="button" class="prompt-toggle" id="bulk-dl-prompts" aria-pressed="false" aria-describedby="bulk-dl-prompts-hint">保存提示词 <span id="bulk-dl-prompts-state" aria-hidden="true">关闭</span></button>
              <p id="bulk-dl-prompts-hint" class="hint">开启后串行读取会话，每次请求完成后等 10 秒；若收到 429，再额外等 10 秒（服务端要求更久时按其时间）。数百个会话可能需要一小时以上。相同提示词归入同一目录，无法解析的图片放入“未解析”。建议使用新目录。</p>
            </div>
            <div class="prompt-option">
              <label for="bulk-dl-retry-report">仅重试上次失败的提示词（可选）</label>
              <button type="button" class="prompt-toggle" id="bulk-dl-retry-images" hidden></button>
              <button type="button" class="prompt-toggle" id="bulk-dl-retry-saved" hidden></button>
              <input type="file" id="bulk-dl-retry-report" />
              <p class="hint">插件会自动保存本页最近一次未解析清单，并在这里提供一键重试；也可手动选择旧下载结果或 prompt-retry-results JSON。重试不重新下载图片。</p>
            </div>
            <div class="parallel">
              <div><label for="bulk-dl-mode">Concurrency</label><p id="bulk-dl-parallel-hint" class="hint">Auto probes capacity and backs off when congested.</p></div>
              <select id="bulk-dl-mode" aria-describedby="bulk-dl-parallel-hint"><option value="auto">Auto</option><option value="manual">Manual</option></select>
            </div>
            <div class="parallel" id="bulk-dl-manual" hidden>
              <div><label for="bulk-dl-concurrency">Manual parallel downloads</label><p class="hint">1–12 images at once.</p></div>
              <input type="number" id="bulk-dl-concurrency" min="1" max="12" step="1" value="6" />
            </div>
            <button type="button" class="open-folder" id="bulk-dl-show"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h7l2 3h9v11H3z"/></svg>Open Downloads folder</button>
            <p id="bulk-dl-error" class="error" role="status" aria-live="polite"></p>
            <footer class="actions">
              <button type="button" id="bulk-dl-cancel">Cancel</button>
              <button type="button" class="primary" id="bulk-dl-ok">Start download</button>
            </footer>
            <p class="footnote">Images and metadata will be saved together.</p>
          </div>
        </dialog>
      `;

      syncTheme = () => { modal.dataset.theme = downloadDialogTheme(); };
      syncTheme();
      themeObserver = new MutationObserver(syncTheme);
      for (const node of [document.documentElement, document.body]) {
        if (node) themeObserver.observe(node, { attributes:true, attributeFilter:['class', 'data-theme', 'data-color-mode', 'style'] });
      }
      systemTheme = window.matchMedia?.('(prefers-color-scheme: dark)');
      systemTheme?.addEventListener?.('change', syncTheme);
      document.body.appendChild(modal);

      const input = root.querySelector('#bulk-dl-folder');
      const parallelInput = root.querySelector('#bulk-dl-concurrency');
      const modeInput = root.querySelector('#bulk-dl-mode');
      const manualRow = root.querySelector('#bulk-dl-manual');
      modeInput.value = 'auto';
      modeInput.onchange = () => { manualRow.hidden = modeInput.value === 'auto'; };
      modeInput.onchange();
      const afterInput = root.querySelector('#bulk-dl-after');
      afterInput.value = '0'; // Always explicit; never load a saved checkpoint.
      const promptsButton = root.querySelector('#bulk-dl-prompts');
      const retryInput = root.querySelector('#bulk-dl-retry-report');
      const savedRetryButton = root.querySelector('#bulk-dl-retry-saved');
      const savedImageRetryButton = root.querySelector('#bulk-dl-retry-images');
      let savedRetryReport = null, useSavedRetry = false;
      let savedImageRetryPlan = null, useSavedImageRetry = false;
      let manualImageRetryPlan = null;
      const setRetryControls = retryOnly => {
        root.querySelector('#bulk-dl-ok').textContent = retryOnly ? '仅重试提示词' : 'Start download';
        afterInput.disabled = retryOnly;
        promptsButton.disabled = retryOnly;
        modeInput.disabled = retryOnly;
        parallelInput.disabled = retryOnly;
      };
      retryInput.onchange = async () => {
        const retryOnly = retryInput.files?.length > 0;
        useSavedRetry = false;
        useSavedImageRetry = false;
        manualImageRetryPlan = null;
        savedRetryButton.setAttribute('aria-pressed', 'false');
        savedImageRetryButton.setAttribute('aria-pressed', 'false');
        setRetryControls(retryOnly);
        errorText.textContent = '';
        if (retryOnly) {
          try {
            const report = JSON.parse(await retryInput.files[0].text());
            if (finished || !retryInput.files?.length) return;
            const path = report.images?.find(item => item?.promptStatus === 'unresolved' || item?.saveStatus === 'failed') ||
              report.images?.find(item => typeof item?.relativePath === 'string');
            const relativePath = report.kind === 'prompt-retry-results' ? path?.imageRelativePath : path?.relativePath;
            const reportFolder = typeof relativePath === 'string' ? relativePath.split('/')[0] : '';
            if (reportFolder && /^[^\\/\x00-\x1f]+$/.test(reportFolder)) input.value = reportFolder;
            manualImageRetryPlan = planImageRetryFromReport(report, input.value || reportFolder, location.href);
            if (manualImageRetryPlan) {
              root.querySelector('#bulk-dl-ok').textContent = `仅重试 ${manualImageRetryPlan.entries.length} 张失败原图`;
            }
          } catch (_) { errorText.textContent = '无法读取所选结果 JSON。'; }
        }
      };
      let savePrompts = false;
      promptsButton.setAttribute('aria-pressed', 'false');
      promptsButton.onclick = () => {
        savePrompts = !savePrompts;
        promptsButton.setAttribute('aria-pressed', String(savePrompts));
        root.querySelector('#bulk-dl-prompts-state').textContent = savePrompts ? '开启' : '关闭';
      };
      const showBtn = root.querySelector('#bulk-dl-show');
      const cancelBtn = root.querySelector('#bulk-dl-cancel');
      const okBtn = root.querySelector('#bulk-dl-ok');

      const errorText = root.querySelector('#bulk-dl-error');
      const dialog = root.querySelector('dialog');
      let finished = false, startSavedWhenReady = false;
      savedRetryButton.onclick = () => {
        if (!savedRetryReport) return;
        useSavedRetry = true;
        useSavedImageRetry = false;
        savedRetryButton.setAttribute('aria-pressed', 'true');
        savedImageRetryButton.setAttribute('aria-pressed', 'false');
        retryInput.value = '';
        input.value = savedRetryReport.folder;
        setRetryControls(true);
        errorText.textContent = '';
        if (okBtn.disabled) startSavedWhenReady = true;
        else okBtn.click();
      };
      savedImageRetryButton.onclick = () => {
        if (!savedImageRetryPlan) return;
        useSavedImageRetry = true;
        useSavedRetry = false;
        savedImageRetryButton.setAttribute('aria-pressed', 'true');
        savedRetryButton.setAttribute('aria-pressed', 'false');
        retryInput.value = '';
        input.value = savedImageRetryPlan.folder;
        setRetryControls(true);
        errorText.textContent = '';
        if (okBtn.disabled) startSavedWhenReady = true;
        else okBtn.click();
      };
      sendToWorker({ action: 'getPromptRetryCheckpoint', page: location.href }).then(response => {
        if (finished || response.status !== 'found' || !response.checkpoint) return;
        try {
          const plan = promptRetry.plan(response.checkpoint, response.checkpoint.folder, location.href);
          savedRetryReport = response.checkpoint;
          savedRetryButton.hidden = false;
          savedRetryButton.textContent = `↻ 一键重试上次未解析的 ${plan.entries.length} 张图片`;
          savedRetryButton.setAttribute('aria-pressed', 'false');
        } catch (_) { /* Invalid or stale checkpoints remain hidden. */ }
      }).catch(() => {});
      sendToWorker({ action: 'getImageRetryCheckpoint', page: location.href }).then(response => {
        if (finished || response.status !== 'found' || !response.checkpoint) return;
        try {
          savedImageRetryPlan = planImageRetry(response.checkpoint, location.href);
          savedImageRetryButton.hidden = false;
          savedImageRetryButton.textContent = `↻ 一键重试上次失败的 ${savedImageRetryPlan.entries.length} 张原图`;
          savedImageRetryButton.setAttribute('aria-pressed', 'false');
        } catch (_) { /* Invalid or stale checkpoints remain hidden. */ }
      }).catch(() => {});
      input.value = 'chatgpt-images';
      parallelInput.value = String(downloadQueue.DEFAULT_CONCURRENCY);
      parallelInput.disabled = true;
      modeInput.disabled = true;
      input.disabled = true;
      okBtn.disabled = true;
      sendToWorker({ action: 'getDownloadFolder' }).then(resp => {
        if (finished) return;
        if (!retryInput.files?.length && !useSavedRetry && !useSavedImageRetry) input.value = resp.folder || 'chatgpt-images';
        const saved = downloadQueue.normalizeConcurrency(resp.concurrency);
        modeInput.value = saved === 'auto' ? 'auto' : 'manual';
        parallelInput.value = String(saved === 'auto' ? downloadQueue.DEFAULT_CONCURRENCY : saved);
        modeInput.onchange();
      }).catch(error => {
        if (!finished) errorText.textContent = error.message;
      }).finally(() => {
        if (finished) return;
        input.disabled = false;
        setRetryControls(useSavedRetry || useSavedImageRetry || retryInput.files?.length > 0);
        okBtn.disabled = false;
        if (startSavedWhenReady) { startSavedWhenReady = false; okBtn.click(); return; }
        input.focus();
        input.select();
      });

      showBtn.onclick = async () => {
        try { await sendToWorker({ action: 'showDefaultDownloadsFolder' }); }
        catch (error) { errorText.textContent = error.message; }
      };

      const finish = (val) => {
        if (finished) return;
        finished = true;
        cleanup();
        resolve(val || null);
        if (!val && previousFocus?.isConnected && !previousFocus.disabled) previousFocus.focus();
      };
      cancelBtn.onclick = () => finish(null);
      root.querySelector('#bulk-dl-close').onclick = () => finish(null);
      dialog.addEventListener('cancel', event => { event.preventDefault(); finish(null); });
      okBtn.onclick = async () => {
        if (finished || okBtn.disabled) return;
        okBtn.disabled = true;
        errorText.textContent = '';
        try {
          const retryFile = retryInput.files?.[0];
          let retryReport = useSavedRetry ? savedRetryReport : null;
          if (!retryReport && retryFile) {
            if (retryFile.size > 32 * 1024 * 1024) throw new Error('结果报告超过 32 MB，无法安全读取。');
            try { retryReport = JSON.parse(await retryFile.text()); }
            catch (_) { throw new Error('所选文件不是有效 JSON。'); }
          }
          const after = retryReport || useSavedImageRetry ? 0 : imageNumbering.parseBoundary(afterInput.value);
          const concurrency = modeInput.value === 'auto' ? 'auto' : Number(parallelInput.value);
          if (!retryReport && !useSavedImageRetry && concurrency !== 'auto' && (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > downloadQueue.MAX_CONCURRENCY)) {
            throw new Error('Choose a whole number of parallel downloads from 1 to 12');
          }
          // Validate the imported report and target directory before persisting
          // settings or making any authenticated conversation requests.
          const requestedFolder = input.value || 'chatgpt-images';
          if ((retryReport || useSavedImageRetry) && originalImages.sanitizeSegment(requestedFolder, 'chatgpt-images') !== requestedFolder) {
            throw new Error('目录名包含不支持的字符，请使用旧结果目录的原始名称。');
          }
          const imageRetryPlan = retryReport ? planImageRetryFromReport(retryReport, requestedFolder, location.href) :
            useSavedImageRetry ? savedImageRetryPlan : null;
          const retryPlan = retryReport && !imageRetryPlan
            ? promptRetry.plan(retryReport, requestedFolder, location.href) : null;
          const resp = await sendToWorker({ action: 'setDownloadFolder', folder: input.value || 'chatgpt-images', concurrency });
          if (resp.status !== 'saved' || !resp.folder) throw new Error('Folder could not be saved');
          if (retryPlan && resp.folder !== retryPlan.folder) throw new Error('目录名包含不支持的字符，请使用旧结果目录的原始名称。');
          if (imageRetryPlan && resp.folder !== imageRetryPlan.folder) throw new Error('原图重试目录与检查点不匹配。');
          selectedConcurrency = downloadQueue.normalizeConcurrency(resp.concurrency ?? concurrency);
          selectedAfterSequence = after;
          selectedSavePrompts = savePrompts;
          selectedRetryPlan = retryPlan;
          selectedImageRetryPlan = imageRetryPlan;
          finish(resp.folder);
        } catch (error) {
          errorText.textContent = error.message;
          okBtn.disabled = false;
        }
      };

      for (const field of [input, parallelInput, afterInput]) {
        field.addEventListener('keydown', event => {
          if (event.key === 'Enter') { event.preventDefault(); okBtn.click(); }
        });
      }
      dialog.addEventListener('click', event => {
        if (event.target !== dialog) return;
        const box = dialog.getBoundingClientRect();
        if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) finish(null);
      });
      dialog.showModal();
    } catch (e) {
      cleanup();
      console.warn('[ChatGPT Bulk] chooseDownloadLocation failed to build modal:', e);
      resolve(null);
    }
  });
}

function syncBulkButton() {
  if (!supportedPage()) {
    document.getElementById('cgpt-bulk-btn')?.remove();
    buttonRoute = null;
    return;
  }
  addBulkDownloadButton();
  if (floatingButton && !activeRun && buttonRoute !== location.href) {
    floatingButton.textContent = `⬇️ Bulk Download ${location.pathname.startsWith('/images') ? 'Images' : 'Folder'} (+JSON)`;
    buttonRoute = location.href;
  }
}

// Content script loads on the existing authorized host, including SPA entry pages.
// Route checks ensure controls only appear on Images/Library.
(function initBulkButton() {
  document.getElementById('cgpt-bulk-btn')?.remove();
  syncBulkButton();
  const observer = new MutationObserver(syncBulkButton);
  observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
  window.addEventListener('popstate', syncBulkButton);
  // Covers pushState navigation even if it produces no immediate DOM mutation.
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      syncBulkButton();
    }
  }, 1000);
})();
