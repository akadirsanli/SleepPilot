// End-to-end test of the built-in API engine: a fake OpenAI-compatible provider drives a real
// SleepPilot run through planning, a tool loop (write + read), checks, review and completion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.env.SLEEPPILOT_QUIET = '1';
process.env.SLEEPPILOT_POLL_MS = '100';
process.env.SLEEPPILOT_BACKOFF_SCALE = '0.0005';
process.env.SLEEPPILOT_NO_KEEPAWAKE = '1';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, '..', 'fake-api', 'server.mjs');
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `sp-${name}-`));

function startFake() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [FAKE], { env: { ...process.env, FAKE_API_KEY: 'test-key' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => reject(new Error('fake API did not start')), 15_000);
    child.stdout.on('data', (d) => {
      out += d.toString();
      const m = out.match(/listening (http:\/\/[^\s]+)/);
      if (m) {
        clearTimeout(timer);
        resolve({ child, url: m[1] });
      }
    });
    child.stderr.on('data', (d) => (out += d.toString()));
    child.on('exit', (code) => reject(new Error(`fake API exited ${code}: ${out}`)));
  });
}

test('API engine: plan, write, read, review and complete a run', async () => {
  const home = tmp('api-home');
  const projectDir = tmp('api-project');
  process.env.SLEEPPILOT_HOME = home;
  const fake = await startFake();
  try {
    fs.writeFileSync(
      path.join(home, 'settings.json'),
      JSON.stringify({
        engine: 'api',
        providers: [
          {
            id: 'fake',
            label: 'Fake provider',
            protocol: 'openai',
            baseUrl: fake.url,
            apiKeyEnv: 'FAKE_API_KEY',
            requiresKey: true,
            models: [
              { id: 'fake-coder', name: 'Fake coder' },
              { id: 'fake-manager', name: 'Fake manager' },
            ],
          },
        ],
        api: { maxSteps: 10, temperature: 0, requestTimeoutSec: 60 },
      }),
    );
    fs.writeFileSync(path.join(home, 'credentials.json'), JSON.stringify({ providers: { fake: 'test-key' }, env: {} }));

    const { SleepPilotApp } = await import('../../src/app/app.mjs');
    const app = new SleepPilotApp({ autoConnect: false });
    await app.init();
    await app.manager.connect('api');
    assert.equal(app.manager.get('api').status.state, 'connected', app.manager.get('api').status.message);

    let project = await app.createProject({ name: 'api test', dir: projectDir, createIfMissing: true, engine: 'api' });
    project = await app.updateProject(project.id, {
      objective: 'Create hello.txt with a greeting and verify it.',
      settings: {
        ...project.settings,
        engine: 'api',
        models: {
          manager: { providerID: 'fake', id: 'fake-manager' },
          developer: { providerID: 'fake', id: 'fake-coder' },
          reviewer: { providerID: 'fake', id: 'fake-manager' },
        },
        backupBeforeRun: false,
        reviewerEnabled: true,
        durationMin: 5,
        maxIterations: 10,
        maxTurnMin: 1,
        permissionProfile: 'full',
        unattended: true,
        closingReport: false,
      },
    });
    const view = await app.startRun(project.id);
    const ctrl = app.controllerFor(view.id);
    await new Promise((resolve) => {
      if (ctrl.terminal) return resolve();
      ctrl.on('finished', resolve);
      setTimeout(resolve, 60_000).unref?.();
    });
    assert.equal(ctrl.run.state, 'completed', `state=${ctrl.run.state} stop=${JSON.stringify(ctrl.run.stopReason)} pause=${JSON.stringify(ctrl.run.pause)}`);
    assert.ok(fs.existsSync(path.join(projectDir, 'hello.txt')), 'the developer tool wrote the file');
    assert.match(fs.readFileSync(path.join(projectDir, 'hello.txt'), 'utf8'), /Hello from the fake API engine/);
    assert.ok(ctrl.run.iterationCount >= 1);
    const events = await app.store.readEvents(project.id, view.id, 1000);
    assert.ok(events.some((e) => e.kind === 'tool' && String(e.text).includes('write')), 'a tool call was logged');
    await app.shutdown();
  } finally {
    fake.child.kill('SIGTERM');
  }
});
