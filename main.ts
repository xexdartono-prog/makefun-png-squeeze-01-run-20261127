// Squeeze: lossless PNG recompression for screenshots.
// Strategy: parse the stored RGBA PNG, try a fixed deterministic set of
// encodings (palette / grey / RGB / RGBA / RGB+tRNS reductions, adaptive and
// fixed row filters, zlib level 9) and keep the smallest file. No clock, no
// randomness: the same input always yields the same output bytes.
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { deflateSync, inflateSync, constants as Z } from 'node:zlib';

const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c;
}
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

// Parse an 8-bit non-interlaced PNG into RGBA pixels.
function parsePng(buf) {
  let off = 8, w = 0, h = 0, colorType = 6, plte = null, trns = null;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      colorType = data[9];
    } else if (type === 'PLTE') plte = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const ch = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 3 ? 1 : colorType === 4 ? 2 : 4;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const px = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1, dst = y * stride, up = dst - stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? px[dst + x - ch] : 0;
      const b = y > 0 ? px[up + x] : 0;
      const c = y > 0 && x >= ch ? px[up + x - ch] : 0;
      let v = raw[src + x];
      if (f === 1) v = (v + a) & 255;
      else if (f === 2) v = (v + b) & 255;
      else if (f === 3) v = (v + ((a + b) >> 1)) & 255;
      else if (f === 4) v = (v + paeth(a, b, c)) & 255;
      px[dst + x] = v;
    }
  }
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const s = i * ch, d = i * 4;
    if (colorType === 6) { rgba[d] = px[s]; rgba[d + 1] = px[s + 1]; rgba[d + 2] = px[s + 2]; rgba[d + 3] = px[s + 3]; }
    else if (colorType === 2) { rgba[d] = px[s]; rgba[d + 1] = px[s + 1]; rgba[d + 2] = px[s + 2]; rgba[d + 3] = 255; }
    else if (colorType === 0) { rgba[d] = rgba[d + 1] = rgba[d + 2] = px[s]; rgba[d + 3] = 255; }
    else if (colorType === 4) { rgba[d] = rgba[d + 1] = rgba[d + 2] = px[s]; rgba[d + 3] = px[s + 1]; }
    else { const p = px[s] * 3; rgba[d] = plte[p]; rgba[d + 1] = plte[p + 1]; rgba[d + 2] = plte[p + 2]; rgba[d + 3] = trns && px[s] < trns.length ? trns[px[s]] : 255; }
  }
  return { w, h, rgba };
}

function filterByte(f, v, a, b, c) {
  if (f === 0) return v;
  if (f === 1) return (v - a) & 255;
  if (f === 2) return (v - b) & 255;
  if (f === 3) return (v - ((a + b) >> 1)) & 255;
  return (v - paeth(a, b, c)) & 255;
}

// rows: Uint8Array of h*stride samples, bpp bytes per pixel.
// mode: fixed filter 0..4, or 'msad' / 'ent' adaptive per row.
function buildFiltered(rows, w, h, bpp, mode) {
  const stride = w * bpp;
  const out = Buffer.alloc(h * (stride + 1));
  const cand = new Uint8Array(stride);
  const hist = new Int32Array(256);
  for (let y = 0; y < h; y++) {
    const dst = y * stride, up = dst - stride, o = y * (stride + 1);
    let bestF = 0, bestScore = Infinity;
    const tries = typeof mode === 'number' ? [mode] : [0, 1, 2, 3, 4];
    for (const f of tries) {
      for (let x = 0; x < stride; x++) {
        const a = x >= bpp ? rows[dst + x - bpp] : 0;
        const b = y > 0 ? rows[up + x] : 0;
        const c = y > 0 && x >= bpp ? rows[up + x - bpp] : 0;
        cand[x] = filterByte(f, rows[dst + x], a, b, c);
      }
      if (typeof mode === 'number') { bestF = f; break; }
      let score;
      if (mode === 'msad') {
        score = 0;
        for (let x = 0; x < stride; x++) { const v = cand[x]; score += v < 128 ? v : 256 - v; }
      } else {
        hist.fill(0);
        for (let x = 0; x < stride; x++) hist[cand[x]]++;
        score = 0;
        for (let i = 0; i < 256; i++) { const n = hist[i]; if (n > 0) score -= n * Math.log2(n); }
      }
      if (score < bestScore) { bestScore = score; bestF = f; }
    }
    out[o] = bestF;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? rows[dst + x - bpp] : 0;
      const b = y > 0 ? rows[up + x] : 0;
      const c = y > 0 && x >= bpp ? rows[up + x - bpp] : 0;
      out[o + 1 + x] = filterByte(bestF, rows[dst + x], a, b, c);
    }
  }
  return out;
}

function writePng(w, h, colorType, plte, trns, filtered, strategy) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = colorType;
  const idat = deflateSync(filtered, { level: 9, memLevel: 8, strategy });
  const parts = [PNG_SIG, chunk('IHDR', ihdr)];
  if (plte) parts.push(chunk('PLTE', plte));
  if (trns) parts.push(chunk('tRNS', trns));
  parts.push(chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

function encode(w, h, rgba) {
  const n = w * h;
  let allA255 = true, allGrey = true, partialAlpha = false;
  const counts = new Map();
  for (let i = 0; i < n; i++) {
    const d = i * 4, r = rgba[d], g = rgba[d + 1], b = rgba[d + 2], a = rgba[d + 3];
    if (a !== 255) allA255 = false;
    if (a !== 0 && a !== 255) partialAlpha = true;
    if (r !== g || g !== b) allGrey = false;
    const key = (r << 24) | (g << 16) | (b << 8) | a;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  let best = null;
  const consider = (buf) => { if (buf && (!best || buf.length < best.length)) best = buf; };

  // Palette candidates (<=256 colours): two orderings, adaptive filters.
  if (counts.size <= 256) {
    const keys = [...counts.keys()];
    const orders = [
      [...keys].sort((x, y) => counts.get(y) - counts.get(x) || x - y),
      [...keys].sort((x, y) => {
        const lum = (k) => ((k >>> 24) * 3 + ((k >>> 16) & 255) * 6 + ((k >>> 8) & 255)) ;
        return (x & 255) - (y & 255) || lum(x) - lum(y) || x - y;
      }),
    ];
    for (let oi = 0; oi < orders.length; oi++) {
      const order = orders[oi];
      const index = new Map(order.map((k, i) => [k, i]));
      const plte = Buffer.alloc(order.length * 3);
      let trnsLen = 0;
      order.forEach((k, i) => {
        plte[i * 3] = k >>> 24; plte[i * 3 + 1] = (k >>> 16) & 255; plte[i * 3 + 2] = (k >>> 8) & 255;
        if ((k & 255) !== 255) trnsLen = i + 1;
      });
      const trns = trnsLen ? Buffer.from(order.slice(0, trnsLen).map((k) => k & 255)) : null;
      const rows = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        const d = i * 4;
        rows[i] = index.get((rgba[d] << 24) | (rgba[d + 1] << 16) | (rgba[d + 2] << 8) | rgba[d + 3]);
      }
      consider(writePng(w, h, 3, plte, trns, buildFiltered(rows, w, h, 1, 'msad'), Z.Z_DEFAULT_STRATEGY));
      if (oi === 0) {
        consider(writePng(w, h, 3, plte, trns, buildFiltered(rows, w, h, 1, 'ent'), Z.Z_DEFAULT_STRATEGY));
        consider(writePng(w, h, 3, plte, trns, buildFiltered(rows, w, h, 1, 4), Z.Z_DEFAULT_STRATEGY));
        consider(writePng(w, h, 3, plte, trns, buildFiltered(rows, w, h, 1, 1), Z.Z_DEFAULT_STRATEGY));
      }
    }
  }

  // Truecolour / grey candidates.
  const modes = [];
  if (allGrey) modes.push(allA255 ? 0 : 4);
  else modes.push(allA255 ? 2 : 6);
  for (const ct of modes) {
    const ch = ct === 0 ? 1 : ct === 4 ? 2 : ct === 2 ? 3 : 4;
    const rows = new Uint8Array(n * ch);
    for (let i = 0; i < n; i++) {
      const d = i * 4, s = i * ch;
      if (ct === 0) rows[s] = rgba[d];
      else if (ct === 4) { rows[s] = rgba[d]; rows[s + 1] = rgba[d + 3]; }
      else if (ct === 2) { rows[s] = rgba[d]; rows[s + 1] = rgba[d + 1]; rows[s + 2] = rgba[d + 2]; }
      else { rows[s] = rgba[d]; rows[s + 1] = rgba[d + 1]; rows[s + 2] = rgba[d + 2]; rows[s + 3] = rgba[d + 3]; }
    }
    consider(writePng(w, h, ct, null, null, buildFiltered(rows, w, h, ch, 'msad'), Z.Z_DEFAULT_STRATEGY));
    consider(writePng(w, h, ct, null, null, buildFiltered(rows, w, h, ch, 'msad'), Z.Z_FILTERED));
    consider(writePng(w, h, ct, null, null, buildFiltered(rows, w, h, ch, 'ent'), Z.Z_DEFAULT_STRATEGY));
    consider(writePng(w, h, ct, null, null, buildFiltered(rows, w, h, ch, 'ent'), Z.Z_FILTERED));
    consider(writePng(w, h, ct, null, null, buildFiltered(rows, w, h, ch, 4), Z.Z_DEFAULT_STRATEGY));
    consider(writePng(w, h, ct, null, null, buildFiltered(rows, w, h, ch, 4), Z.Z_FILTERED));
    consider(writePng(w, h, ct, null, null, buildFiltered(rows, w, h, ch, 1), Z.Z_DEFAULT_STRATEGY));
    consider(writePng(w, h, ct, null, null, buildFiltered(rows, w, h, ch, 2), Z.Z_DEFAULT_STRATEGY));
  }

  // RGB + tRNS when transparency is a single colour and nothing is partial.
  if (!allA255 && !partialAlpha && !allGrey) {
    let tKey = -1, ok = true;
    for (let i = 0; i < n && ok; i++) {
      const d = i * 4;
      if (rgba[d + 3] === 0) {
        const k = (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
        if (tKey === -1) tKey = k; else if (k !== tKey) ok = false;
      }
    }
    if (ok && tKey !== -1) {
      for (let i = 0; i < n && ok; i++) {
        const d = i * 4;
        if (rgba[d + 3] === 255 && ((rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2]) === tKey) ok = false;
      }
    }
    if (ok && tKey !== -1) {
      const rows = new Uint8Array(n * 3);
      for (let i = 0; i < n; i++) { const d = i * 4, s = i * 3; rows[s] = rgba[d]; rows[s + 1] = rgba[d + 1]; rows[s + 2] = rgba[d + 2]; }
      const trns = Buffer.alloc(6);
      trns.writeUInt16BE(tKey >>> 16, 0); trns.writeUInt16BE((tKey >>> 8) & 255, 2); trns.writeUInt16BE(tKey & 255, 4);
      consider(writePng(w, h, 2, null, trns, buildFiltered(rows, w, h, 3, 'msad'), Z.Z_DEFAULT_STRATEGY));
    }
  }
  return best;
}

const ids = readdirSync('/input').sort();
for (const id of ids) {
  const { w, h, rgba } = parsePng(readFileSync(`/input/${id}/image.png`));
  const out = encode(w, h, rgba);
  mkdirSync(`/output/${id}`, { recursive: true });
  writeFileSync(`/output/${id}/image.png`, out);
}
