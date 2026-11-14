import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const FAKE_SERVER = path.join(ROOT, 'test', 'fake-opencode', 'server.mjs');

process.env.SLEEPPILOT_QUIET = '1';
process.env.SLEEPPILOT_POLL_MS = '150';
process.env.SLEEPPILOT_FAKE_STEP_MS = '20';
process.env.SLEEPPILOT_BACKOFF_SCALE = '0.0005';
process.env.SLEEPPILOT_NO_KEEPAWAKE = '1';

export function tmpDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `sp-${name}-`));
}

export const fakeCommand = () => ({ exe: process.execPath, args: [FAKE_SERVER, 'serve', '--hostname', '127.0.0.1', '--port', '0'] });

/** Fresh isolated SleepPilot home + project folder + optional plan file. */
export function setupEnv(name, plan) {
  const home = tmpDir(`${name}-home`);
  const project = tmpDir(`${name}-proj`);
  process.env.SLEEPPILOT_HOME = home;
  if (plan) {
    const f = path.join(home, 'plan.json');
    fs.writeFileSync(f, JSON.stringify(plan));
    process.env.SLEEPPILOT_FAKE_PLAN = f;
  } else delete process.env.SLEEPPILOT_FAKE_PLAN;
  process.env.SLEEPPILOT_FAKE_STATE = path.join(home, 'fake-opencode-state.json');
  return { home, project };
}

export async function waitFor(pred, { timeoutMs = 60_000, interval = 100, label = 'condition' } = {}) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await pred();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, interval));
  }
}

export async function makeApp() {
  const { SleepPilotApp } = await import('../../src/app/app.mjs');
  const app = new SleepPilotApp({ testMode: true, testCommand: fakeCommand() });
  await app.init();
  await waitFor(() => app.adapter.connected, { label: 'fake OpenCode connection', timeoutMs: 30_000 });
  return app;
}

export async function newProject(app, dir, { objective = 'Make a simple HTML demo page.', settings = {}, checks } = {}) {
  let p = await app.createProject({ name: path.basename(dir), dir });
  p = await app.updateProject(p.id, {
    objective,
    settings: { ...p.settings, backupBeforeRun: false, reviewerEnabled: true, durationMin: 30, maxIterations: 20, ...settings },
    ...(checks ? { checks } : {}),
  });
  return p;
}

export function task(title, actions, extra = {}) {
  return { title, description: `${title}\n${actions.map((a) => 'ACTION: ' + a).join('\n')}`, acceptance: ['ok'], priority: extra.priority ?? 2, depends_on: extra.depends_on ?? [], ...(extra.files ? { files: extra.files } : {}) };
}

export const plan = (...tasks) => ({ summary: 'test plan', tasks, verification_notes: 'test', questions: [] });

export async function finished(app, runId, timeoutMs = 90_000) {
  return waitFor(() => {
    const c = app.controllers.get(runId);
    return c && ['completed', 'stopped', 'failed'].includes(c.run.state) ? c.run : null;
  }, { timeoutMs, label: 'run to finish' });
}
