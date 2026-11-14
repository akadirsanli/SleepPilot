// "Never stuck" building blocks. Origin: a night run on 29.10.2026 died at 08:03 when the line
// diff of a regenerated 30 000-line JSON file ran out of memory; nothing restarted the app.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-resilience-'));
process.env.SLEEPPILOT_HOME = home;
process.env.SLEEPPILOT_QUIET = '1';

const { unifiedDiff, MAX_EDIT_DISTANCE } = await import('../../src/project/snapshot.mjs');
const { supervise, describeExit } = await import('../../src/supervisor.mjs');
const { stallLimitMs } = await import('../../src/orchestrator/run-controller.mjs');

const count = (patch, sign) => (patch.match(sign === '+' ? /^\+(?!\+\+ )/gm : /^-(?!-- )/gm) || []).length;
const bigJson = (n, f = (i) => i) => Array.from({ length: n }, (_, i) => `    ${f(i) * 0.0001234},`).join('\n') + '\n';

test('line diff of a huge added file is instant and uses little memory (was: out of memory)', () => {
  const t = Date.now();
  const p = unifiedDiff('fixture_checkpoint.json', '', bigJson(30_642));
  assert.ok(Date.now() - t < 3000, `took ${Date.now() - t} ms`);
  assert.equal(count(p, '+'), 30_642);
  assert.equal(count(p, '-'), 0);
});

test('line diff of a completely rewritten huge file stays bounded and still counts every line', () => {
  const t = Date.now();
  const p = unifiedDiff('w.json', bigJson(20_000), bigJson(20_000, (i) => i + 0.5));
  assert.ok(Date.now() - t < 5000, `took ${Date.now() - t} ms`);
  assert.equal(count(p, '+'), 20_000);
  assert.equal(count(p, '-'), 20_000);
});

test('line diff stays exact for edits inside a big file and for many scattered edits under the bound', () => {
  const lines = bigJson(30_000).split('\n');
  const edited = [...lines];
  edited.splice(15_000, 3, 'a', 'b');
  const p = unifiedDiff('x', lines.join('\n'), edited.join('\n'));
  assert.equal(count(p, '+'), 2);
  assert.equal(count(p, '-'), 3);
  const scattered = lines.map((l, i) => (i % 40 === 7 ? l + ' y' : l));
  const q = unifiedDiff('x', lines.join('\n'), scattered.join('\n'));
  assert.equal(count(q, '+'), 750);
  assert.equal(count(q, '-'), 750);
  assert.ok(750 * 2 < MAX_EDIT_DISTANCE);
});

test('crash reasons are recognised from exit data', () => {
  assert.match(describeExit({ code: 134, stderrTail: 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory' }).reason, /out of memory/);
  assert.match(describeExit({ code: 1, hung: true }).reason, /stopped responding/);
  assert.match(describeExit({ code: 1, requested: 'stall: run 25 min' }).reason, /restart requested/);
  assert.match(describeExit({ code: 3 }).reason, /exit code 3/);
});

test('stall limit is generous and follows the per-turn cap', () => {
  assert.equal(stallLimitMs({ maxTurnMin: 8 }), 23 * 60_000);
  assert.equal(stallLimitMs({ maxTurnMin: 0 }), 60 * 60_000);
  assert.equal(stallLimitMs({ maxTurnMin: 2, finalGraceMin: 30 }), 40 * 60_000);
});

const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'fake-worker.mjs');

async function superviseFake(modes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-sup-'));
  const counter = path.join(dir, 'count');
  process.env.FAKE_WORKER_COUNTER = counter;
  process.env.FAKE_WORKER_MODES = modes.join(',');
  process.env.SLEEPPILOT_RESTART_DELAY_MS = '50';
  process.env.SLEEPPILOT_HANG_MS = '1500';
  const code = await supervise({ entry: WORKER, args: ['--test-mode'] });
  const starts = Number(fs.readFileSync(counter, 'utf8'));
  return { code, starts, info: (n) => JSON.parse(fs.readFileSync(`${counter}.${n}.json`, 'utf8')) };
}

test('supervisor restarts the app after an out-of-memory crash and hands over the reason', { timeout: 30_000 }, async () => {
  const r = await superviseFake(['oom', 'exit0']);
  assert.equal(r.code, 0);
  assert.equal(r.starts, 2);
  const first = r.info(1);
  const second = r.info(2);
  assert.equal(first.lastCrash, null);
  assert.equal(first.worker, '1');
  assert.ok(first.args.includes('--worker') && first.args.includes('--test-mode'));
  assert.ok(!first.args.includes('--no-open'), 'the first start opens the window');
  assert.ok(second.args.includes('--no-open'), 'a restart does not open a second window');
  assert.equal(second.token, first.token, 'same UI token, so the open window reconnects');
  assert.match(JSON.parse(second.lastCrash).reason, /out of memory/);
  const logs = fs.readdirSync(path.join(home, 'logs')).map((f) => fs.readFileSync(path.join(home, 'logs', f), 'utf8')).join('\n');
  assert.match(logs, /app exited unexpectedly: out of memory/);
  assert.match(logs, /heap out of memory/, 'the fatal message is kept in the log file');
});

test('supervisor kills a frozen app (no heartbeat) and on request, then restarts it', { timeout: 30_000 }, async () => {
  const r = await superviseFake(['hang', 'restart', 'exit0']);
  assert.equal(r.code, 0);
  assert.equal(r.starts, 3);
  assert.match(JSON.parse(r.info(2).lastCrash).reason, /stopped responding/);
  assert.match(JSON.parse(r.info(3).lastCrash).reason, /test stall/);
});

test('memory guard: a nearly full heap is saved and restarted before V8 would crash', { timeout: 15_000 }, async () => {
  const r = await superviseFake(['heap', 'exit0']);
  assert.equal(r.starts, 2);
  assert.match(JSON.parse(r.info(2).lastCrash).reason, /close to the memory limit \(0 \/ 0 MB\)/);
  assert.equal(fs.readFileSync(process.env.FAKE_WORKER_COUNTER + '.saved', 'utf8'), '1', 'state was saved before the restart');
});

test('a normal exit ends the supervision without a restart', { timeout: 15_000 }, async () => {
  const r = await superviseFake(['exit0']);
  assert.equal(r.code, 0);
  assert.equal(r.starts, 1);
});

test('instance lock: a live owner blocks a second instance, a dead owner\'s lock is taken over', async () => {
  const { acquireInstanceLock, lockFile } = await import('../../src/util/instance-lock.mjs');
  const { spawn } = await import('node:child_process');
  const owner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    fs.writeFileSync(lockFile(), JSON.stringify({ pid: owner.pid, at: Date.now() }));
    const r = acquireInstanceLock();
    assert.equal(r.ok, false);
    assert.equal(r.pid, owner.pid);
  } finally {
    owner.kill();
  }
  await new Promise((res) => owner.on('exit', res));
  const r2 = acquireInstanceLock();
  assert.equal(r2.ok, true, 'the lock of a process that is gone is taken over');
  assert.equal(JSON.parse(fs.readFileSync(lockFile(), 'utf8')).pid, process.pid);
});
