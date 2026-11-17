import crypto from 'node:crypto';
import { ExternalCliEngine, findExternalCli, authHint, classifyForEngine, signedInFromText } from '../external-cli/engine.mjs';
import { runFile } from '../../util/proc.mjs';
import { parseResetHint } from '../../orchestrator/quota-tracker.mjs';

/** Actual values accepted by the installed Claude Code CLI (`--effort`). */
export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Claude Code engine.
 *
 * Uses the installed `claude` CLI in non-interactive mode:
 *   claude -p --output-format stream-json --verbose [--resume <id>] [--model <model>]
 * The prompt is sent on stdin. Claude Code keeps its own session, tools, MCP servers and login;
 * SleepPilot supervises turns, streams the JSON events into the normal chat and persists the
 * session so a crash never resubmits a turn.
 */
export class ClaudeEngine extends ExternalCliEngine {
  constructor({ settings = {}, credentials = null } = {}) {
    super({ id: 'claude', label: 'Claude Code', settings, credentials });
    this.cli = { cliPath: null, model: null, permissionMode: 'auto', extraArgs: [], timeoutMin: 720, ...(settings.claude || {}) };
  }

  async runTurn(args) {
    const result = await super.runTurn(args);
    if (!result.quota && result.stderr) {
      const quota = claudeQuotaFromText(result.stderr);
      if (quota) {
        result.quota = quota;
        result.errors ||= [];
        if (!result.errors.some((e) => e.type === 'provider.quota')) {
          const err = { type: 'provider.quota', message: quota.message };
          result.errors.push({ ...err, classification: classifyForEngine('claude', err) });
        }
      }
    }
    return result;
  }

  async probeCli() {
    const found = await findExternalCli({
      explicit: this.cli.cliPath,
      envNames: ['CLAUDE_CODE_PATH', 'CLAUDE_CLI'],
      candidates: [
        'claude',
        'claude.cmd',
        '%APPDATA%\\npm\\claude.cmd',
        '%LOCALAPPDATA%\\Programs\\claude\\claude.exe',
        '%USERPROFILE%\\.local\\bin\\claude',
        '%USERPROFILE%\\.claude\\local\\claude.exe',
      ],
      re: /(\d+\.\d+\.\d+)/,
      versionArgs: ['--version'],
    });
    if (!found.found) return found;
    let auth = { loggedIn: null, label: 'sign-in status unknown' };
    const a = await runFile(found.path, ['auth', 'status'], { timeoutMs: 30_000 }).catch(() => null);
    if (a) auth = parseClaudeAuthStatus(`${a.stdout || ''}${a.stderr || ''}`);
    const models = [
      { id: 'default', name: 'Claude default model' },
      { id: 'sonnet', name: 'Claude Sonnet (alias)' },
      { id: 'opus', name: 'Claude Opus (alias)' },
      { id: 'haiku', name: 'Claude Haiku (alias)' },
    ];
    if (this.cli.model && !models.some((m) => m.id === this.cli.model)) models.unshift({ id: this.cli.model, name: this.cli.model });
    return { ...found, auth, models };
  }

  buildArgs({ session, readOnly, profile }) {
    const effort = session.effort || this.cli.effort || null;
    if (effort && !CLAUDE_EFFORTS.includes(effort)) {
      const err = new Error(`Claude Code does not support effort "${effort}". Supported: ${CLAUDE_EFFORTS.join(', ')}.`);
      err.sleepPilotType = 'provider.config';
      throw err;
    }
    const args = ['-p', '--output-format', 'stream-json', '--verbose'];
    if (session.nativeSessionId) {
      args.push('--resume', session.nativeSessionId);
    } else {
      session.nativeSessionId = crypto.randomUUID();
      args.push('--session-id', session.nativeSessionId);
    }
    const model = this.cli.model || session.model?.id;
    if (model && model !== 'default') args.push('--model', model);
    if (effort) args.push('--effort', effort);
    if (readOnly) {
      args.push('--permission-mode', 'plan', '--disallowedTools', 'Write,Edit,Bash,PowerShell,NotebookEdit,WebFetch,WebSearch,Task');
    } else {
      const mode = this.cli.permissionMode && this.cli.permissionMode !== 'auto' ? this.cli.permissionMode : profile === 'full' || profile === 'unrestricted' ? 'bypassPermissions' : 'acceptEdits';
      if (mode === 'bypassPermissions') args.push('--dangerously-skip-permissions');
      else args.push('--permission-mode', mode);
    }
    args.push(...(this.cli.extraArgs || []));
    return { args };
  }

  parseLine(ev, state, h) {
    if (ev.type === 'system') {
      if (ev.session_id) h.sessionId(ev.session_id);
      if (ev.model) state.model = ev.model;
      return;
    }
    if (ev.type === 'assistant') {
      for (const block of ev.message?.content || []) {
        if (block.type === 'text' && block.text) h.text(block.text);
        else if (block.type === 'thinking' && block.thinking) h.reasoning(block.thinking);
        else if (block.type === 'tool_use') h.toolStart(block.id, block.name, block.input || {});
      }
      // The final `result` event carries the authoritative total usage; counting each assistant
      // message as well would double the token numbers.
      return;
    }
    if (ev.type === 'user') {
      for (const block of ev.message?.content || []) {
        if (block.type === 'tool_result') {
          const content = Array.isArray(block.content) ? block.content.map((x) => x.text || '').join('\n') : String(block.content || '');
          h.toolEnd(block.tool_use_id, { status: block.is_error ? 'error' : 'completed', output: content, error: block.is_error ? content : null });
        }
      }
      return;
    }
    if (ev.type === 'result') {
      if (ev.session_id) h.sessionId(ev.session_id);
      if (ev.is_error) {
        h.fail();
        const message = ev.result || 'Claude Code reported an error.';
        const quota = claudeQuotaFromText(message || ev.error || '');
        if (quota) {
          state.quota = quota;
          h.error('provider.quota', message);
        } else {
          h.error(/login|auth|api key/i.test(message) ? 'provider.auth' : 'provider.invalid-output', message);
        }
      } else if (ev.result) {
        h.final(ev.result);
      }
      const u = ev.usage;
      if (u) h.usage({ input: u.input_tokens || 0, output: u.output_tokens || 0, reasoning: u.output_tokens_details?.thinking_tokens || 0, cacheRead: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0 });
      if (ev.total_cost_usd != null) h.cost(ev.total_cost_usd);
      return;
    }
    if (ev.type === 'stream_event' && ev.event?.delta?.text) h.text(ev.event.delta.text);
    if (ev.type === 'rate_limit') {
      const text = ev.message || ev.error?.message || JSON.stringify(ev).slice(0, 2000);
      const quota = claudeQuotaFromText(text);
      if (quota) {
        state.quota = quota;
        h.fail();
        h.error('provider.quota', text);
      } else h.error('provider.rate-limit', text);
      return;
    }
    if (ev.type === 'error') h.error('provider.transport', ev.message || ev.error?.message || ev.type);
  }
}

/** Detect the Claude 5-hour/usage-window exhaustion from real CLI messages and reset hints. */
export function claudeQuotaFromText(text) {
  const message = String(text || '');
  if (!/usage limit|rate.?limit|quota|out of (?:credits|usage)|5[- ]hour|five[- ]hour|try again (?:at|in)|resets? (?:at|in)/i.test(message)) return null;
  const resetsAt = parseResetHint(message);
  return {
    exhausted: true,
    window: /5[- ]hour|five[- ]hour/i.test(message) ? '5h' : 'unknown',
    resetsAt,
    message: message.slice(0, 1000),
    source: 'claude-cli',
  };
}

/** Read `claude auth status` output (JSON, possibly with other lines around it, or plain text). */
export function parseClaudeAuthStatus(output) {
  const text = String(output || '').trim();
  const json = text.match(/\{[\s\S]*\}/)?.[0];
  if (json) {
    try {
      const j = JSON.parse(json);
      if (typeof j.loggedIn === 'boolean') return { loggedIn: j.loggedIn, label: j.loggedIn ? `signed in${j.authMethod && j.authMethod !== 'none' ? ` (${j.authMethod})` : ''}` : 'not signed in — run `claude auth login`' };
    } catch {}
  }
  const loggedIn = signedInFromText(text);
  return { loggedIn, label: loggedIn === false ? 'not signed in — run `claude auth login`' : text.split('\n')[0].slice(0, 160) || 'sign-in status unknown' };
}

export function claudeAuthHint(message) {
  return authHint(message);
}
