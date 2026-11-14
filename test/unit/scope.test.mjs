// Upfront project/target scope analysis and recommendations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { analyzeProjectScope, analyzeTargetScope } = await import('../../src/analysis/scope.mjs');

test('project scope: counts code/tests/TODOs and recommends a realistic run', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-scope-proj-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), '# Demo\n');
  fs.writeFileSync(path.join(dir, 'package.json'), '{"scripts":{"test":"node --test"}}');
  fs.writeFileSync(path.join(dir, 'src', 'main.py'), 'def run():\n    return 1\n' + '# TODO: more\n'.repeat(20));
  fs.writeFileSync(path.join(dir, 'tests', 'test_main.py'), 'from src.main import run\n');
  const scope = await analyzeProjectScope(dir, { inspection: { git: { isRepo: false } } });
  assert.equal(scope.kind, 'project');
  assert.equal(scope.metrics.hasTests, true);
  assert.equal(scope.metrics.sourceFiles, 2);
  assert.ok(scope.metrics.codeLines >= 3);
  assert.equal(scope.primaryLanguage, 'Python');
  assert.ok(scope.estimate.hours >= 0.5 && scope.estimate.hours <= 12);
  assert.ok(scope.estimate.maxIterations >= 8);
  assert.ok(scope.scope.summary.length > 10);
  assert.ok(scope.risks.some((r) => /Git repository/i.test(r)));
});

test('target scope: text and binary counts, recon estimate and Rust mode', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-scope-target-'));
  fs.writeFileSync(path.join(dir, 'app.js'), 'function boot() { return 1; }\n');
  const pe = Buffer.alloc(1024);
  pe.write('MZ', 0, 'latin1');
  fs.writeFileSync(path.join(dir, 'app.exe'), pe);
  const scope = await analyzeTargetScope(dir, { mode: 'rust' });
  assert.equal(scope.kind, 'reverse-target');
  assert.equal(scope.metrics.files, 2);
  assert.equal(scope.metrics.binaryFiles, 1);
  assert.ok(scope.metrics.binaries.some((b) => b.kind === 'Windows PE'));
  assert.ok(scope.estimate.hours >= 2);
  assert.ok(scope.estimate.reconMinutes >= 1);
  assert.match(scope.scope.summary, /Rust/);
});

test('target scope: a missing target is rejected', async () => {
  await assert.rejects(() => analyzeTargetScope(path.join(os.tmpdir(), 'definitely-missing-sp-target')), /not found/i);
});
