/**
 * Extract and classify printable strings from a binary. This is deliberately not `strings(1)`:
 * it also reads UTF-16LE, deduplicates, keeps offsets, and ranks the strings that actually help a
 * reverse engineer (URLs, paths, registry keys, error messages, format strings, crypto names).
 */

const MIN_ASCII = 5;
const MIN_UTF16 = 4;
const MAX_STRING = 400;
const MAX_TOTAL = 6000;

export function extractStrings(buf, { max = MAX_TOTAL } = {}) {
  const found = new Map();
  let ascii = '';
  let asciiStart = 0;
  const push = (text, offset, encoding) => {
    const clean = text.replace(/[\u0000-\u001f]+$/g, '').trim();
    if (clean.length < MIN_ASCII || found.has(clean)) return;
    if (found.size >= max) return;
    found.set(clean, { text: clean.slice(0, MAX_STRING), offset, encoding, kind: classify(clean) });
  };
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i];
    if (c >= 0x20 && c < 0x7f) {
      if (!ascii) asciiStart = i;
      ascii += String.fromCharCode(c);
    } else {
      if (ascii.length >= MIN_ASCII) push(ascii, asciiStart, 'ascii');
      ascii = '';
    }
  }
  if (ascii.length >= MIN_ASCII) push(ascii, asciiStart, 'ascii');
  // UTF-16LE: printable ASCII followed by NUL, repeated.
  let wide = '';
  let wideStart = 0;
  for (let i = 0; i + 1 < buf.length; i += 2) {
    const c = buf[i];
    const z = buf[i + 1];
    if (z === 0 && c >= 0x20 && c < 0x7f) {
      if (!wide) wideStart = i;
      wide += String.fromCharCode(c);
    } else {
      if (wide.length >= MIN_UTF16) push(wide, wideStart, 'utf16le');
      wide = '';
    }
  }
  if (wide.length >= MIN_UTF16) push(wide, wideStart, 'utf16le');
  return [...found.values()];
}

const INTERESTING = [
  ['url', /\bhttps?:\/\/[^\s"'<>)]+/i],
  ['registry', /\bHK(LM|CU|CR|U|CC)\\[^\s"']+/],
  ['path', /(?:[A-Za-z]:\\|\\\\|\/(?:usr|etc|home|opt|var)\/)[^\s"']{3,}/],
  ['email', /[\w.+-]+@[\w.-]+\.[a-z]{2,}/i],
  ['ip', /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/],
  ['version', /\bv?\d+\.\d+(?:\.\d+){1,3}\b/],
  ['format', /%(?:\d+\$)?[-+ #0]*\d*(?:\.\d+)?[diouxXeEfgGaAcspn%]/],
  ['crypto', /\b(aes|rsa|sha-?1|sha-?256|md5|hmac|base64|xor|chacha|ed25519|pbkdf2|bcrypt)\b/i],
  ['api', /\b(?:Create|Open|Read|Write|Reg|Get|Set|Load|Find|Query|Send|Recv|Internet)[A-Z]\w{3,}\b/],
  ['error', /\b(error|failed|invalid|cannot|unable|denied|missing|corrupt|unsupported)\b/i],
  ['debug', /\b(assert|debug|panic|traceback|exception|stack)\b/i],
  ['secret', /\b(password|passwd|token|api[_-]?key|secret|license|activation|serial)\b/i],
];

export function classify(text) {
  for (const [kind, re] of INTERESTING) if (re.test(text)) return kind;
  return 'text';
}

/** The subset worth putting in front of a model, grouped and capped. */
export function interestingStrings(list, perKind = 120) {
  const groups = new Map();
  for (const s of list) {
    if (s.kind === 'text') continue;
    if (!groups.has(s.kind)) groups.set(s.kind, []);
    const arr = groups.get(s.kind);
    if (arr.length < perKind) arr.push(s);
  }
  return Object.fromEntries(groups);
}

export function summarizeStrings(list) {
  const byKind = {};
  for (const s of list) byKind[s.kind] = (byKind[s.kind] || 0) + 1;
  return byKind;
}
