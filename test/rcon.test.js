import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';

import { rconCommand } from '../src/rcon.js';

function encodePacket(id, type, body = '') {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  const length = 8 + bytes.length + 2;
  const packet = Buffer.alloc(length + 4);
  packet.writeInt32LE(length, 0);
  packet.writeInt32LE(id, 4);
  packet.writeInt32LE(type, 8);
  bytes.copy(packet, 12);
  packet.writeUInt16LE(0, length + 2);
  return packet;
}

function startMockServer(onPacket) {
  let onConnection;
  const connected = new Promise((resolve) => {
    onConnection = resolve;
  });
  const server = net.createServer((socket) => {
    onConnection(socket);
    let input = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      input = input.length === 0 ? chunk : Buffer.concat([input, chunk]);
      while (input.length >= 4) {
        const length = input.readInt32LE(0);
        if (input.length < length + 4) break;
        const packet = input.subarray(4, length + 4);
        input = input.subarray(length + 4);
        onPacket(socket, {
          id: packet.readInt32LE(0),
          type: packet.readInt32LE(4),
          body: packet.subarray(8, length - 2).toString('utf8'),
        });
      }
    });
  });
  server.listen(0, '127.0.0.1');
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.once('listening', () => {
      server.removeListener('error', reject);
      resolve({
        host: '127.0.0.1',
        port: server.address().port,
        connected,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

function authenticateAndIgnore(socket, packet) {
  if (packet.type === 3) socket.write(encodePacket(packet.id, 2));
}

test('authenticates and joins fragmented and coalesced command response packets', async (t) => {
  let commandSeen = false;
  const server = await startMockServer((socket, packet) => {
    if (packet.type === 3) {
      assert.equal(packet.body, 'secret');
      socket.write(encodePacket(packet.id, 2));
    } else if (packet.id === 2) {
      commandSeen = packet.type === 2 && packet.body === 'list';
    } else if (packet.id === 3) {
      assert.equal(commandSeen, true);
      const first = encodePacket(2, 0, 'first ');
      const euro = Buffer.from('€', 'utf8');
      const secondAndEnd = Buffer.concat([
        encodePacket(2, 0, 'second'),
        encodePacket(2, 0, euro.subarray(0, 2)),
        encodePacket(2, 0, euro.subarray(2)),
        encodePacket(3, 0),
      ]);
      socket.write(first.subarray(0, 3));
      setTimeout(() => {
        socket.write(Buffer.concat([first.subarray(3), secondAndEnd]));
      }, 5);
    }
  });
  t.after(server.close);

  assert.equal(
    await rconCommand({
      host: server.host,
      port: server.port,
      password: 'secret',
      command: 'list',
    }),
    'first second€',
  );
});

test('rejects failed authentication', async (t) => {
  const server = await startMockServer((socket, packet) => {
    if (packet.type === 3) socket.write(encodePacket(-1, 2));
  });
  t.after(server.close);

  await assert.rejects(
    rconCommand({
      host: server.host,
      port: server.port,
      password: 'wrong',
      command: 'list',
    }),
    { code: 'RCON_AUTH_FAILED' },
  );
});

test('times out when the server does not respond', async (t) => {
  const server = await startMockServer(() => {});
  t.after(server.close);

  await assert.rejects(
    rconCommand({
      host: server.host,
      port: server.port,
      password: 'secret',
      command: 'list',
      timeoutMs: 40,
    }),
    { code: 'RCON_TIMEOUT' },
  );
});

test('cancels an active RCON operation with AbortSignal', async (t) => {
  const server = await startMockServer(() => {});
  t.after(server.close);
  const controller = new AbortController();
  const request = rconCommand({
    host: server.host,
    port: server.port,
    password: 'secret',
    command: 'list',
    timeoutMs: 1000,
    signal: controller.signal,
  });
  await server.connected;
  controller.abort();

  await assert.rejects(request, { code: 'ABORT_ERR', name: 'AbortError' });
});

test('rejects invalid host, port, password, command, timeout, and signal', async () => {
  const valid = { host: 'localhost', port: 25575, password: 'secret', command: 'list' };
  for (const input of [
    { ...valid, host: '' },
    { ...valid, host: 'bad host' },
    { ...valid, port: 0 },
    { ...valid, port: 65536 },
    { ...valid, port: 1.5 },
    { ...valid, password: '' },
    { ...valid, password: 'bad\0password' },
    { ...valid, command: 'bad\0command' },
    { ...valid, timeoutMs: 0 },
    { ...valid, signal: {} },
  ]) {
    await assert.rejects(rconCommand(input), TypeError);
  }

  await assert.rejects(
    rconCommand({ ...valid, password: 'x'.repeat(4087) }),
    RangeError,
  );
  await assert.rejects(
    rconCommand({ ...valid, command: 'x'.repeat(4087) }),
    RangeError,
  );
});

test('rejects an already-aborted signal without opening a connection', async () => {
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    rconCommand({
      host: '127.0.0.1',
      port: 25575,
      password: 'secret',
      command: 'list',
      signal: controller.signal,
    }),
    { code: 'ABORT_ERR', name: 'AbortError' },
  );
});
