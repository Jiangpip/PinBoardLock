// Node 里用假的 window / fetch / XHR 跑 inject.js，检查改写逻辑和读收藏夹的流程。
const fs = require('fs');
const vm = require('vm');
const src = fs.readFileSync(process.argv[2], 'utf8');

let failed = 0;
const check = (name, cond, extra) => {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (cond ? '' : '   ' + (extra || '')));
  if (!cond) failed++;
};

class El {
  constructor(tid, opts = {}) { this.nodeType = 1; this.tid = tid; this.parentElement = null; this.input = opts.input || null; this.rect = opts.rect || { width: 1600, height: 900 }; this.kids = []; }
  add(c) { c.parentElement = this; this.kids.push(c); return c; }
  getAttribute(n) { return n === 'data-test-id' ? this.tid || null : null; }
  querySelector() { if (this.input) return this.input; for (const k of this.kids) { const r = k.querySelector(); if (r) return r; } return null; }
  getBoundingClientRect() { return this.rect; }
}

function makeWorld() {
  const listeners = {};
  const posted = [];
  const fetchCalls = [];
  const xhrSent = [];
  let fetchImpl = async () => new Response('{}', { status: 200 });

  class FakeXHR {
    constructor() { this.responseType = ''; this.status = 0; this.responseText = ''; this._l = {}; }
    open() {}
    setRequestHeader() {}
    send(body) { xhrSent.push(body); this.status = 200; this.responseText = JSON.stringify({ resource_response: { data: { board: { id: '111', name: 'Target' } } } }); (this._l.loadend || []).forEach((f) => f.call(this)); }
    addEventListener(t, f) { (this._l[t] = this._l[t] || []).push(f); }
  }

  const body = new El('body');
  const win = {
    location: { origin: 'https://www.pinterest.com', pathname: '/search/pins/', href: 'https://www.pinterest.com/search/pins/' },
    addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); },
    postMessage: (m) => { posted.push(m); },
    fetch: function (input, init) { fetchCalls.push({ input, init }); return fetchImpl(input, init); },
    XMLHttpRequest: FakeXHR,
    document: { body, getElementById: () => null, cookie: 'a=1; csrftoken=tok%2F123; b=2' },
    URLSearchParams, URL, Request, Response, Headers, FormData, setTimeout, Date, JSON, Promise, Object, Array, String, Map, Set, Error, console,
  };
  win.window = win;
  vm.createContext(win);
  vm.runInContext(src, win);
  const fire = (type, ev) => (listeners[type] || []).forEach((f) => f(ev));
  const innerWindow = vm.runInContext('window', win); // 沙箱里的 window 和外面的 win 不是同一个引用
  const toMain = (m) => fire('message', { source: innerWindow, data: Object.assign({ __pbl: 'to-main' }, m) });
  return { win, body, posted, fetchCalls, xhrSent, fire, toMain, setFetch: (f) => { fetchImpl = f; } };
}

const repinBody = (opts) => new URLSearchParams({ source_url: '/pin/999/', data: JSON.stringify({ options: opts, context: {} }) }).toString();
const optsOf = (bodyText) => JSON.parse(new URLSearchParams(String(bodyText)).get('data')).options;
const repinResponse = () => new Response(JSON.stringify({ resource_response: { data: { board: { id: '111', name: 'Target' } } } }), { status: 200 });
const tick = () => new Promise((r) => setTimeout(r, 20));

(async () => {
  // 1. 快速保存：board_id 被换掉，分区写进去
  {
    const w = makeWorld();
    w.setFetch(async () => repinResponse());
    check('启动时发 ready', w.posted.some((m) => m.type === 'ready'));
    w.toMain({ type: 'state', enabled: true, target: { boardId: '111', sectionId: '77' }, sectionKey: 'section' });
    const saveBtn = w.body.add(new El('pin')).add(new El('PinBetterSaveButton'));
    w.fire('click', { target: saveBtn, altKey: false });
    const res = await w.win.fetch('/resource/RepinResource/create/', { method: 'POST', headers: { 'X-CSRFToken': 'x' }, body: repinBody({ pin_id: '999', board_id: '222', description: 'a b' }) });
    const o = optsOf(w.fetchCalls[0].init.body);
    check('快速保存 → board_id 改成目标', o.board_id === '111', JSON.stringify(o));
    check('快速保存 → 分区写入', o.section === '77');
    check('其他字段不动', o.pin_id === '999' && o.description === 'a b');
    check('source_url 保留', new URLSearchParams(w.fetchCalls[0].init.body).get('source_url') === '/pin/999/');
    check('原始请求头保留', w.fetchCalls[0].init.headers['X-CSRFToken'] === 'x');
    check('返回的仍是原响应', res.status === 200);
    await tick();
    const s = w.posted.find((m) => m.type === 'save');
    check('上报保存结果', s && s.ok && s.info.rewritten && s.actual.id === '111', JSON.stringify(s));
  }

  // 2. 下拉里手动选（test-id 命中）→ 不改写
  {
    const w = makeWorld();
    w.setFetch(async () => repinResponse());
    w.toMain({ type: 'state', enabled: true, target: { boardId: '111' } });
    const row = w.body.add(new El('flyout')).add(new El('board-row-MyBoard')).add(new El(''));
    w.fire('click', { target: row, altKey: false });
    const body = repinBody({ pin_id: '999', board_id: '222' });
    await w.win.fetch('/resource/RepinResource/create/', { method: 'POST', body });
    check('手动选（board-row）→ 请求体原样', w.fetchCalls[0].init.body === body);
    await tick();
    check('手动选 → reason=manual', w.posted.find((m) => m.type === 'save').info.reason === 'manual');
  }

  // 3. 下拉面板靠“带搜索框的小浮层”识别
  {
    const w = makeWorld();
    w.setFetch(async () => repinResponse());
    w.toMain({ type: 'state', enabled: true, target: { boardId: '111' } });
    const flyout = w.body.add(new El('', { input: { type: 'text', id: 'pickerSearchField', name: '', placeholder: 'Search', getAttribute: () => '' }, rect: { width: 360, height: 520 } }));
    const item = flyout.add(new El('')).add(new El(''));
    w.fire('click', { target: item, altKey: false });
    const body = repinBody({ pin_id: '999', board_id: '222' });
    await w.win.fetch('/resource/RepinResource/create/', { method: 'POST', body });
    check('手动选（搜索浮层）→ 请求体原样', w.fetchCalls[0].init.body === body);
  }

  // 4. 评论输入框不算下拉面板；目标没有分区时删掉原来的分区
  {
    const w = makeWorld();
    w.setFetch(async () => repinResponse());
    w.toMain({ type: 'state', enabled: true, target: { boardId: '111' } });
    const col = w.body.add(new El('', { input: { type: 'text', id: 'c', name: '', placeholder: 'Add a comment', getAttribute: () => '' }, rect: { width: 500, height: 800 } }));
    const btn = col.add(new El('SaveButton'));
    w.fire('click', { target: btn, altKey: false });
    await w.win.fetch('/resource/RepinResource/create/', { method: 'POST', body: repinBody({ pin_id: '999', board_id: '222', section: '55' }) });
    const o = optsOf(w.fetchCalls[0].init.body);
    check('评论框旁的保存 → 仍然改写', o.board_id === '111', JSON.stringify(o));
    check('目标无分区 → 原分区被删', !('section' in o));
  }

  // 5. 学到别的分区字段名
  {
    const w = makeWorld();
    w.setFetch(async () => repinResponse());
    w.toMain({ type: 'state', enabled: true, target: { boardId: '111', sectionId: '77' } });
    w.fire('click', { target: w.body.add(new El('x')), altKey: false });
    await w.win.fetch('/resource/RepinResource/create/', { method: 'POST', body: repinBody({ pin_id: '999', board_id: '222', board_section_id: '55' }) });
    const o = optsOf(w.fetchCalls[0].init.body);
    check('沿用页面的分区字段名', o.board_section_id === '77' && !('section' in o), JSON.stringify(o));
    check('上报学到的字段名', w.posted.some((m) => m.type === 'learned' && m.sectionKey === 'board_section_id'));
  }

  // 6. Alt、关闭、没目标、本来就对
  for (const [name, stateMsg, alt, want] of [
    ['按住 Alt → 不改写', { enabled: true, target: { boardId: '111' } }, true, 'alt'],
    ['关闭锁定 → 不改写', { enabled: false, target: { boardId: '111' } }, false, 'disabled'],
    ['没选目标 → 不改写', { enabled: true, target: null }, false, 'no-target'],
    ['本来就是目标 → 不改写', { enabled: true, target: { boardId: '222' } }, false, 'same'],
  ]) {
    const w = makeWorld();
    w.setFetch(async () => repinResponse());
    w.toMain(Object.assign({ type: 'state' }, stateMsg));
    w.fire('click', { target: w.body.add(new El('x')), altKey: alt });
    const body = repinBody({ pin_id: '999', board_id: '222' });
    await w.win.fetch('/resource/RepinResource/create/', { method: 'POST', body });
    await tick();
    const s = w.posted.find((m) => m.type === 'save');
    check(name, w.fetchCalls[0].init.body === body && s.info.reason === want, s && s.info.reason);
  }

  // 7. Request 对象形式
  {
    const w = makeWorld();
    w.setFetch(async () => repinResponse());
    w.toMain({ type: 'state', enabled: true, target: { boardId: '111' } });
    w.fire('click', { target: w.body.add(new El('x')), altKey: false });
    const req = new Request('https://www.pinterest.com/resource/RepinResource/create/', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-CSRFToken': 'x' }, body: repinBody({ pin_id: '999', board_id: '222' }) });
    await w.win.fetch(req);
    const sent = w.fetchCalls[0].input;
    const o = optsOf(await sent.text());
    check('Request 对象 → 改写', o.board_id === '111');
    check('Request 对象 → 方法和头保留', sent.method === 'POST' && sent.headers.get('x-csrftoken') === 'x');
  }

  // 8. XHR 形式
  {
    const w = makeWorld();
    w.toMain({ type: 'state', enabled: true, target: { boardId: '111' } });
    w.fire('click', { target: w.body.add(new El('x')), altKey: false });
    const x = new w.win.XMLHttpRequest();
    x.open('POST', '/resource/RepinResource/create/');
    x.setRequestHeader('X-CSRFToken', 'x');
    x.send(repinBody({ pin_id: '999', board_id: '222' }));
    check('XHR → 改写', optsOf(w.xhrSent[0]).board_id === '111');
    check('XHR → 上报结果', w.posted.some((m) => m.type === 'save' && m.ok && m.info.rewritten));
    const y = new w.win.XMLHttpRequest();
    y.open('POST', '/resource/UserSettingsResource/update/');
    y.send('a=1');
    check('XHR 其他请求不动', w.xhrSent[1] === 'a=1');
  }

  // 9. 无关请求原样放行
  {
    const w = makeWorld();
    w.toMain({ type: 'state', enabled: true, target: { boardId: '111' } });
    const init = { method: 'POST', body: 'x=1' };
    await w.win.fetch('https://i.pinimg.com/x.jpg', init);
    await w.win.fetch('/resource/PinResource/create/', init);
    check('无关请求原样放行', w.fetchCalls[0].init === init && w.fetchCalls[1].init === init);
  }

  // 10. 保存失败上报
  {
    const w = makeWorld();
    w.setFetch(async () => new Response(JSON.stringify({ resource_response: { error: { message: 'nope' } } }), { status: 403 }));
    w.toMain({ type: 'state', enabled: true, target: { boardId: '111' } });
    await w.win.fetch('/resource/RepinResource/create/', { method: 'POST', body: repinBody({ pin_id: '999', board_id: '222' }) });
    await tick();
    const s = w.posted.find((m) => m.type === 'save');
    check('保存失败 → ok=false 带原因', s && !s.ok && s.status === 403 && s.err === 'nope', JSON.stringify(s));
  }

  // 11. 读收藏夹：分页 + 分区 + 学到的请求头
  {
    const w = makeWorld();
    const seen = [];
    w.setFetch(async (input, init) => {
      const u = new URL(String(input), 'https://www.pinterest.com');
      const data = JSON.parse(u.searchParams.get('data') || '{}');
      seen.push({ path: u.pathname, options: data.options, headers: init && init.headers });
      const json = (o) => new Response(JSON.stringify(o), { status: 200 });
      if (u.pathname.includes('SomePageResource')) return json({});
      if (u.pathname.includes('BoardPickerBoardsResource')) return json({ client_context: { user: { username: 'me' } }, resource_response: { data: { all_boards: [{ id: 3, name: 'OnlyInPicker', url: '/me/p/' }] } } });
      if (u.pathname.includes('BoardsResource')) {
        if (!data.options.bookmarks) return json({ resource_response: { data: [{ type: 'board', id: '1', name: 'A', url: '/me/a/', privacy: 'public', pin_count: 10, section_count: 2, image_cover_url: 'c1' }, { type: 'story', id: 's' }] }, resource: { options: { bookmarks: ['bm1'] } } });
        return json({ resource_response: { data: [{ type: 'board', id: '2', name: 'B', url: '/me/b/', privacy: 'secret', pin_count: 5, section_count: 0 }] }, resource: { options: { bookmarks: ['-end-'] } } });
      }
      if (u.pathname.includes('BoardSectionsResource')) return json({ resource_response: { data: [{ id: '10', title: 'S1', pin_count: 3 }, { id: '11', title: 'S2' }] }, resource: { options: { bookmarks: ['-end-'] } } });
      return new Response('nope', { status: 404 });
    });
    // 页面自己先发过一个请求，带着它的头
    await w.win.fetch('/resource/SomePageResource/get/?x=1', { headers: { 'X-Pinterest-PWS-Handler': 'www/search/[scope].js', 'X-APP-VERSION': 'abc123' } });
    w.toMain({ type: 'refresh', reqId: 5 });
    for (let i = 0; i < 40 && !w.posted.some((m) => m.type === 'boards'); i++) await tick();
    const b = w.posted.find((m) => m.type === 'boards');
    check('读收藏夹 → ok', b && b.ok && b.reqId === 5, JSON.stringify(b && b.errors));
    check('用户名来自 client_context', b && b.username === 'me');
    check('分页合并 + 去掉非收藏夹项 + 补上 picker 里的', b && b.boards.map((x) => x.name).join(',') === 'A,B,OnlyInPicker', b && JSON.stringify(b.boards.map((x) => x.name)));
    check('字段规整', b && b.boards[0].id === '1' && b.boards[0].cover === 'c1' && b.boards[1].privacy === 'secret' && b.boards[2].id === '3');
    check('只给有分区的收藏夹取分区', b && b.boards[0].sections.length === 2 && b.boards[0].sections[0].title === 'S1' && seen.filter((s) => s.path.includes('BoardSections')).length === 1);
    const own = seen.find((s) => s.path.includes('BoardPicker'));
    check('自己的请求带上学到的头', own.headers['X-Pinterest-PWS-Handler'] === 'www/search/[scope].js' && own.headers['X-APP-VERSION'] === 'abc123');
  }

  // 12. 没登录：读不到 → ok=false 带原因
  {
    const w = makeWorld();
    w.setFetch(async () => new Response('Invalid Resource Request', { status: 403 }));
    w.toMain({ type: 'refresh', reqId: 6 });
    for (let i = 0; i < 300 && !w.posted.some((m) => m.type === 'boards'); i++) await tick();
    const b = w.posted.find((m) => m.type === 'boards');
    check('读不到 → ok=false 且有错误信息', b && !b.ok && b.errors.length > 0, JSON.stringify(b));
  }

  // 假的 Pinterest：能列收藏夹、能新建收藏夹和分区
  const fakePinterest = (opts = {}) => {
    const calls = [];
    const boards = [{ type: 'board', id: '1', name: 'Ink Study', url: '/me/ink-study/', privacy: 'public', pin_count: 4, section_count: 1 }];
    const sections = { 1: [{ id: '10', title: 'Mist' }] };
    let nextId = 500;
    const json = (o, status) => new Response(JSON.stringify(o), { status: status || 200 });
    const impl = async (input, init) => {
      const u = new URL(String(input), 'https://www.pinterest.com');
      const method = String((init && init.method) || 'GET').toUpperCase();
      if (method === 'POST') {
        const p = new URLSearchParams(String(init.body));
        const o = JSON.parse(p.get('data')).options;
        calls.push({ path: u.pathname, options: o, headers: init.headers, source: p.get('source_url') });
        if (opts.failCreate) return json({ resource_response: { error: { message: 'Board name taken' } } }, 400);
        if (u.pathname.includes('BoardResource/create')) {
          const b = { type: 'board', id: String(nextId++), name: o.name, url: '/me/' + encodeURIComponent(o.name) + '/', privacy: o.privacy, pin_count: 0, section_count: 0 };
          boards.push(b);
          return json({ resource_response: { data: b } });
        }
        if (u.pathname.includes('BoardSectionResource/create')) {
          const sec = { id: String(nextId++), title: o.name };
          (sections[o.board_id] = sections[o.board_id] || []).push(sec);
          return json({ resource_response: { data: sec } });
        }
        return json({}, 404);
      }
      const data = JSON.parse(u.searchParams.get('data') || '{}');
      if (opts.failList) return new Response('Invalid Resource Request', { status: 403 });
      if (u.pathname.includes('BoardPickerBoardsResource')) return json({ client_context: { user: { username: 'me' } }, resource_response: { data: { all_boards: [] } } });
      if (u.pathname.includes('BoardsResource')) return json({ resource_response: { data: boards }, resource: { options: { bookmarks: ['-end-'] } } });
      if (u.pathname.includes('BoardSectionsResource')) return json({ resource_response: { data: sections[data.options.board_id] || [] }, resource: { options: { bookmarks: ['-end-'] } } });
      return json({}, 404);
    };
    return { impl, calls, boards, sections };
  };
  const waitEnsured = async (w) => {
    for (let i = 0; i < 400 && !w.posted.some((m) => m.type === 'ensured'); i++) await tick();
    return w.posted.find((m) => m.type === 'ensured');
  };

  // 13. 新建：收藏夹和分区都没有
  {
    const w = makeWorld();
    const pin = fakePinterest();
    w.setFetch(pin.impl);
    w.toMain({ type: 'ensure', reqId: 21, board: '风格调研-水墨感', privacy: 'public', sections: ['河面雾气', '剪影', '河面雾气'] });
    const e = await waitEnsured(w);
    check('新建 → ok', e && e.ok && e.reqId === 21, JSON.stringify(e && e.errors));
    check('新建 → 发了 1 次建收藏夹、2 次建分区', pin.calls.map((c) => c.path.replace('/resource/', '')).join(',') === 'BoardResource/create/,BoardSectionResource/create/,BoardSectionResource/create/', JSON.stringify(pin.calls.map((c) => c.path)));
    check('建收藏夹的参数', pin.calls[0].options.name === '风格调研-水墨感' && pin.calls[0].options.privacy === 'public', JSON.stringify(pin.calls[0].options));
    check('建分区用新收藏夹的 id', pin.calls[1].options.board_id === '500' && pin.calls[1].options.name === '河面雾气' && Array.isArray(pin.calls[1].options.initial_pins), JSON.stringify(pin.calls[1].options));
    check('写请求带 csrftoken（解码后）', pin.calls[0].headers['X-CSRFToken'] === 'tok/123' && pin.calls[0].headers['Content-Type'] === 'application/x-www-form-urlencoded', JSON.stringify(pin.calls[0].headers));
    const nb = e.boards.find((b) => b.name === '风格调研-水墨感');
    check('返回的列表里有新收藏夹和它的分区', nb && nb.id === '500' && nb.sections.map((x) => x.title).join('|') === '河面雾气|剪影', JSON.stringify(nb));
    check('created 列出建了什么', e.created.join('、') === '风格调研-水墨感、风格调研-水墨感 / 河面雾气、风格调研-水墨感 / 剪影', JSON.stringify(e.created));
  }

  // 14. 新建：收藏夹已经有（名字不分大小写），只补缺的分区；私密参数
  {
    const w = makeWorld();
    const pin = fakePinterest();
    w.setFetch(pin.impl);
    w.toMain({ type: 'ensure', reqId: 22, board: 'ink  study', privacy: 'secret', sections: ['mist', 'Silhouette'] });
    const e = await waitEnsured(w);
    check('已有收藏夹 → 不重复建，只建缺的分区', e && e.ok && pin.calls.length === 1 && pin.calls[0].path.includes('BoardSectionResource') && pin.calls[0].options.board_id === '1' && pin.calls[0].options.name === 'Silhouette', JSON.stringify(pin.calls));
    check('建分区的 source_url 是收藏夹地址', pin.calls[0].source === '/me/ink-study/', pin.calls[0].source);
    const w2 = makeWorld();
    const pin2 = fakePinterest();
    w2.setFetch(pin2.impl);
    w2.toMain({ type: 'ensure', reqId: 23, board: 'Secret One', privacy: 'secret', sections: [] });
    await waitEnsured(w2);
    check('私密 → privacy=secret', pin2.calls.length === 1 && pin2.calls[0].options.privacy === 'secret', JSON.stringify(pin2.calls));
    const w3 = makeWorld();
    const pin3 = fakePinterest();
    w3.setFetch(pin3.impl);
    w3.toMain({ type: 'ensure', reqId: 24, board: 'Ink Study', sections: ['Mist'] });
    const e3 = await waitEnsured(w3);
    check('什么都不缺 → 不发写请求', e3 && e3.ok && pin3.calls.length === 0 && e3.created.length === 0);
  }

  // 15. 新建失败 / 列表读不到
  {
    const w = makeWorld();
    const pin = fakePinterest({ failCreate: true });
    w.setFetch(pin.impl);
    w.toMain({ type: 'ensure', reqId: 25, board: 'New', sections: ['A'] });
    const e = await waitEnsured(w);
    check('Pinterest 拒绝 → ok=false 带它给的原因，且不继续建分区', e && !e.ok && pin.calls.length === 1 && /Board name taken/.test(e.errors.join(' ')), JSON.stringify(e && e.errors));
    const w2 = makeWorld();
    const pin2 = fakePinterest({ failList: true });
    w2.setFetch(pin2.impl);
    w2.toMain({ type: 'ensure', reqId: 26, board: 'New', sections: [] });
    const e2 = await waitEnsured(w2);
    check('读不到现有收藏夹 → 不新建（免得重名）', e2 && !e2.ok && pin2.calls.length === 0, JSON.stringify(e2 && e2.errors));
  }

  console.log(failed ? '\n' + failed + ' 项失败' : '\n全部通过');
  process.exit(failed ? 1 : 0);
})();
