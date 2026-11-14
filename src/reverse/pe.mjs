/**
 * Dependency-free PE/COFF reader. Enough to describe a Windows program without running it:
 * machine, subsystem, sections (with entropy), imports, exports, .NET/CLR presence, PDB path,
 * resources and packer hints. All reads are bounds-checked; a malformed file never throws.
 */

const MACHINES = {
  0x014c: 'x86 (32-bit)',
  0x8664: 'x86-64',
  0x01c0: 'ARM',
  0x01c4: 'ARMv7',
  0xaa64: 'ARM64',
  0x0200: 'Itanium',
};

export function isPe(buf) {
  return buf.length > 0x40 && buf[0] === 0x4d && buf[1] === 0x5a;
}

export function parsePe(buf) {
  if (!isPe(buf)) return { format: 'none' };
  const peOff = buf.readUInt32LE(0x3c);
  if (peOff + 24 > buf.length || buf.toString('latin1', peOff, peOff + 4) !== 'PE\0\0') return { format: 'mz', label: 'DOS executable (MZ)' };
  const coff = peOff + 4;
  const machine = buf.readUInt16LE(coff);
  const sectionCount = buf.readUInt16LE(coff + 2);
  const timestamp = buf.readUInt32LE(coff + 4);
  const optSize = buf.readUInt16LE(coff + 16);
  const characteristics = buf.readUInt16LE(coff + 18);
  const opt = coff + 20;
  if (opt + 2 > buf.length) return { format: 'pe', error: 'truncated optional header' };
  const magic = buf.readUInt16LE(opt);
  const pe32plus = magic === 0x20b;
  if (magic !== 0x10b && magic !== 0x20b) return { format: 'pe', error: `unknown optional header magic 0x${magic.toString(16)}` };
  const entryRva = buf.readUInt32LE(opt + 16);
  const imageBase = pe32plus ? Number(buf.readBigUInt64LE(opt + 24)) : buf.readUInt32LE(opt + 28);
  const subsystem = buf.readUInt16LE(opt + 68);
  const dllCharacteristics = buf.readUInt16LE(opt + 70);
  const numberOfRvaAndSizes = opt + (pe32plus ? 108 : 92);
  const dirsAt = opt + (pe32plus ? 112 : 96);
  const dirCount = Math.min(16, buf.readUInt32LE(numberOfRvaAndSizes) || 0);
  const dirs = [];
  for (let i = 0; i < dirCount; i++) {
    const at = dirsAt + i * 8;
    if (at + 8 > buf.length) break;
    dirs.push({ index: i, rva: buf.readUInt32LE(at), size: buf.readUInt32LE(at + 4) });
  }
  const sectionTable = opt + optSize;
  const sections = [];
  for (let i = 0; i < sectionCount; i++) {
    const at = sectionTable + i * 40;
    if (at + 40 > buf.length) break;
    const name = buf.toString('latin1', at, at + 8).replace(/\0.*$/, '').trim();
    const virtualSize = buf.readUInt32LE(at + 8);
    const virtualAddress = buf.readUInt32LE(at + 12);
    const rawSize = buf.readUInt32LE(at + 16);
    const rawPointer = buf.readUInt32LE(at + 20);
    const sectionCharacteristics = buf.readUInt32LE(at + 36);
    const start = rawPointer;
    const end = Math.min(buf.length, rawPointer + rawSize);
    const data = start < end ? buf.subarray(start, end) : Buffer.alloc(0);
    sections.push({
      name,
      virtualAddress,
      virtualSize,
      rawSize,
      rawPointer,
      characteristics: sectionCharacteristics,
      flags: sectionFlags(sectionCharacteristics),
      entropy: entropy(data),
    });
  }
  const offsetOf = (rva) => {
    for (const s of sections) {
      const span = Math.max(s.virtualSize, s.rawSize);
      if (rva >= s.virtualAddress && rva < s.virtualAddress + span) {
        const delta = rva - s.virtualAddress;
        if (delta < s.rawSize) return s.rawPointer + delta;
      }
    }
    return -1;
  };
  const readCString = (rva, max = 512) => {
    const off = offsetOf(rva);
    if (off < 0 || off >= buf.length) return null;
    const end = Math.min(buf.length, off + max);
    const zero = buf.indexOf(0, off);
    return buf.toString('latin1', off, zero >= 0 && zero < end ? zero : end).replace(/[^\x20-\x7e]/g, '');
  };
  const imports = parseImports(buf, dirs[1], offsetOf, readCString);
  const exports = parseExports(buf, dirs[0], offsetOf, readCString);
  const pdb = parsePdb(buf, dirs[6], offsetOf);
  const clr = dirs[14]?.size > 0;
  return {
    format: 'pe',
    label: clr ? 'Windows .NET executable (PE/CLR)' : 'Windows executable (PE)',
    machine: MACHINES[machine] || `machine 0x${machine.toString(16)}`,
    machineId: machine,
    pe32plus,
    subsystem: SUBSYSTEMS[subsystem] || `subsystem ${subsystem}`,
    subsystemId: subsystem,
    dllCharacteristics: dllFlags(dllCharacteristics),
    characteristics: coffFlags(characteristics),
    timestamp: timestamp ? new Date(timestamp * 1000).toISOString() : null,
    entryRva,
    imageBase,
    sections,
    imports,
    exports,
    pdb: pdb || null,
    clr,
    resources: dirs[2]?.size || 0,
    overlayBytes: overlaySize(buf, sections),
    packerHints: packerHints(sections, imports),
  };
}

function parseImports(buf, dir, offsetOf, readCString) {
  if (!dir?.rva || !dir.size) return [];
  let at = offsetOf(dir.rva);
  if (at < 0) return [];
  const out = [];
  for (let i = 0; i < 200; i++, at += 20) {
    if (at + 20 > buf.length) break;
    const originalFirstThunk = buf.readUInt32LE(at);
    const nameRva = buf.readUInt32LE(at + 12);
    const firstThunk = buf.readUInt32LE(at + 16);
    if (!nameRva) break;
    const dll = readCString(nameRva, 256);
    if (!dll) break;
    const thunkRva = originalFirstThunk || firstThunk;
    const thunkOff = offsetOf(thunkRva);
    const functions = [];
    const width = is32bit(buf) ? 4 : 8;
    if (thunkOff >= 0) {
      for (let j = 0; j < 400; j++) {
        const p = thunkOff + j * width;
        if (p + width > buf.length) break;
        const value = p + 4 <= buf.length ? buf.readUInt32LE(p) : 0;
        if (!value) break;
        if (value & 0x80000000) functions.push(`#${value & 0xffff}`);
        else {
          const name = readCString(value + 2, 256);
          if (name) functions.push(name);
        }
      }
    }
    out.push({ dll, functions: [...new Set(functions)].slice(0, 300) });
  }
  return out;
}

function is32bit(buf) {
  // The optional-header magic is re-derived here; parseImports has no header context.
  const pe = buf.length > 0x40 ? buf.readUInt32LE(0x3c) : -1;
  return pe > 0 && pe + 26 < buf.length ? buf.readUInt16LE(pe + 24) === 0x10b : true;
}

function parseExports(buf, dir, offsetOf, readCString) {
  if (!dir?.rva || !dir.size) return [];
  const at = offsetOf(dir.rva);
  if (at < 0 || at + 40 > buf.length) return [];
  const nameRva = buf.readUInt32LE(at + 12);
  const base = buf.readUInt32LE(at + 16);
  const functionCount = buf.readUInt32LE(at + 20);
  const nameCount = buf.readUInt32LE(at + 24);
  const namesRva = buf.readUInt32LE(at + 32);
  const namesOff = offsetOf(namesRva);
  const out = [];
  if (namesOff >= 0) {
    for (let i = 0; i < Math.min(nameCount, 500); i++) {
      if (namesOff + i * 4 + 4 > buf.length) break;
      const n = readCString(buf.readUInt32LE(namesOff + i * 4), 256);
      if (n) out.push(n);
    }
  }
  return { dllName: nameRva ? readCString(nameRva, 256) : null, base, functionCount, names: [...new Set(out)] };
}

function parsePdb(buf, dir, offsetOf) {
  if (!dir?.rva || dir.size < 28) return null;
  const at = offsetOf(dir.rva);
  if (at < 0 || at + 24 > buf.length) return null;
  const size = buf.readUInt32LE(at + 16);
  const ptr = buf.readUInt32LE(at + 24);
  if (!ptr || ptr + size > buf.length) return null;
  const sig = buf.toString('latin1', ptr, ptr + 4);
  if (sig !== 'RSDS') return null;
  const end = buf.indexOf(0, ptr + 24);
  return end > 0 ? buf.toString('latin1', ptr + 24, Math.min(end, ptr + 24 + 512)).replace(/[^\x20-\x7e]/g, '') : null;
}

function overlaySize(buf, sections) {
  let end = 0;
  for (const s of sections) end = Math.max(end, s.rawPointer + s.rawSize);
  return Math.max(0, buf.length - end);
}

function sectionFlags(c) {
  const f = [];
  if (c & 0x20000000) f.push('exec');
  if (c & 0x40000000) f.push('read');
  if (c & 0x80000000) f.push('write');
  if (c & 0x00000040) f.push('initialized-data');
  if (c & 0x00000020) f.push('code');
  return f;
}

function coffFlags(c) {
  const f = [];
  if (c & 0x0002) f.push('executable');
  if (c & 0x2000) f.push('dll');
  if (c & 0x0001) f.push('relocations-stripped');
  if (c & 0x0100) f.push('32-bit');
  return f;
}

function dllFlags(c) {
  const f = [];
  if (c & 0x0040) f.push('high-entropy-va');
  if (c & 0x0100) f.push('NX-compatible');
  if (c & 0x0400) f.push('no-isolation');
  if (c & 0x0080) f.push('dynamic-base');
  return f;
}

const SUBSYSTEMS = {
  1: 'native',
  2: 'Windows GUI',
  3: 'Windows CUI (console)',
  9: 'Windows CE',
  10: 'EFI application',
  14: 'Xbox',
};

function packerHints(sections, imports) {
  const hints = [];
  const names = sections.map((s) => s.name.toLowerCase());
  if (names.some((n) => n.startsWith('upx'))) hints.push('UPX packer section names');
  if (names.some((n) => /aspack|mpress|themida|vmp|enigma|petite/.test(n))) hints.push('known packer section name');
  if (sections.length <= 3) hints.push('very few sections');
  if (sections.some((s) => s.entropy > 7.5)) hints.push('high-entropy section (packed or encrypted data)');
  if (!imports.length) hints.push('no imports (unusual; packed or statically linked)');
  return hints;
}

export function entropy(buf) {
  if (!buf.length) return 0;
  const counts = new Array(256).fill(0);
  for (let i = 0; i < buf.length; i++) counts[buf[i]]++;
  let e = 0;
  for (const c of counts) if (c) {
    const p = c / buf.length;
    e -= p * Math.log2(p);
  }
  return Math.round(e * 100) / 100;
}
