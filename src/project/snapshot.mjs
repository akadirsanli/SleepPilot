import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const IGNORED_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.mypy_cache', '.pytest_cache', '.next', '.nuxt', '.turbo', '.parcel-cache', '.cache', '.idea', '.vs', '.gradle', '.tox', 'coverage', 'htmlcov', 'target', '.cargo', '_target', '_recon']);
const MAX_FILES = 20_000;
const HASH_LIMIT = 4 * 1024 * 1024;
// Source files of real projects can be large (Mount & Blade module_scripts.py is several MB), and
// without their text there is no line diff for the reviewer or the line counts in the report.
const KEEP_TEXT_LIMIT = 4 * 1024 * 1024;
const KEEP_TEXT_TOTAL = 160 * 1024 * 1024;

/**
 * Fingerprint the project tree so SleepPilot can report exactly which files an iteration
 * changed — independent of Git and of OpenCode's own diff (which is empty outside Git repos).
 * Small text files keep their content so a line diff can be produced afterwards.
 */
export async function takeSnapshot(root) {
  const files = new Map();
  let keptBytes = 0;
  let truncated = false;
  async function walk(dir) {
    if (files.size >= MAX_FILES) {
      truncated = true;
      return;
    }
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!IGNORED_DIRS.has(e.name)) await walk(full);
      } else if (e.isFile()) {
        if (files.size >= MAX_FILES) {
          truncated = true;
          return;
        }
        let st;
        try {
          st = await fsp.stat(full);
        } catch {
          continue;
        }
        const rel = path.relative(root, full).split(path.sep).join('/');
        const rec = { size: st.size, mtimeMs: Math.round(st.mtimeMs) };
        if (st.size <= HASH_LIMIT) {
          try {
            const buf = await fsp.readFile(full);
            rec.hash = crypto.createHash('sha1').update(buf).digest('hex');
            if (st.size <= KEEP_TEXT_LIMIT && keptBytes + st.size <= KEEP_TEXT_TOTAL && isProbablyText(buf)) {
              rec.text = buf.toString('utf8');
              keptBytes += st.size;
            }
          } catch {}
        }
        files.set(rel, rec);
      }
    }
  }
  await walk(root);
  return { root, takenAt: Date.now(), files, truncated };
}

function isProbablyText(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return false;
  return true;
}

/** Compare two snapshots → { added[], modified[], deleted[] } plus per-file line diffs where possible. */
export function diffSnapshots(before, after, { maxPatchChars = 200_000 } = {}) {
  const added = [];
  const modified = [];
  const deleted = [];
  for (const [rel, a] of after.files) {
    const b = before.files.get(rel);
    if (!b) added.push(rel);
    else if (a.hash && b.hash ? a.hash !== b.hash : a.size !== b.size || a.mtimeMs !== b.mtimeMs) modified.push(rel);
  }
  for (const rel of before.files.keys()) if (!after.files.has(rel)) deleted.push(rel);
  const patches = [];
  let budget = maxPatchChars;
  const addedSet = new Set(added);
  const deletedSet = new Set(deleted);
  for (const rel of [...modified, ...added, ...deleted].sort()) {
    const b = before.files.get(rel);
    const a = after.files.get(rel);
    const oldText = b?.text ?? (b ? null : '');
    const newText = a?.text ?? (a ? null : '');
    let patch;
    const status = addedSet.has(rel) ? 'added' : deletedSet.has(rel) ? 'deleted' : 'modified';
    if (oldText == null || newText == null) {
      patches.push({ file: rel, patch: `--- a/${rel}\n+++ b/${rel}\n(binary or large file — no line diff)\n`, additions: 0, deletions: 0, status, binary: true });
      continue;
    }
    patch = unifiedDiff(rel, oldText, newText);
    // Line counts are always kept; only the patch text is subject to the size budget.
    const additions = (patch.match(/^\+(?!\+\+ )/gm) || []).length;
    const deletions = (patch.match(/^-(?!-- )/gm) || []).length;
    if (budget - patch.length < 0) {
      patches.push({ file: rel, patch: '(diff omitted: size limit)\n', additions, deletions, status });
      continue;
    }
    budget -= patch.length;
    patches.push({ file: rel, patch, additions, deletions, status });
  }
  return { added: added.sort(), modified: modified.sort(), deleted: deleted.sort(), patches, truncated: before.truncated || after.truncated };
}

/** Minimal Myers line diff rendered as a unified diff with 3 lines of context. */
export function unifiedDiff(file, oldText, newText, context = 3) {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const ops = myers(a, b);
  const header = `--- ${a.length ? 'a/' + file : '/dev/null'}\n+++ ${b.length ? 'b/' + file : '/dev/null'}\n`;
  let out = '';
  // Group ops into hunks
  let i = 0;
  while (i < ops.length) {
    while (i < ops.length && ops[i].t === '=') i++;
    if (i >= ops.length) break;
    let start = Math.max(0, i - context);
    let end = i;
    while (end < ops.length) {
      if (ops[end].t !== '=') {
        end++;
        continue;
      }
      let run = 0;
      while (end + run < ops.length && ops[end + run].t === '=') run++;
      if (end + run >= ops.length || run > context * 2) {
        end = Math.min(ops.length, end + context);
        break;
      }
      end += run;
    }
    const hunk = ops.slice(start, end);
    const aStart = (hunk[0]?.ai ?? 0) + 1;
    const bStart = (hunk[0]?.bi ?? 0) + 1;
    const aLen = hunk.filter((o) => o.t !== '+').length;
    const bLen = hunk.filter((o) => o.t !== '-').length;
    out += `@@ -${aLen ? aStart : 0},${aLen} +${bLen ? bStart : 0},${bLen} @@\n`;
    for (const o of hunk) out += (o.t === '=' ? ' ' : o.t) + o.line + '\n';
    i = end;
  }
  return out ? header + out : '';
}

/** Lines of a text; a final newline ends the last line instead of starting an empty one. */
function splitLines(text) {
  if (text === '') return [];
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/** Myers on the part between the common prefix and suffix, so small edits in big files stay cheap. */
function myers(a, b) {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const ops = [];
  for (let i = 0; i < pre; i++) ops.push({ t: '=', line: a[i], ai: i, bi: i });
  for (const o of myersCore(a.slice(pre, a.length - suf), b.slice(pre, b.length - suf))) ops.push({ ...o, ai: o.ai + pre, bi: o.bi + pre });
  for (let i = suf; i > 0; i--) ops.push({ t: '=', line: a[a.length - i], ai: a.length - i, bi: b.length - i });
  return ops;
}

/**
 * Upper bound for the edit distance Myers may explore. The trace kept for backtracking grows with
 * D², so an unbounded D on a regenerated 30 000-line data file needed tens of GB: Node ran out of
 * memory and the whole app died in the middle of a night run (29.10.2026, 08:03). Past this bound
 * the changed block is reported as delete-all/add-all, which keeps the line counts meaningful.
 */
export const MAX_EDIT_DISTANCE = 2500;

function myersCore(a, b) {
  const n = a.length;
  const m = b.length;
  const replaceAll = () => [...a.map((line, ai) => ({ t: '-', line, ai, bi: 0 })), ...b.map((line, bi) => ({ t: '+', line, ai: n, bi }))];
  // An added or deleted file (or block) needs no search at all.
  if (!n || !m) return replaceAll();
  const max = Math.min(n + m, MAX_EDIT_DISTANCE);
  const off = max + 1;
  const v = new Int32Array(2 * max + 3); // v[k + off] = furthest x on diagonal k
  const trace = []; // trace[d] = v[-d-1 .. d+1] before step d → 2d+3 ints, ~4·D² bytes in total
  let found = false;
  outer: for (let d = 0; d <= max; d++) {
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[k - 1 + off] < v[k + 1 + off]) ? v[k + 1 + off] : v[k - 1 + off] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[k + off] = x;
      if (x >= n && y >= m) {
        found = true;
        break outer;
      }
    }
  }
  if (!found) return replaceAll();
  const ops = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const vv = trace[d];
    const at = (k) => vv[k + d + 1];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ t: '=', line: a[x - 1], ai: x - 1, bi: y - 1 });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) ops.push({ t: '+', line: b[y - 1], ai: x, bi: y - 1 });
      else ops.push({ t: '-', line: a[x - 1], ai: x - 1, bi: y });
    }
    x = prevX;
    y = prevY;
  }
  return ops.reverse();
}

/** Serialisable summary (no file contents) for persistence. */
export function snapshotSummary(snap) {
  return { takenAt: snap.takenAt, fileCount: snap.files.size, truncated: snap.truncated };
}
