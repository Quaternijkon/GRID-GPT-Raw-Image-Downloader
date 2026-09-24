/* A small response-byte meter and theme-isolated export dashboard. */
(() => {
  function duration(ms) {
    if (!Number.isFinite(ms)) return '—';
    const seconds = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(seconds / 3600), m = Math.floor(seconds / 60) % 60, s = seconds % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  function size(bytes) {
    if (!Number.isFinite(bytes)) return '—';
    return bytes >= 1073741824 ? `${(bytes / 1073741824).toFixed(2)} GiB` : `${(bytes / 1048576).toFixed(1)} MiB`;
  }
  function createMeter({ now = () => Date.now() } = {}) {
    const started = now(), buckets = new Map();
    let bytes = 0, completed = 0, stopped = null;
    function add(byteDelta, countDelta) {
      const time = now(), key = Math.floor(time / 500) * 500;
      const bucket = buckets.get(key) || { bytes: 0, count: 0 };
      bucket.bytes += byteDelta; bucket.count += countDelta;
      buckets.set(key, bucket); bytes += byteDelta; completed += countDelta;
      for (const k of buckets.keys()) if (k < time - 10000) buckets.delete(k);
    }
    return {
      transfer: value => add(Math.max(0, Number(value) || 0), 0),
      complete: value => add(0, Math.max(0, Number(value) || 0)),
      stop: () => { stopped = now(); },
      snapshot(total = 0) {
        const time = stopped ?? now(), elapsedMs = Math.max(0, time - started);
        let recentBytes = 0, recentCount = 0;
        for (const [key, bucket] of buckets) {
          if (key >= time - 10000) { recentBytes += bucket.bytes; recentCount += bucket.count; }
        }
        const span = Math.max(0.5, Math.min(10000, elapsedMs) / 1000);
        const remaining = Math.max(0, total - completed);
        return { bytes, completed, elapsedMs, speed: recentBytes / span,
          averageSpeed: bytes / Math.max(1, elapsedMs / 1000),
          etaMs: remaining === 0 ? 0 : completed >= 3 && recentCount > 0 ? remaining / (recentCount / span) * 1000 : null };
      }
    };
  }

  function createPanel({ theme = () => 'dark', onClose = () => {} } = {}) {
    const host = document.createElement('div');
    host.style.cssText = 'all:initial;position:fixed;right:20px;bottom:20px;z-index:2147483646;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        :host { --bg:#fff;--text:#142b24;--muted:#567067;--line:#dbe7e0;--tile:#f3f8f5;--accent:#087a58;--track:#dfebe4;--warn:#a24b10; }
        :host([data-theme="dark"]) { --bg:#14201b;--text:#eef8f2;--muted:#a1b9ad;--line:#364d40;--tile:#1c2d24;--accent:#75e3b1;--track:#30483a;--warn:#ffcb89; }
        * { box-sizing:border-box; }
        [hidden] { display:none!important; }
        .card { width:390px;max-width:calc(100vw - 32px);max-height:calc(100vh - 40px);max-height:calc(100dvh - 40px);overflow:auto;
          border:1px solid var(--line);border-radius:18px;background:var(--bg);color:var(--text);
          box-shadow:0 18px 65px #0005;font:400 13px/1.5 system-ui,-apple-system,sans-serif;text-align:left; }
        header { padding:18px 18px 12px;display:flex;align-items:center;gap:10px; }
        .mark { display:grid;place-items:center;width:36px;height:36px;border-radius:11px;background:var(--tile);color:var(--accent);font-size:23px; }
        h2 { margin:0;font-size:16px;font-weight:650;color:var(--text); }
        .eyebrow { color:var(--muted);font-size:10px;letter-spacing:.12em; }
        .controls { display:flex;gap:4px;margin-left:auto; }
        button { appearance:none;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--muted);-webkit-text-fill-color:currentColor;
          font:inherit;cursor:pointer;min-width:28px;min-height:28px;padding:3px 6px; }
        button:hover { background:var(--tile);color:var(--text); }
        button:focus-visible { outline:2px solid var(--accent);outline-offset:2px; }
        button:disabled { opacity:.35;cursor:default; }
        .body { padding:0 18px 16px; }
        .phase { display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:12px; }
        .badge { color:var(--accent);background:var(--tile);padding:3px 8px;border:1px solid var(--line);border-radius:6px;font-size:11px;font-weight:650; }
        .mode { color:var(--muted);font-size:11px; }
        .numbers { display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:8px;font-variant-numeric:tabular-nums; }
        .numbers strong { font-size:24px;letter-spacing:-.04em;font-weight:650; }
        .numbers span { color:var(--muted);font-size:12px; }
        .percent { font-size:14px!important;color:var(--accent)!important; }
        .track { height:7px;border-radius:8px;background:var(--track);overflow:hidden; }
        .bar { height:100%;width:0;background:var(--accent);border-radius:8px;transition:width .35s ease; }
        .chart { height:37px;display:block;width:100%;margin:10px 0 2px; }
        .stats { display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px; }
        .stat { background:var(--tile);border:1px solid var(--line);border-radius:10px;padding:10px 12px; }
        .label { display:block;font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted); }
        .value { display:block;font-size:18px;line-height:1.6;font-variant-numeric:tabular-nums;color:var(--text); }
        .sub { font-size:10px;color:var(--muted); }
        .status { display:flex;gap:12px;flex-wrap:wrap;color:var(--muted);font-size:11px;margin:13px 0 10px; }
        .warning { color:var(--warn); }
        .message { border-top:1px solid var(--line);padding-top:10px;font-size:11px;color:var(--muted);overflow-wrap:anywhere; }
        .foot { margin-top:7px;font-size:10px;color:var(--muted); }
        .compact { display:none;padding:0 18px 14px;color:var(--muted);font-size:12px; }
        :host([data-collapsed="true"]) .body { display:none; }
        :host([data-collapsed="true"]) .compact { display:block; }
        @media(prefers-reduced-motion:reduce) { .bar { transition:none; } }
      </style>
      <section class="card" role="region" aria-label="Image export progress">
        <header><div class="mark" aria-hidden="true">↓</div><div><div class="eyebrow">CHATGPT · BULK EXPORT</div><h2>Image export</h2></div>
          <div class="controls"><button id="collapse" aria-label="Minimize progress" aria-expanded="true">−</button><button id="close" aria-label="Close progress" disabled>×</button></div></header>
        <div class="compact" id="compact"></div>
        <div class="body">
          <div class="phase"><span class="badge" id="phase">PREPARING</span><span class="mode" id="mode">Auto</span></div>
          <div class="numbers"><div><strong id="count">0</strong><span id="total"> / — processed</span></div><span class="percent" id="percent">—</span></div>
          <div class="track" id="track" role="progressbar" aria-label="Image tasks processed" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div class="bar" id="bar"></div></div>
          <svg id="chart" class="chart" viewBox="0 0 340 34" preserveAspectRatio="none" aria-hidden="true"><path d="M0 33H340" stroke="var(--line)"/><polyline id="spark" fill="none" stroke="var(--accent)" stroke-width="1.8" points="0,33 340,33"/></svg>
          <div class="stats" id="transfer-stats">
            <div class="stat"><span class="label">Transfer rate</span><span class="value" id="speed">—</span><span class="sub" id="average">Collecting image list</span></div>
            <div class="stat"><span class="label">Active / target</span><span class="value" id="concurrency">—</span><span class="sub" id="control">Waiting to start</span></div>
            <div class="stat"><span class="label">Elapsed</span><span class="value" id="elapsed">00:00</span></div>
            <div class="stat"><span class="label">Est. remaining</span><span class="value" id="eta">—</span><span class="sub">Based on recent completions</span></div>
          </div>
          <div class="stats" id="prompt-stats" hidden>
            <div class="stat"><span class="label">Conversations processed</span><span class="value" id="conversations">0 / —</span></div>
            <div class="stat"><span class="label">Image prompts resolved</span><span class="value" id="resolved">0 / —</span></div>
            <div class="stat"><span class="label">All / selected groups</span><span class="value" id="groups">— / —</span></div>
            <div class="stat"><span class="label">Selected images</span><span class="value" id="selected-images">—</span></div>
          </div>
          <div class="status" id="prompt-errors" hidden><span id="prompt-error-count"></span><span id="prompt-save-error-count"></span></div>
          <div class="status"><span id="queued">0 queued</span><span id="failed">0 failed</span><span id="retrying">0 retrying</span><span id="warnings">0 warnings</span></div>
          <div id="message" class="message" role="status" aria-live="polite">Preparing export…</div>
          <div class="foot">Queued ≠ saved to disk. Check browser Downloads for completion.</div>
        </div>
      </section>`;
    const el = id => root.getElementById(id);
    const rates = [];
    let state = {}, lastChart = 0, collapsed = false;
    const syncTheme = () => { host.dataset.theme = theme(); };
    syncTheme();
    const observer = new MutationObserver(syncTheme);
    for (const node of [document.documentElement, document.body]) if (node) observer.observe(node,
      { attributes: true, attributeFilter: ['class', 'style', 'data-theme', 'data-color-mode'] });
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    media?.addEventListener?.('change', syncTheme);
    el('collapse').onclick = () => {
      collapsed = !collapsed; host.dataset.collapsed = String(collapsed);
      el('collapse').textContent = collapsed ? '+' : '−';
      el('collapse').setAttribute('aria-expanded', String(!collapsed));
      el('collapse').setAttribute('aria-label', collapsed ? 'Expand progress' : 'Minimize progress');
    };
    el('close').onclick = () => { if (state.finished) onClose(); };
    document.body.appendChild(host);
    function update(patch) {
      state = { ...state, ...patch };
      const { completed = 0, total, active = 0, limit = 0, phase = 'preparing', speed = 0 } = state;
      const promptStage = ['prompts', 'grouping', 'prompt-save'].includes(state.stage);
      const displayCompleted = promptStage ? state.resolvedImages || 0 : completed;
      const displayTotal = promptStage ? state.totalImages : total;
      const percent = displayTotal > 0 ? Math.min(100, displayCompleted / displayTotal * 100) : state.finished && phase === 'complete' ? 100 : 0;
      const promptPhase = { prompts: 'RESOLVING PROMPTS', grouping: 'BUILDING GROUPS', 'prompt-save': 'SAVING PROMPTS' }[state.stage];
      el('phase').textContent = promptStage && !state.finished ? promptPhase : phase.toUpperCase();
      el('phase').className = ['blocked', 'error', 'completed with issues', 'cooldown'].includes(phase) ? 'badge warning' : 'badge';
      el('mode').textContent = promptStage ? '保存提示词' : state.mode === 'manual' ? 'Manual' : 'Auto · adaptive';
      el('count').textContent = displayCompleted.toLocaleString();
      el('total').textContent = ` / ${displayTotal == null ? '—' : displayTotal.toLocaleString()} ${promptStage ? 'prompts resolved' : 'processed'}`;
      el('percent').textContent = displayTotal == null ? '—' : `${percent.toFixed(1)}%`;
      el('bar').style.width = `${percent}%`; el('track').setAttribute('aria-valuenow', String(percent));
      el('track').setAttribute('aria-label', promptStage ? 'Image prompts resolved' : 'Image tasks processed');
      // SVG does not implement HTMLElement.hidden in every supported browser.
      if (promptStage) el('chart').setAttribute('hidden', '');
      else el('chart').removeAttribute('hidden');
      el('transfer-stats').hidden = promptStage;
      el('prompt-stats').hidden = !promptStage;
      const count = value => value == null ? '—' : value.toLocaleString();
      el('conversations').textContent = `${count(state.processedConversations || 0)} / ${count(state.totalConversations)}`;
      el('resolved').textContent = `${count(state.resolvedImages || 0)} / ${count(state.totalImages)}`;
      el('groups').textContent = `${count(state.groupCount)} / ${count(state.selectedGroupCount)}`;
      el('selected-images').textContent = count(total);
      const errorCount = value => Array.isArray(value) ? value.length : Number(value) || 0;
      const promptErrors = errorCount(state.promptErrors), promptSaveErrors = errorCount(state.promptSaveErrors);
      el('prompt-errors').hidden = !promptStage && !promptErrors && !promptSaveErrors;
      el('prompt-error-count').textContent = `${promptErrors} prompt resolution errors`;
      el('prompt-save-error-count').textContent = `${promptSaveErrors} prompt save errors`;
      el('prompt-error-count').className = promptErrors ? 'warning' : '';
      el('prompt-save-error-count').className = promptSaveErrors ? 'warning' : '';
      el('speed').textContent = state.finished ? '—' : `${(speed / 1048576).toFixed(1)} MiB/s`;
      el('average').textContent = `${size(state.bytes || 0)} received · avg ${((state.averageSpeed || 0) / 1048576).toFixed(1)} MiB/s`;
      el('concurrency').textContent = `${active} / ${limit || '—'}`;
      el('control').textContent = state.reason || 'Waiting to start';
      el('elapsed').textContent = duration(state.elapsedMs || 0);
      el('eta').textContent = state.etaMs == null ? '—' : `≈ ${duration(state.etaMs)}`;
      for (const key of ['queued', 'failed', 'retrying', 'warnings']) {
        el(key).textContent = `${state[key] || 0} ${key}`;
        el(key).className = (key === 'failed' || key === 'warnings') && state[key] ? 'warning' : '';
      }
      if (patch.message !== undefined) el('message').textContent = patch.message;
      el('close').disabled = !state.finished;
      el('compact').textContent = promptStage
        ? `${displayCompleted}/${displayTotal ?? '—'} prompts · ${state.processedConversations || 0}/${state.totalConversations ?? '—'} conversations · ${state.finished ? phase : promptPhase}`
        : `${completed}/${total ?? '—'} · ${(speed / 1048576).toFixed(1)} MiB/s · ${state.finished ? phase : `ETA ${state.etaMs == null ? '—' : duration(state.etaMs)}`}`;
      if (Date.now() - lastChart >= 450 && !state.finished && !promptStage) {
        rates.push(speed); if (rates.length > 32) rates.shift(); lastChart = Date.now();
        const max = Math.max(1, ...rates);
        el('spark').setAttribute('points', rates.map((r, i) => `${i * 340 / Math.max(1, rates.length - 1)},${33 - r / max * 30}`).join(' '));
      }
    }
    return { update, destroy() { observer.disconnect(); media?.removeEventListener?.('change', syncTheme); host.remove(); } };
  }
  const api = { createMeter, createPanel, duration, size };
  globalThis.ChatGPTDownloadProgress = api;
  if (typeof module !== 'undefined') module.exports = api;
})();
