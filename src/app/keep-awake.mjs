import { spawn } from 'node:child_process';
import { killTree } from '../util/proc.mjs';
import { logger } from '../util/log.mjs';

const log = logger('keep-awake');

/**
 * While a run is active, ask Windows not to enter idle sleep (SetThreadExecutionState with
 * ES_CONTINUOUS | ES_SYSTEM_REQUIRED). This does not prevent sleep from closing a laptop lid
 * or choosing Sleep manually. The display may still turn off.
 */
export class KeepAwake {
  constructor() {
    this.child = null;
  }

  set(on) {
    if (process.platform !== 'win32' || process.env.SLEEPPILOT_NO_KEEPAWAKE === '1') return;
    if (on && !this.child) {
      const script = `
$sig = '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);'
$k = Add-Type -MemberDefinition $sig -Name 'SPKeepAwake' -Namespace 'SleepPilot' -PassThru
while ($true) { [void]$k::SetThreadExecutionState([uint32]'0x80000001'); Start-Sleep -Seconds 50 }`;
      this.child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, stdio: 'ignore' });
      this.child.on('exit', () => (this.child = null));
      log.info('system sleep prevention ON');
    } else if (!on && this.child) {
      killTree(this.child.pid);
      this.child = null;
      log.info('system sleep prevention OFF');
    }
  }
}
