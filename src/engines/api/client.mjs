/**
 * Small, dependency-free client for the two tool-calling protocols SleepPilot's built-in engine
 * speaks: OpenAI-compatible chat completions (the overwhelming majority of providers, including
 * DeepSeek, Ollama, LM Studio, OpenRouter, Groq, Mistral, xAI and vLLM) and Anthropic Messages.
 *
 * It streams when the provider can; when it cannot, the same result is read from a normal JSON
 * response. Every failure is turned into an ApiError carrying an HTTP status so the run
 * controller's existing error classification keeps working.
 */

const decoder = new TextDecoder();

export class ApiError extends Error {
  constructor(message, { status = null, body = null, retryable = false, unsupportedTools = false } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
    this.retryable = retryable;
    this.unsupportedTools = unsupportedTools;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function statusType(status) {
  if (status === 401 || status === 403) return 'provider.auth';
  if (status === 402) return 'provider.quota';
  if (status === 429) return 'provider.rate-limit';
  if (status === 400 || status === 404 || status === 422) return 'provider.invalid-request';
  if (status === 408 || status === 409) return 'provider.timeout';
  if (status >= 500) return 'provider.transport';
  return 'provider.invalid-request';
}

function errorMessage(body, fallback) {
  if (!body) return fallback;
  if (typeof body === 'string') return body.slice(0, 2000);
  const e = body.error ?? body;
  if (typeof e === 'string') return e.slice(0, 2000);
  return String(e.message || e.detail || body.message || fallback).slice(0, 2000);
}

function mergeSignals(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!signal) return timeout;
  return AbortSignal.any ? AbortSignal.any([signal, timeout]) : signal;
}

export class ChatClient {
  constructor({ provider, apiKey, timeoutMs = 600_000, fetchImpl = globalThis.fetch } = {}) {
    this.provider = provider;
    this.apiKey = apiKey || '';
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
    this.toolsSupported = true;
  }

  get protocol() {
    return this.provider.protocol === 'anthropic' ? 'anthropic' : 'openai';
  }

  baseUrl() {
    return String(this.provider.baseUrl || '').replace(/\/+$/, '');
  }

  endpoint(path, fullPattern) {
    const base = this.baseUrl();
    if (!base) throw new ApiError('The provider has no base URL. Add one in Settings → Engines.', { status: 400 });
    if (fullPattern && fullPattern.test(base)) return base;
    return `${base}/${path}`;
  }

  headers() {
    const h = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    if (this.protocol === 'anthropic') {
      if (this.apiKey) h['x-api-key'] = this.apiKey;
      h['anthropic-version'] = '2023-06-01';
    } else if (this.apiKey) {
      h.authorization = `Bearer ${this.apiKey}`;
    }
    for (const [k, v] of Object.entries(this.provider.extraHeaders || {})) if (k && v) h[String(k)] = String(v);
    return h;
  }

  async request(url, body, signal) {
    let res;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: mergeSignals(signal, this.timeoutMs),
      });
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      throw new ApiError(`Network error: ${err.message}`, { retryable: true });
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let parsed = text;
      try {
        parsed = JSON.parse(text);
      } catch {}
      const message = errorMessage(parsed, `HTTP ${res.status}`);
      const lower = message.toLowerCase();
      const unsupportedTools = res.status === 400 && /tool|function|tool_choice/.test(lower) && /support|unknown|unrecognized|invalid|not allowed/.test(lower);
      throw new ApiError(message, { status: res.status, body: parsed, retryable: res.status === 429 || res.status >= 500 || res.status === 408, unsupportedTools });
    }
    return res;
  }

  async listModels(signal) {
    const url = this.endpoint('models', /\/(models)$/);
    let res;
    try {
      res = await this.fetchImpl(url, { headers: this.headers(), signal: mergeSignals(signal, 30_000) });
    } catch (err) {
      throw new ApiError(`Could not list models: ${err.message}`, { retryable: true });
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new ApiError(`Model listing failed: HTTP ${res.status} ${text.slice(0, 300)}`, { status: res.status });
    }
    const json = await res.json().catch(() => ({}));
    const rows = Array.isArray(json.data) ? json.data : Array.isArray(json.models) ? json.models : [];
    return rows
      .map((m) => {
        const id = m.id || m.model || m.name;
        if (!id) return null;
        const context = Number(m.context_length || m.context_window || m.limit?.context || 0) || undefined;
        const priceIn = Number(m.pricing?.prompt ?? m.cost?.input ?? NaN);
        const priceOut = Number(m.pricing?.completion ?? m.cost?.output ?? NaN);
        return {
          id: String(id),
          name: String(m.display_name || m.name || id),
          context,
          // OpenRouter/Ollama prices are per token; normalise to per 1M tokens.
          priceInput: Number.isFinite(priceIn) ? (priceIn > 0 && priceIn < 1 ? priceIn * 1_000_000 : priceIn) : undefined,
          priceOutput: Number.isFinite(priceOut) ? (priceOut > 0 && priceOut < 1 ? priceOut * 1_000_000 : priceOut) : undefined,
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * One assistant step. Returns { text, reasoning, toolCalls, usage, finishReason } and emits
   * { onEvent({ kind:'text'|'reasoning', delta }) } while streaming.
   */
  async complete({ model, system, messages, tools = [], signal, temperature = 0.2, maxOutputTokens, reasoningEffort = null, onEvent }) {
    const wantsTools = tools.length > 0 && this.toolsSupported;
    const maxOut = Math.max(256, Math.min(200_000, Number(maxOutputTokens) || this.provider.maxOutputTokens || 8192));
    if (this.protocol === 'anthropic') return this._anthropicComplete({ model, system, messages, tools: wantsTools ? tools : [], signal, temperature, maxOut, reasoningEffort, onEvent });
    return this._openaiComplete({ model, system, messages, tools: wantsTools ? tools : [], signal, temperature, maxOut, reasoningEffort, onEvent });
  }

  // ---------------------------------------------------------------- OpenAI-compatible

  async _openaiComplete({ model, system, messages, tools, signal, temperature, maxOut, reasoningEffort = null, onEvent }) {
    const body = {
      model,
      messages: toOpenAiMessages(system, messages),
      temperature,
      max_tokens: maxOut,
      stream: this.provider.stream !== false,
    };
    // DeepSeek/OpenAI-compatible reasoning effort. `off`/`none` mean "do not send the parameter";
    // every other value is passed through and the provider decides whether it supports it.
    if (reasoningEffort && !['off', 'none'].includes(reasoningEffort)) body.reasoning_effort = reasoningEffort;
    if (body.stream) body.stream_options = { include_usage: true };
    if (tools.length) {
      body.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
      body.tool_choice = 'auto';
    }
    let res;
    try {
      res = await this.request(this.endpoint('chat/completions', /\/(chat\/completions)$/), body, signal);
    } catch (err) {
      // A provider may reject stream_options specifically; retry once without it.
      if (err instanceof ApiError && err.status === 400 && body.stream_options) {
        delete body.stream_options;
        res = await this.request(this.endpoint('chat/completions', /\/(chat\/completions)$/), body, signal);
      } else if (err instanceof ApiError && err.unsupportedTools && body.tools) {
        // Some local servers accept the request but not tool definitions. Fall back to a text
        // protocol; the engine will parse tool blocks from the answer.
        this.toolsSupported = false;
        delete body.tools;
        delete body.tool_choice;
        res = await this.request(this.endpoint('chat/completions', /\/(chat\/completions)$/), body, signal);
      } else throw err;
    }
    const ctype = res.headers.get('content-type') || '';
    if (!body.stream || !ctype.includes('text/event-stream')) {
      const json = await res.json().catch(() => ({}));
      return parseOpenAiResponse(json, onEvent);
    }
    return this._openaiStream(res, onEvent);
  }

  async _openaiStream(res, onEvent) {
    const out = { text: '', reasoning: '', toolCalls: [], usage: emptyUsage(), finishReason: null };
    const calls = new Map();
    let buffer = '';
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let j;
        try {
          j = JSON.parse(payload);
        } catch {
          continue;
        }
        if (j.error) throw new ApiError(errorMessage(j, 'Provider stream error'), { status: j.error?.code || null, retryable: true });
        if (j.usage) out.usage = mergeUsage(out.usage, openAiUsage(j.usage));
        const choice = j.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) out.finishReason = choice.finish_reason;
        const d = choice.delta || choice.message || {};
        const text = deltaText(d.content);
        if (text) {
          out.text += text;
          onEvent?.({ kind: 'text', delta: text });
        }
        const reasoning = d.reasoning_content || d.reasoning;
        if (typeof reasoning === 'string' && reasoning) {
          out.reasoning += reasoning;
          onEvent?.({ kind: 'reasoning', delta: reasoning });
        }
        for (const tc of d.tool_calls || []) {
          const key = tc.index ?? 0;
          const cur = calls.get(key) || { id: '', name: '', args: '' };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name += tc.function.name;
          if (tc.function?.arguments) cur.args += tc.function.arguments;
          calls.set(key, cur);
        }
      }
    }
    out.toolCalls = [...calls.values()]
      .filter((c) => c.name)
      .map((c, i) => ({ id: c.id || `call_${Date.now().toString(36)}_${i}`, name: c.name, args: safeJson(c.args) }));
    return out;
  }

  // ---------------------------------------------------------------- Anthropic

  async _anthropicComplete({ model, system, messages, tools, signal, temperature, maxOut, reasoningEffort = null, onEvent }) {
    const budget = { minimal: 1024, low: 2048, medium: 4096, high: 6144, xhigh: 8192, max: 12_000, ultra: 16_000 }[reasoningEffort];
    const maxTokens = budget ? Math.max(maxOut, budget + 4096) : maxOut;
    const body = {
      model,
      system,
      messages: toAnthropicMessages(messages),
      max_tokens: maxTokens,
      temperature,
      stream: this.provider.stream !== false,
    };
    if (budget) {
      body.thinking = { type: 'enabled', budget_tokens: budget };
      // Anthropic rejects a custom temperature when extended thinking is enabled.
      delete body.temperature;
    }
    if (tools.length) body.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
    let res;
    try {
      res = await this.request(this.endpoint('messages', /\/(messages)$/), body, signal);
    } catch (err) {
      if (err instanceof ApiError && err.unsupportedTools && body.tools) {
        this.toolsSupported = false;
        delete body.tools;
        res = await this.request(this.endpoint('messages', /\/(messages)$/), body, signal);
      } else throw err;
    }
    const ctype = res.headers.get('content-type') || '';
    if (!body.stream || !ctype.includes('text/event-stream')) {
      const json = await res.json().catch(() => ({}));
      return parseAnthropicResponse(json, onEvent);
    }
    return this._anthropicStream(res, onEvent);
  }

  async _anthropicStream(res, onEvent) {
    const out = { text: '', reasoning: '', toolCalls: [], usage: emptyUsage(), finishReason: null };
    const blocks = new Map();
    let buffer = '';
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let j;
        try {
          j = JSON.parse(payload);
        } catch {
          continue;
        }
        if (j.type === 'error') throw new ApiError(errorMessage(j, 'Provider stream error'), { retryable: true });
        if (j.type === 'message_start') {
          out.usage.input += j.message?.usage?.input_tokens || 0;
          out.usage.cacheRead += j.message?.usage?.cache_read_input_tokens || 0;
          out.usage.cacheWrite += j.message?.usage?.cache_creation_input_tokens || 0;
        } else if (j.type === 'content_block_start') {
          const b = j.content_block || {};
          const cur = { type: b.type, id: b.id, name: b.name, text: b.text || '', json: '', thinking: b.thinking || '' };
          blocks.set(j.index, cur);
          if (b.type === 'text' && b.text) {
            out.text += b.text;
            onEvent?.({ kind: 'text', delta: b.text });
          }
        } else if (j.type === 'content_block_delta') {
          const cur = blocks.get(j.index) || { type: 'text', text: '' };
          const d = j.delta || {};
          if (d.type === 'text_delta' && d.text) {
            cur.text += d.text;
            out.text += d.text;
            onEvent?.({ kind: 'text', delta: d.text });
          } else if (d.type === 'thinking_delta' && d.thinking) {
            cur.thinking += d.thinking;
            out.reasoning += d.thinking;
            onEvent?.({ kind: 'reasoning', delta: d.thinking });
          } else if (d.type === 'input_json_delta' && d.partial_json) {
            cur.json += d.partial_json;
          }
          blocks.set(j.index, cur);
        } else if (j.type === 'content_block_stop') {
          const cur = blocks.get(j.index);
          if (cur?.type === 'tool_use' && cur.name) out.toolCalls.push({ id: cur.id || `tool_${Date.now().toString(36)}_${out.toolCalls.length}`, name: cur.name, args: safeJson(cur.json) });
        } else if (j.type === 'message_delta') {
          if (j.delta?.stop_reason) out.finishReason = j.delta.stop_reason;
          if (j.usage) out.usage.output += j.usage.output_tokens || 0;
        }
      }
    }
    return out;
  }
}

// ------------------------------------------------------------------ conversion helpers

export function toOpenAiMessages(system, messages) {
  const out = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: m.toolCallId, content: String(m.content ?? '') });
    } else if (m.role === 'assistant') {
      const msg = { role: 'assistant', content: m.content || null };
      if (m.toolCalls?.length) {
        msg.tool_calls = m.toolCalls.map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.args ?? {}) } }));
      }
      out.push(msg);
    } else {
      out.push({ role: 'user', content: String(m.content ?? '') });
    }
  }
  return out;
}

export function toAnthropicMessages(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'tool') {
      const block = { type: 'tool_result', tool_use_id: m.toolCallId, content: String(m.content ?? '') };
      const last = out[out.length - 1];
      if (last?.role === 'user' && Array.isArray(last.content)) last.content.push(block);
      else out.push({ role: 'user', content: [block] });
    } else if (m.role === 'assistant') {
      const content = [];
      if (m.content) content.push({ type: 'text', text: String(m.content) });
      for (const t of m.toolCalls || []) content.push({ type: 'tool_use', id: t.id, name: t.name, input: t.args ?? {} });
      out.push({ role: 'assistant', content: content.length ? content : [{ type: 'text', text: '(no text)' }] });
    } else {
      out.push({ role: 'user', content: [{ type: 'text', text: String(m.content ?? '') }] });
    }
  }
  return out;
}

function parseOpenAiResponse(json, onEvent) {
  const choice = json.choices?.[0] || {};
  const msg = choice.message || {};
  const text = deltaText(msg.content);
  if (text) onEvent?.({ kind: 'text', delta: text });
  const reasoning = msg.reasoning_content || msg.reasoning;
  if (reasoning) onEvent?.({ kind: 'reasoning', delta: reasoning });
  return {
    text: text || '',
    reasoning: typeof reasoning === 'string' ? reasoning : '',
    toolCalls: (msg.tool_calls || [])
      .filter((t) => t.function?.name)
      .map((t, i) => ({ id: t.id || `call_${Date.now().toString(36)}_${i}`, name: t.function.name, args: safeJson(t.function.arguments) })),
    usage: openAiUsage(json.usage),
    finishReason: choice.finish_reason || null,
  };
}

function parseAnthropicResponse(json, onEvent) {
  const textParts = [];
  const thinking = [];
  const toolCalls = [];
  for (const b of json.content || []) {
    if (b.type === 'text' && b.text) textParts.push(b.text);
    if (b.type === 'thinking' && b.thinking) thinking.push(b.thinking);
    if (b.type === 'tool_use') toolCalls.push({ id: b.id, name: b.name, args: b.input || {} });
  }
  const text = textParts.join('');
  if (text) onEvent?.({ kind: 'text', delta: text });
  return {
    text,
    reasoning: thinking.join(''),
    toolCalls,
    usage: {
      input: json.usage?.input_tokens || 0,
      output: json.usage?.output_tokens || 0,
      reasoning: 0,
      cacheRead: json.usage?.cache_read_input_tokens || 0,
      cacheWrite: json.usage?.cache_creation_input_tokens || 0,
    },
    finishReason: json.stop_reason || null,
  };
}

function deltaText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('');
  return '';
}

function openAiUsage(u) {
  if (!u) return emptyUsage();
  return {
    input: u.prompt_tokens || 0,
    output: u.completion_tokens || 0,
    reasoning: u.completion_tokens_details?.reasoning_tokens || 0,
    cacheRead: u.prompt_tokens_details?.cached_tokens || 0,
    cacheWrite: 0,
  };
}

function mergeUsage(a, b) {
  // Providers send usage once, usually in the final chunk; keep the latest non-zero value.
  return {
    input: b.input || a.input,
    output: b.output || a.output,
    reasoning: b.reasoning || a.reasoning,
    cacheRead: b.cacheRead || a.cacheRead,
    cacheWrite: b.cacheWrite || a.cacheWrite,
  };
}

export function emptyUsage() {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
}

function safeJson(text) {
  if (!text) return {};
  if (typeof text === 'object') return text;
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: String(text).slice(0, 4000) };
  }
}

export { sleep };
