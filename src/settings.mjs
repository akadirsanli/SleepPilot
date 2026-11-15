import { newProvider, normalizeProvider } from './engines/api/providers.mjs';

export const ENGINE_IDS = ['opencode', 'claude', 'codex', 'api', 'dsh', 'cli'];

/**
 * Application-wide settings. Project settings live in the project record; this file only holds
 * what is shared: the default engine, engine configuration, provider list and UI preferences.
 * API keys are never part of this object (see engines/credentials.mjs).
 */
export function defaultSettings() {
  return {
    engine: 'opencode',
    maxConcurrentRuns: 3,
    opencodePath: null,
    providers: [newProvider('deepseek')],
    api: {
      maxSteps: 80,
      maxOutputChars: 24_000,
      maxContextChars: 420_000,
      temperature: 0.2,
      requestTimeoutSec: 600,
      permissionTimeoutMin: 10,
    },
    claude: {
      cliPath: null,
      model: null,
      permissionMode: 'auto',
      extraArgs: [],
      timeoutMin: 720,
    },
    codex: {
      cliPath: null,
      model: null,
      sandbox: 'workspace-write',
      extraArgs: [],
      timeoutMin: 720,
    },
    dsh: {
      cliPath: null,
      profile: 'headless',
      approvalPolicy: 'never',
      permissionMode: '',
      extraArgs: [],
      timeoutMin: 720,
    },
    cli: {
      command: '',
      args: [],
      appendArgs: [],
      promptVia: 'stdin',
      timeoutMin: 720,
      env: {},
    },
    ollama: {
      baseUrl: 'http://127.0.0.1:11434',
    },
    github: {
      ghPath: null,
      defaultVisibility: 'private',
      commitMessage: 'SleepPilot: update project',
    },
    toolOverrides: {},
    toolchain: {
      lastCheckedAt: null,
    },
    ui: {
      notifications: true,
      reducedMotion: false,
    },
    // Phone access over Tailscale (Settings → Phone). Off until the user turns it on.
    phone: {
      enabled: false,
      port: 47820,
    },
  };
}

/** Manual tool status overrides set from Settings → Toolchain. */
export function sanitizeToolOverrides(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const allowed = new Set(['installed', 'missing', 'ignored']);
  const out = {};
  for (const [id, value] of Object.entries(raw).slice(0, 80)) {
    if (!/^[a-z0-9_-]{1,40}$/i.test(id) || !value || typeof value !== 'object') continue;
    const status = allowed.has(value.status) ? value.status : 'installed';
    out[id] = {
      status,
      path: value.path ? String(value.path).slice(0, 1000) : null,
      version: value.version ? String(value.version).slice(0, 80) : null,
      note: value.note ? String(value.note).slice(0, 500) : null,
      at: Number(value.at) || Date.now(),
    };
  }
  return out;
}

const num = (v, fallback, min, max) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

const strOrNull = (v) => (v == null || String(v).trim() === '' ? null : String(v).trim());

export function sanitizeSettings(raw = {}) {
  const d = defaultSettings();
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    engine: ENGINE_IDS.includes(r.engine) ? r.engine : d.engine,
    maxConcurrentRuns: num(r.maxConcurrentRuns, d.maxConcurrentRuns, 1, 12),
    opencodePath: strOrNull(r.opencodePath),
    providers: (Array.isArray(r.providers) ? r.providers : d.providers).slice(0, 20).map((p, i) => normalizeProvider(p, i)),
    api: {
      maxSteps: num(r.api?.maxSteps, d.api.maxSteps, 1, 400),
      maxOutputChars: num(r.api?.maxOutputChars, d.api.maxOutputChars, 2000, 200_000),
      maxContextChars: num(r.api?.maxContextChars, d.api.maxContextChars, 20_000, 2_000_000),
      temperature: num(r.api?.temperature, d.api.temperature, 0, 2),
      requestTimeoutSec: num(r.api?.requestTimeoutSec, d.api.requestTimeoutSec, 30, 3600),
      permissionTimeoutMin: num(r.api?.permissionTimeoutMin, d.api.permissionTimeoutMin, 0, 240),
    },
    claude: {
      cliPath: strOrNull(r.claude?.cliPath),
      model: strOrNull(r.claude?.model),
      permissionMode: ['auto', 'plan', 'acceptEdits', 'bypassPermissions', 'manual', 'dontAsk'].includes(r.claude?.permissionMode) ? r.claude.permissionMode : 'auto',
      extraArgs: (Array.isArray(r.claude?.extraArgs) ? r.claude.extraArgs : []).map(String).slice(0, 30),
      timeoutMin: num(r.claude?.timeoutMin, d.claude.timeoutMin, 1, 7 * 24 * 60),
    },
    codex: {
      cliPath: strOrNull(r.codex?.cliPath),
      model: strOrNull(r.codex?.model),
      sandbox: ['read-only', 'workspace-write', 'danger-full-access'].includes(r.codex?.sandbox) ? r.codex.sandbox : 'workspace-write',
      extraArgs: (Array.isArray(r.codex?.extraArgs) ? r.codex.extraArgs : []).map(String).slice(0, 30),
      timeoutMin: num(r.codex?.timeoutMin, d.codex.timeoutMin, 1, 7 * 24 * 60),
    },
    dsh: {
      cliPath: strOrNull(r.dsh?.cliPath),
      profile: String(r.dsh?.profile || d.dsh.profile).replace(/[^\w.-]/g, '').slice(0, 60) || 'headless',
      approvalPolicy: ['ask', 'never'].includes(r.dsh?.approvalPolicy) ? r.dsh.approvalPolicy : 'never',
      permissionMode: String(r.dsh?.permissionMode || '').replace(/[^\w.-]/g, '').slice(0, 60),
      extraArgs: (Array.isArray(r.dsh?.extraArgs) ? r.dsh.extraArgs : []).map(String).slice(0, 30),
      timeoutMin: num(r.dsh?.timeoutMin, d.dsh.timeoutMin, 1, 7 * 24 * 60),
    },
    cli: {
      command: String(r.cli?.command || '').slice(0, 1000),
      args: (Array.isArray(r.cli?.args) ? r.cli.args : []).map(String).slice(0, 50),
      appendArgs: (Array.isArray(r.cli?.appendArgs) ? r.cli.appendArgs : []).map(String).slice(0, 50),
      promptVia: r.cli?.promptVia === 'arg' ? 'arg' : 'stdin',
      timeoutMin: num(r.cli?.timeoutMin, d.cli.timeoutMin, 1, 7 * 24 * 60),
      env: r.cli?.env && typeof r.cli.env === 'object' ? Object.fromEntries(Object.entries(r.cli.env).filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k)).slice(0, 20).map(([k, v]) => [k, String(v)])) : {},
    },
    ollama: {
      baseUrl: String(r.ollama?.baseUrl || d.ollama.baseUrl).slice(0, 500),
    },
    github: {
      ghPath: strOrNull(r.github?.ghPath),
      defaultVisibility: r.github?.defaultVisibility === 'public' ? 'public' : 'private',
      commitMessage: String(r.github?.commitMessage || d.github.commitMessage).slice(0, 200),
    },
    toolOverrides: sanitizeToolOverrides(r.toolOverrides),
    toolchain: {
      lastCheckedAt: Number(r.toolchain?.lastCheckedAt) || null,
    },
    ui: {
      notifications: r.ui?.notifications !== false,
      reducedMotion: !!r.ui?.reducedMotion,
    },
    phone: {
      enabled: r.phone?.enabled === true,
      port: Math.round(num(r.phone?.port, d.phone.port, 1024, 65535)),
    },
  };
}
