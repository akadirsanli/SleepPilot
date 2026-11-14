import { ENGINE_IDS } from '../settings.mjs';

/**
 * Declarative multi-harness routing.
 *
 * A run still uses the normal engine contract. Routing only decides *which registered adapter*
 * receives a role/task turn and which model profile that adapter should use. This module is pure;
 * it does not connect adapters or execute turns.
 */

export const ROUTE_ROLES = ['manager', 'developer', 'reviewer', 'closing', 'preflight'];
export const HARNESS_IDS = [...ENGINE_IDS];
/** Harnesses that can enforce a read-only session at the adapter/sandbox level. */
export const READ_ONLY_CAPABLE = Object.freeze(['opencode', 'claude', 'codex', 'api']);

/**
 * Actual effort vocabulary per engine:
 * - API: DeepSeek-compatible reasoning_effort values (plus off/none as "no reasoning parameter").
 * - Claude Code: the CLI exposes --effort low|medium|high|xhigh|max.
 * - Codex: config `model_reasoning_effort` accepts minimal|low|medium|high.
 * - DSH/OpenCode/CLI: no effort flag is exposed by their current contract; an effort request is
 *   rejected rather than silently ignored.
 */
export const EFFORT_LEVELS = {
  api: ['off', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['minimal', 'low', 'medium', 'high'],
  dsh: [],
  opencode: [],
  cli: [],
};

const DEFAULT_ENGINE_ROUTE = {
  manager: ['claude', 'dsh', 'api', 'opencode'],
  developer: ['dsh', 'claude', 'api', 'opencode'],
  reviewer: ['api', 'claude', 'dsh', 'opencode'],
  closing: ['dsh', 'api', 'opencode'],
  preflight: ['claude', 'dsh', 'api', 'opencode'],
};

export class RoutingConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RoutingConfigError';
    this.code = 'ROUTING_CONFIG';
  }
}

export function defaultHarnessRouting() {
  return {
    enabled: false,
    roles: Object.fromEntries(ROUTE_ROLES.map((r) => [r, []])),
    taskTypes: {},
    fallbackChain: [],
    fallbackOnErrors: true,
    maxSwitches: 8,
    claudeWindowHours: 5,
    workingWindowHours: 10,
    quotaCooldownMin: { claude: 300, api: 30, codex: 30, dsh: 30, opencode: 30, cli: 30 },
  };
}

export function defaultModelProfiles() {
  return {
    api: {
      default: { model: null, effort: null },
      high: { model: null, effort: 'high' },
      'deepseek-high': { model: { providerID: 'deepseek', id: 'deepseek-chat' }, effort: 'high' },
    },
    claude: {
      default: { model: null, effort: null },
      high: { model: 'sonnet', effort: 'high' },
      max: { model: 'opus', effort: 'max' },
    },
    codex: {
      default: { model: null, effort: null },
      high: { model: null, effort: 'high' },
    },
    dsh: { default: { model: null, effort: null } },
    opencode: { default: { model: null, effort: null } },
    cli: { default: { model: null, effort: null } },
  };
}

export function defaultRolePins() {
  return Object.fromEntries(ROUTE_ROLES.map((r) => [r, null]));
}

const cleanName = (v, max = 100) => String(v || '').replace(/[^\w@./:+-]/g, '').slice(0, max);
const num = (v, fallback, min, max) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const asArray = (v) => (Array.isArray(v) ? v : []);

/** Normalize and validate routing. Invalid *requested* values throw; safe defaults fill gaps. */
export function normalizeHarnessRouting(raw = {}, { strict = false } = {}) {
  const d = defaultHarnessRouting();
  const r = raw && typeof raw === 'object' ? raw : {};
  const roles = {};
  for (const role of ROUTE_ROLES) {
    const value = asArray(r.roles?.[role]).map((x) => String(x)).filter((x) => HARNESS_IDS.includes(x)).slice(0, 12);
    if (strict && asArray(r.roles?.[role]).length && !value.length) throw new RoutingConfigError(`harnessRouting.roles.${role} contains no known harness (${HARNESS_IDS.join(', ')}).`);
    roles[role] = value;
  }
  const fallbackChain = asArray(r.fallbackChain).map((x) => String(x)).filter((x) => HARNESS_IDS.includes(x)).slice(0, 12);
  if (strict && asArray(r.fallbackChain).length && !fallbackChain.length) throw new RoutingConfigError('harnessRouting.fallbackChain contains no known harness.');
  const taskTypes = {};
  for (const [key, value] of Object.entries(r.taskTypes && typeof r.taskTypes === 'object' ? r.taskTypes : {}).slice(0, 30)) {
    const name = cleanName(key, 40);
    const list = asArray(value).map((x) => String(x)).filter((x) => HARNESS_IDS.includes(x)).slice(0, 12);
    if (name) taskTypes[name] = list;
  }
  return {
    enabled: r.enabled === true,
    roles,
    taskTypes,
    fallbackChain,
    fallbackOnErrors: r.fallbackOnErrors !== false,
    maxSwitches: num(r.maxSwitches, d.maxSwitches, 1, 32),
    claudeWindowHours: num(r.claudeWindowHours, d.claudeWindowHours, 1, 24),
    workingWindowHours: num(r.workingWindowHours, d.workingWindowHours, 1, 48),
    quotaCooldownMin: Object.fromEntries(Object.entries({ ...d.quotaCooldownMin, ...(r.quotaCooldownMin || {}) }).map(([k, v]) => [k, num(v, d.quotaCooldownMin[k] || 30, 1, 24 * 60)])),
  };
}

/** Normalize model profiles; strict mode is used when a project is saved. */
export function normalizeModelProfiles(raw = {}, { strict = false } = {}) {
  const d = defaultModelProfiles();
  const r = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const engine of HARNESS_IDS) {
    const source = r[engine] && typeof r[engine] === 'object' ? r[engine] : d[engine] || {};
    const profiles = {};
    for (const [rawName, rawProfile] of Object.entries(source).slice(0, 40)) {
      const name = cleanName(rawName, 60);
      if (!name) continue;
      const profile = rawProfile && typeof rawProfile === 'object' ? rawProfile : {};
      if (profile.invalidEffort) {
        const message = `${engine} model profile "${name}" requests unsupported effort "${profile.invalidEffort}".`;
        if (strict) throw new RoutingConfigError(message);
        profiles[name] = { model: normalizeModel(profile.model), effort: null, invalidEffort: String(profile.invalidEffort) };
        continue;
      }
      const effort = profile.effort == null || profile.effort === '' ? null : String(profile.effort).toLowerCase();
      if (effort && !EFFORT_LEVELS[engine]?.includes(effort)) {
        const supported = EFFORT_LEVELS[engine]?.length ? EFFORT_LEVELS[engine].join(', ') : 'none';
        const message = `${engine} model profile "${name}" requests effort "${effort}", but ${engine} supports: ${supported}.`;
        if (strict) throw new RoutingConfigError(message);
        profiles[name] = { model: normalizeModel(profile.model), effort: null, invalidEffort: effort };
        continue;
      }
      profiles[name] = { model: normalizeModel(profile.model), effort };
    }
    if (!Object.keys(profiles).length) profiles.default = { model: null, effort: null };
    out[engine] = profiles;
  }
  return out;
}

function normalizeModel(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const providerID = cleanName(raw.providerID, 80);
    const id = cleanName(raw.id, 160);
    return providerID && id ? { providerID, id } : null;
  }
  return cleanName(raw, 240) || null;
}

export function normalizeRolePins(raw = {}, { strict = false } = {}) {
  const out = defaultRolePins();
  const r = raw && typeof raw === 'object' ? raw : {};
  for (const role of ROUTE_ROLES) {
    const pin = r[role];
    if (!pin || typeof pin !== 'object') continue;
    const harness = pin.harness ? String(pin.harness) : null;
    if (harness && !HARNESS_IDS.includes(harness)) {
      if (strict) throw new RoutingConfigError(`rolePins.${role}.harness is not a known harness: ${harness}`);
      continue;
    }
    out[role] = {
      harness,
      modelProfile: pin.modelProfile ? cleanName(pin.modelProfile, 60) : null,
    };
  }
  return out;
}

/** Throws the first actionable routing/profile error. Used before saving project settings. */
export function validateRoutingConfig({ harnessRouting, modelProfiles, rolePins } = {}) {
  const routing = normalizeHarnessRouting(harnessRouting, { strict: true });
  const profiles = normalizeModelProfiles(modelProfiles, { strict: true });
  const pins = normalizeRolePins(rolePins, { strict: true });
  for (const [role, pin] of Object.entries(pins)) {
    if (!pin) continue;
    if (pin.harness && pin.modelProfile && !profiles[pin.harness]?.[pin.modelProfile]) {
      throw new RoutingConfigError(`rolePins.${role} points at missing model profile "${pin.modelProfile}" for harness "${pin.harness}".`);
    }
  }
  return { harnessRouting: routing, modelProfiles: profiles, rolePins: pins };
}

/**
 * Resolve ordered routes. The first entry is preferred; later entries are fallbacks.
 * When routing is disabled, this returns exactly the project's engine/default model profile.
 */
export function resolveRoutes({ role, taskType = null, harnessRouting, modelProfiles, rolePins, defaultEngine = 'opencode' } = {}) {
  const routing = normalizeHarnessRouting(harnessRouting);
  const profiles = normalizeModelProfiles(modelProfiles);
  const pins = normalizeRolePins(rolePins);
  const pin = pins[role] || null;
  const ordered = [];
  const add = (id) => {
    if (id && HARNESS_IDS.includes(id) && !ordered.includes(id)) ordered.push(id);
  };
  if (routing.enabled) {
    if (pin?.harness) add(pin.harness);
    for (const id of routing.roles[role] || []) add(id);
    if (taskType && routing.taskTypes[taskType]) for (const id of routing.taskTypes[taskType]) add(id);
    for (const id of routing.fallbackChain) add(id);
    add(defaultEngine);
  } else {
    add(pin?.harness || defaultEngine);
    if (pin?.harness && pin.harness !== defaultEngine) add(defaultEngine);
  }
  if (!ordered.length) add(defaultEngine);
  return ordered.map((harness, index) => {
    const profileName = pin?.harness === harness && pin.modelProfile ? pin.modelProfile : (profiles[harness]?.default ? 'default' : Object.keys(profiles[harness] || {})[0]);
    const profile = profileName ? profiles[harness]?.[profileName] : null;
    if (pin?.harness === harness && pin.modelProfile && !profile) {
      throw new RoutingConfigError(`No model profile "${pin.modelProfile}" for harness "${harness}".`);
    }
    if (profile?.invalidEffort) {
      const supported = EFFORT_LEVELS[harness]?.length ? EFFORT_LEVELS[harness].join(', ') : 'none';
      throw new RoutingConfigError(`The selected ${harness} model profile "${profileName}" requests unsupported effort "${profile.invalidEffort}". ${harness} supports: ${supported}.`);
    }
    if (profile?.effort && !EFFORT_LEVELS[harness]?.includes(profile.effort)) {
      const supported = EFFORT_LEVELS[harness]?.length ? EFFORT_LEVELS[harness].join(', ') : 'none';
      throw new RoutingConfigError(`${harness} does not support effort "${profile.effort}". Supported: ${supported}.`);
    }
    return {
      harness,
      modelProfile: profileName || null,
      model: profile?.model || null,
      effort: profile?.effort || null,
      fallbackStep: index,
      role,
      taskType: taskType || null,
    };
  });
}

/** Model reference passed to an adapter, normalized to its native shape. */
export function modelForHarness(harness, model) {
  if (!model) return null;
  if (harness === 'api') {
    if (typeof model === 'object') return { providerID: model.providerID, id: model.id };
    const raw = String(model);
    const slash = raw.indexOf('/');
    return slash > 0 ? { providerID: raw.slice(0, slash), id: raw.slice(slash + 1) } : { providerID: 'deepseek', id: raw };
  }
  if (typeof model === 'object') return { providerID: harness, id: model.id };
  return { providerID: harness, id: String(model).split('/').pop() };
}

/** Small stateful facade used by RunController; pure functions remain available for CLI/tests. */
export class HarnessRouter {
  constructor({ harnessRouting = null, modelProfiles = null, rolePins = null, defaultEngine = 'opencode' } = {}) {
    this.harnessRouting = normalizeHarnessRouting(harnessRouting);
    this.modelProfiles = normalizeModelProfiles(modelProfiles);
    this.rolePins = normalizeRolePins(rolePins);
    this.defaultEngine = defaultEngine || 'opencode';
  }

  routesFor(role, taskType = null) {
    return resolveRoutes({
      role,
      taskType,
      harnessRouting: this.harnessRouting,
      modelProfiles: this.modelProfiles,
      rolePins: this.rolePins,
      defaultEngine: this.defaultEngine,
    });
  }

  resolve(role, taskType = null) {
    return this.routesFor(role, taskType)[0] || null;
  }
}

export function routeLabel(route) {
  if (!route) return 'none';
  return `${route.harness}${route.model ? `/${typeof route.model === 'object' ? route.model.id : route.model}` : ''}${route.effort ? ` · ${route.effort}` : ''}`;
}
