/**
 * Minimal QR Code encoder (ISO/IEC 18004): byte mode, error correction level M, versions 1–10
 * (up to 213 bytes). Enough for the phone-access link; no dependency needed.
 * Returns a square boolean matrix (true = dark), rows first: matrix[y][x].
 */

// Level M: [total codewords, EC codewords per block, data codewords per block…]
const VERSIONS_M = {
  1: [26, 10, [16]],
  2: [44, 16, [28]],
  3: [70, 26, [44]],
  4: [100, 18, [32, 32]],
  5: [134, 24, [43, 43]],
  6: [172, 16, [27, 27, 27, 27]],
  7: [196, 18, [31, 31, 31, 31]],
  8: [242, 22, [38, 38, 39, 39]],
  9: [292, 22, [36, 36, 36, 37, 37]],
  10: [346, 26, [43, 43, 43, 43, 44]],
};
const ALIGN = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50] };
const EC_LEVEL_M_BITS = 0;

function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsDivisor(degree) {
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

function rsRemainder(data, divisor) {
  const result = new Array(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ result.shift();
    result.push(0);
    for (let i = 0; i < divisor.length; i++) result[i] ^= gfMul(divisor[i], factor);
  }
  return result;
}

function dataCapacity(v) {
  return VERSIONS_M[v][2].reduce((a, b) => a + b, 0);
}

function encodeData(bytes, version) {
  const bits = [];
  const put = (val, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };
  put(0b0100, 4);
  put(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  const capBits = dataCapacity(version) * 8;
  put(0, Math.min(4, capBits - bits.length));
  while (bits.length % 8) bits.push(0);
  const out = [];
  for (let i = 0; i < bits.length; i += 8) out.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  for (let pad = 0xec; out.length < dataCapacity(version); pad ^= 0xec ^ 0x11) out.push(pad);
  return out;
}

function addEcAndInterleave(data, version) {
  const [, ecLen, blockLens] = VERSIONS_M[version];
  const divisor = rsDivisor(ecLen);
  const blocks = [];
  let k = 0;
  for (const len of blockLens) {
    const dat = data.slice(k, k + len);
    k += len;
    blocks.push({ dat, ec: rsRemainder(dat, divisor) });
  }
  const out = [];
  const maxLen = Math.max(...blockLens);
  for (let i = 0; i < maxLen; i++) for (const b of blocks) if (i < b.dat.length) out.push(b.dat[i]);
  for (let i = 0; i < ecLen; i++) for (const b of blocks) out.push(b.ec[i]);
  return out;
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

class Grid {
  constructor(version) {
    this.version = version;
    this.size = version * 4 + 17;
    this.m = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
    this.fn = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
  }
  setFn(x, y, dark) {
    this.m[y][x] = dark;
    this.fn[y][x] = true;
  }
  drawFunctionPatterns() {
    const n = this.size;
    for (let i = 0; i < n; i++) {
      this.setFn(6, i, i % 2 === 0);
      this.setFn(i, 6, i % 2 === 0);
    }
    for (const [cx, cy] of [[3, 3], [n - 4, 3], [3, n - 4]]) {
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const x = cx + dx;
          const y = cy + dy;
          if (x < 0 || y < 0 || x >= n || y >= n) continue;
          const d = Math.max(Math.abs(dx), Math.abs(dy));
          this.setFn(x, y, d !== 2 && d !== 4);
        }
      }
    }
    const pos = ALIGN[this.version];
    const last = pos.length - 1;
    for (let i = 0; i < pos.length; i++) {
      for (let j = 0; j < pos.length; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) this.setFn(pos[i] + dx, pos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
    this.drawFormat(0);
    this.drawVersion();
  }
  drawFormat(mask) {
    const data = (EC_LEVEL_M_BITS << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const bit = (i) => ((bits >>> i) & 1) === 1;
    const n = this.size;
    for (let i = 0; i <= 5; i++) this.setFn(8, i, bit(i));
    this.setFn(8, 7, bit(6));
    this.setFn(8, 8, bit(7));
    this.setFn(7, 8, bit(8));
    for (let i = 9; i < 15; i++) this.setFn(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) this.setFn(n - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) this.setFn(8, n - 15 + i, bit(i));
    this.setFn(8, n - 8, true);
  }
  drawVersion() {
    if (this.version < 7) return;
    let rem = this.version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (this.version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) === 1;
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.setFn(a, b, dark);
      this.setFn(b, a, dark);
    }
  }
  drawCodewords(codewords) {
    const n = this.size;
    let i = 0;
    for (let right = n - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < n; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? n - 1 - vert : vert;
          if (this.fn[y][x]) continue;
          if (i < codewords.length * 8) this.m[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
          i++;
        }
      }
    }
  }
  applyMask(mask) {
    const f = MASKS[mask];
    for (let y = 0; y < this.size; y++) for (let x = 0; x < this.size; x++) if (!this.fn[y][x] && f(x, y)) this.m[y][x] = !this.m[y][x];
  }
}

/** Standard penalty score (rules 1–4) used to pick the most readable mask. */
function penalty(m) {
  const n = m.length;
  let score = 0;
  const lines = [];
  for (let y = 0; y < n; y++) lines.push(m[y]);
  for (let x = 0; x < n; x++) lines.push(m.map((row) => row[x]));
  for (const line of lines) {
    let run = 1;
    for (let i = 1; i <= n; i++) {
      if (i < n && line[i] === line[i - 1]) run++;
      else {
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
    }
    const s = line.map((d) => (d ? '1' : '0')).join('');
    for (const pat of ['10111010000', '00001011101']) {
      let k = s.indexOf(pat);
      while (k !== -1) {
        score += 40;
        k = s.indexOf(pat, k + 1);
      }
    }
  }
  for (let y = 0; y < n - 1; y++) for (let x = 0; x < n - 1; x++) if (m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) score += 3;
  let dark = 0;
  for (const row of m) for (const d of row) if (d) dark++;
  score += Math.floor(Math.abs((dark * 20) / (n * n) - 10)) * 10;
  return score;
}

export function qrMatrix(text) {
  const bytes = [...Buffer.from(String(text), 'utf8')];
  let version = 0;
  for (let v = 1; v <= 10; v++) {
    if (4 + (v < 10 ? 8 : 16) + bytes.length * 8 <= dataCapacity(v) * 8) {
      version = v;
      break;
    }
  }
  if (!version) throw new Error(`Text too long for a QR code (${bytes.length} bytes, at most 213).`);
  const codewords = addEcAndInterleave(encodeData(bytes, version), version);
  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const g = new Grid(version);
    g.drawFunctionPatterns();
    g.drawCodewords(codewords);
    g.applyMask(mask);
    g.drawFormat(mask);
    const p = penalty(g.m);
    if (!best || p < best.p) best = { p, m: g.m };
  }
  return best.m;
}

/** SVG markup for a matrix, with the 4-module quiet zone the standard requires. */
export function qrSvg(text, { scale = 6, dark = '#000', light = '#fff' } = {}) {
  const m = qrMatrix(text);
  const n = m.length + 8;
  let d = '';
  for (let y = 0; y < m.length; y++) for (let x = 0; x < m.length; x++) if (m[y][x]) d += `M${x + 4} ${y + 4}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" width="${n * scale}" height="${n * scale}" shape-rendering="crispEdges"><rect width="${n}" height="${n}" fill="${light}"/><path d="${d}" fill="${dark}"/></svg>`;
}
