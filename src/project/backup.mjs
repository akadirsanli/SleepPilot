import fsp from 'node:fs/promises';
import path from 'node:path';
import { backupsDir } from '../util/paths.mjs';

export const BACKUP_EXCLUDES = ['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.mypy_cache', '.pytest_cache', '.next', '.cache'];
const MAX_BYTES = Number(process.env.SLEEPPILOT_BACKUP_MAX_BYTES || 2 * 1024 ** 3);
/** Large game/media assets: skipped by the "source files only" fallback. */
const ASSET_EXT = new Set(['.dds', '.brf', '.png', '.jpg', '.jpeg', '.tga', '.bmp', '.gif', '.psd', '.ogg', '.wav', '.mp3', '.flac', '.mp4', '.avi', '.mkv', '.bik', '.zip', '.7z', '.rar', '.exe', '.dll', '.pdb', '.lib', '.obj', '.iso', '.bin', '.pak', '.fbx', '.blend', '.smd', '.sco', '.ttf', '.otf', '.woff', '.woff2', '.pyc']);
const SOURCE_MODE_FILE_LIMIT = 8 * 1024 * 1024;

/**
 * Copy the project's working files to %LOCALAPPDATA%\SleepPilot\backups\<projectId>\<stamp>.
 * Full copy when the folder fits in 2 GB (except BACKUP_EXCLUDES). Otherwise — e.g. a game folder
 * with gigabytes of textures and sounds — a "source files only" copy: media/binary assets and
 * files over 8 MB are left out, so the files an agent edits are still protected.
 * It is a point-in-time copy, not a substitute for version control.
 */
export async function createBackup(projectId, sourceDir) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(backupsDir(), projectId, stamp);
  const excluded = [];
  const all = [];
  async function scan(dir) {
    for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
      const s = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (BACKUP_EXCLUDES.includes(e.name)) excluded.push(path.relative(sourceDir, s));
        else await scan(s);
      } else if (e.isFile()) {
        const st = await fsp.stat(s).catch(() => null);
        if (st) all.push({ rel: path.relative(sourceDir, s), size: st.size });
      }
    }
  }
  try {
    await scan(sourceDir);
    let mode = 'full';
    let list = all;
    let total = all.reduce((n, f) => n + f.size, 0);
    if (total > MAX_BYTES) {
      mode = 'source';
      list = all.filter((f) => f.size <= SOURCE_MODE_FILE_LIMIT && !ASSET_EXT.has(path.extname(f.rel).toLowerCase()));
      total = list.reduce((n, f) => n + f.size, 0);
      if (total > MAX_BYTES) throw new Error(`Even the source files exceed the 2 GB limit (${(total / 1024 ** 3).toFixed(1)} GB); no backup was taken. Choose a narrower project folder (e.g. only the mod folder).`);
    }
    for (const f of list) {
      const d = path.join(dest, f.rel);
      await fsp.mkdir(path.dirname(d), { recursive: true });
      await fsp.copyFile(path.join(sourceDir, f.rel), d);
    }
    const skippedFiles = all.length - list.length;
    return {
      ok: true,
      path: dest,
      files: list.length,
      bytes: total,
      mode,
      skippedFiles,
      excluded,
      createdAt: Date.now(),
      coverage:
        mode === 'full'
          ? `All files in the folder; excluded: ${BACKUP_EXCLUDES.join(', ')}`
          : `Source files only, because the folder is larger than 2 GB (${skippedFiles} media/binary or over-8 MB files skipped; ${BACKUP_EXCLUDES.join(', ')} excluded)`,
    };
  } catch (err) {
    await fsp.rm(dest, { recursive: true, force: true });
    return { ok: false, error: err.message };
  }
}
