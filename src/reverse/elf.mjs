/** Dependency-free ELF reader: header, sections, program headers, dynamic libraries, symbols. */
import { entropy } from './pe.mjs';

const MACHINES = {
  3: 'x86 (32-bit)',
  62: 'x86-64',
  40: 'ARM',
  183: 'ARM64',
  8: 'MIPS',
  20: 'PowerPC',
  243: 'RISC-V',
};
const TYPES = { 1: 'relocatable', 2: 'executable', 3: 'shared object / PIE', 4: 'core dump' };

export function isElf(buf) {
  return buf.length > 4 && buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46;
}

export function parseElf(buf) {
  if (!isElf(buf)) return { format: 'none' };
  const cls = buf[4] === 2 ? 64 : 32;
  const le = buf[5] !== 2;
  const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const u64 = (o) => Number(le ? buf.readBigUInt64LE(o) : buf.readBigUInt64BE(o));
  const word = cls === 64 ? u64 : u32;
  try {
    const type = u16(16);
    const machine = u16(18);
    const entry = word(24);
    const phoff = cls === 64 ? u64(32) : u32(28);
    const shoff = cls === 64 ? u64(40) : u32(32);
    const phentsize = u16(cls === 64 ? 54 : 42);
    const phnum = u16(cls === 64 ? 56 : 44);
    const shentsize = u16(cls === 64 ? 58 : 46);
    const shnum = u16(cls === 64 ? 60 : 48);
    const shstrndx = u16(cls === 64 ? 62 : 50);
    const sections = [];
    for (let i = 0; i < Math.min(shnum, 200); i++) {
      const at = shoff + i * shentsize;
      if (at + shentsize > buf.length) break;
      const s = {
        nameOff: u32(at),
        type: u32(at + 4),
        flags: cls === 64 ? u64(at + 8) : u32(at + 8),
        addr: cls === 64 ? u64(at + 16) : u32(at + 12),
        offset: cls === 64 ? u64(at + 24) : u32(at + 16),
        size: cls === 64 ? u64(at + 32) : u32(at + 20),
        link: u32(at + (cls === 64 ? 40 : 24)),
        entsize: cls === 64 ? u64(at + 56) : u32(at + 36),
      };
      s.data = buf.subarray(s.offset, Math.min(buf.length, s.offset + s.size));
      s.entropy = entropy(s.data);
      sections.push(s);
    }
    const shstr = sections[shstrndx];
    const strAt = (table, off) => {
      if (!table?.data || off >= table.data.length) return null;
      const end = table.data.indexOf(0, off);
      return table.data.toString('latin1', off, end < 0 ? table.data.length : end).replace(/[^\x20-\x7e]/g, '');
    };
    for (const s of sections) s.name = strAt(shstr, s.nameOff) || '';
    const dynstr = sections.find((s) => s.type === 3) || sections.find((s) => s.name === '.dynstr');
    const dynamic = sections.find((s) => s.type === 6) || sections.find((s) => s.name === '.dynamic');
    const needed = [];
    if (dynamic?.data) {
      const step = cls === 64 ? 16 : 8;
      for (let o = 0; o + step <= dynamic.data.length; o += step) {
        const tag = cls === 64 ? Number(dynamic.data.readBigInt64LE(o)) : dynamic.data.readInt32LE(o);
        const val = cls === 64 ? Number(dynamic.data.readBigUInt64LE(o + 8)) : dynamic.data.readUInt32LE(o + 4);
        if (tag === 0) break;
        if (tag === 1) {
          const n = strAt(dynstr, val);
          if (n) needed.push(n);
        }
      }
    }
    const symtab = sections.find((s) => s.type === 11) || sections.find((s) => s.type === 2);
    const symstr = symtab ? sections[symtab.link] : null;
    const symbols = [];
    if (symtab?.data && symstr?.data) {
      const step = cls === 64 ? 24 : 16;
      const count = Math.min(20_000, Math.floor(symtab.data.length / step));
      for (let i = 0; i < count && symbols.length < 4000; i++) {
        const o = i * step;
        const nameOff = symtab.data.readUInt32LE(o);
        const shndx = symtab.data.readUInt16LE(o + (cls === 64 ? 6 : 14));
        if (!nameOff || shndx === 0) continue;
        const name = strAt(symstr, nameOff);
        if (name && !name.startsWith('$') && name.length > 1) symbols.push(name);
      }
    }
    const segments = [];
    for (let i = 0; i < Math.min(phnum, 100); i++) {
      const at = phoff + i * phentsize;
      if (at + phentsize > buf.length) break;
      const ptype = u32(at);
      if (ptype !== 1) continue;
      segments.push({
        type: 'PT_LOAD',
        flags: u32(at + 4),
        offset: cls === 64 ? u64(at + 8) : u32(at + 4),
        vaddr: cls === 64 ? u64(at + 16) : u32(at + 8),
        filesz: cls === 64 ? u64(at + 32) : u32(at + 16),
        memsz: cls === 64 ? u64(at + 40) : u32(at + 20),
      });
    }
    return {
      format: 'elf',
      label: cls === 64 ? 'ELF 64-bit' : 'ELF 32-bit',
      class: cls,
      endianness: le ? 'little-endian' : 'big-endian',
      type: TYPES[type] || `type ${type}`,
      typeId: type,
      machine: MACHINES[machine] || `machine ${machine}`,
      machineId: machine,
      entry,
      interpreter: sections.find((s) => s.name === '.interp')?.data?.toString('latin1').replace(/\0.*$/, '') || null,
      needed: [...new Set(needed)],
      sections: sections.map((s) => ({ name: s.name, type: s.type, addr: s.addr, size: s.size, entropy: s.entropy })),
      segments,
      symbols: [...new Set(symbols)],
      stripped: !sections.some((s) => s.type === 2),
      packerHints: [
        ...(sections.some((s) => s.entropy > 7.6 && s.size > 4096) ? ['high-entropy section (packed or encrypted data)'] : []),
        ...(sections.length <= 3 ? ['very few sections'] : []),
      ],
    };
  } catch (err) {
    return { format: 'elf', error: err.message };
  }
}
