import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { dataRoot } from '../util/paths.mjs';
import { readJson, writeJsonAtomic } from '../util/fsx.mjs';
import { secret } from '../util/ids.mjs';
import { qrSvg } from '../util/qr.mjs';
import { logger } from '../util/log.mjs';

const log = logger('phone');
export const DEFAULT_PHONE_PORT = 47820;
const RETRY_MS = 60_000;

/** Tailscale hands out addresses from the 100.64.0.0/10 shared range. */
export function isTailnetAddress(ip) {
  const m = String(ip || '').replace(/^::ffff:/, '').match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  return !!m && Number(m[1]) === 100 && Number(m[2]) >= 64 && Number(m[2]) <= 127;
}

/** This PC's Tailscale IPv4 address, or null when Tailscale is not running. */
export function findTailscaleAddress(interfaces = os.networkInterfaces()) {
  const found = [];
  for (const [name, list] of Object.entries(interfaces || {})) {
    for (const a of list || []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal && isTailnetAddress(a.address)) found.push({ name, address: a.address });
    }
  }
  return (found.find((f) => /tailscale/i.test(f.name)) || found[0])?.address || null;
}

/**
 * Requests a phone may not make. The phone is a full remote for runs and projects; it cannot read
 * or write API keys, open dialogs on the PC, close the app or change phone access itself.
 */
export function phoneMayCall(method, pathname) {
  if (method === 'GET') return !pathname.startsWith('/api/phone');
  return !/^\/api\/(secrets\/|pick-folder$|app\/close$|phone)/.test(pathname);
}

const tokenFile = () => path.join(dataRoot(), 'phone-access.json');

/**
 * Optional second listener for a phone, bound only to the PC's Tailscale address. Tailscale
 * encrypts the traffic and admits only the user's own devices; on top of that the phone needs a
 * long-lived random token (from the QR code), and the peer must itself be a Tailscale address.
 */
export class PhoneAccess {
  constructor({ app, handle, findAddress = findTailscaleAddress, isPeerAllowed = isTailnetAddress } = {}) {
    this.app = app;
    this.handle = handle;
    this.findAddress = findAddress;
    this.isPeerAllowed = isPeerAllowed;
    this.server = null;
    this.address = null;
    this.port = null;
    this.token = null;
    this.error = null;
    this.timer = null;
    this.busy = Promise.resolve();
  }

  get settings() {
    return this.app.settings?.phone || { enabled: false, port: DEFAULT_PHONE_PORT };
  }

  async loadToken() {
    if (this.token) return this.token;
    const saved = await readJson(tokenFile(), {}).catch(() => ({}));
    if (typeof saved.token === 'string' && saved.token.length >= 32) this.token = saved.token;
    else await this.resetToken();
    return this.token;
  }

  /** A new token signs out every phone that used the old QR code. */
  async resetToken() {
    this.token = secret(32);
    await writeJsonAtomic(tokenFile(), { token: this.token, createdAt: Date.now() });
    return this.token;
  }

  /** Start, stop or move the listener so it matches the settings and the current address. */
  sync() {
    this.busy = this.busy.then(() => this._sync()).catch((err) => log.warn(`phone access: ${err.message}`));
    return this.busy;
  }

  async _sync() {
    clearTimeout(this.timer);
    this.timer = null;
    const { enabled, port } = this.settings;
    if (!enabled) {
      await this._close();
      this.error = null;
      return;
    }
    const address = this.findAddress();
    if (this.server && address === this.address && port === this.port) return;
    await this._close();
    if (!address) {
      this.error = 'no-tailscale';
      this._retryLater();
      return;
    }
    await this.loadToken();
    const server = http.createServer((req, res) => this._serve(req, res));
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, address, () => {
          server.off('error', reject);
          resolve();
        });
      });
    } catch (err) {
      this.error = err.code === 'EADDRINUSE' ? 'port-in-use' : `listen-failed: ${err.message}`;
      this._retryLater();
      return;
    }
    this.server = server;
    this.address = address;
    this.port = server.address().port;
    this.error = null;
    log.info(`phone access on http://${address}:${this.port}/`);
    // Tailscale can reconnect with another address (or stop); keep checking.
    this._retryLater();
  }

  _retryLater() {
    if (!this.settings.enabled) return;
    this.timer = setTimeout(() => this.sync(), RETRY_MS);
    this.timer.unref?.();
  }

  async _close() {
    const s = this.server;
    this.server = null;
    this.address = null;
    this.port = null;
    if (s) await new Promise((r) => (s.closeAllConnections?.(), s.close(() => r())));
  }

  _serve(req, res) {
    if (!this.isPeerAllowed(req.socket.remoteAddress)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end('Only devices on your Tailscale network may connect.');
      return;
    }
    return this.handle(req, res, {
      remote: true,
      token: this.token,
      cookie: 'sp_phone',
      // A year, so the phone stays signed in; "Reset" in Settings revokes it.
      maxAge: 365 * 24 * 3600,
      hostOk: (host) => host === `${this.address}:${this.port}`,
    });
  }

  /** What the Settings screen on the PC shows. The link contains the token. */
  view() {
    const { enabled, port } = this.settings;
    const url = this.server ? `http://${this.address}:${this.port}/?t=${this.token}` : null;
    return {
      enabled,
      port,
      listening: !!this.server,
      address: this.address || this.findAddress(),
      error: this.error,
      url,
      bookmark: this.server ? `http://${this.address}:${this.port}/` : null,
      qr: url ? qrSvg(url, { scale: 5 }) : null,
    };
  }

  async stop() {
    clearTimeout(this.timer);
    this.timer = null;
    await this.busy;
    await this._close();
  }
}
