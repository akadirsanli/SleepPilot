import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { IGNORED_DIRS } from '../project/snapshot.mjs';
import { killTree } from '../util/proc.mjs';
import { redact } from '../util/redact.mjs';
import { sha1 } from '../util/ids.mjs';
import { logger } from '../util/log.mjs';

const log = logger('preview');

/**
 * Live preview of a project.
 *
 *  - static:  the project folder (or a sub-folder such as dist/) is served read-only on
 *             127.0.0.1:<port>. HTML pages get a tiny client script that reloads the page when a
 *             file changes and reports JavaScript errors to the SleepPilot window, so the user
 *             watches the app take shape while the agent is still writing it.
 *  - command: the project's own dev server (`npm run dev`, …) is started and its URL is shown.
 *             It executes project code, so it only runs after the user approved the command —
 *             the same rule as command checks.
 *
 * The preview runs on its own port, i.e. a different origin from the SleepPilot UI: project
 * code in the preview cannot read SleepPilot's API (no CORS headers are ever sent for it) and
 * cannot send the custom header that every state-changing API call requires.
 */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.obj': 'text/plain; charset=utf-8',
  '.bin': 'application/octet-stream',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
};

const PREVIEW_MODES = ['auto', 'static', 'command', 'off'];
/** Folders tried, in order, when looking for the page to show. */
const STATIC_ROOTS = ['', 'public', 'dist', 'build', 'www', 'web', 'site', 'out', 'docs', 'app', 'src'];
/** A dev script that needs its own server: serving the source folder as files would not work. */
const BUNDLERS = /^(vite|next|nuxt|react-scripts|webpack|webpack-dev-server|parcel|astro|@sveltejs\/kit|@angular\/cli|gatsby|@remix-run\/dev|@vue\/cli-service|rsbuild|@rsbuild\/core|snowpack|eleventy|@11ty\/eleventy)$/;
const LOCAL_URL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?(\/[^\s]*)?$/i;
const RESERVED = '/__sleeppilot/';
const MAX_LOG_LINES = 300;

/** A clean, forward-slash relative path inside the project, or '' when it is not one. */
export function cleanRelative(value) {
  const raw = String(value ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!raw || raw === '.') return '';
  if (/^[a-z]:/i.test(raw) || raw.startsWith('/')) return '';
  const parts = raw.split('/').filter((p) => p && p !== '.');
  if (parts.some((p) => p === '..')) return '';
  return parts.join('/').slice(0, 300);
}

export function sanitizePreviewConfig(raw = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const url = String(r.url || '').trim();
  return {
    mode: PREVIEW_MODES.includes(r.mode) ? r.mode : 'auto',
    root: cleanRelative(r.root),
    entry: cleanRelative(r.entry),
    command: String(r.command || '').trim().slice(0, 1000),
    url: LOCAL_URL.test(url) ? url.slice(0, 300) : '',
    commandApproved: r.commandApproved === true,
    // Start the (read-only) static preview by itself when a run starts.
    autoStart: r.autoStart !== false,
  };
}

/**
 * Look at a project folder and say how it can be previewed: which folder holds the page, which
 * HTML files exist, and whether the project has a dev-server script.
 */
export async function detectPreview(dir) {
  const root = path.resolve(dir);
  const htmlFiles = [];
  let scanned = 0;
  async function walk(current, depth) {
    if (depth > 3 || scanned > 4000 || htmlFiles.length >= 60) return;
    const entries = await fsp.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (scanned++ > 4000) return;
      if (e.name.startsWith('.')) continue;
      const full = path.join(current, e.name);
      if (e.isDirectory()) {
        if (!IGNORED_DIRS.has(e.name)) await walk(full, depth + 1);
      } else if (e.isFile() && /\.html?$/i.test(e.name) && htmlFiles.length < 60) {
        htmlFiles.push(path.relative(root, full).split(path.sep).join('/'));
      }
    }
  }
  await walk(root, 0);
  // Shallow pages first, index pages before others.
  htmlFiles.sort((a, b) => a.split('/').length - b.split('/').length || (/(^|\/)index\.html?$/i.test(b) ? 1 : 0) - (/(^|\/)index\.html?$/i.test(a) ? 1 : 0) || a.localeCompare(b));

  let pkg = null;
  try {
    pkg = JSON.parse(await fsp.readFile(path.join(root, 'package.json'), 'utf8'));
  } catch {}
  const scripts = pkg?.scripts || {};
  const deps = Object.keys({ ...pkg?.dependencies, ...pkg?.devDependencies });
  const pm = fs.existsSync(path.join(root, 'pnpm-lock.yaml')) ? 'pnpm' : fs.existsSync(path.join(root, 'yarn.lock')) ? 'yarn' : fs.existsSync(path.join(root, 'bun.lockb')) ? 'bun' : 'npm';
  const commands = [];
  for (const name of ['dev', 'start', 'serve', 'preview']) {
    if (!scripts[name]) continue;
    commands.push({ name, command: name === 'start' && pm === 'npm' ? 'npm start' : `${pm} run ${name}`, script: String(scripts[name]).slice(0, 200) });
  }
  const bundler = deps.find((d) => BUNDLERS.test(d)) || null;

  let staticRoot = null;
  for (const candidate of STATIC_ROOTS) {
    if (htmlFiles.includes(candidate ? `${candidate}/index.html` : 'index.html')) {
      staticRoot = candidate;
      break;
    }
  }
  const firstHtml = htmlFiles[0] || null;
  let recommended = 'none';
  let reason = 'No HTML page and no dev-server script were found in this project.';
  let entry = '';
  if (bundler && commands.length) {
    recommended = 'command';
    reason = `The project uses ${bundler}; its pages are built by a dev server (${commands[0].command}).`;
  } else if (staticRoot != null) {
    recommended = 'static';
    entry = 'index.html';
    reason = `index.html found in ${staticRoot ? `${staticRoot}/` : 'the project folder'}.`;
  } else if (firstHtml) {
    recommended = 'static';
    staticRoot = '';
    entry = firstHtml;
    reason = `No index.html; the first page found is ${firstHtml}.`;
  } else if (commands.length) {
    recommended = 'command';
    reason = `package.json has a "${commands[0].name}" script.`;
  }
  return { recommended, root: staticRoot || '', entry, htmlFiles, commands, bundler, packageManager: pkg ? pm : null, reason, detectedAt: Date.now() };
}

/** Combine what the user saved with what was detected into the preview that will actually run. */
export function effectivePreview(config, detected) {
  const c = sanitizePreviewConfig(config);
  const d = detected || { recommended: 'none', root: '', entry: '', commands: [] };
  let mode = c.mode === 'auto' ? d.recommended : c.mode;
  if (mode === 'command' && !c.command && !d.commands?.length && !c.url) mode = d.recommended === 'static' ? 'static' : 'none';
  const usesDetectedRoot = !c.root && !c.entry;
  return {
    mode,
    root: usesDetectedRoot ? d.root || '' : c.root,
    entry: c.entry || (usesDetectedRoot ? d.entry || '' : ''),
    command: c.command || d.commands?.[0]?.command || '',
    url: c.url,
    commandApproved: c.commandApproved,
  };
}

/** The script served to previewed pages: live reload + error reporting to the SleepPilot window. */
const CLIENT_JS = `(() => {
  if (window.__sleepPilotPreview) return;
  window.__sleepPilotPreview = true;
  const tell = (m) => { try { if (window.parent !== window) window.parent.postMessage(Object.assign({ source: 'sleeppilot-preview' }, m), '*'); } catch {} };
  const text = (v) => { try { return v instanceof Error ? (v.stack || v.message) : typeof v === 'string' ? v : JSON.stringify(v); } catch { return String(v); } };
  window.addEventListener('error', (e) => {
    if (e.target && e.target !== window && (e.target.src || e.target.href)) tell({ type: 'error', kind: 'resource', message: 'Failed to load ' + (e.target.src || e.target.href) });
    else tell({ type: 'error', kind: 'exception', message: e.message || 'Script error', where: (e.filename || '').replace(location.origin, '') + (e.lineno ? ':' + e.lineno : '') });
  }, true);
  window.addEventListener('unhandledrejection', (e) => tell({ type: 'error', kind: 'rejection', message: text(e.reason).slice(0, 600) }));
  const original = console.error;
  console.error = function (...args) { tell({ type: 'error', kind: 'console', message: args.map(text).join(' ').slice(0, 600) }); return original.apply(this, args); };
  tell({ type: 'loaded', url: location.pathname + location.search, title: document.title });
  let es;
  const connect = () => {
    es = new EventSource('${RESERVED}live');
    es.onmessage = (m) => {
      let d = {};
      try { d = JSON.parse(m.data); } catch {}
      if (d.type !== 'change') return;
      if (/\\.css$/i.test(d.file || '')) {
        for (const link of document.querySelectorAll('link[rel~="stylesheet"]')) {
          const u = new URL(link.href);
          u.searchParams.set('sp', Date.now());
          link.href = u.href;
        }
        tell({ type: 'reloaded', file: d.file, soft: true });
      } else location.reload();
    };
  };
  connect();
  window.addEventListener('beforeunload', () => es && es.close());
})();
`;

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Add the client script to an HTML document (before </head>, else before </body>, else at the end). */
export function injectClient(html) {
  const tag = `<script src="${RESERVED}client.js"></script>`;
  if (html.includes(`${RESERVED}client.js`)) return html;
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${tag}</head>`);
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, `${tag}</body>`);
  return html + tag;
}

/** Read-only file server for one project folder, with live reload. */
export class StaticPreview extends EventEmitter {
  constructor({ dir, root = '', entry = '' }) {
    super();
    this.mode = 'static';
    this.projectDir = path.resolve(dir);
    this.root = cleanRelative(root);
    this.entry = cleanRelative(entry);
    this.base = path.resolve(this.projectDir, ...this.root.split('/').filter(Boolean));
    this.clients = new Set();
    this.server = null;
    this.watcher = null;
    this.pollTimer = null;
    this.state = 'stopped';
    this.error = null;
    this.port = null;
    this.requests = 0;
    this.changes = 0;
    this.lastChange = null;
    // Last known size + modification time per file. A watcher event that does not change them
    // (Windows reports plain reads when last-access times are on) must not reload the page —
    // otherwise serving the page would trigger a reload, which serves it again, endlessly.
    this.signatures = new Map();
    this.startedAt = null;
  }

  get url() {
    if (!this.port) return null;
    const page = this.entry && this.entry !== 'index.html' ? this.entry.split('/').map(encodeURIComponent).join('/') : '';
    return `http://127.0.0.1:${this.port}/${page}`;
  }

  async start(preferredPort = 0) {
    const st = await fsp.stat(this.base).catch(() => null);
    if (!st?.isDirectory()) throw new Error(`The preview folder does not exist: ${this.root || '(project folder)'}`);
    this.realBase = await fsp.realpath(this.base);
    this.server = http.createServer((req, res) => this.handle(req, res).catch(() => !res.headersSent && res.writeHead(500).end()));
    await new Promise((resolve, reject) => {
      const tryListen = (port) => {
        const onError = (err) => (port !== 0 && (err.code === 'EADDRINUSE' || err.code === 'EACCES') ? tryListen(0) : reject(err));
        this.server.once('error', onError);
        this.server.listen(port, '127.0.0.1', () => {
          this.server.off('error', onError);
          resolve();
        });
      };
      tryListen(preferredPort);
    });
    this.port = this.server.address().port;
    this.state = 'running';
    this.startedAt = Date.now();
    this.watch();
    this.pingTimer = setInterval(() => {
      for (const res of this.clients) res.write(': ping\n\n');
    }, 20_000);
    this.pingTimer.unref?.();
    return this;
  }

  /** Path inside the served folder for a request, or null when it must not be served. */
  resolveRequest(pathname) {
    let rel;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      return null;
    }
    if (rel.includes('\0')) return null;
    const parts = rel.split('/').filter(Boolean);
    // Dot files and folders (.git, .env, …) are never served, wherever they are.
    if (parts.some((p) => p === '..' || (p.startsWith('.') && p !== '.well-known'))) return null;
    const full = path.resolve(this.base, ...parts);
    if (full !== this.base && !full.startsWith(this.base + path.sep)) return null;
    return full;
  }

  async handle(req, res) {
    this.requests++;
    const host = String(req.headers.host || '');
    // Only loopback names: blocks DNS-rebinding pages from reading local project files.
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host)) {
      res.writeHead(421).end('Misdirected request');
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' }).end();
      return;
    }
    const url = new URL(req.url, 'http://preview');
    if (url.pathname === `${RESERVED}client.js`) {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' }).end(CLIENT_JS);
      return;
    }
    if (url.pathname === `${RESERVED}live`) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(': connected\n\n');
      this.clients.add(res);
      req.on('close', () => this.clients.delete(res));
      return;
    }
    let full = this.resolveRequest(url.pathname);
    if (!full) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end('Not served by the preview.');
      return;
    }
    let st = await fsp.stat(full).catch(() => null);
    if (st?.isDirectory()) {
      if (!url.pathname.endsWith('/')) {
        res.writeHead(302, { location: `${url.pathname}/${url.search}` }).end();
        return;
      }
      const isRoot = full === this.base;
      const candidates = isRoot && this.entry ? [this.entry, 'index.html', 'index.htm'] : ['index.html', 'index.htm'];
      let found = null;
      for (const c of candidates) {
        const f = path.resolve(full, ...c.split('/'));
        if ((await fsp.stat(f).catch(() => null))?.isFile()) {
          found = f;
          break;
        }
      }
      if (!found) {
        const body = await this.listing(full);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(req.method === 'HEAD' ? undefined : body);
        return;
      }
      full = found;
      st = await fsp.stat(full);
    }
    if (st?.isFile()) this.signatures.set(full, fileSignature(st));
    if (!st?.isFile()) {
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(injectClient(`<!doctype html><meta charset="utf-8"><title>Not found</title><body style="font-family:system-ui;padding:24px;color:#333"><h3>Not found</h3><p><code>${escapeHtml(url.pathname)}</code> does not exist in the previewed folder yet. This page reloads when the file appears.</p></body>`));
      return;
    }
    // A link that leaves the folder (symlink to elsewhere on the disk) is not followed.
    const real = await fsp.realpath(full).catch(() => null);
    if (!real || (real !== this.realBase && !real.startsWith(this.realBase + path.sep))) {
      res.writeHead(403).end();
      return;
    }
    const ext = path.extname(full).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    const headers = { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'accept-ranges': 'bytes' };
    if (ext === '.html' || ext === '.htm') {
      const html = injectClient(await fsp.readFile(full, 'utf8'));
      const buf = Buffer.from(html, 'utf8');
      delete headers['accept-ranges'];
      res.writeHead(200, { ...headers, 'content-length': buf.length }).end(req.method === 'HEAD' ? undefined : buf);
      return;
    }
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
    if (range && st.size > 0 && (range[1] || range[2])) {
      let start = range[1] ? Number(range[1]) : Math.max(0, st.size - Number(range[2]));
      let end = range[1] && range[2] ? Number(range[2]) : st.size - 1;
      end = Math.min(end, st.size - 1);
      if (start > end || start >= st.size) {
        res.writeHead(416, { 'content-range': `bytes */${st.size}` }).end();
        return;
      }
      res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${st.size}`, 'content-length': end - start + 1 });
      if (req.method === 'HEAD') return void res.end();
      fs.createReadStream(full, { start, end }).on('error', () => res.destroy()).pipe(res);
      return;
    }
    res.writeHead(200, { ...headers, 'content-length': st.size });
    if (req.method === 'HEAD') return void res.end();
    fs.createReadStream(full).on('error', () => res.destroy()).pipe(res);
  }

  /** Shown for a folder without an index page: the pages and folders that can be opened. */
  async listing(dir) {
    const entries = (await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])).filter((e) => !e.name.startsWith('.') && !IGNORED_DIRS.has(e.name));
    const rel = path.relative(this.base, dir).split(path.sep).join('/');
    const rows = entries
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      .slice(0, 300)
      .map((e) => `<li><a href="${encodeURIComponent(e.name)}${e.isDirectory() ? '/' : ''}">${escapeHtml(e.name)}${e.isDirectory() ? '/' : ''}</a></li>`)
      .join('');
    return injectClient(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Preview — ${escapeHtml(rel || 'project')}</title><style>body{font-family:system-ui,sans-serif;padding:24px;color:#223;background:#f6f7fb}a{color:#1a56c4;text-decoration:none}li{padding:3px 0}code{background:#e8eaf2;padding:1px 5px;border-radius:4px}</style></head><body><h3>No index.html here yet</h3><p>Folder: <code>/${escapeHtml(rel)}</code>. This page reloads by itself when files change.</p><ul>${rel ? '<li><a href="../">../</a></li>' : ''}${rows || '<li>(empty)</li>'}</ul></body></html>`);
  }

  /** A raw watcher event: only a real content change (size or modification time) counts. */
  async onWatchEvent(filename) {
    const rel = String(filename || '');
    if (!rel) return this.notifyChange('');
    const full = path.resolve(this.base, rel);
    if (full !== this.base && !full.startsWith(this.base + path.sep)) return;
    const st = await fsp.stat(full).catch(() => null);
    if (st?.isDirectory()) return; // the files inside report their own events
    const signature = st ? fileSignature(st) : 'deleted';
    if (this.signatures.get(full) === signature) return;
    this.signatures.set(full, signature);
    this.notifyChange(rel);
  }

  notifyChange(file) {
    const rel = String(file || '').split(path.sep).join('/');
    const parts = rel.split('/');
    if (parts.some((p) => p.startsWith('.') || p === 'node_modules')) return;
    if (/~$|\.tmp$|\.swp$|\.crdownload$/i.test(rel)) return;
    this.pendingFile = this.pendingFile && this.pendingFile !== rel ? '*' : rel;
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      const changed = this.pendingFile === '*' ? '' : this.pendingFile;
      this.pendingFile = null;
      this.changes++;
      this.lastChange = { at: Date.now(), file: changed || null };
      const line = `data: ${JSON.stringify({ type: 'change', file: changed })}\n\n`;
      for (const res of this.clients) res.write(line);
      this.emit('change', this.lastChange);
    }, 250);
    this.debounce.unref?.();
  }

  watch() {
    try {
      this.watcher = fs.watch(this.base, { recursive: true }, (_event, filename) => {
        this.onWatchEvent(filename || '').catch(() => {});
      });
      this.watcher.on('error', () => this.pollFallback());
    } catch {
      this.pollFallback();
    }
  }

  /** Recursive fs.watch is not available everywhere; compare modification times instead. */
  pollFallback() {
    this.watcher?.close?.();
    this.watcher = null;
    if (this.pollTimer || this.state !== 'running') return;
    let previous = null;
    const scan = async () => {
      const seen = new Map();
      let count = 0;
      const walk = async (dir, depth) => {
        if (depth > 6 || count > 5000) return;
        for (const e of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
          if (e.name.startsWith('.') || IGNORED_DIRS.has(e.name)) continue;
          const full = path.join(dir, e.name);
          if (e.isDirectory()) await walk(full, depth + 1);
          else if (e.isFile() && count++ < 5000) {
            const st = await fsp.stat(full).catch(() => null);
            if (st) seen.set(full, st.mtimeMs + ':' + st.size);
          }
        }
      };
      await walk(this.base, 0);
      if (previous) {
        for (const [f, sig] of seen) if (previous.get(f) !== sig) this.notifyChange(path.relative(this.base, f));
        for (const f of previous.keys()) if (!seen.has(f)) this.notifyChange(path.relative(this.base, f));
      }
      previous = seen;
    };
    this.pollTimer = setInterval(() => scan().catch(() => {}), 1500);
    this.pollTimer.unref?.();
    scan().catch(() => {});
  }

  view() {
    return { mode: 'static', state: this.state, url: this.url, port: this.port, root: this.root, entry: this.entry, startedAt: this.startedAt, requests: this.requests, changes: this.changes, lastChange: this.lastChange, viewers: this.clients.size, error: this.error, liveReload: true };
  }

  async stop() {
    this.state = 'stopped';
    clearTimeout(this.debounce);
    clearInterval(this.pingTimer);
    clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.watcher?.close?.();
    this.watcher = null;
    for (const res of this.clients) res.end();
    this.clients.clear();
    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    }
  }
}

const fileSignature = (st) => `${st.size}:${Math.round(st.mtimeMs)}`;

const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g, '');

/** Find the first local URL a dev server printed ("Local: http://localhost:5173/"). */
export function findLocalUrl(text) {
  const m = stripAnsi(text).match(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):\d{2,5}[^\s'"<>)\]]*/i);
  if (!m) return null;
  return m[0].replace('0.0.0.0', 'localhost').replace(/\[::\]/, 'localhost').replace(/[.,;]+$/, '');
}

/** The project's own dev server, started with a command the user approved. */
export class CommandPreview extends EventEmitter {
  constructor({ dir, command, url = '' }) {
    super();
    this.mode = 'command';
    this.projectDir = path.resolve(dir);
    this.command = String(command || '').trim();
    this.configuredUrl = url || '';
    this.url = url || null;
    this.state = 'stopped';
    this.error = null;
    this.child = null;
    this.lines = [];
    this.startedAt = null;
    this.exitCode = null;
  }

  async start() {
    if (!this.command) throw new Error('No preview command is set.');
    const win = process.platform === 'win32';
    const file = win ? process.env.ComSpec || 'cmd.exe' : '/bin/sh';
    const args = win ? ['/d', '/s', '/c', `"${this.command}"`] : ['-c', this.command];
    // BROWSER=none: dev servers must not open their own browser tab; the preview pane shows the page.
    this.child = spawn(file, args, {
      cwd: this.projectDir,
      env: { ...process.env, BROWSER: 'none', FORCE_COLOR: '0', NO_COLOR: '1' },
      windowsHide: true,
      windowsVerbatimArguments: win,
      detached: !win,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.state = this.url ? 'running' : 'starting';
    this.startedAt = Date.now();
    let partial = '';
    const onData = (d) => {
      partial += d.toString('utf8');
      const parts = partial.split(/\r?\n/);
      partial = parts.pop() || '';
      for (const raw of parts) this.addLine(raw);
    };
    this.child.stdout.on('data', onData);
    this.child.stderr.on('data', onData);
    this.child.once('error', (err) => {
      this.state = 'failed';
      this.error = `Could not start the command: ${err.message}`;
      this.emit('update');
    });
    this.child.once('close', (code) => {
      if (partial) this.addLine(partial);
      this.exitCode = code;
      if (this.state !== 'stopped') {
        this.state = 'exited';
        this.error = `The preview command ended${code == null ? '' : ` with code ${code}`}.`;
      }
      this.child = null;
      this.emit('update');
    });
    return this;
  }

  addLine(raw) {
    const line = redact(stripAnsi(raw)).slice(0, 500);
    if (!line.trim()) return;
    this.lines.push(line);
    if (this.lines.length > MAX_LOG_LINES) this.lines.splice(0, this.lines.length - MAX_LOG_LINES);
    if (!this.url) {
      const found = findLocalUrl(line);
      if (found) {
        this.url = found;
        this.state = 'running';
      }
    }
    clearTimeout(this.notifyTimer);
    this.notifyTimer = setTimeout(() => this.emit('update'), 150);
    this.notifyTimer.unref?.();
  }

  view() {
    return { mode: 'command', state: this.state, url: this.url, command: this.command, startedAt: this.startedAt, exitCode: this.exitCode, error: this.error, log: this.lines.slice(-80), liveReload: false };
  }

  async stop() {
    this.state = 'stopped';
    clearTimeout(this.notifyTimer);
    const child = this.child;
    this.child = null;
    if (child?.pid) {
      killTree(child.pid);
      await new Promise((resolve) => {
        const t = setTimeout(resolve, 3000);
        child.once('close', () => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  }
}

/** A stable preferred port per project, so a previewed app keeps its localStorage between starts. */
export function preferredPreviewPort(projectId) {
  return 47900 + (parseInt(sha1(String(projectId)).slice(0, 6), 16) % 900);
}

/** Owns the running previews: at most one per project, a few at a time. */
export class PreviewManager extends EventEmitter {
  constructor({ max = 6 } = {}) {
    super();
    this.max = max;
    this.previews = new Map(); // projectId -> { preview, startedAt }
  }

  view(projectId) {
    const rec = this.previews.get(projectId);
    return rec ? { running: rec.preview.state === 'running' || rec.preview.state === 'starting', ...rec.preview.view() } : { running: false, state: 'stopped', mode: null, url: null };
  }

  running() {
    return [...this.previews.entries()].map(([projectId, rec]) => ({ projectId, ...rec.preview.view() }));
  }

  async start(project, plan) {
    await this.stop(project.id);
    if (plan.mode !== 'static' && plan.mode !== 'command') throw new Error('Nothing to preview yet: this project has no HTML page and no preview command. The preview becomes available as soon as a page exists.');
    while (this.previews.size >= this.max) {
      const oldest = [...this.previews.entries()].sort((a, b) => a[1].startedAt - b[1].startedAt)[0];
      await this.stop(oldest[0]);
    }
    let preview;
    if (plan.mode === 'static') {
      preview = new StaticPreview({ dir: project.dir, root: plan.root, entry: plan.entry });
      await preview.start(preferredPreviewPort(project.id));
      preview.on('change', () => this.emit('update', { projectId: project.id, view: this.view(project.id), change: true }));
    } else {
      if (!plan.commandApproved) throw new Error('The preview command runs project code on this computer. Approve it first (Preview → Settings → "I approve running this command").');
      preview = new CommandPreview({ dir: project.dir, command: plan.command, url: plan.url });
      await preview.start();
      preview.on('update', () => this.emit('update', { projectId: project.id, view: this.view(project.id) }));
    }
    this.previews.set(project.id, { preview, startedAt: Date.now() });
    log.info(`preview started for ${project.id} (${plan.mode}${preview.url ? ` · ${preview.url}` : ''})`);
    this.emit('update', { projectId: project.id, view: this.view(project.id) });
    return this.view(project.id);
  }

  async stop(projectId) {
    const rec = this.previews.get(projectId);
    if (!rec) return this.view(projectId);
    this.previews.delete(projectId);
    await rec.preview.stop().catch(() => {});
    rec.preview.removeAllListeners();
    this.emit('update', { projectId, view: this.view(projectId) });
    return this.view(projectId);
  }

  async stopAll() {
    for (const id of [...this.previews.keys()]) await this.stop(id);
  }
}
