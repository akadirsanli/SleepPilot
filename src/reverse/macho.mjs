/** Minimal Mach-O reader: header, architecture and linked dylibs (enough for a recon report). */
const CPUS = { 7: 'x86', 0x01000007: 'x86-64', 12: 'ARM', 0x0100000c: 'ARM64', 18: 'PowerPC', 0x01000012: 'PowerPC64' };

export function isMachO(buf) {
  if (buf.length < 28) return false;
  const magic = buf.readUInt32BE(0);
  return [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe].includes(magic);
}

export function parseMachO(buf) {
  if (!isMachO(buf)) return { format: 'none' };
  const magic = buf.readUInt32BE(0);
  const le = magic === 0xcefaedfe || magic === 0xcffaedfe;
  const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const is64 = magic === 0xfeedfacf || magic === 0xcffaedfe;
  const cputype = u32(4);
  const filetype = u32(12);
  const ncmds = u32(16);
  const libs = [];
  let at = is64 ? 32 : 28;
  const names = { 1: 'object', 2: 'executable', 6: 'dynamic library', 8: 'bundle' };
  try {
    for (let i = 0; i < Math.min(ncmds, 400) && at + 8 <= buf.length; i++) {
      const cmd = u32(at);
      const size = u32(at + 4);
      if (cmd === 0xc || cmd === 0x8000001c || cmd === 0x1f) {
        const nameOff = u32(at + 8);
        const start = at + nameOff;
        if (start > at && start < at + size && start < buf.length) {
          const end = buf.indexOf(0, start);
          const name = buf.toString('latin1', start, end > 0 ? Math.min(end, start + 512) : start + 64).replace(/[^\x20-\x7e]/g, '');
          if (name) libs.push(name);
        }
      }
      if (size < 8) break;
      at += size;
    }
    return {
      format: 'macho',
      label: is64 ? 'Mach-O 64-bit' : 'Mach-O',
      cpu: CPUS[cputype] || `cputype ${cputype}`,
      filetype: names[filetype] || `filetype ${filetype}`,
      libraries: [...new Set(libs)],
      universal: magic === 0xcafebabe,
    };
  } catch (err) {
    return { format: 'macho', error: err.message };
  }
}
