import fsp from 'node:fs/promises';
import path from 'node:path';
import { readWorkbook } from './excel.mjs';
import { readDocx } from './word.mjs';
import { readPdf } from './pdf.mjs';
import { readPptx } from './slides.mjs';
import { readImage } from './image.mjs';
import { profileTable, markdownTable } from './profile.mjs';
import { cellText, JUNK_VALUES, JUNK_TEXT, EXCEL_ERRORS } from './values.mjs';

export const OFFICE_EXT = /\.(xlsx|xlsm|csv|tsv|docx|pdf|pptx|png|jpe?g|gif|webp|xls|doc|ppt)$/i;

/** Detect what a file is, by its first bytes first and its extension second. */
export async function detectKind(file) {
  const handle = await fsp.open(file, 'r');
  const head = Buffer.alloc(8);
  try {
    await handle.read(head, 0, 8, 0);
  } finally {
    await handle.close();
  }
  const ext = path.extname(file).toLowerCase();
  if (head.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (head.readUInt32BE(0) === 0x89504e47 || (head[0] === 0xff && head[1] === 0xd8) || head.subarray(0, 3).toString('latin1') === 'GIF' || head.subarray(0, 4).toString('latin1') === 'RIFF') return 'image';
  if (head.readUInt32BE(0) === 0xd0cf11e0) return 'legacy';
  if (head[0] === 0x50 && head[1] === 0x4b) {
    if (/^\.(xlsx|xlsm|xltx)$/.test(ext)) return 'xlsx';
    if (/^\.(docx|dotx)$/.test(ext)) return 'docx';
    if (/^\.(pptx|potx)$/.test(ext)) return 'pptx';
    return 'zip';
  }
  if (/^\.(csv|tsv|txt)$/.test(ext)) return 'csv';
  return 'unknown';
}

/**
 * Inspect an office file and describe it for a person or an agent:
 * { file, kind, size, ok, error?, summary, details, preview (Markdown), problems: [] }.
 * `problems` lists things that usually mean a bug in generated output (Excel errors, "NaN",
 * "undefined", "[object Object]", scanned PDFs without text …).
 */
export async function inspectFile(file, { maxRows = 15, maxChars = 3000, profile = true } = {}) {
  const st = await fsp.stat(file);
  const base = { file, name: path.basename(file), size: st.size };
  const kind = await detectKind(file);
  try {
    if (kind === 'xlsx' || kind === 'csv') return { ...base, ok: true, ...(await inspectTable(file, { maxRows, profile })) };
    if (kind === 'docx') {
      const d = await readDocx(file);
      const problems = junk(d.text);
      if (!d.text.trim()) problems.push('The document has no text.');
      const outline = d.headings.map((h) => `${'  '.repeat(h.level - 1)}- ${h.text}`).join('\n');
      return {
        ...base, ok: true, kind,
        summary: `Word document: ${d.words} words, ${d.headings.length} heading(s), ${d.paragraphs} paragraph(s), ${d.tables.length} table(s), ${d.images} image(s).`,
        details: { words: d.words, headings: d.headings, paragraphs: d.paragraphs, tables: d.tables.map((t) => ({ rows: t.length, columns: t[0]?.length || 0, header: t[0] || [] })), images: d.images, warnings: d.warnings },
        preview: `${outline ? `Outline:\n${outline}\n\n` : ''}${d.tables[0] ? `First table:\n${markdownTable(d.tables[0], { maxRows: 8 })}\n\n` : ''}Text:\n${clip(d.text, maxChars)}`,
        problems,
      };
    }
    if (kind === 'pdf') {
      const p = await readPdf(file);
      if (p.encrypted) return { ...base, ok: true, kind, summary: 'PDF, password protected: the text cannot be read without the password.', details: { encrypted: true }, preview: '', problems: [] };
      const problems = junk(p.text);
      if (p.likelyScanned) problems.push('The PDF looks scanned (images, no text layer): text extraction needs OCR.');
      else if (!p.text.trim()) problems.push('The PDF has no text.');
      return {
        ...base, ok: true, kind,
        summary: `PDF: ${p.pages} page(s), ${p.textPages} with text${p.imagePages ? `, ${p.imagePages} with images` : ''}${p.metadata.title ? `, title "${p.metadata.title}"` : ''}.`,
        details: { pages: p.pages, textPages: p.textPages, imagePages: p.imagePages, likelyScanned: p.likelyScanned, metadata: p.metadata, pageSizes: p.pageSizes, characters: p.text.length },
        preview: p.pageTexts.slice(0, 3).map((t, i) => `--- page ${i + 1} ---\n${clip(t, Math.floor(maxChars / Math.min(3, p.pageTexts.length || 1)))}`).join('\n'),
        problems,
      };
    }
    if (kind === 'pptx') {
      const p = await readPptx(file);
      const problems = junk(p.text);
      if (!p.slides.length) problems.push('The presentation has no slides.');
      return {
        ...base, ok: true, kind,
        summary: `PowerPoint: ${p.slides.length} slide(s).`,
        details: { slides: p.slides.map((s) => ({ n: s.n, title: s.title, texts: s.texts.length, images: s.images, tables: s.tables, notes: s.notes.length > 0 })) },
        preview: p.slides.slice(0, 12).map((s) => `${s.n}. ${s.title}${s.texts.length > 1 ? `\n   ${s.texts.slice(1, 6).join(' · ').slice(0, 300)}` : ''}`).join('\n'),
        problems,
      };
    }
    if (kind === 'image') {
      const i = await readImage(file);
      // A one-colour image is often intended (a tile, a background), so "blank" is only a note
      // here; the notBlank expectation turns it into a failure for a chart or a report image.
      return { ...base, ok: true, kind, summary: `${i.type.toUpperCase()} image ${i.width ?? '?'}×${i.height ?? '?'}${i.colors !== undefined ? `, ~${i.colors} colour(s)` : ''}${i.blank ? ', BLANK (one colour)' : ''}.`, details: i, preview: '', problems: [] };
    }
    if (kind === 'legacy') {
      return { ...base, ok: false, kind, error: 'Legacy binary Office format (.xls/.doc/.ppt). Convert it to .xlsx/.docx/.pptx first (Excel/Word "Save As", or `sleeppilot office convert <file>` with LibreOffice installed).', summary: 'Legacy Office file (not readable directly).', details: {}, preview: '', problems: [] };
    }
    return { ...base, ok: false, kind, error: 'Not an office file SleepPilot can read (xlsx, xlsm, csv, tsv, docx, pptx, pdf, png, jpg).', summary: 'Unknown file type.', details: {}, preview: '', problems: [] };
  } catch (err) {
    return { ...base, ok: false, kind, error: `Could not read the file: ${err.message}`, summary: `Unreadable ${kind} file.`, details: {}, preview: '', problems: [`The file cannot be opened: ${err.message}`] };
  }
}

async function inspectTable(file, { maxRows, profile }) {
  const wb = await readWorkbook(file, { maxRows: 20000 });
  const problems = [];
  const sheets = wb.sheets.map((s) => {
    const prof = profile ? profileTable(s.rows) : null;
    const junkCells = [];
    s.rows.forEach((r, ri) => r.forEach((v, ci) => {
      if (typeof v === 'string' && JUNK_VALUES.includes(v.trim()) && junkCells.length < 10) junkCells.push(`${colLetter(ci)}${ri + 1}=${v.trim()}`);
    }));
    if (junkCells.length) problems.push(`Sheet "${s.name}": suspicious values ${junkCells.join(', ')}.`);
    const errs = s.errors.filter((e) => EXCEL_ERRORS.includes(e.error));
    if (errs.length) problems.push(`Sheet "${s.name}": ${errs.length} formula error(s) (${errs.slice(0, 5).map((e) => `${e.ref} ${e.error}`).join(', ')}).`);
    return { name: s.name, state: s.state, rows: s.rowCount, columns: s.columnCount, formulas: s.formulaCount || 0, errors: s.errors.slice(0, 20), merges: s.merges.length, profile: prof, preview: markdownTable(s.rows, { maxRows }) };
  });
  if (wb.sheets.every((s) => !s.rowCount)) problems.push('The workbook has no data.');
  if (wb.parseErrors?.length) problems.push(`CSV parse problems: ${wb.parseErrors.slice(0, 3).join('; ')}`);
  const summary = wb.kind === 'csv'
    ? `CSV (${wb.encoding}, delimiter "${wb.delimiter === '\t' ? 'TAB' : wb.delimiter}"): ${sheets[0].rows} row(s) × ${sheets[0].columns} column(s).`
    : `Excel workbook: ${sheets.length} sheet(s) — ${sheets.map((s) => `"${s.name}" ${s.rows}×${s.columns}${s.state !== 'visible' ? ` (${s.state})` : ''}${s.formulas ? `, ${s.formulas} formula(s)` : ''}`).join('; ')}.`;
  const preview = sheets
    .slice(0, 6)
    .map((s) => `### ${s.name} (${s.rows} rows × ${s.columns} columns)\n${s.preview}${s.profile?.columns?.length ? `\nColumns: ${s.profile.columns.map((c) => `${c.name} [${c.type}${c.empty ? `, ${c.empty} empty` : ''}${c.type === 'number' ? `, ${fmt(c.min)}…${fmt(c.max)}, Σ ${fmt(c.sum)}` : ''}${c.type === 'date' ? `, ${c.from}…${c.to}` : ''}]`).join('; ')}${s.profile.duplicateRows ? `\nDuplicate rows: ${s.profile.duplicateRows}` : ''}` : ''}`)
    .join('\n\n');
  return {
    kind: wb.kind,
    summary,
    details: { sheets: sheets.map(({ preview: _p, ...rest }) => rest), definedNames: wb.definedNames, ...(wb.kind === 'csv' ? { encoding: wb.encoding, delimiter: wb.delimiter } : {}) },
    preview,
    problems,
  };
}

const fmt = (n) => (typeof n === 'number' ? n.toLocaleString('en-US', { maximumFractionDigits: 2 }) : String(n));
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}\n… (${s.length - n} more characters)` : s);

function junk(text) {
  const m = JUNK_TEXT.exec(text || '');
  return m ? [`The text contains "${m[0]}" — usually a bug in the code that produced it.`] : [];
}

export function colLetter(i) {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

export function parseRef(ref) {
  const m = /^(?:(?:'([^']+)'|([^!]+))!)?\$?([A-Z]{1,3})\$?(\d+)$/i.exec(String(ref).trim());
  if (!m) return null;
  let col = 0;
  for (const ch of m[3].toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { sheet: m[1] || m[2] || null, row: Number(m[4]) - 1, col: col - 1 };
}

export { cellText };
