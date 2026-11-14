// Integration tests against the FAKE OpenCode server (explicit test double).
// They exercise SleepPilot's real orchestration, persistence, checks (incl. headless Edge),
// and recovery code. They are NOT OpenCode Go integration tests — see test/real/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupEnv, makeApp, newProject, finished, waitFor, plan, task } from './helpers.mjs';
import { findBrowser } from '../../src/checks/browser.mjs';

const hasBrowser = !!findBrowser();

test('HTML project without Git: plan → 2 real iterations → checks → verified → report → history after restart', { timeout: 180_000 }, async () => {
  const { project } = setupEnv('happy');
  const app = await makeApp();
  try {
    const p = await newProject(app, project);
    assert.equal(p.inspection.git.isRepo, false, 'test project must not be a Git repo');
    // Empty folder: inspection suggests nothing; configure the built-in checks explicitly.
    await app.updateProject(p.id, {
      checks: [
        { id: 'js-syntax', type: 'js-syntax', name: 'JS syntax', enabled: true },
        { id: 'html-smoke', type: 'html-smoke', name: 'HTML smoke', entries: ['index.html'], enabled: hasBrowser },
      ],
    });
    const view = await app.startRun(p.id);
    const run = await finished(app, view.id);
    assert.equal(run.state, 'completed', JSON.stringify(run.stopReason));
    assert.equal(run.stopReason.code, 'objective_completed');
    assert.equal(run.iterationCount, 2);
    assert.equal(run.tasks.length, 2);
    for (const t of run.tasks) assert.equal(t.status, 'verified', `${t.id}: ${t.history.at(-1).note}`);
    assert.equal(fs.readFileSync(path.join(project, 'app.js'), 'utf8').trim(), "document.getElementById('status').textContent = 'ready';");
    // Evidence: every iteration has a session id, message id, changed files and executed checks.
    for (const it of run.iterations) {
      assert.match(it.sessionID, /^ses/);
      assert.match(it.messageId, /^msg_/);
      assert.ok(it.changedCount > 0);
      assert.ok(it.checks.some((c) => c.status === 'passed'));
    }
    const it2 = await app.getIteration(p.id, run.id, 2);
    if (hasBrowser) assert.equal(it2.checks.find((c) => c.type === 'html-smoke').status, 'passed', JSON.stringify(it2.checks));
    assert.deepEqual(it2.changes.modified, ['app.js']);
    assert.ok(run.usage.tokens.input > 0 && run.usage.byRole.manager.turns >= 3 && run.usage.byRole.reviewer.turns === 2);
    const { markdown, file } = await app.report(p.id, run.id);
    assert.ok(fs.existsSync(file));
    assert.match(markdown, /TEST MODE/);
    assert.match(markdown, /Completed and verified \(2\)/);
    assert.match(markdown, /not an actual charge/);
  } finally {
    await app.shutdown();
  }
  // Reopen the application: the previous run is listed and readable.
  const app2 = await makeApp();
  try {
    const projects = await app2.store.listProjects();
    assert.equal(projects.length, 1);
    const { runs } = await app2.getProject(projects[0].id);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].state, 'completed');
    const { run, events } = await app2.getRun(projects[0].id, runs[0].id);
    assert.equal(run.iterationCount, 2);
    assert.ok(events.some((e) => e.kind === 'finish'));
  } finally {
    await app2.shutdown();
  }
});

test('failing check → test_failed → repair → repeated failure limit → blocked; never "verified"', { timeout: 120_000 }, async () => {
  const { project } = setupEnv('fail', plan(task('Write a broken script', ['write broken.js function (']), task('Second task', ['write ok.txt fine'], { priority: 3 })));
  const app = await makeApp();
  try {
    const p = await newProject(app, project, { settings: { maxAttemptsSameFailure: 2, reviewerEnabled: false }, checks: [{ id: 'js-syntax', type: 'js-syntax', name: 'JS syntax', enabled: true }] });
    const view = await app.startRun(p.id);
    const run = await finished(app, view.id);
    const t1 = run.tasks.find((t) => t.title === 'Write a broken script');
    assert.equal(t1.status, 'blocked');
    assert.equal(t1.blockedReason, 'repeated_failure');
    assert.ok(t1.history.some((h) => h.to === 'test_failed'));
    assert.ok(!t1.history.some((h) => h.to === 'verified'));
    // Second task has no applicable check (txt file) → implemented but NOT verified.
    const t2 = run.tasks.find((t) => t.title === 'Second task');
    assert.equal(t2.status, 'implemented_unverified');
    assert.equal(run.stopReason.code, 'repeated_failure');
    const it1 = await app.getIteration(p.id, run.id, 1);
    assert.equal(it1.checks[0].status, 'failed');
    assert.ok(it1.checks[0].exitCode !== 0);
  } finally {
    await app.shutdown();
  }
});

test('objective change during a run (after iteration) re-plans without losing completed work', { timeout: 120_000 }, async () => {
  const { project } = setupEnv('steer', plan(task('Economy system', ['write economy.txt v1', 'slow 1500']), task('Economy details', ['write economy2.txt v2'], { priority: 2 })));
  const app = await makeApp();
  try {
    const p = await newProject(app, project, { settings: { reviewerEnabled: false } });
    const view = await app.startRun(p.id);
    const ctrl = app.controllers.get(view.id);
    await waitFor(() => ctrl.run.activity.phase === 'developer', { label: 'developer phase' });
    const s = await ctrl.steer({ text: 'Leave the economy system for now. Prioritise the report screen.\nACTION: write report.html <h1>Report</h1>', mode: 'after_iteration' });
    assert.equal(s.status, 'pending');
    const run = await finished(app, view.id);
    const steer = run.steering[0];
    assert.equal(steer.status, 'applied');
    assert.equal(steer.appliedAfterIteration, 1, 'applied only after the current iteration completed');
    assert.ok(steer.resultingObjectiveVersion > run.objectiveVersionAtStart);
    // Completed work from iteration 1 is preserved.
    assert.equal(run.tasks[0].status, 'implemented_unverified');
    // The steering task ran before the deprioritised economy task.
    const order = run.iterations.map((i) => i.taskTitle);
    assert.match(order[1], /^Instruction:/);
    assert.ok(fs.existsSync(path.join(project, 'report.html')));
    const proj = await app.store.getProject(p.id);
    assert.equal(proj.objectiveHistory.length, 2);
    assert.equal(proj.objectiveHistory[1].instruction.split('\n')[0], 'Leave the economy system for now. Prioritise the report screen.');
  } finally {
    await app.shutdown();
  }
});

test('immediate steering interrupts the active OpenCode execution and switches direction', { timeout: 120_000 }, async () => {
  const { project } = setupEnv('steer-now', plan(task('Long task', ['slow 20000', 'write long.txt done'])));
  const app = await makeApp();
  try {
    const p = await newProject(app, project, { settings: { reviewerEnabled: false } });
    const view = await app.startRun(p.id);
    const ctrl = app.controllers.get(view.id);
    await waitFor(() => ctrl.run.activeTurn?.role === 'developer' && ctrl.run.activeTurn.submittedAt, { label: 'developer turn submitted' });
    const t0 = Date.now();
    await ctrl.steer({ text: 'Drop this, do something short.\nACTION: write short.txt ok', mode: 'interrupt_now' });
    await waitFor(() => ctrl.run.iterations[0]?.status === 'interrupted', { label: 'interrupted iteration', timeoutMs: 15_000 });
    assert.ok(Date.now() - t0 < 15_000, 'interrupt took effect well before the 20 s task would finish');
    await waitFor(() => fs.existsSync(path.join(project, 'short.txt')), { label: 'steered task output' });
    assert.ok(!fs.existsSync(path.join(project, 'long.txt')));
    await ctrl.requestStop({ immediate: true });
    const run = await finished(app, view.id);
    assert.equal(run.stopReason.code, 'user_stopped');
    assert.equal(run.iterations[0].turnStatus, 'interrupted');
  } finally {
    await app.shutdown();
  }
});

test('pause (finish iteration) and resume; immediate pause interrupts', { timeout: 120_000 }, async () => {
  const { project } = setupEnv('pause', plan(task('A', ['slow 1200', 'write a.txt a']), task('B', ['slow 6000', 'write b.txt b'], { priority: 3 }), task('C', ['write c.txt c'], { priority: 4 })));
  const app = await makeApp();
  try {
    const p = await newProject(app, project, { settings: { reviewerEnabled: false } });
    const view = await app.startRun(p.id);
    const ctrl = app.controllers.get(view.id);
    await waitFor(() => ctrl.run.activity.phase === 'developer', { label: 'developer phase' });
    await ctrl.requestPause();
    await waitFor(() => ctrl.run.state === 'paused', { label: 'paused' });
    assert.equal(ctrl.run.pause.code, 'user_paused');
    assert.equal(ctrl.run.iterationCount, 1, 'current iteration finished, no new one started');
    assert.ok(fs.existsSync(path.join(project, 'a.txt')));
    const pausedAt = ctrl.elapsedActive();
    await new Promise((r) => setTimeout(r, 800));
    assert.ok(ctrl.elapsedActive() - pausedAt < 50, 'paused time is not counted');
    await ctrl.resume();
    await waitFor(() => ctrl.run.activeTurn?.role === 'developer' && ctrl.run.iterationCount === 2 && ctrl.run.activeTurn.submittedAt, { label: 'iteration 2 running' });
    await ctrl.requestPause({ immediate: true });
    await waitFor(() => ctrl.run.state === 'paused', { label: 'paused immediately', timeoutMs: 15_000 });
    const tB = ctrl.run.tasks.find((t) => t.title === 'B');
    assert.equal(tB.status, 'pending');
    assert.ok(!fs.existsSync(path.join(project, 'b.txt')));
    await ctrl.resume();
    const run = await finished(app, view.id);
    assert.equal(run.state, 'completed');
    assert.ok(fs.existsSync(path.join(project, 'b.txt')) && fs.existsSync(path.join(project, 'c.txt')));
    assert.equal(run.iterations.find((i) => i.n === 2).status, 'interrupted');
  } finally {
    await app.shutdown();
  }
});

test('permission requests and questions are surfaced and answered, never auto-approved', { timeout: 120_000 }, async () => {
  const { project } = setupEnv('perm', plan(task('Run a command', ['permission npm install left-pad', 'form Which colour?', 'write done.txt ok'])));
  const app = await makeApp();
  try {
    const p = await newProject(app, project, { settings: { reviewerEnabled: false } });
    const view = await app.startRun(p.id);
    const ctrl = app.controllers.get(view.id);
    const perm = await waitFor(() => ctrl.run.pending.permissions[0], { label: 'permission pending' });
    assert.equal(perm.action, 'shell');
    assert.deepEqual(perm.resources, ['npm install left-pad']);
    assert.equal(ctrl.run.activity.phase, 'waiting_permission');
    await new Promise((r) => setTimeout(r, 600));
    assert.ok(!fs.existsSync(path.join(project, 'done.txt')), 'nothing proceeds without an answer');
    await ctrl.replyPermission(perm.id, 'once');
    const form = await waitFor(() => ctrl.run.pending.forms[0], { label: 'form pending' });
    assert.equal(form.title, 'Which colour?');
    await ctrl.replyForm(form.id, { answer: 'mavi' });
    const run = await finished(app, view.id);
    assert.equal(run.state, 'completed');
    assert.equal(JSON.parse(fs.readFileSync(path.join(project, 'form-answer.txt'), 'utf8')).answer, 'mavi');
    assert.equal(run.pending.permissions.length, 0);
  } finally {
    await app.shutdown();
  }
});

test('rejected permission (OpenCode stops without idle marker): developer is told and continues in the same session; no provider error, no long wait', { timeout: 120_000 }, async () => {
  const { project } = setupEnv('reject', plan(task('Paket kur', ['permission npm install left-pad', 'write pkg.txt ok']), task('Sonraki', ['write next.txt ok'], { priority: 3 })));
  const app = await makeApp();
  try {
    const p = await newProject(app, project, { settings: { reviewerEnabled: false } });
    const view = await app.startRun(p.id);
    const ctrl = app.controllers.get(view.id);
    const perm = await waitFor(() => ctrl.run.pending.permissions[0], { label: 'permission pending' });
    const t0 = Date.now();
    await ctrl.replyPermission(perm.id, 'reject');
    const run = await finished(app, view.id);
    assert.ok(Date.now() - t0 < 20_000, 'the stopped turn is recognised immediately, not after the lost-turn grace period');
    assert.ok(!run.iterations.some((i) => i.status === 'provider_error'));
    const it1 = await app.getIteration(p.id, run.id, 1);
    assert.equal(it1.turn.followUpMessageIds.length, 1, 'one follow-up was sent in the same session');
    assert.ok(it1.turn.tools.some((t) => /declined/.test(t.error?.message || '')));
    assert.ok(ctrl.logBuffer.some((e) => /Telling the developer about the rejected operation/.test(e.text)));
    assert.notEqual(run.tasks[0].status, 'verified');
    assert.ok(fs.existsSync(path.join(project, 'next.txt')), 'the run moved on to the next task');
    assert.ok(!fs.existsSync(path.join(project, 'pkg.txt')));
  } finally {
    await app.shutdown();
  }
});

test('429 rate limit → bounded backoff then success; quota → pause with explanation', { timeout: 120_000 }, async () => {
  const { project } = setupEnv('ratelimit', plan(task('Rate limit', ['provider-error provider.rate-limit 2', 'write r.txt ok']), task('Quota', ['provider-error provider.quota 1', 'write q.txt ok'], { priority: 3 })));
  const app = await makeApp();
  try {
    const p = await newProject(app, project, { settings: { reviewerEnabled: false } });
    const view = await app.startRun(p.id);
    const ctrl = app.controllers.get(view.id);
    await waitFor(() => ctrl.run.state === 'paused', { label: 'quota pause', timeoutMs: 60_000 });
    assert.equal(ctrl.run.pause.code, 'quota');
    assert.match(ctrl.run.pause.message, /quota|allowance/i);
    assert.ok(fs.existsSync(path.join(project, 'r.txt')), 'rate-limited task succeeded after retries');
    const rIters = ctrl.run.iterations.filter((i) => i.taskTitle === 'Rate limit');
    assert.equal(rIters.filter((i) => i.status === 'provider_error').length, 2);
    assert.equal(ctrl.run.tasks.find((t) => t.title === 'Rate limit').status, 'implemented_unverified');
    assert.ok(!fs.existsSync(path.join(project, 'q.txt')));
    // User resumes after the (simulated) allowance reset: the fake fails only once.
    await ctrl.resume();
    const run = await finished(app, view.id);
    assert.equal(run.state, 'completed');
    assert.ok(fs.existsSync(path.join(project, 'q.txt')));
  } finally {
    await app.shutdown();
  }
});

test('Go allowance reported as limited → pause before starting work', { timeout: 60_000 }, async () => {
  const { project } = setupEnv('golimit');
  process.env.SLEEPPILOT_FAKE_GO_LIMITED = '1';
  const app = await makeApp();
  try {
    const p = await newProject(app, project);
    const view = await app.startRun(p.id);
    const ctrl = app.controllers.get(view.id);
    await waitFor(() => ctrl.run.state === 'paused', { label: 'quota pause' });
    assert.equal(ctrl.run.pause.code, 'quota');
    assert.equal(ctrl.run.iterationCount, 0);
    assert.ok(ctrl.run.pause.resetsAt > Date.now());
    await ctrl.requestStop();
    await finished(app, view.id);
  } finally {
    delete process.env.SLEEPPILOT_FAKE_GO_LIMITED;
    await app.shutdown();
  }
});

test('crash mid-turn → restart → run recovered as paused → reconciled from durable state, no duplicate submission', { timeout: 120_000 }, async () => {
  const { project } = setupEnv('crash', plan(task('Long task', ['write part1.txt half', 'slow 30000', 'write part2.txt full'])));
  process.env.SLEEPPILOT_LOST_GRACE_MS = '1000';
  const app = await makeApp();
  let runId;
  let messageId;
  let sessionID;
  const p = await newProject(app, project, { settings: { reviewerEnabled: false } });
  try {
    const view = await app.startRun(p.id);
    runId = view.id;
    const ctrl = app.controllers.get(runId);
    await waitFor(() => fs.existsSync(path.join(project, 'part1.txt')) && ctrl.run.activeTurn?.submittedAt, { label: 'turn in progress' });
    ({ messageId, sessionID } = ctrl.run.activeTurn);
    await ctrl.persist();
  } finally {
    // Simulate a crash: kill the OpenCode server and drop the app without finishing the run.
    await ctrl_kill(app);
  }
  const persisted = await app.store.getRun(p.id, runId);
  assert.ok(persisted.activeTurn, 'active turn was persisted before submission');
  assert.equal(persisted.activeTurn.messageId, messageId);

  const app2 = await makeApp();
  try {
    const ctrl2 = app2.controllers.get(runId);
    assert.ok(ctrl2, 'run recovered');
    assert.equal(ctrl2.run.state, 'paused');
    assert.equal(ctrl2.run.pause.code, 'app_restarted');
    const resumed = ctrl2.resume();
    await waitFor(() => ctrl2.run.iterations[0].status === 'interrupted', { label: 'reconciled', timeoutMs: 30_000 });
    // The interrupted task was not resent with the same message id.
    const msgs = (await app2.adapter.requireClient().call('session.message.list', { params: { sessionID }, query: { limit: 100, order: 'asc' } })).data;
    assert.equal(msgs.filter((m) => m.id === messageId).length, 1, 'exactly one user message for the original submission');
    const t = ctrl2.run.tasks[0];
    assert.ok(t.history.some((h) => /interrupted/.test(h.note)), 'task recorded as interrupted, to be retried with a recovery note');
    assert.ok(ctrl2.logBuffer.some((e) => e.kind === 'recovery' && /reached the engine/.test(e.text)), 'recovery inspected the durable engine record');
    await ctrl2.requestStop({ immediate: true });
    await resumed;
    await finished(app2, runId);
  } finally {
    delete process.env.SLEEPPILOT_LOST_GRACE_MS;
    await app2.shutdown();
  }
});

/** Simulated crash: the old process can no longer write anything, and its OpenCode server dies. */
async function ctrl_kill(app) {
  const deadStore = new Proxy({}, { get: () => async () => null });
  for (const c of app.controllers.values()) {
    c.removeAllListeners();
    c.store = deadStore;
    c.control.stop = { immediate: true, at: Date.now() };
  }
  process.env.SLEEPPILOT_RECONNECT_MS = '1000';
  app.adapter.client?.stopEvents();
  await app.adapter.server?.stop();
  await app.adapter.disconnect().catch(() => {});
  app.adapter.setStatus('disconnected', 'crashed (test)');
}
