import fsp from 'node:fs/promises';
import path from 'node:path';
import { dataRoot } from '../util/paths.mjs';
import { registerSecret } from '../util/redact.mjs';

/**
 * MCP servers the coding agents may use (Settings → MCP). One list for all projects: OpenCode runs
 * as a single shared server, so a per-project list could not be honoured for it.
 *
 * A server is either a local command (stdio) or a remote URL (streamable HTTP). Environment
 * variable VALUES are never stored here — only their names; the values live in the credential store
 * (Settings → API providers → environment secrets) and are filled in when an engine starts.
 *
 * Supported engines: Claude Code (--mcp-config file), Codex (-c mcp_servers.<name>.…) and OpenCode
 * (OPENCODE_CONFIG_CONTENT at server start). The built-in API harness, DSH and custom CLIs do not
 * use MCP servers.
 *
 * roles: 'developer' (default) — only the developer gets the tools; 'all' — read-only roles
 * (manager, reviewer) get them too. Read-only roles still cannot write files.
 */
export const MCP_ENGINES = ['claude', 'codex', 'opencode'];

export const MCP_PRESETS = [
  { id: 'playwright', name: 'playwright', label: 'Playwright — drive a real browser (click, type, screenshot)', command: 'npx', args: ['-y', '@playwright/mcp@latest'], env: [], roles: 'all' },
  { id: 'context7', name: 'context7', label: 'Context7 — up-to-date library documentation', command: 'npx', args: ['-y', '@upstash/context7-mcp@latest'], env: [], roles: 'all' },
];

const NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/;
const ENV_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export function sanitizeMcpSettings(raw = {}) {
  const list = Array.isArray(raw?.servers) ? raw.servers : [];
  const seen = new Set();
  const servers = [];
  for (const s of list.slice(0, 20)) {
    const name = String(s?.name || '').trim();
    if (!NAME_RE.test(name) || seen.has(name)) continue;
    const url = String(s?.url || '').trim();
    const command = String(s?.command || '').trim();
    if (!url && !command) continue;
    if (url && !/^https?:\/\/[^\s]+$/i.test(url)) continue;
    seen.add(name);
    servers.push({
      name,
      enabled: s?.enabled !== false,
      ...(url ? { url: url.slice(0, 500) } : { command: command.slice(0, 500), args: (Array.isArray(s?.args) ? s.args : []).map(String).slice(0, 30) }),
      env: (Array.isArray(s?.env) ? s.env : []).map((e) => String(e).trim()).filter((e) => ENV_RE.test(e)).slice(0, 20),
      roles: s?.roles === 'all' ? 'all' : 'developer',
      engines: (Array.isArray(s?.engines) ? s.engines : MCP_ENGINES).filter((e) => MCP_ENGINES.includes(e)),
    });
  }
  return { servers };
}

/** The servers an engine/role gets, with environment values filled in from the credential store. */
export function serversFor(settings, { engine, readOnly = false, getEnv = () => '' } = {}) {
  const out = [];
  for (const s of sanitizeMcpSettings(settings?.mcp).servers) {
    if (!s.enabled || !s.engines.includes(engine)) continue;
    if (readOnly && s.roles !== 'all') continue;
    const env = {};
    for (const name of s.env) {
      const v = getEnv(name);
      if (v) {
        env[name] = v;
        registerSecret(v);
      }
    }
    out.push({ ...s, envValues: env });
  }
  return out;
}

/** Claude Code: the JSON for --mcp-config. */
export function claudeMcpConfig(servers) {
  const mcpServers = {};
  for (const s of servers) mcpServers[s.name] = s.url ? { type: 'http', url: s.url } : { command: s.command, args: s.args, ...(Object.keys(s.envValues).length ? { env: s.envValues } : {}) };
  return { mcpServers };
}

/** Write Claude Code's config file in SleepPilot's data folder (it may hold tokens). */
export async function writeClaudeMcpConfig(servers, key = 'default') {
  const dir = path.join(dataRoot(), 'mcp');
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, `claude-${String(key).replace(/[^\w.-]/g, '_')}.json`);
  await fsp.writeFile(file, JSON.stringify(claudeMcpConfig(servers), null, 2), { mode: 0o600 });
  await fsp.chmod(file, 0o600).catch(() => {});
  return file;
}

const tomlString = (s) => JSON.stringify(String(s));

/** Codex: one `-c key=value` pair per setting (values in TOML syntax). */
export function codexMcpArgs(servers) {
  const args = [];
  for (const s of servers) {
    const base = `mcp_servers.${s.name}`;
    if (s.url) args.push('-c', `${base}.url=${tomlString(s.url)}`);
    else {
      args.push('-c', `${base}.command=${tomlString(s.command)}`);
      args.push('-c', `${base}.args=[${s.args.map(tomlString).join(',')}]`);
      const env = Object.entries(s.envValues);
      if (env.length) args.push('-c', `${base}.env={${env.map(([k, v]) => `${k}=${tomlString(v)}`).join(',')}}`);
    }
  }
  return args;
}

/** OpenCode: the "mcp" section of its config, passed as OPENCODE_CONFIG_CONTENT. */
export function opencodeMcpConfig(servers) {
  const mcp = {};
  for (const s of servers) {
    mcp[s.name] = s.url
      ? { type: 'remote', url: s.url, enabled: true }
      : { type: 'local', command: [s.command, ...s.args], enabled: true, ...(Object.keys(s.envValues).length ? { environment: s.envValues } : {}) };
  }
  return Object.keys(mcp).length ? { mcp } : null;
}
