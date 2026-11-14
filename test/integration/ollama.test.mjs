// Ollama discovery, provider setup and a local API-engine turn against a fake local service.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.env.SLEEPPILOT_QUIET = '1';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, '..', 'fake-ollama', 'server.mjs');

function startFake() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [FAKE], { env: { ...process.env, FAKE_OLLAMA_PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => reject(new Error('fake Ollama did not start')), 15_000);
    child.stdout.on('data', (d) => {
      out += d.toString();
      const m = out.match(/listening (http:\/\/[^\s]+)/);
      if (m) {
        clearTimeout(timer);
        resolve({ child, url: m[1] });
      }
    });
    child.stderr.on('data', (d) => (out += d.toString()));
    child.on('exit', (code) => reject(new Error(`fake Ollama exited ${code}: ${out}`)));
  });
}

test('Ollama detection, provider creation and a local API turn', async () => {
  const fake = await startFake();
  try {
    const { detectOllama, ollamaProvider } = await import('../../src/engines/api/ollama.mjs');
    const status = await detectOllama({ baseUrl: fake.url });
    assert.equal(status.running, true);
    assert.equal(status.version, '0.9.9-test');
    assert.equal(status.models.length, 2);
    assert.equal(status.openaiBaseUrl, `${fake.url}/v1`);
    const provider = ollamaProvider(status);
    assert.equal(provider.id, 'ollama');
    assert.equal(provider.requiresKey, false);
    assert.equal(provider.baseUrl, `${fake.url}/v1`);
    assert.equal(provider.models.length, 2);

    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-ollama-home-'));
    process.env.SLEEPPILOT_HOME = home;
    fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ engine: 'api', ollama: { baseUrl: fake.url }, providers: [] }));
    const { SleepPilotApp } = await import('../../src/app/app.mjs');
    const app = new SleepPilotApp({ autoConnect: false });
    await app.init();
    const added = await app.addOllamaProvider({});
    assert.equal(added.provider.id, 'ollama');
    assert.equal(added.provider.baseUrl, `${fake.url}/v1`);
    assert.equal(added.status.models.length, 2);
    await app.manager.connect('api');
    assert.equal(app.manager.get('api').status.state, 'connected', app.manager.get('api').status.message);
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-ollama-project-'));
    const session = await app.manager.get('api').createSession({
      directory: project,
      title: 'Ollama local turn',
      model: { providerID: 'ollama', id: 'qwen2.5-coder:0.5b' },
      permissions: [],
    });
    const turn = await app.manager.get('api').runTurn({ sessionID: session.id, text: 'Say hello' });
    assert.equal(turn.status, 'succeeded', JSON.stringify(turn.errors));
    assert.match(turn.finalText, /Local Ollama test answer/);
    await app.shutdown();
  } finally {
    fake.child.kill('SIGTERM');
  }
});
