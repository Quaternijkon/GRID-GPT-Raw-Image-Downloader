/* Gemini Library RPC discovery and exact image/prompt association. */
(() => {
  const ORIGIN = 'https://gemini.google.com';
  const FILTER = [1, 1, 1, 0, 0, 0, 1, 0, 1, 1];
  const CHAT_ID = /^c_[a-f0-9]{16}$/;
  const RESPONSE_ID = /^r_[a-f0-9]{16}$/;
  const MEDIA_ID = /^rc_[a-f0-9]{16}$/;
  const PAGE_SIZE = 30;
  const MAX_PAGES = 500;
  const MASK_64 = (1n << 64n) - 1n;

  function variantHash(value) {
    const bytes = new TextEncoder().encode(value);
    let forward = 0xcbf29ce484222325n, reverse = 0x84222325cbf29ce4n;
    for (const byte of bytes) forward = ((forward ^ BigInt(byte)) * 0x100000001b3n) & MASK_64;
    for (let index = bytes.length - 1; index >= 0; index--)
      reverse = ((reverse ^ BigInt(bytes[index])) * 0x100000001b3n) & MASK_64;
    return forward.toString(16).padStart(16, '0') + reverse.toString(16).padStart(16, '0');
  }

  function supported(pathname) { return pathname === '/library'; }
  function imageUrl(value) {
    if (typeof value !== 'string') return null;
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.hostname !== 'lh3.googleusercontent.com' ||
          url.username || url.password || url.port || !/^\/gg\/[A-Za-z0-9_-]{40,}$/.test(url.pathname) ||
          url.search || url.hash) return null;
      return url.href;
    } catch (_) { return null; }
  }
  function tokenFromDocument(doc = document) {
    for (const script of doc.querySelectorAll('script')) {
      const match = script.textContent?.match(/"SNlM0e":"([A-Za-z0-9_:-]{20,512})"/);
      if (match) return match[1];
    }
    throw new Error('Gemini 页面校验信息不可读取，请刷新 Library 页面重试。');
  }
  function parseRpc(text, rpcId) {
    if (typeof text !== 'string' || text.length > 30_000_000 || !text.startsWith(")]}'"))
      throw new Error(`Gemini ${rpcId} 返回格式异常`);
    for (const line of text.split('\n')) {
      if (!line.startsWith('[[')) continue;
      let envelopes;
      try { envelopes = JSON.parse(line); } catch (_) { continue; }
      const item = envelopes.find(value => value?.[0] === 'wrb.fr' && value[1] === rpcId);
      if (!item) continue;
      if (item[2] === null) throw Object.assign(new Error(`Gemini ${rpcId} 暂时没有返回数据，请稍后重试`),
        { retryable: true });
      if (typeof item[2] !== 'string') continue;
      try { return JSON.parse(item[2]); }
      catch (_) { throw new Error(`Gemini ${rpcId} 数据格式异常`); }
    }
    throw new Error(`Gemini ${rpcId} 缺少预期响应`);
  }
  async function rpc(fetchImpl, rpcId, args, { token, checkActive = () => {}, delay = ms =>
    new Promise(resolve => setTimeout(resolve, ms)), onRetry = () => {} } = {}) {
    const url = new URL('/_/BardChatUi/data/batchexecute', ORIGIN);
    url.searchParams.set('rpcids', rpcId);
    url.searchParams.set('source-path', '/library');
    url.searchParams.set('rt', 'c');
    const body = new URLSearchParams({ 'f.req': JSON.stringify([[[rpcId, JSON.stringify(args), null, 'generic']]]), at: token });
    const maxAttempts = rpcId === 'jGArJ' ? 10 : 6;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      checkActive();
      let response, failure;
      try {
        response = await fetchImpl(url.href, { method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body });
      } catch (error) {
        failure = Object.assign(error, { retryable: true });
      }
      if (response?.ok) {
        try { return parseRpc(await response.text(), rpcId); }
        catch (error) { failure = error; }
      } else if (response) {
        failure = Object.assign(new Error(`Gemini ${rpcId} HTTP ${response.status}`),
          { httpStatus: response.status, retryable: [408, 429, 500, 502, 503, 504].includes(response.status) });
      }
      if (!failure.retryable || attempt === maxAttempts) throw failure;
      const retryHeader = response?.headers?.get?.('retry-after');
      const retryAfter = retryHeader == null ? NaN : Number(retryHeader);
      const waitMs = Number.isFinite(retryAfter) && retryAfter >= 0
        ? Math.min(60000, retryAfter * 1000) : Math.min(20000, 1000 * 2 ** (attempt - 1));
      onRetry({ attempt, maxAttempts, waitMs, status: failure.httpStatus || null });
      await delay(waitMs);
      checkActive();
    }
  }
  function parseEntry(item) {
    if (!Array.isArray(item) || item[2] !== 1) return null;
    if (!Array.isArray(item[0]) || !CHAT_ID.test(item[0][0]) || !RESPONSE_ID.test(item[0][1]) ||
        !MEDIA_ID.test(item[5]) || !Number.isSafeInteger(item[1]?.[0]) ||
        !Number.isSafeInteger(item[1]?.[1])) throw new Error('Gemini 图库中存在无法稳定编号的图片');
    const url = imageUrl(item[4]?.[1]);
    if (!url) throw new Error('Gemini 图库中存在无法识别的图片原地址');
    const time = item[1][0] * 1000 + Math.floor(item[1][1] / 1e6);
    if (!Number.isSafeInteger(time)) throw new Error('Gemini 图库中存在无法稳定编号的图片时间');
    const variant = typeof item[10] === 'string' && item[10].length >= 16 && item[10].length <= 4096
      ? item[10] : `${item[1][0]}:${item[1][1]}`;
    const identityKey = `${item[5]}\n${item[0][0]}\n${item[0][1]}\n${variant}`;
    return { id: item[5], resourceId: item[5], chatId: item[0][0], responseId: item[0][1], url, time,
      identityKey, variantFingerprint: variantHash(identityKey) };
  }
  async function collect(fetchImpl, { token, checkActive = () => {}, onProgress = () => {}, delay } = {}) {
    const auth = token || tokenFromDocument();
    const cursors = new Set(), byIdentity = new Map();
    let cursor = null, pages = 0, total = 0;
    for (;;) {
      checkActive();
      if (++pages > MAX_PAGES) throw new Error(`Gemini 图库超过 ${MAX_PAGES} 页，已停止以免遗漏`);
      const page = await rpc(fetchImpl, 'jGArJ', [FILTER, PAGE_SIZE, cursor], { token: auth, checkActive, delay,
        onRetry: retry => onProgress({ pages: pages - 1, records: total, images: byIdentity.size, retry }) });
      if (!Array.isArray(page) || !Array.isArray(page[0]) ||
          (page[1] != null && typeof page[1] !== 'string')) throw new Error('Gemini 图库分页格式变化');
      total += page[0].length;
      for (const item of page[0]) {
        const entry = parseEntry(item);
        if (entry) {
          const previous = byIdentity.get(entry.identityKey);
          // Gemini refreshes signed /gg/ URLs while paginating. Keep the newest
          // permitted address, but retain the earliest creation time for numbering.
          byIdentity.set(entry.identityKey, previous ? {
            ...entry, time: Math.min(previous.time, entry.time)
          } : entry);
        }
      }
      onProgress({ pages, records: total, images: byIdentity.size });
      if (!page[1]) break;
      if (!page[0].length || cursors.has(page[1])) throw new Error('Gemini 图库分页游标重复');
      cursors.add(page[1]); cursor = page[1];
    }
    const variantsPerResource = new Map();
    for (const entry of byIdentity.values())
      variantsPerResource.set(entry.id, (variantsPerResource.get(entry.id) || 0) + 1);
    const ids = new Set();
    const entries = [...byIdentity.values()].map(({ identityKey, variantFingerprint, ...entry }) => {
      const id = variantsPerResource.get(entry.id) > 1 ? `${entry.id}-${variantFingerprint}` : entry.id;
      if (ids.has(id)) throw new Error('Gemini 图片稳定身份发生哈希冲突');
      ids.add(id);
      return { ...entry, id };
    }).sort((a, b) => a.time - b.time || a.id.localeCompare(b.id))
      .map((entry, index) => ({ ...entry, sequence: index + 1 }));
    return { entries, token: auth, pagination: { complete: true, pages, records: total, images: entries.length } };
  }
  function containsResource(value, resourceId) {
    const pending = [value];
    for (let inspected = 0; pending.length && inspected < 10000; inspected++) {
      const current = pending.pop();
      if (current === resourceId) return true;
      if (Array.isArray(current)) for (const item of current) {
        if (pending.length >= 10000) break;
        pending.push(item);
      }
    }
    return false;
  }
  async function resolvePrompts(fetchImpl, entries, { token, checkActive = () => {}, onProgress = () => {}, delay } = {}) {
    const chats = [...new Set(entries.map(entry => entry.chatId))];
    const targets = new Map();
    for (const entry of entries) {
      if (!targets.has(entry.chatId)) targets.set(entry.chatId, new Map());
      if (!targets.get(entry.chatId).has(entry.responseId)) targets.get(entry.chatId).set(entry.responseId, []);
      targets.get(entry.chatId).get(entry.responseId).push(entry);
    }
    const assistantPrompts = new Map(), requestPrompts = new Map(), failedChats = new Map();
    const matchedCount = () => entries.filter(entry => {
      const resourceId = entry.resourceId || entry.id?.slice(0, 19);
      return assistantPrompts.has(`${entry.chatId}:${entry.responseId}`) ||
        requestPrompts.has(`${entry.chatId}:${entry.responseId}:${resourceId}`);
    }).length;
    const wait = delay || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    const readChats = async (chatIds, round) => {
      for (let index = 0; index < chatIds.length; index++) {
        checkActive();
        const chatId = chatIds[index];
        try {
          let cursor = null;
          const cursors = new Set();
          for (let page = 1; page <= 20; page++) {
            const data = await rpc(fetchImpl, 'hNvQHb', [chatId, 100, cursor, 1, [1], [4], null, 1],
              { token, checkActive, delay, onRetry: retry => onProgress({ phase: 'request-retry', round,
                processed: index, total: chatIds.length, resolved: matchedCount(), retry }) });
            if (!Array.isArray(data?.[0]) || data[1] != null && typeof data[1] !== 'string')
              throw new Error('Gemini 会话消息格式变化');
            for (const turn of data[0]) {
              const prompt = turn?.[2]?.[0]?.[0];
              if (typeof prompt !== 'string' || !prompt.trim()) continue;
              const text = prompt.trim().replace(/\r\n?/g, '\n');
              const assistantId = turn?.[1]?.[1];
              if (RESPONSE_ID.test(assistantId) && targets.get(chatId)?.has(assistantId))
                assistantPrompts.set(`${chatId}:${assistantId}`, text);
              const requestId = turn?.[0]?.[1];
              if (!RESPONSE_ID.test(requestId)) continue;
              for (const entry of targets.get(chatId)?.get(requestId) || []) {
                const resourceId = entry.resourceId || entry.id?.slice(0, 19);
                if (MEDIA_ID.test(resourceId) &&
                    (turn?.[3]?.[3] === resourceId || containsResource(turn?.[3], resourceId)))
                  requestPrompts.set(`${chatId}:${requestId}:${resourceId}`, text);
              }
            }
            if (!data[1]) break;
            if (!data[0].length || cursors.has(data[1]) || page === 20)
              throw new Error('Gemini 会话分页未完整结束');
            cursors.add(data[1]); cursor = data[1];
          }
          failedChats.delete(chatId);
        } catch (error) { failedChats.set(chatId, error.message); }
        onProgress({ phase: round ? 'recovery' : 'collecting', round,
          processed: index + 1, total: chatIds.length, resolved: matchedCount() });
      }
    };
    const assign = () => {
      let unresolved = 0;
      for (const entry of entries) {
        const resourceId = entry.resourceId || entry.id?.slice(0, 19);
        const assistant = assistantPrompts.get(`${entry.chatId}:${entry.responseId}`);
        const request = requestPrompts.get(`${entry.chatId}:${entry.responseId}:${resourceId}`);
        entry.prompt = assistant || request || null;
        entry.promptSource = assistant ? 'conversation.assistant-response' :
          request ? 'conversation.request-response-with-exact-media' : null;
        if (entry.prompt) delete entry.promptError;
        else {
          entry.promptError = { code: failedChats.has(entry.chatId) ? 'conversation_unavailable' : 'target_not_found',
            message: failedChats.get(entry.chatId) || 'No exact prompt and media association was available' };
          unresolved++;
        }
      }
      return unresolved;
    };
    await readChats(chats, 0);
    const initialUnresolved = assign();
    let unresolved = initialUnresolved, recoveryRounds = 0;
    for (let round = 1; round <= 2 && unresolved; round++) {
      checkActive();
      const pendingChats = [...new Set(entries.filter(entry => !entry.prompt).map(entry => entry.chatId))];
      const waitMs = round === 1 ? 2000 : 5000;
      onProgress({ phase: 'recovery-wait', round, processed: 0, total: pendingChats.length,
        resolved: entries.length - unresolved, unresolved, waitMs });
      await wait(waitMs);
      await readChats(pendingChats, round);
      unresolved = assign();
      recoveryRounds = round;
    }
    return { chats: chats.length, resolved: entries.length - unresolved, unresolved,
      initialUnresolved, recovered: initialUnresolved - unresolved, recoveryRounds,
      failures: [...failedChats].map(([chatId, error]) => ({ chatId, error })) };
  }
  const api = { ORIGIN, FILTER, supported, imageUrl, tokenFromDocument, parseRpc, rpc, parseEntry, collect, resolvePrompts };
  globalThis.GRIDGeminiMedia = api;
  if (typeof module !== 'undefined') module.exports = api;
})();
