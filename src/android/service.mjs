import { EventEmitter } from 'node:events';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { isInside } from '../util/paths.mjs';
import { redact } from '../util/redact.mjs';
import { logger } from '../util/log.mjs';
import { ANDROID_DEFAULTS, cachedAndroidToolchain, invalidateAndroidToolchain } from './toolchain.mjs';
import { detectAndroidProject, findArtifacts, inspectArtifact } from './project.mjs';
import { addGradleWrapper, buildAndroid, createSigningKey, downloadGradle, exportArtifact, installApk, listDevices, recentDeviceErrors, signingStatus } from './build.mjs';

const log = logger('android');
const SECRET_PREFIX = 'android-signing:';

/**
 * Android features for the app and the UI: toolchain status, per-project builds (one at a time
 * per project, streamed to the UI), artifacts, release signing, devices and the Gradle download.
 * Events: 'update' { projectId, build } while a build runs, 'toolchain' after a change.
 */
export class AndroidService extends EventEmitter {
  constructor({ credentials, exportDirFor = () => null } = {}) {
    super();
    this.credentials = credentials;
    this.exportDirFor = exportDirFor;
    this.builds = new Map(); // projectId -> { build, result, promise, startedAt }
    this.history = new Map(); // projectId -> last results (newest first)
    this.download = null;
  }

  async toolchain({ force = false } = {}) {
    return cachedAndroidToolchain({ force });
  }

  buildView(projectId) {
    const rec = this.builds.get(projectId);
    if (!rec) return null;
    const b = rec.build;
    return {
      id: rec.id,
      variant: rec.variant,
      kind: rec.kind,
      state: rec.result?.state || b?.state || 'starting',
      running: !rec.result,
      task: rec.result?.task || b?.tasks?.[0] || null,
      currentTask: b?.currentTask || null,
      startedAt: rec.startedAt,
      endedAt: rec.result?.endedAt || null,
      durationMs: rec.result?.durationMs || null,
      ok: rec.result?.ok ?? null,
      artifacts: rec.result?.artifacts || [],
      exported: rec.exported || [],
      diagnosis: rec.result?.diagnosis || null,
      error: rec.error || null,
      log: (b?.lines || rec.result?.log || []).slice(-600),
    };
  }

  async signing(projectId) {
    const status = await signingStatus(projectId);
    return { ...status, passwordStored: !!this.credentials?.get(`${SECRET_PREFIX}${projectId}`) };
  }

  async signingConfig(projectId) {
    const status = await signingStatus(projectId);
    const password = this.credentials?.get(`${SECRET_PREFIX}${projectId}`);
    if (!status.exists || !password) return null;
    return { storeFile: status.storeFile, storePassword: password, keyAlias: status.keyAlias, keyPassword: password };
  }

  /** Everything the Android screen shows for one project. */
  async project(project) {
    const [info, toolchain, signing] = await Promise.all([detectAndroidProject(project.dir), this.toolchain(), this.signing(project.id)]);
    const artifacts = [];
    const roots = [project.dir];
    const exportDir = this.exportDirFor(project);
    for (const a of await findArtifacts(project.dir, { limit: 12 })) {
      artifacts.push({ ...a, source: 'build', file: undefined, details: await inspectArtifact(a.file).catch((err) => ({ error: err.message })) });
    }
    const exportsList = [];
    if (exportDir) {
      roots.push(exportDir);
      for (const e of await fsp.readdir(exportDir, { withFileTypes: true }).catch(() => [])) {
        if (!e.isFile() || !/\.(apk|aab)$/i.test(e.name)) continue;
        const full = path.join(exportDir, e.name);
        const st = await fsp.stat(full).catch(() => null);
        if (st) exportsList.push({ name: e.name, path: full, kind: /\.aab$/i.test(e.name) ? 'aab' : 'apk', size: st.size, mtimeMs: st.mtimeMs, source: 'export' });
      }
      exportsList.sort((a, b) => b.mtimeMs - a.mtimeMs);
    }
    return {
      projectId: project.id,
      info,
      toolchain: summarizeToolchain(toolchain),
      signing,
      artifacts,
      exports: exportsList.slice(0, 30),
      exportDir,
      build: this.buildView(project.id),
      history: (this.history.get(project.id) || []).slice(0, 10),
      defaults: ANDROID_DEFAULTS,
    };
  }

  /** Start a build and return at once; progress arrives as 'update' events. */
  async startBuild(project, { variant = 'debug', kind = 'apk', module = null } = {}) {
    const running = this.builds.get(project.id);
    if (running && !running.result) throw new Error('A build is already running for this project.');
    if (!['debug', 'release'].includes(variant)) throw new Error('variant must be "debug" or "release".');
    if (!['apk', 'aab'].includes(kind)) throw new Error('kind must be "apk" or "aab".');
    const rec = { id: `b_${Date.now().toString(36)}`, variant, kind, startedAt: Date.now(), build: null, result: null, exported: [] };
    this.builds.set(project.id, rec);
    const emit = () => this.emit('update', { projectId: project.id, build: this.buildView(project.id) });
    let timer = null;
    const throttled = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        emit();
      }, 400);
      timer.unref?.();
    };
    rec.promise = (async () => {
      try {
        const toolchain = await this.toolchain();
        const signing = variant === 'release' ? await this.signingConfig(project.id) : null;
        const { result } = await buildAndroid({ projectDir: project.dir, toolchain, variant, kind, module, signing, id: rec.id, onStart: (b) => ((rec.build = b), emit()), onLine: throttled });
        rec.result = result;
        const exportDir = this.exportDirFor(project);
        if (result.ok && exportDir) {
          for (const a of result.artifacts.slice(0, 3)) {
            const target = await exportArtifact(a, exportDir, { projectName: project.name }).catch((err) => (log.warn(`export failed: ${err.message}`), null));
            if (target) rec.exported.push(target);
          }
        }
      } catch (err) {
        rec.error = redact(err.message);
        rec.result = { state: 'failed', ok: false, endedAt: Date.now(), durationMs: Date.now() - rec.startedAt, artifacts: [], diagnosis: { summary: rec.error, hints: [] }, log: rec.build?.lines || [] };
      } finally {
        clearTimeout(timer);
        const list = this.history.get(project.id) || [];
        list.unshift({ id: rec.id, variant, kind, state: rec.result.state, ok: rec.result.ok, startedAt: rec.startedAt, durationMs: rec.result.durationMs, artifacts: (rec.result.artifacts || []).map((a) => ({ name: a.name, path: a.path, size: a.size })), exported: rec.exported, summary: rec.result.diagnosis?.summary || null });
        this.history.set(project.id, list.slice(0, 20));
        emit();
      }
      return this.buildView(project.id);
    })();
    emit();
    return this.buildView(project.id);
  }

  async waitForBuild(projectId) {
    return this.builds.get(projectId)?.promise || null;
  }

  cancelBuild(projectId) {
    const rec = this.builds.get(projectId);
    return { cancelled: !!rec?.build?.cancel() };
  }

  async createSigningKey(project, { commonName, organization, country } = {}) {
    const toolchain = await this.toolchain();
    const { password, status } = await createSigningKey({ projectId: project.id, toolchain, commonName: commonName || project.name, organization, country });
    await this.credentials.set(`${SECRET_PREFIX}${project.id}`, password);
    return { ...status, passwordStored: true };
  }

  async devices() {
    return listDevices(await this.toolchain());
  }

  /** A file the UI may install or download: only APK/AABs inside the project or its exports folder. */
  async resolveArtifact(project, file) {
    const raw = String(file || '');
    if (!/\.(apk|aab)$/i.test(raw)) throw new Error('Only .apk and .aab files can be used here.');
    const candidates = path.isAbsolute(raw) ? [raw] : [path.join(project.dir, ...raw.split('/'))];
    const exportDir = this.exportDirFor(project);
    if (!path.isAbsolute(raw) && exportDir) candidates.push(path.join(exportDir, path.basename(raw)));
    for (const c of candidates) {
      const full = path.resolve(c);
      if (!isInside(project.dir, full) && !(exportDir && isInside(exportDir, full))) continue;
      if ((await fsp.stat(full).catch(() => null))?.isFile()) return full;
    }
    throw new Error('That file was not found in this project or its exports folder.');
  }

  async install(project, { serial, file, launch = true } = {}) {
    const full = await this.resolveArtifact(project, file);
    if (!/\.apk$/i.test(full)) throw new Error('Only an APK can be installed on a device (an AAB is for Google Play).');
    const details = await inspectArtifact(full).catch(() => null);
    const toolchain = await this.toolchain();
    try {
      return { ...(await installApk({ toolchain, serial, apk: full, launch, packageName: details?.manifest?.package || null })), packageName: details?.manifest?.package || null };
    } catch (err) {
      return { ok: false, error: err.message, hint: err.hint || null };
    }
  }

  async deviceErrors(project, { serial } = {}) {
    const info = await detectAndroidProject(project.dir);
    return recentDeviceErrors({ toolchain: await this.toolchain(), serial, packageName: info.appModule?.applicationId || null });
  }

  async addWrapper(project) {
    const info = await detectAndroidProject(project.dir);
    if (!info.gradleRoot) throw new Error('No Android Gradle project was found in this folder.');
    const result = await addGradleWrapper({ gradleRoot: info.gradleRoot, toolchain: await this.toolchain() });
    this.emit('toolchain', { projectChanged: project.id });
    return result;
  }

  downloadView() {
    return this.download ? { ...this.download } : null;
  }

  /** Download Gradle once, in the background; progress is broadcast as 'toolchain' events. */
  startGradleDownload({ version = ANDROID_DEFAULTS.gradle } = {}) {
    if (this.download?.state === 'running') return this.downloadView();
    this.download = { state: 'running', version, received: 0, total: null, startedAt: Date.now() };
    let last = 0;
    downloadGradle({
      version,
      onProgress: ({ received, total }) => {
        this.download.received = received;
        this.download.total = total;
        if (Date.now() - last > 500) {
          last = Date.now();
          this.emit('toolchain', { download: this.downloadView() });
        }
      },
    })
      .then((r) => {
        this.download = { ...this.download, state: 'done', path: r.path, endedAt: Date.now() };
        invalidateAndroidToolchain();
      })
      .catch((err) => {
        // Behind a company proxy the download can fail; the manual route always works.
        const manual = ` If this computer uses a proxy, download gradle-${version}-bin.zip from https://gradle.org/releases/, unzip it and set bin/gradle(.bat) as the Gradle executable under Settings → Android.`;
        this.download = { ...this.download, state: 'failed', error: redact(err.message) + manual, endedAt: Date.now() };
      })
      .finally(() => this.emit('toolchain', { download: this.downloadView() }));
    return this.downloadView();
  }

  async cancelAll() {
    for (const rec of this.builds.values()) rec.build?.cancel();
  }
}

/** The toolchain without long lists, for the UI. */
export function summarizeToolchain(t) {
  if (!t) return null;
  return {
    ready: t.ready,
    jdk: { found: t.jdk.found, ok: t.jdk.ok, home: t.jdk.home, version: t.jdk.version, major: t.jdk.major, source: t.jdk.source, others: t.jdk.all.length - (t.jdk.found ? 1 : 0) },
    sdk: { found: t.sdk.found, dir: t.sdk.dir, source: t.sdk.source, platforms: t.sdk.platforms, highestApi: t.sdk.highestApi, buildTools: t.sdk.buildTools.slice(-3), adb: t.sdk.adb, sdkmanager: t.sdk.sdkmanager, licensesAccepted: t.sdk.licensesAccepted, emulator: t.sdk.emulator },
    gradle: { found: t.gradle.found, path: t.gradle.path, version: t.gradle.version, source: t.gradle.source, managed: t.gradle.managed },
    studio: t.studio,
    problems: t.problems,
    checkedAt: t.checkedAt,
  };
}
