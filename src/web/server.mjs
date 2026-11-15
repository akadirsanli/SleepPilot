import http from 'node:http';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { secret } from '../util/ids.mjs';
import { redact } from '../util/redact.mjs';
import { pickFolder } from './folder-picker.mjs';
import { logger } from '../util/log.mjs';
import { PhoneAccess, phoneMayCall } from './remote.mjs';

const log = logger('web');
const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'ui');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png' };

/**
 * Local UI server. Security model:
 *  - binds to 127.0.0.1 only;
 *  - a random per-launch token is exchanged once (?t=…) for an HttpOnly SameSite=Strict cookie;
 *  - the Host header must be the loopback address (blocks DNS-rebinding);
 *  - state-changing requests need the custom header X-SleepPilot (blocks cross-site form posts).
 * Optional phone access (Settings → Phone) adds a second listener on the Tailscale address only,
 * with its own long-lived token; see remote.mjs.
 */
export async function startWebServer(app, { port = 0, token = secret(24), phone: phoneOptions = {} } = {}) {
  const clients = new Set();
  app.on('broadcast', (msg) => {
    const line = `data: ${JSON.stringify(msg)}\n\n`;
    for (const res of clients) res.write(line);
  });
  setInterval(() => {
    for (const res of clients) res.write(': ping\n\n');
  }, 20_000).unref();

  const routes = [];
  const route = (method, pattern, handler) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), handler });

  route('GET', '/api/ping', async () => ({ ok: true, app: 'SleepPilot' }));
  route('POST', '/api/app/close', async () => app.requestClose());
  // Every response that replaces the UI's state says whether it is shown on the phone.
  const stateFor = async (ctx) => ({ ...(await app.state()), viewer: { phone: !!ctx?.remote } });
  route('GET', '/api/state', async (_, __, ___, ctx) => stateFor(ctx));
  route('GET', '/api/phone', async () => phone.view());
  route('POST', '/api/phone', async (_, b) => {
    await app.saveSettings({ phone: { ...(app.settings.phone || {}), enabled: !!b?.enabled } });
    await phone.sync();
    return phone.view();
  });
  route('POST', '/api/phone/reset', async () => {
    // The listener compares against the current token, so old cookies stop working at once.
    await phone.resetToken();
    return phone.view();
  });
  route('POST', '/api/settings', async (_, body, __, ctx) => (await app.saveSettings(body || {}), stateFor(ctx)));
  route('POST', '/api/engines/:id/connect', async (p) => app.testEngine(p.id));
  route('POST', '/api/opencode/reconnect', async (_, __, ___, ctx) => (await app.reconnect('opencode'), stateFor(ctx)));
  route('POST', '/api/secrets/provider', async (_, body) => app.saveProviderSecret(body || {}));
  route('POST', '/api/secrets/env', async (_, body) => app.saveEnvSecret(body || {}));
  route('GET', '/api/usage-limits', async (_, __, q) => app.usageLimits(q.get('projectId')));
  route('POST', '/api/pick-folder', async (_, body) => pickFolder(body.initial));
  route('POST', '/api/projects', async (_, body) => app.createProject(body || {}));
  route('GET', '/api/projects/:id', async (p) => app.getProject(p.id));
  route('PUT', '/api/projects/:id', async (p, body) => app.updateProject(p.id, body || {}));
  route('POST', '/api/projects/:id/inspect', async (p) => app.inspect(p.id));
  route('GET', '/api/projects/:id/scope', async (p) => app.projectScope(p.id));
  route('GET', '/api/projects/:id/scout', async (p) => app.scoutProject(p.id));
  route('POST', '/api/projects/:id/checks/suggested', async (p) => app.addScoutChecks(p.id));
  route('POST', '/api/scout/directory', async (_, b) => app.scoutDirectory(b || {}));
  route('POST', '/api/scout/target', async (_, b) => app.scoutTarget(b || {}));
  route('POST', '/api/projects/:id/runs', async (p) => app.startRun(p.id));
  route('GET', '/api/runs/:pid/:rid', async (p) => app.getRun(p.pid, p.rid));
  route('GET', '/api/runs/:pid/:rid/iterations/:n', async (p) => app.getIteration(p.pid, p.rid, p.n));
  route('GET', '/api/runs/:pid/:rid/report', async (p) => app.report(p.pid, p.rid));
  route('POST', '/api/runs/:pid/:rid/pause', async (p, b) => (await app.controllerFor(p.rid).requestPause({ immediate: !!b.immediate }), { ok: true }));
  route('POST', '/api/runs/:pid/:rid/resume', async (p) => app.resumeRun(p.rid));
  route('POST', '/api/runs/:pid/:rid/stop', async (p, b) => (await app.controllerFor(p.rid).requestStop({ immediate: !!b.immediate }), { ok: true }));
  route('POST', '/api/reverse', async (_, b) => app.createReverseProject(b || {}));
  route('POST', '/api/reverse/preview', async (_, b) => app.reversePreview(b || {}));
  route('GET', '/api/reverse/info', async () => app.reverseInfo());
  route('GET', '/api/tools', async (_, __, q) => app.tools(q?.get('refresh') === '1'));
  route('POST', '/api/tools/:id/verify', async (p, b) => app.verifyTool(p.id, { model: b?.model }));
  route('POST', '/api/tools/override', async (_, b) => app.saveToolOverride(b || {}));
  route('GET', '/api/ollama', async () => app.ollamaStatus());
  route('POST', '/api/ollama/host', async (_, b) => app.saveOllamaHost(b || {}));
  route('POST', '/api/ollama/provider', async (_, b) => app.addOllamaProvider(b || {}));
  route('GET', '/api/projects-summary', async () => app.projectSummaries());
  route('GET', '/api/analytics', async () => app.analytics());
  route('GET', '/api/projects/:id/github', async (p) => app.githubStatus(p.id));
  route('POST', '/api/projects/:id/github/push', async (p, b) => app.githubPush(p.id, b || {}));
  route('POST', '/api/projects/:id/github/create', async (p, b) => app.githubCreate(p.id, b || {}));
  route('POST', '/api/projects/:id/github/init', async (p) => app.githubInit(p.id));
  route('GET', '/api/projects/:pid/stats', async (p, b, q) => app.stats(p.pid, q.get('runId')));
  route('GET', '/api/runs/:pid/:rid/turns', async (p, b, q) => app.getTurns(p.pid, p.rid, { iteration: q.get('iteration'), limit: Number(q.get('limit') || 80) }));
  route('POST', '/api/runs/:pid/:rid/tasks/:tid', async (p, b) => app.editTask(p.rid, p.tid, b || {}));
  route('POST', '/api/runs/:pid/:rid/settings', async (p, b) => app.updateRunSettings(p.rid, b || {}));
  route('POST', '/api/runs/:pid/:rid/steer', async (p, b) => app.controllerFor(p.rid).steer({ text: b.text, mode: b.mode }));
  route('POST', '/api/runs/:pid/:rid/permission', async (p, b) => (await app.controllerFor(p.rid).replyPermission(b.id, b.decision), { ok: true }));
  route('POST', '/api/runs/:pid/:rid/form', async (p, b) => (await app.controllerFor(p.rid).replyForm(b.id, b.answer), { ok: true }));

  const handle = async (req, res, ctx) => {
    try {
      const host = String(req.headers.host || '');
      if (!ctx.hostOk(host)) {
        res.writeHead(421).end('Misdirected request');
        return;
      }
      const url = new URL(req.url, `http://${host}`);
      // Token exchange
      if (url.searchParams.get('t')) {
        if (ctx.token && url.searchParams.get('t') === ctx.token) {
          res.writeHead(302, { 'set-cookie': `${ctx.cookie}=${ctx.token}; HttpOnly; SameSite=Strict; Path=/${ctx.maxAge ? `; Max-Age=${ctx.maxAge}` : ''}`, location: '/' });
        } else res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end(ctx.remote ? 'This phone link is no longer valid. Scan the QR code in SleepPilot → Settings → Phone again.' : 'Invalid access token. Restart SleepPilot.');
        res.end();
        return;
      }
      const cookie = Object.fromEntries(String(req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((x) => x.length === 2));
      const authed = !!ctx.token && cookie[ctx.cookie] === ctx.token;
      if (url.pathname === '/api/ping') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, app: 'SleepPilot' }));
        return;
      }
      if (!authed) {
        res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' }).end(ctx.remote ? '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><p style="font-family:sans-serif">This phone is not signed in. On the PC open SleepPilot → Settings → Phone and scan the QR code.</p>' : '<meta charset="utf-8"><p style="font-family:sans-serif">No access token for this session. Reopen SleepPilot with <b>SleepPilot.cmd</b>.</p>');
        return;
      }
      if (url.pathname === '/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write(': connected\n\n');
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.headers['x-sleeppilot'] !== '1') {
          res.writeHead(403).end('missing header');
          return;
        }
        if (ctx.remote && !phoneMayCall(req.method, url.pathname)) {
          res.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Not available from the phone. Do this on the PC.' }));
          return;
        }
        for (const r of routes) {
          if (r.method !== req.method) continue;
          const m = url.pathname.match(r.re);
          if (!m) continue;
          let body = req.method === 'GET' ? {} : await readBody(req);
          // Phone access is switched on and off only on the PC.
          if (ctx.remote && body && typeof body === 'object' && 'phone' in body) {
            const { phone: _ignored, ...rest } = body;
            body = rest;
          }
          const params = Object.fromEntries(Object.entries(m.groups || {}).map(([k, v]) => [k, decodeURIComponent(v)]));
          const result = await r.handler(params, body, url.searchParams, ctx);
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(JSON.stringify(result ?? null));
          return;
        }
        res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Not found' }));
        return;
      }
      // Static UI
      const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const file = path.resolve(UI_DIR, rel);
      if (!file.startsWith(path.resolve(UI_DIR))) {
        res.writeHead(403).end();
        return;
      }
      const data = await fsp.readFile(file).catch(() => null);
      if (!data) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:" });
      res.end(data);
    } catch (err) {
      log.warn(`request failed: ${err.message}`);
      if (!res.headersSent) res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: redact(err.message) }));
    }
  };
  const server = http.createServer((req, res) => {
    const p = server.address().port;
    return handle(req, res, { remote: false, token, cookie: 'sp_token', hostOk: (host) => host === `127.0.0.1:${p}` || host === `localhost:${p}` });
  });
  const phone = new PhoneAccess({ app, handle, ...phoneOptions });
  server.on('close', () => phone.stop());
  // A stable port keeps per-origin browser state (notification permission, remembered tabs)
  // across launches; if it is taken, any free port is used.
  for (const p of Array.isArray(port) ? port : [port]) {
    const ok = await new Promise((resolve, reject) => {
      const onError = (err) => (err.code === 'EADDRINUSE' && p !== 0 ? resolve(false) : reject(err));
      server.once('error', onError);
      server.listen(p, '127.0.0.1', () => {
        server.off('error', onError);
        resolve(true);
      });
    });
    if (ok) break;
  }
  const actual = server.address().port;
  await phone.sync();
  return { server, phone, port: actual, token, url: `http://127.0.0.1:${actual}/?t=${token}` };
}

async function readBody(req) {
  let s = '';
  for await (const chunk of req) {
    s += chunk;
    if (s.length > 2_000_000) throw new Error('Request too large.');
  }
  if (!s) return {};
  return JSON.parse(s);
}
