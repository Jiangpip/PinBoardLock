// PinBoardLock — 扩展侧内容脚本（isolated world）
// 负责：把存储里的“当前目标”转给 inject.js；把 inject.js 读到的收藏夹写进存储；
// 页面里的状态条（默认左下角，可以拖到左右两侧任意高度）、提示和选择面板；把 Pinterest 按钮旁显示的默认收藏夹名改成目标名；
// 认调研单链接（#plk= / #plks=），按名字切目标，缺收藏夹或分区时问一句再新建。
(() => {
  'use strict';
  if (window.top !== window) return;

  const TAG = '__pbl';
  const S = chrome.storage.local;
  const WATCH = ['enabled', 'target', 'boards', 'sectionKey', 'boardsFetchedAt'];
  const STALE_MS = 6 * 3600 * 1000;
  // Pinterest 保存按钮旁那个显示默认收藏夹名的下拉按钮（按 data-test-id 找，找不到就什么都不做）
  const LABEL_SEL = '[data-test-id="PinBetterSaveDropdown"],[data-test-id="board-dropdown-select-button"],[data-test-id*="SaveDropdown"],[data-test-id*="save-dropdown"]';

  let st = { enabled: true, target: null, boards: [], sectionKey: 'section', boardsFetchedAt: 0 };
  let dead = false;
  let ui = null;
  let noTargetWarned = false;
  let queuedToast = null;
  let waiting = null;   // 等收藏夹列表刷新回来再认一次的链接请求
  let pending = null;   // 链接要的收藏夹/分区还没建：{ req, missing, busy, error, reqId }
  const DOCK_MARGIN = 14;
  let dock = { side: 'left', y: 1 };   // 状态条的位置，见 placeDock
  const nrm = (x) => PBLSheet.norm(x);

  // 调研单链接：尽早读出来并从地址里去掉，Pinterest 自己的脚本看到的就是普通搜索页
  let hashReq = null;
  try {
    hashReq = PBLSheet.parseHash(location.hash, location.search);
    if (hashReq) history.replaceState(history.state, '', location.pathname + location.search);
  } catch (e) { /* ignore */ }

  const safe = (fn) => {
    if (dead) return;
    try { return fn(); } catch (e) {
      if (String(e && e.message).indexOf('Extension context invalidated') !== -1) dead = true;
    }
  };
  const store = (obj) => safe(() => S.set(obj));
  const toMain = (msg) => window.postMessage(Object.assign({ [TAG]: 'to-main' }, msg), location.origin);
  const label = (t) => PBLPicker.label(t);

  function pushState() {
    toMain({ type: 'state', enabled: st.enabled !== false, target: st.target || null, sectionKey: st.sectionKey || 'section' });
  }

  function requestRefresh() {
    store({ boardsStatus: { state: 'loading', t: Date.now() } });
    toMain({ type: 'refresh', reqId: Date.now() });
  }

  // ───────── 保存记录 ─────────
  function addLog(kind, text, detail) {
    safe(() => S.get(['log']).then((v) => {
      const log = [{ t: Date.now(), kind, text, d: detail || null }].concat(v.log || []).slice(0, 30);
      store({ log });
    }));
  }

  function boardName(id) {
    const b = (st.boards || []).find((x) => x.id === String(id));
    return b ? b.name : '';
  }

  function onSave(m) {
    const info = m.info || {};
    const t = st.target;
    const actualName = (m.actual && (m.actual.name + (m.actual.section ? ' / ' + m.actual.section : ''))) || '';
    let kind = 'ok';
    let text = '';
    if (!m.ok) {
      kind = 'err';
      text = '保存失败（HTTP ' + m.status + (m.err ? ' · ' + m.err : '') + '）';
    } else if (info.rewritten) {
      if (m.actual && t && m.actual.id !== String(t.boardId)) {
        kind = 'warn';
        text = 'Pinterest 存到了「' + (actualName || m.actual.id) + '」，不是「' + label(t) + '」';
      } else {
        text = '已存到「' + label(t) + '」';
      }
    } else {
      const where = actualName || boardName(info.origBoard) || '所选收藏夹';
      if (info.reason === 'same') text = '已存到「' + label(t) + '」';
      else if (info.reason === 'manual') { kind = 'info'; text = '手动选择：存到「' + where + '」'; }
      else if (info.reason === 'alt') { kind = 'info'; text = '按住 Alt：存到「' + where + '」'; }
      else if (info.reason === 'no-target') {
        kind = 'info';
        text = '还没选目标收藏夹：存到「' + where + '」';
        if (noTargetWarned) text = '';
        noTargetWarned = true;
      } else if (info.reason === 'disabled') { kind = 'info'; text = ''; }
      else { kind = 'warn'; text = '没认出这次保存请求的格式，存到了「' + where + '」'; }
    }
    if (text) toast(kind, text);
    if (m.ok && (info.rewritten || info.reason === 'same')) countSave();
    addLog(kind, text || '未锁定：存到「' + (actualName || boardName(info.origBoard) || '?') + '」', {
      pin: info.pinId || '', reason: info.reason || 'unparsed', rewritten: !!info.rewritten, status: m.status,
      from: info.origBoard || '', fromSection: info.origSection || '', to: t ? t.boardId : '', toSection: t ? t.sectionId || '' : '',
      actual: m.actual || null, click: info.click || '', keys: info.keys || [],
    });
  }

  // ───────── 调研单：切目标、记关键词、缺了就问 ─────────
  function setTarget(t) {
    st.target = t;
    st.enabled = true;
    pushState();
    updateBar();
    safe(() => S.get(['recent']).then((v) => {
      const same = (r) => r.boardId === t.boardId && (r.sectionId || '') === (t.sectionId || '');
      store({ target: t, enabled: true, recent: [t].concat((v.recent || []).filter((r) => !same(r))).slice(0, 6) });
    }));
  }

  // 把这次点开的关键词并进调研单，并标成“当前关键词”
  function recordKw(req, target) {
    if (!req.q) return;
    safe(() => S.get(['sheets', 'kwStats']).then((v) => {
      const r = PBLSheet.addKeyword(v.sheets, req.board, req.section, req.q);
      const stats = v.kwStats || {};
      const per = stats[r.sheetId] || (stats[r.sheetId] = {});
      const e = per[nrm(req.q)] || (per[nrm(req.q)] = { saves: 0 });
      e.seen = Date.now();
      store({
        sheets: r.sheets, activeSheet: r.sheetId, kwStats: stats,
        kw: { sheetId: r.sheetId, group: r.group, q: req.q, t: Date.now(), boardId: target ? target.boardId : '', sectionId: target ? target.sectionId || '' : '' },
      });
    }));
  }

  // 保存成功且存进的正是当前关键词那一组 → 给这个关键词记一次
  function countSave() {
    const t = st.target;
    if (!t) return;
    safe(() => S.get(['kw', 'kwStats']).then((v) => {
      const kw = v.kw;
      if (!kw || !kw.boardId || kw.boardId !== t.boardId || (kw.sectionId || '') !== (t.sectionId || '')) return;
      const stats = v.kwStats || {};
      const per = stats[kw.sheetId] || (stats[kw.sheetId] = {});
      const e = per[nrm(kw.q)] || (per[nrm(kw.q)] = { saves: 0 });
      e.saves = (e.saves || 0) + 1;
      store({ kwStats: stats });
    }));
  }

  function applyKw(req, retried) {
    const r = PBLSheet.resolve(st.boards, req.board, req.section);
    if (r.target) {
      pending = null;
      setTarget(r.target);
      toast('ok', '已切到「' + label(r.target) + '」' + (req.q ? ' · ' + req.q : ''));
      recordKw(req, r.target);
      renderAsk();
      return;
    }
    if (!retried) {
      waiting = req;
      requestRefresh();
      return;
    }
    pending = { req, missing: r.missing, busy: false, error: '', reqId: 0 };
    recordKw(req, null);
    renderAsk();
  }

  function handleHash(r) {
    if (r.type === 'error') { toast('warn', r.error); return; }
    if (r.type === 'kw') { applyKw(r, false); return; }
    safe(() => S.get(['sheets']).then((v) => S.set({ sheets: PBLSheet.upsert(v.sheets, r.sheet), activeSheet: r.sheet.id })).then(() => {
      toast('ok', '已导入调研单「' + r.sheet.title + '」');
      const hit = r.q && PBLSheet.flatKeywords(r.sheet).find((k) => nrm(k.q) === nrm(r.q));
      if (hit) applyKw({ board: r.sheet.board, section: hit.group.section, q: hit.q, privacy: r.sheet.privacy }, false);
    }));
  }

  function createPending() {
    if (!pending || pending.busy) return;
    pending.busy = true;
    pending.error = '';
    pending.reqId = Date.now();
    toMain({ type: 'ensure', reqId: pending.reqId, board: pending.req.board, privacy: pending.req.privacy || 'public', sections: pending.req.section ? [pending.req.section] : [] });
    renderAsk();
  }

  function onEnsured(m) {
    const msg = (m.errors || []).join('；');
    if (m.boards && m.boards.length) {
      st.boards = m.boards;
      rebuildNames();
      store({ boards: m.boards, username: m.username || '', boardsFetchedAt: Date.now(), boardsStatus: { state: 'ok', t: Date.now(), msg: m.ok ? msg : '' } });
    }
    store({ ensureStatus: { t: Date.now(), reqId: m.reqId, ok: !!m.ok, created: m.created || [], msg } });
    if ((m.created || []).length) addLog('ok', '新建：' + m.created.join('、'), { created: m.created });
    if (!m.ok) addLog('err', '新建失败：' + msg, { created: m.created || [] });
    if (pending && pending.reqId === m.reqId) {
      if (m.ok) applyKw(pending.req, true);
      else { pending.busy = false; pending.error = msg || '新建失败'; renderAsk(); }
    }
  }

  // ───────── 来自 inject.js 的消息 ─────────
  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data || ev.data[TAG] !== 'to-content') return;
    const m = ev.data;
    if (m.type === 'ready') pushState();
    else if (m.type === 'boards') {
      const errors = (m.errors || []).join('；');
      if (m.ok) {
        st.boards = m.boards;
        rebuildNames();
        store({
          boards: m.boards, username: m.username || '', boardsFetchedAt: Date.now(),
          boardsStatus: { state: 'ok', t: Date.now(), msg: errors },
        });
      } else {
        store({ boardsStatus: { state: 'error', t: Date.now(), msg: errors || '没有读到任何收藏夹' } });
      }
      if (waiting) {
        const w = waiting;
        waiting = null;
        applyKw(w, true);
      }
    } else if (m.type === 'ensured') onEnsured(m);
    else if (m.type === 'save') onSave(m);
    else if (m.type === 'learned' && m.sectionKey) store({ sectionKey: m.sectionKey });
    else if (m.type === 'seen') addLog('info', '看到别的带 board_id 的请求：' + m.path, { path: m.path });
    else if (m.type === 'note') addLog('warn', String(m.msg || ''), null);
  });

  // ───────── 来自侧边栏的消息（只发给当前这个标签页） ─────────
  safe(() => chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string' || msg.type.indexOf('pbl-') !== 0) return;
    if (msg.type === 'pbl-ensure') {
      toMain({ type: 'ensure', reqId: msg.reqId, board: msg.board, privacy: msg.privacy, sections: msg.sections || [] });
      sendResponse({ ok: true });
    } else if (msg.type === 'pbl-ping') {
      sendResponse({ ok: true, origin: location.origin });
    }
  }));

  // ───────── 页面内界面：左下角状态条 + 面板 + 提示 + 新建询问 ─────────
  const UI_CSS = `
:host{all:initial}
.wrap{position:fixed;z-index:2147483600;font:13px/1.3 "Segoe UI","Microsoft YaHei UI",system-ui,sans-serif;color:#16140F}
.wrap.L{left:14px}
.wrap.R{right:14px}
.wrap.drag{right:auto !important}
.bar{display:flex;align-items:center;gap:7px;max-width:300px;padding:6px 11px 6px 7px;background:#F6F1E6;border:1.5px solid #16140F;box-shadow:3px 3px 0 #16140F;cursor:pointer;user-select:none;touch-action:none}
.bar:hover{background:#ECE6D8}
.wrap.drag .bar{cursor:grabbing;box-shadow:6px 6px 0 #16140F}
.grip{width:6px;height:14px;flex:none;cursor:grab;opacity:.55;background:radial-gradient(circle,#16140F 1px,transparent 1.3px) 0 0/3px 4px}
.bar:hover .grip{opacity:1}
.dot{width:9px;height:9px;border-radius:50%;background:#7A7468;flex:none}
.bar.on .dot{background:#E4451C}
.k{font-family:"Cascadia Mono",Consolas,monospace;font-size:10px;letter-spacing:.08em;color:#7A7468;flex:none}
.v{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pop{position:absolute;width:372px;height:min(540px,var(--avail,540px));border:1.5px solid #16140F;box-shadow:4px 4px 0 #16140F;background:#ECE6D8;display:none}
.pop.open{display:block}
.wrap.up .pop,.wrap.up .toast{bottom:calc(100% + 10px)}
.wrap.down .pop,.wrap.down .toast{top:calc(100% + 10px)}
.wrap.L .pop,.wrap.L .toast{left:0}
.wrap.R .pop,.wrap.R .toast{right:0}
.wrap.L .ask{left:calc(100% + 10px)}
.wrap.R .ask{right:calc(100% + 10px)}
.toast{position:absolute;max-width:420px;width:max-content;padding:7px 11px;background:#16140F;color:#F6F1E6;border-left:4px solid #1E7A4C;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;opacity:0;transform:translateY(6px);transition:opacity .15s,transform .15s;pointer-events:none}
.toast.show{opacity:1;transform:none}
.toast.err,.toast.warn{border-left-color:#E4451C}
.toast.info{border-left-color:#7A7468}
.ask{position:absolute;bottom:0;width:max-content;max-width:430px;padding:7px 9px 7px 11px;background:#F6F1E6;border:1.5px solid #16140F;border-left:5px solid #E4451C;box-shadow:3px 3px 0 #16140F;display:none;align-items:center;gap:9px}
.ask.open{display:flex}
.ask .tx{min-width:0}
.ask .a1{font-weight:600;word-break:break-all}
.ask .a2{color:#7A7468;font-size:12px;margin-top:1px;word-break:break-all}
.ask .a2.err{color:#E4451C}
.ask button{font:inherit;color:inherit;cursor:pointer;border:1.5px solid #16140F;background:#F6F1E6;padding:3px 9px;white-space:nowrap;flex:none}
.ask button.go{background:#16140F;color:#F6F1E6}
.ask button[disabled]{opacity:.5;cursor:default}
`;

  function buildUI() {
    if (ui || !document.documentElement) return;
    const host = document.createElement('div');
    host.id = 'pbl-host';
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = UI_CSS + PBLPicker.css;
    const wrap = document.createElement('div');
    wrap.className = 'wrap';
    const bar = document.createElement('div');
    bar.className = 'bar';
    const grip = document.createElement('span');
    grip.className = 'grip';
    const dot = document.createElement('span');
    dot.className = 'dot';
    const k = document.createElement('span');
    k.className = 'k';
    const v = document.createElement('span');
    v.className = 'v';
    bar.append(grip, dot, k, v);
    const pop = document.createElement('div');
    pop.className = 'pop';
    const toastEl = document.createElement('div');
    toastEl.className = 'toast';
    const ask = document.createElement('div');
    ask.className = 'ask';
    const askTx = document.createElement('div');
    askTx.className = 'tx';
    const ask1 = document.createElement('div');
    ask1.className = 'a1';
    const ask2 = document.createElement('div');
    ask2.className = 'a2';
    askTx.append(ask1, ask2);
    const askGo = document.createElement('button');
    askGo.className = 'go';
    askGo.addEventListener('click', createPending);
    const askNo = document.createElement('button');
    askNo.textContent = '忽略';
    askNo.addEventListener('click', () => { pending = null; renderAsk(); });
    ask.append(askTx, askGo, askNo);
    wrap.append(pop, toastEl, bar, ask);
    root.append(style, wrap);
    document.documentElement.appendChild(host);

    let picker = null;
    const setOpen = (open) => {
      pop.classList.toggle('open', open);
      if (open) {
        toastEl.classList.remove('show');
        if (!picker) picker = safe(() => PBLPicker.mount(pop));
        if (picker) picker.focus();
      }
    };
    // 按住状态条拖动：跟着鼠标走，松手后吸到离得近的那一侧，上下位置留在松手的地方。没拖动就是普通点击。
    let drag = null;
    let justDragged = false;
    const clamp = (x, lo, hi) => Math.min(Math.max(x, lo), Math.max(lo, hi));
    bar.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return;
      const r = wrap.getBoundingClientRect();
      drag = { id: ev.pointerId, x0: ev.clientX, y0: ev.clientY, dx: ev.clientX - r.left, dy: ev.clientY - r.top, moved: false };
      try { bar.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
    });
    bar.addEventListener('pointermove', (ev) => {
      if (!drag || ev.pointerId !== drag.id) return;
      if (!drag.moved) {
        if (Math.hypot(ev.clientX - drag.x0, ev.clientY - drag.y0) < 5) return;
        drag.moved = true;
        ui.dragging = true;
        setOpen(false);
        toastEl.classList.remove('show');
        wrap.style.transition = 'none';
        wrap.style.transform = '';
        wrap.classList.add('drag');
      }
      wrap.style.left = clamp(ev.clientX - drag.dx, 4, window.innerWidth - wrap.offsetWidth - 4) + 'px';
      wrap.style.top = clamp(ev.clientY - drag.dy, 4, window.innerHeight - wrap.offsetHeight - 4) + 'px';
      ev.preventDefault();
    });
    const endDrag = (ev) => {
      if (!drag || ev.pointerId !== drag.id) return;
      const d = drag;
      drag = null;
      try { bar.releasePointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
      if (!d.moved) return;
      justDragged = true;
      setTimeout(() => { justDragged = false; }, 80);
      const from = wrap.getBoundingClientRect();
      dock = {
        side: from.left + from.width / 2 < window.innerWidth / 2 ? 'left' : 'right',
        y: clamp((from.top + from.height / 2) / window.innerHeight, 0, 1),
      };
      wrap.classList.remove('drag');
      ui.dragging = false;
      placeDock();
      // 从松手的位置滑到吸附后的位置
      const to = wrap.getBoundingClientRect();
      wrap.style.transform = 'translate(' + (from.left - to.left) + 'px,' + (from.top - to.top) + 'px)';
      wrap.getBoundingClientRect();
      wrap.style.transition = 'transform .18s ease-out';
      wrap.style.transform = '';
      store({ dock });
    };
    bar.addEventListener('pointerup', endDrag);
    bar.addEventListener('pointercancel', endDrag);
    bar.addEventListener('click', () => {
      if (justDragged) { justDragged = false; return; }
      setOpen(!pop.classList.contains('open'));
    });
    document.addEventListener('pointerdown', (ev) => {
      if (pop.classList.contains('open') && ev.composedPath().indexOf(host) === -1) setOpen(false);
    }, true);
    window.addEventListener('resize', placeDock);
    // 面板里的按键不要触发 Pinterest 自己的快捷键
    for (const type of ['keydown', 'keyup', 'keypress']) wrap.addEventListener(type, (ev) => ev.stopPropagation());

    ui = { wrap, bar, k, v, pop, toastEl, timer: 0, ask, ask1, ask2, askGo, dragging: false };
    updateBar();
    placeDock();   // 要在状态条有了文字之后量高度
    renderAsk();
    if (queuedToast) {
      const q = queuedToast;
      queuedToast = null;
      toast(q.kind, q.text);
    }
  }

  // 状态条停在哪：side 是吸在页面哪一侧，y 是条的中心在窗口高度里的比例（1 = 贴底）。
  // 面板和提示朝空间大的方向展开（条在下半边就往上开，在上半边就往下开）。
  function normDock(d) {
    const y = d && typeof d.y === 'number' && isFinite(d.y) ? d.y : 1;
    return { side: d && d.side === 'right' ? 'right' : 'left', y: Math.min(1, Math.max(0, y)) };
  }

  function placeDock() {
    if (!ui || ui.dragging) return;
    const w = ui.wrap;
    const vh = window.innerHeight || document.documentElement.clientHeight || 800;
    const h = ui.bar.offsetHeight || 32;
    const top = Math.round(Math.min(Math.max(dock.y * vh - h / 2, DOCK_MARGIN), Math.max(DOCK_MARGIN, vh - h - DOCK_MARGIN)));
    w.classList.toggle('L', dock.side !== 'right');
    w.classList.toggle('R', dock.side === 'right');
    w.style.left = '';
    w.style.top = top + 'px';
    const above = top - 10 - DOCK_MARGIN;
    const below = vh - (top + h) - 10 - DOCK_MARGIN;
    const up = above >= below;
    w.classList.toggle('up', up);
    w.classList.toggle('down', !up);
    w.style.setProperty('--avail', Math.max(160, up ? above : below) + 'px');
  }

  function renderAsk() {
    if (!ui) return;
    ui.ask.classList.toggle('open', !!pending);
    if (!pending) return;
    const r = pending.req;
    ui.ask1.textContent = pending.missing === 'board'
      ? '收藏夹「' + r.board + '」还没建' + (r.section ? '（分区「' + r.section + '」也要建）' : '')
      : '「' + r.board + '」里还没有分区「' + r.section + '」';
    ui.ask2.className = 'a2' + (pending.error ? ' err' : '');
    ui.ask2.textContent = pending.error
      || (pending.busy ? '正在新建…' : st.target && st.enabled !== false ? '没建之前，保存还是进「' + label(st.target) + '」' : '没建之前，保存按 Pinterest 自己的默认');
    ui.askGo.textContent = pending.error ? '重试' : '新建';
    ui.askGo.disabled = !!pending.busy;
  }

  function updateBar() {
    if (!ui) return;
    const on = st.enabled !== false && !!st.target;
    ui.bar.classList.toggle('on', on);
    ui.k.textContent = on ? 'LOCK' : 'OFF';
    ui.v.textContent = st.target ? (on ? label(st.target) : '已暂停') : '点这里选收藏夹';
    ui.bar.title = (on ? '“保存”都进：' + label(st.target) + '（按住 Alt 点保存可临时不锁）' : 'PinBoardLock') + '\n按住可以拖到页面左右两侧';
  }

  function toast(kind, text) {
    if (!ui) { queuedToast = { kind, text }; return; }
    ui.toastEl.className = 'toast ' + kind;
    ui.toastEl.textContent = text;
    if (ui.pop.classList.contains('open')) return;
    requestAnimationFrame(() => ui.toastEl.classList.add('show'));
    clearTimeout(ui.timer);
    ui.timer = setTimeout(() => ui.toastEl.classList.remove('show'), kind === 'ok' ? 2200 : 4500);
  }

  // ───────── 把按钮旁显示的默认收藏夹名改成目标名（只改文字节点） ─────────
  const origText = new WeakMap();
  let names = new Set();
  let relabelTimer = 0;

  function rebuildNames() {
    names = new Set();
    for (const b of st.boards || []) {
      names.add(b.name);
      for (const s of b.sections || []) names.add(s.title);
    }
  }

  function relabel() {
    relabelTimer = 0;
    const want = st.enabled !== false && st.target ? label(st.target) : null;
    if (!want && !names.size) return;
    let els;
    try { els = document.querySelectorAll(LABEL_SEL); } catch (e) { return; }
    for (const el of els) {
      const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = w.nextNode())) {
        const cur = n.nodeValue.trim();
        if (!cur) continue;
        if (want) {
          if (cur !== want && (names.has(cur) || origText.has(n))) {
            if (names.has(cur) || !origText.has(n)) origText.set(n, n.nodeValue);
            n.nodeValue = want;
          }
        } else if (origText.has(n)) {
          n.nodeValue = origText.get(n);
          origText.delete(n);
        }
      }
    }
  }
  const scheduleRelabel = () => { if (!relabelTimer) relabelTimer = setTimeout(relabel, 200); };

  // ───────── 启动 ─────────
  safe(() => chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    let stateChanged = false;
    for (const key of WATCH) {
      if (key in changes) {
        st[key] = changes[key].newValue;
        if (key !== 'boards' && key !== 'boardsFetchedAt') stateChanged = true;
      }
    }
    if ('boards' in changes) rebuildNames();
    // 在别的标签页里拖过状态条：这边跟着挪
    if ('dock' in changes && !(ui && ui.dragging)) { dock = normDock(changes.dock.newValue); placeDock(); }
    // 用户另选了目标（面板或侧边栏里）：不再追着问
    if ('target' in changes && pending && !pending.busy) pending = null;
    if (stateChanged) { pushState(); updateBar(); renderAsk(); }
    if (stateChanged || 'boards' in changes) scheduleRelabel();
    if ('refreshRequest' in changes && document.visibilityState === 'visible') requestRefresh();
  }));

  safe(() => S.get(WATCH.concat('dock')).then((v) => {
    v = Object.assign({}, v);
    dock = normDock(v.dock);
    delete v.dock;
    placeDock();
    Object.assign(st, v);
    rebuildNames();
    pushState();
    updateBar();
    scheduleRelabel();
    if (hashReq) handleHash(hashReq);
    const stale = !(st.boards && st.boards.length) || Date.now() - (st.boardsFetchedAt || 0) > STALE_MS;
    if (stale && !waiting) {
      setTimeout(() => { if (document.visibilityState === 'visible') requestRefresh(); }, 3000);
    }
  }));

  const start = () => {
    buildUI();
    try {
      new MutationObserver(scheduleRelabel).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    } catch (e) { /* ignore */ }
  };
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
