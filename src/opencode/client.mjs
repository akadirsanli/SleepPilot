import { EventEmitter } from 'node:events';
import { logger } from '../util/log.mjs';

const log = logger('opencode-client');

export class OpenCodeHttpError extends Error {
  constructor(status, body, op) {
    const tag = body && typeof body === 'object' ? body._tag : undefined;
    const msg = body && typeof body === 'object' ? body.message : String(body || '').slice(0, 300);
    super(`OpenCode ${op}: HTTP ${status}${tag ? ` ${tag}` : ''}${msg ? ` — ${msg}` : ''}`);
    // The orchestrator recognises OpenCode errors by name; without it they were treated as crashes.
    this.name = 'OpenCodeHttpError';
    this.status = status;
    this.body = body;
    this.tag = tag;
    this.op = op;
  }
}

export class OpenCodeConnectionError extends Error {
  constructor(op, cause) {
    super(`Could not reach the OpenCode server (${op}): ${cause?.message || cause}`);
    this.name = 'OpenCodeConnectionError';
    this.op = op;
    this.cause = cause;
  }
}

/**
 * Operations SleepPilot uses. The method/path here are only fallbacks: at connect time the
 * client reads the server's own /openapi.json and resolves every operation by operationId,
 * so SleepPilot never calls an endpoint the installed server does not declare.
 */
export const OPERATIONS = {
  'server.info': { method: 'GET', path: '/api/info', required: true },
  'session.create': { method: 'POST', path: '/api/session', required: true },
  'session.get': { method: 'GET', path: '/api/session/{sessionID}', required: true },
  'session.prompt': { method: 'POST', path: '/api/session/{sessionID}/prompt', required: true },
  'session.message.list': { method: 'GET', path: '/api/session/{sessionID}/message', required: true },
  'session.active': { method: 'GET', path: '/api/session/active', required: true },
  'session.permission.list': { method: 'GET', path: '/api/session/{sessionID}/permission', required: true },
  'session.permission.reply': { method: 'POST', path: '/api/session/{sessionID}/permission/{requestID}/reply', required: true },
  'event.subscribe': { method: 'GET', path: '/api/event', required: true },
  'model.list': { method: 'GET', path: '/api/model', required: true },
  'agent.list': { method: 'GET', path: '/api/agent', required: true },
  'session.interrupt': { method: 'POST', path: '/api/session/{sessionID}/interrupt' },
  'session.form.list': { method: 'GET', path: '/api/session/{sessionID}/form' },
  'session.form.reply': { method: 'POST', path: '/api/session/{sessionID}/form/{formID}/reply' },
  'session.form.cancel': { method: 'DELETE', path: '/api/session/{sessionID}/form/{formID}' },
  'session.diff': { method: 'GET', path: '/api/session/{sessionID}/diff' },
  'model.default': { method: 'GET', path: '/api/model/default' },
  'experimental.usage.limits': { method: 'GET', path: '/api/experimental/usage/limits' },
};

export class OpenCodeClient extends EventEmitter {
  constructor({ url, password, username = 'opencode', requestTimeoutMs = 60_000 }) {
    super();
    this.url = url.replace(/\/$/, '');
    this.auth = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
    this.requestTimeoutMs = requestTimeoutMs;
    this.ops = Object.fromEntries(Object.entries(OPERATIONS).map(([k, v]) => [k, { ...v, available: undefined }]));
    this.sse = null;
  }

  /** Read /openapi.json and record which operations exist. Returns { ok, missing[], optionalMissing[] }. */
  async loadCapabilities() {
    const spec = await this.raw('GET', '/openapi.json', { op: 'openapi' });
    const byId = new Map();
    for (const [p, methods] of Object.entries(spec.paths || {})) {
      for (const [m, def] of Object.entries(methods)) if (def?.operationId) byId.set(def.operationId, { method: m.toUpperCase(), path: p, def });
    }
    const missing = [];
    const optionalMissing = [];
    for (const [id, op] of Object.entries(this.ops)) {
      const found = byId.get(id);
      if (found) {
        op.method = found.method;
        op.path = found.path;
        op.available = true;
      } else {
        op.available = false;
        (op.required ? missing : optionalMissing).push(id);
      }
    }
    this.specInfo = { title: spec.info?.title, version: spec.info?.version };
    return { ok: missing.length === 0, missing, optionalMissing };
  }

  has(opId) {
    return this.ops[opId]?.available === true;
  }

  async call(opId, { params = {}, query, body, timeoutMs } = {}) {
    const op = this.ops[opId];
    if (!op) throw new Error(`Unknown operation ${opId}`);
    if (op.available === false) throw new Error(`This OpenCode version does not support the '${opId}' operation.`);
    const p = op.path.replace(/\{(\w+)\}/g, (_, k) => {
      if (params[k] == null) throw new Error(`${opId}: missing path param ${k}`);
      return encodeURIComponent(params[k]);
    });
    return this.raw(op.method, p + encodeQuery(query), { body, op: opId, timeoutMs });
  }

  async raw(method, p, { body, op = p, timeoutMs } = {}) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs ?? this.requestTimeoutMs);
    let res;
    try {
      res = await fetch(this.url + p, {
        method,
        headers: { authorization: this.auth, accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ac.signal,
      });
    } catch (err) {
      throw new OpenCodeConnectionError(op, err.name === 'AbortError' ? new Error('timed out') : err);
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let data = text;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {}
    if (!res.ok) throw new OpenCodeHttpError(res.status, data, op);
    return data;
  }

  /**
   * Subscribe to the server's SSE stream. The stream is volatile by contract, so on every
   * (re)connect a 'connected' event is emitted and consumers must reconcile from durable state.
   */
  startEvents() {
    if (this.sse) return;
    const state = { stopped: false, ac: null, attempt: 0 };
    this.sse = state;
    const loop = async () => {
      while (!state.stopped) {
        state.ac = new AbortController();
        try {
          const op = this.ops['event.subscribe'];
          const res = await fetch(this.url + op.path, { headers: { authorization: this.auth, accept: 'text/event-stream' }, signal: state.ac.signal });
          if (!res.ok) throw new OpenCodeHttpError(res.status, await res.text(), 'event.subscribe');
          state.attempt = 0;
          this.emit('stream', { status: 'connected' });
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buf = '';
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            let i;
            while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
              const chunk = buf.slice(0, i);
              buf = buf.slice(i).replace(/^\r?\n\r?\n/, '');
              const data = chunk
                .split(/\r?\n/)
                .filter((l) => l.startsWith('data:'))
                .map((l) => l.slice(5).replace(/^ /, ''))
                .join('\n');
              if (!data) continue;
              let ev;
              try {
                ev = JSON.parse(data);
              } catch {
                continue;
              }
              this.emit('event', ev);
            }
          }
          if (!state.stopped) throw new Error('event stream ended');
        } catch (err) {
          if (state.stopped) break;
          state.attempt++;
          const delay = Math.min(30_000, 500 * 2 ** Math.min(state.attempt, 6));
          log.warn(`event stream lost (${err.message}); reconnecting in ${delay}ms`);
          this.emit('stream', { status: 'disconnected', error: err.message, retryInMs: delay });
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    };
    loop();
  }

  stopEvents() {
    if (!this.sse) return;
    this.sse.stopped = true;
    this.sse.ac?.abort();
    this.sse = null;
  }
}

function encodeQuery(query) {
  if (!query) return '';
  const parts = [];
  const add = (k, v) => {
    if (v === undefined || v === null) return;
    if (typeof v === 'object' && !Array.isArray(v)) {
      for (const [kk, vv] of Object.entries(v)) add(`${k}[${kk}]`, vv);
    } else parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  };
  for (const [k, v] of Object.entries(query)) add(k, v);
  return parts.length ? '?' + parts.join('&') : '';
}
