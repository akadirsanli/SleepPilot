import fsp from 'node:fs/promises';
import path from 'node:path';
import { lib, pdfjs, fontFiles, ROOT } from './deps.mjs';
import { toDocument, inlineRuns, TONES, displayValue } from './docmodel.mjs';
import { chartSvg } from './chart.mjs';

// ------------------------------------------------------------------ read

/**
 * Read a PDF with pdf.js: page count, metadata and the text of each page with its lines rebuilt
 * from the glyph positions. Scanned pages (images, almost no text) are flagged — they need OCR.
 */
export async function readPdf(file, { maxPages = 200, password = '' } = {}) {
  const data = new Uint8Array(await fsp.readFile(file));
  const lib = await pdfjs();
  const pdfDir = path.join(ROOT, 'node_modules', 'pdfjs-dist');
  const task = lib.getDocument({
    data,
    password,
    isEvalSupported: false,
    useSystemFonts: false,
    disableFontFace: true,
    verbosity: 0,
    standardFontDataUrl: path.join(pdfDir, 'standard_fonts') + path.sep,
    cMapUrl: path.join(pdfDir, 'cmaps') + path.sep,
    cMapPacked: true,
  });
  let pdf;
  try {
    pdf = await task.promise;
  } catch (err) {
    if (err?.name === 'PasswordException') return { kind: 'pdf', encrypted: true, pages: null, text: '', pageTexts: [], error: 'The PDF is password protected.' };
    throw err;
  }
  try {
    const meta = await pdf.getMetadata().catch(() => null);
    const info = meta?.info || {};
    const pageTexts = [];
    const pageSizes = [];
    let imagePages = 0;
    for (let p = 1; p <= Math.min(pdf.numPages, maxPages); p++) {
      const page = await pdf.getPage(p);
      const vp = page.getViewport({ scale: 1 });
      pageSizes.push({ width: Math.round(vp.width), height: Math.round(vp.height) });
      const tc = await page.getTextContent();
      pageTexts.push(linesFromItems(tc.items));
      const ops = await page.getOperatorList().catch(() => null);
      if (ops && ops.fnArray.some((fn) => fn === lib.OPS.paintImageXObject || fn === lib.OPS.paintJpegXObject)) imagePages++;
      page.cleanup();
    }
    const text = pageTexts.join('\n\f\n');
    const textPages = pageTexts.filter((t) => t.replace(/\s/g, '').length >= 20).length;
    return {
      kind: 'pdf',
      encrypted: false,
      pages: pdf.numPages,
      pageSizes: pageSizes.slice(0, 5),
      metadata: { title: info.Title || null, author: info.Author || null, creator: info.Creator || null, producer: info.Producer || null, created: info.CreationDate || null, pdfVersion: info.PDFFormatVersion || null },
      pageTexts,
      text,
      textPages,
      imagePages,
      likelyScanned: pdf.numPages > 0 && textPages === 0 && imagePages > 0,
      truncated: pdf.numPages > maxPages,
    };
  } finally {
    await task.destroy();
  }
}

function linesFromItems(items) {
  const rows = [];
  for (const it of items) {
    if (!it.str && !it.hasEOL) continue;
    const [a, b, , , x, y] = it.transform;
    const size = Math.hypot(a, b) || 10;
    let row = rows.find((r) => Math.abs(r.y - y) <= size * 0.35);
    if (!row) rows.push((row = { y, items: [] }));
    row.items.push({ x, w: it.width || 0, s: it.str, size });
  }
  rows.sort((p, q) => q.y - p.y);
  return rows
    .map((r) => {
      r.items.sort((p, q) => p.x - q.x);
      let out = '';
      let end = null;
      for (const it of r.items) {
        if (end !== null) {
          const gap = it.x - end;
          if (gap > it.size * 1.5) out += '  ';
          else if (gap > it.size * 0.15 && !out.endsWith(' ') && !it.s.startsWith(' ')) out += ' ';
        }
        out += it.s;
        end = it.x + it.w;
      }
      return out.trimEnd();
    })
    .filter((l) => l.trim())
    .join('\n');
}

// ------------------------------------------------------------------ write

/**
 * Create a PDF from the shared document model (or Markdown) with pdfmake: headings, paragraphs
 * with bold/italic, lists, tables (header repeated on each page), key-value boxes, callouts,
 * images, vector charts, page numbers and an optional classification label in the header.
 * `spec.pdfmake` passes a raw pdfmake document definition through unchanged.
 */
export async function pdfBuffer(input, { baseDir = process.cwd() } = {}) {
  const pdfmake = lib('pdfmake');
  pdfmake.setFonts({ Roboto: fontFiles() });
  pdfmake.setUrlAccessPolicy(() => false);
  pdfmake.setLocalAccessPolicy((p) => path.resolve(p).startsWith(path.resolve(baseDir)) || path.resolve(p).startsWith(ROOT));
  const def = input?.pdfmake ? input.pdfmake : await docDefinition(toDocument(input), baseDir);
  const doc = pdfmake.createPdf(def);
  return Buffer.from(await doc.getBuffer());
}

async function docDefinition(doc, baseDir) {
  const locale = doc.locale || 'en-US';
  const content = [];
  if (doc.title) content.push({ text: doc.title, style: 'title' });
  if (doc.subtitle) content.push({ text: doc.subtitle, style: 'subtitle' });
  const pageWidth = (doc.landscape ? 841.89 : 595.28) - 80;
  for (const b of doc.blocks) {
    if (b.type === 'heading') content.push({ text: b.text, style: b.level === 0 ? 'title' : `h${b.level}`, tocItem: false });
    else if (b.type === 'paragraph') content.push({ text: runs(b.text), style: 'p' });
    else if (b.type === 'bullets') content.push({ ul: b.items.map((t) => ({ text: runs(t) })), style: 'list' });
    else if (b.type === 'numbered') content.push({ ol: b.items.map((t) => ({ text: runs(t) })), style: 'list' });
    else if (b.type === 'code') content.push({ text: b.text, style: 'code' });
    else if (b.type === 'rule') content.push({ canvas: [{ type: 'line', x1: 0, y1: 4, x2: pageWidth, y2: 4, lineWidth: 0.5, lineColor: '#B8C2D0' }], margin: [0, 4, 0, 8] });
    else if (b.type === 'pagebreak') content.push({ text: '', pageBreak: 'after' });
    else if (b.type === 'table') content.push(table(b, locale));
    else if (b.type === 'kv') {
      content.push({ table: { widths: [150, '*'], body: b.items.map(([k, v]) => [{ text: String(k ?? ''), bold: true, fillColor: '#F1F4F9' }, { text: displayValue(v, locale) }]) }, layout: thinLayout, style: 'block' });
    } else if (b.type === 'callout') {
      const tone = TONES[b.tone] || TONES.info;
      content.push({ table: { widths: ['*'], body: [[{ text: [{ text: `${b.title || tone.label}: `, bold: true }, ...runs(b.text)], fillColor: `#${tone.fill}`, margin: [8, 6, 8, 6] }]] }, layout: { hLineWidth: () => 0, vLineWidth: (i) => (i === 0 ? 3 : 0), vLineColor: () => `#${tone.border}` }, style: 'block' });
    } else if (b.type === 'image') {
      const file = path.resolve(baseDir, String(b.path));
      const data = await fsp.readFile(file).catch(() => null);
      if (!data) content.push({ text: `[Image not found: ${b.path}]`, color: '#B91C1C' });
      else content.push({ image: `data:image/${/\.jpe?g$/i.test(file) ? 'jpeg' : 'png'};base64,${data.toString('base64')}`, fit: [Math.min(Number(b.width) || pageWidth, pageWidth), 600], alignment: 'center', style: 'block' });
      if (b.caption) content.push({ text: b.caption, style: 'caption' });
    } else if (b.type === 'chart') {
      const width = Math.min(Number(b.width) || pageWidth, pageWidth);
      content.push({ svg: chartSvg({ width: 800, height: 450, ...b.chart }), width, alignment: 'center', style: 'block' });
      if (b.caption) content.push({ text: b.caption, style: 'caption' });
    }
  }
  const label = doc.classification || doc.header || null;
  return {
    pageSize: 'A4',
    pageOrientation: doc.landscape ? 'landscape' : 'portrait',
    pageMargins: [40, label ? 50 : 40, 40, 50],
    info: { title: doc.title || '', author: doc.author || '', creator: 'SleepPilot', producer: 'SleepPilot (pdfmake)' },
    header: label ? () => ({ text: label, alignment: 'right', margin: [40, 20, 40, 0], fontSize: 8, color: '#B91C1C', bold: true }) : undefined,
    footer: (page, pages) => ({ columns: [{ text: doc.footer || '', fontSize: 8, color: '#64748B' }, { text: `${page} / ${pages}`, alignment: 'right', fontSize: 8, color: '#64748B' }], margin: [40, 16, 40, 0] }),
    content,
    defaultStyle: { font: 'Roboto', fontSize: 10, lineHeight: 1.2, color: '#1F2937' },
    styles: {
      title: { fontSize: 20, bold: true, margin: [0, 0, 0, 4], color: '#0F2A4A' },
      subtitle: { fontSize: 12, color: '#475569', margin: [0, 0, 0, 14] },
      h1: { fontSize: 15, bold: true, margin: [0, 14, 0, 6], color: '#0F2A4A' },
      h2: { fontSize: 12.5, bold: true, margin: [0, 10, 0, 4], color: '#1E3A5F' },
      h3: { fontSize: 11, bold: true, margin: [0, 8, 0, 3] },
      p: { margin: [0, 0, 0, 6] },
      list: { margin: [0, 0, 0, 6] },
      block: { margin: [0, 4, 0, 10] },
      caption: { fontSize: 8.5, italics: true, color: '#64748B', alignment: 'center', margin: [0, -6, 0, 10] },
      code: { fontSize: 8.5, color: '#334155', background: '#F1F5F9', margin: [0, 0, 0, 8], preserveLeadingSpaces: true },
      th: { bold: true, fillColor: '#E8EEF7', color: '#0F2A4A' },
    },
  };
}

const thinLayout = { hLineWidth: () => 0.5, vLineWidth: () => 0.5, hLineColor: () => '#C9D2DE', vLineColor: () => '#C9D2DE', paddingTop: () => 3, paddingBottom: () => 3 };

function runs(text) {
  return inlineRuns(text).map((r) => ({ text: r.text, ...(r.bold ? { bold: true } : {}), ...(r.italic ? { italics: true } : {}), ...(r.code ? { background: '#F1F5F9' } : {}) }));
}

function table(b, locale) {
  const width = Math.max(b.header?.length || 0, ...b.rows.map((r) => r.length), 1);
  const small = width > 6;
  const numeric = Array.from({ length: width }, (_, c) => b.rows.length > 0 && b.rows.every((r) => r[c] === null || r[c] === undefined || r[c] === '' || typeof r[c] === 'number'));
  const body = [];
  if (b.header) body.push(Array.from({ length: width }, (_, c) => ({ text: String(b.header[c] ?? ''), style: 'th', alignment: numeric[c] ? 'right' : 'left' })));
  for (const r of b.rows) body.push(Array.from({ length: width }, (_, c) => ({ text: typeof r[c] === 'string' ? runs(r[c]) : displayValue(r[c], locale), alignment: numeric[c] ? 'right' : 'left' })));
  const out = [{ table: { headerRows: b.header ? 1 : 0, dontBreakRows: true, widths: b.widths || Array(width).fill(width <= 3 ? '*' : 'auto').map((w, i) => (i === 0 || width > 4 ? '*' : w)), body }, layout: { ...thinLayout, fillColor: (row) => (b.header && row > 0 && row % 2 === 0 ? '#F8FAFC' : null) }, fontSize: small ? 8 : 9.5, style: 'block' }];
  if (b.caption) out.push({ text: b.caption, style: 'caption' });
  return out;
}

// ------------------------------------------------------------------ page tools (pdf-lib)

/** Merge PDFs in order into one buffer. */
export async function mergePdfs(files) {
  const { PDFDocument } = lib('pdf-lib');
  const out = await PDFDocument.create();
  for (const f of files) {
    const src = await PDFDocument.load(await fsp.readFile(f), { ignoreEncryption: false });
    for (const p of await out.copyPages(src, src.getPageIndices())) out.addPage(p);
  }
  return Buffer.from(await out.save());
}

/** Keep the given pages ("1-3,5", 1-based) of a PDF. */
export async function extractPages(file, ranges) {
  const { PDFDocument } = lib('pdf-lib');
  const src = await PDFDocument.load(await fsp.readFile(file));
  const indices = parseRanges(ranges, src.getPageCount());
  if (!indices.length) throw new Error(`No page matches "${ranges}" (the PDF has ${src.getPageCount()} pages).`);
  const out = await PDFDocument.create();
  for (const p of await out.copyPages(src, indices)) out.addPage(p);
  return Buffer.from(await out.save());
}

export function parseRanges(spec, count) {
  const out = [];
  for (const part of String(spec || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = /^(\d+)?\s*-\s*(\d+)?$/.exec(part);
    const [a, b] = m ? [Number(m[1] || 1), Number(m[2] || count)] : [Number(part), Number(part)];
    for (let p = a; p <= b && p <= count; p++) if (p >= 1 && !out.includes(p - 1)) out.push(p - 1);
  }
  return out;
}
