// PinBoardLock — 后台脚本。
// 1. 页面里的面板点了“调研单”时，把侧边栏（Side Panel）打开。
//    sidePanel.open 必须在用户点击的同一轮里调用，所以那一支不能先 await 别的东西。
// 2. AI 聊天页（capture.js）认出调研单时，交给本机小程序存进调研单文件夹；小程序没装就直接放进插件。
importScripts('sheet.js');

const HOST = 'com.pinboardlock.host';
const S = chrome.storage.local;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return;
  if (msg.type === 'pbl-open-panel') {
    const windowId = sender.tab ? sender.tab.windowId : msg.windowId;
    if (windowId == null) return;
    chrome.sidePanel.open({ windowId }).catch(() => { /* 用户手势过期等情况：忽略 */ });
    return;
  }
  if (msg.type === 'pbl-capture') {
    capture(msg).then(sendResponse, (e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
    return true;   // 异步回话
  }
});

async function capture(msg) {
  const got = await S.get(['captured', 'sheets', 'inbox']);
  const captured = got.captured || {};
  if (captured[msg.key]) return { ok: true, known: true };

  const sheets = [];
  for (const raw of msg.sheets || []) {
    try { sheets.push(PBLSheet.normalizeSheet(raw)); } catch (e) { /* 不合格的跳过 */ }
  }
  if (!sheets.length) return { ok: false, error: '没有合格的调研单' };

  let where = 'folder';
  let dir = '';
  try {
    for (const s of sheets) {
      const r = await chrome.runtime.sendNativeMessage(HOST, { cmd: 'sheets.save', sheet: PBLSheet.toPlain(s), base: PBLSheet.fileBase(s) });
      if (!r || !r.ok) throw new Error((r && r.error) || '本机小程序没回应');
      dir = r.dir || dir;
    }
  } catch (e) {
    where = 'plugin';
  }

  const patch = {};
  // 只留最近 300 条“见过”的记录
  captured[msg.key] = Date.now();
  const keys = Object.keys(captured);
  if (keys.length > 300) for (const k of keys.sort((a, b) => captured[a] - captured[b]).slice(0, keys.length - 300)) delete captured[k];
  patch.captured = captured;
  if (where === 'plugin') {
    let list = got.sheets || [];
    for (const s of sheets) list = PBLSheet.upsert(list, s);
    patch.sheets = list;
    patch.activeSheet = sheets[0].id;
  } else {
    // 告诉侧边栏：文件夹里有新的，等它刷新
    patch.inbox = { t: Date.now(), titles: sheets.map((s) => s.title).concat((got.inbox && got.inbox.titles) || []).slice(0, 8) };
  }
  await S.set(patch);
  return { ok: true, where, dir, titles: sheets.map((s) => s.title), from: msg.source || '' };
}
