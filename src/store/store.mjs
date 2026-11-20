import fsp from 'node:fs/promises';
import path from 'node:path';
import { projectsDir, projectDir, runDir, normalizeDir, settingsFile } from '../util/paths.mjs';
import { readJson, writeJsonAtomic, appendJsonl, readJsonl, writeText } from '../util/fsx.mjs';
import { sha1, slugify, sortableId } from '../util/ids.mjs';
import { redactDeep } from '../util/redact.mjs';

export const DEFAULT_PROJECT_SETTINGS = {
  engine: null,
  durationMin: 60,
  maxIterations: 30,
  maxAttemptsSameFailure: 3,
  maxTokens: null,
  maxCostUsd: null,
  improvementMode: false,
  autoResumeOnQuotaReset: false,
  reviewerEnabled: true,
  // Ask a different engine for a diagnosis when a task fails repeatedly, stalls or loops.
  secondOpinion: true,
  sessionPolicy: 'fresh-per-task',
  permissionProfile: 'balanced',
  backupBeforeRun: true,
  unattended: false,
  permissionTimeoutMin: 5,
  scopeMode: 'strict',
  closingReport: true,
  language: 'en',
  finalGraceMin: 30,
  carryOverTasks: true,
  protectedPaths: [],
  parallelDevelopers: 1,
  overtimeMin: 0,
  maxTurnMin: 60,
  planReview: false,
  overtimeMaxRounds: 1,
  preset: 'custom',
  models: { manager: null, developer: null, reviewer: null },
  agents: { manager: 'build', developer: 'build', reviewer: 'build' },
  // Declarative multi-harness routing. Empty objects mean "use the defaults" and keep the
  // current single-engine behaviour until the user explicitly enables routing.
  harnessRouting: {},
  modelProfiles: {},
  rolePins: {},
};

/** Persistent store: one folder per project, one folder per run. Projects are fully isolated. */
export class Store {
  async getSettings() {
    return readJson(settingsFile(), {});
  }

  async saveSettings(s) {
    await writeJsonAtomic(settingsFile(), s);
  }

  projectIdFor(dir, name) {
    return `${slugify(name || path.basename(dir))}-${sha1(normalizeDir(dir)).slice(0, 10)}`;
  }

  async listProjects() {
    let entries = [];
    try {
      entries = await fsp.readdir(projectsDir(), { withFileTypes: true });
    } catch {
      return [];
    }
    const out = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const p = await readJson(path.join(projectDir(e.name), 'project.json'), null).catch(() => null);
      if (p) out.push(p);
    }
    return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  async getProject(id) {
    return readJson(path.join(projectDir(id), 'project.json'), null);
  }

  async findProjectByDir(dir) {
    const key = normalizeDir(dir);
    return (await this.listProjects()).find((p) => p.dirKey === key) || null;
  }

  async createProject({ name, dir }) {
    const existing = await this.findProjectByDir(dir);
    if (existing) return existing;
    const id = this.projectIdFor(dir, name);
    const now = Date.now();
    const project = {
      id,
      name: name || path.basename(dir),
      dir: path.resolve(dir),
      dirKey: normalizeDir(dir),
      kind: 'code',
      createdAt: now,
      updatedAt: now,
      objective: { version: 0, text: '', updatedAt: now },
      objectiveHistory: [],
      rules: '',
      settings: structuredClone(DEFAULT_PROJECT_SETTINGS),
      checks: [],
      inspection: null,
      lastRunId: null,
    };
    await this.saveProject(project);
    return project;
  }

  async saveProject(project) {
    project.updatedAt = Date.now();
    await writeJsonAtomic(path.join(projectDir(project.id), 'project.json'), redactDeep(project));
  }

  /** Record a new objective version. Every version is kept in objectiveHistory. */
  setObjective(project, text, { source, instruction, runId, summary } = {}) {
    if (project.objective.text === text && project.objective.version > 0) return project.objective;
    const version = project.objective.version + 1;
    project.objective = { version, text, updatedAt: Date.now() };
    project.objectiveHistory.push({ version, text, source: source || 'user', instruction: instruction || null, runId: runId || null, summary: summary || null, at: Date.now() });
    return project.objective;
  }

  newRunId() {
    return sortableId('run_');
  }

  async listRuns(projectId) {
    let entries = [];
    try {
      entries = await fsp.readdir(path.join(projectDir(projectId), 'runs'), { withFileTypes: true });
    } catch {
      return [];
    }
    const runs = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const r = await readJson(path.join(runDir(projectId, e.name), 'run.json'), null).catch(() => null);
      if (r) runs.push(r);
    }
    return runs.sort((a, b) => b.createdAt - a.createdAt);
  }

  async getRun(projectId, runId) {
    return readJson(path.join(runDir(projectId, runId), 'run.json'), null);
  }

  async saveRun(run) {
    run.updatedAt = Date.now();
    await writeJsonAtomic(path.join(runDir(run.projectId, run.id), 'run.json'), redactDeep(run));
  }

  async saveIteration(run, iteration) {
    await writeJsonAtomic(path.join(runDir(run.projectId, run.id), 'iterations', `${String(iteration.n).padStart(4, '0')}.json`), redactDeep(iteration));
  }

  async getIteration(projectId, runId, n) {
    return readJson(path.join(runDir(projectId, runId), 'iterations', `${String(n).padStart(4, '0')}.json`), null);
  }

  async saveSnapshotIndex(run, n, snap) {
    const index = {};
    for (const [k, v] of snap.files) index[k] = { size: v.size, mtimeMs: v.mtimeMs, hash: v.hash };
    await writeJsonAtomic(path.join(runDir(run.projectId, run.id), 'iterations', `${String(n).padStart(4, '0')}.before.json`), { takenAt: snap.takenAt, truncated: snap.truncated, files: index });
  }

  async loadSnapshotIndex(run, n) {
    const raw = await readJson(path.join(runDir(run.projectId, run.id), 'iterations', `${String(n).padStart(4, '0')}.before.json`), null);
    if (!raw) return null;
    return { takenAt: raw.takenAt, truncated: raw.truncated, files: new Map(Object.entries(raw.files)) };
  }

  /** One record per finished OpenCode turn (role, prompt head, ordered transcript, usage) — the chat view. */
  async appendTurn(run, rec) {
    await appendJsonl(path.join(runDir(run.projectId, run.id), 'turns.jsonl'), redactDeep(rec));
  }

  async readTurns(projectId, runId, limit = 80) {
    return readJsonl(path.join(runDir(projectId, runId), 'turns.jsonl'), { limit });
  }

  async appendEvent(run, entry) {
    await appendJsonl(path.join(runDir(run.projectId, run.id), 'events.jsonl'), redactDeep({ at: Date.now(), ...entry }));
  }

  async readEvents(projectId, runId, limit = 500) {
    return readJsonl(path.join(runDir(projectId, runId), 'events.jsonl'), { limit });
  }

  async saveReport(run, markdown) {
    const file = path.join(runDir(run.projectId, run.id), 'report.md');
    await writeText(file, markdown);
    return file;
  }
}
