import { parseNumber, parseDate, isoDate, cellText } from './values.mjs';

/**
 * Column profile of a table: type, fill rate, unique values, numeric/date range and the most
 * frequent values. This is what an analysis app — and the agent building it — needs to know
 * about a sheet before writing code against it.
 */
export function profileTable(rows, { header = true, maxColumns = 60, topN = 5 } = {}) {
  const nonEmptyRows = rows.filter((r) => Array.isArray(r) && r.some((v) => cellText(v).trim() !== ''));
  if (!nonEmptyRows.length) return { header: [], rowCount: 0, columns: [], duplicateRows: 0 };
  const width = Math.min(maxColumns, Math.max(...nonEmptyRows.map((r) => r.length)));
  const head = header ? nonEmptyRows[0].slice(0, width).map((v, i) => cellText(v).trim() || `Column ${i + 1}`) : Array.from({ length: width }, (_, i) => `Column ${i + 1}`);
  const data = header ? nonEmptyRows.slice(1) : nonEmptyRows;
  const seen = new Map();
  let duplicateRows = 0;
  for (const r of data) {
    const key = JSON.stringify(r.slice(0, width).map(cellText));
    if (seen.has(key)) duplicateRows++;
    else seen.set(key, true);
  }
  const columns = head.map((name, c) => {
    let filled = 0;
    let numbers = 0;
    let dates = 0;
    let bools = 0;
    let sum = 0;
    let min = Infinity;
    let max = -Infinity;
    let dmin = null;
    let dmax = null;
    let negatives = 0;
    const counts = new Map();
    for (const r of data) {
      const v = r[c];
      const t = cellText(v).trim();
      if (!t) continue;
      filled++;
      counts.set(t, (counts.get(t) || 0) + 1);
      if (typeof v === 'boolean') {
        bools++;
        continue;
      }
      const d = v instanceof Date ? v : typeof v === 'string' ? parseDate(v) : null;
      if (d) {
        dates++;
        if (!dmin || d < dmin) dmin = d;
        if (!dmax || d > dmax) dmax = d;
        continue;
      }
      // "0101" is a code (store, product, postcode), not a number.
      const n = typeof v === 'string' && /^0\d/.test(v.trim()) ? null : parseNumber(v);
      if (n !== null) {
        numbers++;
        sum += n;
        if (n < min) min = n;
        if (n > max) max = n;
        if (n < 0) negatives++;
      }
    }
    const share = (k) => (filled ? k / filled : 0);
    const type = !filled ? 'empty' : share(numbers) >= 0.9 ? 'number' : share(dates) >= 0.9 ? 'date' : share(bools) >= 0.9 ? 'boolean' : numbers + dates > 0 && share(numbers + dates) < 0.9 ? 'mixed' : 'text';
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN).map(([value, count]) => ({ value: value.slice(0, 80), count }));
    return {
      index: c,
      name,
      type,
      filled,
      empty: data.length - filled,
      unique: counts.size,
      ...(type === 'number' ? { min, max, sum: round(sum), mean: round(sum / numbers), negatives } : {}),
      ...(type === 'date' ? { from: isoDate(dmin), to: isoDate(dmax) } : {}),
      top,
    };
  });
  return { header: head, rowCount: data.length, columns, duplicateRows };
}

const round = (n) => Math.round(n * 1e6) / 1e6;

/** A Markdown table of the first rows (for agents, reviewers and the CLI). */
export function markdownTable(rows, { maxRows = 15, maxCols = 12, maxCell = 40 } = {}) {
  const shown = rows.filter((r) => Array.isArray(r)).slice(0, maxRows + 1);
  if (!shown.length) return '(empty)';
  const width = Math.min(maxCols, Math.max(...shown.map((r) => r.length)));
  const cell = (v) => cellText(v).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').slice(0, maxCell);
  const line = (r) => `| ${Array.from({ length: width }, (_, i) => cell(r[i])).join(' | ')} |`;
  const out = [line(shown[0]), `|${' --- |'.repeat(width)}`, ...shown.slice(1).map(line)];
  if (rows.length > shown.length) out.push(`… ${rows.length - shown.length} more row(s)`);
  return out.join('\n');
}
