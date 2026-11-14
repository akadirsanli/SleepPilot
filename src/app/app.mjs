import { EventEmitter } from 'node:events';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Store, DEFAULT_PROJECT_SETTINGS } from '../store/store.mjs';
import { EngineManager } from '../engines/index.mjs';
import { CredentialStore } from '../engines/credentials.mjs';
import { defaultSettings, sanitizeSettings as sanitizeGlobalSettings, sanitizeToolOverrides, ENGINE_IDS } from '../settings.mjs';
import { RunController, newRunRecord, AUTO_RETRY_PAUSES, MAX_AUTO_RESUMES } from '../orchestrator/run-controller.mjs';
import { redact } from '../util/redact.mjs';
import { PROFILES, normalizeProfile } from '../orchestrator/permissions.mjs';
import { TASK_STATUS_LABELS } from '../orchestrator/tasks.mjs';
import { recommendModels, ROLE_ADVICE } from '../orchestrator/model-advice.mjs';
import { normalizeHarnessRouting, normalizeModelProfiles, normalizeRolePins, validateRoutingConfig } from '../orchestrator/routing.mjs';
import { QuotaTracker } from '../orchestrator/quota-tracker.mjs';
import { inspectProject } from '../project/inspect.mjs';
import { buildReport } from '../report/report.mjs';
import { buildStats } from './stats.mjs';
import { detectTools } from '../tools/detect-tools.mjs';
import { verifyTool } from '../tools/verify.mjs';
import { detectOllama, ollamaProvider } from '../engines/api/ollama.mjs';
import { buildReverseProject } from '../reverse/setup.mjs';
import { scaffoldRustProject, rustStatus, resetCargoCache } from '../reverse/rust.mjs';
import { analyzeProjectScope, analyzeTargetScope } from '../analysis/scope.mjs';
import { buildAnalytics } from '../analytics/analytics.mjs';
import { detectGitHub, pushProject, createRepository, ensureGitRepo } from '../github/github.mjs';
import { ScoutAgent } from '../scout/scout.mjs';
import { REVERSE_MODES } from '../reverse/playbook.mjs';
import { KeepAwake } from './keep-awake.mjs';
import { dataRoot } from '../util/paths.mjs';
import { logger } from '../util/log.mjs';

const log = logger('app');
const ACTIVE_STATES = new Set(['created', 'running', 'paused', 'waiting_user', 'planning']);
/** Crash/hang recoveries a single run may use by itself before it waits for a person. */
export const MAX_CRASH_RECOVERIES = 6;
const RECOVER_DELAY_MS = () => Number(process.env.SLEEPPILOT_RECOVER_DELAY_MS || 30_000);

/** Application service: owns the store, the engine manager and the run controllers. */
export class SleepPilotApp extends EventEmitter {
  constructor({ testMode = false, testCommand, autoConnect = true, recover = true } = {}) {
    super();
    this.testMode = testMode;
    this.testCommand = testCommand;
    this.autoConnect = autoConnect;
    this.recover = recover;
    this.store = new Store();
    this.credentials = new CredentialStore();
    this.scout = new ScoutAgent();
    this.quotaTracker = new QuotaTracker();
    this.manager = new EngineManager({
      settings: {},
      credentials: this.credentials,
      testCommand: this.testMode ? this.testCommand : undefined,
    });
    this.controllers = new Map(); // runId -> RunController
    this.keepAwake = new KeepAwake();
  }

  /** The engine of the default (most recently selected) backend. Kept for compatibility. */
  get adapter() {
    return this.manager.defaultEngine;
  }

  async init() {
    const stored = await this.store.getSettings().catch(() => ({}));
    this.settings = sanitizeGlobalSettings({ ...defaultSettings(), ...stored });
    this.manager.applySettings(this.settings);
    await this.manager.init();
    this.manager.on('status', () => this.emit('broadcast', { type: 'engines', data: this.enginesView() }));
    this.manager.on('stream', (s) => this.emit('broadcast', { type: 'stream', data: s }));
    if (this.recover) await this.recoverRuns();
    if (this.autoConnect) this.manager.connectDefault().catch((err) => log.error(`connect failed: ${err.message}`));
  }

  enginesView() {
    const view = this.manager.view();
    const current = view.engines.find((e) => e.id === view.default) || view.engines[0] || null;
    return {
      ...view,
      current,
      recommendedModels: recommendModels(current?.models || []),
      roleAdvice: ROLE_ADVICE,
    };
  }

  /** Engine for a project/run, defaulting to the global setting (old runs infer OpenCode). */
  engineIdFor(project, run = null) {
    if (run?.engine?.id) return run.engine.id;
    if (project?.settings?.engine) return project.settings.engine;
    if (run?.opencode) return 'opencode';
    return this.manager.settings.engine;
  }

  engineFor(project, run = null) {
    return this.manager.get(this.engineIdFor(project, run));
  }

  async ensureEngineFor(project, run = null) {
    const engine = this.engineFor(project, run);
    if (!engine.connected) {
      await this.manager.connect(engine.id);
      if (!engine.connected) throw new Error(`${engine.label} is not available: ${engine.status.message}`);
    }
    return engine;
  }

  /**
   * Runs that were active when the app stopped are re-opened as paused. What happens next depends
   * on HOW the app stopped:
   *  - closed by the user (clean shutdown) → stays paused until the user presses "Resume";
   *  - crashed / was killed / was restarted by the supervisor after a hang, during a sleep-mode
   *    (unattended) run → continues by itself after a short delay (bounded per run), so one crash
   *    no longer stops the night. A turn in flight is reconciled, never resubmitted;
   *  - paused with an automatic retry pending (provider error, quota…) → the retry timer that was
   *    lost with the old process is armed again.
   */
  async recoverRuns() {
    const crash = parseCrashInfo(process.env.SLEEPPILOT_LAST_CRASH);
    for (const p of await this.store.listProjects()) {
      for (const run of await this.store.listRuns(p.id)) {
        if (!ACTIVE_STATES.has(run.state)) continue;
        if (run.activeSince) {
          run.activeMs += Math.max(0, (run.updatedAt || Date.now()) - run.activeSince);
          run.activeSince = null;
        }
        const was = { state: run.state, pause: run.pause, cleanly: !!run.closedCleanly };
        delete run.closedCleanly;
        run.pending = { permissions: [], forms: [] };
        const unattended = !!run.limits?.unattended;
        const crashed = !was.cleanly && (was.state === 'running' || was.state === 'planning');
        const retryCode = was.state === 'paused' && was.pause && !was.cleanly ? was.pause.code : null;
        const engine = this.engineFor(p, run);
        const ctrl = new RunController({
          store: this.store,
          adapter: engine,
          engineManager: this.manager,
          project: p,
          run,
          routing: run.routingConfig?.routing || p.settings.harnessRouting,
          modelProfiles: run.routingConfig?.modelProfiles || p.settings.modelProfiles,
          rolePins: run.routingConfig?.rolePins || p.settings.rolePins,
          quota: this.quotaTracker,
        });
        let resumeIn = null;
        if (crashed && unattended && (run.crashRecoveries || 0) < MAX_CRASH_RECOVERIES) {
          run.crashRecoveries = (run.crashRecoveries || 0) + 1;
          (run.recoveries ||= []).push({ at: Date.now(), reason: crash?.reason || 'unknown', detail: crash?.detail || null, iteration: run.currentIteration || null });
          resumeIn = RECOVER_DELAY_MS();
          run.state = 'paused';
          run.pause = {
            code: 'app_crashed',
            label: 'The app closed unexpectedly',
            message: `SleepPilot closed while the run was going${crash?.reason ? ` (${crash.reason})` : ''}. Sleep mode: the run continues by itself in ${Math.max(1, Math.round(resumeIn / 1000))} s where it left off (${run.crashRecoveries}/${MAX_CRASH_RECOVERIES}); the result of an unfinished instruction is checked in the engine's records, the instruction is not sent again.`,
            at: Date.now(),
          };
          ctrl.addLog({ kind: 'warning', text: `The app had closed unexpectedly${crash?.reason ? ` — reason: ${crash.reason}` : ''}${crash?.detail ? ` (${crash.detail})` : ''}. Recovery ${run.crashRecoveries}/${MAX_CRASH_RECOVERIES}: the run will continue by itself.` });
        } else if (retryCode && unattended && (AUTO_RETRY_PAUSES[retryCode] || retryCode === 'app_crashed' || (retryCode === 'quota' && was.pause.resetsAt)) && (run.autoResumes || 0) <= MAX_AUTO_RESUMES) {
          // The old process had a wake-up timer for this pause; it died with the process.
          const due = retryCode === 'quota' && was.pause.resetsAt ? was.pause.resetsAt + 60_000 : (was.pause.at || Date.now()) + (AUTO_RETRY_PAUSES[retryCode] || RECOVER_DELAY_MS());
          resumeIn = Math.max(RECOVER_DELAY_MS(), due - Date.now());
          run.state = 'paused';
          ctrl.addLog({ kind: 'info', text: `The app was reopened; the pending automatic resume was set up again (in ${Math.max(1, Math.round(resumeIn / 60_000))} min).` });
        } else {
          run.state = 'paused';
          run.pause = {
            code: 'app_restarted',
            label: 'The app was restarted',
            message: run.activeTurn
              ? 'An instruction was being processed when SleepPilot closed. When you resume, its real result is first checked in the engine\'s records and the project files; the instruction is not sent again.'
              : crashed && unattended
                ? `SleepPilot recovered this run by itself ${run.crashRecoveries || 0} times; the limit is reached. Use the "Resume" button to continue.`
                : 'The run was active when SleepPilot closed. Use the "Resume" button to continue.',
            at: Date.now(),
          };
        }
        await this.store.saveRun(run);
        this.attach(ctrl);
        log.info(`recovered run ${run.id} of ${p.id} as paused${resumeIn != null ? ` (auto-resume in ${Math.round(resumeIn / 1000)} s)` : ''}`);
        if (resumeIn != null) this.scheduleRecoveryResume(ctrl, resumeIn);
      }
    }
  }

  /** Continue a recovered run after delayMs, once its engine is reachable — unless the user acted meanwhile. */
  scheduleRecoveryResume(ctrl, delayMs) {
    const code = ctrl.run.pause?.code;
    const timer = setTimeout(async () => {
      for (let i = 0; i < 90 && !ctrl.adapter?.connected; i++) await new Promise((r) => setTimeout(r, 2000));
      if (ctrl.terminal || ctrl.run.state !== 'paused' || ctrl.run.pause?.code !== code) return;
      this.resumeRun(ctrl.run.id).catch((err) => log.error(`auto-resume failed: ${err.message}`));
    }, delayMs);
    timer.unref?.();
    (this.recoveryTimers ||= []).push(timer);
  }

  attach(ctrl) {
    this.controllers.set(ctrl.run.id, ctrl);
    ctrl.on('update', (view) => {
      this.emit('broadcast', { type: 'run', data: view });
      this.updateKeepAwake();
    });
    ctrl.on('log', (entry) => this.emit('broadcast', { type: 'log', runId: ctrl.run.id, data: entry }));
    ctrl.on('turn', (rec) => this.emit('broadcast', { type: 'turn', runId: ctrl.run.id, data: rec }));
    ctrl.on('finished', () => this.updateKeepAwake());
    return ctrl;
  }

  updateKeepAwake() {
    const busy = [...this.controllers.values()].some((c) => c.run.state === 'running' || c.run.state === 'waiting_user');
    this.keepAwake.set(busy);
  }

  activeControllers() {
    return [...this.controllers.values()].filter((c) => !c.terminal);
  }

  activeController(projectId = null) {
    const all = this.activeControllers();
    return (projectId ? all.find((c) => c.project.id === projectId) : all[0]) || null;
  }

  /** Legacy shape kept for older UI builds and tests; the new UI uses `engines`. */
  opencodeView() {
    const view = this.enginesView();
    const a = view.engines.find((e) => e.id === 'opencode') || null;
    return {
      status: a?.status || { state: 'disconnected', message: 'Not connected' },
      testMode: this.testMode,
      detection: a?.detection || null,
      serverVersion: a?.version || null,
      capabilities: a?.capabilities || null,
      models: a?.models || [],
      agents: a?.agents || [],
      defaultModel: a?.defaultModel || null,
      recommendedModels: recommendModels(a?.models || []),
      roleAdvice: ROLE_ADVICE,
    };
  }

  async state() {
    const projects = await this.store.listProjects();
    const activeList = this.activeControllers();
    const active = activeList[0] || null;
    return {
      app: { name: 'SleepPilot', tagline: 'Plan. Build. Verify. Sleep.', version: '2.4.0', testMode: this.testMode, platform: process.platform, arch: process.arch, node: process.versions.node, dataRoot: dataRoot() },
      engines: this.enginesView(),
      opencode: this.opencodeView(),
      settings: this.settings,
      profiles: PROFILES,
      taskStatusLabels: TASK_STATUS_LABELS,
      defaults: DEFAULT_PROJECT_SETTINGS,
      projects: projects.map((p) => ({ id: p.id, name: p.name, dir: p.dir, updatedAt: p.updatedAt, objective: p.objective, lastRunId: p.lastRunId, kind: p.kind || 'code', reverse: p.reverse ? { targetDir: p.reverse.targetDir, mode: p.reverse.mode } : null })),
      activeRuns: activeList.map((c) => ({
        projectId: c.project.id,
        projectName: c.project.name,
        runId: c.run.id,
        state: c.run.state,
        engine: c.engineName || c.run.engine?.label || null,
        activity: c.run.activity?.message || '',
        iteration: c.run.iterationCount,
      })),
      activeRun: active ? { projectId: active.project.id, runId: active.run.id, state: active.run.state } : null,
    };
  }

  /**
   * Save global settings. Provider API keys are pulled out and stored in the credential store,
   * never in settings.json; everything else is sanitised before it reaches disk.
   */
  async saveSettings(patch) {
    if (Array.isArray(patch?.providers)) {
      for (const p of patch.providers) {
        if (p && Object.prototype.hasOwnProperty.call(p, 'apiKey')) {
          await this.credentials.set(String(p.id || ''), p.apiKey ? String(p.apiKey) : '');
        }
      }
    }
    const merged = { ...this.settings, ...patch, providers: patch.providers ?? this.settings.providers };
    this.settings = sanitizeGlobalSettings(merged);
    this.toolsCache = null;
    await this.store.saveSettings(this.settings);
    this.manager.applySettings(this.settings);
    this.emit('broadcast', { type: 'engines', data: this.enginesView() });
    return this.settings;
  }

  async saveProviderSecret({ providerId, apiKey }) {
    if (!providerId) throw new Error('providerId is required.');
    await this.credentials.set(String(providerId), apiKey ? String(apiKey) : '');
    const engine = this.manager.get('api');
    engine?.applySettings(this.settings);
    this.emit('broadcast', { type: 'engines', data: this.enginesView() });
    return { ok: true };
  }

  async saveEnvSecret({ name, value }) {
    await this.credentials.setEnv(name, value);
    this.emit('broadcast', { type: 'engines', data: this.enginesView() });
    return { ok: true };
  }

  async testEngine(id) {
    const engine = this.manager.get(id);
    if (!engine) throw new Error(`Unknown engine: ${id}`);
    await this.manager.connect(id, { force: true });
    return this.enginesView();
  }

  async reconnect(id = this.settings.engine) {
    if (this.activeController()?.run.state === 'running') throw new Error('Cannot reconnect while a run is active; pause it first.');
    await this.manager.connect(id, { force: true });
    return this.enginesView();
  }

  async createProject({ name, dir, createIfMissing, engine, template }) {
    if (!dir || !path.isAbsolute(dir)) throw new Error('An absolute folder path is required.');
    const st = await fsp.stat(dir).catch(() => null);
    if (!st) {
      if (!createIfMissing) throw new Error('Folder not found. For a new project, tick "create the folder".');
      await fsp.mkdir(dir, { recursive: true });
    } else if (!st.isDirectory()) throw new Error('The selected path is not a folder.');
    const chosen = ENGINE_IDS.includes(engine) ? engine : this.settings.engine;
    const project = await this.store.createProject({ name, dir });
    project.settings.engine = chosen;
    project.settings.models = modelsFor(this.manager.get(chosen), project.settings.models);
    if (template === 'rust') {
      const scaffold = await scaffoldRustProject({ projectDir: project.dir, name: path.basename(project.dir) });
      project.kind = 'rust';
      project.objective = { version: 0, text: '', updatedAt: Date.now() };
      project.rules = 'This is a Rust project. Use idiomatic Rust, keep `cargo check` and `cargo test` green, and never edit files under target/.';
      project.checks = [
        { id: 'cargo-check', type: 'cargo', name: 'cargo check', cargo: 'check', enabled: !!scaffold.cargo?.found, approved: true },
        { id: 'cargo-test', type: 'cargo', name: 'cargo test', cargo: 'test', enabled: !!scaffold.cargo?.found, approved: true },
      ];
    }
    await this.store.saveProject(project);
    await this.inspect(project.id);
    return this.store.getProject(project.id);
  }

  /**
   * "Sleep & Reverse & Rust It": prepare a workspace that analyses a target (read-only) and,
   * optionally, writes a Rust implementation from the resulting specification. See
   * src/reverse/setup.mjs for the pipeline.
   */
  async createReverseProject(opts) {
    const engine = this.manager.get(opts?.engine || this.settings.engine);
    const project = await buildReverseProject({
      store: this.store,
      engine,
      settings: this.settings,
      options: opts || {},
    });
    await this.inspect(project.id);
    return this.getProject(project.id);
  }

  /** Deterministic upfront scope/time recommendation for a project. */
  async projectScope(projectId) {
    const project = await this.store.getProject(projectId);
    if (!project) throw new Error('Project not found.');
    const inspection = project.inspection?.ok ? project.inspection : await inspectProject(project.dir);
    return analyzeProjectScope(project.dir, { inspection });
  }

  /** Preview a reverse target before creating its workspace. */
  async reversePreview({ targetPath, mode = 'rust' } = {}) {
    if (!targetPath) throw new Error('A target path is required.');
    return analyzeTargetScope(targetPath, { mode });
  }

  /** Scout agent: stack + required tools + suggested checks for a project. */
  async scoutProject(projectId) {
    const project = await this.store.getProject(projectId);
    if (!project) throw new Error('Project not found.');
    const inspection = project.inspection?.ok ? project.inspection : await inspectProject(project.dir);
    const [scope, scout, allTools] = await Promise.all([
      analyzeProjectScope(project.dir, { inspection }),
      this.scout.project(project.dir, { inspection }),
      this.tools(),
    ]);
    return decorateScout(scout, { scope, allTools });
  }

  /** Scout an arbitrary folder (Settings → Toolchain) without creating a project. */
  async scoutDirectory({ dir } = {}) {
    if (!dir) throw new Error('A folder is required.');
    const inspection = await inspectProject(dir).catch(() => null);
    const [scope, scout, allTools] = await Promise.all([
      analyzeProjectScope(dir, { inspection }),
      this.scout.project(dir, { inspection }),
      this.tools(),
    ]);
    return decorateScout(scout, { scope, allTools });
  }

  /** Scout a program file/folder directly from its own headers and strings. */
  async scoutTarget({ targetPath } = {}) {
    if (!targetPath) throw new Error('A target file or folder is required.');
    const [scout, allTools] = await Promise.all([this.scout.target(targetPath), this.tools()]);
    return decorateScout(scout, { allTools, kind: 'target' });
  }

  /** Import the Scout agent's checks into a project as suggestions the user must approve. */
  async addScoutChecks(projectId) {
    const project = await this.store.getProject(projectId);
    if (!project) throw new Error('Project not found.');
    const scout = await this.scoutProject(projectId);
    const existing = new Set((project.checks || []).map((c) => c.command || c.id));
    const added = [];
    for (const c of scout.checks || []) {
      if (existing.has(c.command)) continue;
      added.push({
        id: `scout-${c.command.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)}-${added.length + 1}`,
        type: 'command',
        name: c.name,
        command: c.command,
        enabled: false,
        approved: false,
        suggested: true,
        reason: c.why,
        timeoutSec: 900,
      });
    }
    project.checks = sanitizeChecks([...(project.checks || []), ...added]);
    await this.store.saveProject(project);
    return { added: added.length, checks: project.checks, scout };
  }

  /** Modes and toolchain availability for the Reverse & Rust screen. */
  async reverseInfo() {
    resetCargoCache();
    const rust = await rustStatus();
    return { modes: REVERSE_MODES, rust, engines: this.enginesView() };
  }

  async inspect(projectId) {
    const project = await this.store.getProject(projectId);
    const insp = await inspectProject(project.dir);
    project.inspection = insp;
    // Merge suggestions: keep the user's existing check config, add new suggestions disabled/as-is.
    const known = new Set(project.checks.map((c) => c.id));
    for (const c of insp.suggestedChecks || []) if (!known.has(c.id)) project.checks.push({ ...c, approved: false });
    await this.store.saveProject(project);
    return project;
  }

  async getProject(id) {
    const project = await this.store.getProject(id);
    if (!project) throw new Error('Project not found.');
    project.settings = sanitizeSettings({ ...DEFAULT_PROJECT_SETTINGS, ...project.settings });
    const runs = (await this.store.listRuns(id)).map((r) => ({ id: r.id, state: r.state, createdAt: r.createdAt, startedAt: r.startedAt, endedAt: r.endedAt, iterationCount: r.iterationCount, stopReason: r.stopReason, objectiveVersion: r.objectiveVersion, testMode: !!r.opencode?.testMode }));
    return { project, runs };
  }

  async updateProject(id, patch) {
    const project = await this.store.getProject(id);
    if (!project) throw new Error('Project not found.');
    const active = this.activeController(id);
    if (patch.name != null) project.name = String(patch.name).slice(0, 120);
    if (patch.rules != null) project.rules = String(patch.rules).slice(0, 8000);
    if (patch.settings) {
      const merged = { ...project.settings, ...patch.settings };
      validateRoutingConfig(merged);
      project.settings = sanitizeSettings(merged);
    }
    if (patch.checks) project.checks = sanitizeChecks(patch.checks);
    if (patch.objective != null) {
      if (active && active.project.id === id) throw new Error('While a run is going, change the objective in the "New instruction" field so the change is recorded and re-planned.');
      const text = String(patch.objective).trim();
      if (text) this.store.setObjective(project, text, { source: 'user' });
    }
    await this.store.saveProject(project);
    if (active && active.project.id === id) {
      // Keep the live controller's project object in sync for rules/checks edits.
      // Run limits stay as they were at start; settings edits apply to the next run.
      active.project.name = project.name;
      active.project.rules = project.rules;
      active.project.checks = project.checks;
      active.project.settings = project.settings;
      // Saved settings also apply to the running run (limits now, models/permissions from the next session).
      if (patch.settings) await active.applyLiveSettings(project.settings);
    }
    return project;
  }

  /** User edits a task of the active run (priority, text, scope, cancel/reopen) or adds one. */
  async editTask(runId, taskId, patch) {
    const c = this.controllerFor(runId);
    return taskId === 'new' ? c.addUserTask(patch) : c.editTask(taskId, patch);
  }

  /** Change only the active run (e.g. "+1 hour" on the live screen), not the project's defaults. */
  async updateRunSettings(runId, patch) {
    const c = this.controllerFor(runId);
    const clean = sanitizeSettings({ ...c.run.limits, ...patch });
    const picked = {};
    for (const k of Object.keys(patch)) if (k in clean) picked[k] = clean[k];
    return c.applyLiveSettings(picked);
  }

  async startRun(projectId) {
    const active = this.activeControllers();
    if (active.some((c) => c.project.id === projectId)) throw new Error('This project already has an active run.');
    const max = Math.max(1, Number(this.settings.maxConcurrentRuns) || 3);
    if (active.length >= max) throw new Error(`The concurrent-run limit is reached (${max}). Finish or stop a run, or raise the limit in Settings → App.`);
    const project = await this.store.getProject(projectId);
    if (!project) throw new Error('Project not found.');
    if (!project.objective.text.trim()) throw new Error('Enter a main objective first.');
    project.settings = sanitizeSettings({ ...DEFAULT_PROJECT_SETTINGS, ...project.settings });
    validateRoutingConfig(project.settings);
    const engine = await this.ensureEngineFor(project);
    const previousRun = project.lastRunId ? await this.store.getRun(project.id, project.lastRunId).catch(() => null) : null;
    const run = newRunRecord({ id: this.store.newRunId(), project, previousRun });
    // Internal Scout agent: record the stack/profile that the run is starting from, without
    // blocking on optional tool downloads or model calls.
    const scout = await this.scout.project(project.dir, { inspection: project.inspection }).catch(() => null);
    run.scout = scout ? { primary: scout.primary, summary: scout.summary, stacks: scout.stacks.map((s) => s.id), checks: scout.checks.length, risks: scout.risks } : null;
    run.engine = {
      id: engine.id,
      label: engine.label,
      version: engine.serverInfo?.version || engine.detection?.version?.raw || null,
      source: engine.detection?.source || null,
      model: project.settings.models?.developer || engine.defaultModel || null,
    };
    project.lastRunId = run.id;
    await this.store.saveProject(project);
    await this.store.saveRun(run);
    const ctrl = this.attach(new RunController({
      store: this.store,
      adapter: engine,
      engineManager: this.manager,
      project,
      run,
      routing: project.settings.harnessRouting,
      modelProfiles: project.settings.modelProfiles,
      rolePins: project.settings.rolePins,
      quota: this.quotaTracker,
    }));
    await ctrl.start();
    return ctrl.view();
  }

  /** Resume a run (also used by recovery): make sure its engine is connected first. */
  async resumeRun(runId) {
    const ctrl = this.controllerFor(runId);
    const engine = await this.ensureEngineFor(ctrl.project, ctrl.run);
    if (ctrl.adapter !== engine) ctrl.adapter = engine;
    await ctrl.resume();
    return ctrl.view();
  }

  controllerFor(runId) {
    const c = this.controllers.get(runId);
    if (!c) throw new Error('This run is not active.');
    return c;
  }

  async getRun(projectId, runId) {
    const c = this.controllers.get(runId);
    const run = c ? c.view() : await this.store.getRun(projectId, runId);
    if (!run) throw new Error('Run not found.');
    const events = c?.logBuffer?.length ? c.logBuffer.slice(-400) : await this.store.readEvents(projectId, runId, 400);
    return { run, events, live: !!c && !c.terminal };
  }

  /**
   * One line per project for the projects screen. Cached until one of the project's runs changes
   * (reading every iteration file is not free on large projects).
   */
  /** Recommended tools and whether each is installed (read-only; nothing is downloaded or run). */
  async tools(force = false) {
    const fresh = !force && this.toolsCache && Date.now() - this.toolsCache.at < 30_000;
    if (fresh) return this.toolsCache.value;
    const value = await detectTools(this.manager.get('opencode'), {
      overrides: this.settings.toolOverrides || {},
      ollamaBase: this.settings.ollama?.baseUrl || process.env.OLLAMA_HOST || null,
    });
    this.toolsCache = { at: Date.now(), value };
    return value;
  }

  /** Set or clear a manual tool status/path (used when automatic detection is wrong). */
  async saveToolOverride({ toolId, status = 'installed', path = null, version = null, note = null } = {}) {
    if (!toolId) throw new Error('toolId is required.');
    const next = { ...(this.settings.toolOverrides || {}) };
    if (status === 'auto') delete next[toolId];
    else next[toolId] = { status, path: path || null, version: version || null, note: note || null, at: Date.now() };
    this.settings.toolOverrides = sanitizeToolOverrides(next);
    this.toolsCache = null;
    await this.store.saveSettings(this.settings);
    this.emit('broadcast', { type: 'engines', data: this.enginesView() });
    return this.tools();
  }

  /** Detect the local Ollama service, its version and installed models. */
  async ollamaStatus({ baseUrl = null } = {}) {
    const status = await detectOllama({ baseUrl: baseUrl || this.settings.ollama?.baseUrl || process.env.OLLAMA_HOST || null });
    const provider = (this.settings.providers || []).find((p) => p.id === 'ollama' || p.preset === 'ollama') || null;
    return { ...status, provider: provider ? { id: provider.id, label: provider.label, baseUrl: provider.baseUrl, enabled: provider.enabled } : null };
  }

  async saveOllamaHost({ baseUrl } = {}) {
    this.settings = sanitizeGlobalSettings({ ...this.settings, ollama: { ...(this.settings.ollama || {}), baseUrl: String(baseUrl || '').trim() || 'http://127.0.0.1:11434' } });
    this.toolsCache = null;
    await this.store.saveSettings(this.settings);
    return this.ollamaStatus();
  }

  /** Add or refresh an Ollama provider from the discovered local models (no API key). */
  async addOllamaProvider({ baseUrl } = {}) {
    if (baseUrl) await this.saveOllamaHost({ baseUrl });
    const status = await this.ollamaStatus();
    if (!status.running && !status.installed) throw new Error(status.error || 'Ollama was not found. Install it from https://ollama.com/download and start the service.');
    if (!status.models.length) throw new Error('Ollama is running, but it has no models. Pull one first, for example: ollama pull qwen2.5-coder:7b');
    const providers = [...(this.settings.providers || [])];
    const existing = providers.find((p) => p.id === 'ollama' || p.preset === 'ollama');
    const provider = ollamaProvider(status, { existing });
    const extra = providers.filter((p) => p !== existing && p.id !== provider.id);
    this.settings = sanitizeGlobalSettings({ ...this.settings, providers: [...extra, provider] });
    await this.store.saveSettings(this.settings);
    this.manager.applySettings(this.settings);
    // Load the model catalogue immediately so project setup can select a local model, but never
    // disconnect an engine that is executing an active run.
    if (!this.activeController()) await this.manager.connect('api', { force: true }).catch(() => {});
    this.emit('broadcast', { type: 'engines', data: this.enginesView() });
    return { status, provider: this.manager.providerView().find((p) => p.id === provider.id) || null, settings: this.settings };
  }

  /** Model-backed check of a tool's latest version and official download link. */
  async verifyTool(toolId, { model } = {}) {
    return verifyTool(this.manager.get('opencode'), { toolId, model });
  }

  async projectSummaries() {
    this.summaryCache ||= new Map();
    const out = [];
    for (const p of await this.store.listProjects()) {
      const runs = await this.store.listRuns(p.id);
      const key = runs.map((r) => `${r.id}:${r.updatedAt}:${r.state}`).join('|');
      let row = this.summaryCache.get(p.id);
      if (!row || row.key !== key) {
        const st = await buildStats(this.store, p.id, null, { includeTest: this.testMode });
        const last = [...st.runs].sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))[0] || null;
        row = { key, data: { id: p.id, runs: st.project.runs, activeMs: st.project.activeMs, added: st.project.added, deleted: st.project.deleted, verified: st.project.verified, iterations: st.project.iterations, last: last ? { state: last.state, startedAt: last.startedAt, stop: last.stop } : null } };
        this.summaryCache.set(p.id, row);
      }
      out.push(row.data);
    }
    return out;
  }

  /** Measured statistics for the report screen (project totals + one run in detail). */
  async stats(projectId, runId) {
    return buildStats(this.store, projectId, runId, { includeTest: this.testMode });
  }

  /** Cross-project measured analytics for the Insights screen. */
  async analytics() {
    return buildAnalytics(this.store, { includeTest: this.testMode });
  }

  async githubStatus(projectId) {
    const project = await this.store.getProject(projectId);
    if (!project) throw new Error('Project not found.');
    return detectGitHub({ projectDir: project.dir, ghPath: this.settings.github?.ghPath });
  }

  async githubPush(projectId, { message } = {}) {
    const project = await this.store.getProject(projectId);
    if (!project) throw new Error('Project not found.');
    return pushProject({ projectDir: project.dir, message: message || this.settings.github?.commitMessage || 'SleepPilot: update project' });
  }

  async githubCreate(projectId, { name, visibility, description } = {}) {
    const project = await this.store.getProject(projectId);
    if (!project) throw new Error('Project not found.');
    return createRepository({
      projectDir: project.dir,
      name: name || project.name,
      visibility: visibility || this.settings.github?.defaultVisibility || 'private',
      description,
      ghPath: this.settings.github?.ghPath,
    });
  }

  async githubInit(projectId) {
    const project = await this.store.getProject(projectId);
    if (!project) throw new Error('Project not found.');
    return ensureGitRepo({ projectDir: project.dir });
  }

  /** Finished agent turns of a run (chat view), optionally only one iteration's. */
  async getTurns(projectId, runId, { iteration, limit = 80 } = {}) {
    const all = await this.store.readTurns(projectId, runId, iteration ? 2000 : limit);
    return iteration ? all.filter((t) => String(t.iteration) === String(iteration)) : all;
  }

  async getIteration(projectId, runId, n) {
    return this.store.getIteration(projectId, runId, Number(n));
  }

  async report(projectId, runId) {
    const project = await this.store.getProject(projectId);
    const c = this.controllers.get(runId);
    const run = c ? c.view() : await this.store.getRun(projectId, runId);
    const iterations = [];
    for (const it of run.iterations || []) {
      const full = await this.store.getIteration(projectId, runId, it.n);
      if (full) iterations.push(full);
    }
    const stats = await buildStats(this.store, projectId, runId, { includeTest: this.testMode }).catch(() => null);
    const md = buildReport({ project, run, iterations, stats });
    const file = await this.store.saveReport(run, md);
    return { markdown: md, file };
  }

  async usageLimits(projectId) {
    const project = projectId ? await this.store.getProject(projectId) : null;
    // Only the OpenCode engine exposes a provider allowance; other engines report "unsupported".
    return this.manager.get('opencode').usageLimits(project?.dir);
  }

  /** Ask the desktop process to shut down cleanly (used by the right-click menu). */
  requestClose() {
    const active = this.activeControllers().length;
    setTimeout(() => this.emit('close-requested', { activeRuns: active }), 120);
    return { ok: true, closing: true, activeRuns: active };
  }

  async shutdown() {
    this.keepAwake.set(false);
    for (const t of this.recoveryTimers || []) clearTimeout(t);
    // A clean shutdown is the user's decision: the next start must not continue the run by itself.
    for (const c of this.controllers.values()) {
      if (!c.terminal) c.run.closedCleanly = Date.now();
      await c.dispose().catch(() => {});
    }
    await this.manager.shutdown();
  }
}

/** Pick a usable model for each role from the selected engine's catalogue. */
function modelsFor(engine, current = {}) {
  const fallback = engine?.defaultModel || engine?.models?.[0] || null;
  const pick = (m) => (m && engine?.models?.some((x) => x.providerID === m.providerID && x.id === m.id) ? m : fallback);
  return {
    manager: pick(current?.manager),
    developer: pick(current?.developer),
    reviewer: pick(current?.reviewer),
  };
}

const num = (v, { min = 0, max = Infinity, allowNull = true } = {}) => {
  if ((v === null || v === '' || v === undefined) && allowNull) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
};

function sanitizeModel(m) {
  return m && m.providerID && m.id ? { providerID: String(m.providerID), id: String(m.id), ...(m.variant ? { variant: String(m.variant) } : {}) } : null;
}

export function sanitizeSettings(s) {
  return {
    engine: ENGINE_IDS.includes(s.engine) ? s.engine : null,
    durationMin: num(s.durationMin, { min: 1, max: 7 * 24 * 60, allowNull: false }) ?? 60,
    maxIterations: num(s.maxIterations, { min: 1, max: 10_000 }),
    maxAttemptsSameFailure: num(s.maxAttemptsSameFailure, { min: 1, max: 20, allowNull: false }) ?? 3,
    maxTokens: num(s.maxTokens, { min: 1000 }),
    maxCostUsd: num(s.maxCostUsd, { min: 0.01 }),
    improvementMode: !!s.improvementMode,
    autoResumeOnQuotaReset: !!s.autoResumeOnQuotaReset,
    reviewerEnabled: s.reviewerEnabled !== false,
    sessionPolicy: ['fresh-per-task', 'fresh-per-iteration'].includes(s.sessionPolicy) ? s.sessionPolicy : 'fresh-per-task',
    permissionProfile: normalizeProfile(s.permissionProfile),
    backupBeforeRun: s.backupBeforeRun !== false,
    unattended: !!s.unattended,
    permissionTimeoutMin: num(s.permissionTimeoutMin, { min: 0, max: 24 * 60, allowNull: false }) ?? 5,
    scopeMode: s.scopeMode === 'creative' ? 'creative' : 'strict',
    closingReport: s.closingReport !== false,
    language: s.language === 'tr' ? 'tr' : 'en',
    finalGraceMin: num(s.finalGraceMin, { min: 0, max: 240, allowNull: false }) ?? 30,
    carryOverTasks: s.carryOverTasks !== false,
    parallelDevelopers: num(s.parallelDevelopers, { min: 1, max: 4, allowNull: false }) ?? 1,
    planReview: !!s.planReview,
    maxTurnMin: num(s.maxTurnMin, { min: 0, max: 24 * 60, allowNull: false }) ?? 60,
    overtimeMin: num(s.overtimeMin, { min: 0, max: 24 * 60, allowNull: false }) ?? 0,
    overtimeMaxRounds: num(s.overtimeMaxRounds, { min: 1, max: 20, allowNull: false }) ?? 1,
    protectedPaths: (Array.isArray(s.protectedPaths) ? s.protectedPaths : String(s.protectedPaths || '').split(/\r?\n/))
      .map((x) => String(x).trim())
      .filter(Boolean)
      .slice(0, 50),
    preset: ['sleep', 'balanced', 'strict', 'custom'].includes(s.preset) ? s.preset : 'custom',
    models: { manager: sanitizeModel(s.models?.manager), developer: sanitizeModel(s.models?.developer), reviewer: sanitizeModel(s.models?.reviewer) },
    agents: {
      manager: s.agents?.manager ? String(s.agents.manager) : 'build',
      developer: s.agents?.developer ? String(s.agents.developer) : 'build',
      reviewer: s.agents?.reviewer ? String(s.agents.reviewer) : 'build',
    },
    harnessRouting: normalizeHarnessRouting(s.harnessRouting),
    modelProfiles: normalizeModelProfiles(s.modelProfiles),
    rolePins: normalizeRolePins(s.rolePins),
  };
}

function decorateScout(scout, { scope = null, allTools = null, kind = scout.kind } = {}) {
  const byId = new Map((allTools?.tools || []).map((t) => [t.id, t]));
  const requiredTools = (scout.tools || []).map((id) => {
    const t = byId.get(id);
    const status = t?.status || 'unknown';
    const installed = status === 'ok' || status === 'manual' || status === 'warn';
    return {
      id,
      name: t?.name || id,
      status,
      installed,
      path: t?.path || null,
      version: t?.version || null,
      download: t?.download || t?.home || null,
      why: t?.why || null,
    };
  });
  return {
    ...scout,
    kind,
    scope,
    requiredTools,
    missingTools: requiredTools.filter((t) => !t.installed),
    checkedAt: Date.now(),
  };
}

export function sanitizeChecks(list) {
  return (Array.isArray(list) ? list : []).slice(0, 30).map((c, i) => ({
    id: String(c.id || `custom-${i + 1}`).slice(0, 60),
    type: ['command', 'html-smoke', 'js-syntax', 'py-syntax', 'cite-check', 'doc-check', 'cargo'].includes(c.type) ? c.type : 'command',
    name: String(c.name || c.command || c.cargo || 'Check').slice(0, 120),
    command: c.type === 'command' || !c.type ? String(c.command || '').slice(0, 1000) : undefined,
    cargo: c.type === 'cargo' ? ['check', 'test', 'build', 'clippy', 'fmt'].includes(String(c.cargo || '').split(/\s+/)[0]) ? String(c.cargo).slice(0, 100) : 'check' : undefined,
    entries: Array.isArray(c.entries) ? c.entries.map(String).slice(0, 10) : undefined,
    minBytes: c.type === 'doc-check' ? num(c.minBytes, { min: 0, max: 10_000_000, allowNull: false }) ?? 300 : undefined,
    interpreter: c.type === 'py-syntax' && c.interpreter ? String(c.interpreter).slice(0, 400) : undefined,
    enabled: !!c.enabled,
    approved: c.type === 'command' || !c.type ? !!c.approved : true,
    suggested: !!c.suggested,
    reason: c.reason ? String(c.reason).slice(0, 500) : undefined,
    timeoutSec: num(c.timeoutSec, { min: 5, max: 7200, allowNull: false }) ?? 600,
  }));
}

/** Crash info handed over by the supervisor (src/supervisor.mjs) to the restarted app. */
function parseCrashInfo(raw) {
  if (!raw) return null;
  try {
    const j = JSON.parse(raw);
    return { reason: redact(String(j.reason || '')).slice(0, 200), detail: j.detail ? redact(String(j.detail)).slice(0, 300) : null };
  } catch {
    return null;
  }
}
