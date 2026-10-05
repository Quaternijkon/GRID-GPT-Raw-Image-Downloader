/* Portable, dependency-free evidence for GLRY. No cookies, URLs, or conversation dumps. */
(() => {
  const PROVIDERS = new Set(['chatgpt', 'grok', 'gemini']);
  const FILE_NAME = '.glry/grid-media-index.json';
  const MAX_RECORDS = 20000;
  const MAX_DOCUMENT_BYTES = 8 * 1048576;
  const CACHE_BYTES = 2 * 1048576;
  const string = value => typeof value === 'string' && value.length > 0 && value.length <= 512 &&
    !/[\x00-\x1f]/.test(value) ? value : undefined;
  const text = value => typeof value === 'string' && value.length <= 200000 ? value : undefined;
  const positive = value => Number.isSafeInteger(value) && value > 0 ? value : undefined;
  const seedValue = value => Number.isSafeInteger(value) ? value :
    string(value) && value.length <= 128 ? value : undefined;
  const clean = value => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null));
  const byteLength = value => {
    let bytes = 0;
    for (const character of JSON.stringify(value)) {
      const point = character.codePointAt(0);
      bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    }
    return bytes;
  };

  function timeNs(value, alreadyNs = false, numericUnit = 'seconds') {
    try {
      if (value === null || value === undefined || value === '') return undefined;
      let result;
      if (alreadyNs && /^\d{1,22}$/.test(String(value))) result = BigInt(value);
      else if (/^\d+(?:\.\d{1,9})?$/.test(String(value))) {
        const [seconds, fraction = ''] = String(value).split('.');
        const digits = numericUnit === 'milliseconds' ? 6 : 9;
        result = BigInt(seconds) * (digits === 6 ? 1000000n : 1000000000n) +
          BigInt(fraction.padEnd(digits, '0').slice(0, digits));
      } else if (typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value)) {
        const parts = value.match(/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?(Z|[+-]\d\d:\d\d)$/i);
        const milliseconds = parts ? Date.parse(parts[1] + parts[3]) : NaN;
        if (Number.isSafeInteger(milliseconds)) result = BigInt(milliseconds) * 1000000n + BigInt((parts[2] || '').padEnd(9, '0'));
      }
      return result > 0n && result <= 8640000000000000000000n ? result.toString() : undefined;
    } catch (_) { return undefined; }
  }

  function relativePath(value, folder) {
    if (typeof value !== 'string' || !value.startsWith(`${folder}/`)) return undefined;
    const path = value.slice(folder.length + 1);
    if (!path || path.length > 1024 || /[\\<>:"|?*\x00-\x1f]/.test(path) ||
        path.split('/').some(part => !part || part === '.' || part === '..') || path.startsWith('.glry/')) return undefined;
    return path;
  }

  function provenance(value) {
    if (typeof value === 'string') return string(value);
    if (!value || typeof value !== 'object') return undefined;
    const result = Object.create(null);
    for (const name of ['conversationId', 'taskRootMessageId', 'taskKind', 'outputMessageId', 'outputNodeId',
      'outputAssetId', 'galleryMessageId', 'ruleVersion', 'adapterVersion', 'kind', 'responseId', 'messageId',
      'sourceResponseId', 'inputResponseId', 'identityWarning']) {
      if (string(value[name])) result[name] = value[name];
    }
    if (positive(value.duplicateOutputCount)) result.duplicateOutputCount = value.duplicateOutputCount;
    for (const name of ['sourceMessageIds', 'branchPath']) {
      if (Array.isArray(value[name]) && value[name].length <= 2000 && value[name].every(string)) result[name] = [...value[name]];
    }
    return Object.keys(result).length ? result : undefined;
  }

  function sanitize(document, savePrompts = true) {
    if (document?.kind !== 'grid-media-index' || document.schemaVersion !== 1 ||
        !PROVIDERS.has(document.provider) || !string(document.scope) || !Array.isArray(document.media) ||
        document.media.length > MAX_RECORDS || !Array.isArray(document.snapshots || []) ||
        (document.snapshots || []).length > MAX_RECORDS) throw new Error('Invalid GRID media index');
    const media = [], snapshots = [];
    for (const item of document.media) {
      const provider = item.provider ?? document.provider, scope = item.scope ?? document.scope;
      if (!PROVIDERS.has(provider) || !string(scope) || !string(item.id) ||
          !['complete', 'queued', 'failed'].includes(item.status)) throw new Error('Invalid GRID media record');
      const path = typeof item.relativePath === 'string' ? relativePath(`root/${item.relativePath}`, 'root') : undefined;
      if (!path) throw new Error('Unsafe GRID media path');
      media.push(clean({ provider, scope, id: item.id, fileId: string(item.fileId), relativePath: path,
        sequence: positive(item.sequence), seed: seedValue(item.seed),
        createdAtNs: timeNs(item.createdAtNs, true), modelName: string(item.modelName),
        width: positive(item.width), height: positive(item.height), bytes: positive(item.bytes),
        mimeType: typeof item.mimeType === 'string' && /^(?:image|video)\/[a-z0-9.+-]{1,60}$/i.test(item.mimeType) ? item.mimeType : undefined,
        sha256: /^[a-f0-9]{64}$/i.test(item.sha256 || '') ? item.sha256.toLowerCase() : undefined,
        promptSource: provenance(item.promptSource), promptSnapshotId: string(item.promptSnapshotId),
        inputAtNs: item.promptSource?.identityWarning === 'duplicate_output_same_prompt' ? undefined :
          timeNs(item.inputAtNs, true), status: item.status }));
    }
    for (const item of document.snapshots || []) {
      const provider = item.provider ?? document.provider, scope = item.scope ?? document.scope;
      if (!PROVIDERS.has(provider) || !string(scope) || !string(item.id)) throw new Error('Invalid GRID prompt snapshot');
      snapshots.push(clean({ provider, scope, id: item.id, conversationId: string(item.conversationId),
        taskRootMessageId: string(item.taskRootMessageId), outputNodeId: string(item.outputNodeId),
        identityWarning: string(item.identityWarning), duplicateOutputCount: positive(item.duplicateOutputCount),
        parentSnapshotId: item.identityWarning === 'duplicate_output_same_prompt' ? undefined : string(item.parentSnapshotId),
        ...(savePrompts ? { basePrompt: text(item.basePrompt), text: text(item.text),
          editSteps: Array.isArray(item.editSteps) && item.editSteps.length <= 2000 ? item.editSteps.map(step => clean({
            messageId: string(step.messageId), text: text(step.text), createdAtNs: timeNs(step.createdAtNs, true)
          })).filter(step => step.messageId && step.text !== undefined) : undefined } : {}),
        sourceMessageIds: item.identityWarning !== 'duplicate_output_same_prompt' &&
          Array.isArray(item.sourceMessageIds) && item.sourceMessageIds.length <= 2000 &&
          item.sourceMessageIds.every(string) ? [...item.sourceMessageIds] : undefined,
        branchPath: item.identityWarning !== 'duplicate_output_same_prompt' &&
          Array.isArray(item.branchPath) && item.branchPath.length <= 2000 &&
          item.branchPath.every(string) ? [...item.branchPath] : undefined,
        promptHash: /^[a-f0-9]{64}$/i.test(item.promptHash || '') ? item.promptHash.toLowerCase() : undefined }));
    }
    const result = { kind: 'grid-media-index', schemaVersion: 1, provider: document.provider, scope: document.scope, media, snapshots };
    if (byteLength(result) > MAX_DOCUMENT_BYTES) throw new Error('GRID media index exceeds 8 MiB');
    return result;
  }

  function snapshot(entry, provider, scope) {
    const prompt = provider === 'chatgpt' ? entry.prompt : null;
    const source = prompt || entry.promptProvenance || {};
    const conversationId = source.conversationId || entry.sourceConversationId || entry.chatId;
    const outputNodeId = source.outputNodeId || source.outputMessageId || source.sourceResponseId || entry.sourceResponseId || entry.responseId;
    const id = provider === 'chatgpt' && conversationId && outputNodeId ? `${conversationId}:${outputNodeId}` : entry.id;
    if (!id || !source.cumulativePrompt && !entry.prompt) return null;
    const ambiguous = source.identityWarning === 'duplicate_output_same_prompt';
    return clean({ provider, scope, id, conversationId, outputNodeId,
      identityWarning: source.identityWarning, duplicateOutputCount: source.duplicateOutputCount,
      taskRootMessageId: source.taskRootMessageId,
      parentSnapshotId: !ambiguous && source.parentOutputNodeId && conversationId ? `${conversationId}:${source.parentOutputNodeId}` : undefined,
      basePrompt: source.basePrompt || (typeof entry.prompt === 'string' ? entry.prompt : undefined),
      text: source.cumulativePrompt || (typeof entry.prompt === 'string' ? entry.prompt : undefined),
      editSteps: source.editSteps?.map(step => clean({ messageId: step.messageId, text: step.text,
        createdAtNs: ambiguous ? undefined : timeNs(step.createdAt) })),
      sourceMessageIds: ambiguous ? undefined : source.sourceMessageIds, branchPath: ambiguous ? undefined : source.branchPath });
  }

  function build({ provider, scope, folder, records, entries = [], savePrompts = false }) {
    const entriesById = new Map(entries.map(entry => [entry.fileId || entry.id, entry]));
    const media = [], snapshots = new Map();
    for (const record of records || []) {
      const id = record.fileId || record.mediaId || record.id;
      const entry = entriesById.get(id) || {};
      const timeUnit = provider === 'grok' && Number(entry.generationTimeSource) >= 1e11 ? 'milliseconds' : 'seconds';
      const path = relativePath(record.relativePath || record.imageRelativePath, folder);
      // Failed requests with no destination are kept in the ordinary report, never guessed into this lookup.
      if (!id || !path) continue;
      const promptSnapshot = savePrompts ? snapshot(entry, provider, scope) : null;
      if (promptSnapshot) snapshots.set(promptSnapshot.id, promptSnapshot);
      media.push(clean({ provider, scope, id, fileId: record.fileId || entry.fileId,
        sequence: record.sequence ?? entry.sequence, seed: record.seed ?? entry.seed,
        relativePath: path, createdAtNs: timeNs(entry.creationTimeNs, true) ||
          timeNs(entry.generationTimeSource, false, timeUnit) || timeNs(record.createdAt ?? entry.createdAt),
        modelName: record.modelName || entry.modelName, width: record.width || record.reportedWidth || entry.reportedWidth,
        height: record.height || record.reportedHeight || entry.reportedHeight, bytes: record.bytes,
        mimeType: record.mimeType, sha256: record.sha256,
        promptSource: savePrompts ? provenance(entry.promptProvenance) || record.promptSource || entry.promptSource : undefined,
        promptSnapshotId: promptSnapshot?.id, inputAtNs: savePrompts &&
          entry.prompt?.identityWarning !== 'duplicate_output_same_prompt' ? timeNs(entry.prompt?.inputCreatedAt) : undefined,
        status: ['complete', 'queued', 'failed'].includes(record.status) ? record.status :
          record.saveStatus === 'queued' ? 'queued' : 'failed' }));
    }
    if (savePrompts) for (const entry of entries) {
      const promptSnapshot = snapshot(entry, provider, scope);
      if (promptSnapshot) snapshots.set(promptSnapshot.id, promptSnapshot);
    }
    return sanitize({ kind: 'grid-media-index', schemaVersion: 1, provider, scope,
      media, snapshots: [...snapshots.values()] }, savePrompts);
  }

  const identity = item => `${item.provider}\n${item.scope}\n${item.id}`;
  function merge(previous, next, savePrompts = true) {
    const newer = sanitize(next, savePrompts);
    if (!previous) return newer;
    const older = sanitize(previous, savePrompts);
    const mergeRows = (oldRows, newRows, isMedia) => {
      const rows = new Map(oldRows.map(item => [identity(item), item]));
      for (const item of newRows) {
        const prior = rows.get(identity(item));
        // A retry can add evidence but cannot erase the last successful placement with a failed request.
        const update = prior && isMedia && prior.status === 'complete' && item.status === 'failed'
          ? { ...item, relativePath: prior.relativePath, status: prior.status } : item;
        rows.set(identity(item), { ...prior, ...update });
      }
      return [...rows.values()];
    };
    return sanitize({ ...newer, media: mergeRows(older.media, newer.media, true),
      snapshots: mergeRows(older.snapshots, newer.snapshots, false) }, savePrompts);
  }

  function boundedCache(cache, key, document) {
    const entries = Object.entries(cache || {}).filter(([name, value]) => name !== key && value?.document);
    entries.unshift([key, { savedAt: Date.now(), document }]);
    entries.sort((a, b) => (b[1].savedAt || 0) - (a[1].savedAt || 0));
    const result = Object.create(null);
    for (const [name, value] of entries.slice(0, 8)) {
      result[name] = value;
      if (byteLength(result) > CACHE_BYTES) delete result[name];
    }
    return { cache: result, currentRetained: !!result[key] };
  }

  const api = { FILE_NAME, CACHE_BYTES, timeNs, relativePath, provenance, sanitize, build, merge, boundedCache };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  globalThis.GRIDMediaIndex = api;
})();
