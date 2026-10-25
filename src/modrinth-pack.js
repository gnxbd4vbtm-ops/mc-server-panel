import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

const DEFAULT_LIMITS = Object.freeze({
  maxArchiveBytes: 64 * 1024 * 1024,
  maxEntries: 4096,
  maxFileBytes: 128 * 1024 * 1024,
  maxExpandedBytes: 512 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
});
const MAX_DOWNLOAD_URLS = 10;
const LOADER_IDS = new Set(['fabric-loader', 'forge', 'neoforge', 'quilt-loader']);
const textDecoder = new TextDecoder('utf-8', { fatal: true });
const crcTable = new Uint32Array(256);

for (let i = 0; i < 256; i += 1) {
  let value = i;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  }
  crcTable[i] = value >>> 0;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function fail(message) {
  throw new Error(`Invalid Modrinth pack: ${message}`);
}

function decodeName(bytes, flags) {
  if ((flags & 0x0800) === 0 && bytes.some((byte) => byte > 0x7f)) {
    fail('non-ASCII ZIP entry names must be explicitly marked as UTF-8');
  }
  let name;
  try {
    name = textDecoder.decode(bytes);
  } catch {
    fail('ZIP entry name is not valid UTF-8');
  }
  if (name.includes('\0')) fail('ZIP entry name contains a NUL byte');
  return name;
}

function safePath(input, { directory = false } = {}) {
  if (typeof input !== 'string' || input.length === 0 || input.includes('\\')) {
    fail('file paths must be non-empty POSIX relative paths');
  }
  const raw = directory && input.endsWith('/') ? input.slice(0, -1) : input;
  if (!raw || raw.startsWith('/') || raw.endsWith('/')) fail(`unsafe file path "${input}"`);

  const parts = raw.split('/');
  for (const part of parts) {
    const reservedName = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
    if (
      !part ||
      part === '.' ||
      part === '..' ||
      /[\u0000-\u001f\u007f]/u.test(part) ||
      part.includes(':') ||
      /[. ]$/u.test(part) ||
      reservedName.test(part)
    ) {
      fail(`unsafe file path "${input}"`);
    }
  }
  return parts.map((part) => part.normalize('NFC')).join('/');
}

function readUInt32(buffer, offset, label) {
  if (offset < 0 || offset + 4 > buffer.length) fail(`truncated ${label}`);
  return buffer.readUInt32LE(offset);
}

function checkExtraFields(extra, label) {
  let offset = 0;
  while (offset < extra.length) {
    if (offset + 4 > extra.length) fail(`truncated ${label} extra field`);
    const id = extra.readUInt16LE(offset);
    const size = extra.readUInt16LE(offset + 2);
    offset += 4;
    if (offset + size > extra.length) fail(`truncated ${label} extra field`);
    if ([0x0001, 0x000d, 0x7075, 0x756e].includes(id)) {
      fail('ZIP64, alternate-path, or Unix-link extra fields are not supported');
    }
    offset += size;
  }
}

function parseZip(buffer, limits, signal) {
  if (buffer.length < 22) fail('ZIP archive is too short');
  if (buffer.length > limits.maxArchiveBytes) fail('archive exceeds the compressed-size limit');

  const searchStart = Math.max(0, buffer.length - 22 - 0xffff);
  let endOffset = -1;
  for (let offset = buffer.length - 22; offset >= searchStart; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      const commentLength = buffer.readUInt16LE(offset + 20);
      if (offset + 22 + commentLength === buffer.length) {
        endOffset = offset;
        break;
      }
    }
  }
  if (endOffset < 0) fail('ZIP end-of-central-directory record is missing');

  const disk = buffer.readUInt16LE(endOffset + 4);
  const centralDisk = buffer.readUInt16LE(endOffset + 6);
  const diskEntries = buffer.readUInt16LE(endOffset + 8);
  const entryCount = buffer.readUInt16LE(endOffset + 10);
  const centralSize = buffer.readUInt32LE(endOffset + 12);
  const centralOffset = buffer.readUInt32LE(endOffset + 16);
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== entryCount) {
    fail('multi-disk ZIP archives are not supported');
  }
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    fail('ZIP64 archives are not supported');
  }
  if (entryCount > limits.maxEntries) fail('archive contains too many entries');
  if (centralOffset + centralSize !== endOffset) fail('invalid central-directory bounds');
  if (centralOffset > buffer.length || centralSize > buffer.length - centralOffset) {
    fail('central directory is outside the archive');
  }

  const entries = [];
  const allPaths = new Map();
  let cursor = centralOffset;
  let totalExpanded = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    if (cursor + 46 > endOffset || buffer.readUInt32LE(cursor) !== 0x02014b50) {
      fail('invalid central-directory entry');
    }
    const madeBy = buffer.readUInt16LE(cursor + 4);
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const checksum = readUInt32(buffer, cursor + 16, 'central directory');
    const compressedSize = readUInt32(buffer, cursor + 20, 'central directory');
    const expandedSize = readUInt32(buffer, cursor + 24, 'central directory');
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const startDisk = buffer.readUInt16LE(cursor + 34);
    const externalAttributes = readUInt32(buffer, cursor + 38, 'central directory');
    const localOffset = readUInt32(buffer, cursor + 42, 'central directory');
    const end = cursor + 46 + nameLength + extraLength + commentLength;
    if (end > endOffset) fail('truncated central-directory entry');
    if (startDisk !== 0) fail('multi-disk ZIP archives are not supported');
    if (compressedSize === 0xffffffff || expandedSize === 0xffffffff || localOffset === 0xffffffff) {
      fail('ZIP64 entries are not supported');
    }
    const nameBytes = buffer.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = decodeName(nameBytes, flags);
    const extra = buffer.subarray(cursor + 46 + nameLength, cursor + 46 + nameLength + extraLength);
    checkExtraFields(extra, 'central directory');

    const directory = name.endsWith('/');
    const path = safePath(name, { directory });
    if (allPaths.has(path)) fail(`duplicate ZIP path "${path}"`);
    const segments = path.split('/');
    for (let parent = 1; parent < segments.length; parent += 1) {
      if (allPaths.get(segments.slice(0, parent).join('/')) === 'file') {
        fail(`file path is also used as a directory ("${path}")`);
      }
    }
    if (!directory) {
      for (const existing of allPaths.keys()) {
        if (existing.startsWith(`${path}/`)) {
          fail(`file path is also used as a directory ("${path}")`);
        }
      }
    }
    allPaths.set(path, directory ? 'directory' : 'file');

    const allowedFlags = 0x0808 | (method === 8 ? 0x0006 : 0);
    if (flags & ~allowedFlags) fail(`unsupported ZIP flags on "${path}"`);
    if (method !== 0 && method !== 8) fail(`unsupported compression method on "${path}"`);
    if (method === 0 && (flags & 0x0006)) fail(`invalid stored-file flags on "${path}"`);
    if (expandedSize > limits.maxFileBytes) fail(`ZIP entry "${path}" exceeds the file-size limit`);
    totalExpanded += expandedSize;
    if (totalExpanded > limits.maxExpandedBytes) fail('archive exceeds the expanded-size limit');
    if (directory && (expandedSize !== 0 || compressedSize !== 0)) {
      fail(`directory entry "${path}" contains data`);
    }

    const operatingSystem = madeBy >>> 8;
    const unixMode = externalAttributes >>> 16;
    const unixType = unixMode & 0xf000;
    if (
      operatingSystem === 3 &&
      unixType !== 0 &&
      unixType !== 0x8000 &&
      unixType !== 0x4000
    ) {
      fail(`links and special files are not allowed ("${path}")`);
    }
    if (externalAttributes & 0x400) {
      fail(`links and reparse-point files are not allowed ("${path}")`);
    }
    if (operatingSystem === 3 && unixType === 0x4000 && !directory) {
      fail(`directory attributes do not match the ZIP path "${path}"`);
    }
    if (operatingSystem === 3 && unixType === 0x8000 && directory) {
      fail(`file attributes do not match the ZIP path "${path}"`);
    }
    if ((externalAttributes & 0x10) !== 0 && !directory) {
      fail(`directory attributes do not match the ZIP path "${path}"`);
    }

    entries.push({
      path,
      directory,
      nameBytes,
      flags,
      method,
      checksum,
      compressedSize,
      expandedSize,
      localOffset,
    });
    cursor = end;
  }
  if (cursor !== endOffset) fail('unexpected data in the central directory');

  const ranges = [];
  for (const entry of entries) {
    if (signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    const offset = entry.localOffset;
    if (offset + 30 > centralOffset || buffer.readUInt32LE(offset) !== 0x04034b50) {
      fail(`invalid local header for "${entry.path}"`);
    }
    const flags = buffer.readUInt16LE(offset + 6);
    const method = buffer.readUInt16LE(offset + 8);
    const checksum = readUInt32(buffer, offset + 14, 'local header');
    const compressedSize = readUInt32(buffer, offset + 18, 'local header');
    const expandedSize = readUInt32(buffer, offset + 22, 'local header');
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    if (dataStart > centralOffset) fail(`truncated local header for "${entry.path}"`);
    const localName = buffer.subarray(nameStart, nameStart + nameLength);
    const localExtra = buffer.subarray(nameStart + nameLength, dataStart);
    checkExtraFields(localExtra, 'local header');
    if (
      !localName.equals(entry.nameBytes) ||
      flags !== entry.flags ||
      method !== entry.method
    ) {
      fail(`local and central headers disagree for "${entry.path}"`);
    }
    const hasDescriptor = (flags & 0x0008) !== 0;
    if (
      (!hasDescriptor &&
        (checksum !== entry.checksum ||
          compressedSize !== entry.compressedSize ||
          expandedSize !== entry.expandedSize)) ||
      (hasDescriptor &&
        !(
          (checksum === 0 && compressedSize === 0 && expandedSize === 0) ||
          (checksum === entry.checksum &&
            compressedSize === entry.compressedSize &&
            expandedSize === entry.expandedSize)
        ))
    ) {
      fail(`invalid local sizes or checksum for "${entry.path}"`);
    }
    const dataEnd = dataStart + entry.compressedSize;
    if (dataEnd > centralOffset || dataEnd < dataStart) fail(`truncated data for "${entry.path}"`);

    let rangeEnd = dataEnd;
    if (hasDescriptor) {
      let descriptorOffset = dataEnd;
      if (descriptorOffset + 4 <= centralOffset && buffer.readUInt32LE(descriptorOffset) === 0x08074b50) {
        descriptorOffset += 4;
      }
      if (descriptorOffset + 12 > centralOffset) fail(`truncated data descriptor for "${entry.path}"`);
      if (
        readUInt32(buffer, descriptorOffset, 'data descriptor') !== entry.checksum ||
        readUInt32(buffer, descriptorOffset + 4, 'data descriptor') !== entry.compressedSize ||
        readUInt32(buffer, descriptorOffset + 8, 'data descriptor') !== entry.expandedSize
      ) {
        fail(`invalid data descriptor for "${entry.path}"`);
      }
      rangeEnd = descriptorOffset + 12;
    }
    ranges.push([offset, rangeEnd, entry.path]);

    const compressed = buffer.subarray(dataStart, dataEnd);
    let contents;
    try {
      if (entry.method === 0) {
        if (entry.compressedSize !== entry.expandedSize) {
          fail(`stored-file size mismatch for "${entry.path}"`);
        }
        contents = Buffer.from(compressed);
      } else {
        contents = inflateRawSync(compressed, { maxOutputLength: entry.expandedSize + 1 });
      }
    } catch (error) {
      if (error.message.startsWith('Invalid Modrinth pack:')) throw error;
      fail(`cannot safely decompress "${entry.path}"`);
    }
    if (contents.length !== entry.expandedSize) fail(`expanded size mismatch for "${entry.path}"`);
    if (crc32(contents) !== entry.checksum) fail(`CRC-32 mismatch for "${entry.path}"`);
    entry.contents = contents;
  }

  ranges.sort((a, b) => a[0] - b[0]);
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index][0] < ranges[index - 1][1]) {
      fail(`overlapping ZIP entries "${ranges[index - 1][2]}" and "${ranges[index][2]}"`);
    }
  }
  return entries;
}

function validateManifest(contents) {
  let manifest;
  try {
    manifest = JSON.parse(contents.toString('utf8'));
  } catch {
    fail('modrinth.index.json is not valid JSON');
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    fail('modrinth.index.json must contain an object');
  }
  if (manifest.formatVersion !== 1 || manifest.game !== 'minecraft') {
    fail('unsupported Modrinth index format or game');
  }
  if (
    typeof manifest.name !== 'string' ||
    !manifest.name.trim() ||
    typeof manifest.versionId !== 'string' ||
    !manifest.versionId.trim()
  ) {
    fail('manifest name or version ID is missing');
  }
  if (!manifest.dependencies || typeof manifest.dependencies !== 'object' || Array.isArray(manifest.dependencies)) {
    fail('manifest dependencies are missing');
  }
  const gameVersion = manifest.dependencies.minecraft;
  if (typeof gameVersion !== 'string' || !gameVersion.trim() || gameVersion.trim() !== gameVersion) {
    fail('manifest Minecraft version is missing');
  }
  const loaders = Object.entries(manifest.dependencies)
    .filter(([id]) => LOADER_IDS.has(id))
    .map(([id, version]) => {
      if (typeof version !== 'string' || !version.trim() || version.trim() !== version) {
        fail(`invalid ${id} version`);
      }
      return { name: id, version };
    });
  for (const [id, version] of Object.entries(manifest.dependencies)) {
    if (
      typeof id !== 'string' ||
      !id ||
      typeof version !== 'string' ||
      !version.trim() ||
      version.trim() !== version
    ) {
      fail('manifest dependency values must be non-empty strings');
    }
  }
  if (!Array.isArray(manifest.files)) fail('manifest files must be an array');
  return { manifest, gameVersion, loaders };
}

function validateEnvironment(file) {
  const env = file.env === undefined ? {} : file.env;
  if (!env || typeof env !== 'object' || Array.isArray(env)) fail('file environment must be an object');
  for (const key of ['client', 'server']) {
    if (env[key] !== undefined && !['required', 'optional', 'unsupported'].includes(env[key])) {
      fail(`invalid ${key} environment for manifest file`);
    }
  }
  return { client: env.client ?? 'required', server: env.server ?? 'required' };
}

function validateDownloadUrl(value) {
  let url;
  try {
    if (typeof value !== 'string' || value.trim() !== value) throw new Error('invalid URL');
    url = new URL(value);
  } catch {
    fail('manifest contains an invalid download URL');
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'cdn.modrinth.com' ||
    (url.port && url.port !== '443') ||
    url.username ||
    url.password
  ) {
    fail('download URLs must use https://cdn.modrinth.com');
  }
  return url;
}

function abortError(signal) {
  if (signal.reason instanceof Error) return signal.reason;
  return new DOMException('The operation was aborted', 'AbortError');
}

async function readResponse(response, expectedSize, signal) {
  if (signal.aborted) throw abortError(signal);
  const contentLength = response.headers?.get?.('content-length');
  if (contentLength !== null && contentLength !== undefined) {
    const declaredLength = Number(contentLength);
    if (!Number.isSafeInteger(declaredLength) || declaredLength > expectedSize) {
      await response.body?.cancel().catch(() => {});
      throw new Error('download exceeds its declared byte size');
    }
  }
  if (!response.body?.getReader) throw new Error('download response has no readable body');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  const cancelReader = () => reader.cancel(abortError(signal)).catch(() => {});
  signal.addEventListener('abort', cancelReader, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw abortError(signal);
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > expectedSize) {
        await reader.cancel();
        throw new Error('download exceeds its declared byte size');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    signal.removeEventListener('abort', cancelReader);
    reader.releaseLock();
  }
  if (size !== expectedSize) throw new Error(`download size mismatch (expected ${expectedSize}, received ${size})`);
  return Buffer.concat(chunks, size);
}

async function fetchVerifiedFile(file, fetchImpl, signal, maxRedirects) {
  if (!Array.isArray(file.downloads) || file.downloads.length > MAX_DOWNLOAD_URLS) {
    throw new Error(`file "${file.path}" must declare at most ${MAX_DOWNLOAD_URLS} download URLs`);
  }
  const urls = file.downloads.map(validateDownloadUrl);
  if (urls.length === 0) throw new Error(`required file "${file.path}" has no download URL`);
  if (!file.hashes || typeof file.hashes.sha512 !== 'string' || !/^[a-f\d]{128}$/i.test(file.hashes.sha512)) {
    throw new Error(`file "${file.path}" is missing a valid SHA-512 hash`);
  }
  if (!Number.isSafeInteger(file.fileSize) || file.fileSize < 0) {
    throw new Error(`file "${file.path}" is missing a valid byte size`);
  }

  const failures = [];
  for (const sourceUrl of urls) {
    let currentUrl = sourceUrl;
    try {
      for (let redirects = 0; ; redirects += 1) {
        if (signal.aborted) throw abortError(signal);
        const response = await fetchImpl(currentUrl.href, {
          signal,
          redirect: 'manual',
          headers: { 'accept-encoding': 'identity' },
        });
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location');
          await response.body?.cancel().catch(() => {});
          if (!location || redirects >= maxRedirects) throw new Error('download redirect limit exceeded');
          const redirected = new URL(location, currentUrl);
          validateDownloadUrl(redirected.href);
          currentUrl = redirected;
          continue;
        }
        if (!response.ok) throw new Error(`download returned HTTP ${response.status}`);
        const contents = await readResponse(response, file.fileSize, signal);
        const digest = createHash('sha512').update(contents).digest('hex');
        if (digest !== file.hashes.sha512.toLowerCase()) {
          throw new Error(`SHA-512 mismatch for "${file.path}"`);
        }
        return contents;
      }
    } catch (error) {
      if (signal.aborted) throw abortError(signal);
      failures.push(error.message);
    }
  }
  throw new Error(`unable to fetch "${file.path}": ${failures.join('; ')}`);
}

function makeSignal(signal, timeoutMs) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal.reason);
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => {
    controller.abort(new Error(`Modrinth pack processing timed out after ${timeoutMs} ms`));
  }, timeoutMs);
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

function validateLimits(options) {
  const limits = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) };
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${key} must be a non-negative safe integer`);
  }
  if (!Number.isSafeInteger(options.timeoutMs ?? 30_000) || (options.timeoutMs ?? 30_000) <= 0) {
    throw new TypeError('timeoutMs must be a positive safe integer');
  }
  if (!Number.isSafeInteger(options.maxRedirects ?? 3) || (options.maxRedirects ?? 3) < 0) {
    throw new TypeError('maxRedirects must be a non-negative safe integer');
  }
  return limits;
}

/**
 * Parses a Modrinth .mrpack, returns verified server files keyed by safe relative path.
 *
 * Options: signal, timeoutMs, maxRedirects, fetch (fetch-compatible function), and limits
 * (maxArchiveBytes, maxEntries, maxFileBytes, maxExpandedBytes, maxTotalBytes).
 */
export async function parseModrinthPack(input, options = {}) {
  if (!Buffer.isBuffer(input)) throw new TypeError('Modrinth pack input must be a Buffer');
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) {
    throw new TypeError('signal must be an AbortSignal');
  }
  const limits = validateLimits(options);
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxRedirects = options.maxRedirects ?? 3;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new TypeError('a fetch implementation is required');
  const timed = makeSignal(options.signal, timeoutMs);

  try {
    if (timed.signal.aborted) throw abortError(timed.signal);
    const entries = parseZip(input, limits, timed.signal);
    const manifestEntry = entries.find((entry) => entry.path === 'modrinth.index.json');
    if (!manifestEntry || manifestEntry.directory) fail('root modrinth.index.json is missing');
    const { manifest, gameVersion, loaders } = validateManifest(manifestEntry.contents);

    const files = [];
    const manifestPaths = new Set();
    let hasRequiredServerFile = false;
    for (const file of manifest.files) {
      if (!file || typeof file !== 'object' || Array.isArray(file)) fail('manifest file entry must be an object');
      const path = safePath(file.path);
      if (manifestPaths.has(path)) fail(`duplicate manifest path "${path}"`);
      manifestPaths.add(path);
      const env = validateEnvironment(file);
      if (env.server === 'required') hasRequiredServerFile = true;
      files.push({ ...file, path, env });
    }
    if (!hasRequiredServerFile) {
      const clientOnly = files.length > 0 && files.every(
        (file) => file.env.server === 'unsupported' && file.env.client === 'required',
      );
      fail(clientOnly ? 'this is a client-only pack with no server-required files' : 'manifest has no server-required file');
    }

    const output = new Map();
    const claimedPaths = new Set();
    const claimOutputPath = (path) => {
      if (claimedPaths.has(path)) fail(`duplicate output path "${path}"`);
      const segments = path.split('/');
      for (let parent = 1; parent < segments.length; parent += 1) {
        if (claimedPaths.has(segments.slice(0, parent).join('/'))) {
          fail(`file path is also used as a directory ("${path}")`);
        }
      }
      for (const existing of claimedPaths) {
        if (existing.startsWith(`${path}/`)) {
          fail(`file path is also used as a directory ("${path}")`);
        }
      }
      claimedPaths.add(path);
    };
    for (const path of manifestPaths) claimOutputPath(path);
    for (const entry of entries) {
      if (entry.directory || entry.path === 'modrinth.index.json') continue;
      let relativePath;
      if (entry.path.startsWith('server-overrides/')) {
        relativePath = safePath(entry.path.slice('server-overrides/'.length));
      } else if (entry.path.startsWith('overrides/')) {
        relativePath = safePath(entry.path.slice('overrides/'.length));
      } else {
        continue;
      }
      claimOutputPath(relativePath);
      output.set(relativePath, entry.contents);
    }

    let totalOutputSize = 0;
    for (const contents of output.values()) totalOutputSize += contents.length;
    const downloadable = files.filter((file) => file.env.server !== 'unsupported');
    if (files.length + entries.length > limits.maxEntries) {
      fail('pack contains too many total entries');
    }
    for (const file of downloadable) {
      if (!Number.isSafeInteger(file.fileSize) || file.fileSize < 0) {
        if (file.env.server === 'required') fail(`required file "${file.path}" is missing a valid byte size`);
        fail(`file "${file.path}" is missing a valid byte size`);
      }
      if (file.fileSize > limits.maxFileBytes) fail(`file "${file.path}" exceeds the file-size limit`);
      totalOutputSize += file.fileSize;
      if (totalOutputSize > limits.maxTotalBytes) fail('pack exceeds the total output-size limit');
    }

    for (const file of downloadable) {
      if (timed.signal.aborted) throw abortError(timed.signal);
      const contents = await fetchVerifiedFile(file, fetchImpl, timed.signal, maxRedirects);
      output.set(file.path, contents);
    }
    return {
      files: output,
      gameVersion,
      loader: loaders[0] ?? null,
      loaders,
    };
  } finally {
    timed.cleanup();
  }
}

export default parseModrinthPack;
