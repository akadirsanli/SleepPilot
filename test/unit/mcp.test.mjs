// MCP servers: settings, per-engine formats, role filter and secrets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.SLEEPPILOT_QUIET = '1';
process.env.SLEEPPILOT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-mcp-home-'));
const HERE = path.dirname(fileURLToPath(import.meta.url));

const SETTINGS = {
  mcp: {
    servers: [
      { name: 'playwright', command: 'npx', args: ['-y', '@playwright/mcp@latest'], roles: 'all' },
      { name: 'github', command: 'npx', args: ['-y', 'gh-mcp'], env: ['GITHUB_TOKEN', 'bad name'], roles: 'developer', engines: ['claude', 'codex'] },
      { name: 'docs', url: 'https://example.com/mcp', roles: 'developer' },
      { name: 'off', command: 'x', enabled: false },
      { name: '1bad', command: 'x' },
      { name: 'nourl', url: 'ftp://x' },
      { name: 'playwright', command: 'dup' },
    ],
  },
};

test('mcp: settings keep only valid, unique servers', async () => {
  const { sanitizeMcpSettings } = await import('../../src/mcp/mcp.mjs');
  const s = sanitizeMcpSettings(SETTINGS.mcp);
  assert.deepEqual(s.servers.map((x) => x.name), ['playwright', 'github', 'docs', 'off']);
  assert.deepEqual(s.servers[1].env, ['GITHUB_TOKEN']);
  assert.deepEqual(s.servers[1].engines, ['claude', 'codex']);
  assert.deepEqual(s.servers[0].engines, ['claude', 'codex', 'opencode']);
  assert.equal(s.servers[3].enabled, false);
});

test('mcp: each engine gets its own format; read-only roles get only "all" servers', async () => {
  const { serversFor, claudeMcpConfig, codexMcpArgs, opencodeMcpConfig } = await import('../../src/mcp/mcp.mjs');
  const getEnv = (n) => (n === 'GITHUB_TOKEN' ? 'ghp_secretvalue123456789' : '');
  const dev = serversFor(SETTINGS, { engine: 'claude', getEnv });
  assert.deepEqual(dev.map((s) => s.name), ['playwright', 'github', 'docs']);
  const ro = serversFor(SETTINGS, { engine: 'claude', readOnly: true, getEnv });
  assert.deepEqual(ro.map((s) => s.name), ['playwright']);
  const claude = claudeMcpConfig(dev);
  assert.deepEqual(claude.mcpServers.github, { command: 'npx', args: ['-y', 'gh-mcp'], env: { GITHUB_TOKEN: 'ghp_secretvalue123456789' } });
  assert.deepEqual(claude.mcpServers.docs, { type: 'http', url: 'https://example.com/mcp' });
  const codex = codexMcpArgs(serversFor(SETTINGS, { engine: 'codex', getEnv }));
  assert.ok(codex.includes('mcp_servers.playwright.command="npx"'));
  assert.ok(codex.includes('mcp_servers.playwright.args=["-y","@playwright/mcp@latest"]'));
  assert.ok(codex.includes('mcp_servers.github.env={GITHUB_TOKEN="ghp_secretvalue123456789"}'));
  assert.ok(codex.includes('mcp_servers.docs.url="https://example.com/mcp"'));
  const oc = opencodeMcpConfig(serversFor(SETTINGS, { engine: 'opencode', getEnv }));
  assert.deepEqual(Object.keys(oc.mcp), ['playwright', 'docs'], 'github is limited to Claude and Codex');
  assert.deepEqual(oc.mcp.playwright, { type: 'local', command: ['npx', '-y', '@playwright/mcp@latest'], enabled: true });
  assert.deepEqual(oc.mcp.docs, { type: 'remote', url: 'https://example.com/mcp', enabled: true });
  assert.equal(opencodeMcpConfig([]), null);
  // The token is registered for redaction.
  const { redact } = await import('../../src/util/redact.mjs');
  assert.equal(redact('token ghp_secretvalue123456789 here').includes('ghp_secretvalue123456789'), false);
});

function fakeCli(dir, name, script) {
  if (process.platform === 'win32') {
    const cmd = path.join(dir, `${name}.cmd`);
    fs.writeFileSync(cmd, `@echo off\r\n"${process.execPath}" "%~dp0${script}" %*\r\n`);
    return cmd;
  }
  const exe = path.join(dir, name);
  fs.writeFileSync(exe, `#!${process.execPath}\nimport(${JSON.stringify(new URL(`file://${path.join(dir, script)}`).href)});\n`);
  fs.chmodSync(exe, 0o755);
  return exe;
}

test('mcp: Claude Code gets --mcp-config with allowed tools; read-only roles get fewer servers', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-mcp-claude-'));
  fs.copyFileSync(path.join(HERE, '..', 'fake-claude', 'claude.mjs'), path.join(dir, 'claude.mjs'));
  const cli = fakeCli(dir, 'claude', 'claude.mjs');
  const log = path.join(dir, 'args.log');
  process.env.FAKE_CLAUDE_ARGS = log;
  const { ClaudeEngine } = await import('../../src/engines/claude/engine.mjs');
  const credentials = { getEnv: (n) => (n === 'GITHUB_TOKEN' ? 'ghp_secretvalue123456789' : '') };
  const engine = new ClaudeEngine({ settings: { claude: { cliPath: cli, timeoutMin: 1 }, ...SETTINGS }, credentials });
  await engine.connect();
  assert.equal(engine.status.state, 'connected', engine.status.message);
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-mcp-proj-'));
  const dev = await engine.createSession({ directory: project, model: engine.defaultModel, permissions: [{ action: '*', resource: '*', effect: 'allow' }] });
  assert.equal((await engine.runTurn({ sessionID: dev.id, text: 'hi', metadata: { role: 'developer' } })).status, 'succeeded');
  const rev = await engine.createSession({ directory: project, model: engine.defaultModel, readOnly: true });
  assert.equal((await engine.runTurn({ sessionID: rev.id, text: 'review', metadata: { role: 'reviewer' } })).status, 'succeeded');
  const [devArgs, revArgs] = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const cfg = (args) => JSON.parse(fs.readFileSync(args[args.indexOf('--mcp-config') + 1], 'utf8'));
  assert.deepEqual(Object.keys(cfg(devArgs).mcpServers), ['playwright', 'github', 'docs']);
  assert.equal(devArgs[devArgs.indexOf('--allowedTools') + 1], 'mcp__playwright,mcp__github,mcp__docs');
  assert.deepEqual(Object.keys(cfg(revArgs).mcpServers), ['playwright']);
  assert.ok(!devArgs.join(' ').includes('ghp_secretvalue123456789'), 'the token is in the config file, not on the command line');
  if (process.platform !== 'win32') assert.equal(fs.statSync(devArgs[devArgs.indexOf('--mcp-config') + 1]).mode & 0o077, 0, 'config file is private');
  await engine.disconnect();
});
