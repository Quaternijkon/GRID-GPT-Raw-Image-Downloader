/* Validate an existing GRID result before making any prompt-only request. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ChatGPTPromptRetry = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const FILE_ID = /^file[_-][A-Za-z0-9_-]{8,100}$/;
  const CONVERSATION_ID = /^[a-f0-9]{8}-[a-f0-9-]{20,60}$/i;
  const FOLDER = /^[^\\/\x00-\x1f]+$/;
  const IMAGE_NAME = /^\d{6}-[^\\/\x00-\x1f]+\.(?:png|jpe?g|webp|gif|avif|bmp)$/i;

  function plan(report, folder, page) {
    const priorRetry = report?.kind === 'prompt-retry-results' && report.schemaVersion === 1;
    const initialExport = report?.schemaVersion === 4 && report.savePrompts === true;
    if (!report || (!initialExport && !priorRetry) ||
        !Array.isArray(report.images) || !report.images.length ||
        !FOLDER.test(folder) || !page || typeof page !== 'string') {
      throw new Error('请选择此扩展生成的有效下载结果 JSON（含提示词记录）。');
    }
    if (priorRetry && report.folder !== folder) throw new Error('重试报告与目标目录不匹配。');
    let previous;
    try { previous = new URL(report.page); } catch (_) { throw new Error('结果报告缺少有效页面地址。'); }
    const current = new URL(page);
    const folderId = current.pathname.match(/\/d\/([a-f0-9-]+)/i)?.[1];
    const expectedScope = current.pathname.startsWith('/images') ? 'generated-images'
      : folderId ? `library-folder:${folderId}` : null;
    if (previous.origin !== 'https://chatgpt.com' || current.origin !== previous.origin ||
        previous.pathname !== current.pathname || !expectedScope || report.scope !== expectedScope) {
      throw new Error('结果报告与当前 ChatGPT 页面或资料库目录不匹配。');
    }
    const unresolved = report.images.filter(item => priorRetry
      ? item?.promptStatus === 'unresolved' || item?.saveStatus === 'failed'
      : item?.promptStatus === 'unresolved');
    if (!unresolved.length) throw new Error('结果报告中没有需要重试的提示词。');
    const sequences = new Set(), fileIds = new Set();
    const entries = unresolved.map(item => {
      const sourceId = priorRetry ? item.conversationId : item.promptSource?.conversationId;
      const prefix = `${folder}/未解析/`;
      const relativePath = priorRetry ? item.imageRelativePath : item.relativePath;
      const name = priorRetry ? relativePath?.slice(prefix.length) : item.name;
      if (!Number.isSafeInteger(item.sequence) || item.sequence < 1 || item.sequence > 999999 ||
          sequences.has(item.sequence) || !FILE_ID.test(item.fileId) || fileIds.has(item.fileId) ||
          !CONVERSATION_ID.test(sourceId) || (!priorRetry && (item.groupName !== '未解析' || item.status !== 'queued')) ||
          !IMAGE_NAME.test(name) || !name.startsWith(String(item.sequence).padStart(6, '0') + '-') ||
          relativePath !== prefix + name ||
          !(priorRetry ? item.promptError?.code || item.saveStatus === 'failed' : item.promptError?.code)) {
        throw new Error('结果报告存在身份、目录或文件名不一致的未解析记录，已停止重试。');
      }
      sequences.add(item.sequence);
      fileIds.add(item.fileId);
      return { fileId: item.fileId, conversationId: sourceId, sequence: item.sequence,
        imageName: name, previousError: item.promptError || { code: 'prompt_save_failed', message: item.saveError || 'Prompt file was not saved' } };
    });
    return { folder, sourceReportCreatedAt: report.createdAt || null, sourceExtensionVersion: report.extensionVersion,
      page: previous.href, scope: report.scope, entries, conversationCount: new Set(entries.map(item => item.conversationId)).size };
  }

  function promptFileName(sequence) {
    if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > 999999) throw new Error('Invalid prompt sequence');
    return `${String(sequence).padStart(6, '0')}-prompt.txt`;
  }

  return { plan, promptFileName };
});
