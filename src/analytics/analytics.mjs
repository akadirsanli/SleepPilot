/**
 * Cross-project analytics for the Insights screen. Everything is computed from persisted run
 * records (active time, measured line changes, token usage, task counts) — no model claims.
 */
export async function buildAnalytics(store, { includeTest = false } = {}) {
  const projects = await store.listProjects();
  const totals = { projects: projects.length, runs: 0, activeMs: 0, added: 0, deleted: 0, verified: 0, unverified: 0, failed: 0, tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0 }, cost: 0 };
  const byProject = [];
  const byEngine = {};
  const byModel = {};
  const daily = new Map();
  const recent = [];
  const now = Date.now();
  for (let i = 13; i >= 0; i--) {
    const d = new Date(now - i * 86400000);
    daily.set(d.toISOString().slice(0, 10), { day: d.toISOString().slice(0, 10), activeMs: 0, added: 0, deleted: 0, runs: 0 });
  }
  for (const project of projects) {
    const runs = await store.listRuns(project.id);
    const p = { id: project.id, name: project.name, runs: 0, activeMs: 0, added: 0, deleted: 0, verified: 0, tokens: 0, cost: 0 };
    for (const run of runs) {
      if (!includeTest && run.opencode?.testMode) continue;
      const activeMs = (run.activeMs || 0) + (run.activeSince ? Math.max(0, now - run.activeSince) : 0);
      const net = run.lineStats?.net || {};
      const added = net.additions || 0;
      const deleted = net.deletions || 0;
      const tokens = (run.usage?.tokens?.input || 0) + (run.usage?.tokens?.output || 0);
      const verified = run.tasks?.filter((t) => t.status === 'verified').length || 0;
      const unverified = run.tasks?.filter((t) => t.status === 'implemented_unverified').length || 0;
      const failed = run.tasks?.filter((t) => ['test_failed', 'blocked'].includes(t.status)).length || 0;
      totals.runs++;
      totals.activeMs += activeMs;
      totals.added += added;
      totals.deleted += deleted;
      totals.verified += verified;
      totals.unverified += unverified;
      totals.failed += failed;
      for (const k of Object.keys(totals.tokens)) totals.tokens[k] += run.usage?.tokens?.[k] || 0;
      totals.cost += run.usage?.cost || 0;
      p.runs++;
      p.activeMs += activeMs;
      p.added += added;
      p.deleted += deleted;
      p.verified += verified;
      p.tokens += tokens;
      p.cost += run.usage?.cost || 0;
      const engine = run.engine?.label || run.engine?.id || 'OpenCode';
      byEngine[engine] ||= { runs: 0, activeMs: 0, tokens: 0 };
      byEngine[engine].runs++;
      byEngine[engine].activeMs += activeMs;
      byEngine[engine].tokens += tokens;
      for (const [model, count] of Object.entries(run.usage?.models || {})) {
        byModel[model] ||= { turns: 0 };
        byModel[model].turns += count;
      }
      const day = new Date(run.startedAt || run.createdAt || now).toISOString().slice(0, 10);
      if (daily.has(day)) {
        const d = daily.get(day);
        d.runs++;
        d.activeMs += activeMs;
        d.added += added;
        d.deleted += deleted;
      }
      recent.push({ runId: run.id, projectId: project.id, projectName: project.name, state: run.state, engine, at: run.startedAt || run.createdAt, activeMs, added, deleted, verified, stop: run.stopReason?.label || null });
    }
    byProject.push(p);
  }
  const usedProjects = byProject.filter((p) => p.runs > 0);
  const sortedProjects = [...usedProjects].sort((a, b) => b.activeMs - a.activeMs || b.added - a.added);
  return {
    generatedAt: now,
    totals,
    byProject: sortedProjects,
    byEngine: Object.fromEntries(Object.entries(byEngine).sort((a, b) => b[1].activeMs - a[1].activeMs)),
    byModel: Object.fromEntries(Object.entries(byModel).sort((a, b) => b[1].turns - a[1].turns).slice(0, 12)),
    daily: [...daily.values()],
    recent: recent.sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, 30),
    top: {
      mostActive: sortedProjects.slice(0, 5),
      mostLines: [...usedProjects].sort((a, b) => b.added - a.added).slice(0, 5),
    },
  };
}
