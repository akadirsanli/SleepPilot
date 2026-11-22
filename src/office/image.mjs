import fsp from 'node:fs/promises';
import { lib } from './deps.mjs';

/**
 * Images: size and type for PNG/JPEG/GIF/WebP from their headers; for PNG also the pixels, so a
 * check can tell a real chart from a blank or single-colour image, and two images can be compared.
 */
export function imageSize(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return { type: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let p = 2;
    while (p + 9 < buf.length) {
      if (buf[p] !== 0xff) {
        p++;
        continue;
      }
      const marker = buf[p + 1];
      const len = buf.readUInt16BE(p + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { type: 'jpeg', height: buf.readUInt16BE(p + 5), width: buf.readUInt16BE(p + 7) };
      p += 2 + len;
    }
    return { type: 'jpeg', width: null, height: null };
  }
  if (buf.subarray(0, 3).toString('latin1') === 'GIF') return { type: 'gif', width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return { type: 'webp', width: null, height: null };
  return null;
}

/** Pixel statistics of a PNG: distinct colours (sampled), share of the most common colour, blank. */
export function pngStats(buf) {
  const { PNG } = lib('pngjs');
  const png = PNG.sync.read(buf);
  const { width, height, data } = png;
  const step = Math.max(1, Math.floor((width * height) / 200_000));
  const counts = new Map();
  let samples = 0;
  let transparent = 0;
  for (let i = 0; i < width * height; i += step) {
    const o = i * 4;
    if (data[o + 3] < 16) {
      transparent++;
      samples++;
      continue;
    }
    const key = ((data[o] >> 3) << 10) | ((data[o + 1] >> 3) << 5) | (data[o + 2] >> 3);
    counts.set(key, (counts.get(key) || 0) + 1);
    samples++;
  }
  const dominant = Math.max(transparent, ...counts.values(), 0);
  const dominantShare = samples ? dominant / samples : 1;
  return { width, height, colors: counts.size, dominantShare: Math.round(dominantShare * 10000) / 10000, blank: dominantShare >= 0.995 };
}

export async function readImage(file) {
  const buf = await fsp.readFile(file);
  const size = imageSize(buf);
  if (!size) throw new Error('Not a PNG, JPEG, GIF or WebP image.');
  const stats = size.type === 'png' ? pngStats(buf) : null;
  return { kind: 'image', ...size, ...(stats ? { colors: stats.colors, dominantShare: stats.dominantShare, blank: stats.blank } : {}) };
}

/** Share of pixels that differ between two PNGs of the same size (0…1). */
export function pngDiff(a, b, { threshold = 24 } = {}) {
  const { PNG } = lib('pngjs');
  const pa = PNG.sync.read(a);
  const pb = PNG.sync.read(b);
  if (pa.width !== pb.width || pa.height !== pb.height) return { sameSize: false, a: [pa.width, pa.height], b: [pb.width, pb.height], changed: 1 };
  let changed = 0;
  for (let i = 0; i < pa.data.length; i += 4) {
    const d = Math.abs(pa.data[i] - pb.data[i]) + Math.abs(pa.data[i + 1] - pb.data[i + 1]) + Math.abs(pa.data[i + 2] - pb.data[i + 2]) + Math.abs(pa.data[i + 3] - pb.data[i + 3]);
    if (d > threshold) changed++;
  }
  return { sameSize: true, changed: changed / (pa.width * pa.height) };
}
