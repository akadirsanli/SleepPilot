import { probeCandidates } from '../../tools/probe.mjs';
import { TOOLS } from '../../tools/catalog.mjs';

/**
 * Ollama discovery and provider setup.
 *
 * Ollama is a local service, not an API key: we check the binary, the running server
 * (`/api/version`, `/api/tags`) and the OpenAI-compatible surface (`/v1/models`). The models
 * listed by the native API are used to seed a SleepPilot API provider, so a local model can be
 * selected in the normal project setup without any key.
 */

export const DEFAULT_OLLAMA_HOST = 'http://127.0.0.1:11434';

export function normalizeOllamaBase(value) {
  let s = String(value || process.env.OLLAMA_HOST || DEFAULT_OLLAMA_HOST).trim();
  if (!s) s = DEFAULT_OLLAMA_HOST;
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  s = s.replace(/\/+$/, '').replace(/\/v1$/i, '');
  try {
    // OLLAMA_HOST is often host:port; clients need a URL with the default port.
    const u = new URL(s);
    if (!u.port) u.port = '11434';
    return `${u.protocol}//${u.host}`;
  } catch {
    return s;
  }
}

export function ollamaProviderBase(baseUrl) {
  const base = normalizeOllamaBase(baseUrl);
  return /\/v1$/i.test(base) ? base : `${base}/v1`;
}

export async function detectOllama({ baseUrl = null, timeoutMs = 4000 } = {}) {
  const base = normalizeOllamaBase(baseUrl);
  const tool = TOOLS.find((t) => t.id === 'ollama');
  const binaryPromise = tool?.probe ? probeCandidates(tool.probe.candidates, { args: tool.probe.args, re: tool.probe.re, timeoutMs: 8000 }) : Promise.resolve({ found: false, attempts: [] });
  const [binary, server] = await Promise.all([binaryPromise, probeServer(base, timeoutMs)]);
  const models = server.models || [];
  return {
    id: 'ollama',
    installed: !!binary.found || !!server.version || !!server.reachable,
    running: !!server.version || !!server.reachable,
    version: server.version || binary.version || null,
    binary: binary.file || null,
    baseUrl: base,
    openaiBaseUrl: ollamaProviderBase(base),
    models,
    error: server.error || null,
    attempts: binary.attempts || [],
    checkedAt: Date.now(),
  };
}

async function probeServer(base, timeoutMs) {
  const out = { version: null, models: [], error: null, reachable: false };
  try {
    const v = await getJson(`${base}/api/version`, timeoutMs);
    out.reachable = true;
    out.version = v?.version ? String(v.version) : null;
  } catch (err) {
    out.error = `Ollama is not reachable at ${base}: ${err.message}`;
  }
  try {
    const tags = await getJson(`${base}/api/tags`, timeoutMs);
    out.reachable = true;
    out.models = (tags?.models || []).map((m) => ({
      id: String(m.model || m.name || m.id),
      name: String(m.name || m.model || m.id),
      size: Number(m.size) || null,
      family: m.details?.family || null,
      parameterSize: m.details?.parameter_size || null,
      quantization: m.details?.quantization_level || null,
    }));
  } catch (err) {
    // The OpenAI-compatible endpoint is a fallback for very old servers.
    try {
      const j = await getJson(`${base}/v1/models`, timeoutMs);
      out.reachable = true;
      out.models = (j?.data || []).map((m) => ({ id: m.id, name: m.id, size: null, family: null, parameterSize: null, quantization: null }));
    } catch {
      if (!out.error) out.error = `Ollama is not reachable at ${base}: ${err.message}`;
    }
  }
  return out;
}

async function getJson(url, timeoutMs) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Convert detected Ollama models into a SleepPilot provider record (no key needed). */
export function ollamaProvider(status, { existing = null } = {}) {
  const models = (status.models || []).map((m) => ({ id: m.id, name: m.name, context: undefined }));
  const base = ollamaProviderBase(status.baseUrl);
  return {
    ...(existing || {}),
    id: 'ollama',
    preset: 'ollama',
    label: 'Ollama (local)',
    protocol: 'openai',
    baseUrl: base,
    apiKeyEnv: 'OLLAMA_API_KEY',
    requiresKey: false,
    enabled: true,
    maxOutputTokens: existing?.maxOutputTokens || 8192,
    stream: true,
    models: models.length ? models : existing?.models || [],
  };
}
