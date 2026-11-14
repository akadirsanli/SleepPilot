import { TASK_STATUS_LABELS } from '../orchestrator/tasks.mjs';
import { STOP_REASONS } from '../orchestrator/run-controller.mjs';

const fmtTime = (t) => (t ? new Date(t).toLocaleString('en-GB') : '—');
const fmtDur = (ms) => {
  if (ms == null) return '—';
  const m = Math.round(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
};
const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const RUN_STATE = { created: 'created', running: 'running', paused: 'paused', waiting_user: 'waiting for the user', completed: 'completed', stopped: 'stopped', failed: 'failed' };
const STEER = { pending: 'pending', applying: 'applying', applied: 'applied', not_applied: 'not applied' };
const CHECK = { passed: 'passed', failed: 'failed', skipped: 'skipped', error: 'could not run' };
const ITER = { running: 'running', completed: 'completed', interrupted: 'interrupted', provider_error: 'provider error', not_submitted: 'not sent' };

/** Build the final report (Markdown) from persisted run state and iteration records. */
export function buildReport({ project, run, iterations, stats = null }) {
  const tasks = run.tasks || [];
  const by = (s) => tasks.filter((t) => t.status === s);
  const changed = new Map();
  for (const it of iterations) {
    for (const f of it.changes?.added || []) changed.set(f, 'added');
    for (const f of it.changes?.modified || []) if (!changed.has(f)) changed.set(f, 'modified');
    for (const f of it.changes?.deleted || []) changed.set(f, 'deleted');
  }
  const elapsed = run.activeMs + (run.activeSince ? Date.now() - run.activeSince : 0);
  const u = run.usage;
  const engineLabel = run.engine?.label || (run.opencode ? 'OpenCode' : 'Agent engine');
  const engineId = run.engine?.id || 'opencode';
  const lines = [];
  lines.push(`# SleepPilot Run Report — ${project.name}`);
  lines.push('');
  if (run.opencode?.testMode) lines.push('> **TEST MODE:** This run used simulated engines. The results are not a real provider run.\n');
  lines.push(`- **Project folder:** \`${project.dir}\``);
  lines.push(`- **Run ID:** ${run.id}`);
  lines.push(`- **Engine:** ${engineLabel} — ${run.engine?.version || run.opencode?.version || 'unknown'} (${run.engine?.source || run.opencode?.source || '—'})`);
  if (run.activeHarness) lines.push(`- **Final harness:** ${run.activeHarness}`);
  if (run.routingSwitches?.length) lines.push(`- **Harness switches:** ${run.routingSwitches.length} (${run.routingSwitches.map((s) => `${s.role}: ${s.from || '?'} → ${s.to || '?'}`).slice(-8).join('; ')})`);
  if (run.scout?.summary) lines.push(`- **Scout:** ${run.scout.summary}${run.scout.stacks?.length ? ` (${run.scout.stacks.join(', ')})` : ''}`);
  lines.push(`- **Started:** ${fmtTime(run.startedAt)}`);
  lines.push(`- **Ended:** ${fmtTime(run.endedAt)}`);
  lines.push(`- **Active run time:** ${fmtDur(elapsed)} (excluding paused time; limit ${run.limits.durationMin ? fmtDur(run.limits.durationMin * 60000) : 'none'})`);
  lines.push(`- **Iterations:** ${run.iterationCount}${run.limits.maxIterations ? ` / ${run.limits.maxIterations}` : ''}`);
  if (run.overtimeUsed) lines.push(`- **Overtime:** ${run.limits.overtimeMin} min granted ${run.overtimeUsed} time(s) (tasks were not finished when time ran out)`);
  if (run.stopReason?.code === 'objective_completed' && run.limits.durationMin && run.activeMs < run.limits.durationMin * 60_000) lines.push(`- **Finished early:** the tasks were done ${fmtDur(run.limits.durationMin * 60_000 - run.activeMs)} before the time limit; the rest of the time was left unused (no tokens spent).`);
  lines.push(`- **Status:** ${RUN_STATE[run.state] || run.state}${run.stopReason ? ` — ${run.stopReason.label}${run.stopReason.detail ? ': ' + run.stopReason.detail : ''}` : ''}`);
  lines.push(`- **Mode:** ${run.limits.unattended ? 'Sleep mode (unattended)' : 'Supervised'}; permission profile ${run.limits.permissionProfile}; scope ${run.limits.scopeMode === 'creative' ? 'creative' : 'strict (objective only)'}`);
  const ls = run.lineStats;
  if (ls?.net) lines.push(`- **Total change (start → end):** ${ls.net.added.length} files added, ${ls.net.modified.length} modified, ${ls.net.deleted.length} deleted; **source code +${ls.net.additions} / −${ls.net.deletions} lines**${ls.net.generated?.files ? ` (plus ${ls.net.generated.files} generated/build-output files: +${ls.net.generated.additions} / −${ls.net.generated.deletions}, not counted as code)` : ''}`);
  if (ls?.iterations) lines.push(`- **Lines written across iterations (sum):** +${ls.iterations.additions} / −${ls.iterations.deletions}`);
  if (run.carriedOver) lines.push(`- **Carried-over tasks:** ${run.carriedOver.total} (${run.carriedOver.open} open) — previous run ${run.carriedOver.fromRunId}`);
  if (run.autoAnswered?.length) lines.push(`- **Requests closed automatically because nobody answered:** ${run.autoAnswered.length}`);
  if (run.reverse) lines.push(`- **Sleep & Reverse target:** \`${run.reverse.targetDir}\` — ${run.reverse.files} file(s), ${run.reverse.mirrored} mirrored for reading, ${run.reverse.blobs} embedded blob(s)/over-long line(s) summarised${run.reverseIntegrity ? `; **integrity: ${run.reverseIntegrity.ok ? `all ${run.reverseIntegrity.files} file(s) unchanged (SHA-1)` : `CHANGED: ${[...run.reverseIntegrity.changed, ...run.reverseIntegrity.missing].slice(0, 10).join(', ')}`}**` : ''}`);
  if (run.recoveries?.length || run.stalls) lines.push(`- **Interruptions and self-recovery:** the app closed/froze and the run was restarted and continued ${run.recoveries?.length || 0} time(s)${run.stalls ? `; ${run.stalls} stall(s) detected` : ''}`);
  lines.push('');
  lines.push('## Objective');
  const hist = (project.objectiveHistory || []).filter((h) => h.version >= run.objectiveVersionAtStart);
  lines.push(`Version at start ${run.objectiveVersionAtStart}, latest version ${run.objectiveVersion}.`);
  lines.push('');
  lines.push('```');
  lines.push(project.objectiveHistory?.find((h) => h.version === run.objectiveVersion)?.text || project.objective?.text || '');
  lines.push('```');
  const steers = run.steering || [];
  if (steers.length) {
    lines.push('');
    lines.push('### Instructions given during the run');
    for (const s of steers) lines.push(`- **${s.id}** (${fmtTime(s.createdAt)}, ${s.mode === 'interrupt_now' ? 'immediately' : 'after the iteration'}): ${s.text} → **${STEER[s.status] || s.status}**${s.resultingObjectiveVersion ? ` (objective v${s.resultingObjectiveVersion})` : ''}${s.summary ? ` — ${s.summary}` : ''}`);
  }
  if (hist.length > 1) {
    lines.push('');
    lines.push('### Objective history');
    for (const h of hist) lines.push(`- v${h.version} (${fmtTime(h.at)}, ${h.source})${h.instruction ? `: “${h.instruction}”` : ''}`);
  }

  const section = (title, list, extra) => {
    lines.push('');
    lines.push(`## ${title} (${list.length})`);
    if (!list.length) lines.push('_None._');
    for (const t of list) lines.push(`- **[${t.id}] ${t.title}** — ${extra ? extra(t) : ''}`);
  };
  const lastEvidence = (t) => {
    const e = (t.evidence || []).at(-1);
    if (!e) return 'no evidence';
    const checks = e.checks.filter((c) => c.status !== 'skipped').map((c) => `${c.name}: ${CHECK[c.status] || c.status}`).join(', ') || 'no check ran';
    return `iteration #${e.iteration}; checks: ${checks}${e.review ? `; reviewer: ${e.review}` : ''}`;
  };
  section('Completed and verified', by('verified'), lastEvidence);
  section('Implemented but not verified', by('implemented_unverified'), (t) => `${t.history.at(-1)?.note || ''} (${lastEvidence(t)})`);
  section('Failed or blocked tasks', [...by('test_failed'), ...by('blocked')], (t) => `${TASK_STATUS_LABELS[t.status]}: ${t.history.at(-1)?.note || ''}`);
  section('Tasks waiting for a user decision', by('waiting_user'), (t) => t.question || t.history.at(-1)?.note || '');
  section('Pending tasks', [...by('pending'), ...by('in_progress')], (t) => `priority P${t.priority}`);
  section('Cancelled tasks', by('cancelled'), (t) => t.history.at(-1)?.note || '');

  lines.push('');
  lines.push(`## Changed files (${ls?.net ? ls.net.files.length : changed.size})`);
  lines.push('SleepPilot measures this by fingerprinting the project files before and after every iteration (independent of Git).');
  if (ls?.net) {
    if (!ls.net.files.length) lines.push('_No net change since the start of the run._');
    const st = { added: 'added', modified: 'modified', deleted: 'deleted' };
    for (const f of ls.net.files) lines.push(`- \`${f.file}\` — ${st[f.status] || f.status}${f.binary ? ' (binary/large file, no line count)' : `, +${f.additions} / −${f.deletions}`}`);
  } else {
    if (!changed.size) lines.push('_No changes detected._');
    for (const [f, s] of [...changed].sort()) lines.push(`- \`${f}\` — ${s}`);
  }

  lines.push('');
  lines.push('## Iterations and test results');
  lines.push('| # | Task | Status | Lines | Checks | Review | Decision | Duration |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const it of run.iterations || []) {
    lines.push(`| ${it.n} | ${esc(it.taskId)} ${esc(it.taskTitle)} | ${esc(it.evaluation ? TASK_STATUS_LABELS[it.evaluation.status] || it.evaluation.status : ITER[it.status] || it.status)} | ${it.lines ? `+${it.lines.additions}/−${it.lines.deletions}` : '—'} | ${esc(it.checks.map((c) => `${c.name}: ${CHECK[c.status] || c.status}`).join(', ') || '—')} | ${esc(it.review || '—')} | ${esc(it.decision || '—')} | ${it.endedAt ? fmtDur(it.endedAt - it.startedAt) : '—'} |`);
  }

  if (stats?.run) statsSection(lines, stats);

  lines.push('');
  lines.push('## Models and usage');
  lines.push(
    engineId === 'opencode'
      ? 'Token counts are the values OpenCode received from the provider. **Cost is an API-equivalent estimate computed from the model price table; it is not an actual charge on an OpenCode subscription.**'
      : 'Token counts are reported by the provider when it returns usage. **Cost is an estimate from the configured model price, when one is known; it is not an invoice.**',
  );
  lines.push(`- Total tokens: input ${u.tokens.input.toLocaleString('en-US')}, output ${u.tokens.output.toLocaleString('en-US')}, reasoning ${u.tokens.reasoning.toLocaleString('en-US')}, cache read ${u.tokens.cacheRead.toLocaleString('en-US')}`);
  lines.push(`- Estimated cost (API equivalent): $${u.cost.toFixed(4)}`);
  for (const [role, r] of Object.entries(u.byRole)) lines.push(`- ${ROLE[role] || role}: ${r.turns} turns, ${(r.tokens.input + r.tokens.output).toLocaleString('en-US')} tokens, ~$${r.cost.toFixed(4)}`);
  lines.push(`- Models used: ${Object.keys(u.models).join(', ') || 'unknown'}`);
  if (engineId === 'opencode') {
    const go = run.goUsage?.data?.go;
    if (go) lines.push(`- OpenCode Go allowance (last read ${fmtTime(run.goUsage.fetchedAt)}): rolling ${go.rolling.percent}%, weekly ${go.weekly.percent}%, monthly ${go.monthly.percent}%`);
    else lines.push(`- OpenCode Go remaining allowance: unknown${run.goUsage?.supported === false ? ' (this OpenCode version does not report it)' : ''}`);
  }
  if (run.limits.models?.developer && run.limits.models?.reviewer && `${run.limits.models.developer.providerID}/${run.limits.models.developer.id}` === `${run.limits.models.reviewer.providerID}/${run.limits.models.reviewer.id}`) {
    lines.push('- Note: the developer and the reviewer used the same model; the review is not equivalent to an independent human review.');
  }

  lines.push('');
  lines.push('## Open issues');
  const issues = [];
  for (const t of tasks) if (t.status === 'implemented_unverified') issues.push(`[${t.id}] not verified — ${t.history.at(-1)?.note || ''}`);
  for (const it of iterations) for (const i of it.review?.issues || []) issues.push(`#${it.n} reviewer: ${i}`);
  for (const a of run.autoAnswered || []) issues.push(`Nobody answered, automatically ${a.type === 'permission' ? `rejected: permission ${a.action} ${(a.resources || []).join(' ')}` : `closed: question “${a.title}”`} (iteration #${a.iteration ?? '?'})`);
  for (const t of tasks) if (t.question && t.status !== 'verified') issues.push(`[${t.id}] question waiting for an answer: ${t.question}`);
  for (const r of run.recoveries || []) issues.push(`${fmtTime(r.at)}: the app closed/froze — ${r.reason}${r.detail ? ` (${r.detail})` : ''}; continued by itself after iteration #${r.iteration ?? '?'}`);
  if (run.backup && !run.backup.ok && !run.backup.skipped) issues.push(`Backup failed: ${run.backup.error}`);
  if (run.backup?.ok) issues.push(`Pre-run backup: ${run.backup.path} (coverage: ${run.backup.coverage})`);
  if (run.gitAtStart?.dirty) issues.push(`There were ${run.gitAtStart.changeCount} uncommitted change(s) at the start; SleepPilot did not commit.`);
  if (!issues.length) lines.push('_None._');
  for (const i of issues.slice(0, 60)) lines.push(`- ${i}`);

  lines.push('');
  lines.push('## Suggested next steps');
  const next = [];
  if (by('implemented_unverified').length) next.push('Add command checks for unverified tasks or check them by hand (Project screen → Advanced → Checks).');
  if (by('test_failed').length + by('blocked').length) next.push('Look at the check output of failed/blocked tasks on the Run screen (Tasks tab).');
  if (by('waiting_user').length) next.push('Answer the pending decisions and continue the run.');
  if (by('pending').length) next.push('Start a new run for the pending tasks.');
  next.push('Review the changes and commit them yourself; SleepPilot never commits or pushes automatically.');
  for (const n of next) lines.push(`- ${n}`);
  if (run.reverse || run.reverseIntegrity) {
    lines.push('');
    lines.push('## Reverse & Rust');
    if (run.reverse?.targetPath || project.reverse?.targetPath) lines.push(`- **Target (read-only):** \`${project.reverse?.targetPath || run.reverse?.targetPath}\``);
    lines.push(`- **Mode:** ${project.reverse?.mode === 'rust' ? 'Analyze + Rust It' : 'Analyze'}`);
    if (run.reverse) lines.push(`- **Mirror:** ${run.reverse.files} files (${run.reverse.mirrored} text), ${run.reverse.binaries ?? 0} binary file(s) analysed by the recon step.`);
    if (run.reverseIntegrity) lines.push(`- **Target integrity:** ${run.reverseIntegrity.ok ? `unchanged (SHA-1 verified for ${run.reverseIntegrity.files} files)` : `CHANGED: ${[...run.reverseIntegrity.changed, ...run.reverseIntegrity.missing].slice(0, 20).join(', ')}`}`);
    lines.push(`- **Evidence:** each document cites the target as \`file:line\`; binary claims cite the section/offset from \`_recon/recon.json\`. Rust checks are \`cargo check\` and \`cargo test\`.`);
  }
  if (run.closingReport?.text) {
    lines.push('');
    lines.push(`## ${engineLabel} closing report`);
    lines.push(`> When the run ended, SleepPilot asked ${engineLabel} for this report in a read-only session (\`${run.closingReport.sessionID}\`). A model wrote it, so compare its claims with the measured evidence above.`);
    lines.push('');
    lines.push(run.closingReport.text);
  }
  lines.push('');
  lines.push(`_Report generated by SleepPilot from the actual run records on ${fmtTime(Date.now())}._`);
  return lines.join('\n');
}

const ROLE = { developer: 'Developer', manager: 'Manager', reviewer: 'Reviewer', closing: 'Closing report', preflight: 'Model check' };

/** Measured statistics (same numbers as the report screen's charts) in text form. */
function statsSection(lines, st) {
  const R = st.run;
  const P = st.project;
  lines.push('');
  lines.push('## Statistics');
  lines.push('Values measured by SleepPilot’s file comparison; build output and dependencies (dist/, build/, node_modules, lock files…) do not count as “written code”.');
  lines.push(`- **This run — source code:** +${R.row.added} / −${R.row.deleted} lines${R.row.generatedAdded ? ` (generated files another +${R.row.generatedAdded}, not counted)` : ''}`);
  const roles = Object.entries(R.roles || {}).sort((a, b) => b[1].ms - a[1].ms);
  if (roles.length) lines.push(`- **Time by role:** ${roles.map(([k, v]) => `${ROLE[k] || k} ${fmtDur(v.ms)} (${v.turns} turns)`).join(' · ')}`);
  if (R.files?.length) {
    lines.push('- **Most changed source files:**');
    for (const f of R.files.slice(0, 10)) lines.push(`  - \`${f.file}\` +${f.added} / −${f.deleted}`);
  }
  if (P.runs > 1) lines.push(`- **Project total (${P.runs} runs, ${fmtDur(P.activeMs)}):** source code +${P.added} / −${P.deleted} lines, ${P.iterations} iterations, ${P.verified} tasks verified`);
}

export { STOP_REASONS };
