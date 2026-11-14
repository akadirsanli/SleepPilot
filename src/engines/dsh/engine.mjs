import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { AgentEngine } from '../base.mjs';
import { engineSessionsDir } from '../../util/paths.mjs';
import { readJson, writeJsonAtomic } from '../../util/fsx.mjs';
import { runFile, killTree, resolveSpawn } from '../../util/proc.mjs';
import { classifyError } from '../../opencode/errors.mjs';
import { redact } from '../../util/redact.mjs';

const NEW_SESSION = () => `ses_dsh_${crypto.randomBytes(9).toString('hex')}`;

/**
 * DeepSeek Harness bridge.
 *
 * Uses DSH's own headless profile:
 *   dsh --profile headless --json --approval-policy never -
 * with the task on stdin and the project folder as the working directory. DSH runs its own
 * tool loop; SleepPilot supervises the turn, streams its events, and persists the result so a
 * restart never resubmits the task. The same pattern fits any harness that can print an
 * NDJSON event stream.
 */
export class DshEngine extends AgentEngine {
  constructor({ settings = {}, credentials = null } = {}) {
    super({ id: 'dsh', label: 'DeepSeek Harness', settings });
    this.credentials = credentials;
    this.sessions = new Map();
    this.running = new Map();
    this.child = null;
    this.dsh = { cliPath: null, profile: 'headless', approvalPolicy: 'never', permissionMode: '', extraArgs: [], timeoutMin: 720, ...(settings.dsh || {}) };
    this.detectedCliPath = null;
    this.capabilities = { 'session.interrupt': true, 'session.permission.list': false, 'session.form.list': false, 'session.diff': false, 'experimental.usage.limits': false };
    this.client.ops = Object.fromEntries(Object.entries(this.capabilities).map(([k, v]) => [k, { available: v }]));
  }

  applySettings(settings = {}) {
    this.settings = { ...this.settings, ...settings };
    const next = { ...(settings.dsh || {}) };
    // Keep the detected executable when the setting means "auto-detect" (null).
    if (!next.cliPath) next.cliPath = this.detectedCliPath || this.dsh.cliPath || null;
    this.dsh = { ...this.dsh, ...next };
  }

  async connect() {
    if (this.connecting) return this.connecting;
    this.connecting = this._connect().finally(() => (this.connecting = null));
    return this.connecting;
  }

  async _connect() {
    this.setStatus('detecting', 'Looking for the DeepSeek Harness CLI…');
    const found = await findDsh(this.dsh.cliPath);
    this.detection = {
      found: !!found.path,
      path: found.path,
      source: found.source,
      version: { raw: found.version || null },
      support: found.path
        ? { status: 'supported', message: `DeepSeek Harness CLI found (${found.source}).` }
        : { status: 'missing', message: 'The dsh CLI was not found. Install DeepSeek Harness, or set the CLI path in Settings → Engines → DeepSeek Harness.' },
      tried: found.tried,
    };
    if (!found.path) {
      this.setStatus('error', this.detection.support.message);
      return this.status;
    }
    this.dsh.cliPath = found.path;
    this.detectedCliPath = found.path;
    this.serverInfo = { version: found.version || 'dsh' };
    this.models = [{ providerID: 'dsh', id: 'default', name: `DeepSeek Harness (${this.dsh.profile})` }];
    this.agents = [{ id: 'default', name: 'DSH headless', mode: 'agent' }];
    this.defaultModel = this.models[0];
    const profile = await runFile(found.path, ['--profile', this.dsh.profile, '--help'], { timeoutMs: 60_000 });
    if (profile.exitCode !== 0) {
      const message = `The "${this.dsh.profile}" profile is not usable: ${(profile.stderr || profile.stdout || 'no output').slice(0, 500)}`;
      this.setStatus('error', redact(message));
      return this.status;
    }
    this.setStatus('connected', `DeepSeek Harness ready (profile: ${this.dsh.profile}).`);
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
    return path.join(engineSessionsDir('dsh'), `${String(id).replace(/[^a-zA-Z0-9_.-]/g, '_')}.json`);
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
    if (!directory) throw new Error('A project folder is required.');
    if (effort) throw new Error(`DeepSeek Harness does not expose a reasoning-effort flag; requested effort "${effort}" cannot be applied. Use a model/profile without effort or choose another harness.`);
    if (readOnly) {
      const err = new Error('DeepSeek Harness cannot enforce a read-only session at the adapter level. Choose OpenCode, Claude Code, Codex or the API harness for Manager/Reviewer roles.');
      err.sleepPilotType = 'provider.config';
      throw err;
    }
    const session = {
      id: NEW_SESSION(),
      engine: 'dsh',
      directory: path.resolve(directory),
      title: String(title || 'SleepPilot session').slice(0, 200),
      model: model || this.defaultModel,
      effort: null,
      readOnly: false,
      permissions: permissions || [],
      createdAt: Date.now(),
      messages: [],
      turns: {},
      dshSessionId: null,
      activeTurn: null,
    };
    await this.saveSession(session);
    return { id: session.id, title: session.title, model: session.model, directory: session.directory };
  }

  async runTurn({ sessionID, text, messageId = `msg_${crypto.randomBytes(6).toString('hex')}`, onEvent, onSubmitted }) {
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
    const promise = this._runDsh({ session, text, messageId, startedAt, rec, onEvent })
      .catch((err) => failed(sessionID, messageId, startedAt, redact(err.message), err?.sleepPilotType || (err?.code === 'ENOENT' ? 'provider.invalid-request' : 'provider.transport')))
      .finally(() => {
        if (this.running.get(sessionID) === rec) this.running.delete(sessionID);
      });
    rec.promise = promise;
    return promise;
  }

  async _runDsh({ session, text, messageId, startedAt, rec, onEvent }) {
    if (!this.dsh.cliPath) {
      const err = new Error('DeepSeek Harness has no CLI path. Open Settings → Engines → DeepSeek Harness, click Test / connect, or set the CLI path.');
      err.sleepPilotType = 'provider.config';
      throw err;
    }
    const args = ['--profile', this.dsh.profile, '--json'];
    if (this.dsh.approvalPolicy !== 'ask') args.push('--approval-policy', this.dsh.approvalPolicy || 'never');
    if (this.dsh.permissionMode) args.push('--permission-mode', this.dsh.permissionMode);
    if (session.dshSessionId) args.push('--session-id', session.dshSessionId);
    for (const a of this.dsh.extraArgs || []) args.push(String(a));
    args.push('-');
    const env = { ...process.env };
    for (const name of this.credentials?.envNames?.() || []) {
      const value = this.credentials.getEnv(name);
      if (value) env[name] = value;
    }
    const spawnSpec = resolveSpawn(this.dsh.cliPath, args);
    const child = spawn(spawnSpec.file, spawnSpec.args, {
      cwd: session.directory,
      env,
      windowsHide: true,
      windowsVerbatimArguments: spawnSpec.verbatim,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    rec.child = child;
    const transcript = [];
    const texts = [];
    const tools = [];
    const errors = [];
    let final = null;
    let dshSessionId = session.dshSessionId;
    let stderr = '';
    let buffer = '';
    const timeoutMs = Math.max(1, Number(this.dsh.timeoutMin) || 720) * 60_000;
    const timer = setTimeout(() => {
      rec.interrupted = true;
      errors.push({ type: 'provider.timeout', message: `The DeepSeek Harness turn exceeded ${Math.round(timeoutMs / 60000)} minutes.` });
      killTree(child.pid);
    }, timeoutMs);
    timer.unref?.();
    child.stdin.end(String(text || ''), 'utf8');

    const handleLine = (line) => {
      if (!line.trim()) return;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }
      if (ev.type === 'session' && ev.sessionId) {
        dshSessionId = ev.sessionId;
        session.dshSessionId = dshSessionId;
        return;
      }
      if (ev.type === 'final') {
        final = ev;
        return;
      }
      if (ev.type === 'status') {
        onEvent?.({ kind: 'status', phase: ev.phase, data: ev });
        return;
      }
      if (typeof ev.text === 'string' && ev.text && ev.type !== 'final') {
        texts.push(ev.text);
        transcript.push({ type: 'text', text: ev.text });
        onEvent?.({ kind: 'text', delta: ev.text });
        return;
      }
      if (/tool/i.test(String(ev.type)) && (ev.name || ev.tool)) {
        const name = ev.name || ev.tool;
        const id = ev.id || ev.callId || `tool_${Date.now().toString(36)}`;
        if (/start|called|begin/i.test(ev.type)) onEvent?.({ kind: 'tool', phase: 'called', name, id, input: ev.input || ev.args });
        else if (/fail|error/i.test(ev.type)) onEvent?.({ kind: 'tool', phase: 'error', name, id, error: { message: ev.error?.message || ev.message || 'error' } });
        else onEvent?.({ kind: 'tool', phase: 'success', name, id, output: ev.output || ev.result || '' });
        tools.push({ name, status: /fail|error/i.test(ev.type) ? 'error' : 'completed', input: ev.input || ev.args, output: ev.output || ev.result || '', error: /fail|error/i.test(ev.type) ? { message: ev.error?.message || ev.message || 'error' } : null, at: Date.now() });
      }
    };

    child.stdout.on('data', (d) => {
      buffer += d.toString('utf8');
      let i;
      while ((i = buffer.indexOf('\n')) >= 0) {
        handleLine(buffer.slice(0, i));
        buffer = buffer.slice(i + 1);
      }
    });
    child.stderr.on('data', (d) => {
      stderr = (stderr + d.toString('utf8')).slice(-20_000);
    });
    const code = await new Promise((resolve) => {
      child.once('error', (err) => {
        errors.push({ type: 'provider.transport', message: err.message });
        resolve(null);
      });
      child.once('close', resolve);
    });
    clearTimeout(timer);
    if (buffer.trim()) handleLine(buffer);

    const interrupted = rec.interrupted;
    const finalText = String(final?.text || texts.join('') || '').trim();
    const reason = final?.reason;
    let status = 'succeeded';
    if (interrupted) status = 'interrupted';
    else if (reason?.kind === 'error') {
      status = 'failed';
      errors.push({ type: 'provider.transport', message: String(reason.error?.message || 'DeepSeek Harness reported an error.').slice(0, 2000) });
    } else if (!final && code !== 0) {
      status = 'failed';
      errors.push({ type: 'provider.transport', message: stderr.slice(-2000) || `dsh exited with code ${code}.` });
    }
    if (finalText) transcript.push({ type: 'text', text: finalText });
    if (final?.usage) {
      // Unknown schema for usage: keep it as raw metadata rather than inventing numbers.
    }
    const result = {
      status,
      sessionID: session.id,
      messageId,
      startedAt,
      endedAt: Date.now(),
      outcome: status === 'succeeded' ? 'succeeded' : status === 'interrupted' ? 'interrupted' : 'failed',
      finalText,
      allText: texts.join('\n') || finalText,
      tools: tools.slice(-200),
      errors: errors.map((e) => ({ type: e.type, message: e.message, status: null, classification: classifyError(e) })),
      usage: { cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, models: [`dsh/${this.dsh.profile}`] },
      transcript: transcript.slice(-600),
      snapshotFiles: [],
      engine: 'dsh',
      dshSessionId,
      dshExitCode: code,
      dshStderr: stderr.slice(-4000),
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
      ? { status: 'interrupted', startedAt: record.startedAt, endedAt: Date.now(), errors: [{ type: 'provider.transport', message: 'SleepPilot restarted while the DeepSeek Harness turn was running; it is not sent again.' }], transcript: [], usage: { cost: 0, tokens: {} }, finalText: '' }
      : record.result || { status: record.status, startedAt: record.startedAt, endedAt: record.endedAt, errors: [], transcript: [], usage: { cost: 0, tokens: {} }, finalText: '' };
    const content = (result.transcript || []).map((t) => (t.type === 'text' ? { type: 'text', text: t.text } : { type: 'tool', name: t.name, state: { status: t.status, input: t.input, content: t.output ? [{ type: 'text', text: t.output }] : [], error: t.error || undefined } }));
    return {
      found: true,
      user: { id: messageId, type: 'user' },
      after: [
        { type: 'assistant', id: `${messageId}_a`, content, cost: 0, tokens: {}, time: { created: result.startedAt } },
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

function failed(sessionID, messageId, startedAt, message, type) {
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
    errors: [{ type, message, status: null, classification: classifyError({ type, message }) }],
    usage: { cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, models: [] },
    transcript: [],
    snapshotFiles: [],
    engine: 'dsh',
  };
}

/** Find the dsh CLI: explicit path, DSH_CLI, PATH, then the DeepSeek Harness installation. */
export async function findDsh(explicit) {
  const tried = [];
  const candidates = [];
  if (explicit) candidates.push({ file: explicit, source: 'Settings' });
  if (process.env.DSH_CLI) candidates.push({ file: process.env.DSH_CLI, source: 'DSH_CLI' });
  candidates.push({ file: 'dsh', source: 'PATH' });
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA;
    if (local) {
      candidates.push({ file: path.join(local, 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'), source: 'DeepSeek Harness installation' });
      candidates.push({ file: path.join(local, 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.exe'), source: 'DeepSeek Harness installation' });
    }
  } else {
    candidates.push({ file: path.join(os.homedir(), '.local', 'bin', 'dsh'), source: '~/.local/bin' });
    candidates.push({ file: '/usr/local/bin/dsh', source: '/usr/local/bin' });
  }
  for (const c of candidates) {
    tried.push(c.file);
    const r = await runFile(c.file, ['--version'], { timeoutMs: 30_000 });
    if (r.error?.code === 'ENOENT') continue;
    if (r.error) continue;
    const version = `${r.stdout || ''}${r.stderr || ''}`.trim().split('\n')[0].slice(0, 120);
    if (r.exitCode === 0 || version) return { path: c.file, source: c.source, version, tried };
  }
  return { path: null, source: null, version: null, tried };
}
