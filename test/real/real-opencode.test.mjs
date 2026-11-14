// REAL OpenCode integration test — uses the installed OpenCode and the user's configured
// account (e.g. OpenCode Go). It spends a small amount of real usage, so it only runs when
// SLEEPPILOT_REAL=1 is set:
//   set SLEEPPILOT_REAL=1 && npm run test:real
// Optional: SLEEPPILOT_REAL_MODEL=opencode-go/deepseek-v4.1-flash
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const enabled = process.env.SLEEPPILOT_REAL === '1';
process.env.SLEEPPILOT_QUIET = process.env.SLEEPPILOT_QUIET || '1';
process.env.SLEEPPILOT_NO_KEEPAWAKE = '1';

const modelRef = (process.env.SLEEPPILOT_REAL_MODEL || 'opencode-go/deepseek-v4.1-flash').split('/');
const model = { providerID: modelRef[0], id: modelRef.slice(1).join('/') };

const waitFor = async (pred, timeoutMs, label) => {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await pred();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timeout: ${label}`);
    await new Promise((r) => setTimeout(r, 500));
  }
};

test('REAL OpenCode: HTML project without Git, ≥2 real iterations, checks, steering, pause/resume, report, history', { skip: !enabled && 'set SLEEPPILOT_REAL=1 to run', timeout: 30 * 60_000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-real-home-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-real-proj-'));
  process.env.SLEEPPILOT_HOME = home;
  const { SleepPilotApp } = await import('../../src/app/app.mjs');
  const app = new SleepPilotApp();
  await app.init();
  await waitFor(() => app.adapter.connected || app.adapter.status.state === 'error', 120_000, 'connect');
  assert.equal(app.adapter.status.state, 'connected', app.adapter.status.message);
  const version = app.adapter.serverInfo.version;
  console.log(`# real OpenCode ${version} at ${app.adapter.detection.path}; model ${model.providerID}/${model.id}`);
  const log = [];
  app.on('broadcast', (m) => m.type === 'log' && m.data.kind !== 'text-delta' && m.data.kind !== 'usage-live' && log.push(m.data));
  try {
    let p = await app.createProject({ name: 'real-counter', dir: project });
    p = await app.updateProject(p.id, {
      objective: 'Build a single-file web page index.html (inline CSS and JavaScript, no external libraries) that shows a counter starting at 0 with "+" and "−" buttons. The page title must be "Counter". Keep it small.',
      rules: 'Only create or edit index.html. Do not create any other files. Do not run git.',
      settings: { ...p.settings, durationMin: 25, maxIterations: 5, reviewerEnabled: true, backupBeforeRun: true, permissionProfile: 'balanced', models: { manager: model, developer: model, reviewer: model } },
      checks: [{ id: 'html-smoke', type: 'html-smoke', name: 'HTML load and JS error check', entries: ['index.html'], enabled: true }],
    });
    const view = await app.startRun(p.id);
    const ctrl = app.controllers.get(view.id);

    // The TEST plays the user: any permission request OpenCode raises is answered "reject"
    // (SleepPilot itself never answers). Requests are recorded as evidence of real handling.
    const answered = [];
    const permWatcher = setInterval(async () => {
      for (const pr of [...ctrl.run.pending.permissions]) {
        if (answered.some((a) => a.id === pr.id)) continue;
        answered.push({ id: pr.id, action: pr.action, resources: pr.resources });
        console.log(`# user (test) rejects permission: ${pr.action} ${String(pr.resources?.[0]).slice(0, 100)}`);
        await ctrl.replyPermission(pr.id, 'reject').catch((e) => console.log('# reply failed', e.message));
      }
    }, 2000);

    // Steering while the first developer iteration runs; applied after it completes.
    await waitFor(() => ctrl.run.activeTurn?.role === 'developer' || ctrl.terminal, 10 * 60_000, 'first developer turn');
    await ctrl.steer({ text: 'Also add a "Reset" button that sets the counter back to 0. Treat this as the top priority after the current task.', mode: 'after_iteration' });

    // Graceful pause during the run, then resume.
    await waitFor(() => ctrl.run.iterationCount >= 1 && ctrl.run.activeTurn?.role === 'developer' && ctrl.run.iterationCount >= 2 || ctrl.terminal, 15 * 60_000, 'second developer turn');
    if (!ctrl.terminal) {
      await ctrl.requestPause();
      await waitFor(() => ctrl.run.state === 'paused' || ctrl.terminal, 10 * 60_000, 'paused');
      if (!ctrl.terminal) {
        assert.equal(ctrl.run.pause.code, 'user_paused');
        const iterAtPause = ctrl.run.iterationCount;
        await new Promise((r) => setTimeout(r, 3000));
        assert.equal(ctrl.run.iterationCount, iterAtPause, 'no new iteration while paused');
        await ctrl.resume();
      }
    }
    const run = await waitFor(() => (ctrl.terminal ? ctrl.run : null), 20 * 60_000, 'run end');
    clearInterval(permWatcher);
    console.log(`# permission requests seen and answered by the test-user: ${answered.length}`);
    console.log(`# stop: ${run.stopReason.code} ${run.stopReason.detail || ''}; iterations ${run.iterationCount}`);
    for (const t of run.tasks) console.log(`#   [${t.id}] ${t.status} — ${t.title}`);
    for (const it of run.iterations) console.log(`#   it#${it.n} ${it.sessionID} ${it.messageId} turn=${it.turnStatus} eval=${it.evaluation?.status} checks=${it.checks.map((c) => c.name + ':' + c.status).join(',')}`);
    console.log(`#   usage tokens in=${run.usage.tokens.input} out=${run.usage.tokens.output} cost(reported)=${run.usage.cost}`);

    assert.ok(run.iterationCount >= 2, 'at least two real iterations');
    for (const it of run.iterations.filter((i) => i.status === 'completed')) {
      assert.match(it.sessionID, /^ses/);
      assert.match(it.messageId, /^msg_/);
    }
    const it1 = await app.getIteration(p.id, run.id, 1);
    assert.ok(it1.developerOutput.length > 0, 'real developer output recorded');
    assert.ok(run.usage.tokens.input > 0, 'token usage reported by OpenCode');
    assert.ok(fs.existsSync(path.join(project, 'index.html')), 'index.html created by OpenCode');
    assert.equal(run.steering[0].status, 'applied');
    assert.ok(run.objectiveVersion > run.objectiveVersionAtStart);
    assert.ok(log.some((e) => e.kind === 'tool'), 'real tool events streamed');
    for (const t of run.tasks.filter((x) => x.status === 'verified')) assert.ok(t.evidence.at(-1).checks.some((c) => c.status === 'passed'), 'verified only with passing checks');
    const { markdown } = await app.report(p.id, run.id);
    assert.doesNotMatch(markdown, /TEST MODE/);
    fs.writeFileSync(path.join(home, 'real-report.md'), markdown);
    console.log(`# report: ${path.join(home, 'real-report.md')}`);
  } finally {
    await app.shutdown();
  }
  // Reopen: history is available.
  const app2 = new SleepPilotApp();
  await app2.init();
  try {
    const projects = await app2.store.listProjects();
    const { runs } = await app2.getProject(projects[0].id);
    assert.equal(runs.length, 1);
    assert.ok(['completed', 'stopped'].includes(runs[0].state));
  } finally {
    await app2.shutdown();
  }
});

test('REAL OpenCode, sleep mode: full authority, nobody answers anything, time limit awaits the last answer, closing report', { skip: !enabled && 'set SLEEPPILOT_REAL=1 to run', timeout: 30 * 60_000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-real-sleep-home-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-real-sleep-proj-'));
  process.env.SLEEPPILOT_HOME = home;
  const { SleepPilotApp } = await import(`../../src/app/app.mjs?sleep=${Date.now()}`);
  const app = new SleepPilotApp();
  await app.init();
  await waitFor(() => app.adapter.connected || app.adapter.status.state === 'error', 120_000, 'connect');
  assert.equal(app.adapter.status.state, 'connected', app.adapter.status.message);
  console.log(`# real OpenCode ${app.adapter.serverInfo.version}; model ${model.providerID}/${model.id}`);
  try {
    let p = await app.createProject({ name: 'real-sleep', dir: project });
    p = await app.updateProject(p.id, {
      objective: 'Create a small Python module stats_util.py with functions mean(xs), median(xs) and mode(xs) (no external libraries), and a test file test_stats_util.py using plain asserts that can be run with "python test_stats_util.py". Then add a function variance(xs).',
      rules: 'Only create or edit stats_util.py and test_stats_util.py. Run the tests yourself if useful.',
      settings: { ...p.settings, preset: 'sleep', permissionProfile: 'full', unattended: true, permissionTimeoutMin: 2, durationMin: 4, maxIterations: null, improvementMode: false, reviewerEnabled: true, closingReport: true, finalGraceMin: 10, backupBeforeRun: true, models: { manager: model, developer: model, reviewer: model } },
      checks: [
        { id: 'py-syntax', type: 'py-syntax', name: 'Python syntax', enabled: true },
        { id: 'pytests', type: 'command', name: 'python test_stats_util.py', command: 'python test_stats_util.py', enabled: true, approved: true, timeoutSec: 120 },
      ],
    });
    const view = await app.startRun(p.id);
    const ctrl = app.controllers.get(view.id);
    let maxPending = 0;
    const watch = setInterval(() => (maxPending = Math.max(maxPending, ctrl.run.pending.permissions.length + ctrl.run.pending.forms.length)), 500);
    const run = await waitFor(() => (ctrl.terminal ? ctrl.run : null), 25 * 60_000, 'run end');
    clearInterval(watch);
    console.log(`# stop: ${run.stopReason.code}; iterations ${run.iterationCount}; preflight ${JSON.stringify(run.preflight?.results)}`);
    for (const t of run.tasks) console.log(`#   [${t.id}] ${t.status} — ${t.title}`);
    for (const it of run.iterations) console.log(`#   it#${it.n} turn=${it.turnStatus} status=${it.status} eval=${it.evaluation?.status} lines=+${it.lines?.additions}/-${it.lines?.deletions} checks=${it.checks.map((c) => c.name + ':' + c.status).join(',')}`);
    console.log(`#   net: ${JSON.stringify({ added: run.lineStats?.net?.added, modified: run.lineStats?.net?.modified, add: run.lineStats?.net?.additions, del: run.lineStats?.net?.deletions })}`);
    console.log(`#   pending seen: ${maxPending}; auto-answered: ${run.autoAnswered.length}; tokens in=${run.usage.tokens.input} out=${run.usage.tokens.output}`);
    console.log(`#   closing report (${run.closingReport?.sessionID}): ${String(run.closingReport?.text || '').slice(0, 600).replace(/\n/g, ' / ')}`);
    assert.equal(maxPending, 0, 'nothing waited for a person in sleep mode');
    assert.ok(['time_limit', 'objective_completed'].includes(run.stopReason.code), run.stopReason.code);
    assert.ok(run.iterations.every((i) => i.status !== 'interrupted'), 'no answer was cut off');
    assert.ok(run.preflight?.results, 'models checked before the run');
    assert.ok(run.lineStats?.net?.additions > 0, 'line totals measured');
    assert.ok(run.closingReport?.text?.length > 200, 'closing report written by OpenCode');
    const { markdown } = await app.report(p.id, run.id);
    assert.match(markdown, /OpenCode closing report/);
    fs.writeFileSync(path.join(home, 'real-sleep-report.md'), markdown);
    console.log(`# report: ${path.join(home, 'real-sleep-report.md')}`);
  } finally {
    await app.shutdown();
  }
});
