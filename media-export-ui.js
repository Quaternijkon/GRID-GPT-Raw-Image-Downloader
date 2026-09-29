/* Grok and Gemini settings use the ChatGPT panel layout and progress dashboard. */
(() => {
  function pageTheme() {
    for (const node of [document.documentElement, document.body]) {
      if (!node) continue;
      const declared = node.getAttribute?.('data-theme') || node.getAttribute?.('data-color-mode');
      if (declared === 'dark' || declared === 'light') return declared;
      if (node.classList?.contains('dark')) return 'dark';
      if (node.classList?.contains('light')) return 'light';
    }
    if (document.documentElement && typeof getComputedStyle === 'function') {
      const schemes = String(getComputedStyle(document.documentElement).colorScheme || '')
        .split(/\s+/).filter(value => value === 'dark' || value === 'light');
      if (schemes.length === 1) return schemes[0];
    }
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function dialog(provider, scope) {
    const gemini = provider === 'Gemini';
    const defaultFolder = gemini ? 'gemini-images' : 'grok-media';
    const context = gemini ? 'Gemini Library 图片' :
      scope === 'liked' ? 'Grok 已收藏作品' : 'Grok 我的作品';
    const host = document.createElement('div');
    host.id = `grid-${provider.toLowerCase()}-dialog`;
    host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483646';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>
      :host{--dl-scheme:light;--dl-bg:rgba(248,248,248,.94);--dl-text:#1d1d1f;--dl-muted:#6e6e73;--dl-input:rgba(255,255,255,.82);--dl-border:rgba(60,60,67,.22);--dl-separator:rgba(60,60,67,.14);--dl-secondary:rgba(118,118,128,.12);--dl-hover:rgba(118,118,128,.18);--dl-accent:#087a58;--dl-accent-hover:#066a4c;--dl-on-accent:#fff;--dl-error:#b42318;--dl-error-bg:#fff1ef;--dl-icon-bg:#e3f3eb;--dl-group:rgba(118,118,128,.08);color-scheme:light;font:400 13px/1.45 -apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif}
      :host([data-theme="dark"]){--dl-scheme:dark;--dl-bg:rgba(38,38,40,.94);--dl-text:#f5f5f7;--dl-muted:#a1a1a6;--dl-input:rgba(28,28,30,.88);--dl-border:rgba(235,235,245,.22);--dl-separator:rgba(235,235,245,.13);--dl-secondary:rgba(118,118,128,.24);--dl-hover:rgba(118,118,128,.32);--dl-accent:#64d2a3;--dl-accent-hover:#7ce0b6;--dl-on-accent:#082d20;--dl-error:#ffb4ab;--dl-error-bg:#442b29;--dl-icon-bg:#264638;--dl-group:rgba(118,118,128,.16);color-scheme:dark}
      *,*::before,*::after{box-sizing:border-box}dialog{position:fixed;inset:0;margin:auto;padding:0;width:min(560px,calc(100vw - 28px));max-width:none;max-height:calc(100dvh - 24px);overflow:auto;overscroll-behavior:contain;border:1px solid var(--dl-border);border-radius:18px;background:var(--dl-bg);color:var(--dl-text);color-scheme:var(--dl-scheme);backdrop-filter:blur(30px) saturate(1.35);-webkit-backdrop-filter:blur(30px) saturate(1.35);box-shadow:0 28px 90px #0005;font:inherit;text-align:left;direction:ltr}dialog::backdrop{background:rgba(5,13,9,.65)}.panel{padding:17px 20px 16px}.header{display:flex;gap:9px;align-items:center;margin-bottom:12px}.icon{display:grid;place-items:center;width:34px;height:34px;flex:none;color:var(--dl-accent);background:var(--dl-icon-bg);border-radius:9px}.icon svg,.open-folder svg,.close svg{width:18px;height:18px;display:block}h2{margin:0;color:var(--dl-text);font-size:18px;font-weight:680;line-height:1.2}.context{margin:0 0 12px;color:var(--dl-muted);font-size:12px}.section{margin-top:10px;padding:12px 13px;border:1px solid var(--dl-separator);border-radius:12px;background:var(--dl-group)}.field-grid{display:grid;grid-template-columns:minmax(0,1fr) 112px;gap:10px;align-items:end}.field{margin-top:10px}.hint{margin:6px 0 0;color:var(--dl-muted);font-size:12px}.recovery-list{display:grid;gap:7px}h3{margin:0 0 9px;font-size:13px;font-weight:650}details>summary{cursor:pointer;color:var(--dl-text);font-weight:650;list-style:none}details>summary::-webkit-details-marker{display:none}details>summary::after{content:'＋';float:right;color:var(--dl-muted)}details[open]>summary::after{content:'−'}.report-picker{margin-top:12px;padding-top:12px;border-top:1px solid var(--dl-separator)}.report-picker input{min-height:40px;padding:7px 9px;margin-top:10px}.parallel{display:flex;align-items:center;gap:14px;margin:10px 0 0}.parallel>div{flex:1}.parallel label{margin:0}.parallel select{width:150px;max-width:55%;flex:none}.parallel input{width:88px;flex:none;text-align:center}label{display:block;color:var(--dl-text);font-size:12px;font-weight:600;margin-bottom:5px}input,button,select{font:inherit;letter-spacing:normal}input:not([type=checkbox]),select{display:block;width:100%;min-width:0;min-height:36px;padding:7px 10px;border:1px solid var(--dl-border);border-radius:8px;background:var(--dl-input);color:var(--dl-text);-webkit-text-fill-color:var(--dl-text);caret-color:var(--dl-accent);color-scheme:inherit}.parallel select{width:150px}.parallel input{width:88px}input:disabled{color:var(--dl-muted);-webkit-text-fill-color:var(--dl-muted);cursor:wait}input:focus-visible,button:focus-visible,select:focus-visible{outline:2px solid var(--dl-accent);outline-offset:3px}button{appearance:none;display:inline-flex;justify-content:center;align-items:center;min-height:36px;padding:7px 12px;border:1px solid var(--dl-border);border-radius:8px;background:var(--dl-secondary);color:var(--dl-text);font-weight:600;cursor:pointer}button:hover:not(:disabled){background:var(--dl-hover)}button:disabled{opacity:.65;cursor:wait}.close{margin-left:auto;min-width:36px;border-color:transparent;background:transparent;color:var(--dl-muted)}.prompt-toggle{display:flex;align-items:center;justify-content:space-between;width:100%;min-height:32px;text-align:left;border:0;background:transparent;margin-top:10px;padding:0}.prompt-toggle:hover:not(:disabled){background:transparent}.switch{appearance:none;width:38px;height:22px;border:0;border-radius:999px;background:#8e8e93;position:relative;cursor:pointer;flex:none}.switch::after{content:'';position:absolute;width:18px;height:18px;left:2px;top:2px;border-radius:50%;background:#fff;box-shadow:0 1px 3px #0005;transition:transform .18s}.switch:checked{background:var(--dl-accent)}.switch:checked::after{transform:translateX(16px)}.checks{display:flex;gap:16px;align-items:center;margin-top:10px}.checks label{display:flex;align-items:center;gap:6px;margin:0}.checks input{accent-color:var(--dl-accent)}.recovery-action{width:100%;justify-content:flex-start;text-align:left}.open-folder{width:100%;gap:7px;font-size:12px;margin-top:10px;background:transparent;border-color:transparent}.actions{display:flex;justify-content:flex-end;gap:8px;margin-top:12px;padding-top:12px;border-top:1px solid var(--dl-separator)}.primary{min-width:120px;background:var(--dl-accent);color:var(--dl-on-accent);border-color:transparent}.primary:hover:not(:disabled){background:var(--dl-accent-hover)}.error{margin-top:14px;padding:10px 12px;border-radius:8px;background:var(--dl-error-bg);color:var(--dl-error);font-size:12px;overflow-wrap:anywhere}.error:empty{display:none}[hidden]{display:none!important}@media(max-width:520px){.panel{padding:18px}.field-grid{grid-template-columns:1fr}.parallel{align-items:flex-start;flex-direction:column;gap:8px}.parallel select,.parallel input{width:100%;max-width:none}.actions>button{flex:1;min-width:0}}@media(forced-colors:active){dialog,input,button,select{border:1px solid CanvasText}}
    </style><dialog aria-labelledby="title"><div class="panel">
      <header class="header"><span class="icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v11m-4-4 4 4 4-4M4 15v5h16v-5"/></svg></span><h2 id="title">GRID</h2><button type="button" class="close" id="close" aria-label="关闭导出设置"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m6 6 12 12M18 6 6 18"/></svg></button></header>
      <p class="context">${context}</p>
      <section class="section"><div class="field-grid"><div><label for="folder">下载子目录</label><input id="folder" type="text" placeholder="${defaultFolder}" value="${defaultFolder}" autocomplete="off" spellcheck="false"></div><div><label for="mode">续传起点</label><select id="mode"><option value="auto">自动识别</option><option value="manual">手动编号</option></select></div></div>
        <div class="field" id="after-row" hidden><label for="after">编号之后</label><input id="after" type="number" min="0" max="999999" step="1" value="0"></div><p id="progress" class="hint" role="status" aria-live="polite"></p>
        <label class="prompt-toggle" for="prompts"><span>同时恢复并整理提示词</span><input id="prompts" class="switch" type="checkbox" aria-label="同时恢复并整理提示词"></label>
        <div class="checks" ${gemini ? 'hidden' : ''}><label><input id="images" type="checkbox" checked>图片</label><label><input id="videos" type="checkbox" checked>视频</label></div>
      </section>
      <section class="section"><h3>恢复失败任务</h3><div class="recovery-list"><button type="button" id="retry-images" class="recovery-action" hidden></button><button type="button" id="retry-prompts" class="recovery-action" hidden></button></div>
        <details class="report-picker"><summary>从结果报告恢复</summary><input id="retry-report" type="file" aria-label="选择结果报告"></details><p id="retry-hint" class="hint"></p></section>
      <details class="section"><summary>性能设置（推荐保持自动）</summary><div class="parallel"><div><label for="concurrency-mode">${gemini ? '图片' : '媒体'}下载并发</label></div><select id="concurrency-mode"><option value="auto">自动调节</option><option value="manual">手动设置</option></select></div><div class="parallel" id="concurrency-row" hidden><div><label for="concurrency">并发数量</label></div><input id="concurrency" type="number" min="1" max="12" step="1" value="6"></div></details>
      <button type="button" class="open-folder" id="show-folder"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h7l2 3h9v11H3z"/></svg>打开浏览器下载目录</button><p id="error" class="error" role="status" aria-live="polite"></p>
      <footer class="actions"><button type="button" id="cancel">取消</button><button type="button" id="start" class="primary" disabled>开始导出</button></footer>
    </div></dialog>`;
    const syncTheme = () => { host.dataset.theme = pageTheme(); };
    syncTheme();
    const observer = new MutationObserver(syncTheme);
    for (const node of [document.documentElement, document.body]) if (node)
      observer.observe(node, { attributes: true, attributeFilter: ['class', 'style', 'data-theme', 'data-color-mode'] });
    const systemTheme = window.matchMedia?.('(prefers-color-scheme: dark)');
    systemTheme?.addEventListener?.('change', syncTheme);
    document.body.appendChild(host);
    const el = id => shadow.getElementById(id);
    const popup = shadow.querySelector('dialog');
    return { host, dialog: popup, el, close() {
      observer.disconnect?.(); systemTheme?.removeEventListener?.('change', syncTheme);
      if (popup.open) popup.close(); host.remove();
    } };
  }

  function progress(provider, onClose, { concurrency = 'auto' } = {}) {
    const meter = globalThis.ChatGPTDownloadProgress.createMeter();
    const mediaLabel = provider === 'Grok' ? '媒体' : '图片';
    let lastBytes = 0, lastProcessed = 0, lastTotal = 0;
    let current = { stage: 'collecting', phase: 'collecting', mode: concurrency === 'auto' ? 'auto' : 'manual',
      completed: 0, failed: 0, queued: 0, warnings: 0 };
    let panel;
    panel = globalThis.ChatGPTDownloadProgress.createPanel({ provider, mediaLabel,
      promptModeLabel: '逐条读取会话', id: `grid-${provider.toLowerCase()}-progress`, theme: pageTheme,
      onClose: () => { panel.destroy(); onClose(); } });
    function update(message, patch = {}) {
      const stage = patch.stage || current.stage;
      if (Number.isFinite(patch.bytes) && patch.bytes > lastBytes) {
        meter.transfer(patch.bytes - lastBytes); lastBytes = patch.bytes;
      }
      if (stage === 'images' && Number.isFinite(patch.processed) && patch.processed > lastProcessed) {
        meter.complete(patch.processed - lastProcessed); lastProcessed = patch.processed;
      }
      if (stage === 'images' && Number.isFinite(patch.total)) lastTotal = patch.total;
      const transfer = meter.snapshot(lastTotal);
      current = { ...current, ...patch, stage,
        completed: stage === 'images' && Number.isFinite(patch.processed) ? patch.processed : current.completed,
        total: Number.isFinite(patch.total) ? patch.total : current.total,
        bytes: transfer.bytes, speed: transfer.speed, averageSpeed: transfer.averageSpeed,
        elapsedMs: transfer.elapsedMs, etaMs: transfer.etaMs,
        message };
      panel.update(current);
    }
    update('正在准备导出…');
    return { update, finish() {
      meter.stop();
      panel.update({ ...current, ...meter.snapshot(lastTotal), finished: true,
        phase: ['complete', 'completed with issues', 'blocked', 'error'].includes(current.phase) ? current.phase : 'error' });
    }, destroy() { panel.destroy(); } };
  }

  const api = { dialog, progress, pageTheme };
  globalThis.GRIDMediaExportUI = api;
  if (typeof module !== 'undefined') module.exports = api;
})();
