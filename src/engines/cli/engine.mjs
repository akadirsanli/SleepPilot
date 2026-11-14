import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { AgentEngine } from '../base.mjs';
import { engineSessionsDir } from '../../util/paths.mjs';
import { readJson, writeJsonAtomic } from '../../util/fsx.mjs';
import { killTree, resolveSpawn, runFile } from '../../util/proc.mjs';
import { classifyError } from '../../opencode/errors.mjs';
import { redact } from '../../util/redact.mjs';
import { newEngineSessionId } from '../../util/ids.mjs';

const NEW_SESSION = () => newEngineSessionId('cli');

/**
 * Generic command-harness engine. Wraps any CLI agent that takes a prompt and prints an answer,
 * for example:
 *   claude -p {prompt}
 *   codex exec {prompt}
 *   aider --message {prompt} --yes
 *   my-harness --dir {project} --prompt-file -
 *
 * Placeholders: {prompt} {project} {model} {sessionId}. `promptVia: "stdin"` sends the prompt to
 * stdin instead of substituting {prompt}. One process per turn; the engine stores the transcript.
 */
export class CliEngine extends AgentEngine {
  constructor({ settings = {} } = {}) {
    super({ id: 'cli', label: 'Command harness', settings });
    this.sessions = new Map();
    this.running = new Map();
    this.cli = { command: '', args: [], promptVia: 'stdin', timeoutMin: 720, appendArgs: [], env: {}, ...(settings.cli || {}) };
    this.capabilities = { 'session.interrupt': true, 'session.permission.list': false, 'session.form.list': false, 'session.diff': false, 'experimental.usage.limits': false };
    this.client.ops = Object.fromEntries(Object.entries(this.capabilities).map(([k, v]) => [k, { available: v }]));
  }

  applySettings(settings = {}) {
    this.settings = { ...this.settings, ...settings };
    this.cli = { ...this.cli, ...(settings.cli || {}) };
  }

  async connect() {
    if (this.connecting) return this.connecting;
    this.connecting = this._connect().finally(() => (this.connecting = null));
    return this.connecting;
  }

  async _connect() {
    this.setStatus('detecting', 'Checking the command harness…');
    const command = String(this.cli.command || '').trim();
    if (!command) {
      this.detection = { found: false, source: 'Command harness', support: { status: 'missing', message: 'No command is configured.' }, tried: [] };
      this.setStatus('error', 'No command is configured. Open Settings → Engines → Command harness and enter one.');
      return this.status;
    }
    const probe = await runFile(command, ['--version'], { timeoutMs: 20_000 });
    if (probe.error?.code === 'ENOENT') {
      this.detection = { found: false, source: 'Command harness', support: { status: 'missing', message: `Command not found: ${command}` }, tried: [command] };
      this.setStatus('error', `Command not found: ${command}`);
      return this.status;
    }
    this.detection = {
      found: true,
      path: command,
      source: 'Command harness',
      version: { raw: `${probe.stdout || probe.stderr || ''}`.trim().split('\n')[0].slice(0, 120) || null },
      support: { status: 'supported', message: 'Command harness configured.' },
      tried: [command],
    };
    this.models = [{ providerID: 'cli', id: 'default', name: `${path.basename(command)} (command harness)` }];
    this.agents = [{ id: 'default', name: 'Command harness', mode: 'agent' }];
    this.defaultModel = this.models[0];
    this.serverInfo = { version: 'cli-harness' };
    this.setStatus('connected', 'Command harness ready.');
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
    return path.join(engineSessionsDir('cli'), `${String(id).replace(/[^a-zA-Z0-9_.-]/g, '_')}.json`);
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
    if (effort) throw new Error(`The Command harness does not expose reasoning effort; requested effort "${effort}" cannot be applied.`);
    if (readOnly) {
      const err = new Error('The Command harness cannot enforce a read-only session at the adapter level. Choose OpenCode, Claude Code, Codex or the API harness for Manager/Reviewer roles.');
      err.sleepPilotType = 'provider.config';
      throw err;
    }
    const session = {
      id: NEW_SESSION(),
      engine: 'cli',
      directory: path.resolve(directory),
      title: String(title || 'SleepPilot session').slice(0, 200),
      model: model || this.defaultModel,
      effort: null,
      readOnly: false,
      permissions: permissions || [],
      createdAt: Date.now(),
      messages: [],
      turns: {},
      activeTurn: null,
    };
    await this.saveSession(session);
    return { id: session.id, title: session.title, model: session.model, directory: session.directory };
  }

  async runTurn({ sessionID, text, messageId = `msg_${crypto.randomBytes(6).toString('hex')}`, onEvent, onSubmitted }) {
    const session = await this.loadSession(sessionID);
    if (session.turns?.[messageId]?.result) return { ...session.turns[messageId].result, recovered: true };
    if (this.running.has(sessionID)) throw new Error('This session is already running another instruction.');
    const startedAt = Date.now();
    session.activeTurn = messageId;
    session.turns ||= {};
    session.turns[messageId] = { messageId, startedAt, status: 'running' };
    session.messages.push({ role: 'user', content: String(text || ''), at: startedAt, messageId });
    await this.saveSession(session);
    onSubmitted?.({ messageId, at: Date.now() });
    const rec = { messageId, startedAt, child: null, interrupted: false, promise: null };
    this.running.set(sessionID, rec);
    const promise = this._runCommand({ session, text, messageId, startedAt, rec, onEvent })
      .catch((err) => failure(sessionID, messageId, startedAt, redact(err.message), err?.sleepPilotType || 'provider.transport'))
      .finally(() => {
        if (this.running.get(sessionID) === rec) this.running.delete(sessionID);
      });
    rec.promise = promise;
    return promise;
  }

  async _runCommand({ session, text, messageId, startedAt, rec, onEvent }) {
    const command = String(this.cli.command || '').trim();
    if (!command) {
      const err = new Error('The Command harness has no command configured. Open Settings → Engines → Command harness and enter one.');
      err.sleepPilotType = 'provider.config';
      throw err;
    }
    const vars = { prompt: text, project: session.directory, model: session.model?.id || 'default', sessionId: session.id };
    const fill = (s) => String(s).replace(/\{(prompt|project|model|sessionId)\}/g, (_, k) => vars[k] || '');
    const args = (this.cli.args || []).map(fill).concat((this.cli.appendArgs || []).map(fill));
    // promptVia=stdin: pipe the prompt; promptVia=arg: substitute {prompt} or append it.
    const useStdin = this.cli.promptVia !== 'arg';
    if (!useStdin && !args.some((a) => a.includes(String(text)))) args.push(String(text));
    const env = { ...process.env };
    for (const [k, v] of Object.entries(this.cli.env || {})) if (k) env[k] = String(v);
    const spec = resolveSpawn(command, args);
    const child = spawn(spec.file, spec.args, {
      cwd: session.directory,
      env,
      windowsHide: true,
      windowsVerbatimArguments: spec.verbatim,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    rec.child = child;
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      rec.interrupted = true;
      killTree(child.pid);
    }, Math.max(1, Number(this.cli.timeoutMin) || 720) * 60_000);
    timer.unref?.();
    if (useStdin) child.stdin.end(String(text || ''), 'utf8');
    else child.stdin.end();
    child.stdout.on('data', (d) => {
      stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d) => {
      stderr = (stderr + d.toString('utf8')).slice(-20_000);
    });
    const code = await new Promise((resolve) => {
      child.once('error', (err) => {
        stderr += `\n${err.message}`;
        resolve(null);
      });
      child.once('close', resolve);
    });
    clearTimeout(timer);
    const interrupted = rec.interrupted;
    const finalText = stdout.trim();
    const status = interrupted ? 'interrupted' : code === 0 ? 'succeeded' : 'failed';
    const errors = status === 'failed' ? [{ type: 'provider.transport', message: (stderr || `Command exited with code ${code}.`).slice(-4000), classification: classifyError({ type: 'provider.transport', message: stderr }) }] : [];
    const result = {
      status,
      sessionID: session.id,
      messageId,
      startedAt,
      endedAt: Date.now(),
      outcome: status === 'succeeded' ? 'succeeded' : status === 'interrupted' ? 'interrupted' : 'failed',
      finalText,
      allText: finalText,
      tools: [],
      errors,
      usage: { cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, models: [`cli/${path.basename(command)}`] },
      transcript: finalText ? [{ type: 'text', text: finalText }] : [],
      snapshotFiles: [],
      engine: 'cli',
      exitCode: code,
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
    if (!session || !session.turns?.[messageId]) return { found: false, user: null, after: [] };
    const record = session.turns[messageId];
    const result = record.status === 'running'
      ? { status: 'interrupted', startedAt: record.startedAt, endedAt: Date.now(), errors: [{ type: 'provider.transport', message: 'SleepPilot restarted while the command was running; it is not sent again.' }], transcript: [], usage: { cost: 0, tokens: {} }, finalText: '' }
      : record.result;
    return {
      found: true,
      user: { id: messageId, type: 'user' },
      after: [
        { type: 'assistant', id: `${messageId}_a`, content: result.transcript?.length ? result.transcript.map((t) => ({ type: 'text', text: t.text })) : [], cost: 0, tokens: {}, time: { created: result.startedAt } },
        { type: 'idle', outcome: result.status === 'succeeded' ? 'succeeded' : result.status === 'interrupted' ? 'interrupted' : 'failed', time: { created: result.endedAt || Date.now() }, error: result.errors?.[0] ? { type: result.errors[0].type, message: result.errors[0].message } : undefined },
      ],
    };
  }

  async usageLimits() {
    return { supported: false, data: null };
  }
}

function failure(sessionID, messageId, startedAt, message, type = 'provider.transport') {
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
    errors: [{ type, message, classification: classifyError({ type, message }) }],
    usage: { cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, models: [] },
    transcript: [],
    snapshotFiles: [],
    engine: 'cli',
  };
}
