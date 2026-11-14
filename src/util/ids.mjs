import crypto from 'node:crypto';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

export function randomId(len = 12) {
  const bytes = crypto.randomBytes(len);
  let s = '';
  for (const b of bytes) s += ALPHABET[b % ALPHABET.length];
  return s;
}

/** Sortable id: base36 timestamp + random suffix. */
export function sortableId(prefix = '') {
  return prefix + Date.now().toString(36).padStart(9, '0') + randomId(8);
}

/** OpenCode 2.x message ids must match ^msg_ (Session.Message.ID in the server's OpenAPI). */
export const newMessageId = () => sortableId('msg_');

/**
 * Optional stable session id for tests, crash-recovery drills and debugging: set
 * SLEEPPILOT_SESSION_ID to reuse a session instead of creating a new one. Returns
 * an error string when the value cannot be used, so callers can explain why
 * instead of silently ignoring it.
 */
const warnedForcedIds = new Set();

export function forcedSessionId({ warn = null } = {}) {
  const raw = String(process.env.SLEEPPILOT_SESSION_ID || '').trim();
  if (!raw) return { id: null, error: null };
  const id = raw.slice(0, 120).replace(/[^A-Za-z0-9_-]/g, '');
  if (raw.length !== id.length || id.length < 3) {
    const error = `SLEEPPILOT_SESSION_ID can only contain letters, digits, "_" and "-" (at least 3 characters); ignoring "${raw.slice(0, 60)}".`;
    if (warn && !warnedForcedIds.has(error)) {
      warnedForcedIds.add(error);
      warn(error);
    }
    return { id: null, error };
  }
  return { id, error: null };
}

/** Shared session id used by every engine that keeps SleepPilot-side sessions. */
export const newEngineSessionId = (engine) => {
  const forced = forcedSessionId({ warn: (m) => console.warn(`[sleeppilot] ${m}`) });
  return forced.id || `ses_${engine}_${crypto.randomBytes(9).toString('hex')}`;
};

export const secret = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

export function slugify(s) {
  return (
    String(s || 'project')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/ı/g, 'i') // dotless i (Turkish) has no NFKD decomposition
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'project'
  );
}

export const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
