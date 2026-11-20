import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { killTree, resolveSpawn, runFile } from '../util/proc.mjs';
import { redact, registerSecret } from '../util/redact.mjs';
import { androidKeysDir, toolsDir } from '../util/paths.mjs';
import { readJson, writeJsonAtomic } from '../util/fsx.mjs';
import { extractZip } from '../util/zip.mjs';
import { ANDROID_DEFAULTS, androidProcessEnv, managedGradleDir } from './toolchain.mjs';
import { detectAndroidProject, findArtifacts, inspectArtifact } from './project.mjs';
import { assembleTask } from './templates.mjs';

const MAX_LOG = 4000;
const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');

/**
 * How Gradle is started for a project: the project's wrapper when it is complete, else a
 * Gradle installation SleepPilot found (or downloaded on request).
 */
export async function resolveGradle(gradleRoot, toolchain, { platform = process.platform } = {}) {
  const script = path.join(gradleRoot, platform === 'win32' ? 'gradlew.bat' : 'gradlew');
  const jar = path.join(gradleRoot, 'gradle', 'wrapper', 'gradle-wrapper.jar');
  if ((await fsp.stat(script).catch(() => null)) && (await fsp.stat(jar).catch(() => null))) {
    if (platform === 'win32') return { file: script, args: [], source: 'wrapper' };
    // On macOS/Linux the wrapper jar is started with the detected java directly, as gradlew does
    // internally: a POSIX sh drops environment variables whose names contain dots, which would
    // lose the ORG_GRADLE_PROJECT_android.injected.signing.* values of a release build.
    if (toolchain?.jdk?.ok && toolchain.jdk.java) return { file: toolchain.jdk.java, args: ['-Xmx64m', '-Xms64m', '-Dorg.gradle.appname=gradlew', '-classpath', jar, 'org.gradle.wrapper.GradleWrapperMain'], source: 'wrapper' };
    return { file: '/bin/sh', args: [script], source: 'wrapper', viaShell: true };
  }
  if (toolchain?.gradle?.found && toolchain.gradle.path) return { file: toolchain.gradle.path, args: [], source: toolchain.gradle.source || 'gradle', version: toolchain.gradle.version, viaShell: platform !== 'win32' };
  return null;
}

/** Write local.properties with the SDK folder when it is missing or points to a folder that does not exist. */
export async function ensureLocalProperties(gradleRoot, sdkDir) {
  if (!sdkDir) return false;
  const file = path.join(gradleRoot, 'local.properties');
  const text = await fsp.readFile(file, 'utf8').catch(() => null);
  const current = text?.match(/^\s*sdk\.dir\s*=\s*(.+)$/m)?.[1]?.replace(/\\\\/g, '\\').replace(/\\:/g, ':').trim();
  if (current && (await fsp.stat(current).catch(() => null))?.isDirectory()) return false;
  // Java properties syntax: backslashes and colons are escaped.
  const line = `sdk.dir=${sdkDir.replace(/\\/g, '\\\\').replace(/:/g, '\\:')}`;
  const next = text ? (current != null ? text.replace(/^\s*sdk\.dir\s*=.*$/m, line) : `${text.replace(/\s*$/, '\n')}${line}\n`) : `## Written by SleepPilot: path of the Android SDK on this computer. Do not commit this file.\n${line}\n`;
  await fsp.writeFile(file, next, 'utf8');
  return true;
}

/** Turn Gradle output into a short diagnosis with a concrete next step. */
export function explainBuildFailure(output) {
  const text = stripAnsi(String(output || ''));
  const wrong = text.match(/\* What went wrong:\s*\n([\s\S]*?)(?:\n\* Try:|\n\* Exception is:|\n\* Get more help|$)/);
  const summary = (wrong ? wrong[1] : text.split('\n').filter((l) => /error|failed|exception/i.test(l)).slice(-6).join('\n')).trim().slice(0, 1500);
  const hints = [];
  const add = (re, hint) => re.test(text) && !hints.includes(hint) && hints.push(hint);
  add(/SDK location not found|ANDROID_HOME|sdk\.dir/i, 'The Android SDK was not found. Install it with Android Studio, or set its folder under Settings → Android.');
  add(/licen[cs]es? .*(not (been )?accepted|have not been accepted)|accept the SDK license/i, 'The Android SDK licences are not accepted. Run "sdkmanager --licenses" or accept them in Android Studio\'s SDK Manager.');
  add(/Failed to find target with hash string|compileSdk.*not installed|Failed to find Platform SDK/i, `The required Android platform is not installed. Install "Android SDK Platform ${ANDROID_DEFAULTS.compileSdk}" in the SDK Manager.`);
  add(/requires Java 17|Android Gradle plugin requires Java|Unsupported class file major version|JAVA_HOME is not set|no Java runtime|ERROR: JAVA_HOME/i, `A JDK ${ANDROID_DEFAULTS.minJdk}+ is needed. Install Android Studio (bundled JDK) or Temurin 17, or set the JDK folder under Settings → Android.`);
  add(/Could not resolve|Could not GET|Could not download|UnknownHostException|Connection (refused|timed out)|PKIX path building failed/i, 'Dependencies could not be downloaded. The first build needs internet access (Google Maven and Maven Central). Check the connection or proxy and build again.');
  add(/Minimum supported Gradle version is|requires Gradle|Gradle version .* is required/i, `The Gradle version does not match the Android Gradle Plugin. Use Gradle ${ANDROID_DEFAULTS.gradle} (Android screen → Download Gradle) or update gradle-wrapper.properties.`);
  add(/OutOfMemoryError|Java heap space|GC overhead limit/i, 'Gradle ran out of memory. Raise org.gradle.jvmargs (e.g. -Xmx3g) in gradle.properties.');
  add(/Execution failed for task ':[^']*:compile\w*(Kotlin|JavaWithJavac)/i, 'The code does not compile. The errors above (file:line) say where.');
  add(/AAPT: error|Android resource linking failed/i, 'A resource file (XML layout, drawable, manifest) is invalid. The AAPT error above names the file.');
  add(/Duplicate class/i, 'Two dependencies contain the same class. Remove one of them or exclude the duplicate module.');
  add(/Keystore was tampered|keystore password was incorrect|Failed to read key/i, 'The release keystore or its password does not match. Recreate the signing key on the Android screen (only if the app was never published with the old one).');
  add(/Could not find or load main class org\.gradle\.wrapper\.GradleWrapperMain|gradle-wrapper\.jar/i, 'The Gradle wrapper is broken. Use "Repair Gradle wrapper" on the Android screen.');
  return { summary: summary || 'The build failed; see the log.', hints };
}

/**
 * One running Gradle build. Emits 'line' for every output line and 'done' with the result.
 * The process tree is killed on cancel or timeout.
 */
export class GradleBuild extends EventEmitter {
  constructor({ id, gradle, cwd, tasks, env, timeoutMs = 45 * 60_000, extraArgs = [] }) {
    super();
    this.id = id;
    this.gradle = gradle;
    this.cwd = cwd;
    this.tasks = tasks;
    this.env = env;
    this.timeoutMs = timeoutMs;
    this.extraArgs = extraArgs;
    this.lines = [];
    this.state = 'queued';
    this.child = null;
    this.startedAt = null;
    this.endedAt = null;
    this.exitCode = null;
    this.cancelled = false;
    this.timedOut = false;
  }

  start() {
    const args = [...this.gradle.args, ...this.tasks, '--console=plain', '--stacktrace', ...this.extraArgs];
    const spec = resolveSpawn(this.gradle.file, args);
    this.state = 'running';
    this.startedAt = Date.now();
    this.command = `${this.gradle.source === 'wrapper' ? 'gradlew' : 'gradle'} ${this.tasks.join(' ')}`;
    this.push(`> ${this.command}  (in ${this.cwd})`);
    return new Promise((resolve) => {
      let partial = '';
      try {
        this.child = spawn(spec.file, spec.args, { cwd: this.cwd, env: this.env, windowsHide: true, windowsVerbatimArguments: spec.verbatim, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (err) {
        this.finish(null, `Could not start Gradle: ${err.message}`);
        resolve(this);
        return;
      }
      const onData = (d) => {
        partial += d.toString('utf8');
        const parts = partial.split(/\r?\n/);
        partial = parts.pop() || '';
        for (const l of parts) this.push(l);
      };
      this.child.stdout.on('data', onData);
      this.child.stderr.on('data', onData);
      const timer = setTimeout(() => {
        this.timedOut = true;
        this.push(`Build timed out after ${Math.round(this.timeoutMs / 60_000)} min; stopping Gradle.`);
        killTree(this.child?.pid);
      }, this.timeoutMs);
      timer.unref?.();
      this.child.once('error', (err) => {
        clearTimeout(timer);
        this.finish(null, `Could not start Gradle: ${err.message}`);
        resolve(this);
      });
      this.child.once('close', (code) => {
        clearTimeout(timer);
        if (partial) this.push(partial);
        this.finish(code);
        resolve(this);
      });
    });
  }

  push(raw) {
    const line = redact(stripAnsi(raw)).slice(0, 1000);
    this.lines.push(line);
    if (this.lines.length > MAX_LOG) this.lines.splice(0, this.lines.length - MAX_LOG);
    const task = line.match(/^> Task (:\S+)/)?.[1];
    if (task) this.currentTask = task;
    this.emit('line', line);
  }

  finish(code, error = null) {
    if (this.state !== 'running' && this.state !== 'queued') return;
    this.exitCode = code;
    this.endedAt = Date.now();
    this.error = error;
    if (error) this.push(error);
    this.state = this.cancelled ? 'cancelled' : this.timedOut ? 'timed_out' : code === 0 ? 'succeeded' : 'failed';
    this.child = null;
  }

  cancel() {
    if (this.state !== 'running') return false;
    this.cancelled = true;
    killTree(this.child?.pid);
    return true;
  }

  output() {
    return this.lines.join('\n');
  }
}

/** Gradle properties that make AGP sign a release build with the given key (Android Studio uses the same). */
export function signingEnv(signing) {
  if (!signing) return {};
  // ORG_GRADLE_PROJECT_<name> sets a Gradle project property without putting the password on the command line.
  return {
    'ORG_GRADLE_PROJECT_android.injected.signing.store.file': signing.storeFile,
    'ORG_GRADLE_PROJECT_android.injected.signing.store.password': signing.storePassword,
    'ORG_GRADLE_PROJECT_android.injected.signing.key.alias': signing.keyAlias,
    'ORG_GRADLE_PROJECT_android.injected.signing.key.password': signing.keyPassword,
  };
}

/**
 * Build a project: resolve Gradle, set JAVA_HOME/ANDROID_HOME, write local.properties, run the
 * task, then inspect the produced APK/AAB. `onLine` receives every log line.
 */
export async function buildAndroid({ projectDir, toolchain, variant = 'debug', kind = 'apk', module = null, signing = null, timeoutMs, onStart, onLine, id = `b_${Date.now().toString(36)}` }) {
  const info = await detectAndroidProject(projectDir);
  if (!info.gradleRoot) throw new Error(info.godot ? 'This is a Godot project; build the APK from Godot (Project → Export → Android). SleepPilot builds Gradle-based Android projects.' : 'No Android Gradle project was found in this folder (settings.gradle / build.gradle with the com.android.application plugin).');
  const appModule = module != null ? info.modules.find((m) => m.name === module) || { name: module } : info.appModule;
  if (!appModule) throw new Error('No Android application module was found (no module applies com.android.application).');
  if (!toolchain?.jdk?.ok) throw new Error(`No usable JDK ${ANDROID_DEFAULTS.minJdk}+ was found. Install Android Studio (it bundles one) or set the JDK folder under Settings → Android.`);
  if (!toolchain?.sdk?.found) throw new Error('The Android SDK was not found. Install Android Studio and its SDK, or set the SDK folder under Settings → Android.');
  const gradle = await resolveGradle(info.gradleRoot, toolchain);
  if (!gradle) throw new Error(`This project has no Gradle wrapper and no Gradle installation was found. Use "Download Gradle ${ANDROID_DEFAULTS.gradle}" on the Android screen (or install Gradle), then build again.`);
  const wroteLocal = await ensureLocalProperties(info.gradleRoot, toolchain.sdk.dir);
  const task = assembleTask(appModule.name, variant, kind);
  const env = { ...androidProcessEnv(toolchain), ...(variant === 'release' ? signingEnv(signing) : {}) };
  if (signing) for (const v of [signing.storePassword, signing.keyPassword]) registerSecret(v);
  const startedAt = Date.now();
  const extraArgs = gradle.source === 'wrapper' ? [] : ['--no-daemon'];
  // Started through a shell script (no wrapper on macOS/Linux): the signing values cannot travel
  // in the environment, so they are passed as -P properties, as Android Studio does.
  if (variant === 'release' && signing && gradle.viaShell) for (const [k, v] of Object.entries(signingEnv(signing))) extraArgs.push(`-P${k.replace('ORG_GRADLE_PROJECT_', '')}=${v}`);
  const build = new GradleBuild({ id, gradle, cwd: info.gradleRoot, tasks: [task], env, timeoutMs, extraArgs });
  if (onLine) build.on('line', onLine);
  if (wroteLocal) build.push(`SleepPilot wrote local.properties (sdk.dir=${toolchain.sdk.dir}).`);
  if (gradle.source !== 'wrapper') build.push(`No Gradle wrapper in the project; using Gradle ${gradle.version || ''} (${gradle.source}).`);
  if (variant === 'release') build.push(signing ? `Release build signed with the SleepPilot key "${signing.keyAlias}".` : 'Release build without a signing key: the APK is unsigned and cannot be installed until it is signed.');
  onStart?.(build);
  await build.start();
  const result = {
    id,
    task,
    variant,
    kind,
    module: appModule.name,
    gradle: { source: gradle.source, version: gradle.version || info.wrapper?.version || null },
    state: build.state,
    ok: build.state === 'succeeded',
    exitCode: build.exitCode,
    startedAt,
    endedAt: build.endedAt || Date.now(),
    durationMs: (build.endedAt || Date.now()) - startedAt,
    artifacts: [],
    diagnosis: null,
    log: build.lines.slice(-400),
  };
  if (result.ok) {
    const moduleDir = path.join(info.gradleRoot, ...(appModule.name ? appModule.name.split(':') : []));
    const found = (await findArtifacts(moduleDir, { since: startedAt - 2000 })).filter((a) => a.kind === kind && (!a.variant || a.variant.toLowerCase().includes(variant)));
    for (const a of found.slice(0, 6)) {
      const details = await inspectArtifact(a.file).catch((err) => ({ error: err.message }));
      result.artifacts.push({ ...a, path: path.relative(projectDir, a.file).split(path.sep).join('/'), details });
    }
    if (!result.artifacts.length) {
      result.ok = false;
      result.state = 'failed';
      result.diagnosis = { summary: `Gradle reported success, but no new ${kind.toUpperCase()} was found under ${path.relative(projectDir, moduleDir) || '.'}/build/outputs.`, hints: [] };
    }
  } else if (build.state !== 'cancelled') {
    result.diagnosis = explainBuildFailure(build.output());
  }
  return { build, result };
}

/** Copy a built artifact to the workspace's exports folder under a readable, versioned name. */
export async function exportArtifact(artifact, exportDir, { projectName = 'app' } = {}) {
  await fsp.mkdir(exportDir, { recursive: true });
  const m = artifact.details?.manifest;
  const version = m?.versionName ? `-${String(m.versionName).replace(/[^\w.-]+/g, '_')}` : '';
  const variant = artifact.variant ? `-${artifact.variant}` : '';
  const base = `${String(projectName).replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'app'}${version}${variant}${artifact.details?.signed === false && artifact.kind === 'apk' ? '-unsigned' : ''}`;
  const ext = artifact.kind === 'aab' ? '.aab' : '.apk';
  const target = path.join(exportDir, `${base}${ext}`);
  await fsp.copyFile(artifact.file, target);
  return target;
}

// ------------------------------------------------------------------ release signing

const keyFile = (projectId) => path.join(androidKeysDir(), `${String(projectId).replace(/[^\w.-]/g, '_')}.jks`);
const keyMeta = (projectId) => path.join(androidKeysDir(), `${String(projectId).replace(/[^\w.-]/g, '_')}.json`);

/** Signing key status of a project (the password itself stays in the credential store). */
export async function signingStatus(projectId) {
  const meta = await readJson(keyMeta(projectId), null).catch(() => null);
  const exists = !!(await fsp.stat(keyFile(projectId)).catch(() => null));
  return exists && meta ? { exists: true, storeFile: keyFile(projectId), keyAlias: meta.keyAlias, dname: meta.dname, createdAt: meta.createdAt, validityYears: meta.validityYears, sha256: meta.sha256 || null } : { exists: false, storeFile: keyFile(projectId) };
}

/**
 * Create a release keystore with the JDK's keytool. The random password is returned to the
 * caller for the credential store and is never written next to the key.
 */
export async function createSigningKey({ projectId, toolchain, commonName = 'SleepPilot app', organization = '', country = '', validityYears = 30 }) {
  const keytool = toolchain?.jdk?.keytool;
  if (!keytool) throw new Error('keytool was not found: it comes with the JDK. Install Android Studio or a JDK 17, then try again.');
  const file = keyFile(projectId);
  if (await fsp.stat(file).catch(() => null)) throw new Error('This project already has a signing key. Apps can only be updated with the key they were first published with, so SleepPilot never replaces it.');
  await fsp.mkdir(androidKeysDir(), { recursive: true });
  const password = crypto.randomBytes(24).toString('base64url');
  registerSecret(password);
  const clean = (s) => String(s || '').replace(/[,=+<>#;"\\]/g, ' ').trim().slice(0, 64);
  const dname = [`CN=${clean(commonName) || 'SleepPilot app'}`, organization ? `O=${clean(organization)}` : null, /^[A-Za-z]{2}$/.test(country) ? `C=${country.toUpperCase()}` : null].filter(Boolean).join(', ');
  const keyAlias = 'release';
  const r = await runFile(keytool, ['-genkeypair', '-v', '-keystore', file, '-storetype', 'PKCS12', '-alias', keyAlias, '-keyalg', 'RSA', '-keysize', '4096', '-validity', String(Math.round(validityYears * 365)), '-dname', dname, '-storepass', password, '-keypass', password], { timeoutMs: 120_000 });
  if (r.exitCode !== 0) {
    await fsp.rm(file, { force: true });
    throw new Error(`keytool failed: ${redact(`${r.stderr || ''}${r.stdout || ''}`).trim().slice(0, 600) || `exit code ${r.exitCode}`}`);
  }
  if (process.platform !== 'win32') await fsp.chmod(file, 0o600).catch(() => {});
  const list = await runFile(keytool, ['-list', '-v', '-keystore', file, '-storepass', password, '-alias', keyAlias], { timeoutMs: 60_000 });
  const sha256 = `${list.stdout || ''}`.match(/SHA256:\s*([0-9A-F:]+)/i)?.[1] || null;
  const meta = { keyAlias, dname, createdAt: Date.now(), validityYears, sha256 };
  await writeJsonAtomic(keyMeta(projectId), meta);
  return { password, status: await signingStatus(projectId) };
}

// ------------------------------------------------------------------ Gradle wrapper and download

/** Add (or repair) the Gradle wrapper using a Gradle installation, without configuring the project. */
export async function addGradleWrapper({ gradleRoot, toolchain, version = ANDROID_DEFAULTS.gradle }) {
  const gradlePath = toolchain?.gradle?.path;
  if (!gradlePath) throw new Error(`No Gradle installation was found to create the wrapper. Use "Download Gradle ${ANDROID_DEFAULTS.gradle}" first.`);
  if (!toolchain?.jdk?.ok) throw new Error('A JDK 17+ is needed to run Gradle.');
  // In an empty folder: running the wrapper task inside the project would first configure the
  // whole Android build (and download the Android Gradle Plugin).
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'sp-wrapper-'));
  try {
    await fsp.writeFile(path.join(tmp, 'settings.gradle'), "rootProject.name = 'wrapper'\n", 'utf8');
    const r = await runFile(gradlePath, ['wrapper', '--gradle-version', version, '--distribution-type', 'bin', '--no-daemon', '--console=plain'], { cwd: tmp, env: androidProcessEnv(toolchain), timeoutMs: 10 * 60_000 });
    if (r.exitCode !== 0) throw new Error(`gradle wrapper failed: ${explainBuildFailure(`${r.stdout}\n${r.stderr}`).summary}`);
    const copied = [];
    for (const rel of ['gradlew', 'gradlew.bat', 'gradle/wrapper/gradle-wrapper.jar', 'gradle/wrapper/gradle-wrapper.properties']) {
      const from = path.join(tmp, ...rel.split('/'));
      if (!(await fsp.stat(from).catch(() => null))) continue;
      const to = path.join(gradleRoot, ...rel.split('/'));
      await fsp.mkdir(path.dirname(to), { recursive: true });
      await fsp.copyFile(from, to);
      if (rel === 'gradlew' && process.platform !== 'win32') await fsp.chmod(to, 0o755).catch(() => {});
      copied.push(rel);
    }
    return { version, files: copied };
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Download the official Gradle distribution into SleepPilot's tools folder (only on the user's
 * request). The archive's SHA-256 is checked against the checksum Gradle publishes next to it.
 */
export async function downloadGradle({ version = ANDROID_DEFAULTS.gradle, fetchImpl = globalThis.fetch, baseUrl = 'https://services.gradle.org/distributions', onProgress } = {}) {
  if (!/^\d+\.\d+(\.\d+)?$/.test(version)) throw new Error(`Invalid Gradle version: ${version}`);
  const dest = managedGradleDir(version);
  const bin = path.join(dest, 'bin', process.platform === 'win32' ? 'gradle.bat' : 'gradle');
  if (await fsp.stat(bin).catch(() => null)) return { version, path: bin, alreadyInstalled: true };
  const name = `gradle-${version}-bin.zip`;
  const sumRes = await fetchImpl(`${baseUrl}/${name}.sha256`);
  if (!sumRes.ok) throw new Error(`Could not get the Gradle checksum (HTTP ${sumRes.status}).`);
  const expected = (await sumRes.text()).trim().split(/\s+/)[0].toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected)) throw new Error('The published Gradle checksum is not a SHA-256 value.');
  const res = await fetchImpl(`${baseUrl}/${name}`);
  if (!res.ok || !res.body) throw new Error(`Could not download Gradle ${version} (HTTP ${res.status}).`);
  await fsp.mkdir(toolsDir(), { recursive: true });
  const zipFile = path.join(toolsDir(), `${name}.${process.pid}.part`);
  const hash = crypto.createHash('sha256');
  const total = Number(res.headers?.get?.('content-length')) || null;
  let received = 0;
  const out = fs.createWriteStream(zipFile);
  try {
    for await (const chunk of res.body) {
      const buf = Buffer.from(chunk);
      hash.update(buf);
      received += buf.length;
      if (!out.write(buf)) await new Promise((r) => out.once('drain', r));
      onProgress?.({ received, total });
    }
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
    const actual = hash.digest('hex');
    if (actual !== expected) throw new Error(`Gradle download checksum mismatch (expected ${expected.slice(0, 12)}…, got ${actual.slice(0, 12)}…). Nothing was installed.`);
    const staging = `${dest}.${process.pid}.tmp`;
    await fsp.rm(staging, { recursive: true, force: true });
    await extractZip(zipFile, staging, { strip: 1 });
    await fsp.rm(dest, { recursive: true, force: true });
    await fsp.rename(staging, dest);
    if (process.platform !== 'win32') await fsp.chmod(path.join(dest, 'bin', 'gradle'), 0o755).catch(() => {});
    return { version, path: bin, bytes: received, sha256: actual };
  } finally {
    out.destroy();
    await fsp.rm(zipFile, { force: true }).catch(() => {});
  }
}

// ------------------------------------------------------------------ devices (adb)

/** Parse `adb devices -l`. */
export function parseAdbDevices(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/^(\S+)\s+(device|unauthorized|offline|recovery|sideload|bootloader|no permissions)\b(.*)$/);
    if (!m) continue;
    const props = Object.fromEntries([...m[3].matchAll(/(\w+):(\S+)/g)].map((x) => [x[1], x[2]]));
    out.push({ serial: m[1], state: m[2], model: props.model ? props.model.replace(/_/g, ' ') : null, product: props.product || null, device: props.device || null, transport: props.transport_id || null, emulator: m[1].startsWith('emulator-'), usable: m[2] === 'device' });
  }
  return out;
}

export async function listDevices(toolchain) {
  const adb = toolchain?.sdk?.adb;
  if (!adb) return { adb: null, devices: [], error: 'adb was not found. Install "Android SDK Platform-Tools" in Android Studio\'s SDK Manager.' };
  const r = await runFile(adb, ['devices', '-l'], { timeoutMs: 20_000, env: androidProcessEnv(toolchain) });
  if (r.error || r.exitCode !== 0) return { adb, devices: [], error: redact(`${r.stderr || r.error?.message || ''}`).trim().slice(0, 300) || 'adb did not answer.' };
  return { adb, devices: parseAdbDevices(r.stdout), error: null };
}

/** Install an APK on a device (replacing an older version) and optionally start it. */
export async function installApk({ toolchain, serial, apk, launch = true, packageName = null }) {
  const adb = toolchain?.sdk?.adb;
  if (!adb) throw new Error('adb was not found. Install "Android SDK Platform-Tools" in the SDK Manager.');
  const env = androidProcessEnv(toolchain);
  const base = serial ? ['-s', serial] : [];
  const r = await runFile(adb, [...base, 'install', '-r', '-d', apk], { timeoutMs: 5 * 60_000, env });
  const output = redact(`${r.stdout || ''}${r.stderr || ''}`).trim();
  if (r.exitCode !== 0 || !/\bSuccess\b/.test(output)) {
    let hint = null;
    if (/INSTALL_FAILED_UPDATE_INCOMPATIBLE|signatures do not match/i.test(output)) hint = 'The phone has this app signed with a different key. Uninstall it on the phone first (its data is lost), then install again.';
    else if (/INSTALL_PARSE_FAILED_NO_CERTIFICATES|not signed/i.test(output)) hint = 'The APK is not signed. Build the debug APK, or create a release signing key first.';
    else if (/INSTALL_FAILED_OLDER_SDK/i.test(output)) hint = 'The phone\'s Android version is older than the app\'s minSdk.';
    else if (/unauthorized/i.test(output)) hint = 'Unlock the phone and accept the "Allow USB debugging" prompt.';
    else if (/INSTALL_FAILED_INSUFFICIENT_STORAGE/i.test(output)) hint = 'The phone is out of storage.';
    throw Object.assign(new Error(`Install failed: ${output.split('\n').slice(-3).join(' ').slice(0, 400) || `exit code ${r.exitCode}`}`), { hint });
  }
  let launched = false;
  if (launch && packageName) {
    const l = await runFile(adb, [...base, 'shell', 'monkey', '-p', packageName, '-c', 'android.intent.category.LAUNCHER', '1'], { timeoutMs: 30_000, env });
    launched = l.exitCode === 0 && !/No activities found|aborted/i.test(`${l.stdout}${l.stderr}`);
  }
  return { ok: true, output: output.slice(-600), launched };
}

/** Recent errors from the device log for an app (crash stack traces after "install and run"). */
export async function recentDeviceErrors({ toolchain, serial, packageName = null, lines = 300 }) {
  const adb = toolchain?.sdk?.adb;
  if (!adb) throw new Error('adb was not found.');
  const base = serial ? ['-s', serial] : [];
  const r = await runFile(adb, [...base, 'logcat', '-d', '-t', String(Math.min(Math.max(lines, 50), 3000)), '-v', 'time', '*:E'], { timeoutMs: 30_000, env: androidProcessEnv(toolchain) });
  let out = `${r.stdout || ''}`.split(/\r?\n/);
  if (packageName) {
    const related = out.filter((l) => l.includes(packageName) || /FATAL EXCEPTION|AndroidRuntime/.test(l));
    if (related.length) out = related;
  }
  return { lines: out.filter(Boolean).slice(-200).map((l) => redact(l).slice(0, 400)) };
}
