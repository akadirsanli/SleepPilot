import { EventEmitter } from 'node:events';
import { detectOpenCode } from './detect.mjs';
import { OpenCodeServerProcess } from './server-process.mjs';
import { OpenCodeClient } from './client.mjs';
import { classifyError } from './errors.mjs';
import { newMessageId } from '../util/ids.mjs';
import { logger } from '../util/log.mjs';
import { redact } from '../util/redact.mjs';

const log = logger('adapter');
const POLL_MS = Number(process.env.SLEEPPILOT_POLL_MS || 4000);
const STARTUP_RETRIES = 15;
const STARTUP_RETRY_MS = Number(process.env.SLEEPPILOT_STARTUP_RETRY_MS || 2000);

/**
 * OpenCode lists many models twice: once under "opencode" (Zen, billed to pay-as-you-go credits)
 * and once under "opencode-go" (covered by the OpenCode Go subscription), with the same name.
 * Picking the wrong one fails with "Insufficient balance", so the model picker spells it out.
 */
export const PROVIDER_LABELS = {
  'opencode-go': 'OpenCode Go (subscription)',
  opencode: 'OpenCode Zen (pay-as-you-go credits)',
};

/**
 * High-level OpenCode 2.x integration used by the orchestrator.
 * Owns a private loopback server, exposes capability/status info, and runs "turns"
 * (one prompt → wait for idle → durable reconciliation).
 */
export class OpenCodeAdapter extends EventEmitter {
  constructor({ settings, testCommand } = {}) {
    super();
    this.settings = settings || {};
    this.testCommand = testCommand; // { exe, args } for the explicit test mode fake server
    this.status = { state: 'disconnected', message: 'Not connected' };
    this.detection = null;
    this.server = null;
    this.client = null;
    this.capabilities = null;
    this.models = [];
    this.agents = [];
    this.defaultModel = null;
    this.serverInfo = null;
    this.restarts = 0;
    this.generation = 0; // bumped by disconnect(): a connect still in progress then gives up
    this.sessionListeners = new Map(); // sessionID -> Set<fn>
  }

  setStatus(state, message, extra = {}) {
    this.status = { state, message, at: Date.now(), ...extra };
    this.emit('status', this.status);
  }

  get connected() {
    return this.status.state === 'connected';
  }

  async connect() {
    if (this.connecting) return this.connecting;
    this.connecting = this._connect().finally(() => (this.connecting = null));
    return this.connecting;
  }

  async _connect() {
    await this.disconnect();
    const gen = this.generation;
    let server = null;
    // Shut down (or reconnected) while this connect was still waiting: never leave a server behind.
    const superseded = async () => {
      if (gen === this.generation) return false;
      await server?.stop();
      if (this.server === server) this.server = null;
      return true;
    };
    this.setStatus('detecting', 'Looking for OpenCode…');
    let command;
    if (this.testCommand) {
      this.detection = {
        found: true,
        path: this.testCommand.exe,
        source: 'TEST MODE (fake OpenCode)',
        version: { raw: 'test-double', major: 2, minor: 0, patch: 0 },
        support: { status: 'test', message: 'Test mode: a fake server is used, not the real OpenCode.' },
        tried: [],
      };
      command = this.testCommand;
    } else {
      this.detection = await detectOpenCode({ override: this.settings.opencodePath });
      if (await superseded()) return this.status;
      if (!this.detection.found || ['unsupported', 'unknown', 'missing'].includes(this.detection.support.status)) {
        this.setStatus('error', this.detection.support.message, { detection: this.detection });
        return this.status;
      }
      command = { exe: this.detection.path };
    }
    this.setStatus('starting', 'Starting the OpenCode server…');
    server = this.server = new OpenCodeServerProcess(command);
    let conn;
    try {
      conn = await server.start();
    } catch (err) {
      if (await superseded()) return this.status;
      this.setStatus('error', `Could not start the OpenCode server: ${redact(err.message)}`);
      return this.status;
    }
    if (await superseded()) return this.status;
    server.on('exit', () => this.onServerExit());
    this.client = new OpenCodeClient({ url: conn.url, password: conn.password });
    try {
      this.capabilities = await this.client.loadCapabilities();
      if (!this.capabilities.ok) {
        this.setStatus('error', `This OpenCode version does not offer the required API operations: ${this.capabilities.missing.join(', ')}`);
        await server.stop();
        return this.status;
      }
      // Seen on 2.2.0 right after start: HTTP 503 "Location plugins did not finish activating".
      // The server is up but still initialising — wait and retry instead of reporting an error.
      for (let attempt = 1; ; attempt++) {
        try {
          this.serverInfo = await this.client.call('server.info');
          await this.refreshCatalog();
          break;
        } catch (err) {
          if (!(err.status === 503 || err.status === 502) || attempt >= STARTUP_RETRIES) throw err;
          this.setStatus('starting', `OpenCode is getting ready (${redact(err.body?.message || err.message).slice(0, 80)}) — retrying (${attempt}/${STARTUP_RETRIES})…`);
          await new Promise((r) => setTimeout(r, STARTUP_RETRY_MS));
        }
      }
    } catch (err) {
      this.setStatus('error', `OpenCode API check failed: ${redact(err.message)}`);
      await server.stop();
      return this.status;
    }
    if (await superseded()) {
      this.client = null;
      return this.status;
    }
    this.client.on('event', (ev) => this.dispatchEvent(ev));
    this.client.on('stream', (s) => this.emit('stream', s));
    this.client.startEvents();
    this.setStatus('connected', `Connected: OpenCode ${this.serverInfo?.version || this.detection.version.raw}`, {
      version: this.serverInfo?.version || this.detection.version.raw,
    });
    return this.status;
  }

  async refreshCatalog(directory) {
    const location = directory ? { directory } : undefined;
    const [models, agents] = await Promise.all([
      this.client.call('model.list', { query: { location } }),
      this.client.call('agent.list', { query: { location } }),
    ]);
    this.models = (models?.data || [])
      .filter((m) => m.enabled !== false)
      .map((m) => ({
        providerID: m.providerID,
        providerLabel: PROVIDER_LABELS[m.providerID] || m.providerID,
        id: m.modelID || m.id,
        name: m.name,
        status: m.status,
        cost: m.cost?.[0] || null,
        context: m.limit?.context,
      }));
    this.agents = (agents?.data || []).filter((a) => !a.hidden).map((a) => ({ id: a.id, name: a.name, mode: a.mode, description: a.description }));
    if (this.client.has('model.default')) {
      const d = await this.client.call('model.default', { query: { location } }).catch(() => null);
      this.defaultModel = d?.data ? { providerID: d.data.providerID, id: d.data.modelID || d.data.id } : null;
    }
  }

  async onServerExit() {
    this.client?.stopEvents();
    this.setStatus('lost', 'Lost the connection to OpenCode (the server process exited).');
    this.emit('lost');
    if (this.restarts < 3) {
      this.restarts++;
      await new Promise((r) => setTimeout(r, 2000 * this.restarts));
      log.warn(`restarting OpenCode server (attempt ${this.restarts})`);
      await this.connect();
      if (this.connected) this.emit('reconnected');
    }
  }

  async disconnect() {
    this.generation++;
    this.client?.stopEvents();
    this.client = null;
    if (this.server) await this.server.stop();
    this.server = null;
    if (this.status.state !== 'disconnected') this.setStatus('disconnected', 'Not connected');
  }

  dispatchEvent(ev) {
    const sid = ev?.data?.sessionID;
    if (sid && this.sessionListeners.has(sid)) for (const fn of this.sessionListeners.get(sid)) fn(ev);
    this.emit('event', ev);
  }

  onSession(sessionID, fn) {
    if (!this.sessionListeners.has(sessionID)) this.sessionListeners.set(sessionID, new Set());
    this.sessionListeners.get(sessionID).add(fn);
    return () => this.sessionListeners.get(sessionID)?.delete(fn);
  }

  requireClient() {
    if (!this.client || !this.connected) {
      const e = new Error('OpenCode is not connected.');
      e.name = 'OpenCodeConnectionError';
      throw e;
    }
    return this.client;
  }

  async createSession({ directory, title, model, agent, permissions, effort = null }) {
    if (effort) throw new Error(`OpenCode does not expose a reasoning-effort flag; requested effort "${effort}" cannot be applied.`);
    const body = { title, location: { directory } };
    if (model?.providerID && model?.id) body.model = { providerID: model.providerID, id: model.id, ...(model.variant ? { variant: model.variant } : {}) };
    if (agent) body.agent = agent;
    if (permissions) body.permissions = permissions;
    const r = await this.requireClient().call('session.create', { body });
    return r.data;
  }

  async getSession(sessionID) {
    return (await this.requireClient().call('session.get', { params: { sessionID } })).data;
  }

  async isActive(sessionID) {
    const r = await this.requireClient().call('session.active');
    return !!r?.data?.[sessionID];
  }

  async interrupt(sessionID) {
    const c = this.requireClient();
    if (!c.has('session.interrupt')) return { supported: false, interrupted: false };
    const r = await c.call('session.interrupt', { params: { sessionID } });
    return { supported: true, interrupted: !!r?.interrupted };
  }

  async listPermissions(sessionID) {
    return (await this.requireClient().call('session.permission.list', { params: { sessionID } }))?.data || [];
  }

  async replyPermission(sessionID, requestID, decision, message) {
    return this.requireClient().call('session.permission.reply', { params: { sessionID, requestID }, body: { decision, ...(message ? { message } : {}) } });
  }

  async listForms(sessionID) {
    const c = this.requireClient();
    if (!c.has('session.form.list')) return [];
    return (await c.call('session.form.list', { params: { sessionID } }))?.data || [];
  }

  async replyForm(sessionID, formID, answer) {
    return this.requireClient().call('session.form.reply', { params: { sessionID, formID }, body: { answer } });
  }

  /** Dismiss a question nobody will answer (OpenCode 2.x `session.form.cancel`). */
  async cancelForm(sessionID, formID) {
    const c = this.requireClient();
    if (!c.has('session.form.cancel')) return false;
    await c.call('session.form.cancel', { params: { sessionID, formID } });
    return true;
  }

  async sessionDiff(sessionID) {
    const c = this.requireClient();
    if (!c.has('session.diff')) return null;
    try {
      return (await c.call('session.diff', { params: { sessionID } }))?.data || [];
    } catch {
      return null;
    }
  }

  /** Go allowance (OpenCode 2.2+). Returns null when unsupported or not signed in — never a guess. */
  async usageLimits(directory) {
    const c = this.client;
    if (!c || !this.connected || !c.has('experimental.usage.limits')) return { supported: false, data: null };
    try {
      const r = await c.call('experimental.usage.limits', { query: { location: directory ? { directory } : undefined } });
      return { supported: true, data: r?.data ?? null, fetchedAt: Date.now() };
    } catch (err) {
      return { supported: true, data: null, error: redact(err.message) };
    }
  }

  /**
   * Fetch the messages that belong to the turn started by `messageId` (oldest → newest).
   * Pages backwards from the newest message until the user message is found.
   */
  async turnMessages(sessionID, messageId) {
    const c = this.requireClient();
    const collected = [];
    let cursor;
    for (let page = 0; page < 50; page++) {
      // Verified on OpenCode 2.2.0: the cursor already carries the order; sending both is rejected
      // with HTTP 400 InvalidCursorError (this ended a real run once a session grew past one page).
      const r = await c.call('session.message.list', { params: { sessionID }, query: cursor ? { limit: 100, cursor } : { limit: 100, order: 'desc' } });
      const data = r?.data || [];
      for (const m of data) {
        if (m.id === messageId || m.metadata?.sleeppilot?.messageId === messageId) {
          return { found: true, user: m, after: collected.reverse() };
        }
        collected.push(m);
      }
      cursor = r?.cursor?.next;
      if (!cursor || data.length === 0) break;
    }
    return { found: false, user: null, after: [] };
  }

  /**
   * Run one turn: submit `text` with a client-chosen message id (idempotent on the server),
   * stream events to `onEvent`, and wait until the session is idle, interrupted, or failed.
   * Returns a reconciled TurnResult built from durable session messages, not from the stream.
   */
  async runTurn({ sessionID, text, messageId = newMessageId(), metadata, onEvent, onSubmitted, shouldStop }) {
    const c = this.requireClient();
    const startedAt = Date.now();
    let lastEventAt = Date.now();
    let finishedByEvent = null;
    const toolNames = new Map();
    const off = this.onSession(sessionID, (ev) => {
      lastEventAt = Date.now();
      const t = ev.type;
      if (t === 'session.tool.input.started') toolNames.set(ev.data.id, ev.data.name);
      if (t === 'session.execution.succeeded' || t === 'session.execution.failed' || t === 'session.execution.interrupted') finishedByEvent = t;
      onEvent?.(normalizeEvent(ev, toolNames));
    });
    try {
      // The prompt endpoint is idempotent for the same message id, so a retry after a
      // network error can never create a duplicate task submission.
      let submitted = false;
      for (let attempt = 0; attempt < 4 && !submitted; attempt++) {
        try {
          await c.call('session.prompt', {
            params: { sessionID },
            body: { id: messageId, text, metadata: { sleeppilot: { messageId, ...(metadata || {}) } } },
          });
          submitted = true;
        } catch (err) {
          const cls = classifyError(err);
          if (attempt === 3 || cls?.action !== 'retry') throw err;
          await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        }
      }
      onSubmitted?.({ messageId, at: Date.now() });
      return await this.waitForTurn({ sessionID, messageId, startedAt, onEvent, shouldStop, isFinished: () => finishedByEvent, lastEventAt: () => lastEventAt });
    } finally {
      off();
    }
  }

  /** Wait for an already-submitted turn (also used after a restart to reconcile). */
  async waitForTurn({ sessionID, messageId, startedAt = Date.now(), onEvent, shouldStop, isFinished = () => null }) {
    const seenPerm = new Set();
    const seenForms = new Set();
    let inactiveWithoutIdleSince = null;
    for (;;) {
      let active = true;
      try {
        if (!isFinished()) active = await this.isActive(sessionID);
        else active = false;
        // Permission requests / forms are polled too: the event stream is volatile.
        const perms = await this.listPermissions(sessionID).catch(() => []);
        for (const p of perms) {
          if (!seenPerm.has(p.id)) {
            seenPerm.add(p.id);
            onEvent?.({ kind: 'permission', request: p });
          }
        }
        const forms = await this.listForms(sessionID).catch(() => []);
        for (const f of forms) {
          if (!seenForms.has(f.id)) {
            seenForms.add(f.id);
            onEvent?.({ kind: 'form', form: f });
          }
        }
        onEvent?.({ kind: 'pending', permissions: perms, forms });
      } catch (err) {
        if (classifyError(err)?.action === 'retry' || !this.connected) {
          onEvent?.({ kind: 'connection', ok: false, message: redact(err.message) });
          await this.waitConnected(Number(process.env.SLEEPPILOT_RECONNECT_MS || 5 * 60_000));
          continue;
        }
        throw err;
      }
      if (!active) {
        const turn = await this.turnMessages(sessionID, messageId);
        if (!turn.found) {
          // Not admitted (e.g. server restarted before it was stored). The caller may resubmit
          // with the same message id; the server deduplicates it.
          return { status: 'not_found', messageId, sessionID, startedAt, endedAt: Date.now() };
        }
        const result = reconcileTurn(turn, { sessionID, messageId, startedAt });
        if (result.status !== 'running') return result;
        // Verified on OpenCode 2.2.0: when the user rejects a permission, the step is aborted and
        // execution stops WITHOUT an idle marker. Recognise that immediately instead of waiting.
        const lastAssistant = [...turn.after].reverse().find((m) => m.type === 'assistant');
        if (lastAssistant?.error) {
          const rejected = result.errors.some((e) => e.classification?.category === 'permission_rejected');
          return { ...result, status: rejected ? 'failed' : 'interrupted', stoppedWithoutIdle: true };
        }
        // Not running and no idle marker: either the loop is about to start, or the execution
        // died with a previous server process. After a grace period treat it as lost.
        inactiveWithoutIdleSince ??= Date.now();
        if (Date.now() - inactiveWithoutIdleSince > Number(process.env.SLEEPPILOT_LOST_GRACE_MS || 45_000)) return { ...result, status: 'lost' };
      } else inactiveWithoutIdleSince = null;
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  }

  /** Wait until connected again; throws (code CONNECTION_LOST) after timeoutMs. */
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
        const e = new Error('The OpenCode connection did not come back in time.');
        e.code = 'CONNECTION_LOST';
        e.name = 'OpenCodeConnectionError';
        reject(e);
      }, timeoutMs);
      this.on('status', on);
    });
  }
}

/** Turn durable messages into a TurnResult. Exported for tests. */
export function reconcileTurn(turn, { sessionID, messageId, startedAt }) {
  const msgs = turn.after;
  const idle = msgs.find((m) => m.type === 'idle');
  const assistants = msgs.filter((m) => m.type === 'assistant');
  const texts = [];
  const tools = [];
  const errors = [];
  // Ordered transcript of the turn for the chat view (verified part types on 2.2.0: text,
  // reasoning, tool; compaction is a separate message type).
  const transcript = [];
  const clip = (s, n) => (s && s.length > n ? s.slice(0, n) + '…' : s || '');
  let cost = 0;
  const tokens = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
  const models = new Set();
  for (const a of assistants) {
    if (a.model) models.add(`${a.model.providerID}/${a.model.id}`);
    if (typeof a.cost === 'number') cost += a.cost;
    if (a.tokens) {
      tokens.input += a.tokens.input || 0;
      tokens.output += a.tokens.output || 0;
      tokens.reasoning += a.tokens.reasoning || 0;
      tokens.cacheRead += a.tokens.cache?.read || 0;
      tokens.cacheWrite += a.tokens.cache?.write || 0;
    }
    if (a.error) errors.push(a.error);
    transcript.push({ type: 'step', at: a.time?.created || null, model: a.model ? `${a.model.providerID}/${a.model.id}` : null, error: a.error ? { type: a.error.type, message: a.error.message } : null });
    for (const part of a.content || []) {
      if (part.type === 'text' && part.text) transcript.push({ type: 'text', text: clip(part.text, 20_000) });
      if (part.type === 'reasoning' && part.text) transcript.push({ type: 'reasoning', text: clip(part.text, 20_000), at: part.time?.created || null, endedAt: part.time?.completed || null });
      if (part.type === 'text' && part.text) texts.push(part.text);
      if (part.type === 'tool') {
        const st = part.state || {};
        // A tool call the user declined (OpenCode reports type "aborted", message "The user declined…")
        if (st.error && /declined|permission denied/i.test(st.error.message || '')) errors.push({ type: 'permission.rejected', message: `${part.name}: ${st.error.message}` });
        const tool = {
          name: part.name,
          status: st.status,
          input: summarizeInput(st.input),
          output: (st.content || []).filter((x) => x.type === 'text').map((x) => x.text).join('\n').slice(0, 2000),
          error: st.error ? { type: st.error.type, message: st.error.message } : null,
        };
        tools.push(tool);
        transcript.push({ type: 'tool', ...tool, at: part.time?.created || st.time?.start || null, endedAt: st.time?.end || part.time?.completed || null });
      }
    }
  }
  for (const m of msgs) if (m.type === 'compaction') transcript.push({ type: 'compaction', status: m.status, reason: m.reason, at: m.time?.created || null });
  if (idle?.error) errors.push(idle.error);
  let status;
  // Tool-level refusals by deny rules do not end a turn; only real failures decide the outcome.
  const hardErrors = errors.filter((e) => e.type !== 'permission.rejected');
  if (!idle) status = 'running';
  else if (idle.outcome === 'succeeded' && hardErrors.length === 0) status = 'succeeded';
  else if (idle.outcome === 'interrupted') status = 'interrupted';
  else status = 'failed';
  const finalText = texts.length ? texts[texts.length - 1] : '';
  return {
    status,
    sessionID,
    messageId,
    startedAt,
    endedAt: idle?.time?.created || Date.now(),
    outcome: idle?.outcome || null,
    finalText,
    allText: texts.join('\n\n'),
    tools,
    errors: errors.map((e) => ({ type: e.type, message: e.message, status: e.status, classification: classifyError(e) })),
    usage: { cost, tokens, models: [...models], source: 'opencode' },
    transcript: transcript.slice(0, 600),
    snapshotFiles: [...new Set(assistants.flatMap((a) => a.snapshot?.files || []))],
  };
}

function summarizeInput(input) {
  if (!input || typeof input !== 'object') return input;
  const out = {};
  for (const [k, v] of Object.entries(input)) out[k] = typeof v === 'string' && v.length > 300 ? v.slice(0, 300) + '…' : v;
  return out;
}

/** Convert raw OpenCode events into compact UI log entries. */
function normalizeEvent(ev, toolNames) {
  const d = ev.data || {};
  switch (ev.type) {
    case 'session.text.delta':
      return { kind: 'text', delta: d.delta, messageID: d.assistantMessageID };
    case 'session.reasoning.delta':
      return { kind: 'reasoning', delta: d.delta };
    case 'session.tool.called':
      return { kind: 'tool', phase: 'called', name: toolNames.get(d.id) || d.name || 'tool', input: summarizeInput(d.input), id: d.id };
    case 'session.tool.success':
      return {
        kind: 'tool',
        phase: 'success',
        name: toolNames.get(d.id) || 'tool',
        id: d.id,
        output: (d.content || []).filter((x) => x.type === 'text').map((x) => x.text).join('\n').slice(0, 1500),
      };
    case 'session.tool.failed':
    case 'session.tool.error':
      return { kind: 'tool', phase: 'error', name: toolNames.get(d.id) || 'tool', id: d.id, error: d.error };
    case 'session.step.failed':
      return { kind: 'step-failed', error: d.error };
    case 'session.compaction.started':
    case 'session.compaction.ended':
    case 'session.compaction.failed':
      return { kind: 'compaction', phase: ev.type.split('.').pop(), data: d };
    case 'session.usage.updated':
      return { kind: 'usage', cost: d.cost, tokens: d.tokens };
    case 'session.retry.scheduled':
      return { kind: 'retry', data: d };
    case 'permission.asked':
      return { kind: 'permission', request: d };
    case 'permission.replied':
      return { kind: 'permission-replied', data: d };
    case 'form.created':
      return { kind: 'form', form: d.form || d };
    case 'session.execution.started':
    case 'session.execution.succeeded':
    case 'session.execution.failed':
    case 'session.execution.interrupted':
      return { kind: 'execution', type: ev.type.split('.').pop(), data: d };
    default:
      return { kind: 'raw', type: ev.type };
  }
}
