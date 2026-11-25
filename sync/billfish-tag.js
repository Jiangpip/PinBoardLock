// 把 gallery-dl 下载到 Billfish 库里的 Pinterest 图，写上来源链接和标签。
//
//   node sync\billfish-tag.js                     按 sync\boards.json 处理全部收藏夹
//   node sync\billfish-tag.js --dry-run           只报告会写什么，不写
//   node sync\billfish-tag.js --only 阳朔         只处理名字里带“阳朔”的
//   node sync\billfish-tag.js --allow-running    Billfish 开着也写（实测确认安全之后再用）
//   node sync\billfish-tag.js --db <副本.db>      写到指定数据库（测试用，不查 Billfish 是否开着，也不备份）
//
// 规则：
//   来源（origin）  文件名 pinterest_<编号>.jpg 里的数字是 Pin 编号 → https://www.pinterest.com/pin/<编号>/
//   标签            顶层标签 = 收藏夹名（boards.json 里的 tag，没有就用 name），子标签 = 分区名（dest 下第一层子文件夹）
//   已经有来源的文件不改来源；已经有的标签不重复加；备注、评分不动。
//   Billfish 还没扫描到的文件（数据库里没有）只报告，不自己建记录：先开一次 Billfish 让它扫完再跑。
//
// 需要 Node 22.5 以上（用自带的 node:sqlite）。写真实库之前 Billfish 必须关着。
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

// gallery-dl 1.32 的文件名是 pinterest_<编号>.jpg，多图 Pin 是 pinterest_<编号>_<序号>.jpg；也认不带前缀的。
// 没登录时收藏夹列表给的是另一种编号（e1_ 开头的一长串字母数字，里面本身带 _ 和 -），整段都是编号。
const PIN_NUM_RE = /^(?:pinterest_)?(\d{6,})(?:[_.]|$)/i;
const PIN_ENC_RE = /^pinterest_(e\d+_[A-Za-z0-9_-]{20,})\.[A-Za-z0-9]+$/;
function pinIdOf(fileName) {
  const m = PIN_NUM_RE.exec(fileName) || PIN_ENC_RE.exec(fileName);
  return m ? m[1] : '';
}
const SKIP_FILE = /^\.pinterest-archive/i;

function parseArgs(argv) {
  const a = { config: path.join(__dirname, 'boards.json'), dryRun: false, only: '', db: '' };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--dry-run') a.dryRun = true;
    else if (k === '--only') a.only = argv[++i] || '';
    else if (k === '--db') a.db = argv[++i] || '';
    else if (k === '--config') a.config = argv[++i] || '';
    else if (k === '--name') a.name = argv[++i] || '';
    else if (k === '--allow-running') a.allowRunning = true;
    else throw new Error('不认识的参数：' + k);
  }
  return a;
}

// 从 dest 往上找带 .bf\billfish.db 的目录，就是 Billfish 库根。
function findLibraryRoot(dest) {
  let dir = path.resolve(dest);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.bf', 'billfish.db'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return '';
    dir = up;
  }
}

function billfishRunning() {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq Billfish.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8' });
    return /billfish\.exe/i.test(out);
  } catch (_) { return false; }
}

const sameName = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

// 按路径一层层找文件夹 id；库根是 pid 0。
function folderIdByPath(db, parts) {
  let pid = 0;
  const q = db.prepare('select id, name from bf_folder where pid = ? and ifnull(is_recycle,0) = 0');
  for (const part of parts) {
    const hit = q.all(pid).find(r => sameName(r.name, part));
    if (!hit) return -1;
    pid = hit.id;
  }
  return pid;
}

// 收藏夹文件夹下的全部文件：{ id, name, section }，section 是第一层子文件夹名（直属文件为 ''）。
function filesUnder(db, rootId) {
  const qFolders = db.prepare('select id, name from bf_folder where pid = ? and ifnull(is_recycle,0) = 0');
  const qFiles = db.prepare('select id, name from bf_file where pid = ?');
  const out = [];
  const walk = (fid, section) => {
    for (const f of qFiles.all(fid)) out.push({ id: f.id, name: f.name, section });
    for (const d of qFolders.all(fid)) walk(d.id, section || d.name);
  };
  walk(rootId, '');
  return out;
}

function filesOnDisk(dest) {
  const out = [];
  const walk = (dir, section) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(dir, e.name), section || e.name);
      else if (!SKIP_FILE.test(e.name)) out.push({ name: e.name, section });
    }
  };
  if (fs.existsSync(dest)) walk(dest, '');
  return out;
}

// 找或建标签。Billfish 里现有标签没有重名的，所以子标签和别处重名时写成“收藏夹名/分区名”。
function ensureTag(db, name, pid, now, dryRun, stats) {
  const same = db.prepare('select id, pid from bf_tag_v2 where name = ?').all(name);
  const hit = same.find(r => r.pid === pid);
  if (hit) return { id: hit.id, name };
  if (same.length && pid !== 0) {
    const parent = db.prepare('select name from bf_tag_v2 where id = ?').get(pid);
    return ensureTag(db, (parent ? parent.name : '') + '/' + name, pid, now, dryRun, stats);
  }
  if (same.length) return { id: same[0].id, name }; // 顶层重名：直接用已有的那个
  stats.newTags.push(name);
  if (dryRun) return { id: -(stats.newTags.length), name };
  const maxSeq = db.prepare('select max(seq) m from bf_tag_v2 where pid = ?').get(pid).m;
  const seq = (maxSeq || 0.9) + 0.000001;
  const r = db.prepare('insert into bf_tag_v2 (name, pid, seq, icon, color, born) values (?, ?, ?, 0, 0, ?)').run(name, pid, seq, now);
  return { id: Number(r.lastInsertRowid), name };
}

function tagBoard(db, board, libRoot, opts, now) {
  const stats = { name: board.name || board.url, onDisk: 0, inDb: 0, notScanned: [], noPinId: [], gone: 0, originSet: 0, originKept: 0, tagLinks: 0, newTags: [], error: '' };
  const dest = path.resolve(board.dest);
  const rel = path.relative(libRoot, dest);
  if (rel.startsWith('..') || path.isAbsolute(rel)) { stats.error = 'dest 不在 Billfish 库里：' + dest; return stats; }

  const disk = filesOnDisk(dest);
  stats.onDisk = disk.length;
  const folderId = folderIdByPath(db, rel.split(path.sep).filter(Boolean));
  if (folderId < 0) {
    stats.notScanned = disk.map(f => path.join(f.section, f.name));
    stats.error = disk.length ? 'Billfish 还没扫描到这个文件夹，先开一次 Billfish' : '文件夹是空的或还没下载';
    return stats;
  }

  const rows = filesUnder(db, folderId);
  stats.inDb = rows.length;
  const known = new Set(rows.map(r => (r.section + '/' + r.name).toLowerCase()));
  stats.notScanned = disk.filter(f => !known.has((f.section + '/' + f.name).toLowerCase())).map(f => path.join(f.section, f.name));

  const boardTagName = board.tag || board.name;
  const boardTag = ensureTag(db, boardTagName, 0, now, opts.dryRun, stats);
  const sectionTags = new Map();

  const qUser = db.prepare('select id, origin from bf_material_userdata where file_id = ?');
  const insUser = db.prepare("insert into bf_material_userdata (file_id, comments_summary, comments_count, comments_detail, note, origin, score, rotation, hflip, vflip, cover_tid) values (?, '', 0, '', '', ?, 0, 0, 0, 0, '0')");
  const updOrigin = db.prepare('update bf_material_userdata set origin = ? where id = ?');
  const qLink = db.prepare('select 1 x from bf_tag_join_file where file_id = ? and tag_id = ?');
  const insLink = db.prepare('insert into bf_tag_join_file (file_id, tag_id, born) values (?, ?, ?)');

  const onDisk = new Set(disk.map(f => (f.section + '/' + f.name).toLowerCase()));
  for (const f of rows) {
    if (SKIP_FILE.test(f.name)) continue;
    // 数据库里还有、磁盘上已经删掉的（比如去重放进回收站的），Billfish 下次会自己清掉，这里不碰。
    if (!onDisk.has((f.section + '/' + f.name).toLowerCase())) { stats.gone++; continue; }
    const pinId = pinIdOf(f.name);
    if (!pinId) { stats.noPinId.push(path.join(f.section, f.name)); continue; }
    const origin = 'https://www.pinterest.com/pin/' + pinId + '/';

    const u = qUser.get(f.id);
    if (u && u.origin) stats.originKept++;
    else {
      stats.originSet++;
      if (!opts.dryRun) { if (u) updOrigin.run(origin, u.id); else insUser.run(f.id, origin); }
    }

    const tags = [boardTag];
    if (f.section) {
      if (!sectionTags.has(f.section)) sectionTags.set(f.section, ensureTag(db, f.section, boardTag.id, now, opts.dryRun, stats));
      tags.push(sectionTags.get(f.section));
    }
    for (const t of tags) {
      if (t.id > 0 && qLink.get(f.id, t.id)) continue;
      stats.tagLinks++;
      if (!opts.dryRun) insLink.run(f.id, t.id, now);
    }
  }
  return stats;
}

// 给命令行和本机小程序（host\pbl-host.js）共用的入口。
//   opts: { config 或 boards + billfishLibrary, only（名字包含）, name（名字全等）, dryRun, db, allowRunning, backupDir }
//   返回 { ok, reason, dbPath, backup, dryRun, results }；reason: 'no-boards' | 'no-library' | 'billfish-running'
function run(opts) {
  opts = Object.assign({}, opts);
  const cfg = opts.boards ? { boards: opts.boards, billfishLibrary: opts.billfishLibrary } : JSON.parse(fs.readFileSync(opts.config, 'utf8'));
  let boards = (cfg.boards || []).filter(b => b && b.dest && (b.name || b.tag));
  if (opts.only) boards = boards.filter(b => String(b.name || '').includes(opts.only));
  if (opts.name) boards = boards.filter(b => String(b.name || '') === opts.name);
  if (!boards.length) return { ok: false, reason: 'no-boards', message: 'boards.json 里没有可处理的收藏夹（要有 name 和 dest）。' };

  const libRoot = cfg.billfishLibrary || findLibraryRoot(boards[0].dest);
  if (!libRoot) return { ok: false, reason: 'no-library', message: '找不到 Billfish 库根（dest 往上没有 .bf\\billfish.db）：' + boards[0].dest };
  const realDb = path.join(libRoot, '.bf', 'billfish.db');
  const dbPath = opts.db || realDb;
  const onRealDb = path.resolve(dbPath).toLowerCase() === path.resolve(realDb).toLowerCase();

  let backup = '';
  if (onRealDb && !opts.dryRun) {
    if (!opts.allowRunning && billfishRunning()) return { ok: false, reason: 'billfish-running', message: 'Billfish 开着。先关掉 Billfish 再跑。' };
    const bakDir = opts.backupDir || path.join(__dirname, 'backups');
    fs.mkdirSync(bakDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    backup = path.join(bakDir, 'billfish-' + stamp + '.db');
    fs.copyFileSync(realDb, backup);
  }

  const db = new DatabaseSync(dbPath, { readOnly: !!opts.dryRun });
  const now = Math.floor(Date.now() / 1000);
  const results = [];
  if (!opts.dryRun) { db.exec('pragma busy_timeout = 5000'); db.exec('begin immediate'); }
  try {
    for (const b of boards) results.push(tagBoard(db, b, libRoot, opts, now));
    if (!opts.dryRun) db.exec('commit');
  } catch (e) {
    if (!opts.dryRun) { try { db.exec('rollback'); } catch (_) { /* ignore */ } }
    throw e;
  } finally { db.close(); }
  return { ok: true, reason: '', dbPath, backup, dryRun: !!opts.dryRun, results };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const r = run(opts);
  if (!r.ok) { console.log(r.message); process.exit(r.reason === 'billfish-running' ? 2 : 1); }
  if (r.backup) console.log('已备份：' + r.backup);
  console.log((r.dryRun ? '【只预览，没有写】 ' : '') + '数据库：' + r.dbPath);
  for (const s of r.results) {
    console.log('\n== ' + s.name);
    if (s.error) console.log('   ' + s.error);
    console.log(`   磁盘上 ${s.onDisk} 个文件，Billfish 已收录 ${s.inDb} 个`);
    console.log(`   写来源 ${s.originSet} 个（已有来源保留 ${s.originKept} 个），加标签关联 ${s.tagLinks} 条`);
    if (s.gone) console.log(`   数据库里有、磁盘上已删掉 ${s.gone} 个：没处理`);
    if (s.newTags.length) console.log('   新建标签：' + s.newTags.join('、'));
    if (s.notScanned.length) console.log(`   Billfish 还没扫描到 ${s.notScanned.length} 个：` + s.notScanned.slice(0, 5).join('、') + (s.notScanned.length > 5 ? ' …' : ''));
    if (s.noPinId.length) console.log(`   文件名不是 Pin 编号、跳过 ${s.noPinId.length} 个：` + s.noPinId.slice(0, 5).join('、') + (s.noPinId.length > 5 ? ' …' : ''));
  }
  if (r.results.some(s => s.notScanned.length)) process.exitCode = 3;
}

if (require.main === module) {
  try { main(); } catch (e) { console.error('出错：' + e.message); process.exit(1); }
}
module.exports = { pinIdOf, findLibraryRoot, folderIdByPath, filesUnder, ensureTag, tagBoard, run, billfishRunning };
