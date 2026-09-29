/* Gemini Library image export. */
(() => {
  const media = globalThis.GRIDGeminiMedia;
  const ui = globalThis.GRIDMediaExportUI;
  const queue = globalThis.ChatGPTDownloadQueue;
  const groups = globalThis.ChatGPTPromptGroups;
  const originals = globalThis.ChatGPTOriginalImages;
  let button = null, running = false;

  function worker(message, timeoutMs = 180000) {
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
  const dataUrl = (type, value) => `data:${type};charset=utf-8,${encodeURIComponent(value)}`;
  function errorMessage(error) {
    const detail = error?.message || String(error);
    if (/HTTP (?:401|403)\b/.test(detail)) return 'Gemini 暂时拒绝读取数据；请确认已登录并在 Library 页面重试。';
    if (/HTTP 429\b/.test(detail)) return 'Gemini 请求过于频繁；请稍后重试。';
    return detail;
  }
  async function settings() {
    const popup = ui.dialog('Gemini', 'library');
    const { el } = popup;
    let closed = false, request = 0, retryIds = null;
    const refresh = async () => {
      if (el('mode').value !== 'auto') { el('progress').textContent = ''; return; }
      const current = ++request;
      el('progress').textContent = '正在核对本地下载进度…';
      try {
        const result = await worker({ action: 'getGeminiProgress', folder: el('folder').value || 'gemini-images',
          savePrompts: el('prompts').checked });
        if (closed || current !== request) return;
        const done = new Set((result.records || []).filter(record => record.kind === 'media' &&
          record.status === 'complete').map(record => record.sequence));
        let through = 0;
        while (done.has(through + 1)) through++;
        el('progress').textContent = through ? `本地记录已完成至编号 ${through}；开始时将与图库核对。` :
          '尚无已完成记录；将从编号 1 开始。';
      } catch (_) { if (!closed && current === request) el('progress').textContent = '本地进度暂不可读取'; }
    };
    el('mode').onchange = () => { el('after-row').hidden = el('mode').value !== 'manual'; void refresh(); };
    el('concurrency-mode').onchange = () => { el('concurrency-row').hidden = el('concurrency-mode').value === 'auto'; };
    el('folder').onchange = () => { void refresh(); };
    el('prompts').onchange = () => { void refresh(); };
    el('show-folder').onclick = () => { void worker({ action: 'showDownloadFolder' }); };
    el('retry-report').onchange = async () => {
      retryIds = null; el('retry-hint').textContent = '';
      const file = el('retry-report').files?.[0];
      if (!file) return;
      try {
        const report = JSON.parse(await file.text());
        if (report.kind !== 'gemini-download-results' || !Array.isArray(report.images))
          throw new Error('这不是 Gemini 图片结果报告。');
        const ids = report.images.filter(item => item.status === 'failed' || item.promptStatus === 'unresolved')
          .map(item => item.mediaId).filter(id => /^rc_[a-f0-9]{16}(?:-[a-f0-9]{32})?$/.test(id));
        if (!ids.length) throw new Error('结果报告中没有可恢复的图片任务。');
        retryIds = [...new Set(ids)];
        if (typeof report.folder === 'string' && originals.sanitizeSegment(report.folder, 'gemini-images') === report.folder)
          el('folder').value = report.folder;
        el('prompts').checked = report.savePrompts === true;
        el('retry-hint').textContent = `将恢复报告中的 ${retryIds.length} 张失败或未解析图片。`;
        el('start').textContent = '开始恢复';
        void refresh();
      } catch (error) { el('error').textContent = error.message; el('retry-report').value = ''; }
    };
    try {
      const saved = await worker({ action: 'getGeminiSettings' });
      el('folder').value = saved.folder || 'gemini-images';
      const concurrency = queue.normalizeConcurrency(saved.concurrency);
      el('concurrency-mode').value = concurrency === 'auto' ? 'auto' : 'manual';
      el('concurrency').value = String(concurrency === 'auto' ? queue.DEFAULT_CONCURRENCY : concurrency);
      el('concurrency-mode').onchange();
      el('start').disabled = false;
      void refresh();
    } catch (error) { el('error').textContent = error.message; }
    return new Promise(resolve => {
      const finish = value => { if (closed) return; closed = true; popup.close(); resolve(value); };
      el('cancel').onclick = el('close').onclick = () => finish(null);
      popup.dialog.addEventListener('cancel', event => { event.preventDefault(); finish(null); });
      el('start').onclick = async () => {
        el('error').textContent = ''; el('start').disabled = true;
        try {
          const folder = el('folder').value.trim();
          if (originals.sanitizeSegment(folder, 'gemini-images') !== folder) throw new Error('下载目录名包含不支持的字符。');
          const after = el('mode').value === 'manual' && !retryIds ? Number(el('after').value) : 0;
          if (!Number.isSafeInteger(after) || after < 0 || after > 999999) throw new Error('编号必须为 0–999999 的整数。');
          const concurrency = el('concurrency-mode').value === 'auto' ? 'auto' : Number(el('concurrency').value);
          if (concurrency !== 'auto' && (!Number.isInteger(concurrency) || concurrency < 1 ||
              concurrency > queue.MAX_CONCURRENCY)) throw new Error('并发数量必须为 1–12 的整数。');
          const saved = await worker({ action: 'setGeminiSettings', folder, concurrency });
          if (saved.status !== 'saved') throw new Error('无法保存下载设置。');
          finish({ folder, after, mode: retryIds ? 'report' : el('mode').value, retryIds,
            prompts: el('prompts').checked, concurrency: queue.normalizeConcurrency(saved.concurrency) });
        } catch (error) { el('error').textContent = error.message; el('start').disabled = false; }
      };
      popup.dialog.showModal();
    });
  }
  async function waitForDownload(downloadId, relativePath, checkActive, timeoutMs = 10 * 60 * 1000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      checkActive();
      const result = await worker({ action: 'getGeminiDownloadState', downloadId, relativePath });
      if (result.status === 'complete' && result.exists) return 'complete';
      if (result.status === 'interrupted' || result.status === 'missing' || result.status === 'complete')
        throw new Error(`Chrome download ${result.status}${result.exists === false ? ' (file missing)' : ''}`);
      await new Promise(resolve => setTimeout(resolve, 750));
    }
    return 'queued';
  }
  async function run(options, status) {
    const startUrl = location.href;
    const checkActive = () => { if (location.href !== startUrl) throw new Error('页面已切换，导出已停止。'); };
    status('正在读取 Gemini Library 全部图片页面…');
    const found = await media.collect(fetch, { checkActive,
      onProgress: progress => status(progress.retry
        ? `Gemini 暂时未返回列表，自动等待恢复（第 ${progress.retry.attempt}/${progress.retry.maxAttempts} 次）；已读取 ${progress.pages} 页…`
        : `已读取 ${progress.pages} 页、${progress.images} 张图片…`) });
    const promptCollection = options.prompts ? await media.resolvePrompts(fetch, found.entries, {
      token: found.token, checkActive,
      onProgress: progress => status(progress.retry
        ? `Gemini 会话暂时不可用，自动等待恢复（第 ${progress.retry.attempt}/${progress.retry.maxAttempts} 次）…`
        : progress.phase === 'recovery-wait'
          ? `仍有 ${progress.unresolved} 张提示词未解析，${Math.round(progress.waitMs / 1000)} 秒后自动复核相关会话…`
          : progress.phase === 'recovery'
            ? `正在复核未解析提示词 ${progress.processed}/${progress.total} 个会话…`
            : `正在提取提示词 ${progress.processed}/${progress.total} 个会话…`)
    }) : null;
    let progress;
    try { progress = await worker({ action: 'getGeminiProgress', folder: options.folder, savePrompts: options.prompts }); }
    catch (error) { if (options.mode === 'auto') throw error; progress = { status: 'found', records: [] }; }
    if (progress.status !== 'found') throw new Error('无法读取 Gemini 下载进度。');
    const byId = new Map(progress.records.filter(record => record.kind === 'media').map(record => [record.mediaId, record]));
    const promptGroups = new Map();
    for (const entry of found.entries) {
      if (!options.prompts) continue;
      entry.groupName = entry.prompt ? groups.groupIdentity(entry.prompt).groupName : '未解析';
      if (entry.prompt) promptGroups.set(entry.groupName, entry.prompt);
      else {
        const prior = byId.get(entry.id);
        const priorGroup = prior?.relativePath?.split('/')[1];
        // A temporary resolver miss must not move an already grouped original
        // back into 未解析, or repeated runs would regress the file layout.
        if (prior?.status === 'complete' && /^p-[0-9a-f]{32}-[0-9a-f]+$/.test(priorGroup))
          entry.groupName = priorGroup;
      }
    }
    const expectedRoot = entry => options.prompts ? `${options.folder}/${entry.groupName}/` : `${options.folder}/`;
    const matches = (entry, record) => record?.status === 'complete' && record.mediaId === entry.id &&
      record.relativePath?.startsWith(expectedRoot(entry));
    const complete = new Set(found.entries.filter(entry => matches(entry, byId.get(entry.id))).map(entry => entry.id));
    const through = records => {
      const bySequence = new Map(records.filter(record => record.kind === 'media').map(record => [record.sequence, record]));
      let sequence = 0;
      for (const entry of found.entries) {
        if (!matches(entry, bySequence.get(entry.sequence))) break;
        sequence = entry.sequence;
      }
      return sequence;
    };
    if (options.mode === 'auto' && progress.records.some(record => record.status === 'in_progress'))
      throw new Error('先前的 Gemini 下载仍在进行，请等待 Chrome 下载完成后重试。');
    if (options.after > found.entries.length) throw new Error(`手动编号 ${options.after} 超出当前 ${found.entries.length} 张图片。`);
    const recoveryCleanup = [];
    if (options.prompts) for (const entry of found.entries) {
      const prior = byId.get(entry.id);
      if (!prior?.previousRecovery || !matches(entry, prior) || entry.groupName === '未解析') continue;
      try {
        const cleanup = await worker({ action: 'cleanupGeminiRecovery', folder: options.folder,
          mediaId: entry.id, oldDownloadId: prior.previousRecovery.downloadId,
          oldRelativePath: prior.previousRecovery.relativePath, newDownloadId: prior.downloadId });
        recoveryCleanup.push({ mediaId: entry.id, status: cleanup.cleanupStatus });
      } catch (error) { recoveryCleanup.push({ mediaId: entry.id, status: 'failed', error: error.message }); }
    }
    const selected = found.entries.filter(entry => options.retryIds ? options.retryIds.includes(entry.id) :
      entry.sequence > options.after && (options.mode !== 'auto' || !complete.has(entry.id)));
    const report = { schemaVersion: 1, kind: 'gemini-download-results',
      extensionVersion: chrome.runtime.getManifest().version, page: startUrl, createdAt: new Date().toISOString(),
      folder: options.folder, boundaryMode: options.mode, afterSequence: options.after,
      savePrompts: options.prompts, pagination: found.pagination, promptCollection,
      unresolvedPrompts: promptCollection?.unresolved || 0,
      recoveredPrompts: promptCollection?.recovered || 0,
      discovered: found.entries.length, selected: selected.length, skipped: found.entries.length - selected.length,
      progressAtStart: { completedThrough: through(progress.records), completedImages: complete.size },
      queued: 0, completed: 0, failed: 0, pending: 0, promptFilesQueued: 0, promptFilesFailed: 0,
      qualityPolicy: 'Full size Gemini image; exact validated response bytes, no preview substitution or re-encoding.',
      downloadStatusMeaning: 'queued means Chrome accepted the download; completed means Chrome reported completion and the file exists.',
      images: [], promptFiles: [], recoveryCleanup };
    status(`已发现 ${found.entries.length} 张图片，本次处理 ${selected.length} 张。`,
      { total: selected.length, processed: 0, completed: 0, failed: 0 });
    if (options.prompts) {
      const saved = new Set(progress.records.filter(record => record.kind === 'prompt' && record.status === 'complete')
        .map(record => record.groupName));
      const selectedGroups = new Set(selected.map(entry => entry.groupName));
      for (const [groupName, prompt] of promptGroups) {
        if (!selectedGroups.has(groupName) && (options.mode !== 'auto' || saved.has(groupName))) continue;
        checkActive();
        const item = { groupName, status: 'failed' };
        try {
          if (new TextEncoder().encode(prompt).length > 100000) throw new Error('提示词超过 TXT 大小限制');
          const accepted = await worker({ action: 'geminiDownload', kind: 'prompt', folder: options.folder,
            groupName, name: 'prompt.txt', url: dataUrl('text/plain', `${prompt}\n`) });
          item.downloadId = accepted.downloadId; item.relativePath = accepted.relativePath;
          report.promptFilesQueued++;
          item.status = await waitForDownload(accepted.downloadId, accepted.relativePath, checkActive);
        } catch (error) { item.error = error.message; report.promptFilesFailed++; }
        report.promptFiles.push(item);
      }
    }
    const memoryBudgetBytes = (navigator.deviceMemory <= 4 ? 192 : navigator.deviceMemory >= 8 ? 512 : 384) * 1048576;
    const concurrency = queue.normalizeConcurrency(options.concurrency);
    const controller = queue.createController({ concurrency, memoryBudgetBytes, initialConcurrency: 8, maxConcurrency: 32 });
    const startedAt = Date.now();
    let receivedBytes = 0;
    const processEntry = async entry => {
      checkActive();
      const record = { sequence: entry.sequence, mediaId: entry.id, chatId: entry.chatId,
        responseId: entry.responseId, promptStatus: !options.prompts ? 'disabled' : entry.prompt ? 'resolved' : 'unresolved',
        ...(options.prompts ? { groupName: entry.groupName, ...(entry.prompt ? {} : { promptError: entry.promptError }) } : {}),
        status: 'failed', warnings: [] };
      const prior = byId.get(entry.id);
      const recoveryPrefix = `${options.folder}/未解析/${String(entry.sequence).padStart(6, '0')}-${entry.id}.`;
      const candidate = prior?.previousRecovery || (prior?.status === 'complete' &&
        prior.relativePath?.startsWith(recoveryPrefix)
        ? { downloadId: prior.downloadId, relativePath: prior.relativePath } : null);
      const previous = options.prompts && entry.groupName !== '未解析' &&
        Number.isInteger(candidate?.downloadId) && candidate?.relativePath?.startsWith(recoveryPrefix) &&
        /^(?:png|jpg|webp|gif|avif)$/.test(candidate.relativePath.slice(recoveryPrefix.length)) ? candidate : null;
      try {
        const accepted = await worker({ action: 'geminiDownload', kind: 'media', folder: options.folder,
          sequence: entry.sequence, mediaId: entry.id, url: entry.url, savePrompts: options.prompts,
          groupName: options.prompts ? entry.groupName : undefined,
          ...(prior ? { retry: true } : {}), ...(previous ? { previousRecovery: previous } : {}) }, 5 * 60 * 1000);
        record.downloadId = accepted.downloadId; record.relativePath = accepted.relativePath;
        record.bytes = accepted.bytes; record.mimeType = accepted.mimeType; record.sha256 = accepted.sha256;
        record.sourceHost = accepted.sourceHost; record.retrievalAttempts = accepted.retrievalAttempts;
        record.recoveryRounds = accepted.recoveryRounds; record.retrievalErrors = accepted.retrievalErrors;
        receivedBytes += accepted.bytes || 0;
        if (accepted.trackingError) record.warnings.push(`本地进度记录失败：${accepted.trackingError}`);
        report.queued++;
        record.status = await waitForDownload(accepted.downloadId, accepted.relativePath, checkActive);
        if (record.status === 'complete') {
          report.completed++;
          if (previous) {
            try {
              const cleanup = await worker({ action: 'cleanupGeminiRecovery', folder: options.folder,
                mediaId: entry.id, oldDownloadId: previous.downloadId,
                oldRelativePath: previous.relativePath, newDownloadId: accepted.downloadId });
              record.cleanupStatus = cleanup.cleanupStatus;
            } catch (error) { record.cleanupStatus = 'failed'; record.warnings.push(error.message); }
          }
        }
      } catch (error) {
        record.error = error.message; report.failed++;
        if ([429, 500, 502, 503, 504].includes(error.httpStatus) || /HTTP (?:429|5\d\d)/.test(error.message))
          controller.congest('Gemini request backoff', Date.now() + 1500);
      }
      return record;
    };
    const outcomes = await queue.run(selected, processEntry, { concurrency, controller, memoryBudgetBytes,
      estimateBytes: () => 24 * 1048576, checkActive,
      onProgress: update => status(`图片 ${update.completed}/${selected.length} · ${report.completed} 已完成 · ${report.failed} 失败 · ${update.active}/${update.concurrency} 并发`,
        { total: selected.length, processed: update.completed, completed: report.completed,
          failed: report.failed, active: update.active, limit: update.concurrency }) });
    checkActive();
    report.images = outcomes.map((outcome, index) => outcome.status === 'fulfilled' ? outcome.value : {
      sequence: selected[index].sequence, mediaId: selected[index].id, status: 'failed',
      error: outcome.reason?.message || String(outcome.reason) });
    report.completed = report.images.filter(item => item.status === 'complete').length;
    report.failed = report.images.filter(item => item.status === 'failed').length;
    report.pending = report.images.filter(item => item.status === 'queued').length;
    report.layoutIssues = report.images.filter(item => item.cleanupStatus === 'failed').length +
      report.recoveryCleanup.filter(item => item.status === 'failed').length;
    report.status = report.failed || report.pending || report.promptFilesFailed ||
      report.promptFiles.some(item => item.status !== 'complete') ||
      report.layoutIssues ||
      options.prompts && promptCollection?.unresolved ? 'partial' : 'complete';
    report.downloadPerformance = { mode: controller.snapshot().mode, requestedConcurrency: concurrency,
      finalConcurrency: controller.snapshot().concurrency, peakActive: controller.snapshot().peakTarget,
      elapsedMs: Date.now() - startedAt, receivedBytes, adaptive: controller.summary() };
    try {
      const latest = await worker({ action: 'getGeminiProgress', folder: options.folder, savePrompts: options.prompts });
      report.progressAtFinish = { completedThrough: through(latest.records),
        completedImages: latest.records.filter(record => record.kind === 'media' && record.status === 'complete').length };
    } catch (error) { report.progressAtFinish = { error: error.message }; }
    status('正在保存 Gemini 结果报告…');
    await worker({ action: 'geminiDownload', kind: 'report', folder: options.folder,
      name: 'gemini-download-results.json', url: dataUrl('application/json', JSON.stringify(report, null, 2)) });
    return report;
  }
  function sync() {
    if (!media.supported(location.pathname)) { button?.remove(); button = null; return; }
    if (!button || !button.isConnected) {
      button = document.createElement('button'); button.id = 'grid-gemini-export';
      button.style.cssText = 'position:fixed;right:24px;bottom:24px;z-index:999999;border:0;border-radius:14px;background:#09694e;color:#fff;padding:11px 16px;font:600 14px system-ui;box-shadow:0 4px 12px #0004;cursor:pointer';
      button.textContent = '⬇️ 导出 Gemini 图片'; document.body.appendChild(button);
      button.onclick = async () => {
        if (running) return;
        running = true; button.disabled = true;
        let panel;
        try {
          const options = await settings();
          if (!options) return;
          button.style.display = 'none';
          panel = ui.progress('Gemini', () => { button.style.display = ''; button.textContent = '⬇️ 导出 Gemini 图片'; });
          const report = await run(options, (message, progress) => panel.update(message, progress));
          const details = [
            report.recoveredPrompts ? `${report.recoveredPrompts} 张提示词自动恢复` : null,
            report.unresolvedPrompts ? `${report.unresolvedPrompts} 张提示词仍未解析` : null,
            report.promptFilesFailed ? `${report.promptFilesFailed} 个提示词文件失败` : null,
            report.layoutIssues ? `${report.layoutIssues} 个旧文件待清理` : null
          ].filter(Boolean);
          panel.update(`${report.status === 'partial' ? '⚠️' : '✓'} 本次 ${report.completed}/${report.selected} 张图片已完成，${report.failed} 张失败${details.length ? `，${details.join('，')}` : ''}；详见结果报告`,
            { total: report.selected, processed: report.selected, completed: report.completed, failed: report.failed });
        } catch (error) {
          const message = errorMessage(error);
          if (panel) panel.update(`⚠️ ${message} 可关闭后重试。`);
          else button.textContent = `⚠️ ${message} 点击重试。`;
        } finally { panel?.finish(); running = false; button.disabled = false; }
      };
    }
  }
  globalThis.GRIDGeminiExport = { run, settings, waitForDownload };
  sync();
  new MutationObserver(sync).observe(document.body || document.documentElement, { childList: true, subtree: true });
  window.addEventListener('popstate', sync);
  let previousUrl = location.href;
  setInterval(() => { if (location.href !== previousUrl) { previousUrl = location.href; sync(); } }, 1000);
})();
