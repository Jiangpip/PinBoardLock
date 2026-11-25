// PinBoardLock — 侧边栏（Side Panel）里的调研单。
// 点关键词 = 把锁定目标切到这一组对应的收藏夹/分区，再让 Pinterest 标签页去搜这个词。
// 只读写 chrome.storage.local；真正去 Pinterest 新建东西的是页面里的 inject.js（经 content.js 转发）。
// 读调研单文件夹、下载、写 Billfish 这三件事交给本机小程序（host\pbl-host.js，Native Messaging）。
(() => {
  'use strict';
  const S = chrome.storage.local;
  const P = PBLSheet;
  const KEYS = ['sheets', 'activeSheet', 'kw', 'kwStats', 'boards', 'target', 'enabled', 'recent', 'log', 'ensureStatus', 'boardsStatus', 'boardsFetchedAt', 'sectionKey', 'syncDest', 'inbox'];
  const PIN_URLS = ['https://*.pinterest.com/*', 'https://*.pinterest.co.uk/*', 'https://*.pinterest.ca/*', 'https://*.pinterest.jp/*',
    'https://*.pinterest.de/*', 'https://*.pinterest.fr/*', 'https://*.pinterest.com.au/*', 'https://*.pinterest.co.kr/*'];
  const PIN_HOST = /(^|\.)pinterest\.(com|co\.uk|ca|jp|de|fr|com\.au|co\.kr)$/i;

  let st = {};
  let view = 'sheet';        // 'sheet' | 'import'
  let flashMsg = null;       // { text, kind }
  let ensure = null;         // { reqId, sheetId }
  let delArmed = false;
  let importText = '';
  let importResult = null;   // parseImport 的结果
  const root = document.getElementById('root');

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

  const label = (t) => (t ? (t.sectionTitle ? t.boardName + ' / ' + t.sectionTitle : t.boardName) : '');
  const hhmm = (t) => {
    if (!t) return '';
    const d = new Date(t);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  };
  const sheets = () => st.sheets || [];
  const current = () => sheets().find((s) => s.id === st.activeSheet) || sheets()[0] || null;
  const statOf = (sheet, q) => ((st.kwStats || {})[sheet.id] || {})[P.norm(q)] || null;
  const isCurKw = (sheet, group, q) => !!st.kw && st.kw.sheetId === sheet.id && st.kw.group === group.name && P.norm(st.kw.q) === P.norm(q);

  function flash(text, kind) {
    flashMsg = { text, kind: kind || '' };
    render();
    const mine = flashMsg;
    setTimeout(() => { if (flashMsg === mine) { flashMsg = null; render(); } }, kind === 'err' ? 6000 : 2600);
  }

  // ───────── 本机小程序 ─────────
  const HOST = 'com.pinboardlock.host';
  const host = { port: null, ok: null, info: null, error: '', seq: 0, waiting: new Map() };
  let syncStatus = null;     // 小程序推过来的同步进度（sync\last-run.json 的内容）
  let syncView = 'closed';   // 'closed' | 'form' | 'result'
  let destDraft = null;      // 目标文件夹输入框里正在改的内容
  let hostHint = false;      // 显示“还没装本机小程序”的说明

  const typing = () => {
    const a = document.activeElement;
    return !!a && root.contains(a) && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && a.type === 'text'));
  };
  // 正在输入框里打字时不重画，免得光标丢了
  const softRender = () => { if (!typing()) render(); };

  function connectHost() {
    if (host.port) return;
    let port;
    try { port = chrome.runtime.connectNative(HOST); } catch (e) { host.ok = false; host.error = String(e && e.message || e); return; }
    host.port = port;
    port.onMessage.addListener((m) => {
      if (m && m.event === 'sync') { syncStatus = m.status; softRender(); return; }
      const w = m && host.waiting.get(m.id);
      if (w) { host.waiting.delete(m.id); w.resolve(m); }
    });
    port.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError;
      host.port = null;
      if (host.ok !== true) { host.ok = false; host.error = (err && err.message) || '连不上'; }
      else host.ok = null;   // 之前连上过：下次要用时再连
      for (const w of host.waiting.values()) w.reject(new Error(host.error || '本机小程序断开了'));
      host.waiting.clear();
      softRender();
    });
  }

  function callHost(cmd, extra) {
    connectHost();
    if (!host.port) return Promise.reject(new Error(host.error || '连不上本机小程序'));
    return new Promise((resolve, reject) => {
      const id = ++host.seq;
      host.waiting.set(id, { resolve, reject });
      try { host.port.postMessage(Object.assign({ id, cmd }, extra)); } catch (e) { host.waiting.delete(id); reject(e); return; }
      setTimeout(() => { if (host.waiting.has(id)) { host.waiting.delete(id); reject(new Error('本机小程序没有回应')); } }, 15000);
    });
  }

  function hello() {
    return callHost('hello').then((r) => {
      if (!r.ok) throw new Error(r.error || '本机小程序报错');
      host.ok = true;
      host.info = r;
      host.error = '';
      hostHint = false;
      if (r.status) syncStatus = r.status;
      return r;
    });
  }
  const ensureHost = () => (host.ok === true && host.port ? Promise.resolve(host.info) : hello());

  // ───────── 从调研单文件夹读进来 ─────────
  async function refreshFromFolder(quiet) {
    let r;
    try {
      await ensureHost();
      r = await callHost('sheets.list');
      if (!r.ok) throw new Error(r.error || '读不了');
    } catch (e) {
      if (quiet) { softRender(); return; }
      if (host.ok === false) { hostHint = true; render(); } else flash('读调研单文件夹失败：' + e.message, 'err');
      return;
    }
    let list = sheets();
    let added = 0;
    let updated = 0;
    let total = 0;
    let firstNew = '';
    const bad = (r.errors || []).map((e) => (e.file ? e.file + '：' : '') + e.error);
    for (const file of r.sheets || []) {
      const d = file.data;
      const items = Array.isArray(d) ? d : d && Array.isArray(d.sheets) ? d.sheets : [d];
      for (const raw of items) {
        let s;
        try { s = P.normalizeSheet(raw); } catch (e) { bad.push(file.file + '：' + e.message); continue; }
        total++;
        const old = list.find((x) => x.id === s.id);
        if (!old) {
          added++;
          if (!firstNew) firstNew = s.id;
          list = P.upsert(list, s);
        } else {
          if (raw.privacy === undefined) s.privacy = old.privacy;   // 公开/私密是在面板里选的，文件里没写就不动
          s.createdAt = old.createdAt;
          if (JSON.stringify(P.toPlain(old)) !== JSON.stringify(P.toPlain(s))) { updated++; list = P.upsert(list, s); }
        }
      }
    }
    const patch = { inbox: null };
    if (added || updated) patch.sheets = list;
    if (firstNew) patch.activeSheet = firstNew;
    if (added) view = 'sheet';
    await S.set(patch);
    if (quiet && !added && !updated && !bad.length) { softRender(); return; }
    let msg = added || updated
      ? '从文件夹读到 ' + total + ' 份：' + [added ? '新增 ' + added + ' 份' : '', updated ? '更新 ' + updated + ' 份' : ''].filter(Boolean).join('，') + '。'
      : '文件夹里的 ' + total + ' 份都已经在了，没有新的。';
    if (bad.length) msg += ' 读不了：' + bad.join('；');
    flash(msg, bad.length ? 'err' : 'ok');
  }

  // ───────── 下载 + 同步到 Billfish ─────────
  function boardUrlOf(sheet) {
    const b = P.resolve(st.boards, sheet.board, '').board;
    return b && b.url ? 'https://www.pinterest.com' + b.url : '';
  }
  const destOf = (sheet) => (st.syncDest || {})[sheet.id] || P.destOf(sheet, host.info && host.info.defaultRoot);

  async function openSync() {
    try { await ensureHost(); } catch (e) { hostHint = true; render(); return; }
    destDraft = null;
    syncView = 'form';
    render();
  }

  async function startSync(sheet) {
    const dest = String(destDraft == null ? destOf(sheet) : destDraft).trim().replace(/\//g, '\\').replace(/\\+$/, '');
    const url = boardUrlOf(sheet);
    if (!url) { flash('账号里还没有收藏夹「' + sheet.board + '」，没有东西可下载。', 'err'); return; }
    if (!/^[A-Za-z]:\\/.test(dest)) { flash('目标文件夹要写完整路径，比如 ' + ((host.info && host.info.defaultRoot) || 'D:\\参考图') + '\\' + P.fileBase(sheet), 'err'); return; }
    try {
      await ensureHost();
      const r = await callHost('sync.run', { name: sheet.board, title: sheet.title, url, dest });
      if (r.status) syncStatus = r.status;
      if (!r.ok) { flash(r.error || '没能开始同步', 'err'); return; }
    } catch (e) {
      if (host.ok === false) { hostHint = true; render(); } else flash('没能开始同步：' + e.message, 'err');
      return;
    }
    const map = Object.assign({}, st.syncDest);
    map[sheet.id] = dest;
    S.set({ syncDest: map });
    destDraft = null;
    syncView = 'result';
    syncStatus = { state: 'running', name: sheet.board, title: sheet.title, dest, steps: [], updatedAt: Date.now() };
    render();
  }

  const MARK = { todo: '○', run: '◐', ok: '●', wait: '!', err: '×', skip: '–' };
  const useBillfish = () => !(host.info && host.info.billfish === false);
  function renderProgress(s) {
    const box = h('div', { class: 'prog' },
      h('div', { class: 'mono', text: (s.state === 'running' ? '正在同步 SYNCING' : s.state === 'done' ? '同步完成 DONE' : '同步停下了 STOPPED') + ' · ' + (s.title || s.name || '') }));
    for (const x of s.steps || []) {
      box.appendChild(h('div', { class: 'st ' + x.state },
        h('span', { class: 'mk', text: MARK[x.state] || '○' }),
        h('div', { class: 'sx' }, h('div', { class: 'sl', text: x.label }), x.text ? h('div', { class: 'sd', text: x.text }) : null)));
    }
    if (!(s.steps || []).length) box.appendChild(h('div', { class: 'sd', text: '正在启动…' }));
    return box;
  }

  function renderSync(sheet) {
    const s = syncStatus;
    const box = h('div', { class: 'sync' });
    if (s && s.state === 'running') {
      box.appendChild(renderProgress(s));
      box.appendChild(h('div', { class: 'sd', text: '可以关掉侧边栏，同步会自己跑完。' }));
      return box;
    }
    if (syncView === 'result' && s && (s.state === 'done' || s.state === 'error')) {
      box.appendChild(renderProgress(s));
      if (s.state === 'done' && s.summary) {
        const m = s.summary;
        box.appendChild(h('div', { class: 'sum', text: '新增 ' + m.added + ' 张，共 ' + m.total + ' 张' + (m.billfish === false ? '。' : '；写了 ' + m.originSet + ' 个来源、' + m.tagLinks + ' 条标签。') }));
        for (const w of m.warnings || []) box.appendChild(h('div', { class: 'sd warn', text: w }));
        box.appendChild(h('div', { class: 'sd', text: s.dest, title: s.dest }));
      }
      if (s.state === 'error') box.appendChild(h('div', { class: 'sum err', text: s.error || '同步出错' }));
      box.appendChild(h('div', { class: 'row' },
        s.state === 'error' ? h('button', { class: 'btn go', text: '再试一次', onclick: openSync }) : null,
        h('button', { class: 'btn' + (s.state === 'done' ? ' go' : ''), text: s.state === 'done' ? '好' : '收起', onclick: () => { syncView = 'closed'; render(); } })));
      return box;
    }
    if (syncView === 'form') {
      const url = boardUrlOf(sheet);
      const input = h('input', { type: 'text', spellcheck: 'false', oninput: (e) => { destDraft = e.target.value; } });
      input.value = destDraft == null ? destOf(sheet) : destDraft;
      box.appendChild(h('div', { class: 'mono', text: '下载到 DOWNLOAD TO' }));
      box.appendChild(input);
      box.appendChild(h('div', { class: 'sd', text: url
        ? '收藏夹「' + sheet.board + '」里的图下载到这个文件夹，分区变成子文件夹；只下新增的。' + (useBillfish() ? '文件夹在 Billfish 库里的话，再写上来源链接，打上标签「' + sheet.board + '」和各分区名。' : '')
        : '账号里还没读到收藏夹「' + sheet.board + '」。先在 Pinterest 页面的面板里点“刷新”，或者先把收藏夹建出来。' }));
      box.appendChild(h('div', { class: 'row' },
        h('button', { class: 'btn go', text: '开始', disabled: !url, onclick: () => startSync(sheet) }),
        h('button', { class: 'btn', text: '取消', onclick: () => { syncView = 'closed'; destDraft = null; render(); } })));
      return box;
    }
    const last = s && s.state === 'done' && s.summary && s.name === sheet.board
      ? '上次 ' + hhmm(s.updatedAt) + ' · 新增 ' + s.summary.added + ' 张'
      : s && s.state === 'error' && s.name === sheet.board ? '上次没做完' : '';
    box.appendChild(h('div', { class: 'row' },
      h('button', { class: 'btn wide', text: useBillfish() ? '⬇ 下载 + 同步到 Billfish' : '⬇ 下载到本地', title: useBillfish() ? '把这份调研单的收藏夹下载到本地，并在 Billfish 里写上来源和标签' : '把这份调研单的收藏夹下载到本地，分区变成子文件夹', onclick: openSync }),
      last ? h('button', { class: 'lnk', text: last, title: '看上次的结果', onclick: () => { syncView = 'result'; render(); } }) : null));
    return box;
  }

  function renderHostHint() {
    let id = '';
    try { id = chrome.runtime.id || ''; } catch (e) { /* ignore */ }
    const cmd = 'pwsh -NoProfile -ExecutionPolicy Bypass -File host\\Install-Host.ps1' + (id ? ' -ExtensionId ' + id : '');
    return h('div', { class: 'note err' },
      h('div', { text: '还没连上本机小程序。读调研单文件夹、下载图片、写 Billfish 都靠它。' }),
      h('div', { style: 'margin-top:4px', text: '在 PinBoardLock 文件夹里打开 PowerShell 跑下面这句，再到 chrome://extensions 把插件重新加载一次：' }),
      h('div', { class: 'cmd', text: cmd }),
      host.error ? h('div', { style: 'margin-top:4px;color:var(--mut)', text: 'Chrome 说：' + host.error }) : null,
      h('div', { class: 'row' },
        h('button', { class: 'btn', text: '复制命令', onclick: () => copy(cmd, '命令已复制。') }),
        h('button', { class: 'btn', text: '再连一次', onclick: () => { host.ok = null; hello().then(() => { flash('连上了。', 'ok'); refreshFromFolder(true); }, () => { hostHint = true; render(); }); } }),
        h('button', { class: 'btn', text: '关掉', onclick: () => { hostHint = false; render(); } })));
  }

  // ───────── 找 Pinterest 标签页 ─────────
  const isPin = (tab) => {
    try { return !!tab && !!tab.url && PIN_HOST.test(new URL(tab.url).hostname); } catch (e) { return false; }
  };
  async function findPinTab() {
    const active = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    if (isPin(active)) return active;
    const all = await chrome.tabs.query({ currentWindow: true, url: PIN_URLS });
    return all[0] || null;
  }

  async function navigate(q) {
    const tab = await findPinTab();
    const origin = tab ? new URL(tab.url).origin : 'https://www.pinterest.com';
    const url = P.searchUrl(origin, q);
    if (tab) await chrome.tabs.update(tab.id, { url, active: true });
    else await chrome.tabs.create({ url });
  }

  // ───────── 点关键词 ─────────
  async function go(sheet, group, q) {
    const r = P.resolve(st.boards, sheet.board, group.section);
    // 分区还没建但收藏夹在：先进收藏夹本身，至少不会存到别的收藏夹去
    const target = r.target || (r.missing === 'section' ? P.resolve(st.boards, sheet.board, '').target : null);
    const stats = Object.assign({}, st.kwStats);
    const per = stats[sheet.id] = Object.assign({}, stats[sheet.id]);
    per[P.norm(q)] = Object.assign({ saves: 0 }, per[P.norm(q)], { seen: Date.now() });
    const patch = {
      activeSheet: sheet.id, kwStats: stats,
      kw: { sheetId: sheet.id, group: group.name, q, t: Date.now(), boardId: r.target ? r.target.boardId : '', sectionId: r.target ? r.target.sectionId || '' : '' },
    };
    if (target) {
      const same = (x) => x.boardId === target.boardId && (x.sectionId || '') === (target.sectionId || '');
      patch.target = target;
      patch.enabled = true;
      patch.recent = [target].concat((st.recent || []).filter((x) => !same(x))).slice(0, 6);
    }
    await S.set(patch);
    try { await navigate(q); } catch (e) { flash('打不开 Pinterest 标签页：' + (e && e.message), 'err'); }
  }

  function step(delta) {
    const sheet = current();
    if (!sheet) return;
    const flat = P.flatKeywords(sheet);
    if (!flat.length) return;
    let i = flat.findIndex((k) => isCurKw(sheet, k.group, k.q));
    i = i === -1 ? (delta > 0 ? 0 : flat.length - 1) : (i + delta + flat.length) % flat.length;
    go(sheet, flat[i].group, flat[i].q);
  }

  // ───────── 新建缺的收藏夹和分区 ─────────
  async function createMissing(sheet) {
    const tab = await findPinTab();
    if (!tab) { flash('先在这个窗口里打开并登录 Pinterest 网页，再点新建。', 'err'); return; }
    const reqId = Date.now();
    const sections = [];
    for (const g of sheet.groups) if (g.section && sections.indexOf(g.section) === -1) sections.push(g.section);
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'pbl-ensure', reqId, board: sheet.board, privacy: sheet.privacy, sections });
    } catch (e) {
      flash('那个 Pinterest 标签页还没连上插件，刷新它再点新建。', 'err');
      return;
    }
    ensure = { reqId, sheetId: sheet.id };
    render();
    setTimeout(() => {
      if (ensure && ensure.reqId === reqId) { ensure = null; flash('新建没有回应。点最下面的“复制诊断”贴给 Claude 看看。', 'err'); }
    }, 45000);
  }

  function onEnsureStatus(es) {
    if (!ensure || !es || es.reqId !== ensure.reqId) return;
    const sheet = sheets().find((s) => s.id === ensure.sheetId);
    ensure = null;
    if (!es.ok) { flash('新建失败：' + (es.msg || '未知原因'), 'err'); return; }
    flash(es.created.length ? '已新建：' + es.created.join('、') : '都已经在了，没有新建。', 'ok');
    // 当前关键词属于这份调研单：把目标补切到刚建好的分区
    if (sheet && st.kw && st.kw.sheetId === sheet.id) {
      const g = sheet.groups.find((x) => x.name === st.kw.group);
      const r = g && P.resolve(st.boards, sheet.board, g.section);
      if (r && r.target) S.set({ target: r.target, enabled: true, kw: Object.assign({}, st.kw, { boardId: r.target.boardId, sectionId: r.target.sectionId || '' }) });
    }
  }

  function setPrivacy(sheet, privacy) {
    S.set({ sheets: sheets().map((s) => (s.id === sheet.id ? Object.assign({}, s, { privacy }) : s)) });
  }

  function removeSheet(sheet) {
    if (!delArmed) {
      delArmed = true;
      render();
      setTimeout(() => { if (delArmed) { delArmed = false; render(); } }, 3000);
      return;
    }
    delArmed = false;
    const rest = sheets().filter((s) => s.id !== sheet.id);
    const stats = Object.assign({}, st.kwStats);
    delete stats[sheet.id];
    const patch = { sheets: rest, activeSheet: rest[0] ? rest[0].id : '', kwStats: stats };
    if (st.kw && st.kw.sheetId === sheet.id) patch.kw = null;
    S.set(patch);
  }

  function copy(text, okMsg) {
    navigator.clipboard.writeText(text).then(() => flash(okMsg, 'ok'), () => flash('复制失败。', 'err'));
  }

  // ───────── 最下面一行：收藏夹链接清单、诊断（和页面里那个面板底部的两个按钮是同一件事） ─────────
  function copyLinks() {
    const boards = st.boards || [];
    if (!boards.length) { flash('还没有收藏夹数据。先打开并登录 Pinterest 网页，等几秒再点。', 'err'); return; }
    const lines = boards.map((b) => b.name + '\t' + (b.url ? 'https://www.pinterest.com' + b.url : '') + '\t' + (b.privacy || ''));
    copy(lines.join('\n'), '已复制 ' + lines.length + ' 个收藏夹的名字和链接。');
  }

  function copyDiag() {
    let version = '';
    try { version = chrome.runtime.getManifest().version; } catch (e) { /* ignore */ }
    const out = {
      version,
      from: 'sidepanel',
      enabled: st.enabled !== false,
      hasTarget: !!st.target,
      targetHasSection: !!(st.target && st.target.sectionId),
      boards: (st.boards || []).length,
      boardsStatus: st.boardsStatus || null,
      sectionKey: st.sectionKey || 'section',
      sheets: sheets().length,
      kw: st.kw || null,
      ensureStatus: st.ensureStatus || null,
      log: st.log || [],
    };
    copy(JSON.stringify(out, null, 2), '诊断信息已复制，可以直接贴给 Claude。');
  }

  function renderUtil() {
    const n = (st.boards || []).length;
    return h('div', { class: 'util' },
      h('span', { class: 'sp mono', text: n ? n + ' 个收藏夹 · ' + hhmm(st.boardsFetchedAt) : '还没读到收藏夹' }),
      h('button', { class: 'lnk', text: '复制诊断', title: '出问题时点这个，把复制到的内容贴给 Claude', onclick: copyDiag }),
      h('button', { class: 'lnk', text: '复制链接清单', title: '复制账号里每个收藏夹的名字和链接（同步到本地时要用）', onclick: copyLinks }));
  }

  // ───────── 导入 ─────────
  function doImport() {
    if (!importResult || !importResult.sheets.length) return;
    let list = sheets();
    for (const s of importResult.sheets) list = P.upsert(list, s);
    const first = importResult.sheets[0];
    const n = importResult.sheets.length;
    const importedNow = importResult.sheets;
    importText = '';
    importResult = null;
    view = 'sheet';
    const imported = importedNow;
    S.set({ sheets: list, activeSheet: first.id }).then(() => flash('已导入' + (n > 1 ? ' ' + n + ' 份调研单' : '「' + first.title + '」'), 'ok'));
    // 小程序连着的话，顺手存一份到调研单文件夹（连不上就算了）
    if (host.ok === true) for (const s of imported) callHost('sheets.save', { sheet: P.toPlain(s), base: P.fileBase(s) }).catch(() => {});
  }

  function describe(s) {
    const n = s.groups.reduce((a, g) => a + g.keywords.length, 0);
    return '「' + s.title + '」→ 收藏夹「' + s.board + '」· ' + s.groups.length + ' 组 ' + n + ' 个关键词';
  }

  function renderImport() {
    const first = !sheets().length;
    const res = h('div', { class: 'res', hidden: true });
    const btnGo = h('button', { class: 'btn go', text: '导入', disabled: true, onclick: doImport });
    const paint = () => {
      const r = importResult;
      res.hidden = !r;
      btnGo.disabled = !(r && r.sheets.length);
      if (!r) return;
      res.className = 'res' + (r.sheets.length ? '' : ' err');
      res.textContent = '';
      if (!r.sheets.length) { res.textContent = r.error; return; }
      for (const s of r.sheets) res.appendChild(h('div', { text: describe(s) }));
    };
    const ta = h('textarea', {
      spellcheck: 'false', placeholder: '把 AI 给的 JSON 整段贴在这里。\n带 #plk= 的链接、或者含这些链接的一整段回答也可以。',
      oninput: (e) => {
        importText = e.target.value;
        importResult = importText.trim() ? P.parseImport(importText) : null;
        paint();
      },
    });
    ta.value = importText;
    paint();
    root.appendChild(h('div', { class: 'imp' },
      h('h2', { text: first ? '还没有调研单' : '导入调研单' }),
      h('p', { text: '调研单是 AI 给你排好的一组组搜索关键词。导入后点关键词，Pinterest 直接出图，保存的图自动进这一组对应的分区。' }),
      h('ol', null,
        h('li', null, '点 ', h('button', { class: 'lnk', text: '复制给 AI 的说明', onclick: () => copy(P.AI_PROMPT, '说明已复制。贴给你用的 AI，后面接上你要调研的风格。') }), '，贴给你用的 AI（ChatGPT、Claude、Gemini、DeepSeek、Kimi、豆包……都行），在后面写上要调研的风格。'),
        h('li', { text: '把它回的 JSON 代码块整段复制，贴到下面。' }),
        h('li', { text: '点“导入”。' })),
      h('p', { text: '更快的办法：复制好 JSON 后，点一下侧边栏空白处，直接按 Ctrl+V。在常见 AI 的网页上，插件会自动收下它回的调研单代码块。用 Claude Code / Codex 的 pin-research 技能出的调研单会自己存进文件夹，点“从文件夹读”或顶上的“刷新”就行。' }),
      ta,
      res,
      h('div', { class: 'row' },
        btnGo,
        h('button', { class: 'btn', text: '从文件夹读', title: '读调研单文件夹里的 *.json', onclick: () => refreshFromFolder(false) }),
        first ? null : h('button', { class: 'btn', text: '取消', onclick: () => { view = 'sheet'; importText = ''; importResult = null; render(); } }))));
    if (hostHint) root.appendChild(renderHostHint());
    if (flashMsg) root.appendChild(h('div', { class: 'note ' + flashMsg.kind, style: 'margin:0 12px 12px', text: flashMsg.text }));
  }

  // ───────── 调研单主视图 ─────────
  function renderTarget(sheet) {
    const on = st.enabled !== false && !!st.target;
    const kw = st.kw && st.kw.sheetId === sheet.id ? st.kw : null;
    const stat = kw ? statOf(sheet, kw.q) : null;
    const last = (st.log || [])[0];
    const box = h('div', { class: 'tgt' + (on ? '' : ' off') },
      h('div', { class: 'mono', text: on ? '保存进 LOCKED' : st.target ? '已暂停 PAUSED' : '还没选目标 NO TARGET' }),
      h('div', { class: 't1', text: st.target ? label(st.target) : '点下面任意一个关键词开始' }));
    if (kw) {
      box.appendChild(h('div', { class: 't2' }, '当前词 ', h('b', { text: kw.q }), stat && stat.saves ? ' · 已存 ' + stat.saves + ' 张' : ''));
    }
    if (last && last.text && Date.now() - last.t < 3600 * 1000) {
      box.appendChild(h('div', { class: 't2', text: hhmm(last.t) + ' ' + last.text, title: last.text }));
    }
    return box;
  }

  function renderMissing(sheet) {
    const miss = P.missingOf(st.boards, sheet);
    if (!miss.board && !miss.sections.length) return null;
    const busy = !!ensure && ensure.sheetId === sheet.id;
    const box = h('div', { class: 'note' });
    box.appendChild(h('div', {
      text: miss.board ? '你的账号里还没有收藏夹「' + sheet.board + '」。要新建：' : '收藏夹「' + sheet.board + '」里还缺 ' + miss.sections.length + ' 个分区：',
    }));
    const ul = h('ul');
    if (miss.board) ul.appendChild(h('li', { text: '收藏夹（Board）' + sheet.board }));
    if (miss.sections.length) ul.appendChild(h('li', { text: '分区（Section）' + miss.sections.join('、') }));
    box.appendChild(ul);
    const row = h('div', { class: 'row' },
      h('button', { class: 'btn go', text: busy ? '正在新建…' : '新建这些', disabled: busy, onclick: () => createMissing(sheet) }));
    if (miss.board) {
      row.appendChild(h('span', { class: 'seg', title: '私密（Secret）收藏夹只有你能看到；同步到本地时需要登录 cookie' },
        h('button', { class: sheet.privacy !== 'secret' ? 'on' : '', text: '公开', onclick: () => setPrivacy(sheet, 'public') }),
        h('button', { class: sheet.privacy === 'secret' ? 'on' : '', text: '私密', onclick: () => setPrivacy(sheet, 'secret') })));
    }
    box.appendChild(row);
    return box;
  }

  function renderGroup(sheet, g) {
    const r = P.resolve(st.boards, sheet.board, g.section);
    const isCur = !!st.kw && st.kw.sheetId === sheet.id && st.kw.group === g.name;
    let saves = 0;
    const kws = h('div', { class: 'kws' });
    for (const k of g.keywords) {
      const stat = statOf(sheet, k.q);
      if (stat && stat.saves) saves += stat.saves;
      const cur = isCurKw(sheet, g, k.q);
      kws.appendChild(h('button', {
        class: 'kw' + (cur ? ' cur' : stat && stat.seen ? ' seen' : ''),
        title: k.q + (k.note ? '\n' + k.note : '') + (stat && stat.saves ? '\n已存 ' + stat.saves + ' 张' : ''),
        onclick: () => go(sheet, g, k.q),
      }, h('span', { text: k.q }), stat && stat.saves ? h('em', { text: String(stat.saves) }) : null));
    }
    return h('div', { class: 'card' + (isCur ? ' cur' : '') },
      h('div', { class: 'ch' },
        h('div', { class: 'gn', text: g.name, title: g.name }),
        saves ? h('span', { class: 'tag', text: '存 ' + saves }) : null,
        g.section
          ? h('span', { class: 'tag' + (r.missing ? ' miss' : ''), text: r.missing ? '分区未建' : '§ ' + g.section, title: r.missing ? '这一组的分区还没建' : '保存进分区「' + g.section + '」' })
          : h('span', { class: 'tag' + (r.missing ? ' miss' : ''), text: r.missing ? '收藏夹未建' : '收藏夹根', title: '这一组直接存进收藏夹，不分区' })),
      g.note ? h('div', { class: 'gnote', text: g.note }) : null,
      kws);
  }

  function renderSheet() {
    const sheet = current();
    const list = sheets();
    const sel = h('select', { title: '切换调研单', onchange: (e) => S.set({ activeSheet: e.target.value }) });
    for (const s of list) {
      const o = h('option', { value: s.id, text: s.title });
      if (s.id === sheet.id) o.selected = true;
      sel.appendChild(o);
    }
    const flat = P.flatKeywords(sheet);
    const pos = flat.findIndex((k) => isCurKw(sheet, k.group, k.q));
    const seen = flat.filter((k) => { const x = statOf(sheet, k.q); return x && x.seen; }).length;

    const fresh = st.inbox && st.inbox.t ? (st.inbox.titles || []) : null;
    root.appendChild(h('div', { class: 'pick' }, sel,
      h('button', {
        class: 'btn' + (fresh ? ' hot' : ''), text: fresh ? '刷新 •' : '刷新',
        title: fresh ? '文件夹里有新的调研单：' + fresh.join('、') : '重新读调研单文件夹' + (host.info ? '：' + host.info.sheetsDir : ''),
        onclick: () => refreshFromFolder(false),
      }),
      h('button', { class: 'btn', text: '导入', onclick: () => { view = 'import'; render(); } })));
    if (hostHint) root.appendChild(renderHostHint());
    root.appendChild(h('div', { class: 'sub' },
      h('span', { class: 'sp', text: '收藏夹 ' + sheet.board + ' · 看过 ' + seen + '/' + flat.length, title: sheet.note || '' }),
      h('button', { class: 'lnk', text: '复制链接', title: '复制这份调研单的链接；在别处点开会自动导入', onclick: () => copy(P.sheetLink(sheet), '调研单链接已复制。') }),
      h('button', { class: 'lnk danger', text: delArmed ? '再点一次删除' : '删除', title: '只删这份调研单，不动 Pinterest 上的收藏夹', onclick: () => removeSheet(sheet) })));
    root.appendChild(renderTarget(sheet));
    const miss = renderMissing(sheet);
    if (miss) root.appendChild(miss);
    if (flashMsg) root.appendChild(h('div', { class: 'note ' + flashMsg.kind, text: flashMsg.text }));

    const listEl = h('div', { class: 'list' });
    if (sheet.note) listEl.appendChild(h('div', { class: 'gnote', style: 'padding:0 0 9px', text: sheet.note }));
    for (const g of sheet.groups) listEl.appendChild(renderGroup(sheet, g));
    root.appendChild(listEl);

    root.appendChild(renderSync(sheet));

    root.appendChild(h('div', { class: 'foot' },
      h('button', { class: 'btn', text: '◀ 上一个', onclick: () => step(-1) }),
      h('span', { class: 'mid mono', text: (pos === -1 ? '–' : pos + 1) + ' / ' + flat.length }),
      h('button', { class: 'btn go', text: '下一个 ▶', onclick: () => step(1) })));
  }

  function render() {
    const keepScroll = root.querySelector('.list');
    const top = keepScroll ? keepScroll.scrollTop : 0;
    root.textContent = '';
    root.appendChild(h('div', { class: 'head' },
      h('div', { class: 'brand' }, 'PIN', h('i', { text: '/' }), 'BOARD', h('i', { text: '/' }), 'LOCK', h('span', { style: 'font-weight:400;letter-spacing:.04em', text: '  调研单' }))));
    if (view === 'import' || !sheets().length) renderImport();
    else renderSheet();
    root.appendChild(renderUtil());
    const now = root.querySelector('.list');
    if (now) now.scrollTop = top;
    const ta = root.querySelector('textarea');
    if (ta && document.activeElement !== ta && (view === 'import' || !sheets().length)) ta.focus();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    let hit = false;
    for (const k of KEYS) {
      if (k in changes) { st[k] = changes[k].newValue; hit = true; }
    }
    if ('ensureStatus' in changes) onEnsureStatus(st.ensureStatus);
    if (hit) softRender();
  });

  // 复制好调研单 JSON 之后，在侧边栏里直接按 Ctrl+V 就导入（不用先点“导入”）。正在输入框里打字时不抢。
  document.addEventListener('paste', (e) => {
    if (typing()) return;
    const text = (e.clipboardData && e.clipboardData.getData('text')) || '';
    if (!text.trim()) return;
    e.preventDefault();
    const r = P.parseImport(text);
    if (!r.sheets.length) { flash('剪贴板里的不是调研单：' + r.error, 'err'); return; }
    importResult = r;
    doImport();
  });

  S.get(KEYS).then((v) => {
    st = v || {};
    render();
    hello().then(() => refreshFromFolder(true), () => softRender());
  });
})();
