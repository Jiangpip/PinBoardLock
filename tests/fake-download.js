// test-host.js 用的假下载脚本：代替 Sync-PinterestBoards.ps1 + gallery-dl。
// 每跑一次，往收藏夹的目标文件夹里加 1 张散图和 1 张分区图，然后打印和真脚本一样的 ##PBL 结果行。
const fs = require('fs');
const path = require('path');
const arg = (k) => { const i = process.argv.indexOf(k); return i === -1 ? '' : process.argv[i + 1]; };
const cfg = JSON.parse(fs.readFileSync(arg('-Config'), 'utf8'));
const b = cfg.boards.find((x) => x.name === arg('-Name'));
if (!b) { console.log('没有可同步的收藏夹。'); process.exit(1); }
const count = (dir) => fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? count(path.join(dir, e.name)) : 1), 0) : 0;
const before = count(b.dest);
const sec = path.join(b.dest, '笔触');
fs.mkdirSync(sec, { recursive: true });
const n = String(before + 1).padStart(3, '0');
const files = [path.join(b.dest, 'pinterest_e1_AfqPShw6ls2kNmqQQO8rWFLDBDTpfTI4' + n + '.jpg'), path.join(sec, 'pinterest_9076161312112' + n + '.jpg')];
for (const f of files) { fs.writeFileSync(f, 'img' + f); console.log(f); }
const total = count(b.dest);
console.log('##PBL ' + JSON.stringify({ name: b.name, before, total, dups: 0, code: 0 }));
