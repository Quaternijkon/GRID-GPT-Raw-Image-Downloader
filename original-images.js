/* Original asset resolution. Shared by the content script and dependency-free tests. */
(() => {
  const ORIGIN = 'https://chatgpt.com';
  const REQUEST_TIMEOUT_MS = 30000;

  function decode(value) {
    let text = String(value || '');
    for (let i = 0; i < 2; i++) {
      try { text = decodeURIComponent(text); } catch (_) { break; }
    }
    return text;
  }

  function fileId(value) {
    const text = String(value || '');
    const direct = decode(text).match(/^(file[_-][a-z0-9-]+)(?:#.*)?$/i);
    if (direct) return direct[1];
    try {
      const url = new URL(text, ORIGIN);
      for (const key of ['id', 'file_id']) {
        const id = decode(url.searchParams.get(key)).match(/^(file[_-][a-z0-9-]+)(?:#.*)?$/i);
        if (id) return id[1];
      }
      // Opaque query values (sig, token, filename, etc.) are not asset IDs.
      return decode(url.pathname).match(/(?:^|\/)(file[_-][a-z0-9-]+)(?=[/.#]|$)/i)?.[1] || null;
    } catch (_) { return null; }
  }

  function allowedUrl(value) {
    try {
      const u = new URL(value, ORIGIN);
      return u.protocol === 'https:' && !u.username && !u.password && (
        (u.hostname === 'chatgpt.com' && u.pathname.startsWith('/backend-api/')) ||
        u.hostname === 'oaiusercontent.com' || u.hostname.endsWith('.oaiusercontent.com') ||
        u.hostname === 'openai.com' || u.hostname.endsWith('.openai.com')
      );
    } catch (_) { return false; }
  }

  function isPreview(value) {
    try {
      const u = new URL(value, ORIGIN);
      const variant = /(?:^|[/#])(thumbnail|thumb|preview|low_res)(?:$|[/#])/i;
      // Inspect variant selectors, never opaque signatures or arbitrary filename words.
      if (variant.test(decode(u.pathname)) || variant.test(decode(u.hash))) return true;
      for (const [key, val] of u.searchParams) {
        if (/^(w|h|width|height|resize|quality)$/i.test(key) && val) return true;
        if (/^(id|file_id|variant|encoding|size)$/i.test(key) && variant.test(decode(val))) return true;
      }
    } catch (_) { return true; }
    return false;
  }

  function urlValue(value) {
    return typeof value === 'string' ? value : value?.url || value?.path || '';
  }

  const associationFields = [
    ['conversationId', 'conversation_id'], ['messageId', 'message_id'],
    ['generationId', 'generation_id'], ['transformationId', 'transformation_id'],
    ['assetPointer', 'asset_pointer']
  ];

  function sourceAssociations(item) {
    const records = [];
    const add = source => {
      if (!source || typeof source !== 'object') return;
      // Keep conflicting aliases as separate records; never fabricate a joined
      // conversation/message identity when duplicate API records disagree.
      for (const preferred of [0, 1]) {
        const record = {};
        for (const fields of associationFields) {
          const values = [source[fields[preferred]], source[fields[1 - preferred]]];
          const value = values.find(value => typeof value === 'string' && value.trim());
          if (value !== undefined) record[fields[0]] = value;
        }
        if (Object.keys(record).length && !records.some(old => JSON.stringify(old) === JSON.stringify(record))) {
          records.push(record);
        }
      }
    };
    if (Array.isArray(item.sourceAssociations)) item.sourceAssociations.forEach(add);
    add(item);
    return records;
  }

  function fromItem(item, index = 0, origin = 'api') {
    if (!item || typeof item !== 'object') return null;
    const originals = [item.download_url, item.original_url, item.original,
      item.original_image_url, item.full_size_url, item.full_res_url,
      item.encodings?.original, item.encodings?.source,
      item.asset?.download_url, item.asset?.original_url,
      item.image?.original_url].map(urlValue);
    const resources = [item.url, item.file_url, item.src, item.image_url,
      item.asset?.url, item.asset?.src, item.image?.url, item.image?.src].map(urlValue);
    const previews = [item.thumbnail, item.thumbnail_url, item.encodings?.thumbnail].map(urlValue);
    const urls = [...originals, ...resources, ...previews];
    const id = fileId(item.file_id) || fileId(item.id) || urls.map(fileId).find(Boolean);
    const candidates = [];
    for (const [values, role] of [[originals, 'original'], [resources, 'resource']]) {
      for (const value of values) {
        if (value && allowedUrl(value) && !isPreview(value)) {
          candidates.push({ url: new URL(value, ORIGIN).href, role, origin });
        }
      }
    }
    if (!id && !candidates.length) return null;
    const name = String(item.name || item.filename || item.title || item.prompt ||
      item.asset?.name || `chatgpt-image-${index + 1}`);
    const associations = sourceAssociations(item);
    return { fileId: id, name, candidates, previewWidth: 0, previewHeight: 0,
      ...associations[0], sourceAssociations: associations };
  }

  function itemsFrom(data) {
    if (Array.isArray(data)) return data;
    for (const key of ['items', 'nodes', 'images', 'data']) {
      if (Array.isArray(data?.[key])) return data[key];
    }
    if (data?.data && typeof data.data === 'object') return itemsFrom(data.data);
    return [];
  }

  function merge(entries) {
    const files = new Map();
    for (const entry of entries.filter(Boolean)) {
      const key = entry.fileId || entry.candidates[0]?.url;
      if (!key) continue;
      const old = files.get(key);
      if (!old) {
        const associations = sourceAssociations(entry);
        files.set(key, { ...entry, ...associations[0], candidates: [...entry.candidates],
          sourceAssociations: associations });
      } else {
        for (const association of sourceAssociations(entry)) {
          if (!old.sourceAssociations.some(source => JSON.stringify(source) === JSON.stringify(association))) {
            old.sourceAssociations.push(association);
          }
        }
        // The first real association remains the shorthand; consumers needing
        // provenance must inspect every record, including conflicting sources.
        Object.assign(old, old.sourceAssociations[0]);
        for (const candidate of entry.candidates) {
          if (!old.candidates.some(c => c.url === candidate.url && c.role === candidate.role)) {
            old.candidates.push(candidate);
          }
        }
        old.previewWidth = Math.max(old.previewWidth || 0, entry.previewWidth || 0);
        old.previewHeight = Math.max(old.previewHeight || 0, entry.previewHeight || 0);
      }
    }
    return [...files.values()];
  }

  function createClient({ fetchImpl = globalThis.fetch, measure = measureImage,
    wait = ms => new Promise(resolve => setTimeout(resolve, ms)), maxAttempts = 3,
    onRateLimit = () => {}, onTransfer = null, onRequestTiming = null, now = () => Date.now() } = {}) {
    let tokenPromise;
    let accessToken = null;
    let cooldownUntil = 0;
    async function request(url, options = {}) {
      // All concurrent original tasks share this gate. Already in-flight requests
      // can finish, but new requests wait rather than amplifying a server 429.
      while (cooldownUntil > now()) await wait(cooldownUntil - now());
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const began = now();
        const response = await fetchImpl(url, { ...options, signal: controller.signal });
        if (onRequestTiming && response.ok && /^(image\/|application\/octet-stream)/i.test(response.headers.get('content-type') || '')) {
          onRequestTiming({ ttfbMs: Math.max(1, now() - began) });
        }
        // Keep the timeout active through body consumption, not just response headers.
        let bytes;
        if (onTransfer && response.body?.getReader) {
          const reader = response.body.getReader(), chunks = [];
          let length = 0;
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              chunks.push(value); length += value.byteLength;
              onTransfer(value.byteLength);
            }
          } finally { reader.releaseLock(); }
          bytes = new Uint8Array(length);
          let offset = 0;
          for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        } else {
          bytes = await response.arrayBuffer();
          if (onTransfer) onTransfer(bytes.byteLength);
        }
        const buffered = new Response(bytes.byteLength ? bytes : null, {
          status: response.status, statusText: response.statusText, headers: response.headers
        });
        Object.defineProperty(buffered, 'url', { value: response.url });
        return buffered;
      } catch (error) {
        // CORS and network failures are intentionally indistinguishable to Fetch.
        // Retry a bounded number of times; do not claim retries can fix permanent CORS.
        if (error.name === 'TypeError' || error.name === 'AbortError' || error.name === 'TimeoutError') {
          error.retryable = true;
          error.phase = 'fetch';
        }
        throw error;
      } finally { clearTimeout(timeout); }
    }
    function sessionUnavailable(message, retryable = false, status) {
      return Object.assign(new Error(message), { code: 'session_unavailable', phase: 'auth',
        retryable, ...(Number.isInteger(status) ? { status } : {}) });
    }
    function sessionToken(refresh = false) {
      // Every caller joins an in-flight refresh instead of reusing its stale token.
      if (tokenPromise) return tokenPromise;
      if (accessToken && !refresh) return Promise.resolve(accessToken);
      accessToken = null;
      // Shared lookup errors are sanitized; optional-auth callers retain their
      // original HTTP response, while explicit-auth callers can report the cause.
      tokenPromise = (async () => {
        let response;
        try { response = await request(`${ORIGIN}/api/auth/session`, { credentials: 'include' }); }
        catch (error) {
          throw sessionUnavailable('Session authentication request failed', error?.retryable === true ||
            ['TypeError', 'AbortError', 'TimeoutError'].includes(error?.name));
        }
        if (!response.ok) throw sessionUnavailable(`Session authentication returned HTTP ${response.status}`,
          [408, 425, 429].includes(response.status) || response.status >= 500 && response.status <= 599, response.status);
        let session;
        try { session = await response.json(); }
        catch (_) { throw sessionUnavailable('Session authentication returned invalid JSON'); }
        if (typeof session?.accessToken !== 'string' || !session.accessToken.trim()) {
          throw sessionUnavailable('Session authentication returned no access token');
        }
        accessToken = session.accessToken;
        return accessToken;
      })().finally(() => { tokenPromise = null; });
      return tokenPromise;
    }
    function authResponse(response, bearerSent, refreshed) {
      Object.defineProperty(response, '_gridAuth', { value: Object.freeze({ bearerSent, refreshed }) });
      return response;
    }
    async function apiFetch(path, { requireAuth = false } = {}) {
      const url = new URL(path, ORIGIN);
      if (url.origin !== ORIGIN || !url.pathname.startsWith('/backend-api/')) {
        throw new Error('Invalid backend API destination');
      }
      const attemptedToken = requireAuth ? await sessionToken() : accessToken;
      const options = { credentials: 'include',
        ...(attemptedToken ? { headers: { Authorization: `Bearer ${attemptedToken}` } } : {}) };
      const response = await request(url.href, options);
      if (![401, 403].includes(response.status)) return authResponse(response, Boolean(attemptedToken), false);
      // Session token is never persisted, logged, exported or sent to a CDN.
      let token;
      try { token = await sessionToken(Boolean(attemptedToken && attemptedToken === accessToken)); }
      catch (error) {
        if (requireAuth) throw error;
        return authResponse(response, Boolean(attemptedToken), false);
      }
      return authResponse(await request(url.href, { ...options, headers: { Authorization: `Bearer ${token}` } }), true, true);
    }
    async function readImage(response, candidate) {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (response.url && (!allowedUrl(response.url) || isPreview(response.url))) {
        throw new Error('Download redirected to a preview or unsupported host');
      }
      let blob = await response.blob();
      if (!blob.size) throw new Error('Response is not an image');
      const detectedType = await imageType(blob);
      if (!detectedType) throw new Error('Response is not a supported image');
      // Change only Blob metadata. Attachment endpoints often use octet-stream;
      // the actual original file bytes must remain identical.
      if (blob.type !== detectedType) blob = blob.slice(0, blob.size, detectedType);
      let dimensions, validation = 'browser-decoded', warnings = [];
      try {
        dimensions = await measure(blob);
        if (!dimensions.width || !dimensions.height) throw new Error('Image has no decoded dimensions');
      } catch (error) {
        dimensions = await containerDimensions(blob, detectedType);
        if (!dimensions) {
          const failure = new Error(`Image decode failed and container is incomplete or unsupported: ${error.message}`);
          failure.retryable = true;
          failure.phase = 'validation';
          throw failure;
        }
        validation = 'container-only';
        warnings.push(`Browser decode failed: ${error.message}. Basic container checks passed; original bytes preserved. Inspect this file manually; renderability is unverified.`);
      }
      return { blob, ...dimensions, validation, warnings, source: candidate.origin,
        verification: 'original-endpoint-or-field' };
    }
    async function fetchCandidate(candidate, visited = new Set()) {
      if (!allowedUrl(candidate.url) || isPreview(candidate.url)) throw new Error('Preview URL rejected');
      const u = new URL(candidate.url, ORIGIN);
      if (visited.has(u.href) || visited.size >= 4) throw new Error('Download link cycle or excessive redirects');
      visited.add(u.href);
      const response = u.origin === ORIGIN
        ? await apiFetch(u.href)
        : await request(u.href, { credentials: 'omit' });
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}`);
        error.status = response.status;
        error.phase = 'fetch';
        error.retryable = [408, 429, 500, 502, 503, 504].includes(response.status) ||
          (visited.size > 1 && [401, 403].includes(response.status));
        const retryAfter = response.headers.get('retry-after');
        const delay = retryAfter === null ? 0 : /^\d+(?:\.\d+)?$/.test(retryAfter)
          ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now();
        error.retryAfterMs = Number.isFinite(delay) ? Math.max(0, Math.min(30000, delay)) : 0;
        if (response.status === 429) {
          const delayMs = Math.max(1000, error.retryAfterMs);
          cooldownUntil = Math.max(cooldownUntil, now() + delayMs);
          onRateLimit({ delayMs, until: cooldownUntil });
        }
        throw error;
      }
      if (response.url && (!allowedUrl(response.url) || isPreview(response.url))) {
        throw new Error('Download redirected to a preview or unsupported host');
      }
      if (/^application\/(?:[\w.-]+\+)?json(?:;|$)/i.test(response.headers.get('content-type') || '')) {
        const data = await response.json();
        const url = data.download_url || data.url || data.data?.download_url;
        if (typeof url !== 'string') throw new Error('Missing download URL');
        return fetchCandidate({ ...candidate, url: new URL(url, response.url || u.href).href }, visited);
      }
      return readImage(response, candidate);
    }
    async function resolve(entry, { onRetry = () => {} } = {}) {
      const sources = [];
      if (entry.fileId && /^file[_-][a-z0-9-]+$/i.test(entry.fileId)) {
        sources.push(
          { url: `/backend-api/files/${entry.fileId}/download`, role: 'original', origin: 'file-download-endpoint' },
          { url: `/backend-api/files/download/${entry.fileId}`, role: 'original', origin: 'file-download-endpoint' }
        );
      }
      sources.push(...entry.candidates.filter(candidate => candidate.role === 'original'));
      const errors = [];
      const permanentFailures = new Set();
      const attempts = Math.max(1, Math.min(3, Math.floor(Number(maxAttempts)) || 3));
      let attemptsMade = 0;
      for (let attempt = 1; attempt <= attempts; attempt++) {
        attemptsMade = attempt;
        let transient = false, retryAfterMs = 0;
        for (const source of sources) {
          if (permanentFailures.has(source.url)) continue;
          try {
            // Restart at the descriptor endpoint each round to obtain fresh signed links.
            return { ...await fetchCandidate(source), retrievalAttempts: attempt, retrievalErrors: errors };
          } catch (error) {
            errors.push({ attempt, source: source.origin, phase: error.phase || 'resolve',
              status: error.status || null, message: error.message });
            if (error.retryable) {
              transient = true;
              retryAfterMs = Math.max(retryAfterMs, error.retryAfterMs || 0);
            } else permanentFailures.add(source.url);
          }
        }
        if (!transient || attempt === attempts) break;
        const delayMs = Math.min(30000, Math.max(retryAfterMs, 1000 * 2 ** (attempt - 1) + Math.floor(Math.random() * 300)));
        onRetry({ attempt: attempt + 1, maxAttempts: attempts, delayMs });
        await wait(delayMs);
      }
      const error = new Error(`Original unavailable; no thumbnail saved. ${errors.map(e => `Attempt ${e.attempt}: ${e.source}: ${e.message}`).join('; ') || 'No original download link or resolvable file ID.'}`);
      error.retrievalAttempts = attemptsMade;
      error.details = errors;
      throw error;
    }
    return { apiFetch, resolve };
  }

  async function imageType(blob) {
    const bytes = new Uint8Array(await blob.slice(0, 64).arrayBuffer());
    const starts = values => values.every((value, i) => bytes[i] === value);
    const ascii = (start, end) => String.fromCharCode(...bytes.slice(start, end));
    if (starts([137, 80, 78, 71, 13, 10, 26, 10])) return 'image/png';
    if (starts([255, 216, 255])) return 'image/jpeg';
    if (['GIF87a', 'GIF89a'].includes(ascii(0, 6))) return 'image/gif';
    if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
    if (ascii(0, 2) === 'BM') return 'image/bmp';
    if (ascii(4, 8) === 'ftyp') {
      const size = new DataView(bytes.buffer).getUint32(0);
      for (let i = 8; i + 4 <= Math.min(size, bytes.length); i += 4) {
        if (i !== 12 && ['avif', 'avis'].includes(ascii(i, i + 4))) return 'image/avif';
      }
    }
    return null;
  }

  // Only a fallback when the browser decoder refuses an original. These checks
  // detect obvious truncation, not corrupt compressed pixels or invalid PNG CRCs.
  async function containerDimensions(blob, type) {
    const b = new Uint8Array(await blob.arrayBuffer());
    const v = new DataView(b.buffer);
    const text = (a, z) => String.fromCharCode(...b.slice(a, z));
    if (type === 'image/png') {
      let pos = 8, width = 0, height = 0, imageData = false;
      while (pos + 12 <= b.length) {
        const size = v.getUint32(pos), kind = text(pos + 4, pos + 8);
        if (size > b.length - pos - 12) return null;
        if (pos === 8) {
          if (kind !== 'IHDR' || size !== 13) return null;
          width = v.getUint32(pos + 8); height = v.getUint32(pos + 12);
        } else if (kind === 'IHDR') return null;
        if (kind === 'IDAT' && size > 0) imageData = true;
        pos += size + 12;
        if (kind === 'IEND') return size === 0 && pos === b.length && imageData && width && height ? { width, height } : null;
      }
    } else if (type === 'image/jpeg') {
      if (b.length < 4 || b[b.length - 2] !== 255 || b[b.length - 1] !== 217) return null;
      let pos = 2, dimensions = null;
      const sof = new Set([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207]);
      while (pos + 1 < b.length) {
        if (b[pos++] !== 255) return null;
        while (b[pos] === 255) pos++;
        const marker = b[pos++];
        if (marker === 217) return null;
        if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
        if (pos + 2 > b.length) return null;
        const size = v.getUint16(pos);
        if (size < 2 || pos + size > b.length) return null;
        if (sof.has(marker)) {
          if (size < 8) return null;
          dimensions = { width: v.getUint16(pos + 5), height: v.getUint16(pos + 3) };
        }
        if (marker === 218) return dimensions?.width && dimensions?.height ? dimensions : null;
        pos += size;
      }
    } else if (type === 'image/webp' && b.length >= 20 && v.getUint32(4, true) + 8 === b.length) {
      let pos = 12, dimensions = null, payload = false;
      const u24 = p => b[p] | b[p + 1] << 8 | b[p + 2] << 16;
      while (pos + 8 <= b.length) {
        const kind = text(pos, pos + 4), size = v.getUint32(pos + 4, true), start = pos + 8;
        if (size > b.length - start) return null;
        if (kind === 'VP8X' && size >= 10) dimensions = { width: u24(start + 4) + 1, height: u24(start + 7) + 1 };
        if (kind === 'VP8 ' && size >= 10 && b[start + 3] === 157 && b[start + 4] === 1 && b[start + 5] === 42) {
          payload = true;
          dimensions ||= { width: v.getUint16(start + 6, true) & 16383, height: v.getUint16(start + 8, true) & 16383 };
        }
        if (kind === 'VP8L' && size >= 5 && b[start] === 47) {
          payload = true;
          const bits = v.getUint32(start + 1, true);
          dimensions ||= { width: (bits & 16383) + 1, height: ((bits >>> 14) & 16383) + 1 };
        }
        if (kind === 'ANMF' && size > 16) payload = true;
        pos = start + size + (size & 1);
      }
      if (pos === b.length && payload && dimensions?.width && dimensions?.height) return dimensions;
    }
    return null;
  }

  async function measureImage(blob) {
    const bitmap = await createImageBitmap(blob);
    try { return { width: bitmap.width, height: bitmap.height }; }
    finally { bitmap.close(); }
  }

  async function fingerprint(blob) {
    const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
    return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  }

  function sanitizeSegment(value, fallback = 'image') {
    let clean = String(value || '').normalize('NFKC')
      .replace(/[\p{Cc}\p{Cf}\p{Cs}\uFDD0-\uFDEF]/gu, '')
      .replace(/[\u2028\u2029]/g, ' ')
      .replace(/[\x00-\x1f\x7f\\/:*?"<>|]/g, '_').replace(/^[. ]+|[. ]+$/g, '');
    if (!clean) clean = fallback;
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(clean)) clean = `${fallback}_${clean}`;
    // Filesystems limit encoded bytes, not JavaScript UTF-16 code units.
    let result = '', bytes = 0;
    for (const char of clean) {
      const point = char.codePointAt(0);
      if ((point & 0xffff) >= 0xfffe) continue;
      bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
      if (bytes > 180) break;
      result += char;
    }
    return result.replace(/[. ]+$/g, '') || fallback;
  }

  function filename(name, type, index, numberWidth = 4) {
    const extensions = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp',
      'image/gif': '.gif', 'image/avif': '.avif', 'image/bmp': '.bmp' };
    const ext = extensions[type.toLowerCase().split(';')[0]];
    if (!ext) throw new Error(`Unsupported image format: ${type}`);
    const base = sanitizeSegment(String(name).replace(/\.(png|jpe?g|webp|gif|avif|bmp)$/i, ''));
    return `${String(index + 1).padStart(numberWidth, '0')}-${base}${ext}`;
  }

  const api = { fileId, allowedUrl, isPreview, fromItem, itemsFrom, merge, createClient, fingerprint, filename, sanitizeSegment };
  globalThis.ChatGPTOriginalImages = api;
  if (typeof module !== 'undefined') module.exports = api;
})();
