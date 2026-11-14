import fsp from 'node:fs/promises';
import path from 'node:path';
import { IGNORED_DIRS } from '../project/snapshot.mjs';
import { isGeneratedPath } from '../project/generated.mjs';

/**
 * Upfront scope analysis for the Project and Reverse & Rust screens.
 *
 * This is deliberately local and deterministic: it reads file names/sizes (and text lines for
 * code projects) and turns them into a practical time/scope suggestion. It never calls a model,
 * never modifies the project and never reads generated/build directories.
 */
const LANG = {
  '.js': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript', '.jsx': 'JavaScript',
  '.ts': 'TypeScript', '.tsx': 'TypeScript', '.vue': 'Vue', '.svelte': 'Svelte',
  '.py': 'Python', '.rs': 'Rust', '.go': 'Go', '.java': 'Java', '.kt': 'Kotlin',
  '.c': 'C', '.h': 'C/C++', '.cc': 'C++', '.cpp': 'C++', '.hpp': 'C++', '.cs': 'C#',
  '.rb': 'Ruby', '.php': 'PHP', '.swift': 'Swift', '.dart': 'Dart', '.lua': 'Lua',
  '.sh': 'Shell', '.ps1': 'PowerShell', '.sql': 'SQL', '.html': 'HTML', '.htm': 'HTML',
  '.css': 'CSS', '.scss': 'CSS', '.md': 'Markdown', '.json': 'JSON', '.toml': 'TOML',
  '.yml': 'YAML', '.yaml': 'YAML',
};
const CODE_LANGS = new Set(['JavaScript', 'TypeScript', 'Vue', 'Svelte', 'Python', 'Rust', 'Go', 'Java', 'Kotlin', 'C', 'C/C++', 'C++', 'C#', 'Ruby', 'PHP', 'Swift', 'Dart', 'Lua', 'Shell', 'PowerShell', 'SQL', 'HTML', 'CSS']);
const TEST_RE = /(^|[\\/])(tests?|spec|__tests__)([\\/]|$)|\.(test|spec)\.[^.]+$/i;
const MAX_FILES = 20_000;
const MAX_READ = 2 * 1024 * 1024;

export async function analyzeProjectScope(dir, { inspection = null } = {}) {
  const root = path.resolve(dir);
  const metrics = {
    files: 0, sourceFiles: 0, lines: 0, codeLines: 0, testFiles: 0, todoCount: 0,
    binaryFiles: 0, generatedFiles: 0, largest: [], languages: {}, extensions: {},
  };
  const risks = [];
  const readCap = 60 * 1024 * 1024;
  let readTotal = 0;
  let hasReadme = false;
  let hasTests = false;
  let hasPackage = false;

  async function visit(current, depth) {
    if (depth > 8 || metrics.files >= MAX_FILES || readTotal > readCap) return;
    const entries = await fsp.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (metrics.files >= MAX_FILES || readTotal > readCap) return;
      const full = path.join(current, e.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (e.isDirectory()) {
        if (!IGNORED_DIRS.has(e.name)) await visit(full, depth + 1);
        continue;
      }
      if (!e.isFile()) continue;
      metrics.files++;
      if (/^readme(\.|$)/i.test(e.name)) hasReadme = true;
      if (/^package\.json$|^cargo\.toml$|^pyproject\.toml$|^go\.mod$/i.test(e.name)) hasPackage = true;
      if (isGeneratedPath(rel)) {
        metrics.generatedFiles++;
        continue;
      }
      const st = await fsp.stat(full).catch(() => null);
      if (!st) continue;
      const ext = path.extname(e.name).toLowerCase() || '(none)';
      metrics.extensions[ext] = (metrics.extensions[ext] || 0) + 1;
      const lang = LANG[ext];
      const isCode = !!lang && CODE_LANGS.has(lang);
      if (isCode) {
        metrics.sourceFiles++;
        metrics.languages[lang] = (metrics.languages[lang] || 0) + 1;
      }
      if (TEST_RE.test(rel)) {
        metrics.testFiles++;
        hasTests = true;
      }
      metrics.largest.push({ file: rel, bytes: st.size });
      if (st.size > MAX_READ && isCode) {
        risks.push(`Large source file: ${rel} (${(st.size / 1024 / 1024).toFixed(1)} MB) — read it in ranges.`);
      }
      if (!isCode || st.size > MAX_READ || readTotal > readCap) {
        if (!isCode && st.size > 0 && !lang) metrics.binaryFiles++;
        continue;
      }
      const buf = await fsp.readFile(full).catch(() => null);
      if (!buf || buf.includes(0)) {
        metrics.binaryFiles++;
        continue;
      }
      readTotal += buf.length;
      const text = buf.toString('utf8');
      metrics.lines += text.split('\n').length;
      const code = text.split('\n').filter((l) => l.trim() && !/^\s*(\/\/|#|\*|\/\*)/.test(l)).length;
      metrics.codeLines += code;
      metrics.todoCount += (text.match(/\b(TODO|FIXME|HACK|XXX)\b/g) || []).length;
    }
  }
  await visit(root, 0);
  metrics.largest = metrics.largest.sort((a, b) => b.bytes - a.bytes).slice(0, 15);
  metrics.languages = Object.fromEntries(Object.entries(metrics.languages).sort((a, b) => b[1] - a[1]));
  metrics.extensions = Object.fromEntries(Object.entries(metrics.extensions).sort((a, b) => b[1] - a[1]).slice(0, 15));

  const sizeClass = metrics.codeLines < 500 ? 'tiny' : metrics.codeLines < 5_000 ? 'small' : metrics.codeLines < 25_000 ? 'medium' : metrics.codeLines < 100_000 ? 'large' : 'huge';
  const primaryLanguage = Object.keys(metrics.languages)[0] || (inspection?.kinds?.[0] || 'unknown');
  if (metrics.codeLines === 0 && metrics.files > 0) risks.push('No source code was found; the objective may describe a new project or a non-code folder.');
  if (!hasTests) risks.push('No tests were found; SleepPilot will rely on command checks you add.');
  if (!hasReadme) risks.push('No README was found; the agent has less project context.');
  if (metrics.todoCount > 20) risks.push(`${metrics.todoCount} TODO/FIXME markers exist; the objective should say which ones matter.`);
  if (metrics.generatedFiles > 0) risks.push(`${metrics.generatedFiles} generated/build files are excluded from line counts.`);
  if (inspection?.git && !inspection.git.isRepo) risks.push('The folder is not a Git repository; a pre-run backup is recommended.');

  const baseHours = { tiny: 0.75, small: 1.5, medium: 3, large: 5, huge: 8 }[sizeClass];
  let hours = baseHours;
  if (!hasTests) hours *= 1.25;
  if (metrics.todoCount > 20) hours *= 1.1;
  hours = Math.round(Math.min(12, Math.max(0.5, hours)) * 2) / 2;
  const maxIterations = Math.max(8, Math.min(120, Math.round((metrics.codeLines || 300) / 180)));
  const parallelDevelopers = sizeClass === 'medium' || sizeClass === 'large' || sizeClass === 'huge' ? 2 : 1;
  const scopeSummary = {
    tiny: 'One focused change (usually 1–3 files); keep the task list short.',
    small: 'One feature slice or a small refactor; 2–5 concrete tasks.',
    medium: 'One module or subsystem at a time; split shared files into integration tasks.',
    large: 'Work module-by-module with a small parallel wave; do not attempt a broad rewrite in one run.',
    huge: 'Narrow the objective to one subsystem; use a longer run and frequent checkpoints.',
  }[sizeClass];
  const risksList = [...new Set(risks)].slice(0, 8);
  const confidence = metrics.files ? (metrics.codeLines > 0 ? 'high' : 'medium') : 'low';
  return {
    kind: 'project',
    dir: root,
    sizeClass,
    primaryLanguage,
    metrics: { ...metrics, hasTests, hasReadme, hasPackage, isRepo: !!inspection?.git?.isRepo, dirty: !!inspection?.git?.dirty },
    estimate: {
      hours,
      durationMin: Math.round(hours * 60),
      maxIterations,
      parallelDevelopers,
      maxTurnMin: sizeClass === 'huge' ? 60 : 45,
      reviewerEnabled: true,
      permissionProfile: hours >= 4 ? 'full' : 'balanced',
      unattended: hours >= 4,
    },
    scope: { summary: scopeSummary, sizeClass, language: primaryLanguage },
    risks: risksList,
    confidence,
    analyzedAt: Date.now(),
  };
}

/**
 * Preview a reverse-engineering target before a workspace exists. File names, sizes and magic
 * headers only; the full recon still runs when the workspace is created.
 */
export async function analyzeTargetScope(targetPath, { mode = 'rust' } = {}) {
  const target = path.resolve(String(targetPath || ''));
  const st = await fsp.stat(target).catch(() => null);
  if (!st) throw new Error(`The target was not found: ${target}`);
  const root = st.isDirectory() ? target : path.dirname(target);
  const metrics = { files: 0, bytes: 0, textFiles: 0, binaryFiles: 0, extensions: {}, binaries: [], largest: [] };
  const risks = [];
  const maxFiles = 20_000;
  async function addFile(full, rel) {
    if (metrics.files >= maxFiles) return;
    const info = await fsp.stat(full).catch(() => null);
    if (!info?.isFile()) return;
    metrics.files++;
    metrics.bytes += info.size;
    const ext = path.extname(full).toLowerCase() || '(none)';
    metrics.extensions[ext] = (metrics.extensions[ext] || 0) + 1;
    metrics.largest.push({ file: rel, bytes: info.size });
    const head = Buffer.alloc(Math.min(512, info.size));
    const fd = await fsp.open(full, 'r');
    try {
      await fd.read(head, 0, head.length, 0);
    } finally {
      await fd.close();
    }
    const binary = looksBinary(head) || /\.(exe|dll|so|dylib|bin|dat|pak|pck|class|jar|apk|zip|7z|png|jpe?g|gif|webp|mp3|ogg|wav|mp4|ttf|otf|woff2?)$/i.test(ext);
    if (binary) {
      metrics.binaryFiles++;
      if (metrics.binaries.length < 40) metrics.binaries.push({ file: rel, bytes: info.size, kind: sniffSimple(head) });
    } else metrics.textFiles++;
  }
  if (st.isFile()) await addFile(target, path.basename(target));
  else {
    async function walk(dir, depth) {
      if (depth > 8 || metrics.files >= maxFiles) return;
      const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (!IGNORED_DIRS.has(e.name)) await walk(full, depth + 1);
        } else if (e.isFile()) await addFile(full, path.relative(root, full).split(path.sep).join('/'));
      }
    }
    await walk(target, 0);
  }
  metrics.largest = metrics.largest.sort((a, b) => b.bytes - a.bytes).slice(0, 15);
  metrics.extensions = Object.fromEntries(Object.entries(metrics.extensions).sort((a, b) => b[1] - a[1]).slice(0, 15));
  if (metrics.binaryFiles && !metrics.textFiles) risks.push('Only binary files were found; the dossier will depend on static binary analysis and external tools.');
  if (metrics.bytes > 500 * 1024 * 1024) risks.push('The target is large (>500 MB); mirroring/recon can take several minutes.');
  if (metrics.binaries.some((b) => /PE|ELF|Mach-O/.test(b.kind))) risks.push('Native binaries detected; use the recon headers/imports and a disassembler for behaviour.');
  if (metrics.textFiles === 0) risks.push('No readable source/text files; Rust reconstruction will be specification-driven.');
  const sizeClass = metrics.bytes < 2 * 1024 * 1024 ? 'tiny' : metrics.bytes < 25 * 1024 * 1024 ? 'small' : metrics.bytes < 250 * 1024 * 1024 ? 'medium' : 'large';
  const reconMinutes = Math.max(1, Math.ceil(metrics.files / 400 + metrics.binaryFiles * 0.2));
  const baseHours = mode === 'rust'
    ? { tiny: 2, small: 4, medium: 7, large: 10 }[sizeClass]
    : { tiny: 1, small: 2, medium: 3.5, large: 5 }[sizeClass];
  const hours = Math.round(Math.min(12, baseHours + reconMinutes / 60) * 2) / 2;
  return {
    kind: 'reverse-target',
    targetPath: target,
    targetIsFile: st.isFile(),
    mode,
    sizeClass,
    metrics,
    estimate: {
      hours,
      durationMin: Math.round(hours * 60),
      reconMinutes,
      maxIterations: Math.max(12, Math.min(100, Math.round(metrics.files / 100 + (mode === 'rust' ? 25 : 10)))),
      parallelDevelopers: 1,
    },
    scope: {
      summary: mode === 'rust'
        ? `Analyze ${metrics.textFiles} text/source file(s) and ${metrics.binaryFiles} binary file(s), write a spec, then build a Rust implementation.`
        : `Map ${metrics.textFiles} text/source file(s) and ${metrics.binaryFiles} binary file(s) into a cited dossier.`,
    },
    risks: [...new Set(risks)].slice(0, 8),
    confidence: metrics.files ? 'medium' : 'low',
    analyzedAt: Date.now(),
  };
}

function looksBinary(buf) {
  return buf.includes(0);
}
function sniffSimple(buf) {
  const asc = buf.toString('latin1');
  if (asc.startsWith('MZ')) return 'Windows PE';
  if (buf[0] === 0x7f && asc.slice(1, 4) === 'ELF') return 'ELF';
  if (/^\xca\xfe\xba\xbe|\xfe\xed\xfa|\xcf\xfa\xed\xfe/.test(asc)) return 'Mach-O';
  if (asc.startsWith('PK')) return 'ZIP/archive';
  if (asc.startsWith('%PDF')) return 'PDF';
  return 'binary';
}
