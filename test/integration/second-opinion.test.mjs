// Second opinion: a stuck task is diagnosed by another engine (here: a fresh session of the fake one).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv, makeApp, newProject, finished, plan, task } from './helpers.mjs';

const BROKEN = () => plan(task('Write a broken script', ['write broken.js function (']));
const CHECKS = [{ id: 'js-syntax', type: 'js-syntax', name: 'JS syntax', enabled: true }];

async function runWith(name, mode, settings = {}) {
  const { project } = setupEnv(name, BROKEN());
  if (mode) process.env.SLEEPPILOT_FAKE_SECOND_OPINION = mode;
  else delete process.env.SLEEPPILOT_FAKE_SECOND_OPINION;
  const app = await makeApp();
  try {
    const p = await newProject(app, project, { settings: { maxAttemptsSameFailure: 3, reviewerEnabled: false, maxIterations: 12, ...settings }, checks: CHECKS });
    const view = await app.startRun(p.id);
    const run = await finished(app, view.id, 120_000);
    const iterations = [];
    for (const it of run.iterations) iterations.push(await app.getIteration(p.id, run.id, it.n));
    return { run, iterations, events: app.controllers.get(run.id)?.logBuffer || [] };
  } finally {
    delete process.env.SLEEPPILOT_FAKE_SECOND_OPINION;
    await app.shutdown();
  }
}

test('second opinion: the same failure twice → diagnosis → advice in the next developer prompt; one rescue round', { timeout: 180_000 }, async () => {
  const { run, iterations, events } = await runWith('so-retry', 'retry');
  const t = run.tasks.find((x) => x.title === 'Write a broken script');
  assert.ok(t.secondOpinions?.length >= 1, 'a second opinion was asked');
  assert.ok(t.secondOpinions.length <= 2, 'at most two per task');
  assert.equal(t.secondOpinions[0].reason, 'same_failure');
  assert.match(t.secondOpinions[0].diagnosis, /fake second opinion/);
  const consulted = iterations.findIndex((it) => it.secondOpinion);
  assert.ok(consulted >= 0 && iterations[consulted + 1], 'another attempt followed the second opinion');
  assert.match(iterations[consulted + 1].prompt, /SECOND OPINION/);
  assert.match(iterations[consulted + 1].prompt, /FAKE-ADVICE: fix the syntax error in broken\.js/);
  // The fake developer never fixes it: after the rescue round the task is blocked for good.
  assert.equal(t.status, 'blocked');
  assert.equal(t.rescued, true);
  assert.ok(events.some((e) => /Second opinion on \[T1\]/.test(e.text || '')));
});

test('second opinion: "split" replaces a too-big task with sub-tasks', { timeout: 180_000 }, async () => {
  const { run } = await runWith('so-split', 'split');
  const t = run.tasks.find((x) => x.title === 'Write a broken script');
  assert.equal(t.status, 'cancelled');
  assert.match(t.history.at(-1).note, /Split into/);
  const parts = run.tasks.filter((x) => x.createdBy === 'second-opinion');
  assert.deepEqual(parts.map((x) => x.title), ['Fake part one', 'Fake part two']);
  assert.deepEqual(parts[1].dependsOn || parts[1].depends_on || [], [parts[0].id]);
  for (const x of parts) assert.ok(['implemented_unverified', 'verified'].includes(x.status), `${x.id}: ${x.status}`);
});

test('second opinion: "give_up" blocks a task that cannot succeed here', { timeout: 180_000 }, async () => {
  const { run } = await runWith('so-giveup', 'give_up');
  const t = run.tasks.find((x) => x.title === 'Write a broken script');
  assert.equal(t.status, 'blocked');
  assert.equal(t.blockedReason, 'second_opinion');
  assert.match(t.history.at(-1).note, /cannot succeed here — fake: the tool it needs is not installed/);
});

test('second opinion: an unreadable answer is ignored; switched off means never asked', { timeout: 180_000 }, async () => {
  const garbage = await runWith('so-garbage', 'garbage');
  assert.ok(garbage.events.some((e) => /could not be read; the run continues/.test(e.text || '')));
  assert.ok(['completed', 'stopped'].includes(garbage.run.state) || garbage.run.stopReason, 'the run ended normally');
  const off = await runWith('so-off', 'retry', { secondOpinion: false });
  assert.ok(!off.run.tasks.some((x) => x.secondOpinions?.length));
  assert.ok(!off.events.some((e) => /Second opinion/.test(e.text || '')));
});

test('second opinion: its turns are billed under their own name, not as reviewer turns', { timeout: 180_000 }, async () => {
  const { run } = await runWith('so-usage', 'retry', { reviewerEnabled: false });
  assert.ok(run.usage.byRole.second_opinion?.turns >= 1, JSON.stringify(Object.keys(run.usage.byRole)));
  assert.equal(run.usage.byRole.reviewer.turns, 0);
});
