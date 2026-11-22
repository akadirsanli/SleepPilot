// Office tools: Excel / CSV / Word / PowerPoint / PDF / PNG read-write, inspection, expectations,
// diff, synthetic test data with an answer key, the office check, the MCP server and the wiring
// into Scout, prompts and MCP settings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.SLEEPPILOT_QUIET = '1';
process.env.SLEEPPILOT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-office-home-'));
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-office-'));
const office = await import('../../src/office/index.mjs');
// pdfmake prints access-policy notices; keep test output clean.
console.warn = () => {};

const REPORT_MD = `# Sales Report — Stores

This report uses **synthetic** data. The content is *an example*.

Unicode text: Ğüşıöç İĞÜŞÖÇ äöß éèê

## Findings

- Duplicate receipts: 3
- Sales outside opening hours: 2

| Store | Sales | Amount |
| --- | --- | --- |
| Downtown | 12 | 1250.5 |
| Harbor | 7 | 830 |

> [!WARNING] Stock count difference found.

\`\`\`chart
{"type": "bar", "title": "Sales by store", "labels": ["Downtown", "Harbor"], "series": [{"name": "Sales", "values": [12, 7]}]}
\`\`\`
`;

test('office: all libraries are installed', () => {
  const s = office.officeStatus();
  assert.equal(s.ready, true, `missing: ${s.missing.join(', ')}`);
});

test('office: Excel round trip keeps text, numbers, dates, formulas and sheet names', async () => {
  const spec = {
    sheets: [
      {
        name: 'Summary',
        columns: [{ header: 'Store' }, { header: 'Date', format: 'date' }, { header: 'Amount', format: 'money' }],
        rows: [['Downtown', '2025-03-01', 1234.5], ['Harbor', '01.04.2025', '2.500,75'], ['Hillside', { date: '2025-05-02' }, { value: 10, bold: true, fill: 'FFEEEE' }]],
        totals: { label: 'Total', columns: ['Amount'] },
        images: [{ chart: { type: 'pie', labels: ['A', 'B'], series: [{ values: [1, 2] }] }, range: 'E2:J12' }],
      },
      { name: 'Detail', rows: [['x', '=1+1']] },
    ],
  };
  const r = await office.createFile('book.xlsx', spec, { baseDir: DIR });
  assert.ok(r.bytes > 1000);
  const wb = await office.readWorkbook(path.join(DIR, 'book.xlsx'));
  assert.deepEqual(wb.sheets.map((s) => s.name), ['Summary', 'Detail']);
  const [head, a, b, c, total] = wb.sheets[0].rows;
  assert.deepEqual(head, ['Store', 'Date', 'Amount']);
  assert.deepEqual(a, ['Downtown', '2025-03-01', 1234.5]);
  assert.deepEqual(b, ['Harbor', '2025-04-01', 2500.75], 'European number and dd.mm.yyyy date text become real values in typed columns');
  assert.equal(c[1], '2025-05-02');
  assert.equal(total[0], 'Total');
  assert.equal(wb.sheets[0].formulas.C5, 'SUM(C2:C4)');
  assert.equal(total[2], 3745.25, 'the total carries its computed value');
  assert.equal(wb.sheets[0].images, 1);
  assert.equal(wb.sheets[1].formulas.B1, '1+1');
});

test('office: a legacy code page CSV (Windows-1254, ";") is decoded and profiled (European number format)', async () => {
  const iconv = (await import('node:module')).createRequire(import.meta.url)('iconv-lite');
  // Store names with non-ASCII letters prove the code page was decoded, not guessed as UTF-8.
  const text = 'Store;Amount;Date\r\nKadıköy;1.234,56;05.01.2025\r\nŞişli;99,5;06.01.2025\r\nÇankaya;;07.01.2025\r\n';
  await fsp.writeFile(path.join(DIR, 'legacy.csv'), iconv.encode(text, 'windows-1254'));
  const wb = await office.readWorkbook(path.join(DIR, 'legacy.csv'));
  assert.equal(wb.encoding, 'windows-1254');
  assert.equal(wb.delimiter, ';');
  assert.equal(wb.sheets[0].rows[2][0], 'Şişli');
  const prof = office.profileTable(wb.sheets[0].rows);
  const amount = prof.columns.find((c) => c.name === 'Amount');
  assert.equal(amount.type, 'number');
  assert.equal(amount.sum, 1334.06);
  assert.equal(amount.empty, 1);
  assert.equal(prof.columns.find((c) => c.name === 'Date').type, 'date');
  // Written back: UTF-8 with a BOM (so Excel reads it as UTF-8) and "," by default.
  await office.createFile('out.csv', { sheets: [{ columns: ['Name', 'Amount'], rows: [['Ğüşıöç', 1.5]] }] }, { baseDir: DIR });
  const buf = await fsp.readFile(path.join(DIR, 'out.csv'));
  assert.deepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.match(buf.toString('utf8'), /Name,Amount\r\nĞüşıöç,1\.5/);
});

test('office: Word from Markdown reads back with headings, lists, tables and the chart image', async () => {
  await office.createFile('report.docx', { title: 'Sales Report', classification: 'INTERNAL', markdown: REPORT_MD }, { baseDir: DIR });
  const d = await office.readDocx(path.join(DIR, 'report.docx'));
  assert.ok(d.headings.some((h) => h.text === 'Sales Report — Stores' && h.level === 1));
  assert.ok(d.headings.some((h) => h.text === 'Findings' && h.level === 2));
  assert.equal(d.tables.length, 1);
  assert.deepEqual(d.tables[0][1], ['Downtown', '12', '1250.5'], 'Markdown cells are written as typed');
  assert.equal(d.images, 1);
  assert.match(d.text, /Duplicate receipts: 3/);
  assert.match(d.text, /Warning: Stock count difference/);
  assert.match(d.text, /Ğüşıöç İĞÜŞÖÇ äöß éèê/);
});

test('office: PDF from Markdown has Unicode text, a table and a vector chart; pages can be merged and cut', async () => {
  await office.createFile('report.pdf', { title: 'Sales Report', footer: 'Synthetic data', markdown: `${REPORT_MD}\n\\pagebreak\n\n# Appendix\n\nSecond page.` }, { baseDir: DIR });
  const p = await office.readPdf(path.join(DIR, 'report.pdf'));
  assert.equal(p.pages, 2);
  assert.match(p.pageTexts[0], /Sales Report — Stores/);
  assert.match(p.pageTexts[0], /Ğüşıöç İĞÜŞÖÇ äöß éèê/, 'non-English letters survive the bundled font');
  assert.match(p.pageTexts[0], /Downtown\s+12\s+1250\.5/);
  assert.match(p.pageTexts[0], /Sales by store/, 'chart title is real text in the PDF');
  assert.match(p.pageTexts[1], /Second page/);
  assert.equal(p.likelyScanned, false);
  await office.mergePdfFiles('merged.pdf', ['report.pdf', 'report.pdf'], { baseDir: DIR });
  assert.equal((await office.readPdf(path.join(DIR, 'merged.pdf'))).pages, 4);
  await office.extractPdfPages('p2.pdf', 'report.pdf', '2', { baseDir: DIR });
  const p2 = await office.readPdf(path.join(DIR, 'p2.pdf'));
  assert.equal(p2.pages, 1);
  assert.match(p2.text, /Second page/);
});

test('office: PowerPoint from Markdown — one slide per heading', async () => {
  await office.createFile('slides.pptx', REPORT_MD, { baseDir: DIR });
  const s = await office.readPptx(path.join(DIR, 'slides.pptx'));
  assert.deepEqual(s.slides.map((x) => x.title), ['Sales Report — Stores', 'Findings']);
  assert.ok(s.slides[1].texts.some((t) => /Duplicate receipts/.test(t)));
  assert.equal(s.slides[1].tables, 1);
});

test('office: chart PNG is real (not blank) and blank images are detected only when asked', async () => {
  await office.createFile('chart.png', { type: 'line', title: 'Monthly', labels: ['January', 'February', 'March'], series: [{ name: 'A', values: [1, 3, 2] }], width: 600, height: 300 }, { baseDir: DIR });
  const info = await office.inspectFile(path.join(DIR, 'chart.png'));
  assert.equal(info.kind, 'image');
  assert.equal(info.details.width, 1200, 'rendered at 2× for sharp text');
  assert.equal(info.details.blank, false);
  const { PNG } = (await import('node:module')).createRequire(import.meta.url)('pngjs');
  const png = new PNG({ width: 40, height: 40 });
  png.data.fill(255);
  await fsp.writeFile(path.join(DIR, 'white.png'), PNG.sync.write(png));
  const white = await office.inspectFile(path.join(DIR, 'white.png'));
  assert.deepEqual(white.problems, [], 'a one-colour image is not a problem by itself (tiles, backgrounds)');
  const v = await office.verifyFile({ file: 'white.png', notBlank: true, minWidth: 10 }, { baseDir: DIR });
  assert.equal(v.ok, false);
  assert.match(v.failed.join('\n'), /blank/);
});

test('office: inspect reports the usual signs of a bug in generated output', async () => {
  await office.createFile('bad.xlsx', { sheets: [{ name: 'S', columns: ['Ad', 'Oran'], rows: [['a', 'NaN'], ['b', '[object Object]'], ['c', { formula: 'A1/0', result: { error: '#DIV/0!' } }]] }] }, { baseDir: DIR });
  const info = await office.inspectFile(path.join(DIR, 'bad.xlsx'));
  assert.equal(info.ok, true);
  const text = info.problems.join('\n');
  assert.match(text, /suspicious values B2=NaN, B3=\[object Object\]/);
  assert.match(text, /formula error/);
  await fsp.writeFile(path.join(DIR, 'broken.xlsx'), 'PK\u0003\u0004 not really a zip');
  const broken = await office.inspectFile(path.join(DIR, 'broken.xlsx'));
  assert.equal(broken.ok, false);
  await fsp.writeFile(path.join(DIR, 'old.xls'), Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
  assert.match((await office.inspectFile(path.join(DIR, 'old.xls'))).error, /Legacy binary Office format/);
});

test('office: expectations report each passed and failed point', async () => {
  const pass = await office.verifyFile({ file: 'book.xlsx', sheets: ['SUMMARY', 'detail'], sheet: 'Summary', columns: ['store', 'AMOUNT'], minRows: 3, cells: { 'Summary!A2': 'Downtown', C2: { approx: 1234.5 }, 'Summary!C5': { formula: true, min: 3000 } }, contains: ['harbor'], notContains: ['undefined'] }, { baseDir: DIR });
  assert.equal(pass.ok, true, pass.failed.join('\n'));
  const fail = await office.verifyFile({ file: 'book.xlsx', sheets: ['Missing'], columns: ['Channel'], maxRows: 1, cells: { C2: 99, 'Summary!A2': { contains: 'Airport' } } }, { baseDir: DIR });
  assert.equal(fail.ok, false);
  const f = fail.failed.join('\n');
  assert.match(f, /no sheet "Missing"/);
  assert.match(f, /no column "Channel" \(header: Store \| Date \| Amount\)/);
  assert.match(f, /expected at most 1/);
  assert.match(f, /Summary!C2: is 1234\.5, expected 99/);
  assert.match(f, /expected to contain "Airport"/);
  const pdf = await office.verifyFile({ file: 'report.pdf', pages: { min: 1, max: 1 }, headings: ['Findings'] }, { baseDir: DIR });
  assert.match(pdf.failed.join('\n'), /has 2 page\(s\); expected 1…1/);
  const docx = await office.verifyFile({ file: 'report.docx', headings: ['findings', 'Conclusion'], minTables: 1 }, { baseDir: DIR });
  assert.deepEqual(docx.failed.map((x) => /no heading "Conclusion"/.test(x)), [true]);
  const missing = await office.verifyFile({ file: 'nope.xlsx' }, { baseDir: DIR });
  assert.match(missing.failed[0], /does not exist/);
});

test('office: diff finds the changed cell, and same files compare equal', async () => {
  const spec = (v) => ({ sheets: [{ name: 'S', columns: ['A', 'B'], rows: [['x', 1], ['y', v]] }] });
  await office.createFile('d1.xlsx', spec(2), { baseDir: DIR });
  await office.createFile('d2.xlsx', spec(2.5), { baseDir: DIR });
  await office.createFile('d3.csv', spec(2), { baseDir: DIR });
  const d = await office.diffFiles(path.join(DIR, 'd1.xlsx'), path.join(DIR, 'd2.xlsx'));
  assert.equal(d.same, false);
  assert.deepEqual(d.differences, [{ sheet: 'S', ref: 'B3', a: 2, b: 2.5 }]);
  assert.equal((await office.diffFiles(path.join(DIR, 'd1.xlsx'), path.join(DIR, 'd3.csv'))).same, true, 'xlsx and csv with the same values are equal');
  const v = await office.verifyFile({ file: 'd2.xlsx', sameAs: 'd1.xlsx' }, { baseDir: DIR });
  assert.match(v.failed.join('\n'), /S!B3 2\.5 ≠ 2/);
  const t = await office.diffFiles(path.join(DIR, 'report.pdf'), path.join(DIR, 'p2.pdf'));
  assert.equal(t.same, false);
  assert.ok(t.removed.some((l) => /Findings/.test(l)));
});

test('office: synthetic test data — answer key, rules and recall measurement', async () => {
  for (const template of Object.keys(office.SAMPLE_TEMPLATES)) {
    const r = await office.generateSample({ template, out: `data/${template}.xlsx`, rows: 400, seed: 5, baseDir: DIR });
    assert.ok(r.rows >= 400);
    assert.ok(r.anomalies >= 10, `${template}: ${r.anomalies}`);
    const key = JSON.parse(await fsp.readFile(r.keyFile, 'utf8'));
    assert.equal(key.template, template);
    assert.ok(Object.keys(key.types).length >= 5, `${template} plants several kinds of anomaly`);
    assert.match(await fsp.readFile(r.rulesFile, 'utf8'), /rules to detect/);
    const wb = await office.readWorkbook(r.file, { maxRows: 1e5 });
    const ids = new Set(wb.sheets[0].rows.slice(1).map((x) => x[0]));
    assert.ok(key.anomalies.every((a) => ids.has(a.id)), 'every key id exists in the data');
    // An "app" that reports every planted id but one.
    const found = key.anomalies.slice(1).map((a) => [a.id]);
    await office.createFile(`out/${template}.xlsx`, { sheets: [{ name: 'Findings', columns: [key.idColumn], rows: found }] }, { baseDir: DIR });
    const v = await office.verifyFile({ file: `out/${template}.xlsx`, findsAll: { key: `data/${template}.key.json`, minRecall: 1 } }, { baseDir: DIR });
    assert.equal(v.ok, false);
    assert.match(v.failed.join('\n'), new RegExp(`found ${found.length}/${key.anomalies.length}.*Missed ids \\(first 10\\): ${key.anomalies[0].id}`));
    const lenient = await office.verifyFile({ file: `out/${template}.xlsx`, findsAll: { key: `data/${template}.key.json`, minRecall: 0.9, maxFalsePositives: 0 } }, { baseDir: DIR });
    assert.equal(lenient.ok, true, lenient.failed.join('\n'));
  }
  // Same seed, same data: tests are reproducible.
  const a = await office.generateSample({ template: 'sales', out: 'r1.csv', rows: 120, seed: 9, baseDir: DIR });
  const b = await office.generateSample({ template: 'sales', out: 'r2.csv', rows: 120, seed: 9, baseDir: DIR });
  assert.equal(await fsp.readFile(a.file, 'utf8'), await fsp.readFile(b.file, 'utf8'));
  // Legacy code page on request (testing the app's encoding handling).
  const w = await office.generateSample({ template: 'expenses', out: 'w.csv', rows: 60, seed: 1, encoding: 'windows-1252', baseDir: DIR });
  const raw = await fsp.readFile(w.file);
  assert.notEqual(raw[0], 0xef, 'no UTF-8 BOM in a legacy code page file');
  const back = await office.readWorkbook(w.file);
  assert.equal(back.sheets[0].rowCount, 61);
  assert.equal(back.sheets[0].rows[0][0], 'Expense No');
});

test('office check: changed files must open cleanly; expectations must hold', async () => {
  const { runChecks } = await import('../../src/checks/runner.mjs');
  const check = { id: 'office', type: 'office', name: 'Office', enabled: true, approved: true, expect: [] };
  const skipped = await runChecks({ projectDir: DIR, checks: [check], changedFiles: ['src/app.js'] });
  assert.equal(skipped[0].status, 'skipped');
  const bad = await runChecks({ projectDir: DIR, checks: [check], changedFiles: ['bad.xlsx', 'book.xlsx', 'node_modules/x/y.xlsx'] });
  assert.equal(bad[0].status, 'failed');
  assert.match(bad[0].output, /✗ bad\.xlsx/);
  assert.match(bad[0].output, /✓ book\.xlsx/);
  assert.equal(bad[0].details.files.length, 2, 'node_modules is ignored');
  const exp = await runChecks({ projectDir: DIR, checks: [{ ...check, expect: [{ file: 'book.xlsx', sheets: ['Summary'] }, { file: 'report.pdf', pages: 2 }] }], changedFiles: ['book.xlsx'] });
  assert.equal(exp[0].status, 'passed', exp[0].output);
  const { sanitizeChecks } = await import('../../src/app/app.mjs');
  const [s] = sanitizeChecks([{ type: 'office', name: 'O', enabled: true, expect: [{ file: 'a\\b.xlsx', minRows: 1 }, { nofile: true }] }]);
  assert.equal(s.type, 'office');
  assert.equal(s.approved, true);
  assert.deepEqual(s.expect, [{ file: 'a/b.xlsx', minRows: 1 }]);
});

test('office MCP server: handshake, read-only filtering, calls and the write guard', async () => {
  const { createMcpHandler } = await import('../../src/office/mcp-server.mjs');
  const rw = createMcpHandler({ root: DIR });
  const init = await rw({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
  assert.equal(init.result.protocolVersion, '2025-03-26');
  assert.equal(await rw({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  const all = (await rw({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).result.tools.map((t) => t.name);
  assert.ok(all.includes('office_create') && all.includes('office_inspect'));
  const ro = createMcpHandler({ root: DIR, readOnly: true });
  const roTools = (await ro({ jsonrpc: '2.0', id: 3, method: 'tools/list' })).result.tools;
  assert.deepEqual(roTools.map((t) => t.name), ['office_inspect', 'office_read_table', 'office_text', 'office_verify', 'office_diff']);
  assert.deepEqual(roTools[0].inputSchema.required, ['path']);
  const denied = await ro({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'office_create', arguments: { path: 'x.xlsx', spec: {} } } });
  assert.equal(denied.result.isError, true);
  const insp = await rw({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'office_inspect', arguments: { path: 'book.xlsx', rows: 3 } } });
  assert.equal(insp.result.isError, false);
  assert.match(insp.result.content[0].text, /Excel workbook: 2 sheet\(s\)/);
  const outside = await rw({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'office_create', arguments: { path: '../escape.xlsx', spec: { sheets: [] } } } });
  assert.equal(outside.result.isError, true);
  assert.match(outside.result.content[0].text, /outside the project folder/);
  const made = await rw({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'office_create', arguments: { path: 'mcp/notes.docx', markdown: '# Note\n\nHello' } } });
  assert.match(made.result.content[0].text, /Created mcp[\\/]notes\.docx/);
  const table = JSON.parse((await rw({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'office_read_table', arguments: { path: 'book.xlsx', sheet: 'summary', offset: 1, limit: 1 } } })).result.content[0].text);
  assert.deepEqual(table.rows, [['Downtown', '2025-03-01', 1234.5]]);
  assert.equal((await rw({ jsonrpc: '2.0', id: 9, method: 'nope' })).error.code, -32601);
});

test('office: MCP settings — the built-in server starts with this Node.js, read-only for reviewers', async () => {
  const { sanitizeMcpSettings, serversFor, MCP_PRESETS, claudeMcpConfig } = await import('../../src/mcp/mcp.mjs');
  assert.ok(MCP_PRESETS.some((p) => p.builtin === 'office'));
  const settings = { mcp: sanitizeMcpSettings({ servers: [{ name: 'office', builtin: 'office', roles: 'all', engines: ['claude', 'codex', 'opencode'] }] }) };
  assert.deepEqual(settings.mcp.servers[0].engines, ['claude', 'codex'], 'OpenCode shares one server across projects: not offered');
  const dev = serversFor(settings, { engine: 'claude' });
  assert.equal(dev[0].command, process.execPath);
  assert.match(dev[0].args[0], /office[\\/]cli\.mjs$/);
  assert.deepEqual(dev[0].args.slice(1), ['mcp']);
  assert.deepEqual(serversFor(settings, { engine: 'claude', readOnly: true })[0].args.slice(1), ['mcp', '--read-only']);
  assert.equal(serversFor(settings, { engine: 'opencode' }).length, 0);
  assert.equal(claudeMcpConfig(dev).mcpServers.office.command, process.execPath);
});

test('office: Scout recognises office libraries; prompts tell the developer and show the reviewer the files', async () => {
  const { scanProject } = await import('../../src/scout/scout.mjs');
  const p = path.join(DIR, 'pyproj');
  await fsp.mkdir(p, { recursive: true });
  await fsp.writeFile(path.join(p, 'requirements.txt'), 'openpyxl==3.1\nrequests\n');
  await fsp.writeFile(path.join(p, 'app.py'), 'print(1)\n');
  const scout = await scanProject(p);
  const st = scout.stacks.find((s) => s.id === 'office');
  assert.ok(st, scout.stacks.map((s) => s.id).join(','));
  assert.deepEqual(st.libraries, ['openpyxl']);
  const plain = path.join(DIR, 'plain');
  await fsp.mkdir(plain, { recursive: true });
  await fsp.writeFile(path.join(plain, 'requirements.txt'), 'requests\nflask\n');
  assert.equal((await scanProject(plain)).stacks.some((s) => s.id === 'office'), false);

  const P = await import('../../src/orchestrator/prompts.mjs');
  const base = { project: { name: 'p', dir: DIR }, objective: { version: 1, text: 'x' }, rules: '', task: { id: 'T1', title: 't', description: 'd', acceptance: [] }, tasks: [], previousAttempts: [] };
  const without = P.developerPrompt({ ...base, checks: [], opts: { officeCli: 'node "/sp/src/main.mjs" office' } });
  assert.doesNotMatch(without, /OFFICE TOOLS/);
  const withScout = P.developerPrompt({ ...base, checks: [], opts: { scout: { stacks: ['python', 'office'] }, officeCli: 'node "/sp/src/main.mjs" office' } });
  assert.match(withScout, /OFFICE TOOLS/);
  assert.match(withScout, /node "\/sp\/src\/main\.mjs" office inspect <file>/);
  const withCheck = P.developerPrompt({ ...base, checks: [{ type: 'office', name: 'Office', enabled: true, expect: [{ file: 'out/r.xlsx', minRows: 3 }] }], opts: { officeCli: 'sp office' } });
  assert.match(withCheck, /Expectations \(exact\): \[\{"file":"out\/r\.xlsx","minRows":3\}\]/);
  const { officePreviews } = await import('../../src/office/check.mjs');
  const previews = await officePreviews(DIR, ['book.xlsx', 'readme.md']);
  assert.match(previews, /### book\.xlsx\nExcel workbook/);
  const review = P.reviewPrompt({ objective: { version: 1, text: 'x' }, task: { id: 'T1', title: 't', description: 'd', acceptance: [] }, developerSummary: '', changes: { added: ['book.xlsx'], modified: [], deleted: [] }, patches: [], checks: [], opts: { officeFiles: previews } });
  assert.match(review, /OFFICE FILES CHANGED[\s\S]*Downtown/);
});

test('office CLI: create, inspect --json, verify exit codes', async () => {
  const { runFile } = await import('../../src/util/proc.mjs');
  const { fileURLToPath } = await import('node:url');
  const main = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'main.mjs');
  const cli = (...a) => runFile(process.execPath, [main, 'office', ...a], { cwd: DIR, timeoutMs: 60_000 });
  const c = await cli('create', 'cli.xlsx', '--spec', '{"sheets":[{"name":"A","columns":["x"],"rows":[[1],[2]]}]}');
  assert.equal(c.exitCode, 0, c.stderr);
  const i = await cli('inspect', 'cli.xlsx', '--json');
  assert.equal(i.exitCode, 0, i.stderr);
  assert.equal(JSON.parse(i.stdout).details.sheets[0].rows, 3);
  await fsp.writeFile(path.join(DIR, 'exp-ok.json'), JSON.stringify([{ file: 'cli.xlsx', minRows: 2 }]));
  await fsp.writeFile(path.join(DIR, 'exp-bad.json'), JSON.stringify([{ file: 'cli.xlsx', minRows: 5 }]));
  assert.equal((await cli('verify', 'exp-ok.json')).exitCode, 0);
  const bad = await cli('verify', 'exp-bad.json');
  assert.equal(bad.exitCode, 1);
  assert.match(bad.stdout, /FAIL cli\.xlsx/);
  const outside = await cli('create', '../x.xlsx', '--spec', '{"sheets":[]}');
  assert.equal(outside.exitCode, 1);
  assert.match(outside.stderr, /outside the project folder/);
});
