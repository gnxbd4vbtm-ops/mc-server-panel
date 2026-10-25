import assert from 'node:assert/strict';
import { createServer as createNetServer } from 'node:net';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { Database } from '../src/database.js';
import { ServerManager } from '../src/manager.js';

const fixtures = [];
const managers = [];
const databases = [];

async function makeManager(options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'byte-server-panel-'));
  fixtures.push(root);
  const database = new Database(path.join(root, 'panel.sqlite'));
  const manager = new ServerManager(database, {
    serverDir: path.join(root, 'servers'),
    backupDir: path.join(root, 'backups'),
    availableMemoryMb: 4096,
    ...options
  });
  await manager.initialize();
  managers.push(manager);
  databases.push(database);
  return { root, database, manager };
}

async function availablePort() {
  const { createServer } = await import('node:net');
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function fakeRcon(port, expectedPassword) {
  const server = createNetServer((socket) => {
    let pending = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 4) {
        const length = pending.readInt32LE(0);
        if (pending.length < length + 4) break;
        const packet = pending.subarray(0, length + 4);
        pending = pending.subarray(length + 4);
        const id = packet.readInt32LE(4);
        const type = packet.readInt32LE(8);
        const body = packet.subarray(12, length + 2).toString('utf8');
        if (type === 3) {
          socket.write(fakeRconPacket(body === expectedPassword ? id : -1, 2));
        } else if (type === 2) {
          socket.write(fakeRconPacket(id, 0, body === 'list' ? 'There are 0 of 20 players online' : 'ok'));
        }
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return server;
}

function fakeRconPacket(id, type, body = '') {
  const text = Buffer.from(body);
  const packet = Buffer.alloc(text.length + 14);
  packet.writeInt32LE(text.length + 10, 0);
  packet.writeInt32LE(id, 4);
  packet.writeInt32LE(type, 8);
  text.copy(packet, 12);
  packet.writeUInt16LE(0, text.length + 12);
  return packet;
}

async function fakeJava(root, name, version = '21.0.0', serverScript = 'printf "Done (test)\\n"\nwhile IFS= read -r line; do [ "$line" = "stop" ] && exit 0; done\n') {
  const executable = path.join(root, name);
  await writeFile(executable, `#!/bin/sh\nif [ "$1" = "-version" ]; then echo 'openjdk version "${version}"' >&2; exit 0; fi\n${serverScript}`);
  await chmod(executable, 0o700);
  return executable;
}

function makeStoredZip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const body = Buffer.from(entry.contents);
    const checksum = testCrc32(body);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(body.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, body);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x0800, 8);
    record.writeUInt32LE(checksum, 16);
    record.writeUInt32LE(body.length, 20);
    record.writeUInt32LE(body.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(offset, 42);
    central.push(record, name);
    offset += header.length + name.length + body.length;
  }
  const centralDirectory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralDirectory, end]);
}

function testCrc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.shutdown()));
  for (const database of databases.splice(0)) database.close();
  await Promise.all(fixtures.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test('creates isolated server configuration and rejects invalid inputs or port reuse', async () => {
  const { manager, database } = await makeManager();
  const port = await availablePort();
  const server = await manager.createServer({
    name: 'Survival World',
    minecraftVersion: '1.21.8',
    port,
    memoryMb: 1024
  });

  test('keeps RCON credentials private and masks the server properties password', async () => {
    const { manager, database } = await makeManager();
    const server = await manager.createServer({
      name: 'RCON privacy',
      minecraftVersion: '1.21.8',
      port: await availablePort(),
      memoryMb: 512
    });
    const internal = database.getServer(server.id);
    const password = await manager.ensureRconConfiguration(internal);
    const secretPath = path.join(internal.directory, '.panel-rcon-secret');
    assert.equal((await stat(secretPath)).mode & 0o777, 0o600);
    assert.equal((await readFile(secretPath, 'utf8')).trim(), password);
    assert.equal(server.rconPort, undefined);
    assert.equal(manager.getServer(server.id).rconPort, undefined);
    database.updateServer(server.id, { installed: 1 });
    assert.match((await manager.readServerFile(server.id, 'server.properties')).content, /rcon\.password=\[managed\]/);
    await assert.rejects(manager.readServerFile(server.id, '.panel-rcon-secret'), /not available/);
  });

  assert.equal(server.status, 'stopped');
  assert.equal(server.installed, false);
  assert.equal(server.software, 'vanilla');
  assert.equal(server.eulaAccepted, false);
  assert.equal(server.directory, undefined);
  assert.match(database.getServer(server.id).directory, /servers\/survival-world-/);
  const snapshot = await manager.createServer({
    name: 'Snapshot server',
    minecraftVersion: '26.4-snapshot-5',
    port: await availablePort(),
    memoryMb: 512
  });
  assert.equal(snapshot.minecraftVersion, '26.4-snapshot-5');
  const weeklySnapshot = await manager.createServer({
    name: 'Weekly snapshot',
    minecraftVersion: '24w14a',
    port: await availablePort(),
    memoryMb: 512
  });
  assert.equal(weeklySnapshot.minecraftVersion, '24w14a');
  const legacyVersion = await manager.createServer({
    name: 'Legacy version',
    minecraftVersion: 'b1.7.3',
    port: await availablePort(),
    memoryMb: 512
  });
  assert.equal(legacyVersion.minecraftVersion, 'b1.7.3');
  assert.equal(database.getServer('missing'), null);
  await assert.rejects(manager.createServer({
    name: 'Duplicate port',
    minecraftVersion: '1.21.8',
    port,
    memoryMb: 512
  }), /already assigned/);
  await assert.rejects(manager.createServer({
    name: 'Invalid software',
    minecraftVersion: '1.21.8',
    port: await availablePort(),
    memoryMb: 512,
    software: 'custom'
  }), /supported Minecraft server software/);
  await assert.rejects(manager.createServer({
    name: 'Invalid version',
    minecraftVersion: '../outside',
    port: await availablePort(),
    memoryMb: 512
  }), /valid Minecraft version/);
  await assert.rejects(manager.createServer({
    name: 'Overallocated',
    minecraftVersion: '1.21.8',
    port: await availablePort(),
    memoryMb: 2048
  }), /based on available memory/);
  const { createServer } = await import('node:net');
  const occupied = createServer();
  await new Promise((resolve, reject) => {
    occupied.once('error', reject);
    occupied.listen(0, '127.0.0.1', resolve);
  });
  const occupiedPort = occupied.address().port;
  try {
    await assert.rejects(manager.createServer({
      name: 'Occupied port',
      minecraftVersion: '1.21.8',
      port: occupiedPort,
      memoryMb: 512
    }), /already in use/);
  } finally {
    await new Promise((resolve, reject) => occupied.close((error) => error ? reject(error) : resolve()));
  }
});

test('downloads only a Mojang-hosted jar and verifies its official SHA-1 and size', async () => {
  const jar = Buffer.from('verified-disposable-jar-content');
  const release = {
    id: '1.21.8',
    type: 'release',
    releaseTime: '2025-01-01T00:00:00+00:00',
    url: 'https://piston-meta.mojang.com/version.json'
  };
  const fetch = async (value, options) => {
    assert.equal(options.headers['accept-encoding'], 'identity');
    const url = String(value);
    if (url === 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json') {
      return Response.json({ versions: [release] });
    }
    if (url === release.url) {
      return Response.json({
        javaVersion: { component: 'jre-legacy', majorVersion: 21 },
        downloads: { server: {
          url: 'https://piston-data.mojang.com/server.jar',
          size: jar.length,
          sha1: createHash('sha1').update(jar).digest('hex')
        } }
      });
    }
    if (url === 'https://piston-data.mojang.com/server.jar') return new Response(jar);
    throw new Error(`Unexpected URL: ${url}`);
  };
  const { root, manager } = await makeManager({ fetch });
  const javaPath = await fakeJava(root, 'test-java', '25.0.1');
  const server = await manager.createServer({
    name: 'Verified',
    minecraftVersion: '1.21.8',
    port: await availablePort(),
    memoryMb: 1024,
    javaPath
  });

  await assert.rejects(manager.install(server.id), /Explicit confirmation/);
  assert.deepEqual(await manager.install(server.id, { confirmed: true }), { installed: true, version: '1.21.8' });
  const directory = manager.requireServer(server.id).directory;
  assert.equal((await readFile(path.join(directory, 'server.jar'))).toString(), jar.toString());
  assert.match(await readFile(path.join(directory, 'server.properties'), 'utf8'), /server-port=/);
  assert.equal(manager.requireServer(server.id).installed, true);
  assert.equal(manager.requireServer(server.id).requiredJavaMajor, 21);
});

test('installs a checksum-verified Paper server from official metadata', async () => {
  const { root, manager, database } = await makeManager();
  const executable = await fakeJava(root, 'paper-java');
  const artifactBytes = Buffer.from('verified paper jar');
  const artifactHash = createHash('sha256').update(artifactBytes).digest('hex');
  const gameVersion = { id: '1.21.8', url: 'https://piston-meta.mojang.com/version.json' };
  manager.fetch = async (value) => {
    const url = String(value);
    if (url.endsWith('version_manifest_v2.json')) return Response.json({ versions: [gameVersion] });
    if (url === gameVersion.url) return Response.json({ javaVersion: { majorVersion: 21 } });
    if (url === 'https://api.papermc.io/v2/projects/paper/versions/1.21.8') {
      return Response.json({ project_id: 'paper', version: '1.21.8', builds: [42] });
    }
    if (url === 'https://api.papermc.io/v2/projects/paper/versions/1.21.8/builds/42') {
      return Response.json({
        project_id: 'paper', version: { id: '1.21.8' }, build: 42,
        downloads: { application: { name: 'paper.jar', sha256: artifactHash, size: artifactBytes.length } }
      });
    }
    if (url === 'https://api.papermc.io/v2/projects/paper/versions/1.21.8/builds/42/downloads/paper.jar') {
      return new Response(artifactBytes);
    }
    throw new Error(`Unexpected URL ${url}`);
  };
  const server = await manager.createServer({
    name: 'Verified Paper',
    minecraftVersion: '1.21.8',
    software: 'paper',
    javaPath: executable,
    port: await availablePort(),
    memoryMb: 512
  });
  const result = await manager.install(server.id, { confirmed: true });
  assert.equal(result.software, 'paper');
  assert.equal(database.getServer(server.id).installed, true);
  assert.deepEqual(await readFile(path.join(database.getServer(server.id).directory, 'server.jar')), artifactBytes);
  assert.equal((await stat(path.join(database.getServer(server.id).directory, 'server.properties'))).mode & 0o777, 0o600);
});

test('attempts a checksum-verified Fabric install when the game version is absent from its catalog', async () => {
  const { root, manager, database } = await makeManager();
  const executable = path.join(root, 'fake-fabric-java');
  await writeFile(executable, `#!/bin/sh
if [ "$1" = "-version" ]; then echo 'openjdk version "21.0.0"' >&2; exit 0; fi
if [ "$1" = "-jar" ]; then
  case "$2" in
    *installer.jar) printf 'minecraft-server-jar' > server.jar; printf 'fabric-launcher-jar' > fabric-server-launch.jar ;;
  esac
  exit 0
fi
if [ "$3" = "-jar" ]; then printf '%s' "$4" > invoked-launch.txt; exit 0; fi
exit 1
`);
  await chmod(executable, 0o700);
  const installerBytes = Buffer.from('checksum-verified Fabric installer');
  const sha1 = createHash('sha1').update(installerBytes).digest('hex');
  const release = { id: '1.21.8', url: 'https://piston-meta.mojang.com/version.json' };
  manager.fetch = async (value) => {
    const url = String(value);
    if (url.endsWith('version_manifest_v2.json')) return Response.json({ versions: [release] });
    if (url === release.url) return Response.json({ javaVersion: { majorVersion: 21 } });
    if (url === 'https://meta.fabricmc.net/v2/versions/game') return Response.json([{ version: '1.20.6' }]);
    if (url === 'https://meta.fabricmc.net/v2/versions/loader') return Response.json([{ version: '0.17.2', stable: true }]);
    if (url === 'https://meta.fabricmc.net/v2/versions/installer') return Response.json([{
      version: '1.0.1', stable: true, maven: 'net.fabricmc:fabric-installer:1.0.1'
    }]);
    if (url === 'https://maven.fabricmc.net/net/fabricmc/fabric-installer/1.0.1/fabric-installer-1.0.1.jar.sha1') {
      return new Response(sha1);
    }
    if (url === 'https://maven.fabricmc.net/net/fabricmc/fabric-installer/1.0.1/fabric-installer-1.0.1.jar') {
      return new Response(installerBytes);
    }
    throw new Error(`Unexpected URL ${url}`);
  };
  const server = await manager.createServer({
    name: 'Fabric server',
    minecraftVersion: '1.21.8',
    software: 'fabric',
    javaPath: executable,
    port: await availablePort(),
    memoryMb: 512
  });
  const result = await manager.install(server.id, { confirmed: true });
  assert.equal(result.software, 'fabric');
  assert.equal(database.getServer(server.id).loaderVersion, '0.17.2');
  const serverDirectory = database.getServer(server.id).directory;
  assert.deepEqual(await readFile(path.join(serverDirectory, 'server.jar')), Buffer.from('minecraft-server-jar'));
  assert.deepEqual(await readFile(path.join(serverDirectory, 'fabric-server-launch.jar')), Buffer.from('fabric-launcher-jar'));
  await manager.start(server.id, { acceptEula: true });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(await readFile(path.join(serverDirectory, 'invoked-launch.txt'), 'utf8'),
    path.join(serverDirectory, 'fabric-server-launch.jar'));
  assert.deepEqual((await readdir(manager.serverDir)).filter((name) => name.startsWith('.provider-stage-')), []);
});

test('repairs Fabric installs that replaced the Minecraft server jar with the loader launcher', async () => {
  const { root, manager, database } = await makeManager();
  const executable = path.join(root, 'fake-repair-java');
  await writeFile(executable, `#!/bin/sh
if [ "$1" = "-version" ]; then echo 'openjdk version "21.0.0"' >&2; exit 0; fi
if [ "$3" = "-jar" ]; then printf '%s' "$4" > invoked-launch.txt; exit 0; fi
exit 1
`);
  await chmod(executable, 0o700);
  const serverBytes = Buffer.from('verified-minecraft-server-jar');
  const release = { id: '1.21.8', url: 'https://piston-meta.mojang.com/version.json' };
  manager.fetch = async (value, options) => {
    assert.equal(options.headers['accept-encoding'], 'identity');
    const url = String(value);
    if (url.endsWith('version_manifest_v2.json')) return Response.json({ versions: [release] });
    if (url === release.url) return Response.json({
      downloads: { server: {
        url: 'https://piston-data.mojang.com/server.jar',
        size: serverBytes.length,
        sha1: createHash('sha1').update(serverBytes).digest('hex')
      } }
    });
    if (url === 'https://piston-data.mojang.com/server.jar') return new Response(serverBytes);
    throw new Error(`Unexpected URL ${url}`);
  };
  const server = await manager.createServer({
    name: 'Broken Fabric legacy',
    minecraftVersion: '1.21.8',
    software: 'fabric',
    javaPath: executable,
    port: await availablePort(),
    memoryMb: 512
  });
  const legacyLauncher = Buffer.from([0x50, 0x4b, 0x03, 0x04, ...Buffer.from('legacy fabric launcher')]);
  await writeFile(path.join(database.getServer(server.id).directory, 'server.jar'), legacyLauncher);
  database.updateServer(server.id, { installed: 1, eula_accepted: 1 });

  await manager.start(server.id);
  const directory = database.getServer(server.id).directory;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(await readFile(path.join(directory, 'server.jar')), serverBytes);
  assert.deepEqual(await readFile(path.join(directory, 'fabric-server-launch.jar')), legacyLauncher);
  assert.equal(await readFile(path.join(directory, 'invoked-launch.txt'), 'utf8'),
    path.join(directory, 'fabric-server-launch.jar'));
});

test('imports a verified Modrinth server pack without replacing managed configuration', async () => {
    const { manager, database } = await makeManager();
    const server = await manager.createServer({
      name: 'Modrinth test',
      minecraftVersion: '1.21.8',
      software: 'fabric',
      port: await availablePort(),
      memoryMb: 512
    });
    database.updateServer(server.id, { installed: 1 });
    const modBytes = Buffer.from('server mod bytes');
    const modrinthFile = {
      path: 'mods/example.jar',
      hashes: { sha512: createHash('sha512').update(modBytes).digest('hex') },
      env: { client: 'required', server: 'required' },
      downloads: ['https://cdn.modrinth.com/data/projectabc/example.jar'],
      fileSize: modBytes.length
    };
    const packBytes = makeStoredZip([{
      name: 'modrinth.index.json',
      contents: JSON.stringify({
        formatVersion: 1,
        game: 'minecraft',
        versionId: 'panel-test',
        name: 'Panel test pack',
        dependencies: { minecraft: '1.21.8', 'fabric-loader': '0.17.2' },
        files: [modrinthFile]
      })
    }, { name: 'server-overrides/config/pack.json', contents: '{"enabled":true}' }]);
    const packHash = createHash('sha512').update(packBytes).digest('hex');
    manager.fetch = async (value) => {
      const url = String(value);
      if (url === 'https://api.modrinth.com/v2/version/packversion') {
        return Response.json({
          id: 'packversion', project_id: 'projectabc', project_type: 'modpack',
          name: 'Panel test pack', version_number: '1.0',
          game_versions: ['1.21.8'], loaders: ['fabric'],
          files: [{
            filename: 'pack.mrpack',
            url: 'https://cdn.modrinth.com/data/projectabc/pack.mrpack',
            size: packBytes.length, hashes: { sha512: packHash }, primary: true
          }]
        });
      }
      if (url === 'https://cdn.modrinth.com/data/projectabc/pack.mrpack') return new Response(packBytes);
      if (url === 'https://cdn.modrinth.com/data/projectabc/example.jar') return new Response(modBytes);
      throw new Error(`Unexpected URL ${url}`);
    };
    const result = await manager.installModrinthPack(server.id, { versionId: 'packversion' });
    const directory = database.getServer(server.id).directory;
    assert.equal(result.installed, 2);
    assert.deepEqual(await readFile(path.join(directory, 'mods', 'example.jar')), modBytes);
    assert.equal(await readFile(path.join(directory, 'config', 'pack.json'), 'utf8'), '{"enabled":true}');
    assert.match(await readFile(path.join(directory, 'server.properties'), 'utf8'), /rcon.password=/);
});

test('installs Modrinth mods only for compatible loaders and hashes', async () => {
  const { manager, database } = await makeManager();
  const server = await manager.createServer({
    name: 'Modrinth mod test',
    minecraftVersion: '1.21.8',
    software: 'fabric',
    port: await availablePort(),
    memoryMb: 512
  });
  database.updateServer(server.id, { installed: 1 });
  const bytes = Buffer.from('verified mod jar');
  const sha512 = createHash('sha512').update(bytes).digest('hex');
  manager.fetch = async (value) => {
    const url = String(value);
    if (url === 'https://api.modrinth.com/v2/version/version123') {
      return Response.json({
        id: 'version123', project_id: 'project123', project_type: 'mod',
        name: 'Example', version_number: '1.0', game_versions: ['1.21.8'], loaders: ['fabric'],
        files: [{
          filename: 'example.jar', url: 'https://cdn.modrinth.com/data/project123/example.jar',
          size: bytes.length, hashes: { sha512 }, primary: true
        }]
      });
    }
    if (url === 'https://cdn.modrinth.com/data/project123/example.jar') return new Response(bytes);
    throw new Error(`Unexpected URL ${url}`);
  };
  const result = await manager.installModrinthContent(server.id, {
    contentType: 'mod', versionId: 'version123'
  });
  assert.equal(result.installed, 1);
  assert.deepEqual(await readFile(path.join(database.getServer(server.id).directory, 'mods', 'example.jar')), bytes);
  await assert.rejects(manager.installModrinthContent(server.id, {
    contentType: 'mod', versionId: 'version123'
  }), /already exists/);
});

test('rejects Modrinth plugins on Fabric and mods on Paper', async () => {
  const { manager, database } = await makeManager();
  const fabric = await manager.createServer({
    name: 'Fabric compatibility test',
    minecraftVersion: '1.21.8',
    software: 'fabric',
    port: await availablePort(),
    memoryMb: 512
  });
  const paper = await manager.createServer({
    name: 'Paper compatibility test',
    minecraftVersion: '1.21.8',
    software: 'paper',
    port: await availablePort(),
    memoryMb: 512
  });
  database.updateServer(fabric.id, { installed: 1 });
  database.updateServer(paper.id, { installed: 1 });

  await assert.rejects(manager.installModrinthContent(fabric.id, {
    contentType: 'plugin', versionId: 'plugin-version'
  }), /Plugins require a Paper or Purpur server/);
  await assert.rejects(manager.installModrinthContent(paper.id, {
    contentType: 'mod', versionId: 'mod-version'
  }), /Mods require a Fabric, Forge, NeoForge, or Quilt server/);
});

test('rejects non-Mojang download URLs without writing a server jar', async () => {
  const release = { id: '1.21.8', url: 'https://piston-meta.mojang.com/version.json' };
  const fetch = async (value) => {
    const url = String(value);
    if (url.endsWith('version_manifest_v2.json')) return Response.json({ versions: [release] });
    if (url === release.url) return Response.json({ downloads: { server: {
      url: 'https://example.invalid/server.jar', size: 1, sha1: '0'.repeat(40)
    } } });
    throw new Error(`Unexpected request: ${url}`);
  };
  const { root, manager } = await makeManager({ fetch });
  const javaPath = await fakeJava(root, 'test-java');
  const server = await manager.createServer({
    name: 'Unsafe metadata',
    minecraftVersion: '1.21.8',
    port: await availablePort(),
    memoryMb: 1024,
    javaPath
  });

  await assert.rejects(manager.install(server.id, { confirmed: true }), /outside Mojang/);
  await assert.rejects(readFile(path.join(manager.requireServer(server.id).directory, 'server.jar')), { code: 'ENOENT' });
  assert.equal(manager.requireServer(server.id).installed, false);
});

test('discovers Java runtimes and blocks a runtime below the Mojang minimum', async () => {
  const { root, manager, database } = await makeManager({ javaCandidates: [] });
  const java17 = await fakeJava(root, 'java-17', '17.0.12');
  const java21 = await fakeJava(root, 'java-21', '21.0.6');
  manager.javaCandidates = [java17, java21, java21];
  const runtimes = await manager.javaRuntimes();
  assert.deepEqual(runtimes.map(({ majorVersion }) => majorVersion), [21, 17]);
  assert.equal(runtimes[0].path, java21);

  let jarRequested = false;
  const release = { id: '1.21.8', url: 'https://piston-meta.mojang.com/version.json' };
  manager.fetch = async (value) => {
    const url = String(value);
    if (url.endsWith('version_manifest_v2.json')) return Response.json({ versions: [release] });
    if (url === release.url) return Response.json({
      javaVersion: { majorVersion: 21 },
      downloads: { server: { url: 'https://piston-data.mojang.com/server.jar', size: 1, sha1: '0'.repeat(40) } }
    });
    jarRequested = true;
    throw new Error('Java compatibility should have been checked before downloading.');
  };
  const server = await manager.createServer({
    name: 'Java compatibility test',
    minecraftVersion: '1.21.8',
    port: await availablePort(),
    memoryMb: 1024,
    javaPath: java17
  });
  await assert.rejects(manager.install(server.id, { confirmed: true }), /requires Java 21 or newer/);
  assert.equal(jarRequested, false);
  database.updateServer(server.id, { installed: 1, required_java_major: 21 });
  await assert.rejects(manager.start(server.id, { acceptEula: true }), /requires Java 21 or newer/);
  assert.equal(database.getServer(server.id).status, 'stopped');
});

test('persists background task progress, supports cancellation, and marks interrupted work on restart', async () => {
  const { root, manager, database } = await makeManager();
  const server = await manager.createServer({
    name: 'Task cancellation',
    minecraftVersion: '1.21.8',
    port: await availablePort(),
    memoryMb: 512
  });
  manager.fetch = async (url, options = {}) => {
    if (String(url).endsWith('version_manifest_v2.json')) {
      return Response.json({ versions: [{ id: '1.21.8', url: 'https://piston-meta.mojang.com/version.json' }] });
    }
    if (String(url).endsWith('version.json')) {
      return Response.json({ javaVersion: { majorVersion: 21 }, downloads: { server: {
        url: 'https://piston-data.mojang.com/server.jar',
        size: 1,
        sha1: '0'.repeat(40)
      } } });
    }
    return new Promise((resolve, reject) => {
      if (options.signal.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    });
  };
  const executable = await fakeJava(root, 'java-task');
  database.updateServer(server.id, { java_path: executable });
  const task = manager.queueTask('install', server.id, { confirmed: true });
  await waitFor(() => manager.getTask(task.id).status === 'running');
  assert.throws(() => manager.queueTask('install', server.id, { confirmed: true }), /already active/);
  manager.cancelTask(task.id);
  await waitFor(() => manager.getTask(task.id).status === 'cancelled');
  assert.equal(manager.getTask(task.id).progress >= 1, true);

  const interrupted = database.createTask({
    id: '8c5d6f1e-0eb5-4f33-b89e-97ae89044b1a',
    type: 'backup',
    serverId: server.id,
    createdAt: new Date().toISOString()
  });
  assert.equal(interrupted.status, 'queued');
  const restarted = new ServerManager(database, {
    serverDir: path.join(root, 'servers'),
    backupDir: path.join(root, 'backups'),
    availableMemoryMb: 4096
  });
  await restarted.initialize();
  managers.push(restarted);
  assert.equal(restarted.getTask(interrupted.id).status, 'failed');
  assert.match(restarted.getTask(interrupted.id).error, /restarted/);
});

test('persists recurring schedules and historical resource metrics', async () => {
  const { manager, database } = await makeManager();
  const server = await manager.createServer({
    name: 'Schedule metrics',
    minecraftVersion: '1.21.8',
    port: await availablePort(),
    memoryMb: 512
  });
  const schedule = manager.createSchedule(server.id, { action: 'backup', intervalMinutes: 5 });
  assert.equal(schedule.enabled, true);
  await assert.rejects(
    Promise.resolve().then(() => manager.createSchedule(server.id, { action: 'command', intervalMinutes: 1 })),
    /action must be/
  );
  database.advanceSchedule(schedule.id, new Date(Date.now() - 6000).toISOString(), new Date(Date.now() - 1000).toISOString());
  await manager.runDueSchedules();
  assert.equal(manager.listSchedules(server.id)[0].lastRunAt !== null, true);
  await waitFor(() => manager.listTasks().some((task) => task.status === 'completed'));

  await manager.sampleMetrics();
  const metrics = manager.getMetrics(server.id, 10);
  assert.equal(metrics.length >= 1, true);
  assert.equal(metrics.at(-1).diskBytes >= 0, true);
  const diagnostics = await manager.diagnostics();
  assert.equal('javaPath' in diagnostics.servers[0], false);
  assert.equal(diagnostics.metrics[server.id].length >= 1, true);
});

test('applies per-server backup retention and deletes archived backups', async () => {
  const { manager, database } = await makeManager({ backupRetention: 1 });
  const server = await manager.createServer({
    name: 'Backup retention',
    minecraftVersion: '1.21.8',
    port: await availablePort(),
    memoryMb: 512
  });

  const first = await manager.createBackup(server.id);
  const second = await manager.createBackup(server.id);
  assert.deepEqual(database.listBackups(server.id).map((backup) => backup.id), [second.id]);
  await assert.rejects(manager.getBackupDownload(first.id), /Backup not found/);
  assert.equal((await manager.getBackupDownload(second.id)).sizeBytes > 0, true);

  await manager.deleteBackup(second.id);
  assert.deepEqual(database.listBackups(server.id), []);
});

test('starts a local process once, sends commands, and stops gracefully', async () => {
  const { manager, database } = await makeManager();
  const executable = await fakeJava(fixtures.at(-1), 'test-java');
  const server = await manager.createServer({
    name: 'Process test',
    minecraftVersion: '1.21.8',
    port: await availablePort(),
    memoryMb: 1024,
    javaPath: executable
  });
  database.updateServer(server.id, { installed: 1 });

  await assert.rejects(manager.start(server.id), /accept the Minecraft EULA/);
  assert.equal((await manager.start(server.id, { acceptEula: true })).status, 'starting');
  await assert.rejects(manager.start(server.id), /already running/);
  await waitFor(() => database.getServer(server.id).status === 'running');
  assert.equal(manager.sendCommand(server.id, 'list').sent, true);
  assert.throws(() => manager.sendCommand(server.id, 'say hello\nstop'), /single line/);
  await manager.stop(server.id);
  await waitFor(() => database.getServer(server.id).status === 'stopped');
  assert.equal((await manager.getLogs(server.id)).some((entry) => entry.line.includes('Done (test)')), true);
});

test('detects and controls a still-running server process after manager restart', async () => {
  const { root, manager, database } = await makeManager();
  const executable = await fakeJava(root, 'test-java-orphan', '21.0.0',
    'while IFS= read -r line; do [ "$line" = "stop" ] && sleep 1 && exit 0; done\n');
  const server = await manager.createServer({
    name: 'Recovery test',
    minecraftVersion: '1.21.8',
    port: await availablePort(),
    memoryMb: 1024,
    javaPath: executable
  });
  database.updateServer(server.id, { installed: 1 });
  await manager.start(server.id, { acceptEula: true });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const internal = database.getServer(server.id);
  const password = await readFile(path.join(internal.directory, '.panel-rcon-secret'), 'utf8').then((value) => value.trim());
  const rconServer = await fakeRcon(internal.rconPort, password);
  try {
    const restartedManager = new ServerManager(database, {
      serverDir: path.join(root, 'servers'),
      backupDir: path.join(root, 'backups'),
      availableMemoryMb: 4096
    });
    await restartedManager.initialize();
    managers.push(restartedManager);

    assert.equal(database.getServer(server.id).status, 'running');
    assert.match((await restartedManager.sendCommand(server.id, 'list')).output, /0 of 20 players/);
    assert.equal(restartedManager.runtime.get(server.id).attached, true);
    await restartedManager.stop(server.id, true);
    await waitFor(() => database.getServer(server.id).status === 'stopped', 2500);
  } finally {
    await new Promise((resolve, reject) => rconServer.close((error) => error ? reject(error) : resolve()));
  }
});

test('requires manual confirmation when earlier process identity is unavailable', async () => {
  const { root, manager, database } = await makeManager();
  const server = await manager.createServer({
    name: 'Unknown process test',
    minecraftVersion: '1.21.8',
    port: await availablePort(),
    memoryMb: 1024
  });
  database.updateServer(server.id, { installed: 1, status: 'running' });
  const restartedManager = new ServerManager(database, {
    serverDir: path.join(root, 'servers'),
    backupDir: path.join(root, 'backups'),
    availableMemoryMb: 4096
  });
  await restartedManager.initialize();
  managers.push(restartedManager);

  assert.equal(database.getServer(server.id).status, 'unknown');
  await assert.rejects(restartedManager.start(server.id, { acceptEula: true }), /Confirm that the previous process has stopped/);
  assert.throws(() => restartedManager.confirmStopped(server.id), /Explicit confirmation/);
  restartedManager.confirmStopped(server.id, { confirmed: true });
  assert.equal(database.getServer(server.id).status, 'stopped');
});

test('force-stops a process and records a stopped status', async () => {
  const { root, manager, database } = await makeManager();
  const executable = await fakeJava(root, 'test-java-force', '21.0.0', 'exec /bin/sleep 30\n');
  const server = await manager.createServer({
    name: 'Force stop test',
    minecraftVersion: '1.21.8',
    port: await availablePort(),
    memoryMb: 1024,
    javaPath: executable
  });
  database.updateServer(server.id, { installed: 1 });
  await manager.start(server.id, { acceptEula: true });
  await manager.stop(server.id, true);
  await waitFor(() => database.getServer(server.id).status === 'stopped');
});

test('rejects an unavailable Java executable before accepting the EULA', async () => {
  const { manager, database } = await makeManager();
  const server = await manager.createServer({
    name: 'Missing Java test',
    minecraftVersion: '1.21.8',
    port: await availablePort(),
    memoryMb: 1024,
    javaPath: path.join(fixtures.at(-1), 'missing-java')
  });
  database.updateServer(server.id, { installed: 1 });
  await assert.rejects(manager.start(server.id, { acceptEula: true }), /Could not run/);
  assert.equal(database.getServer(server.id).status, 'stopped');
  assert.equal(database.getServer(server.id).eulaAccepted, false);
});

test('creates a stopped-server snapshot and restores it without following symlinks', async () => {
  const { root, manager, database } = await makeManager();
  const server = await manager.createServer({
    name: 'Backup test',
    minecraftVersion: '1.21.8',
    port: await availablePort(),
    memoryMb: 1024
  });
  const directory = manager.requireServer(server.id).directory;
  const outsideFile = path.join(root, 'outside.txt');
  await writeFile(outsideFile, 'outside');
  await symlink(outsideFile, path.join(directory, 'outside-link'));
  await writeFile(path.join(directory, 'world.txt'), 'before');
  database.updateServer(server.id, { installed: 1 });
  const backup = await manager.createBackup(server.id);
  await writeFile(path.join(directory, 'world.txt'), 'after');

  assert.equal(backup.archive, true);
  assert.equal(backup.sizeBytes > 0, true);
  const downloaded = await manager.getBackupDownload(backup.id);
  assert.equal(downloaded.sha256.length, 64);
  await assert.rejects(manager.restoreBackup(server.id, backup.id), /Explicit confirmation/);
  await manager.restoreBackup(server.id, backup.id, { confirmed: true });
  assert.equal(await readFile(path.join(directory, 'world.txt'), 'utf8'), 'before');
  await assert.rejects(readFile(path.join(directory, 'outside-link')), { code: 'ENOENT' });
  await writeFile(downloaded.path, 'damaged archive');
  await assert.rejects(manager.getBackupDownload(backup.id), /SHA-256 integrity verification/);
  await assert.rejects(manager.restoreBackup(server.id, backup.id, { confirmed: true }), /SHA-256 integrity verification/);
});

async function waitFor(predicate, timeout = 2500) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= end) throw new Error('Condition was not met before timeout.');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
