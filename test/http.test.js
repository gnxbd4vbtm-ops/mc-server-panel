import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "byte-server-panel-http-test-"));
const probe = net.createServer();
await new Promise((resolve, reject) => probe.listen(0, "127.0.0.1", resolve).once("error", reject));
const panelPort = probe.address().port;
await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));

process.env.MC_PANEL_DATA_DIR = path.join(tempRoot, "data");
process.env.MC_PANEL_SERVER_ROOT = path.join(tempRoot, "servers");
process.env.MC_PANEL_BACKUP_ROOT = path.join(tempRoot, "backups");
process.env.MC_PANEL_HOST = "127.0.0.1";
process.env.MC_PANEL_PORT = String(panelPort);

const fakeJava = path.join(tempRoot, "fake-java");
await fs.writeFile(fakeJava, `#!${process.execPath}
if (process.argv.includes("-version")) {
  process.stderr.write('openjdk version "21.0.1"\\n');
  process.exit(0);
}
process.stdout.write('[22:00:00] [Server thread/INFO]: Done (1.0s)!\\n');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  input += chunk;
  while (input.includes('\\n')) {
    const index = input.indexOf('\\n');
    const line = input.slice(0, index).trim();
    input = input.slice(index + 1);
    if (line === 'list') process.stdout.write('There are 0 of a max of 10 players online.\\n');
    else if (line === 'stop') process.exit(0);
    else process.stdout.write('COMMAND:' + line + '\\n');
  }
});
`);
await fs.chmod(fakeJava, 0o700);

const { listen, server } = await import("../src/http.js");
const manager = await import("../src/manager.js");
const config = await import("../src/config.js");
const origin = `http://127.0.0.1:${panelPort}`;

before(async () => listen());

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(tempRoot, { recursive: true, force: true });
});

async function json(url, { body, cookie, csrf, method = "GET", requestOrigin = origin } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  if (csrf) headers["x-csrf-token"] = csrf;
  if (requestOrigin) headers.origin = requestOrigin;
  return fetch(`${origin}${url}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("protects panel APIs with setup, session, same-origin, and CSRF controls", async () => {
  const setup = await json("/api/setup");
  assert.deepEqual(await setup.json(), { configured: false });
  assert.equal(setup.headers.get("x-frame-options"), "DENY");

  const initialized = await json("/api/setup", {
    method: "POST",
    body: { password: "http-test-password-long" },
  });
  assert.equal(initialized.status, 200);
  const setupBody = await initialized.json();
  assert.ok(setupBody.csrf);
  const cookie = initialized.headers.get("set-cookie").split(";")[0];
  assert.match(initialized.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);

  assert.equal((await json("/api/servers")).status, 401);
  assert.equal((await json("/api/servers", {
    method: "POST",
    body: {},
    cookie,
    csrf: setupBody.csrf,
    requestOrigin: "https://attacker.example",
  })).status, 403);

  const noCsrf = await json("/api/servers", {
    method: "POST",
    body: {},
    cookie,
  });
  assert.equal(noCsrf.status, 403);

  const freePort = await new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const port = listener.address().port;
      listener.close((error) => error ? reject(error) : resolve(port));
    });
  });
  const created = await json("/api/servers", {
    method: "POST",
    cookie,
    csrf: setupBody.csrf,
    body: {
      id: "http-test-server",
      name: "HTTP test server",
      version: "1.21.1",
      software: "vanilla",
      port: freePort,
      bind_address: "127.0.0.1",
      max_players: 10,
      min_memory_mb: 512,
      max_memory_mb: 1024,
      java_path: fakeJava,
    },
  });
  assert.equal(created.status, 201);
  const serverRecord = await created.json();
  assert.equal(serverRecord.eula_accepted, false);

  const autoRestart = await json(`/api/servers/${serverRecord.id}/auto-restart`, {
    method: "PUT", body: { enabled: true }, cookie, csrf: setupBody.csrf,
  });
  assert.equal((await autoRestart.json()).auto_restart, true);

  const schedule = await json(`/api/servers/${serverRecord.id}/backup-schedule`, {
    method: "PUT", body: { interval_hours: 12, retention_count: 4, enabled: false }, cookie, csrf: setupBody.csrf,
  });
  assert.equal((await schedule.json()).retention_count, 4);

  const createdFile = await json(`/api/servers/${serverRecord.id}/files`, {
    method: "POST", body: { operation: "create", path: "notes.txt", type: "file" }, cookie, csrf: setupBody.csrf,
  });
  assert.equal(createdFile.status, 201);
  const download = await fetch(`${origin}/api/servers/${serverRecord.id}/download?path=server.properties`, {
    headers: { cookie, origin },
  });
  assert.equal(download.status, 200);
  assert.match(await download.text(), /server-port=/);
  const deletedFile = await json(`/api/servers/${serverRecord.id}/files`, {
    method: "POST", body: { operation: "delete", path: "notes.txt" }, cookie, csrf: setupBody.csrf,
  });
  assert.equal((await deletedFile.json()).trashed_as.startsWith(".panel-trash/"), true);

  const changedPassword = await json("/api/password", {
    method: "POST",
    body: { current_password: "wrong-password", new_password: "http-test-password-newlong" },
    cookie,
    csrf: setupBody.csrf,
  });
  assert.equal(changedPassword.status, 401);
  const validPasswordChange = await json("/api/password", {
    method: "POST",
    body: { current_password: "http-test-password-long", new_password: "http-test-password-newlong" },
    cookie,
    csrf: setupBody.csrf,
  });
  assert.equal(validPasswordChange.status, 200);

  const noEula = await json(`/api/servers/${serverRecord.id}/start`, {
    method: "POST",
    body: {},
    cookie,
    csrf: setupBody.csrf,
  });
  assert.equal(noEula.status, 400);
  assert.match((await noEula.json()).error, /Accept the EULA/);

  const eula = await json(`/api/servers/${serverRecord.id}/eula`, {
    method: "POST", body: { accepted: true }, cookie, csrf: setupBody.csrf,
  });
  assert.equal(eula.status, 200);
  const serverDirectory = path.join(config.serverRoot, serverRecord.id);
  await fs.writeFile(path.join(serverDirectory, "server.jar"), "test jar");
  await fs.writeFile(path.join(serverDirectory, "server-panel.json"), JSON.stringify({ jar: "server.jar", java_major: 21 }));
  const started = await json(`/api/servers/${serverRecord.id}/start`, {
    method: "POST", body: {}, cookie, csrf: setupBody.csrf,
  });
  assert.equal(started.status, 200);
  const deadline = Date.now() + 3000;
  let live = manager.getServer(serverRecord.id);
  while (live.status !== "running" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    live = manager.getServer(serverRecord.id);
  }
  assert.equal(live.status, "running");
  const players = await json(`/api/servers/${serverRecord.id}/players`, { cookie });
  assert.deepEqual(await players.json(), { count: 0, players: [] });
  const playerAction = await json(`/api/servers/${serverRecord.id}/players`, {
    method: "POST", body: { action: "op", player: "TestPlayer" }, cookie, csrf: setupBody.csrf,
  });
  assert.equal(playerAction.status, 200);
  const commandDeadline = Date.now() + 1000;
  while (!((await manager.getLog(serverRecord.id)).includes("COMMAND:op TestPlayer")) && Date.now() < commandDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.match(await manager.getLog(serverRecord.id), /COMMAND:op TestPlayer/);
  const stopped = await json(`/api/servers/${serverRecord.id}/stop`, {
    method: "POST", body: {}, cookie, csrf: setupBody.csrf,
  });
  assert.equal(stopped.status, 200);

  const { db } = await import("../src/database.js");
  db.prepare("UPDATE servers SET online_mode = 0 WHERE id = ?").run(serverRecord.id);
  const resolvedProfile = await json(`/api/servers/${serverRecord.id}/player-profile?name=TestPlayer`, { cookie });
  assert.equal((await resolvedProfile.json()).identity_type, "offline-derived");
  const permissions = await json(`/api/servers/${serverRecord.id}/permissions`, {
    method: "PUT", body: {
      filename: "whitelist.json",
      records: [{ uuid: "c0cfa492-cc95-3ec5-8b56-8f9b8184fc6d", name: "TestPlayer" }],
    },
    cookie,
    csrf: setupBody.csrf,
  });
  assert.equal(permissions.status, 200);
  assert.equal((await permissions.json()).records.length, 1);
  const invalidPermissions = await json(`/api/servers/${serverRecord.id}/permissions`, {
    method: "PUT", body: { filename: "../outside", records: [] }, cookie, csrf: setupBody.csrf,
  });
  assert.equal(invalidPermissions.status, 400);

  const worldDirectory = path.join(serverDirectory, "world");
  await fs.mkdir(worldDirectory);
  await fs.writeFile(path.join(worldDirectory, "level.dat"), "world-before");
  const worldBackupResponse = await json(`/api/servers/${serverRecord.id}/worlds`, {
    method: "POST", body: { operation: "backup", world_name: "world" }, cookie, csrf: setupBody.csrf,
  });
  assert.equal(worldBackupResponse.status, 201);
  const worldBackup = await worldBackupResponse.json();
  const worldDownload = await fetch(`${origin}/api/servers/${serverRecord.id}/world-backup-download?backup_id=${worldBackup.id}`, {
    headers: { cookie, origin },
  });
  assert.equal(worldDownload.status, 200);
  assert.match(worldDownload.headers.get("content-type"), /application\/gzip/);
  await fs.writeFile(path.join(worldDirectory, "level.dat"), "world-after");
  const worldRestore = await json(`/api/servers/${serverRecord.id}/world-backups`, {
    method: "POST", body: { operation: "restore", backup_id: worldBackup.id }, cookie, csrf: setupBody.csrf,
  });
  assert.equal(worldRestore.status, 200);
  assert.equal(await fs.readFile(path.join(worldDirectory, "level.dat"), "utf8"), "world-before");

  db.prepare("UPDATE servers SET loader = 'purpur' WHERE id = ?").run(serverRecord.id);
  const pluginsDirectory = path.join(serverDirectory, "plugins");
  await fs.mkdir(pluginsDirectory, { recursive: true });
  await fs.writeFile(path.join(pluginsDirectory, "existing.jar"), "old plugin");
  db.prepare(`INSERT INTO project_installs
    (server_id, project_type, project_id, version_id, filename, project_title)
    VALUES(?, 'plugin', 'http-plugin', 'plugin-v1', 'existing.jar', 'HTTP Plugin')`).run(serverRecord.id);
  const originalFetch = globalThis.fetch;
  const updatedPlugin = Buffer.from("updated plugin");
  const pluginHash = crypto.createHash("sha512").update(updatedPlugin).digest("hex");
  globalThis.fetch = async (request, options) => {
    const url = new URL(String(request));
    if (url.origin === origin) return originalFetch(request, options);
    if (url.hostname === "cdn.modrinth.com") return new Response(updatedPlugin);
    if (url.hostname !== "api.modrinth.com") throw new Error(`Unexpected test URL: ${url}`);
    const response = url.pathname === "/v2/project/http-plugin"
      ? Response.json({ id: "http-plugin", slug: "http-plugin", title: "HTTP Plugin", project_type: "plugin" })
      : url.pathname === "/v2/project/http-plugin/version"
        ? Response.json([{
          id: "plugin-v2", name: "Plugin 2", version_number: "2.0", dependencies: [],
          files: [{ filename: "updated.jar", primary: true, url: "https://cdn.modrinth.com/updated.jar", hashes: { sha512: pluginHash } }],
        }])
        : null;
    if (!response) throw new Error(`Unexpected test URL: ${url}`);
    Object.defineProperty(response, "url", { value: url.href });
    return response;
  };
  try {
    const update = await json(`/api/servers/${serverRecord.id}/projects`, {
      method: "POST", body: { operation: "update", type: "plugin", project_id: "http-plugin" },
      cookie, csrf: setupBody.csrf,
    });
    assert.equal(update.status, 200);
    assert.equal((await update.json()).version.id, "plugin-v2");
    const rollback = await json(`/api/servers/${serverRecord.id}/projects`, {
      method: "POST", body: { operation: "rollback", type: "plugin", project_id: "http-plugin" },
      cookie, csrf: setupBody.csrf,
    });
    assert.equal(rollback.status, 200);
    assert.equal((await rollback.json()).version_id, "plugin-v1");
    await assert.rejects(fs.stat(path.join(pluginsDirectory, "updated.jar")), { code: "ENOENT" });
    assert.equal(await fs.readFile(path.join(pluginsDirectory, "existing.jar"), "utf8"), "old plugin");
    const removePlugin = await json(`/api/servers/${serverRecord.id}/projects`, {
      method: "POST", body: { operation: "remove", type: "plugin", filename: "existing.jar" },
      cookie, csrf: setupBody.csrf,
    });
    assert.equal(removePlugin.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const removed = await json(`/api/servers/${serverRecord.id}`, {
    cookie,
    csrf: setupBody.csrf,
    method: "DELETE",
  });
  assert.equal(removed.status, 200);
});
