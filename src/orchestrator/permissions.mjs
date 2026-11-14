import os from 'node:os';

/**
 * OpenCode 2.x session permission rulesets. Verified on 2.0.32: rules are
 * {action, resource, effect}, later rules override earlier ones, and an `* * deny`
 * rule removes the tools from the model. The shell action is `shell` (v1 called it `bash`).
 */

/** Commands that are always denied for the developer: publishing, history rewriting, destructive deletes. */
export const ALWAYS_DENY_SHELL = [
  'git push*', 'git commit*', 'git reset*', 'git clean*', 'git checkout*', 'git restore*', 'git rebase*', 'git merge*',
  'git stash*', 'git revert*', 'git tag*', 'git branch -d*', 'git branch -D*', 'git remote*', 'git switch*',
  'gh *', 'npm publish*', 'npm login*', 'npm adduser*', 'pnpm publish*', 'yarn publish*', 'twine upload*',
  'rm -rf*', 'rm -r *', 'rm -fr*', 'rmdir /s*', 'rd /s*', 'del /s*', 'del /q*', 'erase /s*',
  'Remove-Item*-Recurse*', 'Remove-Item*-r *', 'format *', 'diskpart*', 'shutdown*', 'Stop-Computer*', 'Restart-Computer*',
  'reg *', 'Set-ExecutionPolicy*', 'opencode auth*', 'opencode-cli auth*', 'setx *', 'netsh *', 'schtasks *',
];

/** Commands the balanced profile allows without asking (read-only inspection, local builds/tests). */
export const BALANCED_ALLOW_SHELL = [
  'git status*', 'git diff*', 'git log*', 'git show*', 'git ls-files*', 'git rev-parse*',
  'ls*', 'dir*', 'pwd*', 'cat *', 'type *', 'echo *', 'head *', 'tail *', 'wc *', 'find *', 'findstr *', 'rg *', 'grep *', 'where *', 'which *', 'tree*',
  'Get-ChildItem*', 'Get-Content*', 'Select-String*', 'Test-Path*', 'Get-Location*', 'Resolve-Path*', 'mkdir *', 'md *', 'New-Item*-ItemType Directory*',
  'node *', 'npm test*', 'npm run *', 'npm ls*', 'npx tsc*', 'tsc*', 'python *', 'python3 *', 'py *', 'pytest*', 'pip list*', 'pip show*',
];

export const PROFILES = {
  strict: {
    label: 'Ask everything',
    description: 'File edits inside the project are allowed. Every shell command, web request and access outside the project asks for approval. Meant for short, supervised runs.',
  },
  balanced: {
    label: 'Supervised',
    description:
      'File edits inside the project are allowed. Read-only commands, node/npm/python/pytest and builds run without asking. Other commands and outside folders ask; an unanswered request is rejected after the timeout and the run continues.',
  },
  full: {
    label: 'Full autonomy',
    description:
      'The agent asks nothing: all tools, shell commands (including package installs), web access and folders outside the project are allowed. A small set of destructive commands (Git history rewriting, publishing, formatting disks, system shutdown) stays blocked. Built for overnight runs.',
  },
  unrestricted: {
    label: 'Unrestricted (your responsibility)',
    description:
      'No permission checks and no command deny list: the agent may run anything your user account can run, anywhere. Use it only when you fully trust the project and the task. You are responsible for what the agent does.',
  },
};

/** Old settings used "broad"; it is now the full-autonomy profile. */
export function normalizeProfile(p) {
  if (p === 'broad') return 'full';
  return Object.keys(PROFILES).includes(p) ? p : 'balanced';
}

const rule = (action, resource, effect) => ({ action, resource, effect });

/** OpenCode keeps scratch files in %TEMP%\opencode; resources use forward slashes. */
function tempPatterns() {
  const t = os.tmpdir().replace(/\\/g, '/').replace(/\/$/, '');
  return [`${t}/*`, `${t}`];
}

/**
 * unattended: nobody is at the keyboard. The question tool is denied (the developer must decide
 * itself) so a question can never stop the run.
 */
/**
 * Protected paths (verified on OpenCode 2.2.0): file tools ask/deny with the PROJECT-RELATIVE path
 * as resource (e.g. "korunan/a.txt") under action "edit"; folders outside the project go through
 * "external_directory" with "C:/dir/*" — denying it blocked both writing and reading there.
 * Shell commands that name a protected outside folder are denied too (a safety net, not a sandbox).
 */
export function protectedPathRules(paths = [], projectDir = '') {
  const rules = [];
  const fwd = (p) => String(p).trim().replace(/\\/g, '/').replace(/\/+$/, '');
  const root = fwd(projectDir).toLowerCase();
  for (const raw of paths || []) {
    let p = fwd(raw);
    if (!p) continue;
    const abs = /^[a-z]:\//i.test(p) || p.startsWith('//');
    if (abs && root && (p.toLowerCase() === root || p.toLowerCase().startsWith(root + '/'))) p = p.slice(root.length + 1) || '*';
    else if (abs) {
      rules.push(rule('external_directory', p, 'deny'), rule('external_directory', `${p}/*`, 'deny'));
      // The path must end at a boundary: `*C:\x\app*` would also block every command that names a
      // sibling such as `C:\x\app-analysis` (a Sleep & Reverse workspace next to its target was
      // unusable from the shell). Separator, quote, space or end of the command ends the path.
      for (const variant of new Set([p, p.replace(/\//g, '\\')])) {
        for (const end of ['/', '\\', '"', "'", ' ', ';', ')']) rules.push(rule('shell', `*${variant}${end}*`, 'deny'));
        rules.push(rule('shell', `*${variant}`, 'deny'));
      }
      continue;
    }
    p = p.replace(/^\.\//, '');
    for (const act of ['edit', 'write', 'patch']) rules.push(rule(act, p, 'deny'), rule(act, `${p}/*`, 'deny'));
  }
  return rules;
}

/**
 * Parallel developers: a developer may only edit its task's files (project-relative, as OpenCode
 * 2.2.0 reports edit resources). Everything else is denied for the file tools, so two developers
 * working at the same time cannot overwrite each other. Shell commands are not path-scoped.
 */
export function editScopeRules(files = []) {
  if (!files?.length) return [];
  const rules = [];
  for (const act of ['edit', 'write', 'patch']) {
    rules.push(rule(act, '*', 'deny'));
    for (const f of files) {
      rules.push(rule(act, f, 'allow'));
      if (!/[*?]/.test(f)) rules.push(rule(act, `${f}/*`, 'allow'));
    }
  }
  return rules;
}

export function developerRuleset(profile = 'balanced', { unattended = false, protectedPaths = [], projectDir = '', editScope = [] } = {}) {
  profile = normalizeProfile(profile);
  let rules;
  if (profile === 'unrestricted') {
    // Explicitly chosen by the user: no deny list, no protected paths, no permission prompts.
    return [rule('*', '*', 'allow')];
  }
  if (profile === 'full') {
    rules = [rule('*', '*', 'allow')];
  } else {
    // Reading inside the project never asks; only edits/commands/outside folders are policy.
    rules = [rule('read', '*', 'allow'), rule('edit', '*', 'allow'), rule('write', '*', 'allow'), rule('patch', '*', 'allow'), rule('external_directory', '*', 'ask')];
    // OpenCode's own scratch folder (and the rest of %TEMP%) is harmless; asking for it froze a
    // real overnight run for 7 hours.
    for (const p of tempPatterns()) rules.push(rule('external_directory', p, 'allow'));
    if (profile === 'strict') {
      rules.push(rule('shell', '*', 'ask'), rule('webfetch', '*', 'ask'), rule('websearch', '*', 'ask'));
    } else {
      rules.push(rule('shell', '*', 'ask'), rule('webfetch', '*', 'allow'), rule('websearch', '*', 'allow'));
      for (const p of BALANCED_ALLOW_SHELL) rules.push(rule('shell', p, 'allow'));
    }
  }
  if (unattended) rules.push(rule('question', '*', 'deny'));
  rules.push(...editScopeRules(editScope));
  for (const p of ALWAYS_DENY_SHELL) rules.push(rule('shell', p, 'deny'));
  rules.push(...protectedPathRules(protectedPaths, projectDir));
  return rules;
}

/** Manager and Reviewer are read-only: every tool denied except reading/searching files. */
export function readOnlyRuleset() {
  return [rule('*', '*', 'deny'), rule('read', '*', 'allow'), rule('glob', '*', 'allow'), rule('grep', '*', 'allow'), rule('list', '*', 'allow')];
}
