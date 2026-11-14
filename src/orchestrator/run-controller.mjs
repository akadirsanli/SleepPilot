import { EventEmitter } from 'node:events';
import { takeSnapshot, diffSnapshots } from '../project/snapshot.mjs';
import { buildTargetMirror, verifyTargetUnchanged, readMirrorMap } from '../project/target-mirror.mjs';
import { runRecon } from '../reverse/recon.mjs';
import { inspectProject } from '../project/inspect.mjs';
import { isGeneratedPath } from '../project/generated.mjs';
import { gitInfo } from '../project/git.mjs';
import { createBackup } from '../project/backup.mjs';
import { runChecks, verificationFrom } from '../checks/runner.mjs';
import { reconcileTurn } from '../opencode/adapter.mjs';
import { classifyError } from '../opencode/errors.mjs';
import { newMessageId, sha1 } from '../util/ids.mjs';
import { redact } from '../util/redact.mjs';
import { logger } from '../util/log.mjs';
import { extractJson, parseDeveloperStatus } from './json-extract.mjs';
import { developerRuleset, readOnlyRuleset } from './permissions.mjs';
import * as P from './prompts.mjs';
import { makeTask, setTaskStatus, applyTaskUpdates, resolveDependencies, selectNextTask, selectWave, inScope, taskCounts, normalizeScope, clampPriority, FINAL_STATUSES } from './tasks.mjs';
import { HarnessRouter, modelForHarness, RoutingConfigError, READ_ONLY_CAPABLE } from './routing.mjs';
import { QuotaTracker } from './quota-tracker.mjs';

const log = logger('run');

export const STOP_REASONS = {
  objective_completed: 'Objective completed',
  time_limit: 'Time limit reached',
  iteration_limit: 'Iteration limit reached',
  token_limit: 'Token limit reached',
  cost_limit: 'Estimated cost limit reached',
  user_paused: 'Paused by the user',
  user_stopped: 'Stopped by the user',
  waiting_input: 'Waiting for a permission or user input',
  plan_review: 'Waiting for your plan approval',
  quota: 'Provider quota / usage allowance',
  auth: 'Authentication / account error',
  provider_config: 'Model or provider configuration error',
  provider_error: 'Repeated temporary provider error',
  connection_lost: 'Lost the connection to the engine',
  test_failed: 'Test failed',
  repeated_failure: 'Repeated-failure limit reached',
  tasks_blocked: 'Remaining tasks are blocked',
  tasks_need_user: 'Remaining tasks need a user decision',
  app_restarted: 'The app was restarted',
  app_crashed: 'The app closed unexpectedly',
  stalled: 'Stall detected',
  unexpected_error: 'Unexpected error',
};

const TERMINAL = new Set(['completed', 'stopped', 'failed']);
const BACKOFF_MS = [30_000, 60_000, 120_000, 240_000, 480_000];
/** Stop reasons after which the engine is still usable for the closing report. */
const CLOSING_CODES = new Set(['objective_completed', 'time_limit', 'iteration_limit', 'token_limit', 'cost_limit', 'user_stopped', 'test_failed', 'repeated_failure', 'tasks_blocked', 'tasks_need_user']);
/** Pauses that unattended (sleep) mode retries by itself instead of waiting for a person. */
export const AUTO_RETRY_PAUSES = { provider_error: 10 * 60_000, connection_lost: 3 * 60_000, quota: 30 * 60_000, unexpected_error: 5 * 60_000 };
export const MAX_AUTO_RESUMES = 8;

/**
 * How long a running unattended run may go without ANY sign of progress (log entry, activity
 * change, streamed OpenCode event) before the stall watchdog steps in. Generous on purpose: a
 * silent shell command inside a turn is normal, the per-turn cap handles long turns first.
 */
export function stallLimitMs(limits = {}) {
  if (process.env.SLEEPPILOT_STALL_MS) return Number(process.env.SLEEPPILOT_STALL_MS);
  const turn = limits.maxTurnMin > 0 ? limits.maxTurnMin : 45;
  return Math.max(20, turn + 15, (limits.finalGraceMin || 0) + 10) * 60_000;
}
const WATCHDOG_MS = Number(process.env.SLEEPPILOT_WATCHDOG_MS || 15_000);
const OPEN_STATUSES = new Set(['pending', 'test_failed', 'in_progress', 'waiting_user']);
/** Run limits that may be changed while a run is going (see applyLiveSettings). */
export const LIVE_LIMIT_KEYS = ['maxTurnMin', 'overtimeMin', 'overtimeMaxRounds', 'parallelDevelopers', 'durationMin', 'maxIterations', 'maxAttemptsSameFailure', 'maxTokens', 'maxCostUsd', 'improvementMode', 'autoResumeOnQuotaReset', 'reviewerEnabled', 'permissionProfile', 'unattended', 'permissionTimeoutMin', 'scopeMode', 'closingReport', 'language', 'finalGraceMin', 'protectedPaths'];
const LIVE_LABELS = { maxTurnMin: 'Per-turn time limit (min)', overtimeMin: 'Overtime (min)', overtimeMaxRounds: 'Overtime rounds', parallelDevelopers: 'Parallel developers', durationMin: 'Duration (min)', maxIterations: 'Max iterations', maxAttemptsSameFailure: 'Same-failure attempts', maxTokens: 'Token limit', maxCostUsd: 'Cost limit', improvementMode: 'Improvement mode', autoResumeOnQuotaReset: 'Auto-resume after quota reset', reviewerEnabled: 'Reviewer', permissionProfile: 'Permission profile', unattended: 'Unattended', permissionTimeoutMin: 'Permission timeout', scopeMode: 'Scope', closingReport: 'Closing report', language: 'Report language', finalGraceMin: 'Final answer wait', protectedPaths: 'Protected paths' };
const fmtSetting = (v) => (v === null || v === undefined || v === '' ? 'none/unlimited' : v === true ? 'on' : v === false ? 'off' : Array.isArray(v) ? `${v.length} item(s)` : String(v));

class ProviderFailure extends Error {
  constructor(classification, role) {
    super(classification?.message || 'provider failure');
    this.classification = classification;
    this.role = role;
  }
}
class Interrupted extends Error {}

/**
 * Create the persisted record for a new run. When the previous run of this project ended with
 * open tasks, they are carried over (same ids, statuses, attempt history) so a new night
 * continues the backlog instead of planning a different one.
 */
export function newRunRecord({ id, project, previousRun = null }) {
  const s = project.settings;
  const carry = s.carryOverTasks !== false ? carriedTasks(previousRun) : null;
  const samePlan = !!carry && previousRun.objectiveVersion === project.objective.version;
  return {
    id,
    projectId: project.id,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    startedAt: null,
    endedAt: null,
    state: 'created',
    stopReason: null,
    pause: null,
    limits: {
      durationMin: s.durationMin,
      maxIterations: s.maxIterations,
      maxAttemptsSameFailure: s.maxAttemptsSameFailure,
      maxTokens: s.maxTokens,
      maxCostUsd: s.maxCostUsd,
      improvementMode: s.improvementMode,
      autoResumeOnQuotaReset: s.autoResumeOnQuotaReset,
      reviewerEnabled: s.reviewerEnabled,
      sessionPolicy: s.sessionPolicy,
      permissionProfile: s.permissionProfile,
      models: s.models,
      agents: s.agents,
      unattended: !!s.unattended,
      permissionTimeoutMin: s.unattended && !s.permissionTimeoutMin ? 2 : s.permissionTimeoutMin ?? 5,
      scopeMode: s.scopeMode || 'strict',
      closingReport: s.closingReport !== false,
      language: s.language || 'en',
      finalGraceMin: s.finalGraceMin === undefined ? 30 : s.finalGraceMin,
      protectedPaths: s.protectedPaths || [],
      parallelDevelopers: s.parallelDevelopers || 1,
      overtimeMin: s.overtimeMin || 0,
      maxTurnMin: s.maxTurnMin === undefined ? 60 : s.maxTurnMin,
      workingWindowHours: s.harnessRouting?.workingWindowHours || 10,
      planReview: !!s.planReview,
      overtimeMaxRounds: s.overtimeMaxRounds || 1,
    },
    overtimeUsed: 0,
    objectiveVersionAtStart: project.objective.version,
    objectiveVersion: project.objective.version,
    activeMs: 0,
    activeSince: null,
    planned: samePlan,
    plan: samePlan ? { ...(previousRun.plan || {}), carriedFrom: previousRun.id } : null,
    tasks: carry ? carry.tasks : [],
    nextTaskNumber: carry ? previousRun.nextTaskNumber || carry.tasks.length + 1 : 1,
    carriedOver: carry ? { fromRunId: previousRun.id, open: carry.open, total: carry.tasks.length, samePlan } : null,
    iterationCount: 0,
    iterations: [],
    steering: [],
    usage: emptyUsage(),
    goUsage: null,
    sessions: { manager: null, reviewer: null },
    pending: { permissions: [], forms: [] },
    activity: { phase: 'idle', message: '' },
    activeTurn: null,
    activeTurns: {},
    currentIteration: null,
    forceNextTaskId: null,
    improvementRounds: 0,
    backup: null,
    gitAtStart: null,
    consecutiveProviderErrors: 0,
    autoResumes: 0,
    autoAnswered: [],
    preflight: null,
    lineStats: null,
    closingReport: null,
    opencode: null,
    activeHarness: null,
    routingSwitches: [],
    sessionRoutes: {},
    routingConfig: null,
    quota: null,
  };
}

function carriedTasks(prev) {
  if (!prev?.tasks?.length) return null;
  const open = prev.tasks.filter((t) => OPEN_STATUSES.has(t.status)).length;
  if (!open) return null;
  const tasks = structuredClone(prev.tasks).map((t) => {
    t.devSessionId = null;
    if (t.status === 'in_progress' || t.status === 'waiting_user') setTaskStatus(t, 'pending', `Carried over from the previous run (${prev.id}).`, 0);
    return t;
  });
  return { tasks, open };
}

const emptyRole = () => ({ cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, turns: 0 });

function emptyUsage() {
  return { cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, byRole: { manager: emptyRole(), developer: emptyRole(), reviewer: emptyRole() }, models: {} };
}

export class RunController extends EventEmitter {
  constructor({ store, adapter, project, run, engineManager = null, routing = null, modelProfiles = null, rolePins = null, quota = null }) {
    super();
    this.store = store;
    this.adapter = adapter;
    this.project = project;
    this.run = run;
    this.engineManager = engineManager;
    this.routing = routing || project?.settings?.harnessRouting || null;
    this.modelProfiles = modelProfiles || project?.settings?.modelProfiles || null;
    this.rolePins = rolePins || project?.settings?.rolePins || null;
    this.router = new HarnessRouter({
      harnessRouting: this.routing,
      modelProfiles: this.modelProfiles,
      rolePins: this.rolePins,
      defaultEngine: adapter?.id || 'opencode',
    });
    this.adapters = new Map();
    if (adapter) this.adapters.set(adapter.id || 'opencode', adapter);
    this.sessionHarness = new Map();
    this.quota = quota || new QuotaTracker({ routing: this.routing, state: run.quota, now: Date.now() });
    if (quota && run.quota) this.quota.rehydrate(run.quota);
    run.activeHarness ||= this.adapter?.id || 'opencode';
    run.routingSwitches ||= [];
    run.sessionRoutes ||= {};
    run.routingConfig ||= { routing: this.routing, modelProfiles: this.modelProfiles, rolePins: this.rolePins };
    this.logBuffer = [];
    this.control = { pause: null, stop: null };
    this.resumeWaiters = [];
    this.activeTurns = new Map(); // sessionID -> { role, sessionID, tag, interruptReason }
    this.loopPromise = null;
    this.textBuffers = new Map();
    this.saveQueue = Promise.resolve();
    this.lastProgressAt = Date.now();
    this.stallStage = 0;
  }

  // ------------------------------------------------------------------ public API

  get engineName() {
    return this.adapterForHarness(this.run.activeHarness)?.label || this.adapter?.label || 'the engine';
  }

  get activeHarness() {
    return this.run.activeHarness || this.adapter?.id || 'opencode';
  }

  /** Engines that can enforce a read-only role at the adapter/sandbox level. */
  readOnlyCapable(id) {
    return READ_ONLY_CAPABLE.includes(id);
  }

  adapterForHarness(id) {
    if (!id) return this.adapter;
    if (this.adapters.has(id)) return this.adapters.get(id);
    const found = this.engineManager?.engines?.get(id) || null;
    if (found) this.adapters.set(id, found);
    return found;
  }

  async ensureHarness(id) {
    let engine = this.adapterForHarness(id);
    if (!engine && this.engineManager) engine = this.engineManager.get(id);
    if (!engine || !engine.id) throw new Error(`Harness "${id}" is not registered.`);
    if (!engine.connected) {
      if (!this.engineManager) throw new Error(`Harness "${id}" is not connected.`);
      await this.engineManager.connect(id);
    }
    if (!engine.connected) throw new Error(`${engine.label} (${id}) is not available: ${engine.status?.message || 'not connected'}`);
    this.adapters.set(id, engine);
    return engine;
  }

  routesFor(role, taskType = null) {
    this.router.harnessRouting = this.routing;
    this.router.modelProfiles = this.modelProfiles;
    this.router.rolePins = this.rolePins;
    this.router.defaultEngine = this.adapter?.id || 'opencode';
    return this.router.routesFor(role, taskType);
  }

  /** First route that is allowed by the quota tracker and can enforce the role. */
  routeFor(role, taskType = null, { exclude = [] } = {}) {
    const routes = this.routesFor(role, taskType);
    for (const route of routes) {
      if (exclude.includes(route.harness)) continue;
      if (role !== 'developer' && !this.readOnlyCapable(route.harness)) continue;
      if (!this.quota.canUse(route.harness).ok) continue;
      return route;
    }
    const next = this.quota.nextAvailable();
    const label = next ? `${next.harness} is unavailable until ${new Date(next.until).toISOString()}` : 'no configured harness can enforce this role';
    const err = new ProviderFailure({
      category: 'quota',
      action: 'pause',
      label: 'No usable harness',
      message: `No usable harness for ${role}: ${label}. Configure harnessRouting/modelProfiles/rolePins or wait for the quota window.`,
      hint: 'SleepPilot will not silently downgrade effort or bypass a read-only requirement.',
    }, role);
    err.code = 'ALL_HARNESSES_BLOCKED';
    if (next?.until) err.classification.resetsAt = next.until;
    throw err;
  }

  sessionRoute(sessionID) {
    const r = this.sessionHarness.get(sessionID);
    if (r) return r;
    const fromRun = Object.values(this.run.sessionRoutes || {}).find((x) => x?.sessionID === sessionID);
    if (fromRun) {
      this.sessionHarness.set(sessionID, fromRun);
      return fromRun;
    }
    // Developer sessions are task-scoped and parallel developers may use different harnesses.
    const devTask = (this.run.tasks || []).find((t) => t.devSessionId === sessionID);
    if (devTask?.devHarness) {
      const record = { harness: devTask.devHarness, modelProfile: devTask.devModelProfile || null, model: null, effort: null, fallbackStep: 0, sessionID, taskId: devTask.id };
      this.sessionHarness.set(sessionID, record);
      return record;
    }
    const reviewTask = (this.run.tasks || []).find((t) => t.reviewSession?.id === sessionID);
    if (reviewTask?.reviewSession?.harness) {
      const record = { harness: reviewTask.reviewSession.harness, modelProfile: reviewTask.reviewSession.modelProfile || null, model: null, effort: null, fallbackStep: 0, sessionID, taskId: reviewTask.id };
      this.sessionHarness.set(sessionID, record);
      return record;
    }
    return { harness: this.adapter?.id || 'opencode', modelProfile: null, model: null, effort: null, fallbackStep: 0, sessionID };
  }

  registerSession(role, session, route, extra = {}) {
    const record = { ...route, sessionID: session.id, ...extra };
    this.sessionHarness.set(session.id, record);
    this.run.sessionRoutes[role] = record;
    this.run.sessions[role] = session.id;
    this.run.activeHarness = route.harness;
    return record;
  }

  /** Create a role session on the routed harness. Developer sessions are task-scoped. */
  async createRoleSession(role, route, { title, task = null } = {}) {
    const adapter = await this.ensureHarness(route.harness);
    const readOnly = role !== 'developer';
    const legacyModel = this.run.limits.models?.[role === 'closing' ? 'manager' : role] || null;
    const session = await adapter.createSession({
      directory: this.project.dir,
      title,
      model: modelForHarness(route.harness, route.model) || (route.harness === this.adapter?.id ? legacyModel : null) || undefined,
      agent: this.run.limits.agents?.[role] || undefined,
      effort: route.effort || null,
      readOnly,
      permissions: readOnly ? readOnlyRuleset() : developerRuleset(this.run.limits.permissionProfile, {
        unattended: this.run.limits.unattended,
        protectedPaths: this.run.limits.protectedPaths,
        projectDir: this.project.dir,
        editScope: task?.files || [],
      }),
    });
    return { session, route, adapter };
  }

  recordSwitch(role, from, to, reason) {
    const entry = { at: Date.now(), role, from: from?.harness || from || null, to: to?.harness || to || null, fromProfile: from?.modelProfile || null, toProfile: to?.modelProfile || null, reason: redact(String(reason || '')).slice(0, 1000), iteration: this.run.currentIteration || null };
    (this.run.routingSwitches ||= []).push(entry);
    this.addLog({ kind: 'routing', role, text: `Harness switch: ${entry.from || 'none'} → ${entry.to || 'none'}${entry.toProfile ? ` (${entry.toProfile})` : ''} — ${entry.reason}` });
  }

  /** Next route after a failure, respecting quota and read-only capability. */
  nextRoute(role, taskType, currentHarness, attempted = []) {
    const routes = this.routesFor(role, taskType);
    for (const route of routes) {
      if (route.harness === currentHarness || attempted.includes(route.harness)) continue;
      if (role !== 'developer' && !this.readOnlyCapable(route.harness)) continue;
      if (!this.quota.canUse(route.harness).ok) continue;
      return route;
    }
    return null;
  }

  quotaSnapshot() {
    this.run.quota = this.quota.snapshot();
    return this.run.quota;
  }

  /** The most recently started agent turn (any role), or null. */
  get activeTurnSession() {
    let last = null;
    for (const v of this.activeTurns.values()) last = v;
    return last;
  }

  get terminal() {
    return TERMINAL.has(this.run.state);
  }

  async start() {
    if (this.loopPromise) return;
    const run = this.run;
    run.startedAt = run.startedAt || Date.now();
    const engine = this.adapter;
    run.engine ||= { id: engine.id || 'opencode', label: engine.label || 'OpenCode', version: engine.serverInfo?.version || engine.status?.version || engine.detection?.version?.raw || null };
    run.activeHarness ||= engine.id || 'opencode';
    run.routingConfig ||= { routing: this.routing, modelProfiles: this.modelProfiles, rolePins: this.rolePins };
    run.opencode = { version: run.engine.version, source: engine.detection?.source, testMode: !!engine.testCommand };
    this.setActivity('preparing', 'Preparing the project…');
    this.setState('running');
    this.markActive(true);
    this.loopPromise = this.loop().finally(() => (this.loopPromise = null));
  }

  /** Default pause: finish the current iteration, then wait. immediate=true interrupts OpenCode. */
  async requestPause({ immediate = false } = {}) {
    if (this.terminal) return;
    this.control.pause = { immediate, at: Date.now() };
    this.addLog({ kind: 'control', text: immediate ? 'Pause requested: the current operation is interrupted now.' : 'Pause requested: pausing after the current iteration.' });
    if (immediate) await this.interruptActive('user_paused');
    this.persist();
  }

  async resume() {
    if (this.terminal) return;
    // The user resumed a quota pause: this is an explicit override of the recorded window.
    if (this.run.pause?.code === 'quota') {
      this.quota.clear();
      this.quotaSnapshot();
    }
    this.control.pause = null;
    this.lastProgressAt = Date.now();
    this.stallStage = 0;
    if (this.run.state === 'paused' || this.run.state === 'waiting_user') {
      this.addLog({ kind: 'control', text: 'Resuming.' });
      this.run.pause = null;
      this.setState('running');
      this.markActive(true);
    }
    const w = this.resumeWaiters.splice(0);
    w.forEach((fn) => fn());
    if (!this.loopPromise) {
      // Recovered run (after app restart) — the loop is not running yet.
      this.loopPromise = this.loop().finally(() => (this.loopPromise = null));
    }
  }

  async requestStop({ immediate = false } = {}) {
    if (this.terminal) return;
    this.control.stop = { immediate, at: Date.now() };
    this.addLog({ kind: 'control', text: immediate ? 'Stop requested: the current operation is interrupted now.' : 'Stop requested: stopping after the current iteration.' });
    if (immediate) await this.interruptActive('user_stopped');
    const w = this.resumeWaiters.splice(0);
    w.forEach((fn) => fn());
    if (!this.loopPromise && !this.terminal) await this.finish('user_stopped');
    this.persist();
  }

  /** Queue a steering instruction. mode: 'after_iteration' | 'interrupt_now'. */
  async steer({ text, mode = 'after_iteration' }) {
    const clean = String(text || '').trim();
    if (!clean) throw new Error('The instruction cannot be empty.');
    let effectiveMode = mode;
    let note = '';
    if (mode === 'interrupt_now' && !this.adapterForHarness(this.activeHarness)?.client?.has('session.interrupt')) {
      effectiveMode = 'after_iteration';
      note = `This ${this.engineName} version cannot interrupt; the instruction is applied after the current iteration.`;
    }
    const item = { id: `S${this.run.steering.length + 1}`, text: clean, mode: effectiveMode, requestedMode: mode, status: 'pending', createdAt: Date.now(), note };
    this.run.steering.push(item);
    this.addLog({ kind: 'steer', text: `New instruction received (${effectiveMode === 'interrupt_now' ? 'apply now' : 'after the iteration'}): ${clean}${note ? ' — ' + note : ''}` });
    if (effectiveMode === 'interrupt_now' && [...this.activeTurns.values()].some((a) => a.role === 'developer')) await this.interruptActive('steering', { onlyRole: 'developer' });
    // An instruction answers a "waiting for your decision" pause.
    // (Plan review is approved explicitly, not by an instruction.)
    if (this.run.pause?.code !== 'plan_review' && (this.run.state === 'waiting_user' || (this.run.state === 'paused' && this.run.pause?.code === 'waiting_input'))) await this.resume();
    await this.persist();
    return item;
  }

  /**
   * Change run settings while the run is going. Limits apply at once (the loop re-checks them
   * before every step); models/agents of Manager/Reviewer apply from their next turn (a new
   * session is opened), the Developer's model/agent/permissions from its next session. A turn that
   * is already running is never changed or interrupted.
   */
  async applyLiveSettings(patch = {}) {
    const l = this.run.limits;
    const changed = [];
    const key = (m) => (m ? `${m.providerID}/${m.id}` : 'default');
    for (const k of LIVE_LIMIT_KEYS) {
      if (!(k in patch) || patch[k] === undefined) continue;
      if (JSON.stringify(l[k]) === JSON.stringify(patch[k])) continue;
      changed.push(`${LIVE_LABELS[k] || k}: ${fmtSetting(l[k])} → ${fmtSetting(patch[k])}`);
      l[k] = patch[k];
    }
    for (const group of ['models', 'agents']) {
      if (!patch[group]) continue;
      for (const role of ['manager', 'developer', 'reviewer']) {
        if (!(role in patch[group])) continue;
        const a = l[group]?.[role] ?? null;
        const b = patch[group][role] ?? null;
        if (JSON.stringify(a) === JSON.stringify(b)) continue;
        l[group] = { ...l[group], [role]: b };
        changed.push(`${roleLabel(role)} ${group === 'models' ? 'model' : 'agent'}: ${group === 'models' ? key(a) : a || 'default'} → ${group === 'models' ? key(b) : b || 'default'}`);
        if (role === 'developer') this.resetDeveloperSessions();
        else this.run.sessions[role] = null;
      }
    }
    for (const key of ['harnessRouting', 'modelProfiles', 'rolePins']) {
      if (!(key in patch) || patch[key] === undefined) continue;
      if (JSON.stringify(this[key]) === JSON.stringify(patch[key])) continue;
      this[key] = patch[key];
      changed.push(`${key}: updated`);
      this.run.sessions.manager = null;
      this.run.sessions.reviewer = null;
      this.resetDeveloperSessions();
    }
    if (changed.some((c) => /^(Permission profile|Unattended|Protected|harnessRouting|modelProfiles|rolePins)/.test(c))) this.resetDeveloperSessions();
    if (changed.length) {
      this.run.routingConfig = { routing: this.routing, modelProfiles: this.modelProfiles, rolePins: this.rolePins };
      if (this.quota) this.quota.routing = this.routing;
    }
    if (l.unattended && !l.permissionTimeoutMin) l.permissionTimeoutMin = 2;
    if (!changed.length) return { changed };
    this.addLog({ kind: 'control', text: `Settings changed during the run: ${changed.join('; ')}` });
    (this.run.settingChanges ||= []).push({ at: Date.now(), changes: changed, afterIteration: this.run.iterationCount });
    // A shorter limit or a lifted pause reason is picked up by the loop; wake a waiting loop.
    await this.persist();
    return { changed };
  }

  /** Next developer turn of every open task starts in a new session with the current settings. */
  resetDeveloperSessions() {
    for (const t of this.run.tasks) if (t.status !== 'in_progress') t.devSessionId = null;
  }

  async replyPermission(requestId, decision) {
    const p = this.run.pending.permissions.find((x) => x.id === requestId);
    if (!p) throw new Error('Permission request not found (it may already be answered).');
    if (!['once', 'always', 'reject'].includes(decision)) throw new Error('Invalid decision.');
    await this.adapterForHarness(this.sessionRoute(p.sessionID).harness).replyPermission(p.sessionID, requestId, decision);
    this.run.pending.permissions = this.run.pending.permissions.filter((x) => x.id !== requestId);
    this.addLog({ kind: 'permission', text: `Permission answered: ${p.action} ${p.resources?.join(' ') || ''} → ${decision === 'once' ? 'allowed once' : decision === 'always' ? 'always for this session' : 'rejected'}` });
    this.afterPendingChange();
  }

  /**
   * "Show me the plan before starting": after planning, wait until the user approved (and maybe
   * edited) the task list. Asked for in the setup, so a person is there at the start.
   */
  async reviewPlanIfAsked() {
    const run = this.run;
    if (!run.limits.planReview || run.planApproved || !run.planned || this.control.stop) return;
    this.addLog({ kind: 'plan', text: `The plan is ready (${run.tasks.length} tasks). Review and edit it on the Tasks screen, then click “Approve plan and start”.` });
    await this.pauseFor('plan_review', `The ${run.tasks.length}-task plan is waiting for your approval. Edit it on the Tasks screen, then approve it.`);
    run.planApproved = !this.control.stop;
    if (run.planApproved) this.addLog({ kind: 'plan', text: 'Plan approved; the run is starting.' });
    await this.persist();
  }

  /** User edit of a task that is not being worked on right now. */
  async editTask(taskId, patch = {}) {
    const t = this.run.tasks.find((x) => x.id === taskId);
    if (!t) throw new Error('Task not found.');
    if (t.status === 'in_progress') throw new Error('A task in progress cannot be edited; try again after the iteration.');
    const changes = [];
    if (patch.title != null && String(patch.title).trim()) {
      t.title = String(patch.title).trim().slice(0, 200);
      changes.push('title');
    }
    if (patch.description != null) {
      t.description = String(patch.description).slice(0, 4000);
      changes.push('description');
    }
    if (patch.priority != null) {
      t.priority = clampPriority(patch.priority);
      changes.push(`priority P${t.priority}`);
    }
    if (patch.files != null) {
      t.files = normalizeScope(Array.isArray(patch.files) ? patch.files : String(patch.files).split(/[\n,]+/));
      t.devSessionId = null;
      changes.push('file scope');
    }
    if (patch.action === 'cancel' && t.status !== 'cancelled') {
      setTaskStatus(t, 'cancelled', 'Cancelled by the user.', this.run.iterationCount);
      changes.push('cancelled');
    }
    if (patch.action === 'reopen' && ['cancelled', 'blocked', 'test_failed', 'implemented_unverified', 'waiting_user'].includes(t.status)) {
      setTaskStatus(t, 'pending', 'Reopened by the user.', this.run.iterationCount);
      t.attempts = 0;
      t.failureSignatures = [];
      t.timeouts = 0;
      t.blockedReason = null;
      changes.push('reopened');
    }
    if (patch.action === 'first') {
      this.run.forceNextTaskId = t.id;
      t.priority = 1;
      changes.push('next task');
    }
    if (!changes.length) return t;
    this.addLog({ kind: 'plan', text: `The user edited task [${t.id}]: ${changes.join(', ')}.` });
    await this.persist();
    return t;
  }

  async addUserTask(patch = {}) {
    if (!String(patch.title || '').trim()) throw new Error('A task title is required.');
    const [t] = this.addTasks([{ title: patch.title, description: patch.description || patch.title, priority: patch.priority ?? 2, files: patch.files ? String(patch.files).split(/[\n,]+/) : undefined, acceptance: [] }], { createdBy: 'user' });
    this.addLog({ kind: 'plan', text: `The user added a task: [${t.id}] ${t.title}` });
    // A finished-early loop may already be past the task list; nothing else is needed: the next
    // loop round picks it up.
    await this.persist();
    return t;
  }

  async replyForm(formId, answer) {
    const f = this.run.pending.forms.find((x) => x.id === formId);
    if (!f) throw new Error('Question not found (it may already be answered).');
    await this.adapterForHarness(this.sessionRoute(f.sessionID).harness).replyForm(f.sessionID, formId, answer);
    this.run.pending.forms = this.run.pending.forms.filter((x) => x.id !== formId);
    this.addLog({ kind: 'form', text: `Question answered: ${f.title}` });
    this.afterPendingChange();
  }

  /** Data sent to the UI. Everything is real persisted/live state. */
  view() {
    const r = this.run;
    return {
      ...r,
      elapsedActiveMs: this.elapsedActive(),
      remainingMs: r.limits.durationMin ? Math.max(0, r.limits.durationMin * 60_000 - this.elapsedActive()) : null,
      timeUp: this.timeUp(),
      control: this.control,
      taskCounts: taskCounts(r.tasks),
      live: !!this.loopPromise,
    };
  }

  // ------------------------------------------------------------------ main loop

  async loop() {
    const watchdog = setInterval(() => {
      this.watchPending().catch((err) => log.warn(`watchdog: ${err.message}`));
      this.checkStall().catch((err) => log.warn(`stall watchdog: ${err.message}`));
    }, WATCHDOG_MS);
    watchdog.unref?.();
    try {
      for (;;) {
        try {
          return await this.runLoop();
        } catch (err) {
          log.error(`run loop crashed: ${err.stack || err.message}`);
          this.addLog({ kind: 'error', text: `Unexpected error: ${redact(err.message)}` });
          if (this.terminal) return;
          // Sleep mode: an unexpected error must not end the night. Pause, retry by itself
          // (bounded); a turn in flight is reconciled from OpenCode's records, never resubmitted.
          if (this.run.limits.unattended && this.run.autoResumes < MAX_AUTO_RESUMES && !this.control.stop) {
            await this.pauseFor('unexpected_error', `${redact(err.message)}\nSleep mode: the run was not ended; it is retried where it left off after a short wait.`);
            if (this.control.stop) return await this.finish('user_stopped');
            continue;
          }
          return await this.finish('unexpected_error', redact(err.message));
        }
      }
    } finally {
      clearInterval(watchdog);
    }
  }

  async runLoop() {
    const run = this.run;
    {
      if (!run.backup && !run.gitAtStart) await this.prepare();
      while (!run.preflight && !this.control.stop) {
        if ((await this.withProviderHandling(() => this.preflightModels())) !== 'retry') break;
      }
      if (run.activeTurn || Object.keys(run.activeTurns || {}).length) await this.recoverActiveTurn();
      await this.recoverOrphans();
      if (!run.planned) await this.withProviderHandling(() => this.planPhase());
      await this.reviewPlanIfAsked();
      for (;;) {
        if (await this.handleControl()) return;
        const lim = this.limitReached();
        if (lim) return await this.finish(lim);
        if (!(await this.quotaGate())) continue;
        const steered = await this.withProviderHandling(() => this.applySteering());
        if (steered === 'retry') continue;
        if (!run.planned) {
          await this.withProviderHandling(() => this.planPhase());
          continue;
        }
        const task = this.pickTask();
        if (!task) {
          const finished = await this.withProviderHandling(() => this.noRunnableTask());
          if (finished === true) return;
          continue;
        }
        const wave = this.pickWave(task);
        await this.withProviderHandling(() => (wave.length > 1 ? this.iterateWave(wave) : this.iterate(task)));
      }
    }
  }

  /** Run fn; provider failures become backoff or a pause, never an endless retry loop. */
  async withProviderHandling(fn) {
    try {
      const r = await fn();
      this.run.consecutiveProviderErrors = 0;
      return r;
    } catch (err) {
      if (err instanceof Interrupted) return 'retry';
      let cls = err instanceof ProviderFailure ? err.classification : null;
      if (!cls && err instanceof RoutingConfigError) cls = { category: 'config', action: 'pause', label: 'Routing configuration error', message: err.message };
      if (!cls && (err.name === 'OpenCodeConnectionError' || err.name === 'OpenCodeHttpError' || err.code === 'CONNECTION_LOST')) cls = classifyError(err);
      if (!cls) throw err;
      if (err.code === 'CONNECTION_LOST') {
        await this.pauseFor('connection_lost', `The ${this.engineName} connection did not come back. ${redact(err.message)}`);
        return 'retry';
      }
      this.addLog({ kind: 'error', text: `${cls.label}: ${redact(cls.message)}${cls.hint ? ' — ' + cls.hint : ''}` });
      if (err instanceof ProviderFailure) this.noteRoleFailure(err.role);
      if (cls.action === 'retry') {
        const n = ++this.run.consecutiveProviderErrors;
        if (n > BACKOFF_MS.length) {
          await this.pauseFor('provider_error', `Still a temporary error after ${n - 1} attempts: ${redact(cls.message)}`);
          return 'retry';
        }
        const delay = Number(process.env.SLEEPPILOT_BACKOFF_SCALE || 1) * BACKOFF_MS[n - 1];
        this.setActivity('backoff', `${cls.label}. Retrying in ${Math.round(delay / 1000)} s (attempt ${n}/${BACKOFF_MS.length}).`);
        await this.sleepInterruptible(delay);
        return 'retry';
      }
      const code = { quota: 'quota', auth: 'auth', config: 'provider_config', content_filter: 'provider_config' }[cls.category] || 'unexpected_error';
      await this.pauseFor(code, `${cls.label}: ${redact(cls.message)}${cls.hint ? '\n' + cls.hint : ''}`, { resetsAt: cls.resetsAt || null });
      return 'retry';
    }
  }

  /**
   * A Manager/Reviewer model that keeps failing (e.g. a provider whose stream breaks off) is
   * replaced by the Developer model for the rest of the run, so one flaky model cannot stall it.
   */
  noteRoleFailure(role) {
    const run = this.run;
    if (!role || role === 'developer') return;
    // With explicit routing the fallback chain chooses the replacement; legacy model downgrades
    // would not affect the pinned model profile and would only make the run record misleading.
    if (this.routing?.enabled) return;
    const f = (run.roleFailures ||= {});
    f[role] = (f[role] || 0) + 1;
    const key = (m) => (m ? `${m.providerID}/${m.id}` : 'default');
    const cur = run.limits.models?.[role];
    const dev = run.limits.models?.developer;
    if (f[role] >= 2 && key(cur) !== key(dev)) {
      run.limits.models = { ...run.limits.models, [role]: dev || null };
      run.sessions[role] = null;
      f[role] = 0;
      this.addLog({ kind: 'warning', text: `The ${roleLabel(role)} model (${key(cur)}) failed repeatedly; the Developer model (${key(dev)}) is used for the ${roleLabel(role)} for the rest of this run.` });
    }
  }

  async prepare() {
    const run = this.run;
    this.setActivity('preparing', 'Checking Git status and backup…');
    run.gitAtStart = await gitInfo(this.project.dir);
    if (run.gitAtStart.isRepo && run.gitAtStart.dirty) {
      this.addLog({ kind: 'warning', text: `The project has ${run.gitAtStart.changeCount} uncommitted change(s). SleepPilot never deletes or reverts them; the agent may change these files.` });
    }
    if (this.project.settings.backupBeforeRun) {
      this.setActivity('preparing', 'Backing up the project…');
      run.backup = await createBackup(this.project.id, this.project.dir);
      this.addLog({ kind: run.backup.ok ? 'info' : 'warning', text: run.backup.ok ? `Backup taken: ${run.backup.path} (${run.backup.files} files). Coverage: ${run.backup.coverage}.` : `Backup failed: ${run.backup.error}` });
    } else {
      run.backup = { ok: false, skipped: true };
    }
    if (run.carriedOver) {
      this.addLog({ kind: 'plan', text: `Carried over ${run.carriedOver.total} task(s) from the previous run (${run.carriedOver.open} open).${run.carriedOver.samePlan ? ' The objective is unchanged, so no re-planning; continuing with the remaining tasks.' : ' The objective changed, so the manager re-plans taking these tasks into account.'}` });
    }
    if (this.project.reverse?.targetDir) await this.refreshTargetMirror();
    // Baseline for the closing report's "what changed during the whole run" numbers.
    this.setActivity('preparing', 'Taking the start snapshot of the project files…');
    this.baseline = await takeSnapshot(this.project.dir);
    await this.persist();
  }

  /**
   * Sleep & Reverse: rebuild the read-only mirror of the target so the agent analyses the
   * current program, and remember the target's hashes to prove at the end that nothing in it
   * was modified (see verifyReverseTarget).
   */
  async refreshTargetMirror() {
    const run = this.run;
    this.setActivity('preparing', 'Mirroring and re-scanning the analysis target (read-only)…');
    try {
      const targetIsFile = !!this.project.reverse.targetIsFile;
      const target = this.project.reverse.targetPath || this.project.reverse.targetDir;
      const map = await buildTargetMirror({
        targetDir: targetIsFile ? undefined : this.project.reverse.targetDir,
        targetFile: targetIsFile ? target : undefined,
        workDir: this.project.dir,
      });
      let recon = null;
      try {
        recon = await runRecon({ targetPath: target, workDir: this.project.dir, map });
      } catch (err) {
        this.addLog({ kind: 'warning', text: `Reconnaissance could not be refreshed: ${redact(err.message)}` });
      }
      const blobs = map.files.reduce((a, f) => a + (f.longLines?.length || 0), 0);
      run.reverse = {
        targetDir: this.project.reverse.targetDir,
        targetPath: target,
        files: map.files.length,
        bytes: map.files.reduce((a, f) => a + f.bytes, 0),
        mirrored: map.files.filter((f) => f.mirrored).length,
        blobs,
        binaries: recon?.binaries ?? null,
        builtAt: map.builtAt,
      };
      this.project.reverse.files = map.files.length;
      this.project.reverse.binaries = recon?.binaries ?? this.project.reverse.binaries;
      this.project.reverse.builtAt = map.builtAt;
      await this.store.saveProject(this.project);
      this.addLog({ kind: 'info', text: `Target mirrored: ${run.reverse.files} file(s), ${run.reverse.mirrored} readable text file(s), ${run.reverse.binaries ?? 0} binary file(s), ${blobs} over-long line(s)/embedded blob(s) summarised. The agent reads _target/ and _recon/; the target itself stays out of its reach.` });
    } catch (err) {
      this.addLog({ kind: 'warning', text: `Could not mirror the target: ${redact(err.message)}. The previous mirror (if any) is used.` });
    }
  }

  /** Sleep & Reverse: compare the target with the hashes recorded when the run started. */
  async verifyReverseTarget() {
    const run = this.run;
    if (!run.reverse) return;
    const map = await readMirrorMap(this.project.dir);
    if (!map) return;
    const r = await verifyTargetUnchanged(map);
    run.reverseIntegrity = { at: Date.now(), files: r.files, changed: r.changed, missing: r.missing, ok: r.ok };
    this.addLog({ kind: r.ok ? 'info' : 'warning', text: r.ok ? `Target integrity verified: all ${r.files} file(s) of the target are unchanged (SHA-1).` : `Target CHANGED during the run: ${[...r.changed, ...r.missing.map((f) => f + ' (missing)')].slice(0, 20).join(', ')}` });
  }

  /**
   * Before a long unattended run, send each selected model a one-line request. A wrong model or
   * provider setting is then reported while the user is still at the computer, not at 3 a.m.
   * A failing Manager/Reviewer model falls back to the Developer model.
   */
  async preflightModels() {
    const run = this.run;
    const roles = run.limits.reviewerEnabled ? ['developer', 'manager', 'reviewer'] : ['developer', 'manager'];
    this.setActivity('preparing', 'Trying the routed harness/model profiles with a short request…');
    const results = {};
    const routesUsed = {};
    for (const role of roles) {
      let route;
      try {
        route = this.routeFor(role, role === 'manager' ? 'planning' : role === 'reviewer' ? 'review' : 'coding');
      } catch (err) {
        if (role === 'developer') throw err;
        this.addLog({ kind: 'warning', role, text: `No usable harness for the ${roleLabel(role)}: ${err.message}` });
        continue;
      }
      const attempted = [];
      let checked = null;
      for (;;) {
        const key = `${route.harness}/${route.modelProfile || 'default'}`;
        if (results[key]) {
          checked = { ...results[key], route };
          break;
        }
        let turn;
        try {
          const { session } = await this.createRoleSession(role, route, {
            title: `SleepPilot · ${this.project.name} · model check`,
          });
          turn = await this.ensureHarness(route.harness).then((adapter) => adapter.runTurn({
            sessionID: session.id,
            text: 'SleepPilot model check. Reply with exactly: OK',
            metadata: { role: 'preflight', runId: run.id, harness: route.harness, modelProfile: route.modelProfile, readOnly: true },
          }));
        } catch (err) {
          turn = { status: 'failed', errors: [{ type: 'provider.config', message: err.message, classification: { category: 'config', action: 'pause', label: 'Model check failed', message: err.message } }] };
        }
        this.addUsage('preflight', turn.usage);
        const err = turn.errors?.find((e) => e.classification);
        const item = { ok: turn.status === 'succeeded', error: err ? `${err.classification.label}: ${err.message || ''}`.slice(0, 300) : null, classification: err?.classification || null, harness: route.harness, modelProfile: route.modelProfile, model: route.model };
        this.quota.observe(route.harness, { result: turn, classification: err?.classification || null, quota: turn.quota });
        results[key] = item;
        this.addLog({ kind: item.ok ? 'info' : 'warning', role, text: `Model check ${key}: ${item.ok ? 'working' : 'FAILED — ' + (item.error || turnStatusLabel(turn.status))}` });
        if (item.ok) {
          checked = { ...item, route };
          break;
        }
        attempted.push(route.harness);
        const next = this.nextRoute(role, role === 'manager' ? 'planning' : role === 'reviewer' ? 'review' : 'coding', route.harness, attempted);
        if (!next) {
          checked = { ...item, route };
          break;
        }
        this.recordSwitch(role, route, next, `preflight ${key} failed`);
        route = next;
      }
      if (checked) routesUsed[role] = checked;
      if (!checked) continue;
      if (role !== 'developer') {
        // Keep the legacy report field in sync for the title, but routing uses the pinned route.
        run.limits.models = { ...run.limits.models, [role]: checked.model || run.limits.models?.[role] || null };
      }
    }
    const dev = routesUsed.developer;
    if (!dev?.ok) {
      const cls = dev?.classification || { category: 'config', action: 'pause', label: 'Model check failed', message: 'The Developer route did not answer.' };
      if (cls.action !== 'none' && !['config', 'auth', 'content_filter'].includes(cls.category)) throw new ProviderFailure(cls, 'developer');
      await this.pauseFor('provider_config', `The Developer route does not work (${dev?.harness || 'none'}): ${dev?.error || 'no answer'}. Choose another model profile on the Setup screen and start a new run.`);
      return 'retry';
    }
    for (const role of roles.slice(1)) {
      const r = routesUsed[role];
      if (!r?.ok) {
        const devRoute = routesUsed.developer?.route;
        if (devRoute && this.readOnlyCapable(devRoute.harness)) {
          this.addLog({ kind: 'warning', text: `The ${roleLabel(role)} route did not work; the Developer route is used for the ${roleLabel(role)} in this run.` });
          this.rolePins = { ...(this.rolePins || {}), [role]: { harness: devRoute.harness, modelProfile: devRoute.modelProfile } };
        } else {
          await this.pauseFor('provider_config', `No read-only-capable harness is available for the ${roleLabel(role)}. DSH and the Command harness cannot enforce a read-only session; pin ${roleLabel(role)} to OpenCode, Claude Code, Codex or the API harness.`);
          return 'retry';
        }
      }
    }
    run.routingConfig = { routing: this.routing, modelProfiles: this.modelProfiles, rolePins: this.rolePins };
    run.preflight = {
      at: Date.now(),
      results: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, { ok: v.ok, error: v.error, harness: v.harness, modelProfile: v.modelProfile }])),
      routes: Object.fromEntries(Object.entries(routesUsed).map(([k, v]) => [k, { harness: v.harness, modelProfile: v.modelProfile, model: v.model }])),
    };
    this.quotaSnapshot();
    await this.persist();
    return 'ok';
  }

  /**
   * Nobody may be at the keyboard. A permission request or question that stays unanswered for
   * permissionTimeoutMin is declined (permissions) or dismissed (questions) so the run continues;
   * the developer is then told to finish without it. 0 = wait for the user (not in sleep mode).
   */
  async watchPending() {
    const run = this.run;
    const min = run.limits.permissionTimeoutMin;
    if (!min || this.terminal) return;
    const limitMs = min * 60_000;
    const now = Date.now();
    for (const p of [...run.pending.permissions]) {
      if (now - p.at < limitMs) continue;
      try {
        await this.adapterForHarness(this.sessionRoute(p.sessionID).harness).replyPermission(p.sessionID, p.id, 'reject');
      } catch (err) {
        log.warn(`auto-reject failed: ${err.message}`);
      }
      run.pending.permissions = run.pending.permissions.filter((x) => x.id !== p.id);
      run.autoAnswered.push({ type: 'permission', action: p.action, resources: p.resources, role: p.role, at: now, iteration: run.currentIteration });
      this.addLog({ kind: 'permission', role: p.role, text: `Permission not answered for ${min} min → REJECTED automatically, the run continues: ${p.action} ${(p.resources || []).join(' ')}` });
      this.afterPendingChange();
    }
    for (const f of [...run.pending.forms]) {
      if (now - f.at < limitMs) continue;
      let ok = false;
      try {
        ok = await this.adapterForHarness(this.sessionRoute(f.sessionID).harness).cancelForm(f.sessionID, f.id);
      } catch (err) {
        log.warn(`auto-dismiss failed: ${err.message}`);
      }
      if (!ok) continue;
      (this.dismissedForms ||= new Set()).add(f.sessionID);
      run.pending.forms = run.pending.forms.filter((x) => x.id !== f.id);
      run.autoAnswered.push({ type: 'question', title: f.title, role: f.role, at: now, iteration: run.currentIteration });
      this.addLog({ kind: 'form', role: f.role, text: `Question not answered for ${min} min → closed automatically; the agent continues on its own judgement: ${f.title}` });
      this.afterPendingChange();
    }
  }

  /**
   * Stall watchdog (sleep mode). If a running run shows no progress at all for stallLimitMs, the
   * code is waiting on something that will never come (a lost reply, a hung request). Stage 1
   * interrupts the OpenCode turns in flight so the waiting code can move on; if that does not
   * help within the same time again, stage 2 asks the supervisor process to restart the app —
   * the run is then recovered from disk and continued automatically (see app.recoverRuns).
   */
  async checkStall() {
    const run = this.run;
    if (!run.limits.unattended || run.state !== 'running' || this.terminal) return;
    // Progress after the stage-1 interrupt means the interrupt worked: start over.
    if (this.stallStage && this.lastProgressAt > this.stallAt) this.stallStage = 0;
    const limit = stallLimitMs(run.limits);
    const idle = Date.now() - this.lastProgressAt;
    if (idle < limit) return;
    const min = Math.max(1, Math.round(idle / 60_000));
    run.stalls = (run.stalls || 0) + 1;
    if (this.stallStage === 0) {
      this.stallStage = 1;
      this.addLog({ kind: 'warning', text: `Stall detected: the run has shown no progress for ${min} min (activity: ${run.activity?.message || run.activity?.phase || '?'}). Interrupting the active executions; the task will be retried.` });
      for (const a of this.activeTurns.values()) if (a.role === 'developer') (this.stallTimeouts ||= new Set()).add(a.sessionID);
      await this.interruptActive('stalled');
      await this.persist();
      this.stallAt = Date.now();
      return;
    }
    if (this.stallStage === 2) return;
    this.stallStage = 2;
    if (process.send && process.env.SLEEPPILOT_WORKER === '1') {
      this.addLog({ kind: 'warning', text: `Still stalled (${min} min). The supervisor will restart the app; the run continues by itself from its saved state.` });
      await this.persist();
      process.send({ type: 'restart', reason: `stall: ${run.id} no progress for ${min} min` });
    } else {
      this.addLog({ kind: 'warning', text: `Still stalled (${min} min) and the app runs without a supervisor; restart SleepPilot.` });
      await this.persist();
    }
  }

  // ------------------------------------------------------------------ control helpers

  async handleControl() {
    if (this.control.stop) {
      await this.finish('user_stopped');
      return true;
    }
    if (this.control.pause) {
      await this.pauseFor('user_paused', this.control.pause.immediate ? 'Paused immediately by the user; the interrupted task may be unfinished.' : 'Paused by the user (the current iteration was completed).');
      return this.control.stop ? (await this.finish('user_stopped'), true) : false;
    }
    return false;
  }

  /** Stop this controller before the app disposes its engines; used by app shutdown/tests. */
  async dispose() {
    this.disposed = true;
    this.control.stop = { immediate: true, at: Date.now() };
    this.control.pause = null;
    const waiters = this.resumeWaiters.splice(0);
    waiters.forEach((fn) => fn());
    if (this.updateTimer) clearTimeout(this.updateTimer);
    if (this.autoResumeTimer) clearTimeout(this.autoResumeTimer);
    await this.interruptActive('shutdown').catch(() => {});
    await this.persist().catch(() => {});
  }

  async pauseFor(code, message, { resetsAt } = {}) {
    const run = this.run;
    // Register for wake-up BEFORE the state becomes "paused" and before any await: a resume/stop
    // that arrives while the state is being saved must not be lost (it left runs paused forever).
    const woken = new Promise((resolve) => this.resumeWaiters.push(resolve));
    run.pause = { code, label: STOP_REASONS[code] || code, message, at: Date.now(), resetsAt: resetsAt || null };
    this.markActive(false);
    this.setState(code === 'waiting_input' || code === 'plan_review' ? 'waiting_user' : 'paused');
    this.setActivity('paused', `${STOP_REASONS[code] || code}${message ? ': ' + message : ''}`);
    this.addLog({ kind: 'pause', text: `Paused — ${STOP_REASONS[code] || code}${message ? ': ' + message : ''}` });
    let autoTimer = null;
    if (code === 'quota' && resetsAt && (run.limits.autoResumeOnQuotaReset || run.limits.unattended)) {
      const wait = Math.max(60_000, resetsAt - Date.now() + 60_000);
      this.addLog({ kind: 'info', text: `The allowance renews on ${new Date(resetsAt).toLocaleString('en-GB')}; automatic resume is on.` });
      autoTimer = setTimeout(() => this.resume(), wait);
      autoTimer.unref?.();
    } else if (run.limits.unattended && AUTO_RETRY_PAUSES[code] && run.autoResumes < MAX_AUTO_RESUMES) {
      const wait = Number(process.env.SLEEPPILOT_BACKOFF_SCALE || 1) * AUTO_RETRY_PAUSES[code];
      run.autoResumes++;
      this.addLog({ kind: 'info', text: `Sleep mode: retrying automatically in ${Math.max(1, Math.round(wait / 60_000))} min (${run.autoResumes}/${MAX_AUTO_RESUMES}).` });
      autoTimer = setTimeout(() => {
        if (code === 'connection_lost') {
          const a = this.adapterForHarness(this.activeHarness);
          if (a && !a.connected) a.connect().catch(() => {});
        }
        this.resume();
      }, wait);
      autoTimer.unref?.();
    }
    this.autoResumeTimer = autoTimer;
    await this.persist();
    await woken;
    if (autoTimer) clearTimeout(autoTimer);
    if (this.autoResumeTimer === autoTimer) this.autoResumeTimer = null;
  }

  async sleepInterruptible(ms) {
    const end = Date.now() + ms;
    while (Date.now() < end && !this.control.stop && !this.control.pause) await new Promise((r) => setTimeout(r, Math.min(1000, end - Date.now())));
  }

  /** Interrupt every running OpenCode turn (parallel developers included), or only one role's. */
  async interruptActive(reason, { onlyRole } = {}) {
    const list = [...this.activeTurns.values()].filter((a) => !onlyRole || a.role === onlyRole);
    if (!list.length) return false;
    let any = false;
    for (const at of list) {
      try {
        const r = await this.adapterForHarness(at.harness || this.sessionRoute(at.sessionID).harness).interrupt(at.sessionID);
        at.interruptReason = reason;
        any ||= !!r.interrupted;
        this.addLog({ kind: 'control', text: `${at.tag ? `[${at.tag}] ` : ''}${r.supported ? (r.interrupted ? 'Execution interrupted.' : 'There was no active execution to interrupt.') : 'This engine cannot interrupt.'}` });
      } catch (err) {
        this.addLog({ kind: 'error', text: `Interrupt failed: ${redact(err.message)}` });
      }
    }
    return any;
  }

  markActive(on) {
    const run = this.run;
    if (on && !run.activeSince) run.activeSince = Date.now();
    if (!on && run.activeSince) {
      run.activeMs += Date.now() - run.activeSince;
      run.activeSince = null;
    }
  }

  elapsedActive() {
    return this.run.activeMs + (this.run.activeSince ? Date.now() - this.run.activeSince : 0);
  }

  timeUp() {
    const d = this.run.limits.durationMin;
    if (!d || this.elapsedActive() < d * 60_000) return false;
    return !this.grantOvertime();
  }

  /** Tasks that still need work (what "the given job is not finished yet" means). */
  openTaskCount() {
    return this.run.tasks.filter((t) => t.status === 'pending' || t.status === 'test_failed' || t.status === 'in_progress').length;
  }

  /**
   * The time limit was reached but the given tasks are not finished: if the user allowed it in
   * the setup ("Overtime"), extend the run by overtimeMin, at most overtimeMaxRounds times.
   */
  grantOvertime() {
    const run = this.run;
    const l = run.limits;
    if (!l.overtimeMin || (run.overtimeUsed || 0) >= (l.overtimeMaxRounds || 1)) return false;
    const open = this.openTaskCount();
    if (!open || this.control.stop) return false;
    run.overtimeUsed = (run.overtimeUsed || 0) + 1;
    l.durationMin += l.overtimeMin;
    this.addLog({ kind: 'control', text: `Time is up but ${open} task(s) are still open: ${l.overtimeMin} min overtime granted (${run.overtimeUsed}/${l.overtimeMaxRounds || 1}). New time limit ${l.durationMin} min.` });
    this.persist();
    return true;
  }

  limitReached() {
    const { limits, usage, iterationCount } = this.run;
    if (limits.durationMin && this.timeUp()) return 'time_limit';
    if (limits.maxIterations && iterationCount >= limits.maxIterations) return 'iteration_limit';
    const tok = usage.tokens.input + usage.tokens.output + usage.tokens.reasoning;
    if (limits.maxTokens && tok >= limits.maxTokens) return 'token_limit';
    if (limits.maxCostUsd && usage.cost >= limits.maxCostUsd) return 'cost_limit';
    return null;
  }

  /** Options every role prompt receives: scope discipline, sleep mode, report language. */
  promptOpts() {
    const l = this.run.limits;
    return { scope: l.scopeMode || 'strict', unattended: !!l.unattended, language: l.language || 'en', protectedPaths: l.protectedPaths || [], parallel: l.parallelDevelopers || 1, scout: this.run.scout || null };
  }

  limitsInfo() {
    const l = this.run.limits;
    const rem = l.durationMin ? Math.round((l.durationMin * 60_000 - this.elapsedActive()) / 60_000) : null;
    return `iterations ${this.run.iterationCount}/${l.maxIterations || '�?'}; time remaining ${rem != null ? rem + ' min' : 'unlimited'}`;
  }

  /** Check the Go allowance when the installed OpenCode exposes it. Never guesses. */
  async quotaGate() {
    const now = Date.now();
    this.quota.clearExpired(now);
    const active = this.activeHarness;
    if (!this.quota.canUse(active).ok) {
      const next = this.nextRoute('developer', 'coding', active);
      const wait = this.quota.nextAvailable(now);
      if (!next) {
        await this.pauseFor('quota', `Every usable harness is in a quota/cooldown window${wait ? ` until ${new Date(wait.until).toLocaleString('en-GB')}` : ''}.`, { resetsAt: wait?.until || null });
        return false;
      }
      this.recordSwitch('developer', { harness: active }, next, 'active harness quota window exhausted');
      this.run.activeHarness = next.harness;
      await this.persist();
    }
    if (this.lastQuotaCheck && now - this.lastQuotaCheck < 120_000) return true;
    this.lastQuotaCheck = now;
    const u = await this.adapterForHarness(this.activeHarness).usageLimits(this.project.dir);
    this.run.goUsage = { supported: u.supported, data: u.data, fetchedAt: now, error: u.error || null };
    const go = u.data?.go;
    if (go) {
      const limited = ['rolling', 'weekly', 'monthly'].filter((k) => go[k]?.limited);
      if (limited.length) {
        const resetsAt = Math.max(...limited.map((k) => go[k].resetsAt || 0)) || null;
        await this.pauseFor('quota', `The OpenCode Go allowance is at its limit (${limited.join(', ')}). Renews: ${resetsAt ? new Date(resetsAt).toLocaleString('en-GB') : 'unknown'}.`, { resetsAt });
        return false;
      }
    }
    return true;
  }

  /** Tasks to run together with `first` (parallel developers), never more than the iteration limit allows. */
  pickWave(first) {
    const l = this.run.limits;
    const left = l.maxIterations ? l.maxIterations - this.run.iterationCount : Infinity;
    const max = Math.max(1, Math.min(l.parallelDevelopers || 1, left));
    return selectWave(this.run.tasks, first, max);
  }

  pickTask() {
    const tasks = this.run.tasks;
    if (this.run.forceNextTaskId) {
      const t = tasks.find((x) => x.id === this.run.forceNextTaskId);
      this.run.forceNextTaskId = null;
      if (t && (t.status === 'pending' || t.status === 'test_failed')) return t;
    }
    return selectNextTask(tasks);
  }

  // ------------------------------------------------------------------ roles

  /** Create the developer session for a task on its routed harness. */
  async developerSessionFor(task) {
    const route = this.routeFor('developer', task.type || 'coding');
    const { session } = await this.createRoleSession('developer', route, {
      title: `SleepPilot · ${this.project.name} · ${task.id}`,
      task,
    });
    task.devSessionId = session.id;
    task.devHarness = route.harness;
    task.devModelProfile = route.modelProfile;
    const record = { ...route, sessionID: session.id, taskId: task.id };
    this.sessionHarness.set(session.id, record);
    this.run.sessionRoutes[`developer:${task.id}`] = record;
    this.addLog({ kind: 'session', role: 'developer', text: `[${task.id}] Developer session on ${route.harness}${route.modelProfile ? ` (${route.modelProfile})` : ''}: ${session.id}` });
    return { id: session.id, route };
  }

  async ensureSession(role) {
    const run = this.run;
    const recorded = run.sessionRoutes?.[role];
    if (run.sessions[role] && recorded && this.quota.canUse(recorded.harness).ok) return run.sessions[role];
    const route = this.routeFor(role, role === 'manager' ? 'planning' : role === 'reviewer' ? 'review' : role);
    const { session } = await this.createRoleSession(role, route, {
      title: `SleepPilot · ${this.project.name} · ${role === 'manager' ? 'Manager' : role === 'reviewer' ? 'Reviewer' : role}`,
    });
    this.registerSession(role, session, route);
    this.addLog({ kind: 'session', role, text: `${role === 'manager' ? 'Manager' : role === 'reviewer' ? 'Reviewer' : role} session created on ${route.harness}: ${session.id}` });
    await this.persist();
    return session.id;
  }

  /**
   * Parallel waves review their tasks at the same time, so each task gets its own read-only
   * reviewer session (one session cannot run two turns at once). Reused across a task's attempts.
   */
  async reviewSessionFor(task) {
    const route = this.routeFor('reviewer', 'review');
    const key = `${route.harness}/${route.modelProfile || 'default'}`;
    if (task.reviewSession?.id && task.reviewSession.model === key && this.quota.canUse(route.harness).ok) return task.reviewSession.id;
    const { session } = await this.createRoleSession('reviewer', route, {
      title: `SleepPilot · ${this.project.name} · Reviewer · ${task.id}`,
    });
    task.reviewSession = { id: session.id, model: key, harness: route.harness, modelProfile: route.modelProfile };
    this.registerSession('reviewer', session, route, { taskId: task.id });
    this.addLog({ kind: 'session', role: 'reviewer', text: `[${task.id}] Reviewer session (${route.harness}): ${session.id}` });
    return session.id;
  }

  /** Run a turn for any role with persistence-before-submit, live streaming and usage accounting. */
  async roleTurn(role, sessionID, text, { iterationN, tag, task = null, taskType = null, fallbackDepth = 0, attempted = [] } = {}) {
    const run = this.run;
    const route = this.sessionRoute(sessionID);
    const maxSwitches = Number(this.routing?.maxSwitches) || 8;

    // A harness whose quota window is closed is skipped before anything is submitted to it.
    if (!this.quota.canUse(route.harness).ok) {
      const next = this.nextRoute(role, taskType || task?.type, route.harness, attempted);
      if (!next || fallbackDepth >= maxSwitches) {
        const wait = this.quota.canUse(route.harness);
        throw new ProviderFailure({
          category: 'quota',
          action: 'pause',
          label: 'Harness quota window exhausted',
          message: `${route.harness} is unavailable${wait.until ? ` until ${new Date(wait.until).toISOString()}` : ''}; no fallback harness is usable.`,
          hint: 'Add another harness to harnessRouting.fallbackChain or wait for the quota window.',
        }, role);
      }
      this.recordSwitch(role, route, next, `quota/cooldown before ${role} turn`);
      const created = await this.createRoleSession(role, next, { title: `SleepPilot · ${this.project.name} · ${role}`, task });
      this.registerSession(role, created.session, next);
      if (role === 'developer' && task) {
        task.devSessionId = created.session.id;
        task.devHarness = next.harness;
        task.devModelProfile = next.modelProfile;
        this.run.sessionRoutes[`developer:${task.id}`] = { ...next, sessionID: created.session.id, taskId: task.id };
      } else if (role === 'reviewer' && task) {
        task.reviewSession = { id: created.session.id, model: `${next.harness}/${next.modelProfile || 'default'}`, harness: next.harness, modelProfile: next.modelProfile };
      }
      this.quotaSnapshot();
      await this.persist();
      return this.roleTurn(role, created.session.id, text, { iterationN, tag, task, taskType, fallbackDepth: fallbackDepth + 1, attempted: [...attempted, route.harness] });
    }

    const adapter = await this.ensureHarness(route.harness);
    const messageId = newMessageId();
    const rec = { role, sessionID, messageId, iterationN: iterationN ?? null, submittedAt: null, startedAt: Date.now(), tag: tag || null, harness: route.harness, modelProfile: route.modelProfile, fallbackStep: route.fallbackStep || 0 };
    (run.activeTurns ||= {})[messageId] = rec;
    run.activeTurn = rec;
    await this.persist(); // persisted BEFORE submission → restart can reconcile instead of resubmitting
    this.activeTurns.set(sessionID, { role, sessionID, tag: tag || null, messageId, startedAt: Date.now(), harness: route.harness, modelProfile: route.modelProfile });
    const pre = tag ? `[${tag}] ` : '';
    const legacyModel = run.limits.models?.[role === 'closing' ? 'manager' : role] || null;
    const modelLabel = route.model ? (typeof route.model === 'object' ? `${route.model.providerID}/${route.model.id}` : String(route.model)) : legacyModel ? `${legacyModel.providerID}/${legacyModel.id}` : null;
    this.addLog({ kind: 'turn-start', role, turn: messageId, tag: tag || null, iteration: iterationN ?? null, harness: route.harness, modelProfile: route.modelProfile, fallbackStep: route.fallbackStep || 0, model: modelLabel, prompt: String(text).slice(0, 4000), text: `${pre}${roleLabel(role)} → ${adapter.label} (${sessionID})${route.modelProfile ? ` · ${route.modelProfile}` : ''}` });
    let result;
    try {
      result = await adapter.runTurn({
        sessionID,
        text,
        messageId,
        metadata: { role, runId: run.id, iteration: iterationN ?? null, harness: route.harness, modelProfile: route.modelProfile, fallbackStep: route.fallbackStep || 0, readOnly: role !== 'developer' },
        onSubmitted: () => {
          rec.submittedAt = Date.now();
          this.persist();
        },
        onEvent: (ev) => this.onTurnEvent(role, sessionID, ev, tag, messageId),
      });
    } catch (err) {
      const cls = err?.sleepPilotType === 'provider.config'
        ? { category: 'config', action: 'pause', label: 'Harness configuration error', message: err.message }
        : classifyError(err);
      result = {
        status: 'failed', sessionID, messageId, startedAt: rec.startedAt, endedAt: Date.now(), outcome: 'failed',
        finalText: '', allText: '', tools: [], transcript: [],
        errors: [{ type: err?.sleepPilotType || 'provider.transport', message: err.message, classification: cls }],
        usage: { cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, models: [] },
        quota: null,
      };
    } finally {
      this.flushText(role, sessionID, tag, messageId);
      this.flushReasoning(role, sessionID, tag, messageId);
      this.activeTurns.delete(sessionID);
    }
    result.harness = route.harness;
    result.modelProfile = route.modelProfile;
    result.fallbackStep = route.fallbackStep || 0;
    result.sessionID = sessionID;
    const providerErr = result.errors?.find((e) => e.classification && e.classification.action !== 'none') || null;
    this.quota.observe(route.harness, { result, classification: providerErr?.classification || null, quota: result.quota });
    // Durable record of the whole turn for the chat view and later analysis.
    const turnRec = {
      id: messageId,
      role,
      tag: tag || null,
      sessionID,
      harness: route.harness,
      modelProfile: route.modelProfile,
      fallbackStep: route.fallbackStep || 0,
      iteration: iterationN ?? null,
      model: modelLabel || (result.usage?.models || [])[0] || null,
      startedAt: rec.startedAt,
      endedAt: Date.now(),
      status: result.status,
      prompt: String(text).slice(0, 6000),
      usage: result.usage || null,
      errors: (result.errors || []).map((e) => ({ type: e.type, message: e.message })),
      transcript: result.transcript || [],
    };
    this.store.appendTurn?.(run, turnRec).catch(() => {});
    this.emit('turn', turnRec);
    delete run.activeTurns[messageId];
    run.activeTurn = Object.values(run.activeTurns).at(-1) || null;
    // Until this iteration is evaluated (diff, checks, decision) a crash must not lose the finished
    // turn: recovery then evaluates THIS turn from the engine's records instead of re-running the task.
    if (role === 'developer' && iterationN != null) (run.evaluating ||= {})[iterationN] = { ...rec, endedAt: Date.now() };
    this.addUsage(role, result.usage);
    this.addLog({ kind: 'turn-end', role, turn: messageId, status: result.status, text: `${pre}${roleLabel(role)} turn finished on ${route.harness}: ${turnStatusLabel(result.status)}${result.usage ? ` · estimated cost $${result.usage.cost.toFixed(4)} · ${result.usage.tokens.input + result.usage.tokens.output} tokens` : ''}` });
    this.run.pending.permissions = this.run.pending.permissions.filter((p) => p.sessionID !== sessionID);
    this.run.pending.forms = this.run.pending.forms.filter((p) => p.sessionID !== sessionID);
    this.quotaSnapshot();
    await this.persist();

    if (result.status === 'failed' && providerErr) {
      const canFallback = this.routing?.fallbackOnErrors !== false && !['permission_rejected', 'content_filter'].includes(providerErr.classification.category) && fallbackDepth < maxSwitches;
      if (canFallback) {
        const next = this.nextRoute(role, taskType || task?.type, route.harness, attempted);
        if (next) {
          this.recordSwitch(role, route, next, `${providerErr.classification.label}: ${providerErr.message || ''}`.slice(0, 800));
          const created = await this.createRoleSession(role, next, { title: `SleepPilot · ${this.project.name} · ${role}`, task });
          this.registerSession(role, created.session, next);
          if (role === 'developer' && task) {
            task.devSessionId = created.session.id;
            task.devHarness = next.harness;
            task.devModelProfile = next.modelProfile;
            this.run.sessionRoutes[`developer:${task.id}`] = { ...next, sessionID: created.session.id, taskId: task.id };
          } else if (role === 'reviewer' && task) {
            task.reviewSession = { id: created.session.id, model: `${next.harness}/${next.modelProfile || 'default'}`, harness: next.harness, modelProfile: next.modelProfile };
          }
          await this.persist();
          return this.roleTurn(role, created.session.id, text, { iterationN, tag, task, taskType, fallbackDepth: fallbackDepth + 1, attempted: [...attempted, route.harness] });
        }
      }
      throw new ProviderFailure(providerErr.classification, role);
    }
    // An interrupted manager/reviewer turn has no usable answer; the loop re-checks controls.
    if (result.status === 'interrupted' && role !== 'developer') throw new Interrupted('interrupted');
    if (result.status === 'not_found' || result.status === 'lost') {
      throw new ProviderFailure({ category: 'transient', action: 'retry', label: 'Execution lost', message: 'The instruction result was not found in the engine\'s records.' }, role);
    }
    return result;
  }

  onTurnEvent(role, sessionID, ev, tag, turn) {
    const run = this.run;
    // 'pending' and 'connection' come from SleepPilot's own polling, not from the agent: no progress.
    if (ev.kind !== 'pending' && ev.kind !== 'connection') this.lastProgressAt = Date.now();
    const pre = tag ? `[${tag}] ` : '';
    switch (ev.kind) {
      case 'text': {
        this.flushReasoning(role, sessionID, tag, turn);
        this.textBuffers.set(sessionID, (this.textBuffers.get(sessionID) || '') + (ev.delta || ''));
        // Live deltas carry the turn id; the log view shows only untagged ones (parallel streams would interleave).
        this.emit('log', { at: Date.now(), kind: 'text-delta', role, turn, tag: tag || null, text: ev.delta });
        break;
      }
      case 'reasoning': {
        const key = `r:${sessionID}`;
        this.textBuffers.set(key, (this.textBuffers.get(key) || '') + (ev.delta || ''));
        this.emit('log', { at: Date.now(), kind: 'reasoning-delta', role, turn, tag: tag || null, text: ev.delta });
        break;
      }
      case 'compaction':
        this.addLog({ kind: 'compaction', role, turn, text: `${pre}${this.engineName} is compacting the context (${ev.phase === 'started' ? 'started' : ev.phase === 'ended' ? 'done' : 'failed'}).` });
        break;
      case 'tool':
        this.flushText(role, sessionID, tag, turn);
        this.flushReasoning(role, sessionID, tag, turn);
        if (ev.phase === 'called') this.addLog({ kind: 'tool', role, turn, toolId: ev.id, tool: ev.name, input: ev.input, text: `${pre}g��� ${ev.name} ${toolArg(ev.input)}` });
        else if (ev.phase === 'error') this.addLog({ kind: 'tool-error', role, turn, toolId: ev.id, tool: ev.name, text: `${pre}✖ ${ev.name}: ${ev.error?.message || 'error'}` });
        else if (ev.phase === 'success') this.addLog({ kind: 'tool-result', role, turn, toolId: ev.id, tool: ev.name, text: `${pre}✓ ${ev.name}: ${String(ev.output || '').slice(0, 300)}` });
        break;
      case 'permission': {
        const r = ev.request;
        if (!r?.id || run.pending.permissions.some((p) => p.id === r.id)) break;
        run.pending.permissions.push({ id: r.id, sessionID: r.sessionID || sessionID, role, action: r.action, resources: r.resources, save: r.save, message: r.message, at: Date.now() });
        this.addLog({ kind: 'permission', role, text: `${pre}Permission requested: ${r.action} ${(r.resources || []).join(' ')}` });
        this.afterPendingChange();
        break;
      }
      case 'form': {
        const f = ev.form;
        if (!f?.id || run.pending.forms.some((p) => p.id === f.id)) break;
        run.pending.forms.push({ id: f.id, sessionID: f.sessionID || sessionID, role, title: f.title, fields: f.fields, at: Date.now() });
        this.addLog({ kind: 'form', role, text: `The agent asks a question: ${f.title}` });
        this.afterPendingChange();
        break;
      }
      case 'pending': {
        // Reconcile with the server's view (volatile event stream).
        const permIds = new Set((ev.permissions || []).map((p) => p.id));
        const formIds = new Set((ev.forms || []).map((f) => f.id));
        const before = run.pending.permissions.length + run.pending.forms.length;
        run.pending.permissions = run.pending.permissions.filter((p) => p.sessionID !== sessionID || permIds.has(p.id));
        run.pending.forms = run.pending.forms.filter((f) => f.sessionID !== sessionID || formIds.has(f.id));
        if (before !== run.pending.permissions.length + run.pending.forms.length) this.afterPendingChange();
        break;
      }
      case 'usage':
        this.emit('log', { at: Date.now(), kind: 'usage-live', role, cost: ev.cost, tokens: ev.tokens });
        break;
      case 'retry':
        this.addLog({ kind: 'warning', role, text: `The provider request is being retried: ${ev.data?.error?.message || ''}` });
        break;
      case 'step-failed':
        this.addLog({ kind: 'warning', role, text: `Step failed: ${ev.error?.type || ''} ${ev.error?.message || ''}` });
        break;
      case 'connection':
        this.addLog({ kind: 'warning', role, text: `Connection problem: ${ev.message}` });
        break;
      default:
        break;
    }
  }

  afterPendingChange() {
    const waiting = this.run.pending.permissions.length + this.run.pending.forms.length > 0;
    if (waiting && this.run.activity.phase !== 'waiting_permission') {
      this.prevActivity = this.run.activity;
      this.setActivity('waiting_permission', 'The agent is waiting for a permission or answer — answer it on the Run screen.');
    } else if (!waiting && this.run.activity.phase === 'waiting_permission') {
      this.setActivity(this.prevActivity?.phase || 'developer', this.prevActivity?.message || '');
    }
    this.persist();
  }

  flushText(role, key = role, tag = null, turn = null) {
    const t = this.textBuffers.get(key);
    if (t && t.trim()) this.addLog({ kind: 'text', role, turn, text: `${tag ? `[${tag}] ` : ''}${t.trim().slice(0, 6000)}` });
    this.textBuffers.delete(key);
  }

  /** Model "thinking" (reasoning parts) is logged as its own entry so the UI can fold it away. */
  flushReasoning(role, sessionID, tag = null, turn = null) {
    const key = `r:${sessionID}`;
    const t = this.textBuffers.get(key);
    if (t && t.trim()) this.addLog({ kind: 'reasoning', role, turn, text: `${tag ? `[${tag}] ` : ''}${t.trim().slice(0, 8000)}` });
    this.textBuffers.delete(key);
  }

  addUsage(role, u) {
    if (!u) return;
    const total = this.run.usage;
    const r = (total.byRole[role] ||= emptyRole());
    total.cost += u.cost;
    r.cost += u.cost;
    r.turns++;
    for (const k of Object.keys(total.tokens)) {
      total.tokens[k] += u.tokens[k] || 0;
      r.tokens[k] += u.tokens[k] || 0;
    }
    for (const m of u.models || []) total.models[m] = (total.models[m] || 0) + 1;
  }

  /**
   * Ask the manager for JSON; one corrective retry, then the caller's fallback. Calls are queued:
   * the manager has one session, and the tasks of a parallel wave finish at the same time.
   */
  askManager(text, opts) {
    const next = (this.managerQueue || Promise.resolve()).catch(() => {}).then(() => this.askManagerNow(text, opts));
    this.managerQueue = next.catch(() => {});
    return next;
  }

  async askManagerNow(text, { iterationN, validate }) {
    let sid = await this.ensureSession('manager');
    const turn = await this.roleTurn('manager', sid, text, { iterationN, taskType: 'planning' });
    sid = turn.sessionID || sid;
    let json = extractJson(turn.finalText || turn.allText);
    if (!json || (validate && !validate(json))) {
      this.addLog({ kind: 'warning', role: 'manager', text: 'The manager reply was not valid JSON; asking once for a correction.' });
      const again = await this.roleTurn('manager', sid, P.JSON_RETRY, { iterationN, taskType: 'planning' });
      json = extractJson(again.finalText || again.allText);
      if (json && validate && !validate(json)) json = null;
    }
    return json;
  }

  nextTaskId() {
    return `T${this.run.nextTaskNumber++}`;
  }

  addTasks(list, { createdBy = 'manager', improvement = false } = {}) {
    const added = [];
    const rawDeps = [];
    for (const raw of Array.isArray(list) ? list.slice(0, 20) : []) {
      if (!raw?.title || isPlaceholderTask(raw)) continue;
      const t = makeTask(raw, { id: this.nextTaskId(), objectiveVersion: this.run.objectiveVersion, createdBy, improvement });
      this.run.tasks.push(t);
      added.push(t);
      rawDeps.push([t.id, Array.isArray(raw.depends_on) ? raw.depends_on : []]);
    }
    // Numeric depends_on values are 1-based indexes within this batch; strings are ids or titles.
    const deps = new Map(rawDeps.map(([id, ds]) => [id, ds.map((d) => (typeof d === 'number' ? added[d - 1]?.id ?? null : d)).filter(Boolean)]));
    resolveDependencies(this.run.tasks, deps);
    return added;
  }

  async planPhase() {
    const run = this.run;
    this.setState('running');
    this.setActivity('planning', 'The manager is inspecting the project and writing the task plan…');
    const inspection = await inspectProject(this.project.dir);
    this.project.inspection = inspection;
    await this.store.saveProject(this.project);
    const json = await this.askManager(
      P.planPrompt({ project: this.project, objective: this.project.objective, rules: this.project.rules, inspection, checks: this.project.checks, previousTasks: run.tasks, opts: this.promptOpts() }),
      { validate: (j) => Array.isArray(j.tasks) },
    );
    if (json?.tasks?.length) {
      const added = this.addTasks(json.tasks);
      run.plan = { summary: json.summary || '', verificationNotes: json.verification_notes || '', questions: json.questions || [], source: 'manager', at: Date.now() };
      this.addLog({ kind: 'plan', role: 'manager', text: `Plan created: ${added.length} tasks.${json.verification_notes ? ' Verification note: ' + json.verification_notes : ''}` });
    } else {
      const t = this.addTasks([{ title: 'Implement the objective', description: this.project.objective.text, acceptance: [], priority: 1 }], { createdBy: 'sleeppilot' })[0];
      run.plan = { summary: '', verificationNotes: '', questions: json?.questions || [], source: 'fallback', at: Date.now() };
      this.addLog({ kind: 'warning', text: `The manager returned no valid plan; the objective was planned as a single task (${t.id}).` });
    }
    run.planned = true;
    await this.persist();
    if (!json?.tasks?.length && json?.questions?.length) {
      if (run.limits.unattended) this.addLog({ kind: 'info', role: 'manager', text: `The manager asked questions, but nobody can answer in sleep mode; continuing with the objective as a single task. Questions: ${json.questions.join(' / ')}` });
      else await this.pauseFor('waiting_input', `The manager has questions before planning: ${json.questions.join(' / ')}`);
    }
  }

  async applySteering() {
    const run = this.run;
    const pending = run.steering.filter((s) => s.status === 'pending');
    if (!pending.length) return false;
    for (const s of pending) {
      this.setActivity('steering', `Applying the new instruction: ${s.text}`);
      s.status = 'applying';
      await this.persist();
      if (!run.planned) {
        // No plan yet: fold the instruction into the objective; planning will use it.
        const obj = this.store.setObjective(this.project, `${this.project.objective.text}\n\nAdditional instruction: ${s.text}`, { source: 'steer', instruction: s.text, runId: run.id });
        await this.finishSteering(s, obj, 'There was no plan yet; the instruction was added to the objective.');
        continue;
      }
      const json = await this.askManager(P.steeringPrompt({ objective: this.project.objective, tasks: run.tasks, instruction: s.text, opts: this.promptOpts() }), { validate: (j) => typeof j.objective === 'string' && j.objective.trim().length > 0 });
      let summary;
      if (json) {
        const obj = this.store.setObjective(this.project, json.objective.trim(), { source: 'steer', instruction: s.text, runId: run.id, summary: json.change_summary });
        applyTaskUpdates(run.tasks, json.task_updates, run.iterationCount);
        const added = this.addTasks(json.new_tasks || [], { createdBy: 'manager' });
        summary = `${json.change_summary || ''} (${added.length} new task(s))`.trim();
        await this.finishSteering(s, obj, summary);
      } else {
        const obj = this.store.setObjective(this.project, `${this.project.objective.text}\n\nNew priority (user): ${s.text}`, { source: 'steer', instruction: s.text, runId: run.id });
        const t = this.addTasks([{ title: s.text.slice(0, 120), description: s.text, priority: 1 }], { createdBy: 'user' })[0];
        await this.finishSteering(s, obj, `Could not parse the manager reply; the instruction was added as the top-priority task ${t.id}.`);
      }
    }
    return true;
  }

  async finishSteering(s, obj, summary) {
    s.status = 'applied';
    s.appliedAt = Date.now();
    s.appliedAfterIteration = this.run.iterationCount;
    s.resultingObjectiveVersion = obj.version;
    s.summary = summary;
    this.run.objectiveVersion = obj.version;
    await this.store.saveProject(this.project);
    this.addLog({ kind: 'steer', text: `Instruction ${s.id} applied → objective version ${obj.version}. ${summary || ''}` });
    await this.persist();
  }

  async noRunnableTask() {
    const run = this.run;
    const tasks = run.tasks;
    const waiting = tasks.filter((t) => t.status === 'waiting_user');
    if (waiting.length && !run.limits.unattended) {
      await this.pauseFor('waiting_input', waiting.map((t) => `[${t.id}] ${t.title}: ${t.question || t.notes || 'a decision is needed'}`).join('\n'));
      return false;
    }
    // Improvement rounds continue while time remains; two empty rounds in a row end them.
    const maxRounds = run.limits.durationMin ? 1000 : 5;
    if (run.limits.improvementMode && run.improvementRounds < maxRounds && (run.emptyImprovementRounds || 0) < 2 && !this.limitReached()) {
      run.improvementRounds++;
      this.setActivity('manager', run.limits.scopeMode === 'creative' ? 'Creative mode: asking for new improvements and features in the spirit of the objective…' : 'Improvement mode: asking for improvements within the objective…');
      const json = await this.askManager(P.improvementPrompt({ objective: this.project.objective, tasks, opts: this.promptOpts() }), { validate: (j) => Array.isArray(j.new_tasks) });
      const added = this.addTasks(json?.new_tasks || [], { improvement: true });
      run.emptyImprovementRounds = added.length ? 0 : (run.emptyImprovementRounds || 0) + 1;
      this.addLog({ kind: 'plan', role: 'manager', text: added.length ? `Improvement round ${run.improvementRounds}: ${added.length} task(s) added.` : 'The manager found no meaningful improvement within the objective.' });
      if (added.length) return false;
    }
    if (waiting.length) {
      await this.finish('tasks_need_user', waiting.map((t) => `[${t.id}] ${t.title}: ${t.question || t.notes || 'a decision is needed'}`).join('\n'));
      return true;
    }
    const blocked = tasks.filter((t) => t.status === 'blocked' || t.status === 'test_failed');
    if (blocked.length) {
      const repeated = blocked.some((t) => t.blockedReason === 'repeated_failure');
      await this.finish(repeated ? 'repeated_failure' : blocked.every((t) => t.status === 'test_failed') ? 'test_failed' : 'tasks_blocked', blocked.map((t) => `[${t.id}] ${t.title}`).join(', '));
      return true;
    }
    await this.finish('objective_completed');
    return true;
  }

  // ------------------------------------------------------------------ iteration

  async iterate(task) {
    const run = this.run;
    const n = ++run.iterationCount;
    const iteration = {
      n,
      taskId: task.id,
      taskTitle: task.title,
      objectiveVersion: run.objectiveVersion,
      attempt: task.attempts + 1,
      startedAt: Date.now(),
      endedAt: null,
      status: 'running',
    };
    run.currentIteration = n;
    const previousStatus = task.status;
    setTaskStatus(task, 'in_progress', `Iteration #${n}`, n);
    this.setActivity('developer', `#${n} · [${task.id}] ${task.title}`, { taskId: task.id, iteration: n });
    this.addLog({ kind: 'iteration', text: `── Iteration #${n} started: [${task.id}] ${task.title} (attempt ${iteration.attempt}) ──` });

    const before = await takeSnapshot(this.project.dir);
    await this.store.saveSnapshotIndex(run, n, before);

    // Developer session: one session per task (repairs continue it) or one per iteration.
    if (!task.devSessionId || run.limits.sessionPolicy === 'fresh-per-iteration' || !this.quota.canUse(task.devHarness || this.activeHarness).ok) {
      await this.developerSessionFor(task);
    }
    iteration.sessionID = task.devSessionId;
    iteration.prompt = P.developerPrompt({
      project: this.project,
      objective: this.project.objective,
      rules: this.project.rules,
      task,
      tasks: run.tasks,
      previousAttempts: task.attemptLog || [],
      checks: this.project.checks,
      recoveryNote: task.recoveryNote,
      opts: this.promptOpts(),
    });
    task.recoveryNote = null;
    run.iterations.push(iterationSummary(iteration));
    await this.store.saveIteration(run, iteration);
    await this.persist();

    // When the time limit passes during this turn, the developer's last answer is still awaited
    // (a cut-off answer leaves half-edited files). Only after finalGraceMin more minutes is the
    // turn interrupted; finalGraceMin = null waits without limit.
    const timer = this.startTimeLimitWatch();

    let turn;
    try {
      turn = await this.developerTurn(task, iteration);
    } catch (err) {
      clearInterval(timer);
      iteration.status = 'provider_error';
      iteration.error = redact(err.message);
      iteration.endedAt = Date.now();
      setTaskStatus(task, previousStatus === 'in_progress' ? 'pending' : previousStatus, 'Provider/connection error; the task will be retried.', n);
      await this.recordChanges(iteration, before);
      await this.saveIterationState(iteration);
      throw err;
    }
    clearInterval(timer);
    await this.completeDeveloperIteration({ iteration, task, turn, before });
  }

  /**
   * One developer turn plus follow-ups. OpenCode stops the turn when a permission is declined (by
   * the user or by the unanswered-request timeout) or a question is dismissed. Like a person at
   * the keyboard, tell the developer and let it finish another way (max 2×).
   */
  async developerTurn(task, iteration, { tag } = {}) {
    const run = this.run;
    const n = iteration.n;
    let turn = await this.roleTurn('developer', task.devSessionId, iteration.prompt, { iterationN: n, tag, task, taskType: task.type || 'coding' });
    if (turn.sessionID && turn.sessionID !== task.devSessionId) task.devSessionId = turn.sessionID;
    for (let k = 0; k < 2 && !this.control.stop && !this.control.pause && !this.timeUp(); k++) {
      const declined = turn.status === 'failed' ? turn.errors.filter((e) => e.classification?.category === 'permission_rejected').map((e) => e.message) : [];
      const dismissed = turn.status === 'interrupted' && turn.stoppedWithoutIdle && this.dismissedForms?.delete(task.devSessionId);
      if (!declined.length && !dismissed) break;
      const what = declined.length ? declined.join('; ').slice(0, 500) : 'your question (nobody answered it)';
      this.addLog({ kind: 'info', role: 'developer', text: `${tag ? `[${tag}] ` : ''}${declined.length ? `Telling the developer about the rejected operation; the task continues without it: ${what.slice(0, 200)}` : 'Unanswered question closed; asking the developer to continue on its own judgement.'}` });
      const follow = await this.roleTurn('developer', task.devSessionId, P.rejectionFollowUp(what, { dismissed: !declined.length, unattended: run.limits.unattended }), { iterationN: n, tag, task, taskType: task.type || 'coding' });
      if (follow.sessionID && follow.sessionID !== task.devSessionId) task.devSessionId = follow.sessionID;
      turn = mergeTurns(turn, follow);
    }
    return turn;
  }

  /** Stop-the-clock helper shared by single and parallel iterations: wait for the last answer, interrupt only after finalGraceMin. */
  startTimeLimitWatch() {
    const run = this.run;
    let warned = false;
    const timer = setInterval(() => {
      // Per-turn cap: a developer turn that runs far longer than normal (a model stuck in a loop)
      // is stopped and the task retried with smaller steps, instead of burning the whole night.
      const cap = run.limits.maxTurnMin;
      if (cap) {
        for (const a of this.activeTurns.values()) {
          if (a.role !== 'developer' || a.timedOut || Date.now() - a.startedAt < cap * 60_000) continue;
          a.timedOut = true;
          (this.turnTimeouts ||= new Set()).add(a.sessionID);
          this.addLog({ kind: 'warning', text: `${a.tag ? `[${a.tag}] ` : ''}Developer turn exceeded ${cap} min (per-turn time limit); interrupting, the task will be retried in smaller steps.` });
          this.adapterForHarness(a.harness || this.sessionRoute(a.sessionID).harness).interrupt(a.sessionID).catch(() => {});
        }
      }
      if (!this.timeUp() || !this.activeTurns.size) return;
      if (!warned) {
        warned = true;
        this.addLog({ kind: 'info', text: `Time is up; waiting for the developer's last answer${run.limits.finalGraceMin ? ` (at most ${run.limits.finalGraceMin} min)` : ''}. No new task will start.` });
      }
      const grace = run.limits.finalGraceMin;
      if (grace && this.elapsedActive() > run.limits.durationMin * 60_000 + grace * 60_000) {
        this.addLog({ kind: 'warning', text: `The ${grace} min allowed for the last answer are over too; interrupting the execution.` });
        this.interruptActive('time_limit');
      }
    }, Math.min(10_000, WATCHDOG_MS));
    timer.unref?.();
    return timer;
  }

  /**
   * Parallel developers ("multi-agent"): every task of the wave gets its own OpenCode session whose
   * edit permissions cover only that task's files, all turns run at the same time, then the
   * changes are split by file scope and each task is checked, reviewed and decided as usual.
   * Command checks run once per wave (the project state is the same for all of its tasks).
   */
  async iterateWave(tasks) {
    const run = this.run;
    const waveNo = (run.waveCount = (run.waveCount || 0) + 1);
    const before = await takeSnapshot(this.project.dir);
    const items = [];
    for (const task of tasks) {
      const n = ++run.iterationCount;
      const others = tasks.filter((t) => t !== task).map((t) => ({ id: t.id, title: t.title, files: t.files }));
      const iteration = { n, taskId: task.id, taskTitle: task.title, objectiveVersion: run.objectiveVersion, attempt: task.attempts + 1, startedAt: Date.now(), endedAt: null, status: 'running', wave: waveNo, parallelWith: others.map((o) => o.id), scope: task.files };
      const previousStatus = task.status;
      setTaskStatus(task, 'in_progress', `Iteration #${n} (parallel wave ${waveNo})`, n);
      await this.store.saveSnapshotIndex(run, n, before);
      // A parallel developer must work in a session restricted to its own files.
      if (!task.devSessionId || !task.devSessionScoped || run.limits.sessionPolicy === 'fresh-per-iteration' || !this.quota.canUse(task.devHarness || this.activeHarness).ok) {
        await this.developerSessionFor(task);
        task.devSessionScoped = true;
        this.addLog({ kind: 'session', role: 'developer', text: `[${task.id}] Developer session (may edit only ${task.files.join(', ')}): ${task.devSessionId}` });
      }
      iteration.sessionID = task.devSessionId;
      iteration.prompt = P.developerPrompt({ project: this.project, objective: this.project.objective, rules: this.project.rules, task, tasks: run.tasks, previousAttempts: task.attemptLog || [], checks: this.project.checks, recoveryNote: task.recoveryNote, opts: { ...this.promptOpts(), parallelWith: others } });
      task.recoveryNote = null;
      run.iterations.push(iterationSummary(iteration));
      await this.store.saveIteration(run, iteration);
      items.push({ task, iteration, previousStatus });
    }
    run.currentIteration = items.at(-1).iteration.n;
    this.setActivity('developer', `Paralel dalga #${waveNo}: ${items.map((it) => `#${it.iteration.n} [${it.task.id}] ${it.task.title}`).join(' · ')}`, { taskId: tasks[0].id, taskIds: tasks.map((t) => t.id), iteration: run.currentIteration, wave: waveNo });
    this.addLog({ kind: 'iteration', text: `── Parallel wave #${waveNo} (${items.length} developers): ${items.map((it) => `#${it.iteration.n} [${it.task.id}] ${it.task.title}`).join(' | ')} ──` });
    await this.persist();

    const timer = this.startTimeLimitWatch();
    const settled = await Promise.allSettled(items.map((it) => this.developerTurn(it.task, it.iteration, { tag: it.task.id })));
    clearInterval(timer);

    const all = diffSnapshots(before, await takeSnapshot(this.project.dir));
    const changed = [...all.added, ...all.modified, ...all.deleted];
    const unowned = changed.filter((f) => !items.some((it) => inScope(f, it.task.files)));
    if (unowned.length) this.addLog({ kind: 'warning', text: `Parallel wave #${waveNo}: changes outside every task's scope (e.g. by a shell command) — attributed to all tasks of the wave: ${unowned.slice(0, 20).join(', ')}` });
    const part = (it) => {
      const keep = (f) => inScope(f, it.task.files) || unowned.includes(f);
      return { added: all.added.filter(keep), modified: all.modified.filter(keep), deleted: all.deleted.filter(keep), truncated: all.truncated, patches: all.patches.filter((p) => keep(p.file)) };
    };
    // Checks and reviews of the wave run at the same time (real logs: sequential reviews took as
    // long as the parallel developers). Command checks run once (shared, in-flight deduplicated);
    // manager decisions are queued by askManager.
    this.waveCheckCache = new Map();
    let firstError = null;
    try {
      const done = [];
      for (const [i, it] of items.entries()) {
        const r = settled[i];
        if (r.status === 'rejected') {
          await this.recordChanges(it.iteration, before, part(it));
          it.iteration.status = 'provider_error';
          it.iteration.error = redact(r.reason?.message || String(r.reason));
          it.iteration.endedAt = Date.now();
          setTaskStatus(it.task, it.previousStatus === 'in_progress' ? 'pending' : it.previousStatus, 'Provider/connection error; the task will be retried.', it.iteration.n);
          await this.saveIterationState(it.iteration);
          firstError ||= r.reason;
          continue;
        }
        done.push(this.completeDeveloperIteration({ iteration: it.iteration, task: it.task, turn: r.value, before, changes: part(it) }));
      }
      for (const r of await Promise.allSettled(done)) if (r.status === 'rejected') firstError ||= r.reason;
    } finally {
      this.waveCheckCache = null;
    }
    if (firstError) throw firstError;
  }

  async recordChanges(iteration, before, preset = null) {
    const changes = preset || diffSnapshots(before, await takeSnapshot(this.project.dir));
    iteration.changes = { added: changes.added, modified: changes.modified, deleted: changes.deleted, truncated: changes.truncated };
    iteration.patches = changes.patches;
    // "Lines written" means source code: build output and dependencies are counted separately.
    iteration.lines = lineTotals(changes.patches.filter((p) => !isGeneratedPath(p.file)));
    const gen = changes.patches.filter((p) => isGeneratedPath(p.file));
    iteration.generatedLines = gen.length ? { files: gen.length, ...lineTotals(gen) } : null;
    if (changes.added.length + changes.modified.length + changes.deleted.length) {
      this.addLog({ kind: 'changes', text: `Changed files: ${[...changes.added.map((f) => '+' + f), ...changes.modified.map((f) => '~' + f), ...changes.deleted.map((f) => '−' + f)].slice(0, 30).join(', ')}` });
    }
    return changes;
  }

  async completeDeveloperIteration({ iteration, task, turn, before, recovered = false, changes: presetChanges = null }) {
    const run = this.run;
    const n = iteration.n;
    iteration.turn = turnSummary(turn);
    iteration.developerOutput = turn.allText?.slice(0, 20_000) || '';

    if (turn.status === 'interrupted' || turn.status === 'running') {
      await this.recordChanges(iteration, before, presetChanges);
      iteration.status = 'interrupted';
      iteration.endedAt = Date.now();
      setTaskStatus(task, 'pending', 'Iteration interrupted; the changes may be unfinished.', n);
      task.recoveryNote = 'The previous attempt on this task was interrupted before finishing. Inspect the current state of the files first, keep correct partial work, and complete the task.';
      // A stalled turn (no sign of life, see checkStall) counts like an over-long one, so a task
      // that hangs every time is blocked after a few attempts instead of eating the whole night.
      const stalled = !!this.stallTimeouts?.delete(task.devSessionId);
      if (this.turnTimeouts?.delete(task.devSessionId) || stalled) {
        task.timeouts = (task.timeouts || 0) + 1;
        task.recoveryNote = stalled
          ? 'The previous attempt showed no progress for a long time (probably a command that never returned or waited for input) and was stopped. Keep correct partial work, then finish the task in small, quick steps: no interactive or never-ending commands, use timeouts for long ones.'
          : `The previous attempt exceeded the per-turn time limit (${run.limits.maxTurnMin} min) and was stopped. Keep correct partial work, then finish the task in small, quick steps: avoid long-running commands, huge single writes and repeated re-reading.`;
        if (task.timeouts >= (run.limits.maxAttemptsSameFailure || 3)) {
          setTaskStatus(task, 'blocked', `The developer turn ${stalled ? 'stalled / showed no progress' : 'exceeded the per-turn time limit'} ${task.timeouts} times; task blocked.`, n);
          task.blockedReason = 'repeated_failure';
        }
      }
      await this.saveIterationState(iteration);
      this.addLog({ kind: 'iteration', text: `Iteration #${n} interrupted; task [${task.id}] is pending again.` });
      return;
    }

    const changes = await this.recordChanges(iteration, before, presetChanges);
    const changedFiles = [...changes.added, ...changes.modified];
    iteration.developerStatus = parseDeveloperStatus(turn.finalText || turn.allText);

    // File-scoped checks (syntax) cover every file this task touched across its attempts, not
    // only this iteration: a repair attempt that leaves a broken file untouched must still fail.
    const touched = new Set(task.touchedFiles || []);
    for (const f of changedFiles) touched.add(f);
    for (const f of changes.deleted) touched.delete(f);
    task.touchedFiles = [...touched].slice(-500);

    await this.autoAddBuiltinChecks(changedFiles);
    this.setActivity('checks', `#${n} · running checks…`, { taskId: task.id, iteration: n });
    iteration.checks = await runChecks({ projectDir: this.project.dir, checks: this.project.checks, changedFiles: task.touchedFiles, commandCache: this.waveCheckCache });
    for (const c of iteration.checks) this.addLog({ kind: c.status === 'passed' ? 'check-pass' : c.status === 'failed' ? 'check-fail' : 'check', text: `Check: ${c.name} → ${checkLabel(c.status)}${c.status !== 'passed' && c.output ? ' — ' + String(c.output).slice(0, 300) : ''}` });

    // Reviewer / manager failures must never leave the task stuck "in progress": the evaluation
    // is always recorded first, and a provider error is re-thrown only afterwards.
    let deferredError = null;
    const timeUp = this.timeUp();
    if (timeUp && !recovered) this.addLog({ kind: 'info', text: 'Time is up: the checks of this last iteration ran; review and manager decision are skipped.' });
    // The reviewer is skipped when its verdict cannot change the outcome: a failed check already
    // makes the task "test failed", and with no file change there is nothing to review. Real logs
    // showed the reviewer taking ~35% of a run's time, much of it on such iterations.
    const checksFailed = (iteration.checks || []).some((c) => c.status === 'failed');
    const noChange = changes.added.length + changes.modified.length + changes.deleted.length === 0;
    if (run.limits.reviewerEnabled && !recovered && !timeUp && turn.status === 'succeeded' && (checksFailed || noChange)) {
      this.addLog({ kind: 'info', role: 'reviewer', text: checksFailed ? 'Review skipped: checks failed, the task will be repaired anyway (saves tokens).' : 'Review skipped: no file changes.' });
    }
    if (run.limits.reviewerEnabled && !recovered && !timeUp && !checksFailed && !noChange && turn.status === 'succeeded' && iteration.developerStatus.status !== 'needs_user') {
      this.setActivity('reviewer', `#${n} · the reviewer is assessing…`, { taskId: task.id, iteration: n });
      try {
        const sid = this.waveCheckCache ? await this.reviewSessionFor(task) : await this.ensureSession('reviewer');
        const rt = await this.roleTurn('reviewer', sid, P.reviewPrompt({ objective: this.project.objective, task, developerSummary: turn.finalText, changes, patches: changes.patches, checks: iteration.checks, opts: this.promptOpts() }), { iterationN: n, task, taskType: 'review' });
        const j = extractJson(rt.finalText || rt.allText);
        iteration.review = j
          ? { verdict: String(j.verdict || 'cannot_judge').split(/[\s|]/)[0], issues: (j.issues || []).map(String).slice(0, 12), missingVerification: (j.missing_verification || []).map(String).slice(0, 12), summary: String(j.summary || '').slice(0, 2000), sameModelAsDeveloper: sameModel(run.limits.models) }
          : { verdict: 'cannot_judge', issues: [], missingVerification: [], summary: 'Could not parse the reviewer reply.', sameModelAsDeveloper: sameModel(run.limits.models) };
        this.addLog({ kind: 'review', role: 'reviewer', text: `Review: ${iteration.review.verdict}${iteration.review.issues.length ? ' — ' + iteration.review.issues.slice(0, 3).join('; ') : ''}` });
      } catch (err) {
        if (!(err instanceof ProviderFailure || err instanceof Interrupted)) throw err;
        if (err instanceof ProviderFailure) deferredError = err;
        iteration.review = { verdict: 'cannot_judge', issues: [], missingVerification: [], summary: err instanceof Interrupted ? 'Review interrupted.' : `Review failed: ${err.message}`, sameModelAsDeveloper: sameModel(run.limits.models) };
      }
    }

    const evaluation = this.evaluate(task, iteration, changes);
    iteration.evaluation = evaluation;
    setTaskStatus(task, evaluation.status, evaluation.note, n);
    task.evidence = task.evidence || [];
    task.evidence.push({ iteration: n, status: evaluation.status, checks: (iteration.checks || []).map((c) => ({ name: c.name, status: c.status, exitCode: c.exitCode })), review: iteration.review?.verdict || null, changedFiles: changedFiles.slice(0, 50), at: Date.now() });
    task.attemptLog = task.attemptLog || [];
    task.attemptLog.push({
      n,
      summary: `${evaluation.status}: ${evaluation.note}`,
      failedChecks: (iteration.checks || []).filter((c) => c.status === 'failed').map((c) => `${c.name}: ${String(c.output).slice(-1500)}`).join('\n') || null,
      reviewIssues: iteration.review?.issues?.join('; ') || null,
    });
    if (evaluation.question) task.question = evaluation.question;
    iteration.status = 'completed';
    iteration.endedAt = Date.now();
    this.addLog({ kind: 'evaluation', text: `Evaluation #${n}: [${task.id}] → ${evaluation.label}. ${evaluation.note}` });
    await this.saveIterationState(iteration);

    if (recovered || timeUp) return;
    if (deferredError) throw deferredError;
    // Manager decides the next step from the evidence.
    this.setActivity('manager', `#${n} · the manager is deciding the next step…`);
    let decision = null;
    try {
      decision = await this.askManager(
        P.decisionPrompt({ objective: this.project.objective, tasks: run.tasks, iteration, evaluation, limitsInfo: this.limitsInfo(), improvementMode: run.limits.improvementMode, opts: this.promptOpts() }),
        { iterationN: n, validate: (j) => typeof j.decision === 'string' },
      );
    } catch (err) {
      if (!(err instanceof ProviderFailure || err instanceof Interrupted)) throw err;
      if (err instanceof ProviderFailure) deferredError = err;
    }
    iteration.decision = decision ? { decision: decision.decision, nextTaskId: decision.next_task_id || null, reasoning: String(decision.reasoning || '').slice(0, 2000), userQuestion: decision.user_question || null } : { decision: 'continue', reasoning: 'Could not parse the manager reply; default: continue by priority.', fallback: true };
    if (decision) {
      applyTaskUpdates(run.tasks, decision.task_updates, n);
      const added = this.addTasks(decision.new_tasks || []);
      if (added.length) this.addLog({ kind: 'plan', role: 'manager', text: `The manager added ${added.length} new task(s): ${added.map((t) => t.id + ' ' + t.title).join('; ')}` });
    }
    const d = iteration.decision;
    if (d.decision === 'repair' && !['verified', 'blocked', 'cancelled'].includes(task.status)) {
      if (task.status === 'implemented_unverified') setTaskStatus(task, 'pending', 'The manager asked for a repair.', n);
      run.forceNextTaskId = task.id;
    } else if (d.decision === 'continue' && d.nextTaskId) {
      run.forceNextTaskId = d.nextTaskId;
    } else if (d.decision === 'ask_user' && d.userQuestion) {
      if (run.limits.unattended) {
        // Nobody can answer tonight: the question is recorded for the report, work goes on.
        task.notes = `${task.notes ? task.notes + '\n' : ''}The manager's question to the user (sleep mode, unanswered): ${d.userQuestion}`;
        this.addLog({ kind: 'info', role: 'manager', text: `The manager asked the user a question; in sleep mode the run continues with other tasks: ${d.userQuestion}` });
        if (task.status !== 'verified') setTaskStatus(task, 'waiting_user', `The manager asks: ${d.userQuestion}`, n);
      } else setTaskStatus(task, task.status === 'verified' ? task.status : 'waiting_user', `The manager asks: ${d.userQuestion}`, n);
      task.question = d.userQuestion;
    } else if (d.decision === 'complete') {
      const open = run.tasks.filter((t) => t.status === 'pending' || t.status === 'test_failed');
      if (open.length) this.addLog({ kind: 'info', role: 'manager', text: `The manager said "complete", but ${open.length} task(s) are still open; continuing with the open tasks.` });
    }
    this.addLog({ kind: 'decision', role: 'manager', text: `Decision: ${decisionLabel(d.decision)}${d.reasoning ? ' — ' + d.reasoning.slice(0, 300) : ''}` });
    await this.saveIterationState(iteration);
    if (deferredError) throw deferredError;
  }

  /**
   * Built-in checks have no side effects on the project, so when a run creates the first
   * HTML / JS / Python files (e.g. a project started from scratch) the matching check is added.
   * Command checks are never added automatically.
   */
  async autoAddBuiltinChecks(changedFiles) {
    const want = [];
    if (changedFiles.some((f) => /\.html?$/i.test(f) && !f.includes('/'))) want.push(['html-smoke', 'HTML load and JavaScript error check', { entries: [] }]);
    if (changedFiles.some((f) => /\.(m|c)?js$/i.test(f))) want.push(['js-syntax', 'JavaScript syntax (node --check)', {}]);
    if (changedFiles.some((f) => /\.py$/i.test(f))) want.push(['py-syntax', 'Python syntax (ast.parse)', {}]);
    let added = false;
    for (const [type, name, extra] of want) {
      if (this.project.checks.some((c) => c.type === type)) continue;
      this.project.checks.push({ id: type, type, name, enabled: true, approved: true, auto: true, timeoutSec: 60, ...extra });
      this.addLog({ kind: 'info', text: `Side-effect-free built-in check added automatically: ${name}` });
      added = true;
    }
    if (added) await this.store.saveProject(this.project);
  }

  /**
   * Deterministic evaluation. "verified" requires executed checks that passed after the change;
   * a model's statement ("done", reviewer "pass") is recorded but is never enough on its own.
   */
  evaluate(task, iteration, changes) {
    const max = this.run.limits.maxAttemptsSameFailure || 3;
    const ds = iteration.developerStatus || { status: 'unreported' };
    const vf = verificationFrom(iteration.checks || []);
    const changedCount = changes.added.length + changes.modified.length + changes.deleted.length;
    const review = iteration.review;
    const reviewNote = review ? ` Reviewer: ${review.verdict}.` : '';
    let r;
    if (ds.status === 'needs_user') {
      r = { status: 'waiting_user', note: `The developer needs a user decision: ${ds.reason}`, question: ds.reason };
    } else if (ds.status === 'blocked') {
      r = { status: 'blocked', note: `The developer reported being blocked: ${ds.reason}` };
    } else if (iteration.turn?.status === 'failed') {
      // The OpenCode turn itself failed for a non-provider reason (e.g. a refused permission).
      task.attempts++;
      const why = (iteration.turn.errors || []).map((e) => e.classification?.label || e.type).join(', ') || 'unknown reason';
      const refused = (iteration.turn.errors || []).some((e) => e.classification?.category === 'permission_rejected');
      r = refused
        ? { status: 'blocked', note: `The agent turn could not complete (${why}): an operation the task needs was rejected. The manager may re-plan the task.` }
        : task.attempts >= max ? { status: 'blocked', note: `The agent turn could not complete ${task.attempts} times (${why}); task blocked.` } : { status: 'pending', note: `The agent turn could not complete (${why}); the task can be retried.` };
    } else if (vf.verdict === 'failed') {
      task.attempts++;
      const sig = sha1(iteration.checks.filter((c) => c.status === 'failed').map((c) => c.checkId + ':' + String(c.output).split('\n').find((l) => /error|fail|exception/i.test(l))?.slice(0, 200)).join('|'));
      task.failureSignatures.push(sig);
      const same = task.failureSignatures.filter((s) => s === sig).length;
      if (same >= max || task.attempts >= max * 2) {
        task.blockedReason = 'repeated_failure';
        r = { status: 'blocked', note: `The same failure repeated ${same} times (limit ${max}); task blocked. Failed: ${vf.failed.join(', ')}` };
      } else {
        r = { status: 'test_failed', note: `Failed checks: ${vf.failed.join(', ')} (same failure ${same}/${max}).` };
      }
    } else if (ds.status === 'partial') {
      task.attempts++;
      r = task.attempts >= max * 2 ? { status: 'blocked', note: 'The task was only partly completed again and again; blocked.' } : { status: 'pending', note: `The developer reported partial completion: ${ds.reason}` };
    } else if (vf.verdict === 'passed') {
      if (review && ['fail', 'incomplete'].includes(review.verdict)) {
        r = { status: 'implemented_unverified', note: `Checks passed (${vf.ran}) but the reviewer found gaps/bugs.${reviewNote}` };
      } else if (changedCount === 0) {
        r = { status: 'implemented_unverified', note: `Checks passed but no file change was detected in this iteration; no direct evidence that the task is done.${reviewNote}` };
      } else {
        r = { status: 'verified', note: `${vf.ran} automatic check(s) passed after the change.${reviewNote}` };
      }
    } else {
      r = { status: 'implemented_unverified', note: `No automatic check ran${vf.errored.length ? ` (could not run: ${vf.errored.join(', ')})` : ''}; not verified.${changedCount ? '' : ' No file change was detected either.'}${reviewNote}` };
    }
    return { ...r, label: P_LABEL[r.status] || r.status, developerSelfReport: ds.status, checks: vf };
  }

  async saveIterationState(iteration) {
    const run = this.run;
    if (iteration.status !== 'running' && run.evaluating?.[iteration.n]) delete run.evaluating[iteration.n];
    const idx = run.iterations.findIndex((x) => x.n === iteration.n);
    if (idx >= 0) run.iterations[idx] = iterationSummary(iteration);
    await this.store.saveIteration(run, iteration);
    await this.persist();
  }

  /** After an app restart: look at what actually happened to the last submitted turn. */
  /**
   * An iteration whose OpenCode turn had already ended but whose evaluation (diff, checks,
   * decision) never finished — the app crashed or the loop was restarted in between — must not
   * keep its task "in progress" forever: such a task was never picked again and the run could even
   * be called complete without it (29.10.2026, T10). Nothing is in flight when the loop (re)starts,
   * so every leftover is closed as interrupted and its task goes back to the queue; the work on
   * disk is kept and the developer is told to check it first.
   */
  async recoverOrphans() {
    const run = this.run;
    if (this.activeTurns.size) return;
    let closed = 0;
    let evaluated = 0;
    for (const it of [...(run.iterations || [])]) {
      if (it.status !== 'running' || it.endedAt) continue;
      // The turn had finished: evaluate it now (checks run again, reviewer/manager are skipped).
      const done = run.evaluating?.[it.n];
      if (done) {
        try {
          this.addLog({ kind: 'recovery', text: `Recovery: the developer turn of iteration #${it.n} had finished; evaluating that turn's result instead of running it again.` });
          await this.recoverOneTurn(done);
          delete run.evaluating[it.n];
          if (run.iterations.find((x) => x.n === it.n)?.status !== 'running') {
            evaluated++;
            continue;
          }
        } catch (err) {
          this.addLog({ kind: 'warning', text: `Iteration #${it.n} could not be evaluated in recovery (${redact(err.message)}); the task will be retried.` });
        }
      }
      const file = await this.store.getIteration(run.projectId, run.id, it.n).catch(() => null);
      const rec = file || it;
      rec.status = 'interrupted';
      rec.endedAt = Date.now();
      rec.error = 'This iteration could not be evaluated because the app closed or the loop restarted.';
      if (file) await this.saveIterationState(file);
      closed++;
    }
    let requeued = 0;
    for (const t of run.tasks) {
      if (t.status !== 'in_progress') continue;
      setTaskStatus(t, 'pending', 'Unfinished iteration (the app closed / the loop restarted); the task will be retried.', run.currentIteration);
      t.recoveryNote = 'SleepPilot restarted before your previous attempt at this task was checked. Its changes may already be on disk: inspect the current state first, keep what is correct, finish whatever is missing and verify it.';
      requeued++;
    }
    run.evaluating = {};
    if (closed || requeued || evaluated) {
      this.addLog({ kind: 'recovery', text: `Recovery: ${evaluated ? `evaluated the finished turn of ${evaluated} unfinished iteration(s); ` : ''}closed ${closed} unfinished iteration(s), re-queued ${requeued} task(s) (work on disk is kept).` });
      await this.persist();
    }
  }

  async recoverActiveTurn() {
    const run = this.run;
    const list = Object.values(run.activeTurns || {});
    if (!list.length && run.activeTurn) list.push(run.activeTurn);
    for (const at of list) await this.recoverOneTurn(at);
    run.activeTurns = {};
    run.activeTurn = null;
    await this.persist();
  }

  async recoverOneTurn(at) {
    const run = this.run;
    if (!at) return;
    this.setActivity('recovering', `Checking the last state of the previous turn in ${this.engineName}'s records…`);
    this.addLog({ kind: 'recovery', text: `Recovery: checking the last ${roleLabel(at.role)} instruction sent (${at.messageId}, session ${at.sessionID}).` });
    let turnInfo;
    try {
      turnInfo = await this.adapterForHarness(at.harness || this.sessionRoute(at.sessionID).harness).turnMessages(at.sessionID, at.messageId);
    } catch (err) {
      this.addLog({ kind: 'error', text: `Could not read ${this.engineName} during recovery: ${redact(err.message)}` });
      throw err;
    }
    const iterFile = at.iterationN ? await this.store.getIteration(run.projectId, run.id, at.iterationN) : null;
    const task = iterFile ? run.tasks.find((t) => t.id === iterFile.taskId) : null;
    if (!turnInfo.found) {
      this.addLog({ kind: 'recovery', text: 'The instruction is not in the engine\'s records (it never arrived). The same task will be retried; nothing is sent twice.' });
      if (iterFile && task) {
        iterFile.status = 'not_submitted';
        iterFile.endedAt = Date.now();
        setTaskStatus(task, 'pending', 'The app was restarted; the instruction had not been sent.', iterFile.n);
        await this.saveIterationState(iterFile);
      }
    } else {
      const turn = reconcileTurn(turnInfo, { sessionID: at.sessionID, messageId: at.messageId, startedAt: at.startedAt });
      this.addUsage(at.role, turn.usage);
      this.addLog({ kind: 'recovery', text: `The instruction reached the engine; result: ${turnStatusLabel(turn.status)}. Comparing the project files with the saved snapshot.` });
      if (at.role === 'developer' && iterFile && task) {
        const before = (await this.store.loadSnapshotIndex(run, iterFile.n)) || { files: new Map(), truncated: true };
        // A parallel iteration only owns the changes inside its task's file scope.
        let changes = null;
        if (iterFile.wave && task.files?.length) {
          const all = diffSnapshots(before, await takeSnapshot(this.project.dir));
          const keep = (f) => inScope(f, task.files);
          changes = { added: all.added.filter(keep), modified: all.modified.filter(keep), deleted: all.deleted.filter(keep), truncated: all.truncated, patches: all.patches.filter((p) => keep(p.file)) };
        }
        await this.completeDeveloperIteration({ iteration: iterFile, task, turn, before, recovered: true, changes });
      }
    }
    run.activeTurn = null;
    await this.persist();
  }

  // ------------------------------------------------------------------ state, logging, persistence

  async finish(code, detail) {
    const run = this.run;
    if (TERMINAL.has(run.state) || this.finishing) return;
    this.finishing = true;
    try {
      await this.verifyReverseTarget().catch((err) => log.warn(`target integrity check failed: ${err.message}`));
      await this.computeLineStats();
      if (run.limits.closingReport && CLOSING_CODES.has(code) && !run.closingReport && !this.control.stop?.immediate) await this.writeClosingReport(code, detail);
    } catch (err) {
      log.warn(`closing report failed: ${err.message}`);
      this.addLog({ kind: 'warning', text: `Could not get the closing report: ${redact(err.message)}` });
    }
    this.markActive(false);
    run.endedAt = Date.now();
    run.stopReason = { code, label: STOP_REASONS[code] || code, detail: detail || null, at: Date.now() };
    for (const s of run.steering) if (s.status === 'pending' || s.status === 'applying') s.status = 'not_applied';
    for (const t of run.tasks) if (t.status === 'in_progress') setTaskStatus(t, 'pending', 'The run ended.', run.iterationCount);
    this.setState(code === 'objective_completed' ? 'completed' : code === 'unexpected_error' ? 'failed' : 'stopped');
    this.setActivity('finished', `${STOP_REASONS[code] || code}${detail ? ': ' + detail : ''}`);
    this.addLog({ kind: 'finish', text: `Run finished — ${STOP_REASONS[code] || code}${detail ? ': ' + detail : ''}` });
    await this.persist();
    this.emit('finished', run);
  }

  /** Whole-run change totals: net (start → end) when the start snapshot is in memory, plus the sum of all iterations. */
  async computeLineStats() {
    const run = this.run;
    const iter = { additions: 0, deletions: 0, iterationsWithChanges: 0 };
    for (const it of run.iterations) {
      if (!it.lines) continue;
      iter.additions += it.lines.additions;
      iter.deletions += it.lines.deletions;
      if (it.changedCount) iter.iterationsWithChanges++;
    }
    let net = null;
    if (this.baseline) {
      const changes = diffSnapshots(this.baseline, await takeSnapshot(this.project.dir), { maxPatchChars: 400_000 });
      const lines = lineTotals(changes.patches.filter((p) => !isGeneratedPath(p.file)));
      const gen = changes.patches.filter((p) => isGeneratedPath(p.file));
      net = {
        generated: { files: gen.length, ...lineTotals(gen) },
        added: changes.added,
        modified: changes.modified,
        deleted: changes.deleted,
        additions: lines.additions,
        deletions: lines.deletions,
        files: changes.patches.filter((p) => !isGeneratedPath(p.file)).map((p) => ({ file: p.file, status: p.status, additions: p.additions, deletions: p.deletions, binary: !!p.binary })),
      };
      this.finalPatches = changes.patches;
    }
    run.lineStats = { iterations: iter, net, at: Date.now() };
    await this.persist();
  }

  /**
   * After the last answer, ask OpenCode (in a read-only session, so nothing can change any more)
   * for a full report of the run. SleepPilot's measured facts are given as the source of truth.
   */
  async writeClosingReport(code, detail) {
    const run = this.run;
    this.setActivity('closing', 'Asking the routed harness for the closing report…');
    this.addLog({ kind: 'info', text: 'The run is ending: asking the routed harness for a comprehensive report of this run.' });
    const route = this.routeFor('closing', 'review');
    const { session: s } = await this.createRoleSession('closing', route, {
      title: `SleepPilot · ${this.project.name} · Closing report`,
    });
    this.registerSession('closing', s, route);
    const prompt = P.closingReportPrompt({
      project: this.project,
      run,
      stopReason: STOP_REASONS[code] || code,
      detail,
      hours: this.elapsedActive() / 3_600_000,
      patches: this.finalPatches || [],
      engineLabel: this.engineName,
      opts: this.promptOpts(),
    });
    const t = await this.roleTurn('closing', s.id, prompt);
    run.closingReport = { sessionID: s.id, messageId: t.messageId, status: t.status, text: (t.finalText || t.allText || '').slice(0, 60_000), at: Date.now() };
    this.addLog({ kind: 'info', text: `Closing report received (${s.id}); it is shown on the Report screen and in the report file.` });
    await this.persist();
  }

  setState(state) {
    this.run.state = state;
    this.emitUpdate();
  }

  setActivity(phase, message, extra = {}) {
    this.lastProgressAt = Date.now();
    this.run.activity = { phase, message, since: Date.now(), ...extra };
    this.emitUpdate();
  }

  addLog(entry) {
    const e = { at: Date.now(), ...entry, text: redact(entry.text) };
    this.lastProgressAt = e.at;
    this.logBuffer.push(e);
    if (this.logBuffer.length > 600) this.logBuffer.splice(0, this.logBuffer.length - 600);
    this.emit('log', e);
    this.store.appendEvent(this.run, e).catch(() => {});
  }

  emitUpdate() {
    clearTimeout(this.updateTimer);
    this.updateTimer = setTimeout(() => this.emit('update', this.view()), 50);
    this.updateTimer.unref?.();
  }

  persist() {
    this.emitUpdate();
    this.run.quota = this.quota.snapshot();
    this.saveQueue = this.saveQueue.then(() => this.store.saveRun(this.run)).catch((err) => log.error(`saveRun failed: ${err.message}`));
    return this.saveQueue;
  }
}

const P_LABEL = {
  verified: 'Implemented and verified',
  implemented_unverified: 'Implemented, not verified',
  test_failed: 'Test failed',
  blocked: 'Blocked',
  waiting_user: 'Waiting for the user',
  pending: 'Will be retried',
};

/**
 * Small/local models sometimes copy the JSON example's placeholder values literally
 * ("...", "optional: project-relative files…") instead of writing real tasks. Such tasks can
 * never be worked on and used to flood the list; drop them before they get an id.
 */
function isPlaceholderTask(raw) {
  const title = String(raw?.title || '').trim();
  if (!title) return true;
  if (/^(\.{2,}|…|-+|<.*>)$/.test(title)) return true;
  const all = `${title} ${raw?.description || ''}`.toLowerCase();
  if (all.includes('what to do and where') || all.includes('project-relative files') || all.includes('optional: project-relative')) return true;
  return false;
}

function roleLabel(role) {
  return { manager: 'Manager', developer: 'Developer', reviewer: 'Reviewer', closing: 'Closing report', preflight: 'Model check' }[role] || role;
}

function lineTotals(patches) {
  let additions = 0;
  let deletions = 0;
  for (const p of patches || []) {
    additions += p.additions || 0;
    deletions += p.deletions || 0;
  }
  return { additions, deletions };
}

function turnStatusLabel(s) {
  return { succeeded: 'succeeded', failed: 'failed', interrupted: 'interrupted', running: 'unfinished', not_found: 'not found', lost: 'lost' }[s] || s;
}

function checkLabel(s) {
  return { passed: 'passed', failed: 'failed', skipped: 'skipped', error: 'could not run' }[s] || s;
}

function decisionLabel(d) {
  return { continue: 'continue', repair: 'repair', ask_user: 'ask the user', complete: 'complete' }[d] || d;
}

function toolArg(input) {
  if (!input || typeof input !== 'object') return '';
  const v = input.command || input.path || input.filePath || input.file || input.pattern || input.url || input.query || '';
  return String(v).slice(0, 160);
}

function sameModel(models) {
  const k = (m) => (m ? `${m.providerID}/${m.id}` : 'default');
  return k(models?.developer) === k(models?.reviewer);
}

/** Combine an original developer turn with a follow-up turn in the same session. */
function mergeTurns(a, b) {
  const tokens = {};
  for (const k of Object.keys(a.usage.tokens)) tokens[k] = (a.usage.tokens[k] || 0) + (b.usage?.tokens?.[k] || 0);
  return {
    ...b,
    messageId: a.messageId,
    followUpMessageIds: [...(a.followUpMessageIds || []), b.messageId],
    startedAt: a.startedAt,
    allText: `${a.allText}\n\n${b.allText}`,
    tools: [...a.tools, ...b.tools],
    errors: [...a.errors, ...b.errors].filter((e) => b.status !== 'succeeded' || e.type === 'permission.rejected'),
    usage: { cost: a.usage.cost + (b.usage?.cost || 0), tokens, models: [...new Set([...a.usage.models, ...(b.usage?.models || [])])], source: 'opencode' },
    snapshotFiles: [...new Set([...(a.snapshotFiles || []), ...(b.snapshotFiles || [])])],
  };
}

function turnSummary(t) {
  return { status: t.status, sessionID: t.sessionID, messageId: t.messageId, followUpMessageIds: t.followUpMessageIds || [], startedAt: t.startedAt, endedAt: t.endedAt, outcome: t.outcome, errors: t.errors, usage: t.usage, tools: (t.tools || []).slice(0, 100), finalText: (t.finalText || '').slice(0, 8000) };
}

function iterationSummary(it) {
  return {
    n: it.n,
    taskId: it.taskId,
    taskTitle: it.taskTitle,
    objectiveVersion: it.objectiveVersion,
    attempt: it.attempt,
    sessionID: it.sessionID || null,
    messageId: it.turn?.messageId || null,
    startedAt: it.startedAt,
    endedAt: it.endedAt,
    status: it.status,
    turnStatus: it.turn?.status || null,
    evaluation: it.evaluation ? { status: it.evaluation.status, note: it.evaluation.note } : null,
    checks: (it.checks || []).map((c) => ({ name: c.name, status: c.status, exitCode: c.exitCode })),
    changedCount: it.changes ? it.changes.added.length + it.changes.modified.length + it.changes.deleted.length : null,
    lines: it.lines || null,
    wave: it.wave || null,
    review: it.review?.verdict || null,
    decision: it.decision?.decision || null,
    usage: it.turn?.usage || null,
    error: it.error || null,
  };
}

export { FINAL_STATUSES };
