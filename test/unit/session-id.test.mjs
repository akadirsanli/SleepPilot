// SLEEPPILOT_SESSION_ID: a stable session id for recovery drills and debugging.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forcedSessionId, newEngineSessionId } from '../../src/util/ids.mjs';

const withEnv = (value, fn) => {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'SLEEPPILOT_SESSION_ID');
  const prev = process.env.SLEEPPILOT_SESSION_ID;
  if (value === undefined) delete process.env.SLEEPPILOT_SESSION_ID;
  else process.env.SLEEPPILOT_SESSION_ID = value;
  try {
    return fn();
  } finally {
    if (had) process.env.SLEEPPILOT_SESSION_ID = prev;
    else delete process.env.SLEEPPILOT_SESSION_ID;
  }
};

test('SLEEPPILOT_SESSION_ID accepts safe ids and is used by every session-owning engine', () => {
  withEnv('recovery-drill_1', () => {
    assert.deepEqual(forcedSessionId(), { id: 'recovery-drill_1', error: null });
    assert.equal(newEngineSessionId('api'), 'recovery-drill_1');
    assert.equal(newEngineSessionId('claude'), 'recovery-drill_1');
    assert.equal(newEngineSessionId('dsh'), 'recovery-drill_1');
  });
});

test('SLEEPPILOT_SESSION_ID rejects unsafe values loudly instead of using them', () => {
  const warnings = [];
  withEnv('../etc/passwd', () => {
    const r = forcedSessionId({ warn: (m) => warnings.push(m) });
    assert.equal(r.id, null);
    assert.match(r.error, /SLEEPPILOT_SESSION_ID/);
    assert.match(r.error, /\.\.\/etc\/passwd/);
  });
  assert.equal(warnings.length, 1);
  // A second call with the same bad value does not repeat the warning.
  withEnv('../etc/passwd', () => {
    forcedSessionId({ warn: (m) => warnings.push(m) });
  });
  assert.equal(warnings.length, 1);
  withEnv('ab', () => assert.match(forcedSessionId().error, /at least 3 characters/));
  withEnv('   ', () => assert.deepEqual(forcedSessionId(), { id: null, error: null }));
});

test('without the variable, engines generate their own branded ids', () => {
  withEnv(undefined, () => {
    assert.match(newEngineSessionId('api'), /^ses_api_[0-9a-f]{18}$/);
    assert.match(newEngineSessionId('claude'), /^ses_claude_[0-9a-f]{18}$/);
    // Different calls must not collide.
    assert.notEqual(newEngineSessionId('dsh'), newEngineSessionId('dsh'));
  });
});
