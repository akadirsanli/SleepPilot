// The in-app assistant: deterministic status, context in the prompt, model fallback and history.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupEnv, makeApp } from './helpers.mjs';
import { buildPrompt, buildStatus, resolveModel, sanitizeAssistantSettings } from '../../src/assistant/assistant.mjs';

test('assistant: settings are sanitised to three known engines', () => {
  const s = sanitizeAssistantSettings({ models: [{ engine: 'claude', model: 'haiku' }, { engine: 'nope' }, { engine: 'opencode', model: 'opencode-go/x' }, { engine: 'api' }, { engine: 'codex' }] }, ['claude', 'opencode', 'api', 'codex']);
  assert.deepEqual(s.models.map((m) => m.engine), ['claude', 'opencode', 'api']);
  assert.equal(s.enabled, true);
  const engine = { id: 'opencode', models: [{ providerID: 'opencode-go', id: 'glm' }], defaultModel: { providerID: 'opencode-go', id: 'glm' } };
  assert.deepEqual(resolveModel(engine, ''), { providerID: 'opencode-go', id: 'glm' });
  assert.deepEqual(resolveModel(engine, 'glm'), { providerID: 'opencode-go', id: 'glm' });
  assert.deepEqual(resolveModel(engine, 'anthropic/claude-x'), { providerID: 'anthropic', id: 'claude-x' });
  assert.deepEqual(resolveModel({ id: 'claude', models: [] }, 'haiku'), { providerID: 'claude', id: 'haiku' });
});

test('assistant: status explains signed-out engines and paused runs without a model call', () => {
  const state = {
    engines: { default: 'claude', engines: [{ id: 'claude', label: 'Claude Code', status: { state: 'connected', message: 'Claude Code ready · not signed in — run `claude auth login`' } }] },
    activeRuns: [],
  };
  const items = buildStatus({ state, project: { name: 'P', objective: { text: '' }, checks: [] }, run: { state: 'paused', pause: { code: 'provider_config', label: 'Model check failed', message: 'Not logged in · Please run /login' }, tasks: [] }, workspace: { configured: false } });
  const titles = items.map((i) => i.title).join(' | ');
  assert.match(titles, /Claude Code is not signed in/);
  assert.match(titles, /Run paused: Model check failed/);
  assert.match(titles, /No workspace yet/);
  assert.match(titles, /no goal yet/);
  assert.equal(items[0].level, 'error', 'errors come first');
  assert.ok(items.find((i) => /not signed in/.test(i.title)).detail.includes('claude auth login'));
  const prompt = buildPrompt({ question: 'Neden durdu?', history: [{ role: 'user', text: 'hi' }], live: 'LIVE', screen: { view: 'run', text: 'Run paused api_key=sk-abcdefghijklmnopqrstuvwx' } });
  assert.match(prompt, /Answer in the language the user writes in/);
  assert.match(prompt, /=== LIVE STATE ===\nLIVE/);
  assert.match(prompt, /User: hi/);
  assert.ok(!prompt.includes('sk-abcdefghijklmnopqrstuvwx'), 'secrets on the screen are redacted');
});

test('assistant: answers with context, falls back to the next model, keeps history', { timeout: 120_000 }, async () => {
  const { project: dir } = setupEnv('assistant');
  const app = await makeApp();
  try {
    fs.writeFileSync(path.join(dir, 'index.html'), '<h1>x</h1>');
    const project = await app.createProject({ name: 'helper', dir });
    let view = await app.assistantView({ projectId: project.id });
    assert.ok(view.status.some((s) => /no goal yet/.test(s.title)));
    assert.deepEqual(view.candidates.map((c) => c.engine), ['opencode'], 'default: the default engine');

    // 1st choice: the command harness without a command (not available) → 2nd choice answers.
    view = await app.saveAssistantSettings({ models: [{ engine: 'cli', model: '' }, { engine: 'opencode', model: '' }] });
    assert.deepEqual(view.settings.models.map((m) => m.engine), ['cli', 'opencode']);
    const progress = [];
    app.assistant.on('progress', (p) => progress.push(p.text));
    const r = await app.assistantAsk({ question: 'What should I do next?', projectId: project.id, view: 'project', screen: 'Goal (empty) Start run' });
    assert.ok(r.answer, JSON.stringify(r));
    assert.equal(r.used.engine, 'opencode');
    assert.equal(r.attempts.length, 1);
    assert.equal(r.attempts[0].engine, 'cli');
    assert.ok(progress.some((t) => /Trying the next choice/.test(t)));
    view = await app.assistantView({ projectId: project.id });
    assert.equal(view.history.length, 2);
    assert.equal(view.history[1].fallback, true);
    // History survives a restart of the assistant.
    app.assistant.history = null;
    assert.equal((await app.assistant.loadHistory()).length, 2);

    // No choice answers → a clear error message in the conversation.
    await app.saveAssistantSettings({ models: [{ engine: 'cli' }, { engine: 'dsh' }] });
    const fail = await app.assistantAsk({ question: 'Hello?', projectId: project.id });
    assert.equal(fail.answer, null);
    assert.equal(fail.attempts.length, 2);
    assert.match((await app.assistant.loadHistory()).at(-1).text, /None of the chosen models answered/);
    await app.clearAssistant();
    assert.equal((await app.assistant.loadHistory()).length, 0);
  } finally {
    await app.shutdown();
  }
});
