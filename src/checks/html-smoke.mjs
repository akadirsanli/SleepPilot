import http from 'node:http';
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
  if (!browsers.length) return { status: 'error', summary: 'Microsoft Edge or Chrome not found; the HTML check could not run.', pages: [] };
  const startErrors = [];
  for (const browserPath of browsers) {
    const r = await runWithBrowser(browserPath, opts);
    if (!r.startFailed) return startErrors.length ? { ...r, summary: `${r.summary} (with ${path.basename(browserPath)}; could not start: ${startErrors.join(', ')})` } : r;
    startErrors.push(`${path.basename(browserPath)}: ${r.startFailed}`);
  }
  return { status: 'error', summary: `The HTML check could not run; no browser could be started (${startErrors.join('; ')}).`, pages: [] };
}

async function runWithBrowser(browserPath, { projectDir, entries, timeoutSec = 60, settleMs = 2000 }) {
  const server = await staticServer(projectDir);
  const port = server.address().port;
  const profile = await fsp.mkdtemp(path.join(os.tmpdir(), 'sleeppilot-edge-'));
  const browser = spawn(
    browserPath,
    ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank'],
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
    for (const entry of entries) {
      pages.push(await checkPage(cdp, `http://127.0.0.1:${port}/${entry.split('/').map(encodeURIComponent).join('/')}`, entry, timeoutSec, settleMs));
    }
    cdp.close();
  } catch (err) {
    if (!started) return { startFailed: err.message };
    return { status: 'error', summary: `The HTML check could not run: ${err.message}`, pages };
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

async function checkPage(cdp, url, entry, timeoutSec, settleMs) {
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
    const nav = await cdp.send('Page.navigate', { url }, sessionId);
    if (nav.errorText) problems.push({ kind: 'navigation', text: nav.errorText });
    const deadline = Date.now() + timeoutSec * 1000;
    while (!loaded && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    if (!loaded) problems.push({ kind: 'timeout', text: `The page did not load within ${timeoutSec} s (no load event).` });
    await new Promise((r) => setTimeout(r, settleMs));
    const title = await cdp.send('Runtime.evaluate', { expression: 'document.title', returnByValue: true }, sessionId).catch(() => null);
    const bodyLen = await cdp.send('Runtime.evaluate', { expression: 'document.body ? document.body.innerText.length : -1', returnByValue: true }, sessionId).catch(() => null);
    return { entry, url, ok: problems.length === 0, loaded, title: title?.result?.value ?? null, bodyTextLength: bodyLen?.result?.value ?? null, problems: problems.slice(0, 30), console: consoleLines.slice(0, 30) };
  } finally {
    off();
    await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
  }
}

function connectCdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
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
