// Claude Code and Codex engines: detection, stream parsing, tool events, usage and session reuse.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.SLEEPPILOT_QUIET = '1';
const HERE = path.dirname(fileURLToPath(import.meta.url));

function wrapper(dir, name, script) {
  const cmd = path.join(dir, `${name}.cmd`);
  fs.writeFileSync(cmd, `@echo off\r\n"${process.execPath}" "%~dp0${script}" %*\r\n`);
  return cmd;
}

test('Claude Code engine: stream-json, tool events, usage and --resume', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-claude-'));
  fs.copyFileSync(path.join(HERE, '..', 'fake-claude', 'claude.mjs'), path.join(dir, 'claude.mjs'));
  const cli = wrapper(dir, 'claude', 'claude.mjs');
  const log = path.join(dir, 'args.log');
  process.env.FAKE_CLAUDE_ARGS = log;
  process.env.SLEEPPILOT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-claude-home-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-claude-project-'));

  const { ClaudeEngine } = await import('../../src/engines/claude/engine.mjs');
  const engine = new ClaudeEngine({ settings: { claude: { cliPath: cli, timeoutMin: 1 } } });
  await engine.connect();
  assert.equal(engine.status.state, 'connected', engine.status.message);
  assert.equal(engine.auth.loggedIn, true);
  // Saving global settings (cliPath: null = auto) must not erase the detected executable.
  engine.applySettings({ claude: { cliPath: null, timeoutMin: 1 } });
  assert.equal(engine.cli.cliPath, cli);

  const session = await engine.createSession({ directory: project, title: 'test', model: engine.defaultModel });
  const events = [];
  const turn = await engine.runTurn({ sessionID: session.id, text: 'Write hello', onEvent: (e) => events.push(e) });
  assert.equal(turn.status, 'succeeded', JSON.stringify(turn.errors));
  assert.match(turn.finalText, /Claude fake done/);
  assert.equal(turn.usage.tokens.input, 120);
  assert.equal(turn.usage.cost, 0.0002);
  assert.ok(turn.tools.some((t) => t.name === 'Write' && t.status === 'completed'));
  assert.ok(events.some((e) => e.kind === 'text'));
  assert.ok(events.some((e) => e.kind === 'tool' && e.phase === 'called'));

  const second = await engine.runTurn({ sessionID: session.id, text: 'Again' });
  assert.equal(second.status, 'succeeded');
  const logged = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(logged[0].includes('--session-id'));
  assert.ok(logged[1].includes('--resume'));
  const info = await engine.turnMessages(session.id, second.messageId);
  assert.equal(info.found, true);
  await engine.disconnect();
});

test('Codex engine: exec/resume, item events, usage and thread id', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-codex-'));
  fs.copyFileSync(path.join(HERE, '..', 'fake-codex', 'codex.mjs'), path.join(dir, 'codex.mjs'));
  const cli = wrapper(dir, 'codex', 'codex.mjs');
  const log = path.join(dir, 'args.log');
  process.env.FAKE_CODEX_ARGS = log;
  process.env.SLEEPPILOT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-codex-home-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-codex-project-'));

  const { CodexEngine } = await import('../../src/engines/codex/engine.mjs');
  const engine = new CodexEngine({ settings: { codex: { cliPath: cli, timeoutMin: 1 } } });
  await engine.connect();
  assert.equal(engine.status.state, 'connected', engine.status.message);
  assert.equal(engine.auth.loggedIn, true);
  engine.applySettings({ codex: { cliPath: null, timeoutMin: 1 } });
  assert.equal(engine.cli.cliPath, cli);

  const session = await engine.createSession({ directory: project, title: 'test', model: engine.defaultModel });
  const events = [];
  const turn = await engine.runTurn({ sessionID: session.id, text: 'Say hi', onEvent: (e) => events.push(e) });
  assert.equal(turn.status, 'succeeded', JSON.stringify(turn.errors));
  assert.match(turn.finalText, /Codex fake answer/);
  assert.equal(turn.usage.tokens.input, 200);
  assert.ok(turn.tools.some((t) => t.name === 'shell' && t.status === 'completed'));
  assert.ok(events.some((e) => e.kind === 'tool'));

  const second = await engine.runTurn({ sessionID: session.id, text: 'Again' });
  assert.equal(second.status, 'succeeded');
  const logged = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(logged[0].slice(0, 2), ['exec', '--json']);
  assert.deepEqual(logged[1].slice(0, 3), ['exec', 'resume', 'thread-fake-codex']);
  await engine.disconnect();
});
