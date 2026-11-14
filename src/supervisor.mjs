/**
 * Supervisor: keeps the SleepPilot app process alive through a night run.
 *
 * Origin: on 29.10.2026 the app died at 08:03 with a JavaScript out-of-memory error in the middle of
 * an unattended run. Nothing was left to restart it, the log file had no line about it (a fatal
 * V8 error never reaches the app's own logger), and the run sat there until the user came back.
 *
 * The supervisor is a tiny parent process that does no real work, so it has nothing to crash on:
 *  - it starts the app as a child process (`--worker`) and passes the same UI token every time, so
 *    the open window simply reconnects after a restart;
 *  - the child sends a heartbeat every few seconds; no heartbeat for SLEEPPILOT_HANG_MS (default
 *    3 min) means the child's event loop is frozen → the child (and its OpenCode server) is killed;
 *  - when the child dies unexpectedly — crash, out of memory, killed, frozen, or it asked for a
 *    restart because a run stalled — the reason and the tail of its stderr are written to the log
 *    file and the child is started again (with a growing delay if it keeps crashing);
 *  - the restarted app recovers its runs from disk; a sleep-mode run then continues by itself.
 *  - a clean exit (the user closed SleepPilot) ends the supervisor too.
 */
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import v8 from 'node:v8';
import { logger } from './util/log.mjs';
import { redact } from './util/redact.mjs';

const log = logger('supervisor');

export const HEARTBEAT_MS = 5_000;
const hangMs = () => Number(process.env.SLEEPPILOT_HANG_MS || 180_000);
const restartDelayMs = () => Number(process.env.SLEEPPILOT_RESTART_DELAY_MS || 3_000);
const STDERR_TAIL_LINES = 40;

/** Kill a process and everything it started (on Windows the OpenCode server is a grandchild). */
export function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
}

/** Human-readable reason for an unexpected child exit, from its exit code/signal and stderr. */
export function describeExit({ code, signal, stderrTail = '', hung = false, requested = null }) {
  if (requested) return { reason: `restart requested — ${requested}`, detail: null };
  if (hung) return { reason: 'the app stopped responding (event loop frozen)', detail: null };
  const oom = /heap out of memory|Reached heap limit|Allocation failed/i.test(stderrTail);
  const last = stderrTail.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-3).join(' | ');
  if (oom) return { reason: 'out of memory (JavaScript heap out of memory)', detail: last.slice(0, 300) || null };
  if (signal) return { reason: `process ended by signal (${signal})`, detail: last.slice(0, 300) || null };
  return { reason: `process exited unexpectedly (exit code ${code})`, detail: last.slice(0, 300) || null };
}

/**
 * Run the app under supervision. entry = path of src/main.mjs, args = the user's CLI args.
 * Resolves with the exit code the supervisor should exit with.
 */
export function supervise({ entry, args = [], execArgv = [] }) {
  const token = crypto.randomBytes(24).toString('base64url');
  let child = null;
  let stopping = false;
  let restarts = [];
  let first = true;
  let lastCrash = null;

  return new Promise((resolveExit) => {
    const startChild = () => {
      const childArgs = [...execArgv, entry, ...args.filter((a) => a !== '--worker'), '--worker'];
      if (!first && !childArgs.includes('--no-open')) childArgs.push('--no-open');
      const env = { ...process.env, SLEEPPILOT_WORKER: '1', SLEEPPILOT_UI_TOKEN: token };
      if (lastCrash) env.SLEEPPILOT_LAST_CRASH = JSON.stringify(lastCrash);
      else delete env.SLEEPPILOT_LAST_CRASH;
      first = false;
      const c = spawn(process.execPath, childArgs, { stdio: ['inherit', 'inherit', 'pipe', 'ipc'], env, windowsHide: false });
      child = c;
      let tail = [];
      let lastBeat = Date.now();
      let hung = false;
      let requested = null;
      c.stderr.on('data', (buf) => {
        process.stderr.write(buf);
        tail.push(...buf.toString('utf8').split(/\r?\n/));
        if (tail.length > STDERR_TAIL_LINES) tail = tail.slice(-STDERR_TAIL_LINES);
      });
      c.on('message', (m) => {
        if (m?.type === 'hb') lastBeat = Date.now();
        else if (m?.type === 'restart' && !requested) {
          requested = String(m.reason || 'unknown reason').slice(0, 200);
          log.warn(`app asked for a restart: ${requested}`);
          killTree(c.pid);
        }
      });
      const watch = setInterval(() => {
        if (stopping || hung || requested) return;
        if (Date.now() - lastBeat > hangMs()) {
          hung = true;
          log.error(`app did not answer for ${Math.round((Date.now() - lastBeat) / 1000)} s; killing and restarting it`);
          killTree(c.pid);
        }
      }, Math.min(HEARTBEAT_MS * 2, hangMs()));
      c.on('exit', (code, signal) => {
        clearInterval(watch);
        if (child === c) child = null;
        if (stopping) return resolveExit(0);
        if (code === 0 && !hung && !requested) return resolveExit(0); // closed normally by the user
        const stderrTail = redact(tail.join('\n'));
        lastCrash = { at: Date.now(), ...describeExit({ code, signal, stderrTail, hung, requested }) };
        log.error(`app exited unexpectedly: ${lastCrash.reason}${lastCrash.detail ? ` — ${lastCrash.detail}` : ''}`);
        if (stderrTail.trim()) log.error(`last stderr lines:\n${stderrTail.trim()}`);
        const now = Date.now();
        restarts = restarts.filter((t) => now - t < 30 * 60_000);
        restarts.push(now);
        // Crash loop guard: back off (up to 5 min) instead of giving up — the night must go on.
        const delay = Math.min(5 * 60_000, restartDelayMs() * 2 ** Math.max(0, restarts.length - 2));
        log.info(`restarting the app in ${Math.round(delay / 1000)} s (${restarts.length}. restart in 30 min)`);
        setTimeout(() => !stopping && startChild(), delay);
      });
    };

    const stop = (sig) => {
      if (stopping) return;
      stopping = true;
      // Ctrl+C / closing the console reaches the child too; give it time for a clean shutdown.
      if (!child) return resolveExit(0);
      if (process.platform !== 'win32') child.kill(sig);
      setTimeout(() => {
        if (child) killTree(child.pid);
        resolveExit(0);
      }, 8_000).unref();
    };
    process.on('SIGINT', () => stop('SIGINT'));
    process.on('SIGTERM', () => stop('SIGTERM'));
    process.on('SIGHUP', () => stop('SIGHUP'));
    startChild();
  });
}

/** Called in the child: heartbeat to the supervisor (no-op when not supervised). */
export function startHeartbeat() {
  if (!process.send || process.env.SLEEPPILOT_WORKER !== '1') return null;
  const beat = () => {
    try {
      process.send({ type: 'hb' });
    } catch {}
  };
  beat();
  const t = setInterval(beat, HEARTBEAT_MS);
  t.unref();
  process.on('disconnect', () => log.warn('supervisor disconnected; the app keeps running unsupervised'));
  return t;
}

/**
 * Called in the child: watch the JavaScript heap. Close to V8's limit the app would die with an
 * uncatchable out-of-memory error; instead, save everything (onHigh) and ask the supervisor for a
 * restart while that is still possible. The restarted app recovers and continues the run.
 * Returns the timer (or null when not supervised).
 */
export function startMemoryGuard({ onHigh, everyMs = 15_000, getStats } = {}) {
  if (!process.send || process.env.SLEEPPILOT_WORKER !== '1') return null;
  const fraction = Number(process.env.SLEEPPILOT_HEAP_GUARD || 0.85);
  let fired = false;
  const t = setInterval(async () => {
    if (fired) return;
    const st = (getStats || v8HeapStats)();
    if (st.used < fraction * st.limit) return;
    fired = true;
    const mb = (b) => Math.round(b / 1048576);
    const reason = `close to the memory limit (${mb(st.used)} / ${mb(st.limit)} MB)`;
    log.warn(`heap guard: ${reason}; saving and asking for a restart`);
    try {
      await onHigh?.(reason);
    } catch (err) {
      log.error(`heap guard save failed: ${err.message}`);
    }
    process.send({ type: 'restart', reason });
  }, everyMs);
  t.unref();
  return t;
}

function v8HeapStats() {
  const h = v8.getHeapStatistics();
  return { used: h.used_heap_size, limit: h.heap_size_limit };
}
