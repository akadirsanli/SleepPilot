// Unattended ("sleep mode") behaviour against the FAKE OpenCode server (explicit test double).
// Origin: a real overnight run froze for 7 hours on one unanswered permission request.
process.env.SLEEPPILOT_WATCHDOG_MS = '200';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { setupEnv, makeApp, newProject, finished, waitFor, plan, task } from './helpers.mjs';

test('sleep mode with full authority: no permission prompt, no question, closing report and line totals saved', { timeout: 120_000 }, async () => {
  const { project } = setupEnv('sleep', plan(task('Command and question', ['permission npm install left-pad', 'form Which colour?', 'write done.txt one\\ntwo\\nthree\\n'])));
  const app = await makeApp();
  try {
    const p = await newProject(app, project, { settings: { reviewerEnabled: false, permissionProfile: 'full', unattended: true, closingReport: true } });
    const view = await app.startRun(p.id);
    const ctrl = app.controllers.get(view.id);
    let sawPending = false;
    const watch = setInterval(() => (sawPending ||= ctrl.run.pending.permissions.length + ctrl.run.pending.forms.length > 0), 50);
    const run = await finished(app, view.id);
    clearInterval(watch);
    assert.equal(sawPending, false, 'nothing waited for a person');
    assert.equal(run.stopReason.code, 'objective_completed');
    assert.ok(fs.existsSync(path.join(project, 'done.txt')));
    assert.ok(!fs.existsSync(path.join(project, 'form-answer.txt')), 'the question tool is denied in sleep mode');
    assert.ok(run.preflight?.results, 'models were checked before the run');
    assert.equal(run.lineStats.net.additions, 3);
    assert.deepEqual(run.lineStats.net.added, ['done.txt']);
    assert.match(run.closingReport.text, /FAKE closing report/);
    assert.match(run.closingReport.text, /\+3 \/ -0 lines/);
    const { markdown } = await app.report(p.id, run.id);
    assert.match(markdown, /OpenCode closing report/);
    assert.match(markdown, /\+3 \/ −0 lines/);
    assert.match(markdown, /Sleep mode/);
  } finally {
    await app.shutdown();
  }
});

test('unanswered permission is declined automatically after the timeout; the developer is told and the run moves on', { timeout: 120_000 }, async () => {
  const { project } = setupEnv('timeout', plan(task('Paket kur', ['permission npm install left-pad', 'write pkg.txt ok']), task('Next', ['write next.txt ok'], { priority: 3 })));
  const app = await makeApp();
  try {
    const p = await newProject(app, project, { settings: { reviewerEnabled: false, permissionProfile: 'balanced', permissionTimeoutMin: 0.01 } });
    const view = await app.startRun(p.id);
    const ctrl = app.controllers.get(view.id);
    await waitFor(() => ctrl.run.pending.permissions[0], { label: 'permission pending' });
    const run = await finished(app, view.id);
    assert.equal(run.autoAnswered.length, 1);
    assert.equal(run.autoAnswered[0].action, 'shell');
    assert.ok(ctrl.logBuffer.some((e) => /REJECTED automatically/.test(e.text)));
    const it1 = await app.getIteration(p.id, run.id, 1);
    assert.equal(it1.turn.followUpMessageIds.length, 1, 'the developer was told in the same session');
    assert.ok(fs.existsSync(path.join(project, 'next.txt')), 'the run continued with the next task');
    const { markdown } = await app.report(p.id, run.id);
    assert.match(markdown, /automatically rejected: permission shell npm install left-pad/);
  } finally {
    await app.shutdown();
  }
});

test('unanswered question is dismissed after the timeout (supervised profile) and the developer continues', { timeout: 120_000 }, async () => {
  const { project } = setupEnv('formtimeout', plan(task('Ask a question', ['form Which colour?', 'write color.txt blue'])));
  const app = await makeApp();
  try {
    const p = await newProject(app, project, { settings: { reviewerEnabled: false, permissionTimeoutMin: 0.01 } });
    const view = await app.startRun(p.id);
    const ctrl = app.controllers.get(view.id);
    await waitFor(() => ctrl.run.pending.forms[0], { label: 'form pending' });
    const run = await finished(app, view.id);
    assert.equal(run.autoAnswered[0].type, 'question');
    const it1 = await app.getIteration(p.id, run.id, 1);
    assert.equal(it1.turn.followUpMessageIds.length, 1);
    assert.ok(ctrl.logBuffer.some((e) => /Unanswered question closed/.test(e.text)));
  } finally {
    await app.shutdown();
  }
});

test('time limit during a turn: the last answer is awaited (not cut off), then no new task, then the closing report', { timeout: 120_000 }, async () => {
  const { project } = setupEnv('timeup', plan(task('Slow task', ['slow 2500', 'write slow.txt done']), task('Must never start', ['write never.txt x'], { priority: 3 })));
  const app = await makeApp();
  try {
    const p = await newProject(app, project, { settings: { reviewerEnabled: true } });
    const view = await app.startRun(p.id);
    const ctrl = app.controllers.get(view.id);
    await waitFor(() => ctrl.activeTurnSession?.role === 'developer', { label: 'developer turn' });
    ctrl.run.limits.durationMin = 0.0001; // time is up while the developer is still working
    const run = await finished(app, view.id);
    assert.equal(run.stopReason.code, 'time_limit');
    assert.equal(run.iterations[0].status, 'completed', 'the turn finished normally');
    assert.equal(run.iterations[0].turnStatus, 'succeeded');
    assert.equal(fs.readFileSync(path.join(project, 'slow.txt'), 'utf8'), 'done');
    assert.ok(!fs.existsSync(path.join(project, 'never.txt')), 'no new task after the time limit');
    assert.equal(run.iterations[0].review, null, 'review skipped after the time limit');
    assert.ok(ctrl.logBuffer.some((e) => /waiting for the developer's last answer/.test(e.text)));
    assert.match(run.closingReport.text, /FAKE closing report/);
  } finally {
    await app.shutdown();
  }
});

test('next run of the same objective carries over open tasks instead of planning a different backlog', { timeout: 120_000 }, async () => {
  const { project } = setupEnv('carry', plan(task('First', ['write one.txt 1']), task('Second', ['write two.txt 2'], { priority: 3 })));
  const app = await makeApp();
  try {
    const p = await newProject(app, project, { settings: { reviewerEnabled: false, maxIterations: 1, closingReport: false } });
    const r1 = await finished(app, (await app.startRun(p.id)).id);
    assert.equal(r1.stopReason.code, 'iteration_limit');
    assert.equal(r1.tasks.find((t) => t.title === 'Second').status, 'pending');
    await app.updateProject(p.id, { settings: { maxIterations: 5 } });
    const v2 = await app.startRun(p.id);
    const r2 = await finished(app, v2.id);
    assert.equal(r2.carriedOver.fromRunId, r1.id);
    assert.equal(r2.carriedOver.samePlan, true);
    assert.equal(r2.tasks.length, 2, 'no new plan was added');
    assert.equal(r2.iterations[0].taskTitle, 'Second');
    assert.equal(r2.tasks.find((t) => t.title === 'First').status, r1.tasks.find((t) => t.title === 'First').status);
    assert.ok(fs.existsSync(path.join(project, 'two.txt')));
    assert.equal(r2.usage.byRole.manager.turns, 1, 'only the decision after the iteration, no planning turn');
  } finally {
    await app.shutdown();
  }
});

test('settings changed during a run apply to it: a higher iteration limit lets the run continue; protected files are denied', { timeout: 120_000 }, async () => {
  const { project } = setupEnv('live', plan(task('Slow', ['slow 1500', 'write a.txt 1', 'write source/original.txt changed']), task('Second', ['write b.txt 2'], { priority: 3 })));
  const app = await makeApp();
  try {
    fs.mkdirSync(path.join(project, 'source'));
    fs.writeFileSync(path.join(project, 'source', 'orijinal.txt'), 'orijinal');
    const p = await newProject(app, project, { settings: { reviewerEnabled: false, maxIterations: 1, permissionProfile: 'full', unattended: true, closingReport: false, protectedPaths: ['source'] } });
    const view = await app.startRun(p.id);
    const ctrl = app.controllers.get(view.id);
    await waitFor(() => ctrl.activeTurnSession?.role === 'developer', { label: 'developer turn' });
    const r = await app.updateRunSettings(view.id, { maxIterations: 3 });
    assert.ok(r.changed.some((c) => /Max iterations: 1 → 3/.test(c)), JSON.stringify(r));
    const run = await finished(app, view.id);
    assert.equal(run.iterationCount, 2, 'the second task ran because the limit was raised');
    assert.equal(run.stopReason.code, 'objective_completed');
    assert.equal(fs.readFileSync(path.join(project, 'source', 'orijinal.txt'), 'utf8'), 'orijinal', 'protected file untouched');
    assert.ok(fs.existsSync(path.join(project, 'a.txt')));
    assert.equal(run.settingChanges.length, 1);
    assert.ok(ctrl.logBuffer.some((e) => /Settings changed during the run/.test(e.text)));
  } finally {
    await app.shutdown();
  }
});


test('sleep mode: a cut-off provider stream is retried; an unexpected error pauses and resumes by itself instead of ending the run', { timeout: 120_000 }, async () => {
  const { project } = setupEnv('resilient', plan(task('Cut-off stream', ['provider-error provider.invalid-output 1', 'write a.txt 1']), task('Next', ['write b.txt 2'], { priority: 3 })));
  const app = await makeApp();
  try {
    const p = await newProject(app, project, { settings: { reviewerEnabled: false, permissionProfile: 'full', unattended: true, closingReport: false } });
    const view = await app.startRun(p.id);
    const ctrl = app.controllers.get(view.id);
    // Simulate a SleepPilot-side crash once (like today's InvalidCursorError before the fix).
    const original = ctrl.pickTask.bind(ctrl);
    let thrown = false;
    ctrl.pickTask = () => {
      if (!thrown && ctrl.run.iterationCount === 1) {
        thrown = true;
        throw new Error('simulated unexpected failure');
      }
      return original();
    };
    const run = await finished(app, view.id);
    assert.equal(run.stopReason.code, 'objective_completed', JSON.stringify(run.stopReason));
    assert.equal(thrown, true);
    assert.equal(run.autoResumes, 1, 'resumed once by itself');
    assert.ok(fs.existsSync(path.join(project, 'a.txt')) && fs.existsSync(path.join(project, 'b.txt')));
    assert.ok(ctrl.logBuffer.some((e) => /Provider response cut off/.test(e.text)), 'cut-off stream recognised and retried');
    assert.ok(!run.iterations.some((i) => i.status === 'provider_error' && /Beklenmeyen/.test(i.error || '')));
  } finally {
    await app.shutdown();
  }
});

test('a Manager/Reviewer model that keeps failing is replaced by the Developer model for the rest of the run', async () => {
  const { RunController, newRunRecord } = await import('../../src/orchestrator/run-controller.mjs');
  const project = { id: 'p', name: 'p', dir: '.', objective: { version: 1, text: 'x' }, settings: { models: { developer: { providerID: 'opencode-go', id: 'deepseek-v4.1-flash' }, reviewer: { providerID: 'opencode-go', id: 'glm-5.3-flash' }, manager: null } } };
  const run = newRunRecord({ id: 'r', project });
  const ctrl = new RunController({ store: { appendEvent: async () => {}, saveRun: async () => {} }, adapter: {}, project, run });
  run.sessions.reviewer = 'ses_old';
  ctrl.noteRoleFailure('reviewer');
  assert.equal(run.limits.models.reviewer.id, 'glm-5.3-flash', 'one failure is tolerated');
  ctrl.noteRoleFailure('reviewer');
  assert.equal(run.limits.models.reviewer.id, 'deepseek-v4.1-flash');
  assert.equal(run.sessions.reviewer, null, 'a new session will use the new model');
  ctrl.noteRoleFailure('developer');
  assert.equal(run.limits.models.developer.id, 'deepseek-v4.1-flash');
});

test('time is not the only goal: overtime is granted while given tasks are open, and the run ends early once they are done', { timeout: 120_000 }, async () => {
  const { project } = setupEnv('overtime', plan(task('Long task', ['slow 1500', 'write a.txt 1']), task('Second', ['write b.txt 2'], { priority: 3 })));
  const app = await makeApp();
  try {
    const p = await newProject(app, project, { settings: { reviewerEnabled: false, closingReport: false, improvementMode: false, overtimeMin: 1, overtimeMaxRounds: 1 } });
    const view = await app.startRun(p.id);
    const ctrl = app.controllers.get(view.id);
    await waitFor(() => ctrl.activeTurnSession?.role === 'developer', { label: 'developer turn' });
    ctrl.run.limits.durationMin = 0.0001; // time runs out during the first task
    const run = await finished(app, view.id);
    assert.equal(run.overtimeUsed, 1, 'one overtime round granted');
    assert.equal(run.stopReason.code, 'objective_completed', 'both tasks finished inside the overtime');
    assert.ok(fs.existsSync(path.join(project, 'b.txt')));
    assert.ok(ctrl.logBuffer.some((e) => /overtime granted/.test(e.text)));
    const { markdown } = await app.report(p.id, run.id);
    assert.match(markdown, /Overtime:\*\* 1 min granted 1 time/);
    assert.match(markdown, /Finished early/);
  } finally {
    await app.shutdown();
  }
});

test('token saving: the reviewer is skipped when checks failed or nothing changed', { timeout: 120_000 }, async () => {
  const { project } = setupEnv('noreview', plan(task('Broken', ['write bad.js function (']), task('No change', ['status done nothing was needed'], { priority: 3 })));
  const app = await makeApp();
  try {
    const p = await newProject(app, project, { settings: { reviewerEnabled: true, closingReport: false, maxAttemptsSameFailure: 1 }, checks: [{ id: 'js-syntax', type: 'js-syntax', name: 'JS', enabled: true }] });
    const run = await finished(app, (await app.startRun(p.id)).id);
    assert.equal(run.usage.byRole.reviewer.turns, 0, 'no reviewer turn was spent');
    assert.ok(run.iterations.length >= 2);
  } finally {
    await app.shutdown();
  }
});

test('chat view data: every OpenCode turn is recorded with role, prompt head, reasoning, tool calls and text; live entries carry the turn id', { timeout: 120_000 }, async () => {
  const { project } = setupEnv('turns', plan(task('Write a page', ['write index.html <h1>x</h1>'])));
  const app = await makeApp();
  try {
    const p = await newProject(app, project, { settings: { reviewerEnabled: true, closingReport: false } });
    const live = [];
    app.on('broadcast', (m) => (m.type === 'turn' || (m.type === 'log' && m.data.turn)) && live.push(m));
    const run = await finished(app, (await app.startRun(p.id)).id);
    const turns = await app.getTurns(p.id, run.id);
    const roles = turns.map((t) => t.role);
    assert.ok(roles.includes('manager') && roles.includes('developer') && roles.includes('reviewer'), roles.join(','));
    const dev = turns.find((t) => t.role === 'developer');
    assert.equal(dev.iteration, 1);
    assert.match(dev.prompt, /DEVELOPER/);
    const kinds = dev.transcript.map((x) => x.type);
    assert.ok(kinds.includes('reasoning') && kinds.includes('tool') && kinds.includes('text'), kinds.join(','));
    assert.equal(dev.transcript.find((x) => x.type === 'tool').name, 'write');
    assert.ok(dev.usage.tokens.input > 0);
    const it1Roles = (await app.getTurns(p.id, run.id, { iteration: 1 })).map((t) => t.role);
    assert.ok(it1Roles.includes('developer') && it1Roles.includes('reviewer') && !it1Roles.includes('preflight'), it1Roles.join(','));
    assert.ok(live.some((m) => m.type === 'turn'));
    assert.ok(live.some((m) => m.type === 'log' && m.data.kind === 'reasoning-delta'), 'reasoning streamed live');
    assert.ok(live.some((m) => m.type === 'log' && m.data.kind === 'tool' && m.data.turn === dev.id));
  } finally {
    await app.shutdown();
  }
});

test('report statistics: measured lines per iteration and file, generated files kept apart, time per role', { timeout: 120_000 }, async () => {
  const { project } = setupEnv('stats', plan(task('Kod', ['write src/a.js // a\\n// b\\n', 'write dist/bundle.js x\\ny\\nz\\n']), task('Kod 2', ['write src/b.py x = 1\\n'], { priority: 3 })));
  const app = await makeApp();
  try {
    const p = await newProject(app, project, { settings: { reviewerEnabled: true, closingReport: false } });
    const run = await finished(app, (await app.startRun(p.id)).id);
    const st = await app.stats(p.id, run.id);
    assert.equal(st.run.iterations.length, 2);
    assert.equal(st.run.iterations[0].added, 2, 'dist/ is build output, not counted');
    assert.equal(st.run.iterations[0].generatedAdded, 3);
    assert.equal(st.run.iterations[1].cumulative, 3);
    assert.deepEqual(st.run.files.map((f) => f.file).sort(), ['src/a.js', 'src/b.py']);
    assert.ok(st.run.roles.developer.turns >= 2 && st.run.roles.developer.ms > 0);
    assert.equal(st.project.added, 3, 'test-mode runs count only inside test mode');
    assert.equal(st.project.generatedFiles, 1);
    const ext = Object.fromEntries(st.extensions.map((e) => [e.ext, e.added]));
    assert.deepEqual(ext, { '.js': 2, '.py': 1 });
    const { markdown } = await app.report(p.id, run.id);
    assert.match(markdown, /## Statistics/);
    assert.match(markdown, /This run — source code:\*\* \+3 \/ −0 lines \(generated files another \+3/);
    assert.match(markdown, /Time by role:\*\* .*Developer/);
  } finally {
    await app.shutdown();
  }
});

test('OpenCode still initialising at start (HTTP 503 "Location plugins did not finish activating", seen on 2.2.0): SleepPilot waits and connects', { timeout: 60_000 }, async () => {
  setupEnv('startup503');
  process.env.SLEEPPILOT_FAKE_STARTUP_503 = '3';
  process.env.SLEEPPILOT_STARTUP_RETRY_MS = '100';
  try {
    const app = await makeApp();
    try {
      assert.equal(app.adapter.status.state, 'connected');
      assert.ok(app.adapter.models.length > 0);
    } finally {
      await app.shutdown();
    }
  } finally {
    delete process.env.SLEEPPILOT_FAKE_STARTUP_503;
    delete process.env.SLEEPPILOT_STARTUP_RETRY_MS;
  }
});

test('per-turn time cap: a developer turn that runs too long is stopped, the task retried with smaller steps, then blocked if it keeps happening', { timeout: 120_000 }, async () => {
  const { project } = setupEnv('turncap', plan(task('Endless loop', ['slow 4000', 'write never.txt x']), task('Normal', ['write ok.txt 1'], { priority: 3 })));
  const app = await makeApp();
  try {
    const p = await newProject(app, project, { settings: { reviewerEnabled: false, closingReport: false, maxTurnMin: 0.02, maxAttemptsSameFailure: 2 } });
    const view = await app.startRun(p.id);
    const ctrl = app.controllers.get(view.id);
    const run = await finished(app, view.id);
    const t1 = run.tasks.find((t) => t.title === 'Endless loop');
    assert.equal(t1.status, 'blocked', JSON.stringify(t1.history.at(-1)));
    assert.equal(t1.timeouts, 2);
    assert.ok(ctrl.logBuffer.some((e) => /per-turn time limit/.test(e.text)));
    assert.ok(fs.existsSync(path.join(project, 'ok.txt')), 'the run moved on to the other task');
    assert.ok(!fs.existsSync(path.join(project, 'never.txt')));
  } finally {
    await app.shutdown();
  }
});

test('plan review: the run waits after planning; the user cancels, reprioritises and adds tasks, then approves', { timeout: 120_000 }, async () => {
  const { project } = setupEnv('planreview', plan(task('Unneeded', ['write a.txt 1']), task('Important', ['write b.txt 2'], { priority: 3 })));
  const app = await makeApp();
  try {
    const p = await newProject(app, project, { settings: { reviewerEnabled: false, closingReport: false, planReview: true } });
    const view = await app.startRun(p.id);
    const ctrl = app.controllers.get(view.id);
    await waitFor(() => ctrl.run.pause?.code === 'plan_review', { label: 'plan review pause' });
    assert.equal(ctrl.run.state, 'waiting_user');
    assert.equal(ctrl.run.iterationCount, 0, 'nothing ran before approval');
    const [t1, t2] = ctrl.run.tasks;
    await app.editTask(view.id, t1.id, { action: 'cancel' });
    await app.editTask(view.id, t2.id, { action: 'first' });
    const added = await app.editTask(view.id, 'new', { title: 'User task', description: 'ACTION: write c.txt 3', priority: 4 });
    await ctrl.steer({ text: 'an instruction' }); // an instruction must not approve the plan by itself
    assert.equal(ctrl.run.pause?.code, 'plan_review');
    await ctrl.resume();
    const run = await finished(app, view.id);
    assert.equal(run.planApproved, true);
    assert.equal(run.tasks.find((t) => t.id === t1.id).status, 'cancelled');
    assert.ok(!fs.existsSync(path.join(project, 'a.txt')), 'cancelled task never ran');
    assert.ok(fs.existsSync(path.join(project, 'b.txt')));
    assert.equal(run.tasks.find((t) => t.id === added.id).createdBy, 'user');
    assert.ok(ctrl.logBuffer.some((e) => /Plan approved/.test(e.text)));
  } finally {
    await app.shutdown();
  }
});

test('Sleep & Reverse & Rust It: target is protected (read-only), output goes to a separate workspace, objective/rules cite evidence', { timeout: 120_000 }, async () => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-rev-target-'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-rev-work-'));
  fs.writeFileSync(path.join(target, 'game.cfg'), 'price=100\n');
  process.env.SLEEPPILOT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-rev-home-'));
  const app = await makeApp();
  try {
    await assert.rejects(() => app.createReverseProject({ targetDir: target, workDir: work, goals: 'understand', ack: false }), /right to analyse/i);
    await assert.rejects(() => app.createReverseProject({ targetDir: target, workDir: target, goals: 'x', ack: true }), /cannot be the target or inside it/);
    const created = await app.createReverseProject({ targetDir: target, workDir: work, goals: 'Extract the economy constants', language: 'tr', ack: true });
    const p = created.project || created;
    assert.equal(p.dir, work, 'workspace is the project dir');
    const fwd = (x) => x.replace(/\\/g, '/').toLowerCase();
    assert.ok(p.settings.protectedPaths.some((x) => fwd(x) === fwd(target)), JSON.stringify(p.settings.protectedPaths));
    assert.match(p.objective.text, /read-only/i);
    assert.match(p.objective.text, /_target\//, 'the agent is pointed at the mirror');
    assert.ok(fs.existsSync(path.join(work, '_target', 'game.cfg')), 'target mirrored into the workspace');
    assert.ok(fs.existsSync(path.join(work, '_target', 'TARGET_MAP.md')));
    assert.ok(p.settings.protectedPaths.includes('_target'), 'the mirror is protected from edits');
    assert.ok(p.checks.some((c) => c.type === 'cite-check' && c.enabled), 'evidence citations are checked');
    assert.equal(p.reverse.targetDir, target);
    assert.match(p.objective.text, /Extract the economy constants/);
    assert.match(p.rules, /READ-ONLY|read-only/i);
    assert.match(p.rules, /right|responsible|authori/i);
    assert.ok(p.checks.length >= 1);
    // The run would add the target to the developer ruleset as deny; verify the ruleset builder.
    const { developerRuleset } = await import('../../src/orchestrator/permissions.mjs');
    const rules = developerRuleset('full', { protectedPaths: [target], projectDir: work });
    assert.ok(rules.some((r) => r.effect === 'deny' && fwd(String(r.resource)).includes(fwd(target))));
  } finally {
    await app.shutdown();
    fs.rmSync(target, { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true });
  }
});
