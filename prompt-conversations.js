/* Authenticated conversation reads, isolated from original-image concurrency. */
(() => {
  const MAX_ATTEMPTS = 3, CONCURRENCY = 1, REQUEST_GAP_MS = 10000;
  const RATE_LIMIT_EXTRA_WAIT_MS = 10000, MAX_DELAY_MS = 10000;
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const transient = status => [408, 425, 429].includes(status) || status >= 500 && status <= 599;
  function failure(code, message, extra = {}) { return Object.assign(new Error(message), { code, ...extra }); }
  function safeDiagnostic(value) {
    if (!value || typeof value !== 'object') return null;
    const result = {};
    for (const key of ['mappingNodes', 'exactPointerParts', 'exactPointerInOutputRole',
      'attachmentCount', 'imageParts', 'branchNodes', 'userTextMessages',
      'referenceInputs', 'outputMessages', 'candidateCount', 'resolvedCandidates', 'distinctPromptCount']) {
      if (Number.isSafeInteger(value[key]) && value[key] >= 0) result[key] = value[key];
    }
    if (typeof value.galleryMessagePresent === 'boolean') result.galleryMessagePresent = value.galleryMessagePresent;
    if (['attachments', 'image_attachments'].includes(value.attachmentField)) result.attachmentField = value.attachmentField;
    if (['text', 'image', 'application', 'audio', 'video', 'unknown'].includes(value.attachmentMimeClass)) {
      result.attachmentMimeClass = value.attachmentMimeClass;
    }
    for (const key of ['attachmentKeys', 'partTypes', 'contentKeys', 'candidateErrorCodes']) {
      if (Array.isArray(value[key])) result[key] = value[key]
        .filter(item => typeof item === 'string' && /^[a-z0-9_:-]{1,40}$/i.test(item)).slice(0, 20);
    }
    if (['user', 'assistant', 'tool'].includes(value.role)) result.role = value.role;
    if (typeof value.contentType === 'string' && /^[a-z0-9_:-]{1,60}$/i.test(value.contentType)) {
      result.contentType = value.contentType;
    }
    return Object.keys(result).length ? result : null;
  }
  function retryAfter(response, now) {
    const value = response.headers?.get?.('Retry-After');
    if (!value) return 0;
    const seconds = Number(value);
    const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now();
    return Number.isFinite(ms) ? Math.max(0, ms) : 0;
  }
  function conversationId(entry) {
    const ids = new Set();
    for (const source of [entry, ...(entry.sourceAssociations || [])]) {
      for (const key of ['conversationId', 'conversation_id']) {
        if (typeof source?.[key] === 'string' && source[key].trim()) ids.add(source[key]);
      }
    }
    if (ids.size > 1) throw failure('conflicting_conversation_id', 'Image has conflicting conversation identities');
    if (!ids.size) throw failure('missing_conversation_id', 'Image has no conversation identity');
    return [...ids][0];
  }

  function summarizeErrors(errors) {
    const groups = new Map();
    for (const error of errors) {
      const context = { code: error.code };
      for (const key of ['phase', 'httpStatus', 'bearerSent', 'authRetried']) {
        if (error[key] !== undefined) context[key] = error[key];
      }
      const key = JSON.stringify(context);
      if (!groups.has(key)) groups.set(key, { ...context, affectedImages: 0, conversations: new Set() });
      const group = groups.get(key);
      group.affectedImages++;
      if (error.conversationId) group.conversations.add(error.conversationId);
    }
    return [...groups.values()].map(({ conversations, ...group }) => ({
      ...group, affectedConversations: conversations.size
    })).sort((a, b) => b.affectedImages - a.affectedImages ||
      (JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0));
  }

  async function collect(entries, { client, resolver, onProgress = () => {}, checkActive = () => {}, sleep = pause, random = Math.random, now = Date.now } = {}) {
    if (!Array.isArray(entries) || typeof client?.apiFetch !== 'function' ||
        typeof resolver?.resolveConversation !== 'function') {
      throw new Error('Conversation collection requires entries, an authenticated client and resolver');
    }
    const buckets = new Map(), byId = new Map(), errors = [];
    let processedConversations = 0, resolvedImages = 0;
    let cancelled = false, cancellation;
    let nextRequestAt = 0, cooldownUntil = 0, retryInMs = 0;
    const requestGapMs = REQUEST_GAP_MS;
    let targetConcurrency = CONCURRENCY, activeRequests = 0, peakRequests = 0;
    let requestCount = 0, rateLimitCount = 0, rateLimitEpisodes = 0;
    let lastServerRetryAfterMs = null, lastFallbackCooldownMs = 0, cooldownSource = null;
    let lastWaitProgressAt = -Infinity;
    function active() {
      if (cancelled) throw cancellation;
      try { checkActive(); } catch (error) {
        cancelled = true;
        cancellation = error;
        throw error;
      }
    }
    active();
    const identities = new Set();
    for (const entry of entries) {
      if (!entry || typeof entry.fileId !== 'string' || !entry.fileId || identities.has(entry.fileId)) throw new Error('Conversation collection requires unique image file IDs');
      identities.add(entry.fileId);
    }
    function unresolved(entry, error, id = null, record = null) {
      // Export only diagnostic fields, never arbitrary thrown objects or response bodies.
      const code = typeof error?.code === 'string' ? error.code : 'resolver_error';
      const message = typeof error?.message === 'string' ? error.message : 'Image prompt could not be resolved';
      const detail = { fileId: entry.fileId, conversationId: id, code, message,
        ...(Number.isInteger(error?.status) ? { httpStatus: error.status } : {}) };
      const diagnostic = safeDiagnostic(error?.diagnostic);
      if (diagnostic) detail.diagnostic = diagnostic;
      if (['auth', 'conversation'].includes(error?.phase)) detail.phase = error.phase;
      if (Number.isInteger(error?.attemptCount)) detail.attemptCount = error.attemptCount;
      for (const key of ['bearerSent', 'authRetried']) {
        if (typeof error?.[key] === 'boolean') detail[key] = error[key];
      }
      errors.push(detail);
      byId.set(entry.fileId, { ...record, ...detail, error: { code, message }, status: 'unresolved' });
    }
    for (const entry of entries) {
      try {
        const id = conversationId(entry);
        if (!buckets.has(id)) buckets.set(id, []);
        buckets.get(id).push(entry);
      } catch (error) { unresolved(entry, error); }
    }
    const jobs = [...buckets.entries()], conversationCount = jobs.length, totalImages = entries.length;
    function progress() {
      // A detached counter snapshot; UI observers cannot alter collection state.
      try { onProgress({ conversationCount, processedConversations, resolvedImages, totalImages,
        requestCount, rateLimitCount, rateLimitEpisodes, retryInMs,
        requestGapMs, targetConcurrency, activeRequests, peakRequests,
        lastServerRetryAfterMs, lastFallbackCooldownMs, cooldownSource,
        errorCount: errors.length, errors: errors.map(error => ({ ...error })),
        errorSummary: summarizeErrors(errors) }); } catch (_) { /* UI is advisory. */ }
    }
    async function waitUntil(deadline) {
      while (deadline > now()) {
        active();
        retryInMs = cooldownUntil > now() ? cooldownUntil - now() : 0;
        if (retryInMs && now() - lastWaitProgressAt >= 5000) {
          lastWaitProgressAt = now();
          progress();
        }
        await sleep(Math.min(1000, deadline - now()));
      }
      active();
      if (retryInMs) { retryInMs = 0; progress(); }
    }
    async function admitRequest() {
      for (;;) {
        active();
        const delay = Math.max(nextRequestAt, cooldownUntil) - now();
        if (activeRequests < targetConcurrency && delay <= 0) {
          activeRequests++;
          peakRequests = Math.max(peakRequests, activeRequests);
          nextRequestAt = now() + requestGapMs;
          return;
        }
        if (delay > 0) {
          retryInMs = cooldownUntil > now() ? cooldownUntil - now() : 0;
          if (retryInMs && now() - lastWaitProgressAt >= 5000) {
            lastWaitProgressAt = now();
            progress();
          }
        }
        await sleep(Math.min(1000, Math.max(1, delay)));
      }
    }
    async function read(id) {
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        await admitRequest();
        const context = { attemptCount: attempt };
        try {
          let response;
          try {
            // Use the observed singular mapping endpoint without the unsupported
            // full-conversation query (which can return 403). Authenticate before
            // the first read: cookie-only requests can receive a masked 404.
            requestCount++;
            response = await client.apiFetch(`/backend-api/conversation/${encodeURIComponent(id)}`, { requireAuth: true });
          } catch (error) {
            if (error?.code === 'session_unavailable' && error.phase === 'auth') {
              throw failure('session_unavailable', 'Session authentication is unavailable; conversation could not be read', {
                phase: 'auth', retryable: error.retryable === true,
                ...(Number.isInteger(error.status) ? { status: error.status } : {})
              });
            }
            throw failure('fetch_error', 'Conversation request failed', {
              retryable: error?.retryable === true || ['TypeError', 'AbortError', 'TimeoutError'].includes(error?.name)
            });
          } finally {
            activeRequests--;
            nextRequestAt = Math.max(nextRequestAt, now() + requestGapMs);
          }
          active();
          if (typeof response?._gridAuth?.bearerSent === 'boolean') context.bearerSent = response._gridAuth.bearerSent;
          if (typeof response?._gridAuth?.refreshed === 'boolean') context.authRetried = response._gridAuth.refreshed;
          if (!response || typeof response.ok !== 'boolean') throw failure('response_shape', 'Conversation request returned an invalid response');
          if (!response.ok) throw failure('http_error', `Conversation request returned HTTP ${response.status}`, { status: response.status, retryable: transient(response.status), retryAfterMs: retryAfter(response, now) });
          let data;
          try { data = await response.json(); } catch (_) { throw failure('json_error', 'Conversation response is not valid JSON'); }
          active();
          if (!data || typeof data !== 'object' || !data.mapping || typeof data.mapping !== 'object' || Array.isArray(data.mapping)) throw failure('conversation_shape', 'Conversation response lacks a supported message mapping');
          // Preserve the singular endpoint's mapping and hints unchanged. The
          // resolver checks each target's actual ancestry; unrelated broken
          // siblings or absent pagination hints do not invalidate that branch.
          // Never turn paginated message arrays into invented parent chains.
          return data;
        } catch (error) {
          active();
          Object.assign(error, context, { phase: error.phase || 'conversation' });
          const inCooldown = cooldownUntil > now();
          if (error.status !== 429 && error.retryable && error.retryAfterMs > 0) {
            cooldownUntil = Math.max(cooldownUntil, now() + error.retryAfterMs);
          }
          if (error.status === 429) {
            rateLimitCount++;
            if (!inCooldown || rateLimitEpisodes === 0) rateLimitEpisodes++;
            targetConcurrency = 1;
            lastServerRetryAfterMs = error.retryAfterMs || null;
            lastFallbackCooldownMs = REQUEST_GAP_MS + RATE_LIMIT_EXTRA_WAIT_MS;
            cooldownSource = (error.retryAfterMs || 0) > lastFallbackCooldownMs ? 'server' : 'fallback';
            const delay = Math.max(error.retryAfterMs || 0, lastFallbackCooldownMs);
            cooldownUntil = Math.max(cooldownUntil, now() + delay);
            nextRequestAt = Math.max(nextRequestAt, now() + requestGapMs);
            // Simultaneous in-flight 429s are one service-limit episode.
            // Keep the same conversation pending until the service accepts it.
            // 429 does not consume the finite budget for unrelated network errors.
            await waitUntil(cooldownUntil);
            attempt--;
            continue;
          }
          if (!error.retryable || attempt === MAX_ATTEMPTS) throw error;
          const jitter = Math.max(0, Math.min(1, Number(random()) || 0));
          const delay = Math.max(error.retryAfterMs || 0, Math.min(MAX_DELAY_MS, 500 * 2 ** (attempt - 1) + jitter * 250));
          await waitUntil(now() + delay);
        }
      }
    }
    let cursor = 0;
    async function worker() {
      while (cursor < jobs.length) {
        active();
        const [id, associated] = jobs[cursor++];
        try {
          const conversation = await read(id);
          active();
          const result = await resolver.resolveConversation(conversation, associated);
          active();
          const records = Array.isArray(result) ? result : result?.records;
          if (!Array.isArray(records)) throw failure('resolver_shape', 'Prompt resolver returned no record array');
          const expected = new Set(associated.map(entry => entry.fileId)), found = new Map();
          for (const record of records) {
            if (!record || !expected.has(record.fileId) || found.has(record.fileId)) throw failure('resolver_identity', 'Prompt resolver returned duplicate or unexpected image identities');
            if (record.conversationId !== undefined && record.conversationId !== id) throw failure('resolver_conversation_identity', 'Prompt resolver returned a conflicting conversation identity');
            found.set(record.fileId, record);
          }
          for (const entry of associated) {
            const record = found.get(entry.fileId);
            if (record?.status === 'resolved' && typeof record.cumulativePrompt === 'string' && record.cumulativePrompt.trim()) {
              byId.set(entry.fileId, { ...record, conversationId: id });
              resolvedImages++;
            } else {
              unresolved(entry, record?.error || failure(record?.code || 'prompt_unresolved', 'Image prompt could not be resolved'), id, record);
            }
          }
        } catch (error) {
          active();
          // Roll back any partially accepted records before failing this bucket.
          // A late invalid resolver record must not inflate resolved progress.
          const failedIds = new Set(associated.map(entry => entry.fileId));
          for (const entry of associated) {
            if (byId.get(entry.fileId)?.status === 'resolved') resolvedImages--;
            byId.delete(entry.fileId);
          }
          for (let index = errors.length - 1; index >= 0; index--) {
            if (failedIds.has(errors[index].fileId)) errors.splice(index, 1);
          }
          for (const entry of associated) unresolved(entry, error, id);
        } finally {
          if (!cancelled) { processedConversations++; progress(); }
        }
      }
    }
    progress();
    // Drain existing requests before rejecting, so no work from this run can
    // outlive its caller's cleanup. A rejected worker also stops new admissions.
    const outcomes = await Promise.allSettled(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, async () => {
      try { await worker(); } catch (error) {
        if (!cancelled) { cancelled = true; cancellation = error; }
        throw error;
      }
    }));
    active();
    const rejected = outcomes.find(outcome => outcome.status === 'rejected');
    if (rejected) throw rejected.reason;
    progress();
    return { records: entries.map(entry => byId.get(entry.fileId)), errors, errorSummary: summarizeErrors(errors),
      requestCount, rateLimitCount, rateLimitEpisodes, deferredConversations: 0, stopped: false,
      requestGapMs, targetConcurrency, peakRequests, cooldownUntil,
      lastServerRetryAfterMs, lastFallbackCooldownMs, cooldownSource,
      conversationCount, processedConversations, resolvedImages, totalImages,
      complete: errors.length === 0 && resolvedImages === totalImages };
  }
  const api = { collect };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof globalThis !== 'undefined') globalThis.ChatGPTPromptConversations = api;
})();
