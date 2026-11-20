// SleepPilot assistant: the chat box in the lower-right corner.
// Shows what SleepPilot already knows (engine problems, a paused run, missing tools) without a
// model call, and answers questions with the model the user chose — or the 2nd / 3rd choice when
// the first is not available. The question is sent with the text of the current screen.

let S, api, esc, markdown, go, openProject, toast;
export function initAssistant(deps) {
  ({ S, api, esc, markdown, go, openProject, toast } = deps);
  mount();
}

const $ = (sel, root = document) => root.querySelector(sel);
const A = {
  open: localStorage.getItem('sp.assistantOpen') === '1',
  view: null, // server view: settings, candidates, engines, status, history
  mode: 'chat', // 'chat' | 'settings'
  pending: null, // { id, question, text, progress }
  loading: false,
  refreshTimer: null,
};

const QUICK = [
  'What is happening right now?',
  'Why did my run stop or pause?',
  'What should I do next?',
  'Explain this screen.',
];

function mount() {
  if ($('#assistantFab')) return;
  const fab = document.createElement('button');
  fab.id = 'assistantFab';
  fab.className = 'assistant-fab';
  fab.type = 'button';
  fab.title = 'Assistant: status, help and questions';
  fab.setAttribute('aria-label', 'Open the assistant');
  fab.innerHTML = '<span class="assistant-fab-icon">💬</span><span class="assistant-fab-badge" hidden></span>';
  fab.addEventListener('click', () => toggle());
  const panel = document.createElement('section');
  panel.id = 'assistantPanel';
  panel.className = 'assistant-panel';
  panel.hidden = true;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'SleepPilot assistant');
  document.body.append(fab, panel);
  panel.addEventListener('click', onClick);
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && e.target.id === 'assistantInput') {
      e.preventDefault();
      send();
    }
    if (e.key === 'Escape') toggle(false);
  });
  if (A.open) toggle(true);
  else refresh();
}

/** Called by app.js when the view, project or run changes (debounced). */
export function assistantRefresh() {
  clearTimeout(A.refreshTimer);
  A.refreshTimer = setTimeout(() => refresh().catch(() => {}), 600);
}

/** Streaming text and progress from the server (SSE 'assistant' events). */
export function assistantEvent(d) {
  if (!A.pending || d.id !== A.pending.id) return;
  if (d.kind === 'delta') A.pending.text += d.text;
  else if (d.kind === 'progress') A.pending.progress = d.text;
  renderMessages();
}

async function refresh() {
  const q = new URLSearchParams();
  if (S.projectId) q.set('projectId', S.projectId);
  if (S.runId) q.set('runId', S.runId);
  A.view = await api('GET', `/api/assistant?${q}`);
  renderFab();
  if (A.open) render();
}

function toggle(force) {
  A.open = force ?? !A.open;
  localStorage.setItem('sp.assistantOpen', A.open ? '1' : '0');
  $('#assistantPanel').hidden = !A.open;
  $('#assistantFab').classList.toggle('active', A.open);
  if (A.open) {
    render();
    refresh().catch((err) => toast(err.message, true));
    setTimeout(() => $('#assistantInput')?.focus(), 50);
  }
}

function renderFab() {
  const items = A.view?.status || [];
  const n = items.filter((s) => s.level !== 'info').length;
  const badge = $('#assistantFab .assistant-fab-badge');
  if (!badge) return;
  badge.hidden = !n;
  badge.textContent = String(n);
  badge.classList.toggle('bad', items.some((s) => s.level === 'error'));
}

function modelLabel(c) {
  const e = A.view?.engines?.find((x) => x.id === c.engine);
  return `${e?.label || c.engine}${c.model ? ` · ${c.model.split('/').pop()}` : ''}`;
}

function render() {
  const panel = $('#assistantPanel');
  if (!panel || !A.view) {
    if (panel) panel.innerHTML = '<div class="assistant-empty"><span class="spinner"></span></div>';
    return;
  }
  const first = A.view.candidates?.[0];
  panel.innerHTML = `
    <header class="assistant-head">
      <div><b>Assistant</b><div class="hint">${first ? `${esc(modelLabel(first))}${A.view.candidates.length > 1 ? ` <span title="${esc(A.view.candidates.slice(1).map(modelLabel).join(' → '))}">+${A.view.candidates.length - 1} fallback</span>` : ''}` : ''}</div></div>
      <span class="spacer"></span>
      <button class="icon-btn ${A.mode === 'settings' ? 'active' : ''}" data-a="settings" title="Choose models">⚙</button>
      <button class="icon-btn" data-a="clear" title="Clear the conversation">🗑</button>
      <button class="icon-btn" data-a="close" title="Close (Esc)">✕</button>
    </header>
    ${A.mode === 'settings' ? settingsHtml() : `
    <div class="assistant-body" id="assistantBody">
      ${statusHtml()}
      <div id="assistantMessages"></div>
    </div>
    <footer class="assistant-foot">
      <textarea id="assistantInput" rows="2" placeholder="Ask about SleepPilot, your project or the current run… (Enter to send)"></textarea>
      <button class="btn btn-primary btn-small" data-a="send" ${A.pending ? 'disabled' : ''}>Send</button>
    </footer>`}`;
  if (A.mode === 'chat') renderMessages();
}

function statusHtml() {
  const items = A.view.status || [];
  if (!items.length) return '<div class="assistant-status ok">✓ Nothing needs your attention right now.</div>';
  return `<div class="assistant-status">${items
    .map((s, i) => `<div class="assistant-card ${esc(s.level)}"><div><b>${s.level === 'error' ? '⛔' : s.level === 'warn' ? '⚠️' : 'ℹ️'} ${esc(s.title)}</b>${s.detail ? `<div class="hint">${esc(s.detail)}</div>` : ''}</div>${s.action ? `<button class="btn btn-small" data-a="action" data-i="${i}">${esc(s.action.label)}</button>` : ''}</div>`)
    .join('')}</div>`;
}

function renderMessages() {
  const box = $('#assistantMessages');
  if (!box || !A.view) return;
  const msgs = A.view.history || [];
  const html = msgs
    .map((m) => `<div class="assistant-msg ${m.role === 'user' ? 'user' : 'bot'}${m.error ? ' bad' : ''}">${m.role === 'user' ? esc(m.text) : markdown(m.text)}${m.used ? `<div class="assistant-meta">${esc(m.used)}${m.fallback ? ' · fallback' : ''}</div>` : ''}</div>`)
    .join('');
  const pending = A.pending
    ? `<div class="assistant-msg user">${esc(A.pending.question)}</div><div class="assistant-msg bot live">${A.pending.text ? markdown(A.pending.text) : '<span class="assistant-typing"><i></i><i></i><i></i></span>'}${A.pending.progress ? `<div class="assistant-meta">${esc(A.pending.progress)}</div>` : ''}</div>`
    : '';
  const quick = !msgs.length && !A.pending ? `<div class="assistant-quick">${QUICK.map((q) => `<button class="chip" data-a="quick">${esc(q)}</button>`).join('')}</div>` : '';
  box.innerHTML = html + pending + quick;
  const body = $('#assistantBody');
  if (body) body.scrollTop = body.scrollHeight;
}

function settingsHtml() {
  const engines = A.view.engines || [];
  const chosen = A.view.settings?.models?.length ? A.view.settings.models : A.view.candidates || [];
  const row = (i) => {
    const c = chosen[i] || { engine: '', model: '' };
    const e = engines.find((x) => x.id === c.engine);
    return `<div class="assistant-choice">
      <label>${i === 0 ? '1. Preferred model' : `${i + 1}. If that is not available`}</label>
      <div class="row">
        <select data-engine="${i}"><option value="">${i === 0 ? 'Default engine' : '— none —'}</option>${engines.map((x) => `<option value="${esc(x.id)}" ${x.id === c.engine ? 'selected' : ''}>${esc(x.label)}${x.state === 'connected' ? '' : ` (${esc(x.state)})`}</option>`).join('')}</select>
        <input type="text" data-model="${i}" list="assistantModels${i}" value="${esc(c.model || '')}" placeholder="model (empty = engine default)">
        <datalist id="assistantModels${i}">${(e?.models || []).map((m) => `<option value="${esc(m)}">`).join('')}</datalist>
      </div>
    </div>`;
  };
  return `<div class="assistant-body">
    <p class="hint" style="margin-top:0">The assistant asks the first model; when it is not available (engine missing, signed out, out of quota, error) it uses the second, then the third. Your choice is saved.</p>
    ${row(0)}${row(1)}${row(2)}
    <p class="hint">Model names: OpenCode and the API harness use <span class="mono">provider/model</span> (pick from the list after connecting the engine); Claude Code accepts <span class="mono">sonnet</span>, <span class="mono">opus</span>, <span class="mono">haiku</span>. A small, fast model is enough here.</p>
    <div class="row"><button class="btn btn-primary btn-small" data-a="save">Save</button><button class="btn btn-small btn-ghost" data-a="back">Back to chat</button></div>
  </div>`;
}

async function onClick(e) {
  const el = e.target.closest('[data-a]');
  if (!el) return;
  const a = el.dataset.a;
  try {
    if (a === 'close') toggle(false);
    else if (a === 'settings') {
      A.mode = A.mode === 'settings' ? 'chat' : 'settings';
      render();
    } else if (a === 'back') {
      A.mode = 'chat';
      render();
    } else if (a === 'clear') {
      if (!confirm('Clear the assistant conversation?')) return;
      await api('POST', '/api/assistant/clear', {});
      await refresh();
    } else if (a === 'send') send();
    else if (a === 'quick') {
      $('#assistantInput').value = el.textContent;
      send();
    } else if (a === 'save') {
      const models = [0, 1, 2]
        .map((i) => ({ engine: $(`[data-engine="${i}"]`)?.value || '', model: $(`[data-model="${i}"]`)?.value.trim() || '' }))
        .filter((m) => m.engine);
      A.view = await api('POST', '/api/assistant/settings', { models });
      A.mode = 'chat';
      toast('Assistant models saved.');
      render();
    } else if (a === 'action') {
      const act = A.view.status?.[Number(el.dataset.i)]?.action;
      if (!act) return;
      if (act.tab) S.settingsTab = act.tab;
      if (act.projectId && act.projectId !== S.projectId) await openProject(act.projectId, { view: act.view, runId: act.runId });
      else await go(act.view);
    }
  } catch (err) {
    toast(err.message, true);
  }
}

/** The screen the user is looking at, as text (the assistant's "eyes"). */
function screenText() {
  const main = document.getElementById('main');
  if (!main) return '';
  // Values of form fields are part of what the user sees.
  const fields = [...main.querySelectorAll('input[type=text], textarea, select')]
    .filter((f) => f.offsetParent !== null && f.value && !/password|key|token|secret/i.test(f.id + f.name + f.placeholder))
    .slice(0, 40)
    .map((f) => `[${f.previousElementSibling?.textContent?.trim() || f.id || 'field'}: ${String(f.value).slice(0, 300)}]`);
  return `${main.innerText.replace(/\n{3,}/g, '\n\n').slice(0, 16_000)}\n${fields.join('\n')}`;
}

async function send() {
  const input = $('#assistantInput');
  const question = input?.value.trim();
  if (!question || A.pending) return;
  input.value = '';
  const id = `a_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  A.pending = { id, question, text: '', progress: '' };
  render();
  try {
    const r = await api('POST', '/api/assistant/ask', { id, question, projectId: S.projectId, runId: S.runId, view: S.view, screen: screenText() });
    if (r?.error) toast(r.error, true);
  } catch (err) {
    toast(err.message, true);
  } finally {
    A.pending = null;
    await refresh().catch(() => {});
    render();
    $('#assistantInput')?.focus();
  }
}
