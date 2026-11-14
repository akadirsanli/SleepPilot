/**
 * Citation check for Sleep & Reverse runs: the analysis documents must back their claims with
 * `file:LINE` / `file:START-END` references into the target, and every reference must point at a
 * line that exists. A model that invents line numbers (or cites a file that is not there) fails
 * the check, so its task is repaired instead of being reported as verified.
 *
 * Paths are resolved against the target map built by target-mirror.mjs (relative to the target
 * root, with or without the `_target/` prefix, or by unique file name), then against the
 * workspace (for the agent's own scripts). Unresolvable references are reported, not failed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readMirrorMap, MIRROR_DIR } from '../project/target-mirror.mjs';

const CITE = /([A-Za-z0-9_\-./\\À-ɏ]+\.[A-Za-z0-9]{1,10}):L?(\d+)(?:\s*[-–]\s*L?(\d+))?/g;

function lineCount(file) {
  try {
    const buf = fs.readFileSync(file);
    let n = 0;
    for (const b of buf) if (b === 10) n++;
    return buf.length && buf[buf.length - 1] !== 10 ? n + 1 : n;
  } catch {
    return null;
  }
}

export async function checkCitations({ projectDir, changedFiles = [] }) {
  const docs = changedFiles.filter((f) => /\.md$/i.test(f) && !f.startsWith(`${MIRROR_DIR}/`));
  if (!docs.length) return { status: 'skipped', output: 'No analysis document (.md) changed in this iteration.' };
  const map = await readMirrorMap(projectDir);
  const byPath = new Map();
  const byName = new Map();
  for (const f of map?.files || []) {
    byPath.set(f.file.toLowerCase(), f);
    const base = path.posix.basename(f.file).toLowerCase();
    byName.set(base, byName.has(base) ? null : f); // null = ambiguous
  }
  const targetPrefix = map ? map.targetDir.replace(/\\/g, '/').toLowerCase() + '/' : null;
  const resolve = (raw) => {
    let p = raw.replace(/\\/g, '/').replace(/^\.\//, '');
    if (targetPrefix && p.toLowerCase().startsWith(targetPrefix)) p = p.slice(targetPrefix.length);
    p = p.replace(new RegExp(`^${MIRROR_DIR}/`), '');
    const hit = byPath.get(p.toLowerCase()) || (!p.includes('/') && byName.get(p.toLowerCase()));
    if (hit) return { file: hit.file, lines: hit.lines ?? null, target: true };
    const own = path.join(projectDir, p);
    if (fs.existsSync(own) && fs.statSync(own).isFile()) return { file: p, lines: lineCount(own), target: false };
    return null;
  };
  let total = 0;
  let toTarget = 0;
  const invalid = [];
  const unresolved = new Set();
  const perDoc = [];
  for (const doc of docs) {
    let text;
    try {
      text = fs.readFileSync(path.join(projectDir, doc), 'utf8');
    } catch {
      continue;
    }
    let n = 0;
    for (const m of text.matchAll(CITE)) {
      const [whole, file, a, b] = m;
      if (/^https?:|^\w+:\/\//i.test(whole) || /^\d+(\.\d+)+$/.test(file)) continue; // URLs, version numbers
      const r = resolve(file);
      if (!r) {
        unresolved.add(file);
        continue;
      }
      if (r.lines == null) continue; // binary / not mirrored: a page or offset, cannot be checked
      total++;
      n++;
      if (r.target) toTarget++;
      const start = Number(a);
      const end = b ? Number(b) : start;
      if (start < 1 || end < start || end > r.lines) invalid.push(`${doc}: ${whole} (${r.file} has ${r.lines} lines)`);
    }
    perDoc.push(`${doc}: ${n} citation(s)`);
  }
  const lines = [`${total} citation(s) checked in ${docs.length} document(s); ${toTarget} point into the target.`, ...perDoc];
  if (invalid.length) lines.push(`${invalid.length} invalid:`, ...invalid.slice(0, 40).map((x) => `  - ${x}`));
  if (unresolved.size) lines.push(`Not found (ignored): ${[...unresolved].slice(0, 15).join(', ')}`);
  if (!toTarget) lines.push('No citation points into the target: every claim about the program needs file:line evidence.');
  return { status: invalid.length || !toTarget ? 'failed' : 'passed', exitCode: invalid.length || !toTarget ? 1 : 0, output: lines.join('\n'), details: { total, toTarget, invalid, unresolved: [...unresolved] } };
}
