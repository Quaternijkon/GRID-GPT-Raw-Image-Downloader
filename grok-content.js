/* Grok Imagine export UI. Loaded only on grok.com; ChatGPT keeps its own flow. */
(() => {
  const media = globalThis.ChatGPTGrokMedia;
  const groups = globalThis.ChatGPTPromptGroups;
  const originals = globalThis.ChatGPTOriginalImages;
  const queue = globalThis.ChatGPTDownloadQueue;
  let button = null, running = false, activeObjectUrls = new Set();

  function worker(message, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('GRID 下载服务超时，请刷新页面重试。')), timeoutMs);
      chrome.runtime.sendMessage(message, response => {
        const error = chrome.runtime.lastError;
        clearTimeout(timeout);
        if (error || !response || response.error) reject(new Error(error?.message || response?.error || '下载服务没有回应'));
        else resolve(response);
      });
    });
  }

  function dataUrl(type, value) {
    return `data:${type};charset=utf-8,${encodeURIComponent(value)}`;
  }

  function exportErrorMessage(error) {
    const detail = error?.message || String(error);
    if (/HTTP (?:401|403)\b/.test(detail)) return 'Grok 暂时拒绝读取数据；请在当前页面完成登录或人机验证后重试。';
    if (/HTTP 429\b/.test(detail)) return 'Grok 请求过于频繁；请稍后重试。';
    return detail;
  }

  const makeDialog = scope => globalThis.GRIDMediaExportUI.dialog('Grok', scope);
  const makeProgressPanel = (onClose, options) => globalThis.GRIDMediaExportUI.progress('Grok', onClose,
    { concurrency: options.concurrency });

  async function settings(scope) {
    const ui = makeDialog(scope);
    const { el } = ui;
    let closed = false, request = 0, retryIds = null, recoveryFolder = null;
    const activateRetry = (ids, prompts) => {
      retryIds = [...ids];
      recoveryFolder = el('folder').value;
      el('prompts').checked = prompts;
      el('retry-hint').textContent = `将恢复 ${retryIds.length} 个媒体任务。`;
      el('start').textContent = '开始恢复';
      void refresh();
    };
    const refresh = async () => {
      if (el('mode').value !== 'auto') { el('progress').textContent = ''; return; }
      const current = ++request;
      el('progress').textContent = '正在核对本地下载进度…';
      try {
        const result = await worker({ action: 'getGrokProgress', folder: el('folder').value || 'grok-media',
          savePrompts: el('prompts').checked });
        if (closed || current !== request) return;
        const completed = new Set((result.records || []).filter(record => record.kind === 'media' &&
          record.status === 'complete').map(record => record.sequence));
        let through = 0;
        while (completed.has(through + 1)) through++;
        el('progress').textContent = through
          ? `本地记录已完成至编号 ${through}；开始时将与 Grok 列表核对。`
          : '尚无已完成记录；将从编号 1 开始。';
      } catch (_) { if (!closed && current === request) el('progress').textContent = '本地进度暂不可读取'; }
    };
    el('mode').onchange = () => { el('after-row').hidden = el('mode').value !== 'manual';
      el('after').disabled = el('after-row').hidden; void refresh(); };
    el('mode').onchange();
    el('concurrency-mode').onchange = () => {
      el('concurrency-row').hidden = el('concurrency-mode').value === 'auto';
    };
    el('folder').onchange = () => { void refresh(); };
    el('prompts').onchange = () => { void refresh(); };
    el('show-folder').onclick = () => { void worker({ action: 'showDownloadFolder' })
      .catch(error => { el('error').textContent = error.message; }); };
    el('retry-report').onchange = async () => {
      retryIds = null;
      el('retry-hint').textContent = '';
      const file = el('retry-report').files?.[0];
      if (!file) return;
      try {
        if (file.size > 32 * 1024 * 1024) throw new Error('结果报告超过 32 MB，无法安全读取。');
        const report = JSON.parse(await file.text());
        if (report.kind !== 'grok-download-results' || report.scope !== scope ||
            new URL(report.page).origin !== location.origin ||
            !Array.isArray(report.media)) throw new Error('这不是当前 Grok 页面对应的结果报告。');
        const ids = report.media.filter(item => item.status === 'failed' || item.promptStatus === 'unresolved')
          .map(item => item.mediaId).filter(id => /^[A-Za-z0-9_-]{8,128}$/.test(id));
        if (!ids.length) throw new Error('结果报告中没有可恢复的媒体任务。');
        if (typeof report.folder !== 'string' || originals.sanitizeSegment(report.folder, 'grok-media') !== report.folder)
          throw new Error('结果报告中的下载目录无效。');
        el('folder').value = report.folder;
        activateRetry(new Set(ids), report.savePrompts === true);
      } catch (error) { el('error').textContent = error.message; el('retry-report').value = ''; }
    };
    try {
      const saved = await worker({ action: 'getGrokSettings' });
      el('folder').value = saved.folder || 'grok-media';
      const savedConcurrency = queue.normalizeConcurrency(saved.concurrency);
      el('concurrency-mode').value = savedConcurrency === 'auto' ? 'auto' : 'manual';
      el('concurrency').value = String(savedConcurrency === 'auto' ? queue.DEFAULT_CONCURRENCY : savedConcurrency);
      el('concurrency-mode').onchange();
      el('start').disabled = false;
      void refresh();
      void worker({ action: 'getMediaRetryCheckpoint', provider: 'Grok' }).then(response => {
        if (closed || response.status !== 'found') return;
        const checkpoint = response.checkpoint;
        const failed = checkpoint.failed || [], unresolved = checkpoint.unresolved || [];
        if (!failed.length && !unresolved.length) return;
        el('retry-images').hidden = !failed.length;
        el('retry-images').textContent = `↻ 一键重试上次失败的 ${failed.length} 个媒体`;
        el('retry-prompts').hidden = !unresolved.length;
        el('retry-prompts').textContent = `↻ 一键重试上次未解析的 ${unresolved.length} 个提示词`;
        el('retry-images').onclick = () => {
          el('folder').value = checkpoint.folder;
          el('retry-report').value = '';
          activateRetry(new Set(failed), unresolved.length > 0);
        };
        el('retry-prompts').onclick = () => {
          el('folder').value = checkpoint.folder;
          el('retry-report').value = '';
          activateRetry(new Set(unresolved), true);
        };
      }).catch(() => {});
    } catch (error) { el('error').textContent = error.message; }
    return new Promise(resolve => {
      const finish = value => { if (closed) return; closed = true; ui.close(); resolve(value); };
      el('cancel').onclick = el('close').onclick = () => finish(null);
      ui.dialog.addEventListener('cancel', event => { event.preventDefault(); finish(null); });
      el('start').onclick = async () => {
        el('error').textContent = '';
        el('start').disabled = true;
        try {
          if (!el('images').checked && !el('videos').checked) throw new Error('请选择图片或视频。');
          const folder = el('folder').value.trim();
          if (originals.sanitizeSegment(folder, 'grok-media') !== folder) throw new Error('下载目录名包含不支持的字符。');
          if (retryIds && folder !== recoveryFolder) throw new Error('恢复任务必须使用原结果目录。');
          const after = !retryIds && el('mode').value === 'manual' ? Number(el('after').value) : 0;
          if (!Number.isSafeInteger(after) || after < 0 || after > 999999) throw new Error('编号必须为 0–999999 的整数。');
          const concurrency = el('concurrency-mode').value === 'auto' ? 'auto' : Number(el('concurrency').value);
          if (concurrency !== 'auto' && (!Number.isInteger(concurrency) || concurrency < 1 ||
              concurrency > queue.MAX_CONCURRENCY)) throw new Error('并发数量必须为 1–12 的整数。');
          const saved = await worker({ action: 'setGrokSettings', folder, concurrency });
          if (saved.status !== 'saved') throw new Error('无法保存下载目录。');
          finish({ folder, after, mode: retryIds ? 'report' : el('mode').value, retryIds,
            images: el('images').checked,
            videos: el('videos').checked, prompts: el('prompts').checked,
            concurrency: queue.normalizeConcurrency(saved.concurrency) });
        } catch (error) { el('error').textContent = error.message; el('start').disabled = false; }
      };
      ui.dialog.showModal();
    });
  }

  async function waitForDownload(downloadId, relativePath, checkActive, timeoutMs = 10 * 60 * 1000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      checkActive();
      const result = await worker({ action: 'getGrokDownloadState', downloadId, relativePath });
      if (result.status === 'complete' && result.exists) return 'complete';
      if (result.status === 'interrupted' || result.status === 'missing' || result.status === 'complete')
        throw new Error(`Chrome download ${result.status}${result.exists === false ? ' (file missing)' : ''}`);
      await new Promise(resolve => setTimeout(resolve, 750));
    }
    return 'queued';
  }

  function selectedEntry(entry, options, completed) {
    return (!options.retryIds || options.retryIds.includes(entry.id)) && entry.sequence > options.after &&
      (entry.kind === 'image' ? options.images : options.videos) &&
      (options.mode !== 'auto' || !completed.has(entry.id));
  }

  async function run(scope, options, status) {
    const startUrl = location.href;
    const checkActive = () => {
      if (location.href !== startUrl) throw new Error('页面已切换，导出已停止。');
    };
    status('正在读取 Grok 全部媒体页面…', { stage: 'collecting', phase: 'collecting' });
    const found = await media.collectCurrent(fetch, scope, { checkActive,
      onProgress: progress => status(`已读取 ${progress.pages} 页、${progress.posts} 条记录…`,
        { stage: 'collecting', phase: 'collecting' }) });
    const promptCollection = options.prompts ? await media.resolvePrompts(found.entries, {
      checkActive, onProgress: progress => status(`正在恢复提示词 ${progress.processed}/${progress.total} 个会话 · 已匹配 ${progress.resolved}/${found.entries.length} 个媒体…`,
        { stage: 'prompts', phase: 'prompts', processedConversations: progress.processed,
          totalConversations: progress.total, resolvedImages: progress.resolved,
          totalImages: found.entries.length, promptErrors: Math.max(0, found.entries.length - progress.resolved) })
    }) : null;
    let progress;
    try { progress = await worker({ action: 'getGrokProgress', folder: options.folder,
      savePrompts: options.prompts }); }
    catch (error) { if (options.mode === 'auto') throw error; progress = { status: 'found', records: [] }; }
    if (progress.status !== 'found') {
      if (options.mode === 'auto') throw new Error('无法读取 Grok 下载进度。');
      progress = { status: 'found', records: [] };
    }
    const byId = new Map(progress.records.filter(record => record.kind === 'media').map(record => [record.mediaId, record]));
    const promptGroups = new Map();
    for (const entry of found.entries) {
      if (!options.prompts) continue;
      entry.groupName = entry.prompt ? groups.groupIdentity(entry.prompt).groupName : '未解析';
      if (entry.prompt) promptGroups.set(entry.groupName, entry.prompt);
    }
    const expectedRoot = entry => options.prompts
      ? entry.groupName === '未解析' ? `${options.folder}/未解析/` :
        `${options.folder}/${entry.groupName}/` : `${options.folder}/`;
    const matchesDestination = (entry, record) => record?.status === 'complete' &&
      record.mediaId === entry.id && record.mediaType === entry.kind &&
      record.relativePath?.startsWith(expectedRoot(entry));
    const previousRecovery = (entry, prior) => {
      if (!options.prompts || !prior) return null;
      const leaf = `${String(entry.sequence).padStart(6, '0')}-${entry.id.slice(0, 32)}.`;
      const legacyPrefix = `${options.folder}-recovery/未解析/${leaf}`;
      const currentPrefix = `${options.folder}/未解析/${leaf}`;
      const candidate = prior.previousRecovery || (prior.status === 'complete'
        ? { downloadId: prior.downloadId, relativePath: prior.relativePath } : null);
      const path = candidate?.relativePath;
      if (!path?.startsWith(legacyPrefix) && !path?.startsWith(currentPrefix)) return null;
      if (entry.groupName === '未解析' && !path.startsWith(legacyPrefix)) return null;
      return candidate;
    };
    const completed = new Set(found.entries.filter(entry => matchesDestination(entry, byId.get(entry.id)))
      .map(entry => entry.id));
    const completedThrough = records => {
      const bySequence = new Map(records.filter(record => record.kind === 'media' &&
        record.status === 'complete').map(record => [record.sequence, record]));
      let through = 0;
      for (const entry of found.entries) {
        const record = bySequence.get(entry.sequence);
        if (!matchesDestination(entry, record)) break;
        through = entry.sequence;
      }
      return through;
    };
    if (options.mode === 'auto' && found.entries.some(entry => byId.get(entry.id)?.status === 'in_progress')) {
      throw new Error('先前的 Grok 下载仍在进行，请等待 Chrome 下载完成后重试。');
    }
    if (options.after > found.entries.length) throw new Error(`手动编号 ${options.after} 超出当前 ${found.entries.length} 个媒体。`);
    const selected = found.entries.filter(entry => selectedEntry(entry, options, completed));
    const selectedGroupCount = options.prompts ? new Set(selected.map(entry => entry.groupName)).size : 0;
    const report = { schemaVersion: 1, kind: 'grok-download-results', extensionVersion: chrome.runtime.getManifest().version,
      page: startUrl, scope, createdAt: new Date().toISOString(), folder: options.folder,
      boundaryMode: options.mode, afterSequence: options.after, savePrompts: options.prompts,
      promptCollection,
      mediaTypes: { images: options.images, videos: options.videos }, pagination: found.pagination,
      progressAtStart: { completedThrough: completedThrough(progress.records),
        completedMedia: completed.size },
      discovered: found.entries.length, selected: selected.length, skipped: found.entries.length - selected.length,
      queued: 0, completed: 0, failed: 0, warnings: 0, layoutIssues: 0,
      promptFilesQueued: 0, promptFilesFailed: 0,
      qualityPolicy: 'Preferred original media URL; exact response bytes, no preview substitution or re-encoding.',
      media: [], promptFiles: [], recoveryCleanup: [],
      downloadStatusMeaning: 'queued means Chrome accepted the download; completed means Chrome reported completion and the file exists.' };
    status(`已发现 ${found.entries.length} 个媒体，本次处理 ${selected.length} 个。`,
      { stage: options.prompts ? 'grouping' : 'images', phase: options.prompts ? 'prompts' : 'transferring',
        total: selected.length, processed: 0, completed: 0, failed: 0,
        totalImages: found.entries.length, resolvedImages: found.entries.length - (promptCollection?.unresolved || 0),
        totalConversations: promptCollection?.conversations, processedConversations: promptCollection?.conversations,
        groupCount: promptGroups.size, selectedGroupCount, promptErrors: promptCollection?.unresolved || 0 });
    if (options.prompts) for (const entry of found.entries) {
      const prior = byId.get(entry.id);
      const previous = previousRecovery(entry, prior);
      if (!prior?.previousRecovery || !previous || !matchesDestination(entry, prior)) continue;
      try {
        const cleanup = await worker({ action: 'cleanupGrokRecovery', folder: options.folder,
          mediaId: entry.id, sequence: entry.sequence, groupName: entry.groupName,
          oldDownloadId: previous.downloadId,
          oldRelativePath: previous.relativePath, newDownloadId: prior.downloadId });
        report.recoveryCleanup.push({ mediaId: entry.id, status: cleanup.cleanupStatus });
      } catch (error) {
        report.recoveryCleanup.push({ mediaId: entry.id, status: 'failed', error: error.message });
        report.warnings++;
        report.layoutIssues++;
      }
    }
    if (options.prompts) {
      const savedPrompts = new Set(progress.records.filter(record => record.kind === 'prompt' && record.status === 'complete')
        .map(record => record.groupName));
      const selectedGroups = new Set(selected.map(entry => entry.groupName));
      for (const [groupName, prompt] of promptGroups) {
        if (options.mode === 'auto' && !selectedGroups.has(groupName) && savedPrompts.has(groupName)) continue;
        if (options.mode !== 'auto' && !selectedGroups.has(groupName)) continue;
        checkActive();
        status(`正在保存提示词 ${report.promptFiles.length + 1}/${promptGroups.size}…`,
          { stage: 'prompt-save', phase: 'prompts', total: selected.length,
            totalImages: found.entries.length, resolvedImages: found.entries.length - (promptCollection?.unresolved || 0),
            groupCount: promptGroups.size, selectedGroupCount, promptErrors: promptCollection?.unresolved || 0,
            promptSaveErrors: report.promptFilesFailed });
        const record = { groupName, status: 'failed' };
        try {
          if (new TextEncoder().encode(prompt).length > 100000) throw new Error('Prompt exceeds supported TXT size');
          const accepted = await worker({ action: 'grokDownload', kind: 'prompt', folder: options.folder,
            groupName, name: 'prompt.txt', url: dataUrl('text/plain', `${prompt}\n`) });
          if (!accepted.ok) throw new Error('Chrome rejected prompt.txt');
          record.downloadId = accepted.downloadId;
          record.relativePath = accepted.relativePath;
          report.promptFilesQueued++;
          record.status = await waitForDownload(accepted.downloadId, accepted.relativePath, checkActive);
          if (accepted.trackingError) { record.trackingError = accepted.trackingError; report.warnings++; }
        } catch (error) { record.error = error.message; report.promptFilesFailed++; }
        report.promptFiles.push(record);
      }
    }
    const deviceMemory = typeof navigator !== 'undefined' ? navigator.deviceMemory : undefined;
    const memoryBudgetBytes = (deviceMemory && deviceMemory <= 4 ? 192 : deviceMemory >= 8 ? 512 : 384) * 1048576;
    const concurrency = queue.normalizeConcurrency(options.concurrency);
    const controller = queue.createController({ concurrency, memoryBudgetBytes,
      initialConcurrency: 8, maxConcurrency: 32 });
    const estimateBytes = entry => {
      const size = Number(entry.reportedSizeBytes) || 0;
      const pixels = (entry.reportedWidth || 0) * (entry.reportedHeight || 0) * 4;
      if (entry.kind === 'video') return size > 0 ? Math.max(48 * 1048576, size * 2.5) : 128 * 1048576;
      return Math.max(16 * 1048576, size * 4 + pixels);
    };
    const downloadStartedAt = Date.now();
    let receivedBytes = 0, retrying = 0;
    let peakActive = 0, peakActiveBytes = 0;
    const waitWhileActive = async delayMs => {
      const deadline = Date.now() + delayMs;
      while (Date.now() < deadline) {
        checkActive();
        await new Promise(resolve => setTimeout(resolve, Math.min(750, deadline - Date.now())));
      }
      checkActive();
    };
    const resolveOriginalWithRecovery = async entry => {
      let attempts = 0, lastError;
      for (let round = 1; round <= 3; round++) {
        checkActive();
        try {
          const asset = await media.fetchOriginal(entry, { checkActive,
            onRequestTiming: timing => controller.observeNetwork(timing) });
          return { ...asset, retrievalAttempts: attempts + asset.retrievalAttempts,
            recoveryRounds: round - 1 };
        } catch (error) {
          attempts += error.retrievalAttempts || 1;
          lastError = error;
          if (!error.retryable || round === 3) break;
          const delayMs = Math.max(error.retryAfterMs || 0, Math.min(30000, 2000 * 2 ** (round - 1)));
          controller.congest(`Grok HTTP ${error.httpStatus || 'network'} backoff`, Date.now() + delayMs);
          retrying++;
          status(`媒体 ${entry.sequence} 暂时失败，正在等待第 ${round} 轮自动恢复…`,
            { stage: 'images', phase: 'cooldown', retrying, failed: report.failed,
              queued: report.queued, warnings: report.warnings, bytes: receivedBytes });
          try { await waitWhileActive(delayMs); }
          finally { retrying--; }
        }
      }
      lastError.retrievalAttempts = attempts;
      throw lastError;
    };
    const processEntry = async (entry, index) => {
      checkActive();
      const record = { sequence: entry.sequence, mediaId: entry.id, mediaType: entry.kind,
        createdAt: entry.createdAt, modelName: entry.modelName,
        reportedWidth: entry.reportedWidth, reportedHeight: entry.reportedHeight,
        videoDuration: entry.videoDuration,
        promptStatus: !options.prompts ? 'disabled' : entry.prompt ? 'resolved' : 'unresolved',
        ...(options.prompts ? { groupName: entry.groupName, promptSource: entry.promptSource,
          promptProvenance: entry.promptProvenance || null,
          ...(entry.prompt ? {} : { promptError: entry.promptError ||
            { code: 'prompt_missing', message: 'No exact prompt was available' } }) } : {}),
        status: 'failed', warnings: [] };
      if (options.prompts && !entry.prompt) {
        record.warnings.push('Grok post has no exact prompt; media is saved in the recovery folder');
      }
      let objectUrl;
      try {
        const prior = byId.get(entry.id);
        const recovery = previousRecovery(entry, prior);
        const asset = await resolveOriginalWithRecovery(entry);
        record.bytes = asset.blob.size;
        receivedBytes += asset.blob.size;
        record.mimeType = asset.mimeType;
        record.sourceHost = asset.sourceHost;
        record.quality = asset.quality;
        record.retrievalAttempts = asset.retrievalAttempts;
        record.retrievalErrors = asset.retrievalErrors;
        record.recoveryRounds = asset.recoveryRounds;
        if (entry.kind === 'image' && typeof createImageBitmap === 'function') {
          const bitmap = await createImageBitmap(asset.blob);
          try { record.width = bitmap.width; record.height = bitmap.height; }
          finally { bitmap.close(); }
        }
        if (asset.quality === 'fallback') record.warnings.push('Preferred media URL failed; another original media URL was used');
        if (entry.kind === 'image' || asset.blob.size <= 64 * 1048576) {
          record.sha256 = await originals.fingerprint(asset.blob);
        } else record.hashStatus = 'omitted-large-video';
        const name = `${String(entry.sequence).padStart(6, '0')}-${entry.id.slice(0, 32)}.${asset.extension}`;
        objectUrl = URL.createObjectURL(asset.blob);
        activeObjectUrls.add(objectUrl);
        const accepted = await worker({ action: 'grokDownload', kind: 'media', folder: options.folder,
          groupName: options.prompts ? entry.groupName : undefined,
          savePrompts: options.prompts, sequence: entry.sequence,
          mediaId: entry.id, mediaType: entry.kind, name, url: objectUrl,
          ...(prior ? { retry: true } : {}),
          ...(recovery ? { previousRecovery: recovery } : {}) });
        if (!accepted.ok) throw new Error('Chrome rejected original media download');
        record.downloadId = accepted.downloadId;
        record.relativePath = accepted.relativePath;
        if (accepted.trackingError) {
          record.trackingError = accepted.trackingError;
          record.warnings.push(`Local progress could not be saved: ${accepted.trackingError}`);
        }
        report.queued++;
        record.status = await waitForDownload(accepted.downloadId, accepted.relativePath, checkActive);
        if (record.status === 'complete') {
          report.completed++;
          if (recovery) {
            try {
              const cleanup = await worker({ action: 'cleanupGrokRecovery', folder: options.folder,
                mediaId: entry.id, sequence: entry.sequence, groupName: entry.groupName,
                oldDownloadId: recovery.downloadId,
                oldRelativePath: recovery.relativePath,
                newDownloadId: record.downloadId });
              record.cleanupStatus = cleanup.cleanupStatus;
            } catch (error) {
              record.cleanupStatus = 'failed';
              record.warnings.push(`Old recovery file could not be removed: ${error.message}`);
              report.layoutIssues++;
            }
          }
        }
      } catch (error) {
        record.error = error.message;
        record.retrievalAttempts = error.retrievalAttempts || record.retrievalAttempts;
        record.retrievalErrors = error.retrievalErrors || record.retrievalErrors;
        report.failed++;
        if (error.retryable) controller.congest(`Grok HTTP ${error.httpStatus || 'network'} error`, Date.now() + 1500);
      }
      finally {
        if (objectUrl && record.status !== 'queued') { URL.revokeObjectURL(objectUrl); activeObjectUrls.delete(objectUrl); }
      }
      if (record.warnings.length) report.warnings++;
      return record;
    };
    const outcomes = await queue.run(selected, processEntry, {
      concurrency, controller, memoryBudgetBytes, estimateBytes, checkActive,
      onProgress: update => {
        peakActive = Math.max(peakActive, update.peakActive);
        peakActiveBytes = Math.max(peakActiveBytes, update.peakActiveBytes);
        status(`媒体 ${update.completed}/${selected.length} · ${report.completed} 已完成 · ${report.failed} 失败 · ${update.active}/${update.concurrency} 并发`,
          { stage: 'images', phase: update.coolingDown ? 'cooldown' : 'transferring',
            total: selected.length, processed: update.completed, queued: report.queued,
            failed: report.failed, warnings: report.warnings, retrying, bytes: receivedBytes,
            active: update.active, limit: update.concurrency, reason: update.reason,
            promptErrors: promptCollection?.unresolved || 0, promptSaveErrors: report.promptFilesFailed });
      }
    });
    checkActive();
    report.media = outcomes.map((outcome, index) => outcome.status === 'fulfilled' ? outcome.value : {
      sequence: selected[index].sequence, mediaId: selected[index].id, mediaType: selected[index].kind,
      status: 'failed', warnings: [], error: outcome.reason?.message || String(outcome.reason)
    });
    report.queued = report.media.filter(item => Number.isInteger(item.downloadId)).length;
    report.completed = report.media.filter(item => item.status === 'complete').length;
    report.failed = report.media.filter(item => item.status === 'failed').length;
    report.pending = report.media.filter(item => item.status === 'queued').length;
    report.warnings = report.media.filter(item => item.warnings?.length).length +
      report.promptFiles.filter(item => item.trackingError).length +
      report.recoveryCleanup.filter(item => item.status === 'failed').length;
    report.status = report.failed || report.pending || report.promptFilesFailed ||
      report.promptFiles.some(item => item.status !== 'complete') || report.layoutIssues ||
      (options.prompts && promptCollection?.unresolved)
      ? 'partial' : 'complete';
    report.downloadPerformance = { mode: controller.snapshot().mode,
      requestedConcurrency: concurrency, finalConcurrency: controller.snapshot().concurrency,
      peakActive, peakActiveBytes, memoryBudgetBytes,
      elapsedMs: Date.now() - downloadStartedAt, receivedBytes,
      adaptive: controller.summary() };
    const previousCheckpoint = await worker({ action: 'getMediaRetryCheckpoint', provider: 'Grok',
      folder: options.folder }).catch(() => ({ checkpoint: null }));
    const attempted = new Set(selected.map(entry => entry.id));
    const failed = new Set((previousCheckpoint.checkpoint?.failed || []).filter(id => !attempted.has(id)));
    const unresolved = new Set((previousCheckpoint.checkpoint?.unresolved || []).filter(id =>
      !options.prompts || !found.entries.some(entry => entry.id === id)));
    for (const item of report.media) if (item.status !== 'complete') failed.add(item.mediaId);
    if (options.prompts) {
      for (const entry of found.entries) if (!entry.prompt) unresolved.add(entry.id);
      const failedGroups = new Set(report.promptFiles.filter(item => item.status !== 'complete').map(item => item.groupName));
      for (const entry of found.entries) if (failedGroups.has(entry.groupName)) unresolved.add(entry.id);
    }
    try {
      const saved = await worker({ action: 'saveMediaRetryCheckpoint', provider: 'Grok', checkpoint: {
        schemaVersion: 1, scope, folder: options.folder,
        failed: [...failed], unresolved: [...unresolved] } });
      if (saved.status !== 'saved') throw new Error('恢复清单未保存');
    } catch (error) { report.retryCheckpointError = error.message; report.warnings++; report.status = 'partial'; }
    checkActive();
    status('正在保存 Grok 结果报告…', { stage: 'images', phase: 'finalizing',
      total: selected.length, processed: selected.length, queued: report.queued, failed: report.failed,
      retrying: 0,
      warnings: report.warnings, bytes: receivedBytes, promptErrors: promptCollection?.unresolved || 0,
      promptSaveErrors: report.promptFilesFailed });
    try {
      const latest = await worker({ action: 'getGrokProgress', folder: options.folder,
        savePrompts: options.prompts });
      if (latest.status === 'found') report.progressAtFinish = {
        completedThrough: completedThrough(latest.records),
        completedMedia: latest.records.filter(record => record.kind === 'media' && record.status === 'complete').length
      };
    } catch (error) { report.progressAtFinish = { error: error.message }; }
    const accepted = await worker({ action: 'grokDownload', kind: 'report', folder: options.folder,
      name: 'grok-download-results.json', url: dataUrl('application/json', JSON.stringify(report, null, 2)) });
    if (!accepted.ok) throw new Error('Chrome rejected Grok result report');
    return report;
  }

  function sync() {
    const scope = media.scope(location.pathname);
    if (!scope) { button?.remove(); button = null; return; }
    if (!button || !button.isConnected) {
      button = document.createElement('button');
      button.id = 'grid-grok-export';
      button.style.cssText = 'position:fixed;right:24px;bottom:24px;z-index:999999;border:0;border-radius:14px;background:#09694e;color:#fff;padding:11px 16px;font:600 14px system-ui;box-shadow:0 4px 12px #0004;cursor:pointer;';
      button.textContent = '⬇️ 导出 Grok 图片与视频';
      document.body.appendChild(button);
      button.onclick = async () => {
        if (running) return;
        running = true;
        button.disabled = true;
        let panel;
        try {
          const options = await settings(media.scope(location.pathname));
          if (!options) { button.textContent = '⬇️ 导出 Grok 图片与视频'; return; }
          button.style.display = 'none';
          panel = makeProgressPanel(() => { button.style.display = ''; button.textContent = '⬇️ 导出 Grok 图片与视频'; }, options);
          const report = await run(media.scope(location.pathname), options,
            (message, progress) => panel.update(message, progress));
          panel.update(`${report.status === 'partial' ? '⚠️' : '✓'} ${report.completed}/${report.selected} 个媒体已完成，${report.failed} 个失败，${report.warnings} 条警告；详见结果报告`,
            { stage: 'images', phase: report.status === 'partial' ? 'completed with issues' : 'complete',
              total: report.selected, processed: report.selected, queued: report.queued,
              failed: report.failed, warnings: report.warnings,
              bytes: report.downloadPerformance.receivedBytes,
              promptErrors: report.promptCollection?.unresolved || 0,
              promptSaveErrors: report.promptFilesFailed });
        } catch (error) { const message = exportErrorMessage(error);
          if (panel) panel.update(`⚠️ ${message} 可关闭后重试。`,
            { phase: /HTTP (?:401|403)/.test(error.message) ? 'blocked' : 'error' });
          else button.textContent = `⚠️ ${message} 点击重试。`; }
        finally { panel?.finish(); running = false; button.disabled = false; }
      };
    }
  }

  globalThis.ChatGPTGrokExport = { run, settings, selectedEntry, waitForDownload };
  sync();
  const observer = new MutationObserver(sync);
  observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
  window.addEventListener('popstate', sync);
  let previousUrl = location.href;
  setInterval(() => { if (location.href !== previousUrl) { previousUrl = location.href; sync(); } }, 1000);
})();
