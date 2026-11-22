import fsp from 'node:fs/promises';
import path from 'node:path';
import { lib } from './deps.mjs';
import { readCsv, csvBuffer } from './csv.mjs';
import { isoDate, parseDate, parseNumber, EXCEL_ERRORS } from './values.mjs';
import { chartPng } from './chart.mjs';

/**
 * Excel workbooks (.xlsx / .xlsm) through ExcelJS, plus CSV through the same shape:
 *   { kind, sheets: [{ name, state, rowCount, columnCount, rows, formulas, errors, merges }], definedNames }
 * Cell values are plain JSON: numbers, strings, booleans, null and dates as ISO text.
 */

function plain(v) {
  if (v === null || v === undefined) return { value: null };
  if (v instanceof Date) return { value: isoDate(v), date: true };
  if (typeof v !== 'object') return { value: v };
  if ('formula' in v || 'sharedFormula' in v) {
    const r = plain(v.result);
    return { ...r, formula: v.formula || v.sharedFormula || '' };
  }
  if ('error' in v) return { value: v.error, error: v.error };
  if (Array.isArray(v.richText)) return { value: v.richText.map((t) => t.text).join('') };
  if ('text' in v) return { value: typeof v.text === 'object' ? plain(v.text).value : v.text, hyperlink: v.hyperlink || null };
  return { value: JSON.stringify(v) };
}

/** Read a workbook. maxRows caps the rows returned per sheet (counts stay exact). */
export async function readWorkbook(file, { maxRows = 5000, encoding = 'auto', delimiter = '' } = {}) {
  if (/\.(csv|tsv|txt)$/i.test(file)) {
    const csv = await readCsv(file, { encoding, delimiter });
    const width = csv.rows.reduce((m, r) => Math.max(m, r.length), 0);
    return {
      kind: 'csv',
      encoding: csv.encoding,
      delimiter: csv.delimiter,
      parseErrors: csv.errors,
      sheets: [{ name: path.basename(file), state: 'visible', rowCount: csv.rows.length, columnCount: width, rows: csv.rows.slice(0, maxRows), truncated: csv.rows.length > maxRows, formulas: {}, errors: [], merges: [] }],
      definedNames: [],
    };
  }
  const ExcelJS = lib('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const sheets = wb.worksheets.map((ws) => {
    const rows = [];
    const formulas = {};
    const errors = [];
    let columnCount = 0;
    let lastRow = 0;
    let formulaCount = 0;
    ws.eachRow({ includeEmpty: false }, (row, r) => {
      lastRow = r;
      if (r > maxRows) {
        row.eachCell({ includeEmpty: false }, (cell) => {
          const p = plain(cell.value);
          if (p.formula !== undefined) formulaCount++;
          if (p.error && errors.length < 200) errors.push({ ref: cell.address, error: p.error });
        });
        return;
      }
      const out = [];
      row.eachCell({ includeEmpty: false }, (cell, c) => {
        const p = plain(cell.value);
        out[c - 1] = p.value;
        if (p.formula !== undefined) {
          formulaCount++;
          if (Object.keys(formulas).length < 500) formulas[cell.address] = p.formula;
        }
        if (p.error && errors.length < 200) errors.push({ ref: cell.address, error: p.error });
        if (typeof p.value === 'string' && EXCEL_ERRORS.includes(p.value) && errors.length < 200) errors.push({ ref: cell.address, error: p.value });
      });
      for (let i = 0; i < out.length; i++) if (out[i] === undefined) out[i] = null;
      columnCount = Math.max(columnCount, out.length);
      while (rows.length < r - 1) rows.push([]);
      rows.push(out);
    });
    return {
      name: ws.name,
      state: ws.state || 'visible',
      rowCount: lastRow,
      columnCount: Math.max(columnCount, ws.actualColumnCount || 0),
      rows,
      truncated: lastRow > maxRows,
      formulas,
      formulaCount,
      errors,
      merges: Object.keys(ws._merges || {}).map((k) => ws._merges[k].range || k).slice(0, 200),
      images: (ws.getImages?.() || []).length,
    };
  });
  const definedNames = (wb.definedNames?.model || []).map((d) => ({ name: d.name, ranges: d.ranges })).slice(0, 100);
  return { kind: 'xlsx', sheets, definedNames, properties: { title: wb.title || null, creator: wb.creator || null, created: wb.created ? isoDate(wb.created) : null } };
}

const FORMATS = {
  text: '@',
  integer: '#,##0',
  number: '#,##0.00',
  money: '#,##0.00',
  try: '#,##0.00 "₺"',
  percent: '0.00%',
  date: 'dd.mm.yyyy',
  datetime: 'dd.mm.yyyy hh:mm',
};

function toCell(v, format) {
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    if (v.formula) return { formula: String(v.formula).replace(/^=/, ''), ...(v.result !== undefined ? { result: v.result } : {}) };
    if (v.date) return parseDate(String(v.date));
    if (v.link) return { text: String(v.text ?? v.link), hyperlink: String(v.link) };
    if ('value' in v) return toCell(v.value, v.format || format);
  }
  if (typeof v === 'string' && /^=/.test(v) && v.length > 1) return { formula: v.slice(1) };
  if ((format === 'date' || format === 'datetime') && typeof v === 'string') return parseDate(v) || v;
  if (['integer', 'number', 'money', 'try', 'percent'].includes(format) && typeof v === 'string') {
    const n = parseNumber(v);
    return n === null ? v : n;
  }
  return v ?? null;
}

/**
 * Create a workbook from a plain spec:
 * { sheets: [{ name, columns: [{ header, width?, format? }], rows: [[…]] | [{header: value}],
 *              freeze?, autoFilter?, totals?: { label, columns: [header…] }, images?: [{ path|chart, range }] }],
 *   properties?: { title, creator } }
 * Formats: text, integer, number, money, try, percent, date, datetime (or an Excel format code).
 * A cell can be a value, "=FORMULA", { formula }, { date }, { link, text } or { value, format, bold, fill, color }.
 */
export async function workbookBuffer(spec = {}, { baseDir = process.cwd() } = {}) {
  const ExcelJS = lib('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.creator = spec.properties?.creator || 'SleepPilot';
  if (spec.properties?.title) wb.title = String(spec.properties.title);
  wb.calcProperties = { fullCalcOnLoad: true };
  const sheets = Array.isArray(spec.sheets) && spec.sheets.length ? spec.sheets : [{ name: 'Sheet1', rows: spec.rows || [] }];
  const used = new Set();
  for (const [si, sheet] of sheets.entries()) {
    let name = String(sheet.name || `Sheet${si + 1}`).replace(/[\\/?*[\]:]/g, ' ').slice(0, 31).trim() || `Sheet${si + 1}`;
    while (used.has(name.toLowerCase())) name = `${name.slice(0, 28)} ${si + 1}`;
    used.add(name.toLowerCase());
    const ws = wb.addWorksheet(name, { views: [] });
    let columns = Array.isArray(sheet.columns) ? sheet.columns.map((c) => (typeof c === 'string' ? { header: c } : c)) : null;
    let rows = Array.isArray(sheet.rows) ? sheet.rows : [];
    if (!columns && rows.length && rows[0] && !Array.isArray(rows[0]) && typeof rows[0] === 'object') columns = Object.keys(rows[0]).map((header) => ({ header }));
    if (columns) rows = rows.map((r) => (Array.isArray(r) ? r : columns.map((c) => r[c.key ?? c.header])));
    const hasHeader = !!columns || sheet.header === true;
    let first = 1;
    if (columns) {
      ws.addRow(columns.map((c) => c.header ?? ''));
      first = 2;
    }
    for (const r of rows) ws.addRow(r.map((v, i) => toCell(v, columns?.[i]?.format)));
    const width = Math.max(columns?.length || 0, ...rows.map((r) => r.length), 0);
    // Formats, styles and widths.
    for (let c = 1; c <= width; c++) {
      const col = ws.getColumn(c);
      const meta = columns?.[c - 1] || {};
      const fmt = meta.format ? FORMATS[meta.format] || meta.format : null;
      if (fmt) col.numFmt = fmt;
      let longest = String(meta.header ?? '').length;
      col.eachCell({ includeEmpty: false }, (cell, r) => {
        const v = cell.value;
        const text = v instanceof Date ? '00.00.0000' : typeof v === 'number' ? v.toLocaleString('en-US', { maximumFractionDigits: 2 }) : v && typeof v === 'object' ? String(v.text ?? v.formula ?? '') : String(v ?? '');
        if (r <= 2000) longest = Math.max(longest, ...text.split('\n').map((l) => l.length));
      });
      col.width = Number(meta.width) || Math.min(60, Math.max(8, longest + 2));
    }
    // Per-cell styles from { value, bold, fill, color, format }.
    rows.forEach((r, ri) => r.forEach((v, ci) => {
      if (!v || typeof v !== 'object' || v instanceof Date) return;
      const cell = ws.getRow(ri + first).getCell(ci + 1);
      if (v.format) cell.numFmt = FORMATS[v.format] || v.format;
      if (v.bold || v.color) cell.font = { ...(cell.font || {}), bold: !!v.bold, ...(v.color ? { color: { argb: argb(v.color) } } : {}) };
      if (v.fill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(v.fill) } };
    }));
    if (hasHeader && width) {
      const head = ws.getRow(1);
      head.font = { bold: true };
      head.alignment = { vertical: 'middle', wrapText: true };
      for (let c = 1; c <= width; c++) {
        head.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EEF7' } };
        head.getCell(c).border = { bottom: { style: 'thin', color: { argb: 'FF8EA2C0' } } };
      }
      if (sheet.freeze !== false) ws.views = [{ state: 'frozen', ySplit: 1 }];
      if (sheet.autoFilter !== false && rows.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: width } };
    }
    if (sheet.totals && columns && rows.length) {
      const label = sheet.totals.label || 'Total';
      const last = rows.length + first - 1;
      const totalRow = ws.addRow(columns.map((c, i) => {
        if ((sheet.totals.columns || []).includes(c.header)) {
          const letter = ws.getColumn(i + 1).letter;
          // The written cell values (after "2.500,75" → 2500.75 and { value } unwrapping).
          let sum = 0;
          for (let r = first; r <= last; r++) {
            const v = ws.getRow(r).getCell(i + 1).value;
            const n = typeof v === 'number' ? v : typeof v?.result === 'number' ? v.result : null;
            if (n !== null) sum += n;
          }
          return { formula: `SUM(${letter}${first}:${letter}${last})`, result: Math.round(sum * 1e9) / 1e9 };
        }
        return i === 0 ? label : null;
      }));
      totalRow.font = { bold: true };
      totalRow.eachCell((cell) => (cell.border = { top: { style: 'thin' } }));
    }
    for (const m of sheet.merges || []) ws.mergeCells(String(m));
    for (const img of sheet.images || []) {
      const buffer = img.chart ? chartPng(img.chart) : await fsp.readFile(path.resolve(baseDir, String(img.path)));
      const id = wb.addImage({ buffer, extension: /\.jpe?g$/i.test(String(img.path || '')) ? 'jpeg' : 'png' });
      ws.addImage(id, String(img.range || `${ws.getColumn(width + 2).letter}2:${ws.getColumn(width + 9).letter}20`));
    }
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function argb(color) {
  const s = String(color).replace(/^#/, '').toUpperCase();
  return s.length === 6 ? `FF${s}` : s;
}

/** Same spec, written as CSV (first sheet). */
export function workbookCsv(spec = {}, opts = {}) {
  const sheet = (spec.sheets || [{ rows: spec.rows || [] }])[0];
  const columns = sheet.columns?.map((c) => (typeof c === 'string' ? c : c.header));
  const rows = (sheet.rows || []).map((r) => (Array.isArray(r) ? r : (columns || Object.keys(r)).map((k) => r[k])));
  const head = columns || (sheet.rows?.[0] && !Array.isArray(sheet.rows[0]) ? Object.keys(sheet.rows[0]) : null);
  return csvBuffer(head ? [head, ...rows] : rows, { delimiter: opts.delimiter || spec.delimiter || ',', encoding: opts.encoding || spec.encoding || 'utf-8', bom: spec.bom !== false });
}
