// Multi-harness routing and quota fallback through the real RunController.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Store, DEFAULT_PROJECT_SETTINGS } from '../../src/store/store.mjs';
import { RunController, newRunRecord } from '../../src/orchestrator/run-controller.mjs';
import { QuotaTracker } from '../../src/orchestrator/quota-tracker.mjs';
import { resolveRoutes } from '../../src/orchestrator/routing.mjs';

process.env.SLEEPPILOT_QUIET = '1';

class FakeHarness extends EventEmitter {
  constructor(id, { failDeveloper = false } = {}) {
    super();
    this.id = id;
    this.label = id.toUpperCase();
    this.connected = true;
    this.models = [{ providerID: id, id: `${id}-model`, name: `${id} model` }];
    this.defaultModel = this.models[0];
    this.failDeveloper = failDeveloper;
    this.sessions = [];
    this.calls = [];
    this.status = { state: 'connected', message: 'ready' };
    this.client = { has: () => true };
  }
  async connect() { this.connected = true; }
  async disconnect() { this.connected = false; }
  async createSession({ directory, title, model, effort = null, readOnly = false, permissions } = {}) {
    const session = { id: `s_${this.id}_${this.sessions.length + 1}`, directory, title, model, effort, readOnly, permissions: permissions || [] };
    this.sessions.push(session);
    return session;
  }
  async runTurn({ sessionID, text, messageId, metadata }) {
    this.calls.push({ sessionID, text, metadata, session: this.sessions.find((s) => s.id === sessionID) });
    const base = { status: 'succeeded', sessionID, messageId, startedAt: Date.now(), endedAt: Date.now(), outcome: 'succeeded', finalText: '', allText: '', tools: [], errors: [], usage: { cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, models: [`${this.id}/${this.id}-model`] }, transcript: [], snapshotFiles: [] };
    if (/SleepPilot model check/.test(text)) return { ...base, finalText: 'OK' };
    if (/You are the MANAGER/.test(text) && /Break the objective/.test(text)) {
      const plan = { summary: 'one task', tasks: [{ title: 'Write fallback file', description: 'Write fallback.txt', type: 'coding', acceptance: ['file exists'], priority: 1, depends_on: [], files: ['fallback.txt'] }], verification_notes: 'none', questions: [] };
      return { ...base, finalText: JSON.stringify(plan), allText: JSON.stringify(plan) };
    }
    if (/You are the MANAGER/.test(text) && /Decide the next step/.test(text)) {
      const decision = { decision: 'complete', next_task_id: null, reasoning: 'done', user_question: null, task_updates: [], new_tasks: [] };
      return { ...base, finalText: JSON.stringify(decision), allText: JSON.stringify(decision) };
    }
    if (/You are the REVIEWER/.test(text)) {
      const review = { verdict: 'pass', issues: [], missing_verification: [], summary: 'reviewed by the API harness' };
      return { ...base, finalText: JSON.stringify(review), allText: JSON.stringify(review) };
    }
    if (/You are the DEVELOPER/.test(text)) {
      if (this.failDeveloper) {
        return {
          ...base,
          status: 'failed',
          outcome: 'failed',
          errors: [{ type: 'provider.quota', message: 'Claude 5-hour usage window exhausted', classification: { category: 'quota', action: 'pause', label: 'Provider quota / usage allowance exhausted', message: 'Claude 5-hour usage window exhausted' } }],
          quota: { exhausted: true, window: '5h', resetsAt: Date.now() + 5 * 3_600_000, message: 'Claude 5-hour usage window exhausted', source: 'claude-cli' },
          finalText: '',
          allText: '',
        };
      }
      fs.writeFileSync(path.join(this.sessions.find((s) => s.id === sessionID).directory, 'fallback.txt'), 'fallback route worked\n');
      return { ...base, finalText: 'wrote fallback.txt\nSLEEPPILOT_STATUS: done', allText: 'wrote fallback.txt\nSLEEPPILOT_STATUS: done' };
    }
    return base;
  }
  async turnMessages() { return { found: false, user: null, after: [] }; }
  async interrupt() { return { supported: true, interrupted: true }; }
  async usageLimits() { return { supported: false, data: null }; }
  async replyPermission() { return true; }
  async replyForm() { return true; }
  async cancelForm() { return true; }
  async sessionDiff() { return []; }
}

test('routing pins manager/developer/reviewer and falls back on Claude quota exhaustion', { timeout: 60_000 }, async () => {
  const previousHome = process.env.SLEEPPILOT_HOME;
  process.env.SLEEPPILOT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-routing-home-'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-routing-project-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>routing</h1>\n');
  const store = new Store();
  let project = await store.createProject({ name: 'Routing demo', dir });
  store.setObjective(project, 'Write fallback.txt through the routed developer.');
  project.settings = {
    ...DEFAULT_PROJECT_SETTINGS,
    durationMin: 2,
    maxIterations: 2,
    maxAttemptsSameFailure: 1,
    reviewerEnabled: true,
    backupBeforeRun: false,
    closingReport: false,
    permissionProfile: 'full',
    planReview: false,
    harnessRouting: {
      enabled: true,
      roles: { manager: ['claude'], developer: ['claude'], reviewer: ['api'], closing: ['api'], preflight: ['claude'] },
      fallbackChain: ['claude', 'dsh', 'api'],
      fallbackOnErrors: true,
      maxSwitches: 4,
    },
    modelProfiles: {
      claude: { default: { model: 'sonnet', effort: 'high' } },
      dsh: { default: { model: null, effort: null } },
      api: { default: { model: { providerID: 'deepseek', id: 'deepseek-chat' }, effort: 'high' } },
    },
    rolePins: {
      manager: { harness: 'claude', modelProfile: 'default' },
      developer: { harness: 'claude', modelProfile: 'default' },
      reviewer: { harness: 'api', modelProfile: 'default' },
    },
  };
  await store.saveProject(project);
  const run = newRunRecord({ id: store.newRunId(), project });
  await store.saveRun(run);
  const claude = new FakeHarness('claude', { failDeveloper: true });
  const dsh = new FakeHarness('dsh');
  const api = new FakeHarness('api');
  const manager = { engines: new Map([['claude', claude], ['dsh', dsh], ['api', api]]), get(id) { return this.engines.get(id); }, async connect(id) { return this.engines.get(id); } };
  const quota = new QuotaTracker({ routing: project.settings.harnessRouting });
  const ctrl = new RunController({
    store,
    adapter: claude,
    engineManager: manager,
    project,
    run,
    routing: project.settings.harnessRouting,
    modelProfiles: project.settings.modelProfiles,
    rolePins: project.settings.rolePins,
    quota,
  });
  const turns = [];
  ctrl.on('turn', (t) => turns.push(t));
  const finished = new Promise((resolve) => ctrl.on('finished', resolve));
  await ctrl.start();
  let timer;
  await Promise.race([finished, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('run did not finish')), 30_000); })]);
  clearTimeout(timer);
  assert.equal(ctrl.run.state, 'completed');
  const saved = await store.getRun(project.id, run.id);
  assert.ok(saved.routingSwitches.some((s) => s.role === 'developer' && s.from === 'claude' && s.to === 'dsh'), 'switch is persisted in the run record');
  assert.ok(saved.sessionRoutes.manager, 'route/session binding is persisted');
  assert.ok(saved.sessionRoutes['developer:T1'], 'developer session route is persisted per task');
  assert.ok(saved.quota.windows.claude, 'quota window is persisted');
  assert.ok(fs.readFileSync(path.join(dir, 'fallback.txt'), 'utf8').includes('fallback route worked'));
  assert.ok(ctrl.run.routingSwitches.some((s) => s.role === 'developer' && s.from === 'claude' && s.to === 'dsh'));
  const claudeDev = claude.calls.find((c) => /You are the DEVELOPER/.test(c.text));
  const dshDev = dsh.calls.find((c) => /You are the DEVELOPER/.test(c.text));
  assert.equal(claudeDev.session.readOnly, false);
  assert.equal(claudeDev.session.effort, 'high');
  assert.equal(dshDev.session.effort, null);
  const managerSession = claude.sessions.find((s) => /Manager/.test(s.title));
  assert.equal(managerSession.readOnly, true);
  const reviewerSession = api.sessions.find((s) => /Reviewer/.test(s.title));
  assert.ok(reviewerSession, 'reviewer session was created on the pinned API harness');
  assert.equal(reviewerSession.readOnly, true);
  assert.equal(reviewerSession.effort, 'high');
  assert.ok(turns.some((t) => t.role === 'reviewer' && t.harness === 'api'), 'reviewer turn ran on the pinned harness');
  const failedTurn = turns.find((t) => t.role === 'developer' && t.status === 'failed');
  const fallbackTurn = turns.find((t) => t.role === 'developer' && t.status === 'succeeded');
  assert.equal(failedTurn.harness, 'claude');
  assert.equal(failedTurn.modelProfile, 'default');
  assert.equal(failedTurn.fallbackStep, 0);
  assert.equal(fallbackTurn.harness, 'dsh');
  assert.equal(fallbackTurn.fallbackStep, 1);
  assert.ok(turns.some((t) => t.role === 'manager' && t.harness === 'api'), 'manager turn continued on the fallback harness');
  assert.equal(project.settings.rolePins.reviewer.harness, 'api');
  const routes = resolveRoutes({ role: 'developer', taskType: 'coding', harnessRouting: project.settings.harnessRouting, modelProfiles: project.settings.modelProfiles, rolePins: project.settings.rolePins, defaultEngine: 'claude' });
  assert.equal(routes[0].harness, 'claude');
  assert.equal(routes[1].harness, 'dsh');
  if (previousHome === undefined) delete process.env.SLEEPPILOT_HOME;
  else process.env.SLEEPPILOT_HOME = previousHome;
});
