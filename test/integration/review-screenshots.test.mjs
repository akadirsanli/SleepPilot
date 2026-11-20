// The reviewer asks to see a page; SleepPilot takes the screenshot and the reviewer judges with it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupEnv, makeApp, newProject, finished } from './helpers.mjs';
import { findBrowsers } from '../../src/checks/browser.mjs';

// CI on Windows has Edge; a Linux machine may have Playwright's Chromium.
if (!findBrowsers().length) {
  const root = '/opt/pw-browsers';
  const dir = fs.existsSync(root) ? fs.readdirSync(root).find((d) => /^chromium-\d+$/.test(d)) : null;
  const exe = dir ? ['chrome-linux64/chrome', 'chrome-linux/chrome'].map((p) => path.join(root, dir, p)).find((p) => fs.existsSync(p)) : null;
  if (exe) process.env.SLEEPPILOT_BROWSER = exe;
}
const hasBrowser = findBrowsers().length > 0;

test('reviewer screenshots: taken only on request, only of real pages, then judged', { timeout: 180_000, skip: !hasBrowser && 'no Edge/Chrome on this machine' }, async () => {
  const { project } = setupEnv('review-shots');
  process.env.SLEEPPILOT_FAKE_REVIEW_SCREENSHOTS = '1';
  const app = await makeApp();
  try {
    const p = await newProject(app, project, { settings: { maxIterations: 4 } });
    await app.updateProject(p.id, { checks: [{ id: 'js-syntax', type: 'js-syntax', name: 'JS syntax', enabled: true }] });
    const view = await app.startRun(p.id);
    const run = await finished(app, view.id, 150_000);
    assert.equal(run.state, 'completed', JSON.stringify(run.stopReason));
    const its = [];
    for (const it of run.iterations) its.push(await app.getIteration(p.id, run.id, it.n));
    const withShots = its.filter((it) => it.screenshots?.length);
    assert.ok(withShots.length >= 1, 'at least one review used a screenshot');
    const shot = withShots[0].screenshots[0];
    assert.equal(shot.page, 'index.html');
    assert.equal(shot.device, 'phone');
    assert.match(shot.path, /^\.sleeppilot\/screens\/i\d+-.+\.png$/);
    const png = fs.readFileSync(path.join(project, shot.path));
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    // "../outside.html" was refused: only pages of the project are opened.
    assert.equal(withShots[0].screenshots.length, 1);
    assert.match(withShots[0].review.summary, /looked at \.sleeppilot\/screens\//);
    assert.equal(withShots[0].review.verdict, 'pass');
    // The working folder is not counted as a project change and is ignored by Git.
    const changed = its.flatMap((it) => [...(it.changes?.added || []), ...(it.changes?.modified || []), ...(it.changes?.deleted || [])]);
    assert.ok(changed.length > 0, 'the iterations record their changes');
    assert.ok(!changed.some((f) => f.startsWith('.sleeppilot/')), changed.join(', '));
    assert.equal(fs.readFileSync(path.join(project, '.sleeppilot', '.gitignore'), 'utf8').trim().split('\n').pop(), '*');
  } finally {
    delete process.env.SLEEPPILOT_FAKE_REVIEW_SCREENSHOTS;
    await app.shutdown();
  }
});
