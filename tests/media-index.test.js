const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const index = require('../media-index.js');

const fixture = () => ({ provider: 'chatgpt', scope: 'generated-images', folder: 'sample-export', savePrompts: true,
  records: [{ fileId: 'file_before', relativePath: 'sample-export/0001/image.png', status: 'complete',
    bytes: 1234, mimeType: 'image/png', sha256: 'a'.repeat(64), createdAt: '1767225600.123456789',
    promptSource: { conversationId: 'conversation-1', branchPath: ['root', 'input', 'output'],
      accessToken: 'must-not-export', ignoredConversation: 'must-not-export' } }],
  entries: [{ fileId: 'file_before', prompt: { conversationId: 'conversation-1', status: 'resolved',
    taskRootMessageId: 'input', outputNodeId: 'output', outputMessageId: 'output-message',
    parentOutputNodeId: 'prior-output', inputCreatedAt: '1767225599.123456789',
    basePrompt: 'A blue mountain', cumulativePrompt: 'A blue mountain\n\nAdd snow',
    sourceMessageIds: ['input', 'edit'], branchPath: ['root', 'input', 'prior-output', 'edit', 'output'],
    editSteps: [{ messageId: 'edit', text: 'Add snow', createdAt: '1767225599.123456789' }] } }] });

test('portable index stores generation and actual user message time with exact nanoseconds', () => {
  const document = index.build(fixture());
  assert.equal(document.media[0].createdAtNs, '1767225600123456789');
  assert.equal(document.media[0].inputAtNs, '1767225599123456789');
  assert.equal(document.media[0].relativePath, '0001/image.png');
  assert.equal(document.media[0].promptSnapshotId, 'conversation-1:output');
  assert.equal(document.snapshots[0].parentSnapshotId, 'conversation-1:prior-output');
  assert.equal(document.snapshots[0].editSteps[0].createdAtNs, '1767225599123456789');
  assert.equal(JSON.stringify(document).includes('must-not-export'), false);
});

test('original sequence and finite seed evidence are retained without deriving absent values', () => {
  const input = fixture();
  Object.assign(input.records[0], { sequence: 17, seed: 0 });
  const numeric = index.build(input);
  assert.equal(numeric.media[0].sequence, 17);
  assert.equal(numeric.media[0].seed, 0);
  input.records[0].seed = 'seed-abcdef';
  assert.equal(index.build(input).media[0].seed, 'seed-abcdef');
  Object.assign(input.records[0], { sequence: -1, seed: Number.POSITIVE_INFINITY });
  const unknown = index.build(input);
  assert.equal(unknown.media[0].sequence, undefined);
  assert.equal(unknown.media[0].seed, undefined);
});

test('ambiguous equivalent outputs retain their identity warning without claiming a selected branch was verified', () => {
  const input = fixture();
  const warning = { identityWarning: 'duplicate_output_same_prompt', duplicateOutputCount: 2 };
  Object.assign(input.records[0].promptSource, warning, { outputMessageId: 'output-message', outputNodeId: 'output' });
  Object.assign(input.entries[0].prompt, warning);
  const document = index.sanitize(index.build(input));
  const source = document.media[0].promptSource;
  assert.equal(source.identityWarning, warning.identityWarning);
  assert.equal(source.duplicateOutputCount, 2);
  assert.equal(source.outputMessageId, 'output-message');
  assert.equal(source.outputNodeId, 'output');
  assert.equal(document.media[0].inputAtNs, undefined);
  assert.equal(document.media[0].createdAtNs, '1767225600123456789');
  assert.equal(document.snapshots[0].identityWarning, warning.identityWarning);
  assert.equal(document.snapshots[0].duplicateOutputCount, 2);
  assert.equal(document.snapshots[0].parentSnapshotId, undefined);
  assert.equal(document.snapshots[0].branchPath, undefined);
  assert.equal(document.snapshots[0].sourceMessageIds, undefined);
  assert.equal(document.snapshots[0].editSteps[0].createdAtNs, undefined);
  assert.equal(document.snapshots[0].text, 'A blue mountain\n\nAdd snow');
  const merged = index.merge(index.build(fixture()), document);
  assert.equal(merged.media[0].inputAtNs, undefined);
  assert.equal(merged.snapshots[0].parentSnapshotId, undefined);
  assert.equal(merged.snapshots[0].branchPath, undefined);
  const stale = index.provenance({ identityWarning: 'gallery_message_missing', duplicateOutputCount: -1 });
  assert.equal(stale.identityWarning, 'gallery_message_missing');
  assert.equal(stale.duplicateOutputCount, undefined);
});

test('metadata-only export contains no previously authorized prompt body or edit text', () => {
  const older = index.build(fixture());
  const newer = index.build({ ...fixture(), savePrompts: false });
  const merged = index.merge(older, newer, false);
  const serialized = JSON.stringify(merged);
  assert.equal(serialized.includes('A blue mountain'), false);
  assert.equal(serialized.includes('Add snow'), false);
  assert.equal(serialized.includes('editSteps'), false);
  assert.equal(merged.media[0].createdAtNs, older.media[0].createdAtNs);
});

test('Gemini does not substitute export/report times for unavailable generation time', () => {
  const document = index.build({ provider: 'gemini', scope: 'library', folder: 'gemini-export', savePrompts: true,
    records: [{ mediaId: 'rc_abcdef1234567890', relativePath: 'gemini-export/p-1/image.png', status: 'queued' }],
    entries: [{ id: 'rc_abcdef1234567890', chatId: 'chat-1', responseId: 'response-1', prompt: 'Blue mountain' }] });
  assert.equal(document.media[0].createdAtNs, undefined);
  assert.equal(document.media[0].inputAtNs, undefined);
  assert.equal(document.snapshots[0].conversationId, 'chat-1');
  assert.equal(document.snapshots[0].text, 'Blue mountain');
  assert.equal(index.timeNs('not-a-time'), undefined);
  assert.equal(index.timeNs(null), undefined);
  assert.equal(index.timeNs('2026-09-01T00:00:00.123456789Z'), '1788220800123456789');
  assert.equal(index.timeNs('2026-09-01T00:00:00'), undefined);
});

test('Grok retains verified model, dimensions and ISO generation timestamp', () => {
  const document = index.build({ provider: 'grok', scope: 'owned', folder: 'grok-export',
    records: [{ mediaId: 'asset_001', relativePath: 'grok-export/000001.png', status: 'complete',
      createdAt: '2026-09-01T00:00:00.123Z', modelName: 'grok-image', reportedWidth: 1024, reportedHeight: 1536 }] });
  assert.equal(document.media[0].createdAtNs, '1788220800123000000');
  assert.equal(document.media[0].modelName, 'grok-image');
  assert.equal(document.media[0].width, 1024);
  const milliseconds = index.build({ provider: 'grok', scope: 'owned', folder: 'grok-export',
    records: [{ mediaId: 'asset_002', relativePath: 'grok-export/000002.png', status: 'complete' }],
    entries: [{ id: 'asset_002', generationTimeSource: '1788220800123.456789' }] });
  assert.equal(milliseconds.media[0].createdAtNs, '1788220800123456789');
});

test('incremental retries preserve earlier known facts and merge distinct provider/scope identities', () => {
  const first = index.build(fixture());
  const retried = index.build({ ...fixture(), entries: [], records: [{ fileId: 'file_before',
    relativePath: 'sample-export/0001/image.png', status: 'failed' }] });
  const merged = index.merge(first, retried);
  assert.equal(merged.media.length, 1);
  assert.equal(merged.media[0].createdAtNs, first.media[0].createdAtNs);
  assert.equal(merged.media[0].sha256, 'a'.repeat(64));
  assert.equal(merged.media[0].status, 'complete');
  assert.equal(merged.snapshots[0].text, first.snapshots[0].text);
  const another = index.build({ provider: 'grok', scope: 'owned', folder: 'sample-export',
    records: [{ mediaId: 'file_before', relativePath: 'sample-export/grok.png', status: 'queued' }] });
  const mixed = index.merge(merged, another);
  assert.equal(mixed.media.length, 2);
  assert.equal(mixed.media[0].provider, 'chatgpt');
  assert.equal(mixed.media[1].provider, 'grok');
});

test('unsafe paths, index files, malformed records and traversal are rejected', () => {
  for (const path of ['../image.png', '/image.png', 'part/../image.png', 'part\\image.png',
    '.glry/owner.json', 'x//image.png', 'x\0/image.png', 'C:/image.png']) {
    assert.throws(() => index.sanitize({ kind: 'grid-media-index', schemaVersion: 1, provider: 'chatgpt',
      scope: 'generated-images', media: [{ id: 'file_image', relativePath: path, status: 'queued' }] }));
  }
  assert.equal(index.relativePath('/Users/person/sample-export/image.png', 'sample-export'), undefined);
  assert.equal(index.relativePath('different-root/image.png', 'sample-export'), undefined);
  assert.throws(() => index.sanitize({ ...index.build(fixture()), media: [{ id: 'file_image', status: 'queued' }] }));
});

test('extension cache is bounded across roots and cannot use prototype keys', () => {
  const document = index.build(fixture());
  let cache = {};
  for (let count = 0; count < 20; count++) cache = index.boundedCache(cache, `export-${count}`, document).cache;
  assert.ok(Object.keys(cache).length <= 8);
  assert.ok(Buffer.byteLength(JSON.stringify(cache)) <= index.CACHE_BYTES);
  const reserved = index.boundedCache(cache, '__proto__', document);
  assert.equal(reserved.currentRetained, true);
  assert.equal(Object.getPrototypeOf(reserved.cache), null);
});

test('shared synthetic JSON protocol fixture remains importable without private data', () => {
  const document = JSON.parse(fs.readFileSync('tests/fixtures/grid-media-index.json', 'utf8'));
  const sanitized = index.sanitize(document);
  assert.equal(sanitized.media.length, 2);
  assert.equal(sanitized.snapshots[1].parentSnapshotId, sanitized.snapshots[0].id);
});
