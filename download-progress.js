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

  // Presentation-only sampling. Queue admission and download receipts remain authoritative.
  function createDisplayTelemetry({ now = () => Date.now() } = {}) {
    let started = null, lastBytes = 0, lastProcessed = 0, lastCompletion = null, droppedProcessed = 0;
    const byteBuckets = new Map(), completionHistory = [], remainingHistory = [], concurrencyHistory = [];
    function observe({ stage, bytes = 0, completed = 0, total, active = 0, limit = 0,
      phase, retrying = 0, finished = false }) {
      if (stage !== 'images' || started === null && finished) return null;
      const time = now(), second = Math.floor(time / 1000);
      if (started === null) started = time;
      const safeBytes = Math.max(0, Number(bytes) || 0);
      if (safeBytes > lastBytes) byteBuckets.set(second, (byteBuckets.get(second) || 0) + safeBytes - lastBytes);
      lastBytes = Math.max(lastBytes, safeBytes);
      const processed = Math.max(0, Number(completed) || 0);
      if (processed > lastProcessed) {
        completionHistory.push({ time, processed });
        lastCompletion = time;
        lastProcessed = processed;
      }
      for (const key of byteBuckets.keys()) if (key < second - 59) byteBuckets.delete(key);
      while (completionHistory.length && completionHistory[0].time < time - 60000)
        droppedProcessed = completionHistory.shift().processed;
      if (Number.isFinite(total) && total >= 0) {
        const point = { time, remaining: Math.max(0, total - processed) };
        if (!remainingHistory.length || second !== Math.floor(remainingHistory.at(-1).time / 1000) ||
            remainingHistory.at(-1).remaining !== point.remaining) remainingHistory.push(point);
        else remainingHistory[remainingHistory.length - 1] = point;
      }
      while (remainingHistory.length > 1 && remainingHistory[0].time < time - 60000) remainingHistory.shift();
      const concurrencyPoint = { time, active: Math.max(0, Number(active) || 0),
        target: Math.max(0, Number(limit) || 0) };
      if (concurrencyHistory.length && second === Math.floor(concurrencyHistory.at(-1).time / 1000))
        concurrencyHistory[concurrencyHistory.length - 1] = concurrencyPoint;
      else concurrencyHistory.push(concurrencyPoint);
      while (concurrencyHistory.length > 60) concurrencyHistory.shift();
      const firstSecond = Math.max(Math.floor(started / 1000), second - 59);
      const samples = [];
      let smooth = 0;
      for (let key = firstSecond; key <= second; key++) {
        const raw = byteBuckets.get(key) || 0;
        smooth = key === firstSecond ? raw : 0.22 * raw + 0.78 * smooth;
        samples.push({ time: key * 1000, rate: smooth });
      }
      const elapsed = Math.max(0, time - started);
      const currentRate = samples.at(-1)?.rate || 0;
      const averageRate = safeBytes / Math.max(1, elapsed / 1000);
      const peakRate = Math.max(0, ...samples.map(item => item.rate));
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
        remaining, remainingHistory: remainingHistory.slice(), concurrencyHistory: concurrencyHistory.slice(),
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
        .chart-block { margin-top:12px;padding:10px 11px;border:1px solid var(--line);border-radius:11px;background:var(--tile); }
        .chart-head,.chart-axis,.secondary { display:flex;align-items:center;justify-content:space-between;gap:8px;color:var(--muted);font-size:10px; }
        .chart-head strong { color:var(--text);font-size:11px; }
        .chart-head span { font-variant-numeric:tabular-nums; }
        .chart { height:58px;display:block;width:100%;margin:5px 0 0; }
        .chart-axis { margin-top:1px;font-variant-numeric:tabular-nums; }
        .sample-hint { margin:8px 0 2px;color:var(--muted);font-size:11px; }
        .kpis { display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-top:13px; }
        .kpi { min-width:0;border-right:1px solid var(--line);padding-right:6px; }
        .kpi:last-child { border-right:0;padding-right:0; }
        .kpi .value { font-size:16px;font-weight:650;line-height:1.5;white-space:nowrap; }
        .secondary { margin-top:7px;flex-wrap:wrap;justify-content:flex-start; }
        .secondary span { font-variant-numeric:tabular-nums; }
        .control { margin-top:3px;color:var(--muted);font-size:10px; }
        details.chart-block { padding:9px 11px; }
        details.chart-block summary { cursor:pointer;color:var(--text);font-size:11px;font-weight:650; }
        .segments { display:flex;height:8px;overflow:hidden;border-radius:8px;background:var(--track);margin-top:8px; }
        .segments span { height:100%;display:block; }
        .segments .done { background:var(--accent); }
        .segments .working { background:var(--info); }
        .segments .pending { background:var(--track); }
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
        @media(max-width:360px) { .kpis { grid-template-columns:repeat(2,minmax(0,1fr)); } .kpi:nth-child(2) { border-right:0; } }
        :host([data-collapsed="true"]) .body { display:none; }
        :host([data-collapsed="true"]) .compact { display:block; }
        @media(prefers-reduced-motion:reduce) { .bar { transition:none; } }
      </style>
      <section class="card" role="region" aria-label="导出任务进度">
        <header><div class="mark" aria-hidden="true">↓</div><div><div class="eyebrow">GRID · ${provider.toUpperCase()} 导出</div><h2 id="title">准备导出</h2></div>
          <div class="controls"><button id="collapse" aria-label="收起进度" aria-expanded="true">−</button><button id="close" aria-label="关闭进度" disabled>×</button></div></header>
        <div class="compact" id="compact"></div>
        <div class="body">
          <div class="phase"><span class="badge" id="phase">准备中</span><span class="mode" id="mode">自动调节</span></div>
          <div class="numbers"><div><strong id="count">正在建立任务清单</strong><span id="total"></span></div><span class="percent" id="percent"></span></div>
          <div class="track" id="track" role="progressbar" aria-label="${mediaLabel}任务进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div class="bar" id="bar"></div></div>
          <div id="transfer-stats">
            <div class="kpis">
              <div class="kpi"><span class="label">接收速率</span><span class="value" id="speed">采样中</span></div>
              <div class="kpi"><span class="label">活跃 / 目标并发</span><span class="value" id="concurrency">—</span></div>
              <div class="kpi"><span class="label">预计处理剩余</span><span class="value" id="eta">计算中…</span></div>
            </div>
            <div class="secondary"><span id="average">已接收 0.0 MiB</span><span>· 已运行 <span id="elapsed">00:00</span></span><span id="finish-time"></span></div>
            <div id="control" class="control">等待开始</div>
            <div class="chart-block" id="throughput-block"><div class="chart-head"><strong>接收吞吐 · 最近 60 秒</strong><span id="throughput-summary"></span></div>
              <p id="sample-hint" class="sample-hint">正在采样媒体响应…</p>
              <svg id="chart" class="chart" viewBox="0 0 340 58" preserveAspectRatio="none" aria-hidden="true" hidden><path d="M0 54H340M0 30H340M0 6H340" stroke="var(--line)"/><polyline id="spark" fill="none" stroke="var(--accent)" stroke-width="2" points=""/></svg>
              <div id="throughput-axis" class="chart-axis" hidden><span>−60 秒</span><span id="throughput-scale">MiB/s</span><span>现在</span></div>
              <div id="meter-note" class="control"></div>
            </div>
            <div class="chart-block" id="forecast-block" hidden><div class="chart-head"><strong>剩余任务预测</strong><span id="forecast-count"></span></div>
              <svg id="forecast-chart" class="chart" viewBox="0 0 340 58" preserveAspectRatio="none" aria-hidden="true"><path d="M0 54H340" stroke="var(--line)"/><polyline id="forecast-actual" fill="none" stroke="var(--accent)" stroke-width="2" points=""/><line id="forecast-now" y1="6" y2="54" stroke="var(--line)" stroke-dasharray="2 3"/><line id="forecast-future" stroke="var(--info)" stroke-width="2" stroke-dasharray="4 4"/><text id="forecast-now-label" y="12" fill="var(--muted)" font-size="8">现在</text></svg>
              <div class="chart-axis"><span id="forecast-window">近期</span><span>实线：实际 · 虚线：预测</span><span id="forecast-time">预计结束</span></div>
            </div>
            <details id="advanced" class="chart-block" hidden><summary>并发与任务处理分布</summary>
              <div class="chart-head" style="margin-top:8px"><strong>并发趋势 · 最近 60 秒</strong><span>目标 / 活跃</span></div>
              <svg id="concurrency-chart" class="chart" viewBox="0 0 340 58" preserveAspectRatio="none" aria-hidden="true"><path d="M0 54H340" stroke="var(--line)"/><polyline id="worker-target" fill="none" stroke="var(--accent)" stroke-width="2" points=""/><polyline id="worker-active" fill="none" stroke="var(--info)" stroke-width="2" points=""/></svg>
              <div class="chart-axis"><span>−60 秒</span><span id="worker-scale">任务数</span><span>现在</span></div>
              <div class="chart-head" style="margin-top:12px"><strong>任务处理分布</strong><span id="queue-label"></span></div>
              <div id="queue-bar" class="segments" role="img" aria-label="任务处理分布"><span id="queue-done" class="done"></span><span id="queue-working" class="working"></span><span id="queue-pending" class="pending"></span></div>
              <div class="chart-axis"><span id="queue-done-label">已处理 0</span><span id="queue-working-label">处理中 0</span><span id="queue-pending-label">待处理 0</span></div>
            </details>
          </div>
          <div class="stats" id="prompt-stats" hidden>
            <div class="stat"><span class="label">已读取会话</span><span class="value" id="conversations">0 / —</span></div>
            <div class="stat"><span class="label">已恢复提示词</span><span class="value" id="resolved">0 / —</span></div>
            <div class="stat"><span class="label">全部 / 本次分组</span><span class="value" id="groups">— / —</span></div>
            <div class="stat"><span class="label">本次${mediaLabel}</span><span class="value" id="selected-images">—</span></div>
          </div>
          <div class="status" id="prompt-errors" hidden><span id="prompt-error-count"></span><span id="prompt-save-error-count"></span></div>
          <div class="status" id="status" hidden><span id="queued">0 已排队</span><span id="failed">0 原图失败</span><span id="retrying">0 正在恢复</span><span id="warnings">0 条警告</span></div>
          <div id="alert" class="recovery warning" hidden></div>
          <div id="recovery" class="recovery" hidden>网络暂时不可用，任务会等待并继续，不会立即计为失败。</div>
          <div id="message" class="message" role="status" aria-live="polite">正在准备导出…</div>
          <div class="foot">“已排队”表示 Chrome 已接收任务；最终写盘状态请查看浏览器下载记录。</div>
        </div>
      </section>`;
    const el = id => root.getElementById(id);
    const monitor = createDisplayTelemetry({ now });
    let state = {}, collapsed = false;
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
      const transfer = monitor.observe(state);
      const displayCompleted = promptStage ? state.resolvedImages || 0 : completed;
      const displayTotal = promptStage ? state.totalImages : total;
      const percent = displayTotal > 0 ? Math.min(100, displayCompleted / displayTotal * 100) : state.finished && phase === 'complete' ? 100 : 0;
      const promptPhase = { prompts: '恢复提示词', grouping: '构建分组', 'prompt-save': '保存提示词' }[state.stage];
      const phaseLabels = { preparing: '准备中', collecting: '读取列表', transferring: mediaLabel === '图片' ? '下载原图' : `下载${mediaLabel}`, cooldown: '等待恢复',
        backoff: '降低速度', recovering: '恢复中', finalizing: '整理结果', complete: '已完成',
        'completed with issues': '完成但有问题', blocked: '已阻止', error: '发生错误', prompts: '恢复提示词' };
      const phaseLabel = promptStage && !state.finished ? promptPhase : phaseLabels[phase] || String(phase);
      el('phase').textContent = phaseLabel;
      el('title').textContent = state.finished ? (phase === 'complete' ? '导出完成' : phase === 'completed with issues' ? '导出完成，但需要处理' : '导出已停止')
        : promptStage ? promptPhase : phase === 'finalizing' ? '正在整理结果' :
          state.stage === 'images' ? (mediaLabel === '图片' ? '正在下载原图' : `正在下载${mediaLabel}`) : '正在建立任务清单';
      el('phase').className = ['blocked', 'error', 'completed with issues', 'cooldown'].includes(phase) ? 'badge warning' : 'badge';
      el('mode').textContent = promptStage ? promptModeLabel : state.mode === 'manual' ? '手动并发' : '自动调节并发';
      const hasTotal = Number.isFinite(displayTotal);
      el('count').textContent = hasTotal ? displayCompleted.toLocaleString() :
        promptStage ? '正在读取会话' : '正在建立任务清单';
      el('total').textContent = hasTotal ? ` / ${displayTotal.toLocaleString()} ${promptStage ? '条提示词' : '项已处理'}` : '';
      el('percent').textContent = hasTotal ? `${percent.toFixed(1)}%` : '';
      el('bar').style.width = `${percent}%`; el('track').setAttribute('aria-valuenow', String(percent));
      el('track').setAttribute('aria-label', promptStage ? '提示词恢复进度' : `${mediaLabel}任务进度`);
      el('track').hidden = !hasTotal;
      // SVG does not implement HTMLElement.hidden in every supported browser.
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
      const shownSpeed = transfer?.currentRate || 0;
      const etaMs = transfer?.etaMs ?? null;
      el('speed').textContent = state.finished ? '—' : transfer?.peakRate > 0
        ? `${(shownSpeed / 1048576).toFixed(1)} MiB/s` : '采样中';
      el('average').textContent = `已接收 ${size(state.bytes || 0)} · 平均 ${((transfer?.averageRate || 0) / 1048576).toFixed(1)} MiB/s`;
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
      el('eta').textContent = state.finished ? '—' : ['cooldown', 'backoff', 'recovering'].includes(phase) || state.retrying
        ? '等待恢复' : total == null ? '待确定' : total === 0 ? '无需处理' :
          completed >= total ? '整理结果' : etaMs === null ? '计算中…' : `≈ ${duration(etaMs)}`;
      el('finish-time').textContent = etaMs === null || state.finished ? '' :
        `· 预计本轮处理至 ${new Date(transfer.finishAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
      const samplePoints = transfer?.samples || [];
      const hasSamples = samplePoints.length > 1 && transfer.peakRate > 0;
      if (hasSamples && !promptStage) {
        const scale = Math.max(1, transfer.peakRate);
        el('spark').setAttribute('points', samplePoints.map(item =>
          `${Math.max(0, 340 - (transfer.now - item.time) / 60000 * 340).toFixed(1)},${(54 - item.rate / scale * 48).toFixed(1)}`).join(' '));
        el('chart').removeAttribute('hidden');
      } else el('chart').setAttribute('hidden', '');
      el('sample-hint').hidden = hasSamples;
      el('throughput-axis').hidden = !hasSamples;
      el('throughput-scale').textContent = `0–${(transfer?.peakRate / 1048576 || 0).toFixed(1)} MiB/s`;
      el('throughput-summary').textContent = hasSamples
        ? `均值 ${(transfer.averageRate / 1048576).toFixed(1)} · 峰值 ${(transfer.peakRate / 1048576).toFixed(1)} MiB/s` : '';
      el('meter-note').textContent = provider === 'ChatGPT' ? '按原图响应字节采样' :
        '按媒体读取完成时间计入字节；曲线不代表瞬时网速';
      const forecast = transfer && etaMs !== null && Number.isFinite(total) && total > 0 &&
        transfer.remainingHistory.length > 1 && !state.finished;
      el('forecast-block').hidden = !forecast || promptStage;
      if (forecast) {
        const left = Math.max(transfer.remainingHistory[0].time, transfer.now - 60000);
        const span = Math.max(1, transfer.finishAt - left);
        const x = time => Math.max(0, Math.min(340, (time - left) / span * 340));
        const y = remaining => 54 - Math.max(0, Math.min(1, remaining / total)) * 48;
        const actual = transfer.remainingHistory.filter(point => point.time >= left);
        actual.push({ time: transfer.now, remaining: transfer.remaining });
        el('forecast-actual').setAttribute('points', actual.map(point =>
          `${x(point.time).toFixed(1)},${y(point.remaining).toFixed(1)}`).join(' '));
        el('forecast-future').setAttribute('x1', x(transfer.now).toFixed(1));
        el('forecast-future').setAttribute('y1', y(transfer.remaining).toFixed(1));
        el('forecast-future').setAttribute('x2', '340');
        el('forecast-future').setAttribute('y2', '54');
        el('forecast-now').setAttribute('x1', x(transfer.now).toFixed(1));
        el('forecast-now').setAttribute('x2', x(transfer.now).toFixed(1));
        el('forecast-now-label').setAttribute('x', Math.min(310, x(transfer.now) + 3).toFixed(1));
        el('forecast-window').textContent = `−${Math.ceil((transfer.now - left) / 1000)} 秒`;
        el('forecast-count').textContent = `剩余 ${transfer.remaining.toLocaleString()} 项`;
        el('forecast-time').textContent = `约 ${new Date(transfer.finishAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
      }
      el('advanced').hidden = promptStage || !Number.isFinite(total) || total <= 0 || !transfer;
      if (transfer && Number.isFinite(total) && total > 0) {
        const points = transfer.concurrencyHistory;
        const scale = Math.max(1, ...points.map(point => Math.max(point.target, point.active)));
        const x = time => Math.max(0, 340 - (transfer.now - time) / 60000 * 340);
        const y = value => 54 - value / scale * 48;
        el('worker-target').setAttribute('points', points.map(point =>
          `${x(point.time).toFixed(1)},${y(point.target).toFixed(1)}`).join(' '));
        el('worker-active').setAttribute('points', points.map(point =>
          `${x(point.time).toFixed(1)},${y(point.active).toFixed(1)}`).join(' '));
        el('worker-scale').textContent = `0–${scale} 个任务`;
        const done = Math.max(0, Math.min(total, completed));
        const working = Math.max(0, Math.min(total - done, active));
        const pending = Math.max(0, total - done - working);
        for (const [key, value] of [['done', done], ['working', working], ['pending', pending]])
          el(`queue-${key}`).style.width = `${value / total * 100}%`;
        el('queue-label').textContent = `${done}/${total} 项已处理`;
        el('queue-done-label').textContent = `已处理 ${done}`;
        el('queue-working-label').textContent = `处理中 ${working}`;
        el('queue-pending-label').textContent = `待处理 ${pending}`;
        el('queue-bar').setAttribute('aria-label', `已处理 ${done}，处理中 ${working}，待处理 ${pending}`);
      }
      const statusLabels = { queued: '已排队', failed: mediaLabel === '图片' ? '原图失败' : `${mediaLabel}失败`, retrying: '正在恢复', warnings: '条警告' };
      for (const key of ['queued', 'failed', 'retrying', 'warnings']) {
        el(key).textContent = `${state[key] || 0} ${statusLabels[key]}`;
        el(key).hidden = !(state[key] > 0);
        el(key).className = key === 'failed' && state[key] ? 'danger' :
          key === 'retrying' && state[key] ? 'info' : key === 'warnings' && state[key] ? 'warning' : '';
      }
      el('status').hidden = !['queued', 'failed', 'retrying', 'warnings'].some(key => state[key] > 0);
      el('alert').hidden = !(state.failed > 0);
      el('alert').textContent = state.failed > 0
        ? `${state.failed} 个${mediaLabel}任务失败；本轮结束后可在导出设置中恢复失败任务。` : '';
      const recovering = (state.retrying || 0) > 0 || ['cooldown', 'backoff', 'recovering'].includes(phase) ||
        /backoff|Transient request errors|暂时性请求错误/i.test(rawReason);
      el('recovery').hidden = !recovering;
      el('recovery').textContent = (state.retrying || 0) > 0
        ? `${state.retrying} 个${mediaLabel}任务正在等待或恢复。暂时错误不会立即计入失败。`
        : '请求速度已自动降低，网络恢复后会继续。';
      if (patch.message !== undefined) el('message').textContent = patch.message;
      el('close').disabled = !state.finished;
      el('compact').textContent = promptStage
        ? `${displayCompleted}/${displayTotal ?? '—'} 条提示词 · ${state.processedConversations || 0}/${state.totalConversations ?? '—'} 个会话 · ${state.finished ? phaseLabel : promptPhase}`
        : `${completed}/${total ?? '—'} · ${(shownSpeed / 1048576).toFixed(1)} MiB/s · ${state.finished ? phaseLabel : `剩余 ${etaMs === null ? '计算中' : duration(etaMs)}`}`;
    }
    return { update, destroy() { observer.disconnect(); media?.removeEventListener?.('change', syncTheme); host.remove(); } };
  }
  const api = { createMeter, createDisplayTelemetry, createPanel, duration, size };
  globalThis.ChatGPTDownloadProgress = api;
  if (typeof module !== 'undefined') module.exports = api;
})();
