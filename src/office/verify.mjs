import fsp from 'node:fs/promises';
import path from 'node:path';
import { detectKind, inspectFile, parseRef, colLetter } from './inspect.mjs';
import { readWorkbook } from './excel.mjs';
import { readPdf } from './pdf.mjs';
import { readDocx } from './word.mjs';
import { readPptx } from './slides.mjs';
import { readImage } from './image.mjs';
import { diffFiles, textOf, sameValue } from './diff.mjs';
import { cellText, normName, fold, parseNumber, EXCEL_ERRORS } from './values.mjs';

/**
 * Check an office file against expectations. Every expectation becomes one line in `passed` or
 * `failed`, so the agent sees exactly what is wrong. Paths are relative to `baseDir`.
 *
 * { file,                                   required
 *   minBytes,
 *   sheets: ['Summary'], sheet: 'Detail',   xlsx/csv: sheets that must exist, sheet for the checks below
 *   minRows, maxRows, columns: ['Amount'],  data rows (header excluded), header names
 *   cells: { 'Summary!B2': 100 | 'text' | { equals, approx, tolerance, contains, min, max, nonEmpty, formula } },
 *   noErrors: true,                         no #REF!, #DIV/0!, #VALUE! … cells
 *   contains: [...], notContains: [...],    any kind: text content (case-insensitive)
 *   pages: 3 | { min, max },                pdf
 *   headings: ['Findings'], minTables,      docx (pdf: headings are searched in the text)
 *   slides: n | { min, max },               pptx
 *   width, height, minWidth, minHeight, notBlank,   images
 *   sameAs: 'expected/golden.xlsx', tolerance,      same content as a reference file
 *   findsAll: { key: 'x.key.json', column, sheet, minRecall, maxFalsePositives, types } }
 *                                           the planted anomalies of a sample data set were found
 */
export async function verifyFile(exp, { baseDir = process.cwd() } = {}) {
  const passed = [];
  const failed = [];
  const ok = (msg) => passed.push(msg);
  const bad = (msg) => failed.push(msg);
  const rel = String(exp?.file || '');
  if (!rel) return { file: rel, ok: false, passed, failed: ['No "file" given in the expectation.'] };
  const file = path.resolve(baseDir, rel);
  const st = await fsp.stat(file).catch(() => null);
  if (!st?.isFile()) return { file: rel, ok: false, passed, failed: [`${rel} does not exist.`] };
  ok(`${rel} exists (${st.size} bytes)`);
  if (exp.minBytes && st.size < exp.minBytes) bad(`${rel} is only ${st.size} bytes (expected at least ${exp.minBytes}).`);
  const kind = await detectKind(file);
  // The basic health check every file gets: it opens and has no tell-tale bug values.
  const info = await inspectFile(file, { maxRows: 5, profile: false });
  if (!info.ok) {
    bad(`${rel}: ${info.error}`);
    return { file: rel, kind, ok: false, passed, failed };
  }
  ok(`${rel} opens as ${kind}`);
  for (const p of info.problems) bad(`${rel}: ${p}`);

  const lowerText = { value: null };
  const text = async () => (lowerText.value ??= fold(await textOf(file, kind)));

  if (kind === 'xlsx' || kind === 'csv') await verifyTable(exp, file, rel, kind, { ok, bad });
  if (kind === 'pdf' && exp.pages !== undefined) {
    const n = (await readPdf(file, { maxPages: 1 })).pages;
    within(n, exp.pages) ? ok(`${n} page(s)`) : bad(`${rel} has ${n} page(s); expected ${range(exp.pages)}.`);
  }
  if (exp.headings?.length) {
    if (kind === 'docx') {
      const heads = (await readDocx(file)).headings.map((h) => normName(h.text));
      for (const h of exp.headings) heads.some((x) => x.includes(normName(h))) ? ok(`heading "${h}"`) : bad(`${rel} has no heading "${h}" (headings: ${heads.slice(0, 12).join(' | ') || 'none'}).`);
    } else for (const h of exp.headings) (await text()).includes(fold(h)) ? ok(`heading text "${h}"`) : bad(`${rel} does not contain the heading "${h}".`);
  }
  if (exp.minTables !== undefined && kind === 'docx') {
    const n = (await readDocx(file)).tables.length;
    n >= exp.minTables ? ok(`${n} table(s)`) : bad(`${rel} has ${n} table(s); expected at least ${exp.minTables}.`);
  }
  if (exp.slides !== undefined && kind === 'pptx') {
    const n = (await readPptx(file)).slides.length;
    within(n, exp.slides) ? ok(`${n} slide(s)`) : bad(`${rel} has ${n} slide(s); expected ${range(exp.slides)}.`);
  }
  for (const s of list(exp.contains)) (await text()).includes(fold(s)) ? ok(`contains "${s}"`) : bad(`${rel} does not contain "${s}".`);
  for (const s of list(exp.notContains)) (await text()).includes(fold(s)) ? bad(`${rel} contains "${s}", which it must not.`) : ok(`does not contain "${s}"`);
  if (kind === 'image') {
    const img = await readImage(file);
    if (exp.width !== undefined) img.width === exp.width ? ok(`width ${img.width}`) : bad(`${rel} is ${img.width} px wide; expected ${exp.width}.`);
    if (exp.height !== undefined) img.height === exp.height ? ok(`height ${img.height}`) : bad(`${rel} is ${img.height} px high; expected ${exp.height}.`);
    if (exp.minWidth !== undefined) img.width >= exp.minWidth ? ok(`width ≥ ${exp.minWidth}`) : bad(`${rel} is ${img.width} px wide; expected at least ${exp.minWidth}.`);
    if (exp.minHeight !== undefined) img.height >= exp.minHeight ? ok(`height ≥ ${exp.minHeight}`) : bad(`${rel} is ${img.height} px high; expected at least ${exp.minHeight}.`);
    if (exp.notBlank) img.blank ? bad(`${rel} is blank (one colour) — the chart or picture was not drawn.`) : ok('not blank');
  }
  if (exp.sameAs) {
    const ref = path.resolve(baseDir, String(exp.sameAs));
    if (!(await fsp.stat(ref).catch(() => null))) bad(`Reference file ${exp.sameAs} does not exist.`);
    else {
      const d = await diffFiles(file, ref, { tolerance: Number(exp.tolerance) || 1e-6, maxDiffs: 10 });
      if (d.same) ok(`same content as ${exp.sameAs}`);
      else bad(`${rel} differs from ${exp.sameAs}: ${d.summary}${d.differences?.length ? ` First: ${d.differences.slice(0, 5).map((x) => `${x.sheet}!${x.ref} ${JSON.stringify(x.a)} ≠ ${JSON.stringify(x.b)}`).join('; ')}` : ''}${d.removed?.length ? ` Missing lines: ${d.removed.slice(0, 3).join(' | ')}` : ''}`);
    }
  }
  if (exp.findsAll) await verifyFindings(exp.findsAll, file, rel, baseDir, { ok, bad });
  return { file: rel, kind, ok: !failed.length, passed, failed };
}

async function verifyTable(exp, file, rel, kind, { ok, bad }) {
  const wb = await readWorkbook(file, { maxRows: 200000 });
  for (const s of list(exp.sheets)) wb.sheets.some((x) => normName(x.name) === normName(s)) ? ok(`sheet "${s}"`) : bad(`${rel} has no sheet "${s}" (sheets: ${wb.sheets.map((x) => x.name).join(', ')}).`);
  const pick = (name) => (name ? wb.sheets.find((x) => normName(x.name) === normName(name)) : wb.sheets[0]);
  const sheet = pick(exp.sheet);
  if (exp.sheet && !sheet) return bad(`${rel} has no sheet "${exp.sheet}".`);
  const rows = sheet ? sheet.rows.filter((r) => r.some((v) => cellText(v).trim() !== '')) : [];
  const dataRows = Math.max(0, rows.length - 1);
  if (exp.minRows !== undefined) dataRows >= exp.minRows ? ok(`${dataRows} data row(s) ≥ ${exp.minRows}`) : bad(`${rel}${exp.sheet ? ` [${sheet.name}]` : ''} has ${dataRows} data row(s); expected at least ${exp.minRows}.`);
  if (exp.maxRows !== undefined) dataRows <= exp.maxRows ? ok(`${dataRows} data row(s) ≤ ${exp.maxRows}`) : bad(`${rel}${exp.sheet ? ` [${sheet.name}]` : ''} has ${dataRows} data row(s); expected at most ${exp.maxRows}.`);
  if (exp.columns?.length) {
    const head = (rows[0] || []).map((v) => normName(cellText(v)));
    for (const c of exp.columns) head.includes(normName(c)) ? ok(`column "${c}"`) : bad(`${rel}${sheet ? ` [${sheet.name}]` : ''} has no column "${c}" (header: ${(rows[0] || []).map(cellText).join(' | ') || 'empty'}).`);
  }
  if (exp.noErrors) {
    const errs = wb.sheets.flatMap((s) => s.errors.filter((e) => EXCEL_ERRORS.includes(e.error)).map((e) => `${s.name}!${e.ref} ${e.error}`));
    errs.length ? bad(`${rel} has formula errors: ${errs.slice(0, 8).join(', ')}.`) : ok('no formula errors');
  }
  for (const [ref, want] of Object.entries(exp.cells || {})) {
    const p = parseRef(ref);
    if (!p) {
      bad(`Cell reference "${ref}" is not valid (use A1 or Sheet!A1).`);
      continue;
    }
    const s = p.sheet ? pick(p.sheet) : sheet;
    if (!s) {
      bad(`${rel} has no sheet "${p.sheet}" (for ${ref}).`);
      continue;
    }
    const value = s.rows[p.row]?.[p.col] ?? null;
    const label = `${s.name}!${colLetter(p.col)}${p.row + 1}`;
    const res = cellMatches(value, want, s.formulas?.[`${colLetter(p.col)}${p.row + 1}`]);
    res === true ? ok(`${label} = ${JSON.stringify(value)}`) : bad(`${rel} ${label}: ${res}`);
  }
}

function cellMatches(value, want, formula) {
  const got = JSON.stringify(value);
  if (want === null || typeof want !== 'object') return sameValue(value, want, 1e-9) ? true : `is ${got}, expected ${JSON.stringify(want)}`;
  const n = typeof value === 'number' ? value : parseNumber(value);
  if (want.nonEmpty && (value === null || cellText(value).trim() === '')) return 'is empty';
  if (want.formula && !formula) return `is a plain value (${got}), expected a formula`;
  if (want.equals !== undefined && !sameValue(value, want.equals, 1e-9)) return `is ${got}, expected ${JSON.stringify(want.equals)}`;
  if (want.approx !== undefined) {
    const tol = want.tolerance ?? Math.max(1e-6, Math.abs(want.approx) * 1e-4);
    if (n === null || Math.abs(n - want.approx) > tol) return `is ${got}, expected ≈ ${want.approx} (±${tol})`;
  }
  if (want.min !== undefined && (n === null || n < want.min)) return `is ${got}, expected ≥ ${want.min}`;
  if (want.max !== undefined && (n === null || n > want.max)) return `is ${got}, expected ≤ ${want.max}`;
  if (want.contains !== undefined && !fold(cellText(value)).includes(fold(want.contains))) return `is ${got}, expected to contain "${want.contains}"`;
  return true;
}

/** Recall of planted anomalies: which ids of the answer key appear in the output's id column. */
async function verifyFindings(spec, file, rel, baseDir, { ok, bad }) {
  const keyFile = path.resolve(baseDir, String(spec.key || ''));
  const key = JSON.parse(await fsp.readFile(keyFile, 'utf8').catch(() => 'null'));
  if (!key?.anomalies) return bad(`Answer key ${spec.key} not found or not a SleepPilot sample key.`);
  const column = spec.column || key.idColumn;
  const types = list(spec.types);
  const expected = new Set(key.anomalies.filter((a) => !types.length || types.includes(a.type)).map((a) => String(a.id)));
  const wb = await readWorkbook(file, { maxRows: 500000 });
  const sheets = spec.sheet ? wb.sheets.filter((s) => normName(s.name) === normName(spec.sheet)) : wb.sheets;
  const found = new Set();
  let columnSeen = false;
  for (const s of sheets) {
    const headerRow = s.rows.findIndex((r) => r.some((v) => normName(cellText(v)) === normName(column)));
    if (headerRow < 0) continue;
    columnSeen = true;
    const c = s.rows[headerRow].findIndex((v) => normName(cellText(v)) === normName(column));
    for (const r of s.rows.slice(headerRow + 1)) if (cellText(r[c]).trim()) found.add(cellText(r[c]).trim());
  }
  if (!columnSeen) return bad(`${rel} has no column "${column}" to match the answer key against.`);
  const hit = [...expected].filter((id) => found.has(id));
  const missed = [...expected].filter((id) => !found.has(id));
  const recall = expected.size ? hit.length / expected.size : 1;
  const minRecall = spec.minRecall ?? 1;
  const byType = {};
  for (const a of key.anomalies) if (expected.has(String(a.id)) && !found.has(String(a.id))) byType[a.type] = (byType[a.type] || 0) + 1;
  recall >= minRecall
    ? ok(`found ${hit.length}/${expected.size} planted anomalies (recall ${(recall * 100).toFixed(1)}%)`)
    : bad(`${rel} found ${hit.length}/${expected.size} planted anomalies (recall ${(recall * 100).toFixed(1)}%, required ${(minRecall * 100).toFixed(0)}%). Missed by type: ${Object.entries(byType).map(([t, n]) => `${t} ${n}`).join(', ')}. Missed ids (first 10): ${missed.slice(0, 10).join(', ')}.`);
  if (spec.maxFalsePositives !== undefined) {
    // The first copy of a duplicate is "related", not a false positive.
    const all = new Set(key.anomalies.flatMap((a) => [String(a.id), ...(a.related || []).map(String)]));
    const fp = [...found].filter((id) => !all.has(id));
    fp.length <= spec.maxFalsePositives ? ok(`${fp.length} false positive(s)`) : bad(`${rel} flags ${fp.length} record(s) that are not planted anomalies (allowed ${spec.maxFalsePositives}); first: ${fp.slice(0, 10).join(', ')}.`);
  }
}

const list = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
const within = (n, spec) => (typeof spec === 'number' ? n === spec : (spec.min === undefined || n >= spec.min) && (spec.max === undefined || n <= spec.max));
const range = (spec) => (typeof spec === 'number' ? String(spec) : `${spec.min ?? 0}…${spec.max ?? '∞'}`);
