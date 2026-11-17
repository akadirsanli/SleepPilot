// Workspace layout, live preview server, ZIP reader, Android project/APK inspection, templates,
// toolchain detection and the Gradle build runner (with a fake Gradle wrapper — no SDK needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { writeZip, makeZip, fakeApk } from '../fixtures/zip-writer.mjs';

process.env.SLEEPPILOT_QUIET = '1';
process.env.SLEEPPILOT_HOME ||= fs.mkdtempSync(path.join(os.tmpdir(), 'sp-wb-home-'));
const HERE = path.dirname(fileURLToPath(import.meta.url));
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `sp-wb-${name}-`));
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

function get(url, { headers = {}, method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

// ------------------------------------------------------------------ workspace

test('workspace: folder names are safe for build tools', async () => {
  const { projectFolderName } = await import('../../src/workspace/workspace.mjs');
  assert.equal(projectFolderName('Yarış Oyunu 3D!'), 'yaris-oyunu-3d');
  assert.equal(projectFolderName('Çiğ Köfte Şöleni'), 'cig-kofte-soleni');
  assert.equal(projectFolderName('   '), 'project');
  assert.equal(projectFolderName('CON'), 'con-project');
  assert.match(projectFolderName('x'.repeat(200)), /^x{48}$/);
});

test('workspace: layout is created once, never overwritten, and lists project folders', async () => {
  const { initWorkspace, newProjectDir, workspaceView, validateWorkspaceDir, WORKSPACE_MARKER } = await import('../../src/workspace/workspace.mjs');
  const { dataRoot } = await import('../../src/util/paths.mjs');
  const root = path.join(tmp('ws'), 'SleepPilot');
  await initWorkspace(root);
  for (const f of ['projects', 'exports', 'README.md', WORKSPACE_MARKER]) assert.ok(fs.existsSync(path.join(root, f)), f);
  fs.writeFileSync(path.join(root, 'README.md'), 'mine');
  await initWorkspace(root);
  assert.equal(fs.readFileSync(path.join(root, 'README.md'), 'utf8'), 'mine');

  const first = await newProjectDir(root, 'Racing Game');
  assert.equal(path.basename(first), 'racing-game');
  fs.mkdirSync(first);
  assert.equal(path.basename(await newProjectDir(root, 'Racing Game')), 'racing-game-2');

  const view = await workspaceView(root, { projects: [{ id: 'p1', name: 'Racing', dir: first, updatedAt: 5 }, { id: 'p2', name: 'Elsewhere', dir: tmp('other') }] });
  assert.equal(view.configured, true);
  assert.equal(view.folders.length, 1);
  assert.equal(view.folders[0].projectId, 'p1');
  assert.equal(view.outside, 1);
  assert.equal((await workspaceView(null)).configured, false);

  assert.throws(() => validateWorkspaceDir('relative/path'), /absolute/);
  assert.throws(() => validateWorkspaceDir(path.parse(root).root), /drive root/);
  assert.throws(() => validateWorkspaceDir(path.join(dataRoot(), 'ws')), /data folder/);
});

// ------------------------------------------------------------------ preview

test('preview: detection finds the page folder and dev-server scripts', async () => {
  const { detectPreview, effectivePreview, sanitizePreviewConfig, cleanRelative } = await import('../../src/preview/preview.mjs');
  const a = tmp('pv-static');
  write(path.join(a, 'public', 'index.html'), '<h1>x</h1>');
  write(path.join(a, 'public', 'about.html'), '<h1>about</h1>');
  let d = await detectPreview(a);
  assert.equal(d.recommended, 'static');
  assert.equal(d.root, 'public');
  assert.equal(d.entry, 'index.html');

  const b = tmp('pv-vite');
  write(path.join(b, 'index.html'), '<div id=app></div>');
  write(path.join(b, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' }, devDependencies: { vite: '^5' } }));
  d = await detectPreview(b);
  assert.equal(d.recommended, 'command');
  assert.equal(d.commands[0].command, 'npm run dev');
  assert.equal(effectivePreview({}, d).mode, 'command');
  assert.equal(effectivePreview({ mode: 'static' }, d).mode, 'static');

  const c = tmp('pv-none');
  assert.equal((await detectPreview(c)).recommended, 'none');

  assert.equal(cleanRelative('../etc'), '');
  assert.equal(cleanRelative('C:\\x'), '');
  assert.equal(cleanRelative('web\\pages\\'), 'web/pages');
  const cfg = sanitizePreviewConfig({ mode: 'bogus', url: 'http://example.com:80/', command: 'npm run dev', commandApproved: 'yes' });
  assert.equal(cfg.mode, 'auto');
  assert.equal(cfg.url, '', 'only local dev-server URLs are accepted');
  assert.equal(cfg.commandApproved, false);
  assert.equal(sanitizePreviewConfig({ url: 'http://localhost:5173/' }).url, 'http://localhost:5173/');
});

test('preview: static server serves the project read-only with live reload and error reporting', async () => {
  const { StaticPreview, injectClient } = await import('../../src/preview/preview.mjs');
  const dir = tmp('pv-serve');
  write(path.join(dir, 'index.html'), '<!doctype html><html><head><title>t</title></head><body>hello</body></html>');
  write(path.join(dir, 'app.js'), 'console.log(1)');
  write(path.join(dir, 'audio', 'track.ogg'), Buffer.alloc(1000, 7));
  write(path.join(dir, '.env'), 'SECRET=1');
  write(path.join(dir, 'empty', 'note.txt'), 'n');
  const p = await new StaticPreview({ dir }).start(0);
  try {
    const base = `http://127.0.0.1:${p.port}`;
    let r = await get(`${base}/`);
    assert.equal(r.status, 200);
    assert.match(r.body, /hello/);
    assert.match(r.body, /<script src="\/__sleeppilot\/client\.js"><\/script><\/head>/);
    r = await get(`${base}/app.js`);
    assert.equal(r.headers['content-type'], 'text/javascript; charset=utf-8');
    assert.equal(r.body, 'console.log(1)');
    assert.equal((await get(`${base}/.env`)).status, 403);
    // "%2e%2e" is resolved by the URL parser itself (stays inside); an encoded slash is not.
    assert.notEqual((await get(`${base}/%2e%2e/%2e%2e/etc/passwd`)).status, 200);
    assert.equal((await get(`${base}/..%2f..%2fetc%2fpasswd`)).status, 403);
    assert.equal((await get(`${base}/sub%2f..%2f..%2f.env`)).status, 403);
    assert.equal((await get(`${base}/app.js`, { headers: { host: 'evil.example:80' } })).status, 421);
    assert.equal((await get(`${base}/app.js`, { method: 'POST' })).status, 405);
    r = await get(`${base}/audio/track.ogg`, { headers: { range: 'bytes=10-19' } });
    assert.equal(r.status, 206);
    assert.equal(r.headers['content-range'], 'bytes 10-19/1000');
    r = await get(`${base}/empty/`);
    assert.match(r.body, /note\.txt/);
    r = await get(`${base}/missing.html`);
    assert.equal(r.status, 404);
    assert.match(r.body, /client\.js/, 'the 404 page reloads itself when the file appears');
    assert.match((await get(`${base}/__sleeppilot/client.js`)).body, /sleeppilot-preview/);

    // Live reload: a connected page gets a change event.
    const events = [];
    const sse = http.get(`${base}/__sleeppilot/live`, (res) => res.on('data', (c) => events.push(String(c))));
    await new Promise((r2) => setTimeout(r2, 150));
    p.notifyChange('style.css');
    await new Promise((r2) => setTimeout(r2, 500));
    sse.destroy();
    assert.ok(events.join('').includes('"file":"style.css"'), events.join(''));
    assert.equal(p.view().changes, 1);
  } finally {
    await p.stop();
  }
  assert.equal(injectClient('<p>no head</p>'), '<p>no head</p><script src="/__sleeppilot/client.js"></script>');
});

test('preview: a dev-server command is started and its URL is read from the output', async () => {
  const { CommandPreview, findLocalUrl, PreviewManager } = await import('../../src/preview/preview.mjs');
  assert.equal(findLocalUrl('\x1b[32m  ➜  Local:   http://localhost:5173/\x1b[0m'), 'http://localhost:5173/');
  assert.equal(findLocalUrl('Listening on http://0.0.0.0:3000.'), 'http://localhost:3000');
  assert.equal(findLocalUrl('no url'), null);
  const dir = tmp('pv-cmd');
  write(path.join(dir, 'server.js'), "console.log('ready at http://127.0.0.1:43219/app'); setInterval(() => {}, 1000);");
  const p = new CommandPreview({ dir, command: `"${process.execPath}" server.js` });
  await p.start();
  try {
    for (let i = 0; i < 50 && !p.url; i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(p.url, 'http://127.0.0.1:43219/app');
    assert.equal(p.view().state, 'running');
  } finally {
    await p.stop();
  }
  // The manager refuses an unapproved command.
  const m = new PreviewManager();
  await assert.rejects(() => m.start({ id: 'x', dir }, { mode: 'command', command: 'npm run dev', commandApproved: false }), /Approve/);
  await assert.rejects(() => m.start({ id: 'x', dir }, { mode: 'none' }), /Nothing to preview/);
});

// ------------------------------------------------------------------ zip

test('zip: lists, reads and extracts stored and deflated entries; rejects unsafe paths', async () => {
  const { listZip, readZipEntry, extractZip } = await import('../../src/util/zip.mjs');
  const dir = tmp('zip');
  const file = path.join(dir, 'a.zip');
  writeZip(file, [
    { name: 'gradle-9.9/', data: '' },
    { name: 'gradle-9.9/bin/gradle', data: '#!/bin/sh\necho hi\n', mode: 0o755 },
    { name: 'gradle-9.9/lib/big.txt', data: 'x'.repeat(50_000), deflate: true },
  ]);
  const entries = await listZip(file);
  assert.equal(entries.length, 3);
  assert.equal(entries[1].mode, 0o755);
  assert.equal((await readZipEntry(file, 'gradle-9.9/lib/big.txt')).length, 50_000);
  assert.equal(await readZipEntry(file, 'nope'), null);
  const out = path.join(dir, 'out');
  const r = await extractZip(file, out, { strip: 1 });
  assert.equal(r.files, 2);
  assert.equal(fs.readFileSync(path.join(out, 'lib', 'big.txt'), 'utf8').length, 50_000);
  if (process.platform !== 'win32') assert.ok(fs.statSync(path.join(out, 'bin', 'gradle')).mode & 0o100);

  const evil = path.join(dir, 'evil.zip');
  writeZip(evil, [{ name: '../escape.txt', data: 'x' }]);
  await assert.rejects(() => extractZip(evil, path.join(dir, 'out2')), /Unsafe path/);
  assert.equal(fs.existsSync(path.join(dir, 'escape.txt')), false);
  fs.writeFileSync(path.join(dir, 'not.zip'), 'hello');
  await assert.rejects(() => listZip(path.join(dir, 'not.zip')), /Not a ZIP/);
});

// ------------------------------------------------------------------ android: project + APK

test('android: Gradle files are parsed (Groovy and Kotlin DSL)', async () => {
  const { parseIncludes, parseModuleBuild } = await import('../../src/android/project.mjs');
  assert.deepEqual(parseIncludes("include ':app', ':wear'\n// include ':old'\ninclude(\":core\")"), ['app', 'wear', 'core']);
  const kts = parseModuleBuild(`plugins { id("com.android.application"); kotlin("android") }
android { namespace = "com.x.y"; compileSdk = 34
  defaultConfig { applicationId = "com.x.y.app"; minSdk = 24; targetSdk = 34; versionCode = 7; versionName = "2.0.1" }
  buildFeatures { compose = true } }`);
  assert.equal(kts.isApp, true);
  assert.equal(kts.applicationId, 'com.x.y.app');
  assert.equal(kts.versionCode, 7);
  assert.equal(kts.versionName, '2.0.1');
  assert.equal(kts.minSdk, 24);
  assert.equal(kts.compileSdk, 34);
  assert.equal(kts.kotlin, true);
  assert.equal(kts.compose, true);
  const groovy = parseModuleBuild("apply plugin: 'com.android.library'\nandroid { compileSdkVersion 33\n defaultConfig { minSdkVersion 21 } }");
  assert.equal(groovy.isApp, false);
  assert.equal(groovy.isLib, true);
  assert.equal(groovy.minSdk, 21);
});

test('android: every template scaffolds a detectable project and never overwrites files', async () => {
  const { scaffoldTemplate, defaultApplicationId, validateApplicationId, assembleTask } = await import('../../src/android/templates.mjs');
  const { detectAndroidProject } = await import('../../src/android/project.mjs');
  const { detectPreview } = await import('../../src/preview/preview.mjs');
  assert.equal(defaultApplicationId('Yarış Oyunu 3D'), 'com.sleeppilot.yarisoyunu3d');
  assert.equal(defaultApplicationId('3D Racer'), 'com.sleeppilot.app3dracer');
  assert.equal(defaultApplicationId('class'), 'com.sleeppilot.classapp');
  assert.throws(() => validateApplicationId('noDots'), /not a valid/);
  assert.throws(() => validateApplicationId('com.class.x'), /not a valid/);
  assert.throws(() => validateApplicationId('com.1x.y'), /not a valid/);
  assert.equal(validateApplicationId('com.example.my_game'), 'com.example.my_game');
  assert.equal(assembleTask('app'), ':app:assembleDebug');
  assert.equal(assembleTask('', 'release', 'aab'), 'bundleRelease');

  const expected = { 'android-kotlin': ['app', 'MainActivity.kt'], 'android-webview': ['app', 'MainActivity.java'], 'android-libgdx': ['android', 'AndroidLauncher.java'] };
  for (const [id, [module, source]] of Object.entries(expected)) {
    const dir = tmp(id);
    const r = await scaffoldTemplate(dir, id, { name: 'Yarış Oyunu', applicationId: 'com.example.racer' });
    assert.equal(r.kind, 'android');
    assert.equal(r.module, module);
    assert.equal(r.checks[0].type, 'android-build');
    assert.ok(r.written.some((f) => f.endsWith(source)), `${id}: ${source}`);
    for (const f of ['AGENTS.md', 'README.md', '.gitignore', 'gradle/wrapper/gradle-wrapper.properties', 'settings.gradle']) assert.ok(fs.existsSync(path.join(dir, f)), `${id}: ${f}`);
    assert.match(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), /\*\.jks/);
    const info = await detectAndroidProject(dir);
    assert.equal(info.isAndroid, true, id);
    assert.equal(info.appModule.name, module);
    assert.equal(info.appModule.applicationId, 'com.example.racer');
    assert.equal(info.appModule.minSdk, 24);
    assert.equal(info.wrapper.complete, false, 'no wrapper jar is ever faked');
    assert.equal(info.wrapper.version, '8.9');
    assert.equal(info.agp, '8.5.2');
    // App name with a Turkish character survives in strings.xml.
    const strings = fs.readdirSync(dir, { recursive: true }).find((f) => String(f).replace(/\\/g, '/').endsWith('values/strings.xml'));
    assert.match(fs.readFileSync(path.join(dir, strings), 'utf8'), /Yarış Oyunu/);
    // Applying the template again adds nothing and changes nothing.
    fs.writeFileSync(path.join(dir, 'README.md'), 'mine');
    const again = await scaffoldTemplate(dir, id, { name: 'Other', applicationId: 'com.example.racer' });
    assert.equal(again.written.length, 0);
    assert.equal(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), 'mine');
    if (id === 'android-webview') {
      assert.equal(r.preview.root, 'web');
      const d = await detectPreview(path.join(dir, 'web'));
      assert.equal(d.recommended, 'static');
      assert.ok(r.checks.some((c) => c.type === 'html-smoke'));
    }
  }
  const web = tmp('web');
  const w = await scaffoldTemplate(web, 'web', { name: 'Site' });
  assert.equal(w.kind, 'web');
  assert.equal(w.checks[0].type, 'html-smoke');
  assert.ok(fs.existsSync(path.join(web, 'index.html')));
  await assert.rejects(() => scaffoldTemplate(tmp('bad'), 'android-kotlin', { applicationId: 'bad' }), /not a valid/);
});

test('android: framework layouts in a sub-folder are found', async () => {
  const { detectAndroidProject } = await import('../../src/android/project.mjs');
  const dir = tmp('rn');
  write(path.join(dir, 'package.json'), '{}');
  write(path.join(dir, 'app.json'), '{}');
  write(path.join(dir, 'android', 'settings.gradle'), "include ':app'");
  write(path.join(dir, 'android', 'app', 'build.gradle'), "apply plugin: 'com.android.application'\nandroid { defaultConfig { applicationId 'com.rn.app' } }");
  const info = await detectAndroidProject(dir);
  assert.equal(info.framework.id, 'react-native');
  assert.equal(info.gradleRootRel, 'android');
  assert.equal(info.appModule.applicationId, 'com.rn.app');
  const godot = tmp('godot');
  write(path.join(godot, 'project.godot'), '[application]');
  write(path.join(godot, 'export_presets.cfg'), '[preset.0]\nname="Android"\nplatform="Android"\n');
  const g = await detectAndroidProject(godot);
  assert.equal(g.isAndroid, true);
  assert.deepEqual(g.godot.presets, ['Android']);
  assert.equal((await detectAndroidProject(tmp('empty'))).isAndroid, false);
});

test('android: APK inspection reads the compiled manifest, ABIs and signature scheme', async () => {
  const { inspectArtifact, findArtifacts, parseBinaryManifest } = await import('../../src/android/project.mjs');
  const dir = tmp('apk');
  const apk = path.join(dir, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
  fs.mkdirSync(path.dirname(apk), { recursive: true });
  fs.writeFileSync(apk, fakeApk({ pkg: 'com.example.racer', versionCode: 12, versionName: '1.4.0', abis: ['arm64-v8a', 'x86_64'] }));
  const unsigned = path.join(dir, 'app', 'build', 'outputs', 'apk', 'release', 'app-release-unsigned.apk');
  fs.mkdirSync(path.dirname(unsigned), { recursive: true });
  fs.writeFileSync(unsigned, fakeApk({ signed: false }));
  const info = await inspectArtifact(apk);
  assert.equal(info.valid, true);
  assert.equal(info.manifest.package, 'com.example.racer');
  assert.equal(info.manifest.versionCode, 12);
  assert.equal(info.manifest.versionName, '1.4.0');
  assert.equal(info.manifest.minSdk, 24);
  assert.equal(info.manifest.targetSdk, 34);
  assert.equal(info.manifest.launcher, 'com.example.racer.MainActivity');
  assert.deepEqual(info.manifest.permissions, ['android.permission.INTERNET']);
  assert.deepEqual(info.abis.sort(), ['arm64-v8a', 'x86_64']);
  assert.equal(info.signature.v2plus, true);
  assert.equal(info.dexFiles, 1);
  assert.equal((await inspectArtifact(unsigned)).signed, false);
  const found = await findArtifacts(dir);
  assert.equal(found.length, 2);
  assert.deepEqual(found.map((f) => f.variant).sort(), ['debug', 'release']);
  assert.equal(found.find((f) => f.variant === 'release').unsigned, true);
  assert.throws(() => parseBinaryManifest(Buffer.from('<manifest/>')), /compiled Android XML/);
});

// ------------------------------------------------------------------ android: toolchain

function fakeJdk(root, version = '17.0.9') {
  const exe = (n) => (process.platform === 'win32' ? `${n}.exe` : n);
  for (const b of ['java', 'javac', 'keytool']) write(path.join(root, 'bin', exe(b)), '');
  write(path.join(root, 'release'), `JAVA_VERSION="${version}"\n`);
  return root;
}

function fakeSdk(root, { platform = 34, licences = true, adb = true } = {}) {
  fs.mkdirSync(path.join(root, 'platforms', `android-${platform}`), { recursive: true });
  fs.mkdirSync(path.join(root, 'build-tools', '34.0.0'), { recursive: true });
  if (adb) write(path.join(root, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb'), '');
  if (licences) write(path.join(root, 'licenses', 'android-sdk-license'), 'x');
  return root;
}

test('android: toolchain detection finds a JDK and SDK and explains what is missing', async () => {
  const { detectAndroidToolchain, javaMajor, androidProcessEnv } = await import('../../src/android/toolchain.mjs');
  assert.equal(javaMajor('1.8.0_392'), 8);
  assert.equal(javaMajor('17.0.9'), 17);
  assert.equal(javaMajor('21'), 21);
  const home = tmp('home');
  const jdk = fakeJdk(path.join(tmp('jdk'), 'jdk-17'));
  const sdk = fakeSdk(path.join(tmp('sdk'), 'Sdk'));
  const ok = await detectAndroidToolchain({ settings: { jdkHome: jdk, sdkDir: sdk }, env: { PATH: '' }, home, allowRun: false, scan: false });
  assert.equal(ok.ready, true, JSON.stringify(ok.problems));
  assert.equal(ok.jdk.major, 17);
  assert.equal(ok.jdk.source, 'SleepPilot setting');
  assert.deepEqual(ok.sdk.platforms, ['android-34']);
  assert.equal(ok.sdk.highestApi, 34);
  assert.equal(ok.sdk.licensesAccepted, true);
  assert.ok(ok.sdk.adb);
  assert.equal(ok.env.JAVA_HOME, jdk);
  assert.equal(ok.env.ANDROID_HOME, sdk);
  const env = androidProcessEnv(ok, { PATH: '/usr/bin' });
  assert.ok(env.PATH.startsWith(path.join(jdk, 'bin')));
  assert.equal(env.JAVA_HOME, jdk);

  // JAVA_HOME pointing to Java 11, no SDK, no licences.
  const old = fakeJdk(path.join(tmp('jdk11'), 'jdk-11'), '11.0.2');
  const bad = await detectAndroidToolchain({ settings: {}, env: { JAVA_HOME: old, PATH: '' }, home, allowRun: false, scan: false });
  assert.equal(bad.ready, false);
  assert.equal(bad.jdk.found, true);
  assert.equal(bad.jdk.ok, false);
  const ids = bad.problems.map((p) => p.id);
  assert.ok(ids.includes('jdk-old'));
  assert.ok(ids.includes('sdk-missing'));
  assert.ok(ids.includes('gradle-missing'));

  // ANDROID_HOME without a platform: tells the user exactly what to install.
  const empty = fakeSdk(path.join(tmp('sdk2'), 'Sdk'), { licences: false });
  fs.rmSync(path.join(empty, 'platforms'), { recursive: true });
  const partial = await detectAndroidToolchain({ settings: { jdkHome: jdk }, env: { ANDROID_HOME: empty, PATH: '' }, home, allowRun: false, scan: false });
  assert.ok(partial.problems.some((p) => p.id === 'sdk-platform' && /Platform 34/.test(p.fix)));
  assert.ok(partial.problems.some((p) => p.id === 'sdk-licenses'));
});

// ------------------------------------------------------------------ android: build

/** A Gradle wrapper stand-in: writes an APK where AGP would and prints Gradle-like output. */
function fakeWrapper(dir, { fail = false } = {}) {
  const script = path.join(dir, 'fake-gradle.mjs');
  fs.writeFileSync(script, `
import fs from 'node:fs';
import path from 'node:path';
import { fakeApk } from ${JSON.stringify(new URL('../fixtures/zip-writer.mjs', import.meta.url).href)};
const tasks = process.argv.slice(2).filter((a) => /^(:|assemble|bundle)/.test(a));
fs.writeFileSync(path.join(process.cwd(), 'gradle-call.json'), JSON.stringify({ tasks, args: process.argv.slice(2), javaHome: process.env.JAVA_HOME || null, androidHome: process.env.ANDROID_HOME || null, storePassword: process.env['ORG_GRADLE_PROJECT_android.injected.signing.store.password'] || null }));
console.log('> Task :app:preBuild UP-TO-DATE');
console.log('> Task :app:compileDebugKotlin');
${fail ? "console.log('\\nFAILURE: Build failed with an exception.\\n\\n* What went wrong:\\nExecution failed for task \\':app:compileDebugKotlin\\'.\\n> Compilation error. See log for more details\\n\\n* Try:\\n> Run with --info');\nprocess.exit(1);" : `
const variant = tasks[0].includes('Release') ? 'release' : 'debug';
const out = path.join(process.cwd(), 'app', 'build', 'outputs', 'apk', variant);
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'app-' + variant + '.apk'), fakeApk({ pkg: 'com.example.racer', versionName: '1.0' }));
console.log('BUILD SUCCESSFUL in 1s');`}
`);
  write(path.join(dir, 'gradlew'), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  write(path.join(dir, 'gradlew.bat'), `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  write(path.join(dir, 'gradle', 'wrapper', 'gradle-wrapper.jar'), 'jar');
}

async function androidFixture({ fail = false } = {}) {
  const { scaffoldTemplate } = await import('../../src/android/templates.mjs');
  const dir = tmp('build');
  await scaffoldTemplate(dir, 'android-kotlin', { name: 'Racer', applicationId: 'com.example.racer' });
  fakeWrapper(dir, { fail });
  const jdk = fakeJdk(path.join(tmp('jdk'), 'jdk-17'));
  if (process.platform !== 'win32') {
    // On macOS/Linux the wrapper jar is started with the JDK's java: a stand-in for it.
    const java = path.join(jdk, 'bin', 'java');
    // A Node script, not a shell script: sh would drop the dotted ORG_GRADLE_PROJECT_* variables.
    fs.writeFileSync(java, `#!${process.execPath}\nimport(${JSON.stringify(new URL(`file://${path.join(dir, 'fake-gradle.mjs')}`).href)});\n`);
    fs.chmodSync(java, 0o755);
  }
  const sdk = fakeSdk(path.join(tmp('sdk'), 'Sdk'));
  const { detectAndroidToolchain } = await import('../../src/android/toolchain.mjs');
  const toolchain = await detectAndroidToolchain({ settings: { jdkHome: jdk, sdkDir: sdk }, env: { PATH: process.env.PATH }, home: tmp('home'), allowRun: false, scan: false });
  return { dir, jdk, sdk, toolchain };
}

test('android: a build runs the wrapper with JAVA_HOME/ANDROID_HOME and inspects the APK', async () => {
  const { buildAndroid, exportArtifact, resolveGradle } = await import('../../src/android/build.mjs');
  const { dir, jdk, sdk, toolchain } = await androidFixture();
  assert.equal((await resolveGradle(dir, toolchain)).source, 'wrapper');
  const lines = [];
  const { result } = await buildAndroid({ projectDir: dir, toolchain, onLine: (l) => lines.push(l) });
  assert.equal(result.ok, true, result.log.join('\n'));
  assert.equal(result.task, ':app:assembleDebug');
  assert.equal(result.artifacts.length, 1);
  assert.equal(result.artifacts[0].path, 'app/build/outputs/apk/debug/app-debug.apk');
  assert.equal(result.artifacts[0].details.manifest.package, 'com.example.racer');
  assert.ok(lines.some((l) => l.includes('compileDebugKotlin')));
  const call = JSON.parse(fs.readFileSync(path.join(dir, 'gradle-call.json'), 'utf8'));
  assert.deepEqual(call.tasks, [':app:assembleDebug']);
  assert.ok(call.args.includes('--console=plain'));
  assert.equal(call.javaHome, jdk);
  assert.equal(call.androidHome, sdk);
  // local.properties written with the SDK path (escaped for Java properties).
  assert.match(fs.readFileSync(path.join(dir, 'local.properties'), 'utf8'), /^sdk\.dir=/m);

  const exportDir = path.join(tmp('exports'), 'racer');
  const target = await exportArtifact(result.artifacts[0], exportDir, { projectName: 'Racer Game' });
  assert.equal(path.basename(target), 'Racer-Game-1.0-debug.apk');
  assert.ok(fs.existsSync(target));

  // Release: signing passwords reach Gradle through the environment, never the command line.
  const signing = { storeFile: path.join(dir, 'k.jks'), storePassword: 'pw-1234567890', keyAlias: 'release', keyPassword: 'pw-1234567890' };
  const rel = await buildAndroid({ projectDir: dir, toolchain, variant: 'release', signing });
  assert.equal(rel.result.ok, true);
  const relCall = JSON.parse(fs.readFileSync(path.join(dir, 'gradle-call.json'), 'utf8'));
  assert.equal(relCall.storePassword, 'pw-1234567890');
  assert.ok(!relCall.args.join(' ').includes('pw-1234567890'));
  assert.ok(!rel.result.log.join('\n').includes('pw-1234567890'));
});

test('android: a failed build is explained', async () => {
  const { buildAndroid, explainBuildFailure } = await import('../../src/android/build.mjs');
  const { dir, toolchain } = await androidFixture({ fail: true });
  const { result } = await buildAndroid({ projectDir: dir, toolchain });
  assert.equal(result.ok, false);
  assert.match(result.diagnosis.summary, /compileDebugKotlin/);
  assert.ok(result.diagnosis.hints.some((h) => /does not compile/.test(h)));

  const sdk = explainBuildFailure('* What went wrong:\nSDK location not found. Define a valid SDK location with an ANDROID_HOME environment variable\n* Try:');
  assert.match(sdk.summary, /SDK location not found/);
  assert.ok(sdk.hints.some((h) => /Android SDK was not found/.test(h)));
  assert.ok(explainBuildFailure('Could not resolve com.android.tools.build:gradle:8.5.2').hints.some((h) => /internet/.test(h)));
  assert.ok(explainBuildFailure('Android Gradle plugin requires Java 17 to run. You are currently using Java 11.').hints.some((h) => /JDK 17/.test(h)));
  assert.ok(explainBuildFailure("Failed to install the following Android SDK packages as some licences have not been accepted.").hints.some((h) => /licences/.test(h)));
});

test('android: build preconditions are reported before Gradle starts', async () => {
  const { buildAndroid } = await import('../../src/android/build.mjs');
  const { scaffoldTemplate } = await import('../../src/android/templates.mjs');
  await assert.rejects(() => buildAndroid({ projectDir: tmp('nothing'), toolchain: {} }), /No Android Gradle project/);
  const dir = tmp('nowrapper');
  await scaffoldTemplate(dir, 'android-kotlin', { name: 'X' });
  const jdk = fakeJdk(path.join(tmp('jdk'), 'jdk-17'));
  const sdk = fakeSdk(path.join(tmp('sdk'), 'Sdk'));
  const { detectAndroidToolchain } = await import('../../src/android/toolchain.mjs');
  const toolchain = await detectAndroidToolchain({ settings: { jdkHome: jdk, sdkDir: sdk }, env: { PATH: '' }, home: tmp('home'), allowRun: false, scan: false });
  await assert.rejects(() => buildAndroid({ projectDir: dir, toolchain }), /no Gradle wrapper and no Gradle installation/);
  await assert.rejects(() => buildAndroid({ projectDir: dir, toolchain: { ...toolchain, jdk: { ok: false } } }), /JDK/);
});

test('android: the "Android build" check verifies a task with the real build path', async () => {
  const { runChecks } = await import('../../src/checks/runner.mjs');
  const { configureAndroid, invalidateAndroidToolchain } = await import('../../src/android/toolchain.mjs');
  const { dir, jdk, sdk } = await androidFixture();
  configureAndroid({ jdkHome: jdk, sdkDir: sdk });
  invalidateAndroidToolchain();
  try {
    const [r] = await runChecks({ projectDir: dir, checks: [{ id: 'android-build', type: 'android-build', name: 'Android build', module: 'app', variant: 'debug', enabled: true, approved: true }] });
    assert.equal(r.status, 'passed', r.output);
    assert.match(r.output, /:app:assembleDebug succeeded/);
    assert.equal(r.details.artifacts[0].package, 'com.example.racer');
  } finally {
    configureAndroid({});
    invalidateAndroidToolchain();
  }
});

test('android: adb device list and Gradle download checksum', async () => {
  const { parseAdbDevices, downloadGradle, ensureLocalProperties } = await import('../../src/android/build.mjs');
  const devices = parseAdbDevices('List of devices attached\nR58M123ABC     device usb:1-1 product:beyond1 model:SM_G973F device:beyond1 transport_id:3\nemulator-5554  device product:sdk_gphone model:Pixel_7 transport_id:1\n0123456789     unauthorized usb:1-2 transport_id:4\n');
  assert.equal(devices.length, 3);
  assert.equal(devices[0].model, 'SM G973F');
  assert.equal(devices[1].emulator, true);
  assert.equal(devices[2].usable, false);

  const dir = tmp('localprops');
  const sdkDir = process.platform === 'win32' ? 'C:\\Users\\a\\AppData\\Local\\Android\\Sdk' : '/opt/android-sdk';
  await ensureLocalProperties(dir, sdkDir);
  const text = fs.readFileSync(path.join(dir, 'local.properties'), 'utf8');
  if (process.platform === 'win32') assert.match(text, /sdk\.dir=C\\:\\\\Users/);
  else assert.match(text, /sdk\.dir=\/opt\/android-sdk/);

  // The archive must match the published SHA-256, or nothing is installed.
  const zip = makeZip([{ name: 'gradle-0.1/bin/gradle', data: '#!/bin/sh\n' }, { name: 'gradle-0.1/bin/gradle.bat', data: '@echo off\r\n' }]);
  const crypto = await import('node:crypto');
  const sha = crypto.createHash('sha256').update(zip).digest('hex');
  const fetchImpl = (good) => async (url) => (url.endsWith('.sha256') ? new Response(good ? sha : 'a'.repeat(64)) : new Response(zip, { headers: { 'content-length': String(zip.length) } }));
  await assert.rejects(() => downloadGradle({ version: '0.1', fetchImpl: fetchImpl(false) }), /checksum mismatch/);
  const r = await downloadGradle({ version: '0.1', fetchImpl: fetchImpl(true) });
  assert.equal(r.sha256, sha);
  assert.ok(fs.existsSync(r.path));
  assert.equal((await downloadGradle({ version: '0.1', fetchImpl: fetchImpl(true) })).alreadyInstalled, true);
  await assert.rejects(() => downloadGradle({ version: '../x' }), /Invalid Gradle version/);
});
