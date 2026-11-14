import fsp from 'node:fs/promises';
import path from 'node:path';
import { parsePe, isPe, entropy } from './pe.mjs';
import { parseElf, isElf } from './elf.mjs';
import { parseMachO, isMachO } from './macho.mjs';
import { extractStrings, interestingStrings, summarizeStrings } from './strings.mjs';
import { MIRROR_DIR, MAP_FILE } from '../project/target-mirror.mjs';
import { runFile } from '../util/proc.mjs';

export const RECON_DIR = '_recon';
const MAX_BINARY_BYTES = 96 * 1024 * 1024;
const MAX_BINARIES = 120;
const MAX_STRING_READ = 64 * 1024 * 1024;

/**
 * Build a machine-generated reconnaissance bundle for a target (folder or single file):
 *   _recon/RECON.md       human/agent readable overview
 *   _recon/recon.json     structured data
 *   _recon/binaries.json  headers, imports/exports, strings, archive listings
 *
 * Everything here is read-only and dependency-free. It gives the agent a strong head start
 * before it reads the mirrored source or runs its own analysis commands.
 */
export async function runRecon({ targetPath, workDir, map = null, mirrorMapPath = null }) {
  const target = path.resolve(targetPath);
  const st = await fsp.stat(target).catch(() => null);
  if (!st) throw new Error(`The analysis target was not found: ${target}`);
  const targetIsFile = st.isFile();
  const mapData = map || (await readMap(mirrorMapPath || path.join(workDir, MIRROR_DIR, 'target-map.json')));
  const files = mapData?.files || [];
  const reconDir = path.join(workDir, RECON_DIR);
  await fsp.mkdir(reconDir, { recursive: true });

  const inventory = summarizeInventory(files);
  const tools = await detectReverseTools();
  const binaries = [];
  const candidates = files
    .filter((f) => !f.mirrored && f.bytes > 0)
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, MAX_BINARIES);
  for (const f of candidates) {
    const full = path.join(mapData.targetDir || (targetIsFile ? path.dirname(target) : target), ...f.file.split('/'));
    const bin = await analyzeBinary(full, f, target);
    if (bin) binaries.push(bin);
  }
  const text = summarizeText(files, mapData);
  const recon = {
    tool: 'SleepPilot Recon',
    version: 2,
    createdAt: Date.now(),
    targetPath: target,
    targetIsFile,
    targetRoot: mapData?.targetDir || (targetIsFile ? path.dirname(target) : target),
    targetBytes: st.isFile() ? st.size : inventory.totalBytes,
    mirrorMap: `${MIRROR_DIR}/${MAP_FILE}`,
    inventory,
    text,
    binaries: binaries.map((b) => ({ ...b, strings: { summary: b.strings.summary, interesting: b.strings.interesting } })),
    tools,
  };
  await fsp.writeFile(path.join(reconDir, 'recon.json'), JSON.stringify(recon, null, 2));
  await fsp.writeFile(
    path.join(reconDir, 'binaries.json'),
    JSON.stringify(
      binaries.map((b) => ({ ...b, strings: { summary: b.strings.summary, interesting: b.strings.interesting } })),
      null,
      2,
    ),
  );
  await fsp.writeFile(path.join(reconDir, 'RECON.md'), reconMarkdown(recon));
  await fsp.writeFile(path.join(reconDir, 'TOOLS.md'), await toolsMarkdown(tools));
  return { recon, reconDir, binaries: binaries.length, tools };
}

async function readMap(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

function summarizeInventory(files) {
  const byExt = {};
  const byKind = {};
  let totalBytes = 0;
  let textFiles = 0;
  let binaryFiles = 0;
  for (const f of files) {
    const ext = (path.extname(f.file) || '(none)').toLowerCase();
    byExt[ext] = (byExt[ext] || 0) + 1;
    byKind[f.kind] = (byKind[f.kind] || 0) + 1;
    totalBytes += f.bytes || 0;
    if (f.mirrored) textFiles++;
    else binaryFiles++;
  }
  const largest = [...files].sort((a, b) => (b.bytes || 0) - (a.bytes || 0)).slice(0, 40);
  return {
    files: files.length,
    totalBytes,
    textFiles,
    binaryFiles,
    byExtension: sortObject(byExt),
    byKind: sortObject(byKind),
    largest: largest.map((f) => ({ file: f.file, bytes: f.bytes, kind: f.kind, mirrored: !!f.mirrored, sha1: f.sha1 })),
  };
}

function summarizeText(files, mapData) {
  const text = files.filter((f) => f.mirrored);
  let lines = 0;
  let symbols = 0;
  let blocks = 0;
  let longLines = 0;
  for (const f of text) {
    lines += f.lines || 0;
    symbols += f.symbols?.length || 0;
    blocks += f.blocks?.length || 0;
    longLines += f.longLines?.length || 0;
  }
  const topSymbols = text
    .filter((f) => f.symbols?.length)
    .sort((a, b) => (b.symbols?.length || 0) - (a.symbols?.length || 0))
    .slice(0, 20)
    .map((f) => ({ file: f.file, lines: f.lines, symbols: f.symbols.slice(0, 40) }));
  return { mirroredFiles: text.length, lines, symbols, scriptBlocks: blocks, longLines, topSymbols, truncated: !!mapData?.truncated };
}

async function analyzeBinary(full, f, target) {
  const info = await fsp.stat(full).catch(() => null);
  if (!info?.isFile()) return null;
  const readBytes = Math.min(info.size, info.size > MAX_STRING_READ ? MAX_STRING_READ : info.size);
  const fd = await fsp.open(full, 'r');
  const buf = Buffer.alloc(readBytes);
  try {
    await fd.read(buf, 0, readBytes, 0);
  } finally {
    await fd.close();
  }
  let parsed = { format: 'unknown', label: 'binary' };
  if (isPe(buf)) parsed = parsePe(buf);
  else if (isElf(buf)) parsed = parseElf(buf);
  else if (isMachO(buf)) parsed = parseMachO(buf);
  else if (buf[0] === 0x50 && buf[1] === 0x4b) {
    const zip = listZip(buf);
    parsed = { format: 'zip', label: 'ZIP archive (JAR/APK/DOCX/asset package)', entries: zip.entries, entryCount: zip.count, truncated: zip.truncated };
  } else if (buf.length >= 4 && buf[0] === 0x00 && buf[1] === 0x61 && buf[2] === 0x73 && buf[3] === 0x6d) {
    parsed = { format: 'wasm', label: 'WebAssembly module' };
  } else {
    parsed = { format: 'unknown', label: f.kind || 'binary', entropy: entropy(buf.subarray(0, Math.min(buf.length, 4 * 1024 * 1024))) };
  }
  const strings = info.size > MAX_STRING_READ ? [] : extractStrings(buf, { max: 5000 });
  const report = {
    file: f.file,
    bytes: info.size,
    sha1: f.sha1,
    readBytes,
    truncatedRead: info.size > readBytes,
    format: parsed.format,
    label: parsed.label || f.kind,
    parsed,
    strings: {
      summary: summarizeStrings(strings),
      interesting: interestingStrings(strings, 120),
      sample: strings.slice(0, 20).map((s) => s.text),
    },
  };
  if (parsed.format === 'zip') report.parsed = { ...parsed, entries: (parsed.entries || []).slice(0, 400) };
  return report;
}

// ------------------------------------------------------------------ tool detection

const TOOL_PROBES = [
  { id: 'cargo', name: 'Rust / Cargo', args: ['--version'], why: 'Builds and tests the Rust implementation.' },
  { id: 'rustc', name: 'rustc', args: ['--version'], why: 'Rust compiler.' },
  { id: 'git', name: 'Git', args: ['--version'], why: 'Version control and diffing.' },
  { id: 'python', name: 'Python', args: ['--version'], why: 'Analysis scripts.' },
  { id: 'node', name: 'Node.js', args: ['--version'], why: 'SleepPilot itself and JavaScript analysis.' },
  { id: 'objdump', name: 'objdump (binutils)', args: ['--version'], why: 'Disassembly and section inspection.' },
  { id: 'dumpbin', name: 'dumpbin (Visual Studio)', args: ['/?'], why: 'PE headers, imports and exports.' },
  { id: 'strings', name: 'strings', args: ['--version'], why: 'Extracting strings from binaries.' },
  { id: 'r2', name: 'radare2', args: ['-v'], why: 'Disassembly, analysis and binary patching.' },
  { id: 'rizin', name: 'Rizin', args: ['-v'], why: 'Modern radare2 fork.' },
  { id: 'ilspycmd', name: 'ilspycmd', args: ['--version'], why: 'Decompiling .NET assemblies to C#.' },
  { id: 'de4dot', name: '.NET deobfuscator (de4dot)', args: ['--help'], why: 'Deobfuscating .NET assemblies.' },
  { id: '7z', name: '7-Zip', args: [], why: 'Opening archives and Unity/Unreal packages.' },
  { id: 'ghidra', name: 'Ghidra', manual: true, why: 'Headless decompilation (analyzeHeadless).' },
  { id: 'ida', name: 'IDA Pro', manual: true, why: 'Commercial disassembler/decompiler (if licensed).' },
  { id: 'cutter', name: 'Cutter / Rizin GUI', manual: true, why: 'Interactive reverse engineering.' },
];

async function detectReverseTools() {
  const rows = await Promise.all(
    TOOL_PROBES.map(async (t) => {
      if (t.manual) {
        const found = await findProgramDir(t.id);
        return { id: t.id, name: t.name, why: t.why, status: found ? 'found' : 'not-configured', detail: found || 'Not detected automatically.', install: t.id === 'ghidra' ? 'https://ghidra-sre.org/' : null };
      }
      const r = await runFile(t.id, t.args, { timeoutMs: 12_000 });
      const text = `${r.stdout || ''}${r.stderr || ''}`.trim().split('\n')[0].slice(0, 160);
      return { id: t.id, name: t.name, why: t.why, status: r.error ? 'missing' : r.exitCode === 0 || text ? 'found' : 'unknown', detail: text || null };
    }),
  );
  return rows;
}

async function findProgramDir(id) {
  const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA, process.env.USERPROFILE].filter(Boolean);
  const patterns = id === 'ghidra' ? [/^ghidra/i] : id === 'ida' ? [/^ida/i, /^idapro/i] : [/^cutter/i, /^rizin/i];
  for (const root of roots) {
    const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (patterns.some((re) => re.test(e.name))) return path.join(root, e.name);
    }
  }
  return null;
}

async function toolsMarkdown(tools) {
  const rows = tools.map((t) => `| ${t.name} | ${t.status} | ${(t.detail || '').replace(/\|/g, '/')} | ${t.why} |`).join('\n');
  return `# Reverse-engineering tools on this machine\n\n| Tool | Status | Detail | Why it matters |\n|---|---|---|---|\n${rows}\n\nSleepPilot does not install anything. Commands are run only from analysis tasks you approve.\n`;
}

// ------------------------------------------------------------------ markdown

function reconMarkdown(r) {
  const L = [];
  L.push(`# Reconnaissance — ${path.basename(r.targetPath)}`);
  L.push('');
  L.push(`Generated by SleepPilot at ${new Date(r.createdAt).toISOString()}. Target: \`${r.targetPath}\`${r.targetIsFile ? ' (single file)' : ''}. Processed read-only; the target was not modified.`);
  L.push('');
  L.push(`Text source is mirrored under \`${MIRROR_DIR}/\` with original line numbers (\`${r.mirrorMap}\`). Cite source as \`path/file.ext:LINE\`.`);
  L.push('');
  L.push('## 1. What this appears to be');
  L.push('');
  const kinds = Object.entries(r.inventory.byKind).sort((a, b) => b[1] - a[1]);
  L.push(`- ${r.inventory.files} files, ${fmtBytes(r.inventory.totalBytes)}; ${r.inventory.textFiles} text/mirrored, ${r.inventory.binaryFiles} binary/other.`);
  L.push(`- File kinds: ${kinds.map(([k, n]) => `${k} ×${n}`).join(', ') || 'none'}.`);
  const formats = [...new Set(r.binaries.map((b) => b.format))].filter((f) => f && f !== 'unknown');
  if (formats.length) L.push(`- Binary formats: ${formats.join(', ')}.`);
  const exts = Object.entries(r.inventory.byExtension).sort((a, b) => b[1] - a[1]).slice(0, 15);
  L.push(`- Most common extensions: ${exts.map(([e, n]) => `${e} ×${n}`).join(', ')}.`);
  L.push('');
  L.push('## 2. Inventory (largest files)');
  L.push('');
  L.push('| File | Size | Kind | SHA-1 |');
  L.push('|---|---|---|---|');
  for (const f of r.inventory.largest.slice(0, 40)) L.push(`| \`${f.file}\` | ${fmtBytes(f.bytes)} | ${f.kind}${f.mirrored ? '' : ' (binary)'} | \`${(f.sha1 || '').slice(0, 12)}\` |`);
  if (r.inventory.files > 40) L.push(`| … ${r.inventory.files - 40} more files (see recon.json) | | | |`);
  L.push('');
  L.push('## 3. Binary analysis');
  L.push('');
  if (!r.binaries.length) L.push('No binary files were found (or all files are text/source).');
  for (const b of r.binaries) {
    L.push(`### ${b.file} — ${b.label}${b.truncatedRead ? ' (head only)' : ''}`);
    L.push('');
    L.push(`${fmtBytes(b.bytes)}; format ${b.format}; SHA-1 \`${(b.sha1 || '').slice(0, 16)}\`.`);
    if (b.format === 'pe') peSection(b, L);
    else if (b.format === 'elf') elfSection(b, L);
    else if (b.format === 'macho') machoSection(b, L);
    else if (b.format === 'zip') zipSection(b, L);
    else if (b.format === 'wasm') L.push('- WebAssembly module: export/import analysis can be done with `wasm-objdump` or a small parser.');
    else L.push(`- Entropy: ${b.parsed.entropy ?? 'n/a'}. No parser matched; inspect with strings/hex tools.`);
    const inter = b.strings.interesting || {};
    const groups = Object.entries(inter);
    if (groups.length) {
      L.push('');
      L.push('**Notable strings**');
      for (const [kind, list] of groups) {
        L.push(`- *${kind}*: ${list.slice(0, 12).map((s) => `\`${s.text.slice(0, 160).replace(/`/g, '\\`')}\``).join(', ')}`);
      }
    }
    L.push('');
  }
  L.push('## 4. Text and source');
  L.push('');
  L.push(`${r.text.mirroredFiles} files mirrored, ${r.text.lines.toLocaleString('en-US')} lines, ${r.text.symbols} indexed symbols, ${r.text.scriptBlocks} script/style blocks, ${r.text.longLines} over-long lines summarized.`);
  if (r.text.topSymbols.length) {
    L.push('');
    L.push('| File | Lines | Symbols (first 40) |');
    L.push('|---|---|---|');
    for (const t of r.text.topSymbols) L.push(`| \`${t.file}\` | ${t.lines} | ${t.symbols.map((s) => `${s.kind === 'event' ? 'on:' : ''}${s.name}@${s.line}`).join(' · ')} |`);
  }
  L.push('');
  L.push('## 5. Tools available locally');
  L.push('');
  L.push(`| Tool | Status | Detail |`);
  L.push(`|---|---|---|`);
  for (const t of r.tools) L.push(`| ${t.name} | ${t.status} | ${(t.detail || '').replace(/\|/g, '/')} |`);
  L.push('');
  L.push('## 6. Suggested analysis order');
  L.push('');
  const order = [
    'Identify the program type, entry points and framework from this report and the file tree.',
    'Map the user-visible behaviour and data flow; write `INVENTORY.md` and `ARCHITECTURE.md` with `file:line` evidence.',
    'Decode the file formats and stored data; write `FORMATS.md` with field layouts and value ranges.',
    'Document the algorithms and decision logic (thresholds, constants, state machines) with citations.',
    'Write `SPEC.md`: an implementation-ready description of the behaviour, inputs/outputs, edge cases and test vectors.',
    r.binaries.length ? 'For binaries, use headers/imports/exports/strings above; run objdump/rizin/Ghidra headless only on files you may analyse.' : 'Confirm the text mirror is complete; note anything summarized in TARGET_MAP.md.',
  ];
  order.forEach((s, i) => L.push(`${i + 1}. ${s}`));
  if (r.binaries.length) {
    L.push('');
    L.push('## 7. Binary evidence');
    L.push('');
    L.push('Binary claims cannot use `file:line` citations. Cite the binary as `binary:path` plus the section, import table, offset or string offset from `recon.json`, and mark uncertainty.');
  }
  L.push('');
  return L.join('\n');
}

function peSection(b, L) {
  const p = b.parsed;
  L.push(`- ${p.machine}, ${p.subsystem}, ${p.pe32plus ? 'PE32+' : 'PE32'}; entry RVA 0x${(p.entryRva || 0).toString(16)}; image base 0x${(p.imageBase || 0).toString(16)}.`);
  if (p.clr) L.push('- **.NET / CLR assembly** (managed code).');
  if (p.timestamp) L.push(`- Link timestamp: ${p.timestamp}.`);
  if (p.pdb) L.push(`- PDB: \`${p.pdb}\`.`);
  if (p.overlayBytes) L.push(`- Overlay after the last section: ${fmtBytes(p.overlayBytes)} (installer data or appended payload).`);
  if (p.packerHints?.length) L.push(`- Packer hints: ${p.packerHints.join('; ')}.`);
  if (p.sections?.length) {
    L.push('');
    L.push('| Section | RVA | Raw | Entropy | Flags |');
    L.push('|---|---|---|---|---|');
    for (const s of p.sections) L.push(`| \`${s.name}\` | 0x${s.virtualAddress.toString(16)} | ${fmtBytes(s.rawSize)} | ${s.entropy} | ${s.flags.join(', ')} |`);
  }
  if (p.imports?.length) {
    L.push('');
    L.push('**Imports**');
    for (const dll of p.imports.slice(0, 40)) L.push(`- \`${dll.dll}\`: ${dll.functions.slice(0, 25).join(', ')}${dll.functions.length > 25 ? ` … (+${dll.functions.length - 25})` : ''}`);
  }
  if (p.exports?.names?.length) L.push(`\n**Exports**: ${p.exports.names.slice(0, 60).join(', ')}${p.exports.names.length > 60 ? ' …' : ''}`);
}

function elfSection(b, L) {
  const p = b.parsed;
  L.push(`- ${p.machine}, ${p.type}, ${p.endianness}; entry 0x${(p.entry || 0).toString(16)}; stripped: ${p.stripped ? 'yes' : 'no'}.`);
  if (p.interpreter) L.push(`- Interpreter: \`${p.interpreter}\`.`);
  if (p.needed?.length) L.push(`- Needed libraries: ${p.needed.map((n) => `\`${n}\``).join(', ')}.`);
  if (p.packerHints?.length) L.push(`- Packer hints: ${p.packerHints.join('; ')}.`);
  if (p.sections?.length) L.push(`- Sections: ${p.sections.slice(0, 30).map((s) => `\`${s.name || s.type}\``).join(', ')}.`);
  if (p.symbols?.length) L.push(`- Symbols (${p.symbols.length}): ${p.symbols.slice(0, 40).join(', ')}${p.symbols.length > 40 ? ' …' : ''}.`);
}

function machoSection(b, L) {
  const p = b.parsed;
  L.push(`- ${p.cpu}, ${p.filetype}${p.universal ? ', universal binary' : ''}.`);
  if (p.libraries?.length) L.push(`- Libraries: ${p.libraries.map((n) => `\`${n}\``).join(', ')}.`);
}

function zipSection(b, L) {
  const p = b.parsed;
  L.push(`- ${p.entryCount} entries${p.truncated ? ' (listing truncated)' : ''}.`);
  if (p.entries?.length) L.push(`- First entries: ${p.entries.slice(0, 30).map((e) => `\`${e.name}\` (${fmtBytes(e.size)})`).join(', ')}.`);
}

// ------------------------------------------------------------------ zip listing

export function listZip(buf) {
  const entries = [];
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66_000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return { entries, count: 0, truncated: false };
  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < Math.min(count, 2000) && at + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) break;
    const method = buf.readUInt16LE(at + 10);
    const size = buf.readUInt32LE(at + 24);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const name = buf.toString('utf8', at + 46, Math.min(buf.length, at + 46 + nameLen)).replace(/[^\x20-\x7e]/g, '');
    entries.push({ name, size, method: method === 0 ? 'stored' : method === 8 ? 'deflate' : method });
    at += 46 + nameLen + extraLen + commentLen;
  }
  return { entries, count, truncated: count > entries.length };
}

// ------------------------------------------------------------------ helpers

const fmtBytes = (n) => (!n ? '0 B' : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);
const sortObject = (o) => Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1]));
