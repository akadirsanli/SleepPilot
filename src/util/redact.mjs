/**
 * Credential redaction applied to everything SleepPilot logs, persists, or exports.
 * SleepPilot never reads OpenCode credential files; this is a second line of defence
 * against secrets that appear in model output, command output, or errors.
 */
const registered = new Set();

/** Register a runtime secret (e.g. the per-launch server password) for exact-match redaction. */
export function registerSecret(value) {
  if (value && String(value).length >= 8) registered.add(String(value));
}

const PATTERNS = [
  // Authorization headers
  [/(authorization\s*[:=]\s*)(basic|bearer)\s+[A-Za-z0-9+/=._-]+/gi, '$1$2 <redacted>'],
  // key=value / "key": "value" for sensitive key names
  [
    /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|passwd|client[_-]?secret|OPENCODE_PASSWORD|OPENCODE_SERVER_PASSWORD)["']?\s*[:=]\s*["']?)([^"'\s,}]{4,})/gi,
    '$1<redacted>',
  ],
  // Common provider key shapes
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, '<redacted-key>'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '<redacted-key>'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '<redacted-key>'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, '<redacted-key>'],
];

export function redact(text) {
  if (text == null) return text;
  let s = String(text);
  for (const sec of registered) if (s.includes(sec)) s = s.split(sec).join('<redacted>');
  for (const [re, rep] of PATTERNS) s = s.replace(re, rep);
  return s;
}

/** Deep-redact all string values in a JSON-compatible value. */
export function redactDeep(value) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = /^(password|apiKey|api_key|token|secret|authorization)$/i.test(k) ? '<redacted>' : redactDeep(v);
    }
    return out;
  }
  return value;
}
