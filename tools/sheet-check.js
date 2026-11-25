// 检查调研单文件合不合格（和插件用的是同一份解析逻辑），并打印插件读进去之后的样子。
//   node tools\sheet-check.js                      检查 sheets\ 里的全部
//   node tools\sheet-check.js sheets\某调研单.json  只检查这一个
// 有不合格的退出码是 1。AI 存完调研单后跑一次这个，再告诉用户“存好了”。
'use strict';
const fs = require('fs');
const path = require('path');
const P = require(path.join(__dirname, '..', 'extension', 'sheet.js'));

const ROOT = path.resolve(__dirname, '..');
const SHEETS = path.join(ROOT, 'sheets');
let defaultRoot = '';
try { defaultRoot = JSON.parse(fs.readFileSync(path.join(ROOT, 'host', 'config.json'), 'utf8').replace(/^﻿/, '')).defaultRoot || ''; } catch (e) { /* 没装小程序就不显示完整路径 */ }

const files = process.argv.slice(2).length
  ? process.argv.slice(2).map((f) => path.resolve(f))
  : fs.readdirSync(SHEETS).filter((n) => /\.json$/i.test(n)).map((n) => path.join(SHEETS, n));
if (!files.length) { console.log('没有要检查的文件。'); process.exit(1); }

let bad = 0;
const seenIds = new Map();
for (const file of files) {
  console.log('\n' + file);
  let data;
  try {
    const buf = fs.readFileSync(file);
    if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) console.log('  注意：文件开头有 BOM，能读，但最好存成不带 BOM 的 UTF-8');
    data = JSON.parse(buf.toString('utf8').replace(/^﻿/, ''));
  } catch (e) { console.log('  不合格：不是合法的 JSON（' + e.message + '）'); bad++; continue; }
  const items = Array.isArray(data) ? data : data && Array.isArray(data.sheets) ? data.sheets : [data];
  for (const raw of items) {
    let s;
    try { s = P.normalizeSheet(raw); } catch (e) { console.log('  不合格：' + e.message); bad++; continue; }
    const warn = [];
    if (path.dirname(file).toLowerCase() !== SHEETS.toLowerCase()) warn.push('这个文件不在调研单文件夹里，插件点“刷新”读不到：' + SHEETS);
    if (seenIds.has(s.id)) warn.push('和 ' + seenIds.get(s.id) + ' 是同一份（title 和 board 都一样），插件里只会留后读到的那个');
    seenIds.set(s.id, path.basename(file));
    if (!raw.title) warn.push('没写 title，用了 board 当标题');
    if (s.groups.length < 3) warn.push('只有 ' + s.groups.length + ' 组，一般按“看的角度”分 3–6 组');
    if (s.groups.length > 8) warn.push('有 ' + s.groups.length + ' 组，太多了，一次调研 3–6 组比较好收');
    const all = new Map();
    const secs = new Map();
    for (const g of s.groups) {
      if (g.keywords.length < 3) warn.push('「' + g.name + '」只有 ' + g.keywords.length + ' 个关键词');
      if (/[\\/]/.test(g.section)) warn.push('分区名「' + g.section + '」里有斜杠，下载后会变成两层文件夹，换个写法');
      if (g.section) { if (secs.has(P.norm(g.section))) warn.push('「' + g.name + '」和「' + secs.get(P.norm(g.section)) + '」用了同一个分区「' + g.section + '」'); secs.set(P.norm(g.section), g.name); }
      for (const k of g.keywords) {
        if (all.has(P.norm(k.q))) warn.push('关键词「' + k.q + '」在「' + all.get(P.norm(k.q)) + '」和「' + g.name + '」里重复了');
        all.set(P.norm(k.q), g.name);
      }
    }
    console.log('  合格：「' + s.title + '」 → 收藏夹（Board）「' + s.board + '」' + (s.privacy === 'secret' ? '（私密）' : ''));
    console.log('  下载到：' + P.destOf(s, defaultRoot) + (s.folder ? '' : '   （没写 folder，用标题当文件夹名）'));
    for (const g of s.groups) console.log('    ' + (g.section ? '§ ' + g.section : '（不分区）') + (g.section && g.section !== g.name ? '  [' + g.name + ']' : '') + '：' + g.keywords.length + ' 个关键词');
    for (const w of warn) console.log('  提醒：' + w);
  }
}
console.log(bad ? '\n' + bad + ' 处不合格' : '\n都合格');
process.exit(bad ? 1 : 0);
