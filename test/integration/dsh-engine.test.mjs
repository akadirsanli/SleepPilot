// DSH engine: detection through a fake dsh.cmd, a turn with NDJSON events, and session recovery.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.SLEEPPILOT_QUIET = '1';
const HERE = path.dirname(fileURLToPath(import.meta.url));

test('DeepSeek Harness engine: detect, stream a turn, persist the session', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-dsh-'));
  fs.copyFileSync(path.join(HERE, '..', 'fake-dsh', 'fake-dsh.mjs'), path.join(dir, 'fake-dsh.mjs'));
  const cmd = path.join(dir, 'dsh.cmd');
  fs.writeFileSync(cmd, `@echo off\r\n"${process.execPath}" "%~dp0fake-dsh.mjs" %*\r\n`);
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-dsh-project-'));
  process.env.SLEEPPILOT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-dsh-home-'));

  const { DshEngine } = await import('../../src/engines/dsh/engine.mjs');
  const engine = new DshEngine({ settings: { dsh: { cliPath: cmd, profile: 'headless', timeoutMin: 1 } } });
  await engine.connect();
  assert.equal(engine.status.state, 'connected', engine.status.message);
  assert.equal(engine.models[0].providerID, 'dsh');
  engine.applySettings({ dsh: { cliPath: null } });
  assert.ok(engine.dsh.cliPath, 'detected DSH path survives an auto-detect settings save');

  const session = await engine.createSession({ directory: project, title: 'test', model: engine.defaultModel });
  const events = [];
  const result = await engine.runTurn({ sessionID: session.id, text: 'Explain the file', onEvent: (e) => events.push(e) });
  assert.equal(result.status, 'succeeded', JSON.stringify(result));
  assert.match(result.finalText, /Fake DSH answer/);
  assert.ok(events.some((e) => e.kind === 'text'));
  assert.ok(events.some((e) => e.kind === 'tool'));

  const again = await engine.loadSession(session.id);
  assert.equal(again.dshSessionId, 'session-fake-1234');
  assert.ok(again.turns[result.messageId].result);
  const info = await engine.turnMessages(session.id, result.messageId);
  assert.equal(info.found, true);
  assert.ok(info.after.some((m) => m.type === 'idle'));
  await engine.disconnect();
});
