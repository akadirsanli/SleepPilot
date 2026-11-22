import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { workbookBuffer, workbookCsv, readWorkbook } from './excel.mjs';
import { pdfBuffer, mergePdfs, extractPages, readPdf } from './pdf.mjs';
import { docxBuffer, readDocx } from './word.mjs';
import { pptxBuffer, readPptx } from './slides.mjs';
import { chartPng, chartSvg } from './chart.mjs';
import { inspectFile, detectKind, OFFICE_EXT } from './inspect.mjs';
import { verifyFile } from './verify.mjs';
import { diffFiles, textOf } from './diff.mjs';
import { generateSample, SAMPLE_TEMPLATES } from './sample.mjs';
import { profileTable } from './profile.mjs';
import { officeStatus } from './deps.mjs';
import { runFile } from '../util/proc.mjs';

export { inspectFile, detectKind, verifyFile, diffFiles, textOf, generateSample, SAMPLE_TEMPLATES, readWorkbook, readPdf, readDocx, readPptx, profileTable, officeStatus, chartPng, chartSvg, OFFICE_EXT };

/**
 * Create a file from a spec; the extension decides the format:
 *   .xlsx / .csv  → workbook spec ({ sheets: [...] })
 *   .docx / .pdf  → document spec or Markdown text ({ title, blocks } | "# …")
 *   .pptx         → { slides: [...] } or a document / Markdown
 *   .png / .svg   → chart spec ({ type, labels, series })
 */
export async function createFile(out, spec, { baseDir = process.cwd() } = {}) {
  const file = path.resolve(baseDir, out);
  const ext = path.extname(file).toLowerCase();
  let data;
  if (ext === '.xlsx') data = await workbookBuffer(spec, { baseDir });
  else if (ext === '.csv') data = workbookCsv(spec);
  else if (ext === '.pdf') data = await pdfBuffer(spec, { baseDir });
  else if (ext === '.docx') data = await docxBuffer(spec, { baseDir });
  else if (ext === '.pptx') data = await pptxBuffer(spec, { baseDir });
  else if (ext === '.png') data = chartPng(spec);
  else if (ext === '.svg') data = Buffer.from(chartSvg(spec), 'utf8');
  else throw new Error(`Cannot create "${ext || out}": use .xlsx, .csv, .docx, .pdf, .pptx, .png or .svg.`);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, data);
  return { file, bytes: data.length };
}

export async function mergePdfFiles(out, files, { baseDir = process.cwd() } = {}) {
  const data = await mergePdfs(files.map((f) => path.resolve(baseDir, f)));
  const file = path.resolve(baseDir, out);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, data);
  return { file, bytes: data.length };
}

export async function extractPdfPages(out, input, pages, { baseDir = process.cwd() } = {}) {
  const data = await extractPages(path.resolve(baseDir, input), pages);
  const file = path.resolve(baseDir, out);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, data);
  return { file, bytes: data.length };
}

/** LibreOffice (optional): converts legacy .xls/.doc/.ppt, and any office file to PDF. */
export function findSoffice() {
  const candidates = process.platform === 'win32'
    ? [process.env.SOFFICE, 'C:\\Program Files\\LibreOffice\\program\\soffice.exe', 'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe']
    : process.platform === 'darwin'
      ? [process.env.SOFFICE, '/Applications/LibreOffice.app/Contents/MacOS/soffice']
      : [process.env.SOFFICE, '/usr/bin/soffice', '/usr/bin/libreoffice', '/usr/local/bin/soffice', '/snap/bin/libreoffice'];
  return candidates.find((c) => c && fs.existsSync(c)) || null;
}

export async function convertFile(input, { to = null, outDir = null, baseDir = process.cwd() } = {}) {
  const soffice = findSoffice();
  if (!soffice) throw new Error('LibreOffice was not found. Install it from https://www.libreoffice.org (free) or set SOFFICE to soffice(.exe); or open the file in Excel/Word and use "Save As".');
  const src = path.resolve(baseDir, input);
  const ext = path.extname(src).toLowerCase();
  const target = to || { '.xls': 'xlsx', '.doc': 'docx', '.ppt': 'pptx', '.odt': 'docx', '.ods': 'xlsx', '.odp': 'pptx' }[ext] || 'pdf';
  const dir = path.resolve(baseDir, outDir || path.dirname(src));
  await fsp.mkdir(dir, { recursive: true });
  const r = await runFile(soffice, ['--headless', '--norestore', '--convert-to', target, '--outdir', dir, src], { timeoutMs: 180_000 });
  const file = path.join(dir, `${path.basename(src, ext)}.${target.split(':')[0]}`);
  if (r.exitCode !== 0 || !fs.existsSync(file)) throw new Error(`LibreOffice could not convert the file: ${(r.stderr || r.stdout || '').trim().slice(-400)}`);
  return { file };
}
