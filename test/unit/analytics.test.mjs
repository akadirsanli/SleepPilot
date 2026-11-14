// Cross-project Insights aggregation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAnalytics } from '../../src/analytics/analytics.mjs';

test('analytics sums measured active time, lines, tasks and tokens per project', async () => {
  const now = Date.now();
  const runs = {
    p1: [
      { id: 'r1', state: 'completed', startedAt: now - 3_600_000, activeMs: 1_800_000, lineStats: { net: { additions: 120, deletions: 10 } }, usage: { cost: 0.25, tokens: { input: 1000, output: 500, reasoning: 50, cacheRead: 0 }, models: { 'fake/model': 3 } }, tasks: [{ status: 'verified' }, { status: 'implemented_unverified' }], engine: { id: 'opencode', label: 'OpenCode' } },
      { id: 'r2', state: 'stopped', startedAt: now - 86_400_000, activeMs: 600_000, lineStats: { net: { additions: 30, deletions: 0 } }, usage: { cost: 0.05, tokens: { input: 200, output: 100, reasoning: 0, cacheRead: 0 }, models: {} }, tasks: [{ status: 'blocked' }], engine: { id: 'codex', label: 'Codex CLI' } },
    ],
    p2: [{ id: 'r3', state: 'completed', startedAt: now, activeMs: 300_000, lineStats: { net: { additions: 0, deletions: 5 } }, usage: { cost: 0, tokens: { input: 20, output: 10, reasoning: 0, cacheRead: 0 }, models: {} }, tasks: [], engine: { id: 'claude', label: 'Claude Code' } }],
  };
  const store = {
    listProjects: async () => [{ id: 'p1', name: 'One' }, { id: 'p2', name: 'Two' }],
    listRuns: async (id) => runs[id] || [],
  };
  const a = await buildAnalytics(store);
  assert.equal(a.totals.projects, 2);
  assert.equal(a.totals.runs, 3);
  assert.equal(a.totals.activeMs, 2_700_000);
  assert.equal(a.totals.added, 150);
  assert.equal(a.totals.deleted, 15);
  assert.equal(a.totals.verified, 1);
  assert.equal(a.totals.unverified, 1);
  assert.equal(a.totals.failed, 1);
  assert.equal(a.totals.tokens.input, 1220);
  assert.equal(a.totals.tokens.output, 610);
  assert.equal(a.totals.cost, 0.3);
  assert.equal(a.top.mostActive[0].id, 'p1');
  assert.equal(a.top.mostLines[0].id, 'p1');
  assert.equal(a.byEngine['Codex CLI'].runs, 1);
  assert.equal(a.daily.length, 14);
  assert.ok(a.recent.length === 3);
});
