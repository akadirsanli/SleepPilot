import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runFile } from '../util/proc.mjs';
import { toolsDir } from '../util/paths.mjs';
import { cmpVersion } from '../tools/catalog.mjs';

/**
 * Android build toolchain detection (read-only): JDK, Android SDK, Gradle, adb, Android Studio.
 *
 * Android Studio installs everything an APK build needs but puts none of it on PATH and sets no
 * environment variables, so "java is not recognised" is the usual first failure. SleepPilot
 * therefore looks in the places Android Studio uses and passes what it finds to the build as
 * JAVA_HOME / ANDROID_HOME, instead of asking the user to edit system variables.
 */
export const ANDROID_DEFAULTS = {
  /** Android Gradle Plugin used by the templates, and the Gradle version it is built against. */
  agp: '8.5.2',
  gradle: '8.9',
  minGradleForAgp: '8.7',
  minJdk: 17,
  compileSdk: 34,
  targetSdk: 34,
  minSdk: 24,
};

const exe = (name, platform = process.platform) => (platform === 'win32' ? `${name}.exe` : name);
const bat = (name, platform = process.platform) => (platform === 'win32' ? `${name}.bat` : name);

async function isDir(p) {
  return !!p && !!(await fsp.stat(p).catch(() => null))?.isDirectory();
}
async function isFile(p) {
  return !!p && !!(await fsp.stat(p).catch(() => null))?.isFile();
}

/** Expand a path whose segments may contain `*` (e.g. `C:/Program Files/Java/jdk-*`). */
async function expand(pattern) {
  if (!pattern) return [];
  if (!pattern.includes('*')) return [pattern];
  const parts = path.normalize(pattern).split(path.sep);
  let bases = [parts[0] === '' ? path.sep : parts[0] + path.sep];
  for (const part of parts.slice(1)) {
    const next = [];
    for (const base of bases) {
      if (!part.includes('*')) next.push(path.join(base, part));
      else {
        const re = new RegExp('^' + part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i');
        for (const e of await fsp.readdir(base, { withFileTypes: true }).catch(() => [])) if (re.test(e.name)) next.push(path.join(base, e.name));
      }
    }
    bases = next.slice(0, 80);
    if (!bases.length) return [];
  }
  return bases;
}

/** "17.0.9" → 17, "1.8.0_392" → 8, "21" → 21. */
export function javaMajor(version) {
  const m = String(version || '').match(/^(\d+)(?:\.(\d+))?/);
  if (!m) return null;
  return Number(m[1]) === 1 && m[2] ? Number(m[2]) : Number(m[1]);
}

/** Read a JDK folder: its java binary and version (from the `release` file; no process is started). */
export async function inspectJdk(home, { platform = process.platform, allowRun = true } = {}) {
  if (!(await isDir(home))) return null;
  const java = path.join(home, 'bin', exe('java', platform));
  if (!(await isFile(java))) return null;
  let version = null;
  const release = await fsp.readFile(path.join(home, 'release'), 'utf8').catch(() => '');
  const m = release.match(/^JAVA_VERSION="?([^"\r\n]+)"?/m);
  if (m) version = m[1].trim();
  if (!version && allowRun) {
    const r = await runFile(java, ['-version'], { timeoutMs: 15_000 }).catch(() => null);
    const v = `${r?.stderr || ''}${r?.stdout || ''}`.match(/version "([^"]+)"/);
    if (v) version = v[1];
  }
  const javac = await isFile(path.join(home, 'bin', exe('javac', platform)));
  return { home, java, version, major: javaMajor(version), jdk: javac, keytool: (await isFile(path.join(home, 'bin', exe('keytool', platform)))) ? path.join(home, 'bin', exe('keytool', platform)) : null };
}

function studioDirs({ env, platform, home }) {
  if (platform === 'win32') {
    const pf = env.ProgramFiles || 'C:\\Program Files';
    const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return [path.join(pf, 'Android', 'Android Studio'), path.join(local, 'Programs', 'Android Studio'), path.join(local, 'Android', 'Android Studio'), path.join(local, 'JetBrains', 'Toolbox', 'apps', 'android-studio')];
  }
  if (platform === 'darwin') return ['/Applications/Android Studio.app/Contents', path.join(home, 'Applications', 'Android Studio.app', 'Contents')];
  return ['/opt/android-studio', '/usr/local/android-studio', path.join(home, 'android-studio'), '/snap/android-studio/current/android-studio'];
}

async function jdkCandidates({ settings, env, platform, home, scan = true }) {
  const list = [];
  const add = (dir, source) => dir && list.push({ dir, source });
  add(settings.jdkHome, 'SleepPilot setting');
  add(env.JAVA_HOME, 'JAVA_HOME');
  if (!scan) return list;
  for (const studio of studioDirs({ env, platform, home })) {
    add(path.join(studio, 'jbr'), 'Android Studio (bundled JDK)');
    if (platform === 'darwin') add(path.join(studio, 'jbr', 'Contents', 'Home'), 'Android Studio (bundled JDK)');
    add(path.join(studio, 'jre'), 'Android Studio (bundled JDK)');
  }
  const patterns = platform === 'win32'
    ? [
        path.join(env.ProgramFiles || 'C:\\Program Files', 'Eclipse Adoptium', 'jdk-*'),
        path.join(env.ProgramFiles || 'C:\\Program Files', 'Java', 'jdk-*'),
        path.join(env.ProgramFiles || 'C:\\Program Files', 'Microsoft', 'jdk-*'),
        path.join(env.ProgramFiles || 'C:\\Program Files', 'Zulu', 'zulu-*'),
        path.join(env.ProgramFiles || 'C:\\Program Files', 'Amazon Corretto', 'jdk*'),
        path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Programs', 'Eclipse Adoptium', 'jdk-*'),
        path.join(home, '.jdks', '*'),
        path.join(home, 'scoop', 'apps', 'temurin*-jdk', 'current'),
      ]
    : platform === 'darwin'
      ? ['/Library/Java/JavaVirtualMachines/*/Contents/Home', path.join(home, 'Library', 'Java', 'JavaVirtualMachines', '*', 'Contents', 'Home'), '/opt/homebrew/opt/openjdk*/libexec/openjdk.jdk/Contents/Home', path.join(home, '.sdkman', 'candidates', 'java', 'current')]
      : ['/usr/lib/jvm/*', '/usr/java/*', '/opt/java/*', path.join(home, '.jdks', '*'), path.join(home, '.sdkman', 'candidates', 'java', 'current')];
  for (const pattern of patterns) for (const dir of await expand(pattern)) add(dir, 'installed JDK');
  return list;
}

/** `java` on PATH → its home folder (asks the JVM itself; used only when nothing else was found). */
async function jdkFromPath() {
  const r = await runFile('java', ['-XshowSettings:properties', '-version'], { timeoutMs: 15_000 }).catch(() => null);
  const m = `${r?.stderr || ''}${r?.stdout || ''}`.match(/java\.home\s*=\s*(.+)/);
  return m ? m[1].trim() : null;
}

async function detectJdk(ctx) {
  const seen = new Set();
  const all = [];
  for (const c of await jdkCandidates(ctx)) {
    const key = path.resolve(c.dir).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const info = await inspectJdk(c.dir, ctx);
    if (info) all.push({ ...info, source: c.source });
    if (all.length >= 12) break;
  }
  if (!all.some((j) => (j.major || 0) >= ANDROID_DEFAULTS.minJdk) && ctx.allowRun && ctx.scan !== false) {
    const home = await jdkFromPath();
    if (home && !seen.has(path.resolve(home).toLowerCase())) {
      const info = await inspectJdk(home, ctx);
      if (info) all.push({ ...info, source: 'java on PATH' });
    }
  }
  // The first usable one in priority order (setting, JAVA_HOME, Android Studio, others).
  const usable = all.find((j) => (j.major || 0) >= ANDROID_DEFAULTS.minJdk && j.jdk) || null;
  const best = usable || all[0] || null;
  return {
    found: !!best,
    ok: !!usable,
    home: best?.home || null,
    java: best?.java || null,
    keytool: best?.keytool || null,
    version: best?.version || null,
    major: best?.major || null,
    source: best?.source || null,
    all: all.map((j) => ({ home: j.home, version: j.version, major: j.major, source: j.source, jdk: j.jdk })),
  };
}

function sdkCandidates({ settings, env, platform, home, scan = true }) {
  const list = [];
  const add = (dir, source) => dir && list.push({ dir, source });
  add(settings.sdkDir, 'SleepPilot setting');
  add(env.ANDROID_HOME, 'ANDROID_HOME');
  add(env.ANDROID_SDK_ROOT, 'ANDROID_SDK_ROOT');
  if (!scan) return list;
  if (platform === 'win32') {
    add(path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Android', 'Sdk'), 'Android Studio default location');
    add('C:\\Android\\Sdk', 'common location');
    add('C:\\Android\\android-sdk', 'common location');
  } else if (platform === 'darwin') {
    add(path.join(home, 'Library', 'Android', 'sdk'), 'Android Studio default location');
  } else {
    add(path.join(home, 'Android', 'Sdk'), 'Android Studio default location');
    add('/usr/lib/android-sdk', 'system package');
    add('/opt/android-sdk', 'common location');
  }
  return list;
}

const apiLevel = (name) => Number(String(name).match(/^android-(\d+)/)?.[1] || 0);

async function inspectSdk(dir, { platform = process.platform } = {}) {
  if (!(await isDir(dir))) return null;
  const names = async (sub) => (await fsp.readdir(path.join(dir, sub), { withFileTypes: true }).catch(() => [])).filter((e) => e.isDirectory()).map((e) => e.name);
  const platforms = (await names('platforms')).filter((n) => /^android-\d+/.test(n)).sort((a, b) => apiLevel(a) - apiLevel(b));
  const buildTools = (await names('build-tools')).filter((n) => /^\d/.test(n)).sort(cmpVersion);
  const adbPath = path.join(dir, 'platform-tools', exe('adb', platform));
  const adb = (await isFile(adbPath)) ? adbPath : null;
  const cmdline = await names('cmdline-tools');
  let sdkmanager = null;
  for (const v of ['latest', ...cmdline.filter((n) => n !== 'latest').sort(cmpVersion).reverse()]) {
    const p = path.join(dir, 'cmdline-tools', v, 'bin', bat('sdkmanager', platform));
    if (await isFile(p)) {
      sdkmanager = p;
      break;
    }
  }
  if (!platforms.length && !buildTools.length && !adb && !cmdline.length) return null;
  const emulatorPath = path.join(dir, 'emulator', exe('emulator', platform));
  return {
    dir,
    platforms,
    highestApi: platforms.length ? apiLevel(platforms.at(-1)) : null,
    buildTools,
    adb,
    sdkmanager,
    licensesAccepted: await isFile(path.join(dir, 'licenses', 'android-sdk-license')),
    ndk: (await names('ndk')).sort(cmpVersion),
    emulator: (await isFile(emulatorPath)) ? emulatorPath : null,
  };
}

async function detectSdk(ctx) {
  const seen = new Set();
  for (const c of sdkCandidates(ctx)) {
    const key = path.resolve(c.dir).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const info = await inspectSdk(c.dir, ctx);
    if (info) return { found: true, source: c.source, ...info };
  }
  return { found: false, dir: null, source: null, platforms: [], highestApi: null, buildTools: [], adb: null, sdkmanager: null, licensesAccepted: false, ndk: [], emulator: null };
}

/** Version of a Gradle installation, read from its folder name or launcher jar (no process). */
async function gradleVersionOf(binFile) {
  const home = path.dirname(path.dirname(binFile));
  const fromPath = home.match(/gradle-(\d+(?:\.\d+)+)/i);
  if (fromPath) return fromPath[1];
  const libs = await fsp.readdir(path.join(home, 'lib')).catch(() => []);
  const jar = libs.map((n) => n.match(/^gradle-(?:launcher|core)-(\d+(?:\.\d+)+)\.jar$/)).find(Boolean);
  return jar ? jar[1] : null;
}

/** Folder holding SleepPilot's own (user-requested) Gradle download for a version. */
export const managedGradleDir = (version = ANDROID_DEFAULTS.gradle) => path.join(toolsDir(), `gradle-${version}`);

async function detectGradle(ctx) {
  const { settings, env, platform, home } = ctx;
  const script = bat('gradle', platform);
  const found = [];
  const seen = new Set();
  const add = async (file, source) => {
    if (!file) return;
    const key = path.resolve(file).toLowerCase();
    if (seen.has(key) || !(await isFile(file))) return;
    seen.add(key);
    found.push({ path: file, source, version: await gradleVersionOf(file) });
  };
  if (settings.gradlePath) await add(settings.gradlePath, 'SleepPilot setting');
  if (ctx.scan === false) return { found: !!found[0], path: found[0]?.path || null, version: found[0]?.version || null, source: found[0]?.source || null, managed: false, all: found };
  for (const dir of await expand(path.join(toolsDir(), 'gradle-*'))) await add(path.join(dir, 'bin', script), 'downloaded by SleepPilot');
  if (env.GRADLE_HOME) await add(path.join(env.GRADLE_HOME, 'bin', script), 'GRADLE_HOME');
  for (const dir of String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean).slice(0, 200)) await add(path.join(dir, script), 'PATH');
  const patterns = platform === 'win32'
    ? [
        path.join(env.ProgramFiles || 'C:\\Program Files', 'Gradle', 'gradle-*', 'bin', script),
        path.join('C:\\Gradle', 'gradle-*', 'bin', script),
        path.join(home, 'scoop', 'apps', 'gradle', 'current', 'bin', script),
        path.join(env.ProgramData || 'C:\\ProgramData', 'chocolatey', 'lib', 'gradle', 'tools', 'gradle-*', 'bin', script),
      ]
    : ['/opt/gradle/gradle-*/bin/gradle', '/usr/share/gradle/bin/gradle', '/opt/homebrew/opt/gradle/libexec/bin/gradle', path.join(home, '.sdkman', 'candidates', 'gradle', 'current', 'bin', 'gradle')];
  for (const pattern of patterns) for (const file of await expand(pattern)) await add(file, 'installed Gradle');
  // Distributions the Gradle wrapper (Android Studio, earlier builds) already downloaded.
  const userHome = env.GRADLE_USER_HOME || path.join(home, '.gradle');
  for (const file of await expand(path.join(userHome, 'wrapper', 'dists', 'gradle-*', '*', 'gradle-*', 'bin', script))) await add(file, 'Gradle wrapper cache');

  // An explicit setting wins; otherwise SleepPilot's own download, then the newest version found.
  const rank = (g) => (g.source === 'SleepPilot setting' ? 2 : g.source === 'downloaded by SleepPilot' ? 1 : 0);
  found.sort((a, b) => rank(b) - rank(a) || cmpVersion(b.version || '0', a.version || '0'));
  const best = found[0] || null;
  return {
    found: !!best,
    path: best?.path || null,
    version: best?.version || null,
    source: best?.source || null,
    managed: found.some((g) => g.source === 'downloaded by SleepPilot'),
    all: found.slice(0, 10),
  };
}

async function detectStudio(ctx) {
  if (ctx.scan === false) return { found: false, path: null };
  for (const dir of studioDirs(ctx)) if (await isDir(dir)) return { found: true, path: dir };
  return { found: false, path: null };
}

/**
 * @returns {Promise<{jdk, sdk, gradle, studio, ready: boolean, problems: Array<{id, severity, title, fix}>, env: object, checkedAt: number}>}
 */
/**
 * `scan: false` looks only at the configured paths and JAVA_HOME/ANDROID_HOME (no install
 * folders, no PATH) — used where the result must not depend on what this computer has installed.
 */
export async function detectAndroidToolchain({ settings = {}, env = process.env, platform = process.platform, home = os.homedir(), allowRun = true, scan = true } = {}) {
  const ctx = { settings: settings || {}, env, platform, home, allowRun, scan };
  const [jdk, sdk, gradle, studio] = await Promise.all([detectJdk(ctx), detectSdk(ctx), detectGradle(ctx), detectStudio(ctx)]);
  const problems = [];
  const studioHint = studio.found ? 'Android Studio is installed: open it → More Actions → SDK Manager.' : 'Install Android Studio (https://developer.android.com/studio); it brings the JDK, the SDK and the SDK Manager.';
  if (!jdk.found) problems.push({ id: 'jdk-missing', severity: 'error', title: 'No JDK was found', fix: `Android builds need JDK ${ANDROID_DEFAULTS.minJdk} or newer. ${studio.found ? 'Android Studio is installed but its bundled JDK was not found; set the JDK folder under Settings → Android.' : 'Install Android Studio (it bundles one) or Temurin 17 from https://adoptium.net/.'}` });
  else if (!jdk.ok) problems.push({ id: 'jdk-old', severity: 'error', title: `JDK ${jdk.version || '?'} is too old or is only a runtime`, fix: `The Android Gradle Plugin needs a full JDK ${ANDROID_DEFAULTS.minJdk}+ (found: ${jdk.home}). Install Android Studio or Temurin 17, or set the JDK folder under Settings → Android.` });
  if (!sdk.found) problems.push({ id: 'sdk-missing', severity: 'error', title: 'The Android SDK was not found', fix: `${studioHint} Or set the SDK folder under Settings → Android.` });
  else {
    if (!sdk.platforms.length) problems.push({ id: 'sdk-platform', severity: 'error', title: 'No Android platform is installed in the SDK', fix: `In the SDK Manager install "Android SDK Platform ${ANDROID_DEFAULTS.compileSdk}".${sdk.sdkmanager ? ` Command line: sdkmanager "platforms;android-${ANDROID_DEFAULTS.compileSdk}"` : ''}` });
    if (!sdk.buildTools.length) problems.push({ id: 'sdk-build-tools', severity: 'warn', title: 'No Android build-tools are installed', fix: 'Gradle downloads them on the first build if the SDK licences are accepted; otherwise install "Android SDK Build-Tools" in the SDK Manager.' });
    if (!sdk.licensesAccepted) problems.push({ id: 'sdk-licenses', severity: 'warn', title: 'The Android SDK licences are not accepted', fix: sdk.sdkmanager ? 'Run: sdkmanager --licenses (answer y), or install any package in Android Studio\'s SDK Manager and accept the licence there.' : 'Install any package in Android Studio\'s SDK Manager and accept the licence; missing SDK parts cannot be downloaded by the build until then.' });
    if (!sdk.adb) problems.push({ id: 'adb-missing', severity: 'info', title: 'adb (platform-tools) is not installed', fix: 'Only needed to install the APK on a connected phone from SleepPilot. Install "Android SDK Platform-Tools" in the SDK Manager.' });
  }
  if (!gradle.found) problems.push({ id: 'gradle-missing', severity: 'info', title: 'No Gradle installation was found', fix: `Projects that ship a Gradle wrapper (gradlew) do not need one. For projects without it, download Gradle ${ANDROID_DEFAULTS.gradle} with the button below, or install Gradle from https://gradle.org/install/.` });
  const toolEnv = {};
  if (jdk.ok) toolEnv.JAVA_HOME = jdk.home;
  if (sdk.found) {
    toolEnv.ANDROID_HOME = sdk.dir;
    toolEnv.ANDROID_SDK_ROOT = sdk.dir;
  }
  return {
    jdk,
    sdk,
    gradle,
    studio,
    ready: jdk.ok && sdk.found && sdk.platforms.length > 0,
    problems,
    env: toolEnv,
    defaults: ANDROID_DEFAULTS,
    checkedAt: Date.now(),
  };
}

/** Environment for a Gradle/adb process: the detected JDK and SDK win over whatever is on PATH. */
export function androidProcessEnv(toolchain, base = process.env) {
  const env = { ...base, ...(toolchain?.env || {}) };
  const extra = [];
  if (toolchain?.jdk?.ok && toolchain.jdk.home) extra.push(path.join(toolchain.jdk.home, 'bin'));
  if (toolchain?.sdk?.dir) extra.push(path.join(toolchain.sdk.dir, 'platform-tools'));
  if (extra.length) {
    const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'PATH';
    env[key] = [...extra, env[key] || ''].filter(Boolean).join(path.delimiter);
  }
  return env;
}

/**
 * Make the detected JDK/SDK visible to every process SleepPilot starts from now on (agent turns,
 * checks), but only for variables the user has not set. Returns what was added.
 */
export function exportAndroidEnv(toolchain, target = process.env) {
  const added = {};
  for (const [k, v] of Object.entries(toolchain?.env || {})) {
    if (!target[k] && v) {
      target[k] = v;
      added[k] = v;
    }
  }
  return added;
}

// ------------------------------------------------------------------ shared, cached detection

let configured = {};
let cache = null;
let inflight = null;
const CACHE_MS = 60_000;

/** The user's Settings → Android paths (JDK, SDK, Gradle); used by every detection afterwards. */
export function configureAndroid(settings = {}) {
  const next = { jdkHome: settings?.jdkHome || null, sdkDir: settings?.sdkDir || null, gradlePath: settings?.gradlePath || null };
  if (JSON.stringify(next) !== JSON.stringify(configured)) cache = null;
  configured = next;
}

/** Detection shared by the Android screen and the "Android build" check (cached for a minute). */
export async function cachedAndroidToolchain({ force = false } = {}) {
  if (!force && cache && Date.now() - cache.checkedAt < CACHE_MS) return cache;
  if (inflight) return inflight;
  inflight = detectAndroidToolchain({ settings: configured })
    .then((t) => {
      cache = t;
      // Agent turns and command checks started from now on see the same JDK/SDK as SleepPilot.
      exportAndroidEnv(t);
      return t;
    })
    .finally(() => (inflight = null));
  return inflight;
}

export function invalidateAndroidToolchain() {
  cache = null;
}
