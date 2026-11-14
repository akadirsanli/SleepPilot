// Local Git/GitHub status helpers (no network, no repository creation).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runFile } from '../../src/util/proc.mjs';

const { detectGitHub, ensureGitRepo, pushProject } = await import('../../src/github/github.mjs');

async function git(args, cwd) {
  const r = await runFile('git', args, { cwd, timeoutMs: 60_000 });
  assert.equal(r.exitCode, 0, `${args.join(' ')}: ${r.stderr}`);
  return r;
}

test('git detection: a fresh repository is recognised and has no remote', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-gh-'));
  const init = await runFile('git', ['init', '-b', 'main'], { cwd: dir, timeoutMs: 30_000 });
  assert.equal(init.exitCode, 0, init.stderr);
  fs.writeFileSync(path.join(dir, 'README.md'), '# demo\n');
  const status = await detectGitHub({ projectDir: dir });
  assert.equal(status.isRepo, true);
  assert.equal(status.branch, 'main');
  assert.equal(status.remote, null);
  assert.equal(status.dirty, true);
  assert.ok(typeof status.gh.found === 'boolean');
});

test('commit & push works against a real local bare remote', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-gh-push-'));
  const remote = path.join(root, 'remote.git');
  const work = path.join(root, 'work');
  await git(['init', '--bare', remote], root);
  await git(['init', '-b', 'main', work], root);
  await git(['config', 'user.name', 'SleepPilot Test'], work);
  await git(['config', 'user.email', 'test@example.invalid'], work);
  fs.writeFileSync(path.join(work, 'a.txt'), 'one\n');
  await git(['add', '-A'], work);
  await git(['commit', '-m', 'initial'], work);
  await git(['remote', 'add', 'origin', remote], work);
  fs.writeFileSync(path.join(work, 'a.txt'), 'two\n');
  const result = await pushProject({ projectDir: work, message: 'second' });
  assert.equal(result.ok, true);
  assert.equal(result.committed, true);
  const after = await detectGitHub({ projectDir: work });
  assert.equal(after.dirty, false);
});

test('ensureGitRepo initializes only when needed; push without a remote is rejected', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-gh-empty-'));
  const first = await ensureGitRepo({ projectDir: dir });
  assert.equal(first.created, true);
  const second = await ensureGitRepo({ projectDir: dir });
  assert.equal(second.created, false);
  await assert.rejects(() => pushProject({ projectDir: dir, message: 'test' }), /no "origin" remote|not a Git repository/i);
});
