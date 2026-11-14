// Stand-in for the SleepPilot app process in supervisor tests. Each start records what it was
// given and then behaves as FAKE_WORKER_MODES says for that start (comma-separated, 1-based):
//   oom      print a V8 out-of-memory message and die (like the 29.10.2026 crash)
//   hang     freeze the event loop (no more heartbeats)
//   restart  ask the supervisor for a restart (stall watchdog)
//   heap     report a nearly full heap to the memory guard (saves, then asks for a restart)
//   exit0    exit normally (the user closed SleepPilot)
import fs from 'node:fs';
import { startMemoryGuard } from '../../src/supervisor.mjs';

const f = process.env.FAKE_WORKER_COUNTER;
const n = (fs.existsSync(f) ? Number(fs.readFileSync(f, 'utf8')) : 0) + 1;
fs.writeFileSync(f, String(n));
fs.writeFileSync(`${f}.${n}.json`, JSON.stringify({ lastCrash: process.env.SLEEPPILOT_LAST_CRASH || null, token: process.env.SLEEPPILOT_UI_TOKEN, worker: process.env.SLEEPPILOT_WORKER, args: process.argv.slice(2) }));
const mode = (process.env.FAKE_WORKER_MODES || '').split(',')[n - 1] || 'exit0';
process.send?.({ type: 'hb' });
if (mode === 'oom') {
  process.stderr.write('\n<--- Last few GCs --->\nFATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n');
  process.exit(134);
} else if (mode === 'hang') {
  const end = Date.now() + 60_000;
  while (Date.now() < end) {}
} else if (mode === 'restart') {
  process.send({ type: 'restart', reason: 'test stall' });
  setInterval(() => {}, 1000);
} else if (mode === 'heap') {
  startMemoryGuard({ everyMs: 50, getStats: () => ({ used: 95, limit: 100 }), onHigh: async () => fs.writeFileSync(`${f}.saved`, String(n)) });
  setInterval(() => {}, 1000);
} else process.exit(0);
