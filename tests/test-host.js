// host\pbl-host.js 的测试：真的把它当 Native Messaging 程序启动（4 字节长度 + JSON），
// 下载用 tests\fake-download.js 代替，Billfish 用一个临时数据库 + 一个假进程代替。
// 用法：node tests\test-host.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

let failed = 0;
const check = (name, cond, extra) => {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (cond ? '' : '   ' + (extra === undefined ? '' : JSON.stringify(extra))));
  if (!cond) failed++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plk-host-'));
const lib = path.join(root, 'lib');
const dest = path.join(lib, '参考', '水墨测试');
const dbPath = path.join(root, 'test.db');
const cfgPath = path.join(root, 'config.json');
const cfg = {
  sheetsDir: path.join(root, 'sheets'),
  defaultRoot: path.join(lib, '参考'),
  boardsFile: path.join(root, 'boards.json'),
  statusFile: path.join(root, 'last-run.json'),
  backupDir: path.join(root, 'backups'),
  downloadCmd: [process.execPath, path.join(__dirname, 'fake-download.js'), '-Config', path.join(root, 'boards.json')],
  billfishExe: '',
  billfishProcess: 'pbl-no-such-app.exe',
  writeWhileBillfishOpen: false,
  scanTimeoutSec: 20, closeTimeoutSec: 20, pollMs: 150,
  dbPath, billfishLibrary: lib,
};
fs.mkdirSync(lib, { recursive: true });
fs.mkdirSync(cfg.sheetsDir, { recursive: true });
fs.writeFileSync(cfgPath, JSON.stringify(cfg));

// 临时数据库：只建打标签要用的几张表
let db = new DatabaseSync(dbPath);
db.exec(`
CREATE TABLE bf_file (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, pid INTEGER NOT NULL, is_hide INTEGER, is_link INTEGER, file_size INTEGER, ctime INTEGER, mtime INTEGER, md5 TEXT, tid INTEGER, born INTEGER, ttid INTEGER);
CREATE TABLE bf_folder (id INTEGER PRIMARY KEY AUTOINCREMENT, born INTEGER, pid INTEGER NOT NULL, name TEXT, desc TEXT, cover_tid INTEGER, hide INTEGER, seq REAL, color INTEGER, is_recycle INTEGER);
CREATE TABLE bf_material_userdata (id INTEGER PRIMARY KEY AUTOINCREMENT, file_id INTEGER NOT NULL, comments_summary TEXT, comments_count INTEGER, comments_detail TEXT, note TEXT, origin TEXT, score INTEGER, rotation INTEGER, hflip INTEGER, vflip INTEGER, cover_tid TEXT, unique(file_id) on conflict replace);
CREATE TABLE bf_tag_v2(id integer primary key autoincrement,name text,pid integer,seq real,icon integer,color integer,born integer);
CREATE TABLE bf_tag_join_file(id integer primary key autoincrement, file_id integer, tag_id integer, born integer,unique(file_id, tag_id) on conflict ignore);
`);
db.close();

// 假装 Billfish 扫描：把磁盘上有、数据库里没有的文件和文件夹补进数据库
function fakeBillfishScan() {
  const d = new DatabaseSync(dbPath);
  const folderId = (name, pid) => {
    const hit = d.prepare('select id from bf_folder where pid = ? and name = ?').get(pid, name);
    return hit ? hit.id : Number(d.prepare("insert into bf_folder (born, pid, name, desc, cover_tid, hide, seq, color, is_recycle) values (1, ?, ?, '', 0, 0, 0.5, 0, 0)").run(pid, name).lastInsertRowid);
  };
  const walk = (dir, pid) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '.bf') continue;
      if (e.isDirectory()) walk(path.join(dir, e.name), folderId(e.name, pid));
      else if (!d.prepare('select 1 x from bf_file where pid = ? and name = ?').get(pid, e.name)) {
        d.prepare("insert into bf_file (name, pid, is_hide, is_link, file_size, ctime, mtime, md5, tid, born, ttid) values (?, ?, 0, 0, 1, 1, 1, '', 20, 1, 0)").run(e.name, pid);
      }
    }
  };
  walk(lib, 0);
  d.close();
}

// 和小程序说话
function startHost() {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'host', 'pbl-host.js'), 'chrome-extension://test/'], { env: Object.assign({}, process.env, { PBL_HOST_CONFIG: cfgPath }), stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = Buffer.alloc(0);
  const waiters = new Map();
  const events = [];
  let seq = 0;
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  child.stdout.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32LE(0)) {
      const len = buf.readUInt32LE(0);
      const m = JSON.parse(buf.slice(4, 4 + len).toString('utf8'));
      buf = buf.slice(4 + len);
      if (m.event) events.push(m);
      else if (waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); }
    }
  });
  const call = (cmd, extra) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => reject(new Error(cmd + ' 没有回应。stderr: ' + stderr)), 8000);
    waiters.set(id, (m) => { clearTimeout(timer); resolve(m); });
    const body = Buffer.from(JSON.stringify(Object.assign({ id, cmd }, extra)), 'utf8');
    const head = Buffer.alloc(4);
    head.writeUInt32LE(body.length, 0);
    child.stdin.write(Buffer.concat([head, body]));
  });
  const exited = new Promise((r) => child.on('exit', r));
  return { call, events, close: () => { child.stdin.end(); return exited; }, stderr: () => stderr };
}

const status = () => { try { return JSON.parse(fs.readFileSync(cfg.statusFile, 'utf8')); } catch (e) { return {}; } };
const stepOf = (s, key) => (s.steps || []).find((x) => x.key === key) || {};
async function until(fn, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 15000)) { if (fn()) return true; await sleep(80); }
  return false;
}

(async () => {
  let host = startHost();
  try {
    // A. 打招呼、调研单文件夹
    let r = await host.call('hello');
    check('A hello：版本和两个目录', r.ok && /^\d+\.\d+\.\d+$/.test(r.version) && r.sheetsDir === cfg.sheetsDir && r.defaultRoot === cfg.defaultRoot && r.status.state === 'idle', r);
    r = await host.call('sheets.list');
    check('A 空文件夹 → 0 份', r.ok && r.sheets.length === 0 && r.errors.length === 0, r);
    const sheet = { title: '水墨 测试/一', board: '风格调研-水墨感', groups: [{ name: '笔触', keywords: ['sumi-e brush strokes'] }] };
    r = await host.call('sheets.save', { sheet, base: '水墨 测试/一' });
    check('A 存一份：文件名里的 / 被换掉', r.ok && r.file === '水墨 测试 一.json' && r.unchanged === false && fs.existsSync(path.join(cfg.sheetsDir, r.file)), r);
    r = await host.call('sheets.save', { sheet, base: '水墨 测试/一' });
    check('A 内容一样再存 → 不重写', r.ok && r.unchanged === true, r);
    fs.writeFileSync(path.join(cfg.sheetsDir, '坏的.json'), '{ 这不是 JSON');
    fs.writeFileSync(path.join(cfg.sheetsDir, '说明.md'), '不是调研单');
    r = await host.call('sheets.list');
    check('A 列出来：1 份好的 + 1 个报错，.md 不算', r.ok && r.sheets.length === 1 && r.sheets[0].data.board === '风格调研-水墨感' && r.errors.length === 1 && r.errors[0].file === '坏的.json', r);
    r = await host.call('nope');
    check('A 不认识的命令 → 报错不崩', r.ok === false && /不认识/.test(r.error), r);

    // B. 同步：参数不对
    r = await host.call('sync.run', { name: '风格调研-水墨感', url: 'https://example.com/a/b/', dest });
    check('B 开始了（检查在同步进程里做）', r.ok && r.started, r);
    check('B 链接不是 Pinterest → 报错', await until(() => status().state === 'error') && /收藏夹链接不对/.test(status().error), status());

    // C. 同步：Billfish 没开 → 等收录 → 写
    const url = 'https://www.pinterest.com/someone/%E9%A3%8E%E6%A0%BC/';
    r = await host.call('sync.run', { name: '风格调研-水墨感', title: '水墨测试', url, dest });
    check('C 开始', r.ok && r.started, r);
    check('C 下载完成', await until(() => stepOf(status(), 'download').state === 'ok'), status());
    check('C 下载结果写清楚', /新增 2 张，共 2 张/.test(stepOf(status(), 'download').text), stepOf(status(), 'download'));
    const boards = JSON.parse(fs.readFileSync(cfg.boardsFile, 'utf8'));
    check('C 收藏夹登记进 boards.json', boards.boards.length === 1 && boards.boards[0].name === '风格调研-水墨感' && boards.boards[0].url === url && boards.boards[0].dest === dest, boards);
    check('C Billfish 没开 → 停在“等收录”并提示打开', await until(() => stepOf(status(), 'scan').state === 'wait') && /请打开 Billfish/.test(stepOf(status(), 'scan').text) && /0 \/ 2/.test(stepOf(status(), 'scan').text), stepOf(status(), 'scan'));
    r = await host.call('sync.run', { name: '风格调研-水墨感', url, dest });
    check('C 同步途中再点 → 拒绝', r.ok === false && /正在同步/.test(r.error), r);
    check('C 进度有推给插件', await until(() => host.events.some((e) => e.event === 'sync' && e.status.state === 'running' && e.status.steps[0].state === 'ok'), 3000), host.events.length);
    fakeBillfishScan();
    check('C 收录后自动写完', await until(() => status().state === 'done'), status());
    let s = status();
    check('C 结果：2 个来源、3 条标签、2 个新标签', s.summary.originSet === 2 && s.summary.tagLinks === 3 && s.summary.newTags.join('|') === '风格调研-水墨感|笔触' && s.summary.added === 2, s.summary);
    db = new DatabaseSync(dbPath, { readOnly: true });
    const origins = db.prepare('select origin from bf_material_userdata order by id').all().map((x) => x.origin);
    check('C 数据库里真有来源', origins.length === 2 && origins.every((o) => /^https:\/\/www\.pinterest\.com\/pin\/[^/]+\/$/.test(o)), origins);
    db.close();

    // D. 侧边栏关了（小程序退出）再开：还能问到上次的结果
    await host.close();
    host = startHost();
    r = await host.call('sync.status');
    check('D 重连后能读到上次的结果', r.ok && r.status.state === 'done' && r.status.summary.originSet === 2, r);

    // E. Billfish 开着（用一个 ping 进程冒充）→ 提示关掉 → 关掉后自动继续
    fs.writeFileSync(cfgPath, JSON.stringify(Object.assign({}, cfg, { billfishProcess: 'PING.EXE' })));
    await host.close();
    host = startHost();
    const ping = spawn('ping', ['-n', '60', '127.0.0.1'], { stdio: 'ignore' });
    await sleep(300);
    r = await host.call('sync.run', { name: '风格调研-水墨感', url, dest, tag: '水墨标签' });
    check('E 开始', r.ok && r.started, r);
    await until(() => stepOf(status(), 'scan').state === 'run' || stepOf(status(), 'scan').state === 'wait');
    fakeBillfishScan();
    check('E Billfish 开着 → 停在“写”并提示关掉', await until(() => stepOf(status(), 'write').state === 'wait') && /请关掉 Billfish/.test(stepOf(status(), 'write').text), status());
    db = new DatabaseSync(dbPath, { readOnly: true });
    check('E 没关之前不写', db.prepare('select count(*) c from bf_material_userdata').get().c === 2);
    db.close();
    ping.kill();
    check('E 关掉后自动写完', await until(() => status().state === 'done'), status());
    s = status();
    check('E 结果：只补新来的 2 张；标签名用调研单指定的', s.summary.added === 2 && s.summary.total === 4 && s.summary.originSet === 2 && s.summary.newTags[0] === '水墨标签', s.summary);

    // F. 什么都没变再点一次：不重复写
    const noop = path.join(root, 'fake-nothing-new.js');
    fs.writeFileSync(noop, `console.log('##PBL ' + JSON.stringify({ name: 'x', before: 4, total: 4, dups: 0, code: 0 }));`);
    fs.writeFileSync(cfgPath, JSON.stringify(Object.assign({}, cfg, { downloadCmd: [process.execPath, noop] })));
    await host.close();
    host = startHost();
    r = await host.call('sync.run', { name: '风格调研-水墨感', url, dest, tag: '水墨标签' });
    check('F 没有新图 → 直接完成，不写', await until(() => status().state === 'done') && status().summary.originSet === 0 && /没有新的要写/.test(stepOf(status(), 'write').text), status());

    // G. 配置成“Billfish 开着也直接写”：不停下来等关
    fs.writeFileSync(cfgPath, JSON.stringify(Object.assign({}, cfg, { billfishProcess: 'PING.EXE', writeWhileBillfishOpen: true })));
    await host.close();
    host = startHost();
    const ping2 = spawn('ping', ['-n', '60', '127.0.0.1'], { stdio: 'ignore' });
    await sleep(300);
    r = await host.call('hello');
    check('G hello 报告开着也写', r.ok && r.writeWhileBillfishOpen === true, r);
    r = await host.call('sync.run', { name: '风格调研-水墨感', url, dest, tag: '水墨标签' });
    await until(() => status().state === 'running' && (stepOf(status(), 'scan').state === 'run' || stepOf(status(), 'scan').state === 'wait'));
    fakeBillfishScan();
    const doneLive = await until(() => status().state === 'done' || status().state === 'error');
    const pingAlive = ping2.exitCode === null;
    ping2.kill();
    s = status();
    check('G Billfish 开着 → 不等关，直接写完', doneLive && s.state === 'done' && pingAlive && s.summary.originSet === 2 && s.summary.liveWrite === true && s.summary.reopened === false, s);
    check('G 结果里提醒“没看到就关开一次”', /关开一次/.test(stepOf(s, 'write').text), stepOf(s, 'write'));

    // H. 不用 Billfish（billfish: false）：只下载，后两步跳过，数据库不动
    db = new DatabaseSync(dbPath, { readOnly: true });
    const originsBefore = db.prepare('select count(*) c from bf_material_userdata').get().c;
    db.close();
    fs.writeFileSync(cfgPath, JSON.stringify(Object.assign({}, cfg, { billfish: false })));
    await host.close();
    host = startHost();
    r = await host.call('hello');
    check('H hello 报告不用 Billfish', r.ok && r.billfish === false, r);
    r = await host.call('sync.run', { name: '风格调研-水墨感', url, dest });
    check('H 只下载就完成', await until(() => status().state === 'done' || status().state === 'error') && status().state === 'done', status());
    s = status();
    check('H 后两步标成跳过', stepOf(s, 'scan').state === 'skip' && stepOf(s, 'write').state === 'skip' && s.summary.billfish === false && s.summary.added === 2, s);
    db = new DatabaseSync(dbPath, { readOnly: true });
    check('H 数据库没动', db.prepare('select count(*) c from bf_material_userdata').get().c === originsBefore);
    db.close();

    // I. 默认 auto：目标文件夹不在任何 Billfish 库里 → 只下载
    const plain = path.join(root, 'plain', '水墨');
    fs.writeFileSync(cfgPath, JSON.stringify(Object.assign({}, cfg, { billfishLibrary: '', dbPath: '' })));
    await host.close();
    host = startHost();
    r = await host.call('hello');
    check('I hello 默认算用 Billfish', r.ok && r.billfish === true, r);
    r = await host.call('sync.run', { name: '风格调研-水墨感', url, dest: plain });
    check('I 不在库里 → 只下载就完成', await until(() => status().state === 'done' || status().state === 'error') && status().state === 'done' && status().summary.billfish === false, status());
    check('I 图下载到了', fs.existsSync(path.join(plain, '笔触')), plain);

    // J. billfish: true 而目标文件夹不在库里 → 报错
    fs.writeFileSync(cfgPath, JSON.stringify(Object.assign({}, cfg, { billfishLibrary: '', dbPath: '', billfish: true })));
    await host.close();
    host = startHost();
    r = await host.call('sync.run', { name: '风格调研-水墨感', url, dest: plain });
    check('J 必须写 Billfish 但不在库里 → 报错', await until(() => status().state === 'error') && /不在 Billfish 的库里/.test(status().error), status());
  } catch (e) {
    failed++;
    console.log('FAIL  测试中断：' + (e && e.stack || e));
  }
  await host.close();
  await sleep(300);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  console.log(failed ? '\n' + failed + ' 项失败' : '\n全部通过');
  process.exit(failed ? 1 : 0);
})();
