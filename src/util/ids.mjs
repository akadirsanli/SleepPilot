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
