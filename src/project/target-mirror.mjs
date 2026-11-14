/**
 * Sleep & Reverse: a read-only, agent-friendly MIRROR of the analysis target inside the workspace.
 *
 * Why a mirror instead of letting the agent read the target folder:
 *  - The target must stay untouched, and OpenCode's permission rules cannot tell "read" from
 *    "write" for folders outside the project (both are `external_directory`). Denying the target
 *    therefore also denied reading it — the agent could not see the program it had to analyse.
 *    The mirror lives inside the project, where reads are free and edits can be denied per path.
 *  - Real programs carry huge single lines: a 76 MB single-file HTML app had a 59-million-character
 *    base64 ONNX model on one line. One `read` or `grep` of that line floods the model's context.
 *    The mirror keeps every line NUMBER identical to the original but replaces the content of
 *    over-long lines with a one-line summary, so `file:line` citations stay valid for the target.
 *  - SleepPilot itself identifies what the blobs are (WASM, ONNX/protobuf model, PDF, images,
 *    bundled JS libraries…), indexes script blocks and functions, and records SHA-1 hashes so the
 *    run can prove at the end that the target was not modified.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const MIRROR_DIR = '_target';
export const MAP_FILE = 'TARGET_MAP.md';
const SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv', '.idea', '.vs']);
const MAX_FILES = 20_000;
const MAX_TEXT_BYTES = 256 * 1024 * 1024; // processed as text up to this size
const MAX_MIRROR_TOTAL = 300 * 1024 * 1024;
const LONG_LINE = 4000;
const TEXT_EXT = /\.(html?|xhtml|svg|css|m?js|cjs|jsx|tsx?|json|jsonc|xml|txt|md|csv|tsv|ini|cfg|conf|toml|ya?ml|py|pyw|lua|c|cc|cpp|h|hpp|cs|java|kt|go|rs|rb|php|sh|bat|cmd|ps1|sql|glsl|hlsl|shader|fx|gd|tscn|tres|lst|log|properties|gradle|sln|csproj|vcxproj|mk|cmake)$/i;

const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');

async function sha1File(file) {
  const h = crypto.createHash('sha1');
  for await (const chunk of fs.createReadStream(file)) h.update(chunk);
  return h.digest('hex');
}

/** Identify a byte buffer by magic number / content. */
export function sniff(bytes) {
  const b = Buffer.from(bytes);
  const asc = b.toString('latin1');
  if (b.length >= 4 && b[0] === 0x00 && asc.slice(1, 4) === 'asm') return { kind: 'wasm', label: 'WebAssembly module' };
  if (asc.startsWith('%PDF')) return { kind: 'pdf', label: 'PDF document' };
  if (b[0] === 0x89 && asc.slice(1, 4) === 'PNG') return { kind: 'png', label: 'PNG image' };
  if (b[0] === 0xff && b[1] === 0xd8) return { kind: 'jpeg', label: 'JPEG image' };
  if (asc.startsWith('GIF8')) return { kind: 'gif', label: 'GIF image' };
  if (asc.startsWith('RIFF') && asc.slice(8, 12) === 'WEBP') return { kind: 'webp', label: 'WebP image' };
  if (asc.startsWith('PK\u0003\u0004')) return { kind: 'zip', label: 'ZIP archive (also .docx/.xlsx/.jar…)' };
  if (b[0] === 0x1f && b[1] === 0x8b) return { kind: 'gzip', label: 'gzip data' };
  if (asc.startsWith('wOF2') || asc.startsWith('wOFF')) return { kind: 'font', label: 'Web font (WOFF)' };
  if (asc.startsWith('MZ')) return { kind: 'exe', label: 'Windows executable (PE)' };
  const printable = [...b.slice(0, 512)].filter((c) => c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127) || c >= 160).length / Math.max(1, Math.min(512, b.length));
  if (printable > 0.95) {
    const text = b.toString('utf8');
    const lib = text.match(/ONNX Runtime[^\n]*|PDF\.js|pdfjs-dist|licstart[\s\S]{0,200}?(Mozilla|Apache|MIT)[^\n]*|React v[\d.]+|jQuery v[\d.]+|three\.js|TensorFlow\.js/i);
    return { kind: 'text', label: lib ? `Text/JavaScript - looks like: ${lib[0].replace(/\s+/g, ' ').slice(0, 80)}` : 'Text', preview: text.slice(0, 240) };
  }
  if (/onnx|pytorch|tensorflow|keras/i.test(asc.slice(0, 2048)) && b[0] < 0x40) return { kind: 'model', label: `Machine-learning model, protobuf (mentions: ${[...new Set((asc.slice(0, 2048).match(/onnx|pytorch|tensorflow|keras/gi) || []).map((s) => s.toLowerCase()))].join(', ')})` };
  return { kind: 'binary', label: 'Unknown binary data' };
}

const B64 = /^[A-Za-z0-9+/=\s]+$/;

function decodeHead(b64, n = 4096) {
  try {
    return Buffer.from(b64.slice(0, n).replace(/\s+/g, '').replace(/=+$/, '').slice(0, Math.floor(n / 4) * 4), 'base64');
  } catch {
    return Buffer.alloc(0);
  }
}

/** Describe an over-long line: embedded script/data blob, data: URIs, minified code. */
function describeLongLine(line) {
  const tag = line.slice(0, 600).match(/<script\b([^>]*)>/i);
  const out = { chars: line.length };
  if (tag) {
    out.tag = 'script';
    out.id = (tag[1].match(/\bid\s*=\s*["']([^"']+)/) || [])[1] || null;
    out.type = (tag[1].match(/\btype\s*=\s*["']([^"']+)/) || [])[1] || null;
    const start = line.indexOf('>', line.indexOf(tag[0])) + 1;
    const end = line.lastIndexOf('</script');
    const body = line.slice(start, end > start ? end : undefined);
    if (body.length > 64 && B64.test(body.slice(0, 2000)) && B64.test(body.slice(-200))) {
      const clean = body.replace(/\s+/g, '');
      out.encoding = 'base64';
      out.decodedBytes = Math.floor((clean.length * 3) / 4) - (clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0);
      out.content = sniff(decodeHead(clean));
    } else {
      out.content = sniff(Buffer.from(body.slice(0, 2048)));
      out.encoding = 'text';
    }
  }
  const uris = [...line.matchAll(/data:([\w/+.-]+);base64,/g)].map((m) => m[1]);
  if (uris.length) out.dataUris = Object.entries(uris.reduce((a, m) => ((a[m] = (a[m] || 0) + 1), a), {})).map(([mime, count]) => ({ mime, count }));
  if (!tag && !uris.length) out.content = { kind: 'code', label: 'Very long line (minified code or inline data)' };
  return out;
}

function summaryLine(line, info, ref) {
  const head = line.slice(0, 240).replace(/[A-Za-z0-9+/=]{120,}$/, (m) => m.slice(0, 40));
  const what = info.content?.label || 'data';
  const size = info.decodedBytes ? `${fmtBytes(info.decodedBytes)} decoded` : `${info.chars.toLocaleString('en-US')} chars`;
  return `${head} ...[SleepPilot mirror: ${info.chars} characters omitted - ${what}, ${size}; see ${MIRROR_DIR}/${MAP_FILE} ${ref}]... ${line.slice(-60)}`;
}

const fmtBytes = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);

/** Script/style blocks and a small symbol index (functions, classes, event handlers) of a text file. */
function indexText(lines, rel) {
  const blocks = [];
  const symbols = [];
  let open = null;
  lines.forEach((l, i) => {
    const n = i + 1;
    const s = l.length > LONG_LINE ? l.slice(0, 400) : l;
    if (/\.html?$/i.test(rel)) {
      const m = s.match(/<(script|style)\b([^>]*)>/i);
      if (m && !open && !/\bsrc\s*=/.test(m[2])) {
        const type = (m[2].match(/\btype\s*=\s*["']([^"']+)/) || [])[1] || (m[1] === 'script' ? 'text/javascript' : 'text/css');
        const id = (m[2].match(/\bid\s*=\s*["']([^"']+)/) || [])[1] || null;
        open = { tag: m[1].toLowerCase(), type, id, start: n };
      }
      if (open && new RegExp(`</${open.tag}>`, 'i').test(l.slice(-200))) {
        blocks.push({ ...open, end: n });
        open = null;
      }
    }
    if (l.length > LONG_LINE) return;
    let m;
    if ((m = s.match(/^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*([\w$]+)\s*\(/))) symbols.push({ line: n, kind: 'function', name: m[1] });
    else if ((m = s.match(/^\s*(?:export\s+)?class\s+([\w$]+)/))) symbols.push({ line: n, kind: 'class', name: m[1] });
    else if ((m = s.match(/^\s*(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[\w$]+\s*=>)/))) symbols.push({ line: n, kind: 'function', name: m[1] });
    else if ((m = s.match(/^\s*([\w$]+(?:\.prototype)?\.[\w$]+)\s*=\s*(?:async\s+)?function\b/))) symbols.push({ line: n, kind: 'function', name: m[1] });
    else if ((m = s.match(/^\s*def\s+([\w]+)\s*\(/))) symbols.push({ line: n, kind: 'def', name: m[1] });
    if ((m = s.match(/addEventListener\(\s*['"]([\w:-]+)['"]/))) symbols.push({ line: n, kind: 'event', name: m[1] });
  });
  if (open) blocks.push({ ...open, end: lines.length });
  return { blocks, symbols };
}

/**
 * Build or refresh the mirror. Returns the map (also written as JSON + Markdown into the mirror).
 * The mirror folder is replaced as a whole, so files removed from the target disappear too.
 */
export async function buildTargetMirror({ targetDir, targetFile, workDir }) {
  const mirror = path.join(workDir, MIRROR_DIR);
  const single = targetFile ? path.resolve(targetFile) : null;
  if (single) {
    const st = await fsp.stat(single).catch(() => null);
    if (!st?.isFile()) throw new Error(`The target file was not found: ${single}`);
  }
  const tgt = single ? path.dirname(single) : path.resolve(targetDir);
  const workResolved = path.resolve(workDir);
  if (workResolved.toLowerCase().startsWith(tgt.toLowerCase() + path.sep) || workResolved.toLowerCase() === tgt.toLowerCase()) throw new Error('The workspace cannot be inside the target.');
  await fsp.rm(mirror, { recursive: true, force: true });
  await fsp.mkdir(mirror, { recursive: true });
  const files = [];
  let mirrored = 0;
  let truncated = false;

  async function addFile(full, rel) {
    const st = await fsp.stat(full).catch(() => null);
    if (!st?.isFile()) return;
    const rec = { file: rel, bytes: st.size, sha1: await sha1File(full) };
    const head = Buffer.alloc(Math.min(8192, st.size));
    const fd = await fsp.open(full, 'r');
    await fd.read(head, 0, head.length, 0);
    await fd.close();
    const isText = TEXT_EXT.test(rel) ? !head.includes(0) : !head.includes(0) && sniff(head).kind === 'text';
    if (!isText) {
      rec.kind = sniff(head).label;
      rec.mirrored = false;
      files.push(rec);
      return;
    }
    if (st.size > MAX_TEXT_BYTES || mirrored > MAX_MIRROR_TOTAL) {
      rec.kind = 'Text (too large to mirror)';
      rec.mirrored = false;
      files.push(rec);
      return;
    }
    // latin1 maps every byte to one char and back, so the mirror is byte-identical to the
    // original (any encoding, CRLF kept) except for the summarised over-long lines.
    const text = (await fsp.readFile(full)).toString('latin1');
    const lines = text.split('\n');
    const longLines = [];
    const out = lines.map((l, i) => {
      if (l.length <= LONG_LINE) return l;
      const info = { line: i + 1, ...describeLongLine(l) };
      longLines.push(info);
      return summaryLine(l, info, `(${rel}:${i + 1})`);
    });
    const body = Buffer.from(out.join('\n'), 'latin1');
    const dest = path.join(mirror, ...rel.split('/'));
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.writeFile(dest, body);
    mirrored += body.length;
    Object.assign(rec, { kind: 'Text', mirrored: true, lines: lines.length - (lines.at(-1) === '' ? 1 : 0), mirrorBytes: body.length, longLines, ...indexText(lines, rel) });
    files.push(rec);
  }

  async function walk(dir) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (files.length >= MAX_FILES) return void (truncated = true);
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) await walk(full);
        continue;
      }
      if (!e.isFile()) continue;
      await addFile(full, path.relative(tgt, full).split(path.sep).join('/'));
    }
  }
  if (single) await addFile(single, path.basename(single));
  else await walk(tgt);
  const map = { targetDir: tgt, targetPath: single || tgt, targetIsFile: !!single, builtAt: Date.now(), truncated, files };
  await fsp.writeFile(path.join(mirror, 'target-map.json'), JSON.stringify(map, null, 2));
  await fsp.writeFile(path.join(mirror, MAP_FILE), mapMarkdown(map));
  return map;
}

function mapMarkdown(map) {
  const L = [];
  const total = map.files.reduce((a, f) => a + f.bytes, 0);
  L.push(`# Target map (generated by SleepPilot — do not edit)`);
  L.push('');
  L.push(`Target: \`${map.targetDir}\` — ${map.files.length} files, ${fmtBytes(total)}${map.truncated ? ' (file limit reached; listing truncated)' : ''}. Built ${new Date(map.builtAt).toISOString()}.`);
  L.push('');
  L.push(`Text files are mirrored under \`${MIRROR_DIR}/\` with the SAME line numbers as the original. Lines longer than ${LONG_LINE} characters are replaced by a one-line summary (see "Embedded data"). Cite evidence as \`relative/path.ext:LINE\` or \`relative/path.ext:START-END\` (paths relative to the target root). Binary files are listed but not mirrored.`);
  L.push('');
  L.push('## Files');
  L.push('| File | Size | Type | Lines | SHA-1 |');
  L.push('|---|---|---|---|---|');
  for (const f of map.files.slice(0, 500)) L.push(`| \`${f.file}\` | ${fmtBytes(f.bytes)} | ${f.kind}${f.mirrored ? '' : ' (not mirrored)'} | ${f.lines ?? '—'} | \`${f.sha1.slice(0, 12)}\` |`);
  if (map.files.length > 500) L.push(`| … ${map.files.length - 500} more (see target-map.json) | | | | |`);
  const long = map.files.flatMap((f) => (f.longLines || []).map((l) => ({ file: f.file, ...l })));
  if (long.length) {
    L.push('');
    L.push('## Embedded data and over-long lines');
    L.push('| Where | Element | Encoding | Size | Content |');
    L.push('|---|---|---|---|---|');
    for (const l of long.slice(0, 300)) {
      const el = l.tag ? `\`<script${l.id ? ` id="${l.id}"` : ''}${l.type ? ` type="${l.type}"` : ''}>\`` : '—';
      const size = `${l.chars.toLocaleString('en-US')} chars${l.decodedBytes ? ` → ${fmtBytes(l.decodedBytes)}` : ''}`;
      const uris = l.dataUris ? ` data: URIs ${l.dataUris.map((d) => `${d.mime}×${d.count}`).join(', ')}` : '';
      L.push(`| \`${l.file}:${l.line}\` | ${el} | ${l.encoding || '—'} | ${size} | ${(l.content?.label || '').replace(/\|/g, '/')}${uris} |`);
    }
  }
  const withBlocks = map.files.filter((f) => f.blocks?.length);
  if (withBlocks.length) {
    L.push('');
    L.push('## Script and style blocks');
    for (const f of withBlocks) for (const b of f.blocks.slice(0, 200)) L.push(`- \`${f.file}:${b.start}-${b.end}\` <${b.tag}${b.id ? ` id="${b.id}"` : ''}> ${b.type}`);
  }
  const withSyms = map.files.filter((f) => f.symbols?.length);
  if (withSyms.length) {
    L.push('');
    L.push('## Symbol index (functions, classes, event listeners)');
    for (const f of withSyms) {
      L.push(`### \`${f.file}\``);
      L.push(f.symbols.slice(0, 600).map((s) => `${s.kind === 'event' ? `on:${s.name}` : s.name}@${s.line}`).join(' · '));
    }
  }
  return L.join('\n') + '\n';
}

/** Compare the target with the hashes recorded in a map: which files changed / vanished / appeared. */
export async function verifyTargetUnchanged(map) {
  const changed = [];
  const missing = [];
  for (const f of map.files) {
    const full = path.join(map.targetDir, ...f.file.split('/'));
    const st = await fsp.stat(full).catch(() => null);
    if (!st) missing.push(f.file);
    else if (st.size !== f.bytes || (await sha1File(full)) !== f.sha1) changed.push(f.file);
  }
  return { files: map.files.length, changed, missing, ok: !changed.length && !missing.length };
}

export async function readMirrorMap(workDir) {
  try {
    return JSON.parse(await fsp.readFile(path.join(workDir, MIRROR_DIR, 'target-map.json'), 'utf8'));
  } catch {
    return null;
  }
}

export { sha1 };
