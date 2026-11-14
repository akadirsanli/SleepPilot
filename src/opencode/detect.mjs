import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runFile } from '../util/proc.mjs';

/** OpenCode major versions this adapter was written and verified against. */
export const SUPPORTED_MAJOR = 2;

function candidatePaths(override) {
  const home = os.homedir();
  const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const roaming = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const list = [];
  if (override) list.push({ path: override, source: 'settings' });
  if (process.env.SLEEPPILOT_OPENCODE) list.push({ path: process.env.SLEEPPILOT_OPENCODE, source: 'SLEEPPILOT_OPENCODE' });
  // PATH lookup (opencode.exe / opencode.cmd)
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) list.push({ path: path.join(dir, 'opencode' + ext), source: 'PATH' });
  }
  list.push({ path: path.join(local, 'Programs', '@opencode-aidesktop', 'resources', 'opencode-cli.exe'), source: 'OpenCode Desktop' });
  list.push({ path: path.join(home, '.opencode', 'bin', 'opencode.exe'), source: 'opencode installer' });
  list.push({ path: path.join(roaming, 'npm', 'opencode.cmd'), source: 'npm global' });
  list.push({ path: path.join(home, 'scoop', 'shims', 'opencode.exe'), source: 'scoop' });
  list.push({ path: path.join(home, '.bun', 'bin', 'opencode.exe'), source: 'bun global' });
  return list;
}

export function parseVersion(text) {
  const m = String(text || '').match(/v?(\d+)\.(\d+)\.(\d+)(?:[-+][\w.]+)?/);
  if (!m) return null;
  return { raw: m[0].replace(/^v/, ''), major: +m[1], minor: +m[2], patch: +m[3] };
}

export function classifyVersion(version) {
  if (!version) return { status: 'unknown', message: 'Could not read the OpenCode version.' };
  if (version.major < SUPPORTED_MAJOR) {
    return {
      status: 'unsupported',
      message: `OpenCode ${version.raw} (1.x API) is not supported. SleepPilot uses the OpenCode 2.x HTTP API. Update OpenCode to 2.x.`,
    };
  }
  if (version.major > SUPPORTED_MAJOR) {
    return {
      status: 'untested',
      message: `OpenCode ${version.raw} is an untested major version. API compatibility is checked when connecting.`,
    };
  }
  return { status: 'supported', message: `OpenCode ${version.raw} destekleniyor.` };
}

/**
 * Locate the OpenCode CLI and read its version.
 * Returns { found, path, source, version, support, tried[] }.
 */
export async function detectOpenCode({ override } = {}) {
  const tried = [];
  const seen = new Set();
  for (const c of candidatePaths(override)) {
    const key = c.path.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    let stat;
    try {
      stat = fs.statSync(c.path);
    } catch {
      if (c.source === 'settings' || c.source === 'SLEEPPILOT_OPENCODE') tried.push({ ...c, result: 'not found' });
      continue;
    }
    if (!stat.isFile()) continue;
    const r = await runFile(c.path, ['--version'], { timeoutMs: 30_000 });
    const text = `${r.stdout}\n${r.stderr}`;
    const version = parseVersion(text);
    if (r.exitCode !== 0 || !version) {
      tried.push({ ...c, result: r.timedOut ? 'timed out' : `could not read the version (exit code ${r.exitCode})` });
      continue;
    }
    return { found: true, path: c.path, source: c.source, version, support: classifyVersion(version), tried };
  }
  return {
    found: false,
    path: null,
    source: null,
    version: null,
    support: {
      status: 'missing',
      message:
        'OpenCode not found. Install OpenCode Desktop or the CLI (https://opencode.ai), or enter the path of the opencode executable in Settings.',
    },
    tried,
  };
}
