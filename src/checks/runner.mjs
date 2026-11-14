import fs from 'node:fs';
import path from 'node:path';
import { runShell, runFile } from '../util/proc.mjs';
import { redact } from '../util/redact.mjs';
import { runHtmlSmoke } from './html-smoke.mjs';
import { checkCitations } from './citations.mjs';
import { runCargo, detectCargo } from '../reverse/rust.mjs';

const tail = (s, n = 4000) => (s && s.length > n ? '…' + s.slice(-n) : s || '');

let pythonCmd;
async function findPython() {
  if (pythonCmd !== undefined) return pythonCmd;
  for (const c of [{ file: 'python', args: [] }, { file: 'py', args: ['-3'] }, { file: 'python3', args: [] }]) {
    const r = await runFile(c.file, [...c.args, '--version'], { timeoutMs: 15_000 });
    if (r.exitCode === 0 && /Python 3/.test(r.stdout + r.stderr)) return (pythonCmd = c);
  }
  return (pythonCmd = null);
}

// Works on Python 2.7 and 3.x alike.
const PY_PARSE = 'import ast,sys\nfor f in sys.argv[1:]:\n    ast.parse(open(f,"rb").read(), f)\n';

/**
 * Interpreter for the syntax check. Default: Python 3 on PATH. A check may name its own
 * interpreter (e.g. a Python 2.7 python.exe for Mount & Blade: Warband module systems, whose
 * `print "x"` lines are not valid Python 3). Relative paths are resolved against the project.
 */
async function pythonFor(check, projectDir) {
  const custom = String(check.interpreter || '').trim();
  if (!custom) {
    const py = await findPython();
    return py ? { ...py, isolate: ['-I'], label: 'Python 3' } : null;
  }
  const file = path.isAbsolute(custom) || /^[a-z]+$/i.test(custom) ? custom : path.join(projectDir, custom);
  const v = await runFile(file, ['--version'], { timeoutMs: 15_000 });
  if (v.error || v.exitCode !== 0) return { missing: `Could not run the interpreter: ${custom}` };
  const version = (v.stdout + v.stderr).trim();
  // -I exists only on Python 3.4+; -E -s gives the same isolation on 2.7.
  return { file, args: [], isolate: /Python 2\./.test(version) ? ['-E', '-s'] : ['-I'], label: version };
}

/**
 * Run the enabled checks for an iteration. Only checks the user enabled run; command checks
 * additionally require explicit approval (approved: true) because they execute project code.
 * @returns {Promise<Array<{checkId,name,type,status,exitCode,durationMs,output,details,command}>>}
 */
export async function runChecks({ projectDir, checks, changedFiles = [], commandCache = null }) {
  const results = [];
  for (const check of checks.filter((c) => c.enabled)) {
    const started = Date.now();
    const base = { checkId: check.id, name: check.name, type: check.type, startedAt: started };
    try {
      if (check.type === 'command') {
        if (!check.approved) {
          results.push({ ...base, status: 'skipped', output: 'The command was not approved by the user; not run.', durationMs: 0 });
          continue;
        }
        // Parallel developers: after a wave the project state is the same for every task in it,
        // so a command check (build, test suite) runs once and its result is shared. The cache
        // holds the in-flight promise, so tasks checked at the same moment wait for that one run.
        const key = `${check.id}\u0000${check.command}`;
        if (commandCache?.has(key)) {
          const cached = await commandCache.get(key);
          results.push({ ...cached, ...base, startedAt: cached.startedAt, shared: true, output: `${cached.output}\n(run once for the parallel wave; the result applies to every task in this wave)` });
          continue;
        }
        let settle = null;
        if (commandCache) commandCache.set(key, new Promise((resolve) => (settle = resolve)));
        const r = await runShell(check.command, { cwd: projectDir, timeoutMs: (check.timeoutSec || 600) * 1000 }).catch((error) => ({ error, exitCode: null, stdout: '', stderr: '', durationMs: 0 }));
        const output = redact(tail(`${r.stdout}\n${r.stderr}`.trim()));
        results.push({
          ...base,
          command: check.command,
          status: r.timedOut ? 'failed' : r.error ? 'error' : r.exitCode === 0 ? 'passed' : 'failed',
          exitCode: r.exitCode,
          timedOut: r.timedOut,
          durationMs: r.durationMs,
          output: r.timedOut ? `Timed out (${check.timeoutSec || 600} s).\n${output}` : r.error ? `Could not start the command: ${r.error.message}` : output,
        });
        settle?.(results.at(-1));
      } else if (check.type === 'js-syntax') {
        const files = changedFiles.filter((f) => /\.(m|c)?js$/i.test(f) && !f.includes('node_modules/'));
        if (!files.length) {
          results.push({ ...base, status: 'skipped', output: 'No JavaScript file changed in this iteration.', durationMs: 0 });
          continue;
        }
        const failures = [];
        for (const f of files.slice(0, 200)) {
          const r = await runFile(process.execPath, ['--check', path.join(projectDir, f)], { timeoutMs: 30_000 });
          if (r.exitCode !== 0) failures.push(`${f}:\n${tail(r.stderr, 1200)}`);
        }
        results.push({ ...base, status: failures.length ? 'failed' : 'passed', exitCode: failures.length ? 1 : 0, durationMs: Date.now() - started, output: failures.length ? failures.join('\n\n') : `${files.length} file(s) passed the syntax check.`, details: { files } });
      } else if (check.type === 'py-syntax') {
        const files = changedFiles.filter((f) => /\.py$/i.test(f));
        if (!files.length) {
          results.push({ ...base, status: 'skipped', output: 'No Python file changed in this iteration.', durationMs: 0 });
          continue;
        }
        const py = await pythonFor(check, projectDir);
        if (!py || py.missing) {
          results.push({ ...base, status: 'error', output: py?.missing || 'Python 3 not found; the syntax check could not run.', durationMs: 0 });
          continue;
        }
        const r = await runFile(py.file, [...py.args, ...py.isolate, '-c', PY_PARSE, ...files.slice(0, 200).map((f) => path.join(projectDir, f))], { cwd: projectDir, timeoutMs: 60_000 });
        results.push({ ...base, status: r.exitCode === 0 ? 'passed' : 'failed', exitCode: r.exitCode, durationMs: r.durationMs, output: r.exitCode === 0 ? `${files.length} file(s) parsed (${py.label}).` : tail(r.stderr, 3000), details: { files, interpreter: py.label } });
      } else if (check.type === 'html-smoke') {
        // Configured pages plus every HTML page this task created or changed.
        const touchedHtml = changedFiles.filter((f) => /\.html?$/i.test(f));
        let entries = [...new Set([...(check.entries || []), ...touchedHtml])].filter((e) => fs.existsSync(path.join(projectDir, e))).slice(0, 8);
        if (!entries.length) {
          const top = fs.readdirSync(projectDir).filter((f) => /\.html?$/i.test(f));
          entries = top.includes('index.html') ? ['index.html'] : top.slice(0, 5);
        }
        if (!entries.length) {
          results.push({ ...base, status: 'skipped', output: 'The project has no HTML file to open.', durationMs: 0 });
          continue;
        }
        const r = await runHtmlSmoke({ projectDir, entries, timeoutSec: check.timeoutSec || 60 });
        results.push({ ...base, status: r.status, durationMs: Date.now() - started, output: r.summary, details: { pages: r.pages } });
      } else if (check.type === 'cite-check') {
        const r = await checkCitations({ projectDir, changedFiles });
        results.push({ ...base, ...r, durationMs: Date.now() - started });
      } else if (check.type === 'doc-check') {
        const entries = (check.entries || []).slice(0, 20);
        const missing = [];
        const short = [];
        for (const rel of entries) {
          const file = path.join(projectDir, ...String(rel).split('/'));
          const st = await fs.promises.stat(file).catch(() => null);
          if (!st?.isFile()) missing.push(rel);
          else if (st.size < (check.minBytes || 0)) short.push(`${rel} (${st.size} bytes)`);
        }
        const ok = !missing.length && !short.length;
        results.push({
          ...base,
          status: ok ? 'passed' : 'failed',
          durationMs: Date.now() - started,
          output: ok ? `${entries.length} required document(s) present.` : `${missing.length ? `Missing: ${missing.join(', ')}. ` : ''}${short.length ? `Too short: ${short.join(', ')}.` : ''}`.trim(),
          details: { entries, missing, short },
        });
      } else if (check.type === 'cargo') {
        const cargo = await detectCargo();
        if (!cargo.found) {
          results.push({ ...base, status: 'error', durationMs: 0, output: `cargo was not found. Install Rust from https://rustup.rs/ or set CARGO to cargo.exe.` });
          continue;
        }
        const args = String(check.cargo || 'check').split(/\s+/).filter(Boolean);
        const allowed = ['check', 'test', 'build', 'clippy', 'fmt'];
        if (!allowed.includes(args[0])) args.unshift('check');
        const cwd = check.dir ? path.join(projectDir, String(check.dir)) : projectDir;
        const key = `cargo\u0000${cwd}\u0000${args.join(' ')}`;
        if (commandCache?.has(key)) {
          const cached = await commandCache.get(key);
          results.push({ ...cached, ...base, startedAt: cached.startedAt, shared: true, output: `${cached.output}\n(run once for the parallel wave)` });
          continue;
        }
        let settle = null;
        if (commandCache) commandCache.set(key, new Promise((resolve) => (settle = resolve)));
        const r = await runCargo(args, { cwd, timeoutMs: (check.timeoutSec || 1800) * 1000 });
        const result = {
          ...base,
          command: `cargo ${args.join(' ')}`,
          status: r.ok ? 'passed' : 'failed',
          exitCode: r.exitCode ?? null,
          durationMs: r.durationMs,
          output: tail(r.output || r.error || '').slice(-8000),
        };
        results.push(result);
        settle?.(result);
      } else {
        results.push({ ...base, status: 'skipped', output: `Unknown check type: ${check.type}`, durationMs: 0 });
      }
    } catch (err) {
      results.push({ ...base, status: 'error', output: `Error while running the check: ${redact(err.message)}`, durationMs: Date.now() - started });
    }
  }
  return results;
}

/** Summarise check results into one verification verdict for a task. */
export function verificationFrom(results) {
  const ran = results.filter((r) => r.status === 'passed' || r.status === 'failed');
  const failed = results.filter((r) => r.status === 'failed');
  const errored = results.filter((r) => r.status === 'error');
  if (failed.length) return { verdict: 'failed', ran: ran.length, failed: failed.map((r) => r.name) };
  if (ran.length) return { verdict: 'passed', ran: ran.length, errored: errored.map((r) => r.name) };
  return { verdict: 'none', ran: 0, errored: errored.map((r) => r.name) };
}
