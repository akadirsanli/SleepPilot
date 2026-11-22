/**
 * Value helpers shared by the readers, the profiler and the checks: English and European number
 * formats, dd.mm.yyyy dates and a stable text form for every cell value.
 */

const NUM_PLAIN = /^[-+]?\d+(\.\d+)?([eE][-+]?\d+)?$/;
const NUM_TR = /^[-+]?\d{1,3}(\.\d{3})+(,\d+)?$|^[-+]?\d+,\d+$/; // 1.234.567,89 · 12,5
const NUM_EN = /^[-+]?\d{1,3}(,\d{3})+(\.\d+)?$/; // 1,234,567.89
const CURRENCY = /\s*(₺|TL|TRY|USD|EUR|\$|€)\s*/gi;

/** Parse a number in English or European style ("1,234.56", "1.234,56", "12.5%", "%12,5", "250 TL"). */
export function parseNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  let s = value.trim().replace(CURRENCY, '').replace(/ /g, ' ').trim();
  if (!s) return null;
  let percent = false;
  if (/^%/.test(s) || /%$/.test(s)) {
    percent = true;
    s = s.replace(/%/g, '').trim();
  }
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/\s/g, '');
  let n = null;
  if (NUM_PLAIN.test(s)) n = Number(s);
  else if (NUM_TR.test(s)) n = Number(s.replace(/\./g, '').replace(',', '.'));
  else if (NUM_EN.test(s)) n = Number(s.replace(/,/g, ''));
  if (n === null || !Number.isFinite(n)) return null;
  if (negative) n = -n;
  return percent ? n / 100 : n;
}

/** Parse a date: ISO (2024-01-31[T…]), dd.mm.yyyy, dd/mm/yyyy, dd-mm-yyyy (+ optional hh:mm[:ss]). */
export function parseDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== 'string') return null;
  const s = value.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (m) return mk(+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (m) return mk(+m[3], +m[2], +m[1], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  return null;
}

function mk(y, mo, d, h, mi, se) {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || se > 59) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d, h, mi, se));
  return dt.getUTCMonth() === mo - 1 ? dt : null;
}

/** ISO text for a date: "2024-01-31" or "2024-01-31T14:05:00". */
export function isoDate(d) {
  const iso = d.toISOString();
  return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.slice(0, 19);
}

/** The text a person would compare against: numbers as-is, dates ISO, booleans TRUE/FALSE. */
export function cellText(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return isoDate(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return String(v);
}

/**
 * Case-insensitive form of a text in any language. The dotted/dotless I of Turkish (İ ı) folds to
 * a plain i, so "INVOICE", "Invoice" and "invoice" match, and so do Turkish spellings of a name.
 */
export function fold(s) {
  return String(s ?? '').replace(/[İIı]/g, 'i').toLowerCase();
}

/** Normalise a header/name for tolerant comparison (case, dotted/dotless I, spaces). */
export function normName(s) {
  return fold(s).replace(/\s+/g, ' ').trim();
}

/** Values that almost always mean a bug in generated output. */
export const JUNK_VALUES = ['undefined', 'NaN', '[object Object]', 'Invalid Date', 'Infinity', '-Infinity'];
export const JUNK_TEXT = /\[object Object\]|Invalid Date|\bNaN\b|\bundefined\b/;

/** Excel error values that point at a broken formula (#N/A is reported but often intended). */
export const EXCEL_ERRORS = ['#REF!', '#DIV/0!', '#VALUE!', '#NAME?', '#NUM!', '#NULL!', '#SPILL!', '#CALC!'];
