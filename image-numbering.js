/* Stateless numbering: a complete authoritative list, never a local history. */
(() => {
  const RULE = 'creation-time-file-id-v1';
  const WIDTH = 6;
  const MAX_SEQUENCE = 999999;
  const MAX_DATE_NS = 8640000000000000000000n;

  function creationTime(value) {
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    const text = String(value).trim();
    const numeric = text.match(/^(\d+)(?:\.(\d{1,9}))?$/);
    if (numeric) {
      const whole = BigInt(numeric[1]);
      const scale = whole >= 100000000000n ? 6 : 9; // Unix milliseconds or seconds.
      const fraction = numeric[2] || '';
      if (/[^0]/.test(fraction.slice(scale))) return null;
      const ns = whole * 10n ** BigInt(scale) + BigInt(fraction.padEnd(scale, '0').slice(0, scale));
      return ns > 0n && ns <= MAX_DATE_NS ? ns : null;
    }
    // Require an explicit timezone. Local-time parsing would change across machines.
    const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?([Zz]|[+-]\d{2}:?\d{2})$/);
    if (!iso) return null;
    const [, year, month, day, hour, minute, second, fraction = '', zone] = iso;
    if (+month < 1 || +month > 12 || +day < 1 ||
      +day > new Date(Date.UTC(+year, +month, 0)).getUTCDate() || +hour > 23 || +minute > 59 || +second > 59) return null;
    const offset = zone.toUpperCase() === 'Z' ? 'Z' : zone.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
    const ms = Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}${offset}`);
    if (!Number.isFinite(ms)) return null;
    const ns = BigInt(ms) * 1000000n + BigInt(fraction.padEnd(9, '0'));
    return ns > 0n && ns <= MAX_DATE_NS ? ns : null;
  }

  function parseBoundary(value) {
    const validType = typeof value === 'number' || typeof value === 'string';
    const number = !validType || (typeof value === 'string' && !/^\d+$/.test(value.trim())) ? NaN : Number(value);
    if (!Number.isSafeInteger(number) || number < 0 || number > MAX_SEQUENCE) {
      throw new Error(`Enter a whole download boundary from 0 to ${MAX_SEQUENCE}`);
    }
    return number;
  }

  function failure(message, issues = []) {
    const error = new Error(message);
    error.numberingIssues = issues;
    return error;
  }

  function plan(list, originals, { after = 0 } = {}) {
    after = parseBoundary(after);
    if (!list?._pagination?.complete) {
      const detail = list?._pagination?.errors?.[0]?.message || list?.error || 'Image list is incomplete';
      throw failure(`Cannot assign stable numbers: ${detail}`);
    }
    const rows = originals.itemsFrom(list);
    if (!Array.isArray(list?.items) && !Array.isArray(list?.nodes) && !Array.isArray(list?.images) && !Array.isArray(list?.data)) {
      throw failure('Cannot assign stable numbers: missing authoritative image records');
    }
    const byId = new Map(), issues = [];
    for (const [index, row] of rows.entries()) {
      const entry = originals.fromItem(row, index, 'authoritative-api');
      if (!entry?.fileId) {
        issues.push({ row: index, reason: 'Missing stable original file ID' });
        continue;
      }
      const fields = ['created_at', 'create_time', 'created_time'];
      const field = fields.find(key => row[key] !== null && row[key] !== undefined);
      const raw = field ? row[field] : null;
      const time = creationTime(raw);
      if (time === null) {
        issues.push({ fileId: entry.fileId, reason: 'Missing or invalid creation time (timezone required for ISO dates)' });
        continue;
      }
      const name = String(row.name || row.filename || row.title || row.prompt || row.asset?.name || entry.fileId);
      const old = byId.get(entry.fileId);
      if (old) {
        if (old.time !== time) issues.push({ fileId: entry.fileId, reason: 'Conflicting creation times for one file ID' });
        old.entry = originals.merge([old.entry, entry])[0];
        // Do not let overlapping-page order choose different title variants.
        if (name < old.name) { old.name = name; old.raw = raw; old.field = field; }
      } else byId.set(entry.fileId, { entry, name, time, raw, field });
    }
    if (issues.length) throw failure(`Cannot assign stable numbers: ${issues.length} record(s) lack reliable identity/time data. See the exported report.`, issues);
    const sorted = [...byId.values()].sort((a, b) => a.time < b.time ? -1 : a.time > b.time ? 1 :
      a.entry.fileId < b.entry.fileId ? -1 : a.entry.fileId > b.entry.fileId ? 1 : 0);
    if (sorted.length > MAX_SEQUENCE) throw failure(`This numbering version supports at most ${MAX_SEQUENCE} images`);
    if (after > sorted.length) throw failure(`Boundary ${after} exceeds the current ${sorted.length} images. Check the account, view and number.`);
    const all = sorted.map((row, index) => ({ ...row.entry, name: row.name,
      sequence: index + 1, createdAt: row.raw, creationTimeField: row.field, creationTimeNs: row.time.toString() }));
    const describe = entry => entry ? {
      sequence: entry.sequence, fileId: entry.fileId, name: entry.name,
      createdAt: entry.createdAt, creationTimeNs: entry.creationTimeNs
    } : null;
    return { all, selected: all.slice(after), summary: {
      rule: RULE, prefixWidth: WIDTH, afterSequence: after, total: all.length,
      selected: all.length - after, skipped: after,
      boundary: describe(all[after - 1]), firstSelected: describe(all[after]),
      lastSelected: after < all.length ? describe(all[all.length - 1]) : null
    } };
  }

  const api = { RULE, WIDTH, MAX_SEQUENCE, creationTime, parseBoundary, plan };
  globalThis.ChatGPTImageNumbering = api;
  if (typeof module !== 'undefined') module.exports = api;
})();
