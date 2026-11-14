import { ExternalCliEngine, findExternalCli } from '../external-cli/engine.mjs';
import { runFile } from '../../util/proc.mjs';

/** Codex config vocabulary for `model_reasoning_effort`. */
export const CODEX_EFFORTS = ['minimal', 'low', 'medium', 'high'];

/**
 * Codex CLI engine.
 *
 * Uses `codex exec --json` (and `codex exec resume <thread>` for continuation). Codex runs its
 * own agent loop, sandbox and approvals; SleepPilot streams the JSONL events, keeps the thread id
 * and evaluates the resulting files with its normal checks. Authentication is Codex's own
 * (`codex login`); SleepPilot never asks for an OpenAI key for this engine.
 */
export class CodexEngine extends ExternalCliEngine {
  constructor({ settings = {}, credentials = null } = {}) {
    super({ id: 'codex', label: 'Codex CLI', settings, credentials });
    this.cli = { cliPath: null, model: null, sandbox: 'workspace-write', extraArgs: [], timeoutMin: 720, ...(settings.codex || {}) };
  }

  async probeCli() {
    const found = await findExternalCli({
      explicit: this.cli.cliPath,
      envNames: ['CODEX_CLI_PATH', 'CODEX_CLI'],
      candidates: [
        'codex',
        'codex.cmd',
        '%APPDATA%\\npm\\codex.cmd',
        '%LOCALAPPDATA%\\Programs\\codex\\codex.exe',
        '%USERPROFILE%\\.cargo\\bin\\codex.exe',
      ],
      re: /(\d+\.\d+\.\d+)/,
      versionArgs: ['--version'],
    });
    if (!found.found) return found;
    let auth = { loggedIn: null, label: 'sign-in status unknown' };
    const a = await runFile(found.path, ['login', 'status'], { timeoutMs: 30_000 }).catch(() => null);
    if (a) {
      const text = `${a.stdout || ''}${a.stderr || ''}`.trim();
      auth = { loggedIn: /logged in/i.test(text) ? true : /not logged in|logged out/i.test(text) ? false : null, label: text.split('\n')[0].slice(0, 160) || 'sign-in status unknown' };
    }
    const models = [{ id: 'default', name: 'Codex default model' }];
    if (this.cli.model && this.cli.model !== 'default') models.unshift({ id: this.cli.model, name: this.cli.model });
    return { ...found, auth, models };
  }

  buildArgs({ session, readOnly, profile }) {
    const effort = session.effort || this.cli.effort || null;
    if (effort && !CODEX_EFFORTS.includes(effort)) {
      const err = new Error(`Codex does not support effort "${effort}". Supported: ${CODEX_EFFORTS.join(', ')}.`);
      err.sleepPilotType = 'provider.config';
      throw err;
    }
    const resume = !!session.nativeSessionId;
    const args = resume ? ['exec', 'resume', session.nativeSessionId] : ['exec'];
    args.push('--json', '--skip-git-repo-check');
    if (!resume) args.push('--color', 'never');
    const sandbox = readOnly ? 'read-only' : profile === 'full' || profile === 'unrestricted' ? 'danger-full-access' : this.cli.sandbox || 'workspace-write';
    // `codex exec resume` does not accept --sandbox/--color, so the sandbox is set via config
    // there; the first turn uses the documented --sandbox flag.
    if (!resume) args.push('--sandbox', sandbox);
    else args.push('-c', `sandbox_mode="${sandbox}"`);
    // Headless runs cannot answer Codex approval prompts; the sandbox is the boundary.
    args.push('-c', 'approval_policy="never"');
    const model = this.cli.model || session.model?.id;
    if (model && model !== 'default') args.push('--model', model);
    if (effort) args.push('-c', `model_reasoning_effort="${effort}"`);
    args.push(...(this.cli.extraArgs || []));
    // `-` reads the prompt from stdin, avoiding command-line length limits.
    args.push('-');
    return { args };
  }

  parseLine(ev, state, h) {
    if (ev.type === 'thread.started' && ev.thread_id) {
      h.sessionId(ev.thread_id);
      return;
    }
    if (ev.type === 'turn.completed') {
      const u = ev.usage || {};
      h.usage({ input: u.input_tokens || 0, output: u.output_tokens || 0, reasoning: u.reasoning_output_tokens || 0, cacheRead: u.cached_input_tokens || 0, cacheWrite: u.cache_write_input_tokens || 0 });
      return;
    }
    if (ev.type === 'turn.failed' || ev.type === 'error') {
      h.fail();
      h.error(/login|auth|api key/i.test(ev.message || JSON.stringify(ev)) ? 'provider.auth' : 'provider.transport', ev.message || ev.error?.message || 'Codex reported an error.');
      return;
    }
    if ((ev.type === 'item.started' || ev.type === 'item.completed' || ev.type === 'item.updated') && ev.item) {
      const item = ev.item;
      if (item.type === 'agent_message' && item.text) {
        if (ev.type === 'item.completed') h.final(item.text);
        h.text(item.text);
        return;
      }
      if (item.type === 'reasoning' && item.text) {
        h.reasoning(item.text);
        return;
      }
      if (item.type === 'command_execution') {
        if (ev.type === 'item.started') h.toolStart(item.id, 'shell', { command: item.command });
        else if (ev.type === 'item.completed') {
          const output = item.aggregated_output || '';
          const failed = item.exit_code != null && item.exit_code !== 0;
          h.toolEnd(item.id, { status: failed || item.status === 'failed' ? 'error' : 'completed', output, error: failed ? output || `exit code ${item.exit_code}` : null });
        }
        return;
      }
      if (item.type === 'file_change') {
        const changes = item.changes || [];
        const desc = changes.map((c) => `${c.kind || 'change'} ${c.path || c.file || ''}`).join(', ') || 'file change';
        if (ev.type === 'item.started') h.toolStart(item.id, 'file_change', { changes });
        else if (ev.type === 'item.completed') h.toolEnd(item.id, { status: 'completed', output: desc });
        return;
      }
      if (item.type === 'error') {
        h.fail();
        h.error('provider.transport', item.message || 'Codex item error.');
      }
    }
  }
}
