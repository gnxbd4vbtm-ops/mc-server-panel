import net from 'node:net';

const MAX_PACKET_LENGTH = 4096;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_RESPONSE_PACKETS = 4096;
const MAX_BUFFERED_BYTES =
  MAX_RESPONSE_BYTES + MAX_RESPONSE_PACKETS * 14 + MAX_PACKET_LENGTH + 4;
const DEFAULT_TIMEOUT_MS = 5000;
const MAX_TIMEOUT_MS = 120_000;

function createError(message, code, name = 'Error') {
  const error = new Error(message);
  error.code = code;
  error.name = name;
  return error;
}

function validateText(value, name, { allowEmpty = true } = {}) {
  if (
    typeof value !== 'string' ||
    (!allowEmpty && value.length === 0) ||
    value.includes('\0')
  ) {
    throw new TypeError(`${name} must be ${allowEmpty ? 'a string' : 'a non-empty string'} without NUL bytes`);
  }

  if (Buffer.byteLength(value, 'utf8') > MAX_PACKET_LENGTH - 10) {
    throw new RangeError(`${name} exceeds the RCON packet size limit`);
  }
  return Buffer.from(value, 'utf8');
}

function createPacket(id, type, body) {
  const length = 8 + body.length + 2;
  if (length > MAX_PACKET_LENGTH) {
    throw new RangeError(`RCON packet exceeds the ${MAX_PACKET_LENGTH}-byte limit`);
  }

  const packet = Buffer.allocUnsafe(length + 4);
  packet.writeInt32LE(length, 0);
  packet.writeInt32LE(id, 4);
  packet.writeInt32LE(type, 8);
  body.copy(packet, 12);
  packet.writeUInt16LE(0, length + 2);
  return packet;
}

/**
 * Authenticate to a Minecraft RCON server and run one command.
 *
 * RCON packets are limited to 4096 bytes. The operation has one deadline,
 * covering connection, authentication, and the complete command response;
 * timeoutMs defaults to 5000 and may be set from 1 to 120000. Command output
 * is joined from all response packets and capped at 1 MiB. AbortSignal
 * cancellation closes the socket and rejects with an AbortError.
 */
export async function rconCommand({
  host,
  port,
  password,
  command,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal,
} = {}) {
  if (
    typeof host !== 'string' ||
    host.length === 0 ||
    host.length > 255 ||
    host.trim() !== host ||
    /[\s\0]/u.test(host)
  ) {
    throw new TypeError('host must be a non-empty hostname or IP address');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TypeError('port must be an integer from 1 to 65535');
  }
  const passwordBytes = validateText(password, 'password', { allowEmpty: false });
  const commandBytes = validateText(command, 'command');
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_TIMEOUT_MS
  ) {
    throw new TypeError(`timeoutMs must be an integer from 1 to ${MAX_TIMEOUT_MS}`);
  }
  if (
    signal !== undefined &&
    (signal === null ||
      typeof signal.aborted !== 'boolean' ||
      typeof signal.addEventListener !== 'function' ||
      typeof signal.removeEventListener !== 'function')
  ) {
    throw new TypeError('signal must be an AbortSignal');
  }

  const authPacket = createPacket(1, 3, passwordBytes);
  const commandPacket = createPacket(2, 2, commandBytes);
  const terminatorPacket = createPacket(3, 2, Buffer.alloc(0));

  if (signal?.aborted) {
    throw createError('RCON operation was aborted', 'ABORT_ERR', 'AbortError');
  }

  return await new Promise((resolve, reject) => {
    let stage = 'connecting';
    let input = Buffer.alloc(0);
    const responseParts = [];
    let responseBytes = 0;
    let responsePackets = 0;
    let settled = false;
    const socket = net.createConnection({ host, port });

    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      socket.destroy();
    };
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(result);
    };
    const onAbort = () => {
      finish(createError('RCON operation was aborted', 'ABORT_ERR', 'AbortError'));
    };
    const timeout = setTimeout(() => {
      finish(createError(`RCON operation timed out after ${timeoutMs} ms`, 'RCON_TIMEOUT'));
    }, timeoutMs);

    signal?.addEventListener('abort', onAbort, { once: true });
    socket.on('connect', () => {
      if (settled) return;
      stage = 'authenticating';
      socket.write(authPacket);
    });
    socket.on('error', (error) => {
      finish(
        createError(
          `RCON connection failed: ${error.message}`,
          'RCON_CONNECTION_ERROR',
        ),
      );
    });
    socket.on('close', () => {
      if (!settled) {
        finish(createError(`RCON connection closed while ${stage}`, 'RCON_CONNECTION_CLOSED'));
      }
    });
    socket.on('data', (chunk) => {
      if (settled) return;
      if (input.length + chunk.length > MAX_BUFFERED_BYTES) {
        finish(createError('RCON response exceeded the buffered data limit', 'RCON_RESPONSE_TOO_LARGE'));
        return;
      }

      input = input.length === 0 ? chunk : Buffer.concat([input, chunk]);
      try {
        while (input.length >= 4) {
          const length = input.readInt32LE(0);
          if (length < 10 || length > MAX_PACKET_LENGTH) {
            throw createError('RCON server sent an invalid packet length', 'RCON_PROTOCOL_ERROR');
          }
          if (input.length < length + 4) break;

          const packet = input.subarray(4, length + 4);
          input = input.subarray(length + 4);
          if (packet[length - 2] !== 0 || packet[length - 1] !== 0) {
            throw createError('RCON server sent a packet without terminators', 'RCON_PROTOCOL_ERROR');
          }

          const id = packet.readInt32LE(0);
          const type = packet.readInt32LE(4);
          const body = packet.subarray(8, length - 2);

          if (stage === 'authenticating') {
            if (id === -1) {
              throw createError('RCON authentication failed', 'RCON_AUTH_FAILED');
            }
            if (id !== 1 || type !== 2) {
              throw createError('RCON server sent an unexpected authentication response', 'RCON_PROTOCOL_ERROR');
            }
            stage = 'command';
            socket.write(commandPacket);
            socket.write(terminatorPacket);
            continue;
          }

          if (stage !== 'command' || type !== 0) {
            throw createError('RCON server sent an unexpected command response', 'RCON_PROTOCOL_ERROR');
          }
          if (id === 3) {
            finish(null, Buffer.concat(responseParts, responseBytes).toString('utf8'));
            return;
          }
          if (id !== 2) {
            throw createError('RCON server sent a response with an unexpected packet ID', 'RCON_PROTOCOL_ERROR');
          }

          responsePackets += 1;
          responseBytes += body.length;
          if (
            responsePackets > MAX_RESPONSE_PACKETS ||
            responseBytes > MAX_RESPONSE_BYTES
          ) {
            throw createError('RCON command response exceeded its size limit', 'RCON_RESPONSE_TOO_LARGE');
          }
          responseParts.push(body);
        }
      } catch (error) {
        finish(error);
      }
    });
  });
}
