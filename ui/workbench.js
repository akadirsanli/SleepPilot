// SleepPilot workbench screens: Workspace (Home card + Settings tab), live Preview and Android.
// app.js imports this module and hands over its helpers with initWorkbench().

let S, api, esc, badge, toast, fmtTime, fmtDur, num, openModal, rerender;
export function initWorkbench(deps) {
  ({ S, api, esc, badge, toast, fmtTime, fmtDur, num, openModal, rerender } = deps);
}

const $ = (sel, root = document) => root.querySelector(sel);
const fmtSize = (n) => (n == null ? '—' : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
const onPhone = () => !!S.state?.viewer?.phone;

export const WB = {
  workspace: null,
  preview: null,
  previewErrors: [],
  previewDevice: localStorage.getItem('sp.previewDevice') || 'phone',
  previewLandscape: localStorage.getItem('sp.previewLandscape') === '1',
  previewNonce: 0,
  android: null,
  androidTc: null,
  devices: null,
  selectedDevice: null,
  logcat: null,
  installResult: null,
};

// ------------------------------------------------------------------ workspace

export async function loadWorkspace() {
  WB.workspace = await api('GET', '/api/workspace').catch(() => WB.workspace);
  return WB.workspace;
}

/** Home card: set up the workspace, or list its project folders. */
export function workspaceCardHtml() {
  const w = WB.workspace;
  if (!w) return '';
  if (!w.configured) {
    return `<div class="card workspace-card">
      <div class="card-head"><h2>Set up your workspace</h2><span class="hint">One folder for all SleepPilot projects</span></div>
      <p class="sub" style="margin:0 0 10px">SleepPilot creates a <code>projects/</code> folder for your projects and an <code>exports/</code> folder for finished files (APKs) inside the folder you choose. New projects then need only a name.</p>
      <div class="row"><input type="text" id="wsDirHome" class="grow" value="${esc(w.suggested || '')}"><button class="btn" data-act="pickDir" data-for="wsDirHome">Browse…</button><button class="btn btn-primary" data-act="wsSave" data-input="wsDirHome">Create workspace</button></div>
      <div class="hint">Choose a short path without spaces or special characters (for example <code>C:\\SleepPilot</code>): Android builds fail on unusual paths.</div>
    </div>`;
  }
  const unopened = (w.folders || []).filter((f) => !f.projectId);
  return `<div class="card workspace-card">
    <div class="card-head"><h2>Workspace</h2><span class="hint mono">${esc(w.dir)}</span><span class="spacer"></span><button class="btn btn-small btn-ghost" data-act="wsSettings">Change…</button></div>
    ${w.exists ? '' : `<div class="warn-box">The workspace folder does not exist any more. <a href="#" data-act="wsSettings">Choose it again</a>.</div>`}
    <div class="kv">
      <div>Projects folder</div><div class="mono mono-wrap">${esc(w.projectsDir || '')}</div>
      <div>Exports (APK/AAB)</div><div class="mono mono-wrap">${esc(w.exportsDir || '')}</div>
      <div>Project folders</div><div>${(w.folders || []).length}${w.outside ? ` · ${w.outside} project(s) live outside the workspace` : ''}</div>
    </div>
    ${unopened.length ? `<div class="hint" style="margin-top:10px">Folders in the workspace that are not SleepPilot projects yet:</div>${unopened.slice(0, 12).map((f) => `<div class="project-row"><div class="project-main"><div class="project-name">${esc(f.folder)}</div><div class="project-dir mono">${esc(f.dir)}</div></div><div class="project-meta"><button class="btn btn-small" data-act="wsOpenFolder" data-folder="${esc(f.folder)}">Open as project</button></div></div>`).join('')}` : ''}
  </div>`;
}

export function workspaceSettingsHtml() {
  const w = WB.workspace;
  if (!w) return '<div class="empty"><span class="spinner"></span> Loading…</div>';
  return `<div class="card flat">
    <div class="card-head"><h2>Workspace</h2>${w.configured ? badge('set up', 'badge-ok') : badge('not set up', 'badge-warn')}</div>
    <p class="sub" style="margin:0 0 10px">The folder in which SleepPilot creates new projects. Its layout:</p>
    <div class="kv">
      <div class="mono">projects/&lt;name&gt;/</div><div>One folder per project; the agents work here.</div>
      <div class="mono">exports/&lt;name&gt;/</div><div>Built APKs and AABs, copied here after every successful Android build.</div>
      <div class="mono">README.md</div><div>Explains the layout to anyone who opens the folder.</div>
    </div>
    <label>Workspace folder</label>
    <div class="row"><input type="text" id="wsDir" class="grow" value="${esc(w.dir || w.suggested || '')}"><button class="btn" data-act="pickDir" data-for="wsDir">Browse…</button><button class="btn btn-primary" data-act="wsSave" data-input="wsDir">${w.configured ? 'Save' : 'Create workspace'}</button>${w.configured ? '<button class="btn btn-ghost" data-act="wsClear">Stop using a workspace</button>' : ''}</div>
    <div class="hint">Existing projects stay where they are. Run history, settings and API keys are kept in SleepPilot's data folder, not in the workspace.</div>
  </div>`;
}

// ------------------------------------------------------------------ preview

export async function loadPreview(projectId = S.projectId) {
  if (!projectId) return null;
  WB.preview = await api('GET', `/api/projects/${projectId}/preview`);
  return WB.preview;
}

const DEVICES = { phone: [390, 844, 'Phone'], tablet: [820, 1180, 'Tablet'], desktop: [1280, 800, 'Desktop'], fill: [0, 0, 'Fill'] };

function deviceStyle() {
  const d = DEVICES[WB.previewDevice] || DEVICES.phone;
  if (!d[0]) return '';
  const [w, h] = WB.previewLandscape ? [d[1], d[0]] : [d[0], d[1]];
  return `width:${w}px;height:${h}px`;
}

function frameUrl(v) {
  if (!v?.url) return null;
  return v.url;
}

export function renderPreviewView() {
  const main = $('#main');
  if (!S.project) return;
  const info = WB.preview;
  const v = info?.view || {};
  const running = !!v.running;
  const plan = info?.effective || {};
  const url = frameUrl(v);
  main.innerHTML = `
  <div class="row" style="justify-content:space-between;align-items:flex-start">
    <div><h1>Preview</h1><div class="sub">${esc(S.project.name)} · <span class="mono">${esc(S.project.dir)}</span></div></div>
    <div class="row">${running ? badge(v.state === 'starting' ? 'starting' : 'live', v.state === 'starting' ? 'badge-warn' : 'badge-ok') : badge('stopped', 'badge-muted')}${v.liveReload ? badge('live reload', 'badge-info') : ''}</div>
  </div>
  ${!info ? '<div class="empty"><span class="spinner"></span> Loading…</div>' : `
  <div class="card preview-card">
    <div class="preview-toolbar">
      ${running ? '<button class="btn btn-warn" data-act="previewStop">Stop</button>' : `<button class="btn btn-primary" data-act="previewStart" ${plan.mode === 'none' || plan.mode === 'off' ? 'disabled' : ''}>Start preview</button>`}
      ${running && url ? '<button class="btn" data-act="previewReload">Reload</button>' : ''}
      ${running && url && !onPhone() ? `<a class="btn btn-ghost" href="${esc(url)}" target="_blank" rel="noopener">Open in browser ↗</a>` : ''}
      <span class="spacer"></span>
      <div class="pill-row">${Object.entries(DEVICES).map(([k, d]) => `<button class="chip ${WB.previewDevice === k ? 'active' : ''}" data-act="previewDevice" data-device="${k}">${d[2]}</button>`).join('')}
      ${WB.previewDevice !== 'fill' && WB.previewDevice !== 'desktop' ? `<button class="chip ${WB.previewLandscape ? 'active' : ''}" data-act="previewRotate" title="Rotate">⟳ ${WB.previewLandscape ? 'Landscape' : 'Portrait'}</button>` : ''}</div>
    </div>
    <div class="hint" style="margin:6px 0 10px">${running ? `${url ? `<span class="mono">${esc(url)}</span>` : 'Waiting for the dev server to print its address…'}${v.mode === 'static' ? ` · ${num(v.changes || 0)} change(s) seen${v.lastChange?.file ? ` · last: <span class="mono">${esc(v.lastChange.file)}</span>` : ''}` : ''}` : esc(planText(info))}</div>
    ${onPhone() ? `<div class="info-box">The preview runs on the PC (127.0.0.1) and cannot be opened from the phone. Android builds can be downloaded to the phone on the Android screen.</div>` : running && url ? `
    <div class="preview-stage ${WB.previewDevice === 'fill' ? 'fill' : ''}">
      <div class="preview-device ${WB.previewDevice}" style="${deviceStyle()}">
        <iframe id="previewFrame" src="${esc(url)}" title="Preview of ${esc(S.project.name)}" allow="fullscreen; autoplay; gamepad; accelerometer; gyroscope; clipboard-write"></iframe>
      </div>
    </div>` : running ? '<div class="empty"><span class="spinner"></span> Starting…</div>' : `<div class="empty">${plan.mode === 'none' ? 'There is nothing to preview yet. As soon as the agent writes an HTML page (or a dev-server script), the preview can start — during a run it starts by itself.' : 'The preview is stopped.'}</div>`}
  </div>
  <div class="grid grid-2">
    <div class="card">
      <div class="card-head"><h2>Console</h2>${WB.previewErrors.length ? badge(`${WB.previewErrors.length} error(s)`, 'badge-bad') : badge('no errors', 'badge-ok')}<span class="spacer"></span>${WB.previewErrors.length ? '<button class="btn btn-small" data-act="previewClearErrors">Clear</button>' : ''}</div>
      <div class="log-box preview-console" id="previewConsole">${previewConsoleHtml()}</div>
      ${v.mode === 'command' ? `<div class="hint" style="margin-top:8px">Dev server output:</div><pre class="log-box" style="height:180px">${esc((v.log || []).join('\n') || '(no output yet)')}</pre>` : ''}
      <div class="hint" style="margin-top:6px">JavaScript errors, failed requests and console.error calls of the previewed page appear here (static preview).</div>
    </div>
    ${previewSettingsHtml(info)}
  </div>`}`;
}

function planText(info) {
  const e = info.effective || {};
  const d = info.detected || {};
  if (e.mode === 'static') return `Static preview of ${e.root ? `${e.root}/` : 'the project folder'}${e.entry ? ` → ${e.entry}` : ''}. ${d.reason || ''}`;
  if (e.mode === 'command') return `Dev server: ${e.command || '(no command)'}${e.commandApproved ? '' : ' — needs your approval below'}. ${d.reason || ''}`;
  if (e.mode === 'off') return 'Preview is switched off for this project.';
  return d.reason || 'Nothing to preview yet.';
}

function previewConsoleHtml() {
  if (!WB.previewErrors.length) return '<div class="hint">No errors so far.</div>';
  return WB.previewErrors.slice(-200).map((e) => `<div class="log-line k-error">${esc(new Date(e.at).toLocaleTimeString('en-GB'))} [${esc(e.kind || 'error')}] ${esc(e.message)}${e.where ? ` <span class="hint">${esc(e.where)}</span>` : ''}</div>`).join('');
}

function previewSettingsHtml(info) {
  const c = info.config || {};
  const d = info.detected || {};
  return `<div class="card">
    <div class="card-head"><h2>Preview settings</h2><span class="hint">Auto = what SleepPilot detected</span></div>
    <div class="grid grid-2">
      <div><label>Mode</label><select id="pvMode">${[['auto', `Auto (${d.recommended || 'none'})`], ['static', 'Static files (live reload)'], ['command', 'Dev server command'], ['off', 'Off']].map(([k, l]) => `<option value="${k}" ${c.mode === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></div>
      <div><label>Folder to serve</label><input type="text" id="pvRoot" value="${esc(c.root)}" placeholder="${esc(d.root || '(project folder)')}"></div>
      <div><label>Start page</label><input type="text" id="pvEntry" list="pvPages" value="${esc(c.entry)}" placeholder="${esc(d.entry || 'index.html')}"><datalist id="pvPages">${(d.htmlFiles || []).map((f) => `<option value="${esc(f)}">`).join('')}</datalist></div>
      <div><label>Dev server URL (optional)</label><input type="text" id="pvUrl" value="${esc(c.url)}" placeholder="read from the command output"></div>
    </div>
    <label>Dev server command</label>
    <input type="text" id="pvCommand" list="pvCommands" value="${esc(c.command)}" placeholder="${esc(d.commands?.[0]?.command || 'npm run dev')}"><datalist id="pvCommands">${(d.commands || []).map((x) => `<option value="${esc(x.command)}">${esc(x.script)}</option>`).join('')}</datalist>
    <label class="check"><input type="checkbox" id="pvApproved" ${c.commandApproved ? 'checked' : ''}> I approve running this command in the project folder (it executes project code on this computer)</label>
    <label class="check"><input type="checkbox" id="pvAuto" ${c.autoStart !== false ? 'checked' : ''}> Start the static preview by itself when a run starts</label>
    <div class="row" style="margin-top:10px"><button class="btn btn-primary" data-act="previewSave">Save</button><span class="hint">${esc(d.reason || '')}</span></div>
  </div>`;
}

export function onPreviewMessage(e) {
  const url = WB.preview?.view?.url;
  if (!url || !e.data || e.data.source !== 'sleeppilot-preview') return;
  try {
    if (new URL(url).origin !== e.origin) return;
  } catch {
    return;
  }
  if (e.data.type === 'loaded') {
    WB.previewErrors = WB.previewErrors.filter((x) => x.at > Date.now() - 1500);
  } else if (e.data.type === 'error') {
    WB.previewErrors.push({ at: Date.now(), kind: String(e.data.kind || 'error'), message: String(e.data.message || '').slice(0, 600), where: e.data.where ? String(e.data.where).slice(0, 200) : '' });
    if (WB.previewErrors.length > 300) WB.previewErrors.splice(0, 100);
  } else return;
  if (S.view === 'preview') {
    const box = $('#previewConsole');
    if (box) box.innerHTML = previewConsoleHtml();
    const head = box?.closest('.card')?.querySelector('.card-head .badge');
    if (head) head.outerHTML = WB.previewErrors.length ? badge(`${WB.previewErrors.length} error(s)`, 'badge-bad') : badge('no errors', 'badge-ok');
  }
}

/** SSE 'preview' event. A file change in static mode only updates the status line (the page reloads itself). */
export function onPreviewEvent(data) {
  if (!data || data.projectId !== S.projectId || !WB.preview) return;
  const wasUrl = WB.preview.view?.url;
  WB.preview.view = data.view;
  if (S.view !== 'preview') return;
  if (data.change && wasUrl === data.view?.url && $('#previewFrame')) {
    const hint = $('.preview-card > .hint');
    const v = data.view;
    if (hint) hint.innerHTML = `<span class="mono">${esc(v.url)}</span> · ${num(v.changes || 0)} change(s) seen${v.lastChange?.file ? ` · last: <span class="mono">${esc(v.lastChange.file)}</span>` : ''}`;
    return;
  }
  renderPreviewView();
}

// ------------------------------------------------------------------ android

export async function loadAndroid(projectId = S.projectId, { force = false } = {}) {
  const [tc, project] = await Promise.all([api('GET', `/api/android/toolchain${force ? '?refresh=1' : ''}`).catch(() => null), projectId ? api('GET', `/api/projects/${projectId}/android`).catch((err) => ({ error: err.message })) : null]);
  WB.androidTc = tc;
  WB.android = project;
  return project;
}

const statusBadge = (ok, warn = false, labels = ['OK', 'missing']) => (ok ? badge(labels[0], 'badge-ok') : badge(labels[1], warn ? 'badge-warn' : 'badge-bad'));

export function toolchainCardHtml(compact = false) {
  const t = WB.androidTc?.toolchain;
  const dl = WB.androidTc?.download;
  if (!t) return '<div class="card"><div class="empty"><span class="spinner"></span> Checking the Android toolchain…</div></div>';
  const problems = t.problems || [];
  return `<div class="card">
    <div class="card-head"><h2>Android toolchain</h2>${t.ready ? badge('ready to build', 'badge-ok') : badge('needs setup', 'badge-warn')}<span class="spacer"></span><button class="btn btn-small" data-act="androidRecheck">Check again</button></div>
    <div class="kv">
      <div>JDK</div><div>${statusBadge(t.jdk.ok, t.jdk.found, ['OK', t.jdk.found ? 'too old' : 'missing'])} ${t.jdk.found ? `${esc(t.jdk.version || '?')} · <span class="mono">${esc(t.jdk.home)}</span> <span class="hint">(${esc(t.jdk.source || '')})</span>` : ''}</div>
      <div>Android SDK</div><div>${statusBadge(t.sdk.found)} ${t.sdk.found ? `<span class="mono">${esc(t.sdk.dir)}</span> · platforms: ${esc(t.sdk.platforms.join(', ') || 'none')}${t.sdk.buildTools.length ? ` · build-tools ${esc(t.sdk.buildTools.at(-1))}` : ''} · licences ${t.sdk.licensesAccepted ? 'accepted' : '<b>not accepted</b>'}` : ''}</div>
      <div>Gradle</div><div>${t.gradle.found ? `${badge('OK', 'badge-ok')} ${esc(t.gradle.version || '')} <span class="hint">(${esc(t.gradle.source || '')})</span>` : `${badge('not installed', 'badge-muted')} <span class="hint">only needed for projects without gradlew</span>`}</div>
      <div>adb</div><div>${t.sdk.adb ? `${badge('OK', 'badge-ok')} <span class="mono">${esc(t.sdk.adb)}</span>` : `${badge('missing', 'badge-muted')} <span class="hint">needed to install on a phone by USB</span>`}</div>
      ${compact ? '' : `<div>Android Studio</div><div>${t.studio.found ? `${badge('found', 'badge-ok')} <span class="mono">${esc(t.studio.path)}</span>` : `${badge('not found', 'badge-muted')} <a href="https://developer.android.com/studio" target="_blank" rel="noopener">developer.android.com/studio</a>`}</div>`}
    </div>
    ${problems.length ? `<div style="margin-top:10px">${problems.map((p) => `<div class="${p.severity === 'error' ? 'warn-box' : 'info-box'}" style="margin:6px 0"><b>${esc(p.title)}.</b> ${esc(p.fix)}</div>`).join('')}</div>` : ''}
    <div class="row" style="margin-top:10px">
      ${!t.gradle.managed ? `<button class="btn" data-act="androidDownloadGradle" ${dl?.state === 'running' ? 'disabled' : ''}>Download Gradle ${esc(WB.android?.defaults?.gradle || '')}</button>` : ''}
      ${dl ? `<span class="hint">${dl.state === 'running' ? `Downloading Gradle ${esc(dl.version)}… ${fmtSize(dl.received)}${dl.total ? ` / ${fmtSize(dl.total)}` : ''}` : dl.state === 'done' ? `Gradle ${esc(dl.version)} installed.` : dl.state === 'failed' ? `<span style="color:var(--bad)">Download failed: ${esc(dl.error)}</span>` : ''}</span>` : ''}
      <span class="spacer"></span><a href="#" class="hint" data-act="androidPaths">Set JDK / SDK / Gradle paths…</a>
    </div>
  </div>`;
}

export function renderAndroidView() {
  const main = $('#main');
  if (!S.project) return;
  const a = WB.android;
  const info = a?.info;
  const app = info?.appModule;
  main.innerHTML = `
  <div class="row" style="justify-content:space-between;align-items:flex-start">
    <div><h1>Android</h1><div class="sub">${esc(S.project.name)} · <span class="mono">${esc(S.project.dir)}</span></div></div>
    <div class="row">${info?.framework ? badge(info.framework.label, 'badge-info') : ''}${app ? badge(app.applicationId || 'app', 'badge-muted') : ''}<button class="btn btn-small" data-act="androidRefresh">Refresh</button></div>
  </div>
  ${!a ? '<div class="empty"><span class="spinner"></span> Loading…</div>' : a.error ? `<div class="warn-box">${esc(a.error)}</div>` : `
  ${!app ? `<div class="card"><h2>No Android app in this project yet</h2>
    <p class="sub">SleepPilot builds Gradle-based Android projects (an app module with the <code>com.android.application</code> plugin). ${info?.godot ? 'This is a Godot project: export the APK from Godot (Project → Export → Android).' : 'Start a new project from an Android template on the Home screen, or let the agent create one: describe the app in the Goal and say "Android app, build an APK with Gradle".'}</p>
    ${(info?.notes || []).map((n) => `<div class="hint">• ${esc(n)}</div>`).join('')}
  </div>` : `
  <div class="grid grid-2">
    ${appCardHtml(a)}
    ${buildCardHtml(a)}
  </div>
  ${buildLogHtml(a)}
  ${artifactsCardHtml(a)}
  <div class="grid grid-2">
    ${devicesCardHtml(a)}
    ${signingCardHtml(a)}
  </div>`}
  ${toolchainCardHtml()}`}`;
  const log = $('#androidLog');
  if (log) log.scrollTop = log.scrollHeight;
}

function appCardHtml(a) {
  const info = a.info;
  const m = info.appModule;
  const hasCheck = (S.project.checks || []).some((c) => c.type === 'android-build' && c.enabled);
  return `<div class="card">
    <div class="card-head"><h2>App</h2></div>
    <div class="kv">
      <div>Application id</div><div class="mono">${esc(m.applicationId || '—')}</div>
      <div>Version</div><div>${esc(m.versionName || '—')} <span class="hint">(code ${esc(m.versionCode ?? '—')})</span></div>
      <div>SDK levels</div><div>min ${esc(m.minSdk ?? '—')} · target ${esc(m.targetSdk ?? '—')} · compile ${esc(m.compileSdk ?? '—')}</div>
      <div>Module</div><div class="mono">${esc(m.gradlePath || '(root)')} <span class="hint">${esc(m.buildFile || '')}</span></div>
      <div>Language</div><div>${m.kotlin ? 'Kotlin' : 'Java'}${m.compose ? ' · Jetpack Compose' : ''}</div>
      <div>Gradle project</div><div class="mono">${esc(info.gradleRootRel === '.' ? '(project folder)' : info.gradleRootRel)}${info.agp ? ` <span class="hint">AGP ${esc(info.agp)}</span>` : ''}</div>
      <div>Gradle wrapper</div><div>${info.wrapper?.complete ? `${badge('OK', 'badge-ok')} ${esc(info.wrapper.version || '')}` : badge(info.wrapper?.properties ? 'incomplete' : 'none', 'badge-warn')} <button class="btn btn-small" data-act="androidWrapper">${info.wrapper?.complete ? 'Repair' : 'Add wrapper'}</button></div>
      <div>Build check</div><div>${hasCheck ? `${badge('on', 'badge-ok')} <span class="hint">every task must keep the app building</span>` : `${badge('off', 'badge-muted')} <button class="btn btn-small" data-act="androidAddCheck">Verify every task with an Android build</button>`}</div>
      <div>Run check</div><div>${(S.project.checks || []).some((c) => c.type === 'android-run' && c.enabled) ? `${badge('on', 'badge-ok')} <span class="hint">after each build the app is started on a phone/emulator and must not crash</span>` : `${badge('off', 'badge-muted')} <button class="btn btn-small" data-act="androidAddRunCheck" title="Needs a USB phone with USB debugging, or an emulator image (Android Studio → Device Manager). An emulator is started without a window when no device is connected.">Also start the app after each build</button>`}</div>
    </div>
    ${(info.notes || []).map((n) => `<div class="hint" style="margin-top:6px">• ${esc(n)}</div>`).join('')}
  </div>`;
}

function buildCardHtml(a) {
  const b = a.build;
  const running = !!b?.running;
  const ready = !!a.toolchain?.ready;
  return `<div class="card">
    <div class="card-head"><h2>Build</h2>${b ? buildStateBadge(b) : ''}</div>
    <div class="row">
      <button class="btn btn-primary" data-act="androidBuild" data-variant="debug" data-kind="apk" ${running || !ready ? 'disabled' : ''}>Debug APK</button>
      <button class="btn" data-act="androidBuild" data-variant="release" data-kind="apk" ${running || !ready ? 'disabled' : ''}>Release APK</button>
      <button class="btn" data-act="androidBuild" data-variant="release" data-kind="aab" ${running || !ready ? 'disabled' : ''} title="Android App Bundle for Google Play">Release AAB (Play)</button>
      ${running ? '<button class="btn btn-danger" data-act="androidCancel">Cancel</button>' : ''}
    </div>
    ${!ready ? '<div class="hint" style="margin-top:8px">Set up the toolchain below first (JDK 17+ and the Android SDK).</div>' : ''}
    <div class="hint" style="margin-top:8px">Debug APKs install directly on a phone. Release builds are signed with this project's SleepPilot key ${a.signing?.exists ? '(set up)' : '<b>(not created yet — see Release signing)</b>'}. The first build downloads dependencies and can take several minutes.</div>
    ${b ? `<div class="kv" style="margin-top:10px">
      <div>Last build</div><div>${esc(b.variant)} ${esc(b.kind?.toUpperCase())} · ${esc(b.task || '')} · ${fmtTime(b.startedAt)}${b.durationMs ? ` · ${fmtDur(b.durationMs)}` : ''}</div>
      ${running ? `<div>Now</div><div class="mono">${esc(b.currentTask || 'starting Gradle…')}</div>` : ''}
      ${b.exported?.length ? `<div>Copied to</div><div class="mono mono-wrap">${b.exported.map(esc).join('<br>')}</div>` : ''}
    </div>` : ''}
    ${b?.diagnosis ? `<div class="warn-box" style="margin-top:10px"><b>What went wrong:</b><pre style="white-space:pre-wrap;margin:6px 0">${esc(b.diagnosis.summary)}</pre>${(b.diagnosis.hints || []).map((h) => `<div>→ ${esc(h)}</div>`).join('')}</div>` : ''}
  </div>`;
}

function buildStateBadge(b) {
  if (b.running) return '<span class="live-indicator"><span class="spinner"></span> building</span>';
  return b.ok ? badge('succeeded', 'badge-ok') : b.state === 'cancelled' ? badge('cancelled', 'badge-muted') : badge(b.state === 'timed_out' ? 'timed out' : 'failed', 'badge-bad');
}

function buildLogHtml(a) {
  const b = a.build;
  if (!b) return '';
  return `<div class="card"><div class="card-head"><h2>Build log</h2><span class="hint">${num((b.log || []).length)} line(s)</span></div><pre class="log-box android-log" id="androidLog">${esc((b.log || []).join('\n'))}</pre></div>`;
}

function artifactsCardHtml(a) {
  const rows = [...(a.artifacts || []).map((x) => ({ ...x, where: x.path })), ...(a.exports || []).map((x) => ({ ...x, where: x.name, exportRow: true }))];
  const usable = (WB.devices?.devices || []).filter((d) => d.usable);
  return `<div class="card">
    <div class="card-head"><h2>APKs and bundles</h2><span class="hint">Exports: <span class="mono">${esc(a.exportDir || '')}</span></span></div>
    ${rows.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>File</th><th>Variant</th><th>Version</th><th>Size</th><th>Signed</th><th>ABIs</th><th>Built</th><th></th></tr></thead><tbody>
    ${rows.map((x) => {
      const d = x.details || {};
      const m = d.manifest || {};
      const href = `/api/projects/${encodeURIComponent(S.projectId)}/android/file?path=${encodeURIComponent(x.exportRow ? x.name : x.path)}`;
      return `<tr>
        <td><span class="mono">${esc(x.exportRow ? `exports/${x.name}` : x.path)}</span></td>
        <td>${esc(x.variant || (x.exportRow ? 'export' : '—'))}</td>
        <td>${esc(m.versionName || '—')}</td>
        <td>${fmtSize(x.size)}</td>
        <td>${d.signed == null ? '—' : d.signed ? badge(d.signature?.v2plus ? 'v2+' : 'v1', 'badge-ok') : badge('unsigned', 'badge-warn')}</td>
        <td class="hint">${esc((d.abis || []).join(', ') || (d.abis ? 'any' : '—'))}</td>
        <td class="hint">${fmtTime(x.mtimeMs)}</td>
        <td><div class="row">
          <a class="btn btn-small" href="${href}" download>Download</a>
          ${x.kind === 'apk' && usable.length ? `<button class="btn btn-small" data-act="androidInstall" data-file="${esc(x.exportRow ? x.name : x.path)}">Install & run</button>` : ''}
        </div></td>
      </tr>`;
    }).join('')}</tbody></table></div>` : '<div class="empty">No APK built yet. Use "Debug APK" above.</div>'}
    <div class="hint" style="margin-top:8px">${onPhone() ? 'Tap Download to save the APK on this phone, then open it to install (allow "Install unknown apps" for your browser once).' : 'On the phone (Settings → Phone) the Download button saves the APK straight to the phone.'}</div>
    ${WB.installResult ? `<div class="${WB.installResult.ok ? 'info-box' : 'warn-box'}" style="margin-top:8px">${WB.installResult.ok ? `Installed${WB.installResult.launched ? ' and started' : ''}${WB.installResult.packageName ? ` (${esc(WB.installResult.packageName)})` : ''}.` : `<b>${esc(WB.installResult.error)}</b>${WB.installResult.hint ? `<div>→ ${esc(WB.installResult.hint)}</div>` : ''}`}</div>` : ''}
  </div>`;
}

function devicesCardHtml() {
  const d = WB.devices;
  return `<div class="card">
    <div class="card-head"><h2>Devices</h2><span class="spacer"></span><button class="btn btn-small" data-act="androidDevices">${d ? 'Refresh' : 'Look for devices'}</button></div>
    ${!d ? '<div class="hint">Connect a phone by USB with USB debugging on (Settings → About phone → tap "Build number" 7 times → Developer options → USB debugging), or start an emulator.</div>' : d.error ? `<div class="warn-box">${esc(d.error)}</div>` : d.devices.length ? d.devices.map((x) => `<label class="check"><input type="radio" name="androidDevice" value="${esc(x.serial)}" ${x.usable ? '' : 'disabled'} ${WB.selectedDevice === x.serial || (!WB.selectedDevice && x.usable) ? 'checked' : ''}> <span><b>${esc(x.model || x.serial)}</b> <span class="hint mono">${esc(x.serial)}</span> ${x.usable ? badge(x.emulator ? 'emulator' : 'ready', 'badge-ok') : badge(x.state, 'badge-warn')}${x.state === 'unauthorized' ? '<div class="hint">Unlock the phone and allow USB debugging.</div>' : ''}</span></label>`).join('') : '<div class="hint">No device is connected.</div>'}
    ${d?.devices?.some((x) => x.usable) ? `<div class="row" style="margin-top:8px"><button class="btn btn-small" data-act="androidLogcat">Show recent errors (logcat)</button></div>` : ''}
    ${WB.logcat ? `<pre class="log-box" style="height:220px;margin-top:8px">${esc(WB.logcat.join('\n') || '(no errors in the device log)')}</pre>` : ''}
  </div>`;
}

function signingCardHtml(a) {
  const s = a.signing || {};
  return `<div class="card">
    <div class="card-head"><h2>Release signing</h2>${s.exists ? badge('key ready', 'badge-ok') : badge('no key', 'badge-muted')}</div>
    ${s.exists ? `<div class="kv">
      <div>Keystore</div><div class="mono mono-wrap">${esc(s.storeFile)}</div>
      <div>Alias</div><div class="mono">${esc(s.keyAlias)}</div>
      <div>Owner</div><div>${esc(s.dname || '')}</div>
      <div>Created</div><div>${fmtTime(s.createdAt)} · valid ${esc(s.validityYears)} years</div>
      ${s.sha256 ? `<div>SHA-256</div><div class="mono mono-wrap" style="font-size:11px">${esc(s.sha256)}</div>` : ''}
      <div>Password</div><div>${s.passwordStored ? 'stored in SleepPilot\'s credential file' : '<b>missing</b> — release builds cannot be signed'}</div>
    </div>
    <div class="warn-box" style="margin-top:10px"><b>Back up the keystore file.</b> Google Play and phones only accept updates signed with the same key. If it is lost, the app cannot be updated under the same id.</div>` : `
    <p class="sub" style="margin:0 0 8px">Release APKs and AABs must be signed. SleepPilot creates a key for this project with the JDK's keytool, keeps it in its data folder (never in the project) and signs release builds with it.</p>
    <div class="grid grid-3"><div><label>Name / developer</label><input type="text" id="sgName" value="${esc(S.project.name)}"></div><div><label>Organisation</label><input type="text" id="sgOrg" placeholder="optional"></div><div><label>Country (2 letters)</label><input type="text" id="sgCountry" maxlength="2" placeholder="TR"></div></div>
    <div class="row" style="margin-top:10px"><button class="btn btn-primary" data-act="androidCreateKey">Create release key</button></div>`}
  </div>`;
}

export function onAndroidBuildEvent(data) {
  if (!data || data.projectId !== S.projectId || !WB.android || WB.android.error) return;
  const finished = WB.android.build?.running && !data.build?.running;
  WB.android.build = data.build;
  if (S.view !== 'android') return;
  if (finished) {
    loadAndroid().then(() => S.view === 'android' && renderAndroidView()).catch(() => {});
    return;
  }
  const log = $('#androidLog');
  if (log && data.build?.running) {
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    log.textContent = (data.build.log || []).join('\n');
    if (atBottom) log.scrollTop = log.scrollHeight;
    // The build card is the second card of the first row (App | Build).
    const buildCard = document.querySelectorAll('#main .grid.grid-2 > .card')[1];
    if (buildCard) buildCard.outerHTML = buildCardHtml(WB.android);
    return;
  }
  renderAndroidView();
}

export function onAndroidToolchainEvent(data) {
  if (data?.projectChanged) {
    if (data.projectChanged === S.projectId && S.view === 'android') loadAndroid().then(() => S.view === 'android' && renderAndroidView()).catch(() => {});
    return;
  }
  if (!WB.androidTc) return;
  if (data?.download) WB.androidTc.download = data.download;
  if (data?.download?.state === 'done') {
    loadAndroid(S.projectId, { force: true }).then(() => (S.view === 'android' ? renderAndroidView() : S.view === 'settings' && rerender())).catch(() => {});
    return;
  }
  if (S.view === 'android') renderAndroidView();
  else if (S.view === 'settings' && S.settingsTab === 'android') rerender();
}

export function androidSettingsHtml() {
  const s = WB.androidTc?.settings || S.state?.settings?.android || {};
  return `<div class="card flat">
    <div class="card-head"><h2>Android build paths</h2><span class="hint">Leave empty to detect automatically</span></div>
    <p class="sub" style="margin:0 0 10px">SleepPilot looks for Android Studio's bundled JDK and SDK, JAVA_HOME / ANDROID_HOME and the usual install folders. Set a path only when the detection picks the wrong one.</p>
    <label>JDK folder (JDK 17 or newer)</label><div class="row"><input type="text" id="anJdk" class="grow" value="${esc(s.jdkHome || '')}" placeholder="auto: Android Studio's jbr, JAVA_HOME, …"><button class="btn" data-act="pickDir" data-for="anJdk">Browse…</button></div>
    <label>Android SDK folder</label><div class="row"><input type="text" id="anSdk" class="grow" value="${esc(s.sdkDir || '')}" placeholder="auto: %LOCALAPPDATA%\\Android\\Sdk, ANDROID_HOME, …"><button class="btn" data-act="pickDir" data-for="anSdk">Browse…</button></div>
    <label>Gradle executable (only for projects without gradlew)</label><input type="text" id="anGradle" value="${esc(s.gradlePath || '')}" placeholder="auto: downloaded by SleepPilot, GRADLE_HOME, PATH, …">
    <div class="row" style="margin-top:10px"><button class="btn btn-primary" data-act="androidSavePaths">Save and check again</button></div>
  </div>
  <div style="margin-top:14px">${toolchainCardHtml()}</div>`;
}

// ------------------------------------------------------------------ actions

export const WB_ACTIONS = {
  wsSave: async (el) => {
    const dir = $(`#${el.dataset.input}`)?.value.trim();
    if (!dir) return toast('Enter or choose a folder.', true);
    WB.workspace = await api('POST', '/api/workspace', { dir });
    S.state = await api('GET', '/api/state');
    toast('Workspace ready.');
    rerender();
  },
  wsClear: async () => {
    if (!confirm('Stop using the workspace? Its folders and projects are not deleted.')) return;
    WB.workspace = await api('POST', '/api/workspace', { dir: null });
    S.state = await api('GET', '/api/state');
    rerender();
  },
  wsSettings: async () => {
    S.settingsTab = 'workspace';
    document.querySelector('.nav-btn[data-view="settings"]')?.click();
  },
  wsOpenFolder: async (el) => {
    const p = await api('POST', '/api/workspace/open', { folder: el.dataset.folder });
    toast('Project opened.');
    await loadWorkspace();
    location.hash = '';
    return p;
  },
  previewStart: async () => {
    WB.previewErrors = [];
    WB.preview = await api('POST', `/api/projects/${S.projectId}/preview/start`, {});
    renderPreviewView();
  },
  previewStop: async () => {
    WB.preview = await api('POST', `/api/projects/${S.projectId}/preview/stop`, {});
    renderPreviewView();
  },
  previewReload: () => {
    const f = $('#previewFrame');
    if (f) {
      WB.previewErrors = [];
      f.src = f.src;
    }
  },
  previewDevice: (el) => {
    WB.previewDevice = el.dataset.device;
    localStorage.setItem('sp.previewDevice', WB.previewDevice);
    renderPreviewView();
  },
  previewRotate: () => {
    WB.previewLandscape = !WB.previewLandscape;
    localStorage.setItem('sp.previewLandscape', WB.previewLandscape ? '1' : '0');
    renderPreviewView();
  },
  previewClearErrors: () => {
    WB.previewErrors = [];
    renderPreviewView();
  },
  previewSave: async () => {
    const body = {
      mode: $('#pvMode')?.value,
      root: $('#pvRoot')?.value.trim(),
      entry: $('#pvEntry')?.value.trim(),
      url: $('#pvUrl')?.value.trim(),
      command: $('#pvCommand')?.value.trim(),
      commandApproved: !!$('#pvApproved')?.checked,
      autoStart: !!$('#pvAuto')?.checked,
    };
    const running = WB.preview?.view?.running;
    WB.preview = await api('POST', `/api/projects/${S.projectId}/preview/config`, body);
    if (running) WB.preview = await api('POST', `/api/projects/${S.projectId}/preview/start`, {});
    toast('Preview settings saved.');
    renderPreviewView();
  },
  androidRefresh: async () => {
    await loadAndroid();
    renderAndroidView();
  },
  androidRecheck: async () => {
    await loadAndroid(S.projectId, { force: true });
    if (S.view === 'android') renderAndroidView();
    else rerender();
  },
  androidPaths: () => {
    S.settingsTab = 'android';
    document.querySelector('.nav-btn[data-view="settings"]')?.click();
  },
  androidSavePaths: async () => {
    const android = { jdkHome: $('#anJdk')?.value.trim() || null, sdkDir: $('#anSdk')?.value.trim() || null, gradlePath: $('#anGradle')?.value.trim() || null };
    S.state = await api('POST', '/api/settings', { android });
    await loadAndroid(S.projectId, { force: true });
    toast('Android paths saved.');
    rerender();
  },
  androidDownloadGradle: async () => {
    const dl = await api('POST', '/api/android/gradle/download', {});
    if (WB.androidTc) WB.androidTc.download = dl;
    if (S.view === 'android') renderAndroidView();
    else rerender();
  },
  androidBuild: async (el) => {
    const build = await api('POST', `/api/projects/${S.projectId}/android/build`, { variant: el.dataset.variant, kind: el.dataset.kind });
    WB.android.build = build;
    renderAndroidView();
  },
  androidCancel: async () => {
    await api('POST', `/api/projects/${S.projectId}/android/cancel`, {});
  },
  androidWrapper: async () => {
    toast('Creating the Gradle wrapper (runs Gradle once)…');
    const r = await api('POST', `/api/projects/${S.projectId}/android/wrapper`, {});
    toast(`Gradle wrapper ${r.version} added.`);
    await loadAndroid();
    renderAndroidView();
  },
  androidAddRunCheck: async () => {
    await api('POST', `/api/projects/${S.projectId}/android/check`, { run: true });
    S.project = (await api('GET', `/api/projects/${S.projectId}`)).project;
    toast('Android run check added: after each build the app is started on a device and must not crash.');
    renderAndroidView();
  },
  androidAddCheck: async () => {
    await api('POST', `/api/projects/${S.projectId}/android/check`, {});
    S.project = (await api('GET', `/api/projects/${S.projectId}`)).project;
    toast('Android build check added: every task must keep the app building.');
    renderAndroidView();
  },
  androidDevices: async () => {
    WB.devices = await api('GET', '/api/android/devices');
    const first = WB.devices.devices?.find((d) => d.usable);
    if (!WB.selectedDevice || !WB.devices.devices?.some((d) => d.serial === WB.selectedDevice)) WB.selectedDevice = first?.serial || null;
    renderAndroidView();
  },
  androidPickDevice: (el) => {
    WB.selectedDevice = el.value;
  },
  androidInstall: async (el) => {
    toast('Installing on the device…');
    WB.installResult = await api('POST', `/api/projects/${S.projectId}/android/install`, { serial: WB.selectedDevice, file: el.dataset.file, launch: true });
    renderAndroidView();
  },
  androidLogcat: async () => {
    const r = await api('POST', `/api/projects/${S.projectId}/android/logcat`, { serial: WB.selectedDevice });
    WB.logcat = r.lines || [];
    renderAndroidView();
  },
  androidCreateKey: async () => {
    if (!confirm('Create the release signing key for this project? It cannot be replaced later without losing the ability to update a published app.')) return;
    await api('POST', `/api/projects/${S.projectId}/android/signing`, { commonName: $('#sgName')?.value.trim(), organization: $('#sgOrg')?.value.trim(), country: $('#sgCountry')?.value.trim() });
    toast('Release key created.');
    await loadAndroid();
    renderAndroidView();
  },
};

/** Show the application-id field only for Android templates. */
export function onTemplateChange() {
  const tpl = $('#npTemplate')?.value || 'blank';
  const isAndroid = (S.state?.templates || []).find((t) => t.id === tpl)?.android;
  const row = $('#npAndroidRow');
  if (row) row.hidden = !isAndroid;
  const create = $('#npCreate');
  if (create && tpl !== 'blank') create.checked = true;
}

// ------------------------------------------------------------------ MCP servers (Settings → MCP)

export async function loadMcp() {
  WB.mcp = await api('GET', '/api/mcp');
  return WB.mcp;
}

export function mcpSettingsHtml() {
  const m = WB.mcp;
  if (!m) return '<div class="empty"><span class="spinner"></span> Loading…</div>';
  const engineLabel = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode' };
  const row = (s, i) => `<div class="engine-card" data-mcp="${i}">
    <div class="engine-head">
      <label class="check" style="margin:0"><input type="checkbox" data-f="enabled" ${s.enabled ? 'checked' : ''}> <b>${esc(s.name)}</b></label>
      <span class="hint mono">${esc(s.url || [s.command, ...(s.args || [])].join(' '))}</span>
      <span class="spacer"></span>
      <button class="btn btn-small btn-ghost" data-act="mcpRemove" data-i="${i}">Remove</button>
    </div>
    <div class="grid grid-2" style="margin-top:8px">
      <div><label>Command or URL</label><input type="text" data-f="target" value="${esc(s.url || [s.command, ...(s.args || [])].join(' '))}"></div>
      <div><label>Who may use it</label><select data-f="roles"><option value="developer" ${s.roles !== 'all' ? 'selected' : ''}>Developer only</option><option value="all" ${s.roles === 'all' ? 'selected' : ''}>All roles (manager and reviewer stay read-only)</option></select></div>
    </div>
    <div class="row" style="margin-top:6px">${Object.entries(engineLabel).map(([id, l]) => `<label class="check" style="margin:0"><input type="checkbox" data-engine="${id}" ${s.engines?.includes(id) ? 'checked' : ''}> ${esc(l)}</label>`).join('')}</div>
    <label>Environment variables it needs (names, comma-separated)</label>
    <input type="text" data-f="env" value="${esc((s.env || []).join(', '))}" placeholder="e.g. GITHUB_TOKEN">
    ${(s.env || []).length ? `<div class="hint">${s.env.map((n) => `${esc(n)}: ${m.envSet?.includes(n) ? '<span style="color:var(--ok)">set</span>' : `<span style="color:var(--warn)">not set</span> <a href="#" data-act="mcpSetEnv" data-name="${esc(n)}">set value…</a>`}`).join(' · ')}</div>` : ''}
  </div>`;
  return `<div class="card flat">
    <div class="card-head"><h2>MCP servers for the agents</h2><span class="hint">Claude Code, Codex and OpenCode</span></div>
    <p class="sub" style="margin:0 0 10px">MCP servers give the coding agents extra tools: a real browser, current library documentation, GitHub and more. One list for all projects. Secrets (tokens) are stored in SleepPilot's credential file, never in the settings. Changes apply from the next agent turn; OpenCode restarts by itself when no run is active.</p>
    ${(m.servers || []).map(row).join('') || '<div class="empty">No MCP server yet.</div>'}
    <div class="row" style="margin-top:10px">
      ${(m.presets || []).filter((p) => !(m.servers || []).some((s) => s.name === p.name)).map((p) => `<button class="btn btn-small" data-act="mcpAddPreset" data-id="${esc(p.id)}" title="${esc(p.label)}">+ ${esc(p.label.split(' — ')[0])}</button>`).join('')}
      <button class="btn btn-small" data-act="mcpAddCustom">+ Custom server</button>
      <span class="spacer"></span>
      <button class="btn btn-primary" data-act="mcpSave">Save</button>
    </div>
    <div class="hint" style="margin-top:8px">Local servers usually start with <span class="mono">npx</span> (Node.js) and download on first use. "Developer only" is the safe default: the manager and reviewer stay read-only either way.</div>
  </div>`;
}

function readMcpForm() {
  return [...document.querySelectorAll('[data-mcp]')].map((card) => {
    const i = Number(card.dataset.mcp);
    const prev = WB.mcp.servers[i] || {};
    const target = card.querySelector('[data-f="target"]').value.trim();
    const isUrl = /^https?:\/\//i.test(target);
    const parts = target.match(/"[^"]*"|\S+/g)?.map((p) => p.replace(/^"|"$/g, '')) || [];
    return {
      name: prev.name,
      enabled: card.querySelector('[data-f="enabled"]').checked,
      ...(isUrl ? { url: target } : { command: parts[0] || '', args: parts.slice(1) }),
      roles: card.querySelector('[data-f="roles"]').value,
      engines: [...card.querySelectorAll('[data-engine]')].filter((c) => c.checked).map((c) => c.dataset.engine),
      env: card.querySelector('[data-f="env"]').value.split(/[,\s]+/).filter(Boolean),
    };
  });
}

Object.assign(WB_ACTIONS, {
  mcpAddPreset: async (el) => {
    const p = WB.mcp.presets.find((x) => x.id === el.dataset.id);
    if (!p) return;
    WB.mcp.servers = [...readMcpForm(), { name: p.name, enabled: true, command: p.command, args: p.args, env: p.env, roles: p.roles, engines: WB.mcp.engines }];
    rerender();
  },
  mcpAddCustom: async () => {
    const name = prompt('Name of the MCP server (letters, digits, - and _):', 'myserver');
    if (!name) return;
    const target = prompt('Command (e.g. npx -y some-mcp-server) or URL (https://…):', '');
    if (!target) return;
    const isUrl = /^https?:\/\//i.test(target.trim());
    const parts = target.trim().split(/\s+/);
    WB.mcp.servers = [...readMcpForm(), { name: name.trim(), enabled: true, ...(isUrl ? { url: target.trim() } : { command: parts[0], args: parts.slice(1) }), env: [], roles: 'developer', engines: WB.mcp.engines }];
    rerender();
  },
  mcpRemove: async (el) => {
    const list = readMcpForm();
    list.splice(Number(el.dataset.i), 1);
    WB.mcp.servers = list;
    rerender();
  },
  mcpSave: async () => {
    const before = WB.mcp.servers.length;
    WB.mcp = await api('POST', '/api/mcp', { servers: readMcpForm() });
    toast(WB.mcp.servers.length < before ? 'Saved. Entries without a valid name or command were dropped.' : 'MCP servers saved.', WB.mcp.servers.length < before);
    rerender();
  },
  mcpSetEnv: async (el) => {
    const name = el.dataset.name;
    const value = prompt(`Value for ${name} (stored in SleepPilot's credential file, never shown again):`);
    if (!value) return;
    await api('POST', '/api/secrets/env', { name, value });
    await loadMcp();
    toast(`${name} saved.`);
    rerender();
  },
});
