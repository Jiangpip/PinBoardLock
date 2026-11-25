// sync\billfish-tag.js 的测试：在临时目录里搭一个假的 Billfish 库，跑真脚本，再读数据库检查。
// 用法：node tests\test-billfish.js [真实 billfish.db 的副本]
//   不给参数：用最小表结构新建一个库。
//   给了副本：在副本的拷贝上加测试文件夹再跑（顺带检查原有数据没被动）。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

let failed = 0;
const check = (name, cond, extra) => {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (cond ? '' : '   ' + (extra === undefined ? '' : JSON.stringify(extra))));
  if (!cond) failed++;
};

const SCHEMA = `
CREATE TABLE bf_file (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, pid INTEGER NOT NULL, is_hide INTEGER, is_link INTEGER, file_size INTEGER, ctime INTEGER, mtime INTEGER, md5 TEXT, tid INTEGER, born INTEGER, ttid INTEGER);
CREATE TABLE bf_folder (id INTEGER PRIMARY KEY AUTOINCREMENT, born INTEGER, pid INTEGER NOT NULL, name TEXT, desc TEXT, cover_tid INTEGER, hide INTEGER, seq REAL, color INTEGER, is_recycle INTEGER);
CREATE TABLE bf_material_userdata (id INTEGER PRIMARY KEY AUTOINCREMENT, file_id INTEGER NOT NULL, comments_summary TEXT, comments_count INTEGER, comments_detail TEXT, note TEXT, origin TEXT, score INTEGER, rotation INTEGER, hflip INTEGER, vflip INTEGER, cover_tid TEXT, unique(file_id) on conflict replace);
CREATE TABLE bf_tag_v2(id integer primary key autoincrement,name text,pid integer,seq real,icon integer,color integer,born integer);
CREATE TABLE bf_tag_join_file(id integer primary key autoincrement, file_id integer, tag_id integer, born integer,unique(file_id, tag_id) on conflict ignore);
`;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plk-bf-'));
const lib = path.join(root, 'lib');
// 数据库故意不放在 lib\.bf 里：脚本只有写“库自己的” billfish.db 时才查 Billfish 是否开着、才备份，
// 测试不该受本机 Billfish 开没开影响。库根用 boards.json 的 billfishLibrary 指定。
const dbPath = path.join(root, 'test.db');
fs.mkdirSync(lib, { recursive: true });
const baseDb = process.argv[2];
if (baseDb) fs.copyFileSync(baseDb, dbPath);

const BOARD = 'PLK测试收藏夹';
const dest = path.join(lib, 'PLK测试区', BOARD);
// 磁盘上的文件：[分区, 文件名]
const DISK = [
  ['', 'pinterest_111111111111111111.jpg'],  // 没分区；gallery-dl 的真实文件名带 pinterest_ 前缀
  ['石桥', '222222222222222222.jpg'],        // 不带前缀也认
  ['石桥', 'pinterest_333333333333333333_2.png'], // 多图 Pin 的第 2 张
  ['石桥', '444444444444444444.jpg'],        // 已有来源和备注
  ['竹林', '555555555555555555.jpg'],        // 分区名和别处的标签重名
  ['竹林', '封面草图.jpg'],                   // 不是 Pin 编号
  ['散图', '666666666666666666.jpg'],        // Billfish 还没扫描到
];
for (const [sec, name] of DISK) {
  fs.mkdirSync(path.join(dest, sec), { recursive: true });
  fs.writeFileSync(path.join(dest, sec, name), 'x');
}
fs.writeFileSync(path.join(dest, '.pinterest-archive.sqlite3'), 'x');

let db = new DatabaseSync(dbPath);
if (!baseDb) db.exec(SCHEMA);
const before = {
  users: db.prepare('select count(*) c from bf_material_userdata').get().c,
  tags: db.prepare('select count(*) c from bf_tag_v2').get().c,
  links: db.prepare('select count(*) c from bf_tag_join_file').get().c,
};
const addFolder = (name, pid) => Number(db.prepare("insert into bf_folder (born, pid, name, desc, cover_tid, hide, seq, color, is_recycle) values (1, ?, ?, '', 0, 0, 0.5, 0, 0)").run(pid, name).lastInsertRowid);
const addFile = (name, pid) => Number(db.prepare("insert into bf_file (name, pid, is_hide, is_link, file_size, ctime, mtime, md5, tid, born, ttid) values (?, ?, 0, 0, 1, 1, 1, '', 20, 1, 0)").run(name, pid).lastInsertRowid);
const fArea = addFolder('PLK测试区', 0);
const fBoard = addFolder(BOARD, fArea);
const fBridge = addFolder('石桥', fBoard);
const fBamboo = addFolder('竹林', fBoard);
const ids = {
  loose: addFile('pinterest_111111111111111111.jpg', fBoard),
  b1: addFile('222222222222222222.jpg', fBridge),
  b2: addFile('pinterest_333333333333333333_2.png', fBridge),
  b3: addFile('444444444444444444.jpg', fBridge),
  bamboo: addFile('555555555555555555.jpg', fBamboo),
  sketch: addFile('封面草图.jpg', fBamboo),
  archive: addFile('.pinterest-archive.sqlite3', fBoard),
};
db.prepare("insert into bf_material_userdata (file_id, comments_summary, comments_count, comments_detail, note, origin, score, rotation, hflip, vflip, cover_tid) values (?, '', 0, '', '手写备注', 'https://example.com/mine', 4, 0, 0, 0, '0')").run(ids.b3);
db.prepare("insert into bf_material_userdata (file_id, comments_summary, comments_count, comments_detail, note, origin, score, rotation, hflip, vflip, cover_tid) values (?, '', 0, '', '只有备注', '', 3, 0, 0, 0, '0')").run(ids.b1);
// 别处已有一个叫“竹林”的子标签
let otherParent = db.prepare("select id from bf_tag_v2 where name = '阳朔实拍' and pid = 0").get();
if (!otherParent) otherParent = { id: Number(db.prepare("insert into bf_tag_v2 (name, pid, seq, icon, color, born) values ('阳朔实拍', 0, 0.900001, 0, 0, 1)").run().lastInsertRowid) };
if (!db.prepare("select id from bf_tag_v2 where name = '竹林'").get()) db.prepare("insert into bf_tag_v2 (name, pid, seq, icon, color, born) values ('竹林', ?, 0.900001, 0, 0, 1)").run(otherParent.id);
const setup = {
  users: db.prepare('select count(*) c from bf_material_userdata').get().c,
  tags: db.prepare('select count(*) c from bf_tag_v2').get().c,
  links: db.prepare('select count(*) c from bf_tag_join_file').get().c,
};
db.close();

const cfgPath = path.join(root, 'boards.json');
fs.writeFileSync(cfgPath, JSON.stringify({ billfishLibrary: lib, boards: [{ name: BOARD, url: 'https://www.pinterest.com/u/b/', dest }] }));
const script = path.join(__dirname, '..', 'sync', 'billfish-tag.js');
const run = (...extra) => spawnSync(process.execPath, [script, '--config', cfgPath, '--db', dbPath, ...extra], { encoding: 'utf8' });
const counts = () => {
  const d = new DatabaseSync(dbPath, { readOnly: true });
  const r = {
    users: d.prepare('select count(*) c from bf_material_userdata').get().c,
    tags: d.prepare('select count(*) c from bf_tag_v2').get().c,
    links: d.prepare('select count(*) c from bf_tag_join_file').get().c,
  };
  d.close();
  return r;
};

// 0. 文件名 → Pin 编号
const { pinIdOf } = require(script);
check('编号：pinterest_数字', pinIdOf('pinterest_907616131211275519.jpg') === '907616131211275519');
check('编号：多图取下划线前', pinIdOf('pinterest_907616131211275519_3.png') === '907616131211275519');
check('编号：e1_ 长编号整段都是', pinIdOf('pinterest_e1_AfqPShw6ls2kNmqQQO8rWFLDBDTpfTI4_J5Ui-OkJ_ppU1CulscH.jpg') === 'e1_AfqPShw6ls2kNmqQQO8rWFLDBDTpfTI4_J5Ui-OkJ_ppU1CulscH');
check('编号：普通文件名不是', pinIdOf('封面草图.jpg') === '' && pinIdOf('pinterest_notes.txt') === '' && pinIdOf('IMG_2024.jpg') === '');

// 1. 预览不写
let r = run('--dry-run');
check('预览：退出码 3（有没扫描到的文件）', r.status === 3, r.status + ' ' + r.stderr);
check('预览：报告写来源 4 个', /写来源 4 个（已有来源保留 1 个）/.test(r.stdout), r.stdout);
check('预览：数据库没变', JSON.stringify(counts()) === JSON.stringify(setup), counts());

// 2. 真写
r = run();
check('写入：退出码 3', r.status === 3, r.status + ' ' + r.stderr);
check('写入：报告没扫描到 散图 那张', /还没扫描到 1 个：散图/.test(r.stdout), r.stdout);
check('写入：报告跳过 封面草图', /跳过 1 个：竹林.封面草图\.jpg/.test(r.stdout), r.stdout);
db = new DatabaseSync(dbPath, { readOnly: true });
const origin = id => (db.prepare('select origin from bf_material_userdata where file_id = ?').get(id) || {}).origin;
const user = id => db.prepare('select * from bf_material_userdata where file_id = ?').get(id);
const tagsOf = id => db.prepare('select t.name, t.pid from bf_tag_join_file j join bf_tag_v2 t on t.id = j.tag_id where j.file_id = ? order by t.id').all(id).map(t => t.name);
const boardTag = db.prepare('select * from bf_tag_v2 where name = ?').get(BOARD);
check('收藏夹标签建在顶层', boardTag && boardTag.pid === 0, boardTag);
check('收藏夹标签排在顶层最后', boardTag && boardTag.seq > db.prepare('select max(seq) m from bf_tag_v2 where pid = 0 and id <> ?').get(boardTag.id).m, boardTag);
const secTag = db.prepare("select * from bf_tag_v2 where name = '石桥'").get();
check('分区标签挂在收藏夹标签下', secTag && secTag.pid === boardTag.id, secTag);
check('重名分区写成 收藏夹/分区', !!db.prepare('select 1 x from bf_tag_v2 where name = ? and pid = ?').get(BOARD + '/竹林', boardTag.id));
check('别处的 竹林 标签还是一个', db.prepare("select count(*) c from bf_tag_v2 where name = '竹林'").get().c === 1);
check('没分区的图：来源', origin(ids.loose) === 'https://www.pinterest.com/pin/111111111111111111/', origin(ids.loose));
check('没分区的图：只有收藏夹标签', JSON.stringify(tagsOf(ids.loose)) === JSON.stringify([BOARD]), tagsOf(ids.loose));
check('分区里的图：两个标签', JSON.stringify(tagsOf(ids.b1)) === JSON.stringify([BOARD, '石桥']), tagsOf(ids.b1));
check('多图 Pin：编号取下划线前', origin(ids.b2) === 'https://www.pinterest.com/pin/333333333333333333/', origin(ids.b2));
check('已有来源不改', origin(ids.b3) === 'https://example.com/mine', origin(ids.b3));
check('已有来源的图：备注评分不动', user(ids.b3).note === '手写备注' && user(ids.b3).score === 4, user(ids.b3));
check('已有来源的图：照样加标签', tagsOf(ids.b3).length === 2, tagsOf(ids.b3));
check('只有备注的图：补来源、备注评分不动', origin(ids.b1) === 'https://www.pinterest.com/pin/222222222222222222/' && user(ids.b1).note === '只有备注' && user(ids.b1).score === 3, user(ids.b1));
check('重名分区的图：标签', JSON.stringify(tagsOf(ids.bamboo)) === JSON.stringify([BOARD, BOARD + '/竹林']), tagsOf(ids.bamboo));
check('非 Pin 文件名：不写来源不加标签', !user(ids.sketch) && tagsOf(ids.sketch).length === 0);
check('下载记录文件：不动', !user(ids.archive) && tagsOf(ids.archive).length === 0);
const newUser = user(ids.loose);
check('新建的 userdata 行和 Billfish 自己的默认值一样', newUser.comments_summary === '' && newUser.comments_count === 0 && newUser.note === '' && newUser.score === 0 && newUser.cover_tid === '0', newUser);
db.close();
const after = counts();
check('新增行数：userdata 3、标签 3、关联 9', after.users - setup.users === 3 && after.tags - setup.tags === 3 && after.links - setup.links === 9, { setup, after });

// 3. 再跑一次不重复
r = run();
check('重跑：什么都不新增', JSON.stringify(counts()) === JSON.stringify(after), counts());
check('重跑：报告写来源 0 个、标签 0 条', /写来源 0 个（已有来源保留 5 个），加标签关联 0 条/.test(r.stdout), r.stdout);

// 4. 给了真实副本时：原有数据一条没少
if (baseDb) {
  const a = new DatabaseSync(baseDb, { readOnly: true });
  const b = new DatabaseSync(dbPath, { readOnly: true });
  const dump = (d, sql) => JSON.stringify(d.prepare(sql).all());
  check('原有 userdata 没变', dump(a, 'select * from bf_material_userdata order by id') === dump(b, `select * from bf_material_userdata where id <= ${a.prepare('select max(id) m from bf_material_userdata').get().m} order by id`));
  check('原有标签没变', dump(a, 'select * from bf_tag_v2 order by id') === dump(b, `select * from bf_tag_v2 where id <= ${a.prepare('select max(id) m from bf_tag_v2').get().m} order by id`));
  check('原有标签关联没变', dump(a, 'select * from bf_tag_join_file order by id') === dump(b, `select * from bf_tag_join_file where id <= ${a.prepare('select max(id) m from bf_tag_join_file').get().m} order by id`));
  check('原有文件没变', dump(a, 'select * from bf_file order by id') === dump(b, `select * from bf_file where id <= ${a.prepare('select max(id) m from bf_file').get().m} order by id`));
  check('integrity_check', b.prepare('pragma integrity_check').get().integrity_check === 'ok');
  a.close(); b.close();
  console.log('（基于真实副本：原有 userdata ' + before.users + '、标签 ' + before.tags + '、关联 ' + before.links + '）');
}

fs.rmSync(root, { recursive: true, force: true });
console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
