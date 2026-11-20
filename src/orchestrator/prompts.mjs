import { TASK_STATUS_LABELS } from './tasks.mjs';
import { isGeneratedPath } from '../project/generated.mjs';

/** Report languages the user can choose (the model writes in it; the app itself is English). */
export const REPORT_LANGUAGES = { en: 'English', tr: 'Turkish' };
export const languageName = (code) => REPORT_LANGUAGES[code] || 'English';

const LANG = 'Write all human-readable text (titles, descriptions, notes, questions) in the same language as the OBJECTIVE.';

/**
 * Scope discipline. "strict" (default): the run stays inside the user's objective; the manager and
 * reviewer actively keep it there. "creative": the user explicitly allowed new ideas and features
 * that fit the spirit of the objective.
 */
function scopeBlock(opts = {}) {
  if (opts.scope === 'creative')
    return `SCOPE MODE: CREATIVE (chosen by the user). Beyond the explicit objective you MAY propose new features and ideas that clearly fit its spirit and the project's style, as long as the explicitly requested work keeps priority, nothing requested is broken, and the rules are respected.`;
  return `SCOPE MODE: STRICT (default). Stay inside the user's objective and rules. Do NOT add features, systems, refactors or "nice to have" work the objective does not ask for. Fixing bugs and completing unfinished parts of the requested work is in scope; inventing new scope is not.`;
}

function parallelPlanBlock(opts = {}) {
  if (!(opts.parallel > 1)) return '';
  return `\nPARALLEL DEVELOPERS: SleepPilot runs up to ${opts.parallel} developers AT THE SAME TIME on tasks whose files do not overlap. For EVERY task give "files": the project-relative files or folders (globs allowed, e.g. "ui/charts.js", "module_system/module_caravans.py", "tests/test_caravans.py") it will create or edit — the developer can edit nothing else. Split work so tasks touch different files; keep shared files (README, registries, build scripts) in as few tasks as possible and make those tasks depend on the ones they integrate. A task without "files" runs alone; when deciding, give pending tasks that have no files a scope via task_updates[].files.`;
}

function sleepBlock(opts = {}) {
  if (!opts.unattended) return '';
  return `
SLEEP MODE: the user is asleep and cannot answer questions or approve anything until the run ends. Never wait for the user. When something is ambiguous, choose the most reasonable option consistent with the objective and rules, write the assumption down, and continue.`;
}

function inspectionBlock(insp) {
  if (!insp?.ok) return '(project inspection unavailable)';
  return [
    `Detected kinds: ${insp.kinds.join(', ')}; files: ${insp.totalFiles}`,
    `Top level: ${insp.topLevel.slice(0, 40).join(', ') || '(empty folder)'}`,
    `Extensions: ${Object.entries(insp.extensionCounts).map(([k, v]) => `${k}:${v}`).join(' ')}`,
    insp.git?.isRepo ? `Git: branch ${insp.git.branch || '?'}, ${insp.git.changeCount} uncommitted change(s)` : 'Git: not a repository',
    insp.readme ? `README (start):\n${insp.readme.slice(0, 800)}` : '',
    insp.agentsMd ? `AGENTS.md (start):\n${insp.agentsMd.slice(0, 800)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function checksBlock(checks) {
  const enabled = (checks || []).filter((c) => c.enabled && (c.type !== 'command' || c.approved));
  if (!enabled.length) return 'No automated checks are configured. Work will be recorded as "implemented but not verified" unless the user adds checks.';
  return enabled.map((c) => `- ${c.name}${c.command ? ` (\`${c.command}\`)` : ''}`).join('\n');
}

export function taskTable(tasks, { max = 40 } = {}) {
  if (!tasks.length) return '(no tasks yet)';
  return tasks
    .slice(0, max)
    .map((t) => `- [${t.id}] P${t.priority} ${t.status}${t.attempts ? ` (attempts ${t.attempts})` : ''}${t.dependsOn.length ? ` deps:${t.dependsOn.join(',')}` : ''}: ${t.title}${t.improvement ? ' (improvement)' : ''}`)
    .join('\n');
}

const MANAGER_ROLE = `You are the MANAGER of an autonomous software project run supervised by SleepPilot.
You plan and decide; you never edit files. You may read files in the project folder (read/glob/grep) to understand it.
A separate DEVELOPER agent implements one task at a time. SleepPilot itself runs the configured checks and records evidence.
Never claim that something is verified: only SleepPilot's executed checks determine verification.
Priority scale: 1 = most important, 5 = least important.`;

function managerHead(opts) {
  return `${MANAGER_ROLE}
${scopeBlock(opts)}${sleepBlock(opts)}${parallelPlanBlock(opts)}`;
}

export function planPrompt({ project, objective, rules, inspection, checks, previousTasks = [], opts = {} }) {
  return `${managerHead(opts)}

PROJECT FOLDER: ${project.dir}
OBJECTIVE (version ${objective.version}):
${objective.text}

GENERAL USER RULES:
${rules || '(none)'}

PROJECT INSPECTION:
${inspectionBlock(inspection)}
${opts.scout?.summary ? `\nSCOUT PROFILE (deterministic file/header analysis): ${opts.scout.summary}${opts.scout.stacks?.length ? `; stacks: ${opts.scout.stacks.join(', ')}` : ''}${opts.scout.risks?.length ? `; notes: ${opts.scout.risks.slice(0, 3).join(' | ')}` : ''}\n` : ''}

CHECKS SLEEPPILOT WILL RUN AFTER EACH TASK:
${checksBlock(checks)}
${previousTasks.length ? `\nTASKS FROM THE PREVIOUS RUN (already in the task list with these ids; do NOT repeat finished ones, do not re-create open ones — they stay in the list and will be worked on):\n${taskTable(previousTasks, { max: 60 })}\n` : ''}
Break the objective into 2–12 concrete, independently checkable tasks (in addition to the previous tasks above, if any), ordered so each can be implemented and checked on its own.
Each task must be small enough to finish in ONE developer turn (roughly one focused change in a few files).
${opts.scope === 'creative' ? 'Requested work comes first; you may add a few clearly marked new-idea tasks with lower priority.' : 'Only include work that the objective and rules call for. Do not add unrelated features.'}
${LANG}

Reply with ONLY a JSON object in a \`\`\`json fenced block, exactly this shape:
\`\`\`json
{
  "summary": "One paragraph describing the current project and the approach; write your own text, do not copy this example.",
  "tasks": [
    {"title": "Add the CSV export button", "description": "Add an Export CSV button to src/ui.rs and connect it to the visible table rows.", "type": "coding", "acceptance": ["Clicking Export downloads a CSV containing the visible rows"], "priority": 1, "depends_on": [], "files": ["src/ui.rs"]}
  ],
  "verification_notes": "cargo test and a manual check of the exported file; write real checks, do not copy this example",
  "questions": []
}
\`\`\``;
}

export function decisionPrompt({ objective, tasks, iteration, evaluation, limitsInfo, improvementMode, opts = {} }) {
  return `${managerHead(opts)}

OBJECTIVE (version ${objective.version}):
${objective.text}

TASKS:
${taskTable(tasks)}

LAST ITERATION #${iteration.n} on task [${iteration.taskId}]:
- Developer turn status: ${iteration.turn?.status || 'n/a'}; developer self-report: ${iteration.developerStatus?.status || 'unreported'} ${iteration.developerStatus?.reason || ''}
- Changed files: ${iteration.changes ? [...iteration.changes.added.map((f) => '+' + f), ...iteration.changes.modified.map((f) => '~' + f), ...iteration.changes.deleted.map((f) => '-' + f)].slice(0, 40).join(', ') || 'none detected' : 'unknown'}
- Checks: ${(iteration.checks || []).map((c) => `${c.name}=${c.status}`).join(', ') || 'none ran'}
- Failed check output (tail): ${(iteration.checks || []).filter((c) => c.status === 'failed').map((c) => `${c.name}: ${String(c.output).slice(-800)}`).join('\n') || 'n/a'}
- Reviewer: ${iteration.review ? `${iteration.review.verdict} — ${(iteration.review.issues || []).slice(0, 6).join('; ')}` : 'not run'}
- SleepPilot evaluation: task is now "${evaluation.status}" (${TASK_STATUS_LABELS[evaluation.status] || ''}). ${evaluation.note || ''}

LIMITS: ${limitsInfo}
IMPROVEMENT MODE: ${improvementMode ? (opts.scope === 'creative' ? 'ON (creative) — when all tasks are finished you may propose new improvements and features that fit the spirit of the objective.' : 'ON — when all tasks are finished you may propose at most 3 improvements that stay strictly within the objective and rules.') : 'OFF — never invent new work beyond the objective.'}

Decide the next step. Options:
- "repair": the same task needs another attempt (only if a fix is plausible).
- "continue": move on; optionally name next_task_id.
- "ask_user": a decision only the user can make blocks progress; write user_question.${opts.unattended ? ' (Sleep mode: the question is only recorded for the morning; other tasks continue. Prefer deciding yourself.)' : ''}
- "complete": the objective is fully achieved and no pending task remains worth doing.
You may cancel tasks that became unnecessary (status "cancelled" with reason), reprioritise pending tasks, or add new tasks required by the objective.
If the reviewer reported OUT-OF-SCOPE changes, prefer "repair" so the developer removes or justifies them.
You can NOT mark tasks verified or implemented. ${LANG}

Reply with ONLY a JSON object in a \`\`\`json fenced block:
\`\`\`json
{"decision": "continue", "next_task_id": "T3", "reasoning": "T2 passed its checks; T3 is the next runnable task.", "user_question": null,
 "task_updates": [{"id": "T4", "status": "cancelled", "priority": 2, "reason": "Superseded by T5", "files": ["src/ui.rs"]}],
 "new_tasks": [{"title": "Add a regression test for CSV export", "description": "Cover the export path in tests/export.rs with a small table fixture.", "acceptance": ["cargo test passes"], "priority": 2, "files": ["tests/export.rs"]}]}
\`\`\``;
}

export function steeringPrompt({ objective, tasks, instruction, opts = {} }) {
  return `${managerHead(opts)}

The user changed direction during the run.
CURRENT OBJECTIVE (version ${objective.version}):
${objective.text}

NEW USER INSTRUCTION:
${instruction}

TASKS:
${taskTable(tasks)}

Rewrite the objective so that it reflects the instruction while keeping everything from the old objective that the user did not withdraw.
Completed tasks (verified / implemented) must be kept as they are. Re-prioritise or cancel pending tasks, and add new tasks the instruction requires.
Express "do X first" by giving the new or existing task priority 1 and lowering the others. ${LANG}

Reply with ONLY a JSON object in a \`\`\`json fenced block:
\`\`\`json
{"objective": "The full updated objective in your own words.", "change_summary": "The user wants the report screen before the settings screen; T1 is promoted.",
 "task_updates": [{"id": "T2", "priority": 4, "status": "pending", "reason": "Settings can wait until the report screen is done"}],
 "new_tasks": [{"title": "Build the report screen", "description": "Create the report screen and its data binding.", "acceptance": ["The screen renders the report and handles the empty state"], "priority": 1}]}
\`\`\``;
}

export function improvementPrompt({ objective, tasks, opts = {} }) {
  const creative = opts.scope === 'creative';
  return `${managerHead(opts)}

All planned tasks are finished. IMPROVEMENT MODE is enabled by the user.
OBJECTIVE (version ${objective.version}):
${objective.text}

TASKS:
${taskTable(tasks)}

${
    creative
      ? 'Propose up to 5 tasks: first finish or harden anything requested that is incomplete, then new features or ideas that fit the spirit of the objective and the project.'
      : 'Propose at most 3 improvements that clearly serve the objective and its rules: bugs, unfinished parts of requested features, robustness, edge cases, consistency between the requested systems. Do NOT propose new features or systems the objective does not ask for.'
  }
Do not repeat tasks that were already done or cancelled. If nothing worthwhile remains, return an empty list. ${LANG}

Reply with ONLY a JSON object in a \`\`\`json fenced block:
\`\`\`json
{"new_tasks": [{"title": "Add an empty-state message to the report", "description": "Show a short message when the report has no rows.", "acceptance": ["An empty report shows the message instead of a blank table"], "priority": 3}], "reasoning": "One unfinished edge case in the requested feature remains."}
\`\`\``;
}

export function developerPrompt({ project, objective, rules, task, tasks, previousAttempts, checks, recoveryNote, opts = {} }) {
  const done = tasks.filter((t) => ['verified', 'implemented_unverified'].includes(t.status));
  const prev = (previousAttempts || []).slice(-2);
  return `You are the DEVELOPER in a run supervised by SleepPilot. Implement exactly ONE task in the project folder below.

PROJECT FOLDER: ${project.dir}
OVERALL OBJECTIVE (version ${objective.version}, for context — do not work beyond the current task):
${objective.text}

GENERAL USER RULES:
${rules || '(none)'}

SAFETY RULES (mandatory):
- Work only inside the project folder. Temporary scratch files may go to the system temp folder; never leave them in the project.
- ${opts.scope === 'creative' ? 'Implement the task; small related improvements are welcome if they do not break anything.' : 'Implement exactly what the task asks. Do not add features, refactors or changes outside the task.'}
${opts.protectedPaths?.length ? `- PROTECTED (never modify; SleepPilot denies it): ${opts.protectedPaths.join(', ')}\n` : ''}- Do not run git commit, push, reset, checkout, restore, clean, stash or any history-changing command. SleepPilot never commits for the user.
- Never delete or overwrite existing user work that the task does not require changing. Do not remove files you did not create unless the task says so.
- Do not print, copy or store credentials, API keys or tokens.
${opts.unattended ? '- The user is ASLEEP and cannot answer questions or approve anything. Do not ask questions. Decide reasonably within the objective and rules, state your assumption in the summary, and finish the task. Use needs_user only if any choice could cause serious harm.\n' : '- If something is ambiguous and only the user can decide, stop and report needs_user instead of guessing.\n'}
ALREADY COMPLETED TASKS:
${done.length ? done.map((t) => `- [${t.id}] ${t.title} (${t.status === 'verified' ? 'verified' : 'implemented, not verified'})`).join('\n') : '(none)'}

${
    opts.parallelWith?.length
      ? `PARALLEL MODE: other developers are working AT THE SAME TIME in this folder on: ${opts.parallelWith.map((o) => `[${o.id}] ${o.title} (${(o.files || []).join(', ')})`).join('; ')}.
You may ONLY create or edit these files: ${(task.files || []).join(', ')}. Edits to any other file are denied. Do not run commands that modify other files. If the task needs a change elsewhere, do not attempt it — describe it in your summary.

`
      : ''
  }CURRENT TASK [${task.id}]: ${task.title}
${task.description}
Acceptance criteria:
${task.acceptance.length ? task.acceptance.map((a) => `- ${a}`).join('\n') : '- (none given; use the description)'}
${task.notes ? `Manager notes: ${task.notes}\n` : ''}${
    prev.length
      ? `\nPREVIOUS ATTEMPTS ON THIS TASK:\n${prev
          .map((p) => `- Iteration #${p.n}: ${p.summary}${p.failedChecks ? `\n  Failed checks:\n${p.failedChecks}` : ''}${p.reviewIssues ? `\n  Reviewer issues: ${p.reviewIssues}` : ''}`)
          .join('\n')}\nFix the cause of these failures.\n`
      : ''
  }${recoveryNote ? `\nNOTE: ${recoveryNote}\n` : ''}
AFTER YOU FINISH, SLEEPPILOT WILL RUN THESE CHECKS:
${checksBlock(checks)}
You may run them yourself if your permissions allow it.

Keep each tool call and your answer reasonably small: write large files in several smaller edits rather than one huge write (very long outputs get truncated by the provider).
When finished, reply with a short summary of what you changed (files and why) and how you checked it, then end with exactly one final line:
SLEEPPILOT_STATUS: done | blocked | needs_user | partial — <one-sentence reason>`;
}

export function reviewPrompt({ objective, task, developerSummary, changes, patches, checks, opts = {} }) {
  // Build output and dependencies say nothing about the change and cost many tokens.
  const generated = (patches || []).filter((p) => isGeneratedPath(p.file));
  const patchText = (patches || [])
    .filter((p) => !isGeneratedPath(p.file))
    .map((p) => p.patch)
    .join('\n')
    .slice(0, 24_000) + (generated.length ? `\n(${generated.length} generated/build-output file(s) omitted from this diff, e.g. ${generated.slice(0, 3).map((p) => p.file).join(', ')})` : '');
  return `You are the REVIEWER in a run supervised by SleepPilot. You are read-only: you may read project files but never edit them.
Note: you may be the same underlying model as the developer; be skeptical and concrete.

OBJECTIVE (version ${objective.version}):
${objective.text}

TASK [${task.id}]: ${task.title}
${task.description}
Acceptance criteria:
${task.acceptance.map((a) => `- ${a}`).join('\n') || '- (none)'}

DEVELOPER'S OWN REPORT (a claim, not evidence):
${String(developerSummary || '(empty)').slice(0, 4000)}

FILES CHANGED (measured by SleepPilot): added ${changes.added.length}, modified ${changes.modified.length}, deleted ${changes.deleted.length}
${[...changes.added.map((f) => '+ ' + f), ...changes.modified.map((f) => '~ ' + f), ...changes.deleted.map((f) => '- ' + f)].slice(0, 60).join('\n') || '(no file changes detected)'}

DIFF (may be truncated):
${patchText || '(no diff available)'}

CHECK RESULTS (executed by SleepPilot):
${(checks || []).map((c) => `- ${c.name}: ${c.status}${c.status !== 'passed' ? ` — ${String(c.output).slice(-600)}` : ''}${c.details?.screenshot ? ` (screenshot of the running app: ${c.details.screenshot} — open it with your file tool if the look matters)` : ''}`).join('\n') || '- none ran'}

Judge whether the change satisfies the acceptance criteria, what is missing, and what evidence is missing.
${opts.screenshotPages?.length ? `
SCREENSHOTS (only if you need them): if you cannot judge the result without SEEING it (layout, visual design, a canvas or game screen, mobile view), add "screenshots": [{"page": "index.html", "device": "desktop | phone | tablet"}] (at most 3) to your JSON and use verdict "cannot_judge" for now. SleepPilot opens the pages in a real browser, saves the images and asks you once more. Do not ask when the diff and the checks are enough. Pages in the project: ${opts.screenshotPages.slice(0, 15).join(', ')}.
` : ''}
${opts.scope === 'creative' ? 'Scope mode is CREATIVE: related extra improvements are allowed; still flag anything that breaks requested behaviour.' : 'Scope mode is STRICT: list every change that is not needed for this task or the objective as an issue starting with "OUT-OF-SCOPE:", and use verdict "incomplete" if such changes are significant.'}
Reply with ONLY a JSON object in a \`\`\`json fenced block:
\`\`\`json
{"verdict": "pass | fail | incomplete | cannot_judge", "issues": ["concrete defect or gap"], "missing_verification": ["what was not actually tested"], "summary": "..."}
\`\`\``;
}

const STUCK_REASONS = {
  same_failure: 'the same check failure happened again after a repair attempt',
  repeated_failure: 'the same failure repeated until the attempt limit; the task was about to be given up',
  loop: 'the last attempts changed no files although the task is not done (the developer is going in circles)',
  stalled: 'the developer turn showed no progress for a long time and was stopped (a command that never returned or waited for input?)',
  timeout: 'the developer turn exceeded the per-turn time limit and was stopped',
};

/** A different engine diagnoses a stuck task (read-only) and tells the developer how to get unstuck. */
export function secondOpinionPrompt({ objective, task, reason, attempts = [], lastChecks = [], developerSummary = '', changedFiles = [], fromEngine = '' }) {
  const fence = '```';
  return `You are a SECOND-OPINION ENGINEER called in by SleepPilot because a coding agent is stuck. You are read-only: you may read the project files, but never edit them.
Why you were called: ${STUCK_REASONS[reason] || reason}.${fromEngine ? ` The developer runs on ${fromEngine}; look at the problem with fresh eyes.` : ''}

OBJECTIVE (version ${objective.version}):
${String(objective.text || '').slice(0, 4000)}

TASK [${task.id}]: ${task.title}
${String(task.description || '').slice(0, 3000)}
Acceptance criteria:
${(task.acceptance || []).map((a) => `- ${a}`).join('\n') || '- (none)'}
${task.files?.length ? `Files in scope: ${task.files.join(', ')}\n` : ''}
ATTEMPTS SO FAR (newest last):
${attempts.slice(-6).map((a) => `- #${a.n}: ${String(a.summary || '').slice(0, 400)}${a.failedChecks ? `\n  failed checks: ${String(a.failedChecks).slice(-1200)}` : ''}${a.reviewIssues ? `\n  reviewer: ${String(a.reviewIssues).slice(0, 400)}` : ''}`).join('\n') || '- (none recorded)'}

LAST CHECK RESULTS:
${lastChecks.map((c) => `- ${c.name}: ${c.status}${c.status !== 'passed' && c.output ? ` — ${String(c.output).slice(-1500)}` : ''}`).join('\n') || '- none'}

LAST DEVELOPER REPORT (a claim, not evidence):
${String(developerSummary || '(none)').slice(-2500)}
${changedFiles.length ? `\nFiles changed in the last attempt: ${changedFiles.slice(0, 40).join(', ')}\n` : ''}
Read the relevant files, then find the ROOT CAUSE: a wrong approach, a misunderstood requirement, an environment problem (missing tool, wrong path, a command that waits for input), a check that cannot pass as written, or a task that is too big for one step.
Reply with ONLY a JSON object in a ${fence}json fenced block:
${fence}json
{"diagnosis": "what is really going wrong (concrete: file, line, command, error)", "root_cause": "approach | requirement | environment | check | too_big | other", "advice": "exact instructions for the developer's next attempt: what to change, in which files, what to avoid", "recommendation": "retry | split | give_up", "subtasks": [{"title": "...", "description": "...", "acceptance": ["..."]}], "give_up_reason": "only for give_up: why no further attempt can succeed"}
${fence}
Use "split" (with 2-4 subtasks) only when the task is too big; "give_up" only when the task cannot succeed in this environment.`;
}

/** Second reviewer turn after SleepPilot took the screenshots the reviewer asked for. */
export function reviewScreenshotsPrompt({ files = [], missing = [] }) {
  return `SleepPilot took the screenshots you asked for (real browser, after the page settled):
${files.map((f) => `- ${f.path} — ${f.page} (${f.device})${f.problems?.length ? ` · page errors while loading: ${f.problems.map((p) => p.text).join('; ').slice(0, 300)}` : ''}`).join('\n') || '- none could be taken'}
${missing.length ? `Not captured: ${missing.map((m) => `${m.page} (${m.error})`).join('; ')}\n` : ''}
Open each image with your file-reading tool and look at it. Then give your FINAL verdict for the same task, judged on the diff, the checks AND what the screenshots show. Do not ask for more screenshots.
Reply with ONLY a JSON object in a \`\`\`json fenced block:
\`\`\`json
{"verdict": "pass | fail | incomplete | cannot_judge", "issues": ["concrete defect or gap, mention what the screenshot shows"], "missing_verification": ["..."], "summary": "..."}
\`\`\``;
}

export function rejectionFollowUp(declined, { dismissed = false, unattended = false } = {}) {
  const head = dismissed
    ? `Nobody answered ${declined}; it was closed automatically${unattended ? ' because the user is asleep' : ''}. Do not ask again. Make the most reasonable decision within the objective and rules yourself, note the assumption, and continue.`
    : `The last tool call was DECLINED${unattended ? ' (the user is asleep; unanswered permission requests are declined automatically)' : ' by the user'}: ${declined}. Do not run it again and do not try to get around the refusal with an equivalent command.
Continue the CURRENT TASK without it if you can (for example skip optional self-checks — SleepPilot runs its own checks afterwards; keep scratch files inside the project or the system temp folder).`;
  return `${head}
If the task cannot be completed without that action, stop.
End with exactly one final line:
SLEEPPILOT_STATUS: done | blocked | needs_user | partial — <one-sentence reason>`;
}

export const JSON_RETRY = 'Your previous reply could not be parsed. Reply again with ONLY the JSON object in a ```json fenced block, following the exact shape requested. No other text.';

/**
 * Sent after the last answer of a run, in a read-only session. SleepPilot's measured numbers are
 * the source of truth; the model explains them and reads files to describe the changes.
 */
export function closingReportPrompt({ project, run, stopReason, detail, hours, patches, engineLabel = 'the agent engine', opts = {} }) {
  const lang = languageName(opts.language);
  const ls = run.lineStats || {};
  const net = ls.net;
  const files = net
    ? net.files.map((f) => `${f.status === 'added' ? '+' : f.status === 'deleted' ? '-' : '~'} ${f.file}  (+${f.additions} / -${f.deletions})`).slice(0, 120).join('\n')
    : (run.iterations || []).map((it) => `#${it.n} ${it.taskId}: ${it.changedCount ?? 0} files, +${it.lines?.additions ?? 0}/-${it.lines?.deletions ?? 0}`).join('\n');
  const tasks = (run.tasks || []).map((t) => `- [${t.id}] ${t.status}${t.attempts ? ` (attempts ${t.attempts})` : ''}: ${t.title}${t.question ? ` — open question: ${t.question}` : ''}`).join('\n');
  const diff = (patches || []).filter((p) => !isGeneratedPath(p.file)).map((p) => p.patch).join('\n').slice(0, 30_000);
  const auto = (run.autoAnswered || []).map((a) => `- ${a.type === 'permission' ? `permission ${a.action} ${(a.resources || []).join(' ')}` : `question: ${a.title}`} (iteration ${a.iteration ?? '?'})`).join('\n');
  const facts = `FACTS MEASURED BY SLEEPPILOT (source of truth):
- Project folder: ${project.dir}
- Active run time: ${hours.toFixed(2)} h; stop reason: ${stopReason}${detail ? ` (${String(detail).slice(0, 300)})` : ''}
- Iterations: ${run.iterationCount}; tokens in/out: ${run.usage?.tokens?.input ?? 0}/${run.usage?.tokens?.output ?? 0}
- Net change since the run started: ${net ? `${net.added.length} added, ${net.modified.length} modified, ${net.deleted.length} deleted files; source code +${net.additions} / -${net.deletions} lines${net.generated?.files ? ` (plus ${net.generated.files} generated/build-output files, +${net.generated.additions} lines, not counted as code)` : ''}` : 'start snapshot not available (app restarted)'}
- Sum over all iterations: +${ls.iterations?.additions ?? 0} / -${ls.iterations?.deletions ?? 0} lines
- Files:
${files || '(no file changes)'}
- Tasks:
${tasks || '(none)'}
${auto ? `- Requests nobody answered (declined/closed automatically):\n${auto}\n` : ''}
DIFF OF THE WHOLE RUN (may be truncated; files over the snapshot size limit show no line diff):
${diff || '(no diff available)'}`;
  return `This message was written automatically by SleepPilot, an automation app that has been sending ${engineLabel} regular instructions so that you could work on this project autonomously for about ${hours.toFixed(1)} hours. The run has now ended (${stopReason}).

You are in a read-only session: do not modify any file. Read files if needed to explain the facts below.

Write a comprehensive report in ${lang} of what was done during this period:
1. Short summary (3–5 sentences): what was achieved, what is unfinished.
2. Changes file by file: what changed and why; lines added/removed (use the measured numbers below, never invent numbers).
3. Task status: verified, unverified, failed, blocked, still open.
4. Risks and things to check: possible bugs, compatibility of old saves/data, what needs manual testing.
5. Unanswered questions and automatically declined permissions, and their impact.
6. A prioritised task list for the next run.
Never present unverified work as working; only work whose SleepPilot checks passed counts as verified.

${facts}`;
}
