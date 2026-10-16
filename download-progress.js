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
  function rate(bytes) {
    return bytes > 0 && bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KiB/s` : `${(bytes / 1048576).toFixed(1)} MiB/s`;
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

  // Presentation-only sampling. Queue admission and download receipts remain authoritative.
  function createDisplayTelemetry({ now = () => Date.now() } = {}) {
    let started = null, lastBytes = 0, lastProcessed = 0, lastCompletion = null, droppedProcessed = 0;
    const byteBuckets = new Map(), itemBuckets = new Map(), completionHistory = [];
    function observe({ stage, bytes = 0, completed = 0, total,
      phase, retrying = 0, finished = false }) {
      if (stage !== 'images' || started === null && finished) return null;
      const time = now(), second = Math.floor(time / 1000);
      if (started === null) started = time;
      const safeBytes = Math.max(0, Number(bytes) || 0);
      if (safeBytes > lastBytes) byteBuckets.set(second, (byteBuckets.get(second) || 0) + safeBytes - lastBytes);
      lastBytes = Math.max(lastBytes, safeBytes);
      const processed = Math.max(0, Number(completed) || 0);
      if (processed > lastProcessed) {
        itemBuckets.set(second, (itemBuckets.get(second) || 0) + processed - lastProcessed);
        completionHistory.push({ time, processed });
        lastCompletion = time;
        lastProcessed = processed;
      }
      for (const key of byteBuckets.keys()) if (key < second - 63) byteBuckets.delete(key);
      for (const key of itemBuckets.keys()) if (key < second - 59) itemBuckets.delete(key);
      while (completionHistory.length && completionHistory[0].time < time - 60000)
        droppedProcessed = completionHistory.shift().processed;
      const firstSecond = Math.max(Math.floor(started / 1000), second - 59);
      const samples = [], itemSamples = [];
      for (let key = firstSecond; key <= second; key++) {
        let recentBytes = 0;
        for (let bucket = Math.max(Math.floor(started / 1000), key - 4); bucket <= key; bucket++)
          recentBytes += byteBuckets.get(bucket) || 0;
        const span = Math.max(1, Math.min(5, (key * 1000 - started) / 1000));
        samples.push({ time: key * 1000, rate: recentBytes / span });
      }
      // One cell per wall-clock second. Repeated renders never add task counts.
      for (let key = second - 59; key <= second; key++) itemSamples.push({
        time: key * 1000, rate: itemBuckets.get(key) || 0,
        observed: key >= Math.floor(started / 1000) });
      const elapsed = Math.max(0, time - started);
      const currentRate = samples.at(-1)?.rate || 0;
      const averageRate = safeBytes / Math.max(1, elapsed / 1000);
      const peakRate = Math.max(0, ...samples.map(item => item.rate));
      const itemRate = itemSamples.slice(-5).reduce((sum, item) => sum + item.rate, 0) /
        Math.max(1, Math.min(5, elapsed / 1000));
      const peakItemRate = Math.max(0, ...itemSamples.map(item => item.rate));
      const remaining = Number.isFinite(total) ? Math.max(0, total - processed) : null;
      let etaMs = null;
      if (!finished && phase === 'transferring' && !retrying && remaining > 0 &&
          processed >= 5 && elapsed >= 15000 && lastCompletion !== null && time - lastCompletion <= 15000) {
        const windowStart = Math.max(started, time - 45000);
        const before = [...completionHistory].reverse().find(item => item.time < windowStart)?.processed ?? droppedProcessed;
        const recent = Math.max(0, processed - before);
        const recentRate = recent / Math.max(1, (time - windowStart) / 1000);
        const overallRate = processed / Math.max(1, elapsed / 1000);
        const rate = 0.6 * recentRate + 0.4 * overallRate;
        if (rate > 0) etaMs = Math.round(remaining / rate * 1000);
      }
      return { samples, currentRate, averageRate, peakRate, elapsedMs: elapsed,
        itemSamples, itemRate, peakItemRate, remaining,
        etaMs, finishAt: etaMs === null ? null : time + etaMs, now: time };
    }
    return { observe };
  }

  function createPanel({ theme = () => 'dark', onClose = () => {}, provider = 'ChatGPT',
    mediaLabel = '图片', promptModeLabel = '串行读取 · 10 秒间隔', id,
    now = () => Date.now() } = {}) {
    const host = document.createElement('div');
    if (id) host.id = id;
    host.style.cssText = 'all:initial;position:fixed;right:20px;bottom:20px;z-index:2147483646;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        :host { --bg:#fff;--text:#142b24;--muted:#567067;--line:#dbe7e0;--tile:#f3f8f5;--accent:#087a58;--track:#dfebe4;--warn:#a24b10;--danger:#b3261e;--info:#1967a3; }
        :host([data-theme="dark"]) { --bg:#14201b;--text:#eef8f2;--muted:#a1b9ad;--line:#364d40;--tile:#1c2d24;--accent:#75e3b1;--track:#30483a;--warn:#ffcb89;--danger:#ff9b92;--info:#8fc9ff; }
        * { box-sizing:border-box; }
        [hidden] { display:none!important; }
        .card { width:520px;max-width:calc(100vw - 32px);max-height:calc(100vh - 40px);max-height:calc(100dvh - 40px);overflow:auto;
          border:1px solid var(--line);border-radius:20px;background:var(--bg);color:var(--text);
          box-shadow:0 18px 65px #0004;font:400 13px/1.5 system-ui,-apple-system,sans-serif;text-align:left; }
        header { padding:22px 24px 18px;display:flex;align-items:center;gap:12px; }
        .mark { display:grid;place-items:center;width:36px;height:36px;border-radius:11px;background:var(--tile);color:var(--accent);font-size:22px; }
        h2 { margin:0;font-size:17px;font-weight:650;color:var(--text); }
        .eyebrow { color:var(--muted);font-size:11px; }
        .controls { display:flex;gap:4px;margin-left:auto;align-self:flex-start; }
        button { appearance:none;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--muted);-webkit-text-fill-color:currentColor;
          font:inherit;cursor:pointer;min-width:28px;min-height:28px;padding:3px 6px; }
        button:hover { background:var(--tile);color:var(--text); }
        button:focus-visible { outline:2px solid var(--accent);outline-offset:2px; }
        button:disabled { opacity:.35;cursor:default; }
        .body { padding:0 24px 24px; }
        .phase { display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:16px; }
        .badge,.mode { color:var(--muted);font-size:12px; }
        .numbers { display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:10px;font-variant-numeric:tabular-nums; }
        .numbers strong { font-size:24px;letter-spacing:-.025em;font-weight:600; }
        .numbers span { color:var(--muted);font-size:12px; }
        .percent { font-size:14px!important;color:var(--accent)!important; }
        .track { height:9px;border-radius:9px;background:var(--track);overflow:hidden; }
        .bar { height:100%;width:0;background:var(--accent);border-radius:9px;transition:width .35s ease; }
        .times { display:flex;justify-content:space-between;gap:12px;margin-top:9px;color:var(--muted);font-size:12px;font-variant-numeric:tabular-nums; }
        .times strong { font-weight:500;color:var(--text); }
        .chart-block { margin-top:24px; }
        .chart-head,.chart-axis,.secondary { display:flex;align-items:center;justify-content:space-between;gap:8px;color:var(--muted);font-size:12px; }
        .chart-head strong { color:var(--text);font-weight:600; }
        .rate { margin:4px 0 12px;display:flex;align-items:baseline;gap:6px; }
        .rate strong { font-size:32px;letter-spacing:-.035em;line-height:1.2;font-weight:600;font-variant-numeric:tabular-nums; }
        .rate span { color:var(--muted);font-size:12px; }
        .plot { position:relative;border-radius:12px;background:var(--tile);overflow:hidden; }
        .chart { height:180px;display:block;width:100%; }
        .chart-axis { margin-top:6px;font-size:11px;font-variant-numeric:tabular-nums; }
        .secondary { margin-top:14px;padding-top:14px;border-top:1px solid var(--line); }
        .heatmap { display:grid;grid-template-columns:repeat(30,minmax(0,1fr));gap:4px;margin-top:12px; }
        .heat-cell { height:15px;border-radius:3px;background:var(--track); }
        .heat-cell[data-empty="true"] { opacity:.3; }
        .legend { display:inline-block;width:44px;height:6px;margin:0 5px;border-radius:4px;background:linear-gradient(90deg,var(--track),var(--accent)); }
        .stats { display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:22px; }
        .stat { border-bottom:1px solid var(--line);padding-bottom:12px; }
        .label { display:block;font-size:12px;color:var(--muted); }
        .value { display:block;font-size:19px;line-height:1.6;font-variant-numeric:tabular-nums;color:var(--text); }
        .status { display:flex;gap:8px;flex-wrap:wrap;color:var(--muted);font-size:12px;margin:18px 0 0; }
        .status span { padding:3px 7px;border-radius:6px;background:var(--tile); }
        .warning { color:var(--warn); }
        .danger { color:var(--danger)!important; }
        .info { color:var(--info)!important; }
        .recovery { margin-top:12px;color:var(--info);font-size:12px; }
        .message { margin-top:12px;font-size:12px;color:var(--warn);overflow-wrap:anywhere; }
        .compact { display:none;padding:0 24px 20px;color:var(--muted);font-size:12px; }
        @media(max-width:480px) { header { padding:18px 18px 16px; } .body { padding:0 18px 20px; }
          .chart { height:155px; } .heatmap { gap:3px; } .heat-cell { height:12px; } }
        @media(forced-colors:active) { .card,.track,.heat-cell { border:1px solid CanvasText; } }
        :host([data-collapsed="true"]) .body { display:none; }
        :host([data-collapsed="true"]) .compact { display:block; }
        @media(prefers-reduced-motion:reduce) { .bar { transition:none; } }
      </style>
      <section class="card" role="region" aria-label="导出任务进度">
        <header><div class="mark" aria-hidden="true">↓</div><div><div class="eyebrow">GRID · ${provider}</div><h2 id="title">准备导出</h2></div>
          <div class="controls"><button id="collapse" aria-label="收起进度" aria-expanded="true">−</button><button id="close" aria-label="关闭进度" disabled>×</button></div></header>
        <div class="compact" id="compact"></div>
        <div class="body">
          <div class="numbers"><div><strong id="count">扫描中</strong><span id="total"></span></div><span class="percent" id="percent"></span></div>
          <div class="track" id="track" role="progressbar" aria-label="${mediaLabel}任务进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div class="bar" id="bar"></div></div>
          <div class="times"><span>已用 <strong id="elapsed">00:00</strong></span><span>剩余 <strong id="eta">—</strong></span></div>
          <div id="transfer-stats">
            <div class="chart-block" id="throughput-block">
              <div class="chart-head"><strong>接收速度</strong><span id="throughput-summary"></span></div>
              <div class="rate"><strong id="speed">—</strong><span id="speed-unit">MiB/s</span></div>
              <div class="plot"><svg id="chart" class="chart" viewBox="0 0 600 180" preserveAspectRatio="none" role="img" aria-label="最近 60 秒接收速度">
                <path d="M0 170H600M0 90H600M0 10H600" stroke="var(--line)" stroke-width="1"/>
                <polygon id="speed-area" fill="var(--accent)" opacity=".12" points=""/>
                <polyline id="spark" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linejoin="round" vector-effect="non-scaling-stroke" points=""/>
              </svg></div>
              <div class="chart-axis"><span>−60 s</span><span id="throughput-scale">MiB/s</span><span>现在</span></div>
            </div>
            <div class="chart-block" id="items-block"><div class="chart-head"><strong>处理速度</strong><span id="item-speed">— items/s</span></div>
              <div id="heatmap" class="heatmap" role="img" aria-label="最近 60 秒每秒处理任务数">
                ${Array.from({ length: 60 }, (_, index) => `<span id="heat-cell-${index}" class="heat-cell" data-empty="true" aria-hidden="true"></span>`).join('')}
              </div>
              <div class="chart-axis"><span>−60 s</span><span>0<i class="legend" aria-hidden="true"></i><span id="item-scale">items/s</span></span><span>现在</span></div>
            </div>
            <div class="secondary"><span id="average">0.0 MiB</span><span id="concurrency">—</span></div>
          </div>
          <div class="stats" id="prompt-stats" hidden>
            <div class="stat"><span class="label">会话</span><span class="value" id="conversations">0 / —</span></div>
            <div class="stat"><span class="label">提示词</span><span class="value" id="resolved">0 / —</span></div>
            <div class="stat"><span class="label">分组</span><span class="value" id="groups">— / —</span></div>
            <div class="stat"><span class="label">本次${mediaLabel}</span><span class="value" id="selected-images">—</span></div>
          </div>
          <div class="status" id="prompt-errors" hidden><span id="prompt-error-count"></span><span id="prompt-save-error-count"></span></div>
          <div class="status" id="status" hidden><span id="queued">0 已排队</span><span id="failed">0 原图失败</span><span id="retrying">0 正在恢复</span><span id="warnings">0 条警告</span></div>
          <div id="alert" class="recovery warning" hidden></div>
          <div class="phase" style="margin:16px 0 0"><span class="badge" id="phase" hidden>准备中</span><span class="mode" id="mode">自动并发</span></div>
          <div id="recovery" class="recovery" hidden></div>
          <div id="message" class="message" role="status" aria-live="polite" hidden></div>
        </div>
      </section>`;
    const el = id => root.getElementById(id);
    const monitor = createDisplayTelemetry({ now });
    let state = {}, collapsed = false, elapsedStart = now(), stoppedElapsed = null;
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
      if (Number.isFinite(patch.elapsedMs)) elapsedStart = now() - patch.elapsedMs;
      state = { ...state, ...patch };
      const { completed = 0, total, active = 0, limit = 0, phase = 'preparing' } = state;
      if (state.finished && stoppedElapsed === null) stoppedElapsed = Math.max(0, now() - elapsedStart);
      const promptStage = ['prompts', 'grouping', 'prompt-save'].includes(state.stage);
      const transfer = monitor.observe(state);
      const savingFiles = state.stage === 'prompt-save' && Number.isFinite(state.promptFilesTotal);
      const displayCompleted = savingFiles ? state.promptFilesProcessed || 0 : promptStage ? state.resolvedImages || 0 : completed;
      const displayTotal = savingFiles ? state.promptFilesTotal : promptStage ? state.totalImages : total;
      const percent = displayTotal > 0 ? Math.min(100, displayCompleted / displayTotal * 100) : state.finished && phase === 'complete' ? 100 : 0;
      const promptPhase = { prompts: '恢复提示词', grouping: '构建分组', 'prompt-save': '保存提示词' }[state.stage];
      const phaseLabels = { preparing: '准备中', collecting: '读取列表', transferring: mediaLabel === '图片' ? '下载原图' : `下载${mediaLabel}`, cooldown: '等待恢复',
        backoff: '降低速度', recovering: '恢复中', finalizing: '整理结果', complete: '已完成',
        'completed with issues': '完成但有问题', blocked: '已阻止', error: '发生错误', prompts: '恢复提示词' };
      const phaseLabel = promptStage && !state.finished ? promptPhase : phaseLabels[phase] || String(phase);
      el('phase').textContent = phaseLabel;
      el('title').textContent = state.finished ? (phase === 'complete' ? '本轮完成' : phase === 'completed with issues' ? '需要处理' : '已停止')
        : promptStage ? promptPhase : phase === 'finalizing' ? '正在整理结果' :
          state.stage === 'images' ? (mediaLabel === '图片' ? '下载原图' : `下载${mediaLabel}`) : '扫描中';
      el('phase').className = ['blocked', 'error', 'completed with issues', 'cooldown'].includes(phase) ? 'badge warning' : 'badge';
      el('phase').hidden = !['cooldown', 'backoff', 'recovering'].includes(phase);
      el('mode').textContent = state.stage === 'prompt-save'
        ? `并行保存 · ${active} / ${limit || '—'}`
        : promptStage ? promptModeLabel : state.mode === 'manual' ? '手动并发' : '自动并发';
      const hasTotal = Number.isFinite(displayTotal);
      el('count').textContent = hasTotal ? displayCompleted.toLocaleString() :
        promptStage ? '读取中' : '扫描中';
      el('total').textContent = hasTotal ? ` / ${displayTotal.toLocaleString()} ${savingFiles ? 'TXT' : promptStage ? '条' : '已处理'}` : '';
      el('percent').textContent = hasTotal ? `${percent.toFixed(1)}%` : '';
      el('bar').style.width = `${percent}%`; el('track').setAttribute('aria-valuenow', String(percent));
      el('track').setAttribute('aria-label', savingFiles ? '提示词文件保存进度' : promptStage ? '提示词恢复进度' : `${mediaLabel}任务进度`);
      el('track').hidden = !hasTotal;
      // SVG does not implement HTMLElement.hidden in every supported browser.
      el('transfer-stats').hidden = promptStage || !transfer;
      el('prompt-stats').hidden = !promptStage;
      const count = value => value == null ? '—' : value.toLocaleString();
      el('conversations').textContent = `${count(state.processedConversations || 0)} / ${count(state.totalConversations)}`;
      el('resolved').textContent = `${count(state.resolvedImages || 0)} / ${count(state.totalImages)}`;
      el('groups').textContent = `${count(state.groupCount)} / ${count(state.selectedGroupCount)}`;
      el('selected-images').textContent = count(total);
      const errorCount = value => Array.isArray(value) ? value.length : Number(value) || 0;
      const promptErrors = errorCount(state.promptErrors), promptSaveErrors = errorCount(state.promptSaveErrors);
      el('prompt-errors').hidden = !promptErrors && !promptSaveErrors;
      el('prompt-error-count').hidden = !promptErrors;
      el('prompt-save-error-count').hidden = !promptSaveErrors;
      el('prompt-error-count').textContent = `未解析 ${promptErrors}`;
      el('prompt-save-error-count').textContent = `TXT 失败 ${promptSaveErrors}`;
      el('prompt-error-count').className = promptErrors ? 'warning' : '';
      el('prompt-save-error-count').className = promptSaveErrors ? 'warning' : '';
      const shownSpeed = transfer?.currentRate || 0;
      const etaMs = transfer?.etaMs ?? null;
      const [speedValue, speedUnit] = rate(shownSpeed).split(' ');
      el('speed').textContent = transfer ? speedValue : '—';
      el('speed-unit').textContent = speedUnit;
      el('average').textContent = `已接收 ${size(state.bytes || 0)}`;
      el('concurrency').textContent = `${active} / ${limit || '—'} 并发`;
      const rawReason = state.reason || '';
      el('elapsed').textContent = duration(stoppedElapsed ?? Math.max(0, now() - elapsedStart));
      el('eta').textContent = state.finished ? '—' : ['cooldown', 'backoff', 'recovering'].includes(phase) || state.retrying
        ? '等待重试' : !promptStage && Number.isFinite(total) && completed >= total ? '00:00' :
          etaMs === null ? '—' : `≈ ${duration(etaMs)}`;
      const samplePoints = transfer?.samples || [];
      if (samplePoints.length && !promptStage) {
        const scale = Math.max(1, transfer.peakRate);
        const points = samplePoints.map(item =>
          `${Math.max(0, 600 - (transfer.now - item.time) / 60000 * 600).toFixed(1)},${(170 - item.rate / scale * 160).toFixed(1)}`);
        el('spark').setAttribute('points', points.join(' '));
        el('speed-area').setAttribute('points', `${points[0].split(',')[0]},170 ${points.join(' ')} ${points.at(-1).split(',')[0]},170`);
        el('chart').removeAttribute('hidden');
      } else el('chart').setAttribute('hidden', '');
      el('throughput-scale').textContent = `0–${rate(transfer?.peakRate || 0)}`;
      el('throughput-summary').textContent = transfer ? `平均 ${rate(transfer.averageRate)}` : '';
      el('item-speed').textContent = transfer ? `${transfer.itemRate.toFixed(1)} items/s` : '— items/s';
      el('item-scale').textContent = `${transfer?.peakItemRate || 0} items/s`;
      for (let index = 0; index < 60; index++) {
        const cell = el(`heat-cell-${index}`), sample = transfer?.itemSamples[index];
        cell.setAttribute('data-empty', String(!sample?.observed));
        cell.style.background = sample?.rate ? 'var(--accent)' : 'var(--track)';
        cell.style.opacity = sample?.rate ? String(.25 + .75 * Math.sqrt(sample.rate / Math.max(1, transfer.peakItemRate))) : '';
        cell.title = sample?.observed ? `${new Date(sample.time).toLocaleTimeString('zh-CN')} · ${sample.rate} items/s` : '';
      }
      el('heatmap').setAttribute('aria-label', `最近 60 秒处理速度，当前 ${(transfer?.itemRate || 0).toFixed(1)} items/s`);
      const statusLabels = { queued: '已排队', failed: '失败', retrying: '恢复中', warnings: '警告' };
      for (const key of ['queued', 'failed', 'retrying', 'warnings']) {
        el(key).textContent = `${state[key] || 0} ${statusLabels[key]}`;
        el(key).hidden = !(state[key] > 0);
        el(key).className = key === 'failed' && state[key] ? 'danger' :
          key === 'retrying' && state[key] ? 'info' : key === 'warnings' && state[key] ? 'warning' : '';
      }
      el('status').hidden = !['queued', 'failed', 'retrying', 'warnings'].some(key => state[key] > 0);
      el('alert').hidden = !(state.failed > 0);
      el('alert').textContent = state.failed > 0
        ? '导出设置 → 恢复失败任务' : '';
      const recovering = (state.retrying || 0) > 0 || ['cooldown', 'backoff', 'recovering'].includes(phase) ||
        /backoff|Transient request errors|暂时性请求错误/i.test(rawReason);
      el('recovery').hidden = !recovering || state.retrying > 0;
      el('recovery').textContent = '等待重试';
      el('message').hidden = !['error', 'blocked'].includes(phase);
      if (patch.message !== undefined) el('message').textContent = patch.message;
      el('close').disabled = !state.finished;
      el('compact').textContent = promptStage
        ? `${displayCompleted}/${displayTotal ?? '—'} 条提示词 · ${state.processedConversations || 0}/${state.totalConversations ?? '—'} 个会话 · ${state.finished ? phaseLabel : promptPhase}`
        : `${completed}/${total ?? '—'} · ${rate(shownSpeed)} · ${state.finished ? phaseLabel : `剩余 ${etaMs === null ? '—' : duration(etaMs)}`}`;
    }
    const timer = globalThis.setInterval?.(() => { if (!state.finished) update({}); }, 1000);
    return { update, destroy() { globalThis.clearInterval?.(timer); observer.disconnect();
      media?.removeEventListener?.('change', syncTheme); host.remove(); } };
  }
  const api = { createMeter, createDisplayTelemetry, createPanel, duration, size };
  globalThis.ChatGPTDownloadProgress = api;
  if (typeof module !== 'undefined') module.exports = api;
})();
