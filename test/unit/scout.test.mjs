// Scout agent: project-stack and program-runtime detection without an EXE picker or model call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ScoutAgent } from '../../src/scout/scout.mjs';

const scout = new ScoutAgent();

function fakePe() {
  const buf = Buffer.alloc(2048);
  buf.write('MZ', 0, 'latin1');
  buf.writeUInt32LE(0x80, 0x3c);
  buf.write('PE\0\0', 0x80, 'latin1');
  const coff = 0x84;
  buf.writeUInt16LE(0x14c, coff);
  buf.writeUInt16LE(1, coff + 2);
  buf.writeUInt16LE(0x1c0, coff + 16);
  const opt = coff + 20;
  buf.writeUInt16LE(0x10b, opt);
  buf.writeUInt32LE(0x1000, opt + 16);
  buf.writeUInt32LE(0x400000, opt + 28);
  buf.writeUInt16LE(3, opt + 68);
  const sec = opt + 0xe0;
  buf.write('.text\0\0\0', sec, 'latin1');
  buf.writeUInt32LE(0x1000, sec + 8);
  buf.writeUInt32LE(0x1000, sec + 12);
  buf.writeUInt32LE(0x200, sec + 16);
  buf.writeUInt32LE(0x400, sec + 20);
  buf.write('hello from a fake PE\0', 0x410, 'latin1');
  return buf;
}

test('project scout: package.json → Node stack, tools and npm test', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-scout-node-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'web', scripts: { test: 'vitest run', build: 'vite build' }, dependencies: { react: '^19' }, devDependencies: { vitest: '^3' } }));
  fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}');
  fs.writeFileSync(path.join(dir, 'tsconfig.json'), '{}');
  fs.writeFileSync(path.join(dir, 'src.ts'), 'export const x = 1;\n');
  const out = await scout.project(dir);
  assert.equal(out.kind, 'project');
  assert.equal(out.primary, 'node');
  assert.ok(out.stacks.some((s) => s.id === 'typescript'));
  assert.ok(out.tools.includes('node') && out.tools.includes('npm'));
  assert.ok(out.checks.some((c) => c.command === 'npm test'));
  assert.ok(out.frameworks.includes('react'));
  assert.match(out.summary, /Node/);
});

test('project scout: Python and Rust manifests both contribute checks', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-scout-mixed-'));
  fs.writeFileSync(path.join(dir, 'requirements.txt'), 'pytest==8.3\n');
  fs.writeFileSync(path.join(dir, 'Cargo.toml'), '[package]\nname="demo"\n');
  fs.mkdirSync(path.join(dir, 'tests'));
  const out = await scout.project(dir);
  assert.ok(out.stacks.some((s) => s.id === 'python'));
  assert.ok(out.stacks.some((s) => s.id === 'rust'));
  assert.ok(out.checks.some((c) => /pytest/.test(c.command)));
  assert.ok(out.checks.some((c) => /cargo test/.test(c.command)));
});

test('target scout: a program file identifies PE from its own header, not a path picker', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-scout-pe-'));
  const file = path.join(dir, 'sample.exe');
  fs.writeFileSync(file, fakePe());
  const out = await scout.target(file);
  assert.equal(out.kind, 'target');
  assert.equal(out.format, 'PE');
  assert.match(out.runtime, /Native Windows/);
  assert.ok(out.tools.includes('ghidra'));
  assert.ok(out.tools.includes('objdump'));
  assert.equal(out.recommendedMode, 'analyze');
});

test('target scout: a folder with a script reports its runtime', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-scout-script-'));
  fs.writeFileSync(path.join(dir, 'tool.js'), '#!/usr/bin/env node\nconsole.log("hi")\n');
  const out = await scout.target(dir);
  assert.equal(out.kind, 'target');
  assert.match(out.runtime, /node|Node/);
  assert.ok(out.tools.includes('node'));
});
