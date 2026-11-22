import fsp from 'node:fs/promises';
import path from 'node:path';
import * as office from './index.mjs';
import { readWorkbook } from './excel.mjs';
import { normName } from './values.mjs';

/**
 * The office tools as one table of named operations. The CLI, the MCP server and SleepPilot's
 * own checks all go through here, so an agent, a person and a check see the same behaviour.
 * Paths are relative to `root`; files are only WRITTEN inside `root`.
 */
export const TOOLS = [
  {
    name: 'office_inspect',
    write: false,
    description: 'Describe an office file (xlsx, xlsm, csv, tsv, docx, pptx, pdf, png, jpg): sheets with row/column counts, column types and statistics, a preview of the first rows or text, and problems that usually mean a bug (formula errors, NaN/undefined/[object Object], empty document, scanned PDF without text). Use it to look at input data before writing code, and at every file your code produced.',
    input: { path: 'string — file to inspect', rows: 'number? — preview rows per sheet (default 15)' },
    run: async (a, ctx) => {
      const r = await office.inspectFile(ctx.read(a.path), { maxRows: num(a.rows, 15, 1, 200) });
      return `${r.ok ? '' : `ERROR: ${r.error}\n`}${r.summary}\n${r.problems?.length ? `PROBLEMS:\n${r.problems.map((p) => `- ${p}`).join('\n')}\n` : ''}\n${r.preview}`.trim();
    },
  },
  {
    name: 'office_read_table',
    write: false,
    description: 'Read rows of an Excel sheet or CSV as JSON (values are numbers, strings, booleans, null; dates as ISO text). Use offset/limit to page through large sheets.',
    input: { path: 'string', sheet: 'string? — sheet name (default: first)', offset: 'number? — first row, 0-based (default 0)', limit: 'number? — rows (default 100, max 2000)' },
    run: async (a, ctx) => {
      const offset = num(a.offset, 0, 0, 1e7);
      const limit = num(a.limit, 100, 1, 2000);
      const wb = await readWorkbook(ctx.read(a.path), { maxRows: offset + limit });
      const s = a.sheet ? wb.sheets.find((x) => normName(x.name) === normName(a.sheet)) : wb.sheets[0];
      if (!s) throw new Error(`No sheet "${a.sheet}". Sheets: ${wb.sheets.map((x) => x.name).join(', ')}`);
      return JSON.stringify({ sheet: s.name, totalRows: s.rowCount, offset, rows: s.rows.slice(offset, offset + limit) });
    },
  },
  {
    name: 'office_text',
    write: false,
    description: 'Extract the plain text of a docx, pdf, pptx, xlsx or csv file (PDF pages separated by form feeds).',
    input: { path: 'string', maxChars: 'number? (default 20000)' },
    run: async (a, ctx) => {
      const t = await office.textOf(ctx.read(a.path));
      const max = num(a.maxChars, 20000, 100, 500000);
      return t.length > max ? `${t.slice(0, max)}\n… (${t.length - max} more characters)` : t;
    },
  },
  {
    name: 'office_create',
    write: true,
    description: 'Create a file; the extension picks the format. .xlsx/.csv: {"sheets":[{"name","columns":[{"header","format":"text|integer|number|money|percent|date|datetime","width"}],"rows":[[...]],"totals":{"label","columns":[...]},"images":[{"chart":{...},"range":"H2:P20"}]}]}. .docx/.pdf: {"title","subtitle","classification","footer","landscape","blocks":[{"type":"heading","text","level"},{"type":"paragraph","text"},{"type":"bullets","items"},{"type":"table","header","rows"},{"type":"kv","items":[[k,v]]},{"type":"callout","tone":"info|ok|warning|risk","text"},{"type":"chart","chart":{...}},{"type":"image","path"},{"type":"pagebreak"}]} or "markdown":"# …". .pptx: {"slides":[{"title","bullets","table","chart","notes"}]} or markdown. .png/.svg: a chart spec {"type":"bar|line|area|pie|doughnut|scatter","title","labels":[...],"series":[{"name","values":[...]}]}. Unicode text (accented letters, Turkish, German …) is supported everywhere.',
    input: { path: 'string — output file', spec: 'object? — see description', markdown: 'string? — for docx/pdf/pptx instead of spec' },
    run: async (a, ctx) => {
      const spec = a.markdown ? { ...(a.spec || {}), markdown: String(a.markdown) } : a.spec;
      if (!spec) throw new Error('Give "spec" or "markdown".');
      const r = await office.createFile(ctx.write(a.path), spec, { baseDir: ctx.root });
      return `Created ${path.relative(ctx.root, r.file) || r.file} (${r.bytes} bytes).`;
    },
  },
  {
    name: 'office_verify',
    write: false,
    description: 'Check office files against expectations and report every passed/failed point. Expectation keys: file, minBytes, sheets, sheet, minRows, maxRows, columns, cells {"Sheet!B2": value | {equals|approx|tolerance|contains|min|max|nonEmpty|formula}}, noErrors, contains, notContains, pages, headings, minTables, slides, width, height, minWidth, minHeight, notBlank, sameAs, tolerance, findsAll {key, column, sheet, minRecall, maxFalsePositives, types}.',
    input: { expectations: 'object | object[]' },
    run: async (a, ctx) => {
      const list = Array.isArray(a.expectations) ? a.expectations : [a.expectations];
      const results = [];
      for (const e of list) results.push(await office.verifyFile(e, { baseDir: ctx.root }));
      return results.map((r) => `${r.ok ? 'PASS' : 'FAIL'} ${r.file}\n${r.failed.map((f) => `  ✗ ${f}`).join('\n')}${r.failed.length ? '\n' : ''}${r.passed.map((p) => `  ✓ ${p}`).join('\n')}`).join('\n\n');
    },
  },
  {
    name: 'office_diff',
    write: false,
    description: 'Compare two files: Excel/CSV cell by cell (numbers within tolerance), Word/PDF/PowerPoint by text lines, PNG by changed pixels.',
    input: { a: 'string', b: 'string', tolerance: 'number? (default 1e-6)' },
    run: async (a, ctx) => JSON.stringify(await office.diffFiles(ctx.read(a.a), ctx.read(a.b), { tolerance: Number(a.tolerance) || 1e-6, maxDiffs: 50 }), null, 1),
  },
  {
    name: 'office_sample',
    write: true,
    description: `Generate a SYNTHETIC test data set with planted anomalies plus an answer key (<name>.key.json) and the rules (<name>.rules.md). Templates: ${Object.entries(office.SAMPLE_TEMPLATES).map(([k, v]) => `${k} — ${v}`).join('; ')}. Never read the key from the app under test; the office check uses it to measure what the app found.`,
    input: { template: 'string', path: 'string — .xlsx or .csv', rows: 'number?', seed: 'number?', anomalyRate: 'number? (0.005–0.3, default 0.03)', encoding: 'string? — csv only: utf-8 (default) or windows-1254' },
    run: async (a, ctx) => {
      const r = await office.generateSample({ template: a.template, out: ctx.write(a.path), rows: a.rows, seed: a.seed, anomalyRate: a.anomalyRate, encoding: a.encoding, baseDir: ctx.root });
      return `Created ${path.relative(ctx.root, r.file)} (${r.rows} rows, ${r.anomalies} planted anomalies: ${Object.entries(r.types).map(([k, v]) => `${k} ${v}`).join(', ')}).\nAnswer key: ${path.relative(ctx.root, r.keyFile)}\nRules: ${path.relative(ctx.root, r.rulesFile)}`;
    },
  },
  {
    name: 'office_pdf_merge',
    write: true,
    description: 'Merge PDFs into one, in the given order.',
    input: { path: 'string — output .pdf', files: 'string[]' },
    run: async (a, ctx) => {
      const r = await office.mergePdfFiles(ctx.write(a.path), (a.files || []).map((f) => ctx.read(f)), { baseDir: ctx.root });
      return `Created ${path.relative(ctx.root, r.file)} (${r.bytes} bytes).`;
    },
  },
  {
    name: 'office_pdf_pages',
    write: true,
    description: 'Copy selected pages of a PDF ("1-3,5") into a new PDF.',
    input: { input: 'string', pages: 'string', path: 'string — output .pdf' },
    run: async (a, ctx) => {
      const r = await office.extractPdfPages(ctx.write(a.path), ctx.read(a.input), a.pages, { baseDir: ctx.root });
      return `Created ${path.relative(ctx.root, r.file)} (${r.bytes} bytes).`;
    },
  },
];

/** Path guard: reads may name any file; writes must stay inside the root. */
export function toolContext(root, { readOnly = false } = {}) {
  const base = path.resolve(root);
  return {
    root: base,
    readOnly,
    read: (p) => {
      if (!p) throw new Error('A path is required.');
      return path.resolve(base, String(p));
    },
    write: (p) => {
      if (readOnly) throw new Error('This tool is not available to a read-only role.');
      if (!p) throw new Error('A path is required.');
      const full = path.resolve(base, String(p));
      if (full !== base && !full.startsWith(base + path.sep)) throw new Error(`Refusing to write outside the project folder: ${p}`);
      return full;
    },
  };
}

export async function runTool(name, args, ctx) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  if (tool.write && ctx.readOnly) throw new Error('This tool is not available to a read-only role.');
  return tool.run(args || {}, ctx);
}

function num(v, dflt, min, max) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : dflt;
}

export async function readJsonArg(value) {
  if (value === undefined || value === null || value === true) return undefined;
  const s = String(value);
  if (s === '-') {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  if (/^\s*[[{]/.test(s)) return JSON.parse(s);
  return JSON.parse(await fsp.readFile(s.replace(/^@/, ''), 'utf8'));
}
