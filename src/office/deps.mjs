import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * The office tools use well-known open-source libraries (MIT / BSD / Apache-2.0 / MPL-2.0, see
 * THIRD_PARTY.md). They are loaded lazily, so the rest of SleepPilot keeps working when they are
 * not installed yet; an office call then fails with the exact command that installs them.
 */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(path.join(ROOT, 'package.json'));

export const OFFICE_PACKAGES = {
  exceljs: 'Excel read/write (.xlsx)',
  papaparse: 'CSV parsing',
  'iconv-lite': 'Legacy code pages for CSV (windows-1252, windows-1254 …)',
  'pdfjs-dist': 'PDF text extraction',
  pdfmake: 'PDF reports (tables, charts, Unicode text)',
  'pdf-lib': 'PDF merge / split / page extraction',
  docx: 'Word write (.docx)',
  mammoth: 'Word read (.docx)',
  pptxgenjs: 'PowerPoint write (.pptx)',
  jszip: 'PowerPoint read (.pptx)',
  pngjs: 'PNG pixels (blank-image detection, image diff)',
  echarts: 'Charts (bar, line, pie, scatter …)',
  '@resvg/resvg-js': 'Chart SVG → PNG',
};

export class OfficeToolsMissing extends Error {
  constructor(pkg, cause) {
    super(`The office tools are not installed (missing package "${pkg}"). Run "npm install" in the SleepPilot folder (${ROOT}) once, then try again.`);
    this.code = 'OFFICE_TOOLS_MISSING';
    this.package = pkg;
    this.cause = cause;
  }
}

const cache = new Map();

/** require() a CommonJS office library, with a clear error when it is not installed. */
export function lib(name) {
  if (cache.has(name)) return cache.get(name);
  try {
    const mod = require(name);
    cache.set(name, mod);
    return mod;
  } catch (err) {
    if (err?.code === 'MODULE_NOT_FOUND' && String(err.message).includes(name)) throw new OfficeToolsMissing(name, err);
    throw err;
  }
}

let pdfjsPromise = null;
/** pdf.js is an ES module; its legacy build runs in Node without a DOM. */
export function pdfjs() {
  if (!pdfjsPromise) {
    let file;
    try {
      file = require.resolve('pdfjs-dist/legacy/build/pdf.mjs');
    } catch (err) {
      return Promise.reject(new OfficeToolsMissing('pdfjs-dist', err));
    }
    pdfjsPromise = import(pathToFileURL(file).href);
  }
  return pdfjsPromise;
}

/** Which office libraries are installed (for doctor and the UI). */
export function officeStatus() {
  const packages = Object.entries(OFFICE_PACKAGES).map(([name, purpose]) => {
    let version = null;
    try {
      // Some packages do not export package.json; read it from node_modules directly.
      version = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', ...name.split('/'), 'package.json'), 'utf8')).version || null;
    } catch {
      /* not installed */
    }
    return { name, purpose, installed: !!version, version };
  });
  const missing = packages.filter((p) => !p.installed).map((p) => p.name);
  return { ready: !missing.length, packages, missing, fix: missing.length ? `npm install (in ${ROOT})` : null };
}

/** Roboto (Apache-2.0, shipped with pdfmake): wide Latin/Greek/Cyrillic coverage for PDFs and charts. */
export function fontFiles() {
  const dir = path.join(ROOT, 'node_modules', 'pdfmake', 'build', 'fonts', 'Roboto');
  return {
    normal: path.join(dir, 'Roboto-Regular.ttf'),
    bold: path.join(dir, 'Roboto-Medium.ttf'),
    italics: path.join(dir, 'Roboto-Italic.ttf'),
    bolditalics: path.join(dir, 'Roboto-MediumItalic.ttf'),
  };
}
