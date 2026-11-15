// Phone access over Tailscale. Uses the FAKE OpenCode server; the "Tailscale address" is the
// loopback address so the second listener can be exercised on any machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { setupEnv, makeApp } from './helpers.mjs';
import { startWebServer } from '../../src/web/server.mjs';
import { PhoneAccess } from '../../src/web/remote.mjs';

function rawRequest(port, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers, agent: false }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d }));
    });
    req.on('error', reject);
    if (body) req.end(body);
    else req.end();
  });
}

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

test('phone access: off by default, Tailscale-only listener, own token, PC-only actions refused', { timeout: 60_000 }, async () => {
  setupEnv('phone');
  const app = await makeApp();
  const phonePort = await freePort();
  app.settings.phone = { enabled: false, port: phonePort };
  let peerAllowed = true;
  const web = await startWebServer(app, { token: 'pc-token-123456789', phone: { findAddress: () => '127.0.0.1', isPeerAllowed: () => peerAllowed } });
  const pcHost = { host: `127.0.0.1:${web.port}` };
  try {
    const pcLogin = await rawRequest(web.port, { path: '/?t=pc-token-123456789', headers: pcHost });
    const pcCookie = pcLogin.headers['set-cookie'][0].split(';')[0];
    const pc = (method, path, body) => rawRequest(web.port, { method, path, headers: { ...pcHost, cookie: pcCookie, 'x-sleeppilot': '1', 'content-type': 'application/json' }, body: body && JSON.stringify(body) });

    // Off by default: nothing listens on the phone port.
    let view = JSON.parse((await pc('GET', '/api/phone')).body);
    assert.equal(view.enabled, false);
    assert.equal(view.listening, false);
    await assert.rejects(rawRequest(phonePort, { headers: { host: `127.0.0.1:${phonePort}` } }), /ECONNREFUSED/);

    // Turned on from the PC: QR code and link with a long token.
    view = JSON.parse((await pc('POST', '/api/phone', { enabled: true })).body);
    assert.equal(view.listening, true);
    assert.equal(view.port, phonePort);
    assert.match(view.qr, /^<svg /);
    const token = new URL(view.url).searchParams.get('t');
    assert.ok(token.length >= 40);
    assert.equal(app.settings.phone.enabled, true);

    const host = { host: `127.0.0.1:${phonePort}` };
    assert.equal((await rawRequest(phonePort, { path: '/api/state', headers: { host: `evil.example:${phonePort}` } })).status, 421);
    assert.equal((await rawRequest(phonePort, { path: '/api/state', headers: host })).status, 401);
    assert.equal((await rawRequest(phonePort, { path: '/?t=wrong', headers: host })).status, 403);
    // The PC's session token does not open the phone listener.
    assert.equal((await rawRequest(phonePort, { path: '/?t=pc-token-123456789', headers: host })).status, 403);
    assert.equal((await rawRequest(phonePort, { path: '/api/state', headers: { ...host, cookie: `sp_phone=pc-token-123456789` } })).status, 401);

    const login = await rawRequest(phonePort, { path: `/?t=${token}`, headers: host });
    assert.equal(login.status, 302);
    assert.match(login.headers['set-cookie'][0], /^sp_phone=.*HttpOnly; SameSite=Strict; Path=\/; Max-Age=31536000/);
    const cookie = login.headers['set-cookie'][0].split(';')[0];
    const phone = (method, path, body) => rawRequest(phonePort, { method, path, headers: { ...host, cookie, 'x-sleeppilot': '1', 'content-type': 'application/json' }, body: body && JSON.stringify(body) });

    const st = await phone('GET', '/api/state');
    assert.equal(st.status, 200);
    assert.equal(JSON.parse(st.body).viewer.phone, true);
    assert.equal(JSON.parse((await pc('GET', '/api/state')).body).viewer.phone, false);
    assert.equal((await phone('GET', '/')).status, 200);
    // CSRF header is still required from the phone.
    assert.equal((await rawRequest(phonePort, { method: 'POST', path: '/api/settings', headers: { ...host, cookie }, body: '{}' })).status, 403);

    // PC-only actions.
    for (const [m, p] of [['POST', '/api/secrets/provider'], ['POST', '/api/secrets/env'], ['POST', '/api/pick-folder'], ['POST', '/api/app/close'], ['GET', '/api/phone'], ['POST', '/api/phone'], ['POST', '/api/phone/reset']]) {
      assert.equal((await phone(m, p, {})).status, 403, `${m} ${p} is refused from the phone`);
    }
    // The phone cannot switch phone access off through the general settings call either.
    const saved = await phone('POST', '/api/settings', { phone: { enabled: false }, maxConcurrentRuns: 4 });
    assert.equal(saved.status, 200);
    assert.equal(JSON.parse(saved.body).viewer.phone, true, 'the saved state still knows it is shown on the phone');
    assert.equal(app.settings.phone.enabled, true);
    assert.equal(app.settings.maxConcurrentRuns, 4);

    // A peer outside the tailnet is turned away even with the right cookie.
    peerAllowed = false;
    assert.equal((await phone('GET', '/api/state')).status, 403);
    peerAllowed = true;

    // The token survives a restart (same QR code) …
    const again = new PhoneAccess({ app, handle: () => {} });
    assert.equal(await again.loadToken(), token);
    // … until the PC signs all phones out.
    view = JSON.parse((await pc('POST', '/api/phone/reset', {})).body);
    assert.equal(view.listening, true);
    assert.notEqual(new URL(view.url).searchParams.get('t'), token);
    assert.equal((await phone('GET', '/api/state')).status, 401);

    // Turned off: the listener is gone.
    view = JSON.parse((await pc('POST', '/api/phone', { enabled: false })).body);
    assert.equal(view.listening, false);
    await assert.rejects(rawRequest(phonePort, { headers: host }), /ECONNREFUSED/);
  } finally {
    await web.phone.stop();
    web.server.close();
    await app.shutdown();
  }
});

test('phone access waits for Tailscale instead of failing', { timeout: 30_000 }, async () => {
  setupEnv('phone-wait');
  const app = await makeApp();
  app.settings.phone = { enabled: true, port: await freePort() };
  let address = null;
  const web = await startWebServer(app, { phone: { findAddress: () => address, isPeerAllowed: () => true } });
  try {
    let view = web.phone.view();
    assert.equal(view.listening, false);
    assert.equal(view.error, 'no-tailscale');
    address = '127.0.0.1';
    await web.phone.sync();
    view = web.phone.view();
    assert.equal(view.listening, true);
    assert.equal(view.error, null);
  } finally {
    await web.phone.stop();
    web.server.close();
    await app.shutdown();
  }
});
