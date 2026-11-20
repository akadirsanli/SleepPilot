// Test helpers: write ZIP files (stored/deflate) and compiled AndroidManifest.xml (binary XML).
import fs from 'node:fs';
import zlib from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * entries: [{ name, data: Buffer|string, deflate?: boolean, mode?: number }]
 * apkSigBlock: true writes an (empty) APK Signing Block before the central directory.
 */
export function makeZip(entries, { apkSigBlock = false } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data ?? '', 'utf8');
    const method = e.deflate ? 8 : 0;
    const body = method === 8 ? zlib.deflateRawSync(data) : data;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(e.mode ? (3 << 8) | 20 : 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(e.mode ? (e.mode << 16) >>> 0 : 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const parts = [...locals];
  if (apkSigBlock) {
    // size (8) + no pairs + size (8) + magic (16)
    const block = Buffer.alloc(32);
    block.writeBigUInt64LE(24n, 0);
    block.writeBigUInt64LE(24n, 8);
    block.write('APK Sig Block 42', 16, 'latin1');
    parts.push(block);
    offset += block.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, eocd]);
}

export function writeZip(file, entries, opts) {
  fs.writeFileSync(file, makeZip(entries, opts));
}

// ---------------------------------------------------------------- binary XML (AXML)

const ATTR_IDS = { versionCode: 0x0101021b, versionName: 0x0101021c, minSdkVersion: 0x0101020c, targetSdkVersion: 0x01010270, name: 0x01010003, label: 0x01010001 };

/**
 * Build a compiled AndroidManifest.xml from a tree:
 *   { tag, attrs: { name: value }, children: [...] }   (numbers → int, strings → string)
 */
export function makeAxml(root) {
  const strings = [];
  const idx = (s) => {
    let i = strings.indexOf(s);
    if (i < 0) i = strings.push(s) - 1;
    return i;
  };
  // Android attributes first so their index matches the resource map.
  const androidAttrs = Object.keys(ATTR_IDS);
  for (const a of androidAttrs) idx(a);
  const elements = [];
  const walk = (node) => {
    const attrs = Object.entries(node.attrs || {}).map(([k, v]) => ({ name: idx(k), value: v, raw: typeof v === 'string' ? idx(v) : -1 }));
    elements.push({ type: 'start', tag: idx(node.tag), attrs });
    for (const c of node.children || []) walk(c);
    elements.push({ type: 'end', tag: idx(node.tag) });
  };
  walk(root);
  // String pool (UTF-16)
  const encoded = strings.map((s) => {
    const b = Buffer.alloc(2 + s.length * 2 + 2);
    b.writeUInt16LE(s.length, 0);
    b.write(s, 2, 'utf16le');
    return b;
  });
  const offsets = [];
  let o = 0;
  for (const e of encoded) {
    offsets.push(o);
    o += e.length;
  }
  let data = Buffer.concat(encoded);
  if (data.length % 4) data = Buffer.concat([data, Buffer.alloc(4 - (data.length % 4))]);
  const poolHeader = Buffer.alloc(28);
  const poolSize = 28 + offsets.length * 4 + data.length;
  poolHeader.writeUInt16LE(0x0001, 0);
  poolHeader.writeUInt16LE(28, 2);
  poolHeader.writeUInt32LE(poolSize, 4);
  poolHeader.writeUInt32LE(strings.length, 8);
  poolHeader.writeUInt32LE(0, 12);
  poolHeader.writeUInt32LE(0, 16);
  poolHeader.writeUInt32LE(28 + offsets.length * 4, 20);
  const offBuf = Buffer.alloc(offsets.length * 4);
  offsets.forEach((v, i) => offBuf.writeUInt32LE(v, i * 4));
  const pool = Buffer.concat([poolHeader, offBuf, data]);
  // Resource map
  const resMap = Buffer.alloc(8 + androidAttrs.length * 4);
  resMap.writeUInt16LE(0x0180, 0);
  resMap.writeUInt16LE(8, 2);
  resMap.writeUInt32LE(resMap.length, 4);
  androidAttrs.forEach((a, i) => resMap.writeUInt32LE(ATTR_IDS[a], 8 + i * 4));
  const chunks = elements.map((e) => {
    if (e.type === 'end') {
      const b = Buffer.alloc(24);
      b.writeUInt16LE(0x0103, 0);
      b.writeUInt16LE(16, 2);
      b.writeUInt32LE(24, 4);
      b.writeInt32LE(-1, 12);
      b.writeInt32LE(-1, 16);
      b.writeUInt32LE(e.tag, 20);
      return b;
    }
    const b = Buffer.alloc(36 + e.attrs.length * 20);
    b.writeUInt16LE(0x0102, 0);
    b.writeUInt16LE(16, 2);
    b.writeUInt32LE(b.length, 4);
    b.writeInt32LE(-1, 12);
    b.writeInt32LE(-1, 16);
    b.writeUInt32LE(e.tag, 20);
    b.writeUInt16LE(20, 24);
    b.writeUInt16LE(20, 26);
    b.writeUInt16LE(e.attrs.length, 28);
    e.attrs.forEach((a, i) => {
      const p = 36 + i * 20;
      b.writeInt32LE(-1, p);
      b.writeUInt32LE(a.name, p + 4);
      b.writeInt32LE(a.raw, p + 8);
      b.writeUInt16LE(8, p + 12);
      b[p + 15] = typeof a.value === 'string' ? 0x03 : typeof a.value === 'boolean' ? 0x12 : 0x10;
      b.writeUInt32LE(typeof a.value === 'string' ? a.raw : typeof a.value === 'boolean' ? (a.value ? 0xffffffff : 0) : a.value >>> 0, p + 16);
    });
    return b;
  });
  const body = Buffer.concat([pool, resMap, ...chunks]);
  const head = Buffer.alloc(8);
  head.writeUInt16LE(0x0003, 0);
  head.writeUInt16LE(8, 2);
  head.writeUInt32LE(8 + body.length, 4);
  return Buffer.concat([head, body]);
}

/** A minimal but structurally real APK for tests. */
export function fakeApk({ pkg = 'com.example.test', versionCode = 3, versionName = '1.2', signed = true, abis = ['arm64-v8a'] } = {}) {
  const manifest = makeAxml({
    tag: 'manifest',
    attrs: { package: pkg, versionCode, versionName },
    children: [
      { tag: 'uses-sdk', attrs: { minSdkVersion: 24, targetSdkVersion: 34 } },
      { tag: 'uses-permission', attrs: { name: 'android.permission.INTERNET' } },
      {
        tag: 'application',
        attrs: { label: 'Test App' },
        children: [{ tag: 'activity', attrs: { name: '.MainActivity' }, children: [{ tag: 'intent-filter', children: [{ tag: 'action', attrs: { name: 'android.intent.action.MAIN' } }, { tag: 'category', attrs: { name: 'android.intent.category.LAUNCHER' } }] }] }],
      },
    ],
  });
  return makeZip(
    [
      { name: 'AndroidManifest.xml', data: manifest },
      { name: 'classes.dex', data: Buffer.from('dex\n035\0'), deflate: true },
      { name: 'resources.arsc', data: Buffer.alloc(64) },
      ...abis.map((a) => ({ name: `lib/${a}/libgame.so`, data: Buffer.alloc(16), deflate: true })),
      { name: 'assets/index.html', data: '<h1>hi</h1>', deflate: true },
    ],
    { apkSigBlock: signed },
  );
}
