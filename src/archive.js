import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import {
  chmod, lstat, mkdir, open, readdir, rename, rm
} from 'node:fs/promises';
import path from 'node:path';
import { PassThrough, Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip, constants as zlibConstants } from 'node:zlib';

const MANIFEST_NAME = '.archive-manifest.json';
const TAR_BLOCK_SIZE = 512;
const IO_CHUNK_SIZE = 64 * 1024;
const MAX_TAR_NUMBER = 8_589_934_591;
const DEFAULT_LIMITS = Object.freeze({
  maxEntries: 10_000,
  maxFileBytes: MAX_TAR_NUMBER,
  maxTotalBytes: 16 * 1024 ** 3,
  maxArchiveBytes: 16 * 1024 ** 3,
  maxManifestBytes: 16 * 1024 ** 2,
  maxPathBytes: 4096
});

/**
 * Create a streaming gzip-compressed USTAR/PAX archive of regular files and
 * directories. Symlinks and special files are omitted. A SHA-256 manifest is
 * included and the source bytes are rechecked while writing to catch changes.
 *
 * @param {string} sourceDirectory Directory to archive.
 * @param {string} archivePath New output path; an existing file is never replaced.
 * @param {{signal?: AbortSignal, maxEntries?: number, maxFileBytes?: number,
 *   maxTotalBytes?: number, maxArchiveBytes?: number, maxManifestBytes?: number,
 *   maxPathBytes?: number, compressionLevel?: number}} [options]
 * @returns {Promise<{archivePath: string, entries: number, bytes: number}>}
 */
export async function createArchive(sourceDirectory, archivePath, options = {}) {
  const limits = getLimits(options);
  const signal = options.signal;
  throwIfAborted(signal);

  const source = path.resolve(sourceDirectory);
  const target = path.resolve(archivePath);
  const sourceStat = await lstat(source);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new Error('Archive source must be a real directory.');
  }
  if (isWithin(source, target)) throw new Error('Archive output must not be inside its source directory.');

  const entries = await scanSource(source, limits, signal);
  const paxEntries = entries.filter((entry) => {
    const entryPath = entry.type === 'directory' ? `${entry.path}/` : entry.path;
    return !canStoreUstarPath(entryPath);
  }).length;
  if (entries.length + paxEntries + 1 > limits.maxEntries) throw new Error('Archive entry limit exceeded.');
  if (entries.some((entry) =>
    entry.path === MANIFEST_NAME || entry.path.startsWith(`${MANIFEST_NAME}/`))) {
    throw new Error(`The source contains the reserved path ${MANIFEST_NAME}.`);
  }
  const manifest = Buffer.from(JSON.stringify({ version: 1, entries: entries.map(manifestEntry) }));
  if (manifest.length > limits.maxManifestBytes) throw new Error('Archive manifest size limit exceeded.');

  await mkdir(path.dirname(target), { recursive: true });
  const outputHandle = await open(target, 'wx', 0o600);
  let outputCreated = true;
  const output = createWriteStream(target, { fd: outputHandle.fd, autoClose: false });
  const sizeLimiter = new Transform({
    transform(chunk, encoding, callback) {
      this.bytesWritten = (this.bytesWritten ?? 0) + chunk.length;
      if (this.bytesWritten > limits.maxArchiveBytes) {
        callback(new Error('Compressed archive size limit exceeded.'));
      } else {
        callback(null, chunk);
      }
    }
  });

  try {
    await pipeline(
      Readable.from(writeTar(source, entries, manifest, limits, signal)),
      createGzip({ level: options.compressionLevel ?? zlibConstants.Z_DEFAULT_COMPRESSION }),
      sizeLimiter,
      output,
      ...(signal ? [{ signal }] : [])
    );
    await outputHandle.close();
    outputCreated = false;
    return {
      archivePath: target,
      entries: entries.length,
      bytes: sizeLimiter.bytesWritten ?? 0
    };
  } catch (error) {
    output.destroy();
    await outputHandle.close().catch(() => {});
    if (outputCreated) await rm(target, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Verify an archive's embedded SHA-256 manifest and safely extract it into a
 * destination that does not already exist. Extraction is staged beside the
 * destination and becomes visible only after all entries have been verified.
 * Only regular files and directories are accepted; links and special entries
 * are rejected.
 *
 * @param {string} archivePath gzip-compressed tar archive.
 * @param {string} destinationDirectory New destination path, which must be absent.
 * @param {{signal?: AbortSignal, maxEntries?: number, maxFileBytes?: number,
 *   maxTotalBytes?: number, maxArchiveBytes?: number, maxManifestBytes?: number,
 *   maxPathBytes?: number}} [options]
 * @returns {Promise<{destinationDirectory: string, entries: number, bytes: number}>}
 */
export async function extractArchive(archivePath, destinationDirectory, options = {}) {
  const limits = getLimits(options);
  const signal = options.signal;
  throwIfAborted(signal);

  const archive = path.resolve(archivePath);
  const destination = path.resolve(destinationDirectory);
  const parent = path.dirname(destination);
  await mkdir(parent, { recursive: true });
  try {
    await lstat(destination);
    throw new Error('Archive destination already exists.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const stage = path.join(parent, `.${path.basename(destination)}.restore-${randomUUID()}`);
  await mkdir(stage, { mode: 0o700 });
  const compressedLimiter = new Transform({
    transform(chunk, encoding, callback) {
      this.bytesRead = (this.bytesRead ?? 0) + chunk.length;
      if (this.bytesRead > limits.maxArchiveBytes) {
        callback(new Error('Compressed archive size limit exceeded.'));
      } else {
        callback(null, chunk);
      }
    }
  });
  const input = createReadStream(archive);
  const gunzip = createGunzip();
  const tarOutput = new PassThrough();
  const pipePromise = pipeline(
    input,
    compressedLimiter,
    gunzip,
    tarOutput,
    ...(signal ? [{ signal }] : [])
  );
  pipePromise.catch(() => {});

  let stageOwned = true;
  try {
    const reader = new TarReader(tarOutput, limits);
    const observed = new Map();
    const hashes = new Map();
    const explicitDirectories = [];
    let manifest = null;
    let totalBytes = 0;
    let count = 0;
    let pax = null;
    let foundEndMarker = false;

    while (true) {
      throwIfAborted(signal);
      const header = await reader.readBlock();
      if (header === null) break;
      if (isZeroBlock(header)) {
        const second = await reader.readBlock();
        if (second === null || !isZeroBlock(second)) throw new Error('Invalid tar end marker.');
        await reader.expectZeroPadding();
        foundEndMarker = true;
        break;
      }

      validateHeaderChecksum(header);
      const rawType = String.fromCharCode(header[156] || 48);
      let entryPath = joinHeaderPath(header);
      let size = parseTarNumber(header, 124, 12, 'size');
      const mode = parseTarNumber(header, 100, 8, 'mode') & 0o777;

      if (rawType === 'x') {
        if (pax) throw new Error('Nested PAX headers are not supported.');
        count += 1;
        if (count > limits.maxEntries) throw new Error('Archive entry limit exceeded.');
        if (size > limits.maxManifestBytes) throw new Error('PAX metadata size limit exceeded.');
        pax = parsePax(await reader.readPayload(size), limits);
        continue;
      }
      if (rawType === 'g' || rawType === 'L' || rawType === 'K') {
        throw new Error('Global PAX and GNU long-name records are not supported.');
      }
      if (rawType === '1' || rawType === '2') {
        throw new Error('Archive links are not allowed.');
      }
      if (rawType !== '0' && rawType !== '\0' && rawType !== '5') {
        throw new Error(`Unsupported tar entry type: ${JSON.stringify(rawType)}.`);
      }
      if (pax) {
        if (pax.path !== undefined) entryPath = pax.path;
        if (pax.size !== undefined) size = pax.size;
        pax = null;
      }

      const isDirectory = rawType === '5';
      entryPath = validateArchivePath(entryPath, isDirectory, limits);
      count += 1;
      if (count > limits.maxEntries) throw new Error('Archive entry limit exceeded.');
      if (observed.has(entryPath)) throw new Error(`Duplicate archive entry: ${entryPath}`);

      if (entryPath === MANIFEST_NAME) {
        if (isDirectory || manifest !== null || size > limits.maxManifestBytes) {
          throw new Error('Invalid archive manifest entry.');
        }
        manifest = await reader.readPayload(size);
        continue;
      }

      if (isDirectory) {
        if (size !== 0) throw new Error(`Directory entry has data: ${entryPath}`);
        const target = resolveInside(stage, entryPath);
        await mkdir(target, { recursive: true, mode: 0o700 });
        observed.set(entryPath, { path: entryPath, type: 'directory', size: 0, mode });
        explicitDirectories.push({ path: target, mode });
        continue;
      }

      if (size > limits.maxFileBytes) throw new Error(`File size limit exceeded: ${entryPath}`);
      totalBytes += size;
      if (totalBytes > limits.maxTotalBytes) throw new Error('Total extracted size limit exceeded.');
      const filePath = resolveInside(stage, entryPath);
      await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
      const fileHandle = await open(filePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      const digest = createHash('sha256');
      try {
        await reader.copyToFile(size, fileHandle, digest, signal);
        await fileHandle.sync();
      } finally {
        await fileHandle.close();
      }
      observed.set(entryPath, { path: entryPath, type: 'file', size, mode });
      hashes.set(entryPath, digest.digest('hex'));
    }

    if (!foundEndMarker) throw new Error('Tar archive is missing its end marker.');
    if (pax) throw new Error('Archive ends after a PAX header.');
    await pipePromise;
    if (!manifest) throw new Error('Archive is missing its integrity manifest.');
    const expected = parseManifest(manifest, limits);
    verifyManifest(expected, observed, hashes);

    for (const entry of observed.values()) {
      if (entry.type === 'file') {
        await chmod(resolveInside(stage, entry.path), entry.mode);
      }
    }
    explicitDirectories.sort((left, right) => right.path.length - left.path.length);
    for (const directory of explicitDirectories) await chmod(directory.path, directory.mode);
    throwIfAborted(signal);
    await rename(stage, destination);
    stageOwned = false;
    return { destinationDirectory: destination, entries: observed.size, bytes: totalBytes };
  } catch (error) {
    input.destroy();
    gunzip.destroy();
    tarOutput.destroy();
    await pipePromise.catch(() => {});
    throw error;
  } finally {
    if (stageOwned) await rm(stage, { recursive: true, force: true });
  }
}

async function scanSource(root, limits, signal) {
  const entries = [];
  let totalBytes = 0;
  async function visit(directory, relativeDirectory = '') {
    throwIfAborted(signal);
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const child of children) {
      throwIfAborted(signal);
      const relative = relativeDirectory ? `${relativeDirectory}/${child.name}` : child.name;
      validateArchivePath(relative, child.isDirectory(), limits);
      const absolute = path.join(directory, child.name);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        entries.push({
          path: relative,
          type: 'directory',
          size: 0,
          mode: info.mode & 0o777,
          dev: info.dev,
          ino: info.ino
        });
        if (entries.length + 1 > limits.maxEntries) throw new Error('Archive entry limit exceeded.');
        await visit(absolute, relative);
      } else if (info.isFile()) {
        if (info.size > limits.maxFileBytes) throw new Error(`File size limit exceeded: ${relative}`);
        totalBytes += info.size;
        if (totalBytes > limits.maxTotalBytes) throw new Error('Total archive size limit exceeded.');
        const digest = await hashFile(absolute, info, signal);
        entries.push({
          path: relative,
          type: 'file',
          size: info.size,
          mode: info.mode & 0o777,
          dev: info.dev,
          ino: info.ino,
          sha256: digest
        });
        if (entries.length + 1 > limits.maxEntries) throw new Error('Archive entry limit exceeded.');
      }
    }
  }
  await visit(root);
  entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return entries;
}

async function hashFile(filePath, expectedStat, signal) {
  const handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const digest = createHash('sha256');
  try {
    const current = await handle.stat();
    if (!current.isFile() || current.dev !== expectedStat.dev || current.ino !== expectedStat.ino ||
        current.size !== expectedStat.size || (current.mode & 0o777) !== (expectedStat.mode & 0o777)) {
      throw new Error(`Source changed while archiving: ${filePath}`);
    }
    let position = 0;
    while (position < expectedStat.size) {
      throwIfAborted(signal);
      const buffer = Buffer.allocUnsafe(Math.min(IO_CHUNK_SIZE, expectedStat.size - position));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) throw new Error(`Source changed while archiving: ${filePath}`);
      digest.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const afterRead = await handle.stat();
    if (afterRead.size !== expectedStat.size) throw new Error(`Source changed while archiving: ${filePath}`);
  } finally {
    await handle.close();
  }
  return digest.digest('hex');
}

function manifestEntry(entry) {
  const result = {
    path: entry.path,
    type: entry.type,
    size: entry.size,
    mode: entry.mode
  };
  if (entry.type === 'file') result.sha256 = entry.sha256;
  return result;
}

async function* writeTar(root, entries, manifest, limits, signal) {
  let paxIndex = 0;
  for (const entry of entries) {
    throwIfAborted(signal);
    const absolute = path.join(root, ...entry.path.split('/'));
    if (entry.type === 'directory') {
      const current = await lstat(absolute);
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== entry.dev ||
          current.ino !== entry.ino || (current.mode & 0o777) !== entry.mode) {
        throw new Error(`Source changed while archiving: ${entry.path}`);
      }
    }
    const tarPath = entry.type === 'directory' ? `${entry.path}/` : entry.path;
    const headerPath = canStoreUstarPath(tarPath) ? tarPath : `PaxEntry/${++paxIndex}`;
    if (headerPath !== tarPath) {
      const record = paxRecord('path', tarPath);
      yield makeHeader(`PaxHeaders/${paxIndex}`, record.length, 0o600, 'x');
      yield record;
      yield zeroPadding(record.length);
    }
    yield makeHeader(headerPath, entry.size, entry.mode, entry.type === 'directory' ? '5' : '0');
    if (entry.type === 'directory') continue;

    const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const digest = createHash('sha256');
    let read = 0;
    try {
      const current = await handle.stat();
      if (!current.isFile() || current.dev !== entry.dev || current.ino !== entry.ino ||
          current.size !== entry.size || (current.mode & 0o777) !== entry.mode) {
        throw new Error(`Source changed while archiving: ${entry.path}`);
      }
      while (read < entry.size) {
        throwIfAborted(signal);
        const buffer = Buffer.allocUnsafe(Math.min(IO_CHUNK_SIZE, entry.size - read));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, read);
        if (bytesRead === 0) throw new Error(`Source changed while archiving: ${entry.path}`);
        const chunk = buffer.subarray(0, bytesRead);
        read += bytesRead;
        digest.update(chunk);
        yield chunk;
      }
      const afterRead = await handle.stat();
      if (afterRead.size !== entry.size) throw new Error(`Source changed while archiving: ${entry.path}`);
    } finally {
      await handle.close();
    }
    if (read !== entry.size || digest.digest('hex') !== entry.sha256) {
      throw new Error(`Source changed while archiving: ${entry.path}`);
    }
    yield zeroPadding(entry.size);
  }

  if (manifest.length > limits.maxManifestBytes) throw new Error('Archive manifest size limit exceeded.');
  yield makeHeader(MANIFEST_NAME, manifest.length, 0o600, '0');
  yield manifest;
  yield zeroPadding(manifest.length);
  yield Buffer.alloc(TAR_BLOCK_SIZE * 2);
}

function makeHeader(entryPath, size, mode, type) {
  const split = splitUstarPath(entryPath);
  const header = Buffer.alloc(TAR_BLOCK_SIZE);
  header.write(split.name, 0, 100, 'utf8');
  writeTarNumber(header, 100, 8, mode);
  writeTarNumber(header, 108, 8, 0);
  writeTarNumber(header, 116, 8, 0);
  writeTarNumber(header, 124, 12, size);
  writeTarNumber(header, 136, 12, Math.floor(Date.now() / 1000));
  header.fill(0x20, 148, 156);
  header[156] = type.charCodeAt(0);
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  header.write('root', 265, 32, 'ascii');
  header.write('root', 297, 32, 'ascii');
  if (split.prefix) header.write(split.prefix, 345, 155, 'utf8');
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(checksum.toString(8).padStart(6, '0'), 148, 6, 'ascii');
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function canStoreUstarPath(entryPath) {
  try {
    splitUstarPath(entryPath);
    return true;
  } catch {
    return false;
  }
}

function splitUstarPath(entryPath) {
  const bytes = Buffer.byteLength(entryPath, 'utf8');
  if (bytes <= 100) return { name: entryPath, prefix: '' };
  for (let index = entryPath.lastIndexOf('/'); index > 0; index = entryPath.lastIndexOf('/', index - 1)) {
    const prefix = entryPath.slice(0, index);
    const name = entryPath.slice(index + 1);
    if (Buffer.byteLength(prefix, 'utf8') <= 155 && Buffer.byteLength(name, 'utf8') <= 100) {
      return { name, prefix };
    }
  }
  throw new Error('Archive path requires a PAX extended header.');
}

function writeTarNumber(header, offset, length, value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_TAR_NUMBER) {
    throw new Error('Archive numeric field is outside the supported tar range.');
  }
  const encoded = `${value.toString(8).padStart(length - 1, '0')}\0`;
  if (encoded.length > length) throw new Error('Archive numeric field is too large.');
  header.write(encoded, offset, length, 'ascii');
}

function zeroPadding(size) {
  const remainder = size % TAR_BLOCK_SIZE;
  return remainder === 0 ? Buffer.alloc(0) : Buffer.alloc(TAR_BLOCK_SIZE - remainder);
}

function paxRecord(key, value) {
  const data = Buffer.from(`${key}=${value}\n`);
  let length = data.length + 2;
  while (true) {
    const record = Buffer.from(`${length} ${key}=${value}\n`);
    if (record.length === length) return record;
    length = record.length;
  }
}

function parsePax(payload, limits) {
  const result = {};
  let offset = 0;
  while (offset < payload.length) {
    const space = payload.indexOf(0x20, offset);
    if (space < 0) throw new Error('Malformed PAX record.');
    const lengthText = payload.toString('ascii', offset, space);
    if (!/^[1-9]\d*$/.test(lengthText)) throw new Error('Malformed PAX record length.');
    const length = Number(lengthText);
    if (!Number.isSafeInteger(length) || length <= space - offset + 1 || offset + length > payload.length) {
      throw new Error('Invalid PAX record length.');
    }
    const record = payload.subarray(space + 1, offset + length);
    if (record[record.length - 1] !== 0x0a) throw new Error('Malformed PAX record terminator.');
    const equals = record.indexOf(0x3d);
    if (equals < 1) throw new Error('Malformed PAX key/value pair.');
    const key = record.toString('ascii', 0, equals);
    const value = decodeUtf8(record.subarray(equals + 1, record.length - 1), 'PAX value');
    if (Object.hasOwn(result, key)) throw new Error(`Duplicate PAX attribute: ${key}`);
    if (key === 'path') {
      if (Buffer.byteLength(value, 'utf8') > limits.maxPathBytes) throw new Error('Archive path limit exceeded.');
      result.path = value;
    } else if (key === 'size') {
      if (!/^\d+$/.test(value)) throw new Error('Invalid PAX size.');
      result.size = Number(value);
      if (!Number.isSafeInteger(result.size)) throw new Error('Invalid PAX size.');
    } else {
      throw new Error(`Unsupported PAX attribute: ${key}`);
    }
    offset += length;
  }
  return result;
}

function parseManifest(buffer, limits) {
  let manifest;
  try {
    manifest = JSON.parse(decodeUtf8(buffer, 'archive manifest'));
  } catch (error) {
    throw new Error(`Invalid archive manifest: ${error.message}`);
  }
  if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.entries)) {
    throw new Error('Unsupported archive manifest format.');
  }
  if (manifest.entries.length + 1 > limits.maxEntries) throw new Error('Archive entry limit exceeded.');
  const entries = new Map();
  for (const entry of manifest.entries) {
    if (!entry || (entry.type !== 'file' && entry.type !== 'directory')) {
      throw new Error('Invalid entry in archive manifest.');
    }
    const normalized = validateArchivePath(entry.path, entry.type === 'directory', limits);
    if (normalized === MANIFEST_NAME || entries.has(normalized)) {
      throw new Error(`Invalid or duplicate manifest path: ${normalized}`);
    }
    if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > limits.maxFileBytes ||
        !Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777) {
      throw new Error(`Invalid metadata for manifest path: ${normalized}`);
    }
    if (entry.type === 'directory' && entry.size !== 0) {
      throw new Error(`Invalid directory size in manifest: ${normalized}`);
    }
    if (entry.type === 'file' && !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      throw new Error(`Invalid checksum in manifest: ${normalized}`);
    }
    entries.set(normalized, { ...entry, path: normalized });
  }
  return entries;
}

function verifyManifest(expected, observed, hashes) {
  if (expected.size !== observed.size) throw new Error('Archive contents do not match the integrity manifest.');
  for (const [entryPath, actual] of observed) {
    const entry = expected.get(entryPath);
    if (!entry || entry.type !== actual.type || entry.size !== actual.size || entry.mode !== actual.mode) {
      throw new Error(`Archive metadata does not match the integrity manifest: ${entryPath}`);
    }
    if (entry.type === 'file' && entry.sha256 !== hashes.get(entryPath)) {
      throw new Error(`SHA-256 verification failed for ${entryPath}.`);
    }
  }
}

class TarReader {
  constructor(stream, limits) {
    this.iterator = stream[Symbol.asyncIterator]();
    this.limits = limits;
    this.buffers = [];
    this.buffered = 0;
    this.bytesRead = 0;
  }

  async readBlock() {
    const bytes = await this.take(TAR_BLOCK_SIZE, true);
    return bytes;
  }

  async readPayload(size) {
    if (!Number.isSafeInteger(size) || size < 0 || size > this.limits.maxManifestBytes) {
      throw new Error('Tar metadata size limit exceeded.');
    }
    const payload = await this.take(size, false);
    const padding = (TAR_BLOCK_SIZE - size % TAR_BLOCK_SIZE) % TAR_BLOCK_SIZE;
    if (padding) {
      const bytes = await this.take(padding, false);
      if (!isZeroBlock(bytes, false)) throw new Error('Invalid tar padding.');
    }
    return payload;
  }

  async copyToFile(size, handle, digest, signal) {
    let remaining = size;
    while (remaining > 0) {
      throwIfAborted(signal);
      const chunk = await this.take(Math.min(remaining, IO_CHUNK_SIZE), false);
      digest.update(chunk);
      let offset = 0;
      while (offset < chunk.length) {
        const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
        if (!bytesWritten) throw new Error('Failed to write extracted file.');
        offset += bytesWritten;
      }
      remaining -= chunk.length;
    }
    const padding = (TAR_BLOCK_SIZE - size % TAR_BLOCK_SIZE) % TAR_BLOCK_SIZE;
    if (padding) {
      const bytes = await this.take(padding, false);
      if (!isZeroBlock(bytes, false)) throw new Error('Invalid tar padding.');
    }
  }

  async expectZeroPadding() {
    while (true) {
      const block = await this.readBlock();
      if (block === null) return;
      if (!isZeroBlock(block)) throw new Error('Unexpected data after tar end marker.');
    }
  }

  async take(size, allowEnd) {
    if (size === 0) return Buffer.alloc(0);
    while (this.buffered < size) {
      const item = await this.iterator.next();
      if (item.done) {
        if (allowEnd && this.buffered === 0) return null;
        throw new Error('Truncated tar archive.');
      }
      this.bytesRead += item.value.length;
      const maxTarBytes = this.limits.maxTotalBytes +
        this.limits.maxEntries * 2048 + this.limits.maxManifestBytes + 1024 * 1024;
      if (this.bytesRead > maxTarBytes) throw new Error('Uncompressed tar size limit exceeded.');
      this.buffers.push(item.value);
      this.buffered += item.value.length;
    }
    if (this.buffered === size) {
      const exact = Buffer.concat(this.buffers, size);
      this.buffers = [];
      this.buffered = 0;
      return exact;
    }
    const result = Buffer.allocUnsafe(size);
    let written = 0;
    while (written < size) {
      const first = this.buffers[0];
      const amount = Math.min(first.length, size - written);
      first.copy(result, written, 0, amount);
      written += amount;
      if (amount === first.length) this.buffers.shift();
      else this.buffers[0] = first.subarray(amount);
      this.buffered -= amount;
    }
    return result;
  }
}

function validateHeaderChecksum(header) {
  const stored = parseTarNumber(header, 148, 8, 'checksum');
  let calculated = 0;
  for (let index = 0; index < header.length; index++) {
    calculated += index >= 148 && index < 156 ? 0x20 : header[index];
  }
  if (stored !== calculated) throw new Error('Tar header checksum mismatch.');
}

function parseTarNumber(header, offset, length, label) {
  const raw = header.subarray(offset, offset + length);
  if (raw[0] & 0x80) throw new Error(`Base-256 tar ${label} values are not supported.`);
  const text = raw.toString('ascii').replace(/\0.*$/s, '').trim();
  if (text === '') return 0;
  if (!/^[0-7]+$/.test(text)) throw new Error(`Invalid tar ${label}.`);
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value)) throw new Error(`Invalid tar ${label}.`);
  return value;
}

function joinHeaderPath(header) {
  const name = decodeUtf8(trimNul(header.subarray(0, 100)), 'tar path');
  const prefix = decodeUtf8(trimNul(header.subarray(345, 500)), 'tar prefix');
  return prefix ? `${prefix}/${name}` : name;
}

function trimNul(buffer) {
  const end = buffer.indexOf(0);
  return end < 0 ? buffer : buffer.subarray(0, end);
}

function decodeUtf8(buffer, label) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new Error(`Invalid UTF-8 in ${label}.`);
  }
}

function validateArchivePath(value, isDirectory, limits) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') ||
      Buffer.byteLength(value, 'utf8') > limits.maxPathBytes || value.includes('\\')) {
    throw new Error('Invalid or oversized archive path.');
  }
  let entryPath = value;
  if (isDirectory && entryPath.endsWith('/')) entryPath = entryPath.slice(0, -1);
  if (!entryPath || entryPath.startsWith('/') || /^[a-zA-Z]:/.test(entryPath) ||
      entryPath.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`Unsafe archive path: ${value}`);
  }
  return entryPath;
}

function resolveInside(root, relativePath) {
  const resolved = path.resolve(root, ...relativePath.split('/'));
  if (!isWithin(root, resolved)) throw new Error(`Unsafe archive path: ${relativePath}`);
  return resolved;
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function getLimits(options) {
  const limits = { ...DEFAULT_LIMITS };
  for (const key of Object.keys(limits)) {
    if (options[key] !== undefined) {
      const value = options[key];
      if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${key} must be a positive safe integer.`);
      limits[key] = value;
    }
  }
  return limits;
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    const error = new Error('Archive operation was aborted.');
    error.name = 'AbortError';
    throw error;
  }
}

function isZeroBlock(block, fullBlock = true) {
  const length = fullBlock ? TAR_BLOCK_SIZE : block.length;
  if (block.length !== length) return false;
  for (const byte of block) if (byte !== 0) return false;
  return true;
}
