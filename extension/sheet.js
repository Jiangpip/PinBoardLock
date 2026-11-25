// PinBoardLock — 调研单（research sheet）的数据逻辑。内容脚本、侧边栏和 Node 里的测试/工具共用这一份。
// 调研单 = 一个收藏夹（Board）+ 若干分组；每个分组对应一个分区（Section）和一串搜索关键词。
// 这里只有纯函数，不碰 chrome.* 和 DOM。
const PBLSheet = (() => {
  'use strict';

  const LINK_RE = /https?:\/\/[^\s)\]"'<>]+#plks?=[^\s)\]"'<>]+/gi;

  const norm = (s) => String(s == null ? '' : s).trim().replace(/\s+/g, ' ').toLowerCase();
  const clean = (s) => String(s == null ? '' : s).trim().replace(/\s+/g, ' ');

  function hashId(text) {
    let h = 5381;
    for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
    return 's' + h.toString(36);
  }

  function decodePart(s) {
    let out = String(s || '').replace(/\+/g, ' ');
    try { out = decodeURIComponent(out); } catch (e) { /* 原样用 */ }
    return clean(out);
  }

  // ───────── base64url（UTF-8） ─────────
  function b64uEncode(text) {
    const bytes = new TextEncoder().encode(text);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function b64uDecode(text) {
    const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64 + '==='.slice((b64.length + 3) % 4));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  // ───────── 规整一份调研单 ─────────
  // 输入宽松：keywords 可以是字符串或 {q, note}；section 缺省等于分组名，写 false / "" 表示直接进收藏夹。
  function normalizeSheet(raw) {
    if (!raw || typeof raw !== 'object') throw new Error('不是一个对象');
    const board = clean(raw.board || raw.title);
    const title = clean(raw.title || raw.board);
    if (!board) throw new Error('缺少 board（收藏夹名）');
    const rawGroups = Array.isArray(raw.groups) ? raw.groups
      : Array.isArray(raw.keywords) ? [{ name: '', section: false, keywords: raw.keywords }] : [];
    const groups = [];
    for (const g of rawGroups) {
      if (!g || typeof g !== 'object') continue;
      const name = clean(g.name || (typeof g.section === 'string' ? g.section : ''));
      const section = g.section === false || g.section === null || g.section === '' ? '' : clean(g.section || name);
      const seen = new Set();
      const keywords = [];
      for (const k of Array.isArray(g.keywords) ? g.keywords : []) {
        const q = clean(typeof k === 'string' ? k : k && k.q);
        if (!q || seen.has(norm(q))) continue;
        seen.add(norm(q));
        keywords.push({ q, note: clean(typeof k === 'object' && k ? k.note : '') });
      }
      if (!keywords.length) continue;
      groups.push({ name: name || section || '未分组', section, note: clean(g.note), keywords });
    }
    if (!groups.length) throw new Error('没有任何关键词');
    const out = {
      id: clean(raw.id) || hashId(norm(title) + '|' + norm(board)),
      title,
      board,
      privacy: raw.privacy === 'secret' ? 'secret' : 'public',
      note: clean(raw.note),
      createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
      groups,
    };
    // folder：下载到本地时放进哪个文件夹（相对默认根目录，或者盘符开头的完整路径）。可以不写。
    const folder = clean(raw.folder).replace(/\//g, '\\').replace(/^\\+|\\+$/g, '');
    if (folder) out.folder = folder;
    return out;
  }

  // 一段文字是不是“整段就是调研单 JSON”（AI 聊天页里的代码块用这个判断，比 parseImport 严：
  // 必须整段能解析、每一份都有 board/title 和带关键词的 groups）。是就返回规整后的调研单，不是返回 []。
  function sheetsFromJson(text) {
    const src = String(text || '').trim();
    if (!src || (src[0] !== '{' && src[0] !== '[')) return [];
    let j;
    try { j = JSON.parse(src); } catch (e) { return []; }
    const items = Array.isArray(j) ? j : j && Array.isArray(j.sheets) ? j.sheets : [j];
    const out = [];
    for (const it of items) {
      if (!it || typeof it !== 'object' || !Array.isArray(it.groups) || !(it.board || it.title)) return [];
      try { out.push(normalizeSheet(it)); } catch (e) { return []; }
    }
    return out;
  }

  // 存成文件时的样子：只留内容字段，关键词没有备注的写成字符串。
  function toPlain(sheet) {
    const o = { title: sheet.title, board: sheet.board };
    if (sheet.folder) o.folder = sheet.folder;
    if (sheet.privacy === 'secret') o.privacy = 'secret';
    if (sheet.note) o.note = sheet.note;
    o.groups = sheet.groups.map((g) => {
      const x = { name: g.name, section: g.section || false };
      if (g.note) x.note = g.note;
      x.keywords = g.keywords.map((k) => (k.note ? { q: k.q, note: k.note } : k.q));
      return x;
    });
    return o;
  }

  // 调研单的文件名（不带扩展名）：去掉 Windows 文件名里不能用的字符。
  function fileBase(sheet) {
    const s = clean(sheet.title || sheet.board).replace(/[\\/:*?"<>|\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').replace(/[. ]+$/, '').trim();
    return (s || 'sheet').slice(0, 80);
  }

  // 下载到本地的目标文件夹：调研单写了完整路径就用它，否则是 默认根目录\(folder 或 标题)。
  function destOf(sheet, defaultRoot) {
    const f = sheet.folder || fileBase(sheet);
    if (/^[A-Za-z]:\\/.test(f) || /^\\\\/.test(f)) return f;
    const root = String(defaultRoot || '').replace(/[\\/]+$/, '');
    return root ? root + '\\' + f : f;
  }

  // ───────── 链接 ─────────
  // #plk=收藏夹/分区   单个关键词（关键词取地址里的 q）
  // #plks=<base64url 或 URL 编码的 JSON>   整份调研单
  function parseHash(hash, search) {
    const h = String(hash || '').replace(/^#/, '');
    if (!h) return null;
    let q = '';
    try { q = clean(new URLSearchParams(String(search || '')).get('q')); } catch (e) { /* ignore */ }
    for (const part of h.split('&')) {
      const eq = part.indexOf('=');
      if (eq === -1) continue;
      const key = part.slice(0, eq);
      const val = part.slice(eq + 1);
      if (key === 'plks') {
        let text = '';
        try { text = decodeURIComponent(val); } catch (e) { text = val; }
        if (text.trimStart()[0] !== '{') {
          try { text = b64uDecode(val); } catch (e) { return { type: 'error', error: '调研单链接解不开' }; }
        }
        try { return { type: 'sheet', sheet: normalizeSheet(JSON.parse(text)), q }; }
        catch (e) { return { type: 'error', error: '调研单链接内容有误：' + e.message }; }
      }
      if (key === 'plk') {
        const v = decodePart(val);
        const slash = v.indexOf('/');
        const board = clean(slash === -1 ? v : v.slice(0, slash));
        const section = slash === -1 ? '' : clean(v.slice(slash + 1));
        if (!board) return null;
        return { type: 'kw', board, section, q };
      }
    }
    return null;
  }

  function searchUrl(origin, q) {
    return (origin || 'https://www.pinterest.com') + '/search/pins/?q=' + encodeURIComponent(q) + '&rs=typed';
  }

  function sheetLink(sheet, origin) {
    const slim = {
      title: sheet.title, board: sheet.board,
      groups: sheet.groups.map((g) => {
        const o = { name: g.name, section: g.section || false, keywords: g.keywords.map((k) => (k.note ? { q: k.q, note: k.note } : k.q)) };
        if (g.note) o.note = g.note;
        return o;
      }),
    };
    if (sheet.privacy === 'secret') slim.privacy = 'secret';
    if (sheet.note) slim.note = sheet.note;
    return searchUrl(origin, sheet.groups[0].keywords[0].q) + '#plks=' + b64uEncode(JSON.stringify(slim));
  }

  function keywordLink(sheet, group, q, origin) {
    return searchUrl(origin, q) + '#plk=' + encodeURIComponent(sheet.board) + (group.section ? '/' + encodeURIComponent(group.section) : '');
  }

  // ───────── 把一个关键词并进调研单列表（点 #plk 链接时用） ─────────
  // 返回新的 sheets 数组和落在哪份、哪组。
  function addKeyword(sheets, board, section, q) {
    const list = (sheets || []).map((s) => s);
    let idx = list.findIndex((s) => norm(s.board) === norm(board) && s.groups.some((g) => norm(g.section) === norm(section)));
    if (idx === -1) idx = list.findIndex((s) => norm(s.board) === norm(board));
    let sheet;
    if (idx === -1) {
      sheet = { id: hashId(norm(board) + '|' + norm(board)), title: board, board, privacy: 'public', note: '', createdAt: Date.now(), groups: [] };
      list.unshift(sheet);
    } else {
      sheet = Object.assign({}, list[idx], { groups: list[idx].groups.map((g) => Object.assign({}, g, { keywords: g.keywords.slice() })) });
      list[idx] = sheet;
    }
    let group = sheet.groups.find((g) => norm(g.section) === norm(section));
    if (!group) {
      group = { name: section || '未分组', section: section || '', note: '', keywords: [] };
      sheet.groups.push(group);
    }
    if (q && !group.keywords.some((k) => norm(k.q) === norm(q))) group.keywords.push({ q, note: '' });
    return { sheets: list, sheetId: sheet.id, group: group.name };
  }

  // 同 id 的替换（保留原来的位置），否则放到最前
  function upsert(sheets, sheet) {
    const list = (sheets || []).slice();
    const i = list.findIndex((s) => s.id === sheet.id);
    if (i === -1) list.unshift(sheet);
    else list[i] = sheet;
    return list;
  }

  // ───────── 导入：JSON、调研单链接，或者一段带 #plk 链接的文字 ─────────
  function parseImport(text) {
    const src = String(text || '').trim();
    if (!src) return { sheets: [], error: '内容是空的' };
    const a = src.indexOf('{');
    const b = src.lastIndexOf('}');
    const arrA = src.indexOf('[');
    let jsonErr = '';
    if (a !== -1 && b > a) {
      // 整段是数组（多份调研单）时从 [ 开始取
      const useArr = arrA !== -1 && arrA < a && src.lastIndexOf(']') > b;
      const body = useArr ? src.slice(arrA, src.lastIndexOf(']') + 1) : src.slice(a, b + 1);
      try {
        const j = JSON.parse(body);
        const items = Array.isArray(j) ? j : Array.isArray(j.sheets) ? j.sheets : [j];
        return { sheets: items.map(normalizeSheet), error: '' };
      } catch (e) {
        jsonErr = e.message;
      }
    }
    const links = src.match(LINK_RE) || [];
    let sheets = [];
    for (const link of links) {
      let u;
      try { u = new URL(link); } catch (e) { continue; }
      const r = parseHash(u.hash, u.search);
      if (!r) continue;
      if (r.type === 'sheet') sheets = upsert(sheets, r.sheet);
      else if (r.type === 'kw' && r.q) sheets = addKeyword(sheets, r.board, r.section, r.q).sheets;
    }
    if (sheets.length) return { sheets, error: '' };
    return { sheets: [], error: jsonErr ? 'JSON 解析失败：' + jsonErr : '没找到调研单 JSON，也没找到带 #plk= 的链接' };
  }

  // ───────── 按名字在账号的收藏夹里找目标 ─────────
  // 返回 { target, missing }：missing 是 '' / 'board' / 'section'。
  function resolve(boards, boardName, sectionTitle) {
    const b = (boards || []).find((x) => norm(x.name) === norm(boardName));
    if (!b) return { target: null, missing: 'board', board: null };
    const base = { boardId: b.id, boardName: b.name, boardUrl: b.url, cover: b.cover, sectionId: null, sectionTitle: null };
    if (!sectionTitle) return { target: base, missing: '', board: b };
    const s = (b.sections || []).find((x) => norm(x.title) === norm(sectionTitle));
    if (!s) return { target: null, missing: 'section', board: b };
    return { target: Object.assign(base, { sectionId: s.id, sectionTitle: s.title }), missing: '', board: b };
  }

  // 一份调研单还缺什么：{ board: 是否缺收藏夹, sections: [缺的分区名] }
  function missingOf(boards, sheet) {
    const b = (boards || []).find((x) => norm(x.name) === norm(sheet.board));
    const have = new Set(b ? (b.sections || []).map((s) => norm(s.title)) : []);
    const sections = [];
    for (const g of sheet.groups) {
      if (g.section && !have.has(norm(g.section)) && sections.indexOf(g.section) === -1) sections.push(g.section);
    }
    return { board: !b, sections };
  }

  function flatKeywords(sheet) {
    const out = [];
    for (const g of sheet.groups) for (const k of g.keywords) out.push({ group: g, q: k.q, note: k.note });
    return out;
  }

  const AI_PROMPT = [
    '我用一个浏览器插件在 Pinterest 上做视觉调研。请把这次调研整理成下面这种 JSON，放在一个代码块里，不要加注释，我会整段复制进插件：',
    '',
    '{',
    '  "title": "调研主题（中文）",',
    '  "board": "Pinterest 收藏夹名",',
    '  "groups": [',
    '    {',
    '      "name": "分组名（也是收藏夹里的分区名）",',
    '      "note": "这一组要看什么、怎么判断合不合适",',
    '      "keywords": ["pinterest search phrase", "another phrase"]',
    '    }',
    '  ]',
    '}',
    '',
    '要求：',
    '1. 按“看的角度”分 3–6 组（比如 用色 / 笔触 / 构图 / 代表作者 / 相邻风格），每组 4–8 个关键词。',
    '2. 关键词写 Pinterest 上真能搜出图的词，以英文为主；这个风格在日文、中文圈更常见时，把对应语言的词也放进去。',
    '3. 关键词要具体（作者名、流派名、技法名、年代、题材组合），不要只写 "beautiful art" 这种泛词。',
    '4. board 用一个简短的名字；如果我说了要放进哪个收藏夹，就用我说的名字。',
    '5. 如果我说了图要下载到本地哪个文件夹，在最外层加一项 "folder": "文件夹名"；没说就不要加。',
    '6. 代码块里只放这一个 JSON，前后不要有别的字（插件会自动认这个代码块）。',
    '',
    '调研主题：',
  ].join('\n');

  return {
    norm, clean, normalizeSheet, parseHash, parseImport, searchUrl, sheetLink, keywordLink,
    addKeyword, upsert, resolve, missingOf, flatKeywords, AI_PROMPT,
    sheetsFromJson, toPlain, fileBase, destOf, hashId,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = PBLSheet;
