#!/usr/bin/env node
// Installs the office libraries (Excel, Word, PDF, charts) on first launch, or after an update
// added new ones. Never fatal: SleepPilot starts either way; only the office tools need them.
import { spawnSync } from 'node:child_process';
import { officeStatus, ROOT } from '../src/office/deps.mjs';

const status = officeStatus();
if (!status.ready) {
  console.log(`[SleepPilot] Installing the office tools (one time, about a minute): ${status.missing.join(', ')}`);
  const r = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
  const after = officeStatus();
  if (r.status === 0 && after.ready) console.log('[SleepPilot] Office tools installed.');
  else console.log(`[SleepPilot] The office tools could not be installed (${r.error?.message || `npm exit code ${r.status}`}). SleepPilot works without them; run "npm install" in ${ROOT} later to add them.`);
}
