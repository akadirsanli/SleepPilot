import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { dataRoot, isInside, normalizeDir } from '../util/paths.mjs';
import { readJson, writeJsonAtomic } from '../util/fsx.mjs';

/**
 * The SleepPilot workspace: one folder the user chooses, in which SleepPilot keeps a fixed
 * layout so new projects need nothing but a name.
 *
 *   <workspace>/
 *     sleeppilot-workspace.json   marker (layout version, creation time)
 *     README.md                   what the folders are for
 *     projects/<project>/         one folder per project — the agents work here
 *     exports/<project>/          finished artefacts copied out of a project (APK, AAB)
 *
 * Run history, settings and credentials stay in the per-user data folder (see util/paths.mjs);
 * the workspace only holds what the user would want to open, back up or publish.
 */
export const WORKSPACE_MARKER = 'sleeppilot-workspace.json';
export const WORKSPACE_LAYOUT = { projects: 'projects', exports: 'exports' };
const LAYOUT_VERSION = 1;

const README = `# SleepPilot workspace

SleepPilot keeps your projects in this folder.

| Folder | What it holds |
|---|---|
| \`projects/\` | One folder per project. The agents read and write here. |
| \`exports/\` | Finished files copied out of a project, for example built Android APKs. |

You can move, copy or back up this folder like any other. To use it from another SleepPilot
installation, choose it again under **Settings → Workspace**.

Run history, settings and API keys are **not** stored here; they stay in SleepPilot's own data
folder.
`;

/** Where a workspace is offered by default: a "SleepPilot" folder in the user's home. */
export function suggestedWorkspaceDir() {
  const home = process.env.USERPROFILE || os.homedir();
  return path.join(home, 'SleepPilot');
}

/**
 * Folder name for a project: ASCII letters, digits and dashes only. Build tools such as Gradle
 * and the Android SDK fail on spaces and non-ASCII characters in a path, so "Yarış Oyunu"
 * becomes "yaris-oyunu".
 */
export function projectFolderName(name) {
  const map = { ı: 'i', İ: 'i', ş: 's', Ş: 's', ğ: 'g', Ğ: 'g', ü: 'u', Ü: 'u', ö: 'o', Ö: 'o', ç: 'c', Ç: 'c', ß: 'ss', æ: 'ae', ø: 'o', å: 'a' };
  const ascii = String(name || '')
    .replace(/[ıİşŞğĞüÜöÖçÇßæøå]/g, (c) => map[c] || c)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  const safe = ascii || 'project';
  // Windows device names cannot be used as folder names.
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(safe) ? `${safe}-project` : safe;
}

/** Reject folders that must never become a workspace; returns the resolved path. */
export function validateWorkspaceDir(dir) {
  const raw = String(dir || '').trim();
  if (!raw || !path.isAbsolute(raw)) throw new Error('Choose an absolute folder path for the workspace.');
  const resolved = path.resolve(raw);
  if (path.parse(resolved).root === resolved) throw new Error('A drive root cannot be the workspace. Choose or create a folder, for example a "SleepPilot" folder.');
  if (isInside(dataRoot(), resolved)) throw new Error('The workspace cannot be inside SleepPilot\'s own data folder.');
  return resolved;
}

/** Create the workspace layout (idempotent). Existing files are never overwritten. */
export async function initWorkspace(dir) {
  const root = validateWorkspaceDir(dir);
  await fsp.mkdir(root, { recursive: true });
  for (const sub of Object.values(WORKSPACE_LAYOUT)) await fsp.mkdir(path.join(root, sub), { recursive: true });
  const marker = path.join(root, WORKSPACE_MARKER);
  const existing = await readJson(marker, null).catch(() => null);
  if (!existing) await writeJsonAtomic(marker, { app: 'SleepPilot', layout: LAYOUT_VERSION, createdAt: Date.now() });
  const readme = path.join(root, 'README.md');
  if (!(await fsp.stat(readme).catch(() => null))) await fsp.writeFile(readme, README, 'utf8');
  return root;
}

export const workspaceProjectsDir = (root) => path.join(root, WORKSPACE_LAYOUT.projects);
export const workspaceExportsDir = (root, projectFolder = null) => (projectFolder ? path.join(root, WORKSPACE_LAYOUT.exports, projectFolderName(projectFolder)) : path.join(root, WORKSPACE_LAYOUT.exports));

/** A folder under projects/ that does not exist yet: "my-app", then "my-app-2", … */
export async function newProjectDir(root, name) {
  const base = projectFolderName(name);
  const parent = workspaceProjectsDir(root);
  for (let i = 1; i < 500; i++) {
    const candidate = path.join(parent, i === 1 ? base : `${base}-${i}`);
    if (!(await fsp.stat(candidate).catch(() => null))) return candidate;
  }
  throw new Error('Could not find a free folder name for this project.');
}

/**
 * What the Workspace screen shows: the layout, and every folder under projects/ with the
 * SleepPilot project registered for it (if any). Folders the user copied in by hand show up as
 * "not opened yet" and can be opened with one click.
 */
export async function workspaceView(dir, { projects = [] } = {}) {
  const suggested = suggestedWorkspaceDir();
  if (!dir) return { configured: false, dir: null, suggested, exists: false, folders: [], outside: projects.length };
  const root = path.resolve(dir);
  const st = await fsp.stat(root).catch(() => null);
  const byDir = new Map(projects.map((p) => [p.dirKey || normalizeDir(p.dir), p]));
  const folders = [];
  if (st?.isDirectory()) {
    const entries = await fsp.readdir(workspaceProjectsDir(root), { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const full = path.join(workspaceProjectsDir(root), e.name);
      const p = byDir.get(normalizeDir(full)) || null;
      const fst = await fsp.stat(full).catch(() => null);
      folders.push({ folder: e.name, dir: full, projectId: p?.id || null, name: p?.name || e.name, kind: p?.kind || null, updatedAt: p?.updatedAt || fst?.mtimeMs || null });
    }
    folders.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }
  return {
    configured: true,
    dir: root,
    suggested,
    exists: !!st?.isDirectory(),
    projectsDir: workspaceProjectsDir(root),
    exportsDir: workspaceExportsDir(root),
    folders,
    outside: projects.filter((p) => !isInside(root, p.dir)).length,
  };
}
