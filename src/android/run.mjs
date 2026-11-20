import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { killTree, resolveSpawn, runFile } from '../util/proc.mjs';
import { redact } from '../util/redact.mjs';
import { logger } from '../util/log.mjs';
import { androidProcessEnv } from './toolchain.mjs';
import { listDevices } from './build.mjs';

const log = logger('android-run');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * "Does the app start?" — the Android run check.
 *
 * Install the newest debug APK on a connected device (a USB phone with USB debugging, or a running
 * emulator); when none is connected and an emulator image (AVD) exists, start one without a window.
 * Then start the app, wait a few seconds, and look for a crash (FATAL EXCEPTION / ANR in the log,
 * or the process gone). One screenshot of the running app is saved for the reviewer.
 */

/** Emulators SleepPilot started, kept running for later checks (starting one takes minutes). */
const started = new Map(); // avd -> { child, serial }

export async function listAvds(toolchain) {
  const emulator = toolchain?.sdk?.emulator;
  if (!emulator) return [];
  const r = await runFile(emulator, ['-list-avds'], { timeoutMs: 30_000, env: androidProcessEnv(toolchain) }).catch(() => null);
  return String(r?.stdout || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^(INFO|WARNING|ERROR)\b/.test(l));
}

async function adb(toolchain, serial, args, opts = {}) {
  return runFile(toolchain.sdk.adb, [...(serial ? ['-s', serial] : []), ...args], { timeoutMs: 60_000, env: androidProcessEnv(toolchain), ...opts });
}

async function bootCompleted(toolchain, serial) {
  const r = await adb(toolchain, serial, ['shell', 'getprop', 'sys.boot_completed'], { timeoutMs: 15_000 }).catch(() => null);
  return String(r?.stdout || '').trim() === '1';
}

/** Start an AVD without a window and wait until Android has booted. */
export async function startEmulator(toolchain, avd, { timeoutMs = 6 * 60_000, onProgress } = {}) {
  const emulator = toolchain?.sdk?.emulator;
  if (!emulator) throw new Error('The Android emulator is not installed (SDK Manager → Android Emulator).');
  const before = new Set((await listDevices(toolchain)).devices.map((d) => d.serial));
  const sp = resolveSpawn(emulator, ['-avd', avd, '-no-window', '-no-audio', '-no-boot-anim', '-no-snapshot-save', '-gpu', 'swiftshader_indirect']);
  const child = spawn(sp.file, sp.args, { env: androidProcessEnv(toolchain), windowsHide: true, windowsVerbatimArguments: sp.verbatim, detached: process.platform !== 'win32', stdio: 'ignore' });
  child.unref();
  onProgress?.(`Starting the emulator "${avd}" (this can take a few minutes the first time)…`);
  const deadline = Date.now() + timeoutMs;
  let serial = null;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`The emulator "${avd}" closed while starting (exit code ${child.exitCode}). Start it once from Android Studio's Device Manager to see why.`);
    if (!serial) {
      const now = (await listDevices(toolchain)).devices;
      serial = now.find((d) => d.emulator && !before.has(d.serial))?.serial || null;
    }
    if (serial && (await bootCompleted(toolchain, serial))) {
      started.set(avd, { child, serial });
      return serial;
    }
    await sleep(3000);
  }
  killTree(child.pid);
  throw new Error(`The emulator "${avd}" did not finish booting within ${Math.round(timeoutMs / 60_000)} min.`);
}

/** A device to run on: the requested serial, a connected one (phones first), or a started emulator. */
export async function pickDevice(toolchain, { serial = null, avd = null, startEmulatorIfNeeded = true, onProgress } = {}) {
  const { devices, error } = await listDevices(toolchain);
  if (error && !devices.length && !toolchain?.sdk?.adb) throw new Error(error);
  const usable = devices.filter((d) => d.usable);
  if (serial) {
    const d = usable.find((x) => x.serial === serial);
    if (d) return { serial: d.serial, label: d.model || d.serial, emulator: d.emulator, started: false };
  }
  const phone = usable.find((d) => !d.emulator) || usable[0];
  if (phone) return { serial: phone.serial, label: phone.model || phone.serial, emulator: phone.emulator, started: false };
  const unauthorized = devices.find((d) => d.state === 'unauthorized');
  if (unauthorized && !startEmulatorIfNeeded) throw new Error('A phone is connected but USB debugging is not allowed yet: unlock it and accept the prompt.');
  if (!startEmulatorIfNeeded) throw new Error('No device is connected (USB phone with USB debugging, or a running emulator).');
  const avds = await listAvds(toolchain);
  const name = avd && avds.includes(avd) ? avd : avds[0];
  if (!name) throw new Error('No device is connected and no emulator image exists. Connect a phone with USB debugging, or create a virtual device in Android Studio (Device Manager).');
  const running = started.get(name);
  if (running && (await bootCompleted(toolchain, running.serial))) return { serial: running.serial, label: `emulator ${name}`, emulator: true, started: false };
  const s = await startEmulator(toolchain, name, { onProgress });
  return { serial: s, label: `emulator ${name}`, emulator: true, started: true };
}

/** Save a PNG of the device screen (binary stdout, so not through runFile's text capture). */
export function deviceScreenshot(toolchain, serial, file) {
  return new Promise((resolve) => {
    const sp = resolveSpawn(toolchain.sdk.adb, [...(serial ? ['-s', serial] : []), 'exec-out', 'screencap', '-p']);
    const child = spawn(sp.file, sp.args, { env: androidProcessEnv(toolchain), windowsHide: true, windowsVerbatimArguments: sp.verbatim, stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks = [];
    const timer = setTimeout(() => child.kill(), 30_000);
    child.stdout.on('data', (d) => chunks.push(d));
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', async () => {
      clearTimeout(timer);
      const png = Buffer.concat(chunks);
      if (png.length < 8 || png.subarray(1, 4).toString('latin1') !== 'PNG') return resolve(null);
      await fsp.mkdir(path.dirname(file), { recursive: true }).catch(() => {});
      await fsp.writeFile(file, png).then(() => resolve(file), () => resolve(null));
    });
  });
}

/** Crash lines of the app in a logcat dump (the stack trace after FATAL EXCEPTION, or an ANR). */
export function findCrash(logcat, packageName) {
  const lines = String(logcat || '').split(/\r?\n/);
  const start = lines.findIndex((l) => /FATAL EXCEPTION/.test(l) || (packageName && new RegExp(`ANR in ${packageName.replace(/\./g, '\\.')}`).test(l)));
  if (start < 0) return null;
  const block = lines.slice(start, start + 60);
  if (packageName && !block.some((l) => l.includes(packageName))) return null;
  return block.map((l) => redact(l).slice(0, 300)).join('\n');
}

/**
 * Install, start and watch the app.
 * @returns {{ status: 'passed'|'failed'|'error', summary, device, package, crash, screenshot, durationMs }}
 */
export async function runAndroidApp({ toolchain, apk, packageName, serial = null, avd = null, settleSec = 8, screenshotFile = null, startEmulatorIfNeeded = true, onProgress } = {}) {
  const t0 = Date.now();
  const done = (status, summary, extra = {}) => ({ status, summary, package: packageName, durationMs: Date.now() - t0, ...extra });
  if (!toolchain?.sdk?.adb) return done('error', 'adb was not found; install "Android SDK Platform-Tools" in the SDK Manager.');
  if (!packageName) return done('error', 'The package name of the APK could not be read.');
  let device;
  try {
    device = await pickDevice(toolchain, { serial, avd, startEmulatorIfNeeded, onProgress });
  } catch (err) {
    return done('error', redact(err.message));
  }
  const s = device.serial;
  onProgress?.(`Installing on ${device.label}…`);
  const install = await adb(toolchain, s, ['install', '-r', '-d', apk], { timeoutMs: 5 * 60_000 });
  const installOut = redact(`${install.stdout || ''}${install.stderr || ''}`).trim();
  if (install.exitCode !== 0 || !/\bSuccess\b/.test(installOut)) return done('failed', `Install failed on ${device.label}: ${installOut.split('\n').slice(-3).join(' ').slice(0, 400)}`, { device: device.label });
  await adb(toolchain, s, ['logcat', '-c'], { timeoutMs: 15_000 }).catch(() => {});
  await adb(toolchain, s, ['shell', 'am', 'force-stop', packageName], { timeoutMs: 15_000 }).catch(() => {});
  onProgress?.(`Starting ${packageName}…`);
  const launch = await adb(toolchain, s, ['shell', 'monkey', '-p', packageName, '-c', 'android.intent.category.LAUNCHER', '1'], { timeoutMs: 30_000 });
  if (/No activities found|monkey aborted/i.test(`${launch.stdout}${launch.stderr}`)) return done('failed', `The app has no launcher activity (${packageName}); it cannot be opened from the home screen.`, { device: device.label });
  await sleep(Math.max(1, settleSec) * 1000);
  const pid = String((await adb(toolchain, s, ['shell', 'pidof', packageName], { timeoutMs: 15_000 }).catch(() => null))?.stdout || '').trim();
  const logcat = await adb(toolchain, s, ['logcat', '-d', '-v', 'brief'], { timeoutMs: 30_000, }).catch(() => null);
  const crash = findCrash(`${logcat?.stdout || ''}`, packageName);
  const screenshot = screenshotFile ? await deviceScreenshot(toolchain, s, screenshotFile) : null;
  if (crash) return done('failed', `The app crashed on ${device.label} within ${settleSec} s of starting.`, { device: device.label, crash, screenshot });
  if (!pid) return done('failed', `The app is not running ${settleSec} s after it was started on ${device.label} (it closed itself or was killed).`, { device: device.label, screenshot });
  log.info(`app ${packageName} running on ${device.label} (pid ${pid})`);
  return done('passed', `${packageName} started on ${device.label} and was still running after ${settleSec} s; no crash in the device log.`, { device: device.label, screenshot });
}

/** Stop the emulators SleepPilot started (app shutdown). */
export function stopStartedEmulators() {
  // The whole tree: on Windows the started process can be a launcher (cmd/.bat) of the emulator.
  for (const { child } of started.values()) killTree(child.pid);
  started.clear();
}

export const _internal = { started, fs };
