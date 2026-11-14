/**
 * Extract a JSON object from model output. Prefers the last ```json fenced block,
 * then the last balanced {...} object in the text. Returns null if nothing parses.
 */
export function extractJson(text) {
  if (!text) return null;
  const fences = [...String(text).matchAll(/```(?:json|JSON)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]);
  for (const f of fences.reverse()) {
    const v = tryParse(f);
    if (v && typeof v === 'object') return v;
  }
  const objects = balancedObjects(String(text));
  for (const o of objects.reverse()) {
    const v = tryParse(o);
    if (v && typeof v === 'object') return v;
  }
  return null;
}

function tryParse(s) {
  try {
    return JSON.parse(s.trim());
  } catch {
    // Tolerate trailing commas, a common model mistake.
    try {
      return JSON.parse(s.trim().replace(/,\s*([}\]])/g, '$1'));
    } catch {
      return null;
    }
  }
}

function balancedObjects(s) {
  const out = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '{') continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < s.length; j++) {
      const c = s[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          out.push(s.slice(i, j + 1));
          i = j;
          break;
        }
      }
    }
  }
  return out;
}

/** Parse the developer's required final status line. */
export function parseDeveloperStatus(text) {
  const m = [...String(text || '').matchAll(/SLEEPPILOT_STATUS\s*:\s*(done|blocked|needs_user|partial)\b[ \t]*[-—:]?[ \t]*(.*)/gi)].pop();
  if (!m) return { status: 'unreported', reason: '' };
  return { status: m[1].toLowerCase(), reason: m[2].trim().slice(0, 1000) };
}
