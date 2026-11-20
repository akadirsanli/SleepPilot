import fsp from 'node:fs/promises';
import path from 'node:path';
import { IGNORED_DIRS } from '../project/snapshot.mjs';
import { listZip, readZipEntry, readFileRange } from '../util/zip.mjs';

/**
 * Android project discovery and APK/AAB inspection (read-only).
 *
 * Supported layouts: a plain Gradle Android project (app module at the root), and frameworks
 * that keep the Gradle project in a sub-folder: Flutter, React Native and Capacitor/Cordova
 * (`android/`), libGDX (`android/` module next to `core/`), and Godot (export presets only).
 */
const SETTINGS_FILES = ['settings.gradle.kts', 'settings.gradle'];
const BUILD_FILES = ['build.gradle.kts', 'build.gradle'];

async function readText(file) {
  return fsp.readFile(file, 'utf8').catch(() => null);
}
async function exists(file) {
  return !!(await fsp.stat(file).catch(() => null));
}
const rel = (root, p) => path.relative(root, p).split(path.sep).join('/') || '.';

/** Gradle module paths from a settings file: include(":app", ":core") / include ':app', ':wear'. */
export function parseIncludes(settingsText) {
  const out = [];
  const text = String(settingsText || '').replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of text.matchAll(/\binclude\s*\(?([^)\n]+)\)?/g)) {
    for (const q of m[1].matchAll(/["']([^"']+)["']/g)) {
      const name = q[1].replace(/^:/, '');
      if (name && !out.includes(name)) out.push(name);
    }
  }
  return out;
}

/** The values an app module's build file declares (literal values only; variables are left null). */
export function parseModuleBuild(text) {
  const t = String(text || '');
  const pick = (re) => {
    const m = t.match(re);
    return m ? m[1] : null;
  };
  const num = (re) => {
    const v = pick(re);
    return v != null && /^\d+$/.test(v) ? Number(v) : null;
  };
  const isApp = /com\.android\.application|android\.application|alias\(libs\.plugins\.android\.application\)|apply\s+plugin:\s*["']com\.android\.application["']/.test(t);
  const isLib = /com\.android\.library|android\.library/.test(t);
  return {
    isApp,
    isLib,
    namespace: pick(/\bnamespace\s*=?\s*["']([\w.]+)["']/),
    applicationId: pick(/\bapplicationId\s*=?\s*["']([\w.]+)["']/),
    versionCode: num(/\bversionCode\s*=?\s*(\d+)/),
    versionName: pick(/\bversionName\s*=?\s*["']([^"']+)["']/),
    minSdk: num(/\bminSdk(?:Version)?\s*=?\s*(?:\(\s*)?(\d+)/),
    targetSdk: num(/\btargetSdk(?:Version)?\s*=?\s*(?:\(\s*)?(\d+)/),
    compileSdk: num(/\bcompileSdk(?:Version)?\s*=?\s*(?:\(\s*)?(\d+)/),
    kotlin: /kotlin\(["']android["']\)|org\.jetbrains\.kotlin\.android|kotlin-android|libs\.plugins\.kotlin\.android/.test(t),
    compose: /compose\s*=\s*true|compose\s+true|buildFeatures\s*\{[^}]*compose/.test(t),
    signingConfigs: /signingConfigs\s*\{/.test(t),
  };
}

/** Find the folder that holds the Android Gradle project (the project root or a known sub-folder). */
async function findGradleRoot(dir) {
  for (const sub of ['', 'android', 'app/android', 'mobile', 'platforms/android']) {
    const base = sub ? path.join(dir, ...sub.split('/')) : dir;
    for (const f of SETTINGS_FILES) if (await exists(path.join(base, f))) return { base, settings: path.join(base, f) };
    // A single-module project may have no settings file at all.
    for (const f of BUILD_FILES) {
      const text = await readText(path.join(base, f));
      if (text && parseModuleBuild(text).isApp) return { base, settings: null };
    }
  }
  return null;
}

function frameworkOf(files) {
  if (files.has('pubspec.yaml')) return { id: 'flutter', label: 'Flutter', build: 'flutter build apk' };
  if (files.has('capacitor.config.json') || files.has('capacitor.config.ts')) return { id: 'capacitor', label: 'Capacitor (web app in a native shell)', build: 'npx cap sync android, then Gradle' };
  if (files.has('config.xml') && files.has('www/')) return { id: 'cordova', label: 'Cordova', build: 'cordova build android' };
  if (files.has('app.json') && files.has('package.json') && files.has('android/')) return { id: 'react-native', label: 'React Native', build: 'Gradle (android/)' };
  if (files.has('core/') && files.has('android/')) return { id: 'libgdx', label: 'libGDX', build: 'Gradle :android:assembleDebug' };
  if (files.has('project.godot')) return { id: 'godot', label: 'Godot', build: 'Godot export (export_presets.cfg)' };
  return null;
}

/**
 * Describe the Android side of a project folder.
 * @returns {Promise<{isAndroid, framework, gradleRoot, gradleRootRel, wrapper, modules, appModule, godot, notes}>}
 */
export async function detectAndroidProject(dir) {
  const root = path.resolve(dir);
  const top = new Set((await fsp.readdir(root, { withFileTypes: true }).catch(() => [])).map((e) => (e.isDirectory() ? `${e.name}/` : e.name)));
  const framework = frameworkOf(top);
  const notes = [];
  let godot = null;
  if (top.has('project.godot')) {
    const presets = await readText(path.join(root, 'export_presets.cfg'));
    const android = presets ? [...presets.matchAll(/\[preset\.(\d+)\][\s\S]*?name="([^"]*)"[\s\S]*?platform="Android"/g)].map((m) => m[2]) : [];
    godot = { presets: android, hasAndroidPreset: android.length > 0 };
    if (!android.length) notes.push('Godot project without an Android export preset: add one in Project → Export (Android) first.');
  }
  const found = await findGradleRoot(root);
  if (!found) {
    return { isAndroid: !!godot?.hasAndroidPreset, framework, gradleRoot: null, gradleRootRel: null, wrapper: null, modules: [], appModule: null, godot, notes };
  }
  const { base, settings } = found;
  const settingsText = settings ? await readText(settings) : '';
  const names = settings ? parseIncludes(settingsText) : [];
  const moduleDirs = names.length ? names.map((n) => ({ name: n, dir: path.join(base, ...n.split(':')) })) : [{ name: '', dir: base }];
  const modules = [];
  for (const m of moduleDirs) {
    let buildFile = null;
    let text = null;
    for (const f of BUILD_FILES) {
      text = await readText(path.join(m.dir, f));
      if (text != null) {
        buildFile = path.join(m.dir, f);
        break;
      }
    }
    if (text == null) continue;
    const info = parseModuleBuild(text);
    if (!info.isApp && !info.isLib) continue;
    modules.push({ name: m.name, gradlePath: m.name ? `:${m.name}` : '', dir: rel(root, m.dir), buildFile: rel(root, buildFile), ...info, applicationId: info.applicationId || (info.isApp ? info.namespace : null) });
  }
  const apps = modules.filter((m) => m.isApp);
  const appModule = apps.find((m) => m.name === 'app') || apps.find((m) => m.name === 'android') || apps[0] || null;
  const wrapperProps = await readText(path.join(base, 'gradle', 'wrapper', 'gradle-wrapper.properties'));
  const wrapperVersion = wrapperProps?.match(/gradle-(\d+(?:\.\d+)+)-(?:bin|all)\.zip/)?.[1] || null;
  const wrapper = {
    script: await exists(path.join(base, 'gradlew')),
    batch: await exists(path.join(base, 'gradlew.bat')),
    jar: await exists(path.join(base, 'gradle', 'wrapper', 'gradle-wrapper.jar')),
    properties: !!wrapperProps,
    version: wrapperVersion,
  };
  wrapper.complete = wrapper.jar && wrapper.properties && (process.platform === 'win32' ? wrapper.batch : wrapper.script);
  const rootBuild = (await readText(path.join(base, 'build.gradle.kts'))) ?? (await readText(path.join(base, 'build.gradle'))) ?? '';
  const catalog = (await readText(path.join(base, 'gradle', 'libs.versions.toml'))) || '';
  const agp = rootBuild.match(/com\.android\.(?:application|tools\.build:gradle)["']?\)?\s*(?:version\s*)?[:("']+\s*["']?(\d+\.\d+\.\d+)/)?.[1] || catalog.match(/^\s*agp\s*=\s*["'](\d+\.\d+\.\d+)["']/m)?.[1] || null;
  if (!appModule) notes.push('A Gradle project was found but no module applies the com.android.application plugin.');
  if (!wrapper.complete) notes.push(wrapper.properties ? 'The Gradle wrapper is incomplete (gradlew or gradle-wrapper.jar is missing); SleepPilot can recreate it.' : 'No Gradle wrapper: builds use the Gradle installation SleepPilot found, or you can add a wrapper.');
  const localProps = await readText(path.join(base, 'local.properties'));
  return {
    isAndroid: !!appModule,
    framework,
    gradleRoot: base,
    gradleRootRel: rel(root, base),
    settingsFile: settings ? rel(root, settings) : null,
    wrapper,
    agp,
    modules,
    appModule,
    sdkDirInLocalProperties: localProps?.match(/^\s*sdk\.dir\s*=\s*(.+)$/m)?.[1]?.replace(/\\\\/g, '\\').replace(/\\:/g, ':').trim() || null,
    godot,
    notes,
  };
}

/** Every APK/AAB under build output folders (and dist/), newest first. */
export async function findArtifacts(dir, { since = 0, limit = 40 } = {}) {
  const root = path.resolve(dir);
  const out = [];
  async function walk(current, depth, inOutputs) {
    if (depth > 9 || out.length >= 200) return;
    for (const e of await fsp.readdir(current, { withFileTypes: true }).catch(() => [])) {
      if (e.name.startsWith('.') || (IGNORED_DIRS.has(e.name) && e.name !== 'target') || e.name === 'node_modules' || e.name === 'intermediates' || e.name === 'tmp') continue;
      const full = path.join(current, e.name);
      if (e.isDirectory()) {
        await walk(full, depth + 1, inOutputs || e.name === 'outputs' || e.name === 'dist' || e.name === 'release' || e.name === 'flutter-apk');
      } else if (e.isFile() && /\.(apk|aab)$/i.test(e.name) && (inOutputs || depth <= 1)) {
        const st = await fsp.stat(full).catch(() => null);
        if (!st || st.mtimeMs < since) continue;
        const relPath = rel(root, full);
        const parts = relPath.split('/');
        const outputsAt = parts.lastIndexOf('outputs');
        out.push({
          file: full,
          path: relPath,
          name: e.name,
          kind: /\.aab$/i.test(e.name) ? 'aab' : 'apk',
          size: st.size,
          mtimeMs: st.mtimeMs,
          variant: outputsAt >= 0 && parts[outputsAt + 2] && parts[outputsAt + 2] !== e.name ? parts[outputsAt + 2] : /release/i.test(e.name) ? 'release' : /debug/i.test(e.name) ? 'debug' : null,
          unsigned: /unsigned/i.test(e.name),
        });
      }
    }
  }
  await walk(root, 0, false);
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit);
}

// ------------------------------------------------------------------ binary AndroidManifest.xml

const RES_STRING_POOL = 0x0001;
const RES_XML = 0x0003;
const RES_XML_START_ELEMENT = 0x0102;
const ANDROID_ATTR = { 0x0101021b: 'versionCode', 0x0101021c: 'versionName', 0x0101020c: 'minSdkVersion', 0x01010270: 'targetSdkVersion', 0x01010003: 'name', 0x01010001: 'label', 0x01010572: 'compileSdkVersion' };

function readStringPool(buf, start) {
  const headerSize = buf.readUInt16LE(start + 2);
  const count = buf.readUInt32LE(start + 8);
  const flags = buf.readUInt32LE(start + 16);
  const stringsStart = buf.readUInt32LE(start + 20);
  const utf8 = !!(flags & (1 << 8));
  const strings = [];
  for (let i = 0; i < Math.min(count, 50_000); i++) {
    const off = buf.readUInt32LE(start + headerSize + i * 4);
    let p = start + stringsStart + off;
    if (utf8) {
      let n = buf[p++];
      if (n & 0x80) p++;
      n = buf[p++];
      if (n & 0x80) n = ((n & 0x7f) << 8) | buf[p++];
      strings.push(buf.toString('utf8', p, p + n));
    } else {
      let n = buf.readUInt16LE(p);
      p += 2;
      if (n & 0x8000) {
        n = ((n & 0x7fff) << 16) | buf.readUInt16LE(p);
        p += 2;
      }
      strings.push(buf.toString('utf16le', p, p + n * 2));
    }
  }
  return strings;
}

/**
 * Read the compiled (binary XML) AndroidManifest.xml of an APK: package, version, SDK levels,
 * permissions and the launcher activity. Unknown structures are skipped, never guessed.
 */
export function parseBinaryManifest(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8 || buf.readUInt16LE(0) !== RES_XML) throw new Error('Not a compiled Android XML file.');
  let strings = [];
  let resourceIds = [];
  const result = { package: null, versionCode: null, versionName: null, minSdk: null, targetSdk: null, compileSdk: null, permissions: [], activities: [], launcher: null, label: null, debuggable: null };
  const stack = [];
  let pendingActivity = null;
  let p = buf.readUInt16LE(2);
  while (p + 8 <= buf.length) {
    const type = buf.readUInt16LE(p);
    const size = buf.readUInt32LE(p + 4);
    if (size < 8 || p + size > buf.length) break;
    if (type === RES_STRING_POOL) strings = readStringPool(buf, p);
    else if (type === 0x0180) {
      const headerSize = buf.readUInt16LE(p + 2);
      resourceIds = [];
      for (let q = p + headerSize; q + 4 <= p + size; q += 4) resourceIds.push(buf.readUInt32LE(q));
    } else if (type === RES_XML_START_ELEMENT) {
      const headerSize = buf.readUInt16LE(p + 2);
      const ext = p + headerSize;
      const tag = strings[buf.readUInt32LE(ext + 4)] || '';
      const attrStart = buf.readUInt16LE(ext + 8);
      const attrSize = buf.readUInt16LE(ext + 10);
      const attrCount = buf.readUInt16LE(ext + 12);
      const attrs = {};
      for (let i = 0; i < attrCount; i++) {
        const a = ext + attrStart + i * attrSize;
        const nameIndex = buf.readUInt32LE(a + 4);
        const name = ANDROID_ATTR[resourceIds[nameIndex]] || strings[nameIndex] || '';
        const raw = buf.readInt32LE(a + 8);
        const dataType = buf[a + 15];
        const data = buf.readUInt32LE(a + 16);
        let value;
        if (dataType === 0x03) value = strings[data] ?? null;
        else if (raw >= 0 && strings[raw] != null) value = strings[raw];
        else if (dataType === 0x10 || dataType === 0x11) value = data | 0;
        else if (dataType === 0x12) value = data !== 0;
        else if (dataType === 0x01) value = `@0x${data.toString(16)}`;
        else value = data;
        attrs[name] = value;
      }
      stack.push(tag);
      if (tag === 'manifest') {
        result.package = attrs.package ?? null;
        result.versionCode = attrs.versionCode != null ? Number(attrs.versionCode) : null;
        result.versionName = attrs.versionName != null ? String(attrs.versionName) : null;
        if (attrs.compileSdkVersion != null) result.compileSdk = Number(attrs.compileSdkVersion);
      } else if (tag === 'uses-sdk') {
        if (attrs.minSdkVersion != null) result.minSdk = Number(attrs.minSdkVersion);
        if (attrs.targetSdkVersion != null) result.targetSdk = Number(attrs.targetSdkVersion);
      } else if (tag === 'uses-permission' && attrs.name) result.permissions.push(String(attrs.name));
      else if (tag === 'application') {
        if (typeof attrs.label === 'string') result.label = attrs.label;
        if ('debuggable' in attrs) result.debuggable = !!attrs.debuggable;
      } else if ((tag === 'activity' || tag === 'activity-alias') && attrs.name) {
        pendingActivity = String(attrs.name);
        result.activities.push(pendingActivity);
      } else if (tag === 'category' && attrs.name === 'android.intent.category.LAUNCHER' && pendingActivity && !result.launcher) {
        result.launcher = pendingActivity;
      }
    } else if (type === 0x0103) {
      const tag = stack.pop();
      if (tag === 'activity' || tag === 'activity-alias') pendingActivity = null;
    }
    p += size;
  }
  if (result.launcher && result.package && result.launcher.startsWith('.')) result.launcher = result.package + result.launcher;
  return result;
}

/** Look inside an APK/AAB: size, ABIs, dex count, signature schemes, manifest. */
export async function inspectArtifact(file) {
  const st = await fsp.stat(file);
  const entries = await listZip(file);
  const names = entries.map((e) => e.name);
  const isAab = /\.aab$/i.test(file) || names.includes('BundleConfig.pb');
  const abis = [...new Set(names.map((n) => n.match(/^(?:base\/)?lib\/([^/]+)\//)?.[1]).filter(Boolean))];
  const v1 = names.some((n) => /^META-INF\/[^/]+\.(RSA|DSA|EC)$/i.test(n));
  let v2 = false;
  const cdOffset = entries.centralDirectoryOffset;
  if (cdOffset >= 32) {
    const tail = await readFileRange(file, cdOffset - 16, 16).catch(() => null);
    v2 = !!tail && tail.toString('latin1') === 'APK Sig Block 42';
  }
  let manifest = null;
  let manifestError = null;
  if (!isAab) {
    try {
      const data = await readZipEntry(file, 'AndroidManifest.xml');
      manifest = data ? parseBinaryManifest(data) : null;
      if (!data) manifestError = 'AndroidManifest.xml is missing.';
    } catch (err) {
      manifestError = err.message;
    }
  }
  return {
    file,
    name: path.basename(file),
    kind: isAab ? 'aab' : 'apk',
    size: st.size,
    mtimeMs: st.mtimeMs,
    entries: entries.length,
    dexFiles: names.filter((n) => /^(?:base\/dex\/)?classes\d*\.dex$/.test(n)).length,
    abis,
    assets: names.filter((n) => /^(?:base\/)?assets\//.test(n) && !n.endsWith('/')).length,
    signed: v1 || v2,
    signature: { v1, v2plus: v2 },
    manifest,
    manifestError,
    valid: isAab ? names.includes('base/manifest/AndroidManifest.xml') : !!manifest && names.some((n) => /^classes\d*\.dex$/.test(n)),
  };
}
