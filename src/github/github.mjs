import fsp from 'node:fs/promises';
import path from 'node:path';
import { runFile } from '../util/proc.mjs';

/**
 * Local GitHub/git integration. Nothing is pushed automatically: every publish/commit is an
 * explicit user action. Repository creation uses the GitHub CLI (`gh`); existing git credentials
 * are used for push, so no token is stored by SleepPilot.
 */
export async function detectGitHub({ projectDir, ghPath = null } = {}) {
  const dir = path.resolve(projectDir);
  const st = await fsp.stat(dir).catch(() => null);
  if (!st?.isDirectory()) throw new Error('Project folder not found.');
  const git = await runFile('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree'], { timeoutMs: 20_000 }).catch(() => null);
  const isRepo = !!git && git.exitCode === 0 && /true/.test(git.stdout || '');
  const out = { dir, isRepo, branch: null, remote: null, webUrl: null, dirty: false, changes: 0, gh: { found: false, authenticated: false, version: null, path: null, message: null }, repo: null };
  if (!isRepo) return out;
  const [branch, remote, status] = await Promise.all([
    gitRun(dir, ['rev-parse', '--abbrev-ref', 'HEAD']),
    gitRun(dir, ['remote', 'get-url', 'origin']),
    gitRun(dir, ['status', '--porcelain']),
  ]);
  let branchName = (branch.stdout || '').trim();
  if (!branchName || branchName === 'HEAD') {
    const symbolic = await gitRun(dir, ['symbolic-ref', '--short', 'HEAD']);
    branchName = (symbolic.stdout || '').trim();
  }
  out.branch = branchName || null;
  out.remote = (remote.stdout || '').trim() || null;
  out.changes = (status.stdout || '').split('\n').filter(Boolean).length;
  out.dirty = out.changes > 0;
  out.webUrl = remoteToWeb(out.remote);
  const gh = await findGh(ghPath);
  out.gh = gh;
  if (gh.found) {
    const auth = await runFile(gh.path, ['auth', 'status'], { timeoutMs: 30_000 }).catch(() => null);
    const text = `${auth?.stdout || ''}\n${auth?.stderr || ''}`.trim();
    out.gh.authenticated = !!auth && /logged in to github\.com|logged in/i.test(text);
    out.gh.message = text.split('\n').filter((l) => /logged in|not logged|token|account/i.test(l)).slice(0, 2).join(' · ') || null;
    if (out.gh.authenticated && out.webUrl) {
      const view = await runFile(gh.path, ['repo', 'view', '--json', 'nameWithOwner,url,description,visibility,stargazerCount,forkCount,defaultBranchRef,updatedAt'], { cwd: dir, timeoutMs: 30_000 }).catch(() => null);
      if (view?.exitCode === 0) {
        try {
          out.repo = JSON.parse(view.stdout);
        } catch {}
      }
    }
  }
  return out;
}

export async function pushProject({ projectDir, message = 'SleepPilot: update project', branch = null } = {}) {
  const dir = path.resolve(projectDir);
  const status = await detectGitHub({ projectDir: dir });
  if (!status.isRepo) throw new Error('This folder is not a Git repository. Create one first (or use Create GitHub repository).');
  if (!status.remote) throw new Error('This repository has no "origin" remote. Create a GitHub repository first.');
  const targetBranch = branch || status.branch || 'main';
  const steps = [];
  if (status.changes) {
    const add = await runFile('git', ['-C', dir, 'add', '-A'], { timeoutMs: 120_000 });
    steps.push({ step: 'git add -A', exitCode: add.exitCode, output: tail(add.stdout + add.stderr) });
    if (add.exitCode !== 0) throw new Error(`git add failed: ${tail(add.stderr)}`);
    const commit = await runFile('git', ['-C', dir, 'commit', '-m', String(message || 'SleepPilot update').slice(0, 500)], { timeoutMs: 120_000 });
    steps.push({ step: 'git commit', exitCode: commit.exitCode, output: tail(commit.stdout + commit.stderr) });
    if (commit.exitCode !== 0) throw new Error(`git commit failed: ${tail(commit.stderr)}`);
  }
  const push = await runFile('git', ['-C', dir, 'push', '-u', 'origin', targetBranch], { timeoutMs: 10 * 60_000 });
  steps.push({ step: `git push -u origin ${targetBranch}`, exitCode: push.exitCode, output: tail(push.stdout + push.stderr) });
  if (push.exitCode !== 0) throw new Error(`git push failed: ${tail(push.stderr)}`);
  return { ok: true, branch: targetBranch, committed: !!status.changes, steps, status: await detectGitHub({ projectDir: dir }) };
}

export async function createRepository({ projectDir, name, visibility = 'private', description = '', push = true, ghPath = null } = {}) {
  const dir = path.resolve(projectDir);
  const gh = await findGh(ghPath);
  if (!gh.found) throw new Error('The GitHub CLI (gh) was not found. Install it from https://cli.github.com/ and run `gh auth login`.');
  const auth = await runFile(gh.path, ['auth', 'status'], { timeoutMs: 30_000 }).catch(() => null);
  if (!auth || !/logged in/i.test(`${auth.stdout}\n${auth.stderr}`)) throw new Error('The GitHub CLI is not signed in. Run `gh auth login` in a terminal first.');
  const st = await detectGitHub({ projectDir: dir, ghPath });
  if (st.remote) throw new Error(`This folder already has an origin remote: ${st.remote}`);
  const repoName = String(name || path.basename(dir)).replace(/[^\w.-]+/g, '-').slice(0, 100);
  const hasCommit = (await runFile('git', ['-C', dir, 'rev-parse', '--verify', 'HEAD'], { timeoutMs: 20_000 }).catch(() => null))?.exitCode === 0;
  const args = ['repo', 'create', repoName, `--${visibility === 'public' ? 'public' : 'private'}`, '--source', '.', '--remote', 'origin'];
  if (description) args.push('--description', String(description).slice(0, 350));
  if (push && hasCommit) args.push('--push');
  const r = await runFile(gh.path, args, { cwd: dir, timeoutMs: 10 * 60_000 });
  if (r.exitCode !== 0) throw new Error(`gh repo create failed: ${tail(r.stderr || r.stdout)}`);
  return { ok: true, name: repoName, pushed: !!(push && hasCommit), note: push && !hasCommit ? 'Repository created without pushing: the folder has no commit yet. Use Commit & push.' : null, output: tail(r.stdout + r.stderr), status: await detectGitHub({ projectDir: dir, ghPath }) };
}

export async function ensureGitRepo({ projectDir, initialBranch = 'main' } = {}) {
  const dir = path.resolve(projectDir);
  const st = await detectGitHub({ projectDir: dir });
  if (st.isRepo) return { ok: true, created: false, status: st };
  const init = await runFile('git', ['init', '-b', initialBranch], { cwd: dir, timeoutMs: 60_000 });
  if (init.exitCode !== 0) throw new Error(`git init failed: ${tail(init.stderr)}`);
  return { ok: true, created: true, status: await detectGitHub({ projectDir: dir }) };
}

async function findGh(explicit) {
  const candidates = [explicit, process.env.GH_CLI, 'gh', '%ProgramFiles%\\GitHub CLI\\gh.exe', '%LOCALAPPDATA%\\Programs\\GitHub CLI\\gh.exe', '%USERPROFILE%\\scoop\\shims\\gh.exe'].filter(Boolean);
  for (const raw of candidates) {
    const file = String(raw).replace(/%(?<name>[^%]+)%/g, (_, n) => process.env[n] || '');
    const r = await runFile(file, ['--version'], { timeoutMs: 20_000 }).catch(() => null);
    if (r && !r.error) {
      return { found: true, path: file, version: `${r.stdout || ''}${r.stderr || ''}`.trim().split('\n')[0], authenticated: false, message: null };
    }
  }
  return { found: false, path: null, version: null, authenticated: false, message: 'GitHub CLI (gh) not found.' };
}

async function gitRun(dir, args) {
  return runFile('git', ['-C', dir, ...args], { timeoutMs: 30_000 }).catch(() => ({ stdout: '', stderr: '', exitCode: 1 }));
}

function remoteToWeb(remote) {
  if (!remote) return null;
  const s = String(remote).trim();
  const ssh = s.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
  if (ssh) return `https://github.com/${ssh[1]}/${ssh[2].replace(/\.git$/, '')}`;
  const https = s.match(/^https?:\/\/[^/]*github\.com\/([^/]+)\/(.+?)(?:\.git)?$/i);
  if (https) return `https://github.com/${https[1]}/${https[2].replace(/\.git$/, '')}`;
  return null;
}

function tail(s, n = 4000) {
  const str = String(s || '').trim();
  return str.length > n ? str.slice(-n) : str;
}
