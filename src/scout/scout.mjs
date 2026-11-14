import fsp from 'node:fs/promises';
import path from 'node:path';
import { IGNORED_DIRS } from '../project/snapshot.mjs';
import { isGeneratedPath } from '../project/generated.mjs';
import { isPe, parsePe } from '../reverse/pe.mjs';
import { isElf, parseElf } from '../reverse/elf.mjs';
import { isMachO, parseMachO } from '../reverse/macho.mjs';
import { extractStrings } from '../reverse/strings.mjs';

/**
 * Scout is SleepPilot's local discovery agent.
 *
 * It answers two questions before a run starts:
 *  1. What stack does this project use? (from manifests and source files — no EXE picker)
 *  2. What runtime/framework is this program? (from its own headers, imports and strings)
 *
 * It is deterministic and read-only. The app merges its required-tool list with the live
 * toolchain status and can turn its suggested checks into real project checks.
 */
export class ScoutAgent {
  async project(dir, { inspection = null } = {}) {
    return scanProject(dir, { inspection });
  }

  async target(targetPath) {
    return scanTarget(targetPath);
  }
}

const MANIFESTS = new Set([
  'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'tsconfig.json',
  'cargo.toml', 'cargo.lock', 'pyproject.toml', 'requirements.txt', 'setup.py', 'pipfile', 'poetry.lock',
  'go.mod', 'go.sum', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts',
  'package.swift', 'pubspec.yaml', 'composer.json', 'gemfile', 'cmakelists.txt', 'makefile', 'meson.build',
  'dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'project.godot', 'global.json', 'tauri.conf.json',
]);
const EXT_LANG = {
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascript',
  '.ts': 'typescript', '.tsx': 'typescript', '.vue': 'vue', '.svelte': 'svelte',
  '.py': 'python', '.rs': 'rust', '.go': 'go', '.java': 'java', '.kt': 'kotlin',
  '.cs': 'dotnet', '.fs': 'dotnet', '.vb': 'dotnet', '.c': 'c', '.h': 'c', '.cc': 'cpp', '.cpp': 'cpp',
  '.hpp': 'cpp', '.swift': 'swift', '.dart': 'dart', '.php': 'php', '.rb': 'ruby', '.lua': 'lua',
};

export async function scanProject(dir, { inspection = null } = {}) {
  const root = path.resolve(dir);
  const files = [];
  const manifests = [];
  const extCounts = {};
  let scanned = 0;
  async function walk(current, depth) {
    if (depth > 4 || scanned > 6000) return;
    const entries = await fsp.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (scanned++ > 6000) return;
      const full = path.join(current, e.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (e.isDirectory()) {
        if (!IGNORED_DIRS.has(e.name)) await walk(full, depth + 1);
        continue;
      }
      if (!e.isFile() || isGeneratedPath(rel)) continue;
      files.push(rel);
      const lower = e.name.toLowerCase();
      const ext = path.extname(lower);
      if (EXT_LANG[ext]) extCounts[EXT_LANG[ext]] = (extCounts[EXT_LANG[ext]] || 0) + 1;
      if (MANIFESTS.has(lower) || /\.(sln|csproj|fsproj|vbproj|uproject|xcodeproj)$/i.test(lower) || /(^|\/)projectsettings\/projectversion\.txt$/i.test(rel)) manifests.push(rel.toLowerCase());
    }
  }
  await walk(root, 0);
  const stacks = [];
  const evidence = [];
  const checks = [];
  const tools = new Set(['git']);
  let frameworks = [];
  const addStack = (id, label, confidence, why, extra = {}) => {
    stacks.push({ id, label, confidence, evidence: why, ...extra });
    evidence.push(why);
  };
  const addCheck = (name, command, why) => {
    if (!checks.some((c) => c.command === command)) checks.push({ name, command, why });
  };
  const has = (re) => files.some((f) => re.test(f));
  const manifestHas = (name) => manifests.some((f) => f === name || f.endsWith(`/${name}`));
  const manifestPath = (name) => manifests.find((f) => f === name || f.endsWith(`/${name}`)) || name;

  if (manifestHas('package.json')) {
    const pkg = await readJson(path.join(root, manifestPath('package.json')));
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    const pm = files.includes('pnpm-lock.yaml') ? 'pnpm' : files.includes('yarn.lock') ? 'yarn' : files.includes('bun.lockb') ? 'bun' : 'npm';
    const fw = deps.filter((d) => /^(react|vue|svelte|next|nuxt|electron|@tauri-apps|express|fastify|vite|astro|angular|solid-js)/.test(d));
    frameworks.push(...fw);
    addStack('node', 'Node.js / JavaScript', 0.95, `package.json with ${deps.length} dependencies (${pm})`, { packageManager: pm, frameworks: fw });
    tools.add('node');
    tools.add(pm === 'pnpm' ? 'pnpm' : 'npm');
    if (fw.includes('electron')) tools.add('node');
    if (pkg.scripts?.test && !/no test specified/i.test(pkg.scripts.test)) addCheck(`${pm} test`, `${pm} test`, 'package.json test script');
    if (pkg.scripts?.build) addCheck(`${pm} run build`, `${pm} run build`, 'package.json build script');
    if (pkg.scripts?.lint) addCheck(`${pm} run lint`, `${pm} run lint`, 'package.json lint script');
    if (has(/^tsconfig\.json$/i) || has(/\.tsx?$/i)) addStack('typescript', 'TypeScript', 0.9, 'tsconfig.json or TypeScript source files');
    if (files.some((f) => /(^|\/)tauri\.conf\.json$/i.test(f))) {
      addStack('tauri', 'Tauri desktop app', 0.9, 'tauri.conf.json');
      tools.add('cargo'); tools.add('rustc'); frameworks.push('tauri');
    }
  }
  if (manifestHas('cargo.toml') || extCounts.rust) {
    addStack('rust', 'Rust', 0.97, manifestHas('cargo.toml') ? 'Cargo.toml' : 'Rust source files');
    tools.add('cargo'); tools.add('rustc');
    addCheck('cargo test', 'cargo test --quiet', 'Rust unit/integration tests');
    addCheck('cargo check', 'cargo check --quiet', 'Rust type/borrow check');
  }
  if (manifestHas('pyproject.toml') || manifestHas('requirements.txt') || manifestHas('setup.py') || extCounts.python) {
    const py = await readText(path.join(root, manifestPath('pyproject.toml'))).catch(() => '') + await readText(path.join(root, manifestPath('requirements.txt'))).catch(() => '');
    const fw = ['django', 'flask', 'fastapi', 'pytest', 'torch', 'tensorflow'].filter((x) => new RegExp(`\\b${x}\\b`, 'i').test(py));
    frameworks.push(...fw);
    addStack('python', 'Python', 0.9, manifestHas('pyproject.toml') ? 'pyproject.toml' : extCounts.python ? 'Python source files' : 'requirements.txt', { frameworks: fw });
    tools.add('python3');
    if (fw.includes('pytest') || has(/(^|\/)tests?\//i)) addCheck('pytest', 'python -m pytest -q', 'Python tests');
    else addCheck('python compile', 'python -m compileall -q .', 'Python syntax check of the project');
  }
  if (manifestHas('go.mod') || extCounts.go) {
    addStack('go', 'Go', 0.95, manifestHas('go.mod') ? 'go.mod' : 'Go source files');
    tools.add('go');
    addCheck('go test', 'go test ./...', 'Go test packages');
    addCheck('go vet', 'go vet ./...', 'Go static check');
  }
  const dotnetManifest = manifests.find((f) => /\.(sln|csproj|fsproj|vbproj)$/i.test(f)) || manifests.find((f) => /projectsettings\/projectversion\.txt$/i.test(f));
  if (dotnetManifest || extCounts.dotnet) {
    const unity = manifests.some((f) => /projectsettings\/projectversion\.txt$/i.test(f)) || has(/(^|\/)assets\/(?=.*\.cs$)/i);
    if (unity) {
      frameworks.push('unity');
      addStack('unity', 'Unity (C#/.NET)', 0.9, 'Unity ProjectSettings/Assets');
    } else addStack('dotnet', '.NET / C#', 0.9, dotnetManifest || 'C# source files');
    tools.add('dotnet');
    if (manifests.some((f) => /(\.tests?\.csproj|\.spec\.csproj)$/i.test(f)) || has(/(^|\/)tests?\//i)) addCheck('dotnet test', 'dotnet test', '.NET test projects');
    else addCheck('dotnet build', 'dotnet build', '.NET build');
  }
  if (manifests.some((f) => /(^|\/)(pom\.xml|build\.gradle(\.kts)?)$/i.test(f)) || extCounts.java || extCounts.kotlin) {
    addStack(extCounts.kotlin ? 'kotlin' : 'java', extCounts.kotlin ? 'Kotlin / JVM' : 'Java / JVM', 0.9, 'Maven/Gradle or JVM sources');
    tools.add('java');
    if (files.includes('pom.xml')) addCheck('mvn test', 'mvn -q test', 'Maven tests');
    else addCheck('gradle test', process.platform === 'win32' ? 'gradlew.bat test' : './gradlew test', 'Gradle tests');
  }
  if (manifests.some((f) => /(^|\/)(cmakelists\.txt|meson\.build)$/i.test(f)) || extCounts.c || extCounts.cpp) {
    addStack('cpp', 'C / C++', 0.85, 'CMake/Meson or native sources');
    tools.add('cmake');
    if (manifests.some((f) => /(^|\/)makefile$/i.test(f))) tools.add('make');
  }
  if (has(/(^|\/)dockerfile$/i) || manifests.some((f) => /docker-compose/i.test(f))) {
    addStack('docker', 'Docker', 0.85, 'Dockerfile / compose file');
    tools.add('docker');
  }
  if (manifestHas('project.godot')) {
    addStack('godot', 'Godot', 0.95, 'project.godot');
  }
  if (manifests.some((f) => /\.uproject$/i.test(f))) {
    addStack('unreal', 'Unreal Engine', 0.9, '.uproject');
  }
  if (manifests.some((f) => /package\.swift$/i.test(f)) || extCounts.swift) {
    addStack('swift', 'Swift', 0.9, 'Package.swift or Swift sources');
  }
  if (manifestHas('pubspec.yaml') || extCounts.dart) {
    addStack('dart', 'Dart / Flutter', 0.9, 'pubspec.yaml or Dart sources');
  }
  // A source-only project with no manifest still gets useful evidence from extensions.
  if (!stacks.length && Object.keys(extCounts).length) {
    const primary = Object.entries(extCounts).sort((a, b) => b[1] - a[1])[0];
    const label = { javascript: 'JavaScript', typescript: 'TypeScript', html: 'HTML', css: 'CSS', csharp: 'C#' }[primary[0]] || primary[0][0].toUpperCase() + primary[0].slice(1);
    addStack(primary[0], label, 0.55, `${primary[1]} source files, no recognised manifest`);
    if (['javascript', 'typescript', 'vue', 'svelte'].includes(primary[0])) { tools.add('node'); tools.add('npm'); }
    if (primary[0] === 'python') tools.add('python3');
    if (primary[0] === 'rust') { tools.add('cargo'); tools.add('rustc'); }
    if (primary[0] === 'go') tools.add('go');
    if (primary[0] === 'dotnet') tools.add('dotnet');
    if (['java', 'kotlin'].includes(primary[0])) tools.add('java');
  }
  if (!stacks.length) addStack('unknown', 'Unrecognised project', 0.2, 'No manifest or source files were found');
  const primary = [...stacks].sort((a, b) => b.confidence - a.confidence)[0];
  const risks = [];
  if (!files.length) risks.push('No files were found in the project.');
  if (!manifests.length) risks.push('No manifest was found; dependency and test commands could not be inferred.');
  if (inspection?.git && !inspection.git.isRepo) risks.push('Not a Git repository; previews/backups are recommended before a run.');
  if (!checks.length) risks.push('No automatic check could be inferred; add one that proves the objective.');
  return {
    kind: 'project',
    dir: root,
    primary: primary.id,
    stacks,
    frameworks: [...new Set(frameworks)],
    tools: [...tools],
    checks: checks.slice(0, 8),
    files: files.length,
    manifests,
    evidence: [...new Set(evidence)],
    risks,
    summary: `${primary.label}${frameworks.length ? ` (${frameworks.slice(0, 3).join(', ')})` : ''} · ${files.length} file(s) · ${checks.length} suggested check(s)`,
    confidence: primary.confidence,
    generatedAt: Date.now(),
  };
}

export async function scanTarget(targetPath) {
  const target = path.resolve(String(targetPath || ''));
  const st = await fsp.stat(target).catch(() => null);
  if (!st) throw new Error(`The target was not found: ${target}`);
  const candidates = [];
  if (st.isFile()) candidates.push(target);
  else {
    async function walk(dir, depth) {
      if (depth > 6 || candidates.length > 40) return;
      const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        if (candidates.length > 40) return;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (!IGNORED_DIRS.has(e.name)) await walk(full, depth + 1);
        } else if (e.isFile() && /\.(exe|dll|so|dylib|bin|elf|jar|apk|zip|pyc|class|asar|app|unity3d|pck)$/i.test(e.name)) candidates.push(full);
      }
    }
    await walk(target, 0);
    // Include a few largest files if the extension list missed an unusual binary.
    if (candidates.length < 5) {
      const entries = await fsp.readdir(target, { withFileTypes: true }).catch(() => []);
      const sized = [];
      for (const e of entries) {
        if (!e.isFile()) continue;
        const full = path.join(target, e.name);
        const info = await fsp.stat(full).catch(() => null);
        if (info) sized.push({ full, size: info.size });
      }
      for (const s of sized.sort((a, b) => b.size - a.size).slice(0, 8)) candidates.push(s.full);
    }
  }
  const reports = [];
  for (const file of candidates.slice(0, 12)) reports.push(await inspectProgram(file));
  const found = reports.filter((r) => r.format !== 'unknown');
  const primary = found.sort((a, b) => b.score - a.score)[0] || reports[0] || null;
  if (!primary) throw new Error('No likely program files were found in the target.');
  const runtime = primary.runtime || 'Native / unknown';
  const tools = new Set(primary.tools || []);
  const notes = [...(primary.notes || [])];
  const risks = [];
  if (!found.length) risks.push('No recognised executable/header was found; the dossier may have to work from text and file names.');
  if (primary.packed) risks.push('The binary looks packed or high-entropy; unpack it before relying on strings.');
  if (primary.format === 'PE' || primary.format === 'ELF' || primary.format === 'Mach-O') {
    tools.add('ghidra'); tools.add('rizin'); tools.add('objdump');
  }
  if (primary.format === 'ZIP/JAR') tools.add('7zip');
  const mode = /\.NET|Unity|Java|Electron|Python|Node/i.test(runtime) || reports.some((r) => r.text) ? 'rust' : 'analyze';
  return {
    kind: 'target',
    targetPath: target,
    targetIsFile: st.isFile(),
    primary: primary.file,
    format: primary.format,
    arch: primary.arch || null,
    runtime,
    frameworks: [...new Set(primary.frameworks || [])],
    tools: [...tools],
    notes: [...new Set(notes)],
    risks,
    recommendedMode: mode,
    programs: reports.filter((r) => r.format !== 'unknown').slice(0, 8).map((r) => ({ file: r.file, format: r.format, runtime: r.runtime, arch: r.arch })),
    summary: `${runtime} · ${primary.format}${primary.arch ? ` ${primary.arch}` : ''} · ${found.length} program(s)`,
    confidence: found.length ? (primary.score > 3 ? 'high' : 'medium') : 'low',
    generatedAt: Date.now(),
  };
}

async function inspectProgram(file) {
  const st = await fsp.stat(file).catch(() => null);
  if (!st) return { file, format: 'unknown', score: 0 };
  const name = path.basename(file);
  const ext = path.extname(name).toLowerCase();
  const handle = await fsp.open(file, 'r').catch(() => null);
  if (!handle) return { file, format: 'unknown', score: 0 };
  let buf;
  try {
    const len = Math.min(st.size, 8 * 1024 * 1024);
    buf = Buffer.alloc(len);
    await handle.read(buf, 0, len, 0);
  } finally {
    await handle.close();
  }
  const text = buf.length < 2 * 1024 * 1024 ? buf.toString('utf8') : '';
  const strings = extractStrings(buf, { max: 6000 }).map((s) => s.text).join('\n');
  const lower = strings.toLowerCase();
  const result = { file, format: 'unknown', arch: null, runtime: 'Unknown', frameworks: [], tools: [], notes: [], score: 0, text: !!text && !buf.includes(0), packed: /upx|themida|vmprotect|aspack/i.test(strings) };
  const has = (...markers) => markers.some((m) => lower.includes(m.toLowerCase()));
  const base = name.toLowerCase();
  if (/^node(?:\.exe)?$/.test(base)) {
    result.runtime = 'Node.js';
    result.tools.push('node');
    result.score += 1;
  } else if (/^python[\d.]*(?:\.exe)?$/.test(base)) {
    result.runtime = 'Python';
    result.tools.push('python3');
    result.score += 1;
  } else if (/^dotnet(?:\.exe)?$/.test(base)) {
    result.runtime = 'Windows .NET';
    result.tools.push('dotnet');
    result.score += 1;
  } else if (/^java(?:w)?(?:\.exe)?$/.test(base)) {
    result.runtime = 'Java / JVM';
    result.tools.push('java');
    result.score += 1;
  } else if (/^godot/.test(base)) {
    result.runtime = 'Godot';
    result.frameworks.push('Godot');
    result.tools.push('7zip');
    result.score += 1;
  }
  if (isPe(buf)) {
    const pe = parsePe(buf);
    result.format = 'PE';
    result.arch = pe.machine || null;
    result.score += 3;
    result.packed = result.packed || (pe.packerHints || []).length > 0;
    if (pe.clr) {
      result.runtime = 'Windows .NET';
      result.tools.push('dotnet', 'ilspycmd');
      result.score += 2;
    }
    const imports = (pe.imports || []).map((i) => i.dll || '').join(' ').toLowerCase();
    if (/unityplayer|unityengine/.test(imports + lower)) {
      result.runtime = 'Unity (C#/.NET)';
      result.frameworks.push('Unity');
      result.tools.push('dotnet', 'ilspycmd');
      result.score += 2;
    } else if (/mono|coreclr|hostfxr|mscoree|mscorlib/.test(imports + lower)) {
      result.runtime = 'Windows .NET';
      result.tools.push('dotnet', 'ilspycmd');
    }
    if (/electron|app\.asar|libnode/.test(lower)) {
      result.runtime = 'Electron / Node.js';
      result.frameworks.push('Electron');
      result.tools.push('node');
    }
    if (/pyinstaller|python3|pyi-/.test(lower)) {
      result.runtime = 'Python (packed)';
      result.tools.push('python3');
    }
    if (/godot/.test(lower)) {
      result.runtime = 'Godot';
      result.frameworks.push('Godot');
      result.tools.push('7zip');
    }
    if (/unrealengine|unreal/.test(lower)) {
      result.runtime = 'Unreal Engine';
      result.frameworks.push('Unreal');
      result.tools.push('7zip');
    }
    if (/go1\.|go build id/.test(lower)) result.runtime = 'Go';
    if (/rustc|rust_backtrace|\.rustc/.test(lower)) result.runtime = 'Rust';
    if (/jvm|java|jli\.dll/.test(imports + lower) && !/javascript/.test(lower)) {
      result.runtime = 'Java / JVM';
      result.frameworks.push('Java');
      result.tools.push('java');
    }
    if (result.runtime === 'Unknown' && pe.machine) result.runtime = 'Native Windows';
    result.tools.push('ghidra', 'rizin', 'objdump');
    if (pe.pdb) result.notes.push(`PDB path: ${pe.pdb}`);
    if (pe.packerHints?.length) result.notes.push(...pe.packerHints);
    if (pe.sections?.length) result.notes.push(`${pe.sections.length} sections; ${pe.imports?.length || 0} imported DLL(s)`);
  } else if (isElf(buf)) {
    const elf = parseElf(buf);
    result.format = 'ELF';
    result.arch = elf.machine || null;
    result.score += 3;
    result.runtime = has('go1.', 'go build id') ? 'Go' : has('rustc', '.rustc') ? 'Rust' : 'Native ELF';
    result.tools.push('ghidra', 'rizin', 'objdump');
    if (elf.needed?.length) result.notes.push(`Needed libraries: ${elf.needed.slice(0, 8).join(', ')}`);
  } else if (isMachO(buf)) {
    const mach = parseMachO(buf);
    result.format = 'Mach-O';
    result.arch = mach.cputype || null;
    result.score += 3;
    result.runtime = 'Native Mach-O';
    result.tools.push('ghidra', 'rizin', 'objdump');
  } else if (/^PK\x03\x04/.test(text || buf.toString('latin1', 0, 4))) {
    result.format = 'ZIP/JAR';
    result.runtime = ext === '.apk' ? 'Android APK' : ext === '.jar' ? 'Java JAR' : 'Archive';
    result.tools.push('7zip');
    if (ext === '.jar' || ext === '.apk') result.tools.push('java');
    result.score += 2;
  } else if (buf[0] === 0xca && buf[1] === 0xfe && buf[2] === 0xba && buf[3] === 0xbe) {
    result.format = 'Java class';
    result.runtime = 'Java / JVM';
    result.tools.push('java');
    result.score += 2;
  } else if (/^#!.*\b(node|python|bash|sh|pwsh|powershell|lua|ruby)\b/i.test(text)) {
    const m = text.match(/^#!.*\b(node|python|bash|sh|pwsh|powershell|lua|ruby)\b/i);
    result.format = 'script';
    result.runtime = m ? `${m[1]} script` : 'script';
    result.tools.push(/python/i.test(result.runtime) ? 'python3' : /node/i.test(result.runtime) ? 'node' : 'git');
    result.score += 2;
  } else if (text && /<html|<!doctype html|package\.json|"dependencies"|import .* from /i.test(text)) {
    result.format = 'text/source';
    result.runtime = /"dependencies"|package\.json|import .* from/i.test(text) ? 'Node.js / JavaScript' : 'HTML / web';
    result.tools.push(/"dependencies"|import .* from/i.test(text) ? 'node' : 'browser');
    result.score += 1;
  } else if (text && /\.(m?js|cjs|jsx|ts|tsx|py|rs|go|java|kt|cs|fs|html?|css|scss|php|rb|lua|swift|dart)$/i.test(name)) {
    const info = {
      '.js': ['Node.js / JavaScript', 'node'], '.mjs': ['Node.js / JavaScript', 'node'], '.cjs': ['Node.js / JavaScript', 'node'],
      '.jsx': ['React / JavaScript', 'node'], '.ts': ['TypeScript', 'node'], '.tsx': ['React / TypeScript', 'node'],
      '.py': ['Python', 'python3'], '.rs': ['Rust', 'cargo'], '.go': ['Go', 'go'], '.java': ['Java / JVM', 'java'],
      '.kt': ['Kotlin / JVM', 'java'], '.cs': ['.NET / C#', 'dotnet'], '.fs': ['.NET / F#', 'dotnet'],
      '.html': ['HTML / web', 'browser'], '.htm': ['HTML / web', 'browser'], '.css': ['CSS / web', 'browser'],
      '.php': ['PHP', 'php'], '.rb': ['Ruby', 'ruby'], '.lua': ['Lua', 'lua'], '.swift': ['Swift', 'swift'], '.dart': ['Dart / Flutter', 'dart'],
    }[ext] || ['Source code', 'git'];
    result.format = 'source';
    result.runtime = info[0];
    result.tools.push(info[1]);
    result.score += 1;
  } else if (ext === '.pyc') {
    result.format = 'Python bytecode';
    result.runtime = 'Python';
    result.tools.push('python3');
    result.score += 2;
  } else {
    result.format = 'data';
    result.runtime = 'Unknown';
  }
  result.tools = [...new Set(result.tools)];
  return result;
}

async function readJson(file) {
  const text = await readText(file);
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

async function readText(file) {
  return fsp.readFile(file, 'utf8').catch(() => '');
}
