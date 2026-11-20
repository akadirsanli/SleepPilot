import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { findBrowsers } from './browser.mjs';
import { killTree } from '../util/proc.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/** Serve `root` read-only on 127.0.0.1:<random>. */
function staticServer(root) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      const full = path.resolve(root, rel || 'index.html');
      if (!full.startsWith(path.resolve(root))) {
        res.writeHead(403).end();
        return;
      }
      const data = await fsp.readFile(full);
      res.writeHead(200, { 'content-type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(data);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/**
 * Load each entry page in headless Edge/Chrome through the DevTools protocol and collect:
 * uncaught exceptions, console.error calls, browser log errors, failed requests.
 * Passing means: the page loaded and none of those occurred within the settle window.
 */
/**
 * A browser that will not start is skipped and the next one is tried. Seen on the user's machine:
 * right after an Edge update, headless msedge.exe exited at once with code 0 and no DevTools line.
 */
export async function runHtmlSmoke(opts) {
  const browsers = findBrowsers();
  if (!browsers.length) return { status: 'skipped', summary: 'Microsoft Edge or Chrome not found; the HTML check is unavailable.', pages: [] };
  const startErrors = [];
  for (const browserPath of browsers) {
    const r = await runWithBrowser(browserPath, opts);
    if (!r.startFailed) return startErrors.length ? { ...r, summary: `${r.summary} (with ${path.basename(browserPath)}; could not start: ${startErrors.join(', ')})` } : r;
    startErrors.push(`${path.basename(browserPath)}: ${r.startFailed}`);
  }
  return { status: 'skipped', summary: `The HTML check is unavailable; no browser could be started (${startErrors.join('; ')}).`, pages: [] };
}

/** "web/index.html?level=2#start" → URL path with each segment encoded, query/hash kept. */
export function entryUrl(port, entry) {
  const s = String(entry || '');
  const cut = s.search(/[?#]/);
  const file = cut >= 0 ? s.slice(0, cut) : s;
  const rest = cut >= 0 ? s.slice(cut) : '';
  return `http://127.0.0.1:${port}/${file.split('/').map(encodeURIComponent).join('/')}${rest}`;
}

const VIEWPORTS = { desktop: { width: 1280, height: 800, mobile: false }, phone: { width: 390, height: 844, mobile: true }, tablet: { width: 820, height: 1180, mobile: true } };

/**
 * Screenshots of project pages for the reviewer (taken only when the reviewer asks for them).
 * shots: [{ page: 'index.html', device: 'desktop' | 'phone' | 'tablet' }]. Each PNG is written to
 * outDir; page errors seen while loading are returned with it.
 */
export async function captureScreenshots({ projectDir, shots, outDir, prefix = 'shot', timeoutSec = 45, settleMs = 2500 }) {
  await fsp.mkdir(outDir, { recursive: true });
  const r = await runHtmlSmoke({ projectDir, entries: shots.map((s) => s.page), timeoutSec, settleMs, screenshot: { outDir, prefix, devices: shots.map((s) => s.device) } });
  return {
    status: r.status,
    summary: r.summary,
    files: (r.pages || []).filter((p) => p.screenshot).map((p) => ({ page: p.entry, device: p.device, file: p.screenshot, problems: p.problems.slice(0, 5) })),
    missing: (r.pages || []).filter((p) => !p.screenshot).map((p) => ({ page: p.entry, error: p.screenshotError || p.problems?.[0]?.text || 'no screenshot' })),
  };
}

async function runWithBrowser(browserPath, { projectDir, entries, timeoutSec = 60, settleMs = 2000, screenshot = null }) {
  const server = await staticServer(projectDir);
  const port = server.address().port;
  const profile = await fsp.mkdtemp(path.join(os.tmpdir(), 'sleeppilot-edge-'));
  const browser = spawn(
    browserPath,
    // Chrome refuses to run as root without --no-sandbox (Linux containers, CI images).
    ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank'],
    { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
  );
  const pages = [];
  let started = false;
  try {
    const wsUrl = await new Promise((resolve, reject) => {
      let buf = '';
      const t = setTimeout(() => reject(new Error('The browser DevTools connection did not open.')), 20_000);
      browser.stderr.on('data', (d) => {
        buf += d;
        const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
        if (m) {
          clearTimeout(t);
          resolve(m[1]);
        }
      });
      browser.on('exit', () => reject(new Error('The browser closed unexpectedly.')));
    });
    started = true;
    const cdp = await connectCdp(wsUrl);
    for (const [i, entry] of entries.entries()) {
      const shot = screenshot ? { file: path.join(screenshot.outDir, `${screenshot.prefix}-${i + 1}.png`), device: screenshot.devices?.[i] || 'desktop' } : null;
      pages.push(await checkPage(cdp, entryUrl(port, entry), entry, timeoutSec, settleMs, shot));
    }
    cdp.close();
  } catch (err) {
    if (!started) return { startFailed: err.message };
    // The browser started but the DevTools connection failed. That is an unavailable
    // check, not evidence that the project's HTML is broken.
    return { status: 'skipped', summary: `The HTML check is unavailable: ${err.message}`, pages };
  } finally {
    killTree(browser.pid);
    server.close();
    setTimeout(() => fs.rm(profile, { recursive: true, force: true }, () => {}), 1500);
  }
  const failed = pages.filter((p) => !p.ok);
  return {
    status: failed.length ? 'failed' : 'passed',
    summary: failed.length
      ? `errors on ${failed.length}/${pages.length} page(s): ` + failed.map((p) => `${p.entry} (${p.problems.length} problem(s))`).join(', ')
      : `${pages.length} page(s) loaded without errors.`,
    pages,
  };
}

async function checkPage(cdp, url, entry, timeoutSec, settleMs, shot = null) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const problems = [];
  const consoleLines = [];
  let loaded = false;
  const off = cdp.onEvent(sessionId, (method, params) => {
    if (method === 'Runtime.exceptionThrown') {
      const d = params.exceptionDetails || {};
      problems.push({ kind: 'exception', text: d.exception?.description || d.text, line: d.lineNumber, url: d.url });
    } else if (method === 'Runtime.consoleAPICalled') {
      const text = (params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
      consoleLines.push(`[${params.type}] ${text}`.slice(0, 500));
      if (params.type === 'error' || params.type === 'assert') problems.push({ kind: 'console.error', text: text.slice(0, 500) });
    } else if (method === 'Log.entryAdded' && params.entry?.level === 'error' && !/\/favicon\.ico$/.test(params.entry.url || '')) {
      // Browsers request /favicon.ico implicitly; a missing favicon is not a project defect.
      problems.push({ kind: 'log', text: params.entry.text, url: params.entry.url });
    } else if (method === 'Network.loadingFailed' && !params.canceled) {
      problems.push({ kind: 'network', text: params.errorText, requestId: params.requestId });
    } else if (method === 'Page.loadEventFired') {
      loaded = true;
    }
  });
  try {
    for (const d of ['Runtime.enable', 'Log.enable', 'Page.enable', 'Network.enable']) await cdp.send(d, {}, sessionId);
    if (shot) {
      const vp = VIEWPORTS[shot.device] || VIEWPORTS.desktop;
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: vp.width, height: vp.height, deviceScaleFactor: 1, mobile: vp.mobile }, sessionId).catch(() => {});
    }
    const nav = await cdp.send('Page.navigate', { url }, sessionId);
    if (nav.errorText) problems.push({ kind: 'navigation', text: nav.errorText });
    const deadline = Date.now() + timeoutSec * 1000;
    while (!loaded && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    if (!loaded) problems.push({ kind: 'timeout', text: `The page did not load within ${timeoutSec} s (no load event).` });
    await new Promise((r) => setTimeout(r, settleMs));
    const title = await cdp.send('Runtime.evaluate', { expression: 'document.title', returnByValue: true }, sessionId).catch(() => null);
    const bodyLen = await cdp.send('Runtime.evaluate', { expression: 'document.body ? document.body.innerText.length : -1', returnByValue: true }, sessionId).catch(() => null);
    let screenshot = null;
    let screenshotError = null;
    if (shot) {
      try {
        const img = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
        await fsp.writeFile(shot.file, Buffer.from(img.data, 'base64'));
        screenshot = shot.file;
      } catch (err) {
        screenshotError = err.message;
      }
    }
    return { entry, url, ok: problems.length === 0, loaded, title: title?.result?.value ?? null, bodyTextLength: bodyLen?.result?.value ?? null, problems: problems.slice(0, 30), console: consoleLines.slice(0, 30), ...(shot ? { screenshot, screenshotError, device: shot.device } : {}) };
  } finally {
    off();
    await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
  }
}

function createWebSocket(wsUrl) {
  // Node 22+ ships a browser-compatible WebSocket. Node 20 does not, so keep a small
  // RFC 6455 client for the DevTools connection instead of turning the check into an error.
  return typeof globalThis.WebSocket === 'function' ? new globalThis.WebSocket(wsUrl) : new NodeWebSocket(wsUrl);
}

function connectCdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = createWebSocket(wsUrl);
    let nextId = 1;
    const pending = new Map();
    const listeners = new Set();
    ws.onopen = () =>
      resolve({
        send(method, params = {}, sessionId) {
          const id = nextId++;
          ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
          return new Promise((res, rej) => {
            const t = setTimeout(() => {
              pending.delete(id);
              rej(new Error(`CDP timeout: ${method}`));
            }, 30_000);
            pending.set(id, { res, rej, t });
          });
        },
        onEvent(sessionId, fn) {
          const l = { sessionId, fn };
          listeners.add(l);
          return () => listeners.delete(l);
        },
        close: () => ws.close(),
      });
    ws.onerror = () => reject(new Error('CDP WebSocket error'));
    ws.onmessage = (m) => {
      const msg = JSON.parse(typeof m.data === 'string' ? m.data : Buffer.from(m.data).toString());
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        clearTimeout(p.t);
        if (msg.error) p.rej(new Error(msg.error.message));
        else p.res(msg.result);
      } else if (msg.method) {
        for (const l of listeners) if (l.sessionId === msg.sessionId) l.fn(msg.method, msg.params);
      }
    };
  });
}

/**
 * Minimal RFC 6455 client used only when Node has no global WebSocket (Node 20).
 * DevTools messages are JSON text frames; control and fragmentation frames are handled.
 */
class NodeWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.socket = null;
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;
    this._buffer = Buffer.alloc(0);
    this._fragments = [];
    this._connect();
  }

  _connect() {
    const u = new URL(this.url);
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({
      hostname: u.hostname,
      port: u.port || 80,
      path: `${u.pathname}${u.search}`,
      method: 'GET',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
      },
    });
    req.setTimeout(20_000, () => req.destroy(new Error('CDP WebSocket handshake timed out')));
    req.on('upgrade', (res, socket, head) => {
      const expected = crypto.createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
      if (res.headers['sec-websocket-accept'] !== expected) {
        socket.destroy();
        this._fail(new Error('CDP WebSocket handshake was not accepted'));
        return;
      }
      this.socket = socket;
      this.readyState = 1;
      socket.setNoDelay(true);
      socket.on('data', (d) => this._onData(d));
      socket.on('error', (err) => this._fail(err));
      socket.on('close', () => this._closed());
      if (head?.length) this._onData(head);
      this.onopen?.({});
    });
    req.on('response', (res) => {
      res.resume();
      this._fail(new Error(`CDP WebSocket handshake failed with HTTP ${res.statusCode}`));
    });
    req.on('error', (err) => this._fail(err));
    req.end();
  }

  _fail(err) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onerror?.(err);
    try { this.socket?.destroy(); } catch {}
    this._closed();
  }

  _closed() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({});
  }

  send(data) {
    if (this.readyState !== 1) throw new Error('CDP WebSocket is not open');
    this._sendFrame(Buffer.from(String(data), 'utf8'), 1);
  }

  close() {
    if (this.readyState === 1) {
      try { this._sendFrame(Buffer.alloc(0), 8); } catch {}
    }
    this.readyState = 3;
    try { this.socket?.end(); } catch {}
  }

  _sendFrame(payload, opcode) {
    if (!this.socket) return;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.from([0x80 | opcode, 0x80 | len]);
    } else if (len < 65_536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    const mask = crypto.randomBytes(4);
    const masked = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  _onData(chunk) {
    this._buffer = Buffer.concat([this._buffer, chunk]);
    while (this._buffer.length >= 2) {
      const b0 = this._buffer[0];
      const b1 = this._buffer[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (this._buffer.length < 4) return;
        len = this._buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this._buffer.length < 10) return;
        const big = this._buffer.readBigUInt64BE(2);
        if (big > 100_000_000n) { this._fail(new Error('CDP WebSocket frame is too large')); return; }
        len = Number(big);
        offset = 10;
      }
      let mask = null;
      if (masked) {
        if (this._buffer.length < offset + 4) return;
        mask = this._buffer.subarray(offset, offset + 4);
        offset += 4;
      }
      if (this._buffer.length < offset + len) return;
      let payload = this._buffer.subarray(offset, offset + len);
      this._buffer = this._buffer.subarray(offset + len);
      if (mask) {
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      }
      if (opcode === 8) { this._closed(); try { this.socket?.end(); } catch {} return; }
      if (opcode === 9) { this._sendFrame(payload, 10); continue; }
      if (opcode === 10) continue;
      if (opcode === 1 || opcode === 2) {
        this._fragments = [payload];
        if (fin) this._emitMessage();
      } else if (opcode === 0) {
        this._fragments.push(payload);
        if (fin) this._emitMessage();
      }
    }
  }

  _emitMessage() {
    const message = Buffer.concat(this._fragments).toString('utf8');
    this._fragments = [];
    this.onmessage?.({ data: message });
  }
}
