import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import dgram from "node:dgram";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { makeZip } from "./zip-fixture.js";

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "byte-server-panel-test-"));
process.env.MC_PANEL_DATA_DIR = path.join(tempRoot, "data");
process.env.MC_PANEL_SERVER_ROOT = path.join(tempRoot, "servers");
process.env.MC_PANEL_BACKUP_ROOT = path.join(tempRoot, "backups");

let manager;
let javaPath;
let security;
let minecraft;
let providers;

before(async () => {
  manager = await import("../src/manager.js");
  security = await import("../src/security.js");
  minecraft = await import("../src/minecraft.js");
  providers = await import("../src/providers.js");
  javaPath = path.join(tempRoot, "fake-java");
  await fs.writeFile(javaPath, `#!${process.execPath}
if (process.argv.includes("-version")) {
  process.stderr.write('openjdk version "21.0.1"\\n');
  process.exit(0);
}
process.stdout.write('[22:00:00] [Server thread/INFO]: Done (1.0s)!\\n');
if (process.env.BYTE_SERVER_PANEL_FAKE_CRASH === '1') {
  setTimeout(() => process.exit(7), 100);
} else {
  process.stdin.setEncoding('utf8');
  let input = '';
  process.stdin.on('data', (chunk) => {
    input += chunk;
    while (input.includes('\\n')) {
      const separator = input.indexOf('\\n');
      const line = input.slice(0, separator).trim();
      input = input.slice(separator + 1);
      if (line === 'stop') {
        process.stdout.write('Stopped cleanly\\n');
        process.exit(0);
      }
      if (line === 'list') {
        process.stdout.write('There are 1 of a max of 20 players online: TestPlayer\\n');
        continue;
      }
      if (line === 'tps') {
        process.stdout.write('TPS from last 1m, 5m, 15m: 20.0, 19.5, 18.0\\n');
        continue;
      }
      if (line === 'mspt') {
        process.stdout.write('Average tick time: 12.50ms\\n');
        continue;
      }
      if (line === 'save-off') {
        process.stdout.write('Automatic saving is now disabled\\n');
        continue;
      }
      if (line === 'save-all flush') {
        process.stdout.write('Saved the game\\n');
        continue;
      }
      if (line === 'save-on') {
        process.stdout.write('Automatic saving is now enabled\\n');
        continue;
      }
      process.stdout.write('COMMAND:' + line + '\\n');
    }
  });
}
`);
  await fs.chmod(javaPath, 0o700);
});

after(async () => {
  await manager.shutdownServers();
  await fs.rm(tempRoot, { recursive: true, force: true });
});

const allocatedPorts = new Set();

async function freePort() {
  while (true) {
    const listener = net.createServer();
    await new Promise((resolve, reject) => listener.listen(0, "127.0.0.1", resolve).once("error", reject));
    const port = listener.address().port;
    await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
    if (allocatedPorts.has(port)) continue;
    allocatedPorts.add(port);
    return port;
  }
}

async function freeUdpPort() {
  while (true) {
    const socket = dgram.createSocket("udp4");
    await new Promise((resolve, reject) => socket.bind(0, "127.0.0.1", resolve).once("error", reject));
    const port = socket.address().port;
    await new Promise((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
    if (allocatedPorts.has(port) || port > 65533) continue;
    allocatedPorts.add(port);
    return port;
  }
}

async function create(id, overrides = {}) {
  return manager.createServer({
    id,
    name: id,
    version: "1.21.1",
    software: "vanilla",
    port: await freePort(),
    bind_address: "127.0.0.1",
    max_players: 20,
    min_memory_mb: 512,
    max_memory_mb: 1024,
    java_path: javaPath,
    ...overrides,
  });
}

async function waitFor(id, predicate) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const server = manager.getServer(id);
    if (predicate(server)) return server;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`Timed out waiting for ${id}`);
}

test("validates server definitions and enforces unique identifiers", async () => {
  const server = await create("survival");
  assert.equal(server.status, "stopped");
  assert.equal(server.software, "vanilla");
  assert.match((await manager.readServerFiles("survival", "server.properties")).content, /server-port=\d+/);
  await assert.rejects(
    manager.createServer({ id: "survival", name: "Duplicate", version: "1.21.1", software: "vanilla", port: await freePort() }),
    /already in use/,
  );
  await assert.rejects(
    manager.createServer({ id: "bad/identifier", name: "Invalid", version: "1.21.1", software: "vanilla", port: await freePort() }),
    /identifier/,
  );
});

test("resolves authenticated and offline-derived UUIDs and validates stopped permission edits", async () => {
  const server = await create("permission-records");
  const { db } = await import("../src/database.js");
  db.prepare("UPDATE servers SET online_mode = 0 WHERE id = ?").run(server.id);
  const originalFetch = globalThis.fetch;
  const expectedOffline = crypto.createHash("md5").update("OfflinePlayer:TestPlayer").digest();
  expectedOffline[6] = (expectedOffline[6] & 0x0f) | 0x30;
  expectedOffline[8] = (expectedOffline[8] & 0x3f) | 0x80;
  const offlineUuid = `${expectedOffline.toString("hex").slice(0, 8)}-${expectedOffline.toString("hex").slice(8, 12)}-${expectedOffline.toString("hex").slice(12, 16)}-${expectedOffline.toString("hex").slice(16, 20)}-${expectedOffline.toString("hex").slice(20)}`;
  const offlineProfile = await manager.resolvePlayerProfile(server.id, "TestPlayer");
  assert.equal(offlineProfile.uuid, offlineUuid);
  assert.equal(offlineProfile.identity_type, "offline-derived");
  assert.match(offlineProfile.identity_warning, /do not prove player identity/);
  await assert.rejects(manager.resolvePlayerProfile(server.id, "bad name"), /Player name/);

  db.prepare("UPDATE servers SET online_mode = 1 WHERE id = ?").run(server.id);
  globalThis.fetch = async (request) => {
    assert.equal(String(request), "https://api.mojang.com/users/profiles/minecraft/TestPlayer");
    const response = Response.json({ id: "4566e69fc90748ee8d71d7ba5aa00d20", name: "TestPlayer" });
    Object.defineProperty(response, "url", { value: String(request) });
    return response;
  };
  try {
    const onlineProfile = await manager.resolvePlayerProfile(server.id, "TestPlayer");
    assert.equal(onlineProfile.uuid, "4566e69f-c907-48ee-8d71-d7ba5aa00d20");
    assert.equal(onlineProfile.identity_type, "mojang");
    assert.equal(onlineProfile.identity_warning, null);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const records = [{ uuid: offlineUuid, name: "TestPlayer" }];
  const saved = await manager.updatePlayerRecords(server.id, "whitelist.json", records);
  assert.deepEqual(saved.records, [{ uuid: offlineUuid, name: "TestPlayer" }]);
  assert.deepEqual((await manager.getPlayerRecords(server.id))["whitelist.json"], saved.records);
  await assert.rejects(manager.updatePlayerRecords(server.id, "ops.json", records), /permission level/);
  await assert.rejects(manager.updatePlayerRecords(server.id, "whitelist.json", [
    ...records, { uuid: offlineUuid, name: "OtherPlayer" },
  ]), /duplicate UUID/);
  await assert.rejects(manager.updatePlayerRecords(server.id, "../outside", []), /Unsupported permission file/);
});

test("restricts file access to server roots and rejects symlink escapes", async () => {
  await create("files");
  const serverRoot = (await import("../src/config.js")).serverRoot;
  const serverDirectory = path.join(serverRoot, "files");
  await manager.writeServerFile("files", "server.properties", "motd=Test world\n");
  assert.deepEqual(await manager.readServerFiles("files", "server.properties"), { content: "motd=Test world\n" });
  await assert.rejects(manager.readServerFiles("files", "../../etc/passwd"), /escapes/);

  const outside = path.join(tempRoot, "outside");
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "secret.txt"), "private");
  await fs.symlink(outside, path.join(serverDirectory, "escape"));
  await assert.rejects(manager.readServerFiles("files", "escape/secret.txt"), /Symbolic links/);
  await assert.rejects(manager.writeServerFile("files", "escape/new.txt", "bad"), /invalid directory/);
});

test("starts two independent child processes, sends console commands, and shuts down gracefully", async () => {
  const first = await create("first");
  const second = await create("second");
  for (const server of [first, second]) {
    const directory = path.join((await import("../src/config.js")).serverRoot, server.id);
    await fs.writeFile(path.join(directory, "server.jar"), "test jar");
    await fs.writeFile(path.join(directory, "server-panel.json"), JSON.stringify({ jar: "server.jar" }));
    await manager.acceptEula(server.id, true);
  }
  await manager.startServer(first.id);
  await manager.startServer(second.id);
  await waitFor(first.id, (server) => server.status === "running");
  await waitFor(second.id, (server) => server.status === "running");
  assert.deepEqual(await manager.queryOnlinePlayers(first.id), { count: 1, players: ["TestPlayer"] });
  assert.notEqual(manager.getServer(first.id).pid, manager.getServer(second.id).pid);
  const firstPid = manager.getServer(first.id).pid;
  await manager.restartServer(first.id);
  await waitFor(first.id, (server) => server.status === "running" && server.pid !== firstPid);
  await manager.playerAction(first.id, "kick", "TestPlayer", "Testing");
  await new Promise((resolve) => setTimeout(resolve, 30));
  await manager.sendCommand(first.id, "say hello");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.match(await manager.getLog(first.id), /COMMAND:say hello/);
  assert.match(await manager.getLog(first.id), /COMMAND:kick TestPlayer Testing/);
  assert.doesNotMatch(await manager.getLog(second.id), /say hello/);
  await manager.stopServer(first.id);
  await manager.stopServer(second.id);
  assert.equal(manager.getServer(first.id).status, "stopped");
  assert.equal(manager.getServer(second.id).status, "stopped");
});

test("marks an unexpectedly exiting child as crashed", async () => {
  const server = await create("crash");
  const directory = path.join((await import("../src/config.js")).serverRoot, server.id);
  await fs.writeFile(path.join(directory, "server.jar"), "test jar");
  await fs.writeFile(path.join(directory, "server-panel.json"), JSON.stringify({ jar: "server.jar" }));
  await manager.acceptEula(server.id, true);
  process.env.BYTE_SERVER_PANEL_FAKE_CRASH = "1";
  await manager.startServer(server.id);
  await waitFor(server.id, (current) => current.status === "crashed");
  delete process.env.BYTE_SERVER_PANEL_FAKE_CRASH;
  assert.equal(manager.getServer(server.id).last_exit_code, 7);
});

test("queries and validates real Paper TPS/MSPT console responses", async () => {
  const server = await create("telemetry-test");
  const directory = path.join((await import("../src/config.js")).serverRoot, server.id);
  const { db } = await import("../src/database.js");
  db.prepare("UPDATE servers SET loader = 'paper' WHERE id = ?").run(server.id);
  await fs.writeFile(path.join(directory, "server.jar"), "test jar");
  await fs.writeFile(path.join(directory, "server-panel.json"), JSON.stringify({ jar: "server.jar", java_major: 21 }));
  await manager.acceptEula(server.id, true);
  await manager.startServer(server.id);
  await waitFor(server.id, (current) => current.status === "running");
  assert.deepEqual(await manager.queryServerTelemetry(server.id), { tps: [20, 19.5, 18], mspt: 12.5 });
  assert.deepEqual(manager.getServer(server.id).tps, [20, 19.5, 18]);
  await manager.stopServer(server.id);
});

test("blocks server startup until an explicit EULA acceptance", async () => {
  const server = await create("eula-required");
  await assert.rejects(manager.startServer(server.id), /Accept the EULA/);
});

test("uses Minecraft's Java requirements for known versions", () => {
  assert.equal(minecraft.requiredJavaMajor("1.16.5"), 8);
  assert.equal(minecraft.requiredJavaMajor("1.17.1"), 16);
  assert.equal(minecraft.requiredJavaMajor("1.20.4"), 17);
  assert.equal(minecraft.requiredJavaMajor("1.20.5"), 21);
  assert.equal(minecraft.requiredJavaMajor("1.21.1"), 21);
});

test("installs and runs native Bedrock Dedicated Server without Java", async (context) => {
  if (process.platform !== "linux" || process.arch !== "x64") {
    context.skip("Official Bedrock Dedicated Server is supported only on Linux x86_64");
    return;
  }
  const originalFetch = globalThis.fetch;
  const version = "1.21.80.3";
  const binary = `#!${process.execPath}
process.stdout.write("Server started.\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (input) => {
  if (input.trim() === "stop") {
    process.stdout.write("Stopped cleanly\\n");
    process.exit(0);
  }
});
`;
  let archive = makeZip({
    bedrock_server: binary,
    "server.properties": "server-name=Bedrock Dedicated Server\nserver-port=19132\nserver-portv6=19133\n",
    "permissions.json": "[]\n",
  });
  globalThis.fetch = async (request) => {
    const url = new URL(String(request));
    if (url.href === "https://www.minecraft.net/en-us/download/server/bedrock") {
      return new Response(`<a href="https://www.minecraft.net/bedrockdedicatedserver/bin-linux/bedrock-server-${version}.zip">Download</a>`);
    }
    if (url.href === `https://www.minecraft.net/bedrockdedicatedserver/bin-linux/bedrock-server-${version}.zip`) {
      return new Response(archive, { headers: { "content-length": String(archive.length) } });
    }
    assert.fail(`Unexpected Bedrock download request: ${url.href}`);
  };
  try {
    const server = await manager.createServer({
      id: "bedrock-native",
      name: "Bedrock Native",
      version,
      software: "bedrock",
      loader: "bedrock",
      port: await freeUdpPort(),
      bind_address: "127.0.0.1",
      java_path: "",
      min_memory_mb: 512,
      max_memory_mb: 1024,
    });
    assert.equal(server.loader, "bedrock");
    assert.equal(server.software, "vanilla");
    await assert.rejects(manager.createServer({
      id: "bedrock-v6-port-conflict",
      name: "Bedrock IPv6 Port Conflict",
      version,
      software: "bedrock",
      loader: "bedrock",
      port: server.port + 1,
      bind_address: "127.0.0.1",
      min_memory_mb: 512,
      max_memory_mb: 1024,
    }), /already assigned/);
    await manager.install(server.id);
    const directory = path.join((await import("../src/config.js")).serverRoot, server.id);
    const executablePath = path.join(directory, "bedrock_server");
    assert.ok((await fs.stat(executablePath)).mode & 0o100);
    const properties = await fs.readFile(path.join(directory, "server.properties"), "utf8");
    assert.match(properties, new RegExp(`server-port=${server.port}\\n`));
    assert.match(properties, new RegExp(`server-portv6=${server.port + 1}\\n`));
    assert.equal(JSON.parse(await fs.readFile(path.join(directory, "server-panel.json"), "utf8")).executable, "bedrock_server");
    await fs.writeFile(path.join(directory, "server.properties"), `${properties}motd=custom\n`);
    await fs.writeFile(path.join(directory, "permissions.json"), '[{"xuid":"trusted-player"}]\n');
    archive = makeZip({
      bedrock_server: binary.replace("Server started.", "Server started. Build v2"),
      "server.properties": "server-name=Updated upstream defaults\nserver-port=19132\nserver-portv6=19133\n",
      "permissions.json": "[]\n",
    });
    await manager.install(server.id);
    assert.match(await fs.readFile(executablePath, "utf8"), /Build v2/);
    assert.match(await fs.readFile(path.join(directory, "server.properties"), "utf8"), /motd=custom/);
    assert.equal(await fs.readFile(path.join(directory, "permissions.json"), "utf8"), '[{"xuid":"trusted-player"}]\n');
    await manager.acceptEula(server.id, true);
    await manager.startServer(server.id);
    await waitFor(server.id, (current) => current.status === "running");
    await manager.sendCommand(server.id, "say hello");
    await manager.stopServer(server.id);
    assert.equal(manager.getServer(server.id).status, "stopped");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects a server port occupied by another process", async () => {
  const listener = net.createServer();
  await new Promise((resolve, reject) => listener.listen(0, "127.0.0.1", resolve).once("error", reject));
  const occupiedPort = listener.address().port;
  const server = await create("occupied", { port: occupiedPort });
  const directory = path.join((await import("../src/config.js")).serverRoot, server.id);
  await fs.writeFile(path.join(directory, "server.jar"), "test jar");
  await fs.writeFile(path.join(directory, "server-panel.json"), JSON.stringify({ jar: "server.jar" }));
  await manager.acceptEula(server.id, true);
  try {
    await assert.rejects(manager.startServer(server.id), /already in use/);
  } finally {
    await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  }
});

test("creates and restores a stopped-server backup", async () => {
  const server = await create("backup");
  await manager.writeServerFile(server.id, "world-marker.txt", "before backup");
  const backupTask = manager.createBackup(server.id);
  await assert.rejects(manager.startServer(server.id), /backing up is in progress/);
  const backup = await backupTask;
  assert.equal(manager.listBackups(server.id).length, 1);
  await manager.writeServerFile(server.id, "world-marker.txt", "after backup");
  await manager.restoreBackup(server.id, backup.id);
  assert.deepEqual(await manager.readServerFiles(server.id, "world-marker.txt"), { content: "before backup" });
});

test("creates, exports, restores, and safely imports a world-specific archive", async () => {
  const server = await create("world-archive");
  const directory = path.join((await import("../src/config.js")).serverRoot, server.id);
  const worldDirectory = path.join(directory, "world");
  await fs.mkdir(path.join(worldDirectory, "region"), { recursive: true });
  await fs.writeFile(path.join(worldDirectory, "level.dat"), "original-world");
  const backup = await manager.createWorldBackup(server.id, "world");
  const listed = await manager.listWorldBackups(server.id);
  assert.equal(listed.length, 1);
  assert.equal((await manager.getWorldBackupDownload(server.id, backup.id)).filename, backup.filename);
  await fs.writeFile(path.join(worldDirectory, "level.dat"), "changed-world");
  await manager.restoreWorldBackup(server.id, backup.id);
  assert.equal(await fs.readFile(path.join(worldDirectory, "level.dat"), "utf8"), "original-world");

  const importSource = path.join(tempRoot, "import-world");
  await fs.mkdir(path.join(importSource, "new_world", "region"), { recursive: true });
  await fs.writeFile(path.join(importSource, "new_world", "level.dat"), "imported-world");
  const archive = path.join(tempRoot, "new_world.tar.gz");
  await new Promise((resolve, reject) => {
    const child = spawn("tar", ["-czf", archive, "-C", importSource, "--", "new_world"], { stdio: "ignore", shell: false });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`tar exited with ${code}`)));
  });
  const archivePath = ".panel-import-test.tar.gz";
  await manager.uploadServerFile(server.id, archivePath, Readable.from([await fs.readFile(archive)]));
  const imported = await manager.importWorldArchive(server.id, archivePath, "new_world");
  assert.equal(imported.world_name, "new_world");
  assert.equal(await fs.readFile(path.join(directory, "new_world", "level.dat"), "utf8"), "imported-world");
  await assert.rejects(fs.stat(path.join(directory, archivePath)), { code: "ENOENT" });
  assert.equal((await manager.listWorldBackups(server.id)).length, 2);

  const unsafeSource = path.join(tempRoot, "unsafe-world");
  await fs.mkdir(path.join(unsafeSource, "unsafe_world"), { recursive: true });
  await fs.symlink("/etc/passwd", path.join(unsafeSource, "unsafe_world", "link"));
  const unsafeArchive = path.join(tempRoot, "unsafe_world.tar.gz");
  await new Promise((resolve, reject) => {
    const child = spawn("tar", ["-czf", unsafeArchive, "-C", unsafeSource, "--", "unsafe_world"], { stdio: "ignore", shell: false });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`tar exited with ${code}`)));
  });
  const unsafePath = ".panel-import-unsafe.tar.gz";
  await manager.uploadServerFile(server.id, unsafePath, Readable.from([await fs.readFile(unsafeArchive)]));
  await assert.rejects(manager.importWorldArchive(server.id, unsafePath, "unsafe_world"), /symbolic link or special file/);
});

test("creates a live snapshot only after save-off/save-all and re-enables saving", async () => {
  const server = await create("live-world-snapshot");
  const directory = path.join((await import("../src/config.js")).serverRoot, server.id);
  await fs.writeFile(path.join(directory, "server.jar"), "test jar");
  await fs.writeFile(path.join(directory, "server-panel.json"), JSON.stringify({ jar: "server.jar", java_major: 21 }));
  await manager.acceptEula(server.id, true);
  const world = path.join(directory, "world");
  await fs.mkdir(world);
  await fs.writeFile(path.join(world, "level.dat"), "saved-world");
  await manager.startServer(server.id);
  await waitFor(server.id, (current) => current.status === "running");
  const snapshot = await manager.createLiveWorldSnapshot(server.id, "world");
  assert.equal(snapshot.consistent_snapshot, true);
  const log = await manager.getLog(server.id);
  assert.match(log, /Automatic saving is now disabled/);
  assert.match(log, /Saved the game/);
  assert.match(log, /Automatic saving is now enabled/);
  await manager.stopServer(server.id);
  await fs.writeFile(path.join(world, "level.dat"), "later-world");
  await manager.restoreWorldBackup(server.id, snapshot.id);
  assert.equal(await fs.readFile(path.join(world, "level.dat"), "utf8"), "saved-world");
});

test("refuses to restore archives containing symbolic links", async () => {
  const server = await create("symlink-backup");
  const directory = path.join((await import("../src/config.js")).serverRoot, server.id);
  await fs.symlink("/etc/passwd", path.join(directory, "unsafe-link"));
  const backup = await manager.createBackup(server.id);
  await fs.rm(path.join(directory, "unsafe-link"));
  await assert.rejects(manager.restoreBackup(server.id, backup.id), /symbolic link or special file/);
  await manager.writeServerFile(server.id, "still-here.txt", "original");
  assert.deepEqual(await manager.readServerFiles(server.id, "still-here.txt"), { content: "original" });
});

test("server.properties updates validated panel port/player settings", async () => {
  const first = await create("config-one");
  const second = await create("config-two");
  const configuredPort = await freePort();
  const content = `server-ip=127.0.0.1\nserver-port=${configuredPort}\nmax-players=42\nonline-mode=false\nview-distance=8\nsimulation-distance=6\n`;
  await manager.writeServerFile(first.id, "server.properties", content);
  assert.equal(manager.getServer(first.id).port, configuredPort);
  assert.equal(manager.getServer(first.id).max_players, 42);
  assert.equal(manager.getServer(first.id).online_mode, 0);
  assert.equal(manager.getServer(first.id).view_distance, 8);
  assert.equal(manager.getServer(first.id).simulation_distance, 6);
  await assert.rejects(manager.writeServerFile(first.id, "server.properties", "view-distance=64\n"), /invalid port.*distance/);
  await assert.rejects(
    manager.writeServerFile(first.id, "server.properties", `server-port=${second.port}\n`),
    /already assigned/,
  );
  assert.equal((await manager.readServerFiles(first.id, "server.properties")).content, content);
});

test("downloads Vanilla only when its official checksum matches", async () => {
  const originalFetch = globalThis.fetch;
  const bytes = Buffer.from("test vanilla jar");
  const checksum = crypto.createHash("sha1").update(bytes).digest("hex");
  const snapshotBytes = Buffer.from("snapshot server jar");
  const snapshotChecksum = crypto.createHash("sha1").update(snapshotBytes).digest("hex");
  const metadata = {
    javaVersion: { majorVersion: 21 },
    downloads: { server: { url: "https://piston-data.mojang.com/server.jar", sha1: checksum } },
  };
  const jsonResponse = (body, url) => {
    const response = new Response(JSON.stringify(body));
    Object.defineProperty(response, "url", { value: url });
    return response;
  };
  globalThis.fetch = async (request) => {
    const url = String(request);
    if (url.includes("version_manifest_v2.json")) {
      return jsonResponse({
        versions: [
          { id: "1.21.1", type: "release", url: "https://piston-meta.mojang.com/version.json", time: "2024-01-01" },
          { id: "26w14a", type: "snapshot", url: "https://piston-meta.mojang.com/snapshot.json" },
        ],
      }, "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json");
    }
    if (url.endsWith("version.json")) return jsonResponse(metadata, url);
    if (url.endsWith("snapshot.json")) {
      return jsonResponse({
        javaVersion: { majorVersion: 25 },
        downloads: { server: { url: "https://piston-data.mojang.com/snapshot.jar", sha1: snapshotChecksum } },
      }, url);
    }
    if (url.endsWith("server.jar")) {
      const response = new Response(bytes);
      Object.defineProperty(response, "url", { value: url });
      return response;
    }
    if (url.endsWith("snapshot.jar")) {
      const response = new Response(snapshotBytes);
      Object.defineProperty(response, "url", { value: url });
      return response;
    }
    throw new Error(`Unexpected test URL: ${url}`);
  };
  const directory = path.join((await import("../src/config.js")).serverRoot, "download-test");
  await fs.mkdir(directory);
  try {
    const installed = await minecraft.installServer({ software: "vanilla", version: "1.21.1" }, directory);
    assert.deepEqual(installed, { filename: "server.jar", javaMajor: 21 });
    assert.deepEqual(await fs.readFile(path.join(directory, "server.jar")), bytes);
    const snapshot = await create("snapshot-server", { version: "26w14a" });
    assert.equal(snapshot.version, "26w14a");
    assert.deepEqual(
      await minecraft.installServer({ software: "vanilla", version: "26w14a" }, directory),
      { filename: "server.jar", javaMajor: 25 },
    );
    assert.deepEqual(await fs.readFile(path.join(directory, "server.jar")), snapshotBytes);
    metadata.downloads.server.sha1 = "0".repeat(40);
    await assert.rejects(
      minecraft.installServer({ software: "vanilla", version: "1.21.1" }, directory),
      /SHA-1 verification/,
    );
    await assert.rejects(fs.stat(path.join(directory, "server.jar.part")), { code: "ENOENT" });
    metadata.downloads.server.sha1 = checksum;
    metadata.downloads.server.url = "http://127.0.0.1/internal-resource";
    await assert.rejects(
      minecraft.installServer({ software: "vanilla", version: "1.21.1" }, directory),
      /untrusted host/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("uses Paper's current stable-build API and SHA-256 metadata", async () => {
  const originalFetch = globalThis.fetch;
  const bytes = Buffer.from("test paper jar");
  const checksum = crypto.createHash("sha256").update(bytes).digest("hex");
  const paperBuilds = [{
    id: 132,
    channel: "STABLE",
    downloads: {
      "server:default": {
        name: "paper-1.21.1-132.jar",
        url: "https://fill-data.papermc.io/paper.jar",
        checksums: { sha256: checksum },
      },
    },
  }];
  const jsonResponse = (body, url) => {
    const response = new Response(JSON.stringify(body));
    Object.defineProperty(response, "url", { value: url });
    return response;
  };
  globalThis.fetch = async (request, options = {}) => {
    const url = String(request);
    if (url.includes("fill.papermc.io/v3/projects/paper")) {
      assert.match(new Headers(options.headers).get("user-agent"), /^Byte Server Panel\//);
      if (url.endsWith("/builds")) return jsonResponse(paperBuilds, url);
      return jsonResponse({ project: { id: "paper" }, versions: { "1.21": ["1.21.1"] } }, url);
    }
    if (url.endsWith("version.json")) {
      return jsonResponse({ javaVersion: { majorVersion: 21 } }, url);
    }
    if (url.endsWith("paper.jar")) {
      const response = new Response(bytes);
      Object.defineProperty(response, "url", { value: url });
      return response;
    }
    throw new Error(`Unexpected test URL: ${url}`);
  };
  const directory = path.join((await import("../src/config.js")).serverRoot, "paper-download-test");
  await fs.mkdir(directory);
  try {
    assert.deepEqual(await minecraft.listPaperVersions(), ["1.21.1"]);
    assert.equal((await create("paper-compatible", { software: "paper" })).software, "paper");
    await assert.rejects(
      create("paper-incompatible", { software: "paper", version: "1.20.5" }),
      /does not support Minecraft 1.20.5/,
    );
    const result = await minecraft.installServer({ software: "paper", version: "1.21.1" }, directory);
    assert.deepEqual(result, { filename: "paper-1.21.1-132.jar", javaMajor: 21 });
    assert.deepEqual(await fs.readFile(path.join(directory, result.filename)), bytes);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("installs Geyser and Floodgate from verified official artifacts for cross-play", async () => {
  const originalFetch = globalThis.fetch;
  const paperBytes = Buffer.from("test cross-play Paper jar");
  const paperChecksum = crypto.createHash("sha256").update(paperBytes).digest("hex");
  const artifacts = Object.fromEntries(["geyser", "floodgate"].map((project) => {
    const bytes = Buffer.from(`official ${project} plugin`);
    return [project, { bytes, checksum: crypto.createHash("sha256").update(bytes).digest("hex") }];
  }));
  const response = (body, url) => {
    const result = body instanceof Buffer ? new Response(body) : Response.json(body);
    Object.defineProperty(result, "url", { value: url });
    return result;
  };
  globalThis.fetch = async (request) => {
    const url = String(request);
    if (url === "https://fill.papermc.io/v3/projects/paper/versions") {
      return response({ project: { id: "paper" }, versions: { "1.21": ["1.21.1"] } }, url);
    }
    if (url === "https://fill.papermc.io/v3/projects/paper/versions/1.21.1/builds") {
      return response([{
        id: 132, channel: "STABLE",
        downloads: { "server:default": {
          name: "paper-1.21.1-132.jar", url: "https://fill-data.papermc.io/paper.jar",
          checksums: { sha256: paperChecksum },
        } },
      }], url);
    }
    if (url.endsWith("version.json")) return response({ javaVersion: { majorVersion: 21 } }, url);
    if (url.endsWith("paper.jar")) return response(paperBytes, url);
    const metadataMatch = /download\.geysermc\.org\/v2\/projects\/(geyser|floodgate)\/versions\/latest\/builds\/latest$/.exec(url);
    if (metadataMatch) {
      const project = metadataMatch[1];
      return response({
        project_id: project, version: "2.7.0", build: 42,
        downloads: { spigot: {
          name: `${project}-spigot.jar`, sha256: artifacts[project].checksum,
        } },
      }, url);
    }
    const artifactMatch = /download\.geysermc\.org\/v2\/projects\/(geyser|floodgate)\/versions\/2\.7\.0\/builds\/42\/downloads\/spigot$/.exec(url);
    if (artifactMatch) return response(artifacts[artifactMatch[1]].bytes, url);
    throw new Error(`Unexpected cross-play installation request: ${url}`);
  };
  try {
    const bedrockPort = await freeUdpPort();
    const server = await create("paper-crossplay", {
      software: "paper", crossplay: true, bedrock_port: bedrockPort,
    });
    await manager.install(server.id);
    const directory = path.join((await import("../src/config.js")).serverRoot, server.id);
    const installed = JSON.parse(await fs.readFile(path.join(directory, "server-panel.json"), "utf8"));
    assert.equal(installed.crossplay, true);
    assert.equal(installed.bedrock_port, bedrockPort);
    assert.deepEqual(await fs.readFile(path.join(directory, "plugins", "geyser-spigot.jar")), artifacts.geyser.bytes);
    assert.deepEqual(await fs.readFile(path.join(directory, "plugins", "floodgate-spigot.jar")), artifacts.floodgate.bytes);
    const config = await fs.readFile(path.join(directory, "plugins", "Geyser-Spigot", "config.yml"), "utf8");
    assert.match(config, new RegExp(`port: ${bedrockPort}`));
    assert.match(config, new RegExp(`port: ${server.port}`));
    assert.match(config, /auth-type: floodgate/);
    const updatedGeyser = Buffer.from("updated official geyser plugin");
    artifacts.geyser.bytes = updatedGeyser;
    artifacts.geyser.checksum = crypto.createHash("sha256").update(updatedGeyser).digest("hex");
    await fs.writeFile(path.join(directory, "plugins", "Geyser-Spigot", "config.yml"), `${config}# user setting preserved\n`);
    await manager.install(server.id);
    assert.deepEqual(await fs.readFile(path.join(directory, "plugins", "geyser-spigot.jar")), updatedGeyser);
    assert.match(await fs.readFile(path.join(directory, "plugins", "Geyser-Spigot", "config.yml"), "utf8"),
      /# user setting preserved/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("creates and installs Fabric from stable metadata and a SHA-512 verified installer", async () => {
  const originalFetch = globalThis.fetch;
  const installerBytes = Buffer.from("trusted fabric installer");
  const installerChecksum = crypto.createHash("sha512").update(installerBytes).digest("hex");
  let publishedChecksum = installerChecksum;
  const installerUrl = "https://maven.fabricmc.net/net/fabricmc/fabric-installer/1.1.2/fabric-installer-1.1.2.jar";
  const jsonResponse = (body, url) => {
    const response = new Response(JSON.stringify(body));
    Object.defineProperty(response, "url", { value: url });
    return response;
  };
  globalThis.fetch = async (request) => {
    const url = String(request);
    if (url.endsWith("/v2/versions/game")) {
      return jsonResponse([{ version: "1.21.1", stable: true }, { version: "1.22-snapshot", stable: false }], url);
    }
    if (url.endsWith("/v2/versions/loader/1.21.1")) {
      return jsonResponse([{ loader: { version: "0.16.9", stable: true } }], url);
    }
    if (url.endsWith("/v2/versions/installer")) {
      return jsonResponse([{ version: "1.1.2", stable: true, url: installerUrl }], url);
    }
    if (url.endsWith(".jar.sha512")) {
      const response = new Response(`${publishedChecksum}\n`);
      Object.defineProperty(response, "url", { value: url });
      return response;
    }
    if (url === installerUrl) {
      const response = new Response(installerBytes);
      Object.defineProperty(response, "url", { value: url });
      return response;
    }
    if (url.endsWith("version_manifest_v2.json")) {
      return jsonResponse({
        versions: [{ id: "1.21.1", type: "release", url: "https://piston-meta.mojang.com/version.json" }],
      }, url);
    }
    if (url.endsWith("/version.json")) {
      return jsonResponse({ javaVersion: { majorVersion: 21 } }, url);
    }
    throw new Error(`Unexpected test URL: ${url}`);
  };
  const javaInstaller = path.join(tempRoot, "fabric-test-java");
  await fs.writeFile(javaInstaller, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv;
const dir = args[args.indexOf('-dir') + 1];
if (args[args.indexOf('-mcversion') + 1] !== '1.21.1' ||
    args[args.indexOf('-loader') + 1] !== '0.16.9' || !args.includes('-downloadMinecraft')) process.exit(3);
fs.writeFileSync(path.join(dir, 'fabric-server-launch.jar'), Buffer.from([0x50, 0x4b, 0x03, 0x04]));
fs.writeFileSync(path.join(dir, 'server.jar'), Buffer.from([0x50, 0x4b, 0x03, 0x04]));
fs.mkdirSync(path.join(dir, 'libraries', 'fabric-loader'), { recursive: true });
fs.writeFileSync(path.join(dir, 'libraries', 'fabric-loader', 'metadata'), 'verified installer output');
`);
  await fs.chmod(javaInstaller, 0o700);
  try {
    assert.deepEqual(await minecraft.listFabricMinecraftVersions(), ["1.21.1"]);
    assert.equal((await create("fabric-install-test", { software: "fabric", java_path: javaInstaller })).loader, "fabric");
    const server = manager.getServer("fabric-install-test");
    assert.equal(server.software, "vanilla");
    await manager.install(server.id);
    const directory = path.join((await import("../src/config.js")).serverRoot, server.id);
    const installed = JSON.parse(await fs.readFile(path.join(directory, "server-panel.json"), "utf8"));
    assert.equal(installed.jar, "fabric-server-launch.jar");
    assert.equal(installed.loader, "fabric");
    assert.equal(installed.loader_version, "0.16.9");
    assert.equal(installed.installer_version, "1.1.2");
    assert.equal((await fs.readFile(path.join(directory, "libraries", "fabric-loader", "metadata"), "utf8")),
      "verified installer output");
    assert.deepEqual((await fs.readdir(directory)).filter((entry) => entry.startsWith(".panel-fabric-install-")), []);
    const failedServer = await create("fabric-checksum-failure", { software: "fabric", java_path: javaInstaller });
    publishedChecksum = "0".repeat(128);
    await assert.rejects(manager.install(failedServer.id), /SHA-512 verification/);
    const failedDirectory = path.join((await import("../src/config.js")).serverRoot, failedServer.id);
    await assert.rejects(fs.access(path.join(failedDirectory, "server-panel.json")), { code: "ENOENT" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("creates and installs Quilt with a checksum-verified official installer", async () => {
  const originalFetch = globalThis.fetch;
  const installerBytes = Buffer.from("trusted Quilt installer");
  const checksum = crypto.createHash("sha512").update(installerBytes).digest("hex");
  const installerUrl = "https://maven.quiltmc.org/repository/release/org/quiltmc/quilt-installer/0.15.1/quilt-installer-0.15.1.jar";
  const jsonResponse = (body, url) => {
    const response = new Response(JSON.stringify(body));
    Object.defineProperty(response, "url", { value: url });
    return response;
  };
  globalThis.fetch = async (request) => {
    const url = String(request);
    if (url.endsWith("/v3/versions/game")) {
      return jsonResponse([{ version: "1.21.1", stable: true }], url);
    }
    if (url.endsWith("/v3/versions/loader/1.21.1")) {
      return jsonResponse([{
        loader: {
          version: "0.20.0-beta.9",
          hashes: { sha512: "a".repeat(128) },
        },
      }], url);
    }
    if (url.endsWith("/v3/versions/installer")) {
      return jsonResponse([{
        version: "0.15.1",
        url: installerUrl,
        hashes: { sha512: checksum },
      }], url);
    }
    if (url === installerUrl) {
      const response = new Response(installerBytes);
      Object.defineProperty(response, "url", { value: url });
      return response;
    }
    throw new Error(`Unexpected test URL: ${url}`);
  };
  const javaInstaller = path.join(tempRoot, "quilt-test-java");
  await fs.writeFile(javaInstaller, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv;
if (args[args.indexOf('server') + 1] !== '1.21.1' || !args.includes('--download-server')) process.exit(3);
const dir = path.join(process.cwd(), 'server');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'quilt-server-launch.jar'), Buffer.from([0x50, 0x4b, 0x03, 0x04]));
fs.writeFileSync(path.join(dir, 'server.jar'), Buffer.from([0x50, 0x4b, 0x03, 0x04]));
fs.mkdirSync(path.join(dir, 'libraries', 'quilt-loader'), { recursive: true });
fs.writeFileSync(path.join(dir, 'libraries', 'quilt-loader', 'metadata'), 'quilt output');
`);
  await fs.chmod(javaInstaller, 0o700);
  try {
    assert.equal((await minecraft.listQuiltMinecraftVersions()).includes("1.21.1"), true);
    assert.deepEqual(await minecraft.listQuiltLoaderVersions("1.21.1"), ["0.20.0-beta.9"]);
    const server = await create("quilt-install-test", { software: "quilt", java_path: javaInstaller });
    assert.equal(server.software, "vanilla");
    assert.equal(server.loader, "quilt");
    await manager.install(server.id);
    const directory = path.join((await import("../src/config.js")).serverRoot, server.id);
    const marker = JSON.parse(await fs.readFile(path.join(directory, "server-panel.json"), "utf8"));
    assert.equal(marker.jar, "quilt-server-launch.jar");
    assert.equal(marker.loader, "quilt");
    assert.equal(marker.installer_version, "0.15.1");
    assert.equal(marker.loader_version, "0.20.0-beta.9");
    assert.equal(await fs.readFile(path.join(directory, "libraries", "quilt-loader", "metadata"), "utf8"), "quilt output");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("installs Forge and NeoForge through verified installers and safe Java argument files", async () => {
  const originalFetch = globalThis.fetch;
  const installerBytes = Buffer.from("trusted forge installer");
  const forgeChecksum = crypto.createHash("sha1").update(installerBytes).digest("hex");
  const neoChecksum = crypto.createHash("sha512").update(installerBytes).digest("hex");
  const forgeInstallerUrl = "https://maven.minecraftforge.net/net/minecraftforge/forge/1.21.1-52.0.1/forge-1.21.1-52.0.1-installer.jar";
  const neoInstallerUrl = "https://maven.neoforged.net/releases/net/neoforged/neoforge/21.1.172/neoforge-21.1.172-installer.jar";
  const jsonResponse = (body, url) => {
    const response = new Response(JSON.stringify(body));
    Object.defineProperty(response, "url", { value: url });
    return response;
  };
  globalThis.fetch = async (request) => {
    const url = String(request);
    if (url.endsWith("promotions_slim.json")) {
      return jsonResponse({ promos: { "1.21.1-recommended": "52.0.1" } }, url);
    }
    if (url.endsWith("installer.jar.sha1")) {
      const response = new Response(`${forgeChecksum}  forge-installer.jar\n`);
      Object.defineProperty(response, "url", { value: url });
      return response;
    }
    if (url.endsWith("neoforge")) {
      return jsonResponse({ versions: ["20.2.88", "21.1.172-beta", "21.1.172", "21.1.171"] }, url);
    }
    if (url.endsWith("neoforge-21.1.172-installer.jar.sha512")) {
      const response = new Response(neoChecksum);
      Object.defineProperty(response, "url", { value: url });
      return response;
    }
    if (url === forgeInstallerUrl || url === neoInstallerUrl) {
      const response = new Response(installerBytes);
      Object.defineProperty(response, "url", { value: url });
      return response;
    }
    throw new Error(`Unexpected test URL: ${url}`);
  };
  const javaInstaller = path.join(tempRoot, "forge-installer-java");
  await fs.writeFile(javaInstaller, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
if (process.argv.includes('-version')) {
  process.stderr.write('openjdk version "21.0.1"\\n');
  process.exit(0);
}
if (process.argv.includes('--installServer')) {
  const forge = !process.cwd().includes('neoforge');
  const group = forge ? 'minecraftforge' : 'neoforged';
  const artifact = forge ? 'forge' : 'neoforge';
  const version = forge ? '1.21.1-52.0.1' : '21.1.172';
  const root = path.join(process.cwd(), 'libraries', 'net', group, artifact, version);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'unix_args.txt'), '-cp\\nfixture.jar\\n');
  fs.writeFileSync(path.join(process.cwd(), 'user_jvm_args.txt'), '-Dfixture=true\\n');
  fs.writeFileSync(path.join(process.cwd(), 'run.sh'), '# generated script; panel does not execute it\\n');
  process.exit(0);
}
process.stdout.write('[22:00:00] [Server thread/INFO]: Done (1.0s)!\\n');
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { if (chunk.trim() === 'stop') process.exit(0); });
`);
  await fs.chmod(javaInstaller, 0o700);
  const managed = [];
  try {
    assert.deepEqual(await minecraft.listForgeMinecraftVersions(), ["1.21.1"]);
    assert.deepEqual(await minecraft.listNeoForgeVersions("1.21.1"), ["21.1.172", "21.1.171"]);
    for (const [id, loader] of [["forge-install-test", "forge"], ["neoforge-install-test", "neoforge"]]) {
      const server = await create(id, { software: loader, java_path: javaInstaller });
      assert.equal(server.software, "vanilla");
      assert.equal(server.loader, loader);
      await manager.install(id);
      const directory = path.join((await import("../src/config.js")).serverRoot, id);
      const marker = JSON.parse(await fs.readFile(path.join(directory, "server-panel.json"), "utf8"));
      assert.equal(marker.loader, loader);
      assert.equal(marker.java_args[0], "@user_jvm_args.txt");
      assert.match(marker.java_args[1], /^@libraries\/net\//);
      assert.equal(await fs.readFile(path.join(directory, "user_jvm_args.txt"), "utf8"), "-Dfixture=true\n");
      assert.equal(await fs.readFile(path.join(directory, "run.sh"), "utf8"),
        "# generated script; panel does not execute it\n");
      await manager.acceptEula(id, true);
      await manager.startServer(id);
      managed.push(id);
      await waitFor(id, (current) => current.status === "running");
      assert.equal((await manager.getServer(id)).status, "running");
    }
  } finally {
    for (const id of managed) await manager.stopServer(id);
    globalThis.fetch = originalFetch;
  }
});

test("installs a Purpur build only when official compatibility metadata and checksum match", async () => {
  const originalFetch = globalThis.fetch;
  const bytes = Buffer.from("trusted purpur server jar");
  const md5 = crypto.createHash("md5").update(bytes).digest("hex");
  const jsonResponse = (body, url) => {
    const response = Response.json(body);
    Object.defineProperty(response, "url", { value: url });
    return response;
  };
  globalThis.fetch = async (request) => {
    const url = String(request);
    if (url === "https://api.purpurmc.org/v2/purpur") {
      return jsonResponse({ project: "purpur", versions: ["1.21.1"] }, url);
    }
    if (url.endsWith("/1.21.1/latest")) {
      return jsonResponse({ project: "purpur", version: "1.21.1", build: "2329", md5 }, url);
    }
    if (url.includes("version_manifest_v2.json")) {
      return jsonResponse({
        versions: [{ id: "1.21.1", type: "release", url: "https://piston-meta.mojang.com/version.json", time: "2024-01-01" }],
      }, url);
    }
    if (url.endsWith("version.json")) {
      return jsonResponse({ javaVersion: { majorVersion: 21 } }, url);
    }
    if (url.endsWith("/2329/download")) {
      const response = new Response(bytes);
      Object.defineProperty(response, "url", { value: url });
      return response;
    }
    throw new Error(`Unexpected test URL: ${url}`);
  };
  const directory = path.join(tempRoot, "purpur-download-test");
  await fs.mkdir(directory);
  try {
    const server = await create("purpur-install-test", { software: "purpur" });
    assert.equal(server.software, "paper");
    assert.equal(server.loader, "purpur");
    const installed = await minecraft.installServer(server, directory);
    assert.equal(installed.filename, "purpur-1.21.1-2329.jar");
    assert.deepEqual(await fs.readFile(path.join(directory, installed.filename)), bytes);
    await assert.rejects(create("purpur-unsupported", { software: "purpur", version: "1.20.5" }), /does not support/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("stores only a password hash and validates authenticated sessions", async () => {
  await security.setPassword("a-test-password-long-enough");
  assert.equal(await security.authenticate("a-test-password-long-enough"), true);
  assert.equal(await security.authenticate("wrong-password"), false);
  const session = security.createSession();
  assert.equal(security.getSession(session.id).csrf, session.csrf);
  security.removeSession(session.id);
  assert.equal(security.getSession(session.id), undefined);
});

test("supports safe server file create, move, upload, download, and recoverable delete operations", async () => {
  const server = await create("file-operations");
  await manager.createServerFile(server.id, "nested", "directory");
  await manager.createServerFile(server.id, "nested/settings.txt");
  await manager.writeServerFile(server.id, "nested/settings.txt", "safe");
  await manager.moveServerFile(server.id, "nested/settings.txt", "nested/renamed.txt");
  const download = await manager.downloadServerFile(server.id, "nested/renamed.txt");
  assert.equal(download.filename, "renamed.txt");
  assert.equal(await fs.readFile(download.path, "utf8"), "safe");
  await manager.uploadServerFile(server.id, "nested/upload.txt", Readable.from([Buffer.from("uploaded")]));
  assert.equal((await manager.readServerFiles(server.id, "nested/upload.txt")).content, "uploaded");
  const deletion = await manager.deleteServerFile(server.id, "nested/renamed.txt");
  assert.match(deletion.trashed_as, /^\.panel-trash\//);
  await assert.rejects(manager.readServerFiles(server.id, "nested/renamed.txt"), { code: "ENOENT" });
  await assert.rejects(manager.downloadServerFile(server.id, "../../outside"), /escapes/);
});

test("installs compatible Modrinth dependencies atomically with checksum verification", async () => {
  const originalFetch = globalThis.fetch;
  const server = await create("modrinth-test");
  const { db } = await import("../src/database.js");
  db.prepare("UPDATE servers SET loader = 'fabric' WHERE id = ?").run(server.id);
  const configured = manager.getServer(server.id);
  const payloads = new Map([
    ["main.jar", Buffer.from("main mod")],
    ["main-v2.jar", Buffer.from("updated main mod")],
    ["dependency.jar", Buffer.from("dependency mod")],
  ]);
  const hashes = Object.fromEntries([...payloads].map(([filename, bytes]) =>
    [filename, crypto.createHash("sha512").update(bytes).digest("hex")]));
  const jsonResponse = (body, url) => {
    const response = Response.json(body);
    Object.defineProperty(response, "url", { value: url });
    return response;
  };
  globalThis.fetch = async (request) => {
    const url = new URL(String(request));
    if (url.hostname === "cdn.modrinth.com") {
      const filename = path.basename(url.pathname);
      return new Response(payloads.get(filename));
    }
    if (url.hostname !== "api.modrinth.com") throw new Error(`Unexpected test URL: ${url}`);
    if (url.pathname === "/v2/project/main") {
      return jsonResponse({ id: "main", slug: "main", title: "Main", project_type: "mod" }, url.href);
    }
    if (url.pathname === "/v2/project/dependency") {
      return jsonResponse({ id: "dependency", slug: "dependency", title: "Dependency", project_type: "mod" }, url.href);
    }
    if (url.pathname === "/v2/project/conflicting-project") {
      return jsonResponse({ id: "conflicting-project", slug: "conflicting-project", title: "Conflicting Project", project_type: "mod" }, url.href);
    }
    if (url.pathname === "/v2/project/main/version") {
      return jsonResponse([
        {
          id: "main-v2", name: "Main 2", version_number: "2.0", dependencies: [
            { project_id: "dependency", dependency_type: "required" },
          ],
          files: [{ filename: "main-v2.jar", primary: true, url: "https://cdn.modrinth.com/main-v2.jar", hashes: { sha512: hashes["main-v2.jar"] } }],
        },
        {
          id: "main-v1", name: "Main 1", version_number: "1.0", dependencies: [
            { project_id: "dependency", dependency_type: "required" },
          ],
          files: [{ filename: "main.jar", primary: true, url: "https://cdn.modrinth.com/main.jar", hashes: { sha512: hashes["main.jar"] } }],
        },
      ], url.href);
    }
    if (url.pathname === "/v2/project/dependency/version") {
      return jsonResponse([{
        id: "dependency-v1", name: "Dependency 1", version_number: "1.0", dependencies: [],
        files: [{ filename: "dependency.jar", primary: true, url: "https://cdn.modrinth.com/dependency.jar", hashes: { sha512: hashes["dependency.jar"] } }],
      }], url.href);
    }
    if (url.pathname === "/v2/project/conflicting-project/version") {
      return jsonResponse([{
        id: "conflict-v1", name: "Conflict 1", version_number: "1.0",
        dependencies: [{ project_id: "installed-conflict", dependency_type: "incompatible" }],
        files: [{ filename: "conflict.jar", primary: true, url: "https://cdn.modrinth.com/conflict.jar", hashes: { sha512: hashes["main.jar"] } }],
      }], url.href);
    }
    throw new Error(`Unexpected test URL: ${url}`);
  };
  try {
    const result = await providers.installModrinthProject(configured, path.join((await import("../src/config.js")).serverRoot, server.id), "main", "main-v1");
    assert.equal(result.filename, "main.jar");
    assert.equal(result.dependencies.length, 1);
    db.prepare(`INSERT INTO project_installs
      (server_id, project_type, project_id, version_id, filename, project_title)
      VALUES(?, 'mod', 'installed-conflict', 'conflict-v1', 'installed-conflict.jar', 'Installed Conflict')`).run(server.id);
    await assert.rejects(providers.installModrinthProject(configured,
      path.join((await import("../src/config.js")).serverRoot, server.id), "conflicting-project"), /conflicts with Installed Conflict/);
    db.prepare("DELETE FROM project_installs WHERE server_id = ? AND project_id = 'installed-conflict'").run(server.id);
    const installed = await providers.listInstalledProjects(configured, path.join((await import("../src/config.js")).serverRoot, server.id));
    assert.deepEqual(installed.map((item) => item.filename).sort(), ["dependency.jar", "main.jar"]);
    await assert.rejects(providers.installModrinthProject(configured, path.join((await import("../src/config.js")).serverRoot, server.id), "main"), /already installed/);
    const updated = await providers.updateModrinthProject(configured, path.join((await import("../src/config.js")).serverRoot, server.id), "main");
    assert.equal(updated.version.id, "main-v2");
    let updatedList = await providers.listInstalledProjects(configured, path.join((await import("../src/config.js")).serverRoot, server.id));
    assert.equal(updatedList.find((item) => item.project_id === "main").rollback_available, 1);
    const rolledBack = await providers.rollbackModrinthProject(configured, path.join((await import("../src/config.js")).serverRoot, server.id), "main");
    assert.equal(rolledBack.version_id, "main-v1");
    updatedList = await providers.listInstalledProjects(configured, path.join((await import("../src/config.js")).serverRoot, server.id));
    assert.equal(updatedList.find((item) => item.project_id === "main").version_id, "main-v1");
    await providers.updateModrinthProject(configured, path.join((await import("../src/config.js")).serverRoot, server.id), "main");
    const projectDirectory = path.join((await import("../src/config.js")).serverRoot, server.id, "mods");
    await providers.removeInstalledProject(configured, path.join((await import("../src/config.js")).serverRoot, server.id), "main-v2.jar");
    await assert.rejects(fs.stat(path.join(projectDirectory, "main-v2.jar")), { code: "ENOENT" });
    await assert.rejects(fs.stat(path.join(projectDirectory, ".panel-history")), { code: "ENOENT" });
    assert.equal((await providers.listInstalledProjects(configured, path.join((await import("../src/config.js")).serverRoot, server.id)))
      .some((item) => item.project_id === "main"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("persists installation job failures and permits explicit retry", async () => {
  const originalFetch = globalThis.fetch;
  const server = await create("install-job-test");
  globalThis.fetch = async () => { throw new Error("mocked metadata outage"); };
  try {
    const queued = manager.queueInstall(server.id);
    assert.equal(queued.status, "queued");
    const failed = await waitForJob(queued.id, (job) => job.status === "failed");
    assert.match(failed.error, /mocked metadata outage/);
    const retried = manager.retryJob(failed.id);
    assert.equal(retried.status, "queued");
    await waitForJob(retried.id, (job) => job.status === "failed");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("cancels an active server download, removes its partial file, and records the job outcome", async () => {
  const originalFetch = globalThis.fetch;
  const server = await create("cancel-install");
  const directory = path.join((await import("../src/config.js")).serverRoot, server.id);
  let downloadStarted = false;
  globalThis.fetch = async (request, options = {}) => {
    const url = String(request);
    const jsonResponse = (body) => {
      const response = Response.json(body);
      Object.defineProperty(response, "url", { value: url });
      return response;
    };
    if (url.endsWith("version.json")) {
      return jsonResponse({
        javaVersion: { majorVersion: 21 },
        downloads: { server: { url: "https://piston-data.mojang.com/server.jar", sha1: "1".repeat(40) } },
      });
    }
    if (url.endsWith("server.jar")) {
      downloadStarted = true;
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(Buffer.from("partial jar data"));
          options.signal.addEventListener("abort", () => controller.error(options.signal.reason), { once: true });
        },
      });
      const response = new Response(body, { headers: { "content-length": "100" } });
      Object.defineProperty(response, "url", { value: url });
      return response;
    }
    throw new Error(`Unexpected test URL: ${url}`);
  };
  try {
    const job = manager.queueInstall(server.id);
    const deadline = Date.now() + 3000;
    while (!downloadStarted && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(downloadStarted, true, "installation should begin its server jar request");
    manager.cancelJob(job.id);
    const cancelled = await waitForJob(job.id, (current) => current.status === "cancelled");
    assert.equal(cancelled.message, "Installation cancelled");
    await assert.rejects(fs.stat(path.join(directory, "server.jar.part")), { code: "ENOENT" });
    assert.equal(manager.getServer(server.id).operation, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("reattaches console and logs after an unclean panel exit", async () => {
  const server = await create("recovery-test");
  const directory = path.join((await import("../src/config.js")).serverRoot, server.id);
  await fs.writeFile(path.join(directory, "server.jar"), "test jar");
  await fs.writeFile(path.join(directory, "server-panel.json"), JSON.stringify({ jar: "server.jar" }));
  await manager.acceptEula(server.id, true);
  const managerUrl = new URL("../src/manager.js", import.meta.url).href;
  const script = `const manager = await import(${JSON.stringify(managerUrl)}); await manager.startServer(${JSON.stringify(server.id)}); await new Promise(resolve => setTimeout(resolve, 250)); process.exit(0);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.equal(code, 0, stderr);
  manager.refreshRecoveredProcesses();
  await manager.reattachRecoveredProcesses();
  const recovered = manager.getServer(server.id);
  assert.equal(recovered.status, "running");
  assert.ok(recovered.pid);
  const output = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error("Recovered console did not stream command output"));
    }, 3000);
    const unsubscribe = manager.subscribe(server.id, (text) => {
      if (!text.includes("COMMAND:recovered-command")) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(text);
    });
  });
  await manager.sendCommand(server.id, "recovered-command");
  assert.match(await output, /COMMAND:recovered-command/);
  await manager.stopServer(server.id);
  assert.equal(manager.getServer(server.id).status, "stopped");
});

test("scheduled backups apply retention limits without running on an active server", async () => {
  const server = await create("scheduled-backup");
  await manager.writeServerFile(server.id, "retention-test.txt", "scheduled");
  manager.setBackupSchedule(server.id, 24, 1, true);
  const { db } = await import("../src/database.js");
  db.prepare("UPDATE backup_schedules SET next_run_at = ? WHERE server_id = ?")
    .run(new Date(Date.now() - 1000).toISOString(), server.id);
  await manager.runScheduledBackups();
  assert.equal(manager.listBackups(server.id).length, 1);
  const backup = manager.listBackups(server.id)[0];
  const backupDirectory = path.join((await import("../src/config.js")).backupRoot, server.id);
  assert.equal((await fs.readdir(backupDirectory)).includes(backup.filename), true);
});

async function waitForJob(id, predicate) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const job = manager.getJob(id);
    if (predicate(job)) return job;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`Timed out waiting for job ${id}`);
}
