// PinBoardLock — 收藏夹选择面板。弹窗（popup）和页面内浮层共用这一份。
// 只读写 chrome.storage.local；真正去 Pinterest 取数据的是页面里的 inject.js。
const PBLPicker = (() => {
  'use strict';
  const S = chrome.storage.local;
  const KEYS = ['enabled', 'target', 'boards', 'username', 'boardsFetchedAt', 'boardsStatus', 'recent', 'log', 'sectionKey'];
  const VERSION = '0.5.0';

  const css = `
.pbl{--bg:#ECE6D8;--panel:#F6F1E6;--ink:#16140F;--mut:#7A7468;--acc:#E4451C;--ok:#1E7A4C;--warn:#B26A00;
  font:13px/1.35 "Segoe UI","Microsoft YaHei UI",system-ui,sans-serif;color:var(--ink);background:var(--bg);
  display:flex;flex-direction:column;width:100%;height:100%;max-height:560px;box-sizing:border-box;text-align:left}
.pbl *{box-sizing:border-box}
.pbl button{font:inherit;color:inherit;cursor:pointer}
.pbl .mono{font-family:"Cascadia Mono",Consolas,ui-monospace,monospace;font-size:10px;letter-spacing:.08em;text-transform:uppercase}
.pbl .head{display:flex;align-items:center;justify-content:space-between;padding:10px 12px 8px;border-bottom:1.5px solid var(--ink)}
.pbl .brand{font-family:"Cascadia Mono",Consolas,monospace;font-weight:700;font-size:12px;letter-spacing:.12em}
.pbl .brand i{color:var(--acc);font-style:normal}
.pbl .hbtn{border:1.5px solid var(--ink);background:var(--panel);padding:2px 9px;margin-left:auto;margin-right:8px;font-size:12px}
.pbl .hbtn:hover{background:var(--ink);color:var(--panel)}
.pbl .sw{display:flex;align-items:center;gap:6px;background:none;border:1.5px solid var(--ink);padding:2px 3px 2px 8px;border-radius:999px}
.pbl .sw b{width:26px;height:14px;border-radius:999px;background:var(--mut);position:relative;display:block}
.pbl .sw b::after{content:"";position:absolute;top:2px;left:2px;width:10px;height:10px;border-radius:50%;background:var(--panel);transition:left .12s}
.pbl .sw.on b{background:var(--acc)}
.pbl .sw.on b::after{left:14px}
.pbl .tgt{margin:10px 12px 8px;padding:9px 10px;background:var(--panel);border:1.5px solid var(--ink);box-shadow:3px 3px 0 var(--ink);display:flex;gap:10px;align-items:center}
.pbl .tgt.off{box-shadow:none;border-style:dashed;color:var(--mut)}
.pbl .tgt .t1{font-weight:600;font-size:14px;word-break:break-all}
.pbl .tgt .t2{color:var(--mut);margin-top:2px;font-size:12px}
.pbl .cv{width:34px;height:34px;flex:none;object-fit:cover;background:#D8D0BD;border:1px solid var(--ink);display:flex;align-items:center;justify-content:center;font-weight:700;color:var(--mut)}
.pbl .tgt .cv{width:44px;height:44px}
.pbl .tools{display:flex;gap:6px;padding:0 12px 8px}
.pbl .tools input{flex:1;min-width:0;font:inherit;color:var(--ink);padding:6px 8px;border:1.5px solid var(--ink);background:var(--panel);outline:none}
.pbl .tools input:focus{border-color:var(--acc)}
.pbl .btn{border:1.5px solid var(--ink);background:var(--panel);padding:5px 9px;white-space:nowrap}
.pbl .btn:hover{background:var(--ink);color:var(--panel)}
.pbl .btn[disabled]{opacity:.5;cursor:default}
.pbl .recent{display:flex;gap:5px;flex-wrap:wrap;padding:0 12px 8px;align-items:center}
.pbl .chip{border:1px solid var(--ink);background:none;padding:2px 7px;font-size:12px;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pbl .chip:hover{background:var(--ink);color:var(--panel)}
.pbl .hint{margin:0 12px 8px;padding:6px 8px;border-left:3px solid var(--warn);background:var(--panel);font-size:12px}
.pbl .hint.err{border-left-color:var(--acc)}
.pbl .list{flex:1;min-height:90px;overflow-y:auto;border-top:1.5px solid var(--ink);background:var(--panel)}
.pbl .row{display:flex;align-items:center;gap:9px;padding:6px 12px;border-bottom:1px solid #D8D0BD;cursor:pointer}
.pbl .row:hover{background:#EAE2CF}
.pbl .row.cur{background:var(--ink);color:var(--panel)}
.pbl .row.cur .meta{color:#BDB6A6}
.pbl .row .nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pbl .meta{color:var(--mut);font-size:11px;flex:none}
.pbl .exp{border:1px solid currentColor;background:none;padding:0 6px;font-size:11px;flex:none;line-height:18px}
.pbl .secs{padding:5px 12px 7px 55px;display:flex;gap:5px;flex-wrap:wrap;border-bottom:1px solid #D8D0BD;background:#EFE9DA}
.pbl .sec{border:1px solid var(--ink);background:var(--panel);padding:2px 8px;font-size:12px}
.pbl .sec:hover{background:#EAE2CF}
.pbl .sec.cur{background:var(--acc);color:#fff;border-color:var(--acc)}
.pbl .empty{padding:22px 14px;color:var(--mut);text-align:center}
.pbl .foot{border-top:1.5px solid var(--ink);padding:6px 12px;display:flex;align-items:center;gap:8px;color:var(--mut)}
.pbl .foot .sp{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pbl .lnk{background:none;border:none;padding:0;text-decoration:underline;color:var(--ink);font-size:11px}
.pbl .log{max-height:150px;overflow-y:auto;border-top:1px dashed var(--ink);padding:6px 12px;font-size:11px;background:var(--bg)}
.pbl .log div{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:1px 0}
.pbl .log .e{color:var(--acc)}
.pbl .log .m{color:var(--mut)}
`;

  function h(tag, attrs) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        const v = attrs[k];
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    for (let i = 2; i < arguments.length; i++) {
      const c = arguments[i];
      if (c == null || c === false) continue;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return el;
  }

  function label(t) {
    if (!t) return '';
    return t.sectionTitle ? t.boardName + ' / ' + t.sectionTitle : t.boardName;
  }

  function cover(url, name) {
    if (url) return h('img', { class: 'cv', src: url, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
    return h('div', { class: 'cv', text: (name || '?').slice(0, 1) });
  }

  function hhmm(t) {
    if (!t) return '';
    const d = new Date(t);
    const p = (n) => String(n).padStart(2, '0');
    return p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function mount(root) {
    let st = {};
    let q = '';
    let hint = null; // { text, err }
    let showLog = false;
    let alive = true;
    const open = new Set();

    const elSwitch = h('button', { class: 'sw', title: '开关锁定', onclick: () => S.set({ enabled: !(st.enabled !== false) }) },
      h('span', { class: 'mono', text: 'LOCK' }), h('b'));
    const elTarget = h('div', { class: 'tgt' });
    const elSearch = h('input', {
      type: 'text', placeholder: '搜收藏夹（Board）或分区（Section）', spellcheck: 'false',
      oninput: (e) => { q = e.target.value.trim().toLowerCase(); renderList(); },
    });
    const elRefresh = h('button', { class: 'btn', text: '刷新', title: '重新读取账号里的收藏夹', onclick: refresh });
    const elRecent = h('div', { class: 'recent' });
    const elHint = h('div', { class: 'hint', style: 'display:none' });
    const elList = h('div', { class: 'list' });
    const elFootText = h('span', { class: 'sp mono' });
    const elLog = h('div', { class: 'log', style: 'display:none' });
    const wrap = h('div', { class: 'pbl' },
      h('div', { class: 'head' }, h('div', { class: 'brand' }, 'PIN', h('i', { text: '/' }), 'BOARD', h('i', { text: '/' }), 'LOCK'),
        h('button', { class: 'hbtn', text: '调研单 ▸', title: '在侧边栏（Side Panel）里打开调研单：点关键词搜图，分区保存', onclick: openSheets }),
        elSwitch),
      elTarget,
      h('div', { class: 'tools' }, elSearch, elRefresh),
      elRecent,
      elHint,
      elList,
      h('div', { class: 'foot' },
        elFootText,
        h('button', { class: 'lnk', text: '记录', onclick: () => { showLog = !showLog; renderLog(); } }),
        h('button', { class: 'lnk', text: '复制诊断', onclick: copyDiag }),
        h('button', { class: 'lnk', text: '复制链接清单', onclick: copyLinks })),
      elLog);
    root.appendChild(wrap);

    // 侧边栏要在点击的同一轮里打开。弹窗里能直接调；页面里的面板得让后台脚本代开。
    let windowId = null;
    if (chrome.windows && chrome.windows.getCurrent) chrome.windows.getCurrent().then((w) => { windowId = w.id; }, () => {});
    function openSheets() {
      try {
        if (chrome.sidePanel && windowId != null) {
          chrome.sidePanel.open({ windowId }).then(() => window.close(), () => {});
        } else {
          chrome.runtime.sendMessage({ type: 'pbl-open-panel' });
        }
      } catch (e) { /* ignore */ }
    }

    function setTarget(t) {
      const same = (r) => r.boardId === t.boardId && (r.sectionId || '') === (t.sectionId || '');
      const recent = [t].concat((st.recent || []).filter((r) => !same(r))).slice(0, 6);
      S.set({ target: t, enabled: true, recent });
    }

    function refresh() {
      const now = Date.now();
      hint = null;
      S.set({ refreshRequest: now });
      setTimeout(() => {
        if (!alive) return;
        S.get(['boardsStatus']).then((v) => {
          const bs = v.boardsStatus;
          if (!bs || !(bs.t >= now)) {
            hint = { text: '没有页面响应。请先打开并登录 Pinterest 的网页，再点刷新。', err: false };
            render();
          }
        });
      }, 1600);
    }

    function flash(text) {
      hint = { text, err: false };
      renderHint();
      setTimeout(() => { if (hint && hint.text === text) { hint = null; renderHint(); } }, 2200);
    }

    function copyDiag() {
      const out = {
        version: VERSION,
        enabled: st.enabled !== false,
        hasTarget: !!st.target,
        targetHasSection: !!(st.target && st.target.sectionId),
        boards: (st.boards || []).length,
        boardsStatus: st.boardsStatus || null,
        sectionKey: st.sectionKey || 'section',
        log: st.log || [],
      };
      navigator.clipboard.writeText(JSON.stringify(out, null, 2)).then(() => flash('诊断信息已复制，可以直接贴给 Claude。'), () => flash('复制失败。'));
    }

    function copyLinks() {
      const lines = (st.boards || []).map((b) => b.name + '\t' + (b.url ? 'https://www.pinterest.com' + b.url : '') + '\t' + (b.privacy || ''));
      navigator.clipboard.writeText(lines.join('\n')).then(() => flash('已复制 ' + lines.length + ' 个收藏夹的名字和链接。'), () => flash('复制失败。'));
    }

    function renderTarget() {
      const on = st.enabled !== false;
      const t = st.target;
      elSwitch.className = 'sw' + (on ? ' on' : '');
      elTarget.className = 'tgt' + (on && t ? '' : ' off');
      elTarget.textContent = '';
      if (!t) {
        elTarget.appendChild(h('div', null,
          h('div', { class: 't1', text: '还没选收藏夹' }),
          h('div', { class: 't2', text: '从下面的列表里点一个，之后的“保存（Save）”都进它。' })));
        return;
      }
      elTarget.appendChild(cover(t.cover, t.boardName));
      elTarget.appendChild(h('div', null,
        h('div', { class: 'mono', text: on ? '锁定中 LOCKED' : '已暂停 PAUSED' }),
        h('div', { class: 't1', text: label(t) }),
        h('div', { class: 't2', text: on ? '点“保存”都进这里；下拉里手动选的不受影响。' : '现在按 Pinterest 自己的默认保存。' })));
    }

    function renderRecent() {
      elRecent.textContent = '';
      const list = (st.recent || []).filter((r) => !(st.target && r.boardId === st.target.boardId && (r.sectionId || '') === (st.target.sectionId || '')));
      elRecent.style.display = list.length ? '' : 'none';
      if (!list.length) return;
      elRecent.appendChild(h('span', { class: 'mono', text: '最近' }));
      for (const r of list.slice(0, 5)) {
        elRecent.appendChild(h('button', { class: 'chip', text: label(r), title: label(r), onclick: () => setTarget(r) }));
      }
    }

    function renderHint() {
      const bs = st.boardsStatus;
      let msg = hint;
      if (!msg && bs && bs.state === 'error') msg = { text: '读取收藏夹失败：' + (bs.msg || '未知原因'), err: true };
      if (!msg && bs && bs.state === 'ok' && bs.msg) msg = { text: bs.msg, err: false };
      elHint.style.display = msg ? '' : 'none';
      elHint.className = 'hint' + (msg && msg.err ? ' err' : '');
      elHint.textContent = msg ? msg.text : '';
    }

    function renderList() {
      elList.textContent = '';
      const boards = st.boards || [];
      const t = st.target;
      if (!boards.length) {
        const loading = st.boardsStatus && st.boardsStatus.state === 'loading';
        elList.appendChild(h('div', { class: 'empty', text: loading ? '正在读取收藏夹…' : '还没有收藏夹数据。打开并登录 Pinterest 网页后点“刷新”。' }));
        return;
      }
      let shown = 0;
      for (const b of boards) {
        const secs = b.sections || [];
        const nameHit = !q || b.name.toLowerCase().indexOf(q) !== -1;
        const secHit = q && secs.some((s) => s.title.toLowerCase().indexOf(q) !== -1);
        if (!nameHit && !secHit) continue;
        shown++;
        const isCurBoard = t && t.boardId === b.id;
        const row = h('div', {
          class: 'row' + (isCurBoard && !t.sectionId ? ' cur' : ''),
          title: '保存到「' + b.name + '」',
          onclick: () => setTarget({ boardId: b.id, boardName: b.name, boardUrl: b.url, cover: b.cover, sectionId: null, sectionTitle: null }),
        },
          cover(b.cover, b.name),
          h('div', { class: 'nm', text: b.name }),
          h('span', { class: 'meta', text: (b.privacy === 'secret' ? '私密 · ' : '') + (b.pinCount != null ? b.pinCount : '') }));
        const showSecs = secs.length && (open.has(b.id) || secHit || isCurBoard);
        if (secs.length) {
          row.appendChild(h('button', {
            class: 'exp', text: (showSecs ? '▾ ' : '▸ ') + secs.length, title: '分区（Section）',
            onclick: (e) => { e.stopPropagation(); if (open.has(b.id)) open.delete(b.id); else open.add(b.id); renderList(); },
          }));
        }
        elList.appendChild(row);
        if (showSecs) {
          const box = h('div', { class: 'secs' });
          for (const s of secs) {
            if (q && !nameHit && s.title.toLowerCase().indexOf(q) === -1) continue;
            box.appendChild(h('button', {
              class: 'sec' + (isCurBoard && t.sectionId === s.id ? ' cur' : ''), text: s.title,
              title: '保存到「' + b.name + ' / ' + s.title + '」',
              onclick: () => setTarget({ boardId: b.id, boardName: b.name, boardUrl: b.url, cover: b.cover, sectionId: s.id, sectionTitle: s.title }),
            }));
          }
          elList.appendChild(box);
        }
      }
      if (!shown) elList.appendChild(h('div', { class: 'empty', text: '没有匹配「' + q + '」的收藏夹。' }));
    }

    function renderFoot() {
      const n = (st.boards || []).length;
      const loading = st.boardsStatus && st.boardsStatus.state === 'loading';
      elRefresh.disabled = !!loading;
      elRefresh.textContent = loading ? '读取中' : '刷新';
      elFootText.textContent = n ? n + ' 个收藏夹 · ' + hhmm(st.boardsFetchedAt) : 'v' + VERSION;
    }

    function renderLog() {
      elLog.style.display = showLog ? '' : 'none';
      if (!showLog) return;
      elLog.textContent = '';
      const log = (st.log || []).slice(0, 12);
      if (!log.length) { elLog.appendChild(h('div', { class: 'm', text: '还没有保存记录。' })); return; }
      for (const e of log) {
        elLog.appendChild(h('div', { class: e.kind === 'err' || e.kind === 'warn' ? 'e' : e.kind === 'info' ? 'm' : '', text: hhmm(e.t) + '  ' + e.text, title: e.text }));
      }
    }

    function render() {
      renderTarget();
      renderRecent();
      renderHint();
      renderList();
      renderFoot();
      renderLog();
    }

    function onChanged(changes, area) {
      if (area !== 'local') return;
      let hit = false;
      for (const k of KEYS) {
        if (k in changes) { st[k] = changes[k].newValue; hit = true; }
      }
      if ('boardsStatus' in changes) hint = null;
      if (hit) render();
    }

    S.get(KEYS).then((v) => { st = v || {}; render(); });
    chrome.storage.onChanged.addListener(onChanged);

    return {
      focus: () => elSearch.focus(),
      destroy: () => { alive = false; chrome.storage.onChanged.removeListener(onChanged); wrap.remove(); },
    };
  }

  return { mount, css, label, VERSION };
})();
