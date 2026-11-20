// SleepPilot chat view — a transcript of every turn: who spoke, when, how long,
// what the model thought (folded), which tools it ran (with input/output) and what it answered.
// Data: finished turns from /api/runs/:pid/:rid/turns, live updates from the log stream (entries
// carry the turn id). app.js imports this module and hands over its helpers with initChat().

import { morph, morphElement } from './dom.js';

let S, api, esc, fmtClock, fmtDur, fmtTime, num, markdown, TURN;
export function initChat(deps) {
  ({ S, api, esc, fmtClock, fmtDur, fmtTime, num, markdown, TURN } = deps);
}

const CHAT_ROLE = {
  manager: { icon: '🧭', label: 'Manager' },
  developer: { icon: '🛠️', label: 'Developer' },
  reviewer: { icon: '🔍', label: 'Reviewer' },
  closing: { icon: '📝', label: 'Closing report' },
  preflight: { icon: '🔌', label: 'Model check' },
};
// Log kinds that appear between turns as timeline lines.
const CHAT_SYS = {
  iteration: '🔁',
  plan: '🗺️',
  evaluation: '⚖️',
  decision: '🧭',
  'check-pass': '✅',
  'check-fail': '❌',
  check: '☑️',
  changes: '📄',
  steer: '🎯',
  pause: '⏸️',
  control: '🎛️',
  finish: '🏁',
  error: '⛔',
  warning: '⚠️',
  permission: '🔐',
  form: '❓',
  recovery: '🩹',
  review: '🔍',
};

export const CHAT = {
  turns: new Map(), // id -> turn
  loadedRunId: null,
  filter: 'all',
  showThinking: true,
  frame: null,
  dirty: new Set(),
};

export function chatReset() {
  CHAT.turns = new Map();
  CHAT.loadedRunId = null;
}

/** Load finished turns once per run, then rebuild in-progress turns from the persisted events. */
export async function chatLoad() {
  if (!S.runId) return;
  if (CHAT.loadedRunId !== S.runId) {
    CHAT.turns = new Map();
    const list = await api('GET', `/api/runs/${S.projectId}/${S.runId}/turns?limit=120`).catch(() => []);
    for (const t of list || []) CHAT.turns.set(t.id, chatFromRecord(t));
    CHAT.loadedRunId = S.runId;
    for (const e of S.events) if (e.turn && !CHAT.turns.get(e.turn)?.final) chatApply(e, true);
  }
}

export function chatFromRecordPublic(t) {
  return chatFromRecord(t);
}

function chatFromRecord(t) {
  const items = [];
  for (const x of t.transcript || []) {
    if (x.type === 'reasoning') items.push({ type: 'reasoning', text: x.text, at: x.at, endedAt: x.endedAt });
    else if (x.type === 'text') items.push({ type: 'text', text: x.text });
    else if (x.type === 'tool') items.push({ type: 'tool', name: x.name, input: x.input, status: x.status === 'completed' ? 'ok' : x.status === 'error' ? 'error' : x.status, output: x.output, error: x.error?.message, at: x.at, endedAt: x.endedAt });
    else if (x.type === 'compaction') items.push({ type: 'notice', text: `The engine compacted the context (${x.status || ''})` });
    else if (x.type === 'step' && x.error) items.push({ type: 'notice', bad: true, text: `Step error: ${x.error.type || ''} ${x.error.message || ''}` });
  }
  for (const e of t.errors || []) if (!items.some((i) => i.type === 'notice' && i.text.includes(e.message || '¤'))) items.push({ type: 'notice', bad: true, text: `${e.type || 'error'}: ${e.message || ''}` });
  return { ...t, items, final: true, live: false };
}

/** Apply one live log entry that belongs to a turn. Returns true when something changed. */
export function chatApply(e, bulk = false) {
  let t = CHAT.turns.get(e.turn);
  if (e.kind === 'turn-start') {
    if (t?.final) return false;
    t = { id: e.turn, role: e.role, tag: e.tag, iteration: e.iteration, model: e.model, prompt: e.prompt, startedAt: e.at, items: [], live: true };
    CHAT.turns.set(e.turn, t);
    return true;
  }
  if (!t || t.final) return false;
  const last = t.items[t.items.length - 1];
  switch (e.kind) {
    case 'reasoning-delta':
      if (last?.type === 'reasoning' && last.live) last.text += e.text;
      else t.items.push({ type: 'reasoning', text: e.text, live: true, at: e.at });
      break;
    case 'text-delta':
      if (last?.type === 'text' && last.live) last.text += e.text;
      else t.items.push({ type: 'text', text: e.text, live: true });
      break;
    case 'reasoning':
    case 'text':
      // Flushed copies of what was streamed; used only when the deltas were missed (page reload).
      if (!bulk) {
        for (const i of t.items) if (i.type === e.kind) i.live = false;
        return false;
      }
      t.items.push({ type: e.kind, text: e.text.replace(/^\[[^\]]+\] /, '') });
      break;
    case 'tool':
      for (const i of t.items) i.live = false;
      t.items.push({ type: 'tool', id: e.toolId, name: e.tool, input: e.input, status: 'running', at: e.at });
      break;
    case 'tool-result':
    case 'tool-error': {
      const tool = [...t.items].reverse().find((i) => i.type === 'tool' && (i.id === e.toolId || (!e.toolId && i.status === 'running')));
      if (!tool) return false;
      tool.status = e.kind === 'tool-result' ? 'ok' : 'error';
      tool.endedAt = e.at;
      const body = e.text.replace(/^(\[[^\]]+\] )?[✓✖] [^:]+: ?/, '');
      if (tool.status === 'ok') tool.output = body;
      else tool.error = body;
      break;
    }
    case 'turn-end':
      t.live = false;
      t.endedAt = e.at;
      t.status = e.status;
      for (const i of t.items) i.live = false;
      break;
    default:
      t.items.push({ type: 'notice', text: e.text, bad: /error|fail/.test(e.kind) });
  }
  return true;
}

/** A finished turn from the server replaces the live reconstruction (authoritative transcript). */
export function chatTurnFinished(rec) {
  CHAT.turns.set(rec.id, chatFromRecord(rec));
  chatSchedule(rec.id);
}

export function chatSchedule(turnId) {
  CHAT.dirty.add(turnId || '*');
  if (CHAT.frame) return;
  // A timer, not requestAnimationFrame: rAF never fires while the window is minimised or in the background.
  CHAT.frame = setTimeout(() => {
    CHAT.frame = null;
    const ids = [...CHAT.dirty];
    CHAT.dirty.clear();
    const box = document.getElementById('chat');
    if (!box) return;
    if (ids.includes('*') || ids.some((id) => !document.getElementById(`turn-${id}`))) return chatRender();
    const stick = chatAtBottom(box);
    // Only the changed parts of each bubble are updated: no re-created elements, no replayed
    // entrance animation, folds stay as the user left them.
    for (const id of ids) {
      const t = CHAT.turns.get(id);
      const el = document.getElementById(`turn-${id}`);
      if (!t || !el) continue;
      morphElement(el, chatTurnHtml(t));
    }
    if (stick) box.scrollTop = box.scrollHeight;
  }, 80);
}

function chatAtBottom(box) {
  return document.getElementById('chatAutoScroll')?.checked !== false && box.scrollHeight - box.scrollTop - box.clientHeight < 160;
}

function chatTimeline() {
  const list = [];
  for (const t of CHAT.turns.values()) {
    if (CHAT.filter !== 'all' && t.role !== CHAT.filter) continue;
    list.push({ at: t.startedAt || 0, turn: t });
  }
  if (CHAT.filter === 'all') for (const e of S.events) if (!e.turn && CHAT_SYS[e.kind]) list.push({ at: e.at, sys: e });
  list.sort((a, b) => a.at - b.at);
  return list.slice(-260);
}

export function chatRender() {
  const box = document.getElementById('chat');
  if (!box) return;
  const stick = chatAtBottom(box) || !box.innerHTML;
  const items = chatTimeline();
  // Keyed update: existing bubbles and timeline lines stay in place; only new ones are inserted
  // (and only they play the entrance animation).
  morph(
    box,
    items.length
      ? items.map((x) => (x.turn ? chatTurnHtml(x.turn) : chatSysHtml(x.sys))).join('')
      : '<div class="empty" data-key="empty">No agent turns yet. Once the run starts, the manager, developer and reviewer conversations appear here.</div>',
  );
  if (stick) box.scrollTop = box.scrollHeight;
}

function chatSysHtml(e) {
  const cls = /fail|error/.test(e.kind) ? ' bad' : e.kind === 'check-pass' ? ' ok' : e.kind === 'iteration' ? ' strong' : '';
  return `<div class="chat-sys${cls}" data-key="s-${esc(e.at)}-${esc(e.kind)}-${esc(String(e.text || '').length)}"><span class="t">${fmtClock(e.at)}</span> ${CHAT_SYS[e.kind]} ${esc(e.text)}</div>`;
}

export function chatTurnHtml(t) {
  const r = CHAT_ROLE[t.role] || { icon: '🤖', label: t.role };
  const dur = (t.endedAt || (t.live ? Date.now() : t.startedAt)) - t.startedAt;
  const tok = t.usage?.tokens ? t.usage.tokens.input + t.usage.tokens.output : null;
  const outTok = t.usage?.tokens ? (t.usage.tokens.output || 0) + (t.usage.tokens.reasoning || 0) : 0;
  const tps = outTok && dur > 250 ? outTok / (dur / 1000) : null;
  const tools = t.items.filter((i) => i.type === 'tool');
  const status = t.live
    ? '<span class="chat-live">● working</span>'
    : t.status && t.status !== 'succeeded'
      ? `<span class="badge badge-bad">${esc(TURN[t.status] || t.status)}</span>`
      : '<span class="chat-ok">✓</span>';
  const head = `<div class="turn-head">
    <span class="avatar">${r.icon}</span><b>${esc(r.label)}</b>
    ${t.tag ? `<span class="chat-tag">${esc(t.tag)}</span>` : ''}
    ${t.iteration ? `<span class="chat-it">#${t.iteration}</span>` : ''}
    ${t.model ? `<span class="chat-model">${esc(String(t.model).split('/').pop())}</span>` : ''}
    <span class="grow"></span>
    <span class="chat-meta" title="${esc(fmtTime(t.startedAt))}">${fmtClock(t.startedAt)} · ${fmtDur(dur)}${t.harness ? ` · ${esc(t.harness)}${t.modelProfile ? `/${esc(t.modelProfile)}` : ''}` : ''}${tools.length ? ` · ${tools.length} tool(s)` : ''}${tok != null ? ` · ${num(tok)} tokens` : ''}${tps ? ` · ${tps.toFixed(1)} tok/s` : ''}</span>
    ${status}
  </div>`;
  const prompt = t.prompt ? `<details class="chat-prompt" data-k="p"><summary>Instruction sent</summary><pre>${esc(t.prompt)}</pre></details>` : '';
  const body = chatItemsHtml(t);
  return `<div class="turn role-${esc(t.role)}${t.live ? ' live' : ''}" id="turn-${esc(t.id)}">${head}${prompt}${body || (t.live ? '<div class="chat-wait">The agent is thinking…</div>' : '')}</div>`;
}

/**
 * Three or more tool calls in a row are folded into one line ("🔧 6 tool calls · Read ×4, Edit ×2"),
 * so a busy developer turn reads as what it did, not as a wall of tool rows. While the turn is
 * running, the line shows the tool that is running now.
 */
function chatItemsHtml(t) {
  const out = [];
  const items = t.items;
  for (let n = 0; n < items.length; ) {
    if (items[n].type !== 'tool') {
      out.push(chatItemHtml(items[n], n, t));
      n++;
      continue;
    }
    let end = n;
    while (end < items.length && items[end].type === 'tool') end++;
    const group = items.slice(n, end);
    if (group.length < 3) {
      group.forEach((i, k) => out.push(chatItemHtml(i, n + k, t)));
    } else {
      const counts = new Map();
      for (const i of group) counts.set(i.name || 'tool', (counts.get(i.name || 'tool') || 0) + 1);
      const kinds = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k, c]) => `${esc(k)}${c > 1 ? ` ×${c}` : ''}`).join(', ');
      const failed = group.filter((i) => i.status === 'error').length;
      const running = group.find((i) => i.status === 'running');
      const now = running ? ` · <span class="chat-live">⏳ ${esc(running.name || 'tool')}</span> <span class="mono">${esc(toolArgText(running.input))}</span>` : '';
      out.push(`<details class="chat-tools${failed ? ' bad' : ''}" data-k="g${n}"><summary>🔧 <b>${group.length} tool calls</b> <span class="hint">${kinds}</span>${failed ? ` <span class="tool-bad">${failed} failed</span>` : ''}${now}</summary><div class="chat-tools-body">${group.map((i, k) => chatItemHtml(i, n + k, t)).join('')}</div></details>`);
    }
    n = end;
  }
  return out.join('');
}

function chatItemHtml(i, n, t) {
  if (i.type === 'reasoning') {
    if (!CHAT.showThinking) return '';
    const open = i.live ? ' open' : '';
    return `<details class="chat-think" data-k="r${n}"${open}><summary>💭 Thinking <span class="hint">${num(i.text.length)} chars${i.live ? ' · writing…' : ''}</span></summary><div class="think-body">${esc(i.text.slice(-12_000))}</div></details>`;
  }
  if (i.type === 'text') {
    if (i.live) return `<div class="chat-text"><div class="pre-wrap">${esc(i.text.slice(-8000))}</div></div>`;
    const summary = structuredSummary(i.text);
    if (summary) return `<div class="chat-text">${summary}<details class="chat-prompt" data-k="j${n}"><summary>Raw JSON reply</summary><pre>${esc(i.text.slice(0, 20_000))}</pre></details></div>`;
    return `<div class="chat-text">${markdown(statusBadge(i.text).slice(0, 20_000))}</div>`;
  }
  if (i.type === 'tool') {
    const arg = toolArgText(i.input);
    const secs = i.endedAt && i.at ? fmtDur(i.endedAt - i.at) : '';
    const st = i.status === 'running' ? '<span class="chat-live">⏳</span>' : i.status === 'error' ? '<span class="tool-bad">✖</span>' : '<span class="chat-ok">✓</span>';
    return `<details class="chat-tool ${i.status === 'error' ? 'bad' : ''}" data-k="t${n}"><summary>${st} <b>${esc(i.name || 'tool')}</b> <span class="mono">${esc(arg)}</span> <span class="hint">${secs}</span></summary>
      ${i.input ? `<div class="hint">Input</div><pre>${esc(JSON.stringify(i.input, null, 2).slice(0, 4000))}</pre>` : ''}
      ${i.output ? `<div class="hint">Output</div><pre>${esc(String(i.output).slice(0, 4000))}</pre>` : ''}
      ${i.error ? `<div class="hint">Error</div><pre class="bad">${esc(i.error)}</pre>` : ''}</details>`;
  }
  return `<div class="chat-notice${i.bad ? ' bad' : ''}">${esc(i.text)}</div>`;
}

/**
 * Manager/reviewer answers are JSON for SleepPilot; in the chat they are shown as what they mean
 * (plan, decision, review verdict…). The raw JSON stays one click away.
 */
function structuredSummary(text) {
  const m = text.match(/```json\s*([\s\S]*?)```/) || (/^\s*\{[\s\S]*\}\s*$/.test(text) ? [null, text] : null);
  if (!m) return null;
  let j;
  try {
    j = JSON.parse(m[1].replace(/,\s*([}\]])/g, '$1'));
  } catch {
    return null;
  }
  const li = (arr, f) => `<ul class="chat-list">${arr.slice(0, 20).map((x) => `<li>${f(x)}</li>`).join('')}</ul>`;
  const taskLi = (t) => `<b>${esc(t.title || '')}</b>${t.priority ? ` <span class="hint">P${esc(t.priority)}</span>` : ''}${t.files?.length ? ` <span class="mono hint">${esc(t.files.join(', '))}</span>` : ''}`;
  if (Array.isArray(j.tasks)) return `<div class="chat-card">🗺️ <b>Plan: ${j.tasks.length} tasks</b>${j.summary ? `<div class="hint">${esc(j.summary.length > 400 ? j.summary.slice(0, 400) + "…" : j.summary)}</div>` : ''}${li(j.tasks, taskLi)}${j.questions?.length ? `<div class="hint">Questions: ${esc(j.questions.join(' / '))}</div>` : ''}</div>`;
  if (typeof j.decision === 'string') {
    const label = { continue: 'continue', repair: 'repair', ask_user: 'ask the user', complete: 'complete' }[j.decision] || j.decision;
    return `<div class="chat-card">🧭 <b>Decision: ${esc(label)}</b>${j.next_task_id ? ` → <span class="chat-tag">${esc(j.next_task_id)}</span>` : ''}${j.reasoning ? `<div>${esc(j.reasoning.slice(0, 600))}</div>` : ''}${j.user_question ? `<div class="hint">Question: ${esc(j.user_question)}</div>` : ''}${j.task_updates?.length ? `<div class="hint">Task updates: ${j.task_updates.map((u) => `${esc(u.id)}${u.status ? ` → ${esc(u.status)}` : ''}`).join(', ')}</div>` : ''}${j.new_tasks?.length ? `<div class="hint">New tasks:</div>${li(j.new_tasks, taskLi)}` : ''}</div>`;
  }
  if (typeof j.verdict === 'string') {
    const v = j.verdict.split(/[\s|]/)[0];
    const icon = { pass: '✅', fail: '❌', incomplete: '⚠️', cannot_judge: '❔' }[v] || '🔍';
    return `<div class="chat-card">${icon} <b>Review: ${esc(v)}</b>${j.summary ? `<div>${esc(j.summary.slice(0, 500))}</div>` : ''}${j.issues?.length ? li(j.issues, (x) => esc(String(x).slice(0, 300))) : ''}${j.missing_verification?.length ? `<div class="hint">Not verified: ${esc(j.missing_verification.join('; ').slice(0, 300))}</div>` : ''}</div>`;
  }
  if (typeof j.objective === 'string') return `<div class="chat-card">🎯 <b>Objective updated</b>${j.change_summary ? `<div>${esc(j.change_summary)}</div>` : ''}${j.new_tasks?.length ? li(j.new_tasks, taskLi) : ''}</div>`;
  if (Array.isArray(j.new_tasks)) return `<div class="chat-card">✨ <b>Improvement proposal: ${j.new_tasks.length} tasks</b>${li(j.new_tasks, taskLi)}${j.reasoning ? `<div class="hint">${esc(j.reasoning.slice(0, 300))}</div>` : ''}</div>`;
  return null;
}

/** The developer's final "SLEEPPILOT_STATUS: done — …" line becomes a small badge. */
function statusBadge(text) {
  return text.replace(/^SLEEPPILOT_STATUS:\s*(done|blocked|needs_user|partial)\s*[—-]?\s*(.*)$/m, (_, st, why) => `**${{ done: '✅ done', blocked: '⛔ blocked', needs_user: '❓ needs a user decision', partial: '◐ partial' }[st]}** — ${why}`);
}

function toolArgText(input) {
  if (!input || typeof input !== 'object') return '';
  const v = input.command || input.filePath || input.path || input.file || input.pattern || input.url || input.query || '';
  return String(v).replace(/^[A-Z]:\\[^ ]*?\\(?=[^\\]+$)/, '').slice(0, 120);
}

/** "Who is working right now" for the live header: every running turn with its last action. */
export function chatNowHtml() {
  const live = [...CHAT.turns.values()].filter((t) => t.live);
  if (!live.length) return '';
  return `<div class="now-list">${live
    .map((t) => {
      const r = CHAT_ROLE[t.role] || { icon: '🤖', label: t.role };
      const tool = [...t.items].reverse().find((i) => i.type === 'tool');
      const thinking = t.items.at(-1)?.type === 'reasoning' && t.items.at(-1).live;
      const doing = thinking ? '💭 thinking' : tool ? `${tool.status === 'running' ? '⏳' : '✓'} ${esc(tool.name)} ${esc(toolArgText(tool.input))}` : t.items.some((i) => i.type === 'text') ? '✍️ writing the answer' : 'starting';
      return `<div class="now-item"><span class="avatar">${r.icon}</span><b>${esc(r.label)}</b>${t.tag ? ` <span class="chat-tag">${esc(t.tag)}</span>` : ''} <span class="chat-meta">${fmtDur(Date.now() - t.startedAt)}</span> <span class="now-doing">${doing}</span></div>`;
    })
    .join('')}</div>`;
}

/** Toolbar + container used inside the live screen. */
export function chatPanelHtml() {
  const f = (k, label) => `<button class="chip ${CHAT.filter === k ? 'active' : ''}" data-act="chatFilter" data-k="${k}">${label}</button>`;
  return `<div class="chat-toolbar">
      ${f('all', 'All')}${f('developer', '🛠️ Developer')}${f('manager', '🧭 Manager')}${f('reviewer', '🔍 Reviewer')}
      <span class="grow"></span>
      <label class="check" style="margin:0"><input type="checkbox" id="chatThinking" ${CHAT.showThinking ? 'checked' : ''}> Thinking</label>
      <label class="check" style="margin:0"><input type="checkbox" id="chatAutoScroll" checked> Auto-scroll</label>
    </div>
    <div class="chat" id="chat"></div>
    <div class="chat-composer">
      <textarea id="chatSteer" rows="2" placeholder="Write an instruction for the run… (e.g. Finish the caravan system first, do the UI later)"></textarea>
      <div class="chat-composer-row">
        <label class="check" style="margin:0"><input type="checkbox" id="chatSteerNow"> <span>Apply now <span class="hint">(interrupts the developer)</span></span></label>
        <span class="grow"></span>
        <span class="hint">Ctrl+Enter</span>
        <button class="btn btn-primary btn-small" data-act="chatSteer">Send</button>
      </div>
    </div>`;
}
