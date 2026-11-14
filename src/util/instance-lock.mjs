/**
 * One SleepPilot per data folder. Origin: on 30.10.2026 SleepPilot.cmd was started while another
 * instance was running a Sleep & Reverse run; the "is it already running?" ping missed it, the new
 * instance found the run "running" on disk, treated it as a crash and resumed it — two controllers
 * then drove the same run. A ping can time out; a lock file holding the owner's PID cannot.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { dataRoot } from './paths.mjs';

export const lockFile = () => path.join(dataRoot(), 'instance.lock');

/** Is pid a running process — and, on Windows, a node.exe (PIDs are reused)? */
export function isAlive(pid) {
  try {
    process.kill(pid, 0);
  } catch (err) {
    if (err.code !== 'EPERM') return false;
  }
  if (process.platform !== 'win32') return true;
  const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
  return r.status !== 0 || /node(\.exe)?/i.test(r.stdout || '');
}

/**
 * Take the lock for this process. Returns { ok: true } or { ok: false, pid } when a live process
 * owns it. A lock left behind by a process that died (crash, kill) is taken over.
 */
export function acquireInstanceLock() {
  const file = lockFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx' });
      process.on('exit', () => {
        try {
          if (JSON.parse(fs.readFileSync(file, 'utf8')).pid === process.pid) fs.unlinkSync(file);
        } catch {}
      });
      return { ok: true };
    } catch (err) {
      if (err.code !== 'EEXIST') return { ok: true, warning: err.message }; // never block start-up on an odd file system
      let owner = null;
      try {
        owner = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {}
      if (owner?.pid && owner.pid !== process.pid && isAlive(owner.pid)) return { ok: false, pid: owner.pid };
      try {
        fs.unlinkSync(file);
      } catch {}
    }
  }
  return { ok: true };
}
