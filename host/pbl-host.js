// PinBoardLock — 本机小程序（Chrome 的 Native Messaging host）。
// 插件自己读不了文件夹、也跑不了下载和写 Billfish，这些事由它代做：
//   hello          报告版本、调研单文件夹、默认下载根目录
//   sheets.list    读调研单文件夹里的 *.json
//   sheets.save    把一份调研单存成文件
//   sync.run       一键同步：下载收藏夹 → 等 Billfish 收录 → 写来源和标签（目标文件夹不在 Billfish 库里时只下载）
//   sync.status    上一次（或正在跑的）同步进行到哪了
//
// 同步是另起一个不依附浏览器的进程去跑的（node pbl-host.js --job <请求文件>），进度写在 sync\last-run.json；
// 这个进程只负责把进度转给插件。所以同步途中关掉侧边栏、甚至关掉浏览器，同步也会跑完。
//
// 和 Chrome 之间的消息格式：4 字节长度（小端）+ JSON，走 stdin / stdout。所以这里绝对不能用 console.log。
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const VERSION = '0.5.0';
const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = process.env.PBL_HOST_CONFIG || path.join(__dirname, 'config.json');

function loadConfig() {
  let user = {};
  try { user = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^﻿/, '')); } catch (e) { /* 没有配置就全用默认 */ }
  const cfg = Object.assign({
    sheetsDir: path.join(ROOT, 'sheets'),
    defaultRoot: '',                       // 调研单没写 folder 时，下载到 默认根目录\调研单标题
    boardsFile: path.join(ROOT, 'sync', 'boards.json'),
    statusFile: path.join(ROOT, 'sync', 'last-run.json'),
    backupDir: path.join(ROOT, 'sync', 'backups'),
    pwsh: 'pwsh',
    galleryDl: '',                         // 空 = 用 boards.json 里的，再没有就找 PATH 里的 gallery-dl
    billfish: 'auto',                      // auto = 目标文件夹在 Billfish 库里才写；false = 只下载；true = 必须写进 Billfish
    downloadCmd: null,                     // 默认：pwsh -NoProfile -File sync\Sync-PinterestBoards.ps1
    billfishExe: '',
    billfishProcess: 'Billfish.exe',
    writeWhileBillfishOpen: false,         // Billfish 开着时直接写库（2026-11-24 实测：开着写的标签重启后还在）。false = 写之前等用户关掉它
    scanTimeoutSec: 300,
    closeTimeoutSec: 900,
    pollMs: 2000,
    dbPath: '',                            // 测试用：写到别的数据库
    billfishLibrary: '',                   // 测试用：指定库根
  }, user);
  if (!cfg.downloadCmd) {
    cfg.downloadCmd = [cfg.pwsh, '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'sync', 'Sync-PinterestBoards.ps1'), '-Config', cfg.boardsFile];
    if (cfg.galleryDl) cfg.downloadCmd.push('-GalleryDl', cfg.galleryDl);
  }
  return cfg;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch (e) { return fallback; } };
function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

function processRunning(imageName) {
  if (!imageName) return false;
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq ' + imageName, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
    return out.toLowerCase().indexOf(imageName.toLowerCase()) !== -1;
  } catch (e) { return false; }
}

// ───────── 调研单文件夹 ─────────
function listSheets(cfg) {
  const out = { dir: cfg.sheetsDir, sheets: [], errors: [] };
  let names = [];
  try { names = fs.readdirSync(cfg.sheetsDir); } catch (e) { out.errors.push({ file: '', error: '读不了调研单文件夹：' + e.message }); return out; }
  for (const name of names.sort()) {
    if (!/\.json$/i.test(name)) continue;
    const file = path.join(cfg.sheetsDir, name);
    try {
      const st = fs.statSync(file);
      if (!st.isFile() || st.size > 512 * 1024) continue;
      out.sheets.push({ file: name, mtime: Math.round(st.mtimeMs), data: JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) });
    } catch (e) { out.errors.push({ file: name, error: e.message }); }
  }
  return out;
}

function saveSheet(cfg, msg) {
  if (!msg.sheet || typeof msg.sheet !== 'object') throw new Error('没有调研单内容');
  const base = String(msg.base || msg.sheet.title || msg.sheet.board || 'sheet').replace(/[\\/:*?"<>|\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').replace(/[. ]+$/, '').trim().slice(0, 80) || 'sheet';
  const file = path.join(cfg.sheetsDir, base + '.json');
  const text = JSON.stringify(msg.sheet, null, 2) + '\n';
  fs.mkdirSync(cfg.sheetsDir, { recursive: true });
  let old = null;
  try { old = fs.readFileSync(file, 'utf8'); } catch (e) { /* 新文件 */ }
  if (old === text) return { file: base + '.json', unchanged: true };
  fs.writeFileSync(file, text);
  return { file: base + '.json', unchanged: false, replaced: old !== null };
}

// ───────── 同步状态 ─────────
const STEPS = [['download', '下载新图'], ['scan', '等 Billfish 收录'], ['write', '写来源和标签']];

function readStatus(cfg) {
  const s = readJson(cfg.statusFile, null);
  if (!s) return { state: 'idle' };
  if (s.state === 'running' && !(s.pid && pidAlive(s.pid))) {
    s.state = 'error';
    s.error = '上次同步中途断了（进程不在了）。再点一次“下载 + 同步”会接着做，已经下载的不会重下。';
  }
  return s;
}

// ───────── 同步本体（--job 进程里跑） ─────────
async function runJob(cfg, req) {
  const tag = require(path.join(ROOT, 'sync', 'billfish-tag.js'));
  const status = {
    state: 'running', pid: process.pid, name: req.name, title: req.title || req.name, dest: req.dest,
    startedAt: Date.now(), updatedAt: Date.now(), error: '', summary: null,
    steps: STEPS.map(([key, label]) => ({ key, label, state: 'todo', text: '' })),
  };
  const save = () => { status.updatedAt = Date.now(); writeJsonAtomic(cfg.statusFile, status); };
  const step = (key, state, text) => {
    const s = status.steps.find((x) => x.key === key);
    if (state) s.state = state;
    if (text !== undefined) s.text = text;
    save();
  };
  const fail = (key, text) => { if (key) step(key, 'err', text); status.state = 'error'; status.error = text; save(); };
  save();

  try {
    // 0. 检查 + 登记到 boards.json
    if (!req.name) return fail('download', '没有收藏夹名');
    if (!/^https:\/\/([a-z0-9-]+\.)*pinterest\.[a-z.]+\/[^/]+\/[^/]+\/?$/i.test(req.url || '')) return fail('download', '收藏夹链接不对：' + (req.url || '（空）') + '。先在 Pinterest 页面的面板里点一下“刷新”。');
    if (!req.dest || !path.isAbsolute(req.dest)) return fail('download', '目标文件夹要写完整路径：' + (req.dest || '（空）'));
    const dest = path.resolve(req.dest);
    const libRoot = cfg.billfish === false ? '' : (cfg.billfishLibrary || tag.findLibraryRoot(dest));
    if (!libRoot && cfg.billfish === true) return fail('download', '目标文件夹不在 Billfish 的库里：' + dest + '。不用 Billfish 的话，把 host\\config.json 的 billfish 改成 false。');
    const boards = readJson(cfg.boardsFile, null) || { galleryDl: '', cookies: '', boards: [] };
    if (!Array.isArray(boards.boards)) boards.boards = [];
    let b = boards.boards.find((x) => x && x.name === req.name);
    if (!b) { b = { name: req.name }; boards.boards.push(b); }
    b.url = req.url;
    b.dest = dest;
    if (req.tag) b.tag = req.tag; else delete b.tag;
    writeJsonAtomic(cfg.boardsFile, boards);

    // 1. 下载
    step('download', 'run', '正在连 Pinterest…');
    const dl = await new Promise((resolve) => {
      const args = cfg.downloadCmd.slice(1).concat(['-Name', req.name]);
      const child = spawn(cfg.downloadCmd[0], args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let buf = '';
      let n = 0;
      let info = null;
      const tail = [];
      let lastSave = 0;
      const onLine = (line) => {
        line = line.replace(/\r$/, '');
        if (!line.trim()) return;
        if (line.indexOf('##PBL ') === 0) { try { info = JSON.parse(line.slice(6)); } catch (e) { /* ignore */ } return; }
        tail.push(line);
        if (tail.length > 12) tail.shift();
        if (/\.(jpe?g|png|gif|webp|avif|bmp)\s*$/i.test(line) && line.trim()[0] !== '#') {
          n++;
          if (Date.now() - lastSave > 700) { lastSave = Date.now(); step('download', 'run', '已下载 ' + n + ' 张…'); }
        }
      };
      const feed = (chunk) => {
        buf += chunk.toString('utf8');
        let i;
        while ((i = buf.indexOf('\n')) !== -1) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); }
      };
      child.stdout.on('data', feed);
      child.stderr.on('data', feed);
      child.on('error', (e) => resolve({ code: -1, info: null, tail: ['启动下载脚本失败：' + e.message] }));
      child.on('close', (code) => { if (buf) onLine(buf); resolve({ code, info, tail }); });
    });
    if (!dl.info) return fail('download', '下载没跑起来：' + (dl.tail.slice(-3).join(' / ') || '退出码 ' + dl.code));
    const added = Math.max(0, dl.info.total - dl.info.before);
    const warnings = [];
    if (dl.info.code !== 0) warnings.push('有个别图没下载下来（gallery-dl 退出码 ' + dl.info.code + '）');
    step('download', 'ok', '新增 ' + added + ' 张，共 ' + dl.info.total + ' 张' + (dl.info.dups ? '（去掉和分区重复的 ' + dl.info.dups + ' 张）' : ''));
    if (!libRoot) {
      // 不用 Billfish：下载完就结束
      const why = cfg.billfish === false ? '没开 Billfish 同步' : '目标文件夹不在 Billfish 库里';
      step('scan', 'skip', why + '，跳过');
      step('write', 'skip', why + '，跳过');
      status.state = 'done';
      status.summary = { added, total: dl.info.total, dups: dl.info.dups || 0, originSet: 0, tagLinks: 0, newTags: [], backup: '', warnings, billfish: false };
      return save();
    }
    if (!dl.info.total) {
      step('scan', 'ok', '没有图');
      step('write', 'ok', '没有图');
      status.state = 'done';
      status.summary = { added: 0, total: 0, dups: 0, originSet: 0, tagLinks: 0, newTags: [], backup: '', warnings: ['收藏夹里还没有图。'] };
      return save();
    }

    // 2. 等 Billfish 把新图收录进数据库
    const board = { name: req.name, dest, tag: req.tag || undefined };
    const preview = () => tag.run({ boards: [board], billfishLibrary: libRoot, dryRun: true, db: cfg.dbPath || undefined }).results[0];
    step('scan', 'run', '');
    let s = preview();
    let started = false;
    let lastLeft = -1;
    let lastChange = Date.now();
    while (s.notScanned.length) {
      const left = s.notScanned.length;
      if (left !== lastLeft) { lastLeft = left; lastChange = Date.now(); }
      const running = processRunning(cfg.billfishProcess);
      let text = 'Billfish 已收录 ' + (s.onDisk - left) + ' / ' + s.onDisk;
      if (!running) {
        if (!started && cfg.billfishExe && fs.existsSync(cfg.billfishExe)) {
          started = true;
          try { spawn(cfg.billfishExe, [], { detached: true, stdio: 'ignore', cwd: path.dirname(cfg.billfishExe) }).unref(); } catch (e) { /* 下面会提示手动开 */ }
          text += '。Billfish 没开，已经帮你打开了';
        } else if (!started) {
          text += '。请打开 Billfish，让它把新图扫进去';
        }
      }
      step('scan', running ? 'run' : 'wait', text);
      if (Date.now() - lastChange > cfg.scanTimeoutSec * 1000) {
        return fail('scan', '等了 ' + Math.round(cfg.scanTimeoutSec / 60) + ' 分钟，Billfish 还有 ' + left + ' 张没收录。确认 Billfish 开着、打开的是这个库，过一会儿再点一次，已经下载的不会重下。');
      }
      await sleep(cfg.pollMs);
      s = preview();
    }
    step('scan', 'ok', 'Billfish 已收录 ' + s.onDisk + ' / ' + s.onDisk);

    // 3. 写来源和标签
    let result = null;
    let reopened = false;
    let liveWrite = false;
    if (!s.originSet && !s.tagLinks) {
      step('write', 'ok', '都已经写过了，没有新的要写');
      result = { backup: '', results: [s] };
    } else {
      let userClosed = false;
      const t0 = Date.now();
      for (;;) {
        if (!cfg.writeWhileBillfishOpen && processRunning(cfg.billfishProcess)) {
          userClosed = true;
          step('write', 'wait', '要写 ' + s.originSet + ' 个来源、' + s.tagLinks + ' 条标签。请关掉 Billfish（关窗口就行），关掉后自动继续');
          if (Date.now() - t0 > cfg.closeTimeoutSec * 1000) return fail('write', '等了 ' + Math.round(cfg.closeTimeoutSec / 60) + ' 分钟 Billfish 还开着，先停下。关掉 Billfish 后再点一次，只会补写这一步。');
          await sleep(cfg.pollMs);
          continue;
        }
        step('write', 'run', '正在写…');
        const openNow = processRunning(cfg.billfishProcess);
        const r = tag.run({ boards: [board], billfishLibrary: libRoot, dryRun: false, db: cfg.dbPath || undefined, allowRunning: !!cfg.writeWhileBillfishOpen, backupDir: cfg.backupDir });
        if (!r.ok && r.reason === 'billfish-running') { await sleep(cfg.pollMs); continue; }
        if (!r.ok) return fail('write', r.message || '写入失败');
        result = r;
        liveWrite = openNow;
        break;
      }
      const w = result.results[0];
      if (userClosed && cfg.billfishExe && fs.existsSync(cfg.billfishExe)) {
        try { spawn(cfg.billfishExe, [], { detached: true, stdio: 'ignore', cwd: path.dirname(cfg.billfishExe) }).unref(); reopened = true; } catch (e) { /* ignore */ }
      }
      step('write', 'ok', '写了 ' + w.originSet + ' 个来源、' + w.tagLinks + ' 条标签' + (w.newTags.length ? '，新建标签：' + w.newTags.join('、') : '') + (reopened ? '。Billfish 已重新打开' : '') + (liveWrite ? '。Billfish 开着时写的：标签栏里没看到新标签的话，把 Billfish 关开一次' : ''));
    }
    const w = result.results[0];
    if (w.noPinId.length) warnings.push(w.noPinId.length + ' 个文件的名字不是 Pin 编号，没写来源');
    status.state = 'done';
    status.summary = {
      added, total: dl.info.total, dups: dl.info.dups || 0, originSet: w.originSet, tagLinks: w.tagLinks, newTags: w.newTags,
      backup: result.backup || '', warnings, reopened, liveWrite, billfish: true,
    };
    save();
  } catch (e) {
    fail('', '同步出错：' + (e && e.message || e));
  }
}

// ───────── 和 Chrome 说话 ─────────
function serve(cfg) {
  let alive = true;
  const send = (obj) => {
    if (!alive) return;
    try {
      const body = Buffer.from(JSON.stringify(obj), 'utf8');
      const head = Buffer.alloc(4);
      head.writeUInt32LE(body.length, 0);
      process.stdout.write(Buffer.concat([head, body]));
    } catch (e) { alive = false; }
  };
  process.stdout.on('error', () => { alive = false; });

  // 同步进度：盯着状态文件，变了就推给插件
  let lastSeen = 0;
  const pushStatus = () => {
    const s = readStatus(cfg);
    const stamp = (s.updatedAt || 0) + (s.state === 'error' ? 1 : 0);
    if (stamp !== lastSeen) { lastSeen = stamp; send({ event: 'sync', status: s }); }
  };
  const watcher = setInterval(pushStatus, 300);

  const handle = (msg) => {
    const id = msg && msg.id;
    try {
      if (!msg || typeof msg.cmd !== 'string') throw new Error('消息里没有 cmd');
      if (msg.cmd === 'hello') {
        send({ id, ok: true, version: VERSION, sheetsDir: cfg.sheetsDir, defaultRoot: cfg.defaultRoot, billfish: cfg.billfish !== false, writeWhileBillfishOpen: !!cfg.writeWhileBillfishOpen, status: readStatus(cfg) });
      } else if (msg.cmd === 'sheets.list') {
        send(Object.assign({ id, ok: true }, listSheets(cfg)));
      } else if (msg.cmd === 'sheets.save') {
        send(Object.assign({ id, ok: true, dir: cfg.sheetsDir }, saveSheet(cfg, msg)));
      } else if (msg.cmd === 'sync.status') {
        send({ id, ok: true, status: readStatus(cfg) });
      } else if (msg.cmd === 'sync.run') {
        const cur = readStatus(cfg);
        if (cur.state === 'running') { send({ id, ok: false, error: '「' + (cur.title || cur.name) + '」正在同步，等它做完再点。', status: cur }); return; }
        const reqFile = cfg.statusFile.replace(/\.json$/i, '') + '.request.json';
        writeJsonAtomic(reqFile, { name: msg.name, title: msg.title, url: msg.url, dest: msg.dest, tag: msg.tag });
        // 先写一份“开始了”的状态，免得插件在新进程起来之前看到上一次的结果
        writeJsonAtomic(cfg.statusFile, {
          state: 'running', pid: process.pid, name: msg.name, title: msg.title || msg.name, dest: msg.dest, startedAt: Date.now(), updatedAt: Date.now(), error: '', summary: null,
          steps: STEPS.map(([key, label]) => ({ key, label, state: 'todo', text: '' })),
        });
        const env = Object.assign({}, process.env, { PBL_HOST_CONFIG: CONFIG_PATH });
        spawn(process.execPath, [__filename, '--job', reqFile], { detached: true, stdio: 'ignore', windowsHide: true, env }).unref();
        send({ id, ok: true, started: true });
      } else {
        throw new Error('不认识的命令：' + msg.cmd);
      }
    } catch (e) {
      send({ id, ok: false, error: String(e && e.message || e) });
    }
  };

  let buf = Buffer.alloc(0);
  process.stdin.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 4) return;
      const len = buf.readUInt32LE(0);
      if (len > 8 * 1024 * 1024) { process.exit(1); }
      if (buf.length < 4 + len) return;
      const body = buf.slice(4, 4 + len).toString('utf8');
      buf = buf.slice(4 + len);
      let msg = null;
      try { msg = JSON.parse(body); } catch (e) { send({ ok: false, error: '消息不是 JSON' }); continue; }
      handle(msg);
    }
  });
  process.stdin.on('end', () => { alive = false; clearInterval(watcher); process.exit(0); });
}

if (require.main === module) {
  const cfg = loadConfig();
  const i = process.argv.indexOf('--job');
  if (i !== -1) {
    const req = readJson(process.argv[i + 1], null);
    if (!req) process.exit(1);
    runJob(cfg, req).then(() => process.exit(0), () => process.exit(1));
  } else {
    serve(cfg);
  }
}
module.exports = { loadConfig, listSheets, saveSheet, readStatus, runJob, VERSION };
