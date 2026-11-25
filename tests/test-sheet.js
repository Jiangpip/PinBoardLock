// 调研单逻辑（extension\sheet.js）的测试：链接解析、导入、按名字找目标。
// 用法：node tests\test-sheet.js extension\sheet.js
const path = require('path');
const P = require(path.resolve(process.argv[2]));

let failed = 0;
const check = (name, cond, extra) => {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (cond ? '' : '   ' + (extra === undefined ? '' : JSON.stringify(extra))));
  if (!cond) failed++;
};

const RAW = {
  title: '水墨感山水',
  board: '风格调研-水墨感',
  groups: [
    { name: '河面雾气', note: '看雾怎么压住远山', keywords: ['karst river mist', 'li river morning fog', 'Karst  River Mist'] },
    { name: '峰林剪影', section: '剪影', keywords: [{ q: 'guilin mountains silhouette', note: '逆光' }] },
    { name: '散图', section: false, keywords: ['chinese ink landscape'] },
    { name: '空组', keywords: [] },
  ],
};

// 1. 规整
{
  const s = P.normalizeSheet(RAW);
  check('收藏夹名和标题', s.board === '风格调研-水墨感' && s.title === '水墨感山水');
  check('空组被丢掉', s.groups.length === 3, s.groups.map((g) => g.name));
  check('关键词去重（不分大小写、空格）', s.groups[0].keywords.length === 2, s.groups[0].keywords);
  check('分区缺省等于分组名', s.groups[0].section === '河面雾气');
  check('分区可以单独指定', s.groups[1].section === '剪影' && s.groups[1].keywords[0].note === '逆光');
  check('section:false → 不分区', s.groups[2].section === '');
  check('默认公开', s.privacy === 'public');
  check('同标题同收藏夹 → 同一个 id', P.normalizeSheet(RAW).id === s.id && /^s[a-z0-9]+$/.test(s.id), s.id);
  let threw = '';
  try { P.normalizeSheet({ title: 'x', groups: [] }); } catch (e) { threw = e.message; }
  check('没有关键词 → 报错', threw === '没有任何关键词', threw);
  const flatOnly = P.normalizeSheet({ board: 'B', keywords: ['a', 'b'] });
  check('只有 keywords 没有 groups → 一组、不分区', flatOnly.groups.length === 1 && flatOnly.groups[0].section === '' && flatOnly.title === 'B');
}

// 2. 单个关键词链接
{
  const r = P.parseHash('#plk=' + encodeURIComponent('风格调研-水墨感') + '/' + encodeURIComponent('河面雾气'), '?q=karst+river+mist&rs=typed');
  check('#plk 解析', r && r.type === 'kw' && r.board === '风格调研-水墨感' && r.section === '河面雾气' && r.q === 'karst river mist', r);
  const raw = P.parseHash('#plk=风格调研-水墨感/河面雾气', '?q=a%20b');
  check('#plk 不编码的中文也认', raw && raw.board === '风格调研-水墨感' && raw.section === '河面雾气' && raw.q === 'a b', raw);
  const plus = P.parseHash('#plk=ink+wash/river+mist', '?q=x');
  check('#plk 里的 + 当空格', plus && plus.board === 'ink wash' && plus.section === 'river mist', plus);
  const noSec = P.parseHash('#plk=myboard', '?q=x');
  check('#plk 只有收藏夹', noSec && noSec.board === 'myboard' && noSec.section === '', noSec);
  check('别的 hash 不理', P.parseHash('#top', '?q=x') === null && P.parseHash('', '') === null);
  check('别的参数夹在一起也行', P.parseHash('#a=1&plk=b/s', '?q=x').section === 's');
}

// 3. 整份调研单链接：往返
{
  const s = P.normalizeSheet(RAW);
  const link = P.sheetLink(s);
  const u = new URL(link);
  check('调研单链接是普通搜索地址', u.pathname === '/search/pins/' && u.searchParams.get('q') === 'karst river mist', link.slice(0, 80));
  const r = P.parseHash(u.hash, u.search);
  check('#plks 往返：类型和 id', r && r.type === 'sheet' && r.sheet.id === s.id, r && r.type);
  check('#plks 往返：内容一致', JSON.stringify(r.sheet.groups) === JSON.stringify(s.groups));
  check('#plks 往返：带上 q', r.q === 'karst river mist');
  const pct = P.parseHash('#plks=' + encodeURIComponent(JSON.stringify({ board: 'B', keywords: ['a'] })), '');
  check('#plks 也认 URL 编码的 JSON', pct && pct.type === 'sheet' && pct.sheet.board === 'B', pct);
  const bad = P.parseHash('#plks=%%%', '');
  check('#plks 坏了 → error', bad && bad.type === 'error', bad);
  const kl = new URL(P.keywordLink(s, s.groups[1], 'guilin mountains silhouette'));
  const kr = P.parseHash(kl.hash, kl.search);
  check('关键词链接往返', kr.board === s.board && kr.section === '剪影' && kr.q === 'guilin mountains silhouette', kr);
}

// 4. 导入
{
  const fenced = '好的，这是调研单：\n```json\n' + JSON.stringify(RAW, null, 2) + '\n```\n需要我再补一组吗？';
  const a = P.parseImport(fenced);
  check('导入：带代码围栏和前后文字的 JSON', a.sheets.length === 1 && a.sheets[0].groups.length === 3 && !a.error, a.error);
  const arr = P.parseImport(JSON.stringify([RAW, { board: 'B2', keywords: ['x'] }]));
  check('导入：数组 = 多份', arr.sheets.length === 2 && arr.sheets[1].board === 'B2', arr);
  const text = [
    '用色：[muted ink palette](https://www.pinterest.com/search/pins/?q=muted+ink+palette#plk=水墨/用色)',
    '[sumi-e wash](https://www.pinterest.com/search/pins/?q=sumi-e%20wash#plk=水墨/用色) 和',
    'https://www.pinterest.com/search/pins/?q=shan+shui+composition#plk=水墨/构图',
    'https://www.pinterest.com/search/pins/?q=cyber+ink#plk=别的收藏夹',
  ].join('\n');
  const l = P.parseImport(text);
  check('导入：一段带 #plk 链接的文字 → 按收藏夹分成两份', l.sheets.length === 2, l.sheets.map((s) => s.board));
  const ink = l.sheets.find((s) => s.board === '水墨');
  check('导入：链接按分区归组', ink && ink.groups.length === 2 && ink.groups[0].keywords.map((k) => k.q).join('|') === 'muted ink palette|sumi-e wash', ink && ink.groups);
  check('导入：空内容 / 无关内容报错', P.parseImport('').error && P.parseImport('hello').error && !P.parseImport('hello').sheets.length);
  check('导入：坏 JSON 给出原因', /JSON/.test(P.parseImport('{"board": "x", ').error || P.parseImport('{"board": "x" "groups"}').error));
  const sl = P.parseImport('点这里 ' + P.sheetLink(P.normalizeSheet(RAW)) + ' 打开');
  check('导入：整份调研单链接', sl.sheets.length === 1 && sl.sheets[0].title === '水墨感山水', sl.error);
}

// 5. addKeyword / upsert
{
  let r = P.addKeyword([], 'B', 'S1', 'k1');
  check('第一次点链接 → 自动建一份调研单', r.sheets.length === 1 && r.sheets[0].board === 'B' && r.sheets[0].groups[0].section === 'S1' && r.group === 'S1');
  const before = r.sheets;
  r = P.addKeyword(r.sheets, 'b', 's1', 'K1');
  check('同一个词再点 → 不重复', r.sheets[0].groups[0].keywords.length === 1);
  r = P.addKeyword(r.sheets, 'B', 'S2', 'k2');
  check('同收藏夹新分区 → 加一组', r.sheets.length === 1 && r.sheets[0].groups.length === 2);
  check('不改原数组里的对象', before[0].groups.length === 1);
  r = P.addKeyword(r.sheets, 'B', '', 'k3');
  check('不带分区 → 单独一组', r.sheets[0].groups.length === 3 && r.sheets[0].groups[2].section === '' && r.group === '未分组');
  const s = P.normalizeSheet(RAW);
  const merged = P.addKeyword([s], '风格调研-水墨感', '剪影', 'new one');
  check('链接指向已导入的调研单 → 并进对应分组', merged.sheetId === s.id && merged.group === '峰林剪影' && merged.sheets[0].groups[1].keywords.length === 2, merged.group);
  const up = P.upsert([{ id: 'a' }, s], Object.assign({}, s, { title: '改了' }));
  check('upsert 同 id 原位替换', up.length === 2 && up[1].title === '改了');
  check('upsert 新的放最前', P.upsert([{ id: 'a' }], s)[0].id === s.id);
}

// 6. 按名字找目标
{
  const boards = [
    { id: '1', name: '风格调研-水墨感', url: '/me/ink/', cover: 'c', sections: [{ id: '10', title: '河面雾气' }, { id: '11', title: '剪影' }] },
    { id: '2', name: 'Other', url: '/me/o/', sections: [] },
  ];
  const a = P.resolve(boards, ' 风格调研-水墨感 ', '河面雾气');
  check('找到收藏夹+分区', a.target && a.target.boardId === '1' && a.target.sectionId === '10' && a.target.sectionTitle === '河面雾气' && a.missing === '', a);
  const b = P.resolve(boards, 'other', '');
  check('只要收藏夹（不分大小写）', b.target && b.target.boardId === '2' && b.target.sectionId === null);
  check('缺分区', P.resolve(boards, 'Other', 'x').missing === 'section' && P.resolve(boards, 'Other', 'x').target === null);
  check('缺收藏夹', P.resolve(boards, 'nope', 'x').missing === 'board' && P.resolve(undefined, 'nope', '').missing === 'board');
  const s = P.normalizeSheet(RAW);
  const m = P.missingOf(boards, s);
  check('调研单缺什么：收藏夹在、分区齐', !m.board && m.sections.length === 0, m);
  const m2 = P.missingOf([boards[1]], s);
  check('调研单缺什么：收藏夹没有 → 两个分区都要建', m2.board && m2.sections.join('|') === '河面雾气|剪影', m2);
  const m3 = P.missingOf([Object.assign({}, boards[0], { sections: [boards[0].sections[0]] })], s);
  check('调研单缺什么：只缺一个分区', !m3.board && m3.sections.join('|') === '剪影', m3);
  check('flatKeywords 顺序', P.flatKeywords(s).map((k) => k.q).join('|') === 'karst river mist|li river morning fog|guilin mountains silhouette|chinese ink landscape');
}

// 存文件、认代码块、下载目标文件夹
{
  const raw = { title: '赛博/霓虹: 夜', board: '风格调研-赛博', folder: '/赛博霓虹参考/', groups: [{ name: '招牌', keywords: ['neon signage night', { q: 'cyberpunk alley', note: '小巷' }] }, { name: '散图', section: false, keywords: ['rain'] }] };
  const s = P.normalizeSheet(raw);
  check('folder 留下来，去掉两头的斜杠', s.folder === '赛博霓虹参考', s.folder);
  check('没写 folder 就没有这个字段', !('folder' in P.normalizeSheet({ board: 'b', groups: [{ name: 'g', keywords: ['k'] }] })));
  const plain = P.toPlain(s);
  check('toPlain：只留内容字段', JSON.stringify(Object.keys(plain)) === '["title","board","folder","groups"]' && plain.groups[0].keywords[0] === 'neon signage night' && plain.groups[0].keywords[1].note === '小巷' && plain.groups[1].section === false, plain);
  check('toPlain 再读回来是同一份', P.normalizeSheet(plain).id === s.id && JSON.stringify(P.toPlain(P.normalizeSheet(plain))) === JSON.stringify(plain));
  check('fileBase：去掉文件名里不能用的字符', P.fileBase(s) === '赛博 霓虹 夜', P.fileBase(s));
  check('destOf：默认根目录 + folder', P.destOf(s, 'D:\\库\\参考\\') === 'D:\\库\\参考\\赛博霓虹参考', P.destOf(s, 'D:\\库\\参考\\'));
  check('destOf：没写 folder 用标题', P.destOf(P.normalizeSheet({ title: '水墨感山水', board: 'b', groups: raw.groups }), 'D:\\库\\参考') === 'D:\\库\\参考\\水墨感山水');
  check('destOf：folder 是完整路径就原样用', P.destOf(P.normalizeSheet(Object.assign({}, raw, { folder: 'E:/图/赛博' })), 'D:\\库') === 'E:\\图\\赛博');

  const text = JSON.stringify(raw, null, 2);
  check('sheetsFromJson：整段是调研单', P.sheetsFromJson(text).length === 1 && P.sheetsFromJson(text)[0].board === '风格调研-赛博');
  check('sheetsFromJson：数组 = 多份', P.sheetsFromJson('[' + text + ',' + text.replace('赛博/霓虹: 夜', '另一份') + ']').length === 2);
  check('sheetsFromJson：没写完的不算', P.sheetsFromJson(text.slice(0, text.length - 20)).length === 0);
  check('sheetsFromJson：前后带别的字不算', P.sheetsFromJson('这是调研单：' + text).length === 0);
  check('sheetsFromJson：碰巧有 groups 字样的别的 JSON 不算', P.sheetsFromJson('{"groups": 5}').length === 0 && P.sheetsFromJson('{"groups": [{"name":"a","keywords":["k"]}]}').length === 0 && P.sheetsFromJson('{"board":"b","groups":[{"name":"空的","keywords":[]}]}').length === 0);
}

console.log(failed ? '\n' + failed + ' 项失败' : '\n全部通过');
process.exit(failed ? 1 : 0);
