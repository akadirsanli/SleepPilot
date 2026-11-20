import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { AgentEngine } from '../base.mjs';
import { engineSessionsDir } from '../../util/paths.mjs';
import { readJson, writeJsonAtomic } from '../../util/fsx.mjs';
import { killTree, resolveSpawn, runFile } from '../../util/proc.mjs';
import { classifyError } from '../../opencode/errors.mjs';
import { redact } from '../../util/redact.mjs';

const NEW_SESSION = (id) => `ses_${id}_${crypto.randomBytes(9).toString('hex')}`;

/**
 * Base for external agent CLIs that already ship their own tool loop (Claude Code, Codex).
 *
 * SleepPilot supervises the turn at the task level: it starts the CLI in the project folder,
 * streams its JSON output into the normal chat/events, persists the conversation ID and
 * reconciles the result after a crash. The CLI's own sandbox/permission subsystem still governs
 * the tools it runs; SleepPilot maps its profiles onto the CLI's documented flags.
 */
export class ExternalCliEngine extends AgentEngine {
  constructor({ id, label, settings = {}, credentials = null } = {}) {
    super({ id, label, settings });
    this.credentials = credentials;
    this.sessions = new Map();
    this.running = new Map();
    this.cli = { cliPath: null, model: null, extraArgs: [], timeoutMin: 720, ...(settings[id] || {}) };
    this.detectedCliPath = null;
    this.auth = null;
    this.capabilities = { 'session.interrupt': true, 'session.permission.list': false, 'session.form.list': false, 'session.diff': false, 'experimental.usage.limits': false };
    this.client.ops = Object.fromEntries(Object.entries(this.capabilities).map(([k, v]) => [k, { available: v }]));
  }

  applySettings(settings = {}) {
    this.settings = { ...this.settings, ...settings };
    const next = { ...(settings[this.id] || {}) };
    // An empty cliPath means "auto-detect", not "forget the executable that was just detected".
    // Replacing a detected path with null used to make the next turn spawn a null file.
    if (!next.cliPath) next.cliPath = this.detectedCliPath || this.cli.cliPath || null;
    this.cli = { ...this.cli, ...next };
  }

  /** @abstract { found, path, source, version, auth, models, notes } */
  async probeCli() {
    throw new Error(`${this.label}: probeCli() is not implemented.`);
  }

  /** @abstract { args: string[], env?: object } */
  buildArgs() {
    throw new Error(`${this.label}: buildArgs() is not implemented.`);
  }

  /** @abstract mutate state through helpers */
  parseLine() {}

  async connect() {
    if (this.connecting) return this.connecting;
    this.connecting = this._connect().finally(() => (this.connecting = null));
    return this.connecting;
  }

  async _connect() {
    this.setStatus('detecting', `Looking for ${this.label}…`);
    let probe;
    try {
      probe = await this.probeCli();
    } catch (err) {
      probe = { found: false, error: err.message, models: [], notes: [] };
    }
    this.detection = {
      found: !!probe.found,
      path: probe.path || null,
      source: probe.source || null,
      version: { raw: probe.version || null },
      support: probe.found
        ? { status: 'supported', message: `${this.label} ${probe.version || ''}${probe.auth ? ` · ${probe.auth.label}` : ''}`.trim() }
        : { status: 'missing', message: probe.error || `${this.label} was not found. Install it and sign in, then set the CLI path if needed.` },
      tried: probe.tried || [],
    };
    if (!probe.found) {
      this.setStatus('error', this.detection.support.message);
      return this.status;
    }
    this.cli.cliPath = probe.path;
    this.detectedCliPath = probe.path;
    this.auth = probe.auth || null;
    this.serverInfo = { version: probe.version };
    this.models = (probe.models || []).map((m) => ({
      providerID: this.id,
      id: String(m.id),
      name: String(m.name || m.id),
    }));
    if (!this.models.length) this.models = [{ providerID: this.id, id: 'default', name: `${this.label} default` }];
    this.defaultModel = this.models[0];
    this.agents = [{ id: 'default', name: this.label }];
    const authSuffix = probe.auth?.label ? ` · ${probe.auth.label}` : '';
    this.setStatus('connected', `${this.label} ready (${probe.version || 'detected'})${authSuffix}.`);
    return this.status;
  }

  async disconnect() {
    for (const rec of this.running.values()) {
      rec.interrupted = true;
      killTree(rec.child?.pid);
    }
    this.running.clear();
    if (this.status.state !== 'disconnected') this.setStatus('disconnected', 'Not connected');
  }

  sessionFile(id) {
    return path.join(engineSessionsDir(this.id), `${String(id).replace(/[^a-zA-Z0-9_.-]/g, '_')}.json`);
  }

  async loadSession(id, { required = true } = {}) {
    if (this.sessions.has(id)) return this.sessions.get(id);
    const data = await readJson(this.sessionFile(id), null).catch(() => null);
    if (!data) {
      if (!required) return null;
      throw new Error(`Session ${id} was not found.`);
    }
    this.sessions.set(id, data);
    return data;
  }

  async saveSession(session) {
    session.updatedAt = Date.now();
    this.sessions.set(session.id, session);
    await writeJsonAtomic(this.sessionFile(session.id), session);
  }

  async createSession({ directory, title, model, permissions, effort = null, readOnly = false } = {}) {
    this.requireConnected();
    const session = {
      id: NEW_SESSION(this.id),
      engine: this.id,
      directory: path.resolve(directory || process.cwd()),
      title: String(title || `${this.label} session`).slice(0, 200),
      model: model || this.defaultModel,
      effort: effort || null,
      readOnly: !!readOnly,
      permissions: permissions || [],
      createdAt: Date.now(),
      messages: [],
      turns: {},
      nativeSessionId: null,
      activeTurn: null,
    };
    await this.saveSession(session);
    return { id: session.id, title: session.title, model: session.model, effort: session.effort, readOnly: session.readOnly, directory: session.directory };
  }

  async runTurn({ sessionID, text, messageId = `msg_${crypto.randomBytes(6).toString('hex')}`, metadata, onEvent, onSubmitted }) {
    const session = await this.loadSession(sessionID);
    if (session.turns?.[messageId]?.result) return { ...session.turns[messageId].result, recovered: true };
    if (this.running.has(sessionID)) {
      const rec = this.running.get(sessionID);
      if (rec.messageId === messageId) return rec.promise;
      throw new Error('This session is already running another instruction.');
    }
    const startedAt = Date.now();
    session.activeTurn = messageId;
    session.turns ||= {};
    session.turns[messageId] = { messageId, startedAt, status: 'running' };
    session.messages.push({ role: 'user', content: String(text || ''), at: startedAt, messageId });
    await this.saveSession(session);
    onSubmitted?.({ messageId, at: Date.now() });
    const rec = { messageId, startedAt, child: null, interrupted: false, promise: null };
    this.running.set(sessionID, rec);
    const promise = this._runTurn({ session, text, messageId, startedAt, rec, onEvent, role: metadata?.role || 'developer' })
      .catch((err) => failure(this.id, sessionID, messageId, startedAt, redact(err.message), err?.sleepPilotType || (err?.code === 'ENOENT' ? 'provider.invalid-request' : 'provider.transport')))
      .finally(() => {
        if (this.running.get(sessionID) === rec) this.running.delete(sessionID);
      });
    rec.promise = promise;
    return promise;
  }

  async _runTurn({ session, text, messageId, startedAt, rec, onEvent, role }) {
    if (!this.cli.cliPath) {
      const err = new Error(`${this.label} has no CLI path. Open Settings → Engines → ${this.label}, click Test / connect, or set the CLI path.`);
      err.sleepPilotType = 'provider.config';
      throw err;
    }
    const readOnly = session.readOnly === true || role !== 'developer';
    const profile = profileFromRules(session.permissions);
    const built = this.buildArgs({ session, role, readOnly, profile, text });
    const env = { ...process.env, ...(built.env || {}) };
    const spec = resolveSpawn(this.cli.cliPath, built.args);
    const child = spawn(spec.file, spec.args, {
      cwd: session.directory,
      env,
      windowsHide: true,
      windowsVerbatimArguments: spec.verbatim,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    rec.child = child;
    const state = createState();
    const helpers = makeHelpers(state, onEvent);
    let stderr = '';
    let buffer = '';
    const timeoutMs = Math.max(1, Number(this.cli.timeoutMin) || 720) * 60_000;
    const timer = setTimeout(() => {
      rec.interrupted = true;
      state.timedOut = true;
      killTree(child.pid);
    }, timeoutMs);
    timer.unref?.();
    child.stdin.end(String(text || ''), 'utf8');
    child.stdout.on('data', (d) => {
      buffer += d.toString('utf8');
      let i;
      while ((i = buffer.indexOf('\n')) >= 0) {
        handleLine(this, buffer.slice(0, i), state, helpers);
        buffer = buffer.slice(i + 1);
      }
    });
    child.stderr.on('data', (d) => {
      stderr = (stderr + d.toString('utf8')).slice(-20_000);
    });
    const code = await new Promise((resolve) => {
      child.once('error', (err) => {
        state.errors.push({ type: 'provider.transport', message: err.message });
        resolve(null);
      });
      child.once('close', resolve);
    });
    clearTimeout(timer);
    if (buffer.trim()) handleLine(this, buffer, state, helpers);
    state.stderr = stderr;

    if (state.sessionId) session.nativeSessionId = state.sessionId;
    const status = state.timedOut || rec.interrupted ? 'interrupted' : state.isError || (code !== 0 && !state.finalText) ? 'failed' : 'succeeded';
    if (status === 'failed' && !state.errors.length) {
      state.errors.push({ type: authHint(stderr) ? 'provider.auth' : 'provider.transport', message: (stderr || `The ${this.label} process exited with code ${code}.`).slice(-2000) });
    }
    const finalText = state.finalText || state.texts.at(-1) || '';
    const result = {
      status,
      sessionID: session.id,
      messageId,
      startedAt,
      endedAt: Date.now(),
      outcome: status === 'succeeded' ? 'succeeded' : status === 'interrupted' ? 'interrupted' : 'failed',
      finalText,
      allText: state.texts.join('\n'),
      tools: state.tools.slice(-200),
      errors: state.errors.map((e) => ({ type: e.type, message: e.message, status: null, classification: classifyForEngine(this.id, e) })),
      usage: {
        cost: state.cost,
        tokens: state.usage,
        models: [`${this.id}/${session.model?.id || this.cli.model || 'default'}`],
      },
      transcript: state.transcript.slice(-600),
      snapshotFiles: [],
      engine: this.id,
      nativeSessionId: session.nativeSessionId,
      quota: state.quota || null,
      stderr: stderr.slice(-4000),
    };
    session.activeTurn = null;
    session.turns[messageId] = { messageId, startedAt, endedAt: result.endedAt, status, result };
    await this.saveSession(session);
    return result;
  }

  async isActive(sessionID) {
    return this.running.has(sessionID);
  }

  async interrupt(sessionID) {
    const rec = this.running.get(sessionID);
    if (!rec) return { supported: true, interrupted: false };
    rec.interrupted = true;
    killTree(rec.child?.pid);
    return { supported: true, interrupted: true };
  }

  async turnMessages(sessionID, messageId) {
    const session = await this.loadSession(sessionID, { required: false });
    if (!session) return { found: false, user: null, after: [] };
    const record = session.turns?.[messageId];
    if (!record) return { found: false, user: null, after: [] };
    const result = record.status === 'running'
      ? { status: 'interrupted', startedAt: record.startedAt, endedAt: Date.now(), errors: [{ type: 'provider.transport', message: `SleepPilot restarted while a ${this.label} turn was running; it is not sent again.` }], transcript: [], usage: { cost: 0, tokens: {} }, finalText: '' }
      : record.result || { status: record.status, startedAt: record.startedAt, endedAt: record.endedAt, errors: [], transcript: [], usage: { cost: 0, tokens: {} }, finalText: '' };
    const content = (result.transcript || []).map((t) => (t.type === 'text' ? { type: 'text', text: t.text } : t.type === 'reasoning' ? { type: 'reasoning', text: t.text } : { type: 'tool', name: t.name, state: { status: t.status, input: t.input, content: t.output ? [{ type: 'text', text: t.output }] : [], error: t.error || undefined } }));
    return {
      found: true,
      user: { id: messageId, type: 'user' },
      after: [
        { type: 'assistant', id: `${messageId}_a`, content, cost: result.usage?.cost || 0, tokens: result.usage?.tokens || {}, time: { created: result.startedAt } },
        { type: 'idle', outcome: result.status === 'succeeded' ? 'succeeded' : result.status === 'interrupted' ? 'interrupted' : 'failed', time: { created: result.endedAt || Date.now() }, error: result.errors?.[0] ? { type: result.errors[0].type, message: result.errors[0].message } : undefined },
      ],
    };
  }

  async sessionDiff() {
    return [];
  }

  async usageLimits() {
    return { supported: false, data: null };
  }
}

// ------------------------------------------------------------------ helpers

function createState() {
  return {
    sessionId: null,
    texts: [],
    transcript: [],
    tools: [],
    pendingTools: new Map(),
    usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    cost: 0,
    errors: [],
    finalText: '',
    isError: false,
    timedOut: false,
    stderr: '',
    quota: null,
  };
}

function makeHelpers(state, onEvent) {
  const at = () => Date.now();
  return {
    text(text) {
      const t = String(text || '');
      if (!t) return;
      state.texts.push(t);
      state.transcript.push({ type: 'text', text: t, at: at() });
      onEvent?.({ kind: 'text', delta: t });
    },
    reasoning(text) {
      const t = String(text || '');
      if (!t) return;
      state.transcript.push({ type: 'reasoning', text: t, at: at() });
      onEvent?.({ kind: 'reasoning', delta: t });
    },
    toolStart(id, name, input) {
      const tid = id || `tool_${crypto.randomBytes(4).toString('hex')}`;
      state.pendingTools.set(tid, { name, input, at: at() });
      onEvent?.({ kind: 'tool', phase: 'called', name, id: tid, input });
      return tid;
    },
    toolEnd(id, { status = 'completed', output = '', error = null } = {}) {
      const pending = state.pendingTools.get(id) || {};
      state.pendingTools.delete(id);
      const entry = { name: pending.name || 'tool', status: status === 'error' ? 'error' : 'completed', input: pending.input, output, error: error ? { message: error } : null, at: pending.at || at(), endedAt: at() };
      state.tools.push(entry);
      state.transcript.push({ type: 'tool', ...entry });
      onEvent?.(status === 'error' ? { kind: 'tool', phase: 'error', name: entry.name, id, error: { message: error || output || 'tool failed' } } : { kind: 'tool', phase: 'success', name: entry.name, id, output: String(output).slice(0, 1500) });
    },
    usage(u = {}) {
      for (const k of Object.keys(state.usage)) state.usage[k] += Number(u[k] || 0);
    },
    cost(value) {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) state.cost = Math.max(state.cost, n);
    },
    sessionId(id) {
      if (id) state.sessionId = String(id);
    },
    error(type, message) {
      state.errors.push({ type, message: String(message || '').slice(0, 2000) });
    },
    final(text) {
      if (typeof text === 'string' && text.trim()) state.finalText = text;
    },
    fail() {
      state.isError = true;
    },
  };
}

function handleLine(engine, line, state, helpers) {
  if (!line.trim()) return;
  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    return;
  }
  try {
    engine.parseLine(ev, state, helpers);
  } catch (err) {
    state.errors.push({ type: 'provider.invalid-output', message: `Could not parse ${engine.label} event: ${err.message}` });
  }
  for (const [id, pending] of state.pendingTools) {
    if (Date.now() - (pending.at || 0) > 10 * 60_000) helpers.toolEnd(id, { status: 'completed', output: '(tool result not reported)' });
  }
}

export function profileFromRules(rules = []) {
  const has = (action, resource, effect) => rules.some((r) => r.action === action && r.resource === resource && r.effect === effect);
  if (has('*', '*', 'allow')) return 'unrestricted';
  if (rules.some((r) => r.action === '*' && r.resource === '*' && r.effect === 'allow')) return 'unrestricted';
  if (has('edit', '*', 'allow') && has('shell', '*', 'allow')) return 'full';
  if (has('edit', '*', 'allow')) return 'balanced';
  return 'strict';
}

export function classifyForEngine(engineId, error) {
  const c = classifyError(error);
  if (c?.category === 'auth') {
    c.hint = engineId === 'claude'
      ? 'Claude Code is not signed in for the user account that runs SleepPilot. In a terminal run `claude auth login` (or start `claude` and type /login), check it with `claude auth status`, then reconnect the engine and resume.'
      : engineId === 'codex'
        ? 'Sign in with `codex login` in a terminal, then reconnect the engine.'
        : c.hint;
  }
  return c;
}

/**
 * Signed-in state from a CLI's plain-text status line: true, false or null (unknown).
 * The negative forms are checked first — "Not logged in" also contains "logged in".
 */
export function signedInFromText(text) {
  const t = String(text || '');
  if (/\bnot\s+(?:logged|signed)\s+in\b|\blogged\s+out\b|\bsigned\s+out\b|please run \/login/i.test(t)) return false;
  if (/\b(?:logged|signed)\s+in\b/i.test(t)) return true;
  return null;
}

export function authHint(text) {
  return /not logged in|login|unauthori[sz]ed|api key|authentication/i.test(String(text || ''));
}

export function failure(engineId, sessionID, messageId, startedAt, message, type) {
  return {
    status: 'failed',
    sessionID,
    messageId,
    startedAt,
    endedAt: Date.now(),
    outcome: 'failed',
    finalText: '',
    allText: '',
    tools: [],
    errors: [{ type, message, status: null, classification: classifyForEngine(engineId, { type, message }) }],
    usage: { cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, models: [] },
    transcript: [],
    snapshotFiles: [],
    engine: engineId,
  };
}

/** Shared executable probe with auth status helper. */
export async function findExternalCli({ explicit, envNames = [], candidates = [], versionArgs = ['--version'], re = /(\d+\.\d+\.\d+)/ }) {
  const { probeCandidates } = await import('../../tools/probe.mjs');
  const list = [
    explicit,
    ...envNames.map((n) => process.env[n]),
    ...candidates,
  ].filter(Boolean);
  const hit = await probeCandidates(list, { args: versionArgs, re, timeoutMs: 20_000 });
  return {
    found: hit.found,
    path: hit.file,
    source: hit.file === 'claude' || hit.file === 'codex' ? 'PATH' : 'detected',
    version: hit.version,
    tried: hit.attempts.map((a) => a.file),
  };
}

export async function authJson(file, args, parse) {
  const r = await runFile(file, args, { timeoutMs: 30_000 });
  const text = `${r.stdout || ''}\n${r.stderr || ''}`.trim();
  return parse ? parse(text, r) : text;
}

export async function readText(file) {
  return fsp.readFile(file, 'utf8');
}
