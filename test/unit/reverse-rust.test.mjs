// Sleep & Reverse & Rust It building blocks: recon, Rust scaffold, workspace setup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.SLEEPPILOT_QUIET = '1';
process.env.SLEEPPILOT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-rr-home-'));

const { buildTargetMirror } = await import('../../src/project/target-mirror.mjs');
const { runRecon, RECON_DIR, listZip } = await import('../../src/reverse/recon.mjs');
const { extractStrings, interestingStrings } = await import('../../src/reverse/strings.mjs');
const { parsePe, isPe } = await import('../../src/reverse/pe.mjs');
const { scaffoldRustProject, crateNameFrom, detectCargo } = await import('../../src/reverse/rust.mjs');
const { buildReverseProject } = await import('../../src/reverse/setup.mjs');
const { Store } = await import('../../src/store/store.mjs');
const { runChecks } = await import('../../src/checks/runner.mjs');

function temp(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `sp-${name}-`));
}

/** A tiny but structurally valid PE32 file with one section and no directories. */
function fakePe() {
  const buf = Buffer.alloc(2048);
  buf.write('MZ', 0, 'latin1');
  buf.writeUInt32LE(0x80, 0x3c);
  buf.write('PE\0\0', 0x80, 'latin1');
  const coff = 0x84;
  buf.writeUInt16LE(0x14c, coff); // machine i386
  buf.writeUInt16LE(1, coff + 2); // sections
  buf.writeUInt32LE(0x5f5e1000, coff + 4); // timestamp
  buf.writeUInt16LE(0xe0, coff + 16); // optional header size
  buf.writeUInt16LE(0x0102, coff + 18); // characteristics
  const opt = coff + 20;
  buf.writeUInt16LE(0x10b, opt); // PE32
  buf.writeUInt32LE(0x1000, opt + 16); // entry
  buf.writeUInt32LE(0x400000, opt + 28); // image base
  buf.writeUInt16LE(3, opt + 68); // console
  buf.writeUInt32LE(16, opt + 92); // rva count
  const sec = opt + 0xe0;
  buf.write('.text\0\0\0', sec, 'latin1');
  buf.writeUInt32LE(0x100, sec + 8);
  buf.writeUInt32LE(0x1000, sec + 12);
  buf.writeUInt32LE(0x200, sec + 16);
  buf.writeUInt32LE(0x400, sec + 20);
  buf.writeUInt32LE(0x60000020, sec + 36);
  buf.fill(0x90, 0x400, 0x600);
  buf.write('hello from a fake PE\0', 0x410, 'latin1');
  return buf;
}

test('strings: ASCII, UTF-16LE, dedupe and classification', () => {
  const buf = Buffer.concat([Buffer.from('https://example.com/api\0\x01\x02', 'latin1'), Buffer.from('P\0a\0s\0s\0w\0o\0r\0d\0', 'latin1')]);
  const list = extractStrings(buf);
  assert.ok(list.some((s) => s.text === 'https://example.com/api' && s.kind === 'url'));
  assert.ok(list.some((s) => s.text === 'Password' && s.encoding === 'utf16le'));
  assert.ok(Object.keys(interestingStrings(list)).includes('url'));
});

test('PE parser: header, machine, section and strings on a synthetic executable', () => {
  const buf = fakePe();
  assert.equal(isPe(buf), true);
  const pe = parsePe(buf);
  assert.equal(pe.format, 'pe');
  assert.match(pe.machine, /x86/);
  assert.equal(pe.subsystem, 'Windows CUI (console)');
  assert.equal(pe.sections.length, 1);
  assert.equal(pe.sections[0].name, '.text');
  assert.ok(pe.sections[0].entropy > 0);
});

test('recon: text mirror plus binary facts written to _recon', async () => {
  const target = temp('rr-target');
  const work = temp('rr-work');
  fs.writeFileSync(path.join(target, 'app.js'), 'function boot() {\n  return fetch("https://api.example.com/v1");\n}\n');
  fs.writeFileSync(path.join(target, 'helper.exe'), fakePe());
  const map = await buildTargetMirror({ targetDir: target, workDir: work });
  const { recon } = await runRecon({ targetPath: target, workDir: work, map });
  assert.equal(recon.inventory.files, 2);
  assert.equal(recon.binaries.length >= 1, true, 'the PE was analysed');
  const md = fs.readFileSync(path.join(work, RECON_DIR, 'RECON.md'), 'utf8');
  assert.match(md, /helper\.exe/);
  assert.match(md, /x86/);
  assert.match(md, /app\.js/);
  assert.match(fs.readFileSync(path.join(work, '_target', 'app.js'), 'utf8'), /api\.example\.com/);
  assert.ok(fs.existsSync(path.join(work, RECON_DIR, 'recon.json')));
  assert.ok(fs.existsSync(path.join(work, RECON_DIR, 'binaries.json')));
});

test('zip listing reads a central directory', () => {
  // A minimal empty ZIP with no entries: EOCD only.
  const buf = Buffer.alloc(22);
  buf.writeUInt32LE(0x06054b50, 0);
  buf.writeUInt16LE(0, 8);
  buf.writeUInt16LE(0, 10);
  buf.writeUInt32LE(0, 12);
  buf.writeUInt32LE(0, 16);
  const z = listZip(buf);
  assert.equal(z.count, 0);
  assert.deepEqual(z.entries, []);
});

test('crate names are valid Rust identifiers', () => {
  assert.equal(crateNameFrom('My App!'), 'my-app');
  assert.equal(crateNameFrom('123'), 'app-123');
  assert.equal(crateNameFrom(''), 'reverse-app');
});

test('Rust scaffold creates a project that cargo can at least read', async () => {
  const dir = temp('rr-rust');
  const r = await scaffoldRustProject({ projectDir: dir, name: 'Demo App' });
  assert.equal(r.scaffolded, true);
  assert.ok(fs.existsSync(path.join(dir, 'Cargo.toml')));
  assert.ok(fs.existsSync(path.join(dir, 'src', 'lib.rs')));
  assert.ok(fs.existsSync(path.join(dir, 'tests', 'acceptance.rs')));
  const toml = fs.readFileSync(path.join(dir, 'Cargo.toml'), 'utf8');
  assert.match(toml, /edition = "2021"/);
  assert.match(toml, /name = "demo-app"/);
  const cargo = await detectCargo();
  if (cargo.found) assert.equal(r.baseline?.exitCode, 0, r.baseline?.output);
});

test('cargo and document checks are executed as evidence', async () => {
  const dir = temp('rr-checks');
  await scaffoldRustProject({ projectDir: dir, name: 'Checks Demo' });
  fs.writeFileSync(path.join(dir, 'SPEC.md'), '# Spec\n\n' + 'Behaviour and test vectors. '.repeat(40));
  const cargo = await detectCargo();
  const results = await runChecks({
    projectDir: dir,
    checks: [
      { id: 'doc', type: 'doc-check', name: 'Spec present', entries: ['SPEC.md'], minBytes: 100, enabled: true },
      { id: 'missing', type: 'doc-check', name: 'Missing doc', entries: ['MISSING.md'], enabled: true },
      { id: 'cc', type: 'cargo', name: 'cargo check', cargo: 'check', enabled: true, timeoutSec: 300 },
      { id: 'ct', type: 'cargo', name: 'cargo test', cargo: 'test', enabled: true, timeoutSec: 300 },
    ],
    changedFiles: [],
  });
  assert.equal(results.find((r) => r.checkId === 'doc').status, 'passed');
  assert.equal(results.find((r) => r.checkId === 'missing').status, 'failed');
  if (cargo.found) {
    assert.equal(results.find((r) => r.checkId === 'cc').status, 'passed', results.find((r) => r.checkId === 'cc')?.output);
    assert.equal(results.find((r) => r.checkId === 'ct').status, 'passed', results.find((r) => r.checkId === 'ct')?.output);
  } else {
    assert.equal(results.find((r) => r.checkId === 'cc').status, 'error');
  }
});

test('buildReverseProject: workspace, objective, checks and protections', async () => {
  const target = temp('rr-setup-target');
  const work = temp('rr-setup-work');
  fs.writeFileSync(path.join(target, 'main.rs'), 'fn main() { println!("hello"); }\n');
  fs.writeFileSync(path.join(target, 'data.bin'), fakePe());
  const store = new Store();
  const project = await buildReverseProject({
    store,
    engine: { id: 'api', models: [{ providerID: 'fake', id: 'model' }], defaultModel: { providerID: 'fake', id: 'model' } },
    settings: { engine: 'api' },
    options: {
      targetPath: target,
      workDir: work,
      goals: 'Understand the program and rebuild it.',
      mode: 'rust',
      ack: true,
      engine: 'api',
    },
  });
  assert.equal(project.kind, 'reverse-rust');
  assert.equal(project.reverse.targetPath, target);
  assert.ok(project.objective.text.includes('SPEC.md'));
  assert.ok(project.objective.text.includes('Rust'));
  assert.ok(project.checks.some((c) => c.type === 'cargo' && c.id === 'cargo-check'));
  assert.ok(project.settings.protectedPaths.includes(target));
  assert.ok(fs.existsSync(path.join(work, 'Cargo.toml')));
  assert.ok(fs.existsSync(path.join(work, '_target', 'main.rs')));
  assert.ok(fs.existsSync(path.join(work, '_recon', 'RECON.md')));
  const checks = project.checks.filter((c) => c.type === 'cargo');
  const cargo = await detectCargo();
  assert.equal(checks.every((c) => c.enabled === !!cargo.found), true);

  const again = await buildReverseProject({ store, engine: null, settings: {}, options: { targetPath: target, workDir: work, goals: 'Updated goal', mode: 'analyze', ack: true } });
  assert.equal(again.id, project.id);
  assert.equal(again.reverse.mode, 'analyze');
  assert.match(again.objective.text, /Updated goal/);
});
