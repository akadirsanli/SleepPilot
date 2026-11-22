import { lib } from './deps.mjs';

/**
 * CSV / TSV text files. Exports from many European systems use ";" as the separator and a legacy
 * code page (e.g. Windows-1252 or Windows-1254), so the encoding and the delimiter are detected,
 * not assumed.
 */

/** Decode bytes: UTF-8/UTF-16 by BOM, otherwise strict UTF-8, otherwise Windows-1254 (Latin letters incl. Turkish). */
export function decodeText(buf, encoding = 'auto') {
  if (encoding && encoding !== 'auto') return { text: lib('iconv-lite').decode(buf, encoding).replace(/^﻿/, ''), encoding };
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return { text: buf.subarray(3).toString('utf8'), encoding: 'utf-8-bom' };
  if (buf[0] === 0xff && buf[1] === 0xfe) return { text: buf.subarray(2).toString('utf16le'), encoding: 'utf-16le' };
  if (buf[0] === 0xfe && buf[1] === 0xff) return { text: lib('iconv-lite').decode(buf.subarray(2), 'utf-16be'), encoding: 'utf-16be' };
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), encoding: 'utf-8' };
  } catch {
    return { text: lib('iconv-lite').decode(buf, 'windows-1254'), encoding: 'windows-1254' };
  }
}

/** Parse CSV text into rows of strings; the delimiter is guessed among , ; TAB and |. */
export function parseCsv(text, { delimiter = '' } = {}) {
  const Papa = lib('papaparse');
  const r = Papa.parse(text, { delimiter, delimitersToGuess: [';', ',', '\t', '|'], skipEmptyLines: 'greedy' });
  const errors = (r.errors || []).filter((e) => e.code !== 'UndetectableDelimiter').slice(0, 20).map((e) => `row ${e.row ?? '?'}: ${e.message}`);
  return { rows: r.data, delimiter: r.meta.delimiter, errors };
}

/** Read a CSV/TSV file: { rows, delimiter, encoding, errors }. */
export async function readCsv(file, { encoding = 'auto', delimiter = '' } = {}) {
  const fsp = await import('node:fs/promises');
  const buf = await fsp.readFile(file);
  const decoded = decodeText(buf, encoding);
  const parsed = parseCsv(decoded.text, { delimiter: delimiter || (/\.tsv$/i.test(file) ? '\t' : '') });
  return { ...parsed, encoding: decoded.encoding };
}

/**
 * Write rows as CSV. Default: "," with a UTF-8 BOM (the BOM makes Excel read UTF-8 correctly).
 * Use delimiter ";" for locales whose Excel expects it, and an `encoding` such as
 * 'windows-1252' or 'windows-1254' for systems that need a legacy code page.
 */
export function csvBuffer(rows, { delimiter = ',', bom = true, encoding = 'utf-8' } = {}) {
  const Papa = lib('papaparse');
  const text = Papa.unparse(rows.map((r) => r.map((v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v ?? ''))), { delimiter, newline: '\r\n' });
  if (/^utf-?8$/i.test(encoding)) return Buffer.from((bom ? '﻿' : '') + text, 'utf8');
  return lib('iconv-lite').encode(text, encoding);
}
