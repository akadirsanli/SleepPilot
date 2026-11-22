import fsp from 'node:fs/promises';
import path from 'node:path';
import { inspectFile, OFFICE_EXT } from './inspect.mjs';
import { verifyFile } from './verify.mjs';
import { officeStatus } from './deps.mjs';

const SKIP = /(^|\/)(node_modules|\.git|\.sleeppilot|\.venv|venv|__pycache__|dist|build)\//;
const LEGACY = /\.(xls|doc|ppt)$/i;
const MAX_BYTES = 60 * 1048576;

/** Office files among a list of project-relative paths (what the office check looks at). */
export function officeFilesIn(files) {
  return [...new Set(files)].filter((f) => OFFICE_EXT.test(f) && !LEGACY.test(f) && !SKIP.test(f));
}

/**
 * The "office" check:
 *  1. every office file the task created or changed must open and must not show the usual signs
 *     of a bug (formula errors, NaN/undefined/[object Object], blank image, empty document);
 *  2. every expectation in `check.expect` (see verify.mjs) must hold.
 */
export async function runOfficeCheck({ check, projectDir, changedFiles = [] }) {
  const status = officeStatus();
  if (!status.ready) return { status: 'error', output: `The office tools are not installed (missing: ${status.missing.join(', ')}). Run "npm install" in the SleepPilot folder.` };
  const expectations = Array.isArray(check.expect) ? check.expect : check.expect ? [check.expect] : [];
  const files = officeFilesIn(changedFiles).slice(0, 20);
  if (!files.length && !expectations.length) return { status: 'skipped', output: 'No office file (xlsx, csv, docx, pptx, pdf, png …) changed and no expectation is configured.' };
  const lines = [];
  const details = { files: [], expectations: [] };
  let failed = 0;
  for (const rel of files) {
    const full = path.join(projectDir, ...rel.split('/'));
    const size = (await fsp.stat(full).catch(() => null))?.size ?? 0;
    if (size > MAX_BYTES) {
      // A very large export is read in full by the libraries; not worth stalling a night for.
      lines.push(`· ${rel}: ${(size / 1048576).toFixed(0)} MB — too large to open in the check (limit ${MAX_BYTES / 1048576} MB); use an expectation on a smaller output.`);
      details.files.push({ file: rel, skipped: true, size });
      continue;
    }
    const info = await inspectFile(full, { maxRows: 8, maxChars: 1500 });
    const problems = info.ok ? info.problems : [info.error];
    if (problems.length) failed++;
    lines.push(`${problems.length ? '✗' : '✓'} ${rel}: ${info.summary}${problems.map((p) => `\n    - ${p}`).join('')}`);
    details.files.push({ file: rel, kind: info.kind, ok: info.ok, summary: info.summary, problems, preview: String(info.preview || '').slice(0, 2500) });
  }
  for (const exp of expectations.slice(0, 30)) {
    const r = await verifyFile(exp, { baseDir: projectDir });
    if (!r.ok) failed++;
    lines.push(`${r.ok ? '✓' : '✗'} expectation for ${r.file || '(no file)'}${r.failed.map((f) => `\n    - ${f}`).join('')}${r.ok ? ` (${r.passed.length} point(s) passed)` : ''}`);
    details.expectations.push(r);
  }
  return { status: failed ? 'failed' : 'passed', exitCode: failed ? 1 : 0, output: lines.join('\n'), details };
}

/** Short descriptions of changed office files for the reviewer, who cannot open binary files. */
export async function officePreviews(projectDir, changedFiles, { maxFiles = 6, maxChars = 7000 } = {}) {
  if (!officeStatus().ready) return '';
  const out = [];
  let used = 0;
  for (const rel of officeFilesIn(changedFiles).slice(0, maxFiles)) {
    if (((await fsp.stat(path.join(projectDir, ...rel.split('/'))).catch(() => null))?.size ?? 0) > MAX_BYTES) continue;
    const info = await inspectFile(path.join(projectDir, ...rel.split('/')), { maxRows: 8, maxChars: 1500 }).catch(() => null);
    if (!info) continue;
    const block = `### ${rel}\n${info.ok ? info.summary : `ERROR: ${info.error}`}${info.problems?.length ? `\nProblems: ${info.problems.join(' | ')}` : ''}\n${String(info.preview || '').slice(0, 2000)}`;
    if (used + block.length > maxChars) break;
    used += block.length;
    out.push(block);
  }
  return out.join('\n\n');
}
