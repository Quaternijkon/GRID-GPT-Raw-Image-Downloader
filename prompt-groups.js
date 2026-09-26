/* Exact-text grouping with content-addressed directory identities. */
(() => {
  const RULE_VERSION = 'exact-cumulative-prompt-content-addressed-v3-unresolved';
  const UNRESOLVED_FOLDER = '未解析';
  const segment = value => typeof value === 'string' ? value : value?.text;
  const MASK_64 = (1n << 64n) - 1n;

  function normalizePrompt(base, editSteps = []) {
    if (!Array.isArray(editSteps)) throw new Error('Prompt edits must be an ordered array');
    const parts = [base, ...editSteps].map(segment);
    if (parts.some(text => typeof text !== 'string')) throw new Error('Prompt segments must contain original text');
    return parts.join('\n\n').replace(/\r\n?/g, '\n').trim();
  }

  function fail(message, issues = []) {
    const error = new Error(`Cannot assign stable prompt groups: ${message}`);
    error.promptIssues = issues;
    return error;
  }

  function groupIdentity(text) {
    if (typeof text !== 'string' || !text) throw new Error('Prompt group identity requires normalized text');
    const bytes = new TextEncoder().encode(text);
    let forward = 0xcbf29ce484222325n, reverse = 0x84222325cbf29ce4n;
    for (const byte of bytes) {
      forward = ((forward ^ BigInt(byte)) * 0x100000001b3n) & MASK_64;
    }
    for (let index = bytes.length - 1; index >= 0; index--) {
      reverse = ((reverse ^ BigInt(bytes[index])) * 0x100000001b3n) & MASK_64;
    }
    const hex = value => value.toString(16).padStart(16, '0');
    const groupName = `p-${hex(forward)}${hex(reverse)}-${bytes.length.toString(16)}`;
    return { groupName, promptText: `${text}\n`, text };
  }

  function plan(allEntries, resolvedRecords, { afterSequence = 0 } = {}) {
    if (!Array.isArray(allEntries)) throw fail('complete entries are required');
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0 || afterSequence > allEntries.length) throw fail('invalid download boundary');
    const byId = new Map(), duplicates = new Set();
    for (const record of Array.isArray(resolvedRecords) ? resolvedRecords : []) {
      if (!record || typeof record.fileId !== 'string' || !record.fileId) continue;
      if (byId.has(record.fileId)) duplicates.add(record.fileId);
      byId.set(record.fileId, record);
    }
    const seenIds = new Set(), prepared = [], issues = [];
    for (const [index, entry] of allEntries.entries()) {
      if (!entry || typeof entry.fileId !== 'string' || !entry.fileId || seenIds.has(entry.fileId) || entry.sequence !== index + 1) throw fail('entries must be the complete, uniquely numbered collection in global order');
      seenIds.add(entry.fileId);
      const record = byId.get(entry.fileId);
      try {
        if (duplicates.has(entry.fileId)) throw new Error('duplicate prompt record identity');
        if (!record || record.status !== 'resolved') throw new Error('prompt unresolved');
        let text;
        if (record.basePrompt !== undefined) {
          text = normalizePrompt(record.basePrompt, record.editSteps || []);
          if (record.cumulativePrompt !== undefined && record.cumulativePrompt !== text) throw new Error('conflicting cumulative prompt');
        } else {
          if (typeof record.cumulativePrompt !== 'string') throw new Error('missing cumulative prompt');
          text = normalizePrompt(record.cumulativePrompt);
          if (text !== record.cumulativePrompt) throw new Error('cumulative prompt is not normalized');
        }
        if (!text) throw new Error('empty prompt');
        prepared.push({ entry, record, text });
      } catch (error) {
        const promptError = { code: record?.status !== 'resolved' && typeof record?.error?.code === 'string'
          ? record.error.code : 'invalid_prompt_record',
          message: record?.status !== 'resolved' && typeof record?.error?.message === 'string'
            ? record.error.message : error.message };
        issues.push({ fileId: entry.fileId, sequence: entry.sequence, ...promptError });
        prepared.push({ entry, record, promptError });
      }
    }
    const groups = [], byText = new Map(), byName = new Map(), all = [];
    for (const { entry, record, text, promptError } of prepared) {
      if (promptError) {
        all.push({ ...entry, groupNumber: undefined, groupName: UNRESOLVED_FOLDER,
          unresolved: true, cumulativePrompt: null, promptError,
          prompt: { fileId: entry.fileId, conversationId: entry.conversationId || record?.conversationId,
            status: 'unresolved', error: promptError } });
        continue;
      }
      let group = byText.get(text);
      if (!group) {
        const identity = groupIdentity(text);
        if (byName.has(identity.groupName) && byName.get(identity.groupName).text !== text) {
          throw fail('prompt directory identity collision');
        }
        const groupNumber = groups.length;
        group = { groupNumber, ...identity, entries: [] };
        byText.set(text, group);
        byName.set(group.groupName, group);
        groups.push(group);
      }
      const grouped = { ...entry, unresolved: false, groupNumber: group.groupNumber, groupName: group.groupName, cumulativePrompt: text, prompt: record };
      all.push(grouped);
      group.entries.push(grouped);
    }
    const selected = all.filter(entry => entry.sequence > afterSequence);
    const selectedNumbers = new Set(selected.map(entry => entry.groupNumber));
    const selectedGroups = groups.filter(group => selectedNumbers.has(group.groupNumber));
    return { all, selected, groups, selectedGroups, issues,
      unresolvedCount: issues.length, selectedUnresolvedCount: selected.filter(entry => entry.unresolved).length,
      unresolvedFolder: UNRESOLVED_FOLDER, groupCount: groups.length, selectedGroupCount: selectedGroups.length };
  }

  const api = { RULE_VERSION, UNRESOLVED_FOLDER, normalizePrompt, groupIdentity, plan };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof globalThis !== 'undefined') globalThis.ChatGPTPromptGroups = api;
})();
