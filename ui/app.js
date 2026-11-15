// SleepPilot UI — vanilla JS, no build step.
import { initChat, CHAT, chatReset, chatLoad, chatApply, chatTurnFinished, chatSchedule, chatRender, chatPanelHtml } from './chat.js';

const S = {
  state: null,
  view: 'home',
  projectId: localStorage.getItem('sp.projectId') || null,
  project: null,
  runs: [],
  runId: null,
  run: null,
  events: [],
  live: false,
  runTab: localStorage.getItem('sp.runTab') || 'conversation',
  projectTab: 'setup',
  settingsTab: 'engines',
  reverseInfo: null,
  tools: null,
  ollama: null,
  scope: null,
  scopeProjectId: null,
  scopeLoading: false,
  reverseScope: null,
  reverseScopeLoading: false,
  analytics: null,
  github: null,
  githubLoading: false,
  scout: null,
  scoutProjectId: null,
  scoutLoading: false,
  targetScout: null,
  toolScout: null,
  toolScoutLoading: false,
  report: null,
  reportMarkdown: null,
  stats: null,
  setupEngine: null,
  reverseMode: 'rust',
  newTemplate: 'blank',
  busy: false,
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const main = () => $('#main');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = (t) => (t ? new Date(t).toLocaleString('en-GB') : '—');
const fmtClock = (t) => (t ? new Date(t).toLocaleTimeString('en-GB') : '');
const fmtDur = (ms) => {
  if (ms == null) return '—';
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m` : m ? `${m}m ${s % 60}s` : `${s}s`;
};
const num = (n) => (n == null ? '—' : Number(n).toLocaleString('en-US'));
const fmtMoney = (n) => (n == null ? '—' : `$${Number(n).toFixed(4)}`);

let pendingRequests = 0;
let progressTimer = null;
function beginRequest() {
  pendingRequests++;
  if (pendingRequests === 1) {
    clearTimeout(progressTimer);
    progressTimer = setTimeout(() => {
      const p = $('#topProgress');
      if (p) p.hidden = false;
    }, 140);
  }
}
function endRequest() {
  pendingRequests = Math.max(0, pendingRequests - 1);
  if (!pendingRequests) {
    clearTimeout(progressTimer);
    const p = $('#topProgress');
    if (p) p.hidden = true;
  }
}
function setBusy(text = 'Working…') {
  const overlay = $('#busyOverlay');
  if (!overlay) return;
  const label = $('#busyText');
  if (label) label.textContent = text;
  overlay.hidden = false;
}
function clearBusy() {
  const overlay = $('#busyOverlay');
  if (overlay) overlay.hidden = true;
}
async function api(method, path, body) {
  beginRequest();
  try {
    const res = await fetch(path, { method, headers: { 'content-type': 'application/json', 'x-sleeppilot': '1' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
    return data;
  } finally {
    endRequest();
  }
}

function toast(msg, bad = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (bad ? ' bad' : '');
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), bad ? 8000 : 3800);
}

async function guarded(fn) {
  if (S.busy) return;
  try {
    S.busy = true;
    return await fn();
  } catch (err) {
    toast(err.message, true);
  } finally {
    S.busy = false;
  }
}

function badge(text, cls = 'badge-muted') {
  return `<span class="badge ${cls}">${esc(text)}</span>`;
}

const RUN_STATE = {
  created: ['Created', 'badge-muted'],
  running: ['Running', 'badge-ok'],
  paused: ['Paused', 'badge-warn'],
  waiting_user: ['Waiting for you', 'badge-info'],
  completed: ['Completed', 'badge-ok'],
  stopped: ['Stopped', 'badge-muted'],
  failed: ['Failed', 'badge-bad'],
};
const TASK_STATUS = {
  pending: ['Pending', 'badge-muted'],
  in_progress: ['In progress', 'badge-info'],
  verified: ['Verified', 'badge-ok'],
  implemented_unverified: ['Built, not verified', 'badge-warn'],
  test_failed: ['Test failed', 'badge-bad'],
  blocked: ['Blocked', 'badge-bad'],
  waiting_user: ['Needs decision', 'badge-info'],
  cancelled: ['Cancelled', 'badge-muted'],
};
const TURN = {
  succeeded: 'succeeded', failed: 'failed', interrupted: 'interrupted', running: 'running', lost: 'lost', not_found: 'not found',
  completed: 'completed', provider_error: 'provider error', not_submitted: 'not sent',
};
const ROLE = { manager: 'Manager', developer: 'Developer', reviewer: 'Reviewer', closing: 'Closing report', preflight: 'Model check' };
const runBadge = (state) => badge(...(RUN_STATE[state] || [state, 'badge-muted']));
const taskBadge = (status) => badge(...(TASK_STATUS[status] || [status, 'badge-muted']));

// ------------------------------------------------------------------ engines & models

const engines = () => S.state?.engines?.engines || [];
const engineById = (id) => engines().find((e) => e.id === id) || null;
const defaultEngineId = () => S.state?.engines?.default || 'opencode';
const projectEngineId = () => S.setupEngine || S.project?.settings?.engine || defaultEngineId();
const currentEngine = () => engineById(projectEngineId());
const models = (engineId = projectEngineId()) => engineById(engineId)?.models || [];

function modelKey(m) {
  return m ? `${m.providerID}/${m.id}` : '';
}
function modelOptions(selected) {
  const list = models();
  const cur = selected ? modelKey(selected) : '';
  if (!list.length) return `<option value="">No models — connect the engine first</option>`;
  return list.map((m) => `<option value="${esc(modelKey(m))}" ${modelKey(m) === cur ? 'selected' : ''}>${esc(m.name || m.id)} · ${esc(m.providerLabel || m.providerID)}</option>`).join('');
}
function parseModel(value) {
  if (!value) return null;
  const i = String(value).indexOf('/');
  return i > 0 ? { providerID: value.slice(0, i), id: value.slice(i + 1) } : null;
}
function engineStatusBadge(engine) {
  const st = engine?.status?.state || 'disconnected';
  const cls = st === 'connected' ? 'badge-ok' : st === 'error' || st === 'lost' ? 'badge-bad' : st === 'starting' || st === 'detecting' || st === 'connecting' ? 'badge-warn' : 'badge-muted';
  return badge(st, cls);
}
function currentEngineLabel() {
  const e = engineById(defaultEngineId());
  return e ? `${e.label}` : 'engine';
}
function renderEngineBadge() {
  const b = $('#engineBadge');
  if (!b) return;
  const e = engineById(defaultEngineId());
  if (!e) {
    b.textContent = 'Engine: not configured';
    return;
  }
  const st = e.status?.state || 'disconnected';
  b.textContent = `${e.label}: ${st}`;
  b.title = e.status?.message || '';
  b.style.color = st === 'connected' ? 'var(--ok)' : st === 'error' ? 'var(--bad)' : 'var(--warn)';
}
function renderRunBadge(run = S.run) {
  const b = $('#runBadge');
  if (!b) return;
  if (!run || ['completed', 'stopped', 'failed'].includes(run.state)) {
    b.hidden = true;
    return;
  }
  b.hidden = false;
  b.textContent = `Run: ${RUN_STATE[run.state]?.[0] || run.state}`;
  b.style.color = run.state === 'running' ? 'var(--ok)' : 'var(--warn)';
}

// ------------------------------------------------------------------ boot & events

async function loadState() {
  S.state = await api('GET', '/api/state');
  $('#testBanner').hidden = !S.state.app.testMode;
  document.title = S.state.app.testMode ? 'SleepPilot (test mode)' : 'SleepPilot';
  document.body.classList.toggle('on-phone', !!S.state.viewer?.phone);
  if (S.projectId && !S.state.projects.some((p) => p.id === S.projectId)) S.projectId = null;
  if (!S.projectId && S.state.activeRuns?.length) S.projectId = S.state.activeRuns[0].projectId;
  renderEngineBadge();
}

async function loadProject(id = S.projectId, { keepRun = false } = {}) {
  if (!id) {
    S.project = null;
    S.runs = [];
    return;
  }
  const r = await api('GET', `/api/projects/${id}`);
  S.project = r.project;
  S.runs = r.runs || [];
  S.projectId = id;
  S.setupEngine = null;
  localStorage.setItem('sp.projectId', id);
  const active = S.state.activeRuns?.find((r) => r.projectId === id)?.runId || null;
  if (!keepRun || !S.runId || !S.runs.some((x) => x.id === S.runId)) S.runId = active || S.runs[0]?.id || null;
  const sidebar = $('#sidebarProject');
  if (sidebar) sidebar.innerHTML = `<b>${esc(S.project.name)}</b>${esc(S.project.dir)}`;
}

async function loadRun(runId = S.runId) {
  if (!S.projectId || !runId) {
    S.run = null;
    S.events = [];
    return;
  }
  const r = await api('GET', `/api/runs/${S.projectId}/${runId}`);
  const changed = S.runId !== runId || S.run?.id !== r.run.id;
  S.run = r.run;
  S.runId = runId;
  S.events = r.events || [];
  S.live = r.live;
  if (changed) {
    chatReset();
    localStorage.setItem('sp.runId', runId);
  }
}

function connectEvents() {
  const es = new EventSource('/events');
  es.onmessage = (m) => {
    let msg;
    try {
      msg = JSON.parse(m.data);
    } catch {
      return;
    }
    if (msg.type === 'engines') {
      if (S.state) S.state.engines = msg.data;
      renderEngineBadge();
      if (S.view === 'settings' && !isEditing()) renderSettings();
      if (S.view === 'home') renderEngineStrip();
    } else if (msg.type === 'run') {
      onRunUpdate(msg.data);
    } else if (msg.type === 'turn') {
      if (msg.runId === S.runId) chatTurnFinished(msg.data);
    } else if (msg.type === 'log') {
      if (msg.runId !== S.runId) return;
      const d = msg.data;
      if (d.turn && chatApply(d)) chatSchedule(d.turn);
      if (!d.turn && S.view === 'run' && S.runTab === 'conversation') chatSchedule('*');
      S.events.push(d);
      if (S.events.length > 1200) S.events.splice(0, 400);
      if (S.view === 'run' && S.runTab === 'log') appendLogLine(d);
    }
  };
  let hadError = false;
  es.onerror = () => {
    hadError = true;
  };
  es.onopen = () => {
    if (!hadError) return;
    hadError = false;
    loadState().then(() => go(S.view)).catch(() => {});
  };
}

function isEditing() {
  const a = document.activeElement;
  return !!a && ['INPUT', 'TEXTAREA', 'SELECT'].includes(a.tagName);
}

const lastRunState = new Map();
function onRunUpdate(run) {
  if (S.state) {
    const terminal = ['completed', 'stopped', 'failed'].includes(run.state);
    const list = (S.state.activeRuns || []).filter((r) => r.runId !== run.id);
    if (!terminal) {
      const projectName = S.state.projects?.find((p) => p.id === run.projectId)?.name || run.projectId;
      list.push({ projectId: run.projectId, projectName, runId: run.id, state: run.state, engine: run.engine?.label || null, activity: run.activity?.message || '', iteration: run.iterationCount });
    }
    S.state.activeRuns = list;
    S.state.activeRun = list[0] || null;
    S.state.projects = (S.state.projects || []).map((p) => (p.id === run.projectId ? { ...p, updatedAt: Date.now(), lastRunId: run.id } : p));
  }
  renderRunBadge(run);
  notifyRunChange(run);
  if (S.run?.id === run.id) {
    S.run = run;
    if (S.view === 'run') updateRunView(run);
    if (S.view === 'report') renderReport().then(() => renderReportView()).catch(() => {});
  }
  if (S.view === 'home' && !isEditing()) renderHome().catch(() => {});
  if (['completed', 'stopped', 'failed'].includes(run.state) && S.run?.id === run.id && S.view === 'run') updateRunView(run);
}

function notifyRunChange(r) {
  const prev = lastRunState.get(r.id);
  lastRunState.set(r.id, r.state);
  if (!prev || prev === r.state || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  const tc = r.taskCounts || {};
  const done = `${tc.verified || 0} verified${tc.implemented_unverified ? `, ${tc.implemented_unverified} not verified` : ''}`;
  let body = null;
  if (['completed', 'stopped', 'failed'].includes(r.state)) body = `Run finished — ${r.stopReason?.label || r.state}. ${done}.`;
  else if (r.state === 'waiting_user') body = `Your decision is needed: ${(r.pause?.message || '').slice(0, 120)}`;
  else if (r.state === 'paused' && r.pause?.code !== 'user_paused') body = `Paused — ${r.pause?.label || ''}: ${(r.pause?.message || '').slice(0, 100)}`;
  if (!body) return;
  try {
    const n = new Notification('SleepPilot', { body, tag: `sp-${r.id}`, icon: '/icon.svg' });
    n.onclick = () => {
      window.focus();
      S.projectId = r.projectId;
      S.runId = r.id;
      go(['completed', 'stopped', 'failed'].includes(r.state) ? 'report' : 'run');
    };
  } catch {}
}

// ------------------------------------------------------------------ navigation

async function go(view) {
  if (!view) view = 'home';
  // Never move the active-nav highlight before the guarded navigation actually starts; doing so
  // left the previous screen visible under a new nav highlight when a click landed mid-load.
  if (S.busy) return;
  S.view = view;
  localStorage.setItem('sp.view', view);
  setActiveNav(view);
  await guarded(async () => {
    if (['project', 'run', 'report'].includes(view)) {
      if (S.projectId) await loadProject(S.projectId, { keepRun: true });
      else {
        renderNeedProject();
        return;
      }
    }
    if (view === 'project' && !S.reverseInfo) S.reverseInfo = await api('GET', '/api/reverse/info').catch(() => null);
    if (view === 'run' && S.projectId) {
      if (!S.runId) S.runId = S.state.activeRuns?.find((r) => r.projectId === S.projectId)?.runId || S.runs[0]?.id || null;
      await loadRun();
    }
    if (view === 'report') await renderReport();
    if (view === 'insights') S.analytics = await api('GET', '/api/analytics').catch(() => S.analytics);
    if (view === 'reverse') await renderReverse();
    if (view === 'settings') renderSettings().catch((err) => toast(err.message, true));
    if (view === 'home') await loadState();
    render();
  });
}

function setActiveNav(view) {
  $$('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
}

function render() {
  setActiveNav(S.view);
  const map = { home: renderHome, project: renderProject, run: renderRun, report: renderReportView, insights: renderInsightsView, reverse: renderReverseView, settings: renderSettingsView };
  (map[S.view] || renderHome)();
}

function renderNeedProject() {
  main().innerHTML = `<div class="card"><h2>No project selected</h2><p class="sub">Create a project or open an existing folder to begin.</p><button class="btn btn-primary" data-act="goHome">Go to projects</button></div>`;
}

// ------------------------------------------------------------------ HOME

async function renderHome() {
  const ps = S.state?.projects || [];
  const activeRuns = S.state?.activeRuns || [];
  const engineList = engines();
  main().innerHTML = `
  <div class="hero">
    <div>
      <h1>Plan. Build. Verify. Sleep.</h1>
      <p>SleepPilot is an autonomous engineering harness. It plans the work, sends one concrete task at a time to your engine, runs real checks, reviews the result and continues while you sleep.</p>
      <div class="row">
        <button class="btn btn-primary" data-act="focusNewProject">Start a project</button>
        <button class="btn" data-act="goReverse">Sleep &amp; Reverse &amp; Rust It</button>
        <button class="btn btn-ghost" data-act="goSettings">Configure engines</button>
      </div>
    </div>
    <div class="hero-side">
      <div class="hero-stat"><span>Active runs</span><b>${activeRuns.length}</b></div>
      <div class="hero-stat"><span>Projects</span><b>${ps.length}</b></div>
      <div class="hero-stat"><span>Default engine</span><b>${esc(engineById(defaultEngineId())?.label || defaultEngineId())}</b></div>
      ${activeRuns.length ? `<button class="btn btn-primary" data-act="openActiveRun">Open latest run</button>` : ''}
    </div>
  </div>

  ${activeRuns.length ? `<div class="card"><div class="card-head"><h2>Active runs</h2><span class="hint">${activeRuns.length} of ${S.state.settings?.maxConcurrentRuns || 3} allowed</span></div>${activeRuns.map((ar) => `<div class="project-row"><div class="project-main"><div class="project-name"><span class="pulse-dot"></span>${esc(ar.projectName)} ${badge(ar.state, ar.state === 'running' ? 'badge-ok' : 'badge-warn')}</div><div class="hint">${esc(ar.engine || '')} · ${esc(ar.activity || '')}</div></div><div class="project-meta"><span class="hint">iteration ${num(ar.iteration)}</span><button class="btn btn-small" data-act="openRunById" data-project="${esc(ar.projectId)}" data-run="${esc(ar.runId)}">Open</button></div></div>`).join('')}</div>` : ''}

  <div class="grid grid-2">
    <div class="card">
      <div class="card-head"><h2>New project</h2><span class="hint">Any folder with code, or a new empty folder</span></div>
      <label>Project name</label>
      <input type="text" id="npName" placeholder="e.g. My app, save-editor, game mod">
      <label>Folder</label>
      <div class="row"><input type="text" id="npDir" class="grow" placeholder="C:\\projects\\my-app"><button class="btn" data-act="pickDir" data-for="npDir">Browse…</button></div>
      <div class="grid grid-2">
        <div>
          <label>Engine</label>
          <select id="npEngine">${engineList.map((e) => `<option value="${esc(e.id)}" ${e.id === defaultEngineId() ? 'selected' : ''}>${esc(e.label)}</option>`).join('')}</select>
        </div>
        <div>
          <label>Template</label>
          <select id="npTemplate">
            <option value="blank" ${S.newTemplate === 'blank' ? 'selected' : ''}>Existing / blank folder</option>
            <option value="rust" ${S.newTemplate === 'rust' ? 'selected' : ''}>New Rust project (Cargo scaffold)</option>
          </select>
        </div>
      </div>
      <label class="check"><input type="checkbox" id="npCreate" ${S.newTemplate === 'rust' ? 'checked' : ''}> Create the folder if it does not exist</label>
      <div class="row" style="margin-top:10px"><button class="btn btn-primary" data-act="createProject">Create project</button><span class="hint">A new Rust project is scaffolded and checked with cargo when possible.</span></div>
    </div>

    <div class="card">
      <div class="card-head"><h2>Engines</h2><span class="hint">${esc(currentEngineLabel())} is the default</span></div>
      <div id="engineStrip">${engineStripHtml()}</div>
      <div class="hint" style="margin-top:10px">OpenCode, Claude Code, Codex, a direct API-key harness, DeepSeek Harness and any command-line harness can drive the same runs. Multiple projects can run at the same time.</div>
    </div>
  </div>

  <div class="card">
    <div class="card-head"><h2>Recent projects</h2><span class="hint">${ps.length} saved</span></div>
    ${ps.length ? ps.map((p) => `
      <div class="project-row">
        <div class="project-main">
          <div class="project-name">${esc(p.name)} ${p.kind?.startsWith('reverse') ? badge('Reverse & Rust', 'badge-info') : p.kind === 'rust' ? badge('Rust', 'badge-info') : ''} ${activeRuns.some((ar) => ar.projectId === p.id) ? badge('active run', 'badge-ok') : ''}</div>
          <div class="project-dir mono">${esc(p.dir)}</div>
          <div class="hint">${esc((p.objective?.text || 'No objective yet').slice(0, 180))}</div>
        </div>
        <div class="project-meta">
          <span class="hint">${fmtTime(p.updatedAt)}</span>
          <button class="btn btn-small" data-act="openProject" data-id="${esc(p.id)}">Open</button>
        </div>
      </div>`).join('') : '<div class="empty">No projects yet. Create one above or start with Reverse & Rust.</div>'}
  </div>`;
  if (S.newTemplate === 'rust') setTimeout(() => $('#npName')?.focus(), 30);
}

function engineStripHtml() {
  return engines().map((e) => `
    <div class="row" style="justify-content:space-between;padding:7px 0;border-bottom:1px solid var(--line)">
      <div><b>${esc(e.label)}</b><div class="hint">${esc(e.status?.message || '')}</div></div>
      <div class="row">${engineStatusBadge(e)}${e.status?.state !== 'connected' ? `<button class="btn btn-small" data-act="connectEngine" data-id="${esc(e.id)}">Connect</button>` : ''}</div>
    </div>`).join('');
}
function renderEngineStrip() {
  const el = $('#engineStrip');
  if (el) el.innerHTML = engineStripHtml();
}

// ------------------------------------------------------------------ PROJECT SETUP

const DURATIONS = [[60, '1 hour'], [240, '4 hours'], [480, '8 hours'], [720, '12 hours']];
const PRESETS = {
  overnight: {
    label: 'Overnight',
    text: 'Full autonomy, unattended, 2 developers. Retries temporary errors by itself and writes a closing report.',
    values: { permissionProfile: 'full', unattended: true, parallelDevelopers: 2, durationMin: 480, improvementMode: false, reviewerEnabled: true, closingReport: true, finalGraceMin: 30, carryOverTasks: true, backupBeforeRun: true, maxTurnMin: 45, overtimeMin: 60, overtimeMaxRounds: 2, maxIterations: 80 },
  },
  supervised: {
    label: 'Supervised',
    text: 'Read-only commands and builds run freely; anything else asks. Best while you are at the computer.',
    values: { permissionProfile: 'balanced', unattended: false, parallelDevelopers: 1, durationMin: 240, permissionTimeoutMin: 10, reviewerEnabled: true, closingReport: true, backupBeforeRun: true, maxTurnMin: 60, overtimeMin: 0, overtimeMaxRounds: 1, maxIterations: 40 },
  },
  strict: {
    label: 'Strict',
    text: 'Every command and outside folder asks for approval. Short, watched runs only.',
    values: { permissionProfile: 'strict', unattended: false, parallelDevelopers: 1, durationMin: 60, permissionTimeoutMin: 0, reviewerEnabled: true, closingReport: true, backupBeforeRun: true, overtimeMin: 0, overtimeMaxRounds: 1, maxIterations: 20 },
  },
  unrestricted: {
    label: 'Unrestricted',
    text: 'No permission checks, no command deny list. Everything is your responsibility.',
    values: { permissionProfile: 'unrestricted', unattended: true, parallelDevelopers: 2, durationMin: 480, permissionTimeoutMin: 2, reviewerEnabled: true, closingReport: true, backupBeforeRun: true, maxTurnMin: 45, overtimeMin: 60, overtimeMaxRounds: 2, maxIterations: 80 },
  },
};

function renderProject() {
  if (!S.project) return renderNeedProject();
  const p = S.project;
  const s = p.settings || {};
  const active = !!S.state?.activeRuns?.some((ar) => ar.projectId === p.id);
  const engineId = projectEngineId();
  const engine = currentEngine();
  const approved = Object.keys(PRESETS).find((k) => presetMatches(s, PRESETS[k].values) || s.preset === k) || null;
  const hours = Math.max(0.25, Math.round((s.durationMin || 480) / 60 * 4) / 4);
  main().innerHTML = `
  <div class="row" style="justify-content:space-between;align-items:flex-start">
    <div>
      <h1>${esc(p.name)}</h1>
      <div class="sub mono">${esc(p.dir)}</div>
    </div>
    <div class="row">
      ${active ? badge('Run active', 'badge-ok') : badge('Ready', 'badge-muted')}
      <button class="btn btn-small" data-act="goHome">Projects</button>
    </div>
  </div>
  ${active ? `<div class="info-box">A run is active for this project. Settings for the next run can be saved; to change direction now, use the steering box on the <a href="#" data-act="openActiveRun">Run screen</a>.</div>` : ''}
  ${p.reverse ? reverseProjectBanner(p) : ''}
  ${p.kind === 'rust' ? `<div class="info-box"><b>Rust project.</b> The Cargo scaffold and its checks are ready. ${S.reverseInfo?.rust?.cargo ? `cargo ${esc(S.reverseInfo.rust.cargo.version || '')}` : 'cargo was not found — install Rust from rustup.rs to enable cargo check/test.'}</div>` : ''}
  <div id="scopeCard">${scopeCardHtml()}</div>
  <div id="githubCard">${githubCardHtml()}</div>
  <div id="scoutCard">${scoutCardHtml()}</div>

  <div class="card">
    <div class="card-head"><h2>Goal</h2><span class="hint">Speak plainly; the Manager turns this into tasks.</span></div>
    <textarea id="fObjective" rows="5" placeholder="What should be built, fixed or analysed? Include constraints, acceptance criteria and anything that must not change.">${esc(p.objective?.text || '')}</textarea>
    <label>Additional rules for the agents (optional)</label>
    <textarea id="fRules" rows="2" placeholder="e.g. Use TypeScript strict mode. Never touch the vendored/ folder.">${esc(p.rules || '')}</textarea>
  </div>

  <div class="card">
    <div class="card-head"><h2>Run settings</h2><span class="hint">Presets fill the form; nothing is saved until you click Save.</span></div>
    <div class="preset-grid">
      ${Object.entries(PRESETS).map(([k, v]) => `<button class="preset ${approved === k ? 'active' : ''}" data-act="applyPreset" data-key="${k}"><b>${esc(v.label)}</b><span>${esc(v.text)}</span></button>`).join('')}
    </div>
    <div class="grid grid-3" style="margin-top:14px">
      <div>
        <label>Engine</label>
        <select id="fEngine">${engines().map((e) => `<option value="${esc(e.id)}" ${e.id === engineId ? 'selected' : ''}>${esc(e.label)}</option>`).join('')}</select>
        <div class="hint">${engine ? esc(engine.status?.message || '') : 'Engine not configured'}${engine && !engine.models.length ? ` · <a href="#" data-act="connectEngine" data-id="${esc(engine.id)}">connect</a>` : ''}</div>
      </div>
      <div>
        <label>Time limit (hours)</label>
        <input type="number" id="fDuration" min="0.25" step="0.25" value="${hours}">
        <div class="pill-row" style="margin-top:6px">${DURATIONS.map(([m, l]) => `<button class="chip" data-act="setDuration" data-min="${m}">${l}</button>`).join('')}</div>
      </div>
      <div>
        <label>Permission profile</label>
        <select id="fProfile">${Object.entries(S.state.profiles || {}).map(([k, v]) => `<option value="${k}" ${s.permissionProfile === k ? 'selected' : ''}>${esc(v.label)}</option>`).join('')}</select>
        <label class="check"><input type="checkbox" id="fUnattended" ${s.unattended ? 'checked' : ''}> Unattended / sleep mode</label>
      </div>
    </div>
    <div class="grid grid-3" style="margin-top:8px">
      <div><label>Manager model</label><select id="fModelManager">${modelOptions(s.models?.manager)}</select></div>
      <div><label>Developer model</label><select id="fModelDeveloper">${modelOptions(s.models?.developer)}</select></div>
      <div><label>Reviewer model</label><select id="fModelReviewer">${modelOptions(s.models?.reviewer)}</select></div>
    </div>
    ${routingSettingsHtml(s)}

    <details style="margin-top:14px">
      <summary class="hint">Advanced settings and checks</summary>
      <div class="grid grid-4" style="margin-top:10px">
        <div><label>Max iterations</label><input type="number" id="fMaxIter" min="1" value="${s.maxIterations || 80}"></div>
        <div><label>Max minutes per turn</label><input type="number" id="fMaxTurn" min="0" value="${s.maxTurnMin || 45}"></div>
        <div><label>Final answer grace (min)</label><input type="number" id="fFinalGrace" min="0" value="${s.finalGraceMin || 30}"></div>
        <div><label>Parallel developers</label><input type="number" id="fParallel" min="1" max="4" value="${s.parallelDevelopers || 1}"></div>
        <div><label>Overtime (min)</label><input type="number" id="fOvertime" min="0" value="${s.overtimeMin || 0}"></div>
        <div><label>Overtime rounds</label><input type="number" id="fOvertimeRounds" min="1" value="${s.overtimeMaxRounds || 1}"></div>
        <div><label>Permission timeout (min)</label><input type="number" id="fPermTimeout" min="0" value="${s.permissionTimeoutMin ?? 5}"></div>
        <div><label>Scope</label><select id="fScope"><option value="strict" ${s.scopeMode !== 'creative' ? 'selected' : ''}>Strict (objective only)</option><option value="creative" ${s.scopeMode === 'creative' ? 'selected' : ''}>Creative (related ideas allowed)</option></select></div>
      </div>
      <div class="grid grid-3" style="margin-top:8px">
        <label class="check"><input type="checkbox" id="fReviewer" ${s.reviewerEnabled !== false ? 'checked' : ''}> Reviewer enabled</label>
        <label class="check"><input type="checkbox" id="fClosing" ${s.closingReport !== false ? 'checked' : ''}> Closing report</label>
        <label class="check"><input type="checkbox" id="fBackup" ${s.backupBeforeRun !== false ? 'checked' : ''}> Backup before run</label>
        <label class="check"><input type="checkbox" id="fCarry" ${s.carryOverTasks !== false ? 'checked' : ''}> Carry over open tasks</label>
        <label class="check"><input type="checkbox" id="fImprovement" ${s.improvementMode ? 'checked' : ''}> Improvement mode when tasks finish</label>
        <label class="check"><input type="checkbox" id="fPlanReview" ${s.planReview ? 'checked' : ''}> Review the plan before starting</label>
        <label class="check"><input type="checkbox" id="fAutoResume" ${s.autoResumeOnQuotaReset ? 'checked' : ''}> Auto-resume after quota reset</label>
      </div>
      <label>Protected paths (one per line; the agent cannot write there)</label>
      <textarea id="fProtected" rows="3" placeholder="C:\\important\\folder">${esc((s.protectedPaths || []).join('\n'))}</textarea>
      <h3>Checks</h3>
      <div id="checksEditor">${checksEditorHtml(p.checks || [])}</div>
      <div class="row" style="margin-top:8px">
        <input type="text" id="newCheckName" class="grow" placeholder="New command check name">
        <input type="text" id="newCheckCommand" class="grow" placeholder="e.g. cargo test">
        <button class="btn btn-small" data-act="addCheck">Add check</button>
      </div>
      <div class="hint">Checks are the evidence: a task is only “verified” when an enabled check actually passed after the change.</div>
    </details>
  </div>

  <div class="sticky-bar">
    <div class="summary" id="setupSummary">${esc(setupSummary(p, s))}</div>
    <div class="row">
      <button class="btn" data-act="saveProject">Save settings</button>
      <button class="btn btn-primary" data-act="startRun" ${active ? 'disabled' : ''}>${active ? 'A run is active' : 'Start run'}</button>
      ${active ? '<button class="btn" data-act="openActiveRun">Open run</button>' : ''}
      <span class="hint">Nothing is committed or pushed for you.</span>
    </div>
  </div>`;
  setActiveNav('project');
  loadProjectScope().catch(() => {});
  loadProjectGitHub().catch(() => {});
  loadProjectScout().catch(() => {});
  const duration = $('#fDuration');
  if (duration) duration.addEventListener('input', updateSetupSummary);
  $('#fEngine')?.addEventListener('change', (e) => {
    S.setupEngine = e.target.value;
    refreshModelSelects();
  });
  $$('#fProfile, #fUnattended, #fMaxIter, #fMaxTurn, #fFinalGrace, #fParallel, #fOvertime, #fOvertimeRounds, #fPermTimeout').forEach((el) => el?.addEventListener('change', updateSetupSummary));
}

function presetMatches(s, values) {
  return ['permissionProfile', 'unattended', 'parallelDevelopers'].every((k) => s[k] === values[k]);
}

function setupSummary(p, s) {
  const e = engineById(s.engine || defaultEngineId());
  const model = s.models?.developer ? modelKey(s.models.developer) : 'engine default';
  return `${s.durationMin ? (s.durationMin / 60).toFixed(2).replace(/\.00$/, '') : '8'} h · ${PROFILES_LABEL(s.permissionProfile)} · ${s.unattended ? 'unattended' : 'supervised'} · ${e?.label || s.engine || 'engine'} · ${model}`;
}
const PROFILES_LABEL = (k) => S.state?.profiles?.[k]?.label || k || 'balanced';

function updateSetupSummary() {
  const el = $('#setupSummary');
  if (!el || !S.project) return;
  const hours = Number($('#fDuration')?.value || 8);
  el.textContent = `${hours} h · ${PROFILES_LABEL($('#fProfile')?.value)} · ${$('#fUnattended')?.checked ? 'unattended' : 'supervised'} · ${engineById($('#fEngine')?.value)?.label || ''} · ${$('#fModelDeveloper')?.value || 'engine default'}`;
}

function refreshModelSelects() {
  const engine = engineById($('#fEngine')?.value || projectEngineId());
  const roles = ['Manager', 'Developer', 'Reviewer'];
  for (const r of roles) {
    const sel = $(`#fModel${r}`);
    if (!sel) continue;
    sel.innerHTML = modelOptions(null);
  }
  if (engine && !engine.models.length) toast(`${engine.label} has no models yet. Connect it in Settings or choose another engine.`, true);
}

function routingSettingsHtml(s) {
  const routing = s.harnessRouting || {};
  const pins = s.rolePins || {};
  const profiles = s.modelProfiles || {};
  const readOnlyRole = (role) => role === 'manager' || role === 'reviewer';
  const harnessOptions = (selected, role) => ['<option value="">Default engine</option>', ...engines().filter((e) => !readOnlyRole(role) || ['opencode', 'claude', 'codex', 'api'].includes(e.id)).map((e) => `<option value="${esc(e.id)}" ${selected === e.id ? 'selected' : ''}>${esc(e.label)}</option>`)].join('');
  const pinRow = (role, label) => `<div><label>${label} harness</label><select id="fPin${label}Harness">${harnessOptions(pins[role]?.harness, role)}</select><label>${label} model profile</label><input type="text" id="fPin${label}Profile" value="${esc(pins[role]?.modelProfile || '')}" placeholder="default / high / max"></div>`;
  return `<details style="margin-top:12px" ${routing.enabled || Object.values(pins).some((p) => p?.harness) ? 'open' : ''}>
    <summary class="hint">Multi-harness routing and model profiles</summary>
    <label class="check"><input type="checkbox" id="fRoutingEnabled" ${routing.enabled ? 'checked' : ''}> Enable routing across harnesses (role pins and fallback chain)</label>
    <div class="grid grid-3" style="margin-top:8px">${pinRow('manager', 'Manager')}${pinRow('developer', 'Developer')}${pinRow('reviewer', 'Reviewer')}</div>
    <div class="grid grid-2" style="margin-top:8px">
      <div><label>Fallback chain (comma-separated harness ids)</label><input type="text" id="fFallbackChain" value="${esc((routing.fallbackChain || []).join(', '))}" placeholder="claude, dsh, api, opencode"><div class="hint">Each failure or quota block advances to the next usable harness.</div></div>
      <div><label>Working window (hours)</label><input type="number" id="fWorkingWindow" min="1" max="48" value="${routing.workingWindowHours || 10}"><div class="hint">The run keeps rotating while this window is open; the run time limit still applies.</div></div>
    </div>
    <label>Task-type routes (JSON, optional)</label>
    <textarea id="fTaskTypes" rows="3" spellcheck="false">${esc(JSON.stringify(routing.taskTypes || {}, null, 2))}</textarea>
    <label>Model profiles (JSON per engine)</label>
    <textarea id="fModelProfiles" rows="8" spellcheck="false">${esc(JSON.stringify(profiles, null, 2))}</textarea>
    <div class="hint">Profile shape: <code>{"engine":{"profileName":{"model":"model-id","effort":"high"}}}</code>. Effort is validated against the real engine vocabulary: API off/none/minimal/low/medium/high/xhigh/max/ultra; Claude low/medium/high/xhigh/max; Codex minimal/low/medium/high. Unsupported values are rejected, never downgraded.</div>
  </details>`;
}

function checksEditorHtml(checks) {
  if (!checks.length) return '<div class="hint">No checks configured. Tasks will be “built, not verified”.</div>';
  return checks.map((c) => `
    <div class="row" style="justify-content:space-between;border-bottom:1px solid var(--line);padding:6px 0" data-check-row="${esc(c.id)}">
      <div class="grow">
        <label class="check" style="margin:0"><input type="checkbox" data-check-enabled="${esc(c.id)}" ${c.enabled ? 'checked' : ''}> <b>${esc(c.name)}</b> <span class="badge badge-muted">${esc(c.type)}</span></label>
        ${c.type === 'command' ? `<input type="text" data-check-command="${esc(c.id)}" value="${esc(c.command || '')}" placeholder="command">` : ''}
        ${c.reason ? `<div class="hint">${esc(c.reason)}</div>` : ''}
      </div>
      <button class="btn btn-small btn-danger" data-act="removeCheck" data-id="${esc(c.id)}">Remove</button>
    </div>`).join('');
}

function readChecks() {
  if (!S.project) return [];
  return (S.project.checks || []).map((c) => {
    const enabled = $(`[data-check-enabled="${CSS.escape(c.id)}"]`)?.checked ?? c.enabled;
    const command = c.type === 'command' ? $(`[data-check-command="${CSS.escape(c.id)}"]`)?.value ?? c.command : c.command;
    return { ...c, enabled: !!enabled, command };
  });
}

function readSetup() {
  const hours = Number($('#fDuration')?.value || 8);
  const models = {
    manager: parseModel($('#fModelManager')?.value),
    developer: parseModel($('#fModelDeveloper')?.value),
    reviewer: parseModel($('#fModelReviewer')?.value),
  };
  let modelProfiles = S.project?.settings?.modelProfiles || {};
  try {
    const raw = $('#fModelProfiles')?.value?.trim();
    if (raw) modelProfiles = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Model profiles JSON is invalid: ${err.message}`);
  }
  const rolePins = {};
  for (const [role, label] of [['manager', 'Manager'], ['developer', 'Developer'], ['reviewer', 'Reviewer']]) {
    const harness = $(`#fPin${label}Harness`)?.value || null;
    const modelProfile = $(`#fPin${label}Profile`)?.value?.trim() || null;
    if (harness) rolePins[role] = { harness, modelProfile };
  }
  const baseRouting = S.project?.settings?.harnessRouting || {};
  let taskTypes = baseRouting.taskTypes || {};
  try {
    const raw = $('#fTaskTypes')?.value?.trim();
    if (raw) taskTypes = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Task-type routes JSON is invalid: ${err.message}`);
  }
  const harnessRouting = {
    ...baseRouting,
    enabled: !!$('#fRoutingEnabled')?.checked,
    fallbackChain: String($('#fFallbackChain')?.value || '').split(/[\s,]+/).map((x) => x.trim()).filter(Boolean),
    workingWindowHours: Number($('#fWorkingWindow')?.value) || 10,
    taskTypes,
  };
  const settings = {
    engine: $('#fEngine')?.value || projectEngineId(),
    durationMin: Math.max(15, Math.round(hours * 60)),
    maxIterations: Number($('#fMaxIter')?.value) || 80,
    maxTurnMin: Number($('#fMaxTurn')?.value) ?? 45,
    finalGraceMin: Number($('#fFinalGrace')?.value) ?? 30,
    parallelDevelopers: Math.max(1, Math.min(4, Number($('#fParallel')?.value) || 1)),
    overtimeMin: Number($('#fOvertime')?.value) || 0,
    overtimeMaxRounds: Number($('#fOvertimeRounds')?.value) || 1,
    permissionTimeoutMin: Number($('#fPermTimeout')?.value) ?? 5,
    scopeMode: $('#fScope')?.value || 'strict',
    permissionProfile: $('#fProfile')?.value || 'balanced',
    unattended: !!$('#fUnattended')?.checked,
    reviewerEnabled: !!$('#fReviewer')?.checked,
    closingReport: !!$('#fClosing')?.checked,
    backupBeforeRun: !!$('#fBackup')?.checked,
    carryOverTasks: !!$('#fCarry')?.checked,
    improvementMode: !!$('#fImprovement')?.checked,
    planReview: !!$('#fPlanReview')?.checked,
    autoResumeOnQuotaReset: !!$('#fAutoResume')?.checked,
    protectedPaths: String($('#fProtected')?.value || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean),
    models,
    harnessRouting,
    modelProfiles,
    rolePins,
  };
  return {
    objective: $('#fObjective')?.value || '',
    rules: $('#fRules')?.value || '',
    settings,
    checks: readChecks(),
  };
}

async function saveProjectSetup() {
  if (!S.project) throw new Error('No project.');
  const data = readSetup();
  const updated = await api('PUT', `/api/projects/${S.project.id}`, { objective: data.objective, rules: data.rules, settings: data.settings, checks: data.checks });
  S.project = updated;
  await loadProject(S.projectId, { keepRun: true });
  return updated;
}

async function applyPreset(key) {
  const preset = PRESETS[key];
  if (!preset || !S.project) return;
  const v = preset.values;
  const set = (sel, val) => {
    const el = $(sel);
    if (!el) return;
    if (el.type === 'checkbox') el.checked = !!val;
    else el.value = val ?? '';
  };
  set('#fProfile', v.permissionProfile);
  set('#fUnattended', v.unattended);
  set('#fParallel', v.parallelDevelopers);
  if (v.durationMin) set('#fDuration', Math.round((v.durationMin / 60) * 4) / 4);
  set('#fImprovement', v.improvementMode);
  set('#fReviewer', v.reviewerEnabled);
  set('#fClosing', v.closingReport);
  set('#fFinalGrace', v.finalGraceMin);
  set('#fCarry', v.carryOverTasks);
  set('#fBackup', v.backupBeforeRun);
  set('#fMaxTurn', v.maxTurnMin);
  set('#fOvertime', v.overtimeMin);
  set('#fOvertimeRounds', v.overtimeMaxRounds);
  set('#fMaxIter', v.maxIterations);
  if (v.permissionTimeoutMin != null) set('#fPermTimeout', v.permissionTimeoutMin);
  $$('.preset').forEach((el) => el.classList.toggle('active', el.dataset.key === key));
  updateSetupSummary();
  toast(`“${preset.label}” applied to the form. Save to keep it.`);
}

function scopeCardHtml() {
  if (!S.project) return '';
  if (S.scopeLoading && S.scopeProjectId === S.project.id) {
    return `<div class="scope-card"><div class="scope-head"><div><b>Analyzing the project scope…</b><div class="hint">Counting source files and lines, tests, TODOs and generated folders. This suggests a realistic time limit and task scope.</div></div><span class="spinner"></span></div><div class="skeleton" style="height:38px;margin-top:10px"></div></div>`;
  }
  const s = S.scope?.dir === S.project.dir ? S.scope : null;
  if (s?.error) {
    return `<div class="scope-card"><div class="scope-head"><div><b>Scope analysis failed</b><div class="hint">${esc(s.error)}</div></div><button class="btn btn-small" data-act="refreshScope">Retry</button></div></div>`;
  }
  if (!s) {
    return `<div class="scope-card"><div class="scope-head"><div><b>Scope analysis</b><div class="hint">Analyze the current project before starting: recommended time, iteration count and task scope.</div></div><button class="btn btn-small" data-act="refreshScope">Analyze scope</button></div></div>`;
  }
  const m = s.metrics || {};
  const e = s.estimate || {};
  return `<div class="scope-card">
    <div class="scope-head">
      <div><b>Recommended scope · ${esc(s.sizeClass)} ${esc(s.primaryLanguage)} project</b><div class="hint">${esc(s.scope?.summary || '')} <span class="badge badge-muted">${esc(s.confidence)} confidence</span></div></div>
      <div class="row"><button class="btn btn-small btn-primary" data-act="applyScope">Apply recommendation</button><button class="btn btn-small btn-ghost" data-act="refreshScope">Re-analyze</button></div>
    </div>
    <div class="scope-metrics">
      <div class="scope-metric"><div class="k">Time</div><div class="v">${Number(e.hours || 1).toFixed(1).replace(/\.0$/, '')} h</div></div>
      <div class="scope-metric"><div class="k">Iterations</div><div class="v">${num(e.maxIterations)}</div></div>
      <div class="scope-metric"><div class="k">Code lines</div><div class="v">${num(m.codeLines)}</div></div>
      <div class="scope-metric"><div class="k">Source files</div><div class="v">${num(m.sourceFiles)}</div></div>
      <div class="scope-metric"><div class="k">Tests</div><div class="v">${m.hasTests ? 'found' : 'none'}</div></div>
      <div class="scope-metric"><div class="k">Parallel developers</div><div class="v">${num(e.parallelDevelopers)}</div></div>
    </div>
    ${(s.risks || []).length ? `<ul class="risk-list">${s.risks.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : '<div class="hint" style="margin-top:8px">No major risks detected from the file layout.</div>'}
  </div>`;
}

async function loadProjectScope(force = false) {
  if (!S.project) return;
  if (!force && S.scope?.dir === S.project.dir) {
    renderScopeCard();
    return;
  }
  if (!force && S.scopeLoading && S.scopeProjectId === S.project.id) return;
  S.scopeLoading = true;
  S.scopeProjectId = S.project.id;
  renderScopeCard();
  try {
    S.scope = await api('GET', `/api/projects/${S.project.id}/scope`);
  } catch (err) {
    S.scope = { dir: S.project.dir, error: err.message };
  } finally {
    S.scopeLoading = false;
    renderScopeCard();
  }
}

function renderScopeCard() {
  const el = $('#scopeCard');
  if (el) el.innerHTML = scopeCardHtml();
}

function githubCardHtml() {
  if (!S.project) return '';
  if (S.githubLoading) return `<div class="card flat"><div class="row"><span class="spinner"></span><span class="hint">Checking the Git/GitHub state…</span></div></div>`;
  const g = S.github?.dir === S.project.dir ? S.github : null;
  if (!g) return `<div class="card flat"><div class="card-head"><h2>GitHub</h2><button class="btn btn-small" data-act="refreshGithub">Check</button></div><div class="hint">Check the repository, remote and GitHub CLI state for this project.</div></div>`;
  if (!g.isRepo) {
    return `<div class="card flat"><div class="card-head"><h2>GitHub</h2>${badge('not a Git repository', 'badge-muted')}</div>
      <div class="hint">Initialize Git first, then create a GitHub repository. Nothing is committed or pushed without your click.</div>
      <div class="row" style="margin-top:8px"><button class="btn btn-small" data-act="githubInit">Initialize Git repository</button><button class="btn btn-small btn-primary" data-act="githubCreateModal" ${g.gh?.found ? '' : 'disabled'}>Create GitHub repository</button>${g.gh?.found ? '' : '<span class="hint">Install GitHub CLI (gh) to create a repository.</span>'}</div>
    </div>`;
  }
  return `<div class="card flat"><div class="card-head"><h2>GitHub</h2><div class="row">${g.remote ? badge(g.webUrl ? 'remote connected' : 'remote set', 'badge-ok') : badge('no remote', 'badge-warn')}${g.dirty ? badge(`${g.changes} uncommitted`, 'badge-warn') : badge('clean', 'badge-ok')}<button class="btn btn-small" data-act="refreshGithub">Refresh</button></div></div>
    <div class="kv">
      <div>Branch</div><div class="mono">${esc(g.branch || '—')}</div>
      <div>Remote</div><div class="mono mono-wrap">${esc(g.remote || '—')}</div>
      <div>GitHub CLI</div><div>${g.gh?.found ? `${esc(g.gh.version || 'installed')} · ${g.gh.authenticated ? badge('signed in', 'badge-ok') : badge('not signed in', 'badge-warn')}` : 'not installed'}</div>
      ${g.repo ? `<div>Repository</div><div>${esc(g.repo.nameWithOwner || '')} · ★ ${num(g.repo.stargazerCount || 0)} · ${esc(g.repo.visibility || '')}</div>` : ''}
    </div>
    <div class="row" style="margin-top:10px">
      <button class="btn btn-small btn-primary" data-act="githubPushModal" ${g.remote ? '' : 'disabled'}>Commit &amp; push…</button>
      ${g.remote ? '' : `<button class="btn btn-small" data-act="githubCreateModal" ${g.gh?.found ? '' : 'disabled'}>Create GitHub repository…</button>`}
      ${g.webUrl ? `<a class="btn btn-small" href="${esc(g.webUrl)}" target="_blank" rel="noopener">Open on GitHub</a>` : ''}
    </div>
    <div class="hint" style="margin-top:7px">Push is explicit: it stages all files, creates a commit and pushes to origin. Review secrets and generated files first.</div>
  </div>`;
}

async function loadProjectGitHub(force = false) {
  if (!S.project) return;
  if (!force && S.github?.dir === S.project.dir) {
    renderGithubCard();
    return;
  }
  if (!force && S.githubLoading) return;
  S.githubLoading = true;
  renderGithubCard();
  try {
    S.github = await api('GET', `/api/projects/${S.project.id}/github`);
  } catch (err) {
    S.github = { dir: S.project.dir, error: err.message, isRepo: false };
  } finally {
    S.githubLoading = false;
    renderGithubCard();
  }
}

function renderGithubCard() {
  const el = $('#githubCard');
  if (el) el.innerHTML = githubCardHtml();
}

function scoutCardHtml() {
  if (!S.project) return '';
  if (S.scoutLoading && S.scoutProjectId === S.project.id) {
    return `<div class="scope-card"><div class="scope-head"><div><b>Scout agent is reading the project files…</b><div class="hint">Detecting the stack, package managers, required tools and likely test commands without calling a model.</div></div><span class="spinner"></span></div><div class="skeleton" style="height:34px;margin-top:10px"></div></div>`;
  }
  const s = S.scout?.dir === S.project.dir ? S.scout : null;
  if (s?.error) {
    return `<div class="card flat"><div class="card-head"><h2>Scout agent</h2><button class="btn btn-small" data-act="refreshScout">Retry</button></div><div class="warn-box">${esc(s.error)}</div></div>`;
  }
  if (!s) {
    return `<div class="card flat"><div class="card-head"><h2>Scout agent</h2><button class="btn btn-small" data-act="refreshScout">Detect stack</button></div><div class="hint">Reads package manifests and source files, then recommends the required toolchain and checks. No EXE path or model call needed.</div></div>`;
  }
  const primary = s.stacks?.[0];
  const missing = s.missingTools || [];
  return `<div class="scope-card">
    <div class="scope-head"><div><b>Scout agent · ${esc(primary?.label || s.primary)}</b><div class="hint">${esc(s.summary || '')} <span class="badge badge-muted">${esc(s.confidence)} confidence</span></div></div><button class="btn btn-small btn-ghost" data-act="refreshScout">Re-scan</button></div>
    <div class="row" style="gap:6px;margin-top:8px">${(s.stacks || []).slice(0, 6).map((st) => badge(st.label, st.id === primary?.id ? 'badge-ok' : 'badge-muted')).join('')}${(s.frameworks || []).slice(0, 6).map((f) => badge(f, 'badge-info')).join('')}</div>
    <div class="tool-list" style="margin-top:9px">${(s.requiredTools || []).map((t) => `<div class="tool-row" style="padding:6px 0"><div class="tool-main"><div class="row" style="gap:7px"><b>${esc(t.name)}</b>${t.installed ? badge('ready', 'badge-ok') : badge('missing', 'badge-warn')}</div><div class="hint">${esc(t.why || '')}</div></div>${t.installed ? '' : t.download ? `<a class="btn btn-small" href="${esc(t.download)}" target="_blank" rel="noopener">Install</a>` : ''}</div>`).join('') || '<div class="hint">No additional tools are required by this stack.</div>'}</div>
    ${missing.length ? `<div class="hint" style="margin-top:5px">${missing.length} recommended tool(s) missing; install them or point to them in Settings → Toolchain.</div>` : ''}
    <div style="margin-top:9px"><div class="row" style="justify-content:space-between"><b>Suggested checks</b><button class="btn btn-small" data-act="addScoutChecks" ${(s.checks || []).length ? '' : 'disabled'}>Add suggested checks</button></div>${(s.checks || []).length ? `<div class="tool-list" style="margin-top:5px">${s.checks.map((c) => `<div class="tool-row" style="padding:5px 0"><div class="tool-main"><b class="mono">${esc(c.command)}</b><div class="hint">${esc(c.why || '')}</div></div></div>`).join('')}</div>` : '<div class="hint">No check could be inferred; add one that proves the objective.</div>'}</div>
    ${(s.risks || []).length ? `<ul class="risk-list">${s.risks.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
    <details style="margin-top:8px"><summary class="hint">Evidence (${(s.evidence || []).length})</summary><div class="hint" style="margin-top:5px">${(s.evidence || []).map((e) => `<div>• ${esc(e)}</div>`).join('')}</div></details>
  </div>`;
}

async function loadProjectScout(force = false) {
  if (!S.project) return;
  if (!force && S.scout?.dir === S.project.dir) {
    renderScoutCard();
    return;
  }
  if (!force && S.scoutLoading && S.scoutProjectId === S.project.id) return;
  S.scoutLoading = true;
  S.scoutProjectId = S.project.id;
  renderScoutCard();
  try {
    S.scout = await api('GET', `/api/projects/${S.project.id}/scout`);
  } catch (err) {
    S.scout = { dir: S.project.dir, error: err.message };
  } finally {
    S.scoutLoading = false;
    renderScoutCard();
  }
}

function renderScoutCard() {
  const el = $('#scoutCard');
  if (el) el.innerHTML = scoutCardHtml();
}

function reverseProjectBanner(p) {
  const r = p.reverse || {};
  const rust = r.cargo?.available ? `cargo ${esc(r.cargo.version || '')}` : 'cargo not found — Rust checks disabled';
  return `<div class="card flat">
    <div class="card-head"><h2>Reverse &amp; Rust It</h2>${badge(r.mode === 'rust' ? 'Analyze + Rust' : 'Analyze', 'badge-info')}</div>
    <div class="kv">
      <div>Target (read-only)</div><div class="mono mono-wrap">${esc(r.targetPath || '—')}</div>
      <div>Workspace</div><div class="mono mono-wrap">${esc(p.dir)}</div>
      <div>Reconnaissance</div><div>${esc(r.files ?? 0)} files · ${esc(r.binaries ?? 0)} binary · <a href="#" data-act="openRecon" data-id="${esc(p.id)}">open recon</a></div>
      <div>Rust toolchain</div><div>${rust}${p.setup?.crate ? ` · crate <code>${esc(p.setup.crate)}</code>` : ''}</div>
    </div>
  </div>`;
}

// ------------------------------------------------------------------ RUN

function renderRun() {
  if (!S.project) return renderNeedProject();
  if (!S.run) {
    main().innerHTML = `<div class="card"><h2>No run yet</h2><p class="sub">Configure the project and start a run.</p><button class="btn btn-primary" data-act="goProject">Open project setup</button></div>`;
    return;
  }
  const r = S.run;
  main().innerHTML = `
  <div class="run-head">
    <div>
      <h1>${esc(S.project.name)}</h1>
      <div class="run-activity" id="runActivity">${r.state === 'running' ? '<span class="live-indicator"><span class="spinner"></span> live</span> ' : ''}${esc(r.activity?.message || '')}</div>
    </div>
    <div class="run-controls" id="runControls">${runControlsHtml(r)}</div>
  </div>
  <div id="runHead">${runHeadHtml(r)}</div>
  <div id="otherRuns">${otherActiveRunsHtml(r)}</div>
  <div id="runPending">${pendingHtml(r)}</div>
  <div class="card">
    <div class="tabs">
      ${runTab('conversation', 'Conversation')}${runTab('tasks', `Tasks${r.taskCounts ? ` (${Object.values(r.taskCounts).reduce((a, b) => a + b, 0)})` : ''}`)}${runTab('log', 'Log')}${runTab('details', 'Details')}
    </div>
    <div id="runBody">${runBodyHtml(r)}</div>
  </div>`;
  if (S.runTab === 'conversation') {
    chatLoad().then(chatRender).catch(() => {});
    if (['completed', 'stopped', 'failed'].includes(r.state)) $('.chat-composer')?.remove();
  }
  if (S.runTab === 'log') renderLog();
  setActiveNav('run');
}

function runTab(id, label) {
  return `<button class="tab ${S.runTab === id ? 'active' : ''}" data-act="runTab" data-tab="${id}">${esc(label)}</button>`;
}

function runHeadHtml(r) {
  const tc = r.taskCounts || {};
  const elapsed = r.elapsedActiveMs || 0;
  const remaining = r.remainingMs;
  const outTokens = (r.usage?.tokens?.output || 0) + (r.usage?.tokens?.reasoning || 0);
  const inTokens = r.usage?.tokens?.input || 0;
  const tps = elapsed > 0 && outTokens ? (outTokens / (elapsed / 1000)) : 0;
  return `<div class="stat-row stat-row-5">
    <div class="stat"><div class="k">State</div><div class="v">${r.state === 'running' ? '<span class="pulse-dot"></span>' : ''}${esc(RUN_STATE[r.state]?.[0] || r.state)}</div><div class="s">${esc(r.stopReason?.label || r.pause?.label || '')}${r.activeHarness ? ` | ${esc(r.activeHarness)}` : ''}${(r.routingSwitches || []).length ? ` | ${r.routingSwitches.length} switch(es)` : ''}</div></div>
    <div class="stat"><div class="k">Active time</div><div class="v">${fmtDur(elapsed)}</div><div class="s">${remaining != null ? `${fmtDur(remaining)} left` : 'no time limit'}</div></div>
    <div class="stat"><div class="k">Throughput</div><div class="v tok">${tps ? `<strong>${tps.toFixed(1)}</strong> tok/s` : '—'}</div><div class="s">${num(outTokens)} out · ${num(inTokens)} in tokens</div></div>
    <div class="stat"><div class="k">Iterations</div><div class="v">${num(r.iterationCount)}</div><div class="s">${r.limits?.maxIterations ? `limit ${r.limits.maxIterations}` : 'no iteration limit'}</div></div>
    <div class="stat"><div class="k">Tasks</div><div class="v">${num(tc.verified || 0)}<span class="hint"> verified</span></div><div class="s">${num(tc.implemented_unverified || 0)} built · ${num(tc.pending || 0)} pending · ${num(tc.blocked || 0)} blocked</div></div>
  </div>
  ${taskProgress(r.tasks || [])}
  ${r.pause?.message ? `<div class="warn-box"><b>${esc(r.pause.label || 'Paused')}:</b> ${esc(r.pause.message)}</div>` : ''}
  ${r.controls?.stop?.immediate ? '<div class="info-box">Stopping now…</div>' : ''}`;
}

function otherActiveRunsHtml(r) {
  const others = (S.state?.activeRuns || []).filter((x) => x.runId !== r.id);
  if (!others.length) return '';
  return `<div class="card flat" style="padding:9px 12px;margin-bottom:12px"><div class="row" style="gap:8px"><span class="hint">Also running:</span>${others.map((x) => `<button class="btn btn-small" data-act="openRunById" data-project="${esc(x.projectId)}" data-run="${esc(x.runId)}"><span class="pulse-dot"></span>${esc(x.projectName)} · ${esc(x.state)}</button>`).join('')}<span class="spacer"></span><span class="hint">${(S.state?.activeRuns || []).length} / ${S.state?.settings?.maxConcurrentRuns || 3} project runs</span></div></div>`;
}

function runControlsHtml(r) {
  const terminal = ['completed', 'stopped', 'failed'].includes(r.state);
  const running = r.state === 'running';
  const paused = r.state === 'paused' || r.state === 'waiting_user';
  return `
    ${running ? `<button class="btn btn-warn" data-act="pauseRun" data-now="0">Pause</button><button class="btn btn-warn" data-act="pauseRun" data-now="1">Pause now</button>` : ''}
    ${paused ? `<button class="btn btn-primary" data-act="resumeRun">Resume</button>` : ''}
    ${!terminal ? `<button class="btn btn-danger" data-act="stopRun" data-now="0">Stop</button><button class="btn btn-danger" data-act="stopRun" data-now="1">Stop now</button>` : ''}
    ${!terminal ? `<button class="btn btn-small" data-act="extendRun">+1 hour</button>` : ''}
    ${terminal ? `<button class="btn btn-primary" data-act="goReport">Report</button>` : ''}
    <button class="btn btn-ghost btn-small" data-act="goProject">Setup</button>`;
}

function taskProgress(tasks) {
  if (!tasks.length) return '';
  const counts = {};
  for (const t of tasks) counts[t.status] = (counts[t.status] || 0) + 1;
  const order = ['verified', 'implemented_unverified', 'in_progress', 'test_failed', 'blocked', 'waiting_user', 'pending', 'cancelled'];
  const segs = order.filter((k) => counts[k]).map((k) => `<div class="seg seg-${k}" style="flex:${counts[k]}" title="${esc(TASK_STATUS[k]?.[0] || k)}: ${counts[k]}"></div>`).join('');
  const legend = order.filter((k) => counts[k]).map((k) => `<span><i class="seg-${k}"></i>${esc(TASK_STATUS[k]?.[0] || k)} ${counts[k]}</span>`).join('');
  return `<div class="progress">${segs}</div><div class="legend">${legend}</div>`;
}

function pendingHtml(r) {
  const perms = r.pending?.permissions || [];
  const forms = r.pending?.forms || [];
  let out = '';
  if (r.pause?.code === 'plan_review') out += `<div class="pending"><h3>Review the plan</h3><div>${esc(r.tasks?.length || 0)} tasks are ready. Edit them on the Tasks tab, then approve.</div><div class="row"><button class="btn btn-primary" data-act="approvePlan">Approve plan and start</button><button class="btn" data-act="runTab" data-tab="tasks">Edit tasks</button></div></div>`;
  for (const p of perms) {
    out += `<div class="pending"><h3>Permission requested by ${esc(ROLE[p.role] || p.role || 'the agent')}</h3><div class="mono">${esc(p.action)} ${esc((p.resources || []).join(' '))}</div>${p.message ? `<div class="hint">${esc(p.message)}</div>` : ''}<div class="row"><button class="btn btn-small btn-primary" data-act="replyPermission" data-id="${esc(p.id)}" data-decision="once">Allow once</button><button class="btn btn-small" data-act="replyPermission" data-id="${esc(p.id)}" data-decision="always">Always this session</button><button class="btn btn-small btn-danger" data-act="replyPermission" data-id="${esc(p.id)}" data-decision="reject">Reject</button></div></div>`;
  }
  for (const f of forms) {
    const options = (f.fields?.[0]?.options || []).map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join('');
    out += `<div class="pending"><h3>Question from the agent</h3><div>${esc(f.title)}</div><div class="row"><input type="text" id="formAnswer-${esc(f.id)}" class="grow" placeholder="Your answer">${options ? `<select id="formSelect-${esc(f.id)}" style="max-width:220px"><option value="">Custom…</option>${options}</select>` : ''}<button class="btn btn-small btn-primary" data-act="replyForm" data-id="${esc(f.id)}">Answer</button></div></div>`;
  }
  return out;
}

function runBodyHtml(r) {
  if (S.runTab === 'conversation') return chatPanelHtml();
  if (S.runTab === 'tasks') return `<div class="row" style="justify-content:space-between"><span class="hint">Edit, cancel, reopen or add tasks. Tasks marked verified cannot be changed.</span><button class="btn btn-small" data-act="addTaskModal">Add task</button></div><div id="taskList">${taskListHtml(r)}</div>`;
  if (S.runTab === 'log') return `<div class="row" style="justify-content:space-between;margin-bottom:8px"><span class="hint">Every recorded event. Chat view is on the Conversation tab.</span><button class="btn btn-small" data-act="renderLog">Refresh</button></div><div class="log-box" id="logBox"></div>`;
  if (S.runTab === 'details') return detailsHtml(r);
  return '';
}

function taskListHtml(r) {
  if (!r.tasks?.length) return '<div class="empty">The Manager has not written a task list yet.</div>';
  return `<div class="task-list">${r.tasks.map((t) => `
    <div class="task ${esc(t.status)}">
      <div class="task-head">
        <span class="badge badge-muted">${esc(t.id)}</span>
        <span class="task-title">${esc(t.title)}</span>
        ${taskBadge(t.status)}
        <span class="hint">P${t.priority}${t.attempts ? ` · ${t.attempts} attempt(s)` : ''}${t.files?.length ? ` · ${esc(t.files.join(', '))}` : ''}</span>
        <div class="task-actions">
          ${!['verified', 'implemented_unverified', 'cancelled'].includes(t.status) ? `<button class="btn btn-small" data-act="taskAction" data-task="${esc(t.id)}" data-op="first">Do first</button>` : ''}
          ${t.status !== 'cancelled' && t.status !== 'in_progress' ? `<button class="btn btn-small" data-act="taskAction" data-task="${esc(t.id)}" data-op="cancel">Cancel</button>` : ''}
          ${['cancelled', 'blocked', 'test_failed', 'implemented_unverified'].includes(t.status) ? `<button class="btn btn-small" data-act="taskAction" data-task="${esc(t.id)}" data-op="reopen">Reopen</button>` : ''}
          <button class="btn btn-small" data-act="editTaskModal" data-task="${esc(t.id)}">Edit</button>
        </div>
      </div>
      ${t.description ? `<div class="task-desc">${esc(t.description.slice(0, 500))}</div>` : ''}
      ${t.acceptance?.length ? `<div class="task-meta"><span>Acceptance: ${esc(t.acceptance.join(' · ').slice(0, 300))}</span></div>` : ''}
      ${t.notes ? `<div class="hint">Manager: ${esc(t.notes.slice(0, 400))}</div>` : ''}
      ${t.question ? `<div class="warn-box">Needs you: ${esc(t.question)}</div>` : ''}
    </div>`).join('')}</div>`;
}

function detailsHtml(r) {
  const u = r.usage || {};
  const by = u.byRole || {};
  const roleRows = Object.entries(by).filter(([, v]) => v?.turns).map(([role, v]) => `<tr><td>${esc(ROLE[role] || role)}</td><td>${v.turns}</td><td>${num((v.tokens?.input || 0) + (v.tokens?.output || 0))}</td><td>${fmtMoney(v.cost)}</td></tr>`).join('');
  return `<div class="grid grid-2">
    <div>
      <h3>Run</h3>
      <div class="kv">
        <div>Engine</div><div>${esc(r.engine?.label || r.engine?.id || r.opencode?.source || '—')}</div>
        <div>Models</div><div class="mono">${esc(Object.entries(u.models || {}).map(([m, n]) => `${m} ×${n}`).join(', ') || '—')}</div>
        <div>Tokens</div><div>in ${num(u.tokens?.input)} · out ${num(u.tokens?.output)} · reasoning ${num(u.tokens?.reasoning)}</div>
        <div>Estimated cost</div><div>${fmtMoney(u.cost)}</div>
        <div>Iterations</div><div>${num(r.iterationCount)}</div>
        <div>Started</div><div>${fmtTime(r.startedAt)}</div>
        <div>Permissions</div><div>${esc((r.limits?.protectedPaths || []).join(', ') || 'none')}</div>
      </div>
    </div>
    <div>
      <h3>Usage by role</h3>
      <table><thead><tr><th>Role</th><th>Turns</th><th>Tokens</th><th>Cost</th></tr></thead><tbody>${roleRows || '<tr><td colspan="4" class="hint">No usage recorded yet.</td></tr>'}</tbody></table>
    </div>
  </div>
  ${r.steering?.length ? `<h3>Instructions</h3>${r.steering.map((s) => `<div class="hint">· ${esc(s.text)} ${badge(s.status, s.status === 'not_applied' ? 'badge-muted' : 'badge-ok')}</div>`).join('')}` : ''}
  ${r.settingChanges?.length ? `<h3>Changed during the run</h3>${r.settingChanges.map((c) => `<div class="hint">after iteration ${c.afterIteration}: ${esc(c.changes.join('; '))}</div>`).join('')}` : ''}`;
}

function updateRunView(r) {
  const head = $('#runHead');
  if (head) head.innerHTML = runHeadHtml(r);
  const controls = $('#runControls');
  if (controls) controls.innerHTML = runControlsHtml(r);
  const pending = $('#runPending');
  if (pending) pending.innerHTML = pendingHtml(r);
  const other = $('#otherRuns');
  if (other) other.innerHTML = otherActiveRunsHtml(r);
  const activity = $('#runActivity');
  if (activity) activity.innerHTML = `${r.state === 'running' ? '<span class="live-indicator"><span class="spinner"></span> live</span> ' : ''}${esc(r.activity?.message || '')}`;
  if (S.runTab === 'tasks') {
    const list = $('#taskList');
    if (list) list.innerHTML = taskListHtml(r);
  }
  if (S.runTab === 'details') {
    const body = $('#runBody');
    if (body) body.innerHTML = detailsHtml(r);
  }
  renderRunBadge(r);
}

function appendLogLine(e) {
  const box = $('#logBox');
  if (!box) return;
  const line = document.createElement('div');
  line.className = `log-line k-${e.kind || 'text'}`;
  const role = e.role ? `<span class="role">${esc(ROLE[e.role] || e.role)}</span>` : '';
  line.innerHTML = `<span class="t">${fmtClock(e.at)}</span>${role}${esc(e.text || e.kind || '')}`;
  box.appendChild(line);
  if (box.childElementCount > 1200) box.removeChild(box.firstElementChild);
  box.scrollTop = box.scrollHeight;
}

function renderLog() {
  const box = $('#logBox');
  if (!box) return;
  box.innerHTML = S.events.slice(-800).map((e) => `<div class="log-line k-${esc(e.kind || 'text')}"><span class="t">${fmtClock(e.at)}</span>${e.role ? `<span class="role">${esc(ROLE[e.role] || e.role)}</span>` : ''}${esc(e.text || e.kind || '')}</div>`).join('');
  box.scrollTop = box.scrollHeight;
}

// ------------------------------------------------------------------ REPORT

async function renderReport() {
  if (!S.projectId) return renderReportView();
  await loadProject(S.projectId, { keepRun: true });
  if (!S.runId) S.runId = S.runs[0]?.id || null;
  if (!S.runId) return;
  await loadRun(S.runId);
  S.stats = await api('GET', `/api/projects/${S.projectId}/stats?runId=${encodeURIComponent(S.runId)}`).catch(() => null);
  const rep = await api('GET', `/api/runs/${S.projectId}/${S.runId}/report`).catch(() => null);
  S.report = rep;
  S.reportMarkdown = rep?.markdown || null;
}

function renderReportView() {
  if (!S.project) return renderNeedProject();
  if (!S.runs?.length) {
    main().innerHTML = `<div class="card"><h2>No runs yet</h2><p class="sub">Start a run first.</p><button class="btn btn-primary" data-act="goProject">Open project setup</button></div>`;
    return;
  }
  const r = S.run;
  const st = S.stats?.project;
  main().innerHTML = `
  <div class="row" style="justify-content:space-between;align-items:flex-start">
    <div><h1>Report</h1><div class="sub">${esc(S.project.name)} · measured evidence, not model claims</div></div>
    <div class="row">
      <select id="reportRun" style="min-width:260px">${S.runs.map((x) => `<option value="${esc(x.id)}" ${x.id === S.runId ? 'selected' : ''}>${esc(x.id)} · ${esc(RUN_STATE[x.state]?.[0] || x.state)} · ${fmtTime(x.createdAt)}</option>`).join('')}</select>
      <button class="btn btn-small" data-act="switchReportRun">Open</button>
    </div>
  </div>
  ${r ? `<div class="stat-row">
    <div class="stat"><div class="k">State</div><div class="v">${esc(RUN_STATE[r.state]?.[0] || r.state)}</div><div class="s">${esc(r.stopReason?.label || '')}</div></div>
    <div class="stat"><div class="k">Source lines</div><div class="v"><span style="color:var(--ok)">+${num(r.lineStats?.net?.additions ?? 0)}</span> / <span style="color:var(--bad)">−${num(r.lineStats?.net?.deletions ?? 0)}</span></div><div class="s">${r.lineStats?.net?.files?.length ?? 0} files changed</div></div>
    <div class="stat"><div class="k">Verified tasks</div><div class="v">${num(r.taskCounts?.verified || 0)}</div><div class="s">${num(r.taskCounts?.implemented_unverified || 0)} built but not verified</div></div>
    <div class="stat"><div class="k">Tokens / cost</div><div class="v">${num((r.usage?.tokens?.input || 0) + (r.usage?.tokens?.output || 0))}</div><div class="s">estimated ${fmtMoney(r.usage?.cost)}</div></div>
  </div>` : ''}
  ${st ? `<div class="card flat"><div class="row" style="justify-content:space-between"><span class="hint">Project totals across ${num(st.runs)} run(s), ${fmtDur(st.activeMs)} active.</span><span class="hint">+${num(st.added)} / −${num(st.deleted)} lines · ${num(st.verified)} verified tasks</span></div></div>` : ''}
  <div class="card">
    <div class="card-head"><h2>Run report</h2><div class="row"><button class="btn btn-small" data-act="copyReport">Copy Markdown</button><button class="btn btn-small" data-act="renderReport">Regenerate</button></div></div>
    ${S.reportMarkdown ? `<div class="md">${markdown(S.reportMarkdown)}</div>` : '<div class="empty">No report yet. It is generated when the run ends; use Regenerate if needed.</div>'}
  </div>
  <div class="card">
    <div class="card-head"><h2>Iterations</h2><span class="hint">Every iteration has a diff, check results and a review.</span></div>
    <div class="table-wrap"><table><thead><tr><th>#</th><th>Task</th><th>Status</th><th>Lines</th><th>Checks</th><th>Review</th><th>Decision</th><th></th></tr></thead><tbody>
      ${(r?.iterations || []).map((it) => `<tr class="clickable" data-act="openIteration" data-n="${it.n}"><td>${it.n}</td><td>${esc(it.taskId || '')} ${esc(it.taskTitle || '')}</td><td>${badge(it.status || '', it.status === 'verified' ? 'badge-ok' : it.status === 'test_failed' ? 'badge-bad' : 'badge-muted')}</td><td><span style="color:var(--ok)">+${num(it.lines?.additions || 0)}</span> / <span style="color:var(--bad)">−${num(it.lines?.deletions || 0)}</span></td><td>${esc((it.checks || []).map((c) => `${c.name}: ${c.status}`).join(', ').slice(0, 120))}</td><td>${esc(it.review?.verdict || '—')}</td><td>${esc(it.decision?.decision || '—')}</td><td><button class="btn btn-small">View</button></td></tr>`).join('') || '<tr><td colspan="8" class="hint">No iterations yet.</td></tr>'}
    </tbody></table></div>
  </div>`;
  setActiveNav('report');
}

// ------------------------------------------------------------------ INSIGHTS

function renderInsightsView() {
  const a = S.analytics;
  if (!a) {
    main().innerHTML = `<h1>Insights</h1><div class="card"><div class="skeleton" style="height:120px"></div></div>`;
    return;
  }
  const t = a.totals || {};
  const maxDaily = Math.max(1, ...(a.daily || []).map((d) => d.activeMs));
  const maxProject = Math.max(1, ...(a.byProject || []).map((p) => p.activeMs));
  const maxLines = Math.max(1, ...(a.byProject || []).map((p) => p.added));
  const hours = (t.activeMs || 0) / 3600000;
  main().innerHTML = `
  <div class="row" style="justify-content:space-between;align-items:flex-start">
    <div><h1>Insights</h1><div class="sub">Measured activity across every project: active time, lines written, tokens and throughput.</div></div>
    <button class="btn btn-small" data-act="refreshInsights">Refresh</button>
  </div>
  <div class="stat-row stat-row-5">
    <div class="stat"><div class="k">Active time</div><div class="v">${hours < 10 ? hours.toFixed(1) : Math.round(hours)}<span class="hint"> h</span></div><div class="s">${fmtDur(t.activeMs || 0)} total</div></div>
    <div class="stat"><div class="k">Projects</div><div class="v">${num(t.projects)}</div><div class="s">${num(t.runs)} run(s)</div></div>
    <div class="stat"><div class="k">Source lines</div><div class="v"><span style="color:var(--ok)">+${num(t.added)}</span> <span style="color:var(--bad)">−${num(t.deleted)}</span></div><div class="s">measured snapshots</div></div>
    <div class="stat"><div class="k">Verified tasks</div><div class="v">${num(t.verified)}</div><div class="s">${num(t.unverified)} unverified · ${num(t.failed)} failed</div></div>
    <div class="stat"><div class="k">Tokens</div><div class="v">${num((t.tokens?.input || 0) + (t.tokens?.output || 0))}</div><div class="s">~$${Number(t.cost || 0).toFixed(2)} estimated</div></div>
  </div>

  <div class="grid grid-2">
    <div class="card">
      <div class="card-head"><h2>Activity — last 14 days</h2><span class="hint">active minutes per day</span></div>
      <div class="insight-bars">${(a.daily || []).map((d) => `<div class="insight-bar" style="height:${Math.max(4, Math.round((d.activeMs / maxDaily) * 100))}%" title="${esc(d.day)} · ${fmtDur(d.activeMs)} · +${num(d.added)}/−${num(d.deleted)} lines"><span>${esc(d.day.slice(5))}</span></div>`).join('')}</div>
      <div style="height:22px"></div>
    </div>
    <div class="card">
      <div class="card-head"><h2>Most active projects</h2><span class="hint">by active time</span></div>
      ${(a.top?.mostActive || []).length ? `<div class="rank-list">${a.top.mostActive.map((p) => `<div class="rank-row"><div><div class="row" style="justify-content:space-between"><b>${esc(p.name)}</b><span class="hint">${fmtDur(p.activeMs)}</span></div><div class="rank-bar"><i style="width:${Math.max(2, (p.activeMs / maxProject) * 100)}%"></i></div></div><span class="hint">+${num(p.added)} lines</span></div>`).join('')}</div>` : '<div class="empty">No runs yet.</div>'}
    </div>
  </div>

  <div class="grid grid-2">
    <div class="card">
      <div class="card-head"><h2>Projects that wrote the most</h2><span class="hint">measured source lines</span></div>
      ${(a.top?.mostLines || []).length ? `<div class="rank-list">${a.top.mostLines.map((p) => `<div class="rank-row"><div><div class="row" style="justify-content:space-between"><b>${esc(p.name)}</b><span class="hint">+${num(p.added)} / −${num(p.deleted)}</span></div><div class="rank-bar"><i style="width:${Math.max(2, (p.added / maxLines) * 100)}%"></i></div></div><span class="hint">${num(p.verified)} verified</span></div>`).join('')}</div>` : '<div class="empty">No runs yet.</div>'}
    </div>
    <div class="card">
      <div class="card-head"><h2>Engines and models</h2></div>
      ${Object.entries(a.byEngine || {}).length ? Object.entries(a.byEngine).map(([name, v]) => `<div class="row" style="justify-content:space-between;border-bottom:1px solid var(--line);padding:6px 0"><span>${esc(name)}</span><span class="hint">${num(v.runs)} run(s) · ${fmtDur(v.activeMs)} · ${num(v.tokens)} tokens</span></div>`).join('') : '<div class="empty">No engines used yet.</div>'}
      ${Object.keys(a.byModel || {}).length ? `<div class="hint" style="margin-top:8px">Models: ${Object.entries(a.byModel).slice(0, 8).map(([m, v]) => `${esc(m)} (${v.turns})`).join(' · ')}</div>` : ''}
    </div>
  </div>

  <div class="card">
    <div class="card-head"><h2>Recent runs</h2><span class="hint">${(a.recent || []).length} shown</span></div>
    <div class="table-wrap"><table><thead><tr><th>When</th><th>Project</th><th>Engine</th><th>State</th><th>Active</th><th>Lines</th><th>Verified</th></tr></thead><tbody>
      ${(a.recent || []).map((r) => `<tr class="clickable" data-act="openRunById" data-project="${esc(r.projectId)}" data-run="${esc(r.runId)}"><td>${fmtTime(r.at)}</td><td>${esc(r.projectName)}</td><td>${esc(r.engine || '')}</td><td>${badge(r.state, r.state === 'completed' ? 'badge-ok' : r.state === 'failed' ? 'badge-bad' : 'badge-muted')}</td><td>${fmtDur(r.activeMs)}</td><td><span style="color:var(--ok)">+${num(r.added)}</span>/<span style="color:var(--bad)">−${num(r.deleted)}</span></td><td>${num(r.verified)}</td></tr>`).join('') || '<tr><td colspan="7" class="hint">No runs yet.</td></tr>'}
    </tbody></table></div>
  </div>`;
  setActiveNav('insights');
}

// ------------------------------------------------------------------ REVERSE

async function renderReverse() {
  if (!S.reverseInfo) S.reverseInfo = await api('GET', '/api/reverse/info').catch(() => null);
  S.state = S.state || {};
  S.tools = S.tools || (await api('GET', '/api/tools').catch(() => null));
}

function renderReverseView() {
  const info = S.reverseInfo || { modes: [], rust: null, engines: null };
  const rust = info.rust;
  const reverseProjects = (S.state?.projects || []).filter((p) => p.kind?.startsWith('reverse'));
  main().innerHTML = `
  <div class="hero">
    <div>
      <h1>Sleep &amp; Reverse &amp; Rust It</h1>
      <p>Point SleepPilot at a program. It builds a read-only mirror, performs binary and text reconnaissance, writes a cited technical dossier, turns it into an implementation-ready specification, then rebuilds the behaviour as a Rust application — with cargo check and cargo test as the evidence.</p>
      <div class="row"><span class="hint">The target is never modified. All output goes to a separate workspace.</span></div>
    </div>
    <div class="hero-side">
      <div class="hero-stat"><span>Rust toolchain</span><b>${rust?.cargo ? esc(rust.cargo.version || 'installed') : 'not found'}</b></div>
      <div class="hero-stat"><span>Reconnaissance</span><b>PE / ELF / Mach-O / ZIP / text</b></div>
      <div class="hero-stat"><span>Output</span><b>Docs + Cargo project</b></div>
    </div>
  </div>

  <div class="grid grid-2">
    <div class="card">
      <div class="card-head"><h2>New Reverse &amp; Rust workspace</h2><span class="hint">Mode: ${esc(S.reverseMode === 'rust' ? 'Analyze + Rust' : 'Analyze')}</span></div>
      <label>Target file or folder (read-only)</label>
      <div class="row"><input type="text" id="rvTarget" class="grow" placeholder="C:\\path\\to\\program.exe or folder"><button class="btn" data-act="pickDir" data-for="rvTarget">Browse folder…</button></div>
      <div class="hint">A single binary can be typed directly; the folder picker only selects directories.</div>
      <label>Workspace folder (analysis + Rust project)</label>
      <div class="row"><input type="text" id="rvWork" class="grow" placeholder="C:\\work\\program-reverse"><button class="btn" data-act="pickDir" data-for="rvWork">Browse…</button></div>
      <label>What do you want to understand or rebuild?</label>
      <textarea id="rvGoal" rows="4" placeholder="e.g. Understand the save-file format and the economy rules, then rebuild a compatible editor in Rust."></textarea>
      <div class="grid grid-3">
        <div><label>Mode</label><select id="rvMode"><option value="rust" ${S.reverseMode === 'rust' ? 'selected' : ''}>Analyze + Rust It (recommended)</option><option value="analyze" ${S.reverseMode === 'analyze' ? 'selected' : ''}>Analyze and document only</option></select></div>
        <div><label>Engine</label><select id="rvEngine">${engines().map((e) => `<option value="${esc(e.id)}" ${e.id === defaultEngineId() ? 'selected' : ''}>${esc(e.label)}</option>`).join('')}</select></div>
        <div><label>Time limit (hours)</label><input type="number" id="rvHours" min="0.25" step="0.25" value="8"></div>
      </div>
      <label class="check"><input type="checkbox" id="rvUnattended" checked> Start unattended (full autonomy, no questions)</label>
      <label class="check"><input type="checkbox" id="rvAck"> I confirm that I have the right to analyse this target and that I am responsible for how I use the results.</label>
      <div class="row" style="margin-top:10px"><button class="btn btn-primary" data-act="createReverse">Prepare workspace</button><button class="btn" data-act="previewReverseScope">Analyze target scope</button><span class="hint">Mirroring and reconnaissance can take a minute on large targets.</span></div>
    </div>
    <div class="card">
      <div class="card-head"><h2>What gets created</h2></div>
      <div class="kv">
        <div><code>_target/</code></div><div>Byte-faithful text mirror with original line numbers; protected from edits.</div>
        <div><code>_recon/RECON.md</code></div><div>Inventory, PE/ELF headers, imports/exports, sections, strings, local tools.</div>
        <div><code>_recon/recon.json</code></div><div>Structured facts with offsets and hashes for binary evidence.</div>
        <div><code>SPEC.md</code></div><div>Implementation-ready specification with test vectors.</div>
        <div><code>Cargo.toml</code></div><div>Rust crate scaffolded from scratch; lib, CLI and acceptance tests.</div>
        <div><code>cargo check/test</code></div><div>Run after every task; only passing evidence verifies a task.</div>
      </div>
      ${!rust?.cargo ? `<div class="warn-box">Rust is not installed, so the Rust checks are disabled. Install it from <a href="https://rustup.rs/" target="_blank" rel="noopener">rustup.rs</a> and reopen this project to enable them.</div>` : ''}
      <div class="row" style="margin-top:12px"><button class="btn" data-act="rustFromScratch">New Rust app from scratch</button><span class="hint">No target; just a Cargo scaffold and an objective.</span></div>
    </div>
  </div>

  <div id="reversePreview">${reversePreviewHtml()}</div>

  <div class="card">
    <div class="card-head"><h2>Reverse &amp; Rust workspaces</h2><span class="hint">${reverseProjects.length} saved</span></div>
    ${reverseProjects.length ? reverseProjects.map((p) => `
      <div class="project-row">
        <div class="project-main">
          <div class="project-name">${esc(p.name)} ${badge(p.reverse?.mode === 'rust' ? 'Analyze + Rust' : 'Analyze', 'badge-info')}</div>
          <div class="project-dir mono">${esc(p.reverse?.targetDir || '')} → ${esc(p.dir)}</div>
          <div class="hint">${esc((p.objective?.text || '').slice(0, 160))}</div>
        </div>
        <button class="btn btn-small" data-act="openProject" data-id="${esc(p.id)}">Open</button>
      </div>`).join('') : '<div class="empty">No reverse workspaces yet.</div>'}
  </div>`;
  setActiveNav('reverse');
}

// ------------------------------------------------------------------ SETTINGS

async function renderSettings() {
  // Render immediately so the page never looks frozen while toolchain probing runs.
  renderSettingsView();
  const [tools, reverse, ollama] = await Promise.all([
    api('GET', '/api/tools').catch(() => null),
    S.reverseInfo ? Promise.resolve(S.reverseInfo) : api('GET', '/api/reverse/info').catch(() => null),
    api('GET', '/api/ollama').catch(() => null),
  ]);
  S.tools = tools || S.tools;
  S.reverseInfo = reverse || S.reverseInfo;
  S.ollama = ollama;
  if (S.view === 'settings' && (S.settingsTab === 'tools' || S.settingsTab === 'local')) renderSettingsView();
}

function renderSettingsView() {
  const tabs = { engines: 'Engines', providers: 'API providers', local: 'Local AI', tools: 'Toolchain', phone: 'Phone', app: 'App' };
  main().innerHTML = `
  <h1>Settings</h1>
  <div class="sub">Local configuration. API keys are stored in a separate credentials file and never shown again.</div>
  <div class="tabs">${Object.entries(tabs).map(([k, v]) => `<button class="tab ${S.settingsTab === k ? 'active' : ''}" data-act="settingsTab" data-tab="${k}">${v}</button>`).join('')}</div>
  <div id="settingsBody">${settingsBodyHtml()}</div>`;
  setActiveNav('settings');
  if (S.settingsTab === 'phone' && !S.state?.viewer?.phone) loadPhonePanel();
}

// ------------------------------------------------------------------ phone access

async function loadPhonePanel(view = null) {
  const box = $('#phonePanel');
  if (!box) return;
  try {
    S.phone = view || (await api('GET', '/api/phone'));
  } catch (err) {
    box.innerHTML = `<div class="hint">${esc(err.message)}</div>`;
    return;
  }
  box.innerHTML = phonePanelHtml(S.phone);
}

function phoneSettingsHtml() {
  if (S.state?.viewer?.phone) {
    return `<div class="card flat"><div class="card-head"><h2>Phone</h2></div><p>You are using SleepPilot from your phone. Phone access is turned on, off or reset on the PC.</p></div>`;
  }
  return `<div class="card flat"><div class="card-head"><h2>Control SleepPilot from your phone</h2></div><div id="phonePanel"><div class="skeleton" style="height:120px"></div></div></div>`;
}

function phonePanelHtml(p) {
  const steps = `<ol class="phone-steps">
      <li>Install <b>Tailscale</b> on this PC and on your phone (free, <span class="mono">tailscale.com</span>) and sign in with the same account on both.</li>
      <li>Turn on phone access below. If Windows asks whether Node.js may use the network, allow it.</li>
      <li>Scan the QR code with the phone camera and add the page to the home screen.</li>
    </ol>`;
  const privacy = `<div class="hint" style="margin-top:10px">Only your own Tailscale devices can reach SleepPilot; it is never open to the internet or the Wi-Fi. The phone can watch and control runs and projects, but cannot see API keys, close the app or change phone access.</div>`;
  if (!p.enabled) {
    return `${steps}<div class="row" style="margin-top:12px"><button class="btn btn-primary" data-act="phoneEnable">Turn on phone access</button></div>${privacy}`;
  }
  let status = '';
  if (p.listening) status = `<span class="badge badge-ok">On</span> <span class="hint">Listening on <span class="mono">${esc(p.bookmark)}</span></span>`;
  else if (p.error === 'no-tailscale') status = `<span class="badge badge-warn">Waiting for Tailscale</span> <span class="hint">Tailscale is not running on this PC, or not signed in. SleepPilot checks again every minute.</span>`;
  else if (p.error === 'port-in-use') status = `<span class="badge badge-bad">Port busy</span> <span class="hint">Port ${esc(p.port)} is used by another program.</span>`;
  else status = `<span class="badge badge-warn">Not listening</span> <span class="hint">${esc(p.error || 'Starting…')}</span>`;
  const qr = p.qr
    ? `<div class="phone-qr-wrap"><div class="phone-qr">${p.qr}</div><div><p><b>Scan with your phone camera.</b> The phone stays signed in; this QR code is the key, so do not share a photo of it.</p>
        <div class="row"><button class="btn btn-small" data-act="phoneCopyLink">Copy link</button><button class="btn btn-small btn-ghost" data-act="phoneReset">Sign out all phones (new QR code)</button></div></div></div>`
    : '';
  return `<div class="row" style="gap:8px;margin-bottom:10px">${status}</div>${qr}${p.listening ? '' : steps}
    <div class="row" style="margin-top:12px"><button class="btn btn-small" data-act="phoneRefresh">Check again</button><button class="btn btn-small btn-ghost" data-act="phoneDisable">Turn off phone access</button></div>${privacy}`;
}

function settingsBodyHtml() {
  if (S.settingsTab === 'providers') return providersSettingsHtml();
  if (S.settingsTab === 'local') return localAiSettingsHtml();
  if (S.settingsTab === 'tools') return toolsSettingsHtml();
  if (S.settingsTab === 'phone') return phoneSettingsHtml();
  if (S.settingsTab === 'app') return appSettingsHtml();
  return enginesSettingsHtml();
}

function enginesSettingsHtml() {
  const list = engines();
  return `<div class="grid grid-2">${list.map((e) => `
    <div class="engine-card ${e.id === defaultEngineId() ? 'selected' : ''}">
      <div class="engine-head">
        <span class="engine-name">${esc(e.label)}</span>
        ${engineStatusBadge(e)}
        ${e.id === defaultEngineId() ? badge('default', 'badge-info') : ''}
        <span class="spacer"></span>
        <button class="btn btn-small" data-act="connectEngine" data-id="${esc(e.id)}">Test / connect</button>
        ${e.id !== defaultEngineId() ? `<button class="btn btn-small" data-act="setDefaultEngine" data-id="${esc(e.id)}">Make default</button>` : ''}
      </div>
      <div class="hint" style="margin-top:6px">${esc(e.status?.message || '')}</div>
      <div class="kv" style="margin-top:8px">
        <div>Detected</div><div class="mono">${esc(e.detection?.path || e.detection?.source || '—')}</div>
        <div>Version</div><div>${esc(e.version || '—')}</div>
        <div>Models</div><div>${e.models?.length ? `${e.models.length} available` : 'none — connect to load'}</div>
        <div>Capabilities</div><div>${esc(Object.entries(e.capabilities || {}).filter(([, v]) => v).map(([k]) => k).join(', ') || '—')}</div>
      </div>
      ${engineSpecificHtml(e)}
    </div>`).join('')}</div>
    <div class="card flat" style="margin-top:14px">
      <div class="card-head"><h2>Default engine</h2></div>
      <div class="row"><select id="setDefaultEngine">${list.map((e) => `<option value="${esc(e.id)}" ${e.id === defaultEngineId() ? 'selected' : ''}>${esc(e.label)}</option>`).join('')}</select><button class="btn" data-act="saveDefaultEngine">Save default</button></div>
      <div class="hint">A project can choose its own engine; this is the default for new projects.</div>
    </div>`;
}

function engineSpecificHtml(e) {
  if (e.id === 'opencode') {
    return `<div class="row" style="margin-top:10px"><input type="text" id="setOpencodePath" class="grow" value="${esc(S.state.settings?.opencodePath || '')}" placeholder="Path to opencode executable (empty = auto-detect)"><button class="btn btn-small" data-act="saveEngineSettings">Save path</button></div>`;
  }
  if (e.id === 'api') {
    const providers = S.state.engines?.providers || [];
    return `<div class="row" style="margin-top:10px"><button class="btn btn-small" data-act="settingsTab" data-tab="providers">Manage ${providers.length} provider(s)</button><span class="hint">${providers.filter((p) => p.hasKey).length} with a key</span></div>`;
  }
  if (e.id === 'claude') {
    const c = S.state.settings?.claude || {};
    return `<div class="grid grid-2" style="margin-top:10px">
      <div><label>CLI path (empty = auto-detect)</label><input type="text" id="setClaudePath" value="${esc(c.cliPath || '')}" placeholder="claude.cmd"></div>
      <div><label>Model (empty = Claude default)</label><input type="text" id="setClaudeModel" value="${esc(c.model || '')}" placeholder="sonnet / opus / haiku"></div>
      <div><label>Permission mode</label><select id="setClaudePermission">${['auto','acceptEdits','plan','bypassPermissions','manual','dontAsk'].map((m) => `<option value="${m}" ${c.permissionMode === m ? 'selected' : ''}>${m}${m === 'auto' ? ' (SleepPilot decides)' : ''}</option>`).join('')}</select></div>
      <div><label>Timeout (min)</label><input type="number" id="setClaudeTimeout" value="${c.timeoutMin || 720}"></div>
    </div>
    <div class="row" style="margin-top:8px"><button class="btn btn-small" data-act="saveEngineSettings">Save Claude settings</button><span class="hint">Sign in once in a terminal with <code>claude auth login</code>; SleepPilot uses that login.</span></div>`;
  }
  if (e.id === 'codex') {
    const c = S.state.settings?.codex || {};
    return `<div class="grid grid-2" style="margin-top:10px">
      <div><label>CLI path (empty = auto-detect)</label><input type="text" id="setCodexPath" value="${esc(c.cliPath || '')}" placeholder="codex.cmd"></div>
      <div><label>Model (empty = Codex default)</label><input type="text" id="setCodexModel" value="${esc(c.model || '')}" placeholder="gpt-5-codex"></div>
      <div><label>Sandbox</label><select id="setCodexSandbox">${['workspace-write','read-only','danger-full-access'].map((m) => `<option value="${m}" ${c.sandbox === m ? 'selected' : ''}>${m}</option>`).join('')}</select></div>
      <div><label>Timeout (min)</label><input type="number" id="setCodexTimeout" value="${c.timeoutMin || 720}"></div>
    </div>
    <div class="row" style="margin-top:8px"><button class="btn btn-small" data-act="saveEngineSettings">Save Codex settings</button><span class="hint">Sign in once with <code>codex login</code>; SleepPilot uses that login.</span></div>`;
  }
  if (e.id === 'dsh') {
    const d = S.state.settings?.dsh || {};
    return `<div class="grid grid-2" style="margin-top:10px">
      <div><label>CLI path (empty = auto-detect)</label><input type="text" id="setDshPath" value="${esc(d.cliPath || '')}" placeholder="C:\\...\\dsh.cmd"></div>
      <div><label>Profile</label><input type="text" id="setDshProfile" value="${esc(d.profile || 'headless')}"></div>
      <div><label>Approval policy</label><select id="setDshApproval"><option value="never" ${d.approvalPolicy !== 'ask' ? 'selected' : ''}>never (unattended)</option><option value="ask" ${d.approvalPolicy === 'ask' ? 'selected' : ''}>ask</option></select></div>
      <div><label>Permission mode (optional)</label><input type="text" id="setDshPermission" value="${esc(d.permissionMode || '')}" placeholder="workspace-write"></div>
    </div>
    <div class="row" style="margin-top:8px"><button class="btn btn-small" data-act="saveEngineSettings">Save DSH settings</button></div>
    <label>DEEPSEEK_API_KEY (stored encrypted by the OS file permissions; used by the dsh process)</label>
    <div class="row"><input type="password" id="setDshKey" class="grow" placeholder="${S.state.engines?.dshEnvKeys?.includes('DEEPSEEK_API_KEY') ? 'stored — enter a new value to replace' : 'not set'}"><button class="btn btn-small" data-act="saveDshKey">Save key</button></div>`;
  }
  if (e.id === 'cli') {
    const c = S.state.settings?.cli || {};
    return `<div style="margin-top:10px">
      <label>Command</label><input type="text" id="setCliCommand" value="${esc(c.command || '')}" placeholder="claude">
      <label>Arguments (space separated; {prompt} {project} {model} placeholders)</label><input type="text" id="setCliArgs" value="${esc((c.args || []).join(' '))}" placeholder="-p {prompt}">
      <div class="grid grid-2"><div><label>Prompt via</label><select id="setCliPromptVia"><option value="stdin" ${c.promptVia !== 'arg' ? 'selected' : ''}>stdin</option><option value="arg" ${c.promptVia === 'arg' ? 'selected' : ''}>argument</option></select></div><div><label>Timeout (min)</label><input type="number" id="setCliTimeout" value="${c.timeoutMin || 720}"></div></div>
      <div class="row" style="margin-top:8px"><button class="btn btn-small" data-act="saveEngineSettings">Save command harness</button></div>
    </div>`;
  }
  return '';
}

function providersSettingsHtml() {
  const list = S.state.engines?.providers || [];
  const presets = S.state.engines?.providerPresets || [];
  return `<div class="card flat">
    <div class="card-head"><h2>Providers</h2><div class="row">
      <select id="newProviderPreset" style="min-width:220px">${presets.map((p) => `<option value="${esc(p.id)}">${esc(p.label)}</option>`).join('')}</select>
      <button class="btn btn-small" data-act="addProvider">Add provider</button>
    </div></div>
    <div class="hint">Keys are read from the stored credential or the provider's environment variable. Local providers (Ollama, LM Studio) need no key.</div>
    ${list.map((p) => `
      <div class="provider-card" data-provider-card="${esc(p.id)}" data-provider-preset="${esc(p.preset || 'custom')}" data-provider-requires="${p.requiresKey ? 'true' : 'false'}">
        <div class="provider-head">
          <b>${esc(p.label)}</b><span class="badge badge-muted">${esc(p.protocol)}</span><span class="badge ${p.hasKey ? 'badge-ok' : p.requiresKey ? 'badge-warn' : 'badge-muted'}">${p.hasKey ? 'key stored' : p.requiresKey ? 'no key' : 'no key needed'}</span>
          <span class="spacer"></span>
          <button class="btn btn-small btn-danger" data-act="removeProvider" data-id="${esc(p.id)}">Remove</button>
        </div>
        <div class="provider-grid">
          <div><label>Label</label><input type="text" data-p="label" value="${esc(p.label)}"></div>
          <div><label>Protocol</label><select data-p="protocol"><option value="openai" ${p.protocol === 'openai' ? 'selected' : ''}>OpenAI-compatible</option><option value="anthropic" ${p.protocol === 'anthropic' ? 'selected' : ''}>Anthropic</option></select></div>
          <div><label>Base URL</label><input type="text" data-p="baseUrl" value="${esc(p.baseUrl)}" placeholder="https://api.example.com/v1"></div>
          <div><label>API key environment variable</label><input type="text" data-p="apiKeyEnv" value="${esc(p.apiKeyEnv || '')}" placeholder="DEEPSEEK_API_KEY"></div>
          <div><label>Models (comma separated)</label><input type="text" data-p="models" value="${esc((p.models || []).map((m) => m.id).join(', '))}" placeholder="deepseek-chat, deepseek-reasoner"></div>
          <div><label>Max output tokens</label><input type="number" data-p="maxOutputTokens" value="${p.maxOutputTokens || 8192}"></div>
        </div>
        <label class="check" style="margin-top:4px"><input type="checkbox" data-p="enabled" ${p.enabled ? 'checked' : ''}> Enabled</label>
        <div class="row" style="margin-top:8px">
          <input type="password" class="grow" id="key-${esc(p.id)}" placeholder="${p.hasKey ? 'Key stored — enter a new value to replace' : 'Paste API key'}">
          <button class="btn btn-small" data-act="saveProviderKey" data-id="${esc(p.id)}">Save key</button>
          <button class="btn btn-small" data-act="saveProvider" data-id="${esc(p.id)}">Save provider</button>
        </div>
      </div>`).join('') || '<div class="empty">No providers. Add one above.</div>'}
  </div>`;
}

const TOOL_STATUS = {
  ok: ['installed', 'badge-ok'],
  warn: ['check', 'badge-warn'],
  bad: ['problem', 'badge-bad'],
  missing: ['missing', 'badge-bad'],
  'optional-missing': ['optional · not found', 'badge-muted'],
  unknown: ['not detected', 'badge-muted'],
  manual: ['manual', 'badge-info'],
  ignored: ['ignored', 'badge-muted'],
};

function toolStatusBadge(t) {
  const [label, cls] = TOOL_STATUS[t.status] || [t.status, 'badge-muted'];
  return badge(`${label}${t.version ? ` ${t.version}` : ''}${t.overridden ? ' · manual' : ''}`, cls);
}

function scoutPanelHtml() {
  return `<div class="card flat">
    <div class="card-head"><h2>Scout agent — detect from files</h2><span class="hint">no EXE picker, no model call</span></div>
    <div class="hint" style="margin-bottom:9px">Point at a project folder to infer the stack and required tools, or at a program file/folder to identify its runtime (PE/ELF/Mach-O headers, imports, strings).</div>
    <div class="grid grid-2">
      <div><label>Project folder</label><div class="row"><input type="text" id="scoutFolder" class="grow" placeholder="C:\\work\\app" value="${esc(S.toolScout?.kind === 'project' ? S.toolScout.dir || '' : '')}"><button class="btn btn-small" data-act="scoutToolFolder">Detect stack</button></div></div>
      <div><label>Program file or folder</label><div class="row"><input type="text" id="scoutProgram" class="grow" placeholder="C:\\games\\app.exe" value="${esc(S.toolScout?.kind === 'target' ? S.toolScout.targetPath || '' : '')}"><button class="btn btn-small" data-act="scoutToolProgram">Detect runtime</button></div></div>
    </div>
    <div id="toolScoutResult">${toolScoutResultHtml()}</div>
  </div>`;
}

function toolScoutResultHtml() {
  if (S.toolScoutLoading) return `<div class="row" style="margin-top:12px"><span class="spinner"></span><span class="hint">Scout is reading the files…</span></div><div class="skeleton" style="height:40px;margin-top:8px"></div>`;
  const s = S.toolScout;
  if (!s) return '';
  if (s.error) return `<div class="warn-box" style="margin-top:10px">${esc(s.error)}</div>`;
  const isTarget = s.kind === 'target';
  return `<div class="scope-card" style="margin:12px 0 0">
    <div class="scope-head"><div><b>${isTarget ? 'Program' : 'Project'} scout · ${esc(isTarget ? s.runtime : s.stacks?.[0]?.label || s.primary)}</b><div class="hint">${esc(s.summary || '')} <span class="badge badge-muted">${esc(s.confidence)} confidence</span></div></div></div>
    ${isTarget ? `<div class="scope-metrics"><div class="scope-metric"><div class="k">Format</div><div class="v">${esc(s.format || '—')}</div></div><div class="scope-metric"><div class="k">Architecture</div><div class="v">${esc(s.arch || '—')}</div></div><div class="scope-metric"><div class="k">Mode</div><div class="v">${esc(s.recommendedMode || '—')}</div></div><div class="scope-metric"><div class="k">Programs</div><div class="v">${num((s.programs || []).length)}</div></div></div>` : `<div class="row" style="gap:6px;margin-top:8px">${(s.stacks || []).slice(0, 6).map((st) => badge(st.label, 'badge-info')).join('')}</div>`}
    <h3 style="margin-top:12px">Required tools</h3>
    <div class="tool-list">${(s.requiredTools || []).map((t) => `<div class="tool-row" style="padding:5px 0"><div class="tool-main"><div class="row" style="gap:7px"><b>${esc(t.name)}</b>${t.installed ? badge('ready', 'badge-ok') : badge('missing', 'badge-warn')}</div>${t.path ? `<div class="hint">${esc(t.path)}</div>` : ''}</div>${t.installed ? '' : t.download ? `<a class="btn btn-small" href="${esc(t.download)}" target="_blank" rel="noopener">Install</a>` : ''}</div>`).join('') || '<div class="hint">No tools inferred.</div>'}</div>
    ${(s.checks || []).length ? `<h3 style="margin-top:12px">Suggested checks</h3><div class="tool-list">${s.checks.map((c) => `<div class="tool-row" style="padding:5px 0"><div class="tool-main"><b class="mono">${esc(c.command)}</b><div class="hint">${esc(c.why)}</div></div></div>`).join('')}</div>` : ''}
    ${isTarget && (s.notes || []).length ? `<ul class="risk-list">${s.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
    ${(s.risks || []).length ? `<ul class="risk-list">${s.risks.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
    ${!isTarget && S.project && s.dir && S.project.dir && s.dir.toLowerCase() === S.project.dir.toLowerCase() && (s.checks || []).length ? `<div class="row" style="margin-top:9px"><button class="btn btn-small" data-act="addScoutChecks">Add suggested checks to ${esc(S.project.name)}</button></div>` : ''}
  </div>`;
}

function renderToolScout() {
  const el = $('#toolScoutResult');
  if (el) el.innerHTML = toolScoutResultHtml();
}

function toolsSettingsHtml() {
  const scoutPanel = scoutPanelHtml();
  if (!S.tools) {
    return `${scoutPanel}<div class="card flat"><div class="card-head"><h2>Toolchain</h2><span class="live-indicator"><span class="spinner"></span> scanning</span></div><div class="hint">Checking PATH and common install locations for compilers, engines and reverse-engineering tools…</div><div class="skeleton" style="height:110px;margin-top:12px"></div></div>`;
  }
  const tools = S.tools?.tools || [];
  const rust = S.reverseInfo?.rust;
  const cat = S.tools?.categories || [];
  const overrides = S.state?.settings?.toolOverrides || {};
  return `${scoutPanel}<div class="card flat">
    <div class="card-head"><h2>Toolchain</h2><div class="row"><span class="hint">${S.tools?.checkedAt ? `checked ${fmtClock(S.tools.checkedAt)}` : ''}</span><button class="btn btn-small" data-act="copyToolDiagnostics">Copy diagnostics</button><button class="btn btn-small" data-act="refreshTools">Refresh</button></div></div>
    <div class="row" style="margin-bottom:10px">
      <span class="badge ${rust?.cargo ? 'badge-ok' : 'badge-bad'}">Rust ${rust?.cargo ? 'installed' : 'missing'}</span>
      <span class="hint">${rust?.cargo ? esc(rust.cargo.version) : 'Install from rustup.rs to enable cargo check/test.'}</span>
    </div>
    <div class="hint" style="margin-bottom:10px">Automatic detection checks PATH and common install locations. If a tool is installed somewhere unusual, use <b>Set status/path</b> to mark it manually; every row keeps its detection attempts under “Why?”.</div>
    ${cat.map((c) => {
      const rows = tools.filter((t) => t.category === c.id);
      if (!rows.length) return '';
      return `<h3>${esc(c.label)}</h3>${rows.map((t) => {
        const attempts = (t.attempts || []).slice(0, 12);
        const hasOverride = !!overrides[t.id] || t.overridden;
        return `<div class="tool-row">
          <div class="tool-main">
            <div class="row" style="gap:7px"><b>${esc(t.name)}</b> ${toolStatusBadge(t)} ${t.overridden ? badge('manual override', 'badge-info') : ''}</div>
            <div class="hint">${esc(t.why)}</div>
            ${t.detail ? `<div class="hint mono mono-wrap">${esc(t.detail)}</div>` : ''}
            ${t.ollama ? ollamaToolSummary(t.ollama) : ''}
            ${attempts.length ? `<details class="hint"><summary>Why? ${attempts.length} attempt(s)</summary><div class="mono" style="max-height:160px;overflow:auto;margin-top:5px">${attempts.map((a) => `${a.ok ? '✓' : '✗'} ${esc(a.file)}${a.error ? ` — ${esc(a.error)}` : ''}${a.version ? ` — ${esc(a.version)}` : ''}`).join('<br>')}</div></details>` : ''}
          </div>
          <div class="tool-actions">
            <button class="btn btn-small" data-act="toolOverride" data-id="${esc(t.id)}">Set status/path</button>
            ${hasOverride ? `<button class="btn btn-small btn-ghost" data-act="clearToolOverride" data-id="${esc(t.id)}">Use auto</button>` : ''}
            ${t.download ? `<a class="btn btn-small" href="${esc(t.download)}" target="_blank" rel="noopener">Download</a>` : ''}
          </div>
        </div>`;
      }).join('')}`;
    }).join('')}
  </div>`;
}

function ollamaToolSummary(o) {
  if (!o) return '';
  if (!o.running) return '';
  return `<div class="hint">${o.models?.length ? `Models: ${o.models.slice(0, 8).map((m) => `<code>${esc(m.name)}</code>`).join(', ')}` : 'Running, but no models are pulled yet.'}</div>`;
}

function reversePreviewHtml() {
  if (S.reverseScopeLoading) {
    return `<div class="scope-card"><div class="scope-head"><div><b>Analyzing the target…</b><div class="hint">Counting files and binary formats to recommend a realistic time limit and scope.</div></div><span class="spinner"></span></div><div class="skeleton" style="height:38px;margin-top:10px"></div></div>`;
  }
  const s = S.reverseScope;
  if (!s) return '';
  const m = s.metrics || {};
  const e = s.estimate || {};
  return `<div class="scope-card">
    <div class="scope-head"><div><b>Target scope · ${esc(s.sizeClass)} · ${esc(s.mode === 'rust' ? 'Analyze + Rust' : 'Analyze')}</b><div class="hint">${esc(s.scope?.summary || '')}</div></div><button class="btn btn-small btn-primary" data-act="applyReverseScope">Apply recommendation</button></div>
    <div class="scope-metrics">
      <div class="scope-metric"><div class="k">Time</div><div class="v">${Number(e.hours || 1).toFixed(1).replace(/\.0$/, '')} h</div></div>
      <div class="scope-metric"><div class="k">Recon</div><div class="v">${num(e.reconMinutes)} min</div></div>
      <div class="scope-metric"><div class="k">Files</div><div class="v">${num(m.files)}</div></div>
      <div class="scope-metric"><div class="k">Text / binary</div><div class="v">${num(m.textFiles)} / ${num(m.binaryFiles)}</div></div>
      <div class="scope-metric"><div class="k">Size</div><div class="v">${m.bytes ? (m.bytes >= 1073741824 ? `${(m.bytes / 1073741824).toFixed(1)} GB` : `${Math.round(m.bytes / 1048576)} MB`) : '—'}</div></div>
    </div>
    ${S.targetScout ? `<div style="margin-top:10px"><div class="row" style="gap:7px;flex-wrap:wrap"><b>Detected runtime:</b> ${badge(S.targetScout.runtime, 'badge-info')} ${S.targetScout.format ? badge(S.targetScout.format, 'badge-muted') : ''} ${S.targetScout.arch ? badge(S.targetScout.arch, 'badge-muted') : ''}</div><div class="row" style="gap:6px;flex-wrap:wrap;margin-top:6px">${(S.targetScout.requiredTools || []).map((t) => `<span class="tool-chip">${esc(t.name)} ${t.installed ? badge('ready', 'badge-ok') : badge('missing', 'badge-warn')}</span>`).join('')}</div>${(S.targetScout.notes || []).length ? `<ul class="risk-list">${S.targetScout.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}</div>` : ''}
    ${(s.risks || []).length ? `<ul class="risk-list">${s.risks.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
  </div>`;
}

function localAiSettingsHtml() {
  const o = S.ollama;
  const configured = S.state?.settings?.ollama?.baseUrl || 'http://127.0.0.1:11434';
  const provider = o?.provider;
  const running = !!o?.running;
  const installed = !!o?.installed;
  const models = o?.models || [];
  const status = running ? badge('running', 'badge-ok') : installed ? badge('installed · not running', 'badge-warn') : badge('not detected', 'badge-bad');
  return `<div class="card flat">
    <div class="card-head"><h2>Local AI — Ollama</h2><div class="row">${status}${o?.version ? `<span class="hint">v${esc(o.version)}</span>` : ''}<button class="btn btn-small" data-act="refreshOllama">Refresh</button></div></div>
    <p class="hint">Ollama runs models entirely on this machine. SleepPilot talks to its OpenAI-compatible endpoint, so a local model can be used with the built-in API harness without any API key or cloud account.</p>
    <div class="grid grid-2">
      <div>
        <label>Ollama host</label>
        <div class="row"><input type="text" id="ollamaHost" class="grow" value="${esc(configured)}" placeholder="http://127.0.0.1:11434"><button class="btn btn-small" data-act="saveOllamaHost">Save host</button></div>
        <div class="hint">The service usually listens on port 11434. Use <code>ollama serve</code> if it is not running.</div>
      </div>
      <div>
        <label>Provider</label>
        <div class="row">
          ${provider ? badge(`added: ${provider.label}`, 'badge-ok') : badge('not added', 'badge-muted')}
          <button class="btn btn-small btn-primary" data-act="addOllamaProvider" ${running && models.length ? '' : 'disabled'}>${provider ? 'Refresh provider' : 'Add as API provider'}</button>
          ${provider ? `<button class="btn btn-small" data-act="settingsTab" data-tab="providers">Edit</button>` : ''}
        </div>
        <div class="hint">${running && models.length ? 'The discovered models are written into the provider; select them in Project → Models.' : running ? 'Pull a model first, then add the provider.' : 'Start Ollama, then refresh.'}</div>
      </div>
    </div>
    ${o?.error ? `<div class="warn-box">${esc(o.error)}</div>` : ''}
    ${!installed ? `<div class="info-box"><b>Ollama is not installed.</b> Download it from <a href="https://ollama.com/download" target="_blank" rel="noopener">ollama.com/download</a>, start it, then pull a coding model:<br><code>ollama pull qwen2.5-coder:7b</code></div>` : ''}
    ${running ? `<h3>Installed models (${models.length})</h3>${models.length ? `<div class="tool-list">${models.map((m) => `<div class="tool-row"><div class="tool-main"><b>${esc(m.name)}</b> <span class="hint">${esc([m.parameterSize, m.quantization, m.family].filter(Boolean).join(' · '))}</span>${m.size ? `<span class="hint"> · ${m.size >= 1073741824 ? `${(m.size / 1073741824).toFixed(1)} GB` : `${Math.round(m.size / 1048576)} MB`}</span>` : ''}</div></div>`).join('')}</div>` : `<div class="warn-box">Ollama is running but has no models. Pull one, for example <code>ollama pull qwen2.5-coder:7b</code>, then refresh.</div>`}` : ''}
    <h3>Good local coding models</h3>
    <div class="hint">Tool calling quality varies by model. Models trained for tools (e.g. Qwen2.5-Coder, Llama 3.1, Mistral) work best; SleepPilot falls back to a text tool protocol if native tool calls are unavailable.</div>
  </div>`;
}

function appSettingsHtml() {
  return `<div class="card flat">
    <div class="card-head"><h2>Application</h2></div>
    <div class="kv">
      <div>Version</div><div>${esc(S.state.app?.version || '2.4.1')}${S.state.app?.testMode ? ' (test mode)' : ''}</div>
      <div>Data folder</div><div class="mono mono-wrap">${esc(S.state.app?.dataRoot || S.state.appDataRoot || 'per-user application data')}</div>
      <div>Default engine</div><div>${esc(engineById(defaultEngineId())?.label || defaultEngineId())}</div>
      <div>Platform</div><div>${esc(S.state.app?.platform || '')} · ${esc(S.state.app?.arch || '')} · Node ${esc(S.state.app?.node || '')}</div>
      <div>Concurrent runs</div><div><div class="row"><input type="number" id="setMaxRuns" min="1" max="12" value="${S.state.settings?.maxConcurrentRuns || 3}" style="max-width:100px"><button class="btn btn-small" data-act="saveAppSettings">Save</button></div><div class="hint">One run per project; this is the global limit across projects.</div></div>
      <div>GitHub CLI</div><div><div class="row"><input type="text" id="setGhPath" value="${esc(S.state.settings?.github?.ghPath || '')}" placeholder="gh (auto-detect)" style="max-width:260px"><select id="setGhVisibility" style="max-width:120px"><option value="private" ${S.state.settings?.github?.defaultVisibility !== 'public' ? 'selected' : ''}>private</option><option value="public" ${S.state.settings?.github?.defaultVisibility === 'public' ? 'selected' : ''}>public</option></select><button class="btn btn-small" data-act="saveAppSettings">Save</button></div><div class="hint">GitHub actions are explicit; SleepPilot never pushes automatically.</div></div>
    </div>
    <label class="check"><input type="checkbox" id="setNotifications" ${typeof Notification !== 'undefined' && Notification.permission === 'granted' ? 'checked' : ''}> Desktop notifications for finished or paused runs</label>
    <div class="row" style="margin-top:10px"><button class="btn" data-act="enableNotifications">Enable notifications</button><button class="btn btn-ghost" data-act="goHome">Projects</button></div>
    <div class="hint" style="margin-top:10px">SleepPilot stores projects and runs under %LOCALAPPDATA%\\SleepPilot (Windows) or ~/.local/share/SleepPilot. Nothing is written into a project folder except by the agent itself.</div>
  </div>`;
}

// ------------------------------------------------------------------ ACTIONS

const ACTIONS = {
  goHome: () => go('home'),
  goProject: () => go('project'),
  goRun: () => go('run'),
  goReport: () => go('report'),
  goReverse: () => go('reverse'),
  goSettings: () => go('settings'),
  closeModal: () => ($('#modal').hidden = true),
  openProject: (el) => openProject(el.dataset.id),
  openRunById: (el) => openProject(el.dataset.project, { view: 'run', runId: el.dataset.run }),
  openActiveRun: () => openProject(S.state.activeRuns?.[0]?.projectId || S.projectId, { view: 'run' }),
  focusNewProject: () => $('#npName')?.focus(),
  rustFromScratch: () => {
    S.newTemplate = 'rust';
    go('home').then(() => {
      const sel = $('#npTemplate');
      if (sel) sel.value = 'rust';
      $('#npName')?.focus();
    });
  },
  pickDir: async (el) => {
    const input = document.getElementById(el.dataset.for);
    const r = await api('POST', '/api/pick-folder', { initial: input?.value || '' });
    if (r?.ok && r.path) input.value = r.path;
    else if (r?.error) toast(r.error, true);
  },
  createProject: async () => {
    const body = {
      name: $('#npName')?.value.trim() || '',
      dir: $('#npDir')?.value.trim() || '',
      createIfMissing: !!$('#npCreate')?.checked,
      engine: $('#npEngine')?.value || defaultEngineId(),
      template: $('#npTemplate')?.value || 'blank',
    };
    const p = await api('POST', '/api/projects', body);
    S.newTemplate = 'blank';
    await loadState();
    await loadProject(p.id);
    toast('Project created.');
    await go('project');
  },
  connectEngine: async (el) => {
    toast('Connecting…');
    const view = await api('POST', `/api/engines/${encodeURIComponent(el.dataset.id)}/connect`, {});
    if (S.state) S.state.engines = view;
    renderEngineBadge();
    if (S.view === 'settings') renderSettingsView();
    if (S.view === 'home') renderEngineStrip();
    if (S.view === 'project') renderProject();
    toast('Engine status updated.');
  },
  setDefaultEngine: async (el) => {
    await saveSettingsPatch({ engine: el.dataset.id });
    toast('Default engine saved.');
    await loadState();
    if (S.view === 'settings') renderSettingsView();
  },
  saveDefaultEngine: async () => {
    const id = $('#setDefaultEngine')?.value;
    if (!id) return;
    await saveSettingsPatch({ engine: id });
    toast('Default engine saved.');
    await loadState();
    renderSettingsView();
  },
  saveEngineSettings: async () => {
    const patch = {};
    if ($('#setOpencodePath')) patch.opencodePath = $('#setOpencodePath').value.trim() || null;
    if ($('#setClaudePath')) {
      patch.claude = {
        ...(S.state.settings?.claude || {}),
        cliPath: $('#setClaudePath').value.trim() || null,
        model: $('#setClaudeModel')?.value.trim() || null,
        permissionMode: $('#setClaudePermission')?.value || 'auto',
        timeoutMin: Number($('#setClaudeTimeout')?.value) || 720,
      };
    }
    if ($('#setCodexPath')) {
      patch.codex = {
        ...(S.state.settings?.codex || {}),
        cliPath: $('#setCodexPath').value.trim() || null,
        model: $('#setCodexModel')?.value.trim() || null,
        sandbox: $('#setCodexSandbox')?.value || 'workspace-write',
        timeoutMin: Number($('#setCodexTimeout')?.value) || 720,
      };
    }
    if ($('#setDshPath')) {
      patch.dsh = {
        ...(S.state.settings?.dsh || {}),
        cliPath: $('#setDshPath').value.trim() || null,
        profile: $('#setDshProfile')?.value.trim() || 'headless',
        approvalPolicy: $('#setDshApproval')?.value || 'never',
        permissionMode: $('#setDshPermission')?.value.trim() || '',
      };
    }
    if ($('#setCliCommand')) {
      patch.cli = {
        ...(S.state.settings?.cli || {}),
        command: $('#setCliCommand').value.trim(),
        args: splitArgs($('#setCliArgs')?.value || ''),
        promptVia: $('#setCliPromptVia')?.value || 'stdin',
        timeoutMin: Number($('#setCliTimeout')?.value) || 720,
      };
    }
    await saveSettingsPatch(patch);
    toast('Settings saved.');
    await loadState();
    renderSettingsView();
  },
  saveDshKey: async () => {
    const v = $('#setDshKey')?.value || '';
    if (!v) return toast('Enter a key first.', true);
    await api('POST', '/api/secrets/env', { name: 'DEEPSEEK_API_KEY', value: v });
    toast('Key saved.');
    await loadState();
    renderSettingsView();
  },
  settingsTab: (el) => {
    S.settingsTab = el.dataset.tab;
    renderSettingsView();
  },
  refreshTools: async () => {
    const [tools, reverse, ollama] = await Promise.all([
      api('GET', '/api/tools?refresh=1').catch(() => null),
      api('GET', '/api/reverse/info').catch(() => S.reverseInfo),
      api('GET', '/api/ollama').catch(() => null),
    ]);
    S.tools = tools || S.tools;
    S.reverseInfo = reverse || S.reverseInfo;
    S.ollama = ollama;
    await loadState();
    renderSettingsView();
    toast('Toolchain refreshed.');
  },
  toolOverride: (el) => {
    const t = (S.tools?.tools || []).find((x) => x.id === el.dataset.id);
    if (!t) return;
    const o = S.state?.settings?.toolOverrides?.[t.id];
    openModal(`<h2>${esc(t.name)} — status and path</h2>
      <p class="hint">Automatic detection: <b>${esc((TOOL_STATUS[t.status] || [t.status])[0])}</b>${t.detail ? ` — ${esc(t.detail)}` : ''}</p>
      <label>Status</label>
      <select id="toolOverrideStatus">
        <option value="auto" ${!o ? 'selected' : ''}>Automatic detection</option>
        <option value="installed" ${o?.status === 'installed' ? 'selected' : ''}>Installed (manual)</option>
        <option value="missing" ${o?.status === 'missing' ? 'selected' : ''}>Missing / not usable</option>
        <option value="ignored" ${o?.status === 'ignored' ? 'selected' : ''}>Ignore this tool</option>
      </select>
      <label>Path or command (optional)</label>
      <input type="text" id="toolOverridePath" value="${esc(o?.path || '')}" placeholder="${esc(t.path || 'e.g. C:\\\\Tools\\\\cargo.exe or cargo')}">
      <div class="hint">A manual path is verified with the tool's version probe when possible. For GUI tools, the path is shown as manual information.</div>
      <div class="grid grid-2">
        <div><label>Version (optional)</label><input type="text" id="toolOverrideVersion" value="${esc(o?.version || '')}" placeholder="${esc(t.version || '')}"></div>
        <div><label>Note (optional)</label><input type="text" id="toolOverrideNote" value="${esc(o?.note || '')}" placeholder="e.g. installed in WSL"></div>
      </div>
      ${(t.attempts || []).length ? `<details style="margin-top:10px"><summary class="hint">Show detection attempts</summary><pre>${esc((t.attempts || []).map((a) => `${a.ok ? 'OK ' : 'ERR'} ${a.file}${a.error ? ` — ${a.error}` : ''}`).join('\n'))}</pre></details>` : ''}
      <div class="row" style="margin-top:12px"><button class="btn btn-primary" data-act="saveToolOverride" data-id="${esc(t.id)}">Save</button><button class="btn" data-act="clearToolOverride" data-id="${esc(t.id)}">Use automatic</button><button class="btn btn-ghost" data-act="closeModal">Cancel</button></div>`);
  },
  saveToolOverride: async (el) => {
    const status = $('#toolOverrideStatus')?.value || 'auto';
    const body = {
      toolId: el.dataset.id,
      status,
      path: $('#toolOverridePath')?.value.trim() || null,
      version: $('#toolOverrideVersion')?.value.trim() || null,
      note: $('#toolOverrideNote')?.value.trim() || null,
    };
    S.tools = await api('POST', '/api/tools/override', body);
    $('#modal').hidden = true;
    await loadState();
    renderSettingsView();
    toast('Tool status saved.');
  },
  clearToolOverride: async (el) => {
    S.tools = await api('POST', '/api/tools/override', { toolId: el.dataset.id, status: 'auto' });
    $('#modal').hidden = true;
    await loadState();
    renderSettingsView();
    toast('Automatic detection restored.');
  },
  refreshOllama: async () => {
    S.ollama = await api('GET', '/api/ollama').catch(() => null);
    renderSettingsView();
  },
  saveOllamaHost: async () => {
    const baseUrl = $('#ollamaHost')?.value.trim();
    S.ollama = await api('POST', '/api/ollama/host', { baseUrl });
    await loadState();
    renderSettingsView();
    toast('Ollama host saved.');
  },
  addOllamaProvider: async () => {
    const result = await api('POST', '/api/ollama/provider', {});
    S.ollama = { ...(S.ollama || {}), ...result.status, provider: result.provider };
    await loadState();
    renderSettingsView();
    toast(`Ollama provider saved with ${result.status.models?.length || 0} model(s). Select the API engine in a project to use it.`);
  },
  addProvider: async () => {
    const presetId = $('#newProviderPreset')?.value || 'custom';
    const preset = (S.state.engines?.providerPresets || []).find((p) => p.id === presetId);
    if (!preset) return;
    const id = preset.id === 'custom' ? `custom-${Date.now().toString(36)}` : preset.id;
    const providers = collectProviders();
    providers.push({
      id,
      preset: preset.id,
      label: preset.label,
      protocol: preset.protocol,
      baseUrl: preset.baseUrl,
      apiKeyEnv: preset.apiKeyEnv,
      requiresKey: preset.requiresKey,
      enabled: true,
      models: (preset.models || []).map((m) => ({ id: m.id, name: m.name })),
      maxOutputTokens: preset.maxOutputTokens || 8192,
    });
    await saveSettingsPatch({ providers });
    toast('Provider added. Enter its key and save.');
    await loadState();
    renderSettingsView();
  },
  saveProvider: async (el) => {
    const id = el.dataset.id;
    const card = document.querySelector(`[data-provider-card="${CSS.escape(id)}"]`);
    if (!card) return;
    const providers = collectProviders();
    await saveSettingsPatch({ providers });
    toast('Provider saved.');
    await loadState();
    renderSettingsView();
  },
  saveProviderKey: async (el) => {
    const id = el.dataset.id;
    const key = document.getElementById(`key-${id}`)?.value || '';
    if (!key) return toast('Enter a key first.', true);
    await api('POST', '/api/secrets/provider', { providerId: id, apiKey: key });
    toast('Key saved.');
    await loadState();
    renderSettingsView();
  },
  removeProvider: async (el) => {
    const id = el.dataset.id;
    if (!confirm('Remove this provider? Its stored key is kept until you replace it, but it will not be used.')) return;
    const providers = collectProviders().filter((p) => p.id !== id);
    await saveSettingsPatch({ providers });
    await loadState();
    renderSettingsView();
  },
  saveAppSettings: async () => {
    const n = Math.max(1, Math.min(12, Number($('#setMaxRuns')?.value) || 3));
    const patch = {
      maxConcurrentRuns: n,
      github: {
        ...(S.state.settings?.github || {}),
        ghPath: $('#setGhPath')?.value.trim() || null,
        defaultVisibility: $('#setGhVisibility')?.value || 'private',
      },
    };
    await saveSettingsPatch(patch);
    await loadState();
    renderSettingsView();
    toast('App settings saved.');
  },
  enableNotifications: async () => {
    if (typeof Notification === 'undefined') return toast('Notifications are not available in this browser.', true);
    const r = await Notification.requestPermission();
    toast(r === 'granted' ? 'Notifications enabled.' : 'Notifications were not granted.', r !== 'granted');
    renderSettingsView();
  },
  saveProject: async () => {
    await saveProjectSetup();
    toast('Project settings saved.');
    await loadProject(S.projectId, { keepRun: true });
    renderProject();
  },
  phoneEnable: async () => loadPhonePanel(await api('POST', '/api/phone', { enabled: true })),
  phoneDisable: async () => loadPhonePanel(await api('POST', '/api/phone', { enabled: false })),
  phoneRefresh: async () => loadPhonePanel(await api('POST', '/api/phone', { enabled: true })),
  phoneReset: async () => {
    if (!confirm('Every phone that is signed in now has to scan the new QR code. Continue?')) return;
    await loadPhonePanel(await api('POST', '/api/phone/reset', {}));
    toast('All phones signed out. Scan the new QR code.');
  },
  phoneCopyLink: async () => {
    if (!S.phone?.url) return;
    await navigator.clipboard.writeText(S.phone.url).then(() => toast('Link copied. It works like the QR code; keep it private.')).catch(() => toast('Could not access the clipboard.', true));
  },
  closeApp: async () => {
    const active = S.state?.activeRuns?.length || 0;
    if (active && !confirm(`${active} run(s) are active. Closing SleepPilot stops them after saving their state. Close anyway?`)) return;
    setBusy('Closing SleepPilot…');
    try {
      await api('POST', '/api/app/close', {});
    } catch {}
    setTimeout(() => window.close(), 350);
  },
  closeWindow: () => window.close(),
  reloadUi: () => location.reload(),
  refreshGithub: () => loadProjectGitHub(true),
  githubInit: async () => {
    await api('POST', `/api/projects/${S.project.id}/github/init`, {});
    await loadProjectGitHub(true);
    toast('Git repository initialized.');
  },
  githubCreateModal: () => {
    const name = (S.project.name || 'project').replace(/[^\w.-]+/g, '-');
    openModal(`<h2>Create GitHub repository</h2>
      <p class="hint">Uses the GitHub CLI and your existing <code>gh auth login</code> session. The repository is created from this project folder and pushed.</p>
      <label>Repository name</label><input type="text" id="ghName" value="${esc(name)}">
      <label>Visibility</label><select id="ghVisibility"><option value="private">Private</option><option value="public">Public</option></select>
      <label>Description</label><input type="text" id="ghDescription" placeholder="Optional short description">
      <div class="row" style="margin-top:12px"><button class="btn btn-primary" data-act="githubCreate">Create and push</button><button class="btn" data-act="closeModal">Cancel</button></div>`);
  },
  githubCreate: async () => {
    setBusy('Creating the GitHub repository…');
    try {
      const result = await api('POST', `/api/projects/${S.project.id}/github/create`, { name: $('#ghName')?.value, visibility: $('#ghVisibility')?.value, description: $('#ghDescription')?.value });
      $('#modal').hidden = true;
      await loadProjectGitHub(true);
      toast(result?.note || 'GitHub repository created.');
    } finally {
      clearBusy();
    }
  },
  githubPushModal: () => {
    openModal(`<h2>Commit and push</h2>
      <p class="hint">This stages <b>all</b> changes in the project, creates one commit and pushes to <code>origin</code>. Check that no secrets or generated files are included.</p>
      <label>Commit message</label><input type="text" id="ghCommitMessage" value="${esc(S.state?.settings?.github?.commitMessage || 'SleepPilot: update project')}">
      <div class="row" style="margin-top:12px"><button class="btn btn-primary" data-act="githubPush">Commit &amp; push</button><button class="btn" data-act="closeModal">Cancel</button></div>`);
  },
  githubPush: async () => {
    setBusy('Committing and pushing…');
    try {
      const r = await api('POST', `/api/projects/${S.project.id}/github/push`, { message: $('#ghCommitMessage')?.value });
      $('#modal').hidden = true;
      S.github = r.status;
      renderGithubCard();
      toast(r.committed ? `Pushed to ${r.branch}.` : `Pushed existing commits to ${r.branch}.`);
    } finally {
      clearBusy();
    }
  },
  refreshInsights: async () => {
    S.analytics = await api('GET', '/api/analytics');
    renderInsightsView();
  },
  refreshScout: () => loadProjectScout(true),
  addScoutChecks: async () => {
    const r = await api('POST', `/api/projects/${S.project.id}/checks/suggested`, {});
    await loadProject(S.projectId, { keepRun: true });
    renderProject();
    toast(`${r.added} suggested check(s) added; approve them in the run setup.`);
  },
  scoutToolFolder: async () => {
    const dir = $('#scoutFolder')?.value.trim();
    if (!dir) return toast('Enter a project folder first.', true);
    S.toolScoutLoading = true;
    renderToolScout();
    try {
      S.toolScout = await api('POST', '/api/scout/directory', { dir });
    } finally {
      S.toolScoutLoading = false;
      renderToolScout();
    }
  },
  scoutToolProgram: async () => {
    const targetPath = $('#scoutProgram')?.value.trim();
    if (!targetPath) return toast('Enter a program file or folder first.', true);
    S.toolScoutLoading = true;
    renderToolScout();
    try {
      S.toolScout = await api('POST', '/api/scout/target', { targetPath });
    } finally {
      S.toolScoutLoading = false;
      renderToolScout();
    }
  },
  copyToolDiagnostics: async () => {
    const text = JSON.stringify({ toolchain: S.tools, scout: S.toolScout }, null, 2);
    await navigator.clipboard.writeText(text).then(() => toast('Toolchain diagnostics copied.')).catch(() => toast('Could not access the clipboard.', true));
  },
  refreshScope: () => loadProjectScope(true),
  applyScope: () => {
    const e = S.scope?.estimate;
    if (!e) return toast('Analyze the scope first.', true);
    const set = (sel, val) => {
      const el = $(sel);
      if (el) el.value = val;
    };
    set('#fDuration', Math.round((Number(e.hours) || 1) * 4) / 4);
    set('#fMaxIter', e.maxIterations);
    set('#fMaxTurn', e.maxTurnMin);
    set('#fParallel', e.parallelDevelopers);
    set('#fProfile', e.permissionProfile);
    const unattended = $('#fUnattended');
    if (unattended) unattended.checked = !!e.unattended;
    const reviewer = $('#fReviewer');
    if (reviewer) reviewer.checked = e.reviewerEnabled !== false;
    updateSetupSummary();
    toast('Recommendation applied to the form. Save it to keep it.');
  },
  applyPreset: async (el) => applyPreset(el.dataset.key),
  setDuration: (el) => {
    const h = Number(el.dataset.min) / 60;
    const input = $('#fDuration');
    if (input) input.value = Math.round(h * 4) / 4;
    updateSetupSummary();
  },
  addCheck: () => {
    const name = $('#newCheckName')?.value.trim();
    const command = $('#newCheckCommand')?.value.trim();
    if (!name || !command) return toast('Enter a check name and command.', true);
    S.project.checks = [...(S.project.checks || []), { id: `custom-${Date.now().toString(36)}`, type: 'command', name, command, enabled: true, approved: true }];
    $('#checksEditor').innerHTML = checksEditorHtml(S.project.checks);
    $('#newCheckName').value = '';
    $('#newCheckCommand').value = '';
  },
  removeCheck: (el) => {
    S.project.checks = (S.project.checks || []).filter((c) => c.id !== el.dataset.id);
    $('#checksEditor').innerHTML = checksEditorHtml(S.project.checks);
  },
  startRun: async () => {
    await saveProjectSetup();
    const view = await api('POST', `/api/projects/${S.project.id}/runs`, {});
    S.runId = view.id;
    await loadState();
    await loadProject(S.projectId, { keepRun: true });
    await loadRun(view.id);
    await go('run');
    toast('Run started.');
  },
  runTab: (el) => {
    S.runTab = el.dataset.tab;
    localStorage.setItem('sp.runTab', S.runTab);
    renderRun();
  },
  renderLog: () => renderLog(),
  pauseRun: async (el) => {
    await api('POST', `/api/runs/${S.projectId}/${S.runId}/pause`, { immediate: el.dataset.now === '1' });
    toast('Pause requested.');
  },
  resumeRun: async () => {
    await api('POST', `/api/runs/${S.projectId}/${S.runId}/resume`, {});
    toast('Resuming.');
  },
  stopRun: async (el) => {
    if (el.dataset.now !== '1' && !confirm('Stop the run after the current iteration?')) return;
    await api('POST', `/api/runs/${S.projectId}/${S.runId}/stop`, { immediate: el.dataset.now === '1' });
    toast('Stop requested.');
  },
  extendRun: async () => {
    const current = S.run?.limits?.durationMin || 0;
    await api('POST', `/api/runs/${S.projectId}/${S.runId}/settings`, { durationMin: current + 60 });
    toast('One hour added.');
  },
  approvePlan: async () => {
    await api('POST', `/api/runs/${S.projectId}/${S.runId}/resume`, {});
    toast('Plan approved.');
  },
  replyPermission: async (el) => {
    await api('POST', `/api/runs/${S.projectId}/${S.runId}/permission`, { id: el.dataset.id, decision: el.dataset.decision });
    toast('Permission sent.');
  },
  replyForm: async (el) => {
    const id = el.dataset.id;
    const select = document.getElementById(`formSelect-${id}`);
    const input = document.getElementById(`formAnswer-${id}`);
    const answer = select?.value || input?.value || '';
    if (!answer.trim()) return toast('Type an answer first.', true);
    await api('POST', `/api/runs/${S.projectId}/${S.runId}/form`, { id, answer });
    toast('Answer sent.');
  },
  editTaskModal: (el) => {
    const t = S.run?.tasks?.find((x) => x.id === el.dataset.task);
    if (!t) return;
    openModal(`<h2>Edit task ${esc(t.id)}</h2>
      <label>Title</label><input type="text" id="etTitle" value="${esc(t.title)}">
      <label>Description</label><textarea id="etDesc" rows="5">${esc(t.description || '')}</textarea>
      <div class="grid grid-2"><div><label>Priority (1 high – 5 low)</label><input type="number" id="etPriority" min="1" max="5" value="${t.priority}"></div><div><label>File scope (comma separated)</label><input type="text" id="etFiles" value="${esc((t.files || []).join(', '))}"></div></div>
      <div class="row" style="margin-top:12px"><button class="btn btn-primary" data-act="saveTaskEdit" data-task="${esc(t.id)}">Save</button><button class="btn" data-act="closeModal">Cancel</button></div>`);
  },
  saveTaskEdit: async (el) => {
    await api('POST', `/api/runs/${S.projectId}/${S.runId}/tasks/${encodeURIComponent(el.dataset.task)}`, {
      title: $('#etTitle').value,
      description: $('#etDesc').value,
      priority: Number($('#etPriority').value),
      files: $('#etFiles').value.split(',').map((x) => x.trim()).filter(Boolean),
    });
    $('#modal').hidden = true;
    toast('Task updated.');
  },
  taskAction: async (el) => {
    const patch = el.dataset.op === 'first' ? { action: 'first' } : { action: el.dataset.op };
    await api('POST', `/api/runs/${S.projectId}/${S.runId}/tasks/${encodeURIComponent(el.dataset.task)}`, patch);
    toast('Task updated.');
  },
  addTaskModal: () => {
    openModal(`<h2>Add a task</h2>
      <label>Title</label><input type="text" id="atTitle" placeholder="What should be done?">
      <label>Description</label><textarea id="atDesc" rows="4" placeholder="Details, files, acceptance criteria…"></textarea>
      <div class="grid grid-2"><div><label>Priority</label><input type="number" id="atPriority" min="1" max="5" value="2"></div><div><label>Files (comma separated)</label><input type="text" id="atFiles"></div></div>
      <div class="row" style="margin-top:12px"><button class="btn btn-primary" data-act="saveNewTask">Add task</button><button class="btn" data-act="closeModal">Cancel</button></div>`);
  },
  saveNewTask: async () => {
    const title = $('#atTitle').value.trim();
    if (!title) return toast('Enter a title.', true);
    await api('POST', `/api/runs/${S.projectId}/${S.runId}/tasks/new`, {
      title,
      description: $('#atDesc').value,
      priority: Number($('#atPriority').value) || 2,
      files: $('#atFiles').value.split(',').map((x) => x.trim()).filter(Boolean),
    });
    $('#modal').hidden = true;
    toast('Task added.');
  },
  switchReportRun: async () => {
    S.runId = $('#reportRun')?.value;
    S.report = null;
    S.reportMarkdown = null;
    await renderReport();
    renderReportView();
  },
  renderReport: async () => {
    S.reportMarkdown = null;
    await renderReport();
    renderReportView();
  },
  copyReport: async () => {
    if (!S.reportMarkdown) return toast('No report to copy.', true);
    await navigator.clipboard.writeText(S.reportMarkdown);
    toast('Report copied.');
  },
  openIteration: async (el) => {
    const it = await api('GET', `/api/runs/${S.projectId}/${S.runId}/iterations/${el.dataset.n}`).catch(() => null);
    if (!it) return toast('Iteration not found.', true);
    const patches = (it.changes?.patches || []).map((p) => `<h3>${esc(p.file)} <span class="hint">+${p.additions}/−${p.deletions}</span></h3><pre>${colorDiff(p.patch || '')}</pre>`).join('') || '<div class="hint">No diff stored.</div>';
    openModal(`<h2>Iteration #${esc(String(it.n))}</h2>
      <div class="kv"><div>Task</div><div>${esc(it.taskId || '')} ${esc(it.taskTitle || '')}</div><div>Status</div><div>${taskBadge(it.status)}</div><div>Developer report</div><div>${esc(it.developerStatus?.status || '—')} ${esc(it.developerStatus?.reason || '')}</div><div>Review</div><div>${esc(it.review?.verdict || '—')} ${esc((it.review?.issues || []).join('; '))}</div><div>Decision</div><div>${esc(it.decision?.decision || '—')} ${esc(it.decision?.reasoning || '')}</div></div>
      <h3>Checks</h3>${(it.checks || []).map((c) => `<div class="hint">${c.status === 'passed' ? '✓' : c.status === 'failed' ? '✗' : '·'} ${esc(c.name)} — ${esc(String(c.output || '').slice(0, 800))}</div>`).join('') || '<div class="hint">No checks.</div>'}
      <h3>Changes</h3>${patches}`);
  },
  chatFilter: (el) => {
    CHAT.filter = el.dataset.k;
    $$('.chat-toolbar .chip').forEach((c) => c.classList.toggle('active', c.dataset.k === CHAT.filter));
    chatRender();
  },
  chatSteer: async () => {
    const text = $('#chatSteer')?.value.trim();
    if (!text) return toast('Write an instruction first.', true);
    await api('POST', `/api/runs/${S.projectId}/${S.runId}/steer`, { text, mode: $('#chatSteerNow')?.checked ? 'interrupt_now' : 'after_iteration' });
    $('#chatSteer').value = '';
    toast('Instruction queued.');
  },
  previewReverseScope: async () => {
    const targetPath = $('#rvTarget')?.value.trim();
    if (!targetPath) return toast('Enter a target file or folder first.', true);
    S.reverseScopeLoading = true;
    S.reverseScope = null;
    S.targetScout = null;
    const box = $('#reversePreview');
    if (box) box.innerHTML = reversePreviewHtml();
    try {
      const mode = $('#rvMode')?.value || 'rust';
      const [scope, scout] = await Promise.all([
        api('POST', '/api/reverse/preview', { targetPath, mode }),
        api('POST', '/api/scout/target', { targetPath }).catch(() => null),
      ]);
      S.reverseScope = scope;
      S.targetScout = scout;
    } finally {
      S.reverseScopeLoading = false;
      if (box) box.innerHTML = reversePreviewHtml();
    }
  },
  applyReverseScope: () => {
    const e = S.reverseScope?.estimate;
    if (!e) return;
    const hours = $('#rvHours');
    if (hours) hours.value = Math.round((Number(e.hours) || 1) * 4) / 4;
    toast('Target recommendation applied.');
  },
  createReverse: async () => {
    const body = {
      targetPath: $('#rvTarget')?.value.trim(),
      workDir: $('#rvWork')?.value.trim(),
      goals: $('#rvGoal')?.value || '',
      mode: $('#rvMode')?.value || 'rust',
      engine: $('#rvEngine')?.value || defaultEngineId(),
      language: 'en',
      durationMin: Math.round((Number($('#rvHours')?.value) || 8) * 60),
      unattended: !!$('#rvUnattended')?.checked,
      permissionProfile: 'full',
      ack: !!$('#rvAck')?.checked,
    };
    if (!body.targetPath) return toast('Choose a target file or folder.', true);
    if (!body.workDir) return toast('Choose a workspace folder.', true);
    if (!body.ack) return toast('Confirm that you have the right to analyse the target.', true);
    toast('Mirroring and analysing the target…');
    const created = await api('POST', '/api/reverse', body);
    const p = created.project || created;
    await loadState();
    await loadProject(p.id);
    S.reverseInfo = null;
    toast('Workspace prepared. Review the objective and start the run.');
    await go('project');
  },
  openRecon: async (el) => {
    const p = await api('GET', `/api/projects/${el.dataset.id}`).catch(() => null);
    if (!p) return;
    openModal(`<h2>Reconnaissance</h2><p class="hint">Generated files in the workspace:</p>
      <pre>${esc(`${p.project.dir}\\${p.project.reverse?.recon || '_recon'}\\RECON.md`)}\n${esc(`${p.project.dir}\\${p.project.reverse?.recon || '_recon'}\\recon.json`)}\n${esc(`${p.project.dir}\\${p.project.reverse?.mirror || '_target'}\\TARGET_MAP.md`)}</pre>
      <p class="hint">Open these files in your editor for the full detail. The agent reads them automatically.</p>`);
  },
};

async function openProject(id, { view = null, runId = null } = {}) {
  if (!id) return;
  try {
    S.projectId = id;
    await loadState();
    await loadProject(id);
    S.runId = runId || S.state.activeRuns?.find((r) => r.projectId === id)?.runId || S.runs[0]?.id || null;
    // `go()` uses the guarded navigation lock itself; do not hold it across this call.
    await go(view || 'project');
  } catch (err) {
    toast(err.message, true);
  }
}

async function saveSettingsPatch(patch) {
  const next = await api('POST', '/api/settings', patch);
  S.state = next;
  return next;
}

function collectProviders() {
  return $$('[data-provider-card]').map((card) => {
    const get = (k) => card.querySelector(`[data-p="${k}"]`);
    const models = String(get('models')?.value || '').split(',').map((x) => x.trim()).filter(Boolean);
    return {
      id: card.dataset.providerCard,
      preset: card.dataset.providerPreset || 'custom',
      label: get('label')?.value.trim() || card.dataset.providerCard,
      protocol: get('protocol')?.value || 'openai',
      baseUrl: get('baseUrl')?.value.trim() || '',
      apiKeyEnv: get('apiKeyEnv')?.value.trim() || '',
      requiresKey: card.dataset.providerRequires !== 'false',
      enabled: !!get('enabled')?.checked,
      maxOutputTokens: Number(get('maxOutputTokens')?.value) || 8192,
      models,
    };
  });
}

function splitArgs(s) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

// ------------------------------------------------------------------ modal / markdown / misc

function openModal(html) {
  $('#modalBody').innerHTML = html;
  $('#modal').hidden = false;
}

function colorDiff(patch) {
  return esc(patch)
    .split('\n')
    .map((l) => (/^\+/.test(l) ? `<span class="diff-add">${l}</span>` : /^-/.test(l) ? `<span class="diff-del">${l}</span>` : /^@@/.test(l) ? `<span class="diff-hunk">${l}</span>` : l))
    .join('\n');
}

function markdown(md) {
  const lines = String(md || '').split('\n');
  let html = '';
  let inCode = false;
  let inList = false;
  let table = null;
  const inline = (s) =>
    esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/(^|[^*])\*([^*]+)\*/g, '$1<i>$2</i>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  const closeList = () => {
    if (inList) html += '</ul>';
    inList = false;
  };
  const closeTable = () => {
    if (table) html += `<table>${table.map((r, i) => `<tr>${r.map((c) => (i === 0 ? `<th>${inline(c)}</th>` : `<td>${inline(c)}</td>`)).join('')}</tr>`).join('')}</table>`;
    table = null;
  };
  for (const l of lines) {
    if (l.startsWith('```')) {
      closeList();
      closeTable();
      html += inCode ? '</pre>' : '<pre>';
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      html += esc(l) + '\n';
      continue;
    }
    if (/^\|/.test(l)) {
      closeList();
      const cells = l.replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
      if (cells.every((c) => /^-+$/.test(c))) continue;
      (table ||= []).push(cells);
      continue;
    }
    closeTable();
    if (/^\s*[-*] /.test(l)) {
      if (!inList) html += '<ul>';
      inList = true;
      html += `<li>${inline(l.replace(/^\s*[-*] /, ''))}</li>`;
      continue;
    }
    closeList();
    const h = l.match(/^(#{1,4}) (.*)/);
    if (h) html += `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`;
    else if (l.startsWith('> ')) html += `<blockquote>${inline(l.slice(2))}</blockquote>`;
    else if (/^---+$/.test(l.trim())) html += '<hr>';
    else if (l.trim()) html += `<p>${inline(l)}</p>`;
  }
  closeList();
  closeTable();
  return html;
}

document.addEventListener('contextmenu', (e) => {
  // On the phone a long press opens this menu; its actions (close app/window) belong to the PC.
  if (S.state?.viewer?.phone) return;
  const tag = e.target?.tagName;
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) || e.target?.isContentEditable) return;
  e.preventDefault();
  const menu = $('#contextMenu');
  if (!menu) return;
  menu.hidden = false;
  const w = 230;
  const h = 130;
  menu.style.left = `${Math.min(e.clientX, window.innerWidth - w - 8)}px`;
  menu.style.top = `${Math.min(e.clientY, window.innerHeight - h - 8)}px`;
});
document.addEventListener('mousedown', (e) => {
  const menu = $('#contextMenu');
  if (menu && !menu.hidden && !menu.contains(e.target)) menu.hidden = true;
});
window.addEventListener('blur', () => {
  const menu = $('#contextMenu');
  if (menu) menu.hidden = true;
});
document.addEventListener('scroll', () => {
  const menu = $('#contextMenu');
  if (menu) menu.hidden = true;
}, true);

document.addEventListener('click', (e) => {
  const menu = $('#contextMenu');
  if (menu) menu.hidden = true;
  const nav = e.target.closest('.nav-btn');
  if (nav) {
    go(nav.dataset.view);
    return;
  }
  const el = e.target.closest('[data-act]');
  if (el) {
    e.preventDefault();
    const fn = ACTIONS[el.dataset.act];
    if (!fn) return;
    const wasDisabled = el.disabled;
    if (el.classList.contains('btn') && !wasDisabled) {
      el.disabled = true;
      el.classList.add('loading');
    }
    Promise.resolve(fn(el))
      .catch((err) => toast(err.message, true))
      .finally(() => {
        if (el.classList.contains('btn') && !wasDisabled) {
          el.classList.remove('loading');
          el.disabled = false;
        }
      });
  }
});
$('#modal').addEventListener('click', (e) => {
  if (e.target.id === 'modal') $('#modal').hidden = true;
});
document.addEventListener('change', (e) => {
  if (e.target.id === 'chatThinking') {
    CHAT.showThinking = e.target.checked;
    chatRender();
  }
  if (e.target.id === 'npTemplate') {
    const create = $('#npCreate');
    if (create && e.target.value === 'rust') create.checked = true;
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#modal').hidden) $('#modal').hidden = true;
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && e.target.id === 'chatSteer') {
    e.preventDefault();
    ACTIONS.chatSteer().catch((err) => toast(err.message, true));
  }
});

// ------------------------------------------------------------------ boot

initChat({ S, api, esc, fmtClock, fmtDur, fmtTime, num, markdown, TURN });

(async function boot() {
  await loadState();
  if (S.projectId) await loadProject(S.projectId).catch(() => {});
  connectEvents();
  const saved = localStorage.getItem('sp.view');
  const view = saved && ['home', 'project', 'run', 'report', 'insights', 'reverse', 'settings'].includes(saved) ? saved : S.projectId ? 'project' : 'home';
  await go(view);
  setInterval(() => {
    if (S.view === 'run' && S.run && !['completed', 'stopped', 'failed'].includes(S.run.state)) {
      const head = $('#runHead');
      if (head && !isEditing()) head.innerHTML = runHeadHtml(S.run);
    }
  }, 1000);
})().catch((err) => {
  main().innerHTML = `<div class="card"><h2>The UI could not start</h2><pre>${esc(err.message)}</pre><p class="hint">Reload the page. If the app restarted, reopen it with SleepPilot.cmd.</p></div>`;
});
