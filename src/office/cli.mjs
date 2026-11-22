#!/usr/bin/env node
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOLS, toolContext, runTool, readJsonArg } from './tools.mjs';
import * as office from './index.mjs';
import { ROOT } from './deps.mjs';

/**
 * `sleeppilot office …` — the office tools from a terminal, a script, CI or an agent's shell.
 * Also runnable directly: `node src/office/cli.mjs …` (this is what the MCP preset starts).
 */
export function officeHelp() {
  return `SleepPilot office tools — Excel, CSV, Word, PowerPoint, PDF, PNG

USAGE
  sleeppilot office status                         Which office libraries are installed
  sleeppilot office inspect <file> [--rows N] [--json]
                                                   Sheets, column types/stats, preview, problems
  sleeppilot office table <file> [--sheet S] [--offset N] [--limit N]
                                                   Rows as JSON
  sleeppilot office text <file>                    Plain text of docx/pdf/pptx/xlsx/csv
  sleeppilot office create <out> --spec <json|@file|->   .xlsx .csv .docx .pdf .pptx .png .svg
  sleeppilot office create <out.docx|.pdf|.pptx> --markdown <file.md>
  sleeppilot office verify <expectations.json|-> [--json]
                                                   Check files against expectations (exit 1 on failure)
  sleeppilot office diff <a> <b> [--tolerance N] [--json]
  sleeppilot office sample <sales|expenses|invoices> [--out file.xlsx|.csv] [--rows N]
                           [--seed N] [--rate 0.03] [--encoding utf-8|windows-1254] [--key path]
                                                   Synthetic data with planted anomalies + answer key
  sleeppilot office merge <out.pdf> <a.pdf> <b.pdf> …
  sleeppilot office pages <in.pdf> <1-3,5> <out.pdf>
  sleeppilot office convert <file> [--to pdf|xlsx|docx] [--out-dir dir]   (needs LibreOffice)
  sleeppilot office mcp [--read-only] [--root dir] MCP server on stdio for Claude Code / Codex / OpenCode

Paths are relative to the current folder; files are only written inside it (or --root).
Docs: docs/OFFICE.md`;
}

function parse(argv) {
  const pos = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const next = argv[i + 1];
      if (next === undefined || (next.startsWith('--') && next !== '-')) opts[key] = true;
      else opts[key] = argv[++i];
    } else pos.push(a);
  }
  return { pos, opts };
}

export async function runOfficeCli(argv) {
  const { pos, opts } = parse(argv);
  const sub = pos.shift() || 'help';
  const root = path.resolve(opts.root ? String(opts.root) : process.cwd());
  const ctx = toolContext(root);
  const json = !!opts.json;
  const print = (s) => process.stdout.write(`${s}\n`);
  if (sub === 'help' || opts.help) return print(officeHelp()), 0;
  if (sub === 'mcp') {
    const { serveMcp } = await import('./mcp-server.mjs');
    const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
    await serveMcp({ root, readOnly: !!opts.readOnly, version });
    return 0;
  }
  // pdfmake warns on stdout about access policies it does not need here; keep stdout clean.
  if (json) console.warn = () => {};
  if (sub === 'status') {
    const s = office.officeStatus();
    if (json) return print(JSON.stringify({ ...s, libreoffice: office.findSoffice() }, null, 2)), 0;
    print(`Office tools: ${s.ready ? 'ready' : `missing ${s.missing.join(', ')} — run: ${s.fix}`}`);
    for (const p of s.packages) print(`  ${p.installed ? '✓' : '✗'} ${p.name.padEnd(18)} ${p.version || ''}  ${p.purpose}`);
    print(`  ${office.findSoffice() ? '✓' : '·'} LibreOffice        ${office.findSoffice() || 'not found (optional: legacy .xls/.doc and PDF conversion)'}`);
    return 0;
  }
  if (sub === 'inspect') {
    if (!pos[0]) throw new Error('Usage: sleeppilot office inspect <file>');
    if (json) return print(JSON.stringify(await office.inspectFile(ctx.read(pos[0]), { maxRows: Number(opts.rows) || 15 }), null, 2)), 0;
    print(await runTool('office_inspect', { path: pos[0], rows: opts.rows }, ctx));
    return 0;
  }
  if (sub === 'table') return print(await runTool('office_read_table', { path: pos[0], sheet: opts.sheet, offset: opts.offset, limit: opts.limit }, ctx)), 0;
  if (sub === 'text') return print(await runTool('office_text', { path: pos[0], maxChars: opts.maxChars || 1e6 }, ctx)), 0;
  if (sub === 'create' || sub === 'chart') {
    if (!pos[0]) throw new Error('Usage: sleeppilot office create <out> --spec <json|@file|-> | --markdown <file.md>');
    const markdown = opts.markdown ? (opts.markdown === '-' ? await stdin() : await fsp.readFile(path.resolve(String(opts.markdown)), 'utf8')) : undefined;
    const spec = await readJsonArg(opts.spec);
    print(await runTool('office_create', { path: pos[0], spec, markdown }, ctx));
    return 0;
  }
  if (sub === 'verify') {
    const exp = await readJsonArg(pos[0] || opts.spec || '-');
    const list = Array.isArray(exp) ? exp : Array.isArray(exp?.expectations) ? exp.expectations : [exp];
    const results = [];
    for (const e of list) results.push(await office.verifyFile(e, { baseDir: root }));
    if (json) print(JSON.stringify(results, null, 2));
    else print(await runTool('office_verify', { expectations: list }, ctx));
    return results.every((r) => r.ok) ? 0 : 1;
  }
  if (sub === 'diff') {
    if (pos.length < 2) throw new Error('Usage: sleeppilot office diff <a> <b>');
    const r = await office.diffFiles(ctx.read(pos[0]), ctx.read(pos[1]), { tolerance: Number(opts.tolerance) || 1e-6 });
    if (json) print(JSON.stringify(r, null, 2));
    else {
      print(`${r.same ? 'SAME' : 'DIFFERENT'}: ${r.summary}`);
      for (const d of r.differences || []) print(`  ${d.sheet}!${d.ref}: ${JSON.stringify(d.a)} → ${JSON.stringify(d.b)}`);
      for (const l of r.removed || []) print(`  - ${l}`);
      for (const l of r.added || []) print(`  + ${l}`);
    }
    return r.same ? 0 : 1;
  }
  if (sub === 'sample') {
    const template = pos[0] || 'sales';
    const out = opts.out || `${template}.xlsx`;
    const r = await office.generateSample({ template, out: ctx.write(out), rows: opts.rows, seed: opts.seed, anomalyRate: opts.rate, encoding: opts.encoding || 'utf-8', keyFile: opts.key ? path.resolve(String(opts.key)) : null, baseDir: root });
    if (json) return print(JSON.stringify(r, null, 2)), 0;
    print(`Created ${r.file}\n  ${r.rows} rows, ${r.anomalies} planted anomalies (${Object.entries(r.types).map(([k, v]) => `${k} ${v}`).join(', ')})\n  answer key: ${r.keyFile}\n  rules:      ${r.rulesFile}`);
    return 0;
  }
  if (sub === 'merge') return print(await runTool('office_pdf_merge', { path: pos[0], files: pos.slice(1) }, ctx)), 0;
  if (sub === 'pages') return print(await runTool('office_pdf_pages', { input: pos[0], pages: pos[1], path: pos[2] }, ctx)), 0;
  if (sub === 'convert') {
    const r = await office.convertFile(pos[0], { to: opts.to, outDir: opts.outDir, baseDir: root });
    return print(`Created ${r.file}`), 0;
  }
  if (sub === 'tools') return print(TOOLS.map((t) => `${t.name}${t.write ? ' (writes)' : ''}: ${t.description}`).join('\n\n')), 0;
  throw new Error(`Unknown office command "${sub}".\n\n${officeHelp()}`);
}

async function stdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runOfficeCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code ?? 0;
    })
    .catch((err) => {
      process.stderr.write(`SleepPilot office: ${err.message}\n`);
      process.exitCode = 1;
    });
}
