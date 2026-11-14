// Sleep & Reverse building blocks. Origin: the agent could not read the target at all (it was a
// denied outside folder), and a real 76 MB single-file app had a 59-million-character base64 line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.SLEEPPILOT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-rev-unit-'));
process.env.SLEEPPILOT_QUIET = '1';
const { buildTargetMirror, verifyTargetUnchanged, MIRROR_DIR } = await import('../../src/project/target-mirror.mjs');
const { checkCitations } = await import('../../src/checks/citations.mjs');

function makeTarget() {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-rev-target-'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-rev-work-'));
  const wasm = Buffer.concat([Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]), Buffer.alloc(9000, 7)]).toString('base64');
  const lines = [
    '<!DOCTYPE html>',
    '<html lang="tr"><head><meta charset="utf-8"><title>İmza Aracı</title></head><body>',
    '<script>',
    'function detectPage(canvas) { return nms(run(canvas)); }',
    "document.getElementById('go').addEventListener('click', () => detectPage(c));",
    '</script>',
    `<script type="application/octet-stream" id="b64-wasm">${wasm}</script>`,
    '</body></html>',
  ];
  fs.writeFileSync(path.join(target, 'app.html'), lines.join('\r\n'));
  fs.mkdirSync(path.join(target, 'örnek'));
  fs.writeFileSync(path.join(target, 'örnek', 'sample.pdf'), '%PDF-1.7\n' + 'x'.repeat(100));
  return { target, work, lines };
}

test('mirror: same line numbers, byte-identical normal lines, blobs summarised and identified, symbols indexed', async () => {
  const { target, work, lines } = makeTarget();
  const map = await buildTargetMirror({ targetDir: target, workDir: work });
  const mirrored = fs.readFileSync(path.join(work, MIRROR_DIR, 'app.html'), 'latin1').split('\n');
  const original = fs.readFileSync(path.join(target, 'app.html'), 'latin1').split('\n');
  assert.equal(mirrored.length, original.length, 'line numbers are preserved');
  for (const i of [0, 1, 3, 4, 7]) assert.equal(mirrored[i], original[i], `line ${i + 1} is byte-identical (CRLF and UTF-8 kept)`);
  assert.ok(mirrored[6].length < 600 && /SleepPilot mirror: \d+ characters omitted - WebAssembly module/.test(mirrored[6]), mirrored[6].slice(0, 300));
  const app = map.files.find((f) => f.file === 'app.html');
  assert.equal(app.lines, lines.length);
  assert.deepEqual(app.longLines.map((l) => [l.line, l.id, l.content.kind]), [[7, 'b64-wasm', 'wasm']]);
  assert.ok(app.symbols.some((s) => s.name === 'detectPage' && s.line === 4));
  assert.ok(app.symbols.some((s) => s.kind === 'event' && s.name === 'click' && s.line === 5));
  assert.ok(app.blocks.some((b) => b.tag === 'script' && b.start === 3 && b.end === 6));
  const pdf = map.files.find((f) => f.file === 'örnek/sample.pdf');
  assert.equal(pdf.mirrored, false);
  assert.match(pdf.kind, /PDF/);
  const md = fs.readFileSync(path.join(work, MIRROR_DIR, 'TARGET_MAP.md'), 'utf8');
  assert.match(md, /`app.html:7` \| `<script id="b64-wasm"/);
  assert.match(md, /detectPage@4/);
  assert.equal((await verifyTargetUnchanged(map)).ok, true);
  fs.appendFileSync(path.join(target, 'app.html'), '<!-- changed -->');
  const after = await verifyTargetUnchanged(map);
  assert.deepEqual(after.changed, ['app.html']);
});

test('mirror refuses a workspace inside the target', async () => {
  const { target } = makeTarget();
  await assert.rejects(() => buildTargetMirror({ targetDir: target, workDir: path.join(target, 'out') }), /inside the target/);
});

test('citation check: real lines pass, invented lines fail, documents without target evidence fail', async () => {
  const { target, work } = makeTarget();
  await buildTargetMirror({ targetDir: target, workDir: work });
  fs.writeFileSync(path.join(work, 'ARCHITECTURE.md'), 'Detection starts in `detectPage` (`app.html:4`), wired at app.html:5 and the blob at _target/app.html:7.\nSee https://example.com/a.html:80 and version 1.22.0.\n');
  let r = await checkCitations({ projectDir: work, changedFiles: ['ARCHITECTURE.md'] });
  assert.equal(r.status, 'passed', r.output);
  assert.equal(r.details.toTarget, 3);
  fs.writeFileSync(path.join(work, 'FORMATS.md'), 'The parser is at `app.html:120-140`.\n');
  r = await checkCitations({ projectDir: work, changedFiles: ['ARCHITECTURE.md', 'FORMATS.md'] });
  assert.equal(r.status, 'failed');
  assert.match(r.output, /app\.html:120-140 \(app\.html has 8 lines\)/);
  fs.writeFileSync(path.join(work, 'NOTES.md'), 'No evidence at all.\n');
  r = await checkCitations({ projectDir: work, changedFiles: ['NOTES.md'] });
  assert.equal(r.status, 'failed');
  assert.match(r.output, /No citation points into the target/);
  r = await checkCitations({ projectDir: work, changedFiles: ['tool.py'] });
  assert.equal(r.status, 'skipped');
});

test('protected outside folder: shell commands naming it are denied, a sibling folder with the same prefix is not', async () => {
  const { developerRuleset } = await import('../../src/orchestrator/permissions.mjs');
  const target = 'C:\\demo\\demo_target';
  const work = 'C:\\demo\\demo_target-analysis';
  const rules = developerRuleset('full', { unattended: true, protectedPaths: [target, '_target'], projectDir: work });
  // OpenCode 2.x semantics (as in the fake server): wildcard match, the last matching rule wins.
  const re = (p) => new RegExp('^' + String(p).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 's');
  const effect = (action, resource) => rules.reduce((e, r) => (re(r.action).test(action) && re(r.resource).test(resource) ? r.effect : e), 'ask');
  assert.equal(effect('shell', `ls -la "${work}"`), 'allow', 'the workspace next to the target stays usable');
  assert.equal(effect('shell', `cd "C:/demo/demo_target-analysis" && python check.py`), 'allow');
  assert.equal(effect('shell', `type "${target}\\geri_yuklenen.html"`), 'deny');
  assert.equal(effect('shell', `dir ${target}`), 'deny');
  assert.equal(effect('shell', `cat "C:/demo/demo_target/a.html"`), 'deny');
  assert.equal(effect('external_directory', 'C:/demo/demo_target/*'), 'deny');
  assert.equal(effect('edit', '_target/geri_yuklenen.html'), 'deny', 'the mirror cannot be edited');
  assert.equal(effect('edit', 'INVENTORY.md'), 'allow');
});
