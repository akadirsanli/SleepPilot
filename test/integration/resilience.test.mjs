// "Never stuck" against the FAKE OpenCode server (explicit test double).
// Origin: on 29.10.2026 the app died at 08:03 in the middle of a night run (out of memory while
// diffing a generated file). Nothing restarted it, the reopened app waited for a click, and the
// task whose evaluation was cut off stayed "in progress" forever.
process.env.SLEEPPILOT_WATCHDOG_MS = '200';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupEnv, makeApp, newProject, finished, waitFor, plan, task } from './helpers.mjs';

const SLEEP = { reviewerEnabled: false, closingReport: false, unattended: true, permissionProfile: 'full' };

/**
 * Start a run, capture run.json while an iteration is in flight (what a crash leaves on disk),
 * end that app, then put the captured state back. mutate() adjusts the captured record.
 */
async function crashedRunOnDisk(name, thePlan, mutate = () => {}) {
  const { home, project } = setupEnv(name, thePlan);
  const app = await makeApp();
  const p = await newProject(app, project, { settings: SLEEP });
  const view = await app.startRun(p.id);
  const ctrl = app.controllers.get(view.id);
  await waitFor(() => ctrl.run.iterations.some((i) => i.status === 'running') && ctrl.run.tasks.some((t) => t.status === 'in_progress') && ctrl.run.activeTurn, { label: 'iteration in flight' });
  await ctrl.persist();
  const runFile = path.join(home, 'projects', p.id, 'runs', view.id, 'run.json');
  const onDisk = JSON.parse(fs.readFileSync(runFile, 'utf8'));
  assert.equal(onDisk.state, 'running');
  await ctrl.requestStop({ immediate: true });
  await finished(app, view.id);
  await app.shutdown();
  mutate(onDisk);
  fs.writeFileSync(runFile, JSON.stringify(onDisk));
  return { project, projectId: p.id, runId: view.id };
}

test('after a crash in sleep mode the reopened app continues the run by itself; a half-evaluated task is retried, not lost', { timeout: 120_000 }, async () => {
  const { project, projectId, runId } = await crashedRunOnDisk('crash', plan(task('Slow', ['slow 1500', 'write a.txt 1']), task('Next', ['write b.txt 2'], { priority: 3 })), (run) => {
    // Like T10 on 29.10.2026: the OpenCode turn had ended, the evaluation had not.
    run.activeTurn = null;
    run.activeTurns = {};
  });
  process.env.SLEEPPILOT_RECOVER_DELAY_MS = '100';
  process.env.SLEEPPILOT_LAST_CRASH = JSON.stringify({ reason: 'out of memory (JavaScript heap out of memory)', detail: 'FATAL ERROR: Reached heap limit' });
  const app = await makeApp();
  try {
    const ctrl = app.controllers.get(runId);
    assert.equal(ctrl.run.pause.code, 'app_crashed');
    const run = await finished(app, runId);
    assert.equal(run.stopReason.code, 'objective_completed');
    assert.equal(run.crashRecoveries, 1);
    assert.match(run.recoveries[0].reason, /out of memory/);
    // No automatic checks in this project, so "implemented, not verified" is the best possible result.
    assert.ok(run.tasks.every((t) => t.status === 'implemented_unverified'), JSON.stringify(run.tasks.map((t) => [t.id, t.status])));
    assert.ok(fs.existsSync(path.join(project, 'a.txt')) && fs.existsSync(path.join(project, 'b.txt')));
    assert.ok(ctrl.logBuffer.some((e) => /closed 1 unfinished iteration\(s\), re-queued 1 task/.test(e.text)));
    assert.ok(!run.iterations.some((i) => i.status === 'running'), 'no iteration is left "running"');
    const { markdown } = await app.report(projectId, runId);
    assert.match(markdown, /Interruptions and self-recovery/);
    assert.match(markdown, /out of memory/);
  } finally {
    delete process.env.SLEEPPILOT_LAST_CRASH;
    await app.shutdown();
  }
});

test('crash after the developer turn ended but before its evaluation: that turn is evaluated, the task is NOT run again', { timeout: 120_000 }, async () => {
  const { home, project } = setupEnv('evalcrash', plan(task('Write a file', ['write a.txt 1'])));
  const slowCheck = { id: 'slow', type: 'command', name: 'slow check', command: `node -e "setTimeout(()=>{}, 2500)"`, enabled: true, approved: true };
  let app = await makeApp();
  const p = await newProject(app, project, { settings: SLEEP, checks: [slowCheck] });
  const view = await app.startRun(p.id);
  let ctrl = app.controllers.get(view.id);
  // The checks are running: the OpenCode turn is over, the iteration is not evaluated yet.
  await waitFor(() => ctrl.run.activity?.phase === 'checks', { label: 'checks phase' });
  await ctrl.persist();
  const runFile = path.join(home, 'projects', p.id, 'runs', view.id, 'run.json');
  const onDisk = JSON.parse(fs.readFileSync(runFile, 'utf8'));
  assert.equal(onDisk.state, 'running');
  assert.ok(onDisk.evaluating?.['1'], 'the finished turn is remembered until it is evaluated');
  await ctrl.requestStop({ immediate: true });
  await finished(app, view.id);
  await app.shutdown();
  fs.writeFileSync(runFile, JSON.stringify(onDisk));
  assert.ok(fs.existsSync(path.join(project, 'a.txt')), "the turn's work is on disk, as after a real crash");
  process.env.SLEEPPILOT_RECOVER_DELAY_MS = '100';
  app = await makeApp();
  try {
    ctrl = app.controllers.get(view.id);
    const run = await finished(app, view.id);
    assert.equal(run.stopReason.code, 'objective_completed');
    assert.equal(run.tasks[0].status, 'verified', JSON.stringify(run.tasks[0].history.slice(-3)));
    assert.equal(run.iterations.length, 1, 'no second developer iteration');
    assert.equal(run.iterations[0].status, 'completed');
    assert.ok(ctrl.logBuffer.some((e) => /evaluating that turn's result/.test(e.text)));
    assert.deepEqual(run.evaluating, {});
  } finally {
    await app.shutdown();
  }
});

test('a turn in flight at the crash is reconciled from OpenCode records and the run goes on', { timeout: 120_000 }, async () => {
  const { project, runId } = await crashedRunOnDisk('crashturn', plan(task('Slow', ['slow 1500', 'write a.txt 1'])));
  process.env.SLEEPPILOT_RECOVER_DELAY_MS = '100';
  const app = await makeApp();
  try {
    const run = await finished(app, runId);
    assert.equal(run.stopReason.code, 'objective_completed');
    assert.equal(run.crashRecoveries, 1);
    assert.ok(fs.existsSync(path.join(project, 'a.txt')));
  } finally {
    await app.shutdown();
  }
});

test('closed by the user: the run is NOT continued by itself', { timeout: 120_000 }, async () => {
  const { runId } = await crashedRunOnDisk('clean', plan(task('Slow', ['slow 1500', 'write a.txt 1'])), (run) => {
    run.closedCleanly = Date.now();
  });
  process.env.SLEEPPILOT_RECOVER_DELAY_MS = '100';
  const app = await makeApp();
  try {
    const ctrl = app.controllers.get(runId);
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(ctrl.run.state, 'paused');
    assert.equal(ctrl.run.pause.code, 'app_restarted');
    assert.ok(!ctrl.run.crashRecoveries);
  } finally {
    await app.shutdown();
  }
});

test('stall watchdog: a turn with no sign of life is stopped and retried, then blocked; the run moves on', { timeout: 120_000 }, async () => {
  process.env.SLEEPPILOT_STALL_MS = '1500';
  const { project } = setupEnv('stall', plan(task('Hanging command', ['slow 60000', 'write never.txt x']), task('Normal', ['write ok.txt 1'], { priority: 3 })));
  const app = await makeApp();
  try {
    const p = await newProject(app, project, { settings: { ...SLEEP, maxTurnMin: 0, maxAttemptsSameFailure: 2 } });
    const view = await app.startRun(p.id);
    const ctrl = app.controllers.get(view.id);
    const run = await finished(app, view.id);
    const t1 = run.tasks.find((t) => t.title === 'Hanging command');
    assert.equal(t1.status, 'blocked', JSON.stringify(t1.history.at(-1)));
    assert.equal(t1.timeouts, 2);
    assert.ok(run.stalls >= 2);
    assert.ok(ctrl.logBuffer.some((e) => /Stall detected/.test(e.text)));
    assert.ok(fs.existsSync(path.join(project, 'ok.txt')), 'the run moved on to the other task');
  } finally {
    delete process.env.SLEEPPILOT_STALL_MS;
    await app.shutdown();
  }
});
