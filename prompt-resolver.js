/* Conservative conversation-mapping adapter. Known shapes are checked against
 * sampled live mappings; unknown shapes and conflicting branches fail closed. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ChatGPTPromptResolver = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const RULE_VERSION = 'reference-or-text-image-rounds-v3-nonimage-attachments';
  const ADAPTER_VERSION = 'chatgpt-mapping-v9';
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const string = value => typeof value === 'string' && value.length ? value : null;
  const fail = (code, message, diagnostic) => {
    throw Object.assign(new Error(message), { code, ...(diagnostic ? { diagnostic } : {}) });
  };
  const normalize = text => text.replace(/\r\n?/g, '\n');

  function pointerId(pointer) {
    if (typeof pointer !== 'string') return null;
    const match = /^(?:sediment:\/\/)?(file[-_][A-Za-z0-9_-]+)$/.exec(pointer);
    return match ? match[1] : null;
  }

  function asset(part) {
    if (!part || part.content_type !== 'image_asset_pointer') return null;
    const assetPointer = string(part.asset_pointer);
    const fileId = pointerId(assetPointer);
    // The content type itself is sufficient to identify an image event in the
    // ancestry. An opaque historical pointer may reset/finish a round, but it
    // can never match a requested target without an exact supported file ID.
    return { assetPointer, fileId, identitySupported: Boolean(fileId) };
  }

  function partType(part) {
    if (typeof part === 'string') return 'text';
    const type = part?.content_type;
    return typeof type === 'string' && /^[a-z0-9_:-]{1,40}$/i.test(type) ? type : 'unknown';
  }

  function targetEvidence(mapping, targetFileId, messageId) {
    let exactPointerParts = 0, exactPointerInOutputRole = 0, galleryMessagePresent = false;
    for (const node of Object.values(mapping)) {
      const message = node?.message;
      if (messageId && message?.id === messageId) galleryMessagePresent = true;
      for (const part of Array.isArray(message?.content?.parts) ? message.content.parts : []) {
        if (part?.content_type === 'image_asset_pointer' && pointerId(part.asset_pointer) === targetFileId) {
          exactPointerParts++;
          if (message?.author?.role === 'assistant' || message?.author?.role === 'tool') exactPointerInOutputRole++;
        }
      }
    }
    return { mappingNodes: Object.keys(mapping).length, exactPointerParts,
      exactPointerInOutputRole, galleryMessagePresent };
  }

  // Exact non-image schemas only. Do not treat an unfamiliar content_type (or
  // extra resource-bearing field on a familiar type) as harmless reasoning.
  function nonImageContent(content) {
    if (!content || typeof content !== 'object' || Array.isArray(content)) return false;
    const keysOnly = (object, keys) => Object.keys(object).every(key => keys.includes(key));
    if (content.content_type === 'reasoning_recap') {
      return keysOnly(content, ['content_type', 'content']) && typeof content.content === 'string';
    }
    if (content.content_type === 'code') {
      return keysOnly(content, ['content_type', 'language', 'text', 'response_format_name']) &&
        typeof content.text === 'string' && typeof content.language === 'string' &&
        (content.response_format_name == null || typeof content.response_format_name === 'string');
    }
    if (content.content_type === 'execution_output') {
      return keysOnly(content, ['content_type', 'text']) && typeof content.text === 'string';
    }
    if (content.content_type === 'system_error') {
      return keysOnly(content, ['content_type', 'name', 'text']) &&
        (content.name == null || typeof content.name === 'string') && typeof content.text === 'string';
    }
    if (content.content_type === 'tether_browsing_display') {
      // This is a tool-rendering envelope, not a user message or image output.
      // Historical payload fields changed between strings, arrays and objects;
      // the exact content type and closed top-level key set identify it safely.
      return keysOnly(content, ['content_type', 'result', 'summary', 'assets', 'tether_id']);
    }
    if (content.content_type === 'thoughts') {
      return keysOnly(content, ['content_type', 'thoughts', 'source_analysis_msg_id']) &&
        (content.source_analysis_msg_id == null || typeof content.source_analysis_msg_id === 'string') &&
        Array.isArray(content.thoughts) && content.thoughts.every(thought => thought &&
          typeof thought === 'object' && !Array.isArray(thought) &&
          keysOnly(thought, ['summary', 'content', 'chunks', 'finished']) &&
          typeof thought.summary === 'string' && typeof thought.content === 'string' &&
          (!own(thought, 'finished') || typeof thought.finished === 'boolean') &&
          (!own(thought, 'chunks') || (Array.isArray(thought.chunks) && thought.chunks.every(chunk => typeof chunk === 'string'))));
    }
    return false;
  }

  function event(node) {
    const message = node.message;
    if (!message) {
      if (node.parent === null) return { kind: 'other' };
      fail('missing_message', 'An ancestor node lacks its message.');
    }
    const role = message.author && message.author.role;
    if (!['system', 'developer', 'user', 'assistant', 'tool'].includes(role)) {
      fail('unsupported_role', 'A message lacks a supported author role.');
    }
    if (role === 'system' || role === 'developer') return { kind: 'other' };
    const id = string(message.id);
    if (!id) fail('missing_message_id', 'A message lacks its stable identifier.');
    // Tool requests, errors and incomplete responses never finish a round.
    if (role !== 'user' && ((message.recipient && message.recipient !== 'all') ||
        (message.status && message.status !== 'finished_successfully'))) return { kind: 'other' };
    const content = message.content;
    if (role !== 'user' && nonImageContent(content)) return { kind: 'other' };
    if (!content || !['text', 'multimodal_text'].includes(content.content_type) || !Array.isArray(content.parts)) {
      fail('unsupported_content', 'Message content does not match the supported text/multimodal adapter.', {
        role, contentType: typeof content?.content_type === 'string' ? content.content_type : 'missing',
        contentKeys: content && typeof content === 'object' && !Array.isArray(content) ? Object.keys(content).slice(0, 20) : []
      });
    }
    const texts = [];
    const images = [];
    const nonImageAttachments = [];
    for (const part of content.parts) {
      if (typeof part === 'string') texts.push(part);
      else if (part && part.content_type === 'text' && typeof part.text === 'string') texts.push(part.text);
      else if (content.content_type === 'multimodal_text' && part && part.content_type === 'image_asset_pointer') images.push(asset(part));
      else fail('unsupported_part', 'A message contains an unsupported structured content part.');
    }
    // Separate textual parts retain their individual newlines and their ordering.
    const text = texts.join('\n');
    if (role === 'user') {
      // Known non-image files accompany the user's visible text instruction;
      // only image attachments must match explicit image parts to reset a task.
      // File contents are not fetched or silently inserted into prompt text.
      const metadata = message.metadata;
      if (metadata && typeof metadata === 'object') for (const key of ['attachments', 'image_attachments']) {
        if (!own(metadata, key) || metadata[key] == null) continue;
        const attachments = metadata[key];
        if (!Array.isArray(attachments)) fail('unsupported_attachment', 'User attachment metadata is not a supported array.');
        for (const attachment of attachments) {
          if (!attachment || typeof attachment !== 'object') fail('unsupported_attachment', 'User attachment metadata lacks a structured identity.');
          const mime = typeof attachment.mime_type === 'string' ? attachment.mime_type
            : typeof attachment.mimeType === 'string' ? attachment.mimeType : '';
          const mimeClass = /^[a-z]+\//i.test(mime) ? mime.split('/')[0].toLowerCase() : 'unknown';
          if (mimeClass !== 'image' && mimeClass !== 'unknown') {
            nonImageAttachments.push(mimeClass);
            continue;
          }
          const identities = ['id', 'file_id', 'fileId', 'asset_pointer'].filter(field => own(attachment, field))
            .map(field => ({ raw: string(attachment[field]), fileId: pointerId(attachment[field]) }));
          if (!identities.length || identities.some(identity => !identity.raw || !images.some(image =>
            identity.fileId && image.fileId === identity.fileId || image.assetPointer === identity.raw))) {
            fail('unsupported_attachment', 'User image attachment metadata is not accounted for by supported image parts.', {
              attachmentField: key, attachmentCount: attachments.length,
              attachmentKeys: Object.keys(attachment).filter(name => /^[a-z0-9_]{1,40}$/i.test(name)).slice(0, 20),
              partTypes: [...new Set(content.parts.map(partType))].slice(0, 12),
              imageParts: images.length, attachmentMimeClass: mimeClass
            });
          }
        }
      }
      return { kind: images.length ? 'image' : 'text', id, text, images, nonImageAttachments };
    }
    return images.length ? { kind: 'output', id, images } : { kind: 'other' };
  }

  function ancestry(mapping, target) {
    const seen = new Set();
    const path = [];
    let id = target;
    while (id !== null) {
      if (seen.has(id)) fail('ancestor_cycle', 'The target ancestry contains a cycle.');
      if (typeof id !== 'string' || !own(mapping, id)) fail('missing_parent', 'The target ancestry references a missing parent.');
      seen.add(id);
      const node = mapping[id];
      if (!node || typeof node !== 'object' || !own(node, 'parent')) fail('missing_parent', 'A target ancestor has no explicit parent relationship.');
      if (node.id != null && node.id !== id) fail('node_identity_mismatch', 'Mapping key and node identity disagree.');
      path.push(id);
      id = node.parent;
    }
    return path.reverse();
  }

  function snapshot(mapping, target, messageId) {
    const path = ancestry(mapping, target.nodeId);
    const snapshot = {};
    // Library message IDs may identify an input ancestor rather than output.
    // Treat only absent hints as stale; present unrelated nodes still conflict.
    if (messageId && !path.some(id => mapping[id].message && mapping[id].message.id === messageId)) {
      if (Object.values(mapping).some(node => node?.message?.id === messageId)) {
        fail('message_identity_conflict', 'The supplied message ID is outside the target output ancestry.');
      }
      snapshot.identityWarning = 'gallery_message_missing';
      snapshot.galleryMessageId = messageId;
    }
    // A confirmed new input image resets the task and makes older unsupported
    // content irrelevant, while topology remains fully checked by ancestry().
    let taskStart = 0;
    for (let index = path.length - 1; index >= 0; index--) {
      try {
        if (event(mapping[path[index]]).kind === 'image') { taskStart = index; break; }
      } catch (_) { /* Replay still rejects unsupported content after reset. */ }
    }
    let state = 'NO_TASK';
    let base = null;
    let root = null;
    let taskKind = null;
    let hasOutput = false;
    let references = [];
    let edits = [];
    let sources = [];
    let nonImageAttachmentCount = 0;
    let userTextMessages = 0, referenceInputs = 0, outputMessages = 0;
    for (const id of path.slice(taskStart)) {
      const current = event(mapping[id]);
      if (current.kind === 'image') {
        referenceInputs++;
        root = current.id;
        taskKind = 'reference-image';
        hasOutput = false;
        references = current.images;
        nonImageAttachmentCount = current.nonImageAttachments.length;
        base = current.text.trim() ? current.text : null;
        edits = [];
        sources = [current.id];
        state = base === null ? 'WAIT_BASE_TEXT' : 'WAIT_OUTPUT';
      } else if (current.kind === 'text' && current.text.trim()) {
        userTextMessages++;
        if (state === 'NO_TASK' || (taskKind === 'text-only' && state === 'WAIT_OUTPUT' && !hasOutput)) {
          root = current.id;
          taskKind = 'text-only';
          base = current.text;
          references = [];
          nonImageAttachmentCount = current.nonImageAttachments.length;
          edits = [];
          sources = [current.id];
          state = 'WAIT_OUTPUT';
        } else if (state === 'WAIT_BASE_TEXT') {
          base = current.text;
          nonImageAttachmentCount += current.nonImageAttachments.length;
          sources.push(current.id);
          state = 'WAIT_OUTPUT';
        } else if (state === 'OUTPUT_READY') {
          edits.push({ messageId: current.id, text: current.text });
          nonImageAttachmentCount += current.nonImageAttachments.length;
          sources.push(current.id);
          state = 'WAIT_OUTPUT';
        }
      } else if (current.kind === 'output') {
        outputMessages++;
        if (id === target.nodeId) {
          if (!root) fail('no_reference_task', 'No supported user image request exists on the target branch.', {
            mappingNodes: Object.keys(mapping).length, branchNodes: path.length,
            userTextMessages, referenceInputs, outputMessages
          });
          if (base === null) fail('missing_base', 'The image task has no initial user text.', {
            mappingNodes: Object.keys(mapping).length, branchNodes: path.length,
            userTextMessages, referenceInputs, outputMessages
          });
          return { ...snapshot, status: 'resolved', basePrompt: base,
            cumulativePrompt: normalize([base, ...edits.map(edit => edit.text)].join('\n\n')).trim(),
            taskKind, taskRootMessageId: root, referenceImages: references.map(image => image.identitySupported
              ? { assetPointer: image.assetPointer, fileId: image.fileId } : { unsupportedIdentity: true }),
            nonImageAttachmentCount, editSteps: edits.map(edit => ({ ...edit })),
            sourceMessageIds: [...sources], outputMessageId: current.id,
            outputAssetId: target.assetPointer, branchPath: [...path] };
        }
        if (root) { hasOutput = true; state = 'OUTPUT_READY'; }
      }
    }
    fail('target_replay_failed', 'Target output was not reached on its verified ancestry.');
  }

  function resolveConversation(conversation, entries) {
    const mapping = conversation && conversation.mapping;
    const validMapping = mapping && typeof mapping === 'object' && !Array.isArray(mapping);
    // Index only explicit image parts from actual output messages. Never inspect
    // prose URLs, metadata prompts, current_node or global timestamp ordering.
    const outputs = [];
    if (validMapping) for (const id of Object.keys(mapping)) {
      try {
        const current = event(mapping[id] || {});
        if (current.kind === 'output') for (const image of current.images) outputs.push({ nodeId: id, messageId: current.id, ...image });
      } catch (_) { /* Unsupported target data produces target_not_found below. */ }
    }
    return (Array.isArray(entries) ? entries : []).map(entry => {
      entry = entry || {};
      const fileId = string(entry.fileId) || string(entry.file_id);
      const associations = [entry, ...(Array.isArray(entry.sourceAssociations) ? entry.sourceAssociations : [])];
      const conversationIds = new Set();
      for (const source of associations) {
        if (!source || typeof source !== 'object') continue;
        for (const key of ['conversationId', 'conversation_id']) if (string(source[key])) conversationIds.add(source[key]);
      }
      const conversationId = conversationIds.size === 1 ? [...conversationIds][0] : null;
      const result = { fileId, conversationId, status: 'unresolved', cumulativePrompt: null, basePrompt: null,
        editSteps: [], taskRootMessageId: null, referenceImages: [], sourceMessageIds: [],
        outputMessageId: null, outputAssetId: null, branchPath: [], ruleVersion: RULE_VERSION, adapterVersion: ADAPTER_VERSION };
      try {
        if (!validMapping) fail('unsupported_conversation', 'Conversation has no supported mapping object.');
        for (const [camel, snake] of [['fileId', 'file_id'], ['conversationId', 'conversation_id'], ['messageId', 'message_id'], ['assetPointer', 'asset_pointer']]) {
          const identities = new Set();
          for (const association of associations) {
            if (!association || typeof association !== 'object') fail('source_identity_conflict', 'Invalid source association.');
            for (const key of [camel, snake]) {
              const value = string(association[key]);
              if (value) identities.add(camel === 'assetPointer' ? (pointerId(value) || value) : value);
            }
          }
          if (identities.size > 1) fail('source_identity_conflict', 'Source associations disagree about ' + camel + '.');
        }
        const sourceValue = (camel, snake) => associations.map(source => string(source[camel]) || string(source[snake])).find(Boolean) || null;
        const actualConversationId = string(conversation.conversation_id) || string(conversation.id);
        if (conversationId && actualConversationId && conversationId !== actualConversationId) {
          fail('conversation_identity_conflict', 'The response conversation identity disagrees with the image source.');
        }
        const pointer = sourceValue('assetPointer', 'asset_pointer');
        const pointerFileId = pointerId(pointer);
        if (!fileId && !pointerFileId) fail('missing_target_identity', 'The image lacks a supported resource identity.');
        if (pointer && !pointerFileId) fail('unsupported_target_identity', 'The target asset pointer has an unsupported shape.');
        if (fileId && pointerFileId && fileId !== pointerFileId) fail('target_identity_conflict', 'Target file ID and asset pointer disagree.');
        const messageId = sourceValue('messageId', 'message_id');
        const candidates = outputs.filter(output => output.fileId === (fileId || pointerFileId));
        if (!candidates.length) fail('target_not_found', 'No supported actual output matches the image resource.',
          targetEvidence(mapping, fileId || pointerFileId, messageId));
        let matches = candidates;
        if (messageId && candidates.length > 1) {
          const direct = candidates.filter(output => output.messageId === messageId);
          if (direct.length) matches = direct;
        }
        if (matches.length === 1) Object.assign(result, snapshot(mapping, matches[0], messageId));
        else {
          const attempts = matches.map(target => {
            try { return { target, value: snapshot(mapping, target, messageId) }; }
            catch (error) { return { target, error }; }
          });
          const resolved = attempts.filter(attempt => attempt.value);
          const prompts = new Set(resolved.map(attempt => attempt.value.cumulativePrompt));
          if (resolved.length === attempts.length && prompts.size === 1) {
            Object.assign(result, resolved[0].value, { identityWarning: 'duplicate_output_same_prompt',
              duplicateOutputCount: matches.length });
          } else fail('ambiguous_target', 'The image resource matches outputs with non-equivalent prompt ancestry.', {
            candidateCount: attempts.length, resolvedCandidates: resolved.length,
            distinctPromptCount: prompts.size,
            candidateErrorCodes: [...new Set(attempts.filter(attempt => attempt.error)
              .map(attempt => attempt.error.code || 'invalid_conversation'))]
          });
        }
      } catch (error) {
        result.error = { code: error.code || 'invalid_conversation', message: error.message || 'Unsupported conversation data.',
          ...(error.diagnostic ? { diagnostic: error.diagnostic } : {}) };
      }
      return result;
    });
  }
  return { RULE_VERSION, ADAPTER_VERSION, resolveConversation };
});
