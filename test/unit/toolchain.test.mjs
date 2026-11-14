// Toolchain detection: candidate paths, diagnostics, and manual overrides.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.SLEEPPILOT_QUIET = '1';

test('candidate expansion handles environment variables and home', async () => {
  const { expandCandidate } = await import('../../src/tools/probe.mjs');
  const home = await expandCandidate('%USERPROFILE%');
  assert.equal(home[0], process.env.USERPROFILE || process.env.HOME);
  const tilde = await expandCandidate('~');
  assert.equal(tilde[0], os.homedir());
  const mixed = await expandCandidate('%USERPROFILE%' + path.sep + '.cargo' + path.sep + 'bin');
  assert.match(mixed[0], /\.cargo/);
});

test('tool detection reports attempts and falls back to manual overrides', async () => {
  const { detectTools } = await import('../../src/tools/detect-tools.mjs');
  const result = await detectTools(null, {
    overrides: {
      node: { status: 'installed', path: process.execPath, note: 'test path' },
      '7zip': { status: 'ignored', note: 'not needed' },
      rizin: { status: 'missing', note: 'not installed here' },
    },
  });
  const node = result.tools.find((t) => t.id === 'node');
  assert.equal(node.status, 'ok');
  assert.equal(node.overridden, true);
  assert.equal(node.manual, true);
  assert.equal(node.path, process.execPath);
  const seven = result.tools.find((t) => t.id === '7zip');
  assert.equal(seven.status, 'ignored');
  assert.equal(seven.overridden, true);
  const rizin = result.tools.find((t) => t.id === 'rizin');
  assert.equal(rizin.status, 'missing');
  assert.equal(rizin.overridden, true);
  // Auto-detected entries keep their diagnostics, even when the tool is absent.
  const rea = result.tools.find((t) => t.id === 'rea');
  assert.ok(Array.isArray(rea.attempts));
  assert.ok(rea.attempts.length > 0);
});

test('manual overrides and Ollama host survive settings sanitisation', async () => {
  const { sanitizeSettings } = await import('../../src/settings.mjs');
  const s = sanitizeSettings({
    toolOverrides: {
      cargo: { status: 'installed', path: 'C:\\Tools\\cargo.exe', version: '1.2.3', note: 'custom rust', at: 123 },
      bad: { status: 'nonsense', path: '/x' },
      '../escape': { status: 'installed' },
    },
    ollama: { baseUrl: 'http://127.0.0.1:11434' },
  });
  assert.equal(s.toolOverrides.cargo.status, 'installed');
  assert.equal(s.toolOverrides.cargo.path, 'C:\\Tools\\cargo.exe');
  assert.equal(s.toolOverrides.cargo.version, '1.2.3');
  assert.equal(s.toolOverrides.bad.status, 'installed');
  assert.equal(s.toolOverrides['../escape'], undefined);
  assert.equal(s.ollama.baseUrl, 'http://127.0.0.1:11434');
});

test('a manual path that does not answer the probe is flagged, not silently accepted', async () => {
  const { detectTools } = await import('../../src/tools/detect-tools.mjs');
  const result = await detectTools(null, { overrides: { cargo: { status: 'installed', path: 'C:\\definitely-not-cargo.exe' } } });
  const cargo = result.tools.find((t) => t.id === 'cargo');
  assert.equal(cargo.status, 'bad');
  assert.match(cargo.detail, /Manual path did not answer/);
});
