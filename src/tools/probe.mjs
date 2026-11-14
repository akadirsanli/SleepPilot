import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runFile } from '../util/proc.mjs';

/**
 * Shared, read-only executable discovery for the toolchain screen.
 *
 * A bare command is tried through PATH; a path may contain %ENV% variables, ~, ${ENV},
 * and * wildcards in directory segments (e.g. Python3*). Every attempt is recorded so the UI
 * can explain exactly what was tried when detection fails.
 */
export async function expandCandidate(value) {
  let s = String(value || '').trim();
  if (!s) return [];
  s = s.replace(/^~(?=$|[\\/])/, os.homedir());
  s = s.replace(/%([^%]+)%/g, (_, name) => process.env[name] ?? process.env[findEnvName(name)] ?? '');
  s = s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, a, b) => process.env[a || b] || '');
  if (!s) return [];
  if (!s.includes('*')) return [s];
  return expandGlob(s);
}

function findEnvName(name) {
  const want = String(name).toLowerCase();
  return Object.keys(process.env).find((k) => k.toLowerCase() === want) || name;
}

/** Expand simple * wildcards in the directory portion of a path. */
async function expandGlob(pattern) {
  const normalized = pattern.replace(/\\/g, path.sep).replace(/\//g, path.sep);
  const isAbs = path.isAbsolute(normalized);
  const parts = normalized.split(path.sep).filter((p, i) => p !== '' || i === 0);
  let bases = [isAbs ? path.parse(normalized).root : process.cwd()];
  let index = 0;
  if (isAbs && parts.length && parts[0].endsWith(':')) {
    bases = [parts[0] + path.sep];
    index = 1;
  }
  for (; index < parts.length; index++) {
    const part = parts[index];
    const last = index === parts.length - 1;
    const out = [];
    for (const base of bases) {
      if (!part.includes('*')) out.push(path.join(base, part));
      else {
        const re = new RegExp('^' + part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i');
        const entries = await fsp.readdir(base, { withFileTypes: true }).catch(() => []);
        for (const e of entries) {
          if ((last ? e.isFile() : e.isDirectory()) && re.test(e.name)) out.push(path.join(base, e.name));
        }
      }
    }
    bases = out.slice(0, 60);
    if (!bases.length) return [];
  }
  return bases;
}

export async function probeExecutable(candidate, { args = ['--version'], re, timeoutMs = 12_000 } = {}) {
  const file = typeof candidate === 'string' ? candidate : candidate.file;
  const useArgs = typeof candidate === 'object' && candidate.args ? candidate.args : args;
  const label = typeof candidate === 'object' && candidate.label ? candidate.label : file;
  const r = await runFile(file, useArgs, { timeoutMs }).catch((error) => ({ error, exitCode: null, stdout: '', stderr: '' }));
  const output = `${r.stdout || ''}\n${r.stderr || ''}`.trim();
  const versionMatch = output.match(re || /(\d+\.\d+(?:\.\d+)?)/);
  const version = versionMatch ? (versionMatch[1] || versionMatch[0]) : null;
  const ok = !r.error && (r.exitCode === 0 || !!version);
  return {
    file,
    label,
    args: useArgs,
    ok: !!ok,
    version,
    output: output.slice(0, 600),
    error: r.error ? r.error.message || String(r.error) : r.exitCode !== 0 && !version ? `exit code ${r.exitCode}` : null,
  };
}

/** Try several candidates and return the first success plus every attempt for diagnostics. */
export async function probeCandidates(candidates, options = {}) {
  const attempts = [];
  const seen = new Set();
  for (const raw of candidates || []) {
    const values = await expandCandidate(typeof raw === 'string' ? raw : raw.file);
    for (const file of values) {
      const key = `${typeof raw === 'object' ? (raw.args || []).join(' ') : ''}\u0000${file}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const candidate = typeof raw === 'object' ? { ...raw, file } : file;
      const attempt = await probeExecutable(candidate, options);
      attempts.push(attempt);
      if (attempt.ok) return { found: true, ...attempt, attempts };
    }
  }
  return { found: false, file: null, version: null, attempts };
}

/** Check whether one of the known directories/files exists (GUI tools with no CLI version). */
export async function findExistingPath(candidates) {
  const attempts = [];
  for (const raw of candidates || []) {
    for (const p of await expandCandidate(raw)) {
      const st = await fsp.stat(p).catch(() => null);
      attempts.push({ file: p, ok: !!st, kind: st?.isDirectory() ? 'directory' : st ? 'file' : 'missing' });
      if (st) return { found: true, path: p, kind: st.isDirectory() ? 'directory' : 'file', attempts };
    }
  }
  return { found: false, path: null, attempts };
}

/** Read a version string from a nearby metadata file (Ghidra application.properties). */
export async function readVersionFile(file) {
  try {
    const text = await fsp.readFile(file, 'utf8');
    const m = text.match(/(?:application\.version|version)\s*[=:]\s*([\w.-]+)/i);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}
