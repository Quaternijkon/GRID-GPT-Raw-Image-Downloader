const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto').webcrypto;

// Synthetic mapping contracts only; these fixtures do not establish live API compatibility.
const fixtureFileId = index => index === 0 ? 'file_abc123' : `file_img${index}`;
function conversationFixture(records, conversationId, unresolved = []) {
  const mapping = { root: { id: 'root', parent: null, message: null } };
  let previous = 'root';
  records.forEach((record, index) => {
    if (record.conversationId !== conversationId) return;
    const input = `input-${index}`, output = `output-${index}`;
    mapping[input] = { id: input, parent: previous, message: { id: input, author: { role: 'user' },
      content: { content_type: 'multimodal_text', parts: [
        { content_type: 'image_asset_pointer', asset_pointer: `sediment://file_reference${index}` }, record.prompt
      ] } } };
    mapping[output] = { id: output, parent: input, message: { id: output, author: { role: 'assistant' },
      status: 'finished_successfully', content: { content_type: 'multimodal_text', parts: unresolved.includes(index)
        ? ['Output unavailable'] : [{ content_type: 'image_asset_pointer', asset_pointer: `sediment://${fixtureFileId(index)}` }] } } };
    previous = output;
  });
  return { conversation_id: conversationId, mapping };
}

async function runFlow({ failImage = false, noOriginal = false, changePageDuringMetadata = false, gallerySize = 0, failGalleryPage = false, emptyDom = false, unavailableGallery = false, afterSequence = 0, concurrency = 6,
  savePrompts = false, promptRecords = null, unresolvedPrompts = [], failPrompt = false, changePageDuringPrompts = false,
  metadataRequiresAuth = false, conversationStatus = 200, sessionAvailable = true } = {}) {
  let listener;
  const downloads = [];
  const galleryRequests = [];
  const conversationRequests = [];
  const conversationReads = [], sessionRequests = [];
  let conversationRateLimits = 0;
  const panelUpdates = [];
  const chrome = {
    runtime: {
      onMessage: { addListener(fn) { listener = fn; } },
      onInstalled: { addListener() {} },
      sendMessage(message, callback) {
        listener(message, { url: 'https://chatgpt.com/images/' }, callback || (() => {}));
      }
    },
    downloads: {
      download(options, callback) {
        if ((failImage && options.url.startsWith('data:image/')) || (failPrompt && options.url.startsWith('data:text/plain'))) {
          chrome.runtime.lastError = { message: 'Download rejected by browser' };
          callback();
          delete chrome.runtime.lastError;
        } else {
          downloads.push(options);
          callback(downloads.length);
        }
      }
    }
  };
  const worker = vm.createContext({ chrome, console, setTimeout });
  worker.importScripts = file => vm.runInContext(fs.readFileSync(file, 'utf8'), worker);
  vm.runInContext(fs.readFileSync('background.js', 'utf8'), worker);
  const elements = new Map();
  const thumbnail = 'https://chatgpt.com/backend-api/estuary/content?id=file_abc123%23thumbnail&sig=preview';
  const original = 'https://files.oaiusercontent.com/file_abc123.png?sig=original';
  const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAaX2RUAAAAAASUVORK5CYII=', 'base64');
  const img = { src: thumbnail, naturalWidth: 512, naturalHeight: 512, alt: 'sample.png', closest() { return null; } };
  const main = { scrollHeight: 1000, querySelectorAll() { return emptyDom ? [] : [img]; } };
  const document = {
    title: 'Test gallery',
    body: { appendChild(el) { elements.set(el.id, el); } },
    getElementById(id) { return elements.get(id); },
    querySelector() { return main; },
    querySelectorAll() { return []; },
    createElement() { return { style: {}, remove() {} }; }
  };
  const context = vm.createContext({
    chrome, document, console, URL, Blob, Response, AbortController, crypto,
    getComputedStyle: () => ({ overflowY: 'auto' }),
    location: { pathname: '/images/', href: 'https://chatgpt.com/images/' },
    localStorage: { getItem() { return null; } },
    MutationObserver: class { observe() {} },
    window: { addEventListener() {} }, setInterval: () => 0, clearInterval,
    // Advance scroll waits; retain real abort timers for requests.
    setTimeout(fn, ms) { return setTimeout(fn, [200, 500, 750, 1500, 3000].includes(ms) ? 0 : ms); }, clearTimeout,
    createImageBitmap: async () => ({ width: 1536, height: 1024, close() {} }),
    FileReader: class {
      async readAsDataURL(blob) {
        this.result = `data:${blob.type};base64,${Buffer.from(await blob.arrayBuffer()).toString('base64')}`;
        this.onload();
      }
    },
    fetch: async (url, options = {}) => {
      const parsed = new URL(url);
      if (parsed.pathname === '/api/auth/session') {
        sessionRequests.push(parsed.pathname);
        return Response.json(sessionAvailable ? { accessToken: 'fixture-only-token' } : {});
      }
      if (parsed.pathname.startsWith('/backend-api/conversation/')) {
        const id = decodeURIComponent(parsed.pathname.slice('/backend-api/conversation/'.length));
        conversationRequests.push(id);
        const full = parsed.searchParams.get('include_full_conversation') === 'true';
        const bearerSent = options.headers?.Authorization === 'Bearer fixture-only-token';
        conversationReads.push({ id, full, bearerSent });
        // Observed native behavior: ordinary authenticated reads succeed; the
        // optional include_full_conversation flag returns 403 for this account.
        if (!bearerSent) return Response.json({ detail: 'Missing authentication' }, { status: 404 });
        if (full) return Response.json({ detail: 'Forbidden' }, { status: 403 });
        if (changePageDuringPrompts) {
          context.location.href = 'https://chatgpt.com/library/d/other';
          context.location.pathname = '/library/d/other';
        }
        if (conversationStatus === 429 && conversationRateLimits++ < 2) return Response.json({ detail: 'Rate limited' }, { status: 429 });
        if (conversationStatus !== 200 && conversationStatus !== 429) return Response.json({ detail: 'private-server-error-fixture' }, { status: conversationStatus });
        return Response.json(conversationFixture(promptRecords || [], id, unresolvedPrompts));
      }
      if (metadataRequiresAuth && parsed.pathname === '/backend-api/my/recent/image_gen' &&
          options.headers?.Authorization !== 'Bearer fixture-only-token') return new Response('', { status: 401 });
      if (unavailableGallery && parsed.pathname === '/backend-api/my/recent/image_gen') return new Response('', { status: 422 });
      if (gallerySize && parsed.pathname === '/backend-api/my/recent/image_gen') {
        const cursor = parsed.searchParams.get('after');
        const offset = cursor ? Number(cursor.match(/^page:(\d+)\+\/=opaque$/)?.[1]) : 0;
        assert.ok(Number.isFinite(offset), 'opaque cursor must survive URL encoding');
        galleryRequests.push(offset);
        if (failGalleryPage && offset > 0) return new Response('', { status: 503 });
        const end = Math.min(offset + 100, gallerySize);
        return Response.json({
          items: Array.from({ length: end - offset }, (_, i) => ({
            id: offset + i === 0 ? 'file_abc123' : `file_img${offset + i}`,
            title: `Original ${offset + i}`, created_at: 1767225600 + offset + i,
            ...(promptRecords?.[offset + i] ? { conversation_id: promptRecords[offset + i].conversationId,
              message_id: `output-${offset + i}`, asset_pointer: `sediment://${fixtureFileId(offset + i)}` } : {})
          })),
          cursor: end < gallerySize ? `page:${end}+/=opaque` : null
        });
      }
      if (gallerySize && parsed.pathname.includes('/recent/uploaded_images')) return new Response('', { status: 422 });
      if (parsed.hostname === 'files.oaiusercontent.com') return new Response(imageBytes, { headers: { 'content-type': 'image/png' } });
      if (gallerySize && /^\/backend-api\/files\/file_img\d+\/download$/.test(parsed.pathname)) {
        return Response.json({ download_url: `https://files.oaiusercontent.com/${parsed.pathname.split('/')[3]}.png?sig=original` });
      }
      if (/\/files\/(file_abc123\/download|download\/file_abc123)$/.test(url)) {
        return noOriginal ? new Response('missing', { status: 404 }) : Response.json({ download_url: original });
      }
      if (changePageDuringMetadata) {
        context.location.href = 'https://chatgpt.com/library/d/other';
        context.location.pathname = '/library/d/other';
      }
      if (parsed.pathname === '/backend-api/my/recent/image_gen') {
        return Response.json({ items: emptyDom ? [] : [{ id: 'file_abc123', title: 'sample.png', created_at: 1767225600 }], cursor: null });
      }
      return Response.json({ items: [] });
    }
  });
  vm.runInContext(fs.readFileSync('original-images.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('image-lists.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('download-queue.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('image-numbering.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('download-progress.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('prompt-resolver.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('prompt-groups.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('prompt-conversations.js', 'utf8'), context);
  const collectPrompts = context.ChatGPTPromptConversations.collect;
  context.ChatGPTPromptConversations.collect = (entries, options) => {
    let time = 0;
    return collectPrompts(entries, { ...options, now: () => time, sleep: async ms => { time += ms; } });
  };
  vm.runInContext(fs.readFileSync('content.js', 'utf8'), context);
  vm.runInContext("chooseDownloadLocation = async () => 'original-quality-test'", context);
  vm.runInContext(`selectedAfterSequence = ${Number(afterSequence)}`, context);
  vm.runInContext(`selectedConcurrency = ${JSON.stringify(concurrency)}`, context);
  vm.runInContext(`selectedSavePrompts = ${Boolean(savePrompts)}`, context);
  context.ChatGPTDownloadProgress.createPanel = () => ({ update(patch) { panelUpdates.push(patch); }, destroy() {} });
  const button = elements.get('cgpt-bulk-btn');
  await button.onclick();
  const reportDownload = downloads.find(d => d.filename.endsWith('-download-results.json'));
  if (changePageDuringMetadata || changePageDuringPrompts) return { downloads, button, conversationRequests };
  assert.ok(reportDownload, 'results JSON must be exported even after image failures');
  const report = JSON.parse(decodeURIComponent(reportDownload.url.split(',').slice(1).join(',')));
  return { downloads, report, button, imageBytes, galleryRequests, conversationRequests, conversationReads, sessionRequests, panelUpdates };
}

test('content → original resolver → worker preserves bytes and exports pixel/hash evidence', async () => {
  const { downloads, report, button, imageBytes } = await runFlow();
  assert.equal(report.discovered, 1, 'scroll snapshots must deduplicate');
  assert.equal(report.queued, 1);
  assert.equal(report.failed, 0);
  assert.equal(report.images[0].width, 1536);
  assert.equal(report.images[0].height, 1024);
  assert.match(report.images[0].sha256, /^[a-f0-9]{64}$/);
  const image = downloads.find(d => d.url.startsWith('data:image/'));
  assert.deepEqual(Buffer.from(image.url.split(',')[1], 'base64'), imageBytes);
  assert.match(image.filename, /^original-quality-test\/000001-sample.png$/);
  assert.equal(button.disabled, false);
  assert.match(button.textContent, /1 originals queued, 0 failed/);
});

test('Chrome download errors are visible and never counted as success', async () => {
  const { report, button } = await runFlow({ failImage: true });
  assert.equal(report.queued, 0);
  assert.equal(report.failed, 1);
  assert.equal(report.images[0].error, 'Download rejected by browser');
  assert.match(button.textContent, /0 originals queued, 1 failed/);
  assert.equal(button.disabled, false);
});

test('unavailable original produces failure report and no preview file', async () => {
  const { downloads, report, button } = await runFlow({ noOriginal: true });
  assert.equal(downloads.filter(d => d.url.startsWith('data:image/')).length, 0);
  assert.equal(report.failed, 1);
  assert.match(report.images[0].error, /no thumbnail saved/);
  assert.equal(button.disabled, false);
});


test('navigation during metadata retrieval cannot mix images from another view', async () => {
  const { downloads, button } = await runFlow({ changePageDuringMetadata: true });
  assert.equal(downloads.filter(d => d.url.startsWith('data:image/')).length, 0);
  assert.equal(button.disabled, false);
});


test('cursor gallery exports 2,137 original images across 22 pages', async () => {
  const { downloads, report, galleryRequests, imageBytes } = await runFlow({ gallerySize: 2137 });
  assert.equal(galleryRequests.length, 22);
  assert.equal(report.pagination.recentImageGen.pages, 22);
  assert.equal(report.collectionIncomplete, false);
  assert.equal(report.pagination.recentUploadedImages.complete, false, 'optional upload failure must not hide completed gallery collection');
  assert.equal(report.discovered, 2137);
  assert.equal(report.downloadPerformance.concurrency, 6);
  assert.ok(report.downloadPerformance.peakActive > 1);
  assert.ok(report.downloadPerformance.peakActive <= 6);
  assert.equal(report.images[0].fileId, 'file_abc123');
  assert.equal(report.images.at(-1).fileId, 'file_img2136');
  assert.equal(report.queued, 2137);
  assert.equal(report.failed, 0);
  const images = downloads.filter(d => d.url.startsWith('data:image/'));
  assert.equal(images.length, 2137);
  assert.equal(new Set(images.map(d => d.filename)).size, 2137);
  assert.deepEqual(Buffer.from(images.at(-1).url.split(',')[1], 'base64'), imageBytes);
});


test('partial gallery cannot produce misleading chronological image numbers', async () => {
  const { report, button } = await runFlow({ gallerySize: 2137, failGalleryPage: true });
  assert.equal(report.queued, 0);
  assert.equal(report.status, 'numbering-blocked');
  assert.equal(report.pagination.recentImageGen.stopReason, 'request_failed');
  assert.match(button.textContent, /Cannot assign stable numbers/);
});


test('unavailable API plus empty DOM finishes with an actionable report instead of spinning', async () => {
  const { report, button } = await runFlow({ emptyDom: true, unavailableGallery: true });
  assert.equal(report.status, 'numbering-blocked');
  assert.equal(report.queued, 0);
  assert.match(report.numbering.error, /422/);
  assert.match(button.textContent, /422/);
  assert.equal(button.disabled, false);
});


test('incremental export scans every page and keeps absolute sequence numbers', async () => {
  const { report, downloads, galleryRequests } = await runFlow({ gallerySize: 2137, afterSequence: 1600 });
  assert.equal(galleryRequests.length, 22);
  assert.equal(report.discovered, 2137);
  assert.equal(report.selected, 537);
  assert.equal(report.skipped, 1600);
  assert.equal(report.queued, 537);
  assert.equal(report.images[0].sequence, 1601);
  assert.equal(report.images.at(-1).sequence, 2137);
  const images = downloads.filter(d => d.url.startsWith('data:image/'));
  assert.ok(images.some(d => d.filename.startsWith('original-quality-test/001601-')));
  assert.ok(images.every(d => Number(d.filename.split('/').at(-1).split('-')[0]) > 1600));
});

test('boundary equal to total produces no image downloads and clear no-new-images feedback', async () => {
  const { report, downloads, button } = await runFlow({ gallerySize: 100, afterSequence: 100 });
  assert.equal(report.queued, 0);
  assert.equal(report.selected, 0);
  assert.equal(downloads.filter(d => d.url.startsWith('data:image/')).length, 0);
  assert.match(button.textContent, /No new images after 100/);
});

const promptFixtureRecords = [
  { conversationId: 'conversation-a', prompt: '相同提示词' },
  { conversationId: 'conversation-b', prompt: 'Other prompt' },
  { conversationId: 'conversation-a', prompt: '相同提示词' }
];

test('prompt mode off keeps flat downloads and makes zero conversation-body requests', async () => {
  const { downloads, report, conversationRequests } = await runFlow({ gallerySize: 3, promptRecords: promptFixtureRecords });
  assert.deepEqual(conversationRequests, []);
  assert.equal(report.savePrompts, false);
  assert.equal(report.prompts.status, 'disabled');
  assert.equal(downloads.some(item => item.url.startsWith('data:text/plain')), false);
  assert.ok(downloads.filter(item => item.url.startsWith('data:image/')).every(item => item.filename.split('/').length === 2));
});

test('grouped increment resolves full history, reuses group zero and writes one UTF-8 TXT', async () => {
  const { downloads, report, conversationRequests, conversationReads, sessionRequests, imageBytes, panelUpdates } = await runFlow({ gallerySize: 3,
    promptRecords: promptFixtureRecords, savePrompts: true, afterSequence: 2 });
  assert.deepEqual(conversationRequests.sort(), ['conversation-a', 'conversation-b']);
  assert.equal(sessionRequests.length, 1);
  assert.ok(conversationReads.every(read => !read.full && read.bearerSent));
  assert.equal(report.groupCount, 2);
  assert.equal(report.selectedGroupCount, 1);
  assert.equal(report.images[0].sequence, 3);
  assert.equal(report.images[0].groupNumber, 0);
  assert.equal(report.images[0].promptSource.conversationId, 'conversation-a');
  const prompts = downloads.filter(item => item.url.startsWith('data:text/plain'));
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].filename, 'original-quality-test/0000/prompt.txt');
  assert.equal(prompts[0].conflictAction, 'overwrite');
  assert.equal(decodeURIComponent(prompts[0].url.split(',').slice(1).join(',')), '相同提示词\n');
  const images = downloads.filter(item => item.url.startsWith('data:image/'));
  assert.equal(images.length, 1);
  assert.equal(images[0].filename, 'original-quality-test/0000/000003-Original 2.png');
  assert.equal(images[0].conflictAction, 'uniquify');
  assert.deepEqual(Buffer.from(images[0].url.split(',')[1], 'base64'), imageBytes);
  assert.ok(downloads.indexOf(prompts[0]) < downloads.indexOf(images[0]));
  assert.ok(panelUpdates.some(update => update.stage === 'prompts'));
  assert.ok(panelUpdates.some(update => update.groupCount === 2 && update.total === 1));
});

test('prompt collection reuses authentication already acquired while reading the image list', async () => {
  const { report, sessionRequests, conversationReads } = await runFlow({ gallerySize: 3,
    promptRecords: promptFixtureRecords, savePrompts: true, metadataRequiresAuth: true });
  assert.equal(report.queued, 3);
  assert.equal(sessionRequests.length, 1, 'prompt stage must share the run client');
  assert.equal(conversationReads.length, 2);
  assert.ok(conversationReads.every(read => !read.full && read.bearerSent));
});

test('authenticated 404 routes images to unresolved with the accurate cause and no invented TXT', async () => {
  const { report, downloads, button, conversationReads, panelUpdates } = await runFlow({ gallerySize: 3,
    promptRecords: promptFixtureRecords, savePrompts: true, conversationStatus: 404 });
  assert.equal(report.prompts.status, 'partial');
  assert.equal(report.queued, 3);
  assert.equal(report.prompts.unresolvedCount, 3);
  assert.ok(report.images.every(image => image.groupName === '未解析' && image.promptStatus === 'unresolved'));
  assert.equal(conversationReads.length, 2, 'permanent 404 must not be retried');
  assert.equal(downloads.filter(item => item.url.startsWith('data:image/')).length, 3);
  assert.equal(downloads.some(item => item.url.startsWith('data:text/plain')), false);
  assert.deepEqual(report.prompts.errorSummary, [{ code: 'http_error', phase: 'conversation', httpStatus: 404,
    bearerSent: true, authRetried: false, affectedImages: 3, affectedConversations: 2 }]);
  assert.match(button.textContent, /3 images in 未解析/);
  assert.ok(downloads.filter(item => item.url.startsWith('data:image/')).every(item => item.filename.includes('/未解析/')));
  assert.ok(panelUpdates.some(update => update.message?.includes('HTTP 404')));
  assert.doesNotMatch(JSON.stringify(report), /fixture-only-token|private-server-error-fixture/);
});

test('missing session token prevents every conversation read and is reported as auth failure', async () => {
  const { report, downloads, conversationRequests } = await runFlow({ gallerySize: 3,
    promptRecords: promptFixtureRecords, savePrompts: true, sessionAvailable: false });
  assert.equal(report.prompts.status, 'partial');
  assert.equal(report.prompts.unresolvedCount, 3);
  assert.deepEqual(conversationRequests, []);
  assert.ok(report.prompts.collectionErrors.every(error => error.code === 'session_unavailable' && error.phase === 'auth'));
  assert.equal(downloads.some(item => item.url.startsWith('data:text/plain')), false);
  assert.ok(report.images.every(image => image.groupName === '未解析'));
});

test('one TXT per touched group and image failures retain global sequence/group identities', async () => {
  const { downloads, report } = await runFlow({ gallerySize: 3, promptRecords: promptFixtureRecords, savePrompts: true, failImage: true });
  assert.equal(downloads.filter(item => item.url.startsWith('data:text/plain')).length, 2);
  assert.deepEqual(report.images.map(item => [item.sequence, item.groupNumber]), [[1, 0], [2, 1], [3, 0]]);
  assert.equal(report.failed, 3);
  assert.equal(report.prompts.saveErrors.length, 0);
});

test('unresolved historical prompt no longer blocks known selected images after cutoff', async () => {
  const { downloads, report, button } = await runFlow({ gallerySize: 3, promptRecords: promptFixtureRecords,
    savePrompts: true, afterSequence: 2, unresolvedPrompts: [0] });
  assert.equal(report.prompts.status, 'partial');
  assert.equal(report.queued, 1);
  assert.equal(report.prompts.unresolvedCount, 1);
  assert.equal(report.prompts.selectedUnresolvedCount, 0);
  assert.equal(report.images[0].sequence, 3);
  assert.equal(report.images[0].groupNumber, 1);
  assert.ok(report.prompts.collectionErrors.some(item => item.fileId === 'file_abc123' && item.code === 'target_not_found'));
  assert.equal(downloads.filter(item => item.url.startsWith('data:image/')).length, 1);
  assert.equal(button.disabled, false);
});

test('mixed known and unknown prompts preserve global filenames and original bytes', async () => {
  const { downloads, report, imageBytes } = await runFlow({ gallerySize: 3, promptRecords: promptFixtureRecords,
    savePrompts: true, unresolvedPrompts: [1] });
  assert.equal(report.queued, 3);
  assert.deepEqual(report.images.map(item => item.groupName), ['0000', '未解析', '0000']);
  assert.equal(report.images[1].promptError.code, 'target_not_found');
  assert.equal(report.warnings, 1);
  const unknown = downloads.find(item => item.filename.includes('/未解析/'));
  assert.match(unknown.filename, /000002-/);
  assert.equal(unknown.conflictAction, 'uniquify');
  assert.deepEqual(Buffer.from(unknown.url.split(',')[1], 'base64'), imageBytes);
  assert.equal(downloads.filter(item => item.url.startsWith('data:text/plain')).length, 1);
});

test('equal-total boundary still resolves full prompts but touches no group', async () => {
  const { downloads, report, conversationRequests } = await runFlow({ gallerySize: 3, promptRecords: promptFixtureRecords,
    savePrompts: true, afterSequence: 3 });
  assert.equal(conversationRequests.length, 2);
  assert.equal(report.groupCount, 2);
  assert.equal(report.selectedGroupCount, 0);
  assert.equal(report.selected, 0);
  assert.equal(downloads.some(item => /^data:(?:image\/|text\/plain)/.test(item.url)), false);
});

test('TXT failures are separate and do not renumber or prevent valid image submissions', async () => {
  const { report } = await runFlow({ gallerySize: 3, promptRecords: promptFixtureRecords,
    savePrompts: true, failPrompt: true });
  assert.equal(report.queued, 3);
  assert.equal(report.failed, 0);
  assert.equal(report.prompts.saveErrors.length, 2);
  assert.equal(report.prompts.saveStatus, 'partial');
  assert.deepEqual(report.images.map(item => item.groupNumber), [0, 1, 0]);
});

test('navigation during prompt restoration admits no downloads', async () => {
  const { downloads, button } = await runFlow({ gallerySize: 3, promptRecords: promptFixtureRecords,
    savePrompts: true, changePageDuringPrompts: true });
  assert.equal(downloads.length, 0);
  assert.equal(button.disabled, false);
  assert.match(button.textContent, /Page changed/);
});


test('temporary prompt rate limit waits and still groups every image', async () => {
  const { report, downloads, conversationReads } = await runFlow({ gallerySize: 3,
    promptRecords: promptFixtureRecords, savePrompts: true, conversationStatus: 429 });
  assert.equal(conversationReads.length, 4);
  assert.equal(report.prompts.stopped, false);
  assert.ok(report.prompts.rateLimitEpisodes >= 1);
  assert.equal(report.prompts.unresolvedCount, 0);
  assert.equal(report.queued, 3);
  assert.ok(report.images.every(image => image.promptStatus === 'resolved'));
  assert.equal(downloads.filter(item => item.url.startsWith('data:text/plain')).length, 2);
});
