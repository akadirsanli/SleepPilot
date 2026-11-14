/**
 * Task model. Status values (labels are what the UI shows):
 *   pending                 Pending
 *   in_progress             In progress
 *   verified                Implemented and verified      (only set by SleepPilot from executed checks)
 *   implemented_unverified  Implemented, not verified
 *   test_failed             Test failed
 *   blocked                 Blocked
 *   waiting_user            Waiting for the user's decision / permission
 *   cancelled               Cancelled
 */
export const TASK_STATUS_LABELS = {
  pending: 'Pending',
  in_progress: 'In progress',
  verified: 'Implemented and verified',
  implemented_unverified: 'Implemented, not verified',
  test_failed: 'Test failed',
  blocked: 'Blocked',
  waiting_user: 'Waiting for the user',
  cancelled: 'Cancelled',
};

/** Statuses after which the task needs no more work. */
export const FINAL_STATUSES = new Set(['verified', 'implemented_unverified', 'cancelled']);
/** Statuses a model may never assign. */
const MODEL_FORBIDDEN = new Set(['verified', 'implemented_unverified', 'test_failed', 'in_progress']);

export function makeTask(input, { id, objectiveVersion, createdBy = 'manager', improvement = false }) {
  return {
    id,
    title: String(input.title || 'Task').slice(0, 200),
    description: String(input.description || input.title || '').slice(0, 4000),
    type: String(input.type || input.task_type || 'coding').replace(/[^\w-]/g, '').slice(0, 40) || 'coding',
    acceptance: Array.isArray(input.acceptance) ? input.acceptance.map(String).slice(0, 12) : input.acceptance ? [String(input.acceptance)] : [],
    priority: clampPriority(input.priority),
    dependsOn: [],
    status: 'pending',
    attempts: 0,
    failureSignatures: [],
    objectiveVersion,
    createdBy,
    improvement,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    history: [],
    devSessionId: null,
    notes: input.notes ? String(input.notes).slice(0, 2000) : '',
    files: normalizeScope(input.files),
  };
}

/** Project-relative paths/globs a task may edit (used for parallel developers). Empty = unknown. */
export function normalizeScope(files) {
  return (Array.isArray(files) ? files : files ? [files] : [])
    .map((f) => String(f).trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, ''))
    .filter((f) => f && !f.startsWith('/') && !/^[a-z]:/i.test(f) && !f.includes('..'))
    .slice(0, 30);
}

/** Literal part of a scope entry before any wildcard. "ui/*" → "ui/", "tests/test_*.py" → "tests/test_". */
function scopeBase(f) {
  const i = f.search(/[*?]/);
  return i < 0 ? f : f.slice(0, i);
}

/** Two scopes overlap when any entry could name the same file. Conservative: unknown scope overlaps everything. */
export function scopesOverlap(a, b) {
  if (!a?.length || !b?.length) return true;
  for (const x of a) {
    for (const y of b) {
      const bx = scopeBase(x);
      const by = scopeBase(y);
      if (!bx || !by) return true;
      const wild = bx !== x || by !== y;
      if (x === y || x.startsWith(y + '/') || y.startsWith(x + '/')) return true;
      if (wild && (bx.startsWith(by) || by.startsWith(bx))) return true;
    }
  }
  return false;
}

/** Does a changed file belong to a task scope? A plain entry matches itself and everything under it. */
export function inScope(file, scope) {
  return (scope || []).some((f) => {
    if (/[*?]/.test(f)) {
      const re = new RegExp('^' + f.split(/(\*\*|\*|\?)/).map((part) => (part === '**' ? '.*' : part === '*' ? '[^/]*' : part === '?' ? '[^/]' : part.replace(/[.+^${}()|[\]\\]/g, '\\$&'))).join('') + '(/.*)?$');
      return re.test(file);
    }
    return file === f || file.startsWith(f + '/');
  });
}

export function clampPriority(p) {
  const n = Number(p);
  return Number.isFinite(n) ? Math.min(5, Math.max(1, Math.round(n))) : 3;
}

export function setTaskStatus(task, status, note, iteration) {
  if (task.status === status && !note) return;
  task.history.push({ at: Date.now(), from: task.status, to: status, note: note || '', iteration: iteration ?? null });
  task.status = status;
  task.updatedAt = Date.now();
}

/**
 * Apply manager-proposed updates. Enforced invariants:
 *  - verified / implemented tasks are never modified (completed work is preserved);
 *  - a model can only set pending / cancelled / blocked / waiting_user — never "verified".
 */
export function applyTaskUpdates(tasks, updates, iteration) {
  const applied = [];
  for (const u of Array.isArray(updates) ? updates : []) {
    const t = tasks.find((x) => x.id === u.id);
    if (!t || t.status === 'verified' || t.status === 'implemented_unverified') continue;
    if (u.priority != null) t.priority = clampPriority(u.priority);
    if (u.notes) t.notes = String(u.notes).slice(0, 2000);
    if (u.title) t.title = String(u.title).slice(0, 200);
    if (u.description) t.description = String(u.description).slice(0, 4000);
    if (u.files) t.files = normalizeScope(u.files);
    if (u.status && !MODEL_FORBIDDEN.has(u.status) && TASK_STATUS_LABELS[u.status] && u.status !== t.status) {
      setTaskStatus(t, u.status, `Manager: ${u.reason || u.notes || ''}`.trim(), iteration);
    }
    applied.push(u.id);
  }
  return applied;
}

export function resolveDependencies(tasks, rawDeps) {
  // rawDeps: Map<taskId, Array<string|number>> with indexes (1-based in plan order) or titles or ids.
  for (const [id, deps] of rawDeps) {
    const t = tasks.find((x) => x.id === id);
    if (!t) continue;
    t.dependsOn = (deps || [])
      .map((d) => {
        if (typeof d === 'number') return tasks[d - 1]?.id;
        const s = String(d);
        return tasks.find((x) => x.id === s || x.title === s)?.id;
      })
      .filter((d) => d && d !== id);
  }
}

/** Runnable tasks (pending / test failed, dependencies finished), best first. */
export function runnableTasks(tasks) {
  const done = new Set(tasks.filter((t) => FINAL_STATUSES.has(t.status)).map((t) => t.id));
  const candidates = tasks.filter((t) => (t.status === 'pending' || t.status === 'test_failed') && t.dependsOn.every((d) => done.has(d) || !tasks.find((x) => x.id === d)));
  return candidates.sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt);
}

/** Highest-priority pending task whose dependencies are all finished. */
export function selectNextTask(tasks) {
  return runnableTasks(tasks)[0] || null;
}

/**
 * Tasks that may run at the same time: starting with `first`, add runnable tasks whose file
 * scopes overlap neither `first` nor each other, up to `max`. A task without a scope runs alone.
 */
export function selectWave(tasks, first, max) {
  if (!first) return [];
  const wave = [first];
  if (max <= 1 || !first.files?.length) return wave;
  for (const t of runnableTasks(tasks)) {
    if (wave.length >= max) break;
    if (wave.includes(t) || !t.files?.length) continue;
    if (wave.some((w) => scopesOverlap(w.files, t.files))) continue;
    wave.push(t);
  }
  return wave;
}

export function taskCounts(tasks) {
  const c = {};
  for (const t of tasks) c[t.status] = (c[t.status] || 0) + 1;
  return c;
}
