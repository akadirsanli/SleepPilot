import { EventEmitter } from 'node:events';
import path from 'node:path';
import { dataRoot } from '../util/paths.mjs';
import { readJson, writeJsonAtomic } from '../util/fsx.mjs';
import { redact } from '../util/redact.mjs';
import { readOnlyRuleset } from '../orchestrator/permissions.mjs';
import { logger } from '../util/log.mjs';

const log = logger('assistant');
const HISTORY_LIMIT = 80;
const PROMPT_HISTORY = 10;
const SCREEN_LIMIT = 7000;
const DEFAULT_TIMEOUT_MS = 180_000;

/**
 * The in-app assistant (chat box in the lower-right corner).
 *
 * Two layers:
 *  1. status(): deterministic findings about the app, the current project and its run — engine
 *     problems, a paused run and why, missing workspace or Android tools — with the fix. No model
 *     is called; the chat box shows these the moment it opens.
 *  2. ask(): a question goes to the model the user chose (engine + model), with SleepPilot's guide,
 *     the live state and the text of the screen the user is looking at. When the first choice is not
 *     available (engine missing, signed out, out of quota, error) the second, then the third is
 *     used. The turn is read-only: the assistant explains and suggests, it never changes anything.
 */

export const ASSISTANT_GUIDE = `SleepPilot is a desktop app (local web UI) that runs AI coding agents unattended — for hours or overnight — on the user's project and proves the work with real checks.

Screens (left sidebar):
- Home: workspace card, "New project" (name, folder, engine, template), engines, recent projects. The 📱 button in the top bar opens phone access.
- Project: Goal (what to build), Additional rules, run presets (Overnight = unattended full autonomy, Supervised = asks for risky commands, Strict, Unrestricted), time limit, permission profile, models per role (Manager plans and decides, Developer writes code, Reviewer checks), Advanced settings (iterations, parallel developers, scope strict/creative, improvement mode, plan review, auto-resume after quota reset, checks). "Start run" starts.
- Run: live conversation of the agents, tasks, log, details; Pause / Stop / +1 hour; a box to send a new instruction ("steer") to the running agents; answers to permission requests and questions.
- Preview: the project's web app in a phone/tablet/desktop frame, reloads on every saved file, shows JavaScript errors. Dev-server projects (Vite, Next…) need the command approved in Preview settings.
- Android: JDK/SDK/Gradle status with fixes, Debug APK / Release APK / Release AAB (Play) builds with a live log, APK list (download, install & run on a USB phone), devices, release signing key.
- Report: results of a finished run. Insights: statistics across projects. Reverse & Rust: analyse a program and rebuild it in Rust.
- Settings: Engines (OpenCode, Claude Code, Codex, built-in API harness, DeepSeek Harness, any CLI — test/connect, paths, models), API providers (keys), Local AI (Ollama), Toolchain, Workspace (folder for all projects: projects/ and exports/), Android (JDK/SDK/Gradle paths), Phone (QR code over Tailscale), App (concurrent runs, GitHub, notifications, sound).

Facts that often matter:
- Claude Code must be signed in once in a terminal: \`claude auth login\` (check with \`claude auth status\`). "Not logged in · Please run /login" means exactly this. Codex: \`codex login\`.
- A paused run shows why at the top of the Run screen; "Resume" continues. Model/provider errors pause the run; choose another model on the Project screen or fix the engine in Settings → Engines.
- Checks are the evidence: a task is "verified" only after an executed passing check (HTML load, JS/Python syntax, cargo, Android build, approved commands).
- Android builds need a JDK 17+ and the Android SDK (both come with Android Studio); SleepPilot finds them without PATH changes.
- Phone access needs Tailscale on the PC and on the phone (same account).
- Data folder: %LOCALAPPDATA%\\SleepPilot (runs, settings, keys). Projects live in the workspace folder or wherever the user chose.`;

const INSTRUCTIONS = `You are the help assistant built into SleepPilot. You answer the user's questions about the app, their project and the current run.

Rules:
- Answer in the language the user writes in. Be short and concrete: what is going on, why, and the exact next step (screen → button, or the command to type). Use a short list when there are steps.
- Use the LIVE STATE and SCREEN below as the truth about this moment; do not invent runs, errors or settings that are not there. If something is unknown, say so and say where the user can see it.
- You cannot click, change settings or start/stop runs. Never claim you did. Say what the user should do.
- When you notice a problem in the state (an error, a paused run, a missing tool) that the user did not ask about, mention it in one line at the end.
- Do not reveal API keys or tokens even if they appear somewhere.`;

/** Sanitise the saved choice: up to three { engine, model } entries, first = preferred. */
export function sanitizeAssistantSettings(raw = {}, engineIds = []) {
  const list = Array.isArray(raw?.models) ? raw.models : [];
  const models = [];
  for (const m of list) {
    const engine = String(m?.engine || '').trim();
    if (!engine || (engineIds.length && !engineIds.includes(engine))) continue;
    models.push({ engine, model: m?.model ? String(m.model).trim().slice(0, 200) : '' });
    if (models.length === 3) break;
  }
  return { enabled: raw?.enabled !== false, models };
}

/** "provider/model", a bare model id or nothing → the engine's model object. */
export function resolveModel(engine, raw) {
  const s = String(raw || '').trim();
  if (!s) return engine.defaultModel || engine.models?.[0] || null;
  const known = (engine.models || []).find((m) => `${m.providerID}/${m.id}` === s || m.id === s);
  if (known) return { providerID: known.providerID, id: known.id, ...(known.variant ? { variant: known.variant } : {}) };
  const slash = s.indexOf('/');
  if (slash > 0 && (engine.id === 'opencode' || engine.id === 'api')) return { providerID: s.slice(0, slash), id: s.slice(slash + 1) };
  return { providerID: engine.id, id: s.split('/').pop() };
}

const clip = (s, n) => {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/** Deterministic findings — shown instantly, no model call. */
export function buildStatus({ state, project = null, run = null, androidToolchain = null, workspace = null }) {
  const items = [];
  const add = (level, title, detail = '', action = null) => items.push({ level, title, detail, action });
  const engines = state?.engines?.engines || [];
  const def = engines.find((e) => e.id === state?.engines?.default);
  if (def && def.status?.state !== 'connected') {
    const msg = def.status?.message || '';
    add(def.status?.state === 'error' ? 'error' : 'warn', `${def.label} (default engine) is ${def.status?.state || 'not connected'}`, clip(msg, 300), { label: 'Settings → Engines', view: 'settings', tab: 'engines' });
  }
  for (const e of engines) {
    const label = String(e.detection?.support?.message || e.status?.message || '');
    if (/not signed in|not logged in/i.test(label)) add('error', `${e.label} is not signed in`, e.id === 'claude' ? 'In a terminal run: claude auth login — then click Test / connect.' : e.id === 'codex' ? 'In a terminal run: codex login — then click Test / connect.' : label, { label: 'Settings → Engines', view: 'settings', tab: 'engines' });
  }
  if (workspace && !workspace.configured) add('info', 'No workspace yet', 'Choose one folder for all projects; new projects then need only a name.', { label: 'Set up workspace', view: 'settings', tab: 'workspace' });
  for (const r of state?.activeRuns || []) {
    if (r.state === 'waiting_user') add('warn', `${r.projectName}: waiting for you`, clip(r.activity, 200), { label: 'Open the run', view: 'run', projectId: r.projectId, runId: r.runId });
  }
  if (run) {
    if (run.state === 'paused' && run.pause) add(run.pause.code === 'user_paused' ? 'info' : 'warn', `Run paused: ${run.pause.label || run.pause.code}`, clip(run.pause.message, 400), { label: 'Run screen', view: 'run' });
    if (run.state === 'failed') add('error', 'The last run failed', clip(run.stopReason?.label || run.stopReason?.message || '', 300), { label: 'Report', view: 'report' });
    const blocked = (run.tasks || []).filter((t) => t.status === 'blocked');
    if (blocked.length) add('warn', `${blocked.length} blocked task(s)`, blocked.slice(0, 3).map((t) => t.title).join(' · '), { label: 'Tasks', view: 'run' });
  }
  if (project && !String(project.objective?.text || '').trim()) add('info', `${project.name}: no goal yet`, 'Write what should be built on the Project screen, then start a run.', { label: 'Project', view: 'project' });
  if (project && !(project.checks || []).some((c) => c.enabled && (c.approved || c.type !== 'command'))) add('info', `${project.name}: no active check`, 'Without a check no task can be verified. Add or approve one under Project → Advanced → checks.', { label: 'Project', view: 'project' });
  if (project?.kind === 'android' && androidToolchain && !androidToolchain.ready) {
    for (const p of (androidToolchain.problems || []).filter((x) => x.severity === 'error')) add('error', p.title, p.fix, { label: 'Android', view: 'android' });
  }
  const order = { error: 0, warn: 1, info: 2 };
  return items.sort((a, b) => order[a.level] - order[b.level]).slice(0, 12);
}

/** The LIVE STATE block of the prompt: compact text, no secrets. */
export function stateText({ state, project = null, run = null, events = [], status = [], preview = null }) {
  const lines = [];
  const app = state?.app || {};
  lines.push(`SleepPilot ${app.version || ''} on ${app.platform || ''}${app.testMode ? ' (TEST MODE: engines are simulated)' : ''}.`);
  const engines = state?.engines?.engines || [];
  lines.push(`Default engine: ${state?.engines?.default || '?'}. Engines: ${engines.map((e) => `${e.label}=${e.status?.state || '?'}${e.status?.state !== 'connected' && e.status?.message ? ` (${clip(e.status.message, 120)})` : ''}`).join('; ')}.`);
  lines.push(`Workspace: ${state?.workspace?.dir || 'not set up'}. Projects: ${(state?.projects || []).length}. Active runs: ${(state?.activeRuns || []).map((r) => `${r.projectName} [${r.state}] ${clip(r.activity, 80)}`).join('; ') || 'none'}.`);
  if (project) {
    lines.push(`Current project: "${project.name}" (${project.kind || 'code'}) at ${project.dir}.`);
    lines.push(`Goal: ${clip(project.objective?.text || '(none)', 1200)}`);
    if (project.rules) lines.push(`Rules: ${clip(project.rules, 600)}`);
    const s = project.settings || {};
    lines.push(`Run settings: engine ${s.engine || 'default'}, ${Math.round((s.durationMin || 0) / 60 * 10) / 10} h, profile ${s.permissionProfile}, ${s.unattended ? 'unattended' : 'supervised'}, parallel ${s.parallelDevelopers}, scope ${s.scopeMode}, models ${['manager', 'developer', 'reviewer'].map((r) => `${r}=${s.models?.[r]?.id || 'default'}`).join(', ')}.`);
    lines.push(`Checks: ${(project.checks || []).map((c) => `${c.name}${c.enabled ? '' : ' (off)'}${c.type === 'command' && !c.approved ? ' (not approved)' : ''}`).join('; ') || 'none'}.`);
  }
  if (run) {
    const tc = run.taskCounts || {};
    lines.push(`Run ${run.id}: ${run.state}${run.pause ? ` — paused: ${run.pause.label}: ${clip(run.pause.message, 500)}` : ''}${run.stopReason ? ` — stop: ${run.stopReason.label || run.stopReason.code}` : ''}. Activity: ${clip(run.activity?.message, 200)}. Iterations ${run.iterationCount || 0}. Tasks: ${Object.entries(tc).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}.`);
    for (const t of (run.tasks || []).slice(0, 25)) lines.push(`  - [${t.status}] ${t.id} ${clip(t.title, 120)}${t.lastFailure ? ` — last failure: ${clip(t.lastFailure, 160)}` : ''}`);
  }
  const notable = events.filter((e) => /error|warning|pause|fail|check|decision|finish|recovery/.test(e.kind || '')).slice(-25);
  if (notable.length) {
    lines.push('Recent notable run events:');
    for (const e of notable) lines.push(`  ${new Date(e.at || 0).toISOString().slice(11, 19)} [${e.kind}] ${clip(e.text, 220)}`);
  }
  if (preview) lines.push(`Preview: ${preview.running ? `running (${preview.mode}) at ${preview.url || '…'}` : 'stopped'}.`);
  if (status.length) {
    lines.push('Findings SleepPilot already detected:');
    for (const s of status) lines.push(`  [${s.level}] ${s.title}${s.detail ? ` — ${clip(s.detail, 200)}` : ''}`);
  }
  return redact(lines.join('\n'));
}

export function buildPrompt({ question, history = [], live = '', screen = null }) {
  const past = history.slice(-PROMPT_HISTORY).map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${clip(m.text, 1500)}`).join('\n');
  const scr = screen?.text ? `SCREEN — the user is on "${clip(screen.view, 40)}"; visible text:\n${clip(redact(screen.text), SCREEN_LIMIT)}` : 'SCREEN: not provided.';
  return `${INSTRUCTIONS}

=== SLEEPPILOT GUIDE ===
${ASSISTANT_GUIDE}

=== LIVE STATE ===
${live}

=== ${scr}

${past ? `=== CONVERSATION SO FAR ===\n${past}\n\n` : ''}=== QUESTION ===
${clip(question, 4000)}

Answer now (plain text or short Markdown).`;
}

export class Assistant extends EventEmitter {
  constructor({ manager, getSettings, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    super();
    this.manager = manager;
    this.getSettings = getSettings;
    this.timeoutMs = timeoutMs;
    this.history = null;
    this.busy = null;
  }

  file() {
    return path.join(dataRoot(), 'assistant', 'history.json');
  }

  async loadHistory() {
    if (!this.history) this.history = (await readJson(this.file(), { messages: [] }).catch(() => ({ messages: [] }))).messages || [];
    return this.history;
  }

  async saveHistory() {
    this.history = this.history.slice(-HISTORY_LIMIT);
    await writeJsonAtomic(this.file(), { messages: this.history }).catch((err) => log.warn(`history not saved: ${err.message}`));
  }

  async clear() {
    this.history = [];
    await this.saveHistory();
  }

  /** The configured choices, or the default engine with its default model. */
  candidates() {
    const cfg = sanitizeAssistantSettings(this.getSettings()?.assistant, [...this.manager.engines.keys()]);
    if (cfg.models.length) return cfg.models;
    return [{ engine: this.manager.settings.engine, model: '' }];
  }

  /**
   * Ask the assistant. Tries the preferred model, then the alternatives. Streams text with
   * 'delta' events ({ id, text }). Resolves with { answer, used, attempts } or throws when none answered.
   */
  async ask({ id = `a_${Date.now().toString(36)}`, question, live, screen, directory }) {
    const q = String(question || '').trim();
    if (!q) throw new Error('Write a question first.');
    if (this.busy) throw new Error('The assistant is still answering the previous question.');
    const history = await this.loadHistory();
    const prompt = buildPrompt({ question: q, history, live, screen });
    history.push({ role: 'user', text: clip(q, 4000), at: Date.now() });
    const attempts = [];
    this.busy = id;
    try {
      for (const c of this.candidates()) {
        const engine = this.manager.get(c.engine);
        const label = `${engine?.label || c.engine}${c.model ? ` · ${c.model}` : ''}`;
        this.emit('progress', { id, text: `Asking ${label}…` });
        try {
          if (!engine) throw new Error(`Unknown engine: ${c.engine}`);
          await this.manager.ensureConnected(c.engine);
          const model = resolveModel(engine, c.model);
          const session = await engine.createSession({ directory: directory || dataRoot(), title: 'SleepPilot assistant', model, permissions: readOnlyRuleset(), readOnly: true });
          let streamed = '';
          const turn = engine.runTurn({
            sessionID: session.id,
            text: prompt,
            metadata: { role: 'assistant', readOnly: true },
            onEvent: (ev) => {
              if (ev?.kind === 'text' && ev.delta) {
                streamed += ev.delta;
                this.emit('delta', { id, text: ev.delta });
              }
            },
          });
          const result = await withTimeout(turn, this.timeoutMs, () => engine.interrupt?.(session.id).catch(() => {}));
          const answer = String(result?.finalText || result?.allText || streamed || '').trim();
          if (result?.status !== 'succeeded' || !answer) {
            const why = result?.errors?.[0]?.message || (result?.status === 'succeeded' ? 'empty answer' : result?.status || 'no answer');
            throw new Error(why);
          }
          const used = { engine: c.engine, label, model: model ? `${model.providerID}/${model.id}` : null };
          history.push({ role: 'assistant', text: clip(answer, 20_000), at: Date.now(), used: label, fallback: attempts.length > 0 });
          await this.saveHistory();
          return { id, answer, used, attempts };
        } catch (err) {
          const message = redact(String(err?.message || err)).slice(0, 400);
          attempts.push({ engine: c.engine, label, error: message });
          this.emit('progress', { id, text: `${label} did not answer (${clip(message, 120)}). ${attempts.length < this.candidates().length ? 'Trying the next choice…' : ''}` });
        }
      }
      history.push({ role: 'assistant', text: `None of the chosen models answered:\n${attempts.map((a) => `- ${a.label}: ${a.error}`).join('\n')}\n\nCheck them under Settings → Engines, or choose other models with ⚙ in this chat.`, at: Date.now(), error: true });
      await this.saveHistory();
      const err = new Error('None of the chosen models answered.');
      err.attempts = attempts;
      throw err;
    } finally {
      this.busy = null;
    }
  }
}

function withTimeout(promise, ms, onTimeout) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        onTimeout?.();
        reject(new Error(`no answer within ${Math.round(ms / 1000)} s`));
      }, ms);
      timer.unref?.();
    }),
  ]);
}
