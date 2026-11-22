import fsp from 'node:fs/promises';
import path from 'node:path';
import { lib } from './deps.mjs';
import { toDocument, inlineRuns, TONES, displayValue } from './docmodel.mjs';
import { chartPng } from './chart.mjs';
import { imageSize } from './image.mjs';

// ------------------------------------------------------------------ read

/**
 * Read a .docx with mammoth: headings, paragraphs, lists and tables (as rows of text), plus the
 * plain text. Images are counted, not extracted.
 */
export async function readDocx(file) {
  const mammoth = lib('mammoth');
  const buffer = await fsp.readFile(file);
  let images = 0;
  const html = await mammoth.convertToHtml({ buffer }, { convertImage: mammoth.images.imgElement(() => (images++, { src: '' })) });
  const raw = await mammoth.extractRawText({ buffer });
  const blocks = htmlBlocks(html.value);
  const text = raw.value.replace(/\n{3,}/g, '\n\n').trim();
  return {
    kind: 'docx',
    blocks,
    headings: blocks.filter((b) => b.type === 'heading').map((b) => ({ level: b.level, text: b.text })),
    tables: blocks.filter((b) => b.type === 'table').map((b) => b.rows),
    paragraphs: blocks.filter((b) => b.type === 'paragraph').length,
    images,
    text,
    words: (text.match(/\S+/g) || []).length,
    warnings: html.messages.filter((m) => m.type === 'warning').map((m) => m.message).slice(0, 20),
  };
}

const decode = (s) => s.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').trim();

function htmlBlocks(html) {
  const blocks = [];
  const re = /<(h[1-6]|p|ul|ol|table)\b[^>]*>([\s\S]*?)<\/\1>/g;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[1];
    if (tag[0] === 'h') blocks.push({ type: 'heading', level: Number(tag[1]), text: decode(m[2]) });
    else if (tag === 'p') {
      const text = decode(m[2]);
      if (text) blocks.push({ type: 'paragraph', text });
    } else if (tag === 'ul' || tag === 'ol') blocks.push({ type: tag === 'ul' ? 'bullets' : 'numbered', items: [...m[2].matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/g)].map((x) => decode(x[1])) });
    else blocks.push({ type: 'table', rows: [...m[2].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map((r) => [...r[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) => decode(c[1]))) });
  }
  return blocks;
}

// ------------------------------------------------------------------ write

/** Create a .docx from the shared document model (or Markdown) with the `docx` library. */
export async function docxBuffer(input, { baseDir = process.cwd() } = {}) {
  const D = lib('docx');
  const doc = toDocument(input);
  const locale = doc.locale || 'en-US';
  const children = [];
  const pageWidthPx = doc.landscape ? 900 : 600;
  let listInstance = 0;
  const textRuns = (text, extra = {}) => inlineRuns(text).map((r) => new D.TextRun({ text: r.text, bold: r.bold || extra.bold, italics: r.italic, font: r.code ? 'Consolas' : undefined, color: extra.color }));
  const border = { style: D.BorderStyle.SINGLE, size: 4, color: 'C9D2DE' };
  const borders = { top: border, bottom: border, left: border, right: border };
  if (doc.title) children.push(new D.Paragraph({ heading: D.HeadingLevel.TITLE, children: [new D.TextRun(doc.title)] }));
  if (doc.subtitle) children.push(new D.Paragraph({ children: [new D.TextRun({ text: doc.subtitle, color: '475569', size: 24 })], spacing: { after: 240 } }));
  const image = (data, widthPx, caption) => {
    const size = imageSize(data) || { width: 800, height: 450 };
    const w = Math.min(widthPx || pageWidthPx, pageWidthPx);
    const h = Math.round((w * (size.height || 450)) / (size.width || 800));
    children.push(new D.Paragraph({ alignment: D.AlignmentType.CENTER, children: [new D.ImageRun({ type: size.type === 'jpeg' ? 'jpg' : 'png', data, transformation: { width: w, height: h } })] }));
    if (caption) children.push(new D.Paragraph({ alignment: D.AlignmentType.CENTER, children: [new D.TextRun({ text: caption, italics: true, size: 18, color: '64748B' })] }));
  };
  for (const b of doc.blocks) {
    if (b.type === 'heading') children.push(new D.Paragraph({ heading: b.level === 0 ? D.HeadingLevel.TITLE : [D.HeadingLevel.HEADING_1, D.HeadingLevel.HEADING_2, D.HeadingLevel.HEADING_3][b.level - 1], children: textRuns(b.text) }));
    else if (b.type === 'paragraph') children.push(new D.Paragraph({ children: textRuns(b.text), spacing: { after: 120 } }));
    else if (b.type === 'code') for (const line of b.text.split('\n')) children.push(new D.Paragraph({ children: [new D.TextRun({ text: line, font: 'Consolas', size: 18 })] }));
    else if (b.type === 'bullets') for (const it of b.items) children.push(new D.Paragraph({ bullet: { level: 0 }, children: textRuns(it) }));
    else if (b.type === 'numbered') {
      listInstance++;
      for (const it of b.items) children.push(new D.Paragraph({ numbering: { reference: 'numbered', level: 0, instance: listInstance }, children: textRuns(it) }));
    } else if (b.type === 'pagebreak') children.push(new D.Paragraph({ children: [new D.PageBreak()] }));
    else if (b.type === 'rule') children.push(new D.Paragraph({ border: { bottom: { style: D.BorderStyle.SINGLE, size: 6, color: 'B8C2D0', space: 1 } } }));
    else if (b.type === 'table' || b.type === 'kv') {
      const rows = b.type === 'kv' ? b.items : b.rows;
      const header = b.type === 'kv' ? null : b.header;
      const width = Math.max(header?.length || 0, ...rows.map((r) => r.length), 1);
      const cell = (v, { head = false, key = false } = {}) => new D.TableCell({
        borders,
        shading: head || key ? { type: D.ShadingType.CLEAR, fill: head ? 'E8EEF7' : 'F1F4F9', color: 'auto' } : undefined,
        margins: { top: 40, bottom: 40, left: 80, right: 80 },
        children: [new D.Paragraph({ alignment: typeof v === 'number' ? D.AlignmentType.RIGHT : D.AlignmentType.LEFT, children: typeof v === 'string' ? textRuns(v, { bold: head || key }) : [new D.TextRun({ text: displayValue(v, locale), bold: head || key })] })],
      });
      const trs = [];
      if (header) trs.push(new D.TableRow({ tableHeader: true, children: Array.from({ length: width }, (_, c) => cell(String(header[c] ?? ''), { head: true })) }));
      for (const r of rows) trs.push(new D.TableRow({ children: Array.from({ length: width }, (_, c) => cell(r[c] ?? '', { key: b.type === 'kv' && c === 0 })) }));
      children.push(new D.Table({ width: { size: 100, type: D.WidthType.PERCENTAGE }, rows: trs }));
      children.push(new D.Paragraph({ children: [], spacing: { after: 120 } }));
      if (b.caption) children.push(new D.Paragraph({ alignment: D.AlignmentType.CENTER, children: [new D.TextRun({ text: b.caption, italics: true, size: 18, color: '64748B' })] }));
    } else if (b.type === 'callout') {
      const tone = TONES[b.tone] || TONES.info;
      children.push(new D.Paragraph({
        shading: { type: D.ShadingType.CLEAR, fill: tone.fill, color: 'auto' },
        border: { left: { style: D.BorderStyle.SINGLE, size: 24, color: tone.border, space: 6 } },
        spacing: { before: 80, after: 160 },
        children: [new D.TextRun({ text: `${b.title || tone.label}: `, bold: true }), ...textRuns(b.text)],
      }));
    } else if (b.type === 'image') {
      const data = await fsp.readFile(path.resolve(baseDir, String(b.path))).catch(() => null);
      if (data && imageSize(data)) image(data, Number(b.width) || null, b.caption);
      else children.push(new D.Paragraph({ children: [new D.TextRun({ text: `[Image not found: ${b.path}]`, color: 'B91C1C' })] }));
    } else if (b.type === 'chart') image(chartPng({ width: 800, height: 450, ...b.chart }), Number(b.width) || null, b.caption);
  }
  const footerChildren = [new D.TextRun({ text: doc.footer ? `${doc.footer}    ` : '', size: 16, color: '64748B' }), new D.TextRun({ children: [D.PageNumber.CURRENT, ' / ', D.PageNumber.TOTAL_PAGES], size: 16, color: '64748B' })];
  const label = doc.classification || doc.header || null;
  const document = new D.Document({
    creator: doc.author || 'SleepPilot',
    title: doc.title || '',
    styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } },
    numbering: { config: [{ reference: 'numbered', levels: [{ level: 0, format: D.LevelFormat.DECIMAL, text: '%1.', alignment: D.AlignmentType.START, style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] }] },
    sections: [{
      properties: { page: { size: { orientation: doc.landscape ? D.PageOrientation.LANDSCAPE : D.PageOrientation.PORTRAIT } } },
      headers: label ? { default: new D.Header({ children: [new D.Paragraph({ alignment: D.AlignmentType.RIGHT, children: [new D.TextRun({ text: label, bold: true, size: 16, color: 'B91C1C' })] })] }) } : undefined,
      footers: { default: new D.Footer({ children: [new D.Paragraph({ alignment: D.AlignmentType.RIGHT, children: footerChildren })] }) },
      children,
    }],
  });
  return D.Packer.toBuffer(document);
}
