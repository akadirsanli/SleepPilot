import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

/**
 * Minimal ZIP reader (stored + deflate, no ZIP64, no encryption) — enough to list an APK's
 * contents and to unpack a Gradle distribution without any dependency. Entries are read from the
 * file one at a time, so a large archive is never loaded into memory as a whole.
 */
const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

async function readAt(handle, position, length) {
  const buf = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const { bytesRead } = await handle.read(buf, done, length - done, position + done);
    if (!bytesRead) break;
    done += bytesRead;
  }
  if (done !== length) throw new Error('Unexpected end of the ZIP file.');
  return buf;
}

/** List the entries of a ZIP file: [{ name, directory, size, compressedSize, method, mode, offset }]. */
export async function listZip(file) {
  const handle = await fsp.open(file, 'r');
  try {
    return await readDirectory(handle);
  } finally {
    await handle.close();
  }
}

async function readDirectory(handle) {
  const { size } = await handle.stat();
  if (size < 22) throw new Error('Not a ZIP file (too small).');
  const tailLen = Math.min(size, 22 + 65535);
  const tail = await readAt(handle, size - tailLen, tailLen);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a ZIP file (no end-of-central-directory record).');
  const count = tail.readUInt16LE(eocd + 10);
  const cenSize = tail.readUInt32LE(eocd + 12);
  const cenOffset = tail.readUInt32LE(eocd + 16);
  if (count === 0xffff || cenOffset === 0xffffffff) throw new Error('ZIP64 archives are not supported.');
  const cen = await readAt(handle, cenOffset, cenSize);
  const entries = [];
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > cen.length || cen.readUInt32LE(p) !== CEN_SIG) throw new Error('Corrupt ZIP central directory.');
    const flags = cen.readUInt16LE(p + 8);
    const method = cen.readUInt16LE(p + 10);
    const crc = cen.readUInt32LE(p + 16);
    const compressedSize = cen.readUInt32LE(p + 20);
    const uncompressedSize = cen.readUInt32LE(p + 24);
    const nameLen = cen.readUInt16LE(p + 28);
    const extraLen = cen.readUInt16LE(p + 30);
    const commentLen = cen.readUInt16LE(p + 32);
    const madeBy = cen.readUInt16LE(p + 4) >> 8;
    const external = cen.readUInt32LE(p + 38);
    const offset = cen.readUInt32LE(p + 42);
    const name = cen.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    entries.push({
      name,
      directory: name.endsWith('/'),
      size: uncompressedSize,
      compressedSize,
      method,
      crc,
      encrypted: !!(flags & 1),
      // Unix permission bits when the archive was made on a Unix system (keeps bin/gradle executable).
      mode: madeBy === 3 ? (external >>> 16) & 0o777 : 0,
      offset,
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  // Where the central directory starts: an APK's v2+ signature block sits right before it.
  Object.defineProperty(entries, 'centralDirectoryOffset', { value: cenOffset, enumerable: false });
  return entries;
}

async function readEntry(handle, entry) {
  if (entry.encrypted) throw new Error(`Encrypted ZIP entry: ${entry.name}`);
  const head = await readAt(handle, entry.offset, 30);
  if (head.readUInt32LE(0) !== LOC_SIG) throw new Error(`Corrupt ZIP entry: ${entry.name}`);
  const start = entry.offset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
  const raw = entry.compressedSize ? await readAt(handle, start, entry.compressedSize) : Buffer.alloc(0);
  if (entry.method === 0) return raw;
  if (entry.method === 8) return zlib.inflateRawSync(raw);
  throw new Error(`Unsupported ZIP compression method ${entry.method}: ${entry.name}`);
}

/** Read the bytes at [position, position + length) of a file. */
export async function readFileRange(file, position, length) {
  const handle = await fsp.open(file, 'r');
  try {
    return await readAt(handle, position, length);
  } finally {
    await handle.close();
  }
}

/** Read one entry's bytes by name (null when the archive has no such entry). */
export async function readZipEntry(file, name) {
  const handle = await fsp.open(file, 'r');
  try {
    const entry = (await readDirectory(handle)).find((e) => e.name === name);
    return entry ? await readEntry(handle, entry) : null;
  } finally {
    await handle.close();
  }
}

/**
 * Unpack a ZIP file into `destination`. Entry names that would leave the destination
 * ("../x", absolute paths) are rejected, never written.
 * @returns {Promise<{ files: number, bytes: number }>}
 */
export async function extractZip(file, destination, { strip = 0, onProgress } = {}) {
  const dest = path.resolve(destination);
  await fsp.mkdir(dest, { recursive: true });
  const handle = await fsp.open(file, 'r');
  let files = 0;
  let bytes = 0;
  try {
    const entries = await readDirectory(handle);
    for (const entry of entries) {
      const parts = entry.name.split('/').filter(Boolean).slice(strip);
      if (!parts.length) continue;
      if (parts.some((part) => part === '..' || part.includes('\\') || /^[a-z]:$/i.test(part))) throw new Error(`Unsafe path in the ZIP file: ${entry.name}`);
      const target = path.resolve(dest, ...parts);
      if (!target.startsWith(dest + path.sep)) throw new Error(`Unsafe path in the ZIP file: ${entry.name}`);
      if (entry.directory) {
        await fsp.mkdir(target, { recursive: true });
        continue;
      }
      await fsp.mkdir(path.dirname(target), { recursive: true });
      const data = await readEntry(handle, entry);
      await fsp.writeFile(target, data);
      if (entry.mode & 0o111 && process.platform !== 'win32') await fsp.chmod(target, 0o755).catch(() => {});
      files++;
      bytes += data.length;
      if (onProgress && files % 50 === 0) onProgress({ files, total: entries.length, bytes });
    }
  } finally {
    await handle.close();
  }
  return { files, bytes };
}
