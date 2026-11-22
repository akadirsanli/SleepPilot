import fsp from 'node:fs/promises';
import path from 'node:path';
import { lib } from './deps.mjs';
import { toDocument, displayValue } from './docmodel.mjs';
import { chartPng } from './chart.mjs';
import { imageSize } from './image.mjs';

/** Read the text of each slide (and its speaker notes) from a .pptx. */
export async function readPptx(file) {
  const JSZip = lib('jszip');
  const zip = await JSZip.loadAsync(await fsp.readFile(file));
  const num = (n) => Number(/(\d+)\.xml$/.exec(n)?.[1] || 0);
  const slideFiles = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => num(a) - num(b));
  const paragraphs = (xml) => [...xml.matchAll(/<a:p\b[\s\S]*?<\/a:p>/g)].map((p) => [...p[0].matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((t) => t[1]).join('')).map(unxml).filter(Boolean);
  const slides = [];
  for (const f of slideFiles) {
    const xml = await zip.file(f).async('string');
    const notesFile = `ppt/notesSlides/notesSlide${num(f)}.xml`;
    const notes = zip.file(notesFile) ? paragraphs(await zip.file(notesFile).async('string')).filter((t) => !/^\d+$/.test(t)) : [];
    const texts = paragraphs(xml);
    slides.push({ n: num(f), title: texts[0] || '', texts, notes, images: (xml.match(/<p:pic\b/g) || []).length, tables: (xml.match(/<a:tbl\b/g) || []).length });
  }
  return { kind: 'pptx', slides, text: slides.map((s) => s.texts.join('\n')).join('\n\n') };
}

const unxml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&').trim();

/**
 * Create a .pptx. spec.slides: [{ title, bullets?, text?, table?: {header, rows}, chart?, image?, notes? }]
 * — or a document/Markdown: every level-1/2 heading starts a new slide.
 */
export async function pptxBuffer(input, { baseDir = process.cwd() } = {}) {
  const PptxGenJS = lib('pptxgenjs');
  const pres = new PptxGenJS();
  pres.layout = 'LAYOUT_WIDE';
  const spec = typeof input === 'string' || !Array.isArray(input?.slides) ? slidesFromDocument(toDocument(input)) : input;
  const locale = spec.locale || 'en-US';
  if (spec.title) pres.title = spec.title;
  const W = 13.33;
  for (const s of spec.slides || []) {
    const slide = pres.addSlide();
    slide.background = { color: 'FFFFFF' };
    if (s.title) slide.addText(String(s.title), { x: 0.5, y: 0.3, w: W - 1, h: 0.8, fontSize: 26, bold: true, color: '0F2A4A', fontFace: 'Calibri' });
    let y = s.title ? 1.25 : 0.5;
    const body = [];
    if (s.text) body.push({ text: String(s.text), options: { breakLine: true } });
    for (const b of s.bullets || []) body.push({ text: String(b), options: { bullet: true, breakLine: true } });
    const hasVisual = s.table || s.chart || s.image;
    if (body.length) {
      slide.addText(body, { x: 0.6, y, w: hasVisual ? 5.6 : W - 1.2, h: 5.6, fontSize: 18, color: '1F2937', valign: 'top', fontFace: 'Calibri' });
    }
    const vx = body.length ? 6.5 : 0.6;
    const vw = body.length ? W - 7.1 : W - 1.2;
    if (s.table) {
      const rows = [];
      if (s.table.header) rows.push(s.table.header.map((h) => ({ text: String(h), options: { bold: true, fill: { color: 'E8EEF7' } } })));
      for (const r of s.table.rows || []) rows.push(r.map((v) => ({ text: displayValue(v, locale), options: { align: typeof v === 'number' ? 'right' : 'left' } })));
      slide.addTable(rows, { x: vx, y, w: vw, fontSize: 12, border: { type: 'solid', pt: 0.5, color: 'C9D2DE' }, autoPage: false });
    } else if (s.chart || s.image) {
      const data = s.chart ? chartPng({ width: 900, height: 500, ...s.chart }) : await fsp.readFile(path.resolve(baseDir, String(s.image)));
      const size = imageSize(data) || { width: 900, height: 500 };
      const h = Math.min(5.6, (vw * size.height) / size.width);
      slide.addImage({ data: `data:image/${size.type === 'jpeg' ? 'jpeg' : 'png'};base64,${data.toString('base64')}`, x: vx, y, w: (h * size.width) / size.height, h });
    }
    if (s.notes) slide.addNotes(String(s.notes));
  }
  return pres.write({ outputType: 'nodebuffer' });
}

function slidesFromDocument(doc) {
  const slides = [];
  let cur = null;
  const start = (title) => slides.push((cur = { title, bullets: [] }));
  if (doc.title) slides.push({ title: doc.title, text: doc.subtitle || '' });
  for (const b of doc.blocks) {
    if (b.type === 'heading' && b.level <= 2) start(b.text);
    else {
      if (!cur) start('');
      if (b.type === 'heading') cur.bullets.push(b.text);
      else if (b.type === 'paragraph' || b.type === 'callout') cur.bullets.push(b.text.replace(/\*\*|__|\*/g, ''));
      else if (b.type === 'bullets' || b.type === 'numbered') cur.bullets.push(...b.items.map((t) => t.replace(/\*\*|__|\*/g, '')));
      else if (b.type === 'kv') cur.bullets.push(...b.items.map(([k, v]) => `${k}: ${v}`));
      else if (b.type === 'table' && !cur.table) cur.table = { header: b.header, rows: b.rows.slice(0, 12) };
      else if (b.type === 'chart' && !cur.chart) cur.chart = b.chart;
      else if (b.type === 'image' && !cur.image) cur.image = b.path;
    }
  }
  return { title: doc.title, locale: doc.locale, slides };
}
