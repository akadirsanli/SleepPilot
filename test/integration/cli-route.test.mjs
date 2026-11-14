// Headless route command: resolved roles, model profiles and a loud unsupported-effort failure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store, DEFAULT_PROJECT_SETTINGS } from '../../src/store/store.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('sleeppilot route resolves project pins and rejects unsupported effort', { timeout: 30_000 }, async () => {
  const previousHome = process.env.SLEEPPILOT_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-cli-route-home-'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-cli-route-project-'));
  process.env.SLEEPPILOT_HOME = home;
  const store = new Store();
  const project = await store.createProject({ name: 'Route CLI', dir });
  store.setObjective(project, 'route test');
  project.settings = {
    ...DEFAULT_PROJECT_SETTINGS,
    harnessRouting: { enabled: true, roles: { manager: ['claude'], developer: ['dsh'], reviewer: ['api'] }, fallbackChain: ['claude', 'dsh', 'api', 'opencode'] },
    modelProfiles: {
      claude: { default: { model: 'sonnet', effort: 'high' } },
      dsh: { default: { model: null, effort: null } },
      api: { default: { model: { providerID: 'deepseek', id: 'deepseek-chat' }, effort: 'high' } },
    },
    rolePins: {
      manager: { harness: 'claude', modelProfile: 'default' },
      developer: { harness: 'dsh', modelProfile: 'default' },
      reviewer: { harness: 'api', modelProfile: 'default' },
    },
  };
  await store.saveProject(project);
  const env = { ...process.env, SLEEPPILOT_HOME: home, SLEEPPILOT_QUIET: '1' };
  const run = () => spawnSync(process.execPath, [path.join(ROOT, 'src', 'main.mjs'), 'route', '--project', dir, '--task', 'coding', '--dry-run', '--json'], { cwd: ROOT, env, encoding: 'utf8' });
  const ok = run();
  assert.equal(ok.status, 0, ok.stderr);
  const route = JSON.parse(ok.stdout);
  assert.equal(route.type, 'route');
  assert.equal(route.dryRun, true);
  assert.equal(route.roles.manager.harness, 'claude');
  assert.equal(route.roles.manager.modelProfile, 'default');
  assert.equal(route.roles.manager.effort, 'high');
  assert.equal(route.roles.developer.harness, 'dsh');
  assert.equal(route.roles.reviewer.harness, 'api');
  assert.deepEqual(route.fallbackChain.map((r) => r.harness), ['dsh', 'claude', 'api', 'opencode']);

  project.settings = { ...project.settings, modelProfiles: { ...project.settings.modelProfiles, claude: { default: { model: 'sonnet', effort: 'ultra' } } } };
  await store.saveProject(project);
  const bad = run();
  assert.equal(bad.status, 1);
  const err = JSON.parse(bad.stdout);
  assert.equal(err.type, 'error');
  assert.match(err.message, /claude/i);
  assert.match(err.message, /ultra/i);
  assert.match(err.message, /low, medium, high, xhigh, max/);

  project.settings = { ...project.settings, engine: 'dsh', harnessRouting: { enabled: true, roles: { manager: [], developer: [], reviewer: [] }, fallbackChain: [] }, modelProfiles: { claude: { default: { model: 'sonnet', effort: 'high' } } }, rolePins: { manager: { harness: 'dsh', modelProfile: null }, developer: { harness: 'dsh', modelProfile: null }, reviewer: { harness: 'dsh', modelProfile: null } } };
  await store.saveProject(project);
  const readOnlyBad = run();
  assert.equal(readOnlyBad.status, 1);
  assert.match(JSON.parse(readOnlyBad.stdout).message, /read-only-capable harness for manager/);
  if (previousHome === undefined) delete process.env.SLEEPPILOT_HOME;
  else process.env.SLEEPPILOT_HOME = previousHome;
});
