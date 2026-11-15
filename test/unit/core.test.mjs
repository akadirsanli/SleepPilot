import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseVersion, classifyVersion, detectOpenCode } from '../../src/opencode/detect.mjs';
import { classifyError } from '../../src/opencode/errors.mjs';
import { reconcileTurn } from '../../src/opencode/adapter.mjs';
import { extractJson, parseDeveloperStatus } from '../../src/orchestrator/json-extract.mjs';
import { makeTask, applyTaskUpdates, selectNextTask, setTaskStatus } from '../../src/orchestrator/tasks.mjs';
import { developerRuleset, readOnlyRuleset } from '../../src/orchestrator/permissions.mjs';
import { unifiedDiff, takeSnapshot, diffSnapshots } from '../../src/project/snapshot.mjs';
import { redact, registerSecret, redactDeep } from '../../src/util/redact.mjs';
import { verificationFrom } from '../../src/checks/runner.mjs';
import { sanitizeSettings } from '../../src/app/app.mjs';

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `sp-${name}-`));

test('parseVersion / classifyVersion', () => {
  assert.deepEqual(parseVersion('opencode v2.2.0'), { raw: '2.2.0', major: 2, minor: 2, patch: 0 });
  assert.equal(parseVersion('nothing here'), null);
  assert.equal(classifyVersion(parseVersion('1.19.4')).status, 'unsupported');
  assert.equal(classifyVersion(parseVersion('2.0.32')).status, 'supported');
  assert.equal(classifyVersion(parseVersion('3.0.0')).status, 'untested');
});

test('detectOpenCode: missing executable is reported, not guessed', async () => {
  const savedPath = process.env.PATH;
  const savedLocal = process.env.LOCALAPPDATA;
  const savedAppData = process.env.APPDATA;
  const empty = tmp('nooc');
  process.env.PATH = empty;
  process.env.LOCALAPPDATA = empty;
  process.env.APPDATA = empty;
  try {
    const d = await detectOpenCode({ override: path.join(empty, 'does-not-exist.exe') });
    // USERPROFILE locations may still exist on a dev machine; only assert when nothing was found.
    if (!d.found) {
      assert.equal(d.support.status, 'missing');
      assert.match(d.support.message, /not found/);
      assert.ok(d.tried.some((t) => t.result === 'not found'));
    }
  } finally {
    process.env.PATH = savedPath;
    process.env.LOCALAPPDATA = savedLocal;
    process.env.APPDATA = savedAppData;
  }
});

test('detectOpenCode: 1.x executable is detected as unsupported', { skip: process.platform !== 'win32' }, async () => {
  const dir = tmp('oc1');
  const fake = path.join(dir, 'opencode.cmd');
  fs.writeFileSync(fake, '@echo off\r\necho 1.19.4\r\n');
  const d = await detectOpenCode({ override: fake });
  assert.equal(d.found, true);
  assert.equal(d.version.raw, '1.19.4');
  assert.equal(d.support.status, 'unsupported');
});

test('classifyError: distinct handling for quota, 429, auth, transient, config', () => {
  assert.equal(classifyError({ type: 'provider.quota', message: 'x' }).category, 'quota');
  assert.equal(classifyError({ type: 'provider.quota', message: 'x' }).action, 'pause');
  assert.equal(classifyError({ type: 'provider.rate-limit', status: 429, message: 'slow down' }).action, 'retry');
  assert.equal(classifyError({ message: 'Too Many Requests', status: 429 }).category, 'rate_limit');
  assert.equal(classifyError({ type: 'provider.auth', status: 401, message: 'bad key' }).category, 'auth');
  assert.equal(classifyError({ type: 'provider.transport', message: 'ECONNRESET' }).category, 'transient');
  assert.equal(classifyError({ type: 'provider.invalid-request', status: 400, message: 'This Go model trains on request data' }).category, 'config');
  assert.equal(classifyError({ type: 'aborted', message: 'Step interrupted' }).action, 'none');
});

test('classifyError: a pay-as-you-go model without credits is a model choice, not a quota window', () => {
  const real = 'Insufficient balance. This request is pay-as-you-go, billed to OpenCode Models credits. Top up at https://opencode.ai/console/billing?credits=1. OpenCode Go covers only requests to the OpenCode Go provider.';
  const c = classifyError({ type: 'provider.quota', message: real });
  assert.equal(c.category, 'billing');
  assert.equal(c.action, 'pause');
  assert.match(c.hint, /opencode-go/);
  assert.equal(classifyError({ status: 402, message: 'Insufficient credit balance' }).category, 'billing');
  assert.doesNotMatch(classifyError({ message: 'Insufficient credit balance' }).hint, /opencode-go/, 'the Go hint only when the provider says so');
  assert.equal(classifyError({ type: 'provider.quota', message: 'Monthly usage limit reached' }).category, 'quota', 'a real allowance limit is still a quota');
});

test('reconcileTurn: idle marker after our message decides the outcome', () => {
  const after = [
    { type: 'assistant', model: { providerID: 'opencode-go', id: 'm' }, cost: 0.001, tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 1, write: 0 } }, content: [{ type: 'tool', name: 'write', state: { status: 'completed', input: { path: 'a' }, content: [{ type: 'text', text: 'ok' }] } }] },
    { type: 'assistant', model: { providerID: 'opencode-go', id: 'm' }, cost: 0.002, tokens: { input: 20, output: 5, reasoning: 0, cache: { read: 0, write: 0 } }, content: [{ type: 'text', text: 'DONE' }] },
    { type: 'idle', outcome: 'succeeded', time: { created: 5 } },
    // A later, unrelated idle (e.g. from another prompt) must not be used.
    { type: 'idle', outcome: 'failed', time: { created: 9 } },
  ];
  const r = reconcileTurn({ found: true, after }, { sessionID: 's', messageId: 'msg_x', startedAt: 1 });
  assert.equal(r.status, 'succeeded');
  assert.equal(r.finalText, 'DONE');
  assert.equal(r.tools.length, 1);
  assert.equal(r.usage.tokens.input, 30);
  assert.ok(Math.abs(r.usage.cost - 0.003) < 1e-9);

  const failed = reconcileTurn({ found: true, after: [{ type: 'assistant', content: [], error: { type: 'provider.rate-limit', message: '429', status: 429 } }, { type: 'idle', outcome: 'failed', error: { type: 'provider.rate-limit', message: '429' } }] }, {});
  assert.equal(failed.status, 'failed');
  assert.equal(failed.errors[0].classification.category, 'rate_limit');

  const running = reconcileTurn({ found: true, after: [{ type: 'assistant', content: [] }] }, {});
  assert.equal(running.status, 'running');
});

test('extractJson handles fences, prose and trailing commas', () => {
  assert.deepEqual(extractJson('blah\n```json\n{"a": 1,}\n```\n'), { a: 1 });
  assert.deepEqual(extractJson('Here: {"decision":"continue","x":{"y":"}"}} end'), { decision: 'continue', x: { y: '}' } });
  assert.equal(extractJson('no json at all'), null);
});

test('parseDeveloperStatus uses the last status line', () => {
  assert.deepEqual(parseDeveloperStatus('x\nSLEEPPILOT_STATUS: partial — a\nmore\nSLEEPPILOT_STATUS: done — all good'), { status: 'done', reason: 'all good' });
  assert.equal(parseDeveloperStatus('nothing').status, 'unreported');
  assert.equal(parseDeveloperStatus('SLEEPPILOT_STATUS: needs_user - which color?').reason, 'which color?');
});

test('task invariants: models cannot verify, completed work is preserved', () => {
  const t1 = makeTask({ title: 'a', priority: 2 }, { id: 'T1', objectiveVersion: 1 });
  const t2 = makeTask({ title: 'b', priority: 1 }, { id: 'T2', objectiveVersion: 1 });
  const t3 = makeTask({ title: 'c', priority: 1 }, { id: 'T3', objectiveVersion: 1 });
  t3.dependsOn = ['T1'];
  setTaskStatus(t1, 'verified', 'checks passed');
  applyTaskUpdates([t1, t2, t3], [
    { id: 'T1', status: 'cancelled' },
    { id: 'T2', status: 'verified' },
    { id: 'T3', priority: 5 },
  ]);
  assert.equal(t1.status, 'verified');
  assert.equal(t2.status, 'pending');
  assert.equal(t3.priority, 5);
  assert.equal(selectNextTask([t1, t2, t3]).id, 'T2');
  applyTaskUpdates([t1, t2, t3], [{ id: 'T2', status: 'cancelled', reason: 'not needed' }]);
  assert.equal(t2.status, 'cancelled');
  assert.equal(selectNextTask([t1, t2, t3]).id, 'T3');
});

test('permission rulesets: deny list comes last; read-only role denies everything first', () => {
  const r = developerRuleset('balanced');
  const lastAllow = r.map((x) => x.effect).lastIndexOf('allow');
  const firstDeny = r.findIndex((x) => x.effect === 'deny');
  assert.ok(firstDeny > lastAllow, 'deny rules must override allow rules (last match wins)');
  assert.ok(r.some((x) => x.resource === 'git push*' && x.effect === 'deny'));
  assert.ok(developerRuleset('broad').some((x) => x.action === 'shell' && x.resource === 'git commit*' && x.effect === 'deny'));
  assert.deepEqual(readOnlyRuleset()[0], { action: '*', resource: '*', effect: 'deny' });
});

test('snapshot diff detects add/modify/delete without Git', async () => {
  const dir = tmp('snap');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\nthree\n');
  fs.writeFileSync(path.join(dir, 'gone.txt'), 'bye');
  fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.writeFileSync(path.join(dir, 'node_modules', 'ignored.js'), 'x');
  const before = await takeSnapshot(dir);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\nTWO\nthree\n');
  fs.rmSync(path.join(dir, 'gone.txt'));
  fs.writeFileSync(path.join(dir, 'new.txt'), 'hi');
  const after = await takeSnapshot(dir);
  const d = diffSnapshots(before, after);
  assert.deepEqual(d.added, ['new.txt']);
  assert.deepEqual(d.modified, ['a.txt']);
  assert.deepEqual(d.deleted, ['gone.txt']);
  const p = d.patches.find((x) => x.file === 'a.txt');
  assert.match(p.patch, /-two/);
  assert.match(p.patch, /\+TWO/);
  assert.equal(p.additions, 1);
  assert.equal(p.deletions, 1);
});

test('unifiedDiff produces correct hunks', () => {
  const a = Array.from({ length: 20 }, (_, i) => `line${i}`).join('\n');
  const b = a.replace('line3', 'LINE3').replace('line15', 'LINE15');
  const d = unifiedDiff('f.txt', a, b);
  assert.equal((d.match(/^@@/gm) || []).length, 2);
  assert.match(d, /-line3\n\+LINE3/);
  assert.equal(unifiedDiff('f', 'same', 'same'), '');
});

test('redaction masks secrets in text and objects', () => {
  registerSecret('super-secret-password-123');
  assert.equal(redact('pw=super-secret-password-123!'), 'pw=<redacted>!');
  assert.match(redact('Authorization: Basic b3BlbmNvZGU6eHl6'), /<redacted>/);
  assert.match(redact('api_key: "abcd1234efgh"'), /<redacted>/);
  const fakeKey = ['sk', 'abcdefghijklmnopqrstuv'].join('-');
  assert.match(redact(`key ${fakeKey}`), /<redacted-key>/);
  assert.equal(redactDeep({ password: 'x', nested: { apiKey: 'y', ok: 'fine' } }).nested.apiKey, '<redacted>');
});

test('verificationFrom: only executed checks verify', () => {
  assert.equal(verificationFrom([]).verdict, 'none');
  assert.equal(verificationFrom([{ status: 'skipped' }, { status: 'error', name: 'x' }]).verdict, 'none');
  assert.equal(verificationFrom([{ status: 'passed' }]).verdict, 'passed');
  assert.equal(verificationFrom([{ status: 'passed' }, { status: 'failed', name: 'npm test' }]).verdict, 'failed');
});

test('sanitizeSettings clamps values and defaults safely', () => {
  const s = sanitizeSettings({ durationMin: '600', maxIterations: '', maxAttemptsSameFailure: 0, permissionProfile: 'nope', models: { developer: { providerID: 'opencode-go', id: 'x' } } });
  assert.equal(s.durationMin, 600);
  assert.equal(s.maxIterations, null);
  assert.equal(s.maxAttemptsSameFailure, 1);
  assert.equal(s.permissionProfile, 'balanced');
  assert.deepEqual(s.models.developer, { providerID: 'opencode-go', id: 'x' });
  assert.equal(s.models.manager, null);
});

test('permission profiles: old "broad" becomes full authority; full asks nothing but still denies the block list; %TEMP% is allowed everywhere', async () => {
  const { normalizeProfile } = await import('../../src/orchestrator/permissions.mjs');
  assert.equal(normalizeProfile('broad'), 'full');
  assert.equal(sanitizeSettings({ permissionProfile: 'broad' }).permissionProfile, 'full');
  const full = developerRuleset('full', { unattended: true });
  assert.deepEqual(full[0], { action: '*', resource: '*', effect: 'allow' });
  assert.ok(!full.some((r) => r.effect === 'ask'), 'nothing can wait for a person');
  assert.ok(full.some((r) => r.action === 'question' && r.effect === 'deny'));
  assert.deepEqual(full.at(-1).effect, 'deny');
  const tmpDir = os.tmpdir().replace(/\\/g, '/');
  for (const p of ['strict', 'balanced']) {
    const rules = developerRuleset(p);
    const ext = rules.filter((r) => r.action === 'external_directory');
    assert.equal(ext[0].effect, 'ask');
    assert.ok(ext.some((r) => r.resource === `${tmpDir}/*` && r.effect === 'allow'), `${p}: OpenCode temp folder allowed`);
  }
});

test('model advice is cheap by default: deepseek-v4.1-flash is the main model; only offered models are used; empty roles get filled', async () => {
  const { recommendModels, withRecommendedModels } = await import('../../src/orchestrator/model-advice.mjs');
  const m = (id) => ({ providerID: 'opencode-go', id });
  const r = recommendModels([m('deepseek-v4.1-flash'), m('glm-5.3-flash'), m('deepseek-v4-pro'), m('glm-5.3')]);
  assert.equal(r.developer.id, 'deepseek-v4.1-flash');
  assert.equal(r.manager.id, 'deepseek-v4.1-flash');
  assert.equal(r.reviewer.id, 'glm-5.3-flash', 'a cheap model of another family reviews');
  const only = recommendModels([m('deepseek-v4.1-flash')]);
  assert.equal(only.reviewer.id, 'deepseek-v4.1-flash');
  assert.deepEqual(recommendModels([]), { developer: null, manager: null, reviewer: null });
  const kept = withRecommendedModels({ manager: m('kimi-k3'), developer: null, reviewer: null }, [m('deepseek-v4.1-flash')]);
  assert.equal(kept.manager.id, 'kimi-k3', 'a user choice is never overwritten');
  assert.equal(kept.developer.id, 'deepseek-v4.1-flash');
});

test('generated files (build output, dependencies, lock files) are told apart from source code', async () => {
  const { isGeneratedPath } = await import('../../src/project/generated.mjs');
  for (const f of ['dist/App/_internal/_tcl_data/clock.tcl', 'build/math3d/PYZ-00.toc', 'node_modules/x/index.js', 'pkg/__pycache__/a.cpython-310.pyc', 'package-lock.json', 'web/app.min.js', 'x.egg-info/PKG-INFO']) assert.equal(isGeneratedPath(f), true, f);
  for (const f of ['src/build.py', 'math3d/mesh.py', 'ui/app.js', 'build_module.py', 'tests/test_dist.py', 'README.md']) assert.equal(isGeneratedPath(f), false, f);
});

test('line diff of a large file: small edit gives exact counts (common prefix/suffix trimmed)', () => {
  const old = Array.from({ length: 60_000 }, (_, i) => `line ${i}`).join('\n') + '\n';
  const neu = old.replace('line 30000\n', 'line 30000 changed\nline new\n');
  const d = unifiedDiff('big.py', old, neu);
  assert.equal((d.match(/^\+(?!\+\+ )/gm) || []).length, 2);
  assert.equal((d.match(/^-(?!-- )/gm) || []).length, 1);
});

test('backup: a folder over the size cap falls back to source files only instead of no backup', async () => {
  const { createBackup } = await import('../../src/project/backup.mjs');
  const dir = tmp('bk');
  fs.writeFileSync(path.join(dir, 'module_scripts.py'), 'x = 1\n');
  fs.mkdirSync(path.join(dir, 'Textures'));
  fs.writeFileSync(path.join(dir, 'Textures', 'big.dds'), Buffer.alloc(4000));
  process.env.SLEEPPILOT_HOME = tmp('bk-home');
  process.env.SLEEPPILOT_BACKUP_MAX_BYTES = '1000';
  try {
    const { createBackup: cb } = await import(`../../src/project/backup.mjs?cap=${Date.now()}`);
    const b = await cb('p1', dir);
    assert.equal(b.ok, true, b.error);
    assert.equal(b.mode, 'source');
    assert.equal(b.files, 1);
    assert.ok(fs.existsSync(path.join(b.path, 'module_scripts.py')));
    assert.ok(!fs.existsSync(path.join(b.path, 'Textures', 'big.dds')));
  } finally {
    delete process.env.SLEEPPILOT_BACKUP_MAX_BYTES;
  }
  assert.equal(typeof createBackup, 'function');
});

test('inspection finds a Git repository inside the chosen folder (e.g. game root → mod folder)', async () => {
  const { inspectProject } = await import('../../src/project/inspect.mjs');
  const dir = tmp('nested');
  fs.mkdirSync(path.join(dir, 'Modules', 'MyMod', '.git'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Modules', 'MyMod', 'module_info.py'), '');
  const insp = await inspectProject(dir);
  assert.deepEqual(insp.nestedRepos, ['Modules/MyMod']);
});

test('protected paths: outside folder → external_directory + shell deny; inside → project-relative edit deny (format verified on OpenCode 2.2.0)', async () => {
  const { protectedPathRules } = await import('../../src/orchestrator/permissions.mjs');
  const proj = String.raw`C:\ai\proj`;
  const rules = protectedPathRules([String.raw`C:\Games\Warband\Modules\Mod` + '\\',String.raw`C:\ai\proj\source`, '_src/header_*.py'], proj);
  const has = (action, resource) => rules.some((r) => r.action === action && r.resource === resource && r.effect === 'deny');
  assert.ok(has('external_directory', 'C:/Games/Warband/Modules/Mod/*'));
  // The path must end at a boundary, so a sibling such as `Mod-backup` is not blocked.
  assert.ok(has('shell', '*C:/Games/Warband/Modules/Mod/*'));
  assert.ok(has('shell', '*C:/Games/Warband/Modules/Mod"*'));
  assert.ok(has('shell', '*C:/Games/Warband/Modules/Mod'));
  assert.ok(has('shell', String.raw`*C:\Games\Warband\Modules\Mod\*`));
  assert.ok(!has('shell', '*C:/Games/Warband/Modules/Mod*'), 'no prefix-only pattern');
  assert.ok(has('edit', 'source/*') && has('write', 'source') && has('patch', 'source/*'));
  assert.ok(has('edit', '_src/header_*.py'));
  const full = developerRuleset('full', { unattended: true, protectedPaths: ['source'], projectDir: proj });
  assert.equal(full.at(-1).resource, 'source/*', 'protected rules come last so they win over "* * allow"');
});

test('py-syntax: interpreter can be chosen per check; Python 2 code fails under Python 3; a missing interpreter is reported', async () => {
  const { runChecks } = await import('../../src/checks/runner.mjs');
  const dir = tmp('py2');
  fs.writeFileSync(path.join(dir, 'old.py'), 'print "merhaba"\n');
  fs.writeFileSync(path.join(dir, 'new.py'), 'print("merhaba")\n');
  const [py3] = await runChecks({ projectDir: dir, checks: [{ id: 'p', type: 'py-syntax', name: 'p', enabled: true }], changedFiles: ['old.py'] });
  assert.equal(py3.status, 'failed', 'Python 2 print statement is invalid in Python 3');
  const [custom] = await runChecks({ projectDir: dir, checks: [{ id: 'p', type: 'py-syntax', name: 'p', enabled: true, interpreter: 'python' }], changedFiles: ['new.py'] });
  assert.equal(custom.status, 'passed', custom.output);
  assert.match(custom.output, /Python 3\./);
  const [missing] = await runChecks({ projectDir: dir, checks: [{ id: 'p', type: 'py-syntax', name: 'p', enabled: true, interpreter: 'tools/py27/python.exe' }], changedFiles: ['new.py'] });
  assert.equal(missing.status, 'error');
  assert.match(missing.output, /Could not run the interpreter/);
});


test('errors seen on a real run: cut-off provider stream and unknown provider types are retried; an OpenCode API 4xx is not a model-config error', async () => {
  const { OpenCodeHttpError, OpenCodeConnectionError } = await import('../../src/opencode/client.mjs');
  const cut = classifyError({ type: 'provider.invalid-output', message: 'OpenAI Chat stream ended without finish_reason' });
  assert.equal(cut.action, 'retry');
  assert.equal(cut.category, 'transient');
  assert.equal(classifyError({ type: 'provider.something-new', message: 'x' }).action, 'retry');
  assert.equal(classifyError({ message: 'Response still truncated after two output token limit continuations' }).action, 'retry', 'seen in a real run');
  const api = new OpenCodeHttpError(400, { _tag: 'InvalidCursorError', message: 'Cursor cannot be combined with order' }, 'session.message.list');
  assert.equal(api.name, 'OpenCodeHttpError', 'the controller recognises OpenCode errors by name');
  assert.equal(classifyError(api).category, 'opencode_api');
  assert.equal(new OpenCodeConnectionError('x', new Error('econnrefused')).name, 'OpenCodeConnectionError');
  assert.equal(classifyError({ type: 'provider.invalid-request', message: 'model not allowed' }).category, 'config', 'a real model/account problem still pauses');
});

test('turnMessages pages with the cursor alone (OpenCode 2.2.0 rejects cursor + order)', async () => {
  const { OpenCodeAdapter } = await import('../../src/opencode/adapter.mjs');
  const a = new OpenCodeAdapter({});
  const calls = [];
  const pages = [
    { data: [{ id: 'm5', type: 'assistant' }, { id: 'm4', type: 'assistant' }], cursor: { next: 'c1' } },
    { data: [{ id: 'm3', type: 'assistant' }, { id: 'u1', type: 'user' }], cursor: { next: null } },
  ];
  a.client = { call: async (op, { query }) => (calls.push(query), pages[calls.length - 1]) };
  a.requireClient = () => a.client;
  const r = await a.turnMessages('ses_x', 'u1');
  assert.equal(r.found, true);
  assert.deepEqual(r.after.map((m) => m.id), ['m3', 'm4', 'm5']);
  assert.deepEqual(calls[0], { limit: 100, order: 'desc' });
  assert.deepEqual(calls[1], { limit: 100, cursor: 'c1' });
});


test('parallel developers: wave selection respects file scopes, dependencies and priority; edit scope rules deny everything else', async () => {
  const { makeTask, selectWave, scopesOverlap, inScope } = await import('../../src/orchestrator/tasks.mjs');
  const { editScopeRules } = await import('../../src/orchestrator/permissions.mjs');
  const mk = (id, files, priority = 2) => makeTask({ title: id, files, priority }, { id, objectiveVersion: 1 });
  const t1 = mk('T1', ['ui/chart.js'], 1);
  const t2 = mk('T2', ['ui'], 2);
  const t3 = mk('T3', ['engine/caravan.py'], 2);
  const t4 = mk('T4', [], 2);
  const t5 = mk('T5', ['tests/test_*.py'], 3);
  const all = [t1, t2, t3, t4, t5];
  assert.deepEqual(selectWave(all, t1, 4).map((t) => t.id), ['T1', 'T3', 'T5'], 'T2 overlaps T1 (ui/), T4 has no scope');
  assert.deepEqual(selectWave(all, t1, 2).map((t) => t.id), ['T1', 'T3']);
  assert.deepEqual(selectWave(all, t4, 4).map((t) => t.id), ['T4'], 'a task without a scope runs alone');
  assert.deepEqual(selectWave(all, t1, 1).map((t) => t.id), ['T1']);
  assert.equal(scopesOverlap(['tests/test_*.py'], ['tests/test_a.py']), true);
  assert.equal(inScope('ui/chart.js', ['ui']), true);
  const rules = editScopeRules(['ui/chart.js']);
  const last = (action, res) => rules.filter((r) => r.action === action && (r.resource === '*' || r.resource === res)).at(-1)?.effect;
  assert.equal(last('edit', 'ui/chart.js'), 'allow');
  assert.equal(rules.find((r) => r.action === 'edit' && r.resource === '*').effect, 'deny');
});

test('tool catalog: version compare, version parsing, and read-only detection shape', async () => {
  const { cmpVersion, parseVersionFrom, TOOLS } = await import('../../src/tools/catalog.mjs');
  const { detectTools } = await import('../../src/tools/detect-tools.mjs');
  assert.equal(cmpVersion('20.10.0', '20.9.9'), 1);
  assert.equal(cmpVersion('2.7', '2.7.0'), 0);
  assert.equal(cmpVersion('18.0.0', '20.10.0'), -1);
  assert.equal(parseVersionFrom('git version 2.52.0.windows.1', /git version (\d+\.\d+\.\d+)/), '2.52.0');
  assert.equal(parseVersionFrom('Python 3.10.11', /Python (3\.\d+\.\d+)/), '3.10.11');
  assert.ok(TOOLS.every((t) => /^https:\/\//.test(t.download)), 'every tool links to an https source');
  assert.ok(TOOLS.filter((t) => t.category === 'reverse').length >= 3, 'reverse/Rust tools are listed');
  const r = await detectTools(null);
  assert.equal(r.tools.length, TOOLS.length);
  const node = r.tools.find((t) => t.id === 'node');
  assert.equal(node.status, 'ok');
  assert.match(node.version, /^\d+\.\d+\.\d+$/);
});

test('phone access helpers: Tailscale address detection and PC-only routes', async () => {
  const { isTailnetAddress, findTailscaleAddress, phoneMayCall } = await import('../../src/web/remote.mjs');
  assert.equal(isTailnetAddress('100.101.102.103'), true);
  assert.equal(isTailnetAddress('::ffff:100.64.0.1'), true);
  assert.equal(isTailnetAddress('100.128.0.1'), false);
  assert.equal(isTailnetAddress('192.168.1.20'), false);
  assert.equal(isTailnetAddress('127.0.0.1'), false);
  const ifaces = {
    Ethernet: [{ family: 'IPv4', address: '192.168.1.20', internal: false }],
    'Other VPN': [{ family: 'IPv4', address: '100.70.0.9', internal: false }],
    Tailscale: [{ family: 'IPv6', address: 'fd7a:115c::1', internal: false }, { family: 'IPv4', address: '100.101.102.103', internal: false }],
  };
  assert.equal(findTailscaleAddress(ifaces), '100.101.102.103');
  assert.equal(findTailscaleAddress({ Ethernet: ifaces.Ethernet }), null);
  assert.equal(phoneMayCall('GET', '/api/state'), true);
  assert.equal(phoneMayCall('POST', '/api/runs/p/r/stop'), true);
  assert.equal(phoneMayCall('POST', '/api/runs/p/r/permission'), true);
  for (const p of ['/api/secrets/provider', '/api/pick-folder', '/api/app/close', '/api/phone', '/api/phone/reset']) assert.equal(phoneMayCall('POST', p), false, p);
  assert.equal(phoneMayCall('GET', '/api/phone'), false);
});

test('QR encoder: structure and a decoder-verified snapshot', async () => {
  const { qrMatrix, qrSvg } = await import('../../src/util/qr.mjs');
  const crypto = await import('node:crypto');
  const text = 'http://100.101.102.103:47820/?t=abc';
  const m = qrMatrix(text);
  assert.equal(m.length, 29, 'version 3');
  // Finder pattern corners and timing pattern.
  for (const [x, y] of [[0, 0], [6, 6], [22, 0], [0, 22]]) assert.equal(m[y][x], true);
  assert.equal(m[1][1], false);
  assert.deepEqual([8, 9, 10, 11, 12].map((x) => m[6][x]), [true, false, true, false, true]);
  // This matrix was decoded back to the text with OpenCV's QR decoder when the encoder was written.
  const hash = crypto.createHash('sha1').update(m.map((r) => r.map(Number).join('')).join('\n')).digest('hex');
  assert.equal(hash, '80f4f3696161cf2d0b2ceb57cb62a18b5bf5a0b5');
  assert.equal(qrMatrix('x'.repeat(213)).length, 57, 'version 10 at the 213-byte limit');
  assert.throws(() => qrMatrix('x'.repeat(214)), /too long/);
  assert.match(qrSvg(text), /^<svg [^>]*viewBox="0 0 37 37"/);
});
