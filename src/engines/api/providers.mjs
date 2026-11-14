/**
 * Provider presets for the built-in API engine.
 *
 * "Protocol" is what SleepPilot speaks:
 *   openai     - POST {baseUrl}/chat/completions with tool calling (DeepSeek, OpenAI, Groq,
 *                OpenRouter, Mistral, xAI, Ollama, LM Studio, vLLM, any compatible gateway)
 *   anthropic  - POST {baseUrl}/messages with tool use
 *
 * Model lists are suggestions only. The engine refreshes them from the provider's /models
 * endpoint when available, and users can add or remove model ids in Settings.
 */
export const PROVIDER_PRESETS = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    protocol: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    requiresKey: true,
    models: [
      { id: 'deepseek-chat', name: 'DeepSeek Chat', context: 128000 },
      { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', context: 128000, reasoning: true },
    ],
  },
  {
    id: 'openai',
    label: 'OpenAI',
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKeyEnv: 'OPENAI_API_KEY',
    requiresKey: true,
    models: [
      { id: 'gpt-4.1', name: 'GPT-4.1', context: 1047576 },
      { id: 'gpt-4.1-mini', name: 'GPT-4.1 mini', context: 1047576 },
      { id: 'gpt-4o', name: 'GPT-4o', context: 128000 },
      { id: 'o4-mini', name: 'o4-mini', context: 200000, reasoning: true },
    ],
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    requiresKey: true,
    maxOutputTokens: 8192,
    models: [
      { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', context: 200000 },
      { id: 'claude-opus-4-1', name: 'Claude Opus 4.1', context: 200000 },
      { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', context: 200000 },
    ],
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    protocol: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    requiresKey: true,
    models: [],
  },
  {
    id: 'groq',
    label: 'Groq',
    protocol: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKeyEnv: 'GROQ_API_KEY',
    requiresKey: true,
    models: [],
  },
  {
    id: 'mistral',
    label: 'Mistral',
    protocol: 'openai',
    baseUrl: 'https://api.mistral.ai/v1',
    apiKeyEnv: 'MISTRAL_API_KEY',
    requiresKey: true,
    models: [],
  },
  {
    id: 'xai',
    label: 'xAI',
    protocol: 'openai',
    baseUrl: 'https://api.x.ai/v1',
    apiKeyEnv: 'XAI_API_KEY',
    requiresKey: true,
    models: [],
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    protocol: 'openai',
    baseUrl: 'http://127.0.0.1:11434/v1',
    apiKeyEnv: 'OLLAMA_API_KEY',
    requiresKey: false,
    models: [],
  },
  {
    id: 'lmstudio',
    label: 'LM Studio (local)',
    protocol: 'openai',
    baseUrl: 'http://127.0.0.1:1234/v1',
    apiKeyEnv: 'LMSTUDIO_API_KEY',
    requiresKey: false,
    models: [],
  },
  {
    id: 'custom',
    label: 'Custom OpenAI-compatible endpoint',
    protocol: 'openai',
    baseUrl: '',
    apiKeyEnv: 'CUSTOM_API_KEY',
    requiresKey: false,
    models: [],
  },
];

export const presetById = (id) => PROVIDER_PRESETS.find((p) => p.id === id) || null;

export function newProvider(presetId = 'deepseek') {
  const p = presetById(presetId) || PROVIDER_PRESETS[0];
  return {
    id: p.id === 'custom' ? `custom-${Date.now().toString(36)}` : p.id,
    preset: p.id,
    label: p.label,
    protocol: p.protocol,
    baseUrl: p.baseUrl,
    apiKeyEnv: p.apiKeyEnv,
    requiresKey: p.requiresKey,
    maxOutputTokens: p.maxOutputTokens || 8192,
    stream: true,
    enabled: true,
    models: p.models.map((m) => ({ ...m })),
    extraHeaders: {},
  };
}

/** Normalise a provider record coming from the settings file or the UI. */
export function normalizeProvider(raw, index = 0) {
  const preset = presetById(raw?.preset) || null;
  const protocol = raw?.protocol === 'anthropic' ? 'anthropic' : 'openai';
  const models = (Array.isArray(raw?.models) ? raw.models : [])
    .map((m) => (typeof m === 'string' ? { id: m } : m))
    .filter((m) => m && m.id)
    .map((m) => ({
      id: String(m.id),
      name: String(m.name || m.id),
      context: Number(m.context) > 0 ? Number(m.context) : undefined,
      reasoning: !!m.reasoning,
      priceInput: Number.isFinite(Number(m.priceInput)) ? Number(m.priceInput) : undefined,
      priceOutput: Number.isFinite(Number(m.priceOutput)) ? Number(m.priceOutput) : undefined,
    }));
  return {
    id: String(raw?.id || `provider-${index + 1}`).slice(0, 80),
    preset: raw?.preset || preset?.id || 'custom',
    label: String(raw?.label || preset?.label || raw?.id || `Provider ${index + 1}`).slice(0, 80),
    protocol,
    baseUrl: String(raw?.baseUrl || preset?.baseUrl || '').replace(/\/+$/, ''),
    apiKeyEnv: String(raw?.apiKeyEnv || preset?.apiKeyEnv || '').slice(0, 80),
    requiresKey: raw?.requiresKey ?? preset?.requiresKey ?? true,
    maxOutputTokens: Math.max(256, Math.min(200_000, Number(raw?.maxOutputTokens) || preset?.maxOutputTokens || 8192)),
    stream: raw?.stream !== false,
    enabled: raw?.enabled !== false,
    models,
    extraHeaders: raw?.extraHeaders && typeof raw.extraHeaders === 'object' ? raw.extraHeaders : {},
  };
}
