import fsp from 'node:fs/promises';
import { credentialsFile } from '../util/paths.mjs';
import { readJson, writeJsonAtomic } from '../util/fsx.mjs';
import { registerSecret } from '../util/redact.mjs';

/**
 * Provider credentials, stored separately from settings.json and never returned to the UI.
 * `hasKey` is what the interface shows; the secret itself only leaves this process in an
 * Authorization header. Environment variables are used as a fallback and never copied to disk.
 */
export class CredentialStore {
  constructor() {
    this.data = { providers: {}, env: {} };
    this.loaded = false;
  }

  async load() {
    if (this.loaded) return this;
    this.data = await readJson(credentialsFile(), { providers: {}, env: {} }).catch(() => ({ providers: {}, env: {} }));
    this.data.providers ||= {};
    this.data.env ||= {};
    for (const v of [...Object.values(this.data.providers), ...Object.values(this.data.env)]) registerSecret(v);
    this.loaded = true;
    return this;
  }

  async save() {
    const file = credentialsFile();
    await writeJsonAtomic(file, this.data);
    // Best effort: the file is already inside the per-user application data folder.
    await fsp.chmod(file, 0o600).catch(() => {});
  }

  /** Secret for a provider id: stored value, else the configured environment variable. */
  get(providerId, envName) {
    const stored = this.data.providers?.[providerId];
    if (stored) return stored;
    if (envName && process.env[envName]) return process.env[envName];
    return '';
  }

  has(providerId, envName) {
    return !!this.get(providerId, envName);
  }

  async set(providerId, secret) {
    if (!secret) delete this.data.providers[providerId];
    else {
      this.data.providers[providerId] = String(secret);
      registerSecret(String(secret));
    }
    await this.save();
  }

  getEnv(name) {
    return this.data.env?.[name] || process.env[name] || '';
  }

  async setEnv(name, value) {
    const clean = String(name || '').trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(clean)) throw new Error('Environment variable names may only contain letters, digits and underscores.');
    if (!value) delete this.data.env[clean];
    else {
      this.data.env[clean] = String(value);
      registerSecret(String(value));
    }
    await this.save();
  }

  /** Names of stored environment secrets (values are never exposed). */
  envNames() {
    return Object.keys(this.data.env || {});
  }
}
