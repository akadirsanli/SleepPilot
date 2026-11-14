import path from 'node:path';
import { isGeneratedPath } from '../project/generated.mjs';

/**
 * Statistics for the report screen, computed only from SleepPilot's own records (run.json,
 * iterations/NNNN.json patches, turns.jsonl, events.jsonl). Line counts are measured from file
 * snapshots before/after each iteration, never taken from a model's claim.
 */
export async function buildStats(store, projectId, runId, { includeTest = false } = {}) {
  const runs = (await store.listRuns(projectId)).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  const fileAgg = new Map();
  const extAgg = new Map();
  const runRows = [];
  const total = { runs: 0, activeMs: 0, iterations: 0, added: 0, deleted: 0, generatedAdded: 0, generatedDeleted: 0, generatedFiles: 0, verified: 0, unverified: 0, failed: 0, turns: 0, tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0 } };
  const generatedSeen = new Set();
  let selected = null;

  for (const summary of runs) {
    const run = await store.getRun(projectId, summary.id);
    if (!run) continue;
    // Test-mode runs (fake OpenCode) never count in project totals — except inside test mode itself.
    const testMode = !!run.opencode?.testMode && !includeTest;
    const its = [];
    let added = 0;
    let deleted = 0;
    let genAdded = 0;
    let genDeleted = 0;
    for (const it of run.iterations || []) {
      const full = await store.getIteration(projectId, run.id, it.n).catch(() => null);
      let a = it.lines?.additions ?? 0;
      let d = it.lines?.deletions ?? 0;
      let ga = 0;
      let gd = 0;
      if (full?.patches) {
        a = 0;
        d = 0;
        for (const p of full.patches) {
          // Build output / dependencies are counted apart: they are not code the agent wrote.
          if (isGeneratedPath(p.file)) {
            ga += p.additions || 0;
            gd += p.deletions || 0;
            if (!testMode) generatedSeen.add(p.file);
            continue;
          }
          a += p.additions || 0;
          d += p.deletions || 0;
          if (!testMode) addFile(fileAgg, extAgg, p.file, p.additions || 0, p.deletions || 0, run.id);
        }
      }
      added += a;
      deleted += d;
      genAdded += ga;
      genDeleted += gd;
      its.push({
        n: it.n,
        taskId: it.taskId,
        taskTitle: it.taskTitle,
        added: a,
        deleted: d,
        durationMs: it.endedAt && it.startedAt ? it.endedAt - it.startedAt : null,
        status: it.evaluation?.status || it.status,
        files: it.changedCount ?? null,
        generatedAdded: ga,
        wave: full?.wave || null,
        startedAt: it.startedAt,
      });
    }
    const tasks = run.tasks || [];
    const row = {
      id: run.id,
      startedAt: run.startedAt || run.createdAt,
      endedAt: run.endedAt,
      state: run.state,
      stop: run.stopReason?.label || null,
      testMode,
      activeMs: run.activeMs || 0,
      durationLimitMin: run.limits?.durationMin || null,
      iterations: run.iterationCount || 0,
      added,
      deleted,
      generatedAdded: genAdded,
      generatedDeleted: genDeleted,
      net: run.lineStats?.net ? run.lineStats.net.additions - run.lineStats.net.deletions : null,
      verified: tasks.filter((t) => t.status === 'verified').length,
      unverified: tasks.filter((t) => t.status === 'implemented_unverified').length,
      failed: tasks.filter((t) => t.status === 'blocked' || t.status === 'test_failed').length,
      open: tasks.filter((t) => t.status === 'pending' || t.status === 'in_progress' || t.status === 'waiting_user').length,
      tokens: run.usage?.tokens || null,
    };
    runRows.push(row);
    if (!testMode) {
      total.runs++;
      total.activeMs += row.activeMs;
      total.iterations += row.iterations;
      total.added += added;
      total.deleted += deleted;
      total.generatedAdded += genAdded;
      total.generatedDeleted += genDeleted;
      total.verified += row.verified;
      total.unverified += row.unverified;
      total.failed += row.failed;
      for (const k of Object.keys(total.tokens)) total.tokens[k] += run.usage?.tokens?.[k] || 0;
      for (const r of Object.values(run.usage?.byRole || {})) total.turns += r.turns || 0;
    }
    if (run.id === runId) selected = { run, its, row };
  }

  total.generatedFiles = generatedSeen.size;
  let runDetail = null;
  if (selected) {
    const { run, its, row } = selected;
    let cum = 0;
    const roles = await roleTimes(store, projectId, run);
    runDetail = {
      id: run.id,
      row,
      iterations: its.map((x) => ({ ...x, cumulative: (cum += x.added - x.deleted) })),
      roles,
      files: topFiles(await runFiles(store, projectId, run), 12),
      taskStatus: countBy(run.tasks || [], (t) => t.status),
      overtimeUsed: run.overtimeUsed || 0,
      earlyByMs: run.stopReason?.code === 'objective_completed' && run.limits?.durationMin ? Math.max(0, run.limits.durationMin * 60_000 - (run.activeMs || 0)) : 0,
    };
  }

  return {
    project: { ...total, runsIncludingTest: runRows.length },
    runs: runRows,
    files: topFiles(fileAgg, 12),
    extensions: [...extAgg.entries()].map(([ext, v]) => ({ ext, added: v.added, deleted: v.deleted, files: v.files.size })).sort((a, b) => b.added + b.deleted - (a.added + a.deleted)).slice(0, 10),
    run: runDetail,
  };
}

function addFile(fileAgg, extAgg, file, a, d, runId) {
  const f = fileAgg.get(file) || { added: 0, deleted: 0, runs: new Set() };
  f.added += a;
  f.deleted += d;
  f.runs.add(runId);
  fileAgg.set(file, f);
  const ext = path.extname(file).toLowerCase() || '(no extension)';
  const e = extAgg.get(ext) || { added: 0, deleted: 0, files: new Set() };
  e.added += a;
  e.deleted += d;
  e.files.add(file);
  extAgg.set(ext, e);
}

function topFiles(map, n) {
  return [...map.entries()]
    .map(([file, v]) => ({ file, added: v.added, deleted: v.deleted, runs: v.runs ? v.runs.size : undefined }))
    .sort((a, b) => b.added + b.deleted - (a.added + a.deleted))
    .slice(0, n)
    .map((x) => (x.runs === undefined ? (delete x.runs, x) : x));
}

async function runFiles(store, projectId, run) {
  const m = new Map();
  for (const it of run.iterations || []) {
    const full = await store.getIteration(projectId, run.id, it.n).catch(() => null);
    for (const p of full?.patches || []) {
      if (isGeneratedPath(p.file)) continue;
      const f = m.get(p.file) || { added: 0, deleted: 0 };
      f.added += p.additions || 0;
      f.deleted += p.deletions || 0;
      m.set(p.file, f);
    }
  }
  return m;
}

/** Wall time and tokens per role: from turns.jsonl (new runs) or turn-start/turn-end events (older runs). */
async function roleTimes(store, projectId, run) {
  const out = {};
  const turns = await store.readTurns(projectId, run.id, 100_000).catch(() => []);
  if (turns.length) {
    for (const t of turns) {
      const r = (out[t.role] ||= { ms: 0, turns: 0, tokens: 0 });
      r.ms += Math.max(0, (t.endedAt || 0) - (t.startedAt || 0));
      r.turns++;
      r.tokens += (t.usage?.tokens?.input || 0) + (t.usage?.tokens?.output || 0);
    }
    return out;
  }
  const events = await store.readEvents(projectId, run.id, 200_000).catch(() => []);
  const open = {};
  for (const e of events) {
    if (e.kind === 'turn-start') open[e.role] = e.at;
    if (e.kind === 'turn-end' && open[e.role]) {
      const r = (out[e.role] ||= { ms: 0, turns: 0, tokens: run.usage?.byRole?.[e.role] ? run.usage.byRole[e.role].tokens.input + run.usage.byRole[e.role].tokens.output : 0 });
      r.ms += e.at - open[e.role];
      r.turns++;
      delete open[e.role];
    }
  }
  return out;
}

function countBy(list, fn) {
  const c = {};
  for (const x of list) c[fn(x)] = (c[fn(x)] || 0) + 1;
  return c;
}
