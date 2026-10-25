import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import test from 'node:test';
import { parseModrinthPack } from '../src/modrinth-pack.js';

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const contents = Buffer.isBuffer(entry.contents) ? entry.contents : Buffer.from(entry.contents ?? '');
    const compressed = entry.method === 8 ? deflateRawSync(contents) : contents;
    const checksum = entry.crc ?? crc32(contents);
    const flags = 0x0800;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(entry.method ?? 0, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.expandedSize ?? contents.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(((entry.unixMode !== undefined) ? 3 : 0) << 8 | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(entry.method ?? 0, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.expandedSize ?? contents.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt32LE(
      entry.unixMode !== undefined ? ((entry.unixMode << 16) | (entry.name.endsWith('/') ? 0x10 : 0)) >>> 0 : 0,
      38,
    );
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name);
    localOffset += local.length + name.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function manifestFile(path, bytes, env = { client: 'required', server: 'required' }) {
  return {
    path,
    hashes: { sha512: createHash('sha512').update(bytes).digest('hex') },
    env,
    downloads: [`https://cdn.modrinth.com/data/example/${path}`],
    fileSize: bytes.length,
  };
}

function makePack({ files, zipEntries = [], manifestOverrides = {} } = {}) {
  const index = {
    formatVersion: 1,
    game: 'minecraft',
    versionId: 'test',
    name: 'Test pack',
    dependencies: { minecraft: '1.20.4', 'fabric-loader': '0.15.11' },
    files: files ?? [manifestFile('mods/example.jar', Buffer.from('mod'))],
    ...manifestOverrides,
  };
  return zip([
    { name: 'modrinth.index.json', contents: JSON.stringify(index) },
    ...zipEntries,
  ]);
}

function fetchFile(contents) {
  return async (url) => {
    assert.equal(new URL(url).hostname, 'cdn.modrinth.com');
    return new Response(contents, { status: 200 });
  };
}

test('parses a valid pack, applies overrides, and skips client-only files', async () => {
  const mod = Buffer.from('mod-bytes');
  const skipped = manifestFile('mods/client-only.jar', Buffer.from('client'), {
    client: 'required',
    server: 'unsupported',
  });
  const pack = makePack({
    files: [manifestFile('mods/example.jar', mod), skipped],
    zipEntries: [
      { name: 'overrides/config/server.properties', contents: 'motd=Shared\n', method: 8 },
      { name: 'server-overrides/eula.txt', contents: 'eula=true\n' },
    ],
  });
  const result = await parseModrinthPack(pack, { fetch: fetchFile(mod) });

  assert.equal(result.gameVersion, '1.20.4');
  assert.deepEqual(result.loader, { name: 'fabric-loader', version: '0.15.11' });
  assert.deepEqual([...result.files.keys()].sort(), [
    'config/server.properties',
    'eula.txt',
    'mods/example.jar',
  ]);
  assert.equal(result.files.get('mods/example.jar').toString(), 'mod-bytes');
});

test('rejects traversal paths in override entries and manifest files', async () => {
  await assert.rejects(
    parseModrinthPack(makePack({ zipEntries: [{ name: 'overrides/../escape.txt', contents: 'x' }] })),
    /unsafe file path/,
  );
  await assert.rejects(
    parseModrinthPack(makePack({
      files: [manifestFile('../escape.jar', Buffer.from('x'))],
    })),
    /unsafe file path/,
  );
});

test('rejects ZIP CRC and published SHA-512 mismatches', async () => {
  const badCrc = zip([
    { name: 'modrinth.index.json', contents: '{}', crc: 1 },
  ]);
  await assert.rejects(parseModrinthPack(badCrc), /CRC-32 mismatch/);

  const content = Buffer.from('tamperxxx');
  const file = manifestFile('mods/example.jar', Buffer.from('published'));
  await assert.rejects(
    parseModrinthPack(makePack({ files: [file] }), { fetch: fetchFile(content) }),
    /SHA-512 mismatch/,
  );
});

test('rejects expansion bombs and configured size limits before extraction', async () => {
  const bomb = makePack({
    zipEntries: [{ name: 'overrides/large.dat', contents: Buffer.alloc(4096, 0x41), method: 8 }],
  });
  await assert.rejects(
    parseModrinthPack(bomb, { limits: { maxFileBytes: 1024 } }),
    /file-size limit/,
  );
  await assert.rejects(
    parseModrinthPack(bomb, { limits: { maxExpandedBytes: 1024 } }),
    /expanded-size limit/,
  );
});

test('rejects symbolic links and duplicate archive paths', async () => {
  const symlink = makePack({
    zipEntries: [{ name: 'overrides/config-link', contents: 'target', unixMode: 0o120777 }],
  });
  await assert.rejects(parseModrinthPack(symlink), /links and special files/);

  const duplicate = makePack({
    zipEntries: [
      { name: 'overrides/config.txt', contents: 'one' },
      { name: 'overrides/config.txt', contents: 'two' },
    ],
  });
  await assert.rejects(parseModrinthPack(duplicate), /duplicate ZIP path/);
});

test('rejects client-only packs and untrusted download hosts', async () => {
  const clientOnly = manifestFile('mods/client.jar', Buffer.from('x'), {
    client: 'required',
    server: 'unsupported',
  });
  await assert.rejects(
    parseModrinthPack(makePack({ files: [clientOnly] })),
    /client-only pack/,
  );

  const remoteFile = { ...manifestFile('mods/example.jar', Buffer.from('x')) };
  remoteFile.downloads = ['https://cdn.modrinth.com.evil.invalid/file'];
  await assert.rejects(
    parseModrinthPack(makePack({ files: [remoteFile] }), { fetch: fetchFile(Buffer.from('x')) }),
    /https:\/\/cdn\.modrinth\.com/,
  );
});

test('propagates cancellation while a declared file is being fetched', async () => {
  const controller = new AbortController();
  const pack = makePack();
  const fetch = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  const pending = parseModrinthPack(pack, { signal: controller.signal, fetch });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(pending, /aborted|abort/i);
});
