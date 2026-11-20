// Workspace, live preview and Android features through the app service and the HTTP API.
// Uses the FAKE OpenCode server; no Android SDK is needed (APKs are test fixtures).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { setupEnv, makeApp, tmpDir, waitFor } from './helpers.mjs';
import { startWebServer } from '../../src/web/server.mjs';
import { fakeApk } from '../fixtures/zip-writer.mjs';

function request(port, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { host: `127.0.0.1:${port}`, ...headers }, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, buffer: Buffer.concat(chunks), body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('workspace: a project needs only a name; templates add checks, rules and preview settings', { timeout: 120_000 }, async () => {
  setupEnv('wb-workspace');
  const app = await makeApp();
  try {
    await assert.rejects(() => app.createProject({ name: 'No folder' }), /workspace/);
    const ws = path.join(tmpDir('wb-ws'), 'My Workspace');
    const info = await app.setWorkspace({ dir: ws });
    assert.equal(info.configured, true);
    assert.ok(fs.existsSync(path.join(ws, 'projects')));
    assert.equal(app.settings.workspace.dir, ws);

    // Web template: a folder with a safe name inside the workspace, page-load check, live preview.
    const web = await app.createProject({ name: 'Landing Sayfası', template: 'web' });
    assert.equal(web.dir, path.join(ws, 'projects', 'landing-sayfasi'));
    assert.equal(web.kind, 'web');
    assert.ok(web.checks.some((c) => c.type === 'html-smoke' && c.enabled));
    assert.equal(web.preview.mode, 'static');
    // The same name again gets its own folder.
    const web2 = await app.createProject({ name: 'Landing Sayfası', template: 'web' });
    assert.equal(path.basename(web2.dir), 'landing-sayfasi-2');

    // Android template: build check, rules, application id, Android kind.
    const game = await app.createProject({ name: 'Yarış Oyunu', template: 'android-libgdx' });
    assert.equal(game.kind, 'android');
    assert.equal(game.android.applicationId, 'com.sleeppilot.yarisoyunu');
    assert.ok(game.checks.some((c) => c.type === 'android-build' && c.module === 'android' && c.enabled && c.approved));
    assert.match(game.rules, /:android:assembleDebug/);
    assert.ok(fs.existsSync(path.join(game.dir, 'core', 'build.gradle')));
    await assert.rejects(() => app.createProject({ name: 'Bad Id', template: 'android-kotlin', applicationId: 'nope' }), /not a valid Android application id/);
    assert.equal(fs.existsSync(path.join(ws, 'projects', 'bad-id')), false, 'a failed template leaves no empty folder behind');

    // A folder copied into the workspace by hand can be opened as a project.
    fs.mkdirSync(path.join(ws, 'projects', 'copied-in'));
    let view = await app.workspaceInfo();
    assert.equal(view.folders.find((f) => f.folder === 'copied-in').projectId, null);
    const opened = await app.openWorkspaceFolder({ folder: 'copied-in' });
    assert.equal(opened.dir, path.join(ws, 'projects', 'copied-in'));
    view = await app.workspaceInfo();
    assert.equal(view.folders.find((f) => f.folder === 'copied-in').projectId, opened.id);
    await assert.rejects(() => app.openWorkspaceFolder({ folder: '../escape' }), /Invalid folder name/);

    // Exports go to <workspace>/exports/<project folder>.
    assert.equal(app.exportDirFor(game), path.join(ws, 'exports', 'yaris-oyunu'));
    const state = await app.state();
    assert.equal(state.workspace.configured, true);
    assert.ok(state.templates.some((t) => t.id === 'android-webview'));
    assert.equal(state.projects.find((p) => p.id === game.id).inWorkspace, true);
  } finally {
    await app.shutdown();
  }
});

test('preview: start, live content, stop — through the app and the HTTP API', { timeout: 120_000 }, async () => {
  const { project: dir } = setupEnv('wb-preview');
  const app = await makeApp();
  const web = await startWebServer(app, { token: 'tok-preview-123456789' });
  try {
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html><head><title>Game</title></head><body><canvas></canvas></body></html>');
    const project = await app.createProject({ name: 'game', dir });
    const login = await request(web.port, { path: '/?t=tok-preview-123456789' });
    const cookie = login.headers['set-cookie'][0].split(';')[0];
    const api = async (method, p, body) => {
      const r = await request(web.port, { method, path: p, headers: { cookie, 'x-sleeppilot': '1', 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
      return { ...r, json: r.headers['content-type']?.includes('json') ? JSON.parse(r.body || 'null') : null };
    };
    // The UI page allows framing the local preview, nothing else.
    const page = await request(web.port, { path: '/', headers: { cookie } });
    assert.match(page.headers['content-security-policy'], /frame-src http:\/\/127\.0\.0\.1:\* http:\/\/localhost:\*/);

    let info = (await api('GET', `/api/projects/${project.id}/preview`)).json;
    assert.equal(info.detected.recommended, 'static');
    assert.equal(info.view.running, false);
    info = (await api('POST', `/api/projects/${project.id}/preview/start`)).json;
    assert.equal(info.view.running, true);
    const url = info.view.url;
    const served = await request(Number(new URL(url).port), { path: '/' });
    assert.match(served.body, /<canvas>/);
    assert.match(served.body, /__sleeppilot\/client\.js/);
    assert.equal((await app.state()).previews[0].projectId, project.id);

    // Saving a command withdraws an approval that was given for another command.
    info = (await api('POST', `/api/projects/${project.id}/preview/config`, { mode: 'command', command: 'npm run dev', commandApproved: true })).json;
    assert.equal(info.config.commandApproved, true);
    info = (await api('POST', `/api/projects/${project.id}/preview/config`, { command: 'npm start' })).json;
    assert.equal(info.config.commandApproved, false);
    assert.match((await api('POST', `/api/projects/${project.id}/preview/start`)).body, /Approve/);
    await api('POST', `/api/projects/${project.id}/preview/config`, { mode: 'auto' });

    info = (await api('POST', `/api/projects/${project.id}/preview/stop`)).json;
    assert.equal(info.view.running, false);
    await assert.rejects(request(Number(new URL(url).port), { path: '/' }), /ECONNREFUSED/);

    // A run starts the static preview by itself.
    await app.updateProject(project.id, { objective: 'Make the page nicer.', settings: { ...project.settings, backupBeforeRun: false, durationMin: 5, maxIterations: 2 } });
    await app.startRun(project.id);
    await waitFor(() => app.previews.view(project.id).running, { label: 'preview auto-start', timeoutMs: 20_000 });
    for (const c of app.activeControllers()) await c.requestStop({ immediate: true }).catch(() => {});
  } finally {
    web.server.close();
    await app.shutdown();
  }
});

test('android: project view, artifact download and path checks through the HTTP API', { timeout: 120_000 }, async () => {
  const { project: dir } = setupEnv('wb-android');
  const app = await makeApp();
  const web = await startWebServer(app, { token: 'tok-android-123456789' });
  try {
    const project = await app.createProject({ name: 'Racer', dir, template: 'android-kotlin', applicationId: 'com.example.racer' });
    const apkDir = path.join(dir, 'app', 'build', 'outputs', 'apk', 'debug');
    fs.mkdirSync(apkDir, { recursive: true });
    const apkBytes = fakeApk({ pkg: 'com.example.racer', versionName: '0.9' });
    fs.writeFileSync(path.join(apkDir, 'app-debug.apk'), apkBytes);
    fs.writeFileSync(path.join(dir, 'secret.txt'), 'not an apk');

    const login = await request(web.port, { path: '/?t=tok-android-123456789' });
    const cookie = login.headers['set-cookie'][0].split(';')[0];
    const get = (p) => request(web.port, { path: p, headers: { cookie } });

    const view = JSON.parse((await get(`/api/projects/${project.id}/android`)).body);
    assert.equal(view.info.isAndroid, true);
    assert.equal(view.info.appModule.applicationId, 'com.example.racer');
    assert.equal(view.artifacts.length, 1);
    assert.equal(view.artifacts[0].details.manifest.versionName, '0.9');
    assert.equal(view.artifacts[0].file, undefined, 'absolute paths of build outputs are not sent to the UI');
    assert.equal(view.signing.exists, false);
    assert.ok(view.toolchain.problems.length >= 0);

    const dl = await get(`/api/projects/${project.id}/android/file?path=${encodeURIComponent('app/build/outputs/apk/debug/app-debug.apk')}`);
    assert.equal(dl.status, 200);
    assert.equal(dl.headers['content-type'], 'application/vnd.android.package-archive');
    assert.match(dl.headers['content-disposition'], /attachment; filename="app-debug\.apk"/);
    assert.ok(dl.buffer.equals(apkBytes));
    // Only APK/AAB files inside the project or its exports folder are served.
    assert.equal((await get(`/api/projects/${project.id}/android/file?path=secret.txt`)).status, 400);
    assert.equal((await get(`/api/projects/${project.id}/android/file?path=${encodeURIComponent('../../x.apk')}`)).status, 400);
    const outside = path.join(tmpDir('wb-outside'), 'other.apk');
    fs.writeFileSync(outside, apkBytes);
    assert.equal((await get(`/api/projects/${project.id}/android/file?path=${encodeURIComponent(outside)}`)).status, 400);

    // The build check can be added to an imported Android project.
    const plain = await app.createProject({ name: 'Imported', dir: tmpDir('wb-imported') });
    fs.cpSync(dir, plain.dir, { recursive: true });
    const checks = await app.androidAddCheck(plain.id);
    assert.ok(checks.some((c) => c.type === 'android-build' && c.module === 'app'));
    assert.equal((await app.store.getProject(plain.id)).kind, 'android');
  } finally {
    web.server.close();
    await app.shutdown();
  }
});
