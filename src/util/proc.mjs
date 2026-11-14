import { spawn, spawnSync } from 'node:child_process';

const MAX_CAPTURE = 256 * 1024;

/** Kill a process and its children. On Windows `child.kill()` does not reach grandchildren. */
export function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
  }
}

export function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/**
 * .cmd/.bat files cannot be spawned directly on Windows; route them through cmd.exe.
 * cmd.exe needs the whole command in one quoted argument, and because the file path itself is
 * quoted the command must be wrapped in a second pair of quotes (`cmd /s /c ""C:\a b\x.cmd" --x"`),
 * otherwise a path with spaces is split (this broke dsh.cmd detection).
 */
export function resolveSpawn(file, args) {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(file)) {
    const quote = (a) => (/[\s"&|<>^]/.test(String(a)) ? `"${String(a).replace(/"/g, '""')}"` : String(a));
    const command = `""${file}" ${args.map(quote).join(' ')}"`;
    return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', command], verbatim: true };
  }
  return { file, args, verbatim: false };
}

function cap(s) {
  return s.length > MAX_CAPTURE ? s.slice(0, MAX_CAPTURE / 2) + '\n…[output truncated]…\n' + s.slice(-MAX_CAPTURE / 2) : s;
}

/**
 * Run an executable (no shell) and capture its output.
 * Resolves with { exitCode, stdout, stderr, timedOut, durationMs, error }.
 */
export function runFile(file, args = [], { cwd, env, timeoutMs = 60_000, input } = {}) {
  const sp = resolveSpawn(file, args);
  return runSpawn(sp.file, sp.args, { cwd, env, timeoutMs, input, windowsVerbatimArguments: sp.verbatim });
}

/** Run a user-approved shell command line through cmd.exe (Windows) or sh. */
export function runShell(commandLine, { cwd, env, timeoutMs = 10 * 60_000, signal } = {}) {
  if (process.platform === 'win32') {
    return runSpawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${commandLine}"`], {
      cwd,
      env,
      timeoutMs,
      signal,
      windowsVerbatimArguments: true,
    });
  }
  return runSpawn('/bin/sh', ['-c', commandLine], { cwd, env, timeoutMs, signal });
}

function runSpawn(file, args, { cwd, env, timeoutMs, input, signal, windowsVerbatimArguments }) {
  return new Promise((resolve) => {
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let child;
    try {
      child = spawn(file, args, {
        cwd,
        env: env || process.env,
        windowsHide: true,
        windowsVerbatimArguments,
        stdio: [input != null ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({ exitCode: null, stdout: '', stderr: '', timedOut: false, durationMs: 0, error });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutMs);
    const onAbort = () => {
      aborted = true;
      killTree(child.pid);
    };
    let aborted = false;
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    child.stdout.on('data', (d) => (stdout = cap(stdout + d)));
    child.stderr.on('data', (d) => (stderr = cap(stderr + d)));
    if (input != null) child.stdin.end(input);
    child.on('error', (error) => {
      cleanup();
      resolve({ exitCode: null, stdout, stderr, timedOut, aborted, durationMs: Date.now() - started, error });
    });
    child.on('close', (code) => {
      cleanup();
      resolve({ exitCode: code, stdout, stderr, timedOut, aborted, durationMs: Date.now() - started });
    });
  });
}
