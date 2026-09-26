// Synthetic adapter/regression definitions only; no verified live fixture.
// Do not execute as part of this implementation task.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const resolver = require('../prompt-resolver.js');
const image = id => ({ content_type: 'image_asset_pointer', asset_pointer: `sediment://${id}` });
const node = (id, parent, role, parts) => ({ id, parent, message: { id, author: { role },
  content: { content_type: 'multimodal_text', parts } } });
const conversation = (...nodes) => ({ mapping: Object.fromEntries(nodes.map(n => [n.id, n])) });
const resolve = (c, ...ids) => resolver.resolveConversation(c, ids.map(fileId => ({ fileId })));
const base = () => node('u', null, 'user', [image('file_ref'), 'P']);
const output = (id, parent, fileId) => node(id, parent, 'assistant', [image(fileId)]);

test('immutable output snapshots append edits and discard all waiting text', () => {
  const c = conversation(base(), node('ignored', 'u', 'user', ['do anything']),
    output('a', 'ignored', 'file_a'), node('edit', 'a', 'user', ['E']),
    node('ignored2', 'edit', 'user', ['never retain me']), output('b', 'ignored2', 'file_b'));
  const [a, b] = resolve(c, 'file_a', 'file_b');
  assert.equal(a.cumulativePrompt, 'P');
  assert.equal(b.cumulativePrompt, 'P\n\nE');
  assert.deepEqual(b.sourceMessageIds, ['u', 'edit']);
  assert.deepEqual(b.editSteps, [{ messageId: 'edit', text: 'E' }]);
  assert.equal(JSON.stringify([a, b]).includes('never retain me'), false);
});

test('new references reset even while waiting; image-only waits for first text', () => {
  const c = conversation(base(), node('reset', 'u', 'user', [image('file_other')]),
    node('system', 'reset', 'assistant', ['acknowledged']), node('text', 'system', 'user', ['Q']),
    output('a', 'text', 'file_a'));
  const [a] = resolve(c, 'file_a');
  assert.equal(a.cumulativePrompt, 'Q');
  assert.equal(a.taskRootMessageId, 'reset');
  assert.deepEqual(a.sourceMessageIds, ['reset', 'text']);
});

test('opaque historical image pointers affect rounds without becoming target identities', () => {
  const oldImage = { content_type: 'image_asset_pointer', asset_pointer: 'legacy://opaque-reference' };
  const c = conversation(node('u', null, 'user', [oldImage, 'P']), output('a', 'u', 'file_a'));
  const result = resolve(c, 'file_a')[0];
  assert.equal(result.status, 'resolved');
  assert.equal(result.cumulativePrompt, 'P');
  assert.deepEqual(result.referenceImages, [{ unsupportedIdentity: true }]);
  assert.equal(resolve(c, 'legacy://opaque-reference')[0].error.code, 'target_not_found');
});

test('sibling branches do not inherit edits and current_node has no influence', () => {
  const c = conversation(base(), output('a', 'u', 'file_a'), node('edit', 'a', 'user', ['E']),
    output('b', 'edit', 'file_b'), output('sibling', 'u', 'file_c'));
  c.current_node = 'b';
  assert.deepEqual(resolve(c, 'file_b', 'file_c').map(r => r.cumulativePrompt), ['P\n\nE', 'P']);
});

test('same-response outputs share snapshots and user reuploads reset', () => {
  const c = conversation(base(), node('a', 'u', 'tool', [image('file_a'), image('file_b')]),
    node('reset', 'a', 'user', [image('file_a'), 'Q']), output('c', 'reset', 'file_c'));
  assert.deepEqual(resolve(c, 'file_a', 'file_b', 'file_c').map(r => r.cumulativePrompt), ['P', 'P', 'Q']);
});

test('no reference or no initial text stays explicitly unresolved', () => {
  const noInput = resolve(conversation(output('a', null, 'file_a')), 'file_a')[0];
  assert.equal(noInput.error.code, 'no_reference_task');
  assert.deepEqual(noInput.error.diagnostic, { mappingNodes: 1, branchNodes: 1,
    userTextMessages: 0, referenceInputs: 0, outputMessages: 1 });
  const c = conversation(node('u', null, 'user', [image('file_ref')]), output('a', 'u', 'file_a'));
  assert.equal(resolve(c, 'file_a')[0].error.code, 'missing_base');
});

test('pure text image request resolves from the last user text before first output', () => {
  const c = conversation(node('old', null, 'user', ['unrelated question']),
    node('request', 'old', 'user', ['Draw a red kite']), output('a', 'request', 'file_a'),
    node('edit', 'a', 'user', ['Make it blue']), output('b', 'edit', 'file_b'));
  const [a, b] = resolve(c, 'file_a', 'file_b');
  assert.equal(a.cumulativePrompt, 'Draw a red kite');
  assert.equal(b.cumulativePrompt, 'Draw a red kite\n\nMake it blue');
  assert.equal(a.taskKind, 'text-only');
  assert.equal(a.taskRootMessageId, 'request');
  assert.deepEqual(a.referenceImages, []);
  assert.deepEqual(b.sourceMessageIds, ['request', 'edit']);
});

test('broken and cyclic parent chains are rejected', () => {
  assert.equal(resolve(conversation(output('a', 'missing', 'file_a')), 'file_a')[0].error.code, 'missing_parent');
  const c = conversation(node('u', 'a', 'user', [image('file_ref'), 'P']), output('a', 'u', 'file_a'));
  assert.equal(resolve(c, 'file_a')[0].error.code, 'ancestor_cycle');
});

test('duplicate resource outputs require disambiguation and message IDs are crosschecked', () => {
  const c = conversation(base(), output('a', 'u', 'file_a'), output('b', 'u', 'file_a'));
  const duplicate = resolve(c, 'file_a')[0];
  assert.equal(duplicate.status, 'resolved');
  assert.equal(duplicate.identityWarning, 'duplicate_output_same_prompt');
  assert.equal(duplicate.duplicateOutputCount, 2);
  assert.equal(resolver.resolveConversation(c, [{ fileId: 'file_a', messageId: 'b' }])[0].outputMessageId, 'b');
  const single = conversation(base(), output('a', 'u', 'file_a'));
  assert.equal(resolver.resolveConversation(single, [{ fileId: 'file_a', messageId: 'u' }])[0].status, 'resolved');
  const stale = resolver.resolveConversation(single, [{ fileId: 'file_a', messageId: 'absent' }])[0];
  assert.equal(stale.status, 'resolved');
  assert.equal(stale.identityWarning, 'gallery_message_missing');
  assert.equal(stale.galleryMessageId, 'absent');
  const sibling = conversation(base(), output('a', 'u', 'file_a'), output('b', 'u', 'file_b'));
  assert.equal(resolver.resolveConversation(sibling, [{ fileId: 'file_a', messageId: 'b' }])[0].error.code, 'message_identity_conflict');
  assert.equal(resolver.resolveConversation(c, [{ fileId: 'file_a', messageId: 'absent' }])[0].status, 'resolved');
  assert.equal(resolver.resolveConversation(single, [{ fileId: 'file_a', assetPointer: 'sediment://file_b' }])[0].error.code, 'target_identity_conflict');
});

test('duplicate outputs remain ambiguous when their prompt ancestry differs', () => {
  const c = conversation(base(), output('a', 'u', 'file_a'),
    node('edit', 'a', 'user', ['E']), output('b', 'edit', 'file_a'));
  const result = resolve(c, 'file_a')[0];
  assert.equal(result.error.code, 'ambiguous_target');
  assert.deepEqual(result.error.diagnostic, { candidateCount: 2, resolvedCandidates: 2,
    distinctPromptCount: 2, candidateErrorCodes: [] });
});

test('prose URLs, placeholders, tool requests and error responses are not output', () => {
  for (const kind of ['prose', 'pending', 'request', 'error']) {
    const a = output('a', 'u', 'file_a');
    if (kind === 'prose') a.message.content.parts = ['https://example.test/file_a.png'];
    if (kind === 'pending') a.message.status = 'in_progress';
    if (kind === 'error') a.message.status = 'finished_error';
    if (kind === 'request') a.message.recipient = 'image_gen';
    assert.equal(resolve(conversation(base(), a), 'file_a')[0].error.code, 'target_not_found');
  }
});

test('missing target diagnostics distinguish absent resource from unsupported output shape', () => {
  const c = conversation(base(), output('a', 'u', 'file_other'));
  const absent = resolver.resolveConversation(c, [{ fileId: 'file_missing', messageId: 'a' }])[0];
  assert.equal(absent.error.code, 'target_not_found');
  assert.deepEqual(absent.error.diagnostic, { mappingNodes: 2, exactPointerParts: 0,
    exactPointerInOutputRole: 0, galleryMessagePresent: true });
  const pending = output('pending', 'u', 'file_target');
  pending.message.status = 'in_progress';
  const unsupported = resolve(conversation(base(), pending), 'file_target')[0];
  assert.equal(unsupported.error.code, 'target_not_found');
  assert.equal(unsupported.error.diagnostic.exactPointerInOutputRole, 1);
});

test('unsupported ancestry is not silently skipped', () => {
  const u = base();
  u.message.content.parts.push({ content_type: 'unknown_attachment' });
  assert.equal(resolve(conversation(u, output('a', 'u', 'file_a')), 'file_a')[0].error.code, 'unsupported_part');
  assert.equal(resolve({ messages: [] }, 'file_a')[0].error.code, 'unsupported_conversation');
});

test('conflicting source associations fail closed and consistent snake case is accepted', () => {
  const c = conversation(base(), output('a', 'u', 'file_a'));
  const entry = { fileId: 'file_a', messageId: 'a', sourceAssociations: [{ messageId: 'u' }] };
  assert.equal(resolver.resolveConversation(c, [entry])[0].error.code, 'source_identity_conflict');
  assert.equal(resolver.resolveConversation(c, [{ file_id: 'file_a', asset_pointer: 'sediment://file_a', message_id: 'u' }])[0].status, 'resolved');
});

test('normalization changes line endings and final outer whitespace only', () => {
  const u = node('u', null, 'user', [image('file_ref'), '  P\r\n\r\n  body  ']);
  const c = conversation(u, output('a', 'u', 'file_a'), node('e', 'a', 'user', ['E\rnext  ']), output('b', 'e', 'file_b'));
  const [a, b] = resolve(c, 'file_a', 'file_b');
  assert.equal(a.basePrompt, '  P\r\n\r\n  body  ');
  assert.equal(b.cumulativePrompt, 'P\n\n  body  \n\nE\nnext');
  assert.equal(b.ruleVersion, resolver.RULE_VERSION);
  assert.equal(b.adapterVersion, resolver.ADAPTER_VERSION);
});

test('explicit non-image assistant/tool schemas do not finish a waiting round', () => {
  const contents = [
    { content_type: 'thoughts', thoughts: [{ summary: 'hidden summary', content: 'hidden body', chunks: [] }], source_analysis_msg_id: null },
    { content_type: 'thoughts', thoughts: [{ summary: 'hidden summary', content: 'hidden body', chunks: [], finished: true }], source_analysis_msg_id: 'analysis' },
    { content_type: 'reasoning_recap', content: 'hidden recap' },
    { content_type: 'code', language: 'python', text: 'hidden code', response_format_name: null },
    { content_type: 'execution_output', text: 'hidden execution' }
    ,{ content_type: 'system_error', name: 'tool_error', text: 'hidden error' }
    ,{ content_type: 'tether_browsing_display', result: 'hidden result', summary: 'hidden summary', assets: [], tether_id: 't' }
    ,{ content_type: 'tether_browsing_display', result: { hidden: true }, summary: ['hidden'], assets: { legacy: true }, tether_id: 7 }
  ];
  for (const role of ['assistant', 'tool']) for (const content of contents) {
    const other = node('other', 'u', role, []);
    other.message.content = content;
    const c = conversation(base(), other, node('ignore', 'other', 'user', ['ignored input']), output('a', 'ignore', 'file_a'));
    const [result] = resolve(c, 'file_a');
    assert.equal(result.cumulativePrompt, 'P');
    assert.equal(JSON.stringify(result).includes('hidden'), false);
    assert.deepEqual(result.sourceMessageIds, ['u']);
  }
});

test('unknown or resource-bearing non-image schemas fail closed', () => {
  const contents = [
    { content_type: 'thoughts', thoughts: [{ summary: 's', content: 'c', chunks: [], finished: image('file_hidden') }] },
    { content_type: 'unknown_image_result', asset_pointer: 'sediment://file_hidden' },
    { content_type: 'reasoning_recap', content: 'recap', image: image('file_hidden') },
    { content_type: 'execution_output', text: 'result', parts: [image('file_hidden')] },
    { content_type: 'thoughts', thoughts: [{ summary: 's', content: 'c', chunks: [image('file_hidden')] }] }
  ];
  for (const content of contents) {
    const other = node('other', 'u', 'assistant', []);
    other.message.content = content;
    assert.equal(resolve(conversation(base(), other, output('a', 'other', 'file_a')), 'file_a')[0].error.code, 'unsupported_content');
  }
  const user = base();
  user.message.content = { content_type: 'execution_output', text: 'P' };
  assert.equal(resolve(conversation(user, output('a', 'u', 'file_a')), 'file_a')[0].error.code, 'unsupported_content');
});

test('future non-image assistant and tool display envelopes are ignored', () => {
  for (const role of ['assistant', 'tool']) {
    const other = node('other', 'u', role, []);
    other.message.content = { content_type: 'future_display_envelope', payload: { arbitrary: ['safe', 1] } };
    const result = resolve(conversation(base(), other, output('a', 'other', 'file_a')), 'file_a')[0];
    assert.equal(result.status, 'resolved');
    assert.equal(result.cumulativePrompt, 'P');
  }
  const resource = node('resource', 'u', 'tool', []);
  resource.message.content = { content_type: 'future_display_envelope', payload: image('file_hidden') };
  assert.equal(resolve(conversation(base(), resource, output('a', 'resource', 'file_a')), 'file_a')[0].error.code,
    'unsupported_content');
});

test('an output without base cannot acquire a valid base from a subsequent edit', () => {
  const c = conversation(node('u', null, 'user', [image('file_ref')]), output('a', 'u', 'file_a'),
    node('edit', 'a', 'user', ['E']), output('b', 'edit', 'file_b'));
  assert.deepEqual(resolve(c, 'file_a', 'file_b').map(result => result.error.code), ['missing_base', 'missing_base']);
});

test('conversation provenance survives successful and failed resolution', () => {
  const entry = { fileId: 'file_a', sourceAssociations: [{ conversation_id: 'conversation-1' }] };
  const c = conversation(base(), output('a', 'u', 'file_a'));
  assert.equal(resolver.resolveConversation(c, [entry])[0].conversationId, 'conversation-1');
  assert.equal(resolver.resolveConversation({}, [entry])[0].conversationId, 'conversation-1');
  entry.conversationId = 'conflicting-conversation';
  const [result] = resolver.resolveConversation(c, [entry]);
  assert.equal(result.conversationId, null);
  assert.equal(result.error.code, 'source_identity_conflict');
});

test('metadata-only attachments cannot silently inherit an earlier reference task', () => {
  for (const field of ['attachments', 'image_attachments']) {
    const upload = node('upload', 'u', 'user', ['new prompt']);
    upload.message.metadata = { [field]: [{ id: 'file_new', mimeType: 'image/png' }] };
    const c = conversation(base(), upload, output('a', 'upload', 'file_a'));
    assert.equal(resolve(c, 'file_a')[0].error.code, 'unsupported_attachment');
  }
  const u = base();
  u.message.metadata = { attachments: [{ id: 'file_ref', mimeType: 'image/png' }] };
  assert.equal(resolve(conversation(u, output('a', 'u', 'file_a')), 'file_a')[0].status, 'resolved');
  u.message.metadata.attachments.push({ id: 'file_unaccounted' });
  const unsupported = resolve(conversation(u, output('a', 'u', 'file_a')), 'file_a')[0];
  assert.equal(unsupported.error.code, 'unsupported_attachment');
  assert.deepEqual(unsupported.error.diagnostic, { attachmentField: 'attachments', attachmentCount: 2,
    attachmentKeys: ['id'], partTypes: ['image_asset_pointer', 'text'], imageParts: 1,
    attachmentMimeClass: 'unknown' });
});

test('a non-image attachment uses the visible text prompt without becoming a reference image', () => {
  const u = node('u', null, 'user', ['Use the attached text']);
  u.message.metadata = { attachments: [{ id: 'file_notes', mime_type: 'text/plain' }] };
  const result = resolve(conversation(u, output('a', 'u', 'file_a')), 'file_a')[0];
  assert.equal(result.status, 'resolved');
  assert.equal(result.cumulativePrompt, 'Use the attached text');
  assert.equal(result.taskKind, 'text-only');
  assert.deepEqual(result.referenceImages, []);
  assert.equal(result.nonImageAttachmentCount, 1);
  const imageTask = base();
  imageTask.message.metadata = { attachments: [
    { id: 'file_ref', mime_type: 'image/png' }, { id: 'file_notes', mime_type: 'application/pdf' }
  ] };
  const mixed = resolve(conversation(imageTask, output('b', 'u', 'file_b')), 'file_b')[0];
  assert.equal(mixed.status, 'resolved');
  assert.equal(mixed.taskKind, 'reference-image');
  assert.equal(mixed.nonImageAttachmentCount, 1);
  const empty = node('empty', null, 'user', []);
  empty.message.metadata = { attachments: [{ id: 'file_notes', mime_type: 'text/plain' }] };
  assert.equal(resolve(conversation(empty, output('c', 'empty', 'file_c')), 'file_c')[0].error.code, 'no_reference_task');
});

test('confirmed reference reset isolates old unsupported content but not broken topology', () => {
  const old = node('old', null, 'assistant', []);
  old.message.content = { content_type: 'old_unknown_format' };
  const u = base();
  u.parent = 'old';
  const c = conversation(old, u, output('a', 'u', 'file_a'));
  assert.equal(resolve(c, 'file_a')[0].cumulativePrompt, 'P');
  old.parent = 'missing';
  assert.equal(resolve(c, 'file_a')[0].error.code, 'missing_parent');
});

test('line endings normalize after joining segments, including boundary bare CR', () => {
  const u = node('u', null, 'user', [image('file_ref'), 'P\r']);
  const c = conversation(u, output('a', 'u', 'file_a'), node('e', 'a', 'user', ['E']), output('b', 'e', 'file_b'));
  assert.equal(resolve(c, 'file_b')[0].cumulativePrompt, 'P\n\nE');
});
