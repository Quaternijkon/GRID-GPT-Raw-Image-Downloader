/* Grok Imagine list, identity, prompt, and original-byte validation. */
(() => {
  const ORIGIN = 'https://grok.com';
  const ASSET_ORIGIN = 'https://assets.grok.com';
  const PAGE_SIZE = 40;
  const MAX_PAGES = 500;
  const MAX_POSTS = 20000;
  const MEDIA_ID = /^[A-Za-z0-9_-]{8,128}$/;
  const SOURCE = Object.freeze({ owned: 'MEDIA_POST_SOURCE_OWNED', liked: 'MEDIA_POST_SOURCE_LIKED' });

  function scope(pathname) {
    if (!/^\/imagine(?:\/|$)/.test(pathname || '')) return null;
    return /^\/imagine\/(?:saved|favorites)(?:\/|$)/.test(pathname) ? 'liked' : 'owned';
  }

  function mediaUrl(value) {
    if (typeof value !== 'string') return null;
    try {
      const url = new URL(value, `${ASSET_ORIGIN}/`);
      if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
      if (!['grok.com', 'assets.grok.com', 'imagine-public.x.ai'].includes(url.hostname)) return null;
      if (/\/(?:thumb|thumbnail|preview)(?:[/.?]|$)/i.test(url.pathname) ||
          /(?:^|[?&])(?:w|h|width|height|resize|quality)=/i.test(url.search)) return null;
      return url.href;
    } catch (_) { return null; }
  }

  function classify(post) {
    const type = post?.mediaType || post?.mimeType || '';
    if (/VIDEO|video\//i.test(type)) return 'video';
    if (/IMAGE|image\//i.test(type)) return 'image';
    const url = post?.hd1080MediaUrl || post?.hdMediaUrl || post?.mediaUrl || '';
    if (/\.(?:mp4|webm)(?:\?|$)/i.test(url)) return 'video';
    if (/\.(?:png|jpe?g|webp|gif|avif)(?:\?|$)/i.test(url)) return 'image';
    return null;
  }

  function timestamp(value) {
    const n = typeof value === 'number' || /^\d+(?:\.\d+)?$/.test(String(value || ''))
      ? Number(value) : Date.parse(String(value || ''));
    const ms = Number.isFinite(n) && n > 0 && n < 1e11 ? n * 1000 : n;
    return Number.isFinite(ms) && ms > 0 && ms <= 8640000000000000 ? ms : null;
  }

  function entriesFromPosts(posts) {
    if (!Array.isArray(posts)) throw new Error('Grok media response has no posts array');
    const byId = new Map(), issues = [];
    let visited = 0;
    const visit = (post, parent = null, depth = 0) => {
      if (!post || typeof post !== 'object' || depth > 6 || ++visited > MAX_POSTS) return;
      const id = post.id || post.postId || post.assetId;
      const kind = classify(post);
      const candidates = [post.hd1080MediaUrl, post.hdMediaUrl, post.mediaUrl]
        .filter(value => typeof value === 'string' && value)
        .map(mediaUrl).filter(Boolean);
      if (kind && id) {
        if (!MEDIA_ID.test(String(id))) issues.push({ id: String(id).slice(0, 128), code: 'invalid_identity' });
        else {
          const time = timestamp(post.createTime ?? post.createdAt ?? parent?.createTime ?? parent?.createdAt);
          if (time === null) issues.push({ id: String(id), code: 'invalid_creation_time' });
          else {
            const prompt = [post.prompt, post.originalPrompt, post.originalPost?.prompt,
              post.originalPost?.originalPrompt, parent?.prompt, parent?.originalPrompt]
              .find(value => typeof value === 'string' && value.trim());
            const entry = { id: String(id), kind, createdAt: new Date(time).toISOString(), time,
              sourceConversationId: post.sourceConversationId || post.conversationId ||
                parent?.sourceConversationId || parent?.conversationId || null,
              sourceResponseId: post.responseId || parent?.responseId || null,
              reportedWidth: Number.isFinite(post.width) && post.width > 0 ? post.width :
                Number.isFinite(post.resolution?.width) && post.resolution.width > 0 ? post.resolution.width : null,
              reportedHeight: Number.isFinite(post.height) && post.height > 0 ? post.height :
                Number.isFinite(post.resolution?.height) && post.resolution.height > 0 ? post.resolution.height : null,
              videoDuration: Number.isFinite(post.videoDuration) && post.videoDuration > 0 ? post.videoDuration : null,
              reportedSizeBytes: Number.isFinite(post.sizeBytes) && post.sizeBytes > 0 ? post.sizeBytes : null,
              prompt: prompt ? prompt.replace(/\r\n?/g, '\n').trim() : null,
              promptSource: typeof post.prompt === 'string' && post.prompt.trim() ? 'post.prompt' :
                typeof post.originalPrompt === 'string' && post.originalPrompt.trim() ? 'post.originalPrompt' :
                  prompt ? 'parent.prompt' : 'missing',
              modelName: typeof post.modelName === 'string' ? post.modelName : null,
              candidates: [...new Set(candidates)],
              sourceError: candidates.length ? null : 'No permitted original media URL in the Grok post' };
            const prior = byId.get(entry.id);
            if (prior && (prior.time !== entry.time || prior.kind !== entry.kind ||
              prior.prompt && entry.prompt && prior.prompt !== entry.prompt)) {
              issues.push({ id: entry.id, code: 'conflicting_identity' });
            } else if (!prior || entry.candidates.length > prior.candidates.length) byId.set(entry.id, entry);
          }
        }
      }
      for (const key of ['childPosts', 'images', 'videos']) {
        if (Array.isArray(post[key])) for (const child of post[key]) visit(child, post, depth + 1);
      }
    };
    for (const post of posts) visit(post);
    if (visited > MAX_POSTS) throw new Error('Grok media response exceeds the supported size');
    if (issues.length) throw Object.assign(new Error(`Grok media has ${issues.length} unstable record(s)`), { issues });
    return [...byId.values()];
  }

  function entriesFromAssets(assets) {
    if (!Array.isArray(assets)) throw new Error('Grok assets response has no assets array');
    const posts = assets.filter(asset => asset && asset.isDeleted !== true &&
      asset.fileSource === 'IMAGINE_GENERATED_FILE_SOURCE').map(asset => {
      const input = asset.mediaGenInput && typeof asset.mediaGenInput === 'object'
        ? Object.values(asset.mediaGenInput).find(value => value && typeof value === 'object') : null;
      const prompt = [input?.prompt, asset.auxKeys?.video_original_prompt,
        asset.auxKeys?.original_prompt].find(value => typeof value === 'string' && value.trim());
      return { id: asset.assetId, createTime: asset.createTime, mimeType: asset.mimeType,
        mediaType: asset.mimeType, hd1080MediaUrl: asset.hd1080Key,
        hdMediaUrl: asset.hdKey, mediaUrl: asset.key,
        sourceConversationId: asset.sourceConversationId,
        responseId: asset.responseId,
        width: asset.width, height: asset.height,
        sizeBytes: asset.sizeBytes,
        videoDuration: input?.videoDuration || input?.duration || null,
        prompt: prompt || null, modelName: input?.modelName || null };
    });
    return entriesFromPosts(posts);
  }

  function parsePage(data) {
    const posts = data?.posts ?? data?.mediaPosts;
    if (!Array.isArray(posts)) throw new Error('Grok media response shape changed: posts array is missing');
    const nextCursor = data.nextCursor ?? data.next_cursor ?? null;
    if (nextCursor !== null && (typeof nextCursor !== 'string' || !nextCursor))
      throw new Error('Grok media response has an invalid cursor');
    return { posts, nextCursor };
  }

  async function collect(fetchImpl, source, { checkActive = () => {}, onProgress = () => {},
    delay = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
    if (!SOURCE[source]) throw new Error('Unsupported Grok media scope');
    const cursors = new Set(), posts = [];
    let cursor = null, pages = 0;
    for (;;) {
      checkActive();
      if (++pages > MAX_PAGES) throw new Error(`Grok media pagination exceeded ${MAX_PAGES} pages`);
      let response;
      for (let attempt = 1; attempt <= 4; attempt++) {
        checkActive();
        response = await fetchImpl(`${ORIGIN}/rest/media/post/list`, {
          method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ limit: PAGE_SIZE, filter: { source: SOURCE[source] },
            ...(cursor ? { cursor } : {}) })
        });
        if (response.status !== 429 && response.status < 500) break;
        if (attempt === 4) break;
        const retryHeader = response.headers?.get('retry-after');
        const retryAfter = retryHeader == null ? NaN : Number(retryHeader);
        await delay(Number.isFinite(retryAfter) && retryAfter >= 0
          ? Math.min(60000, retryAfter * 1000) : 1000 * 2 ** (attempt - 1));
      }
      if (!response.ok) throw Object.assign(new Error(`Grok media page ${pages} returned HTTP ${response.status}`),
        { httpStatus: response.status });
      let data;
      try { data = await response.json(); }
      catch (_) { throw new Error(`Grok media page ${pages} returned invalid JSON`); }
      const page = parsePage(data);
      posts.push(...page.posts);
      if (posts.length > MAX_POSTS) throw new Error('Grok media list exceeds the supported size');
      onProgress({ pages, posts: posts.length });
      checkActive();
      if (!page.nextCursor) break;
      if (cursors.has(page.nextCursor)) throw new Error('Grok media pagination repeated a cursor');
      cursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    const entries = entriesFromPosts(posts).sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
    return { entries: entries.map((entry, index) => ({ ...entry, sequence: index + 1 })),
      pagination: { complete: true, provider: 'media-posts', pages, posts: posts.length, media: entries.length } };
  }

  async function collectAssets(fetchImpl, { checkActive = () => {}, onProgress = () => {},
    delay = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
    const tokens = new Set(), assets = [];
    let pageToken = null, pages = 0;
    for (;;) {
      checkActive();
      if (++pages > MAX_PAGES) throw new Error(`Grok assets pagination exceeded ${MAX_PAGES} pages`);
      const url = new URL('/rest/assets', ORIGIN);
      url.searchParams.set('workspaceKind', 'WORKSPACE_KIND_IMAGINE_ALL');
      url.searchParams.set('orderBy', 'ORDER_BY_CREATE_TIME');
      url.searchParams.set('pageSize', String(PAGE_SIZE));
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      let response;
      for (let attempt = 1; attempt <= 4; attempt++) {
        checkActive();
        response = await fetchImpl(url.href, { method: 'GET', credentials: 'include' });
        if (response.status !== 429 && response.status < 500) break;
        if (attempt === 4) break;
        const retryHeader = response.headers?.get('retry-after');
        const retryAfter = retryHeader == null ? NaN : Number(retryHeader);
        await delay(Number.isFinite(retryAfter) && retryAfter >= 0
          ? Math.min(60000, retryAfter * 1000) : 1000 * 2 ** (attempt - 1));
      }
      if (!response.ok) throw Object.assign(new Error(`Grok assets page ${pages} returned HTTP ${response.status}`),
        { httpStatus: response.status });
      let data;
      try { data = await response.json(); }
      catch (_) { throw new Error(`Grok assets page ${pages} returned invalid JSON`); }
      if (!Array.isArray(data?.assets)) throw new Error('Grok assets response shape changed: assets array is missing');
      assets.push(...data.assets);
      if (assets.length > MAX_POSTS) throw new Error('Grok assets list exceeds the supported size');
      onProgress({ pages, posts: assets.length });
      checkActive();
      const next = data.nextPageToken ?? null;
      if (next === null) break;
      if (typeof next !== 'string' || !next || tokens.has(next)) throw new Error('Grok assets pagination has an invalid or repeated token');
      tokens.add(next);
      pageToken = next;
    }
    const entries = entriesFromAssets(assets).sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
    return { entries: entries.map((entry, index) => ({ ...entry, sequence: index + 1 })),
      pagination: { complete: true, provider: 'assets-v2', pages, posts: assets.length, media: entries.length } };
  }

  async function collectCurrent(fetchImpl, source, options = {}) {
    if (source === 'liked') {
      let completedPostPages = 0, postError;
      try {
        const posts = await collect(fetchImpl, source, { ...options,
          onProgress: progress => { completedPostPages = progress.pages; options.onProgress?.(progress); } });
        if (posts.entries.length) return posts;
      } catch (error) {
        if ([401, 403, 429].includes(error.httpStatus)) throw error;
        if (completedPostPages > 0) throw error;
        postError = error;
        options.checkActive?.();
      }
      try { return await collectAssets(fetchImpl, options); }
      catch (error) { throw new Error(`Grok saved media APIs unavailable: posts ${postError?.message || 'empty'}; assets ${error.message}`); }
    }
    let assetError, completedAssetPages = 0;
    try {
      const assets = await collectAssets(fetchImpl, { ...options,
        onProgress: progress => { completedAssetPages = progress.pages; options.onProgress?.(progress); } });
      if (assets.entries.length) return assets;
    } catch (error) {
      if ([401, 403, 429].includes(error.httpStatus)) throw error;
      if (completedAssetPages > 0) throw error;
      assetError = error;
      options.checkActive?.();
    }
    try { return await collect(fetchImpl, source, options); }
    catch (error) {
      throw new Error(`Grok media APIs unavailable: assets ${assetError?.message || 'empty'}; posts ${error.message}`);
    }
  }

  function matchPrompt(entry, responses) {
    if (!Array.isArray(responses)) return { code: 'response_shape', message: 'Conversation has no response list' };
    const byId = new Map(responses.filter(response => typeof response?.responseId === 'string')
      .map(response => [response.responseId, response]));
    const containsAsset = response => {
      if (String(response?.sender || '').toLowerCase() !== 'assistant') return false;
      const fields = ['fileAttachments', 'fileUris', 'fileAttachmentsMetadata',
        'fileAttachmentAssetMetadata', 'cardAttachmentsJson', 'generatedImageUrls', 'imageEditUris'];
      return fields.some(field => response[field] && JSON.stringify(response[field]).includes(entry.id));
    };
    const exact = entry.sourceResponseId ? byId.get(entry.sourceResponseId) : null;
    const candidates = exact && containsAsset(exact) ? [exact] : responses.filter(containsAsset);
    if (candidates.length !== 1) return { code: candidates.length ? 'ambiguous_output' : 'target_not_found',
      message: candidates.length ? 'Several outputs contain this media ID' : 'No output contains this media ID' };
    let current = candidates[0];
    const visited = new Set();
    while (current && !visited.has(current.responseId)) {
      visited.add(current.responseId);
      current = byId.get(current.parentResponseId);
      if (String(current?.sender || '').toLowerCase() === 'human') {
        const prompt = typeof current.message === 'string' ? current.message.replace(/\r\n?/g, '\n').trim() : '';
        return prompt ? { prompt, sourceResponseId: candidates[0].responseId,
          inputResponseId: current.responseId } :
          { code: 'empty_prompt', message: 'The linked user message has no text prompt' };
      }
    }
    return { code: 'parent_not_found', message: 'The media output has no linked user message' };
  }

  async function resolvePrompts(entries, { fetchImpl = globalThis.fetch, checkActive = () => {},
    onProgress = () => {}, delay = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
    const missing = entries.filter(entry => !entry.prompt);
    const buckets = new Map();
    for (const entry of missing) {
      const id = entry.sourceConversationId;
      if (!/^[A-Za-z0-9_-]{8,128}$/.test(id || '')) {
        entry.promptError = { code: 'conversation_missing', message: 'Media has no valid source conversation ID' };
      } else {
        if (!buckets.has(id)) buckets.set(id, []);
        buckets.get(id).push(entry);
      }
    }
    let processed = 0;
    const errors = [];
    for (const [conversationId, bucket] of buckets) {
      checkActive();
      try {
        const path = `${ORIGIN}/rest/app-chat/conversations/${encodeURIComponent(conversationId)}/responses?conversationKind=CONVERSATION_KIND_IMAGINE`;
        let response;
        for (let attempt = 1; attempt <= 4; attempt++) {
          response = await fetchImpl(path, { method: 'GET', credentials: 'include' });
          if (response.status !== 429 && response.status < 500 || attempt === 4) break;
          const header = response.headers?.get('retry-after');
          const wait = header == null ? NaN : Number(header);
          await delay(Number.isFinite(wait) && wait >= 0 ? Math.min(60000, wait * 1000) :
            1000 * 2 ** (attempt - 1));
          checkActive();
        }
        if (!response.ok) throw Object.assign(new Error(`Grok prompt conversation returned HTTP ${response.status}`),
          { httpStatus: response.status });
        let data;
        try { data = await response.json(); }
        catch (_) { throw new Error('Conversation returned invalid JSON'); }
        if (!Array.isArray(data?.responses) || data.nextPageToken || data.nextCursor) {
          throw new Error('Conversation responses are incomplete or unsupported');
        }
        checkActive();
        for (const entry of bucket) {
          const result = matchPrompt(entry, data.responses);
          if (result.prompt) {
            entry.prompt = result.prompt;
            entry.promptSource = 'conversation.user.message';
            entry.promptProvenance = { conversationId, sourceResponseId: result.sourceResponseId,
              inputResponseId: result.inputResponseId };
          } else entry.promptError = { code: result.code, message: result.message };
        }
      } catch (error) {
        checkActive();
        if ([401, 403, 429].includes(error.httpStatus)) throw error;
        for (const entry of bucket) entry.promptError = { code: 'conversation_read_failed', message: error.message };
      }
      processed++;
      onProgress({ processed, total: buckets.size,
        resolved: entries.filter(entry => Boolean(entry.prompt)).length });
      if (processed < buckets.size) { await delay(700); checkActive(); }
    }
    for (const entry of entries) if (!entry.prompt) {
      entry.promptError ||= { code: 'prompt_missing', message: 'No exact prompt was available' };
      errors.push({ mediaId: entry.id, code: entry.promptError.code, message: entry.promptError.message });
    }
    return { conversations: buckets.size, resolved: entries.length - errors.length,
      unresolved: errors.length, errors };
  }

  function sniff(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const ascii = (start, end) => String.fromCharCode(...b.slice(start, end));
    if (b.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => b[index] === value))
      return { kind: 'image', mimeType: 'image/png', extension: 'png' };
    if (b.length >= 3 && b[0] === 255 && b[1] === 216 && b[2] === 255) return { kind: 'image', mimeType: 'image/jpeg', extension: 'jpg' };
    if (b.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return { kind: 'image', mimeType: 'image/webp', extension: 'webp' };
    if (b.length >= 6 && /^GIF8[79]a$/.test(ascii(0, 6))) return { kind: 'image', mimeType: 'image/gif', extension: 'gif' };
    if (b.length >= 12 && ascii(4, 8) === 'ftyp' && /^(?:avif|avis)$/.test(ascii(8, 12))) return { kind: 'image', mimeType: 'image/avif', extension: 'avif' };
    if (b.length >= 12 && ascii(4, 8) === 'ftyp' &&
      /^(?:isom|iso[2-9]|mp4[12]|avc1|M4V |MSNV|qt  |dash|3gp[4-9])$/.test(ascii(8, 12)))
      return { kind: 'video', mimeType: 'video/mp4', extension: 'mp4' };
    if (b.length >= 4 && b[0] === 26 && b[1] === 69 && b[2] === 223 && b[3] === 163) return { kind: 'video', mimeType: 'video/webm', extension: 'webm' };
    return null;
  }

  async function fetchOriginal(entry, { fetchImpl = globalThis.fetch, checkActive = () => {},
    onRequestTiming = () => {} } = {}) {
    let lastError, attempts = 0;
    const failures = [];
    for (const candidate of entry.candidates || []) {
      const url = mediaUrl(candidate);
      if (!url) continue;
      checkActive();
      try {
        attempts++;
        const started = Date.now();
        const response = await fetchImpl(url, { credentials: new URL(url).hostname.endsWith('grok.com')
          ? 'include' : 'omit', redirect: 'follow' });
        onRequestTiming({ ttfbMs: Date.now() - started });
        if (!response.ok) {
          const header = response.headers?.get('retry-after');
          const retrySeconds = header == null ? NaN : Number(header);
          throw Object.assign(new Error(`Media request returned HTTP ${response.status}`), {
            httpStatus: response.status,
            retryable: [408, 429].includes(response.status) || response.status >= 500,
            retryAfterMs: Number.isFinite(retrySeconds) && retrySeconds >= 0
              ? Math.min(60000, retrySeconds * 1000) : 0
          });
        }
        if (!mediaUrl(response.url || url)) throw new Error('Media redirected outside permitted hosts');
        const blob = await response.blob();
        if (blob.size < 12) throw new Error('Original media is empty or truncated');
        const format = sniff(new Uint8Array(await blob.slice(0, 32).arrayBuffer()));
        if (!format || format.kind !== entry.kind) throw new Error('Original media bytes do not match the expected image/video format');
        checkActive();
        return { blob, ...format, sourceHost: new URL(response.url || url).hostname,
          quality: candidate === entry.candidates[0] ? 'preferred' : 'fallback',
          retrievalAttempts: attempts, retrievalErrors: failures };
      } catch (error) {
        lastError = error;
        failures.push({ phase: 'fetch', ...(error.httpStatus ? { status: error.httpStatus } : {}),
          message: error.message });
        error.retrievalAttempts = attempts;
        error.retrievalErrors = failures;
        if (error.retryable || [401, 403].includes(error.httpStatus) || error.name === 'TypeError') {
          if (error.name === 'TypeError') error.retryable = true;
          throw error;
        }
        checkActive();
      }
    }
    throw lastError || new Error(entry.sourceError || 'No permitted original media URL');
  }

  const api = { ORIGIN, ASSET_ORIGIN, PAGE_SIZE, SOURCE, scope, mediaUrl, classify, timestamp,
    entriesFromPosts, entriesFromAssets, parsePage, collect, collectAssets, collectCurrent,
    matchPrompt, resolvePrompts, sniff, fetchOriginal };
  globalThis.ChatGPTGrokMedia = api;
  if (typeof module !== 'undefined') module.exports = api;
})();
