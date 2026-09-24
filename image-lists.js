/* Paginate ChatGPT image lists without treating page size as an export limit. */
(() => {
  const ORIGIN = 'https://chatgpt.com';
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  function pageItems(data) {
    if (Array.isArray(data)) return data;
    for (const key of ['items', 'nodes', 'images', 'data']) {
      if (Array.isArray(data?.[key])) return data[key];
    }
    if (data?.data && typeof data.data === 'object') return pageItems(data.data);
    throw new Error('Image list response has no recognized items array');
  }

  function itemKey(item) {
    if (!item || typeof item !== 'object') return JSON.stringify(item);
    const id = item.file_id || item.id || item.asset_pointer;
    return id ? `id:${id}` : `record:${JSON.stringify(item)}`;
  }

  function field(data, names) {
    const containers = [data, data?.pagination, data?.data, data?.data?.pagination];
    for (const object of containers) {
      if (!object || typeof object !== 'object') continue;
      for (const name of names) {
        if (Object.hasOwn(object, name)) return { present: true, value: object[name] };
      }
    }
    return { present: false };
  }

  async function collect(fetchPage, path, {
    mode = 'cursor', onProgress = () => {}, checkActive = () => {},
    wait = sleep, pageDelayMs = 200, maxPages = 10000, maxRetries = 3, cursorParam
  } = {}) {
    const nextUrl = new URL(path, ORIGIN);
    if (nextUrl.origin !== ORIGIN || !nextUrl.pathname.startsWith('/backend-api/')) {
      throw new Error('Invalid image list endpoint');
    }
    // Native recent-image queryFn sends {limit, after: pageParam}, while its
    // getNextPageParam reads response.cursor. Response and query names differ.
    const continuationParameter = cursorParam ||
      (nextUrl.pathname === '/backend-api/my/recent/image_gen' ? 'after' : 'cursor');
    const stats = { pages: 0, received: 0, unique: 0, retries: 0, continuationParameter,
      complete: false, stopReason: null, errors: [] };
    const items = new Map();
    const visited = new Set();
    let lastData = {};
    let offset = Number(nextUrl.searchParams.get('offset') || 0);
    let emptyPages = 0;

    function stop(reason, message) {
      stats.stopReason = reason;
      if (message) stats.errors.push({ page: stats.pages + 1, message });
    }
    async function getPage() {
      for (let attempt = 0; ; attempt++) {
        checkActive();
        let response, failure;
        try { response = await fetchPage(nextUrl.href); }
        catch (error) { failure = error; }
        checkActive();
        if (response?.ok) return response.json();
        const transient = !response || [408, 429, 500, 502, 503, 504].includes(response.status);
        if (!transient || attempt >= maxRetries) {
          throw new Error(response ? `HTTP ${response.status} while reading image list` : failure?.message || 'Image list request failed');
        }
        const retryAfter = response?.headers?.get('retry-after');
        let delay = 750 * 2 ** attempt;
        if (retryAfter) {
          const seconds = Number(retryAfter);
          const requested = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
          if (Number.isFinite(requested)) delay = Math.max(delay, requested);
        }
        stats.retries++;
        onProgress({ ...stats, retrying: true });
        await wait(Math.min(30000, Math.max(0, delay)));
      }
    }

    while (stats.pages < maxPages) {
      checkActive();
      if (visited.has(nextUrl.href)) { stop('repeated_cursor', 'Pagination repeated a cursor/offset; remaining images may be missing'); break; }
      visited.add(nextUrl.href);
      let data, batch;
      try { data = await getPage(); batch = pageItems(data); }
      catch (error) {
        checkActive(); // Navigation must abort, not look like a recoverable API error.
        stop('request_failed', error.message);
        break;
      }
      checkActive();
      lastData = data;
      stats.pages++;
      stats.received += batch.length;
      const previousCount = items.size;
      for (const item of batch) {
        const key = itemKey(item);
        // Refresh overlapping records (e.g. fresh signed links) without downloading twice.
        items.set(key, item);
      }
      stats.unique = items.size;
      emptyPages = batch.length ? 0 : emptyPages + 1;
      onProgress({ ...stats });

      const cursor = field(data, ['next_cursor', 'nextCursor', 'cursor']);
      const hasMore = field(data, ['has_more', 'hasMore', 'has_next']);
      const total = field(data, ['total', 'total_count']);
      const nextOffset = field(data, ['next_offset', 'nextOffset']);
      const totalCount = (typeof total.value === 'number' || (typeof total.value === 'string' && /^\d+$/.test(total.value)))
        ? Number(total.value) : NaN;
      if (hasMore.value === false || (!cursor.present && Number.isFinite(totalCount) && items.size >= totalCount)) {
        if (Number.isFinite(totalCount) && items.size < totalCount) {
          stop('count_mismatch', 'Server ended pagination before its advertised total was collected'); break;
        }
        stats.complete = true; stop('exhausted'); break;
      }
      if (cursor.present) {
        if (cursor.value === null || cursor.value === '') {
          if (hasMore.value === true) stop('missing_cursor', 'Server reports more images but supplied no next cursor');
          else if (Number.isFinite(totalCount) && items.size < totalCount) stop('count_mismatch', 'Server ended pagination before its advertised total was collected');
          else { stats.complete = true; stop('exhausted'); }
          break;
        }
        if (typeof cursor.value !== 'string') { stop('invalid_cursor', 'Server supplied an invalid image cursor'); break; }
        nextUrl.searchParams.set(continuationParameter, cursor.value);
        if (continuationParameter !== 'cursor') nextUrl.searchParams.delete('cursor');
        nextUrl.searchParams.delete('offset');
      } else if (mode === 'offset') {
        if (!batch.length) {
          if (hasMore.value === true) stop('empty_page', 'Empty image page despite has_more=true');
          else { stats.complete = true; stop('exhausted'); }
          break;
        }
        const value = nextOffset.present ? Number(nextOffset.value) : offset + batch.length;
        if (!Number.isInteger(value) || value <= offset) { stop('invalid_offset', 'Image list offset did not advance'); break; }
        offset = value;
        nextUrl.searchParams.set('offset', String(offset));
      } else if (!batch.length && hasMore.value !== true) {
        stats.complete = true; stop('exhausted'); break;
      } else {
        stop('missing_cursor', 'Image page has no continuation cursor; collection may be incomplete'); break;
      }
      if (batch.length && items.size === previousCount) {
        stop('repeated_page', 'Image list returned no new records; collection may be incomplete'); break;
      }
      if (emptyPages >= 2) { stop('empty_pages', 'Consecutive empty image pages with continuation cursors'); break; }
      await wait(pageDelayMs);
    }
    if (!stats.stopReason) stop('page_limit', 'Pagination safety limit reached; collection is incomplete');
    onProgress({ ...stats });
    return { ...(Array.isArray(lastData) ? {} : lastData), items: [...items.values()], _pagination: stats };
  }

  // Viewport steps retain intermediate virtualized rows. Only settle at the bottom.
  // This supplements partial APIs; a stable DOM is not proof of a complete library.
  async function collectDom({ snapshot, scroll, checkActive = () => {}, onProgress = () => {},
    wait = sleep, settlePasses = 8, maxPasses = 2000, intervalMs = 500,
    emptyPasses = 6, maxDurationMs = 30000, now = () => Date.now() }) {
    const entries = new Map();
    const started = now();
    let lastExtent = null, lastPosition, stable = 0, stalled = 0;
    for (let passes = 1; passes <= maxPasses; passes++) {
      checkActive();
      let added = 0;
      for (const entry of snapshot()) {
        const key = entry.fileId || entry.candidates?.[0]?.url;
        if (!key) continue;
        if (!entries.has(key)) added++;
        entries.set(key, entry);
      }
      const { atBottom, extent, position } = scroll();
      stable = !added && atBottom && extent === lastExtent ? stable + 1 : 0;
      stalled = !added && position !== undefined && position === lastPosition ? stalled + 1 : 0;
      lastExtent = extent;
      lastPosition = position;
      const elapsedMs = now() - started;
      onProgress({ passes, images: entries.size, stable, elapsedMs });
      const stopReason = !entries.size && passes >= emptyPasses ? 'no_image_candidates' :
        stable >= settlePasses ? 'dom_stable_best_effort' :
        stalled >= settlePasses ? 'dom_stalled' :
        elapsedMs >= maxDurationMs ? 'time_limit' :
        passes === maxPasses ? 'scroll_limit' : null;
      if (stopReason) {
        return { entries: [...entries.values()], passes, elapsedMs, exhausted: false, stopReason };
      }
      await wait(intervalMs);
    }
  }

  const api = { collect, collectDom };
  globalThis.ChatGPTImageLists = api;
  if (typeof module !== 'undefined') module.exports = api;
})();
