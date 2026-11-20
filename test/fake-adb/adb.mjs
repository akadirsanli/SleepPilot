#!/usr/bin/env node
// Fake adb for tests. State: FAKE_ADB_STATE (JSON file) — { devices: [...], crash: bool }.
import fs from 'node:fs';
let args = process.argv.slice(2);
if (args[0] === '-s') args = args.slice(2);
const stateFile = process.env.FAKE_ADB_STATE;
const state = stateFile && fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { devices: [], crash: false };
const out = (s) => process.stdout.write(s);
const [cmd, ...rest] = args;
if (cmd === 'devices') {
  out('List of devices attached\n');
  for (const d of state.devices) out(`${d.serial}\tdevice ${d.props || ''}\n`);
} else if (cmd === 'install') {
  out('Performing Streamed Install\nSuccess\n');
} else if (cmd === 'logcat') {
  if (rest[0] === '-d') {
    out('I/ActivityManager( 500): Start proc 12345:com.example.racer/u0a1 for activity\n');
    if (state.crash) out('E/AndroidRuntime(12345): FATAL EXCEPTION: main\nE/AndroidRuntime(12345): Process: com.example.racer, PID: 12345\nE/AndroidRuntime(12345): java.lang.NullPointerException: boom\nE/AndroidRuntime(12345): \tat com.example.racer.MainActivity.onCreate(MainActivity.kt:12)\n');
  }
} else if (cmd === 'shell') {
  if (rest[0] === 'pidof') out(state.crash ? '' : '12345\n');
  else if (rest[0] === 'monkey') out('Events injected: 1\n');
  else if (rest[0] === 'getprop') out('1\n');
} else if (cmd === 'exec-out') {
  process.stdout.write(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]));
} else if (cmd === 'version') {
  out('Android Debug Bridge version 1.0.41\n');
}
