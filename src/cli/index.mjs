import fsp from 'node:fs/promises';
import path from 'node:path';
import { SleepPilotApp } from '../app/app.mjs';
import { DEFAULT_PROJECT_SETTINGS } from '../store/store.mjs';
import { developerRuleset, readOnlyRuleset } from '../orchestrator/permissions.mjs';
import {
  defaultHarnessRouting, defaultModelProfiles, defaultRolePins,
  normalizeHarnessRouting, normalizeModelProfiles, normalizeRolePins,
  resolveRoutes, modelForHarness, routeLabel, READ_ONLY_CAPABLE,
} from '../orchestrator/routing.mjs';
import { detectOpenCode } from '../opencode/detect.mjs';
import { findDsh } from '../engines/dsh/engine.mjs';
import { rustStatus } from '../reverse/rust.mjs';
import { REVERSE_MODES } from '../reverse/playbook.mjs';
import { dataRoot } from '../util/paths.mjs';

const VERSION = '2.4.1';

export const CLI_COMMANDS = ['run', 'ask', 'route', 'reverse', 'engines', 'doctor', 'web', 'help', 'version'];

export function cliHelp() {
  return `SleepPilot ${VERSION} — autonomous engineering harness

USAGE
  sleeppilot                         Open the desktop UI (default)
  sleeppilot run [options]           Run a project autonomously (headless)
  sleeppilot ask [options]           One prompt through an engine (headless harness)
  sleeppilot route [options]         Resolve harness/model routing without executing
  sleeppilot reverse [options]       Prepare a Sleep & Reverse & Rust It workspace
  sleeppilot engines [options]       Show engine/provider/toolchain status
  sleeppilot doctor [--json]         Check this machine's setup
  sleeppilot web [--port N]          Start the UI server without opening a window
  sleeppilot version | --version

COMMON OPTIONS
  --engine opencode|claude|codex|api|dsh|cli  Execution backend (default: saved setting)
  --model provider/model|model-id    Model for the developer role
  --model-profile <name>             Project model profile (model + effort)
  --provider <id>                    API provider id (api engine)
  --api-key <key>                    Store an API key for the provider (or use env)
  --base-url <url>                   Override the provider base URL
  --json                             Machine-readable NDJSON / JSON output
  --quiet                            Do not print human log lines

ENVIRONMENT
  SLEEPPILOT_SESSION_ID              Reuse a fixed session id (letters, digits, _ and -;
                                     at least 3 characters). Useful for crash-recovery
                                     drills and for debugging a specific session. Engines
                                     that own their own session ids (OpenCode) ignore it.
  SLEEPPILOT_DEBUG=1                 Print stack traces on errors

run
  --project <dir>                    Project folder (default: current directory)
  --create                           Create the project record if missing
  --objective <text|@file|->         Main objective (file or stdin with @/-)
  --hours <n>                        Time limit in hours (default: project setting or 8)
  --iterations <n>                   Iteration limit
  --preset sleep|supervised|strict|unrestricted
  --parallel <n>                     Parallel developers (1-4)
  --no-report                        Do not write the final Markdown report
  --no-reviewer                      Disable the reviewer role
  Exit codes: 0 completed, 2 paused/waiting, 3 stopped, 4 failed

ask
  --project <dir>                    Working folder (default: current directory)
  --prompt <text|@file|->            The instruction
  --model-profile <name>             Use this project model profile (model + effort)
  --permission <profile|read-only>   Permission profile (default: full)
  --timeout <min>                    Abort after this many minutes

route
  --project <dir>                    Project folder (uses its routing; defaults otherwise)
  --task <type>                      Task type for the developer route (default: coding)
  --dry-run                          Print the resolved routes and fallback chain only

reverse
  --target <path>                    Program file or folder to analyse (read-only)
  --workspace <dir>                  Output folder (analysis + Rust project)
  --goal <text|@file>                What you want to understand/build
  --mode analyze|rust                Analysis only, or analysis + Rust implementation
  --hours <n>                        Time limit for the run (default 8)
  --yes                              Confirm you are authorized to analyse the target
  --start                            Start the run immediately after preparation

EXAMPLES
  sleeppilot run --project C:\\work\\app --objective "Add CSV export" --hours 6 --preset sleep
  sleeppilot ask --project C:\\work\\app --engine api --model deepseek/deepseek-chat --prompt "Fix the failing test"
  sleeppilot reverse --target C:\\games\\demo --workspace C:\\work\\demo-re --mode rust --goal "Rebuild the save editor" --yes --start
`;
}

// ------------------------------------------------------------------ entry

export async function runCli(command, argv) {
  const args = parseArgs(argv);
  try {
    if (command === 'help' || args.flags.help) {
      console.log(cliHelp());
      return 0;
    }
    if (command === 'version') {
      console.log(VERSION);
      return 0;
    }
    if (command === 'run') return await cmdRun(args);
    if (command === 'ask') return await cmdAsk(args);
    if (command === 'route') return await cmdRoute(args);
    if (command === 'reverse') return await cmdReverse(args);
    if (command === 'engines') return await cmdEngines(args);
    if (command === 'doctor') return await cmdDoctor(args);
    if (command === 'web') return await cmdWeb(args);
    console.error(`Unknown command: ${command}\n`);
    console.error(cliHelp());
    return 1;
  } catch (err) {
    if (args.flags.json) console.log(JSON.stringify({ type: 'error', message: err.message }));
    else console.error(`SleepPilot: ${err.message}`);
    if (process.env.SLEEPPILOT_DEBUG === '1') console.error(err.stack);
    return 1;
  }
}

// ------------------------------------------------------------------ commands

async function cmdRun(args) {
  const projectDir = path.resolve(args.opts.project || process.cwd());
  const objective = args.opts.objective ? await readText(args.opts.objective) : '';
  if (!objective.trim()) throw new Error('--objective is required (text, @file or - for stdin).');
  const app = await makeApp({ autoConnect: false });
  try {
    const engineId = requestedEngine(app, args);
    await configureEngine(app, engineId, args);
    const engine = await app.manager.ensureConnected(engineId);
    let project = await app.store.findProjectByDir(projectDir);
    if (!project) {
      if (!args.flags.create) throw new Error(`No SleepPilot project for ${projectDir}. Add --create to create one.`);
      project = await app.createProject({ name: path.basename(projectDir), dir: projectDir, createIfMissing: true, engine: engineId });
    }
    const preset = presetSettings(args.opts.preset || 'sleep', args);
    const settings = {
      ...project.settings,
      engine: engineId,
      ...preset,
      ...(args.opts.hours ? { durationMin: Math.round(Number(args.opts.hours) * 60) } : {}),
      ...(args.opts.iterations ? { maxIterations: Number(args.opts.iterations) } : {}),
      ...(args.opts.parallel ? { parallelDevelopers: Number(args.opts.parallel) } : {}),
      ...(args.flags['no-reviewer'] ? { reviewerEnabled: false } : {}),
    };
    const models = modelSelection(engine, args, project.settings.models);
    if (args.opts.modelProfile) {
      const profiles = normalizeModelProfiles(project.settings.modelProfiles);
      if (!profiles[engineId]?.[args.opts.modelProfile]) throw new Error(`Model profile "${args.opts.modelProfile}" does not exist for engine ${engineId}.`);
      settings.harnessRouting = { ...(settings.harnessRouting || {}), enabled: true };
      settings.rolePins = { ...(settings.rolePins || {}), developer: { harness: engineId, modelProfile: args.opts.modelProfile } };
    }
    project = await app.updateProject(project.id, { objective, settings: { ...settings, models } });
    const view = await app.startRun(project.id);
    return await waitForRun(app, project, view.id, args);
  } finally {
    await app.shutdown().catch(() => {});
  }
}

async function cmdRoute(args) {
  const dir = path.resolve(args.opts.project || process.cwd());
  const taskType = String(args.opts.task || args.opts.taskType || 'coding');
  const app = await makeApp({ autoConnect: false, recover: false });
  try {
    const project = await app.store.findProjectByDir(dir);
    const settings = { ...DEFAULT_PROJECT_SETTINGS, ...(project?.settings || {}) };
    const routing = normalizeHarnessRouting(settings.harnessRouting || defaultHarnessRouting());
    const profiles = normalizeModelProfiles(settings.modelProfiles || defaultModelProfiles());
    const pins = normalizeRolePins(settings.rolePins || defaultRolePins());
    const defaultEngine = args.opts.engine || settings.engine || app.settings.engine;
    const route = (role, type = null) => resolveRoutes({ role, taskType: type, harnessRouting: routing, modelProfiles: profiles, rolePins: pins, defaultEngine });
    const pick = (role, type = null) => {
      const list = route(role, type);
      const found = role === 'developer' ? list[0] : list.find((r) => READ_ONLY_CAPABLE.includes(r.harness));
      if (!found) throw new Error(`No read-only-capable harness for ${role}; pin it to ${READ_ONLY_CAPABLE.join(', ')}.`);
      return found;
    };
    const routes = {
      manager: pick('manager', 'planning'),
      developer: pick('developer', taskType),
      reviewer: pick('reviewer', 'review'),
      closing: pick('closing', 'review'),
      preflight: pick('preflight', 'planning'),
    };
    const payload = {
      type: 'route',
      dryRun: true,
      project: project ? { id: project.id, dir, name: project.name } : { id: null, dir, name: path.basename(dir) },
      task: taskType,
      routingEnabled: routing.enabled,
      roles: Object.fromEntries(Object.entries(routes).map(([k, r]) => [k, { harness: r.harness, modelProfile: r.modelProfile, model: r.model, effort: r.effort, fallbackStep: r.fallbackStep }])),
      fallbackChain: route('developer', taskType).map((r) => ({ harness: r.harness, modelProfile: r.modelProfile, effort: r.effort })),
      workingWindowHours: routing.workingWindowHours,
    };
    if (args.flags.json) console.log(JSON.stringify(payload, null, 2));
    else {
      console.log(`Route for ${payload.project.dir} | task ${taskType} | routing ${routing.enabled ? 'enabled' : 'disabled'}`);
      for (const [role, r] of Object.entries(routes)) console.log(`  ${role.padEnd(10)} -> ${routeLabel(r)}`);
      console.log(`  fallback   ${payload.fallbackChain.map((r) => `${r.harness}${r.modelProfile ? `(${r.modelProfile})` : ''}`).join(' -> ')}`);
      console.log(`  window     ${routing.workingWindowHours} h`);
    }
    return 0;
  } finally {
    await app.shutdown().catch(() => {});
  }
}

async function cmdAsk(args) {
  const dir = path.resolve(args.opts.project || process.cwd());
  const prompt = args.opts.prompt ? await readText(args.opts.prompt) : '';
  if (!prompt.trim()) throw new Error('--prompt is required (text, @file or - for stdin).');
  const app = await makeApp({ autoConnect: false });
  try {
    const engineId = requestedEngine(app, args);
    await configureEngine(app, engineId, args);
    const engine = await app.manager.ensureConnected(engineId);
    const permissionProfile = args.opts.permission || 'full';
    const permissions = permissionProfile === 'read-only' ? readOnlyRuleset() : developerRuleset(permissionProfile);
    const project = await app.store.findProjectByDir(dir);
    const profiles = normalizeModelProfiles(project?.settings.modelProfiles || defaultModelProfiles());
    const profileName = args.opts.modelProfile || null;
    const profile = profileName ? profiles[engineId]?.[profileName] : null;
    if (profileName && !profile) throw new Error(`Model profile "${profileName}" does not exist for engine ${engineId}.`);
    if (profile?.invalidEffort) throw new Error(`Model profile "${profileName}" requests unsupported effort "${profile.invalidEffort}" for ${engineId}.`);
    const model = modelSelection(engine, args, null);
    if (profile?.model) model.developer = modelForHarness(engineId, profile.model);
    const effort = profile?.effort || null;
    const session = await engine.createSession({ directory: dir, title: `SleepPilot ask · ${path.basename(dir)}`, model: model.developer, effort, permissions, readOnly: permissionProfile === 'read-only' });
    const started = Date.now();
    const result = await engine.runTurn({
      sessionID: session.id,
      text: prompt,
      metadata: { role: 'developer', source: 'cli' },
      onEvent: (ev) => {
        if (args.flags.json) return;
        if (ev.kind === 'text') process.stderr.write(ev.delta);
        else if (ev.kind === 'tool' && ev.phase === 'called') process.stderr.write(`\n[tool] ${ev.name}\n`);
      },
    });
    const payload = {
      type: 'ask',
      engine: engineId,
      harness: engineId,
      sessionId: session.id,
      modelProfile: profileName,
      effort,
      status: result.status,
      text: result.finalText || result.allText || '',
      usage: result.usage,
      errors: (result.errors || []).map((e) => ({ type: e.type, message: e.message })),
      durationMs: Date.now() - started,
    };
    if (args.flags.json) console.log(JSON.stringify(payload));
    else {
      if (result.finalText) process.stdout.write(result.finalText.endsWith('\n') ? result.finalText : result.finalText + '\n');
      if (result.status !== 'succeeded') console.error(`\n[status: ${result.status}]`);
    }
    return result.status === 'succeeded' ? 0 : 4;
  } finally {
    await app.shutdown().catch(() => {});
  }
}

async function cmdReverse(args) {
  const target = args.opts.target;
  const workspace = args.opts.workspace;
  if (!target) throw new Error('--target is required.');
  if (!workspace) throw new Error('--workspace is required.');
  if (!args.flags.yes) throw new Error('Add --yes to confirm that you are authorized to analyse this target.');
  const goal = args.opts.goal ? await readText(args.opts.goal) : '';
  const mode = REVERSE_MODES.some((m) => m.id === args.opts.mode) ? args.opts.mode : 'rust';
  const app = await makeApp({ autoConnect: false });
  try {
    const engineId = requestedEngine(app, args);
    await configureEngine(app, engineId, args);
    const engine = await app.manager.ensureConnected(engineId);
    const created = await app.createReverseProject({
      targetPath: target,
      workDir: workspace,
      goals: goal,
      mode,
      language: 'en',
      ack: true,
      engine: engineId,
      durationMin: args.opts.hours ? Math.round(Number(args.opts.hours) * 60) : 480,
      unattended: true,
      permissionProfile: 'full',
    });
    const project = created.project || created;
    const summary = {
      type: 'reverse-prepared',
      projectId: project.id,
      name: project.name,
      workspace: project.dir,
      target: project.reverse?.targetPath,
      mode: project.reverse?.mode,
      files: project.reverse?.files,
      binaries: project.reverse?.binaries,
      cargo: project.reverse?.cargo,
      crate: project.setup?.crate,
      checks: (project.checks || []).filter((c) => c.enabled).map((c) => c.name),
      engine: engineId,
    };
    if (args.flags.json) console.log(JSON.stringify(summary));
    else {
      console.log(`Workspace: ${summary.workspace}`);
      console.log(`Target:    ${summary.target} (read-only)`);
      console.log(`Mode:      ${summary.mode}${summary.crate ? ` · crate ${summary.crate}` : ''}`);
      console.log(`Recon:     ${summary.files} files, ${summary.binaries} binary file(s)`);
      console.log(`Cargo:     ${summary.cargo?.available ? summary.cargo.version : 'not found — Rust checks disabled'}`);
      console.log(`Checks:    ${summary.checks.join(', ')}`);
    }
    if (args.flags.start) {
      const view = await app.startRun(project.id);
      return await waitForRun(app, project, view.id, args);
    }
    return 0;
  } finally {
    await app.shutdown().catch(() => {});
  }
}

async function cmdEngines(args) {
  const app = await makeApp({ autoConnect: false });
  try {
    const ids = args.opts.engine ? [args.opts.engine] : ['opencode', 'claude', 'codex', 'api', 'dsh', 'cli'];
    const results = [];
    for (const id of ids) {
      const engine = app.manager.get(id);
      if (args.flags.connect || args.flags.all) await app.manager.connect(id).catch(() => {});
      results.push({
        id,
        label: engine.label,
        status: engine.status,
        detection: engine.detection,
        models: engine.models.map((m) => `${m.providerID}/${m.id}`),
        defaultModel: engine.defaultModel,
      });
    }
    if (args.flags.json) console.log(JSON.stringify({ type: 'engines', engines: results, providers: app.manager.providerView(), rust: await rustStatus() }, null, 2));
    else {
      for (const r of results) {
        console.log(`${r.label} (${r.id}): ${r.status.state} — ${r.status.message}`);
        if (r.models.length) console.log(`  models: ${r.models.slice(0, 12).join(', ')}${r.models.length > 12 ? ` … (+${r.models.length - 12})` : ''}`);
      }
      const rust = await rustStatus();
      console.log(`Rust: ${rust.cargo ? `${rust.cargo.version}` : 'not installed (https://rustup.rs/)'}`);
      console.log(`Providers: ${(app.manager.providerView() || []).map((p) => `${p.label}${p.hasKey ? '' : ' (no key)'}`).join(', ') || 'none'}`);
    }
    return 0;
  } finally {
    await app.shutdown().catch(() => {});
  }
}

async function cmdDoctor(args) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });
  add('Node.js', Number(process.versions.node.split('.')[0]) >= 20, `${process.version} · ${process.arch}`);
  add('Data folder', true, dataRoot());
  let writable = true;
  try {
    await fsp.mkdir(dataRoot(), { recursive: true });
    const probe = path.join(dataRoot(), `.write-test-${process.pid}`);
    await fsp.writeFile(probe, 'ok');
    await fsp.rm(probe, { force: true });
  } catch (err) {
    writable = false;
    add('Data folder writable', false, err.message);
  }
  if (writable) add('Data folder writable', true, 'yes');
  const rust = await rustStatus();
  add('Rust toolchain', !!rust.cargo, rust.cargo ? rust.cargo.version : 'Install from https://rustup.rs/ (needed for Rust It)');
  const opencode = await detectOpenCode({}).catch((err) => ({ found: false, support: { message: err.message } }));
  add('OpenCode', !!opencode.found, opencode.found ? `${opencode.path} (${opencode.version?.raw})` : opencode.support?.message || 'not found');
  const dsh = await findDsh(null);
  add('DeepSeek Harness CLI', !!dsh.path, dsh.path || 'not found (optional)');
  const { findExternalCli } = await import('../engines/external-cli/engine.mjs');
  const claude = await findExternalCli({ candidates: ['claude', 'claude.cmd', '%APPDATA%\\npm\\claude.cmd'], versionArgs: ['--version'] });
  add('Claude Code CLI', !!claude.found, claude.found ? `${claude.path} (${claude.version})` : 'not found (optional)');
  const codex = await findExternalCli({ candidates: ['codex', 'codex.cmd', '%APPDATA%\\npm\\codex.cmd'], versionArgs: ['--version'] });
  add('Codex CLI', !!codex.found, codex.found ? `${codex.path} (${codex.version})` : 'not found (optional)');
  const app = await makeApp({ autoConnect: false });
  try {
    const view = app.manager.view();
    const apiModels = view.engines.find((e) => e.id === 'api')?.models?.length || 0;
    add('API providers', apiModels > 0 || (view.providers || []).length > 0, `${(view.providers || []).length} configured, ${apiModels} models loaded (connect to refresh)`);
  } finally {
    await app.shutdown().catch(() => {});
  }
  if (args.flags.json) console.log(JSON.stringify({ type: 'doctor', checks }, null, 2));
  else {
    for (const c of checks) console.log(`${c.ok ? 'OK  ' : 'FAIL'}  ${c.name}: ${c.detail}`);
  }
  const optional = new Set(['OpenCode', 'Claude Code CLI', 'Codex CLI', 'DeepSeek Harness CLI', 'Rust toolchain', 'API providers']);
  return checks.every((c) => c.ok || optional.has(c.name)) ? 0 : 1;
}

async function cmdWeb(args) {
  const { startWebServer } = await import('../web/server.mjs');
  const app = await makeApp({ autoConnect: true });
  const web = await startWebServer(app, { port: args.opts.port ? Number(args.opts.port) : [47810, 0], token: process.env.SLEEPPILOT_UI_TOKEN || undefined });
  console.log(`SleepPilot UI: ${web.url}`);
  await new Promise(() => {});
  return 0;
}

// ------------------------------------------------------------------ run helper

async function waitForRun(app, project, runId, args) {
  const ctrl = app.controllerFor(runId);
  const json = !!args.flags.json;
  const quiet = !!args.flags.quiet || json;
  const write = (obj) => {
    if (json) console.log(JSON.stringify(obj));
  };
  write({ type: 'run-start', runId, projectId: project.id, engine: ctrl.activeHarness || ctrl.adapter.id, activeHarness: ctrl.activeHarness || ctrl.adapter.id, objective: project.objective.text.slice(0, 4000) });
  ctrl.on('log', (entry) => {
    const noisy = ['text', 'reasoning', 'text-delta', 'reasoning-delta', 'usage-live', 'turn-start', 'session', 'info', 'recovery'].includes(entry.kind);
    if (noisy && !args.flags.verbose) return;
    write({ type: 'log', at: entry.at, kind: entry.kind, role: entry.role || null, text: entry.text || null });
    if (!quiet && entry.text) console.log(`${new Date(entry.at || Date.now()).toLocaleTimeString('en-GB')} ${entry.text}`);
  });
  ctrl.on('turn', (rec) => write({ type: 'turn', id: rec.id, role: rec.role, status: rec.status, harness: rec.harness || null, modelProfile: rec.modelProfile || null, fallbackStep: rec.fallbackStep ?? 0, usage: rec.usage, errors: rec.errors }));
  const stop = async () => {
    try {
      await ctrl.requestStop({ immediate: true });
    } catch {}
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  await new Promise((resolve) => {
    if (ctrl.terminal) return resolve();
    ctrl.on('update', () => {
      if (ctrl.terminal) resolve();
    });
    ctrl.on('finished', resolve);
  });
  const view = ctrl.view();
  let report = null;
  if (!args.flags['no-report'] && ['completed', 'stopped', 'failed'].includes(view.state)) {
    report = await app.report(project.id, runId).catch(() => null);
  }
  const summary = {
    type: 'run-end',
    runId,
    state: view.state,
    stopReason: view.stopReason,
    iterations: view.iterationCount,
    tasks: view.taskCounts,
    activeHarness: view.activeHarness || null,
    routingSwitches: view.routingSwitches || [],
    usage: view.usage,
    report: report?.file || null,
  };
  if (json) console.log(JSON.stringify(summary));
  else {
    console.log(`\nRun ${view.state}: ${view.stopReason?.label || view.stopReason || ''}`);
    console.log(`Iterations: ${view.iterationCount}; tasks: ${JSON.stringify(view.taskCounts)}`);
    if (report?.file) console.log(`Report: ${report.file}`);
  }
  const code = { completed: 0, stopped: 3, failed: 4, paused: 2, waiting_user: 2 }[view.state] ?? 4;
  return code;
}

// ------------------------------------------------------------------ setup helpers

async function makeApp({ autoConnect = false, recover = true } = {}) {
  const app = new SleepPilotApp({ autoConnect, recover });
  await app.init();
  return app;
}

/** Infer the API engine when the user supplied API-only options. */
function requestedEngine(app, args) {
  if (args.opts.engine) return args.opts.engine;
  if (args.opts.apiKey || args.opts.baseUrl || args.opts.provider) return 'api';
  return app.settings.engine;
}

async function configureEngine(app, engineId, args) {
  const patch = {};
  if (args.opts.engine) patch.engine = engineId;
  if (engineId === 'api') {
    const providers = app.settings.providers || [];
    const provider = providers.find((p) => p.id === (args.opts.provider || 'deepseek')) || providers.find((p) => p.enabled) || providers[0];
    if (!provider) throw new Error('No API provider configured. Add one in the UI or pass --provider/--base-url.');
    if (args.opts.apiKey) {
      await app.saveProviderSecret({ providerId: provider.id, apiKey: args.opts.apiKey });
    }
    if (args.opts.baseUrl) {
      provider.baseUrl = String(args.opts.baseUrl).replace(/\/+$/, '');
      patch.providers = providers;
    }
    if (args.opts.provider) patch.providers = providers;
  }
  if (Object.keys(patch).length) await app.saveSettings(patch);
}

function modelSelection(engine, args, current = null) {
  const choose = (raw) => {
    if (!raw) return null;
    const s = String(raw);
    const slash = s.indexOf('/');
    if (slash > 0) return { providerID: s.slice(0, slash), id: s.slice(slash + 1) };
    const found = engine.models.find((m) => m.id === s);
    return found ? { providerID: found.providerID, id: found.id } : { providerID: engine.models[0]?.providerID || engine.id, id: s };
  };
  const picked = choose(args.opts.model);
  const model = picked || current?.developer || engine.defaultModel || engine.models[0] || null;
  return { manager: model, developer: model, reviewer: model };
}

function presetSettings(name, args = {}) {
  const base = {
    durationMin: 480,
    maxIterations: 80,
    maxAttemptsSameFailure: 3,
    improvementMode: false,
    autoResumeOnQuotaReset: true,
    reviewerEnabled: true,
    sessionPolicy: 'fresh-per-task',
    permissionProfile: 'full',
    backupBeforeRun: true,
    unattended: true,
    permissionTimeoutMin: 2,
    scopeMode: 'strict',
    closingReport: true,
    language: 'en',
    finalGraceMin: 30,
    carryOverTasks: true,
    parallelDevelopers: 2,
    overtimeMin: 60,
    overtimeMaxRounds: 2,
    maxTurnMin: 45,
    planReview: false,
  };
  if (name === 'supervised') return { ...base, permissionProfile: 'balanced', unattended: false, permissionTimeoutMin: 10, parallelDevelopers: 1, autoResumeOnQuotaReset: false, overtimeMin: 0, overtimeMaxRounds: 1 };
  if (name === 'strict') return { ...base, permissionProfile: 'strict', unattended: false, permissionTimeoutMin: 0, parallelDevelopers: 1, autoResumeOnQuotaReset: false, overtimeMin: 0, overtimeMaxRounds: 1 };
  if (name === 'unrestricted') return { ...base, permissionProfile: 'unrestricted', unattended: true };
  return base;
}

async function readText(value) {
  if (value === '-') {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    return Buffer.concat(chunks).toString('utf8');
  }
  if (String(value).startsWith('@')) return fsp.readFile(path.resolve(String(value).slice(1)), 'utf8');
  return String(value);
}

// ------------------------------------------------------------------ arguments

/**
 * Supports --flag, --key value and --key=value. Unknown options are kept so commands can
 * forward them; repeated options keep the last value.
 */
export function parseArgs(argv = []) {
  const opts = {};
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const key = (eq >= 0 ? a.slice(2, eq) : a.slice(2)).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (eq >= 0) {
      opts[key] = a.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      opts[key] = next;
      i++;
    } else flags[key] = true;
  }
  return { opts, flags, positional };
}

/** Used by main.mjs for `sleeppilot --version`. */
export const version = VERSION;
