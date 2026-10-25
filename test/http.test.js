import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { Database } from '../src/database.js';
import { AuthService } from '../src/auth.js';
import { createHttpServer } from '../src/http.js';
import { ServerManager } from '../src/manager.js';

const fixtures = [];

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

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(async ({ server, manager, database, directory }) => {
    await manager.shutdown();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    database.close();
    await rm(directory, { recursive: true, force: true });
  }));
});

test('serves the dashboard and protects local API mutations from foreign origins', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'byte-panel-http-'));
  const port = await availablePort();
  const database = new Database(path.join(directory, 'panel.sqlite'));
  const manager = new ServerManager(database, {
    serverDir: path.join(directory, 'servers'),
    backupDir: path.join(directory, 'backups'),
    availableMemoryMb: 8192,
    javaCandidates: [],
    fetch: async (url) => {
      if (String(url).endsWith('version_manifest_v2.json')) {
        return Response.json({ versions: [{
          id: '1.21.8',
          type: 'release',
          releaseTime: '2025-01-01T00:00:00Z',
          url: 'https://piston-meta.mojang.com/version.json'
        }] });
      }
      if (String(url) === 'https://piston-meta.mojang.com/version.json') {
        return Response.json({ javaVersion: { majorVersion: 21 } });
      }
      if (String(url) === 'https://api.papermc.io/v2/projects/paper') {
        return Response.json({ project_id: 'paper', versions: ['1.21.8'] });
      }
      if (String(url).startsWith('https://api.modrinth.com/v2/search?')) {
        return Response.json({ total_hits: 0, hits: [] });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }
  });
  await manager.initialize();
  const auth = new AuthService(database);
  const setupToken = await auth.initialize();
  const server = createHttpServer(manager, { host: '127.0.0.1', port }, auth);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.once('listening', resolve);
  });
  fixtures.push({ server, manager, database, directory });

  const baseUrl = `http://127.0.0.1:${port}`;
  const setupResponse = await fetch(`${baseUrl}/api/auth/setup`, {
    method: 'POST',
    headers: { Origin: baseUrl, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: setupToken, password: 'test-admin-password-123' })
  });
  assert.equal(setupResponse.status, 200);
  const sessionCookie = setupResponse.headers.get('set-cookie').split(';')[0];
  const localFetch = (url, options = {}) => fetch(url, {
    ...options,
    headers: { ...options.headers, Cookie: sessionCookie }
  });
  assert.equal((await localFetch(`${baseUrl}/api/auth/status`)).status, 200);
  const providers = await localFetch(`${baseUrl}/api/providers`).then((response) => response.json());
  assert.deepEqual(providers.map((provider) => provider.id), ['fabric', 'forge', 'neoforge', 'quilt', 'paper', 'purpur']);
  assert.deepEqual(await localFetch(`${baseUrl}/api/providers/paper/catalog?minecraftVersion=1.21.8`).then((response) => response.json()), {
    providerId: 'paper', versions: ['1.21.8']
  });
  const invalidSearch = await localFetch(`${baseUrl}/api/modrinth/search?type=unknown`);
  assert.equal(invalidSearch.status, 400);
  const search = await localFetch(`${baseUrl}/api/modrinth/search?type=mod&gameVersion=1.21.8`);
  assert.deepEqual(await search.json(), { total: 0, hits: [] });

  const page = await fetch(baseUrl);
  assert.equal(page.status, 200);
  const pageMarkup = await page.text();
  assert.match(pageMarkup, /Byte Server Panel/);
  for (const section of ['overview', 'files', 'mods', 'plugins', 'worlds', 'players', 'console', 'logs']) {
    assert.match(pageMarkup, new RegExp(`data-server-section="${section}"`));
  }
  assert.match(pageMarkup, /id="page-server"/);
  assert.match(pageMarkup, /id="server-management-template"/);
  assert.match(pageMarkup, /id="console-output"/);
  assert.match(pageMarkup, /id="modrinth-compatibility"/);
  assert.match(pageMarkup, /id="manage-players"/);
  assert.match(pageMarkup, /<select name="minecraftVersion" id="create-version"/);
  assert.equal(pageMarkup.includes('id="minecraft-versions"'), false);
  assert.equal(pageMarkup.includes('id="admin-dialog"'), false);
  assert.equal(page.headers.get('content-security-policy')?.includes("frame-ancestors 'none'"), true);
  const appSource = await fetch(`${baseUrl}/app.js`).then((response) => response.text());
  assert.match(appSource, /class="delete-server-button"/);
  assert.match(appSource, /const MODDED_SOFTWARE = new Set\(\['fabric', 'forge', 'neoforge', 'quilt'\]\)/);
  assert.match(appSource, /const PLUGIN_SOFTWARE = new Set\(\['paper', 'purpur'\]\)/);
  assert.match(appSource, /updateManagedContentCompatibility/);
  assert.equal(appSource.includes('>⋯</button>'), false);

  assert.equal((await fetch(`${baseUrl}/api/servers`)).status, 401);
  assert.deepEqual(await (await localFetch(`${baseUrl}/api/java`)).json(), []);
  assert.deepEqual(await (await localFetch(`${baseUrl}/api/versions/1.21.8`)).json(), {
    id: '1.21.8',
    type: 'release',
    releaseTime: '2025-01-01T00:00:00Z',
    requiredJavaMajor: 21
  });

  const blocked = await localFetch(`${baseUrl}/api/servers`, {
    method: 'POST',
    headers: { Origin: 'https://attacker.example', 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Unexpected', minecraftVersion: '1.21.8' })
  });
  assert.equal(blocked.status, 403);

  const portForServer = await availablePort();
  const created = await localFetch(`${baseUrl}/api/servers`, {
    method: 'POST',
    headers: { Origin: baseUrl, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'HTTP test', minecraftVersion: '1.21.8', port: portForServer, memoryMb: 512 })
  });
  assert.equal(created.status, 201);
  const serverData = await created.json();
  assert.equal(serverData.name, 'HTTP test');
  assert.equal('directory' in serverData, false);
  assert.equal('processPid' in serverData, false);

  database.updateServer(serverData.id, { installed: 1 });
  await manager.ensureRconConfiguration(database.getServer(serverData.id));
  const createdFile = await localFetch(`${baseUrl}/api/servers/${serverData.id}/files`, {
    method: 'POST',
    headers: { Origin: baseUrl, 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: 'notes.txt', content: 'before edit' })
  });
  assert.equal(createdFile.status, 201);
  const files = await localFetch(`${baseUrl}/api/servers/${serverData.id}/files`).then((response) => response.json());
  assert.equal(files.some((file) => file.name === 'notes.txt'), true);
  const fileContent = await localFetch(`${baseUrl}/api/servers/${serverData.id}/file?path=notes.txt`).then((response) => response.json());
  assert.equal(fileContent.content, 'before edit');
  const savedFile = await localFetch(`${baseUrl}/api/servers/${serverData.id}/file`, {
    method: 'PUT',
    headers: { Origin: baseUrl, 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: 'notes.txt', content: 'after edit' })
  });
  assert.equal(savedFile.status, 200);
  const properties = await localFetch(`${baseUrl}/api/servers/${serverData.id}/file?path=server.properties`).then((response) => response.json());
  assert.match(properties.content, /rcon\.password=\[managed\]/);
  assert.equal((await localFetch(`${baseUrl}/api/servers/${serverData.id}/file?path=.panel-rcon-secret`)).status, 404);
  const traversal = await localFetch(`${baseUrl}/api/servers/${serverData.id}/file?path=${encodeURIComponent('../outside')}`);
  assert.equal(traversal.status, 400);
  const fileDelete = await localFetch(`${baseUrl}/api/servers/${serverData.id}/file?path=notes.txt`, {
    method: 'DELETE',
    headers: { Origin: baseUrl }
  });
  assert.equal(fileDelete.status, 200);

  const commands = [];
  database.updateServer(serverData.id, { status: 'running' });
  manager.runtime.set(serverData.id, {
    child: { exitCode: null, stdin: { write: (command) => commands.push(command) } },
    startedAt: Date.now()
  });
  const admin = await localFetch(`${baseUrl}/api/servers/${serverData.id}/admin`, {
    method: 'POST',
    headers: { Origin: baseUrl, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'op', args: { player: 'TestPlayer' } })
  });
  assert.equal(admin.status, 202);
  assert.deepEqual(commands, ['op TestPlayer\n']);
  manager.runtime.delete(serverData.id);
  database.updateServer(serverData.id, { status: 'stopped' });

  const schedule = await localFetch(`${baseUrl}/api/servers/${serverData.id}/schedules`, {
    method: 'POST',
    headers: { Origin: baseUrl, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'backup', intervalMinutes: 10 })
  });
  assert.equal(schedule.status, 201);
  const scheduleData = await schedule.json();
  const schedules = await localFetch(`${baseUrl}/api/servers/${serverData.id}/schedules`).then((response) => response.json());
  assert.equal(schedules.length, 1);
  assert.equal((await localFetch(`${baseUrl}/api/schedules/${scheduleData.id}`, {
    method: 'DELETE', headers: { Origin: baseUrl }
  })).status, 200);
  await manager.sampleMetrics();
  const metrics = await localFetch(`${baseUrl}/api/servers/${serverData.id}/metrics?limit=5`).then((response) => response.json());
  assert.equal(metrics.length >= 1, true);
  const diagnostics = await localFetch(`${baseUrl}/api/diagnostics`);
  const diagnosticData = await diagnostics.json();
  assert.equal(diagnostics.headers.get('content-disposition').includes('diagnostics.json'), true);
  assert.equal('javaPath' in diagnosticData.servers[0], false);

  const installWithoutReview = await localFetch(`${baseUrl}/api/servers/${serverData.id}/install`, {
    method: 'POST',
    headers: { Origin: baseUrl, 'Content-Type': 'application/json' },
    body: '{}'
  });
  assert.equal(installWithoutReview.status, 403);

  const deleteWithoutReview = await localFetch(`${baseUrl}/api/servers/${serverData.id}/delete`, {
    method: 'POST',
    headers: { Origin: baseUrl, 'Content-Type': 'application/json' },
    body: '{}'
  });
  assert.equal(deleteWithoutReview.status, 403);

  const backupResponse = await localFetch(`${baseUrl}/api/servers/${serverData.id}/backups`, {
    method: 'POST',
    headers: { Origin: baseUrl }
  });
  assert.equal(backupResponse.status, 202);
  const backupTask = await backupResponse.json();
  await waitFor(async () => (await localFetch(`${baseUrl}/api/tasks/${backupTask.id}`)).json().then((task) => task.status === 'completed'));
  const backup = (await (await localFetch(`${baseUrl}/api/backups`)).json())[0];
  assert.equal('directory' in backup, false);
  assert.equal(backup.archive, true);
  const backupDownload = await localFetch(`${baseUrl}/api/backups/${backup.id}/download`);
  assert.equal(backupDownload.status, 200);
  assert.equal(backupDownload.headers.get('content-type'), 'application/gzip');
  assert.equal((await backupDownload.arrayBuffer()).byteLength > 0, true);
  const restored = await localFetch(`${baseUrl}/api/servers/${serverData.id}/restore/${backup.id}`, {
    method: 'POST',
    headers: { Origin: baseUrl, 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirmed: true })
  });
  assert.equal(restored.status, 202);
  const restoreTask = await restored.json();
  await waitFor(async () => (await localFetch(`${baseUrl}/api/tasks/${restoreTask.id}`)).json().then((task) => task.status === 'completed'));

  const secondBackupResponse = await localFetch(`${baseUrl}/api/servers/${serverData.id}/backups`, {
    method: 'POST',
    headers: { Origin: baseUrl }
  });
  const secondBackupTask = await secondBackupResponse.json();
  await waitFor(async () => (await localFetch(`${baseUrl}/api/tasks/${secondBackupTask.id}`)).json().then((task) => task.status === 'completed'));
  const secondBackup = (await (await localFetch(`${baseUrl}/api/backups`)).json()).find((entry) => entry.id !== backup.id);
  assert.ok(secondBackup);
  assert.equal((await localFetch(`${baseUrl}/api/backups/${secondBackup.id}`, {
    method: 'DELETE',
    headers: { Origin: baseUrl }
  })).status, 200);

  const deleted = await localFetch(`${baseUrl}/api/servers/${serverData.id}/delete`, {
    method: 'POST',
    headers: { Origin: baseUrl, 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirmed: true })
  });
  assert.equal(deleted.status, 200);
  assert.deepEqual(await (await localFetch(`${baseUrl}/api/servers`)).json(), []);
  assert.equal(database.listBackups()[0].server_id, null);
});

async function waitFor(predicate, timeout = 5000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Task did not complete before timeout.');
}
