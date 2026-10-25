import { constants as fsConstants } from 'node:fs';
import {
  lstat,
  open,
  readdir,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';
import { isIP } from 'node:net';

const DEFAULT_MAX_FILE_SIZE = 1024 * 1024;
const MAX_CONFIGURABLE_FILE_SIZE = 64 * 1024 * 1024;
const MAX_PATH_DEPTH = 16;
const MAX_RELATIVE_PATH_LENGTH = 1024;
const NAME_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,254}$/;
const PLAYER_NAME = /^[A-Za-z0-9_]{1,16}$/;
const MAX_REASON_LENGTH = 256;
const MAX_DATAPACK_NAME_LENGTH = 128;
const MAX_TIME = 2_147_483_647;
const MAX_WEATHER_DURATION = 1_000_000;
const NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

function validateMaxFileSize(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_CONFIGURABLE_FILE_SIZE) {
    throw new TypeError(`maxFileSize must be between 0 and ${MAX_CONFIGURABLE_FILE_SIZE}`);
  }
  return value;
}

function requireNoFollowSupport() {
  if (NOFOLLOW === 0) {
    throw failure('ENOTSUP', 'This platform does not support no-follow file access');
  }
}

function parseRelativePath(value, { allowEmpty = false } = {}) {
  if (typeof value !== 'string' || value.length > MAX_RELATIVE_PATH_LENGTH) {
    throw failure('EINVAL', 'Path must be a short relative path');
  }
  if (allowEmpty && value === '') return [];
  if (
    value === '' ||
    value.startsWith('/') ||
    value.endsWith('/') ||
    value.includes('\\') ||
    value.includes('\0')
  ) {
    throw failure('EINVAL', 'Path must be a safe relative path');
  }

  const segments = value.split('/');
  if (
    segments.length > MAX_PATH_DEPTH ||
    segments.some((segment) =>
      segment === '.' ||
      segment === '..' ||
      !NAME_SEGMENT.test(segment) ||
      segment.endsWith('.') ||
      segment.endsWith(' ')
    )
  ) {
    throw failure('EINVAL', 'Path contains an unsafe name');
  }
  return segments;
}

async function assertDirectoryChain(directory) {
  const absolute = path.resolve(directory);
  const root = path.parse(absolute).root;
  const parts = absolute.slice(root.length).split(path.sep).filter(Boolean);
  let current = root;

  for (const part of parts) {
    current = path.join(current, part);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw failure('ENOENT', 'Server directory does not exist');
      }
      throw error;
    }
    if (info.isSymbolicLink()) {
      throw failure('ELOOP', 'Symbolic links are not allowed in server paths');
    }
    if (!info.isDirectory()) {
      throw failure('ENOTDIR', 'Server path component is not a directory');
    }
  }
  return absolute;
}

async function resolveDirectory(root, relativePath) {
  const segments = parseRelativePath(relativePath, { allowEmpty: true });
  const base = await assertDirectoryChain(root);
  let current = base;

  for (const segment of segments) {
    current = path.join(current, segment);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw failure('ENOENT', 'Directory does not exist');
      }
      throw error;
    }
    if (info.isSymbolicLink()) {
      throw failure('ELOOP', 'Symbolic links are not allowed in server paths');
    }
    if (!info.isDirectory()) {
      throw failure('ENOTDIR', 'Path component is not a directory');
    }
  }
  return { base, directory: current };
}

async function resolveFile(root, relativePath) {
  const segments = parseRelativePath(relativePath);
  const { base, directory } = await resolveDirectory(root, segments.slice(0, -1).join('/'));
  const filePath = path.join(directory, segments.at(-1));
  const relative = path.relative(base, filePath);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw failure('EINVAL', 'Path escapes the server directory');
  }
  return { filePath, name: segments.at(-1) };
}

async function openRegularFile(filePath, flags) {
  requireNoFollowSupport();
  let info;
  try {
    info = await lstat(filePath);
  } catch (error) {
    throw error;
  }
  if (info.isSymbolicLink()) {
    throw failure('ELOOP', 'Symbolic links are not allowed');
  }
  if (!info.isFile()) {
    throw failure('EINVAL', 'Only regular files are supported');
  }

  const handle = await open(filePath, flags | NOFOLLOW | fsConstants.O_NONBLOCK);
  try {
    const openedInfo = await handle.stat();
    if (!openedInfo.isFile() || openedInfo.nlink !== 1) {
      throw failure('EINVAL', 'Only unlinked regular files are supported');
    }
    return { handle, info: openedInfo };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

function validatePayload(data, maxFileSize) {
  if (typeof data !== 'string' && !(data instanceof Uint8Array)) {
    throw new TypeError('File content must be a string or Uint8Array');
  }
  const content = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
  if (content.byteLength > maxFileSize) {
    throw failure('EFBIG', `File exceeds the ${maxFileSize}-byte limit`);
  }
  return content;
}

async function readBounded(handle, maxFileSize) {
  const chunks = [];
  let total = 0;
  while (total <= maxFileSize) {
    const buffer = Buffer.alloc(Math.min(64 * 1024, maxFileSize + 1 - total));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
    if (bytesRead === 0) break;
    chunks.push(buffer.subarray(0, bytesRead));
    total += bytesRead;
  }
  if (total > maxFileSize) {
    throw failure('EFBIG', `File exceeds the ${maxFileSize}-byte limit`);
  }
  return Buffer.concat(chunks, total);
}

export async function listFiles(root, directory = '') {
  const { directory: resolved } = await resolveDirectory(root, directory);
  const entries = await readdir(resolved, { withFileTypes: true });
  const result = [];

  for (const entry of entries) {
    let info;
    try {
      info = await lstat(path.join(resolved, entry.name));
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    const type = info.isSymbolicLink()
      ? 'symlink'
      : info.isDirectory()
        ? 'directory'
        : info.isFile()
          ? 'file'
          : 'other';
    result.push({
      name: entry.name,
      type,
      size: type === 'file' && info.nlink === 1 ? info.size : null,
      safeName: NAME_SEGMENT.test(entry.name) &&
        entry.name !== '.' &&
        entry.name !== '..' &&
        !entry.name.endsWith('.') &&
        !entry.name.endsWith(' '),
    });
  }
  return result.sort((left, right) => left.name.localeCompare(right.name));
}

export async function readFile(root, relativePath, { maxFileSize = DEFAULT_MAX_FILE_SIZE } = {}) {
  validateMaxFileSize(maxFileSize);
  const { filePath } = await resolveFile(root, relativePath);
  const { handle, info } = await openRegularFile(filePath, fsConstants.O_RDONLY);
  try {
    if (info.size > maxFileSize) {
      throw failure('EFBIG', `File exceeds the ${maxFileSize}-byte limit`);
    }
    return await readBounded(handle, maxFileSize);
  } finally {
    await handle.close();
  }
}

export async function writeFile(root, relativePath, data, { maxFileSize = DEFAULT_MAX_FILE_SIZE } = {}) {
  validateMaxFileSize(maxFileSize);
  const content = validatePayload(data, maxFileSize);
  const { filePath } = await resolveFile(root, relativePath);
  const { handle } = await openRegularFile(
    filePath,
    fsConstants.O_WRONLY,
  );
  try {
    await handle.truncate(0);
    await handle.writeFile(content);
  } finally {
    await handle.close();
  }
  return content.byteLength;
}

export async function createFile(root, relativePath, data = '', { maxFileSize = DEFAULT_MAX_FILE_SIZE } = {}) {
  requireNoFollowSupport();
  validateMaxFileSize(maxFileSize);
  const content = validatePayload(data, maxFileSize);
  const { filePath } = await resolveFile(root, relativePath);
  const handle = await open(
    filePath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(content);
  } catch (error) {
    await handle.close();
    await unlink(filePath).catch(() => {});
    throw error;
  }
  await handle.close();
  return content.byteLength;
}

export async function deleteFile(root, relativePath) {
  const { filePath } = await resolveFile(root, relativePath);
  const { handle } = await openRegularFile(filePath, fsConstants.O_RDONLY);
  await handle.close();
  await unlink(filePath);
}

function assertArguments(args, allowed, required = []) {
  if (args === undefined) args = {};
  if (
    args === null ||
    typeof args !== 'object' ||
    (Object.getPrototypeOf(args) !== Object.prototype && Object.getPrototypeOf(args) !== null) ||
    Reflect.ownKeys(args).some((key) => typeof key !== 'string' || !allowed.includes(key))
  ) {
    throw new TypeError('Command arguments must be a plain object with supported fields');
  }
  const descriptors = Object.getOwnPropertyDescriptors(args);
  if (Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value'))) {
    throw new TypeError('Command arguments cannot contain accessors');
  }
  for (const key of required) {
    if (!Object.hasOwn(args, key)) throw new TypeError(`Missing command argument: ${key}`);
  }
  return args;
}

function player(value, field = 'player') {
  if (typeof value !== 'string' || !PLAYER_NAME.test(value)) {
    throw new TypeError(`${field} must be a Minecraft player name`);
  }
  return value;
}

function quoted(value, field, maxLength) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError(`${field} must be printable text of at most ${maxLength} characters`);
  }
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function integer(value, field, { min = 0, max = MAX_TIME } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new TypeError(`${field} must be an integer from ${min} to ${max}`);
  }
  return String(value);
}

function commandForAction(action, args) {
  switch (action) {
    case 'ban': {
      const input = assertArguments(args, ['player', 'reason'], ['player']);
      const command = `ban ${player(input.player)}`;
      return Object.hasOwn(input, 'reason')
        ? `${command} ${quoted(input.reason, 'reason', MAX_REASON_LENGTH)}`
        : command;
    }
    case 'pardon': {
      const input = assertArguments(args, ['player'], ['player']);
      return `pardon ${player(input.player)}`;
    }
    case 'ban-ip': {
      const input = assertArguments(args, ['target', 'reason'], ['target']);
      const target = typeof input.target === 'string' && isIP(input.target) === 0
        ? player(input.target, 'target')
        : input.target;
      if (typeof target !== 'string' || (isIP(target) === 0 && !PLAYER_NAME.test(target))) {
        throw new TypeError('target must be a player name or IP address');
      }
      const command = `ban-ip ${target}`;
      return Object.hasOwn(input, 'reason')
        ? `${command} ${quoted(input.reason, 'reason', MAX_REASON_LENGTH)}`
        : command;
    }
    case 'whitelist.add':
    case 'whitelist.remove': {
      const input = assertArguments(args, ['player'], ['player']);
      return `whitelist ${action.endsWith('add') ? 'add' : 'remove'} ${player(input.player)}`;
    }
    case 'whitelist.list':
    case 'whitelist.on':
    case 'whitelist.off': {
      assertArguments(args, []);
      return `whitelist ${action.slice('whitelist.'.length)}`;
    }
    case 'op':
    case 'deop': {
      const input = assertArguments(args, ['player'], ['player']);
      return `${action} ${player(input.player)}`;
    }
    case 'save-all': {
      const input = assertArguments(args, ['flush']);
      if (Object.hasOwn(input, 'flush') && typeof input.flush !== 'boolean') {
        throw new TypeError('flush must be a boolean');
      }
      return input.flush === true ? 'save-all flush' : 'save-all';
    }
    case 'list':
      assertArguments(args, []);
      return 'list';
    case 'difficulty': {
      const input = assertArguments(args, ['level'], ['level']);
      if (!['peaceful', 'easy', 'normal', 'hard'].includes(input.level)) {
        throw new TypeError('level must be peaceful, easy, normal, or hard');
      }
      return `difficulty ${input.level}`;
    }
    case 'time': {
      const input = assertArguments(args, ['operation', 'value'], ['operation', 'value']);
      if (input.operation === 'set') {
        const value = typeof input.value === 'string' &&
          ['day', 'noon', 'night', 'midnight'].includes(input.value)
          ? input.value
          : integer(input.value, 'value');
        return `time set ${value}`;
      }
      if (input.operation === 'add') {
        return `time add ${integer(input.value, 'value')}`;
      }
      throw new TypeError('operation must be set or add');
    }
    case 'weather': {
      const input = assertArguments(args, ['type', 'duration'], ['type']);
      if (!['clear', 'rain', 'thunder'].includes(input.type)) {
        throw new TypeError('type must be clear, rain, or thunder');
      }
      const command = `weather ${input.type}`;
      return Object.hasOwn(input, 'duration')
        ? `${command} ${integer(input.duration, 'duration', { min: 1, max: MAX_WEATHER_DURATION })}`
        : command;
    }
    case 'datapack.list': {
      const input = assertArguments(args, ['type']);
      if (!Object.hasOwn(input, 'type')) return 'datapack list';
      if (!['available', 'enabled'].includes(input.type)) {
        throw new TypeError('type must be available or enabled');
      }
      return `datapack list ${input.type}`;
    }
    case 'datapack.enable':
    case 'datapack.disable': {
      const input = assertArguments(args, ['name'], ['name']);
      const name = quoted(input.name, 'name', MAX_DATAPACK_NAME_LENGTH);
      return `datapack ${action.endsWith('enable') ? 'enable' : 'disable'} ${name}`;
    }
    default:
      throw new TypeError('Unsupported Minecraft admin action');
  }
}

export function buildAdminCommand(action, args = {}) {
  if (typeof action !== 'string') throw new TypeError('Action must be a string');
  return commandForAction(action, args);
}

export function createAdminExecutor(sendCommand) {
  if (typeof sendCommand !== 'function') {
    throw new TypeError('sendCommand must be a function');
  }
  return (action, args = {}) => sendCommand(buildAdminCommand(action, args));
}
