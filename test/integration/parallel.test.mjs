// Parallel developers ("multi-agent") against the FAKE OpenCode server (explicit test double).
process.env.SLEEPPILOT_WATCHDOG_MS = '200';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setupEnv, makeApp, newProject, finished, plan, task } from './helpers.mjs';

test('parallel developers: file-disjoint tasks run at the same time, each may edit only its own files, command checks run once per wave', { timeout: 120_000 }, async () => {
  const { project } = setupEnv(
    'parallel',
    plan(
      task('UI chart', ['slow 1500', 'write ui/chart.js // chart', 'write engine/unauthorized.py x = 1'], { files: ['ui/chart.js'] }),
      task('Kervan motoru', ['slow 1500', 'write engine/caravan.py x = 2'], { files: ['engine/caravan.py'] }),
      task('Shared README', ['write README.md all'], { priority: 3, files: ['README.md'], depends_on: [1, 2] }),
      task('Task without scope', ['write misc.txt single'], { priority: 4 }),
    ),
  );
  const counter = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sp-count-')), 'count.txt');
  process.env.SP_COUNT = counter;
  // The two wave reviews each take a few seconds in the fake server, so "reviewed at the same time"
  // is a clear overlap that does not depend on how fast the CI runner finishes each task's checks.
  process.env.SLEEPPILOT_FAKE_REVIEW_MS = '4000';
  process.env.SLEEPPILOT_FAKE_REVIEW_MATCH = 'UI chart|Kervan motoru';
  const app = await makeApp();
  try {
    const p = await newProject(app, project, {
      settings: { reviewerEnabled: true, permissionProfile: 'full', unattended: true, closingReport: false, parallelDevelopers: 3 },
      checks: [{ id: 'count', type: 'command', name: 'counter', command: `node -e "require('fs').appendFileSync(process.env.SP_COUNT,'x')"`, enabled: true, approved: true }],
    });
    const t0 = Date.now();
    const run = await finished(app, (await app.startRun(p.id)).id);
    const elapsed = Date.now() - t0;
    assert.equal(run.stopReason.code, 'objective_completed', JSON.stringify(run.stopReason));
    const it = Object.fromEntries(run.iterations.map((i) => [i.taskTitle, i]));
    const full = async (n) => app.getIteration(p.id, run.id, n);
    const a = await full(it['UI chart'].n);
    const b = await full(it['Kervan motoru'].n);
    assert.equal(a.wave, 1);
    assert.equal(b.wave, 1, 'the two disjoint tasks ran in the same wave');
    assert.ok(Math.abs(a.startedAt - b.startedAt) < 1000, 'started together');
    assert.deepEqual(a.changes.added, ['ui/chart.js'], 'changes are split by file scope');
    assert.deepEqual(b.changes.added, ['engine/caravan.py']);
    assert.ok(!fs.existsSync(path.join(project, 'engine', 'unauthorized.py')), 'a write outside the task scope was denied');
    assert.ok(a.turn.tools.some((t) => /Permission denied: edit/.test(t.error?.message || '')));
    const readme = await full(it['Shared README'].n);
    assert.ok(readme.n > Math.max(a.n, b.n), 'a dependent task waits for the wave');
    assert.ok(!(await full(it['Task without scope'].n)).wave, 'a task without a file scope runs alone');
    assert.equal(fs.readFileSync(counter, 'utf8').length, run.iterations.length - 1, 'the command check ran once for the 2-task wave');
    assert.equal(run.waveCount, 1);
    // The wave's two tasks were reviewed at the same time, each in its own read-only session.
    const reviews = (await app.getTurns(p.id, run.id)).filter((t) => t.role === 'reviewer' && [a.n, b.n].includes(t.iteration));
    assert.equal(reviews.length, 2, 'both wave tasks reviewed');
    assert.notEqual(reviews[0].sessionID, reviews[1].sessionID);
    const [r1, r2] = reviews;
    assert.ok(Math.max(r1.startedAt, r2.startedAt) < Math.min(r1.endedAt, r2.endedAt), `reviews overlapped in time: ${JSON.stringify(reviews.map((r) => [r.startedAt, r.endedAt]))}`);
    assert.ok(elapsed < 20_000, `took ${elapsed} ms`);
  } finally {
    await app.shutdown();
    delete process.env.SP_COUNT;
    delete process.env.SLEEPPILOT_FAKE_REVIEW_MS;
    delete process.env.SLEEPPILOT_FAKE_REVIEW_MATCH;
  }
});
