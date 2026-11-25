// PinBoardLock — 页面主世界（MAIN world）脚本
// 做两件事：
//   1. 拦截 Pinterest 自己发出的“保存”请求（RepinResource/create），把目标收藏夹换成用户选的那个。
//   2. 借页面已登录的会话读出账号里的收藏夹和分区列表。
//   3. 用户在调研单里点了“新建”时，按名字新建缺的收藏夹和分区。
// 和扩展侧（content.js）只通过 window.postMessage 通信。
(() => {
  'use strict';
  if (window.__pblInjected) return;
  window.__pblInjected = true;

  const TAG = '__pbl';
  const SECTION_KEYS = ['section', 'board_section_id', 'section_id'];
  const REPIN = /\/resource\/RepinResource\/create\/?(\?|$)/i;
  const KEEP_HEADERS = ['x-app-version', 'x-pinterest-pws-handler'];
  // 点在这些元素里 = 用户在下拉菜单里手动挑收藏夹，不改写
  const MANUAL_ID = /board-?row|section-?row|boardWithoutSection|board-?picker/i;
  const SEARCH_HINT = /search|picker|filter|搜索|搜尋|検索/i;
  const MANUAL_WINDOW_MS = 8000;

  const state = { enabled: true, target: null, sectionKey: 'section' };
  const learned = {};
  let lastClick = { t: 0, manual: false, alt: false, why: '' };
  let seenCount = 0;

  const origFetch = window.fetch;
  const XHR = XMLHttpRequest.prototype;
  const origOpen = XHR.open;
  const origSend = XHR.send;
  const origSetHeader = XHR.setRequestHeader;

  const post = (msg) => {
    try { window.postMessage(Object.assign({ [TAG]: 'to-content' }, msg), location.origin); } catch (e) { /* ignore */ }
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ───────── 点击判定：是“快速保存”还是“在下拉里手动选” ─────────
  function classifyClick(el) {
    const ids = [];
    let node = el;
    let depth = 0;
    let inputChecked = false;
    while (node && node.nodeType === 1 && node !== document.body && depth < 25) {
      const tid = node.getAttribute('data-test-id') || '';
      if (tid) {
        ids.push(tid);
        if (MANUAL_ID.test(tid)) return { manual: true, why: 'test-id:' + tid };
      }
      // 收藏夹下拉面板：一个不大的浮层，里面带搜索框
      if (!inputChecked && depth > 0) {
        const input = node.querySelector('input');
        if (input) {
          inputChecked = true;
          const hint = [input.type, input.id, input.name, input.placeholder, input.getAttribute('aria-label')].join(' ');
          const r = node.getBoundingClientRect();
          if (SEARCH_HINT.test(hint) && r.width <= 560 && r.height <= 820) {
            return { manual: true, why: 'flyout-with-search' };
          }
        }
      }
      node = node.parentElement;
      depth++;
    }
    return { manual: false, why: ids.slice(0, 3).join('>') };
  }

  function onPress(ev) {
    try {
      const el = ev.target;
      if (!el || el.nodeType !== 1) return;
      const c = classifyClick(el);
      lastClick = { t: Date.now(), manual: c.manual, alt: !!ev.altKey, why: c.why };
    } catch (e) { /* ignore */ }
  }
  window.addEventListener('pointerdown', onPress, true);
  window.addEventListener('click', onPress, true);

  // ───────── 改写保存请求 ─────────
  function decide(o) {
    const info = {
      pinId: o.pin_id != null ? String(o.pin_id) : '',
      origBoard: o.board_id != null ? String(o.board_id) : '',
      origSection: null,
      rewritten: false,
      reason: '',
      click: lastClick.why,
      keys: Object.keys(o),
    };
    for (const k of SECTION_KEYS) {
      if (k in o && o[k]) {
        info.origSection = String(o[k]);
        if (state.sectionKey !== k) {
          state.sectionKey = k;
          post({ type: 'learned', sectionKey: k });
        }
      }
    }
    const recent = Date.now() - lastClick.t < MANUAL_WINDOW_MS;
    const t = state.target;
    if (!state.enabled) info.reason = 'disabled';
    else if (!t || !t.boardId) info.reason = 'no-target';
    else if (recent && lastClick.alt) info.reason = 'alt';
    else if (recent && lastClick.manual) info.reason = 'manual';
    else if (info.origBoard === String(t.boardId) && (info.origSection || '') === (t.sectionId || '')) info.reason = 'same';
    else {
      o.board_id = String(t.boardId);
      for (const k of SECTION_KEYS) delete o[k];
      if (t.sectionId) o[state.sectionKey] = String(t.sectionId);
      info.rewritten = true;
      info.reason = 'locked';
    }
    return info;
  }

  function rewriteText(text) {
    if (typeof text !== 'string' || !text) return null;
    const t = text.trimStart();
    if (t[0] === '{') {
      const j = JSON.parse(t);
      if (!j || !j.options) return null;
      const info = decide(j.options);
      return { info, changed: info.rewritten, body: info.rewritten ? JSON.stringify(j) : text };
    }
    const p = new URLSearchParams(text);
    const raw = p.get('data');
    if (!raw) return null;
    const d = JSON.parse(raw);
    if (!d || !d.options) return null;
    const info = decide(d.options);
    if (!info.rewritten) return { info, changed: false, body: text };
    p.set('data', JSON.stringify(d));
    return { info, changed: true, body: p.toString() };
  }

  function rewriteAny(body) {
    if (typeof body === 'string') return rewriteText(body);
    if (body instanceof URLSearchParams) {
      const r = rewriteText(body.toString());
      if (r && r.changed) r.body = new URLSearchParams(r.body);
      else if (r) r.body = body;
      return r;
    }
    if (typeof FormData !== 'undefined' && body instanceof FormData) {
      const raw = body.get('data');
      if (typeof raw !== 'string') return null;
      const d = JSON.parse(raw);
      if (!d || !d.options) return null;
      const info = decide(d.options);
      if (!info.rewritten) return { info, changed: false, body };
      const fd = new FormData();
      for (const [k, v] of body.entries()) fd.append(k, k === 'data' ? JSON.stringify(d) : v);
      return { info, changed: true, body: fd };
    }
    return null;
  }

  function report(info, status, text) {
    let ok = status >= 200 && status < 300;
    let actual = null;
    let err = '';
    try {
      const j = JSON.parse(text);
      const rr = j && j.resource_response;
      const d = rr && rr.data;
      if (d && d.board && d.board.id) {
        actual = { id: String(d.board.id), name: d.board.name || '' };
        if (d.section && d.section.title) actual.section = d.section.title;
      }
      if (rr && rr.error) {
        ok = false;
        err = String(rr.error.message || rr.error.code || 'error').slice(0, 120);
      }
    } catch (e) { /* 响应不是 JSON */ }
    post({ type: 'save', info, ok, status, actual, err });
  }

  // ───────── 记住页面自己请求里带的头，读列表时照着发 ─────────
  function learnHeader(k, v) {
    const key = String(k).toLowerCase();
    if (KEEP_HEADERS.indexOf(key) !== -1 && v) learned[key] = String(v);
  }
  function learnHeaders(h) {
    if (!h) return;
    if (typeof Headers !== 'undefined' && h instanceof Headers) h.forEach((v, k) => learnHeader(k, v));
    else if (Array.isArray(h)) h.forEach((p) => p && learnHeader(p[0], p[1]));
    else if (typeof h === 'object') Object.keys(h).forEach((k) => learnHeader(k, h[k]));
  }

  // 诊断用：保存如果走的不是 RepinResource，这里能看到它实际走了哪条
  function noteOtherPost(url, body) {
    if (seenCount >= 20 || typeof body !== 'string' || !/board_?id/i.test(body)) return;
    seenCount++;
    let path = url;
    try { path = new URL(url, location.href).pathname; } catch (e) { /* ignore */ }
    post({ type: 'seen', path });
  }

  // ───────── fetch ─────────
  window.fetch = function (input, init) {
    let url = '';
    let method = 'GET';
    try {
      url = typeof input === 'string' ? input : (input && input.url) || String(input);
      method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
    } catch (e) {
      return origFetch.apply(this, arguments);
    }
    const isResource = url.indexOf('/resource/') !== -1;
    if (!isResource && url.indexOf('graphql') === -1) return origFetch.apply(this, arguments);
    try {
      if (isResource) {
        if (init && init.headers) learnHeaders(init.headers);
        if (typeof Request !== 'undefined' && input instanceof Request) learnHeaders(input.headers);
      }
    } catch (e) { /* ignore */ }
    if (method !== 'POST') return origFetch.apply(this, arguments);
    if (!REPIN.test(url)) {
      try { noteOtherPost(url, init && init.body); } catch (e) { /* ignore */ }
      return origFetch.apply(this, arguments);
    }
    return repinFetch(this, input, init);
  };

  async function repinFetch(self, input, init) {
    let info = null;
    try {
      if (init && init.body != null) {
        const r = rewriteAny(init.body);
        if (r) {
          info = r.info;
          if (r.changed) init = Object.assign({}, init, { body: r.body });
        }
      } else if (typeof Request !== 'undefined' && input instanceof Request) {
        const text = await input.clone().text();
        const r = rewriteText(text);
        if (r) {
          info = r.info;
          if (r.changed) input = new Request(input, { body: r.body });
        }
      }
    } catch (e) {
      post({ type: 'note', msg: 'rewrite failed: ' + (e && e.message) });
    }
    const res = await origFetch.call(self, input, init);
    try {
      res.clone().text().then((t) => report(info, res.status, t), () => report(info, res.status, ''));
    } catch (e) {
      report(info, res.status, '');
    }
    return res;
  }

  // ───────── XMLHttpRequest ─────────
  XHR.open = function (method, url) {
    try { this.__pbl = { method: String(method || 'GET').toUpperCase(), url: String(url) }; } catch (e) { /* ignore */ }
    return origOpen.apply(this, arguments);
  };
  XHR.setRequestHeader = function (k, v) {
    try { if (this.__pbl && this.__pbl.url.indexOf('/resource/') !== -1) learnHeader(k, v); } catch (e) { /* ignore */ }
    return origSetHeader.apply(this, arguments);
  };
  XHR.send = function (body) {
    const m = this.__pbl;
    if (!m || m.method !== 'POST') return origSend.apply(this, arguments);
    if (!REPIN.test(m.url)) {
      try { if (m.url.indexOf('/resource/') !== -1 || m.url.indexOf('graphql') !== -1) noteOtherPost(m.url, body); } catch (e) { /* ignore */ }
      return origSend.apply(this, arguments);
    }
    let info = null;
    try {
      const r = rewriteAny(body);
      if (r) {
        info = r.info;
        if (r.changed) body = r.body;
      }
    } catch (e) {
      post({ type: 'note', msg: 'rewrite failed: ' + (e && e.message) });
    }
    this.addEventListener('loadend', () => {
      let text = '';
      try {
        text = this.responseType === '' || this.responseType === 'text' ? this.responseText : JSON.stringify(this.response);
      } catch (e) { /* ignore */ }
      report(info, this.status, text || '');
    });
    return origSend.call(this, body);
  };

  // ───────── 读收藏夹列表 ─────────
  async function api(resource, options, sourceUrl) {
    const src = sourceUrl || location.pathname;
    const qs = new URLSearchParams({
      source_url: src,
      data: JSON.stringify({ options, context: {} }),
      _: String(Date.now()),
    });
    const res = await origFetch.call(window, '/resource/' + resource + '/get/?' + qs.toString(), {
      credentials: 'same-origin',
      headers: baseHeaders(src),
    });
    return readJson(resource, res);
  }

  function baseHeaders(src) {
    const headers = {
      Accept: 'application/json, text/javascript, */*, q=0.01',
      'X-Requested-With': 'XMLHttpRequest',
      'X-Pinterest-AppState': 'active',
      'X-Pinterest-Source-Url': src,
      'X-Pinterest-PWS-Handler': learned['x-pinterest-pws-handler'] || 'www/[username].js',
    };
    if (learned['x-app-version']) headers['X-APP-VERSION'] = learned['x-app-version'];
    return headers;
  }

  async function readJson(resource, res) {
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* ignore */ }
    const rr = json && json.resource_response;
    if (!res.ok || !json) {
      const why = (rr && rr.error && (rr.error.message || rr.error.code)) || text.slice(0, 140);
      throw new Error(resource + ' HTTP ' + res.status + ': ' + why);
    }
    return json;
  }

  // 新建收藏夹 / 分区用。和页面自己的写请求一样：表单体 + csrftoken。
  async function apiCreate(resource, options, sourceUrl) {
    const src = sourceUrl || location.pathname;
    const m = /(?:^|;\s*)csrftoken=([^;]+)/.exec(document.cookie || '');
    if (!m) throw new Error('没读到 csrftoken（可能没登录）');
    const headers = baseHeaders(src);
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    headers['X-CSRFToken'] = decodeURIComponent(m[1]);
    const body = new URLSearchParams({ source_url: src, data: JSON.stringify({ options, context: {} }) }).toString();
    const res = await origFetch.call(window, '/resource/' + resource + '/create/', {
      method: 'POST', credentials: 'same-origin', headers, body,
    });
    const json = await readJson(resource, res);
    const rr = json.resource_response;
    if (rr && rr.error) throw new Error(resource + ': ' + String(rr.error.message || rr.error.code || 'error').slice(0, 140));
    return rr && rr.data;
  }

  async function paginate(resource, options, sourceUrl) {
    const out = [];
    const opts = Object.assign({}, options);
    for (let i = 0; i < 40; i++) {
      const j = await api(resource, opts, sourceUrl);
      let data = j && j.resource_response && j.resource_response.data;
      if (data && !Array.isArray(data) && Array.isArray(data.results)) data = data.results;
      if (Array.isArray(data)) out.push.apply(out, data);
      const bm = j && j.resource && j.resource.options && j.resource.options.bookmarks;
      if (!bm || !bm.length || !bm[0] || bm[0] === '-end-' || String(bm[0]).indexOf('Y2JOb25lO') === 0) break;
      opts.bookmarks = bm;
    }
    return out;
  }

  function usernameFromPage() {
    const paths = [
      ['props', 'context', 'user', 'username'],
      ['context', 'user', 'username'],
      ['initialReduxState', 'viewer', 'username'],
      ['props', 'initialReduxState', 'viewer', 'username'],
    ];
    for (const id of ['__PWS_INITIAL_PROPS__', '__PWS_DATA__']) {
      try {
        const el = document.getElementById(id);
        if (!el) continue;
        const j = JSON.parse(el.textContent);
        for (const p of paths) {
          let v = j;
          for (const k of p) v = v && v[k];
          if (typeof v === 'string' && v) return v;
        }
      } catch (e) { /* ignore */ }
    }
    return null;
  }

  function coverOf(b) {
    if (b.image_cover_hd_url) return b.image_cover_hd_url;
    if (b.image_cover_url) return b.image_cover_url;
    if (b.image_thumbnail_url) return b.image_thumbnail_url;
    for (const key of ['cover_images', 'images']) {
      const m = b[key];
      if (m && typeof m === 'object') {
        for (const size of Object.keys(m)) {
          const v = Array.isArray(m[size]) ? m[size][0] : m[size];
          if (v && v.url) return v.url;
        }
      }
    }
    return '';
  }

  function normBoard(b) {
    return {
      id: String(b.id),
      name: String(b.name || ''),
      url: b.url || '',
      privacy: b.privacy || '',
      pinCount: typeof b.pin_count === 'number' ? b.pin_count : null,
      sectionCount: typeof b.section_count === 'number' ? b.section_count : null,
      cover: coverOf(b),
      owner: (b.owner && b.owner.username) || '',
      sections: [],
    };
  }

  async function loadBoards() {
    const errors = [];
    let username = null;
    let pickerBoards = [];
    {
      const t0 = Date.now();
      while (!learned['x-pinterest-pws-handler'] && Date.now() - t0 < 2500) await sleep(150);

      try {
        const j = await api('BoardPickerBoardsResource', {
          field_set_key: 'board_picker',
          allow_stale: true,
          filter: 'all',
          shortlist_length: 3,
        });
        const u = j && j.client_context && j.client_context.user;
        if (u && u.username) username = u.username;
        const d = j && j.resource_response && j.resource_response.data;
        if (d && Array.isArray(d.all_boards)) pickerBoards = d.all_boards;
        else if (Array.isArray(d)) pickerBoards = d;
      } catch (e) {
        errors.push(String((e && e.message) || e));
      }
      if (!username) username = usernameFromPage();

      let listed = [];
      if (username) {
        try {
          listed = await paginate('BoardsResource', {
            username,
            privacy_filter: 'all',
            sort: 'last_pinned_to',
            field_set_key: 'profile_grid_item',
            filter_stories: false,
            page_size: 50,
            include_archived: true,
          }, '/' + username + '/_saved/');
        } catch (e) {
          errors.push(String((e && e.message) || e));
        }
      } else {
        errors.push('没读到登录用户名（可能没登录）');
      }

      const map = new Map();
      for (const b of listed.concat(pickerBoards)) {
        if (!b || !b.id || !b.name) continue;
        if (b.type && b.type !== 'board') continue;
        const id = String(b.id);
        if (!map.has(id)) map.set(id, normBoard(b));
      }
      const boards = Array.from(map.values());

      let sectionErrors = 0;
      for (const b of boards) {
        if (!b.sectionCount) continue;
        try {
          const secs = await paginate('BoardSectionsResource', { board_id: b.id }, b.url || undefined);
          b.sections = secs
            .filter((s) => s && s.id && s.title)
            .map((s) => ({ id: String(s.id), title: String(s.title), pinCount: typeof s.pin_count === 'number' ? s.pin_count : null }));
        } catch (e) {
          sectionErrors++;
        }
      }
      if (sectionErrors) errors.push(sectionErrors + ' 个收藏夹的分区没读到');

      return { username, boards, errors };
    }
  }

  async function refreshBoards(reqId) {
    try {
      const r = await loadBoards();
      post({ type: 'boards', reqId, ok: r.boards.length > 0, username: r.username, boards: r.boards, errors: r.errors });
    } catch (e) {
      post({ type: 'boards', reqId, ok: false, username: null, boards: [], errors: [String((e && e.message) || e)] });
    }
  }

  // ───────── 按名字补齐收藏夹和分区（调研单用；只在用户点了“新建”之后才会被调用） ─────────
  const normName = (x) => String(x || '').trim().replace(/\s+/g, ' ').toLowerCase();
  const sameName = (a, b) => normName(a) === normName(b);
  let ensuring = false;

  async function ensure(m) {
    const created = [];
    let username = null;
    let boards = [];
    let errors = [];
    if (ensuring) {
      post({ type: 'ensured', reqId: m.reqId, ok: false, busy: true, username, boards, created, errors: ['上一次新建还没结束'] });
      return;
    }
    ensuring = true;
    let failed = false;
    try {
      const r = await loadBoards();
      username = r.username;
      boards = r.boards;
      errors = r.errors;
      const name = String(m.board || '').trim();
      if (!name) throw new Error('没有收藏夹名');
      if (!boards.length && errors.length) throw new Error('读不到现有的收藏夹，先不新建，免得重名');
      let b = boards.find((x) => sameName(x.name, name));
      if (!b) {
        if (!username) throw new Error('没读到登录用户名');
        const d = await apiCreate('BoardResource', {
          name, description: '', privacy: m.privacy === 'secret' ? 'secret' : 'public',
          collab_board_email: true, collaborator_invites_enabled: true,
        }, '/' + username + '/_saved/');
        if (!d || !d.id) throw new Error('新建收藏夹的响应里没有 id');
        b = normBoard(Object.assign({ name }, d));
        boards.unshift(b);
        created.push(b.name);
      }
      for (const raw of m.sections || []) {
        const title = String(raw || '').trim();
        if (!title || b.sections.some((s) => sameName(s.title, title))) continue;
        await sleep(350);
        const d = await apiCreate('BoardSectionResource', { board_id: b.id, initial_pins: [], name: title }, b.url || undefined);
        if (!d || !d.id) throw new Error('新建分区「' + title + '」的响应里没有 id');
        b.sections.push({ id: String(d.id), title: String(d.title || title), pinCount: 0 });
        b.sectionCount = b.sections.length;
        created.push(b.name + ' / ' + title);
      }
    } catch (e) {
      failed = true;
      errors = errors.concat(String((e && e.message) || e));
    }
    ensuring = false;
    post({ type: 'ensured', reqId: m.reqId, ok: !failed, username, boards, created, errors });
  }

  // ───────── 和 content.js 通信 ─────────
  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data || ev.data[TAG] !== 'to-main') return;
    const m = ev.data;
    if (m.type === 'state') {
      state.enabled = m.enabled !== false;
      state.target = m.target || null;
      if (m.sectionKey && SECTION_KEYS.indexOf(m.sectionKey) !== -1) state.sectionKey = m.sectionKey;
    } else if (m.type === 'refresh') {
      refreshBoards(m.reqId);
    } else if (m.type === 'ensure') {
      ensure(m);
    }
  });
  post({ type: 'ready' });
})();
