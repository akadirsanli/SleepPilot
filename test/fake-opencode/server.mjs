#!/usr/bin/env node
/**
 * FAKE OpenCode 2.x server — a TEST DOUBLE, not OpenCode.
 *
 * Implements the subset of the OpenCode 2.x HTTP API that SleepPilot uses, with the same
 * auth (Basic, user "opencode", password from OPENCODE_PASSWORD), the same startup line,
 * an /openapi.json with matching operationIds, durable messages with idle markers, SSE events,
 * permission requests, forms, interrupt, and structured provider errors.
 *
 * Agent behaviour is scripted. The "developer" executes ACTION lines found in the
 * CURRENT TASK block of its prompt:
 *   ACTION: write <relpath> <content with \n escapes>
 *   ACTION: append <relpath> <content>
 *   ACTION: slow <ms>                      (interruptible wait)
 *   ACTION: permission <shell command>     (asks permission; waits for reply)
 *   ACTION: form <question title>          (asks a question; waits for reply)
 *   ACTION: provider-error <type> <times>  (fail this many turns with a structured error, then succeed)
 *   ACTION: status <done|blocked|needs_user|partial> <reason>
 * The "manager" returns plans from SLEEPPILOT_FAKE_PLAN (JSON file) or a default HTML plan.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { OPERATIONS } from '../../src/opencode/client.mjs';

const password = process.env.OPENCODE_PASSWORD;
if (!password) {
  console.error('OPENCODE_PASSWORD missing');
  process.exit(2);
}
const expectedAuth = 'Basic ' + Buffer.from('opencode:' + password).toString('base64');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const STEP_MS = Number(process.env.SLEEPPILOT_FAKE_STEP_MS || 60);
// Optional reviewer latency for tests that must prove reviews overlap: SLEEPPILOT_FAKE_REVIEW_MS,
// limited to review prompts matching the SLEEPPILOT_FAKE_REVIEW_MATCH regex when that is set.
const REVIEW_MS = Number(process.env.SLEEPPILOT_FAKE_REVIEW_MS || 0);
const REVIEW_MATCH = process.env.SLEEPPILOT_FAKE_REVIEW_MATCH ? new RegExp(process.env.SLEEPPILOT_FAKE_REVIEW_MATCH) : null;

const sessions = new Map();
let startup503 = Number(process.env.SLEEPPILOT_FAKE_STARTUP_503 || 0);
// Optional durable state (like OpenCode's database) so restart/recovery can be tested.
const STATE_FILE = process.env.SLEEPPILOT_FAKE_STATE;
if (STATE_FILE && fs.existsSync(STATE_FILE)) {
  for (const s of JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))) sessions.set(s.id, { ...s, queue: [], running: false, ctx: null });
}
function saveState() {
  if (!STATE_FILE) return;
  const data = [...sessions.values()].map(({ queue, running, ctx, ...rest }) => rest);
  fs.writeFileSync(STATE_FILE, JSON.stringify(data));
}
setInterval(saveState, 100).unref();
const permissions = new Map(); // id -> {req, resolve}
const forms = new Map();
const failCounters = new Map(); // key -> remaining failures
const sseClients = new Set();
let counter = 0;
const id = (p) => `${p}${Date.now().toString(36)}${(counter++).toString(36).padStart(4, '0')}${crypto.randomBytes(3).toString('hex')}`;

function emit(type, data, location) {
  const ev = { id: id('evt_'), created: Date.now(), type, ...(location ? { location } : {}), data };
  const line = `data: ${JSON.stringify(ev)}\n\n`;
  for (const c of sseClients) c.write(line);
}

function openapi() {
  const paths = {};
  for (const [opId, op] of Object.entries(OPERATIONS)) {
    paths[op.path] ??= {};
    paths[op.path][op.method.toLowerCase()] = { operationId: opId };
  }
  return { openapi: '3.1.0', info: { title: 'FAKE opencode HttpApi (SleepPilot test double)', version: '0.0.0-test' }, paths };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CANCELLED = Symbol('cancelled');

/** OpenCode 2.x ruleset semantics (verified on 2.0.32): wildcard match, the last matching rule wins, default ask. */
function evaluateRule(session, action, resource) {
  const re = (p) => new RegExp('^' + String(p).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 's');
  let effect = 'ask';
  for (const r of session.permissions || []) if (re(r.action).test(action) && re(r.resource).test(resource)) effect = r.effect;
  return effect;
}

function defaultPlan() {
  const file = process.env.SLEEPPILOT_FAKE_PLAN;
  if (file && fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  return JSON.parse(fs.readFileSync(path.join(HERE, 'default-plan.json'), 'utf8'));
}

function managerReply(text, session) {
  if (/Break the objective/.test(text)) {
    const plan = defaultPlan();
    return '```json\n' + JSON.stringify(plan) + '\n```';
  }
  if (/The user changed direction/.test(text)) {
    const instr = (text.match(/NEW USER INSTRUCTION:\n([\s\S]*?)\n\nTASKS:/) || [])[1]?.trim() || 'new instruction';
    const old = (text.match(/CURRENT OBJECTIVE \(version \d+\):\n([\s\S]*?)\n\nNEW USER INSTRUCTION/) || [])[1]?.trim() || '';
    const pending = [...text.matchAll(/- \[(T\d+)\] P\d (pending|test_failed)/g)].map((m) => m[1]);
    const extraActions = (instr.match(/ACTION:[^\n]*/g) || []).join('\n');
    return (
      '```json\n' +
      JSON.stringify({
        objective: `${old}\nPriority change: ${instr}`,
        change_summary: `User instruction applied: ${instr}`,
        task_updates: pending.map((tid) => ({ id: tid, priority: 4, reason: 'lowered because of the new priority' })),
        new_tasks: [{ title: `Instruction: ${instr.split('\n')[0].slice(0, 60)}`, description: `${instr}\n${extraActions || 'ACTION: write steering-result.txt instruction applied'}`, acceptance: ['the instruction is met'], priority: 1 }],
      }) +
      '\n```'
    );
  }
  if (/IMPROVEMENT MODE is enabled/.test(text)) return '```json\n{"new_tasks": [], "reasoning": "fake: no improvements"}\n```';
  if (/Decide the next step/.test(text)) {
    if (session.badJsonOnce && !session.badJsonServed) {
      session.badJsonServed = true;
      return 'not json';
    }
    return '```json\n{"decision": "continue", "next_task_id": null, "reasoning": "fake manager: continue by priority", "task_updates": [], "new_tasks": []}\n```';
  }
  if (/could not be parsed/.test(text)) return '```json\n{"decision": "continue", "reasoning": "fake: corrected json", "task_updates": [], "new_tasks": []}\n```';
  return '```json\n{}\n```';
}

function reviewerReply() {
  return '```json\n{"verdict": "pass", "issues": [], "missing_verification": [], "summary": "fake reviewer: looks fine"}\n```';
}

function currentTaskBlock(text) {
  const m = text.match(/CURRENT TASK \[[^\]]+\]:([\s\S]*?)AFTER YOU FINISH/);
  return m ? m[1] : text;
}

async function runDeveloper(session, text, ctx) {
  const block = currentTaskBlock(text);
  const actions = [...block.matchAll(/^ACTION:\s*(\S+)\s*(.*)$/gm)].map((m) => ({ verb: m[1], arg: m[2] }));
  const tools = [];
  let status = 'done';
  let reason = 'fake developer finished the actions';
  const dir = session.location.directory;
  for (const a of actions) {
    if (ctx.interrupted) break;
    if (a.verb === 'provider-error') {
      const [type, times] = a.arg.split(/\s+/);
      const key = `${session.id}:${crypto.createHash('sha1').update(block).digest('hex')}:${type}`;
      if (!failCounters.has(key)) failCounters.set(key, Number(times || 1));
      const left = failCounters.get(key);
      if (left > 0) {
        failCounters.set(key, left - 1);
        const status = { 'provider.rate-limit': 429, 'provider.quota': 402, 'provider.auth': 401, 'provider.transport': 503 }[type] || 400;
        throw Object.assign(new Error(`fake ${type}`), { structured: { type, message: `FAKE ${type}: simulated provider failure`, status } });
      }
      continue;
    }
    if (a.verb === 'write' || a.verb === 'append') {
      const sp = a.arg.indexOf(' ');
      const rel = sp < 0 ? a.arg : a.arg.slice(0, sp);
      const content = (sp < 0 ? '' : a.arg.slice(sp + 1)).replace(/\\n/g, '\n').replace(/\\t/g, '\t');
      const full = path.join(dir, rel);
      // OpenCode 2.2.0 checks file tools as action "edit" with the project-relative path.
      if (evaluateRule(session, 'edit', rel.replace(/\\/g, '/')) === 'deny') {
        ctx.toolError('write', { path: full }, { type: 'denied', message: 'Permission denied: edit' });
        tools.push({ name: 'write-denied', path: rel });
        continue;
      }
      fs.mkdirSync(path.dirname(full), { recursive: true });
      ctx.tool('write', { path: full });
      if (a.verb === 'write') fs.writeFileSync(full, content);
      else fs.appendFileSync(full, content);
      tools.push({ name: a.verb, path: rel });
      await sleep(STEP_MS);
    } else if (a.verb === 'slow') {
      const end = Date.now() + Number(a.arg || 1000);
      while (Date.now() < end && !ctx.interrupted) await sleep(50);
    } else if (a.verb === 'permission') {
      const effect = evaluateRule(session, 'shell', a.arg);
      if (effect === 'allow') {
        tools.push({ name: 'shell', command: a.arg });
        continue;
      }
      if (effect === 'deny') {
        ctx.toolError('shell', { command: a.arg }, { type: 'denied', message: 'Denied by permission rule' });
        continue;
      }
      const decision = await ctx.askPermission('shell', a.arg);
      if (decision === 'reject') {
        // Mirrors OpenCode 2.2.0: the declined tool errors with type "aborted", the step is
        // aborted, and execution stops WITHOUT an idle marker.
        ctx.toolError('shell', { command: a.arg }, { type: 'aborted', message: 'The user declined this tool call' });
        throw Object.assign(new Error('rejected'), { structured: { type: 'aborted', message: 'Step interrupted' }, noIdle: true });
      }
      tools.push({ name: 'shell', command: a.arg });
    } else if (a.verb === 'form') {
      // A denied question tool is simply not available to the model.
      if (evaluateRule(session, 'question', '*') === 'deny') continue;
      const answer = await ctx.askForm(a.arg);
      if (answer === CANCELLED) {
        // ASSUMPTION (not observed on real OpenCode): a dismissed question ends the step like a
        // declined permission — tool error, aborted step, no idle marker.
        ctx.toolError('question', { title: a.arg }, { type: 'aborted', message: 'The question was dismissed' });
        throw Object.assign(new Error('dismissed'), { structured: { type: 'aborted', message: 'Step interrupted' }, noIdle: true });
      }
      fs.writeFileSync(path.join(dir, 'form-answer.txt'), JSON.stringify(answer));
    } else if (a.verb === 'status') {
      const sp = a.arg.indexOf(' ');
      status = sp < 0 ? a.arg : a.arg.slice(0, sp);
      reason = sp < 0 ? '' : a.arg.slice(sp + 1);
    }
  }
  return `Fake developer summary. Performed ${tools.length} tool action(s): ${tools.map((t) => t.path || t.command).join(', ') || 'none'}.\nSLEEPPILOT_STATUS: ${status} — ${reason}`;
}

async function execute(session) {
  if (session.running) return;
  session.running = true;
  const loc = session.location;
  while (session.queue.length) {
    const user = session.queue.shift();
    const ctx = { interrupted: false };
    session.ctx = ctx;
    emit('session.execution.started', { sessionID: session.id });
    emit('session.inbox.delivered', { sessionID: session.id, inboxID: user.id }, loc);
    const asstId = id('msg_');
    const assistant = { id: asstId, type: 'assistant', time: { created: Date.now() }, agent: session.agent || 'build', model: session.model || { providerID: 'fake', id: 'test-model' }, content: [], cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } };
    emit('session.step.started', { sessionID: session.id, assistantMessageID: asstId, agent: assistant.agent, model: assistant.model }, loc);
    ctx.tool = (name, input) => {
      const cid = id('call_');
      emit('session.tool.input.started', { sessionID: session.id, assistantMessageID: asstId, id: cid, name }, loc);
      emit('session.tool.called', { sessionID: session.id, assistantMessageID: asstId, id: cid, input }, loc);
      emit('session.tool.success', { sessionID: session.id, assistantMessageID: asstId, id: cid, content: [{ type: 'text', text: `${name} ok` }] }, loc);
      assistant.content.push({ type: 'tool', id: cid, name, state: { status: 'completed', input, content: [{ type: 'text', text: `${name} ok` }] }, time: { created: Date.now() } });
    };
    ctx.toolError = (name, input, error) => {
      const cid = id('call_');
      emit('session.tool.input.started', { sessionID: session.id, assistantMessageID: asstId, id: cid, name }, loc);
      emit('session.tool.failed', { sessionID: session.id, assistantMessageID: asstId, id: cid, error }, loc);
      assistant.content.push({ type: 'tool', id: cid, name, state: { status: 'error', input, error }, time: { created: Date.now() } });
    };
    ctx.askPermission = (action, resource) =>
      new Promise((resolve) => {
        const req = { id: id('per_'), sessionID: session.id, action, resources: [resource], save: [resource.split(' ')[0] + ' *'], source: { type: 'tool', messageID: asstId } };
        permissions.set(req.id, { req, resolve });
        emit('permission.asked', req, loc);
        ctx.onInterrupt = () => {
          permissions.delete(req.id);
          resolve('reject');
        };
      });
    ctx.askForm = (title) =>
      new Promise((resolve) => {
        const form = { id: id('frm_'), sessionID: session.id, title, fields: [{ key: 'answer', type: 'string', title }] };
        forms.set(form.id, { form, resolve });
        emit('form.created', { form }, loc);
      });
    const text = user.text;
    let reply;
    let error = null;
    let noIdle = false;
    try {
      await sleep(STEP_MS);
      if (/SleepPilot model check/.test(text)) reply = 'OK';
      else if (/FACTS MEASURED BY SLEEPPILOT/.test(text)) reply = `FAKE closing report (test double).\n${(text.match(/Net change since the run started: [^\n]*/) || [''])[0]}`;
      else if (/You are the MANAGER/.test(text) || /could not be parsed/.test(text)) reply = managerReply(text, session);
      else if (/You are the REVIEWER/.test(text)) {
        if (REVIEW_MS && (!REVIEW_MATCH || REVIEW_MATCH.test(text))) await sleep(REVIEW_MS);
        reply = reviewerReply();
      }
      else reply = await runDeveloper(session, text, ctx);
    } catch (err) {
      error = err.structured || { type: 'unknown', message: err.message };
      noIdle = !!err.noIdle;
    }
    if (ctx.interrupted) error = { type: 'aborted', message: 'Step interrupted' };
    const tokens = { input: 1000 + text.length, output: 200 + (reply?.length || 0), reasoning: 0, cache: { read: 0, write: 0 } };
    assistant.tokens = tokens;
    assistant.cost = (tokens.input * 0.15 + tokens.output * 0.6) / 1e6;
    if (reply && !error) {
      // Reasoning ("thinking") like OpenCode 2.2.0: reasoning.* events + a durable reasoning part.
      const thought = `Fake reasoning: ${text.slice(0, 40).replace(/\s+/g, ' ')}…`;
      emit('session.reasoning.started', { sessionID: session.id, assistantMessageID: asstId, ordinal: 0 }, loc);
      emit('session.reasoning.delta', { sessionID: session.id, assistantMessageID: asstId, ordinal: 0, delta: thought }, loc);
      emit('session.reasoning.ended', { sessionID: session.id, assistantMessageID: asstId, ordinal: 0, text: thought }, loc);
      assistant.content.unshift({ type: 'reasoning', text: thought, time: { created: Date.now(), completed: Date.now() } });
      emit('session.text.started', { sessionID: session.id, assistantMessageID: asstId, ordinal: 0 }, loc);
      for (let i = 0; i < reply.length; i += 80) emit('session.text.delta', { sessionID: session.id, assistantMessageID: asstId, ordinal: 0, delta: reply.slice(i, i + 80) }, loc);
      emit('session.text.ended', { sessionID: session.id, assistantMessageID: asstId, ordinal: 0, text: reply }, loc);
      assistant.content.push({ type: 'text', text: reply });
    }
    assistant.time.completed = Date.now();
    if (error) {
      assistant.error = error;
      assistant.finish = 'error';
      emit('session.step.failed', { sessionID: session.id, assistantMessageID: asstId, error }, loc);
    } else assistant.finish = 'stop';
    emit('session.usage.updated', { sessionID: session.id, cost: assistant.cost, tokens });
    session.messages.push(assistant);
    session.cost += assistant.cost;
    if (noIdle) continue;
    const outcome = ctx.interrupted ? 'interrupted' : error ? 'failed' : 'succeeded';
    session.messages.push({ id: id('msg_'), type: 'idle', time: { created: Date.now() }, outcome, ...(error && !ctx.interrupted ? { error } : {}) });
    session.outcome = outcome;
    session.time.idle = Date.now();
    emit(`session.execution.${outcome}`, { sessionID: session.id, ...(ctx.interrupted ? { reason: 'user' } : {}) });
  }
  session.running = false;
  session.ctx = null;
}

function sessionInfo(s) {
  return { id: s.id, projectID: 'fake', title: s.title, agent: s.agent, model: s.model, cost: s.cost, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, outcome: s.outcome, time: s.time, location: s.location, permissions: s.permissions };
}

async function body(req) {
  let s = '';
  for await (const c of req) s += c;
  return s ? JSON.parse(s) : {};
}

const send = (res, status, data) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(data === undefined ? '' : JSON.stringify(data));
};

const server = http.createServer(async (req, res) => {
  if (req.headers.authorization !== expectedAuth) return send(res, 401, { _tag: 'UnauthorizedError', message: 'Authentication required' });
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  let m;
  try {
    if (p === '/openapi.json') return send(res, 200, openapi());
    if (p === '/api/info') return send(res, 200, { version: 'fake-2.x-test-double', pid: process.pid, urls: [], capabilities: {} });
    // Mirrors OpenCode 2.2.0 right after start: 503 until its plugins are active.
    if (p === '/api/model' && startup503 > 0) {
      startup503--;
      return send(res, 503, { _tag: 'ServiceUnavailableError', message: 'Location plugins did not finish activating' });
    }
    if (p === '/api/model') return send(res, 200, { location: {}, data: [{ id: 'fake/test-model', modelID: 'test-model', providerID: 'fake', name: 'Fake Test Model', enabled: true, status: 'active', cost: [{ input: 0.15, output: 0.6 }], limit: { context: 128000, output: 8000 } }, { id: 'fake/other-model', modelID: 'other-model', providerID: 'fake', name: 'Fake Other Model', enabled: true, status: 'active', cost: [], limit: { context: 64000, output: 4000 } }] });
    if (p === '/api/model/default') return send(res, 200, { location: {}, data: { modelID: 'test-model', providerID: 'fake', name: 'Fake Test Model' } });
    if (p === '/api/agent') return send(res, 200, { location: {}, data: [{ id: 'build', name: 'build', mode: 'primary', hidden: false }, { id: 'plan', name: 'plan', mode: 'primary', hidden: false }] });
    if (p === '/api/experimental/usage/limits') {
      const limited = process.env.SLEEPPILOT_FAKE_GO_LIMITED === '1';
      return send(res, 200, { location: {}, data: { workspace: { id: 'wrk_fake', usageURL: 'https://example.invalid' }, go: { rolling: { percent: limited ? 100 : 5, limited, resetsAt: Date.now() + 3600_000 }, weekly: { percent: 10, limited: false, resetsAt: Date.now() + 86400_000 }, monthly: { percent: 20, limited: false, resetsAt: Date.now() + 864000_000 } }, budgets: [] } });
    }
    if (p === '/api/event') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ id: id('evt_'), type: 'server.connected', data: {} })}\n\n`);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }
    if (p === '/api/session/active') return send(res, 200, { data: Object.fromEntries([...sessions.values()].filter((s) => s.running).map((s) => [s.id, { type: 'running' }])) });
    if (p === '/api/session' && req.method === 'POST') {
      const b = await body(req);
      const s = { id: id('ses_'), title: b.title, agent: b.agent, model: b.model, location: b.location, permissions: b.permissions, messages: [], queue: [], running: false, cost: 0, time: { created: Date.now(), updated: Date.now() }, badJsonOnce: process.env.SLEEPPILOT_FAKE_BAD_JSON === '1' };
      sessions.set(s.id, s);
      emit('session.created', { sessionID: s.id }, s.location);
      return send(res, 200, { data: sessionInfo(s) });
    }
    if ((m = p.match(/^\/api\/session\/(ses[^/]+)$/))) {
      const s = sessions.get(m[1]);
      return s ? send(res, 200, { data: sessionInfo(s) }) : send(res, 404, { _tag: 'SessionNotFoundError', message: 'not found' });
    }
    if ((m = p.match(/^\/api\/session\/(ses[^/]+)\/prompt$/))) {
      const s = sessions.get(m[1]);
      if (!s) return send(res, 404, { _tag: 'SessionNotFoundError' });
      const b = await body(req);
      const mid = b.id || id('msg_');
      const existing = s.messages.find((x) => x.id === mid) || s.queue.find((x) => x.id === mid);
      if (!existing) {
        const user = { id: mid, type: 'user', time: { created: Date.now() }, text: b.text, metadata: b.metadata };
        s.messages.push(user);
        s.queue.push(user);
        emit('session.inbox.enqueued', { sessionID: s.id, inboxID: mid }, s.location);
        setImmediate(() => execute(s));
      }
      return send(res, 200, { data: { id: mid, sessionID: s.id, time: { created: Date.now() }, type: 'user', payload: { text: b.text }, delivery: 'steer' } });
    }
    if ((m = p.match(/^\/api\/session\/(ses[^/]+)\/message$/))) {
      const s = sessions.get(m[1]);
      if (!s) return send(res, 404, { _tag: 'SessionNotFoundError' });
      // Mirrors OpenCode 2.2.0: the cursor is opaque and carries the order; combining it with
      // `order` is rejected with HTTP 400 InvalidCursorError.
      const rawCursor = url.searchParams.get('cursor');
      if (rawCursor && url.searchParams.get('order')) return send(res, 400, { _tag: 'InvalidCursorError', message: 'Cursor cannot be combined with order' });
      const cur = rawCursor ? JSON.parse(Buffer.from(rawCursor, 'base64url').toString()) : { offset: 0, order: url.searchParams.get('order') || 'desc' };
      const limit = Number(url.searchParams.get('limit') || 50);
      const list = cur.order === 'asc' ? [...s.messages] : [...s.messages].reverse();
      const page = list.slice(cur.offset, cur.offset + limit);
      const next = cur.offset + limit < list.length ? Buffer.from(JSON.stringify({ offset: cur.offset + limit, order: cur.order })).toString('base64url') : null;
      return send(res, 200, { data: page, cursor: { next, previous: null } });
    }
    if ((m = p.match(/^\/api\/session\/(ses[^/]+)\/interrupt$/))) {
      const s = sessions.get(m[1]);
      if (!s?.running) return send(res, 200, { interrupted: false });
      s.ctx.interrupted = true;
      s.ctx.onInterrupt?.();
      return send(res, 200, { interrupted: true });
    }
    if ((m = p.match(/^\/api\/session\/(ses[^/]+)\/permission$/))) return send(res, 200, { data: [...permissions.values()].filter((x) => x.req.sessionID === m[1]).map((x) => x.req) });
    if ((m = p.match(/^\/api\/session\/(ses[^/]+)\/permission\/([^/]+)\/reply$/))) {
      const entry = permissions.get(m[2]);
      if (!entry) return send(res, 404, { _tag: 'PermissionNotFoundError' });
      const b = await body(req);
      permissions.delete(m[2]);
      emit('permission.replied', { sessionID: m[1], requestID: m[2], reply: b.decision });
      entry.resolve(b.decision);
      res.writeHead(204).end();
      return;
    }
    if ((m = p.match(/^\/api\/session\/(ses[^/]+)\/form$/))) return send(res, 200, { data: [...forms.values()].filter((x) => x.form.sessionID === m[1]).map((x) => x.form) });
    if ((m = p.match(/^\/api\/session\/(ses[^/]+)\/form\/([^/]+)$/)) && req.method === 'DELETE') {
      const entry = forms.get(m[2]);
      if (!entry) return send(res, 404, { _tag: 'FormNotFoundError' });
      forms.delete(m[2]);
      emit('form.cancelled', { sessionID: m[1], formID: m[2] });
      entry.resolve(CANCELLED);
      res.writeHead(204).end();
      return;
    }
    if ((m = p.match(/^\/api\/session\/(ses[^/]+)\/form\/([^/]+)\/reply$/))) {
      const entry = forms.get(m[2]);
      if (!entry) return send(res, 404, { _tag: 'FormNotFoundError' });
      const b = await body(req);
      forms.delete(m[2]);
      emit('form.replied', { sessionID: m[1], formID: m[2] });
      entry.resolve(b.answer);
      res.writeHead(204).end();
      return;
    }
    if ((m = p.match(/^\/api\/session\/(ses[^/]+)\/diff$/))) return send(res, 200, { data: [] });
    return send(res, 404, { _tag: 'NotFound', message: p });
  } catch (err) {
    return send(res, 500, { _tag: 'InternalError', message: err.message });
  }
});

server.listen(0, '127.0.0.1', () => {
  console.log(`server listening on http://127.0.0.1:${server.address().port}`);
});
