// Routing schema, model profiles, quota windows and adapter-level effort/read-only behavior.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EFFORT_LEVELS, defaultModelProfiles, defaultRolePins, normalizeHarnessRouting, normalizeModelProfiles,
  resolveRoutes, modelForHarness, validateRoutingConfig, RoutingConfigError, HarnessRouter,
} from '../../src/orchestrator/routing.mjs';
import { QuotaTracker, parseResetHint } from '../../src/orchestrator/quota-tracker.mjs';
import { ClaudeEngine } from '../../src/engines/claude/engine.mjs';
import { CodexEngine } from '../../src/engines/codex/engine.mjs';
import { DshEngine } from '../../src/engines/dsh/engine.mjs';
import { OpenCodeAdapter } from '../../src/opencode/adapter.mjs';

test('routing is backward compatible until enabled', () => {
  const routes = resolveRoutes({ role: 'developer', defaultEngine: 'opencode' });
  assert.equal(routes.length, 1);
  assert.equal(routes[0].harness, 'opencode');
  assert.equal(routes[0].effort, null);
  const defaults = normalizeHarnessRouting();
  assert.equal(defaults.enabled, false);
  assert.equal(defaults.claudeWindowHours, 5);
  assert.equal(defaults.workingWindowHours, 10);
});

test('role pins, task types and fallback chain resolve in order', () => {
  const harnessRouting = { enabled: true, roles: { manager: ['claude'], developer: ['dsh'], reviewer: ['api'], closing: ['api'], preflight: ['claude'] }, taskTypes: { analysis: ['claude'] }, fallbackChain: ['claude', 'dsh', 'api', 'opencode'] };
  const modelProfiles = normalizeModelProfiles({ claude: { high: { model: 'sonnet', effort: 'high' } }, api: { deep: { model: { providerID: 'deepseek', id: 'deepseek-chat' }, effort: 'high' } }, dsh: { default: { model: null, effort: null } } });
  const rolePins = { developer: { harness: 'claude', modelProfile: 'high' }, reviewer: { harness: 'api', modelProfile: 'deep' } };
  const dev = resolveRoutes({ role: 'developer', taskType: 'coding', harnessRouting, modelProfiles, rolePins, defaultEngine: 'opencode' });
  assert.deepEqual(dev.slice(0, 4).map((r) => r.harness), ['claude', 'dsh', 'api', 'opencode']);
  assert.equal(dev[0].effort, 'high');
  assert.equal(dev[0].model, 'sonnet');
  const analysis = resolveRoutes({ role: 'developer', taskType: 'analysis', harnessRouting, modelProfiles, rolePins, defaultEngine: 'opencode' });
  assert.equal(analysis[0].harness, 'claude');
  const reviewer = resolveRoutes({ role: 'reviewer', taskType: 'review', harnessRouting, modelProfiles, rolePins, defaultEngine: 'opencode' });
  assert.equal(reviewer[0].harness, 'api');
  assert.equal(reviewer[0].modelProfile, 'deep');
  const router = new HarnessRouter({ harnessRouting, modelProfiles, rolePins, defaultEngine: 'opencode' });
  assert.equal(router.resolve('reviewer', 'review').harness, 'api');
  assert.equal(router.routesFor('developer', 'coding')[0].harness, 'claude');
});

test('effort validation fails loudly instead of downgrading', () => {
  assert.throws(() => normalizeModelProfiles({ claude: { bad: { effort: 'ultra' } } }, { strict: true }), (err) => err instanceof RoutingConfigError && /ultra/.test(err.message) && /low, medium, high, xhigh, max/.test(err.message));
  assert.throws(() => normalizeModelProfiles({ api: { bad: { effort: 'super' } } }, { strict: true }), /super/);
  assert.throws(() => normalizeModelProfiles({ dsh: { bad: { effort: 'high' } } }, { strict: true }), /dsh supports: none/);
  assert.throws(() => validateRoutingConfig({ harnessRouting: { enabled: true, roles: {} }, modelProfiles: {}, rolePins: { manager: { harness: 'claude', modelProfile: 'missing' } } }), /missing model profile/);
  assert.deepEqual(EFFORT_LEVELS.claude, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(EFFORT_LEVELS.api, ['off', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
});

test('native model references and API provider/model split', () => {
  assert.deepEqual(modelForHarness('api', 'deepseek/deepseek-chat'), { providerID: 'deepseek', id: 'deepseek-chat' });
  assert.deepEqual(modelForHarness('claude', 'sonnet'), { providerID: 'claude', id: 'sonnet' });
  assert.equal(modelForHarness('dsh', null), null);
});

test('quota tracker records a Claude 5-hour window and exposes canUse', () => {
  const now = Date.now();
  const q = new QuotaTracker({ routing: { claudeWindowHours: 5 } });
  assert.equal(q.canUse('claude', now).ok, true);
  q.observe('claude', { quota: { exhausted: true, resetsAt: now + 5 * 3_600_000, message: '5-hour limit' } });
  assert.equal(q.canUse('claude', now).ok, false);
  assert.equal(q.canUse('claude', now + 5 * 3_600_000 + 1).ok, true);
  assert.ok(q.nextAvailable(now).until > now);
  q.clear('claude');
  assert.equal(q.canUse('claude', now).ok, true);
});

test('quota tracker: a new run clears guessed cooldowns but keeps reported and Claude windows', () => {
  const now = Date.now();
  const q = new QuotaTracker({ routing: { claudeWindowHours: 5, quotaCooldownMin: { opencode: 30, codex: 30 } } });
  q.observe('opencode', { classification: { category: 'quota', message: 'limit' }, at: now });
  q.observe('codex', { quota: { exhausted: true, resetsAt: now + 3_600_000 }, at: now });
  q.observe('claude', { quota: { exhausted: true, message: '5-hour limit' }, at: now });
  assert.equal(q.canUse('opencode', now).ok, false);
  q.clearGuessed();
  assert.equal(q.canUse('opencode', now).ok, true, 'a 30-minute guess does not outlive the run that caused it');
  assert.equal(q.canUse('codex', now).ok, false, 'a provider-reported reset time stays');
  assert.equal(q.canUse('claude', now).ok, false, 'the Claude usage window stays');
});

test('Claude reset hints are parsed from real-style messages', () => {
  const now = new Date('2026-11-10T12:00:00');
  assert.equal(parseResetHint('You reached your 5-hour limit. Resets at 5:00 PM.', now), new Date('2026-11-10T17:00:00').getTime());
  assert.equal(parseResetHint('usage limit reached; try again at 2026-11-10T23:00:00Z', now), Date.parse('2026-11-10T23:00:00Z'));
  assert.equal(parseResetHint('resets in 2 hours', now), now.getTime() + 2 * 3_600_000);
  assert.equal(parseResetHint('no hint here', now), null);
});

test('Claude and Codex receive effort and read-only flags; DSH refuses unsupported effort/read-only', async () => {
  const claude = new ClaudeEngine({ settings: { claude: { cliPath: 'claude.cmd' } } });
  const claudeArgs = claude.buildArgs({ session: { model: { id: 'sonnet' }, effort: 'high', readOnly: true }, readOnly: true, profile: 'strict' }).args;
  assert.ok(claudeArgs.includes('--effort') && claudeArgs.includes('high'));
  assert.ok(claudeArgs.includes('--permission-mode') && claudeArgs.includes('plan'));
  assert.throws(() => claude.buildArgs({ session: { model: null, effort: 'ultra' }, readOnly: false, profile: 'full' }), /does not support effort "ultra"/);

  const codex = new CodexEngine({ settings: { codex: { cliPath: 'codex.cmd' } } });
  const codexArgs = codex.buildArgs({ session: { model: null, effort: 'high', readOnly: false }, readOnly: false, profile: 'full' }).args;
  assert.ok(codexArgs.includes('model_reasoning_effort="high"'));
  const ro = codex.buildArgs({ session: { model: null, effort: null, readOnly: true }, readOnly: true, profile: 'strict' }).args;
  assert.ok(ro.includes('read-only'));

  const dsh = new DshEngine({ settings: { dsh: { cliPath: 'dsh.cmd' } } });
  dsh.status = { state: 'connected', message: 'test' };
  await assert.rejects(() => dsh.createSession({ directory: process.cwd(), effort: 'high' }), /does not expose a reasoning-effort flag/);
  await assert.rejects(() => dsh.createSession({ directory: process.cwd(), readOnly: true }), /cannot enforce a read-only session/);

  const opencode = new OpenCodeAdapter({ settings: {} });
  await assert.rejects(() => opencode.createSession({ directory: process.cwd(), effort: 'high' }), /OpenCode does not expose a reasoning-effort flag/);
});
