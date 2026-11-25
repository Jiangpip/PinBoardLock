// 把一份调研单 JSON 变成可以直接点的链接。
// 用法：node tools\sheet-link.js sheets\某调研单.json [--md]
//   不带参数：打印整份调研单的导入链接（点开就导入到插件里）。
//   --md：再打印一份 Markdown，每个关键词一个链接，可以贴进 Obsidian 笔记。
const fs = require('fs');
const path = require('path');
const P = require(path.join(__dirname, '..', 'extension', 'sheet.js'));

const file = process.argv[2];
if (!file) {
  console.error('用法：node tools\\sheet-link.js <调研单.json> [--md]');
  process.exit(1);
}
const res = P.parseImport(fs.readFileSync(file, 'utf8'));
if (!res.sheets.length) {
  console.error('读不出调研单：' + res.error);
  process.exit(1);
}
for (const sheet of res.sheets) {
  const n = sheet.groups.reduce((a, g) => a + g.keywords.length, 0);
  console.log('# ' + sheet.title + ' → 收藏夹「' + sheet.board + '」，' + sheet.groups.length + ' 组 ' + n + ' 个关键词');
  console.log(P.sheetLink(sheet));
  if (process.argv.includes('--md')) {
    console.log('');
    for (const g of sheet.groups) {
      console.log('## ' + g.name + (g.note ? '（' + g.note + '）' : ''));
      for (const k of g.keywords) console.log('- [' + k.q + '](' + P.keywordLink(sheet, g, k.q) + ')' + (k.note ? ' ' + k.note : ''));
      console.log('');
    }
  }
}
