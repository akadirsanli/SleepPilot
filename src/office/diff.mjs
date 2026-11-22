import fsp from 'node:fs/promises';
import { detectKind, colLetter } from './inspect.mjs';
import { readWorkbook } from './excel.mjs';
import { readDocx } from './word.mjs';
import { readPdf } from './pdf.mjs';
import { readPptx } from './slides.mjs';
import { pngDiff } from './image.mjs';
import { cellText, parseNumber } from './values.mjs';

/** Plain text of a document-like file (docx, pdf, pptx, csv, xlsx). */
export async function textOf(file, kind = null) {
  kind = kind || (await detectKind(file));
  if (kind === 'docx') return (await readDocx(file)).text;
  if (kind === 'pdf') return (await readPdf(file)).text;
  if (kind === 'pptx') return (await readPptx(file)).text;
  if (kind === 'xlsx' || kind === 'csv') return (await readWorkbook(file, { maxRows: 100000 })).sheets.map((s) => s.rows.map((r) => r.map(cellText).join('\t')).join('\n')).join('\n\n');
  return '';
}

/**
 * Compare two files of the same kind.
 *  tables (xlsx/csv): sheet by sheet, cell by cell; numbers equal within `tolerance`
 *  documents (docx/pdf/pptx): line diff of the text
 *  images (png): share of changed pixels
 */
export async function diffFiles(a, b, { tolerance = 1e-6, maxDiffs = 100, imageThreshold = 0.001 } = {}) {
  const [ka, kb] = await Promise.all([detectKind(a), detectKind(b)]);
  const tabular = (k) => k === 'xlsx' || k === 'csv';
  if (tabular(ka) && tabular(kb)) return diffTables(a, b, { tolerance, maxDiffs });
  if (ka !== kb) return { same: false, kind: `${ka}/${kb}`, summary: `Different file kinds: ${ka} vs ${kb}.`, differences: [] };
  if (ka === 'image') {
    const r = pngDiff(await fsp.readFile(a), await fsp.readFile(b));
    const same = r.sameSize && r.changed <= imageThreshold;
    return { same, kind: 'image', summary: r.sameSize ? `${(r.changed * 100).toFixed(2)}% of the pixels differ.` : `Different sizes: ${r.a.join('×')} vs ${r.b.join('×')}.`, differences: [], ...r };
  }
  if (['docx', 'pdf', 'pptx'].includes(ka)) {
    const [ta, tb] = await Promise.all([textOf(a, ka), textOf(b, kb)]);
    const d = lineDiff(ta, tb, maxDiffs);
    return { same: !d.removed.length && !d.added.length, kind: ka, summary: d.removed.length || d.added.length ? `${d.removed.length} line(s) only in the first file, ${d.added.length} only in the second.` : 'Same text.', removed: d.removed, added: d.added, differences: [] };
  }
  const [ba, bb] = await Promise.all([fsp.readFile(a), fsp.readFile(b)]);
  return { same: ba.equals(bb), kind: ka, summary: ba.equals(bb) ? 'Identical bytes.' : 'The bytes differ.', differences: [] };
}

async function diffTables(a, b, { tolerance, maxDiffs }) {
  const [wa, wb] = await Promise.all([readWorkbook(a, { maxRows: 200000 }), readWorkbook(b, { maxRows: 200000 })]);
  const differences = [];
  let total = 0;
  const single = wa.sheets.length === 1 && wb.sheets.length === 1;
  const onlyA = single ? [] : wa.sheets.filter((s) => !wb.sheets.some((t) => t.name === s.name)).map((s) => s.name);
  const onlyB = single ? [] : wb.sheets.filter((s) => !wa.sheets.some((t) => t.name === s.name)).map((s) => s.name);
  for (const sa of wa.sheets) {
    const sb = single ? wb.sheets[0] : wb.sheets.find((t) => t.name === sa.name);
    if (!sb) continue;
    const rows = Math.max(sa.rows.length, sb.rows.length);
    for (let r = 0; r < rows; r++) {
      const ra = sa.rows[r] || [];
      const rb = sb.rows[r] || [];
      for (let c = 0; c < Math.max(ra.length, rb.length); c++) {
        if (sameValue(ra[c], rb[c], tolerance)) continue;
        total++;
        if (differences.length < maxDiffs) differences.push({ sheet: sa.name, ref: `${colLetter(c)}${r + 1}`, a: ra[c] ?? null, b: rb[c] ?? null });
      }
    }
  }
  const same = !total && !onlyA.length && !onlyB.length;
  return {
    same,
    kind: 'table',
    summary: same ? 'Same sheets and cell values.' : `${total} cell(s) differ${onlyA.length ? `; sheets only in the first: ${onlyA.join(', ')}` : ''}${onlyB.length ? `; sheets only in the second: ${onlyB.join(', ')}` : ''}.`,
    totalDifferences: total,
    differences,
    sheetsOnlyInA: onlyA,
    sheetsOnlyInB: onlyB,
  };
}

export function sameValue(x, y, tolerance = 1e-6) {
  const ex = x === null || x === undefined || x === '';
  const ey = y === null || y === undefined || y === '';
  if (ex || ey) return ex && ey;
  const nx = typeof x === 'number' ? x : parseNumber(x);
  const ny = typeof y === 'number' ? y : parseNumber(y);
  if (nx !== null && ny !== null) return Math.abs(nx - ny) <= tolerance;
  return cellText(x).trim() === cellText(y).trim();
}

function lineDiff(ta, tb, max) {
  const la = ta.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 3000);
  const lb = tb.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 3000);
  const n = la.length;
  const m = lb.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = la[i] === lb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const removed = [];
  const added = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && la[i] === lb[j]) {
      i++;
      j++;
    } else if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) added.push(lb[j++]);
    else removed.push(la[i++]);
  }
  return { removed: removed.slice(0, max), added: added.slice(0, max) };
}
