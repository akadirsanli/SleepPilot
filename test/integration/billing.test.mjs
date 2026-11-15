// A pay-as-you-go model on an OpenCode Go account, against the FAKE OpenCode server (explicit test double).
// Reproduces a real failure on OpenCode 2.3.0: "opencode/deepseek-v4.1-flash" (Zen credits) was picked
// instead of "opencode-go/deepseek-v4.1-flash". SleepPilot called it a quota window, put the whole
// OpenCode harness into a 30-minute cooldown, and the next runs - with the right model - paused at once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupEnv, makeApp, newProject, finished, waitFor, plan, task } from './helpers.mjs';

test('no-credit model: clear pause naming opencode-go, no harness cooldown, the next run with the Go model completes', { timeout: 120_000 }, async () => {
  const { project } = setupEnv('billing', plan(task('Page', ['write index.html <html><title>ok</title></html>'])));
  process.env.SLEEPPILOT_FAKE_NO_CREDITS_PROVIDER = 'opencode';
  const app = await makeApp();
  try {
    const zen = { providerID: 'opencode', id: 'deepseek-v4.1-flash' };
    const go = { providerID: 'opencode-go', id: 'deepseek-v4.1-flash' };
    const labels = Object.fromEntries(app.adapter.models.filter((m) => m.id === 'deepseek-v4.1-flash').map((m) => [m.providerID, m.providerLabel]));
    assert.match(labels['opencode-go'], /OpenCode Go/, 'the model picker names the Go provider');
    assert.match(labels.opencode, /pay-as-you-go/, 'the model picker marks the Zen copy as pay-as-you-go');

    let p = await newProject(app, project, { settings: { unattended: true, permissionProfile: 'full', reviewerEnabled: false, closingReport: false, models: { manager: zen, developer: zen, reviewer: zen } } });
    const first = await app.startRun(p.id);
    const ctrl = app.controllers.get(first.id);
    await waitFor(() => ctrl.run.state === 'paused', { label: 'pause after the model check', timeoutMs: 60_000 });
    assert.equal(ctrl.run.pause.code, 'provider_config', 'a missing credit balance is a model choice, not a usage window');
    assert.match(ctrl.run.pause.message, /opencode-go/, 'the pause tells the user which model to pick');
    assert.equal(app.quotaTracker.canUse('opencode').ok, true, 'OpenCode itself is not put into a cooldown');
    await ctrl.requestStop({ immediate: true });
    await finished(app, first.id);

    p = await app.updateProject(p.id, { settings: { ...p.settings, models: { manager: go, developer: go, reviewer: go } } });
    const run = await finished(app, (await app.startRun(p.id)).id);
    assert.equal(run.stopReason.code, 'objective_completed', JSON.stringify(run.stopReason));
    assert.ok(fs.existsSync(path.join(project, 'index.html')));
  } finally {
    await app.shutdown();
    delete process.env.SLEEPPILOT_FAKE_NO_CREDITS_PROVIDER;
  }
});
