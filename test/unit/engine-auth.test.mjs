// Engine sign-in status: Claude Code / Codex report "Not logged in" in plain text or JSON.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SLEEPPILOT_QUIET = '1';


test('engines: "Not logged in" is never read as signed in', async () => {
  const { parseClaudeAuthStatus } = await import('../../src/engines/claude/engine.mjs');
  const { signedInFromText, classifyForEngine } = await import('../../src/engines/external-cli/engine.mjs');
  assert.equal(signedInFromText('Not logged in · Please run /login'), false);
  assert.equal(signedInFromText('Logged out'), false);
  assert.equal(signedInFromText('Logged in using ChatGPT'), true);
  assert.equal(signedInFromText('status unavailable'), null);
  assert.equal(parseClaudeAuthStatus('Not logged in · Please run /login').loggedIn, false);
  assert.equal(parseClaudeAuthStatus('{"loggedIn": false, "authMethod": "none"}').loggedIn, false);
  const withNoise = parseClaudeAuthStatus('Warning: something\n{"loggedIn": true, "authMethod": "claude.ai"}');
  assert.equal(withNoise.loggedIn, true);
  assert.equal(withNoise.label, 'signed in (claude.ai)');
  const c = classifyForEngine('claude', { type: 'provider.auth', message: 'Not logged in · Please run /login' });
  assert.equal(c.category, 'auth');
  assert.match(c.hint, /claude auth login/);
});
