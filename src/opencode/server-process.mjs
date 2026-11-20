import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { appStateFile } from '../util/paths.mjs';
import { readJsonLenientSync, updateJsonFile } from '../util/fsx.mjs';
import { secret } from '../util/ids.mjs';
import { registerSecret, redact } from '../util/redact.mjs';
import { killTree, isAlive, resolveSpawn } from '../util/proc.mjs';
import { logger } from '../util/log.mjs';

const log = logger('opencode-server');
const LISTEN_RE = /listening on (http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+)/i;

/**
 * A private OpenCode 2.x server owned by SleepPilot:
 *   opencode serve --hostname 127.0.0.1 --port 0   with env OPENCODE_PASSWORD=<random>
 * Loopback only; the password lives in memory for this process lifetime and is never logged.
 * This is the same mechanism OpenCode's own `--standalone` CLI mode uses.
 */
export class OpenCodeServerProcess extends EventEmitter {
  /** @param {{ exe: string, args?: string[], cwd?: string }} command */
  constructor(command) {
    super();
    this.command = command;
    this.child = null;
    this.url = null;
    this.password = null;
    this.stderrTail = '';
    this.stopping = false;
  }

  async start({ timeoutMs = 90_000 } = {}) {
    cleanupOrphan();
    this.password = secret(32);
    registerSecret(this.password);
    const env = { ...process.env, ...(this.command.env || {}), OPENCODE_PASSWORD: this.password };
    delete env.OPENCODE_SERVER_PASSWORD;
    const baseArgs = this.command.args ?? ['serve', '--hostname', '127.0.0.1', '--port', '0'];
    const sp = resolveSpawn(this.command.exe, baseArgs);
    log.info(`starting: ${path.basename(this.command.exe)} ${baseArgs.join(' ')}`);
    this.stopping = false;
    this.child = spawn(sp.file, sp.args, {
      cwd: this.command.cwd,
      env,
      windowsHide: true,
      windowsVerbatimArguments: sp.verbatim,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const child = this.child;
    rememberPid(child.pid, this.command.exe);

    this.url = await new Promise((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(() => reject(new Error('The OpenCode server did not start in time.')), timeoutMs);
      child.stdout.on('data', (d) => {
        buf += d;
        const m = buf.match(LISTEN_RE);
        if (m) {
          clearTimeout(timer);
          resolve(m[1]);
        }
      });
      child.stderr.on('data', (d) => {
        this.stderrTail = (this.stderrTail + d).slice(-4000);
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`The OpenCode server exited while starting (exit code ${code}). ${redact(this.stderrTail.slice(-500))}`));
      });
    });
    // Keep draining output so the child never blocks on a full pipe.
    child.stdout.removeAllListeners('data');
    child.stdout.on('data', () => {});
    child.removeAllListeners('exit');
    child.on('exit', (code, signal) => {
      log.warn(`server exited code=${code} signal=${signal}`);
      forgetPid(child.pid);
      if (this.child === child) {
        this.child = null;
        if (!this.stopping) this.emit('exit', { code, signal });
      }
    });
    log.info(`listening on ${this.url}`);
    return { url: this.url, password: this.password };
  }

  get running() {
    return !!this.child;
  }

  async stop() {
    this.stopping = true;
    const child = this.child;
    this.child = null;
    if (child) {
      killTree(child.pid);
      forgetPid(child.pid);
    }
  }
}

function rememberPid(pid, exe) {
  updateJsonFile(appStateFile(), (st) => {
    st.serverPid = pid;
    st.serverExe = path.basename(exe);
  }).catch(() => {});
}

function forgetPid(pid) {
  updateJsonFile(appStateFile(), (st) => {
    if (st.serverPid === pid) delete st.serverPid;
  }).catch(() => {});
}

/**
 * If SleepPilot crashed, its private server may still be running (Windows does not kill
 * children with the parent). Kill it only if the recorded PID still belongs to the same executable.
 */
function cleanupOrphan() {
  const st = readJsonLenientSync(appStateFile(), {});
  const pid = st.serverPid;
  if (!pid || pid === process.pid || !isAlive(pid)) return;
  if (process.platform === 'win32') {
    const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
    const image = (r.stdout || '').split(',')[0]?.replace(/"/g, '').toLowerCase();
    const expected = String(st.serverExe || '').toLowerCase();
    if (!image || !expected || image !== expected) return;
  }
  log.warn(`killing orphaned OpenCode server pid=${pid} from a previous SleepPilot process`);
  killTree(pid);
}
