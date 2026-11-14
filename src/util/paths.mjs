import os from 'node:os';
import path from 'node:path';

/** Root directory for all SleepPilot data. Override with SLEEPPILOT_HOME (used by tests). */
export function dataRoot() {
  if (process.env.SLEEPPILOT_HOME) return path.resolve(process.env.SLEEPPILOT_HOME);
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'SleepPilot');
}

export const projectsDir = () => path.join(dataRoot(), 'projects');
export const projectDir = (projectId) => path.join(projectsDir(), projectId);
export const runDir = (projectId, runId) => path.join(projectDir(projectId), 'runs', runId);
export const backupsDir = () => path.join(dataRoot(), 'backups');
export const settingsFile = () => path.join(dataRoot(), 'settings.json');
export const credentialsFile = () => path.join(dataRoot(), 'credentials.json');
export const appStateFile = () => path.join(dataRoot(), 'app-state.json');
export const engineSessionsDir = (engineId = 'api') => path.join(dataRoot(), 'engine-sessions', engineId);

/** Case-insensitive, separator-normalised form of a Windows path, used for identity comparisons. */
export function normalizeDir(p) {
  let r = path.resolve(p).replace(/[\\/]+$/, '');
  if (process.platform === 'win32') r = r.toLowerCase();
  return r;
}
