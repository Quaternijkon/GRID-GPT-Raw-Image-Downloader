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
        :host { --bg:#fff;--text:#142b24;--muted:#567067;--line:#dbe7e0;--tile:#f3f8f5;--accent:#087a58;--track:#dfebe4;--warn:#a24b10;--danger:#b3261e;--info:#1967a3; }
        :host([data-theme="dark"]) { --bg:#14201b;--text:#eef8f2;--muted:#a1b9ad;--line:#364d40;--tile:#1c2d24;--accent:#75e3b1;--track:#30483a;--warn:#ffcb89;--danger:#ff9b92;--info:#8fc9ff; }
        * { box-sizing:border-box; }
        [hidden] { display:none!important; }
        .card { width:440px;max-width:calc(100vw - 24px);max-height:calc(100vh - 28px);max-height:calc(100dvh - 28px);overflow:auto;
          border:1px solid var(--line);border-radius:22px;background:var(--bg);color:var(--text);
          box-shadow:0 18px 65px #0005;font:400 13px/1.5 system-ui,-apple-system,sans-serif;text-align:left; }
        header { padding:20px 20px 14px;display:flex;align-items:center;gap:12px;position:sticky;top:0;background:var(--bg);z-index:2; }
        .mark { display:grid;place-items:center;width:42px;height:42px;border-radius:13px;background:var(--tile);color:var(--accent);font-size:25px; }
        h2 { margin:0;font-size:18px;font-weight:700;color:var(--text); }
        .eyebrow { color:var(--muted);font-size:10px;letter-spacing:.12em; }
        .controls { display:flex;gap:4px;margin-left:auto; }
        button { appearance:none;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--muted);-webkit-text-fill-color:currentColor;
          font:inherit;cursor:pointer;min-width:28px;min-height:28px;padding:3px 6px; }
        button:hover { background:var(--tile);color:var(--text); }
        button:focus-visible { outline:2px solid var(--accent);outline-offset:2px; }
        button:disabled { opacity:.35;cursor:default; }
        .body { padding:0 20px 18px; }
        .phase { display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:12px; }
        .badge { color:var(--accent);background:var(--tile);padding:5px 9px;border:1px solid var(--line);border-radius:8px;font-size:11px;font-weight:700; }
        .mode { color:var(--muted);font-size:11px; }
        .numbers { display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:8px;font-variant-numeric:tabular-nums; }
        .numbers strong { font-size:24px;letter-spacing:-.04em;font-weight:650; }
        .numbers span { color:var(--muted);font-size:12px; }
        .percent { font-size:14px!important;color:var(--accent)!important; }
        .track { height:7px;border-radius:8px;background:var(--track);overflow:hidden; }
        .bar { height:100%;width:0;background:var(--accent);border-radius:8px;transition:width .35s ease; }
        .chart { height:37px;display:block;width:100%;margin:10px 0 2px; }
        .stats { display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-top:14px; }
        .stat { background:var(--tile);border:1px solid var(--line);border-radius:12px;padding:11px 13px;min-height:78px; }
        .label { display:block;font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted); }
        .value { display:block;font-size:18px;line-height:1.6;font-variant-numeric:tabular-nums;color:var(--text); }
        .sub { font-size:10px;color:var(--muted); }
        .status { display:flex;gap:7px;flex-wrap:wrap;color:var(--muted);font-size:11px;margin:14px 0 10px; }
        .status span { padding:4px 7px;border-radius:7px;background:var(--tile);border:1px solid var(--line); }
        .warning { color:var(--warn); }
        .danger { color:var(--danger)!important; }
        .info { color:var(--info)!important; }
        .recovery { margin:10px 0;padding:9px 11px;border-radius:10px;background:var(--tile);border:1px solid var(--line);color:var(--info);font-size:11px; }
        .message { border-top:1px solid var(--line);padding-top:11px;font-size:11px;color:var(--muted);overflow-wrap:anywhere; }
        .foot { margin-top:7px;font-size:10px;color:var(--muted); }
        .compact { display:none;padding:0 20px 15px;color:var(--muted);font-size:12px; }
        :host([data-collapsed="true"]) .body { display:none; }
        :host([data-collapsed="true"]) .compact { display:block; }
        @media(prefers-reduced-motion:reduce) { .bar { transition:none; } }
      </style>
      <section class="card" role="region" aria-label="导出任务进度">
        <header><div class="mark" aria-hidden="true">↓</div><div><div class="eyebrow">GRID · CHATGPT 导出</div><h2 id="title">准备导出</h2></div>
          <div class="controls"><button id="collapse" aria-label="收起进度" aria-expanded="true">−</button><button id="close" aria-label="关闭进度" disabled>×</button></div></header>
        <div class="compact" id="compact"></div>
        <div class="body">
          <div class="phase"><span class="badge" id="phase">准备中</span><span class="mode" id="mode">自动调节</span></div>
          <div class="numbers"><div><strong id="count">0</strong><span id="total"> / — 已处理</span></div><span class="percent" id="percent">—</span></div>
          <div class="track" id="track" role="progressbar" aria-label="图片任务进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div class="bar" id="bar"></div></div>
          <svg id="chart" class="chart" viewBox="0 0 340 34" preserveAspectRatio="none" aria-hidden="true"><path d="M0 33H340" stroke="var(--line)"/><polyline id="spark" fill="none" stroke="var(--accent)" stroke-width="1.8" points="0,33 340,33"/></svg>
          <div class="stats" id="transfer-stats">
            <div class="stat"><span class="label">实时速度</span><span class="value" id="speed">—</span><span class="sub" id="average">正在读取图片列表</span></div>
            <div class="stat"><span class="label">正在处理 / 并发上限</span><span class="value" id="concurrency">—</span><span class="sub" id="control">等待开始</span></div>
            <div class="stat"><span class="label">已经用时</span><span class="value" id="elapsed">00:00</span></div>
            <div class="stat"><span class="label">预计剩余</span><span class="value" id="eta">—</span><span class="sub">根据最近完成速度估算</span></div>
          </div>
          <div class="stats" id="prompt-stats" hidden>
            <div class="stat"><span class="label">已读取会话</span><span class="value" id="conversations">0 / —</span></div>
            <div class="stat"><span class="label">已恢复提示词</span><span class="value" id="resolved">0 / —</span></div>
            <div class="stat"><span class="label">全部 / 本次分组</span><span class="value" id="groups">— / —</span></div>
            <div class="stat"><span class="label">本次图片</span><span class="value" id="selected-images">—</span></div>
          </div>
          <div class="status" id="prompt-errors" hidden><span id="prompt-error-count"></span><span id="prompt-save-error-count"></span></div>
          <div class="status"><span id="queued">0 已排队</span><span id="failed">0 原图失败</span><span id="retrying">0 正在恢复</span><span id="warnings">0 条警告</span></div>
          <div id="recovery" class="recovery" hidden>网络暂时不可用，任务会等待并继续，不会立即计为失败。</div>
          <div id="message" class="message" role="status" aria-live="polite">正在准备导出…</div>
          <div class="foot">“已排队”表示 Chrome 已接收任务；最终写盘状态请查看浏览器下载记录。</div>
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
      el('collapse').setAttribute('aria-label', collapsed ? '展开进度' : '收起进度');
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
      const promptPhase = { prompts: '恢复提示词', grouping: '构建分组', 'prompt-save': '保存提示词' }[state.stage];
      const phaseLabels = { preparing: '准备中', collecting: '读取列表', transferring: '下载原图', cooldown: '等待恢复',
        backoff: '降低速度', recovering: '恢复中', finalizing: '整理结果', complete: '已完成',
        'completed with issues': '完成但有问题', blocked: '已阻止', error: '发生错误', prompts: '恢复提示词' };
      const phaseLabel = promptStage && !state.finished ? promptPhase : phaseLabels[phase] || String(phase);
      el('phase').textContent = phaseLabel;
      el('title').textContent = state.finished ? (phase === 'complete' ? '导出完成' : phase === 'completed with issues' ? '导出完成，但需要处理' : '导出已停止')
        : promptStage ? promptPhase : state.stage === 'images' ? '正在下载原图' : '正在准备导出';
      el('phase').className = ['blocked', 'error', 'completed with issues', 'cooldown'].includes(phase) ? 'badge warning' : 'badge';
      el('mode').textContent = promptStage ? '串行读取 · 10 秒间隔' : state.mode === 'manual' ? '手动并发' : '自动调节并发';
      el('count').textContent = displayCompleted.toLocaleString();
      el('total').textContent = ` / ${displayTotal == null ? '—' : displayTotal.toLocaleString()} ${promptStage ? '条提示词' : '项已处理'}`;
      el('percent').textContent = displayTotal == null ? '—' : `${percent.toFixed(1)}%`;
      el('bar').style.width = `${percent}%`; el('track').setAttribute('aria-valuenow', String(percent));
      el('track').setAttribute('aria-label', promptStage ? '提示词恢复进度' : '图片任务进度');
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
      el('prompt-error-count').textContent = `${promptErrors} 条提示词未解析`;
      el('prompt-save-error-count').textContent = `${promptSaveErrors} 个提示词文件保存失败`;
      el('prompt-error-count').className = promptErrors ? 'warning' : '';
      el('prompt-save-error-count').className = promptSaveErrors ? 'warning' : '';
      el('speed').textContent = state.finished ? '—' : `${(speed / 1048576).toFixed(1)} MiB/s`;
      el('average').textContent = `已接收 ${size(state.bytes || 0)} · 平均 ${((state.averageSpeed || 0) / 1048576).toFixed(1)} MiB/s`;
      el('concurrency').textContent = `${active} / ${limit || '—'}`;
      const reasonLabels = { 'Starting': '正在启动', 'Server rate limit': '服务端限流', 'Transient request errors': '暂时性请求错误',
        'Estimated memory budget': '受内存预算限制', 'Latency rose without throughput gain': '延迟升高，正在降速',
        'Observing after backoff': '降速后观察中', 'Probe did not improve throughput': '并发探测未提升速度',
        'Probe improved throughput': '并发探测有效', 'Throughput growing': '吞吐仍在上升',
        'Throughput plateau after growth': '吞吐已到平台', 'Holding measured throughput': '保持当前稳定速度',
        'Exploring spare capacity': '正在探测空余能力' };
      const rawReason = state.reason || '';
      const reasonKey = rawReason.includes(' · ') ? rawReason.split(' · ').at(-1) : rawReason;
      el('control').textContent = reasonLabels[reasonKey] || rawReason || '等待开始';
      el('elapsed').textContent = duration(state.elapsedMs || 0);
      el('eta').textContent = state.etaMs == null ? '—' : `≈ ${duration(state.etaMs)}`;
      const statusLabels = { queued: '已排队', failed: '原图失败', retrying: '正在恢复', warnings: '条警告' };
      for (const key of ['queued', 'failed', 'retrying', 'warnings']) {
        el(key).textContent = `${state[key] || 0} ${statusLabels[key]}`;
        el(key).className = key === 'failed' && state[key] ? 'danger' :
          key === 'retrying' && state[key] ? 'info' : key === 'warnings' && state[key] ? 'warning' : '';
      }
      const recovering = (state.retrying || 0) > 0 || ['cooldown', 'backoff', 'recovering'].includes(phase) ||
        /backoff|Transient request errors|暂时性请求错误/i.test(rawReason);
      el('recovery').hidden = !recovering;
      el('recovery').textContent = (state.retrying || 0) > 0
        ? `${state.retrying} 个原图任务正在等待或恢复。暂时错误不会立即计入失败。`
        : '请求速度已自动降低，网络恢复后会继续。';
      if (patch.message !== undefined) el('message').textContent = patch.message;
      el('close').disabled = !state.finished;
      el('compact').textContent = promptStage
        ? `${displayCompleted}/${displayTotal ?? '—'} 条提示词 · ${state.processedConversations || 0}/${state.totalConversations ?? '—'} 个会话 · ${state.finished ? phaseLabel : promptPhase}`
        : `${completed}/${total ?? '—'} · ${(speed / 1048576).toFixed(1)} MiB/s · ${state.finished ? phaseLabel : `剩余 ${state.etaMs == null ? '—' : duration(state.etaMs)}`}`;
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
