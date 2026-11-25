// 生成插件图标：发光的瞳孔（虹膜纤维 + 光斑）。
// 图是用 canvas 按固定随机种子画出来的，先画 512px 母版，再逐级缩小到 128/48/32/16。
// 用无头 Chrome 渲染，不需要装别的依赖。
//   node tools\build-icons.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const iconsDir = path.join(__dirname, '..', 'extension', 'icons');

// 这一段在浏览器里执行
function pageMain() {
  function rng(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // tiny=true 是给 16px 用的简化版：瞳孔更大、纤维更粗更少
  function draw(S, tiny) {
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const x = c.getContext('2d');
    const rnd = rng(11);
    const R = (a, b) => a + (b - a) * rnd();
    const smooth = (a, b, v) => { const t = Math.min(1, Math.max(0, (v - a) / (b - a))); return t * t * (3 - 2 * t); };
    const blur = (px) => { x.filter = px > 0.05 ? 'blur(' + px.toFixed(2) + 'px)' : 'none'; };

    // 圆角底板
    const pad = S * 0.02;
    const rad = S * 0.225;
    x.beginPath();
    x.roundRect(pad, pad, S - pad * 2, S - pad * 2, rad);
    x.clip();
    let g = x.createRadialGradient(S * 0.5, S * 0.5, 0, S * 0.5, S * 0.5, S * 0.75);
    g.addColorStop(0, '#120e2c');
    g.addColorStop(1, '#040308');
    x.fillStyle = g;
    x.fillRect(0, 0, S, S);

    // 瞳孔：一个斜着的椭圆（像从侧上方看过去）
    const cx = S * 0.455;
    const cy = S * 0.49;
    const rx = S * (tiny ? 0.31 : 0.285);
    const ry = S * (tiny ? 0.235 : 0.2);
    const rot = -0.56;
    const cr = Math.cos(rot);
    const sr = Math.sin(rot);
    const P = (th, k) => {
      const ex = k * rx * Math.cos(th);
      const ey = k * ry * Math.sin(th);
      return [cx + ex * cr - ey * sr, cy + ex * sr + ey * cr];
    };
    // +1 = 右下（近处，青色细纤维），-1 = 左上（远处，暖色粗光带）
    const side = (th) => {
      const p = P(th, 1.6);
      const dx = p[0] - cx;
      const dy = p[1] - cy;
      return (dx * 0.55 + dy * 0.835) / Math.hypot(dx, dy);
    };
    const warmW = (th) => smooth(0.2, -0.45, side(th));
    const tealW = (th) => smooth(-0.4, 0.15, side(th));

    const strand = (th, k0, k1, bend, width, stops, blurPx, curl) => {
      const cw = curl || 0.07;
      const p0 = P(th, k0);
      const p1 = P(th + bend, k1);
      const c1 = P(th + bend * 0.33 + R(-cw, cw), k0 + (k1 - k0) * 0.33);
      const c2 = P(th + bend * 0.66 + R(-cw, cw), k0 + (k1 - k0) * 0.66);
      const gr = x.createLinearGradient(p0[0], p0[1], p1[0], p1[1]);
      for (const s of stops) gr.addColorStop(s[0], s[1]);
      blur(blurPx);
      x.strokeStyle = gr;
      x.lineWidth = width;
      x.lineCap = 'round';
      x.beginPath();
      x.moveTo(p0[0], p0[1]);
      x.bezierCurveTo(c1[0], c1[1], c2[0], c2[1], p1[0], p1[1]);
      x.stroke();
    };

    x.globalCompositeOperation = 'lighter';

    // 底色：左上紫蓝，右下青
    for (const w of [[0.2, 0.18, 'rgba(84,58,210,0.50)'], [0.78, 0.82, 'rgba(18,128,128,0.55)']]) {
      g = x.createRadialGradient(S * w[0], S * w[1], 0, S * w[0], S * w[1], S * 0.62);
      g.addColorStop(0, w[2]);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      x.fillStyle = g;
      x.fillRect(0, 0, S, S);
    }

    // 远处：暖色的粗光带，带虚焦
    const nWarm = tiny ? 26 : 64;
    for (let i = 0; i < nWarm; i++) {
      const th = R(0, Math.PI * 2);
      if (rnd() > warmW(th)) continue;
      strand(th, R(0.86, 0.98), R(2.0, 3.6), R(-0.3, 0.3), S * R(0.012, 0.03) * (tiny ? 1.5 : 1), [
        [0, 'rgba(255,242,222,0.78)'],
        [0.24, 'rgba(255,172,132,0.60)'],
        [0.6, 'rgba(232,112,150,0.22)'],
        [1, 'rgba(80,60,200,0)'],
      ], S * R(0.004, 0.012), 0.12);
    }

    // 近处：青色细纤维
    const nTeal = tiny ? 90 : 460;
    for (let i = 0; i < nTeal; i++) {
      const th = R(0, Math.PI * 2);
      if (rnd() > tealW(th)) continue;
      strand(th, R(0.97, 1.1), R(1.5, 3.3), R(-0.24, 0.24), S * R(0.0024, 0.0058) * (tiny ? 3 : 1), [
        [0, 'rgba(170,240,224,0.50)'],
        [0.16, 'rgba(58,196,180,0.50)'],
        [0.7, 'rgba(20,122,134,0.30)'],
        [1, 'rgba(10,60,92,0)'],
      ], rnd() < 0.35 ? S * 0.005 : 0, 0.1);
    }

    // 近处瞳孔边缘：橙白色的卷曲细丝
    const nRim = tiny ? 0 : 150;
    for (let i = 0; i < nRim; i++) {
      const th = R(0, Math.PI * 2);
      if (rnd() > tealW(th)) continue;
      strand(th, R(0.96, 1.02), R(1.12, 1.5), R(-0.3, 0.3), S * R(0.002, 0.0045), [
        [0, 'rgba(255,236,206,0.95)'],
        [0.5, 'rgba(255,170,110,0.60)'],
        [1, 'rgba(255,120,70,0)'],
      ], 0, 0.16);
    }

    // 左上角外缘的一道亮弧
    const N = 160;
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      const b = ((i + 1.4) / N) * Math.PI * 2;
      const w = warmW(a);
      if (w < 0.02) continue;
      const p0 = P(a, 2.9);
      const p1 = P(b, 2.9);
      blur(S * 0.03);
      x.strokeStyle = 'rgba(255,214,200,' + (0.5 * w).toFixed(3) + ')';
      x.lineWidth = S * 0.05;
      x.beginPath();
      x.moveTo(p0[0], p0[1]);
      x.lineTo(p1[0], p1[1]);
      x.stroke();
    }

    // 瞳孔本体
    x.globalCompositeOperation = 'source-over';
    blur(S * 0.007);
    g = x.createRadialGradient(cx, cy, 0, cx, cy, rx);
    g.addColorStop(0, '#040207');
    g.addColorStop(1, '#0d0709');
    x.fillStyle = g;
    x.beginPath();
    x.ellipse(cx, cy, rx, ry, rot, 0, Math.PI * 2);
    x.fill();

    // 瞳孔边缘的光：近处橙白、远处淡粉
    x.globalCompositeOperation = 'lighter';
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      const b = ((i + 1.4) / N) * Math.PI * 2;
      const p0 = P(a, 1.005);
      const p1 = P(b, 1.005);
      const near = tealW(a);
      const far = warmW(a);
      const seg = (color, width, blurPx) => {
        blur(blurPx);
        x.strokeStyle = color;
        x.lineWidth = width;
        x.beginPath();
        x.moveTo(p0[0], p0[1]);
        x.lineTo(p1[0], p1[1]);
        x.stroke();
      };
      const k = tiny ? 2.2 : 1;
      if (near > 0.02) {
        seg('rgba(255,170,96,' + (0.55 * near).toFixed(3) + ')', S * 0.02 * k, S * 0.012);
        seg('rgba(255,240,214,' + (0.9 * near).toFixed(3) + ')', S * 0.0055 * k, S * 0.0015);
      }
      if (far > 0.02) seg('rgba(255,190,200,' + (0.4 * far).toFixed(3) + ')', S * 0.022 * k, S * 0.016);
    }

    // 光斑
    const colors = ['255,210,74', '255,84,164', '255,96,62', '96,160,255', '255,255,255', '140,255,196', '255,150,60'];
    const nDots = tiny ? 9 : 230;
    for (let i = 0; i < nDots; i++) {
      const th = R(0, Math.PI * 2);
      if (rnd() > tealW(th)) continue;
      const k = 1.14 + 1.25 * Math.pow(rnd(), 1.5);
      const p = P(th, k);
      const r = S * (0.005 + 0.022 * Math.pow(rnd(), 2.4)) * (tiny ? 3.2 : 1);
      const col = colors[Math.floor(rnd() * colors.length)];
      const al = R(0.55, 1);
      blur(rnd() < 0.35 ? r * 0.35 : 0);
      g = x.createRadialGradient(p[0], p[1], 0, p[0], p[1], r);
      g.addColorStop(0, 'rgba(' + col + ',' + al.toFixed(2) + ')');
      g.addColorStop(0.6, 'rgba(' + col + ',' + (al * 0.75).toFixed(2) + ')');
      g.addColorStop(1, 'rgba(' + col + ',0)');
      x.fillStyle = g;
      x.beginPath();
      x.arc(p[0], p[1], r, 0, Math.PI * 2);
      x.fill();
    }

    // 四角压暗
    x.globalCompositeOperation = 'source-over';
    blur(0);
    g = x.createRadialGradient(S * 0.5, S * 0.5, S * 0.42, S * 0.5, S * 0.5, S * 0.8);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.5)');
    x.fillStyle = g;
    x.fillRect(0, 0, S, S);
    return c;
  }

  // 每次最多缩一半，避免一步缩太多出锯齿
  function shrink(src, n) {
    let cur = src;
    while (cur.width > n) {
      const w = Math.max(n, Math.ceil(cur.width / 2));
      const c = document.createElement('canvas');
      c.width = c.height = w;
      const x = c.getContext('2d');
      x.imageSmoothingQuality = 'high';
      x.drawImage(cur, 0, 0, w, w);
      cur = c;
    }
    return cur;
  }

  const master = draw(512, false);
  const tinyMaster = draw(512, true);
  const out = [
    ['icon-master', master.toDataURL('image/png')],
    ['icon128', shrink(master, 128).toDataURL('image/png')],
    ['icon48', shrink(master, 48).toDataURL('image/png')],
    ['icon32', shrink(master, 32).toDataURL('image/png')],
    ['icon16', shrink(tinyMaster, 16).toDataURL('image/png')],
  ];
  document.getElementById('out').textContent = 'PBL' + JSON.stringify(out) + 'PBL';
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pbl-icons-'));
const page = path.join(tmp, 'page.html');
fs.writeFileSync(page, '<!doctype html><meta charset="utf-8"><pre id="out"></pre><script>(' + pageMain.toString() + ')();</script>');

const dom = execFileSync(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--user-data-dir=' + path.join(tmp, 'profile'),
  '--virtual-time-budget=8000', '--dump-dom', 'file:///' + page.replace(/\\/g, '/'),
], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });

const m = dom.match(/PBL(\[.*?\])PBL/s);
if (!m) throw new Error('没拿到渲染结果');
fs.mkdirSync(iconsDir, { recursive: true });
for (const [name, dataUrl] of JSON.parse(m[1].replace(/&amp;/g, '&'))) {
  const file = path.join(iconsDir, name + '.png');
  fs.writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
  console.log(file, fs.statSync(file).size + ' bytes');
}
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* Chrome 可能还占着临时目录 */ }
