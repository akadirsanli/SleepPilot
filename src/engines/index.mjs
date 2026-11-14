import { EventEmitter } from 'node:events';
import { OpenCodeAdapter } from '../opencode/adapter.mjs';
import { ApiEngine } from './api/engine.mjs';
import { ClaudeEngine } from './claude/engine.mjs';
import { CodexEngine } from './codex/engine.mjs';
import { DshEngine } from './dsh/engine.mjs';
import { CliEngine } from './cli/engine.mjs';
import { CredentialStore } from './credentials.mjs';
import { PROVIDER_PRESETS } from './api/providers.mjs';
import { defaultSettings, sanitizeSettings } from '../settings.mjs';

/**
 * Owns every execution backend and presents them as one list to the application and UI.
 * A run normally starts with one default engine; with routing enabled the RunController may connect
 * and use several adapters from this map (one per role/task route). Others stay disconnected until
 * selected, which keeps startup fast when the user only wants one engine.
 */
export class EngineManager extends EventEmitter {
  constructor({ settings = {}, credentials = null, testCommand = null } = {}) {
    super();
    this.settings = sanitizeSettings({ ...defaultSettings(), ...settings });
    this.credentials = credentials || new CredentialStore();
    this.testCommand = testCommand;
    this.engines = new Map();
    this.createEngines();
  }

  createEngines() {
    const common = { settings: this.settings, credentials: this.credentials };
    const opencode = new OpenCodeAdapter({ settings: this.settings, testCommand: this.testCommand });
    opencode.id = 'opencode';
    opencode.label = 'OpenCode';
    const api = new ApiEngine(common);
    const claude = new ClaudeEngine(common);
    const codex = new CodexEngine(common);
    const dsh = new DshEngine(common);
    const cli = new CliEngine(common);
    this.engines = new Map([
      ['opencode', opencode],
      ['claude', claude],
      ['codex', codex],
      ['api', api],
      ['dsh', dsh],
      ['cli', cli],
    ]);
    for (const engine of this.engines.values()) {
      engine.on('status', (status) => this.emit('status', { engineId: engine.id, status }));
      engine.on('event', (ev) => this.emit('event', { engineId: engine.id, ev }));
      engine.on('stream', (s) => this.emit('stream', { engineId: engine.id, stream: s }));
    }
  }

  applySettings(settings) {
    this.settings = sanitizeSettings(settings);
    const opencode = this.engines.get('opencode');
    opencode.settings = this.settings;
    for (const id of ['api', 'claude', 'codex', 'dsh', 'cli']) this.engines.get(id)?.applySettings(this.settings);
  }

  get(id = this.settings.engine) {
    return this.engines.get(id) || this.engines.get('opencode');
  }

  get defaultEngine() {
    return this.get(this.settings.engine);
  }

  async init() {
    await this.credentials.load();
    this.applySettings(this.settings);
  }

  async connect(id = this.settings.engine, { force = false } = {}) {
    const engine = this.get(id);
    if (!engine) throw new Error(`Unknown engine: ${id}`);
    if (engine.connected && !force) return engine;
    if (force) {
      if (engine.restarts !== undefined) engine.restarts = 0;
      await engine.disconnect().catch(() => {});
    }
    this.emit('status', { engineId: engine.id, status: { state: 'connecting', message: `Connecting ${engine.label}…` } });
    await engine.connect();
    return engine;
  }

  /** Connect the default engine in the background; failures are reported through the status event. */
  connectDefault() {
    return this.connect(this.settings.engine).catch(() => null);
  }

  async ensureConnected(id = this.settings.engine) {
    const engine = this.get(id);
    if (engine.connected) return engine;
    await this.connect(id);
    if (!engine.connected) throw new Error(`${engine.label} is not available: ${engine.status.message}`);
    return engine;
  }

  async shutdown() {
    await Promise.all([...this.engines.values()].map((e) => e.disconnect().catch(() => {})));
  }

  providerView() {
    return (this.settings.providers || []).map((p) => ({
      id: p.id,
      preset: p.preset,
      label: p.label,
      protocol: p.protocol,
      baseUrl: p.baseUrl,
      apiKeyEnv: p.apiKeyEnv,
      requiresKey: p.requiresKey,
      enabled: p.enabled,
      stream: p.stream,
      maxOutputTokens: p.maxOutputTokens,
      models: p.models,
      hasKey: this.credentials.has(p.id, p.apiKeyEnv),
      keyFromEnv: !this.credentials.data?.providers?.[p.id] && !!process.env[p.apiKeyEnv],
    }));
  }

  view() {
    return {
      default: this.settings.engine,
      engines: [...this.engines.values()].map((engine) => ({
        ...(typeof engine.info === 'function' ? engine.info() : engineInfo(engine)),
        providers: engine.id === 'api' ? this.providerView() : undefined,
        notes: engine.providerNotes || undefined,
      })),
      settings: {
        engine: this.settings.engine,
        opencodePath: this.settings.opencodePath,
        api: this.settings.api,
        dsh: this.settings.dsh,
        cli: this.settings.cli,
        ui: this.settings.ui,
      },
      providers: this.providerView(),
      providerPresets: PROVIDER_PRESETS,
      dshEnvKeys: this.credentials.envNames(),
    };
  }
}

/** OpenCodeAdapter predates the AgentEngine base class; describe it the same way. */
function engineInfo(engine) {
  return {
    id: engine.id || 'opencode',
    label: engine.label || 'OpenCode',
    status: engine.status,
    detection: engine.detection
      ? {
          found: !!engine.detection.found,
          path: engine.detection.path || null,
          source: engine.detection.source || null,
          version: engine.detection.version?.raw || null,
          support: engine.detection.support || null,
        }
      : null,
    version: engine.serverInfo?.version || engine.status?.version || null,
    models: engine.models || [],
    agents: engine.agents || [],
    defaultModel: engine.defaultModel || null,
    capabilities: engine.capabilities || {},
  };
}

export { CredentialStore, ApiEngine, ClaudeEngine, CodexEngine, DshEngine, CliEngine, OpenCodeAdapter };
