/**
 * Classify OpenCode / provider failures into categories with distinct handling.
 * Input: a Session.StructuredError ({type, message, status}) from a message or idle marker,
 * an OpenCodeHttpError, or an OpenCodeConnectionError.
 *
 * action:
 *   'retry'  — temporary; SleepPilot retries with bounded exponential backoff
 *   'pause'  — needs the user (quota, account, configuration); never retried automatically
 *   'none'   — not a provider failure (e.g. the user interrupted)
 */
export function classifyError(err) {
  if (!err) return null;
  const type = String(err.type || err.tag || '').toLowerCase();
  const status = err.status ?? err.response?.status;
  const message = String(err.message || '');
  const lower = message.toLowerCase();

  if (type === 'aborted' || type.endsWith('.interrupted')) {
    return { category: 'aborted', action: 'none', message, label: 'Interrupted by the user' };
  }
  // A permission the user (or a deny rule) refused is a decision, not a provider failure.
  if (type.startsWith('permission.') || /user declined|permission denied/.test(lower)) {
    return { category: 'permission_rejected', action: 'none', message, label: 'Permission rejected' };
  }
  if (type === 'provider.quota' || status === 402 || /quota|insufficient (balance|credit|funds)|allowance|usage limit|limit reached|out of credits/.test(lower)) {
    return {
      category: 'quota',
      action: 'pause',
      message,
      label: 'Provider quota / usage allowance exhausted',
      hint: 'Your OpenCode Go allowance may be used up. Check the remaining allowance in the OpenCode Console. SleepPilot never changes extra-usage or billing settings.',
    };
  }
  if (type === 'provider.rate-limit' || status === 429 || /rate.?limit|too many requests/.test(lower)) {
    return { category: 'rate_limit', action: 'retry', message, label: 'Rate limit (429)', hint: 'Will be retried after a controlled wait.' };
  }
  if (type === 'provider.auth' || status === 401 || status === 403 || /unauthori[sz]ed|invalid api key|authentication|forbidden/.test(lower)) {
    return {
      category: 'auth',
      action: 'pause',
      message,
      label: 'Authentication / account error',
      hint: 'Check your OpenCode login (OpenCode Desktop or `opencode auth list`). SleepPilot never reads or stores credentials.',
    };
  }
  if (['provider.timeout', 'provider.transport', 'provider.internal'].includes(type) || (status >= 500 && status < 600) || err.name === 'OpenCodeConnectionError' || /timeout|timed out|econnreset|socket hang up|network|fetch failed|econnrefused/.test(lower)) {
    return { category: 'transient', action: 'retry', message, label: 'Temporary network / server error', hint: 'Will be retried after a controlled wait.' };
  }
  // Seen on a real run (glm-5.3-flash through OpenCode's OpenAI-compatible adapter): "OpenAI Chat
  // stream ended without finish_reason". The answer was cut off in transit — temporary.
  // Also seen: "Response still truncated after two output token limit continuations" — the model
  // produced more than it may return in one answer. Retrying (the developer then works in smaller
  // steps, see the follow-up prompt) is the right reaction, not a pause.
  if (type === 'provider.invalid-output' || /stream ended|without finish_reason|incomplete (stream|response)|unexpected end|still truncated|output token limit/.test(lower)) {
    return { category: 'transient', action: 'retry', message, label: 'Provider response cut off', hint: 'The model response stream did not complete (temporary provider problem). Will be retried after a controlled wait.' };
  }
  if (type === 'provider.content-filter') {
    return { category: 'content_filter', action: 'pause', message, label: 'Content filter', hint: 'The provider blocked the response; the task may need rewording.' };
  }
  // A 4xx from OpenCode's own HTTP API (not a model/provider error inside a turn) means SleepPilot
  // sent a request this OpenCode version does not accept — e.g. InvalidCursorError on 2.2.0.
  // It is not the user's model configuration; the run controller retries it in sleep mode.
  if (err.name === 'OpenCodeHttpError' && status >= 400 && status < 500) {
    return { category: 'opencode_api', action: 'pause', message, label: 'OpenCode API request rejected', hint: 'SleepPilot and this OpenCode version may be incompatible; details are in the log.' };
  }
  if (['provider.invalid-request', 'provider.no-route', 'provider.unsupported-operation'].includes(type) || status === 400 || status === 404) {
    return {
      category: 'config',
      action: 'pause',
      message,
      label: 'Model / provider configuration error',
      hint: 'The selected model may not be available for this account (e.g. privacy setting, model access). Choose another model or check the OpenCode Console settings.',
    };
  }
  // Any other provider-side error type: try again with backoff before asking a person.
  if (type.startsWith('provider.')) {
    return { category: 'transient', action: 'retry', message, label: `Provider error (${type})`, hint: 'Will be retried after a controlled wait.' };
  }
  return { category: 'unknown', action: 'pause', message, label: 'Unexpected error' };
}
