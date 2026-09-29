/* Shared settings and progress surfaces for Grok and Gemini. */
(() => {
  function dialog(provider, scope) {
    const host = document.createElement('div');
    host.id = `grid-${provider.toLowerCase()}-dialog`;
    host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:9999999';
    const shadow = host.attachShadow({ mode: 'open' });
    const gemini = provider === 'Gemini';
    shadow.innerHTML = `<style>
      :host{--bg:#f8f8f8;--text:#1d1d1f;--muted:#6e6e73;--field:#fff;--border:#c7c7cc;--group:#eee;--accent:#087a58;--on:#fff;font:13px/1.45 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;color-scheme:light}
      @media(prefers-color-scheme:dark){:host{--bg:#262628;--text:#f5f5f7;--muted:#a1a1a6;--field:#1c1c1e;--border:#646468;--group:#353538;--accent:#64d2a3;--on:#082d20;color-scheme:dark}}
      *{box-sizing:border-box}dialog{position:fixed;inset:0;margin:auto;width:min(560px,calc(100vw - 28px));max-width:none;max-height:calc(100dvh - 24px);overflow:auto;border:1px solid var(--border);border-radius:18px;padding:0;background:var(--bg);color:var(--text);box-shadow:0 28px 90px #0006;font:inherit}dialog::backdrop{background:#050d09a6}
      .panel{padding:20px}.header{display:flex;align-items:center;gap:9px;margin-bottom:12px}.icon{display:grid;place-items:center;width:34px;height:34px;border-radius:9px;background:var(--group);color:var(--accent);font-size:20px}h2{margin:0;font-size:18px}.close{margin-left:auto;border:0;background:transparent;font-size:22px}p{margin:0 0 12px;color:var(--muted)}.section{margin-top:10px;padding:12px 13px;border:1px solid var(--border);border-radius:12px;background:var(--group)}.grid{display:grid;grid-template-columns:minmax(0,1fr) 140px;gap:10px}label{display:block;font-size:12px;font-weight:600;margin:0 0 5px}input,select,button{font:inherit}input:not([type=checkbox]):not([type=file]),select{width:100%;min-height:36px;padding:7px 10px;border:1px solid var(--border);border-radius:8px;background:var(--field);color:var(--text)}button{min-height:36px;padding:7px 12px;border:1px solid var(--border);border-radius:8px;background:var(--field);color:var(--text);font-weight:600;cursor:pointer}button:disabled{opacity:.6;cursor:default}.toggle{display:flex;align-items:center;justify-content:space-between;margin-top:10px}.toggle label{margin:0}.toggle input{appearance:none;width:38px;height:22px;border-radius:99px;background:#8e8e93;position:relative;cursor:pointer}.toggle input:before{content:'';position:absolute;left:2px;top:2px;width:18px;height:18px;border-radius:50%;background:#fff;transition:transform .18s}.toggle input:checked{background:var(--accent)}.toggle input:checked:before{transform:translateX(16px)}.checks{display:flex;gap:16px;margin-top:10px}.checks label{display:flex;align-items:center;gap:5px}.hint{font-size:12px;color:var(--muted);margin:8px 0 0}details summary{cursor:pointer;font-weight:650}details .grid{margin-top:12px}.error{min-height:18px;color:#bb382d;font-size:12px;margin-top:10px;overflow-wrap:anywhere}.open-folder{width:100%;border:0;background:transparent;margin-top:8px}footer{display:flex;justify-content:flex-end;gap:8px;margin-top:12px;padding-top:12px;border-top:1px solid var(--border)}.primary{background:var(--accent);color:var(--on);border-color:transparent}[hidden]{display:none!important}@media(max-width:520px){.grid{grid-template-columns:1fr}}
    </style><dialog aria-labelledby="title"><div class="panel">
      <header class="header"><span class="icon" aria-hidden="true">↓</span><h2 id="title">GRID · ${provider}</h2><button class="close" id="close" aria-label="关闭导出设置">×</button></header>
      <p>${gemini ? 'Gemini Library 图片' : scope === 'liked' ? 'Grok 已收藏作品' : 'Grok 我的作品'}。原始媒体、提示词和结果报告保存在浏览器下载目录。</p>
      <section class="section"><div class="grid"><div><label for="folder">下载子目录</label><input id="folder" autocomplete="off" spellcheck="false" value="${gemini ? 'gemini-images' : 'grok-media'}"></div><div><label for="mode">续传起点</label><select id="mode"><option value="auto">自动识别</option><option value="manual">手动编号</option></select></div></div>
        <div id="after-row" hidden><label for="after">编号之后</label><input id="after" type="number" min="0" max="999999" step="1" value="0"></div><p id="progress" class="hint" role="status"></p>
        <div class="toggle"><label for="prompts">同时恢复并整理提示词</label><input id="prompts" type="checkbox" aria-label="同时恢复并整理提示词"></div>
        <div class="checks" ${gemini ? 'hidden' : ''}><label><input id="images" type="checkbox" checked>图片</label><label><input id="videos" type="checkbox" checked>视频</label></div>
      </section>
      <section class="section"><details><summary>从结果报告恢复失败任务</summary><input id="retry-report" type="file" aria-label="选择结果报告"></details><p id="retry-hint" class="hint"></p></section>
      <details class="section"><summary>性能设置（推荐保持自动）</summary><div class="grid"><div><label for="concurrency-mode">${gemini ? '图片' : '媒体'}下载并发</label><select id="concurrency-mode"><option value="auto">自动调节</option><option value="manual">手动设置</option></select></div><div id="concurrency-row" hidden><label for="concurrency">并发数量</label><input id="concurrency" type="number" min="1" max="12" step="1" value="6"></div></div></details>
      <button class="open-folder" id="show-folder">打开浏览器下载目录</button><div id="error" class="error" role="alert"></div>
      <footer><button id="cancel">取消</button><button id="start" class="primary" disabled>开始导出</button></footer>
    </div></dialog>`;
    document.body.appendChild(host);
    const el = id => shadow.getElementById(id);
    const popup = shadow.querySelector('dialog');
    return { host, dialog: popup, el, close() { if (popup.open) popup.close(); host.remove(); } };
  }
  function progress(provider, onClose) {
    const host = document.createElement('div');
    host.id = `grid-${provider.toLowerCase()}-progress`;
    host.style.cssText = 'all:initial;position:fixed;right:24px;bottom:24px;z-index:9999999';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>:host{font:13px/1.5 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;color-scheme:light}@media(prefers-color-scheme:dark){:host{color-scheme:dark}}.panel{width:min(360px,calc(100vw - 48px));padding:18px;border:1px solid #8885;border-radius:16px;background:Canvas;color:CanvasText;box-shadow:0 8px 32px #0005}header{display:flex;justify-content:space-between;gap:10px}strong{font-size:14px}button{border:0;background:transparent;color:inherit;font-size:20px;cursor:pointer}.message{margin:12px 0;color:GrayText;overflow-wrap:anywhere}.track{height:7px;background:#8884;border-radius:6px;overflow:hidden}.fill{height:100%;width:0;background:#087a58;transition:width .2s}.counts{margin-top:10px;font-size:12px;font-variant-numeric:tabular-nums}</style><section class="panel" role="region" aria-label="${provider} 导出进度"><header><strong>GRID · ${provider} 导出</strong><button id="close" aria-label="关闭进度" disabled>×</button></header><div id="message" class="message" role="status">准备中…</div><div class="track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div id="fill" class="fill"></div></div><div id="counts" class="counts">等待媒体列表</div></section>`;
    document.body.appendChild(host);
    const el = id => root.getElementById(id);
    el('close').onclick = () => { host.remove(); onClose(); };
    return { update(message, state = {}) {
      el('message').textContent = message;
      if (Number.isFinite(state.total)) {
        const done = Math.min(state.total, state.processed || 0);
        const pct = state.total ? Math.round(done / state.total * 100) : 100;
        el('fill').style.width = `${pct}%`;
        el('fill').parentElement.setAttribute('aria-valuenow', String(pct));
        el('counts').textContent = `${done}/${state.total} 已处理 · ${state.completed || 0} 已完成 · ${state.failed || 0} 失败${Number.isFinite(state.limit) ? ` · ${state.active || 0}/${state.limit} 并发` : ''}`;
      }
    }, finish() { el('close').disabled = false; } };
  }
  globalThis.GRIDMediaExportUI = { dialog, progress };
  if (typeof module !== 'undefined') module.exports = { dialog, progress };
})();
