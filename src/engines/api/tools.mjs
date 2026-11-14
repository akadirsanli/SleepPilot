import fsp from 'node:fs/promises';
import path from 'node:path';
import { evaluateRules } from '../base.mjs';
import { runShell } from '../../util/proc.mjs';
import { redact } from '../../util/redact.mjs';

const MAX_READ_LINES = 500;
const MAX_READ_CHARS = 80_000;
const MAX_WRITE_BYTES = 4 * 1024 * 1024;
const MAX_TOOL_OUTPUT = 24_000;
const SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv', '.idea', '.vs', 'target', 'dist', 'build']);

export const READ_ONLY_TOOLS = ['read', 'list', 'glob', 'grep'];
export const ALL_TOOLS = [...READ_ONLY_TOOLS, 'write', 'edit', 'bash', 'webfetch', 'question', 'status'];

const def = (name, description, parameters) => ({ name, description, parameters });

export const TOOL_DEFINITIONS = {
  read: def(
    'read',
    'Read a text file from the project. Returns numbered lines. Read a range (offset/limit) for large files instead of the whole file.',
    {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Path relative to the project folder (forward slashes), or an absolute path.' },
        offset: { type: 'number', description: 'First line (1-based). Default 1.' },
        limit: { type: 'number', description: 'Maximum number of lines. Default 400, max 500.' },
      },
      required: ['filePath'],
    },
  ),
  write: def('write', 'Create or replace a text file in the project. Parent folders are created.', {
    type: 'object',
    properties: { filePath: { type: 'string' }, content: { type: 'string', description: 'The complete file content.' } },
    required: ['filePath', 'content'],
  }),
  edit: def('edit', 'Replace exact text in a file. Read the file first; use a unique oldString. Fails when oldString is missing or ambiguous.', {
    type: 'object',
    properties: {
      filePath: { type: 'string' },
      oldString: { type: 'string', description: 'Exact text to find (include indentation).' },
      newString: { type: 'string', description: 'Replacement text (empty string deletes).' },
      replaceAll: { type: 'boolean', description: 'Replace every occurrence instead of requiring exactly one.' },
    },
    required: ['filePath', 'oldString', 'newString'],
  }),
  list: def('list', 'List a folder of the project (names, types, sizes).', {
    type: 'object',
    properties: { path: { type: 'string', description: 'Folder relative to the project. Default: project root.' } },
  }),
  glob: def('glob', 'Find files by glob pattern (e.g. "src/**/*.rs", "**/*.toml").', {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern. ** matches any depth.' },
      path: { type: 'string', description: 'Folder to search in (project-relative). Default: project root.' },
    },
    required: ['pattern'],
  }),
  grep: def('grep', 'Search file contents with a regular expression.', {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression.' },
      path: { type: 'string', description: 'Folder or file to search (project-relative). Default: project root.' },
      include: { type: 'string', description: 'Only files whose name matches this glob, e.g. "*.rs".' },
    },
    required: ['pattern'],
  }),
  bash: def('bash', 'Run a shell command in the project folder. Use it for builds, tests and analysis tools (cargo check, strings, objdump…).', {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Command line (cmd.exe on Windows, sh elsewhere).' },
      timeout: { type: 'number', description: 'Timeout in seconds (default 600, max 3600).' },
      description: { type: 'string', description: 'Short description of what the command does.' },
    },
    required: ['command'],
  }),
  webfetch: def('webfetch', 'Fetch a web page or document and return it as plain text.', {
    type: 'object',
    properties: { url: { type: 'string', description: 'http:// or https:// URL.' }, format: { type: 'string', enum: ['text', 'html'] } },
    required: ['url'],
  }),
  question: def('question', 'Ask the user a question when a decision truly blocks progress. Never use it in unattended/sleep mode.', {
    type: 'object',
    properties: {
      question: { type: 'string' },
      options: { type: 'array', items: { type: 'string' }, description: 'Optional short choices.' },
    },
    required: ['question'],
  }),
  status: def('status', 'Report the outcome of the current task. Call this exactly once when the task is finished, blocked or needs the user.', {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['done', 'blocked', 'needs_user', 'partial'] },
      reason: { type: 'string', description: 'One sentence.' },
    },
    required: ['status', 'reason'],
  }),
};

export function toolDefinitionsFor(role) {
  const names = role === 'developer' ? ALL_TOOLS : READ_ONLY_TOOLS;
  return names.map((n) => TOOL_DEFINITIONS[n]);
}

/** Text-protocol instructions for providers that cannot do native tool calling. */
export function textToolInstructions(role) {
  const names = role === 'developer' ? ALL_TOOLS : READ_ONLY_TOOLS;
  return `TOOL CALL PROTOCOL (this provider has no native tool calling):
Instead of tool calls, reply with exactly one fenced block and no other text when you need a tool:
\`\`\`tool
{"name":"read","arguments":{"filePath":"src/main.rs"}}
\`\`\`
The result is appended to the conversation and you continue. Available tools: ${names.join(', ')}.`;
}

/** Runtime that executes tool calls for one session. */
export class ToolRuntime {
  constructor({ session, projectDir, requestPermission, answerQuestion, onStatus, signal, maxOutput = MAX_TOOL_OUTPUT }) {
    this.session = session;
    this.projectDir = path.resolve(projectDir);
    this.requestPermission = requestPermission;
    this.answerQuestion = answerQuestion;
    this.onStatus = onStatus;
    this.signal = signal;
    this.maxOutput = maxOutput;
  }

  async execute(name, args = {}) {
    try {
      const check = await this.authorize(name, args);
      if (check !== 'allow') return { ok: false, output: `Permission ${check === 'deny' ? 'denied' : 'not granted'} for ${name}${args.filePath ? ` on ${args.filePath}` : args.command ? `: ${args.command}` : ''}.` };
      const result = await this[name](args);
      return { ok: true, output: clip(result, this.maxOutput), meta: { name } };
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      return { ok: false, output: `Tool ${name} failed: ${redact(err.message)}` };
    }
  }

  // ------------------------------------------------------------ permissions

  async authorize(name, args) {
    const rules = this.session.permissions || [{ action: '*', resource: '*', effect: 'allow' }];
    const action = { read: 'read', list: 'read', glob: 'read', grep: 'read', write: 'edit', edit: 'edit', bash: 'shell', webfetch: 'webfetch', question: 'question', status: 'read' }[name] || name;
    let resource = '';
    let externalPath = null;
    if (name === 'bash') resource = String(args.command || '');
    else if (name === 'webfetch') resource = String(args.url || '');
    else if (name === 'question' || name === 'status') resource = '*';
    else {
      const target = resolvePath(this.projectDir, args.filePath || args.path || '.');
      if (!isInside(this.projectDir, target)) externalPath = target;
      resource = externalPath ? toPosix(externalPath) : toPosix(path.relative(this.projectDir, target)) || '.';
    }
    if (externalPath) {
      const dir = toPosix(targetDirOf(resource));
      const extEffect = worst(evaluateRules(rules, 'external_directory', `${dir}/*`), evaluateRules(rules, 'external_directory', dir));
      if (extEffect === 'deny') return 'deny';
    }
    const effect = evaluateRules(rules, action, resource);
    if (effect === 'allow') return 'allow';
    if (effect === 'deny') return 'deny';
    // The question tool has its own form/answer flow; an `ask` rule means "may ask the user",
    // not "ask permission to ask". Unattended mode denies questions in the ruleset itself.
    if (name === 'question') return 'allow';
    return this.requestPermission({ action, resource, name, args });
  }

  // ------------------------------------------------------------ tools

  async read({ filePath, offset = 1, limit = 400 } = {}) {
    const abs = this.resolve(filePath);
    const st = await fsp.stat(abs);
    if (!st.isFile()) throw new Error('Not a file.');
    if (st.size > 20 * 1024 * 1024) throw new Error(`File is too large to read directly (${st.size} bytes); read a range with bash (e.g. Get-Content -TotalCount) or use the recon report.`);
    const buf = await fsp.readFile(abs);
    if (looksBinary(buf)) return `${this.display(abs)} is a binary file (${st.size} bytes). Use bash tools (strings, objdump, xxd/Format-Hex) or a reconnaissance report to inspect it.`;
    const lines = buf.toString('utf8').split(/\r?\n/);
    const start = Math.max(1, Math.floor(Number(offset) || 1));
    const count = Math.min(MAX_READ_LINES, Math.max(1, Math.floor(Number(limit) || 400)));
    const slice = lines.slice(start - 1, start - 1 + count);
    let out = `${this.display(abs)} — lines ${start}-${start + slice.length - 1} of ${lines.length}\n`;
    let used = 0;
    for (let i = 0; i < slice.length; i++) {
      const line = `${String(start + i).padStart(6)}| ${slice[i]}`;
      if (used + line.length > MAX_READ_CHARS) {
        out += `…(output limit reached at line ${start + i}; read a smaller range)\n`;
        break;
      }
      out += line + '\n';
      used += line.length;
    }
    return out;
  }

  async write({ filePath, content = '' } = {}) {
    const abs = this.resolve(filePath);
    const data = String(content ?? '');
    if (Buffer.byteLength(data) > MAX_WRITE_BYTES) throw new Error(`The content is larger than ${MAX_WRITE_BYTES / 1024 / 1024} MB. Write it in smaller parts.`);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, data, 'utf8');
    return `Wrote ${Buffer.byteLength(data)} bytes to ${this.display(abs)}.`;
  }

  async edit({ filePath, oldString, newString = '', replaceAll = false } = {}) {
    const abs = this.resolve(filePath);
    const before = await fsp.readFile(abs, 'utf8');
    const old = String(oldString ?? '');
    if (!old) throw new Error('oldString must not be empty.');
    const count = before.split(old).length - 1;
    if (!count) throw new Error('oldString was not found. Read the file again and copy the exact text (including indentation).');
    if (count > 1 && !replaceAll) throw new Error(`oldString occurs ${count} times. Include more surrounding text or set replaceAll.`);
    const after = replaceAll ? before.split(old).join(String(newString ?? '')) : before.replace(old, String(newString ?? ''));
    await fsp.writeFile(abs, after, 'utf8');
    return `Edited ${this.display(abs)} (${replaceAll ? count : 1} replacement(s)).`;
  }

  async list({ path: p = '.' } = {}) {
    const abs = this.resolve(p || '.');
    const entries = await fsp.readdir(abs, { withFileTypes: true });
    const rows = [];
    for (const e of entries.slice(0, 500)) {
      const st = await fsp.stat(path.join(abs, e.name)).catch(() => null);
      rows.push(`${e.isDirectory() ? 'd' : '-'} ${String(st?.size ?? 0).padStart(10)}  ${e.name}${e.isDirectory() ? '/' : ''}`);
    }
    return `${this.display(abs)} (${entries.length} entries)\n${rows.join('\n')}`;
  }

  async glob({ pattern, path: p = '.' } = {}) {
    const base = this.resolve(p || '.');
    const re = globToRegex(pattern || '**/*');
    const found = [];
    await walk(base, async (file) => {
      const rel = toPosix(path.relative(this.projectDir, file));
      if (re.test(rel)) found.push(rel);
      return found.length < 500;
    });
    return found.length ? found.sort().join('\n') : 'No files matched.';
  }

  async grep({ pattern, path: p = '.', include } = {}) {
    let re;
    try {
      re = new RegExp(pattern, 'i');
    } catch (err) {
      throw new Error(`Invalid regular expression: ${err.message}`);
    }
    const base = this.resolve(p || '.');
    const includeRe = include ? globToRegex(include, { basename: true }) : null;
    const hits = [];
    const files = [];
    const st = await fsp.stat(base);
    if (st.isFile()) files.push(base);
    else
      await walk(base, async (file) => {
        files.push(file);
        return files.length < 4000;
      });
    for (const file of files) {
      if (includeRe && !includeRe.test(path.basename(file))) continue;
      if (hits.length >= 250) break;
      const info = await fsp.stat(file).catch(() => null);
      if (!info?.isFile() || info.size > 4 * 1024 * 1024) continue;
      const buf = await fsp.readFile(file).catch(() => null);
      if (!buf || looksBinary(buf)) continue;
      const lines = buf.toString('utf8').split(/\r?\n/);
      for (let i = 0; i < lines.length && hits.length < 250; i++) {
        if (re.test(lines[i])) hits.push(`${toPosix(path.relative(this.projectDir, file))}:${i + 1}: ${lines[i].slice(0, 300)}`);
      }
    }
    return hits.length ? hits.join('\n') : 'No matches.';
  }

  async bash({ command, timeout = 600 } = {}) {
    if (!String(command || '').trim()) throw new Error('command is required.');
    const seconds = Math.max(1, Math.min(3600, Number(timeout) || 600));
    const r = await runShell(String(command), { cwd: this.projectDir, timeoutMs: seconds * 1000, signal: this.signal });
    const body = `${r.stdout || ''}${r.stderr ? `\n[stderr]\n${r.stderr}` : ''}`.trim();
    const head = r.aborted ? 'Command interrupted.' : r.timedOut ? `Timed out after ${seconds}s.` : `Exit code ${r.exitCode ?? 'n/a'} (${Math.round(r.durationMs / 1000)}s).`;
    return `${head}\n${body ? clip(body, this.maxOutput - 100) : '(no output)'}`;
  }

  async webfetch({ url, format = 'text' } = {}) {
    const u = new URL(String(url));
    if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only http:// and https:// URLs are allowed.');
    const res = await fetch(u, { signal: AbortSignal.timeout(30_000), headers: { 'user-agent': 'SleepPilot/2.0 (+https://github.com/)' }, redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const ctype = res.headers.get('content-type') || '';
    const text = (await res.text()).slice(0, 1_500_000);
    if (format === 'html' || ctype.includes('text/html')) return clip(format === 'html' ? text : htmlToText(text), this.maxOutput);
    return clip(text, this.maxOutput);
  }

  async question({ question, options } = {}) {
    if (!String(question || '').trim()) throw new Error('question is required.');
    const answer = await this.answerQuestion({ title: String(question).slice(0, 2000), options: Array.isArray(options) ? options.map(String).slice(0, 20) : [] });
    return answer == null ? 'The question was dismissed without an answer. Decide yourself and continue.' : `Answer: ${answer}`;
  }

  async status({ status, reason } = {}) {
    const allowed = ['done', 'blocked', 'needs_user', 'partial'];
    if (!allowed.includes(status)) throw new Error(`status must be one of ${allowed.join(', ')}.`);
    this.onStatus?.({ status, reason: String(reason || '').slice(0, 1000) });
    return `Status recorded: ${status} — ${reason || ''}`;
  }

  // ------------------------------------------------------------ paths

  resolve(p) {
    // Authorization already happened in execute(); resolve only. Paths outside the project are
    // reachable only when the session's permission rules allowed them.
    return resolvePath(this.projectDir, p);
  }

  display(abs) {
    return isInside(this.projectDir, abs) ? toPosix(path.relative(this.projectDir, abs)) || '.' : abs;
  }
}

// ------------------------------------------------------------------ helpers

export function resolvePath(projectDir, p) {
  if (!p) return path.resolve(projectDir);
  return path.isAbsolute(String(p)) ? path.resolve(String(p)) : path.resolve(projectDir, String(p));
}

export function isInside(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

const toPosix = (p) => String(p).replace(/\\/g, '/');

function targetDirOf(resource) {
  // For an external file, ask for its folder; for a folder, itself.
  return /\.[^./]+$/.test(resource) ? path.dirname(resource) : resource;
}

function worst(a, b) {
  const rank = { allow: 0, ask: 1, deny: 2 };
  return rank[a] >= rank[b] ? a : b;
}

export function looksBinary(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export function globToRegex(pattern, { basename = false } = {}) {
  const p = String(pattern || '**/*').replace(/\\/g, '/');
  const body = p
    .split(/(\*\*\/|\*\*|\*|\?)/)
    .map((part) => {
      if (part === '**/') return '(?:.*/)?';
      if (part === '**') return '.*';
      if (part === '*') return '[^/]*';
      if (part === '?') return '[^/]';
      return part.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    })
    .join('');
  return new RegExp(basename ? `^${body}$` : `(?:^|/)${body}$`, 'i');
}

async function walk(root, visit) {
  const dirs = [root];
  while (dirs.length) {
    const dir = dirs.pop();
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) dirs.push(full);
      } else if (e.isFile()) {
        const keep = await visit(full);
        if (keep === false) return;
      }
    }
  }
}

export function htmlToText(html) {
  return String(html)
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function clip(s, n = MAX_TOOL_OUTPUT) {
  const str = String(s ?? '');
  return str.length > n ? str.slice(0, n) + `\n…[truncated ${str.length - n} characters]` : str;
}
