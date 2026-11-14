import { EventEmitter } from 'node:events';
import { redact } from '../util/redact.mjs';

/**
 * Common surface of every execution backend ("engine").
 *
 * SleepPilot's orchestrator only knows this interface. OpenCode was the first backend; the
 * built-in API engine, the DeepSeek Harness bridge and the generic command harness implement the
 * same methods, so a run can be planned, supervised and recovered identically whichever engine
 * executes a turn.
 *
 * A turn is one prompt -> one complete answer (possibly with many tool calls). Durable
 * reconciliation is the engine's job: `turnMessages()` must be able to answer, after a crash,
 * "what happened to message X in session Y?" without re-sending it.
 *
 * Optional multi-harness contract (all methods already receive these fields from the router):
 *   createSession({ effort, readOnly })  apply a real effort level and enforce a read-only role
 *   runTurn(...).quota                   { exhausted, resetsAt, window, message } on usage exhaustion
 * Engines that cannot honour `effort` or `readOnly` must throw a clear configuration error; they
 * must never silently ignore either field.
 */
export class AgentEngine extends EventEmitter {
  constructor({ id, label, settings = {}, secrets = {} } = {}) {
    super();
    this.id = id;
    this.label = label;
    this.settings = settings;
    this.secrets = secrets;
    this.status = { state: 'disconnected', message: 'Not connected' };
    this.detection = null;
    this.models = [];
    this.agents = [];
    this.defaultModel = null;
    this.capabilities = {};
    this.serverInfo = null;
    this.sessionListeners = new Map();
    this.testCommand = undefined;
    this.client = {
      has: (op) => !!this.capabilities[op],
      ops: {},
    };
  }

  setStatus(state, message, extra = {}) {
    this.status = { state, message, at: Date.now(), ...extra };
    this.emit('status', this.status);
  }

  get connected() {
    return this.status.state === 'connected';
  }

  /** Public description used by the UI and by run records. */
  info() {
    return {
      id: this.id,
      label: this.label,
      status: this.status,
      detection: this.detection
        ? {
            found: !!this.detection.found,
            path: this.detection.path || null,
            source: this.detection.source || null,
            version: this.detection.version?.raw || null,
            support: this.detection.support || null,
          }
        : null,
      version: this.serverInfo?.version || this.status.version || null,
      models: this.models,
      agents: this.agents,
      defaultModel: this.defaultModel,
      capabilities: this.capabilities,
    };
  }

  dispatchEvent(ev) {
    const sid = ev?.data?.sessionID || ev?.sessionID;
    if (sid && this.sessionListeners.has(sid)) for (const fn of this.sessionListeners.get(sid)) fn(ev);
    this.emit('event', ev);
  }

  onSession(sessionID, fn) {
    if (!this.sessionListeners.has(sessionID)) this.sessionListeners.set(sessionID, new Set());
    this.sessionListeners.get(sessionID).add(fn);
    return () => this.sessionListeners.get(sessionID)?.delete(fn);
  }

  requireConnected() {
    if (!this.connected) {
      const err = new Error(`${this.label} is not connected: ${this.status.message}`);
      err.name = 'EngineConnectionError';
      err.code = 'ENGINE_DISCONNECTED';
      throw err;
    }
  }

  /** Wait until this engine reconnects; rejects with code CONNECTION_LOST after timeoutMs. */
  async waitConnected(timeoutMs = 5 * 60_000) {
    if (this.connected) return;
    await new Promise((resolve, reject) => {
      const on = (s) => {
        if (s.state === 'connected') {
          clearTimeout(t);
          this.off('status', on);
          resolve();
        }
      };
      const t = setTimeout(() => {
        this.off('status', on);
        const err = new Error(`${this.label} did not reconnect in time.`);
        err.code = 'CONNECTION_LOST';
        err.name = 'EngineConnectionError';
        reject(err);
      }, timeoutMs);
      this.on('status', on);
    });
  }

  async connect() {
    throw new Error(`${this.label}: connect() is not implemented.`);
  }

  async disconnect() {}

  async refreshCatalog() {}

  async createSession() {
    throw new Error(`${this.label}: sessions are not supported.`);
  }

  async runTurn() {
    throw new Error(`${this.label}: runTurn() is not implemented.`);
  }

  async turnMessages() {
    return { found: false, user: null, after: [] };
  }

  async isActive() {
    return false;
  }

  async interrupt() {
    return { supported: false, interrupted: false };
  }

  async listPermissions() {
    return [];
  }

  async replyPermission() {
    throw new Error('Permission replies are not supported.');
  }

  async listForms() {
    return [];
  }

  async replyForm() {
    throw new Error('Forms are not supported.');
  }

  async cancelForm() {
    return false;
  }

  async sessionDiff() {
    return null;
  }

  async usageLimits() {
    return { supported: false, data: null };
  }

  /** Last-resort message sanitation for errors surfaced to the UI. */
  safeMessage(err) {
    return redact(err?.message || String(err));
  }
}

/** Evaluate an OpenCode-style ruleset ({action, resource, effect}, last match wins, default ask). */
export function matchRule(rule, action, resource) {
  return wildcard(rule.action).test(action) && wildcard(rule.resource).test(resource);
}

export function wildcard(pattern) {
  return new RegExp(
    '^' +
      String(pattern)
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.') +
      '$',
    's',
  );
}

export function evaluateRules(rules, action, resource) {
  let effect = 'ask';
  for (const r of rules || []) if (matchRule(r, action, resource)) effect = r.effect;
  return effect;
}
