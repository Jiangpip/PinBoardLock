// 整条链路的浏览器测试：起一个假的 Pinterest 本地站点，把扩展的脚本原样加载进去（chrome.* 用假的），
// 再用无头 Chrome 走一遍“点调研单链接 → 切目标 → 缺分区询问 → 新建 → 侧边栏点关键词”，顺手截图。
// 用法：node tests\harness.js [截图输出目录]
// 不碰真的 Pinterest，也不需要登录。
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const EXT = path.resolve(__dirname, '..', 'extension');
const OUT = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'pbl-harness'));
const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 8717;
const DEBUG_PORT = 9347;
fs.mkdirSync(OUT, { recursive: true });

let failed = 0;
const check = (name, cond, extra) => {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (cond ? '' : '   ' + (extra === undefined ? '' : JSON.stringify(extra))));
  if (!cond) failed++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ───────── 假的 Pinterest ─────────
let db;
let writes;
function resetDb() {
  db = {
    nextId: 500,
    boards: [
      { type: 'board', id: '1', name: 'Ink Study', url: '/me/ink-study/', privacy: 'public', pin_count: 42, section_count: 2 },
      { type: 'board', id: '2', name: '峡谷地貌', url: '/me/gorge/', privacy: 'public', pin_count: 206, section_count: 0 },
    ],
    sections: { 1: [{ id: '10', title: 'Mist', pin_count: 12 }, { id: '11', title: 'Brushwork', pin_count: 5 }] },
  };
  writes = [];
}
resetDb();

// 假的 chrome.*：storage 落在 localStorage 里，这样“页面”和“侧边栏”两个地址看到的是同一份
const STUB = `
(() => {
  const KEY = '__pbl_store';
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { return {}; } };
  const listeners = [];
  const fire = (changes) => listeners.slice().forEach((f) => { try { f(changes, 'local'); } catch (e) { console.error(e); } });
  window.addEventListener('storage', (ev) => {
    if (ev.key !== KEY) return;
    const a = JSON.parse(ev.oldValue || '{}'), b = JSON.parse(ev.newValue || '{}'), ch = {};
    for (const k of new Set(Object.keys(a).concat(Object.keys(b)))) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) ch[k] = { oldValue: a[k], newValue: b[k] };
    if (Object.keys(ch).length) fire(ch);
  });
  window.__sent = [];
  window.__nav = [];
  window.__tabMsgs = [];
  window.chrome = {
    storage: {
      local: {
        get(keys) {
          const all = load(), out = {};
          for (const k of [].concat(keys || Object.keys(all))) if (k in all) out[k] = all[k];
          return Promise.resolve(out);
        },
        set(obj) {
          const all = load(), ch = {};
          for (const k of Object.keys(obj)) {
            const v = JSON.parse(JSON.stringify(obj[k] === undefined ? null : obj[k]));
            ch[k] = { oldValue: all[k], newValue: v };
            all[k] = v;
          }
          localStorage.setItem(KEY, JSON.stringify(all));
          return Promise.resolve().then(() => fire(ch));
        },
      },
      onChanged: { addListener: (f) => listeners.push(f), removeListener: (f) => { const i = listeners.indexOf(f); if (i !== -1) listeners.splice(i, 1); } },
    },
    runtime: {
      id: 'abcdefghijklmnopabcdefghijklmnop',
      onMessage: { addListener: (f) => { window.__onMessage = f; } },
      sendMessage: (m) => { window.__sent.push(m); return Promise.resolve(window.__sendReply ? window.__sendReply(m) : undefined); },
      // 假的本机小程序：装没装、文件夹里有什么，从 localStorage.__pbl_host 读（测试在打开页面之前写好）
      connectNative: () => {
        const h = window.__host = Object.assign({ installed: true, sheets: [], errors: [], status: { state: 'idle' } },
          JSON.parse(localStorage.getItem('__pbl_host') || '{}'), { saved: [], runs: [], calls: [] });
        const onMsg = [], onDis = [];
        const port = { onMessage: { addListener: (f) => onMsg.push(f) }, onDisconnect: { addListener: (f) => onDis.push(f) }, disconnect() {} };
        h.emit = (m) => onMsg.slice().forEach((f) => f(m));
        if (!h.installed) {
          port.postMessage = () => {};
          setTimeout(() => { chrome.runtime.lastError = { message: 'Specified native messaging host not found.' }; onDis.forEach((f) => f(port)); chrome.runtime.lastError = undefined; }, 20);
          return port;
        }
        port.postMessage = (m) => setTimeout(() => {
          h.calls.push(m.cmd);
          let r = { ok: false, error: '不认识的命令' };
          if (m.cmd === 'hello') r = { ok: true, version: '0.4.0', sheetsDir: 'E:\\\\PinBoardLock\\\\sheets', defaultRoot: 'D:\\\\图库\\\\参考图', status: h.status };
          else if (m.cmd === 'sheets.list') r = { ok: true, dir: 'E:\\\\PinBoardLock\\\\sheets', sheets: h.sheets, errors: h.errors };
          else if (m.cmd === 'sheets.save') { h.saved.push(m); r = { ok: true, file: m.base + '.json' }; }
          else if (m.cmd === 'sync.run') { h.runs.push(m); r = { ok: true, started: true }; }
          else if (m.cmd === 'sync.status') r = { ok: true, status: h.status };
          h.emit(Object.assign({ id: m.id }, r));
        }, 10);
        return port;
      },
    },
    tabs: {
      query: async () => [{ id: 7, url: location.origin + '/search/pins/?q=old' }],
      update: async (id, p) => { window.__nav.push(p.url); },
      create: async (p) => { window.__nav.push('NEW ' + p.url); },
      sendMessage: async (id, m) => { window.__tabMsgs.push(m); },
    },
  };
  window.__store = load;
})();
`;

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>fake pinterest</title>
<script src="/__stub.js"></script>
<script src="/ext/inject.js"></script>
<script src="/ext/sheet.js"></script><script src="/ext/picker.js"></script><script src="/ext/content.js"></script>
<style>body{margin:0;background:#fff;font:14px system-ui}.g{columns:5;gap:12px;padding:70px 16px}.g div{break-inside:avoid;margin-bottom:12px;border-radius:14px;background:#e9e6e0}</style>
</head><body><div class="g">${Array.from({ length: 22 }, (_, i) => `<div style="height:${120 + ((i * 53) % 190)}px"></div>`).join('')}</div></body></html>`;

function json(res, obj, status) {
  res.writeHead(status || 200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/__stub.js') { res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' }); res.end(STUB); return; }
  if (u.pathname.startsWith('/ext/')) {
    const f = path.join(EXT, path.basename(u.pathname));
    if (!fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
    const type = f.endsWith('.js') ? 'text/javascript' : f.endsWith('.html') ? 'text/html' : 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(fs.readFileSync(f));
    return;
  }
  if (u.pathname === '/sidepanel') {
    const html = fs.readFileSync(path.join(EXT, 'sidepanel.html'), 'utf8')
      .replace('<script src="sheet.js">', '<script src="/__stub.js"></script><script src="/ext/sheet.js">')
      .replace('src="sidepanel.js"', 'src="/ext/sidepanel.js"');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }
  if (u.pathname === '/chat') {
    // 假的 AI 聊天页：只加载 capture.js 那一套
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><head><meta charset="utf-8"><title>fake chat</title><script src="/__stub.js"></script></head>'
      + '<body style="font:14px system-ui;padding:24px;max-width:720px"><div id="chat"><p>好的，这是按你的规格整理的调研单：</p></div>'
      + '<script src="/ext/sheet.js"></script><script src="/ext/capture.js"></script></body></html>');
    return;
  }
  if (u.pathname.startsWith('/resource/')) {
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const o = JSON.parse(new URLSearchParams(body).get('data')).options;
        writes.push({ path: u.pathname, options: o, csrf: req.headers['x-csrftoken'] || '' });
        if (!req.headers['x-csrftoken']) return json(res, { resource_response: { error: { message: 'CSRF verification failed' } } }, 403);
        if (u.pathname.includes('BoardResource/create')) {
          const b = { type: 'board', id: String(db.nextId++), name: o.name, url: '/me/' + encodeURIComponent(o.name) + '/', privacy: o.privacy, pin_count: 0, section_count: 0 };
          db.boards.push(b);
          return json(res, { resource_response: { data: b } });
        }
        if (u.pathname.includes('BoardSectionResource/create')) {
          const sec = { id: String(db.nextId++), title: o.name, pin_count: 0 };
          (db.sections[o.board_id] = db.sections[o.board_id] || []).push(sec);
          const b = db.boards.find((x) => x.id === String(o.board_id));
          if (b) b.section_count++;
          return json(res, { resource_response: { data: sec } });
        }
        json(res, {}, 404);
      });
      return;
    }
    const data = JSON.parse(u.searchParams.get('data') || '{}');
    if (u.pathname.includes('BoardPickerBoardsResource')) return json(res, { client_context: { user: { username: 'me' } }, resource_response: { data: { all_boards: [] } } });
    if (u.pathname.includes('BoardsResource')) return json(res, { resource_response: { data: db.boards }, resource: { options: { bookmarks: ['-end-'] } } });
    if (u.pathname.includes('BoardSectionsResource')) return json(res, { resource_response: { data: db.sections[data.options.board_id] || [] }, resource: { options: { bookmarks: ['-end-'] } } });
    return json(res, {}, 404);
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Set-Cookie': 'csrftoken=tok123; Path=/' });
  res.end(PAGE);
});

// ───────── 极简 CDP 客户端 ─────────
async function connect() {
  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + DEBUG_PORT + '/json')).json();
      target = list.find((t) => t.type === 'page');
    } catch (e) { /* 还没起来 */ }
    if (!target) await sleep(250);
  }
  if (!target) throw new Error('连不上无头 Chrome');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0;
  const waiters = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); }
  };
  const send = (method, params) => new Promise((res, rej) => {
    const id = ++seq;
    waiters.set(id, (m) => (m.error ? rej(new Error(method + ': ' + m.error.message)) : res(m.result)));
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('页面里出错：' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
    return r.result.value;
  };
  const goto = async (url) => {
    await send('Page.navigate', { url });
    for (let i = 0; i < 80; i++) {
      await sleep(100);
      try { if (await evaluate('document.readyState') === 'complete') return; } catch (e) { /* 正在跳转 */ }
    }
  };
  const until = async (expr, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 8000)) {
      if (await evaluate(expr)) return true;
      await sleep(120);
    }
    return false;
  };
  const shot = async (name, w, h) => {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await sleep(350);
    const r = await send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(OUT, name + '.png');
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    return file;
  };
  await send('Page.enable');
  await send('Runtime.enable');
  return { send, evaluate, goto, until, shot, close: () => ws.close() };
}

const ORIGIN = 'http://localhost:' + PORT;
const SHADOW = `document.getElementById('pbl-host').shadowRoot`;
const SHEET = {
  title: '水墨感山水',
  board: '风格调研-水墨感',
  note: '给阳朔溪谷找的画面气质参考',
  groups: [
    { name: '河面雾气', note: '看雾怎么压住远山、留白占多少', keywords: ['karst river mist', 'li river morning fog', 'ink wash river landscape', '漓江 晨雾', 'misty mountains chinese painting'] },
    { name: '峰林剪影', note: '逆光下山的轮廓层次', keywords: ['guilin mountains silhouette', 'layered mountains fog', 'karst peaks sunrise', 'shan shui silhouette'] },
    { name: '笔触与留白', section: '笔触', keywords: ['sumi-e brush strokes', 'chinese ink wash texture', { q: 'wu guanzhong landscape', note: '吴冠中' }, 'negative space ink painting'] },
    { name: '散图', section: false, keywords: ['yangshuo bamboo raft', 'stylized karst concept art'] },
  ],
};

(async () => {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pbl-chrome-'));
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + DEBUG_PORT, '--user-data-dir=' + profile,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1280,800', 'about:blank'], { stdio: 'ignore' });
  let c;
  try {
    c = await connect();
    const P = require(path.join(EXT, 'sheet.js'));
    const store = () => c.evaluate('window.__store()');
    const fresh = async (url) => { resetDb(); await c.goto(ORIGIN + '/blank'); await c.evaluate('localStorage.clear()'); await c.goto(url); };

    // A. 点一个关键词链接，收藏夹和分区都已经有
    await fresh(ORIGIN + '/search/pins/?q=karst+river+mist&rs=typed#plk=Ink+Study/Mist');
    check('A 链接打开后地址里的 #plk 被去掉', await c.evaluate('location.hash') === '' && await c.evaluate('location.search') === '?q=karst+river+mist&rs=typed');
    check('A 等到目标切好', await c.until(`(window.__store().target || {}).sectionId === '10'`));
    let s = await store();
    check('A 目标 = Ink Study / Mist', s.target && s.target.boardId === '1' && s.target.sectionTitle === 'Mist' && s.enabled === true, s.target);
    check('A 记下当前关键词', s.kw && s.kw.q === 'karst river mist' && s.kw.boardId === '1' && s.kw.sectionId === '10', s.kw);
    check('A 自动生成一份调研单', s.sheets && s.sheets.length === 1 && s.sheets[0].board === 'Ink Study' && s.sheets[0].groups[0].keywords[0].q === 'karst river mist', s.sheets);
    check('A 状态条显示目标', await c.evaluate(`${SHADOW}.querySelector('.bar .v').textContent`) === 'Ink Study / Mist');
    check('A 没有弹出新建询问', await c.evaluate(`${SHADOW}.querySelector('.ask').classList.contains('open')`) === false);
    // 模拟 Pinterest 自己发的保存请求：应该被改写，且给关键词计数
    await c.evaluate(`fetch('/resource/RepinResource/create/', { method: 'POST', headers: { 'X-CSRFToken': 'tok123', 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ source_url: '/pin/9/', data: JSON.stringify({ options: { pin_id: '9', board_id: '2' }, context: {} }) }).toString() }).then(() => 1)`);
    const repin = writes.find((w) => w.path.includes('RepinResource'));
    check('A 保存请求被改写到目标分区', repin && repin.options.board_id === '1' && repin.options.section === '10', repin);

    // B. 链接要的收藏夹和分区都不存在 → 询问 → 点新建
    await fresh(ORIGIN + '/search/pins/?q=' + encodeURIComponent('漓江 晨雾') + '#plk=' + encodeURIComponent('风格调研-水墨感') + '/' + encodeURIComponent('河面雾气'));
    check('B 弹出新建询问', await c.until(`${SHADOW}.querySelector('.ask').classList.contains('open')`));
    check('B 询问里写清楚缺什么', /收藏夹「风格调研-水墨感」还没建/.test(await c.evaluate(`${SHADOW}.querySelector('.ask .a1').textContent`)));
    check('B 没点之前不会自己去建', writes.length === 0, writes);
    s = await store();
    check('B 没建之前不改目标', !s.target, s.target);
    console.log('  截图 ' + await c.shot('1-ask', 1280, 800));
    await c.evaluate(`${SHADOW}.querySelector('.ask .go').click()`);
    check('B 新建后目标切到新分区', await c.until(`(window.__store().target || {}).sectionTitle === '河面雾气'`));
    s = await store();
    check('B 建了 1 个收藏夹 + 1 个分区', writes.length === 2 && writes[0].options.name === '风格调研-水墨感' && writes[1].options.name === '河面雾气' && writes[0].csrf === 'tok123', writes);
    check('B 目标的 id 是新建出来的', s.target && s.target.boardId === '500' && s.target.sectionId === '501', s.target);
    check('B 询问收起', await c.evaluate(`${SHADOW}.querySelector('.ask').classList.contains('open')`) === false);
    check('B 收藏夹列表已更新', s.boards.some((b) => b.name === '风格调研-水墨感' && b.sections.length === 1));
    check('B 当前关键词补上了目标 id', s.kw && s.kw.q === '漓江 晨雾' && s.kw.boardId === '500', s.kw);

    // C. 整份调研单的链接
    const sheet = P.normalizeSheet(SHEET);
    await fresh(P.sheetLink(sheet, ORIGIN));
    check('C 调研单导入', await c.until(`(window.__store().sheets || []).length === 1`));
    s = await store();
    check('C 内容完整', s.sheets[0].id === sheet.id && s.sheets[0].groups.length === 4 && s.activeSheet === sheet.id);
    check('C 第一个关键词的分区没建 → 询问', await c.until(`${SHADOW}.querySelector('.ask').classList.contains('open')`));

    // D. 侧边栏：缺收藏夹的状态
    await c.goto(ORIGIN + '/sidepanel');
    check('D 侧边栏显示调研单', await c.until(`document.querySelectorAll('.card').length === 4`));
    check('D 提示要新建什么', /还没有收藏夹「风格调研-水墨感」/.test(await c.evaluate(`document.querySelector('.note').textContent`)), await c.evaluate(`document.querySelector('.note') && document.querySelector('.note').textContent`));
    console.log('  截图 ' + await c.shot('2-panel-missing', 400, 860));
    await c.evaluate(`[...document.querySelectorAll('.note .btn')].find((b) => b.textContent === '新建这些').click()`);
    check('D 点新建 → 发给 Pinterest 标签页', await c.until(`window.__tabMsgs.length === 1`));
    const msg = (await c.evaluate('window.__tabMsgs'))[0];
    check('D 消息里是收藏夹 + 三个分区（不分区的那组不算）', msg.type === 'pbl-ensure' && msg.board === '风格调研-水墨感' && msg.sections.join('|') === '河面雾气|峰林剪影|笔触', msg);

    // E. 侧边栏：都建好之后点关键词
    resetDb();
    db.boards.push({ type: 'board', id: '500', name: '风格调研-水墨感', url: '/me/ink/', privacy: 'public', pin_count: 31, section_count: 3 });
    db.sections[500] = [{ id: '501', title: '河面雾气' }, { id: '502', title: '峰林剪影' }, { id: '503', title: '笔触' }];
    const boards = db.boards.map((b) => ({ id: b.id, name: b.name, url: b.url, privacy: b.privacy, pinCount: b.pin_count, cover: '', sections: (db.sections[b.id] || []).map((x) => ({ id: x.id, title: x.title })) }));
    await c.evaluate(`chrome.storage.local.set(${JSON.stringify({ boards, boardsFetchedAt: Date.now() })}).then(() => 1)`);
    check('E 收藏夹齐了 → 新建提示消失', await c.until(`!document.querySelector('.note')`));
    await c.evaluate(`[...document.querySelectorAll('.kw')].find((b) => b.textContent === 'guilin mountains silhouette').click()`);
    check('E 点关键词 → 让标签页去搜', await c.until(`window.__nav.length === 1`));
    const nav = (await c.evaluate('window.__nav'))[0];
    check('E 搜索地址', nav === ORIGIN + '/search/pins/?q=guilin%20mountains%20silhouette&rs=typed', nav);
    s = await store();
    check('E 目标切到这一组的分区', s.target && s.target.boardId === '500' && s.target.sectionId === '502' && s.target.sectionTitle === '峰林剪影', s.target);
    check('E 当前关键词和“看过”标记', s.kw.q === 'guilin mountains silhouette' && s.kwStats[sheet.id]['guilin mountains silhouette'].seen > 0, s.kw);
    await c.evaluate(`[...document.querySelectorAll('.foot .btn')].find((b) => b.textContent.includes('下一个')).click()`);
    check('E 下一个 → 同组的下一个词', await c.until(`window.__nav.length === 2 && window.__store().kw.q === 'layered mountains fog'`), await c.evaluate('window.__store().kw'));
    await c.evaluate(`[...document.querySelectorAll('.kw')].find((b) => b.textContent === 'yangshuo bamboo raft').click()`);
    check('E 不分区的组 → 目标是收藏夹本身', await c.until(`window.__store().kw.q === 'yangshuo bamboo raft' && window.__store().target.sectionId === null && window.__store().target.boardId === '500'`), await c.evaluate('window.__store().target'));
    // 摆一个看起来像用了一阵子的状态再截图
    const stats = {};
    stats[sheet.id] = {
      'karst river mist': { seen: 1, saves: 7 }, 'li river morning fog': { seen: 1, saves: 3 }, 'ink wash river landscape': { seen: 1, saves: 0 },
      'guilin mountains silhouette': { seen: 1, saves: 5 }, 'layered mountains fog': { seen: 1, saves: 2 },
    };
    const tgt = P.resolve(boards, sheet.board, '峰林剪影').target;
    await c.evaluate(`chrome.storage.local.set(${JSON.stringify({
      kwStats: stats, target: tgt,
      kw: { sheetId: sheet.id, group: '峰林剪影', q: 'layered mountains fog', t: Date.now(), boardId: '500', sectionId: '502' },
      log: [{ t: Date.now(), kind: 'ok', text: '已存到「风格调研-水墨感 / 峰林剪影」' }],
    })}).then(() => 1)`);
    await sleep(200);
    check('E 当前组高亮、计数显示', await c.evaluate(`document.querySelector('.card.cur .gn').textContent`) === '峰林剪影' && await c.evaluate(`document.querySelector('.kw.cur em').textContent`) === '2');
    console.log('  截图 ' + await c.shot('3-panel-working', 400, 860));

    // F. 导入视图
    await c.evaluate(`[...document.querySelectorAll('.btn')].find((b) => b.textContent === '导入').click()`);
    const pasted = '```json\n' + JSON.stringify({ title: '赛璐璐厚涂', board: '风格调研-赛璐璐', groups: [{ name: '阴影分层', keywords: ['cel shading study', 'anime background painting'] }, { name: '用色', keywords: ['90s anime color palette'] }] }, null, 2) + '\n```';
    await c.evaluate(`(() => { const ta = document.querySelector('textarea'); ta.value = ${JSON.stringify(pasted)}; ta.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    check('F 贴进去就认出来', /「赛璐璐厚涂」→ 收藏夹「风格调研-赛璐璐」· 2 组 3 个关键词/.test(await c.evaluate(`document.querySelector('.res').textContent`)), await c.evaluate(`document.querySelector('.res').textContent`));
    console.log('  截图 ' + await c.shot('4-import', 400, 860));
    await c.evaluate(`[...document.querySelectorAll('.imp .btn')].find((b) => b.textContent === '导入').click()`);
    check('F 导入后切到新调研单', await c.until(`(window.__store().sheets || []).length === 2 && document.querySelector('select').selectedOptions[0].textContent === '赛璐璐厚涂'`));
    await c.evaluate(`document.querySelector('.lnk.danger').click()`);
    await sleep(100);
    check('F 删除要点两次', (await store()).sheets.length === 2 && await c.evaluate(`document.querySelector('.lnk.danger').textContent`) === '再点一次删除');
    await c.evaluate(`document.querySelector('.lnk.danger').click()`);
    check('F 第二次才删', await c.until(`(window.__store().sheets || []).length === 1`));

    // F2. 侧边栏最下面一行：复制链接清单、复制诊断
    await c.evaluate(`Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: (t) => { window.__clip = t; return Promise.resolve(); } } })`);
    const utilBtn = (text) => `[...document.querySelectorAll('.util .lnk')].find((b) => b.textContent === '${text}')`;
    check('F2 侧边栏底部有“复制链接清单”和“复制诊断”', await c.evaluate(`!!${utilBtn('复制链接清单')} && !!${utilBtn('复制诊断')}`));
    check('F2 底部显示收藏夹数量', /^3 个收藏夹/.test(await c.evaluate(`document.querySelector('.util .sp').textContent`)), await c.evaluate(`document.querySelector('.util .sp').textContent`));
    await c.evaluate(`${utilBtn('复制链接清单')}.click()`);
    await c.until('!!window.__clip');
    const clip = String(await c.evaluate('window.__clip')).split('\n');
    check('F2 链接清单：每个收藏夹一行，名字 + 链接 + 公开/私密', clip.length === 3 && clip[2] === '风格调研-水墨感\thttps://www.pinterest.com/me/ink/\tpublic', clip);
    check('F2 复制后有提示', /已复制 3 个收藏夹/.test(await c.evaluate(`(document.querySelector('.note.ok') || {}).textContent || ''`)));
    await c.evaluate(`window.__clip = ''; ${utilBtn('复制诊断')}.click()`);
    await c.until('!!window.__clip');
    const diag = JSON.parse(await c.evaluate('window.__clip'));
    check('F2 诊断内容', diag.from === 'sidepanel' && diag.boards === 3 && diag.hasTarget === true && diag.sheets === 1 && Array.isArray(diag.log), diag);
    console.log('  截图 ' + await c.shot('4b-panel-util', 400, 860));

    // G. 页面里的面板：有“调研单”按钮，点了通知后台
    await c.goto(ORIGIN + '/search/pins/?q=x');
    await c.until(`!!document.getElementById('pbl-host')`);
    await c.evaluate(`${SHADOW}.querySelector('.bar').click()`);
    check('G 面板里有“调研单”按钮', await c.until(`!!${SHADOW}.querySelector('.hbtn')`));
    await c.evaluate(`${SHADOW}.querySelector('.hbtn').click()`);
    check('G 点了 → 请后台打开侧边栏', JSON.stringify(await c.evaluate('window.__sent')) === '[{"type":"pbl-open-panel"}]', await c.evaluate('window.__sent'));
    console.log('  截图 ' + await c.shot('5-picker', 1280, 800));

    // H. 状态条：拖动、吸到两侧、面板朝有空间的方向开、位置记住
    const VW = 1280, VH = 800;
    await c.send('Emulation.setDeviceMetricsOverride', { width: VW, height: VH, deviceScaleFactor: 1, mobile: false });
    await c.evaluate(`chrome.storage.local.set({ dock: null }).then(() => 1)`);
    await c.goto(ORIGIN + '/search/pins/?q=x');
    await c.until(`!!document.getElementById('pbl-host')`);
    await sleep(200);
    const rectOf = (sel) => c.evaluate(`(() => { const r = ${SHADOW}.querySelector('${sel}').getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, w: r.width, h: r.height }; })()`);
    const wrapCls = () => c.evaluate(`${SHADOW}.querySelector('.wrap').className`);
    const popOpen = () => c.evaluate(`${SHADOW}.querySelector('.pop').classList.contains('open')`);
    const mouse = (type, x, y) => c.send('Input.dispatchMouseEvent', { type, x: Math.round(x), y: Math.round(y), button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
    const dragBar = async (tx, ty) => {
      const r = await rectOf('.bar');
      const x = r.left + r.w / 2, y = r.top + r.h / 2;
      await mouse('mousePressed', x, y);
      for (let i = 1; i <= 8; i++) await mouse('mouseMoved', x + ((tx - x) * i) / 8, y + ((ty - y) * i) / 8);
      await mouse('mouseReleased', tx, ty);
      await sleep(400);
    };
    const clickBar = async () => {
      const r = await rectOf('.bar');
      await mouse('mousePressed', r.left + r.w / 2, r.top + r.h / 2);
      await mouse('mouseReleased', r.left + r.w / 2, r.top + r.h / 2);
      await sleep(150);
    };
    const inView = (r) => r.left >= 0 && r.top >= 0 && r.right <= VW && r.bottom <= VH;

    let bar = await rectOf('.bar');
    check('H 默认在左下角', /\bL\b/.test(await wrapCls()) && /\bup\b/.test(await wrapCls()) && Math.abs(bar.left - 14) <= 1 && Math.abs(VH - bar.bottom - 14) <= 2, { bar, cls: await wrapCls() });
    await clickBar();
    check('H 没拖动的点击照常开面板', await popOpen() === true);
    await clickBar();
    check('H 再点一次收起', await popOpen() === false);

    await dragBar(1050, 400);
    bar = await rectOf('.bar');
    s = await store();
    check('H 拖到右半边 → 吸到右侧', /\bR\b/.test(await wrapCls()) && !/\bdrag\b/.test(await wrapCls()) && bar.right <= VW - 13 && bar.right >= VW - 14 - 20, { bar, cls: await wrapCls() });
    check('H 上下留在松手的高度', Math.abs((bar.top + bar.h / 2) - 400) <= 3, bar);
    check('H 位置存下来了', s.dock && s.dock.side === 'right' && Math.abs(s.dock.y - 0.5) < 0.02, s.dock);
    check('H 拖完松手不会误开面板', await popOpen() === false);
    await clickBar();
    let pop = await rectOf('.pop');
    check('H 右侧时面板整个在窗口里、右边对齐', await popOpen() === true && inView(pop) && Math.abs(pop.right - bar.right) <= 4, { pop, bar });
    console.log('  截图 ' + await c.shot('6-dock-right', VW, VH));
    await clickBar();

    await dragBar(180, 40);
    bar = await rectOf('.bar');
    check('H 拖到左上 → 吸到左侧、贴着上边', /\bL\b/.test(await wrapCls()) && /\bdown\b/.test(await wrapCls()) && Math.abs(bar.left - 14) <= 1 && bar.top >= 14 && bar.top <= 60, { bar, cls: await wrapCls() });
    await clickBar();
    pop = await rectOf('.pop');
    check('H 在上边时面板往下开', await popOpen() === true && pop.top >= bar.bottom && inView(pop), { pop, bar });
    console.log('  截图 ' + await c.shot('7-dock-top-left', VW, VH));

    const before = bar;
    await c.goto(ORIGIN + '/search/pins/?q=y');
    await c.until(`!!document.getElementById('pbl-host')`);
    await sleep(300);
    bar = await rectOf('.bar');
    check('H 换页面后位置还在', Math.abs(bar.left - before.left) <= 1 && Math.abs(bar.top - before.top) <= 2, { bar, before });

    // 右侧时，新建询问出现在状态条左边，不会跑出窗口
    await c.evaluate(`chrome.storage.local.set({ dock: { side: 'right', y: 1 } }).then(() => 1)`);
    await c.goto(ORIGIN + '/search/pins/?q=z#plk=' + encodeURIComponent('还没有的收藏夹') + '/' + encodeURIComponent('某分区'));
    check('H 右侧：询问弹出', await c.until(`${SHADOW}.querySelector('.ask').classList.contains('open')`));
    await sleep(200);
    const ask = await rectOf('.ask');
    bar = await rectOf('.bar');
    check('H 右侧：询问在状态条左边、在窗口里', ask.right <= bar.left && inView(ask), { ask, bar });
    console.log('  截图 ' + await c.shot('8-dock-right-ask', VW, VH));

    // I. 侧边栏 + 本机小程序：打开时自动读文件夹、刷新、下载 + 同步
    const inkBoards = [
      { id: '1', name: 'Ink Study', url: '/me/ink-study/', privacy: 'public', pinCount: 42, cover: '', sections: [] },
      { id: '500', name: '风格调研-水墨感', url: '/me/ink/', privacy: 'public', pinCount: 318, cover: '', sections: [{ id: '501', title: '河面雾气' }, { id: '502', title: '峰林剪影' }, { id: '503', title: '笔触' }] },
    ];
    const inkEdited = JSON.parse(JSON.stringify(SHEET));
    inkEdited.groups[0].keywords.push('guilin fog photography');
    const cyber = { title: '赛博霓虹', board: '风格调研-赛博', folder: '赛博霓虹参考', groups: [{ name: '招牌', keywords: ['neon signage night', 'cyberpunk alley'] }, { name: '雨夜反光', keywords: ['wet street neon reflection'] }] };
    const setup = async (hostCfg, extraStore) => {
      await c.goto(ORIGIN + '/blank');
      await c.evaluate(`(() => { localStorage.clear();
        localStorage.setItem('__pbl_store', ${JSON.stringify(JSON.stringify(Object.assign({ sheets: [sheet], activeSheet: sheet.id, boards: inkBoards, boardsFetchedAt: Date.now() }, extraStore)))});
        localStorage.setItem('__pbl_host', ${JSON.stringify(JSON.stringify(hostCfg))}); })()`);
      await c.goto(ORIGIN + '/sidepanel');
      await c.until(`!!document.querySelector('.pick')`);
    };
    const btn = (scope, text) => `[...document.querySelectorAll('${scope}')].find((b) => b.textContent.includes('${text}'))`;
    const typeInto = (sel, value) => c.evaluate(`(() => { const i = document.querySelector('${sel}'); i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);

    await setup({ installed: true, sheets: [{ file: '水墨感山水.json', mtime: 1, data: inkEdited }, { file: '赛博霓虹.json', mtime: 2, data: cyber }], errors: [{ file: '坏的.json', error: 'Unexpected token' }] });
    check('I 打开侧边栏就自动读文件夹', await c.until(`(window.__store().sheets || []).length === 2`), await store());
    s = await store();
    const cyberId = P.normalizeSheet(cyber).id;
    check('I 新的那份排在最前并选中', s.sheets[0].id === cyberId && s.activeSheet === cyberId && s.sheets[0].folder === '赛博霓虹参考', s.sheets.map((x) => x.title));
    check('I 文件里改过的那份跟着更新', s.sheets[1].groups[0].keywords.length === 6 && s.sheets[1].id === sheet.id, s.sheets[1].groups[0].keywords);
    const notes = () => c.evaluate(`[...document.querySelectorAll('.note')].map((n) => n.textContent).join(' | ')`);
    check('I 提示新增、更新和读不了的文件', /新增 1 份，更新 1 份/.test(await notes()) && /读不了：坏的\.json/.test(await notes()), await notes());
    console.log('  截图 ' + await c.shot('9-panel-refreshed', 400, 860));

    await c.evaluate(`chrome.storage.local.set({ inbox: { t: 5, titles: ['刚从 ChatGPT 收下的'] } }).then(() => 1)`);
    check('I 文件夹里有新的 → “刷新”按钮变色', await c.until(`!!document.querySelector('.pick .btn.hot')`));
    await c.evaluate(`document.querySelector('.pick .btn.hot').click()`);
    check('I 点刷新 → 重新读一次，标记清掉', await c.until(`window.__store().inbox === null && window.__host.calls.filter((x) => x === 'sheets.list').length === 2`), await c.evaluate('window.__host.calls'));
    check('I 没有新的也说一声', /都已经在了/.test(await notes()), await notes());

    // 赛博那份：收藏夹还没建 → 不能开始；目标文件夹用调研单里写的 folder
    await c.evaluate(`${btn('.sync .btn', '下载 + 同步')}.click()`);
    check('I 点“下载 + 同步” → 出现目标文件夹', await c.until(`!!document.querySelector('.sync input')`));
    check('I 调研单写了 folder → 用它', await c.evaluate(`document.querySelector('.sync input').value`) === 'D:\\图库\\参考图\\赛博霓虹参考', await c.evaluate(`document.querySelector('.sync input').value`));
    check('I 收藏夹还没读到 → “开始”点不了', await c.evaluate(`${btn('.sync .btn', '开始')}.disabled`) === true);
    await c.evaluate(`${btn('.sync .btn', '取消')}.click()`);

    // 水墨那份：改目标文件夹 → 开始 → 进度 → 完成
    await c.evaluate(`chrome.storage.local.set({ activeSheet: ${JSON.stringify(sheet.id)} }).then(() => 1)`);
    await c.until(`document.querySelector('select').selectedOptions[0].textContent === '水墨感山水'`);
    await c.evaluate(`${btn('.sync .btn', '下载 + 同步')}.click()`);
    await c.until(`!!document.querySelector('.sync input')`);
    check('I 默认目标 = 默认根目录\\\\调研单标题', await c.evaluate(`document.querySelector('.sync input').value`) === 'D:\\图库\\参考图\\水墨感山水', await c.evaluate(`document.querySelector('.sync input').value`));
    console.log('  截图 ' + await c.shot('10-sync-form', 400, 860));
    await typeInto('.sync input', 'D:/图库/参考图/水墨收集/');
    await c.evaluate(`document.activeElement && document.activeElement.blur(); ${btn('.sync .btn', '开始')}.click()`);
    check('I 点开始 → 交给本机小程序', await c.until(`window.__host.runs.length === 1`));
    const run = (await c.evaluate('window.__host.runs'))[0];
    check('I 请求内容：收藏夹名、链接、整理过的路径', run.name === '风格调研-水墨感' && run.title === '水墨感山水' && run.url === 'https://www.pinterest.com/me/ink/' && run.dest === 'D:\\图库\\参考图\\水墨收集', run);
    check('I 目标文件夹记住了', ((await store()).syncDest || {})[sheet.id] === 'D:\\图库\\参考图\\水墨收集', (await store()).syncDest);
    const steps = (a, b, c3, t3) => [
      { key: 'download', label: '下载新图', state: a, text: a === 'ok' ? '新增 12 张，共 330 张' : '已下载 7 张…' },
      { key: 'scan', label: '等 Billfish 收录', state: b, text: b === 'ok' ? 'Billfish 已收录 330 / 330' : '' },
      { key: 'write', label: '写来源和标签', state: c3, text: t3 || '' },
    ];
    const emit = (status) => c.evaluate(`window.__host.emit(${JSON.stringify({ event: 'sync', status })})`);
    await emit({ state: 'running', name: '风格调研-水墨感', title: '水墨感山水', dest: run.dest, updatedAt: 10, steps: steps('ok', 'ok', 'wait', '要写 12 个来源、24 条标签。请关掉 Billfish（关窗口就行），关掉后自动继续') });
    check('I 进度：等关 Billfish 的那一步标出来', await c.until(`!!document.querySelector('.st.wait')`) && /请关掉 Billfish/.test(await c.evaluate(`document.querySelector('.st.wait .sd').textContent`)) && await c.evaluate(`document.querySelectorAll('.st.ok').length`) === 2);
    console.log('  截图 ' + await c.shot('11-sync-waiting', 400, 860));
    await emit({ state: 'done', name: '风格调研-水墨感', title: '水墨感山水', dest: run.dest, updatedAt: Date.now(), steps: steps('ok', 'ok', 'ok', '写了 12 个来源、24 条标签。Billfish 已重新打开'),
      summary: { added: 12, total: 330, dups: 3, originSet: 12, tagLinks: 24, newTags: [], backup: 'x', warnings: [] } });
    check('I 完成：一句话总结', await c.until(`!!document.querySelector('.sync .sum')`) && /新增 12 张，共 330 张；写了 12 个来源、24 条标签/.test(await c.evaluate(`document.querySelector('.sync .sum').textContent`)), await c.evaluate(`(document.querySelector('.sync .sum') || {}).textContent`));
    console.log('  截图 ' + await c.shot('12-sync-done', 400, 860));
    await c.evaluate(`${btn('.sync .btn', '好')}.click()`);
    check('I 点“好” → 收起，留一行上次结果', await c.until(`!document.querySelector('.sync .prog')`) && /上次 .* 新增 12 张/.test(await c.evaluate(`document.querySelector('.sync .lnk').textContent`)), await c.evaluate(`(document.querySelector('.sync') || {}).textContent`));

    // 直接 Ctrl+V 导入
    const pasteText = '按你的要求整理好了：\n' + JSON.stringify({ title: '粘贴进来的', board: '风格调研-粘贴', groups: [{ name: '甲', keywords: ['one', 'two'] }] });
    const paste = (text) => c.evaluate(`(() => { const dt = new DataTransfer(); dt.setData('text/plain', ${JSON.stringify(text)}); document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); })()`);
    await c.evaluate(`document.activeElement && document.activeElement.blur()`);
    await paste(pasteText);
    check('I 侧边栏里直接 Ctrl+V → 导入并选中', await c.until(`(window.__store().sheets || []).some((x) => x.title === '粘贴进来的') && document.querySelector('select').selectedOptions[0].textContent === '粘贴进来的'`), (await store()).sheets.map((x) => x.title));
    check('I 粘贴导入的也存一份到文件夹', await c.until(`window.__host.saved.some((m) => m.base === '粘贴进来的' && m.sheet.board === '风格调研-粘贴')`), await c.evaluate('window.__host.saved'));
    const nBefore = (await store()).sheets.length;
    await paste('今天天气不错');
    await sleep(200);
    check('I 粘贴的不是调研单 → 提示，不导入', (await store()).sheets.length === nBefore && /剪贴板里的不是调研单/.test(await notes()), await notes());

    // 小程序没装
    await setup({ installed: false });
    await sleep(200);
    check('I 没装小程序：平时不打扰', await c.evaluate(`!document.querySelector('.cmd')`));
    await c.evaluate(`${btn('.pick .btn', '刷新')}.click()`);
    check('I 没装小程序：点刷新 → 给出安装命令（带扩展 ID）', await c.until(`!!document.querySelector('.cmd')`) && /Install-Host\.ps1 -ExtensionId abcdefghijklmnopabcdefghijklmnop/.test(await c.evaluate(`document.querySelector('.cmd').textContent`)), await c.evaluate(`(document.querySelector('.cmd') || {}).textContent`));
    console.log('  截图 ' + await c.shot('13-host-missing', 400, 860));

    // J. AI 聊天页：代码块写完才收，只收合格的调研单，同一份不重复收
    await c.goto(ORIGIN + '/chat');
    await c.evaluate(`window.__sendReply = (m) => (m.type === 'pbl-capture' ? { ok: true, where: 'folder', titles: m.sheets.map((x) => x.title) } : undefined)`);
    const full = JSON.stringify(cyber, null, 2);
    const addBlock = (id, text) => c.evaluate(`(() => { let pre = document.getElementById('${id}'); if (!pre) { pre = document.createElement('pre'); pre.id = '${id}'; pre.appendChild(document.createElement('code')); document.getElementById('chat').appendChild(pre); } pre.firstChild.textContent = ${JSON.stringify(text)}; })()`);
    await addBlock('b0', '{ "groups": 5, "note": "这不是调研单，只是碰巧有 groups 这个词的一段 JSON 而已" }');
    await addBlock('b1', full.slice(0, 120));
    await sleep(900);
    await addBlock('b1', full.slice(0, 260));
    await sleep(900);
    check('J 还在往外写字时不收', (await c.evaluate('window.__sent')).length === 0, await c.evaluate('window.__sent'));
    await addBlock('b1', full);
    check('J 写完后收下', await c.until(`window.__sent.length === 1`, 6000), await c.evaluate('window.__sent'));
    const cap = (await c.evaluate('window.__sent'))[0];
    check('J 交给后台的是规整好的调研单', cap.type === 'pbl-capture' && cap.sheets.length === 1 && cap.sheets[0].board === '风格调研-赛博' && cap.sheets[0].folder === '赛博霓虹参考' && !!cap.key && cap.source === 'localhost', cap);
    check('J 页面上有提示', await c.until(`!!document.getElementById('pbl-capture-host') && /已收下调研单「赛博霓虹」/.test(document.getElementById('pbl-capture-host').shadowRoot.querySelector('.t').textContent)`));
    console.log('  截图 ' + await c.shot('14-chat-capture', 900, 600));
    await sleep(2500);
    check('J 不合格的 JSON、同一个代码块都不会再发', (await c.evaluate('window.__sent')).length === 1, await c.evaluate('window.__sent'));
  } catch (e) {
    failed++;
    console.log('FAIL  测试中断：' + (e && e.stack || e));
  }
  try { if (c) c.close(); } catch (e) { /* ignore */ }
  chrome.kill();
  server.close();
  await sleep(400);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* Chrome 还没放手就算了 */ }
  console.log(failed ? '\n' + failed + ' 项失败' : '\n全部通过');
  process.exit(failed ? 1 : 0);
})();
