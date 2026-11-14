import { runFile } from '../util/proc.mjs';

/** Read-only Git helpers. SleepPilot never commits, pushes, resets, or reverts. */
async function git(cwd, args, timeoutMs = 30_000) {
  return runFile('git', ['-c', 'core.quotepath=off', ...args], { cwd, timeoutMs });
}

export async function gitInfo(dir) {
  const probe = await git(dir, ['rev-parse', '--is-inside-work-tree']);
  if (probe.error) return { available: false, isRepo: false, message: 'Git not found.' };
  if (probe.exitCode !== 0 || probe.stdout.trim() !== 'true') return { available: true, isRepo: false };
  const [branch, status, head] = await Promise.all([
    git(dir, ['branch', '--show-current']),
    git(dir, ['status', '--porcelain=v1', '-uall']),
    git(dir, ['rev-parse', '--short', 'HEAD']),
  ]);
  const changes = status.stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => ({ code: l.slice(0, 2), file: l.slice(3) }));
  return {
    available: true,
    isRepo: true,
    branch: branch.stdout.trim() || null,
    head: head.exitCode === 0 ? head.stdout.trim() : null,
    dirty: changes.length > 0,
    changes: changes.slice(0, 500),
    changeCount: changes.length,
  };
}

export async function gitDiffStat(dir) {
  const r = await git(dir, ['diff', '--stat', 'HEAD']);
  return r.exitCode === 0 ? r.stdout : null;
}
