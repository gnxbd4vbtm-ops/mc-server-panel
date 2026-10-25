import { inflateRawSync } from "node:zlib";

const maxArchiveBytes = 128 * 1024 * 1024;
const maxExtractedBytes = 256 * 1024 * 1024;
const maxEntryBytes = 128 * 1024 * 1024;
const maxEntries = 10000;
const crcTable = new Uint32Array(256);

for (let index = 0; index < crcTable.length; index++) {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  crcTable[index] = value >>> 0;
}

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function safeEntryName(buffer) {
  const name = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  if (!name || name.includes("\\") || name.includes("\0") || /^[a-zA-Z]:/.test(name) ||
      name.startsWith("/") || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new Error("ZIP archive contains an unsafe path");
  }
  const directory = name.endsWith("/");
  const segments = (directory ? name.slice(0, -1) : name).split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.includes(":"))) {
    throw new Error("ZIP archive contains an unsafe path");
  }
  return { name: segments.join("/"), directory };
}

export function extractZipEntries(archive, {
  maxArchiveBytes: archiveLimit = 128 * 1024 * 1024,
  maxExtractedBytes: expandedLimit = 256 * 1024 * 1024,
  maxEntryBytes: entryLimit = 128 * 1024 * 1024,
} = {}) {
  const buffer = Buffer.isBuffer(archive) ? archive : Buffer.from(archive);
  if (buffer.length < 22 || buffer.length > archiveLimit) throw new Error("ZIP archive size is outside the supported limit");
  const searchStart = Math.max(0, buffer.length - 65557);
  let endOffset = -1;
  for (let offset = buffer.length - 22; offset >= searchStart; offset--) {
    if (buffer.readUInt32LE(offset) === 0x06054b50 &&
        offset + 22 + buffer.readUInt16LE(offset + 20) === buffer.length) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) throw new Error("ZIP archive has no valid end record");
  const disk = buffer.readUInt16LE(endOffset + 4);
  const centralDisk = buffer.readUInt16LE(endOffset + 6);
  const diskEntries = buffer.readUInt16LE(endOffset + 8);
  const totalEntries = buffer.readUInt16LE(endOffset + 10);
  const centralSize = buffer.readUInt32LE(endOffset + 12);
  const centralOffset = buffer.readUInt32LE(endOffset + 16);
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== totalEntries ||
      totalEntries > maxEntries || totalEntries === 0xffff ||
      centralSize === 0xffffffff || centralOffset === 0xffffffff ||
      centralOffset + centralSize > endOffset) {
    throw new Error("Multi-disk, ZIP64, or oversized ZIP archives are not supported");
  }

  const entries = new Map();
  const names = new Set();
  let position = centralOffset;
  let extractedSize = 0;
  for (let index = 0; index < totalEntries; index++) {
    if (position + 46 > centralOffset + centralSize || buffer.readUInt32LE(position) !== 0x02014b50) {
      throw new Error("ZIP archive has an invalid central directory");
    }
    const madeBy = buffer.readUInt16LE(position + 4);
    const flags = buffer.readUInt16LE(position + 8);
    const method = buffer.readUInt16LE(position + 10);
    const expectedCrc = buffer.readUInt32LE(position + 16);
    const compressedSize = buffer.readUInt32LE(position + 20);
    const uncompressedSize = buffer.readUInt32LE(position + 24);
    const nameLength = buffer.readUInt16LE(position + 28);
    const extraLength = buffer.readUInt16LE(position + 30);
    const commentLength = buffer.readUInt16LE(position + 32);
    const startDisk = buffer.readUInt16LE(position + 34);
    const externalAttributes = buffer.readUInt32LE(position + 38);
    const localOffset = buffer.readUInt32LE(position + 42);
    const recordEnd = position + 46 + nameLength + extraLength + commentLength;
    if (recordEnd > centralOffset + centralSize || startDisk !== 0 ||
        compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error("ZIP archive contains unsupported or truncated metadata");
    }
    const rawName = buffer.subarray(position + 46, position + 46 + nameLength);
    const { name, directory } = safeEntryName(rawName);
    if (names.has(name)) throw new Error("ZIP archive contains duplicate paths");
    names.add(name);
    const mode = madeBy >>> 8 === 3 ? externalAttributes >>> 16 : 0;
    const fileType = mode & 0xf000;
    if ((fileType !== 0 && fileType !== 0x8000 && fileType !== 0x4000) ||
        (directory && fileType === 0x8000) || (!directory && fileType === 0x4000)) {
      throw new Error("ZIP archive contains a symbolic link or special file");
    }
    if ((flags & 1) !== 0 || (flags & 0x40) !== 0 || ![0, 8].includes(method)) {
      throw new Error("Encrypted or unsupported ZIP compression is not allowed");
    }
    if (!directory) {
      if (uncompressedSize > entryLimit || compressedSize > archiveLimit) {
        throw new Error("ZIP entry exceeds the supported size limit");
      }
      extractedSize += uncompressedSize;
      if (extractedSize > expandedLimit) throw new Error("ZIP expands beyond the supported size limit");
      if (localOffset + 30 > centralOffset || buffer.readUInt32LE(localOffset) !== 0x04034b50) {
        throw new Error("ZIP archive contains an invalid local file header");
      }
      const localFlags = buffer.readUInt16LE(localOffset + 6);
      const localMethod = buffer.readUInt16LE(localOffset + 8);
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
      const dataEnd = dataOffset + compressedSize;
      if (localFlags !== flags || localMethod !== method || dataEnd > centralOffset ||
          !buffer.subarray(localOffset + 30, localOffset + 30 + localNameLength).equals(rawName)) {
        throw new Error("ZIP archive local and central file headers do not match");
      }
      const compressed = buffer.subarray(dataOffset, dataEnd);
      const data = method === 0 ? Buffer.from(compressed) :
        inflateRawSync(compressed, { maxOutputLength: Math.max(uncompressedSize, 1) });
      if (data.length !== uncompressedSize || crc32(data) !== expectedCrc) {
        throw new Error("ZIP entry size or checksum is invalid");
      }
      entries.set(name, data);
    }
    position = recordEnd;
  }
  if (position !== centralOffset + centralSize) throw new Error("ZIP central directory size is invalid");
  return entries;
}
