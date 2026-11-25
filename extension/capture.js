// PinBoardLock — 在 AI 聊天页（ChatGPT、Claude、Gemini、DeepSeek、Kimi、豆包……，名单在 manifest.json）里认调研单。
// 只看页面里的 <pre> 代码块，不依赖某一家的页面结构；哪家不是用 <pre> 显示代码的就认不到，那就复制后在侧边栏按 Ctrl+V。
// AI 按规格回了一个 JSON 代码块 → 等它写完 → 整段能解析成调研单 → 交给后台脚本存进调研单文件夹。
// 同一份内容只收一次（后台记着），所以翻回旧对话不会重复存。
(() => {
  'use strict';
  if (window.top !== window) return;

  const STABLE_MS = 1500;       // 代码块的字这么久没变，才当它写完了
  const state = new WeakMap();  // pre → { text, t, done }
  let timer = 0;
  let dead = false;

  function schedule(ms) {
    if (dead || timer) return;
    timer = setTimeout(() => { timer = 0; scan(); }, ms);
  }

  function scan() {
    let again = false;
    let pres;
    try { pres = document.querySelectorAll('pre'); } catch (e) { return; }
    for (const pre of pres) {
      const code = pre.querySelector('code') || pre;
      const text = code.textContent || '';
      if (text.length < 40 || text.length > 300000 || text.indexOf('"groups"') === -1) continue;
      let s = state.get(pre);
      if (!s || s.text !== text) { state.set(pre, { text, t: Date.now(), done: false }); again = true; continue; }
      if (s.done) continue;
      if (Date.now() - s.t < STABLE_MS) { again = true; continue; }
      s.done = true;
      const sheets = PBLSheet.sheetsFromJson(text);
      if (!sheets.length) continue;
      const plain = sheets.map(PBLSheet.toPlain);
      send(plain, PBLSheet.hashId(JSON.stringify(plain)));
    }
    if (again) schedule(600);
  }

  function send(sheets, key) {
    try {
      chrome.runtime.sendMessage({ type: 'pbl-capture', key, sheets, source: location.hostname }).then((r) => {
        if (!r || !r.ok || r.known) return;
        const names = (r.titles || []).map((t) => '「' + t + '」').join('');
        toast(r.where === 'folder'
          ? '已收下调研单' + names + '，存进了调研单文件夹。到侧边栏点“刷新”就能用。'
          : '已收下调研单' + names + '，直接放进了插件（本机小程序没装，没存成文件）。');
      }, () => { /* 后台没回应：忽略 */ });
    } catch (e) {
      if (String(e && e.message).indexOf('Extension context invalidated') !== -1) dead = true;
    }
  }

  let toastHost = null;
  function toast(text) {
    if (!toastHost) {
      toastHost = document.createElement('div');
      toastHost.id = 'pbl-capture-host';
      const root = toastHost.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = ':host{all:initial}.t{position:fixed;right:18px;bottom:18px;z-index:2147483600;max-width:360px;padding:9px 12px 9px 11px;'
        + 'font:13px/1.45 "Segoe UI","Microsoft YaHei UI",system-ui,sans-serif;color:#16140F;background:#F6F1E6;border:1.5px solid #16140F;'
        + 'border-left:5px solid #1E7A4C;box-shadow:3px 3px 0 #16140F;opacity:0;transform:translateY(6px);transition:opacity .15s,transform .15s;cursor:pointer}'
        + '.t.show{opacity:1;transform:none}.k{font:700 10px/1 "Cascadia Mono",Consolas,monospace;letter-spacing:.1em;color:#7A7468;display:block;margin-bottom:3px}';
      const box = document.createElement('div');
      box.className = 't';
      box.title = '点一下关掉';
      box.addEventListener('click', () => box.classList.remove('show'));
      root.append(style, box);
      (document.body || document.documentElement).appendChild(toastHost);
    }
    const box = toastHost.shadowRoot.querySelector('.t');
    box.textContent = '';
    const k = document.createElement('span');
    k.className = 'k';
    k.textContent = 'PINBOARDLOCK';
    box.append(k, document.createTextNode(text));
    requestAnimationFrame(() => box.classList.add('show'));
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => box.classList.remove('show'), 7000);
  }

  const start = () => {
    try { new MutationObserver(() => schedule(500)).observe(document.documentElement, { childList: true, subtree: true, characterData: true }); } catch (e) { /* ignore */ }
    schedule(800);
  };
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
