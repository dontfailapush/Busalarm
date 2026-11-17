// Builds the Android project for Bus Alarm.
// Works whether the files sit in folders or were uploaded flat (all in one place).
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const run = (cmd) => execSync(cmd, { stdio: 'inherit' });
const exists = (p) => fs.existsSync(p);
const copy = (src, dst) => { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst); };

/* ---------- 1. Web files -> www/ ---------- */
fs.mkdirSync('www/lib', { recursive: true });
for (const f of ['index.html', 'style.css', 'app.js']) if (exists(f)) copy(f, `www/${f}`);
for (const f of ['leaflet.js', 'leaflet.css']) copy(`node_modules/leaflet/dist/${f}`, `www/lib/${f}`);
fs.cpSync('node_modules/leaflet/dist/images', 'www/lib/images', { recursive: true });
if (!exists('www/index.html')) throw new Error('index.html is missing from the repository');

/* ---------- 2. Android project ---------- */
if (!exists('android')) run('npx cap add android');
run('npx cap sync android');
const res = 'android/app/src/main/res';

/* ---------- 3. Theme, notification icon, alarm sound ---------- */
if (exists('android-overlay/res')) fs.cpSync('android-overlay/res', res, { recursive: true, force: true });
const flat = [
  ['styles.xml', 'values/styles.xml'],
  ['ic_launcher_background.xml', 'values/ic_launcher_background.xml'],
  ['ic_stat_busalarm.xml', 'drawable/ic_stat_busalarm.xml'],
  ['alarm.wav', 'raw/alarm.wav'],
];
for (const [from, to] of flat) if (exists(from)) copy(from, `${res}/${to}`);

/* ---------- 4. Launcher icons (drawn here, no image files needed) ---------- */
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
function encodePng(w, h, rgba) {
  const stride = w * 4 + 1, raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) { raw[y * stride] = 0; rgba.copy(raw, y * stride + 1, y * w * 4, (y + 1) * w * 4); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function inBell(x, y) {
  const ell = (cx, cy, rx, ry) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
  if (ell(0, -50, 140, 140)) return true;                                           // dome
  if (y >= -50 && y <= 125 && Math.abs(x) <= 140 + (y + 50) * (50 / 175)) return true; // flared body
  if (y >= 112 && y <= 160 && Math.abs(x) <= 205) {                                 // rim
    const ex = Math.max(0, Math.abs(x) - 181), ey = Math.abs(y - 136);
    if (ex * ex + ey * ey <= 576) return true;
  }
  return ell(0, 182.5, 40, 32.5) || ell(0, -210, 26, 25);                           // clapper, knob
}
function art(X, Y) { // gradient disc with a white bell, in a 1024 x 1024 space
  if ((X - 512) ** 2 + (Y - 512) ** 2 > 318 * 318) return null;
  const t = (X + Y) / 2048, k = 0.95;
  if (inBell((X - 512) / k, (Y - 502) / k)) return [255, 255, 255];
  return [111 + 27 * t, 155 - 64 * t, 255 - 0 * t];
}
function inTile(X, Y, round) {
  if (round) return (X - 512) ** 2 + (Y - 512) ** 2 <= 512 * 512;
  const ex = Math.max(0, Math.abs(X - 512) - 282), ey = Math.max(0, Math.abs(Y - 512) - 282);
  return ex * ex + ey * ey <= 230 * 230;
}
function renderIcon(size, kind) {
  const SS = 3, out = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) for (let px = 0; px < size; px++) {
    let r = 0, g = 0, b = 0, n = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const X = ((px + (sx + 0.5) / SS) / size) * 1024, Y = ((py + (sy + 0.5) / SS) / size) * 1024;
      let c = null;
      if (kind === 'foreground') c = art(X, Y);
      else if (inTile(X, Y, kind === 'round')) c = art(X, Y) || [11, 15, 26];
      if (c) { r += c[0]; g += c[1]; b += c[2]; n++; }
    }
    const o = (py * size + px) * 4;
    if (n) { out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = Math.round((255 * n) / (SS * SS)); }
  }
  return encodePng(size, size, out);
}

if (!exists('android-overlay/res/mipmap-xxxhdpi/ic_launcher.png')) {
  const dens = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
  for (const [name, f] of Object.entries(dens)) {
    const dir = `${res}/mipmap-${name}`;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${dir}/ic_launcher_foreground.png`, renderIcon(Math.round(108 * f), 'foreground'));
    fs.writeFileSync(`${dir}/ic_launcher.png`, renderIcon(Math.round(48 * f), 'square'));
    fs.writeFileSync(`${dir}/ic_launcher_round.png`, renderIcon(Math.round(48 * f), 'round'));
  }
}

/* ---------- 5. Permissions ---------- */
const manifest = 'android/app/src/main/AndroidManifest.xml';
let xml = fs.readFileSync(manifest, 'utf8');
if (!xml.includes('android.permission.VIBRATE')) {
  xml = xml.replace('</manifest>', '    <uses-permission android:name="android.permission.VIBRATE" />\n</manifest>');
  fs.writeFileSync(manifest, xml);
}

console.log('Android project ready.');
