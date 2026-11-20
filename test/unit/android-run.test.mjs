// Android run check: install, start, crash detection, screenshot — with fake adb/emulator.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.SLEEPPILOT_QUIET = '1';
process.env.SLEEPPILOT_HOME ||= fs.mkdtempSync(path.join(os.tmpdir(), 'sp-arun-home-'));
const HERE = path.dirname(fileURLToPath(import.meta.url));
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `sp-arun-${n}-`));

/** A runnable stand-in: .cmd on Windows, a Node script with a shebang elsewhere. */
function tool(dir, name, script) {
  if (process.platform === 'win32') {
    const cmd = path.join(dir, `${name}.cmd`);
    fs.writeFileSync(cmd, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
    return cmd;
  }
  const exe = path.join(dir, name);
  fs.writeFileSync(exe, `#!${process.execPath}\nimport(${JSON.stringify(new URL(`file://${script}`).href)});\n`);
  fs.chmodSync(exe, 0o755);
  return exe;
}

function setup({ devices = [{ serial: 'R58M123', props: 'model:SM_G973F' }], crash = false } = {}) {
  const dir = tmp('tools');
  const state = path.join(dir, 'state.json');
  fs.writeFileSync(state, JSON.stringify({ devices, crash }));
  process.env.FAKE_ADB_STATE = state;
  const adb = tool(dir, 'adb', path.join(HERE, '..', 'fake-adb', 'adb.mjs'));
  const emulator = tool(dir, 'emulator', path.join(HERE, '..', 'fake-adb', 'emulator.mjs'));
  return { toolchain: { sdk: { adb, emulator }, jdk: {}, env: {} }, dir };
}

test('android run: the app starts on a connected phone; a screenshot is saved', async () => {
  const { runAndroidApp } = await import('../../src/android/run.mjs');
  const { toolchain, dir } = setup();
  const shot = path.join(dir, 'shot.png');
  const r = await runAndroidApp({ toolchain, apk: path.join(dir, 'app.apk'), packageName: 'com.example.racer', settleSec: 1, screenshotFile: shot });
  assert.equal(r.status, 'passed', r.summary);
  assert.equal(r.device, 'SM G973F');
  assert.equal(r.screenshot, shot);
  assert.equal(fs.readFileSync(shot).subarray(1, 4).toString(), 'PNG');
});

test('android run: a crash in the device log fails the check with the stack trace', async () => {
  const { runAndroidApp } = await import('../../src/android/run.mjs');
  const { toolchain, dir } = setup({ crash: true });
  const r = await runAndroidApp({ toolchain, apk: path.join(dir, 'app.apk'), packageName: 'com.example.racer', settleSec: 1 });
  assert.equal(r.status, 'failed');
  assert.match(r.summary, /crashed/);
  assert.match(r.crash, /FATAL EXCEPTION/);
  assert.match(r.crash, /NullPointerException: boom/);
});

test('android run: no device → a headless emulator is started; no emulator image → clear error', async () => {
  const { runAndroidApp, stopStartedEmulators } = await import('../../src/android/run.mjs');
  const { toolchain, dir } = setup({ devices: [] });
  try {
    const r = await runAndroidApp({ toolchain, apk: path.join(dir, 'app.apk'), packageName: 'com.example.racer', settleSec: 1 });
    assert.equal(r.status, 'passed', r.summary);
    assert.equal(r.device, 'emulator Pixel_7_API_34');
  } finally {
    stopStartedEmulators();
  }
  const none = setup({ devices: [] });
  process.env.FAKE_AVDS = '';
  try {
    const r = await runAndroidApp({ toolchain: none.toolchain, apk: 'x.apk', packageName: 'com.example.racer', settleSec: 1 });
    assert.equal(r.status, 'error');
    assert.match(r.summary, /no emulator image exists/);
    const noEmu = await runAndroidApp({ toolchain: { sdk: { adb: none.toolchain.sdk.adb } }, apk: 'x.apk', packageName: 'p.q', settleSec: 1, startEmulatorIfNeeded: false });
    assert.match(noEmu.summary, /No device is connected/);
  } finally {
    delete process.env.FAKE_AVDS;
  }
  const noAdb = await runAndroidApp({ toolchain: { sdk: {} }, apk: 'x.apk', packageName: 'p.q' });
  assert.match(noAdb.summary, /adb was not found/);
});

test('android run: crash lines are found only for this app', async () => {
  const { findCrash } = await import('../../src/android/run.mjs');
  const other = 'E/AndroidRuntime( 1): FATAL EXCEPTION: main\nE/AndroidRuntime( 1): Process: com.other.app, PID: 1\n';
  assert.equal(findCrash(other, 'com.example.racer'), null);
  assert.match(findCrash('E/ActivityManager( 1): ANR in com.example.racer (com.example.racer/.Main)\n', 'com.example.racer'), /ANR in com\.example\.racer/);
  assert.equal(findCrash('all fine', 'x.y'), null);
});

test('android run check: runs after the build in the check list and reports the screenshot', { skip: process.platform === 'win32' && 'the fake adb must be an .exe for SDK detection on Windows' }, async () => {
  const { runChecks } = await import('../../src/checks/runner.mjs');
  const { configureAndroid, invalidateAndroidToolchain } = await import('../../src/android/toolchain.mjs');
  const { scaffoldTemplate } = await import('../../src/android/templates.mjs');
  const { fakeApk } = await import('../fixtures/zip-writer.mjs');
  const { dir } = setup();
  const sdk = path.join(tmp('sdk'), 'Sdk');
  fs.mkdirSync(path.join(sdk, 'platforms', 'android-34'), { recursive: true });
  fs.mkdirSync(path.join(sdk, 'platform-tools'), { recursive: true });
  fs.mkdirSync(path.join(sdk, 'emulator'), { recursive: true });
  fs.copyFileSync(path.join(dir, 'adb'), path.join(sdk, 'platform-tools', 'adb'));
  fs.chmodSync(path.join(sdk, 'platform-tools', 'adb'), 0o755);
  const jdk = path.join(tmp('jdk'), 'jdk-17');
  for (const b of ['java', 'javac', 'keytool']) {
    fs.mkdirSync(path.join(jdk, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(jdk, 'bin', b), '');
  }
  fs.writeFileSync(path.join(jdk, 'release'), 'JAVA_VERSION="17.0.9"\n');
  const project = tmp('proj');
  await scaffoldTemplate(project, 'android-kotlin', { name: 'Racer', applicationId: 'com.example.racer' });
  const apkDir = path.join(project, 'app', 'build', 'outputs', 'apk', 'debug');
  fs.mkdirSync(apkDir, { recursive: true });
  fs.writeFileSync(path.join(apkDir, 'app-debug.apk'), fakeApk({ pkg: 'com.example.racer' }));
  configureAndroid({ jdkHome: jdk, sdkDir: sdk });
  invalidateAndroidToolchain();
  try {
    const [r] = await runChecks({ projectDir: project, checks: [{ id: 'android-run', type: 'android-run', name: 'Android run', module: 'app', settleSec: 1, enabled: true, approved: true }] });
    assert.equal(r.status, 'passed', r.output);
    assert.equal(r.details.package, 'com.example.racer');
    assert.match(r.details.screenshot, /^\.sleeppilot\/screens\/android-.+\.png$/);
    assert.ok(fs.existsSync(path.join(project, r.details.screenshot)));
    assert.equal(fs.readFileSync(path.join(project, '.sleeppilot', '.gitignore'), 'utf8').trim().split('\n').pop(), '*');
    // No APK yet → an environment error, not a failed task.
    fs.rmSync(path.join(project, 'app', 'build'), { recursive: true });
    const [none] = await runChecks({ projectDir: project, checks: [{ id: 'android-run', type: 'android-run', name: 'Android run', enabled: true, approved: true }] });
    assert.equal(none.status, 'error');
    assert.match(none.output, /No debug APK/);
  } finally {
    configureAndroid({});
    invalidateAndroidToolchain();
  }
});
