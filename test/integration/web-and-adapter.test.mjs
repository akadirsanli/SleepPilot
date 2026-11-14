// Uses the FAKE OpenCode server (test double).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { setupEnv, makeApp, newProject, finished, plan, task } from './helpers.mjs';
import { startWebServer } from '../../src/web/server.mjs';

function rawRequest(port, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d }));
    });
    req.on('error', reject);
    if (body) req.end(body);
    else req.end();
  });
}

test('UI server: loopback only, token→cookie, Host check, CSRF header, English UI served', { timeout: 60_000 }, async () => {
  setupEnv('web');
  const app = await makeApp();
  const web = await startWebServer(app, { token: 'test-token-123456789' });
  try {
    assert.equal(web.server.address().address, '127.0.0.1');
    const host = `127.0.0.1:${web.port}`;
    assert.equal((await rawRequest(web.port, { path: '/api/state', headers: { host } })).status, 401);
    assert.equal((await rawRequest(web.port, { path: '/api/state', headers: { host: `evil.example:${web.port}` } })).status, 421);
    assert.equal((await rawRequest(web.port, { path: '/?t=wrong', headers: { host } })).status, 403);
    const login = await rawRequest(web.port, { path: '/?t=test-token-123456789', headers: { host } });
    assert.equal(login.status, 302);
    const cookie = login.headers['set-cookie'][0].split(';')[0];
    assert.match(login.headers['set-cookie'][0], /HttpOnly; SameSite=Strict/);
    const st = await rawRequest(web.port, { path: '/api/state', headers: { host, cookie } });
    assert.equal(st.status, 200);
    const state = JSON.parse(st.body);
    assert.equal(state.app.name, 'SleepPilot');
    assert.equal(state.app.testMode, true);
    assert.equal(state.opencode.status.state, 'connected');
    // State-changing request without the custom header is refused.
    const noHeader = await rawRequest(web.port, { method: 'POST', path: '/api/settings', headers: { host, cookie, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(noHeader.status, 403);
    const ui = await rawRequest(web.port, { path: '/', headers: { host, cookie } });
    assert.match(ui.body, /Plan\. Build\. Verify\. Sleep\./);
    assert.match(ui.body, /Reverse &amp; Rust/);
    assert.match(ui.body, /Settings/);
    assert.match(ui.headers['content-security-policy'], /default-src 'self'/);
    const js = await rawRequest(web.port, { path: '/app.js', headers: { host, cookie } });
    for (const s of ['Pause', 'Resume', 'Stop', 'Write an instruction', 'Permission requested', 'Copy Markdown', 'Run report']) assert.ok(js.body.includes(s), `UI contains "${s}"`);
  } finally {
    web.server.close();
    await app.shutdown();
  }
});

test('adapter: same message id submitted twice creates one user message (idempotent)', { timeout: 60_000 }, async () => {
  const { project } = setupEnv('idem', plan(task('t', ['write x.txt 1'])));
  const app = await makeApp();
  try {
    const s = await app.adapter.createSession({ directory: project, title: 'idem' });
    const mid = 'msg_idempotency_test_1';
    const prompt = 'You are the DEVELOPER\nCURRENT TASK [T1]: t\nACTION: write x.txt 1\nAFTER YOU FINISH';
    const r1 = await app.adapter.runTurn({ sessionID: s.id, text: prompt, messageId: mid });
    const r2 = await app.adapter.runTurn({ sessionID: s.id, text: prompt, messageId: mid });
    assert.equal(r1.status, 'succeeded');
    assert.equal(r2.status, 'succeeded');
    const msgs = (await app.adapter.requireClient().call('session.message.list', { params: { sessionID: s.id }, query: { limit: 100, order: 'asc' } })).data;
    assert.equal(msgs.filter((m) => m.type === 'user').length, 1);
    assert.equal(msgs.filter((m) => m.type === 'idle').length, 1);
  } finally {
    await app.shutdown();
  }
});

test('iteration limit stops the run with its own reason; unparseable manager JSON falls back safely', { timeout: 90_000 }, async () => {
  const { project } = setupEnv('limits', plan(task('a', ['write a.txt 1']), task('b', ['write b.txt 1'], { priority: 3 }), task('c', ['write c.txt 1'], { priority: 4 })));
  process.env.SLEEPPILOT_FAKE_BAD_JSON = '1';
  const app = await makeApp();
  try {
    const p = await newProject(app, project, { settings: { maxIterations: 2, reviewerEnabled: false } });
    const view = await app.startRun(p.id);
    const run = await finished(app, view.id);
    assert.equal(run.stopReason.code, 'iteration_limit');
    assert.equal(run.iterationCount, 2);
    assert.equal(run.tasks.find((t) => t.title === 'c').status, 'pending');
    // The manager's first decision was not JSON; a corrective retry was made.
    const it1 = await app.getIteration(p.id, run.id, 1);
    assert.equal(it1.decision.decision, 'continue');
    const { events } = await app.getRun(p.id, run.id);
    assert.ok(events.some((e) => /was not valid JSON/.test(e.text)));
  } finally {
    delete process.env.SLEEPPILOT_FAKE_BAD_JSON;
    await app.shutdown();
  }
});
