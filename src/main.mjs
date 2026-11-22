#!/usr/bin/env node
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SleepPilotApp } from './app/app.mjs';
import { startWebServer } from './web/server.mjs';
import { findBrowser } from './checks/browser.mjs';
import { appStateFile, dataRoot } from './util/paths.mjs';
import { readJsonLenientSync, updateJsonFile } from './util/fsx.mjs';
import { logger } from './util/log.mjs';
import { supervise, startHeartbeat, startMemoryGuard } from './supervisor.mjs';
import { acquireInstanceLock, lockFile } from './util/instance-lock.mjs';

const log = logger('main');
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------- CLI dispatch
// The desktop UI stays the default; the commands below turn SleepPilot into a headless harness
// that other tools (workflows, cron jobs, DeepSeek Harness, CI) can call directly.
const rawArgs = process.argv.slice(2);
const cliCommand = rawArgs[0] && !rawArgs[0].startsWith('-') ? rawArgs[0] : rawArgs[0] === '--version' ? 'version' : null;
const CLI_COMMANDS = new Set(['run', 'ask', 'route', 'reverse', 'engines', 'doctor', 'web', 'help', 'version']);
if (cliCommand === 'office') {
  // Office tools (Excel, CSV, Word, PowerPoint, PDF, PNG): standalone, no app state needed.
  const { runOfficeCli } = await import('./office/cli.mjs');
  const code = await runOfficeCli(rawArgs.slice(1)).catch((err) => {
    process.stderr.write(`SleepPilot office: ${err.message}\n`);
    return 1;
  });
  // (`office mcp` returns only when its input closes.) Let stdout drain, then leave: the desktop
  // UI below must never start from an office command.
  process.exitCode = code ?? 0;
  await new Promise((r) => setTimeout(r, 50));
  process.exit(code ?? 0);
} else if (cliCommand && CLI_COMMANDS.has(cliCommand)) {
  process.env.SLEEPPILOT_QUIET = '1';
  const { runCli } = await import('./cli/index.mjs');
  const code = await runCli(cliCommand, rawArgs.slice(1));
  // Give fetch keep-alive sockets and the log stream one tick to close; exiting immediately
  // while libuv still owns a closing handle can trip an assertion on Windows.
  process.exitCode = code;
  await new Promise((r) => setTimeout(r, 120));
  process.exit(code);
}

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

if (flag('--help') || flag('-h')) {
  console.log(`SleepPilot — Plan. Build. Verify. Sleep.

Desktop UI:
  node src/main.mjs [--test-mode] [--no-open] [--port N] [--no-supervisor]
    --test-mode      Use a fake OpenCode test server (UI trials and tests only).
    --no-open        Do not open the UI window automatically.
    --port N         UI server port (default 47810, 47812 in test mode; a random free port if taken).
    --no-supervisor  Run without the supervisor (no automatic restart after a crash or freeze).

Headless harness (same engines, no window):
  sleeppilot run       Run a project autonomously
  sleeppilot ask       Send one prompt through an engine and print the answer
  sleeppilot reverse   Prepare a Sleep & Reverse & Rust It workspace
  sleeppilot engines   Show engines, providers and toolchains
  sleeppilot doctor    Check the local setup
  sleeppilot office    Excel / CSV / Word / PowerPoint / PDF / PNG tools and MCP server
  Run "sleeppilot help" for all options.

Docs: README.md · docs/USAGE.md · docs/ENGINES.md · docs/REVERSE.md`);
  process.exit(0);
}

const testMode = flag('--test-mode');
const worker = flag('--worker');
if (testMode) process.env.SLEEPPILOT_HOME ||= path.join(dataRoot(), 'test-mode-data');

function openWindow(url) {
  if (flag('--no-open')) return;
  const browser = findBrowser();
  if (browser && /msedge/i.test(browser)) {
    // Edge "app" window with a dedicated profile so the UI looks like a desktop application.
    spawn(browser, [`--app=${url}`, `--user-data-dir=${path.join(dataRoot(), 'edge-profile')}`, '--no-first-run', '--window-size=1400,900'], { detached: true, stdio: 'ignore' }).unref();
  } else if (process.platform === 'win32') {
    spawn('cmd.exe', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } else console.log(`UI: ${url}`);
}

/** If SleepPilot is already running, just open its window again. */
async function existingInstance({ timeoutMs = 4000 } = {}) {
  const st = readJsonLenientSync(appStateFile(), {});
  if (!st.uiPort || !st.uiToken) return null;
  try {
    const r = await fetch(`http://127.0.0.1:${st.uiPort}/api/ping`, { signal: AbortSignal.timeout(timeoutMs) });
    const j = await r.json();
    if (j?.app === 'SleepPilot') return `http://127.0.0.1:${st.uiPort}/?t=${st.uiToken}`;
  } catch {}
  return null;
}

async function main() {
  // The supervised app (--worker) never looks for "another instance": after a crash the stale
  // entry is its own predecessor, and exiting here would end the supervision.
  if (!worker) {
    const existing = await existingInstance();
    if (existing) {
      console.log('SleepPilot is already running; reopening its window.');
      openWindow(existing);
      return;
    }
    // The lock decides, not the ping: a busy or starting instance may not answer in time, and a
    // second instance would take over its runs.
    const lock = acquireInstanceLock();
    if (!lock.ok) {
      for (let i = 0; i < 10; i++) {
        const url = await existingInstance({ timeoutMs: 3000 });
        if (url) {
          console.log('SleepPilot is already running; reopening its window.');
          openWindow(url);
          return;
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
      console.error(`SleepPilot is already running (process ${lock.pid}) but its window could not be reached.
Not starting a second copy (it would take over the running work). Wait a moment and try again; if no SleepPilot is running, delete ${lockFile()}.`);
      process.exit(1);
    }
    if (!flag('--no-supervisor') && process.env.SLEEPPILOT_NO_SUPERVISOR !== '1') {
      // Parent process: only keeps the app alive (see src/supervisor.mjs).
      const code = await supervise({ entry: fileURLToPath(import.meta.url), args, execArgv: process.execArgv });
      process.exit(code);
    }
  }
  startHeartbeat();
  process.on('uncaughtException', (err) => {
    log.error(`uncaught exception: ${err?.stack || err}`);
    // State on disk is consistent (every change is persisted); a supervised app is restarted
    // and recovers its runs, which is safer than continuing in an unknown state.
    process.exit(70);
  });
  process.on('unhandledRejection', (err) => log.error(`unhandled rejection: ${err?.stack || err}`));
  const testCommand = testMode ? { exe: process.execPath, args: [path.join(ROOT, 'test', 'fake-opencode', 'server.mjs'), 'serve', '--hostname', '127.0.0.1', '--port', '0'] } : undefined;
  const app = new SleepPilotApp({ testMode, testCommand });
  await app.init();
  startMemoryGuard({
    onHigh: async (reason) => {
      for (const c of app.controllers.values()) {
        if (c.terminal) continue;
        c.addLog({ kind: 'warning', text: `The app is close to its memory limit (${reason}); saving and restarting before it crashes. A sleep-mode run continues where it left off.` });
        await c.persist();
      }
    },
  });
  const web = await startWebServer(app, { port: opt('--port') ? Number(opt('--port')) : [testMode ? 47812 : 47810, 0], token: process.env.SLEEPPILOT_UI_TOKEN || undefined });
  await updateJsonFile(appStateFile(), (st) => Object.assign(st, { uiPort: web.port, uiToken: web.token, pid: process.pid }));
  console.log('');
  console.log('  SleepPilot — Plan. Build. Verify. Sleep.');
  if (testMode) console.log('  *** TEST MODE: using a fake OpenCode server ***');
  console.log(`  UI: http://127.0.0.1:${web.port}/  (the window opens automatically)`);
  console.log('  Closing this console window stops SleepPilot. Closing the UI window does not stop a run.');
  if (worker) console.log('  Supervisor on: the app is restarted automatically if it crashes or freezes; a sleep-mode run continues where it left off.');
  console.log('');
  openWindow(web.url);

  const shutdown = async () => {
    log.info('shutting down');
    await updateJsonFile(appStateFile(), (s) => {
      delete s.uiPort;
      delete s.uiToken;
    }).catch(() => {});
    await app.shutdown().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGHUP', shutdown);
  app.on('close-requested', () => shutdown());
}

main().catch((err) => {
  log.error(err.stack || err.message);
  process.exit(1);
});
