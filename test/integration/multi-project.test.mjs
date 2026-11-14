// Concurrent runs: different projects can run at the same time; the same project cannot duplicate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupEnv, makeApp, newProject, finished } from './helpers.mjs';

test('two projects run concurrently and one project cannot start twice', { timeout: 120_000 }, async () => {
  const { project: a } = setupEnv('multi-a');
  const { project: b } = setupEnv('multi-b');
  const app = await makeApp();
  try {
    const pa = await newProject(app, a, { settings: { reviewerEnabled: false, backupBeforeRun: false } });
    const pb = await newProject(app, b, { settings: { reviewerEnabled: false, backupBeforeRun: false } });
    const ra = await app.startRun(pa.id);
    const rb = await app.startRun(pb.id);
    assert.equal(app.activeControllers().length, 2, 'both runs are active');
    await assert.rejects(() => app.startRun(pa.id), /already has an active run/i);
    const [fa, fb] = await Promise.all([finished(app, ra.id), finished(app, rb.id)]);
    assert.equal(fa.state, 'completed');
    assert.equal(fb.state, 'completed');
    assert.ok(fs.existsSync(path.join(a, 'index.html')));
    assert.ok(fs.existsSync(path.join(b, 'index.html')));
    const state = await app.state();
    assert.deepEqual(state.activeRuns, []);
  } finally {
    await app.shutdown();
  }
});
