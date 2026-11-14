import fsp from 'node:fs/promises';
import path from 'node:path';
import { IGNORED_DIRS } from './snapshot.mjs';
import { gitInfo } from './git.mjs';

/**
 * Inspect a project folder: what kind of project it looks like, which validation methods
 * exist, Git state. Command checks are only SUGGESTED (disabled) until the user approves them,
 * because they execute project code. Built-in syntax checks have no side effects and start enabled.
 */
export async function inspectProject(dir) {
  const st = await fsp.stat(dir).catch(() => null);
  if (!st || !st.isDirectory()) return { ok: false, error: 'Folder not found or not a folder.' };

  const counts = {};
  const topLevel = [];
  let total = 0;
  const htmlFiles = [];
  const nestedRepos = [];
  const py27 = [];
  async function walk(d, depth) {
    let entries;
    try {
      entries = await fsp.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      const rel = path.relative(dir, full).split(path.sep).join('/');
      if (depth === 0) topLevel.push(e.isDirectory() ? rel + '/' : rel);
      // A Git repository inside the chosen folder (e.g. a game root whose mod folder is the repo).
      if (e.name === '.git' && depth > 0 && nestedRepos.length < 10) nestedRepos.push(path.relative(dir, d).split(path.sep).join('/'));
      if (e.isFile() && /^python(2(\.7)?)?\.exe$/i.test(e.name) && /py(thon)?-?2/i.test(rel)) py27.push(rel);
      if (e.isDirectory()) {
        if (!IGNORED_DIRS.has(e.name) && depth < 6 && total < 20000) await walk(full, depth + 1);
      } else if (e.isFile()) {
        total++;
        const ext = path.extname(e.name).toLowerCase() || '(no extension)';
        counts[ext] = (counts[ext] || 0) + 1;
        if ((ext === '.html' || ext === '.htm') && depth <= 1) htmlFiles.push(rel);
      }
    }
  }
  await walk(dir, 0);

  const has = (f) => topLevel.includes(f) || topLevel.includes(f + '/');
  const kinds = [];
  const checks = [];
  let pkg = null;
  if (has('package.json')) {
    kinds.push('node');
    try {
      pkg = JSON.parse(await fsp.readFile(path.join(dir, 'package.json'), 'utf8'));
    } catch {}
    const scripts = pkg?.scripts || {};
    for (const name of ['test', 'lint', 'typecheck', 'build']) {
      const s = scripts[name];
      if (!s || /no test specified/.test(s)) continue;
      checks.push({
        id: `npm-${name}`,
        type: 'command',
        name: `npm run ${name}`,
        command: name === 'test' ? 'npm test' : `npm run ${name}`,
        enabled: false,
        suggested: true,
        reason: `package.json has a "${name}" script: ${s}`,
        timeoutSec: 600,
      });
    }
  }
  const py = (counts['.py'] || 0) > 0;
  if (py) {
    kinds.push('python');
    if (has('pyproject.toml') || has('pytest.ini') || has('tests') || has('setup.cfg') || has('tox.ini')) {
      checks.push({ id: 'pytest', type: 'command', name: 'pytest', command: 'python -m pytest -q', enabled: false, suggested: true, reason: 'Python test configuration / tests folder found.', timeoutSec: 900 });
    }
  }
  if (htmlFiles.length) {
    kinds.push('html');
    const entries = htmlFiles.includes('index.html') ? ['index.html'] : htmlFiles.slice(0, 5);
    checks.push({
      id: 'html-smoke',
      type: 'html-smoke',
      name: 'HTML load and JavaScript error check',
      entries,
      enabled: true,
      suggested: true,
      reason: 'The page is opened from a local server in headless Edge; JavaScript errors, console errors and resources that fail to load are reported.',
      timeoutSec: 60,
    });
  }
  if ((counts['.js'] || 0) + (counts['.mjs'] || 0) + (counts['.cjs'] || 0) > 0) {
    checks.push({ id: 'js-syntax', type: 'js-syntax', name: 'JavaScript syntax (node --check)', enabled: true, suggested: true, reason: 'Changed .js/.mjs/.cjs files are syntax-checked without running them.', timeoutSec: 120 });
  }
  if (py) {
    const py2 = py27[0] || null;
    checks.push({
      id: 'py-syntax',
      type: 'py-syntax',
      name: py2 ? 'Python 2.7 syntax (ast.parse)' : 'Python syntax (ast.parse)',
      enabled: true,
      suggested: true,
      ...(py2 ? { interpreter: py2 } : {}),
      reason: py2 ? `A Python 2.7 interpreter was found in the project (${py2}); changed .py files are parsed with it.` : 'Changed .py files are parsed without running them (no __pycache__). For Python 2 code, enter a 2.7 interpreter in the check row.',
      timeoutSec: 120,
    });
  }
  if (has('module_info.py') || has('build_module.bat') || has('module_system')) {
    kinds.push('warband-module-system');
    if (has('build_module.bat')) {
      checks.push({
        id: 'warband-build',
        type: 'command',
        name: 'Warband build_module.bat',
        command: 'build_module.bat',
        enabled: false,
        suggested: true,
        reason: 'Mount & Blade: Warband Module System found. build_module.bat reports build errors, but it writes files to the export folder set in module_info.py — check that path before approving.',
        timeoutSec: 900,
      });
    }
  }
  if (!kinds.length) kinds.push(total === 0 ? 'empty' : 'generic');

  let readme = null;
  for (const f of ['README.md', 'readme.md', 'README.txt', 'README']) {
    if (has(f)) {
      readme = (await fsp.readFile(path.join(dir, f), 'utf8').catch(() => '')).slice(0, 1500);
      break;
    }
  }
  const agentsMd = has('AGENTS.md') ? (await fsp.readFile(path.join(dir, 'AGENTS.md'), 'utf8').catch(() => '')).slice(0, 1500) : null;

  return {
    ok: true,
    dir,
    kinds,
    totalFiles: total,
    extensionCounts: Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 15)),
    topLevel: topLevel.slice(0, 60),
    htmlFiles,
    packageName: pkg?.name || null,
    readme,
    agentsMd,
    git: await gitInfo(dir),
    nestedRepos,
    large: total >= 20000,
    suggestedChecks: checks,
    inspectedAt: Date.now(),
  };
}
