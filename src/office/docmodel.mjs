/**
 * One document model for Word, PDF and PowerPoint output. A document is
 *   { title?, subtitle?, author?, header?, footer?, landscape?, locale?, blocks: [...] }
 * or Markdown text. Blocks:
 *   { type: 'heading', text, level }           # / ## / ###
 *   { type: 'paragraph', text }                **bold**, *italic*
 *   { type: 'bullets' | 'numbered', items }    - item / 1. item
 *   { type: 'table', header, rows, widths? }   | a | b |
 *   { type: 'kv', items: [[key, value]] }      key-value box (report details)
 *   { type: 'callout', text, tone }            > text  (tone: info | warning | risk | ok)
 *   { type: 'image', path, width?, caption? }  ![caption](path)
 *   { type: 'chart', chart, width?, caption? } ```chart {json}```
 *   { type: 'pagebreak' }                      \pagebreak or <!-- pagebreak -->
 */
export function toDocument(input) {
  if (typeof input === 'string') return { blocks: markdownToBlocks(input) };
  const doc = { ...(input || {}) };
  // Explicit blocks (a cover box, report details) come first, then the Markdown body.
  if (typeof doc.markdown === 'string') doc.blocks = [...(doc.blocks || []), ...markdownToBlocks(doc.markdown)];
  doc.blocks = (Array.isArray(doc.blocks) ? doc.blocks : Array.isArray(doc.content) ? doc.content : []).map(normalizeBlock).filter(Boolean);
  return doc;
}

function normalizeBlock(b) {
  if (typeof b === 'string') return { type: 'paragraph', text: b };
  if (!b || typeof b !== 'object') return null;
  const type = String(b.type || (b.items ? 'bullets' : b.rows ? 'table' : b.chart ? 'chart' : 'paragraph')).toLowerCase();
  if (type === 'heading' || type === 'title') return { type: 'heading', text: String(b.text ?? ''), level: type === 'title' ? 0 : Math.min(3, Math.max(1, Number(b.level) || 1)) };
  if (type === 'table') return { type: 'table', header: b.header || b.columns || null, rows: (b.rows || []).map((r) => (Array.isArray(r) ? r : Object.values(r))), widths: b.widths || null, caption: b.caption || null };
  if (type === 'kv') return { type: 'kv', items: (b.items || []).map((it) => (Array.isArray(it) ? it : [it.key ?? it.label, it.value])) };
  if (type === 'bullets' || type === 'numbered' || type === 'list') return { type: type === 'list' ? (b.ordered ? 'numbered' : 'bullets') : type, items: (b.items || []).map(String) };
  return { ...b, type };
}

export function markdownToBlocks(md) {
  const lines = String(md).replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let para = [];
  const flush = () => {
    if (para.length) blocks.push({ type: 'paragraph', text: para.join(' ').trim() });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    if (!t) {
      flush();
      continue;
    }
    let m;
    if ((m = /^(#{1,4})\s+(.*)$/.exec(t))) {
      flush();
      blocks.push({ type: 'heading', text: m[2].trim(), level: Math.min(3, m[1].length) });
    } else if (/^(\\pagebreak|<!--\s*pagebreak\s*-->|\\newpage)$/i.test(t)) {
      flush();
      blocks.push({ type: 'pagebreak' });
    } else if ((m = /^```\s*(chart|json chart)\s*$/i.exec(t))) {
      flush();
      const body = [];
      while (++i < lines.length && !/^```/.test(lines[i].trim())) body.push(lines[i]);
      try {
        blocks.push({ type: 'chart', chart: JSON.parse(body.join('\n')) });
      } catch (err) {
        blocks.push({ type: 'callout', tone: 'warning', text: `Chart JSON could not be read: ${err.message}` });
      }
    } else if (/^```/.test(t)) {
      flush();
      const body = [];
      while (++i < lines.length && !/^```/.test(lines[i].trim())) body.push(lines[i]);
      blocks.push({ type: 'code', text: body.join('\n') });
    } else if ((m = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)$/.exec(t))) {
      flush();
      blocks.push({ type: 'image', path: m[2], caption: m[1] || null });
    } else if (/^\|.*\|$/.test(t)) {
      flush();
      const rows = [];
      let j = i;
      while (j < lines.length && /^\|.*\|$/.test(lines[j].trim())) rows.push(lines[j++].trim());
      i = j - 1;
      const cells = (r) => r.slice(1, -1).split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
      const sepIdx = rows.findIndex((r) => /^\|(\s*:?-{2,}:?\s*\|)+$/.test(r));
      if (sepIdx === 1) blocks.push({ type: 'table', header: cells(rows[0]), rows: rows.slice(2).map(cells) });
      else blocks.push({ type: 'table', header: null, rows: rows.filter((_, k) => k !== sepIdx).map(cells) });
    } else if (/^[-*+]\s+/.test(t)) {
      flush();
      const items = [];
      let j = i;
      while (j < lines.length && /^\s*[-*+]\s+/.test(lines[j])) items.push(lines[j++].trim().replace(/^[-*+]\s+/, ''));
      i = j - 1;
      blocks.push({ type: 'bullets', items });
    } else if (/^\d+[.)]\s+/.test(t)) {
      flush();
      const items = [];
      let j = i;
      while (j < lines.length && /^\s*\d+[.)]\s+/.test(lines[j])) items.push(lines[j++].trim().replace(/^\d+[.)]\s+/, ''));
      i = j - 1;
      blocks.push({ type: 'numbered', items });
    } else if (/^>\s?/.test(t)) {
      flush();
      const body = [];
      let j = i;
      while (j < lines.length && /^\s*>/.test(lines[j])) body.push(lines[j++].trim().replace(/^>\s?/, ''));
      i = j - 1;
      let text = body.join(' ');
      let tone = 'info';
      const tm = /^\[!(\w+)\]\s*/.exec(text);
      if (tm) {
        tone = { note: 'info', info: 'info', tip: 'ok', warning: 'warning', caution: 'risk', important: 'risk', risk: 'risk', ok: 'ok' }[tm[1].toLowerCase()] || 'info';
        text = text.slice(tm[0].length);
      }
      blocks.push({ type: 'callout', tone, text });
    } else if (/^(-{3,}|\*{3,})$/.test(t)) {
      flush();
      blocks.push({ type: 'rule' });
    } else para.push(t);
  }
  flush();
  return blocks;
}

/** Split **bold** / *italic* / `code` markup into runs: [{ text, bold, italic, code }]. */
export function inlineRuns(text) {
  const runs = [];
  const re = /(\*\*([^*]+)\*\*|__([^_]+)__|\*([^*]+)\*|`([^`]+)`)/g;
  let last = 0;
  let m;
  const s = String(text ?? '');
  while ((m = re.exec(s))) {
    if (m.index > last) runs.push({ text: s.slice(last, m.index) });
    if (m[2] || m[3]) runs.push({ text: m[2] || m[3], bold: true });
    else if (m[4]) runs.push({ text: m[4], italic: true });
    else runs.push({ text: m[5], code: true });
    last = m.index + m[0].length;
  }
  if (last < s.length) runs.push({ text: s.slice(last) });
  return runs.length ? runs : [{ text: '' }];
}

export const TONES = {
  info: { fill: 'EAF2FD', border: '3B82F6', label: 'Note' },
  ok: { fill: 'E9F7EF', border: '16A34A', label: 'OK' },
  warning: { fill: 'FFF6E0', border: 'D97706', label: 'Warning' },
  risk: { fill: 'FDECEC', border: 'DC2626', label: 'Risk' },
};

/** Format a table cell for display: numbers in the document's locale. */
export function displayValue(v, locale = 'en-US') {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isInteger(v) ? v.toLocaleString(locale) : v.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (v instanceof Date) return v.toLocaleDateString(locale);
  return String(v);
}
