import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

/**
 * Write JSON atomically: write a temp file in the same directory, then rename over the target.
 * A crash mid-write leaves either the old or the new file, never a truncated one.
 */
let tmpSeq = 0;

export async function writeJsonAtomic(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  // Unique per call: two writes in the same millisecond must never share a temp file, or their
  // contents interleave (seen as a corrupted app-state.json).
  const tmp = `${file}.${process.pid}.${Date.now()}.${tmpSeq++}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  for (let i = 0; ; i++) {
    try {
      await fsp.rename(tmp, file);
      return;
    } catch (err) {
      // Windows can briefly lock the target (antivirus, indexer). Retry a few times.
      if (i >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes(err.code)) {
        await fsp.rm(tmp, { force: true });
        throw err;
      }
      await new Promise((r) => setTimeout(r, 50 * (i + 1)));
    }
  }
}

export async function readJson(file, fallback = undefined) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw err;
  }
}

export function readJsonSync(file, fallback = undefined) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw err;
  }
}

/** Read JSON; a missing or unreadable/corrupted file gives `fallback` (for best-effort state files). */
export function readJsonLenientSync(file, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

const updateChains = new Map();

/**
 * Read-modify-write of a small shared JSON file, serialised per file within this process so
 * concurrent updates (UI port, OpenCode server PID) cannot drop each other's fields.
 */
export function updateJsonFile(file, mutate) {
  const prev = updateChains.get(file) || Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(async () => {
      const value = readJsonLenientSync(file, {});
      mutate(value);
      await writeJsonAtomic(file, value);
    });
  updateChains.set(file, next);
  return next;
}

export async function appendJsonl(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.appendFile(file, JSON.stringify(value) + '\n', 'utf8');
}

export async function readJsonl(file, { limit } = {}) {
  let text;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const lines = text.split('\n').filter(Boolean);
  const slice = limit ? lines.slice(-limit) : lines;
  const out = [];
  for (const l of slice) {
    try {
      out.push(JSON.parse(l));
    } catch {
      // A crash can leave a partial last line; skip it.
    }
  }
  return out;
}

export async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function writeText(file, text) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, text, 'utf8');
}
