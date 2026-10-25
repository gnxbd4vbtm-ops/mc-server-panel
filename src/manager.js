import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import { access, chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { config } from './config.js';
import { createArchive, extractArchive } from './archive.js';
import {
  createAdminExecutor, createFile as createManagedFile, deleteFile as deleteManagedFile,
  listFiles as listManagedFiles, readFile as readManagedFile, writeFile as writeManagedFile
} from './server-admin.js';
import {
  downloadVerified, getModrinthVersion,
  getProviderCatalog, listModrinthVersions, listProviders, resolveProviderInstall,
  searchModrinth
} from './ecosystem.js';
import { rconCommand } from './rcon.js';
import { parseModrinthPack } from './modrinth-pack.js';

const VERSION_MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const ALLOWED_DOWNLOAD_HOSTS = new Set(['piston-meta.mojang.com', 'piston-data.mojang.com', 'launcher.mojang.com']);
const MAX_MEMORY_FRACTION = 0.8;
const SERVER_SOFTWARE = new Set(['vanilla', 'fabric', 'forge', 'neoforge', 'quilt', 'paper', 'purpur']);

export class ServerManager {
  constructor(database, options = {}) {
    this.db = database;
    this.runtime = new Map();
    this.fetch = options.fetch ?? globalThis.fetch;
    this.serverDir = options.serverDir ?? config.serverDir;
    this.backupDir = options.backupDir ?? config.backupDir;
    this.backupRetention = options.backupRetention ?? config.backupRetention;
    this.availableMemoryMb = options.availableMemoryMb ?? config.availableMemoryMb;
    this.javaCandidates = options.javaCandidates;
    this.javaRuntimeCache = null;
    this.reconcileInterval = null;
    this.taskControllers = new Map();
    this.taskPromises = new Map();
    this.metricsTimer = null;
    this.schedulerTimer = null;
    this.initialMetricsTimer = null;
    this.metricsSamples = new Map();
    this.rconProbeAfter = new Map();
    this.remoteLogState = new Map();
    this.schedulingActive = false;
  }

  async initialize() {
    await mkdir(this.serverDir, { recursive: true });
    await mkdir(this.backupDir, { recursive: true });
    this.db.interruptActiveTasks('Panel restarted before this operation completed.');
    for (const entry of await readdir(this.serverDir, { withFileTypes: true })) {
      if (entry.isDirectory() && /^\.provider-stage-[0-9a-f-]{36}$/.test(entry.name)) {
        await rm(path.join(this.serverDir, entry.name), { recursive: true, force: true });
      }
    }
    for (const server of this.db.listServers()) {
      let entries;
      try {
        entries = await readdir(server.directory, { withFileTypes: true });
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      const refreshed = this.db.getServer(server.id);
      if (refreshed?.installed && refreshed.status === 'stopped') {
        await this.ensureRconConfiguration(refreshed);
      }
      for (const entry of entries) {
        if (entry.isFile() && /^\.server-[0-9a-f-]{36}\.jar\.tmp$/.test(entry.name)) {
          await rm(path.join(server.directory, entry.name), { force: true });
        }
      }
    }
    for (const server of this.db.listServers()) {
      if (server.status === 'running' || server.status === 'starting' || server.status === 'stopping') {
        if (await isManagedProcess(server.processPid, server)) {
          this.db.updateServer(server.id, { status: 'orphaned', error: 'Server process is still running but is not attached to this panel session.' });
          this.db.addEvent(server.id, 'warning', 'Found a running server process after panel restart; console is unavailable.');
        } else if (!server.processPid) {
          this.db.updateServer(server.id, { status: 'unknown', error: 'Previous panel session did not save a process ID; verify the server is stopped before continuing.' });
          this.db.addEvent(server.id, 'warning', 'Cannot verify the previous process state; manual confirmation is required.');
        } else {
          this.db.updateServer(server.id, { status: 'stopped', process_pid: null, error: null });
          this.db.addEvent(server.id, 'info', 'Previous server process was not found after panel restart.');
        }
      }
    }
    await this.reconcileOrphanedProcesses();
    this.reconcileInterval = setInterval(() => {
      this.reconcileOrphanedProcesses().catch((error) => console.error('[manager] Process reconciliation failed:', error));
    }, 3000);
    this.reconcileInterval.unref();
    this.schedulerTimer = setInterval(() => {
      this.runDueSchedules().catch((error) => console.error('[manager] Scheduler failed:', error));
    }, 15000);
    this.schedulerTimer.unref();
    this.metricsTimer = setInterval(() => {
      this.sampleMetrics().catch((error) => console.error('[manager] Metrics collection failed:', error));
    }, 60000);
    this.metricsTimer.unref();
    this.initialMetricsTimer = setTimeout(() => {
      this.sampleMetrics().catch((error) => console.error('[manager] Initial metrics collection failed:', error));
    }, 1000).unref();
  }

  async ensureRconConfiguration(server) {
    if (!Number.isInteger(server.rconPort) || server.rconPort < 1 || server.rconPort > 65535) {
      server.rconPort = await this.allocateRconPort(server.port);
      this.db.updateServer(server.id, { rcon_port: server.rconPort });
    }
    const secretPath = path.join(server.directory, '.panel-rcon-secret');
    let secret;
    try {
      secret = await readRconSecret(server.directory);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      secret = randomBytes(32).toString('base64url');
      try {
        await writeFile(secretPath, `${secret}\n`, { flag: 'wx', mode: 0o600 });
      } catch (writeError) {
        if (writeError.code !== 'EEXIST') throw writeError;
        secret = (await readFile(secretPath, 'utf8')).trim();
      }
    }
    if (!/^[A-Za-z0-9_-]{40,60}$/.test(secret)) {
      throw clientError('Managed RCON credential file contains invalid data.', 422);
    }
    await chmod(secretPath, 0o600);
    const propertiesPath = path.join(server.directory, 'server.properties');
    let properties = '';
    try {
      const propertiesStat = await lstat(propertiesPath);
      if (!propertiesStat.isFile() || propertiesStat.isSymbolicLink()) {
        throw clientError('server.properties is not a regular file.', 422);
      }
      properties = await readFile(propertiesPath, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const managed = new Map([
      ['enable-rcon', 'true'],
      ['rcon.port', String(server.rconPort)],
      ['rcon.password', secret],
      ['rcon.ip', '127.0.0.1'],
      ['broadcast-rcon-to-ops', 'false']
    ]);
    const lines = properties.split(/\r?\n/).filter((line) => !managed.has(line.split('=', 1)[0]));
    for (const [key, value] of managed) lines.push(`${key}=${value}`);
    await writeFile(propertiesPath, `${lines.filter(Boolean).join('\n')}\n`, { mode: 0o600 });
    await chmod(propertiesPath, 0o600);
    return secret;
  }

  async allocateRconPort(serverPort) {
    const reserved = new Set(this.db.listServers().flatMap((server) => [server.port, server.rconPort]));
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const port = randomInt(30000, 60001);
      if (port !== serverPort && !reserved.has(port) && await isPortAvailable(port)) return port;
    }
    throw clientError('Could not find a free local RCON port.');
  }

  async listServers() {
    return Promise.all(this.db.listServers().map(async (server) => {
      try {
        return { ...publicServer(server), players: null, uptimeSeconds: this.getUptime(server.id), diskBytes: await directorySize(server.directory), diskError: null };
      } catch (error) {
        return { ...publicServer(server), players: null, uptimeSeconds: this.getUptime(server.id), diskBytes: null, diskError: safeMessage(error) };
      }
    }));
  }

  getServer(id) {
    const server = this.requireServer(id);
    return { ...publicServer(server), uptimeSeconds: this.getUptime(id) };
  }

  async versions() {
    const response = await this.fetchMojang(VERSION_MANIFEST_URL, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw clientError(`Minecraft version catalogue returned HTTP ${response.status}.`, 502);
    const manifest = await response.json();
    return (manifest.versions ?? []).map(({ id, type, releaseTime }) => ({ id, type, releaseTime }));
  }

  async versionInfo(id) {
    validateMinecraftVersion(id);
    const manifestResponse = await this.fetchMojang(VERSION_MANIFEST_URL, { signal: AbortSignal.timeout(15000) });
    if (!manifestResponse.ok) throw clientError(`Minecraft version catalogue returned HTTP ${manifestResponse.status}.`, 502);
    const manifest = await manifestResponse.json();
    const version = manifest.versions?.find((entry) => entry.id === id);
    if (!version) throw clientError(`Minecraft ${id} is not in the official version catalogue.`, 404);
    const metadataResponse = await this.fetchMojang(checkedMojangUrl(version.url), { signal: AbortSignal.timeout(15000) });
    if (!metadataResponse.ok) throw clientError(`Version metadata returned HTTP ${metadataResponse.status}.`, 502);
    const metadata = await metadataResponse.json();
    return {
      id,
      type: version.type,
      releaseTime: version.releaseTime,
      requiredJavaMajor: requiredJavaMajor(id, metadata)
    };
  }

  async javaRuntimes() {
    if (this.javaRuntimeCache && this.javaRuntimeCache.expiresAt > Date.now()) {
      return this.javaRuntimeCache.runtimes;
    }
    const candidates = await this.getJavaCandidates();
    const unique = new Set();
    const runtimes = [];
    for (const candidate of candidates) {
      const runtime = await inspectJava(candidate);
      if (!runtime || unique.has(runtime.path)) continue;
      unique.add(runtime.path);
      runtimes.push(runtime);
    }
    runtimes.sort((left, right) => right.majorVersion - left.majorVersion || left.path.localeCompare(right.path));
    this.javaRuntimeCache = { runtimes, expiresAt: Date.now() + 30000 };
    return runtimes;
  }

  async inspectJava(javaPath) {
    const candidate = validateText(javaPath, 'Java executable', 1, 512);
    const inspected = await inspectJava(candidate);
    if (!inspected) throw clientError(`Could not run "${candidate}" or determine its Java version. Check the executable path and permissions.`, 422);
    return inspected;
  }

  providers() {
    return listProviders();
  }

  async providerCatalog(providerId, minecraftVersion) {
    try {
      return await getProviderCatalog(providerId, {
        minecraftVersion,
        fetchImpl: this.fetch,
        timeoutMs: 15000
      });
    } catch (error) {
      throw normalizeEcosystemError(error);
    }
  }

  async searchModrinth(options) {
    try {
      return await searchModrinth({ ...options, fetchImpl: this.fetch });
    } catch (error) {
      throw normalizeEcosystemError(error);
    }
  }

  async modrinthVersions(projectId, options) {
    try {
      return await listModrinthVersions(projectId, { ...options, fetchImpl: this.fetch });
    } catch (error) {
      throw normalizeEcosystemError(error);
    }
  }

  async createServer(input) {
    requireObject(input, 'Server configuration');
    const name = validateText(input.name, 'Server name', 2, 48);
    const version = validateMinecraftVersion(input.minecraftVersion);
    const software = input.software ?? 'vanilla';
    if (typeof software !== 'string' || !SERVER_SOFTWARE.has(software)) throw clientError('Choose a supported Minecraft server software provider.');
    const memoryMb = Number(input.memoryMb ?? 2048);
    const configuredMemoryMb = this.db.listServers().reduce((total, server) => total + server.memoryMb, 0);
    const memoryLimitMb = Math.floor(this.availableMemoryMb * MAX_MEMORY_FRACTION);
    const remainingMemoryMb = Math.max(0, memoryLimitMb - configuredMemoryMb);
    if (!Number.isInteger(memoryMb) || memoryMb < 512 || memoryMb > remainingMemoryMb) {
      throw clientError(`Memory must be between 512 MB and ${remainingMemoryMb} MB based on available memory and existing server allocations.`);
    }
    const port = Number(input.port ?? 25565);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      throw clientError('Server port must be between 1024 and 65535.');
    }
    if (this.db.listServers().some((server) => server.port === port)) {
      throw clientError(`Port ${port} is already assigned to a managed server.`);
    }
    if (!await isPortAvailable(port)) throw clientError(`Port ${port} is already in use by another process.`);
    const javaPath = validateText(input.javaPath ?? 'java', 'Java executable', 1, 512);
    const description = typeof input.description === 'string' ? input.description.slice(0, 500) : '';
    const rconPort = await this.allocateRconPort(port);
    const id = `${slugify(name).slice(0, 32) || 'server'}-${randomUUID().slice(0, 8)}`;
    const directory = path.join(this.serverDir, id);
    const server = this.db.insertServer({
      id, name, description, minecraftVersion: version, software, javaPath, memoryMb, port, directory,
      rconPort,
      eulaAccepted: false,
      createdAt: new Date().toISOString()
    });
    try {
      await mkdir(directory, { recursive: false });
    } catch (error) {
      this.db.deleteServer(id);
      throw error;
    }
    this.db.addEvent(id, 'success', `Created ${name} (${version}, ${software}).`);
    return publicServer(server);
  }

  async install(id, options = {}) {
    requireObject(options, 'Installation review');
    if (options.confirmed !== true) throw clientError('Explicit confirmation is required before downloading a server jar.', 403);
    const server = this.requireServer(id);
    if (server.status === 'unknown' || server.status === 'orphaned') {
      throw clientError('Verify and stop the previous process before installing software into this instance.');
    }
    if (server.installed) throw clientError('This server is already installed.');
    if (server.software !== 'vanilla') return this.installProvider(server, options);
    checkCancelled(options.signal);
    options.onProgress?.(5, 'Loading official Minecraft metadata.');
    const manifestResponse = await this.fetchMojang(VERSION_MANIFEST_URL, { signal: combineSignals(options.signal, AbortSignal.timeout(15000)) });
    if (!manifestResponse.ok) throw clientError(`Minecraft version catalogue returned HTTP ${manifestResponse.status}.`, 502);
    const manifest = await manifestResponse.json();
    const versionEntry = manifest.versions?.find((entry) => entry.id === server.minecraftVersion);
    if (!versionEntry) throw clientError(`Minecraft ${server.minecraftVersion} is not in the official version catalogue.`, 404);
    const versionResponse = await this.fetchMojang(checkedMojangUrl(versionEntry.url), { signal: combineSignals(options.signal, AbortSignal.timeout(15000)) });
    if (!versionResponse.ok) throw clientError(`Version metadata returned HTTP ${versionResponse.status}.`, 502);
    const metadata = await versionResponse.json();
    checkCancelled(options.signal);
    options.onProgress?.(12, 'Checking Java compatibility and disk space.');
    const javaMajor = requiredJavaMajor(server.minecraftVersion, metadata);
    this.assertJavaCompatibility(await this.inspectJava(server.javaPath), javaMajor);
    const download = metadata.downloads?.server;
    if (!download?.url || !Number.isSafeInteger(download.size) || download.size <= 0 || download.size > 2 * 1024 ** 3) {
      throw clientError(`Minecraft ${server.minecraftVersion} does not publish a downloadable server jar.`, 422);
    }
    if (typeof download.sha1 !== 'string' || !/^[a-f0-9]{40}$/i.test(download.sha1)) {
      throw clientError('Mojang did not provide a valid SHA-1 checksum for this server jar.', 422);
    }
    const filesystem = await statfs(server.directory);
    const freeBytes = filesystem.bavail * filesystem.bsize;
    if (freeBytes < download.size + 50 * 1024 ** 2) {
      throw clientError('There is not enough free disk space for this server jar and its initial files.', 507);
    }
    const url = checkedMojangUrl(download.url);
    const temporaryJar = path.join(server.directory, `.server-${randomUUID()}.jar.tmp`);
    const jarPath = path.join(server.directory, 'server.jar');
    try {
      await lstat(jarPath);
      throw clientError('A server.jar already exists in this instance; refusing to overwrite it.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    let jarCommitted = false;
    let propertiesCreated = false;
    try {
      const response = await this.fetchMojang(url, { signal: combineSignals(options.signal, AbortSignal.timeout(120000)) });
      if (!response.ok || !response.body) throw clientError(`Server download returned HTTP ${response.status}.`, 502);
      const hash = createHash('sha1');
      let bytes = 0;
      await pipeline(response.body, async function* (source) {
        for await (const chunk of source) {
          bytes += chunk.length;
          hash.update(chunk);
          options.onProgress?.(Math.min(95, 15 + Math.floor(bytes / download.size * 80)), `Downloading and verifying server jar (${Math.min(100, Math.floor(bytes / download.size * 100))}%).`);
          if (bytes > download.size * 1.05) throw clientError('Downloaded file exceeded the size reported by Mojang.', 502);
          yield chunk;
        }
      }, createWriteStream(temporaryJar, { flags: 'wx', mode: 0o600 }), ...(options.signal ? [{ signal: options.signal }] : []));
      checkCancelled(options.signal);
      if (bytes !== download.size) throw clientError('Downloaded server jar has an unexpected size.', 502);
      if (hash.digest('hex') !== download.sha1.toLowerCase()) {
        throw clientError('Downloaded server jar failed Mojang SHA-1 verification.', 502);
      }
      await rename(temporaryJar, jarPath);
      jarCommitted = true;
      if (server.eulaAccepted) await writeFile(path.join(server.directory, 'eula.txt'), 'eula=true\n', { mode: 0o600 });
      try {
        await writeFile(path.join(server.directory, 'server.properties'), [
          `server-port=${server.port}`,
          'max-players=20',
          'online-mode=true',
          'view-distance=10',
          'simulation-distance=10',
          'motd=A Minecraft Server',
          ''
        ].join('\n'), { mode: 0o600, flag: 'wx' });
        propertiesCreated = true;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
      await this.ensureRconConfiguration(this.db.getServer(id));
      this.db.markServerInstalled(id, `Installed Vanilla ${server.minecraftVersion}.`, javaMajor);
      options.onProgress?.(100, 'Installation complete.');
      jarCommitted = false;
      propertiesCreated = false;
      return { installed: true, version: server.minecraftVersion };
    } catch (error) {
      await rm(temporaryJar, { force: true });
      if (jarCommitted) await rm(jarPath, { force: true });
      if (propertiesCreated) await rm(path.join(server.directory, 'server.properties'), { force: true });
      this.db.addEvent(id, 'error', `Installation failed: ${safeMessage(error)}`);
      throw error;
    }
  }

  async installProvider(server, options = {}) {
    checkCancelled(options.signal);
    options.onProgress?.(5, `Loading ${server.software} metadata.`);
    const info = await this.versionInfo(server.minecraftVersion);
    this.assertJavaCompatibility(await this.inspectJava(server.javaPath), info.requiredJavaMajor);
    let artifact;
    let installArgs = null;
    let softwareVersion = null;
    let loaderVersion = null;
    let catalog;
    if (['paper', 'purpur'].includes(server.software)) {
      artifact = await resolveProviderInstall(server.software, {
        minecraftVersion: server.minecraftVersion, fetchImpl: this.fetch, signal: options.signal
      });
      softwareVersion = artifact.build === undefined ? null : String(artifact.build);
    } else {
      catalog = await getProviderCatalog(server.software, {
        fetchImpl: this.fetch, signal: options.signal
      });
      if (server.software === 'fabric' || server.software === 'quilt') {
        const loader = catalog.loaders.find((entry) => entry.stable) ?? catalog.loaders[0];
        const installer = catalog.installers.find((entry) => entry.stable) ?? catalog.installers[0];
        if (!loader || !installer) throw clientError(`No ${server.software} loader installer is published.`, 422);
        loaderVersion = loader.version;
        softwareVersion = loader.version;
        artifact = await resolveProviderInstall(server.software, {
          version: installer.version, fetchImpl: this.fetch, signal: options.signal
        });
        installArgs = server.software === 'fabric'
          ? ['server', '-mcversion', server.minecraftVersion, '-loader', loaderVersion, '-downloadMinecraft']
          : ['install', 'server', server.minecraftVersion, '--download-server'];
      } else {
        const prefix = server.software === 'forge'
          ? `${server.minecraftVersion}-`
          : neoForgeVersionPrefix(server.minecraftVersion);
        softwareVersion = catalog.versions.filter((version) => version.startsWith(prefix)).at(-1);
        if (!softwareVersion) throw clientError(`The official ${server.software} catalog has no installer artifact for Minecraft ${server.minecraftVersion}.`, 422);
        artifact = await resolveProviderInstall(server.software, {
          version: softwareVersion, fetchImpl: this.fetch, signal: options.signal
        });
        installArgs = ['--installServer'];
      }
    }
    const filesystem = await statfs(server.directory);
    if (filesystem.bavail * filesystem.bsize < 256 * 1024 ** 2) {
      throw clientError('At least 256 MiB of free disk space is required for this provider installation.', 507);
    }
    const stage = path.join(this.serverDir, `.provider-stage-${randomUUID()}`);
    await mkdir(stage, { recursive: false, mode: 0o700 });
    const installedPaths = [];
    try {
      options.onProgress?.(15, `Downloading and verifying ${server.software} artifact.`);
      const bytes = await downloadVerified(artifact, {
        fetchImpl: this.fetch, maxBytes: 512 * 1024 ** 2, signal: options.signal
      });
      checkCancelled(options.signal);
      if (artifact.installType === 'server') {
        await writeFile(path.join(stage, 'server.jar'), bytes, { flag: 'wx', mode: 0o600 });
      } else {
        const installerPath = path.join(stage, 'installer.jar');
        await writeFile(installerPath, bytes, { flag: 'wx', mode: 0o600 });
        options.onProgress?.(35, `Running verified ${server.software} installer.`);
        await runInstaller(server.javaPath, ['-jar', installerPath, ...installArgs], stage, options);
        await rm(installerPath, { force: true });
      }
      checkCancelled(options.signal);
      if (['fabric', 'quilt'].includes(server.software)) {
        const launcher = server.software === 'fabric' ? 'fabric-server-launch.jar' : 'quilt-server-launch.jar';
        await assertInstalledJar(path.join(stage, 'server.jar'), `${server.software} Minecraft server`);
        await assertInstalledJar(path.join(stage, launcher), `${server.software} launcher`);
      }
      installedPaths.push(...await mergeDirectory(stage, server.directory));
      if (['forge', 'neoforge'].includes(server.software)) {
        const argsPath = server.software === 'forge'
          ? path.join(server.directory, 'libraries', 'net', 'minecraftforge', 'forge', softwareVersion, 'unix_args.txt')
          : path.join(server.directory, 'libraries', 'net', 'neoforged', 'neoforge', softwareVersion, 'unix_args.txt');
        const argsStat = await lstat(argsPath);
        if (!argsStat.isFile() || argsStat.isSymbolicLink()) throw clientError(`${server.software} installer did not produce a safe Unix server argument file.`);
      }
      const propertiesPath = path.join(server.directory, 'server.properties');
      await writeFile(propertiesPath, [
        `server-port=${server.port}`, 'max-players=20', 'online-mode=true',
        'view-distance=10', 'simulation-distance=10', 'motd=A Minecraft Server', ''
      ].join('\n'), { flag: 'wx', mode: 0o600 });
      installedPaths.push(propertiesPath);
      if (server.eulaAccepted) {
        const eulaPath = path.join(server.directory, 'eula.txt');
        await writeFile(eulaPath, 'eula=true\n', { flag: 'wx', mode: 0o600 });
        installedPaths.push(eulaPath);
      }
      await this.ensureRconConfiguration(server);
      this.db.updateServer(server.id, {
        software_version: softwareVersion,
        loader_version: loaderVersion
      });
      this.db.markServerInstalled(server.id, `Installed ${server.software} for Minecraft ${server.minecraftVersion}.`, info.requiredJavaMajor);
      options.onProgress?.(100, 'Provider installation complete.');
      return { installed: true, software: server.software, version: softwareVersion };
    } catch (error) {
      for (const filename of installedPaths.reverse()) {
        await rm(filename, { recursive: false, force: true }).catch((cleanupError) => {
          console.error(`[manager] Could not roll back provider installation file ${filename}:`, cleanupError);
        });
      }
      throw error;
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }

  async installModrinthContent(serverId, input, options = {}) {
    const server = this.requireServer(serverId);
    if (this.runtime.has(serverId) || !['stopped', 'crashed'].includes(server.status)) {
      throw clientError('Stop and verify the server before installing content.');
    }
    const type = input.contentType;
    if (!['mod', 'plugin'].includes(type) || typeof input.versionId !== 'string') {
      throw clientError('Choose a Modrinth mod or plugin version.');
    }
    if (type === 'mod' && !['fabric', 'forge', 'neoforge', 'quilt'].includes(server.software)) {
      throw clientError('Mods require a Fabric, Forge, NeoForge, or Quilt server.');
    }
    if (type === 'plugin' && !['paper', 'purpur'].includes(server.software)) {
      throw clientError('Plugins require a Paper or Purpur server.');
    }
    checkCancelled(options.signal);
    options.onProgress?.(10, 'Loading Modrinth version metadata.');
    const version = await getModrinthVersion(input.versionId, {
      type, fetchImpl: this.fetch, signal: options.signal
    });
    if (!version.gameVersions.includes(server.minecraftVersion)) {
      throw clientError(`This ${type} version does not support Minecraft ${server.minecraftVersion}.`, 422);
    }
    const supportedLoaders = type === 'plugin'
      ? [server.software, 'bukkit', 'spigot']
      : [server.software];
    if (!version.loaders.some((loader) => supportedLoaders.includes(loader))) {
      throw clientError(`This ${type} version does not support ${server.software}.`, 422);
    }
    const folder = type === 'plugin' ? 'plugins' : 'mods';
    const file = version.files.find((candidate) => candidate.primary) ?? version.files[0];
    const filename = file.filename;
    if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,254}$/.test(filename)) {
      throw clientError('Modrinth returned an unsafe content filename.', 422);
    }
    const bytes = await downloadVerified({ ...file, providerId: 'modrinth' }, {
      fetchImpl: this.fetch, maxBytes: 512 * 1024 ** 2, signal: options.signal
    });
    options.onProgress?.(80, `Installing verified ${type} ${version.versionNumber}.`);
    const installed = await writeImportedFiles(server.directory, new Map([[`${folder}/${filename}`, bytes]]));
    this.db.addEvent(serverId, 'success', `Installed verified Modrinth ${type} ${version.versionNumber}.`);
    options.onProgress?.(100, 'Content installation complete.');
    return { installed, type, version: version.versionNumber };
  }

  async installModrinthPack(serverId, input, options = {}) {
    const server = this.requireServer(serverId);
    if (this.runtime.has(serverId) || !['stopped', 'crashed'].includes(server.status)) {
      throw clientError('Stop and verify the server before importing a modpack.');
    }
    if (!['fabric', 'forge', 'neoforge', 'quilt'].includes(server.software)) {
      throw clientError('Modrinth modpacks require a Fabric, Forge, NeoForge, or Quilt server.');
    }
    if (typeof input.versionId !== 'string') throw clientError('Choose a Modrinth modpack version.');
    checkCancelled(options.signal);
    options.onProgress?.(5, 'Loading selected Modrinth pack metadata.');
    const version = await getModrinthVersion(input.versionId, {
      type: 'modpack', fetchImpl: this.fetch, signal: options.signal
    });
    if (!version.gameVersions.includes(server.minecraftVersion)) {
      throw clientError(`This modpack version does not support Minecraft ${server.minecraftVersion}.`, 422);
    }
    if (!version.loaders.some((loader) => loader.replace(/-loader$/, '') === server.software)) {
      throw clientError(`This modpack version does not support ${server.software}.`, 422);
    }
    const packFile = version.files.find((candidate) => candidate.primary) ?? version.files[0];
    options.onProgress?.(15, 'Downloading the selected Modrinth pack archive.');
    const packBytes = await downloadVerified({ ...packFile, providerId: 'modrinth' }, {
      fetchImpl: this.fetch,
      maxBytes: 64 * 1024 ** 2,
      signal: options.signal
    });
    const pack = await parseModrinthPack(Buffer.from(packBytes), {
      fetch: this.fetch,
      signal: options.signal,
      timeoutMs: 10 * 60 * 1000
    });
    if (pack.gameVersion !== server.minecraftVersion) {
      throw clientError(`This modpack requires Minecraft ${pack.gameVersion}, not ${server.minecraftVersion}.`, 422);
    }
    const packLoader = pack.loader?.name.replace(/-loader$/, '');
    if (packLoader !== server.software) {
      throw clientError(`This modpack requires ${packLoader ?? 'a different loader'}, not ${server.software}.`, 422);
    }
    await this.ensureRconConfiguration(server);
    const files = new Map([...pack.files].filter(([filename]) =>
      filename !== 'server.properties' && filename !== 'eula.txt'
      && filename !== '.panel-rcon-secret' && filename !== 'server.jar'
    ));
    options.onProgress?.(85, `Installing ${files.size} verified server pack files.`);
    const installed = await writeImportedFiles(server.directory, files);
    this.db.addEvent(serverId, 'success', `Imported verified Modrinth pack ${version.name}.`);
    options.onProgress?.(100, 'Modpack import complete.');
    return { installed, name: version.name, gameVersion: pack.gameVersion, loader: pack.loader };
  }

  queueTask(type, serverId, input = {}) {
    requireObject(input, 'Task options');
    if (!['install', 'backup', 'restore', 'content-install', 'modpack-install'].includes(type)) throw clientError('Unsupported background task.');
    if (['install', 'content-install', 'modpack-install'].includes(type) && input.confirmed !== true) throw clientError('Explicit confirmation is required before downloading server software or content.', 403);
    if (type === 'restore' && input.confirmed !== true) throw clientError('Explicit confirmation is required before replacing server files.', 403);
    const server = this.requireServer(serverId);
    if (['install', 'backup', 'restore', 'content-install', 'modpack-install'].includes(type) && this.db.listTasks(1000).some((task) =>
      task.serverId === serverId && ['queued', 'running', 'cancelling'].includes(task.status))) {
      throw clientError('Another background operation is already active for this server.', 409);
    }
    if (['content-install', 'modpack-install'].includes(type) && !server.installed) {
      throw clientError('Install the server software before adding content.');
    }
    if (['install', 'backup', 'restore', 'content-install', 'modpack-install'].includes(type)
        && (this.runtime.has(serverId) || !['stopped', 'crashed'].includes(server.status))) {
      throw clientError('Stop and verify the server before this operation.');
    }
    const taskId = randomUUID();
    const task = this.db.createTask({ id: taskId, type, serverId, createdAt: new Date().toISOString() });
    const controller = new AbortController();
    this.taskControllers.set(taskId, controller);
    const promise = new Promise((resolve) => setImmediate(resolve))
      .then(() => this.executeTask(taskId, input, controller));
    this.taskPromises.set(taskId, promise);
    promise.finally(() => {
      this.taskControllers.delete(taskId);
      this.taskPromises.delete(taskId);
    });
    return task;
  }

  async executeTask(taskId, input, controller) {
    const task = this.db.getTask(taskId);
    if (!task || controller.signal.aborted) {
      this.db.updateTask(taskId, { status: 'cancelled', message: 'Operation cancelled before it started.' });
      return;
    }
    this.db.updateTask(taskId, { status: 'running', progress: 1, message: 'Operation started.' });
    try {
      let result;
      if (task.type === 'install') {
        result = await this.install(task.serverId, {
          ...input,
          signal: controller.signal,
          onProgress: (progress, message) => this.db.updateTask(taskId, { progress, message })
        });
      } else if (task.type === 'backup') {
        checkCancelled(controller.signal);
        this.db.updateTask(taskId, { progress: 10, message: 'Copying stopped server files.' });
        result = await this.createBackup(task.serverId, { signal: controller.signal });
      } else {
        checkCancelled(controller.signal);
        if (task.type === 'restore') {
          this.db.updateTask(taskId, { progress: 10, message: 'Validating backup and replacing server files.' });
          result = await this.restoreBackup(task.serverId, input.backupId, { ...input, signal: controller.signal });
        } else if (task.type === 'content-install') {
          this.db.updateTask(taskId, { progress: 10, message: 'Verifying selected Modrinth content.' });
          result = await this.installModrinthContent(task.serverId, input, {
            signal: controller.signal,
            onProgress: (progress, message) => this.db.updateTask(taskId, { progress, message })
          });
        } else {
          result = await this.installModrinthPack(task.serverId, input, {
            signal: controller.signal,
            onProgress: (progress, message) => this.db.updateTask(taskId, { progress, message })
          });
        }
      }
      this.db.updateTask(taskId, {
        status: 'completed',
        progress: 100,
        message: 'Operation completed.',
        result_json: JSON.stringify(result),
        error: null
      });
    } catch (error) {
      const cancelled = controller.signal.aborted || error.name === 'AbortError';
      this.db.updateTask(taskId, {
        status: cancelled ? 'cancelled' : 'failed',
        message: cancelled ? 'Operation cancelled.' : 'Operation failed.',
        error: safeMessage(error)
      });
      if (!cancelled) this.db.addEvent(task.serverId, 'error', `Background ${task.type} failed: ${safeMessage(error)}`);
    }
  }

  cancelTask(id) {
    const task = this.db.getTask(id);
    if (!task) throw clientError('Task not found.', 404);
    if (task.status !== 'queued' && task.status !== 'running') {
      throw clientError('Only queued or running tasks can be cancelled.', 409);
    }
    this.taskControllers.get(id)?.abort();
    return this.db.updateTask(id, { status: 'cancelling', message: 'Cancellation requested.' });
  }

  listTasks() {
    return this.db.listTasks();
  }

  getTask(id) {
    const task = this.db.getTask(id);
    if (!task) throw clientError('Task not found.', 404);
    return task;
  }

  createSchedule(serverId, input) {
    requireObject(input, 'Schedule');
    this.requireServer(serverId);
    const action = input.action;
    if (!['backup', 'start', 'stop', 'restart'].includes(action)) {
      throw clientError('Schedule action must be backup, start, stop, or restart.');
    }
    const intervalMinutes = Number(input.intervalMinutes);
    if (!Number.isInteger(intervalMinutes) || intervalMinutes < 5 || intervalMinutes > 43200) {
      throw clientError('Schedule interval must be between 5 minutes and 30 days.');
    }
    const createdAt = new Date();
    const schedule = this.db.createSchedule({
      id: randomUUID(),
      serverId,
      action,
      intervalMinutes,
      createdAt: createdAt.toISOString(),
      nextRunAt: new Date(createdAt.getTime() + intervalMinutes * 60000).toISOString()
    });
    this.db.addEvent(serverId, 'success', `Created recurring ${action} schedule (every ${intervalMinutes} minutes).`);
    return schedule;
  }

  listSchedules(serverId = null) {
    return this.db.listSchedules(serverId);
  }

  deleteSchedule(id) {
    if (!this.db.deleteSchedule(id)) throw clientError('Schedule not found.', 404);
    return { deleted: true };
  }

  getMetrics(serverId, limit = 1440) {
    this.requireServer(serverId);
    const count = Number(limit);
    if (!Number.isInteger(count) || count < 1 || count > 1440) throw clientError('Metric limit must be 1-1440.');
    return this.db.listMetrics(serverId, count);
  }

  async sampleMetrics() {
    const capturedAt = new Date().toISOString();
    const systemTicks = await readSystemCpuTicks();
    for (const server of this.db.listServers()) {
      let cpuPercent = null;
      let memoryBytes = null;
      if (server.processPid && server.status === 'running' && await isManagedProcess(server.processPid, server)) {
        try {
          const processMetrics = await readProcessMetrics(server.processPid);
          memoryBytes = processMetrics.memoryBytes;
          const previous = this.metricsSamples.get(server.id);
          if (previous && previous.pid === server.processPid && systemTicks !== null && previous.systemTicks !== null) {
            const systemDelta = systemTicks - previous.systemTicks;
            const processDelta = processMetrics.cpuTicks - previous.processTicks;
            if (systemDelta > 0 && processDelta >= 0) {
              cpuPercent = Math.min(os.cpus().length * 100, Math.max(0, processDelta / systemDelta * os.cpus().length * 100));
            }
          }
          this.metricsSamples.set(server.id, {
            processTicks: processMetrics.cpuTicks,
            systemTicks,
            pid: server.processPid
          });
        } catch (error) {
          if (error.code !== 'ENOENT' && error.code !== 'EACCES') throw error;
          this.metricsSamples.delete(server.id);
        }
      } else {
        this.metricsSamples.delete(server.id);
      }
      let diskBytes = null;
      try {
        diskBytes = await directorySize(server.directory);
      } catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 'EACCES') throw error;
      }
      this.db.addMetrics({ serverId: server.id, capturedAt, cpuPercent, memoryBytes, diskBytes });
    }
    this.db.pruneMetrics(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString());
  }

  async runDueSchedules() {
    if (this.schedulingActive) return;
    this.schedulingActive = true;
    try {
      const now = new Date();
      for (const schedule of this.db.listDueSchedules(now.toISOString())) {
        const runAt = now.toISOString();
        const nextRunAt = new Date(now.getTime() + schedule.intervalMinutes * 60000).toISOString();
        this.db.advanceSchedule(schedule.id, runAt, nextRunAt);
        try {
          await this.runSchedule(schedule);
        } catch (error) {
          this.db.addEvent(schedule.serverId, 'error', `Scheduled ${schedule.action} failed: ${safeMessage(error)}`);
        }
      }
    } finally {
      this.schedulingActive = false;
    }
  }

  async runSchedule(schedule) {
    const server = this.requireServer(schedule.serverId);
    if (schedule.action === 'backup') {
      this.queueTask('backup', server.id);
      return;
    }
    if (schedule.action === 'start') {
      if (['running', 'starting'].includes(server.status)) return;
      await this.start(server.id);
      this.db.addEvent(server.id, 'info', 'Started server from recurring schedule.');
      return;
    }
    if (schedule.action === 'stop') {
      if (!['running', 'starting'].includes(server.status)) return;
      await this.stop(server.id);
      this.db.addEvent(server.id, 'info', 'Requested server stop from recurring schedule.');
      return;
    }
    if (['running', 'starting'].includes(server.status)) await this.stop(server.id);
    await waitForStatus(() => this.db.getServer(server.id)?.status === 'stopped', 30000);
    await this.start(server.id);
    this.db.addEvent(server.id, 'info', 'Restarted server from recurring schedule.');
  }

  async diagnostics() {
    const servers = await this.listServers();
    return {
      generatedAt: new Date().toISOString(),
      platform: process.platform,
      nodeVersion: process.version,
      serverCount: servers.length,
      servers: servers.map((server) => {
        const { javaPath, ...safeServer } = server;
        return safeServer;
      }),
      events: this.events(100),
      tasks: this.listTasks(),
      schedules: this.listSchedules(),
      metrics: Object.fromEntries(servers.map((server) => [server.id, this.getMetrics(server.id, 60)]))
    };
  }

  async start(id, input = {}) {
    requireObject(input, 'Start options');
    const server = this.requireServer(id);
    if (!server.installed) throw clientError('Install the server before starting it.');
    if (this.runtime.has(id)) throw clientError('The server is already running.');
    if (server.status === 'running' || server.status === 'starting' || server.status === 'stopping') {
      throw clientError('The server is already running or changing state.');
    }
    if (server.status === 'unknown') throw clientError('Confirm that the previous process has stopped before starting this server.');
    if (server.processPid && server.status === 'orphaned') {
      if (await isManagedProcess(server.processPid, server)) {
        throw clientError('This server still has a process from an earlier panel session. Stop that process before starting another.');
      }
      this.db.updateServer(id, { status: 'stopped', process_pid: null, error: null });
    }
    const inspectedJava = await this.inspectJava(server.javaPath);
    const requiredMajor = server.requiredJavaMajor ?? requiredJavaMajor(server.minecraftVersion);
    this.assertJavaCompatibility(inspectedJava, requiredMajor);
    await this.repairLegacyLoaderInstallation(server);
    server.rconPassword = await this.ensureRconConfiguration(server);
    if (!server.eulaAccepted && input.acceptEula === true) {
      return this.acceptEulaAndStart(server);
    }
    if (!server.eulaAccepted) throw clientError('You must accept the Minecraft EULA before starting this server.', 403);
    return this.spawnServer(server);
  }

  async repairLegacyLoaderInstallation(server) {
    if (!['fabric', 'quilt'].includes(server.software)) return;
    const launcherName = server.software === 'fabric' ? 'fabric-server-launch.jar' : 'quilt-server-launch.jar';
    const launcherPath = path.join(server.directory, launcherName);
    try {
      const launcherInfo = await lstat(launcherPath);
      if (launcherInfo.isFile() && !launcherInfo.isSymbolicLink() && launcherInfo.size > 0) return;
      throw clientError(`${server.software} launcher is not a regular, non-empty file.`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    const gameJarPath = path.join(server.directory, 'server.jar');
    const oldJarInfo = await lstat(gameJarPath);
    if (!oldJarInfo.isFile() || oldJarInfo.isSymbolicLink() || oldJarInfo.size < 4 || oldJarInfo.size > 128 * 1024 ** 2) {
      throw clientError(`The ${server.software} installation is incomplete and cannot be repaired automatically.`);
    }
    const oldLauncher = await readFile(gameJarPath);
    if (oldLauncher.subarray(0, 4).toString('binary') !== 'PK\u0003\u0004') {
      throw clientError(`The ${server.software} server JAR is not a valid loader archive; reinstall the server software.`);
    }

    const signal = AbortSignal.timeout(120000);
    const manifestResponse = await this.fetchMojang(VERSION_MANIFEST_URL, { signal });
    if (!manifestResponse.ok) throw clientError(`Minecraft version catalogue returned HTTP ${manifestResponse.status}.`, 502);
    const manifest = await manifestResponse.json();
    const version = manifest.versions?.find((entry) => entry.id === server.minecraftVersion);
    if (!version) throw clientError(`Minecraft ${server.minecraftVersion} is not in the official version catalogue.`, 404);
    const metadataResponse = await this.fetchMojang(checkedMojangUrl(version.url), { signal });
    if (!metadataResponse.ok) throw clientError(`Version metadata returned HTTP ${metadataResponse.status}.`, 502);
    const download = (await metadataResponse.json()).downloads?.server;
    if (!download?.url || !Number.isSafeInteger(download.size) || download.size < 1 || download.size > 2 * 1024 ** 3
        || typeof download.sha1 !== 'string' || !/^[a-f0-9]{40}$/i.test(download.sha1)) {
      throw clientError(`Minecraft ${server.minecraftVersion} does not publish a verifiable server JAR.`, 422);
    }
    const filesystem = await statfs(server.directory);
    if (filesystem.bavail * filesystem.bsize < download.size + oldJarInfo.size) {
      throw clientError('There is not enough free disk space to repair this loader installation.', 507);
    }

    const stage = path.join(server.directory, `.loader-repair-${randomUUID()}`);
    await mkdir(stage, { recursive: false, mode: 0o700 });
    const stagedLauncher = path.join(stage, launcherName);
    const stagedGameJar = path.join(stage, 'server.jar');
    const previousGameJar = path.join(stage, 'previous-server.jar');
    try {
      await writeFile(stagedLauncher, oldLauncher, { flag: 'wx', mode: 0o600 });
      const response = await this.fetchMojang(checkedMojangUrl(download.url), { signal });
      if (!response.ok || !response.body) throw clientError(`Minecraft server download returned HTTP ${response.status}.`, 502);
      const hash = createHash('sha1');
      let bytes = 0;
      await pipeline(response.body, async function* (source) {
        for await (const chunk of source) {
          bytes += chunk.length;
          if (bytes > download.size) throw clientError('Minecraft server download exceeded its published size.', 502);
          hash.update(chunk);
          yield chunk;
        }
      }, createWriteStream(stagedGameJar, { flags: 'wx', mode: 0o600 }), { signal });
      if (bytes !== download.size || hash.digest('hex') !== download.sha1.toLowerCase()) {
        throw clientError('Minecraft server JAR failed official size or SHA-1 verification.', 502);
      }
      await rename(gameJarPath, previousGameJar);
      try {
        await rename(stagedLauncher, launcherPath);
        await rename(stagedGameJar, gameJarPath);
      } catch (error) {
        await rm(launcherPath, { force: true });
        await rename(previousGameJar, gameJarPath);
        throw error;
      }
      this.db.addEvent(server.id, 'success', `Repaired the previous ${server.software} launcher and restored the Minecraft server JAR.`);
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }

  async acceptEulaAndStart(server) {
    await writeFile(path.join(server.directory, 'eula.txt'), 'eula=true\n', { mode: 0o600 });
    this.db.updateServer(server.id, { eula_accepted: 1 });
    server.eulaAccepted = true;
    return this.spawnServer(server);
  }

  spawnServer(server) {
    const launcherJar = server.software === 'fabric' ? 'fabric-server-launch.jar'
      : server.software === 'quilt' ? 'quilt-server-launch.jar' : 'server.jar';
    const jarPath = path.join(server.directory, launcherJar);
    const memoryArgs = [`-Xms${Math.min(server.memoryMb, 1024)}M`, `-Xmx${server.memoryMb}M`];
    const launchArgs = ['forge', 'neoforge'].includes(server.software)
      ? [
        ...memoryArgs,
        `@${path.join(server.directory, 'libraries', 'net', server.software === 'forge' ? 'minecraftforge/forge' : 'neoforged/neoforge', server.softwareVersion, 'unix_args.txt')}`,
        'nogui'
      ]
      : [...memoryArgs, '-jar', jarPath, 'nogui'];
    const child = spawn(server.javaPath, launchArgs, {
      cwd: server.directory,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true
    });
    const runtime = { child, startedAt: Date.now(), rconPassword: server.rconPassword };
    this.runtime.set(server.id, runtime);
    this.db.updateServer(server.id, { status: 'starting', process_pid: child.pid ?? null, last_started_at: new Date().toISOString(), error: null });
    this.db.addEvent(server.id, 'info', `Starting Java process (${server.javaPath}).`);
    runtime.startupTimer = setTimeout(() => {
      if (this.runtime.get(server.id) !== runtime || child.exitCode !== null) return;
      if (this.db.getServer(server.id)?.status !== 'starting') return;
      const message = 'Server did not report a ready state within 120 seconds.';
      this.db.updateServer(server.id, { status: 'crashed', error: message });
      this.db.addEvent(server.id, 'error', message);
      child.kill('SIGTERM');
      const forceTimer = setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
      }, 5000);
      forceTimer.unref();
    }, 120000);
    runtime.startupTimer.unref();
    const consume = (stream) => stream.on('data', (chunk) => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        if (!line) continue;
        if (/Done \(/.test(line)) {
          clearTimeout(runtime.startupTimer);
          this.db.updateServer(server.id, { status: 'running', error: null });
        }
        this.db.addEvent(server.id, /error|exception|failed/i.test(line) ? 'error' : 'console', line.slice(0, 1000));
      }
    });
    consume(child.stdout);
    consume(child.stderr);
    child.on('error', (error) => {
      clearTimeout(runtime.startupTimer);
      this.runtime.delete(server.id);
      this.db.updateServer(server.id, { status: 'crashed', process_pid: null, error: safeMessage(error), last_stopped_at: new Date().toISOString() });
      this.db.addEvent(server.id, 'error', `Unable to start Java: ${safeMessage(error)}`);
    });
    child.on('exit', (code, signal) => {
      clearTimeout(runtime.startupTimer);
      this.runtime.delete(server.id);
      const requestedStop = this.db.getServer(server.id)?.status === 'stopping';
      const status = code === 0 || requestedStop ? 'stopped' : 'crashed';
      const error = code === 0 ? null : `Process exited with ${signal ? `signal ${signal}` : `code ${code}`}.`;
      this.db.updateServer(server.id, { status, process_pid: null, error, last_stopped_at: new Date().toISOString() });
      this.db.addEvent(server.id, status === 'stopped' ? 'info' : 'error', error ?? 'Server stopped.');
    });
    return { status: 'starting', pid: child.pid ?? null };
  }

  async stop(id, force = false) {
    const runtime = this.runtime.get(id);
    const server = this.requireServer(id);
    if (!runtime && server.processPid && server.status === 'orphaned') {
      if (!await isManagedProcess(server.processPid, server)) {
        this.db.updateServer(id, { status: 'stopped', process_pid: null, error: null });
        return { status: 'stopped', server: server.name };
      }
      signalProcess(server.processPid, force ? 'SIGKILL' : 'SIGTERM');
      this.db.updateServer(id, { status: 'stopping' });
      this.db.addEvent(id, force ? 'warning' : 'info', force
        ? 'Sent a forced termination signal to the previously running process.'
        : 'Sent a shutdown signal to the previously running process.');
      const pid = server.processPid;
      const timer = setTimeout(() => {
        isManagedProcess(pid, server).then((stillRunning) => {
          if (stillRunning) signalProcess(pid, 'SIGKILL');
        }).catch((error) => console.error(`[manager] Could not verify process ${pid} before escalation:`, error));
      }, 15000);
      timer.unref();
      return { status: 'stopping', server: server.name };
    }
    if (!runtime) throw clientError('This server has no active process.');
    if (runtime.attached) {
      if (force) {
        if (await isManagedProcess(server.processPid, server)) signalProcess(server.processPid, 'SIGKILL');
      } else {
        await rconCommand({
          host: '127.0.0.1', port: server.rconPort, password: runtime.rconPassword, command: 'stop'
        });
      }
      this.db.updateServer(id, { status: 'stopping' });
      this.db.addEvent(id, force ? 'warning' : 'info', force
        ? 'Requested forced termination of the reattached server process.'
        : 'Requested graceful shutdown through the local RCON connection.');
      return { status: 'stopping', server: server.name };
    }
    if (!force && runtime.child.exitCode === null) {
      runtime.child.stdin.write('stop\n');
      this.db.updateServer(id, { status: 'stopping' });
      const timeout = setTimeout(() => {
        if (this.runtime.get(id) !== runtime || runtime.child.exitCode !== null) return;
        runtime.child.kill('SIGTERM');
        const killTimeout = setTimeout(() => {
          if (this.runtime.get(id) === runtime && runtime.child.exitCode === null) runtime.child.kill('SIGKILL');
        }, 5000);
        killTimeout.unref();
      }, 15000);
      timeout.unref();
    } else if (runtime.child.exitCode === null) {
      runtime.child.kill('SIGKILL');
      this.db.updateServer(id, { status: 'stopping' });
    }
    this.db.addEvent(id, force ? 'warning' : 'info', force ? 'Requested process termination.' : 'Requested graceful shutdown.');
    return { status: force ? 'stopping' : 'stopping', server: server.name };
  }

  confirmStopped(id, options = {}) {
    requireObject(options, 'Process-state confirmation');
    if (options.confirmed !== true) throw clientError('Explicit confirmation is required before changing the process state.', 403);
    const server = this.requireServer(id);
    if (server.status !== 'unknown' || server.processPid) {
      throw clientError('This server does not need manual process-state confirmation.');
    }
    this.db.updateServer(id, { status: 'stopped', error: null });
    this.db.addEvent(id, 'warning', 'User confirmed that no previous server process is running.');
    return { status: 'stopped' };
  }

  sendCommand(id, command) {
    const runtime = this.runtime.get(id);
    if (typeof command !== 'string' || command.length < 1 || command.length > 256 || /[\r\n\0]/.test(command)) {
      throw clientError('Commands must be a single line of at most 256 characters.');
    }
    if (!runtime || (runtime.child && runtime.child.exitCode !== null)) throw clientError('The server console is not running.');
    if (runtime.attached) {
      const server = this.requireServer(id);
      return rconCommand({
        host: '127.0.0.1', port: server.rconPort, password: runtime.rconPassword, command
      }).then((output) => {
        if (output) this.db.addEvent(id, 'console', output.slice(0, 1000));
        return { sent: true, output };
      });
    }
    runtime.child.stdin.write(`${command}\n`);
    return { sent: true };
  }

  async getLogs(id, after = null) {
    const server = this.requireServer(id);
    if (this.runtime.get(id)?.attached) {
      try {
        const logStat = await lstat(path.join(server.directory, 'logs', 'latest.log'));
        if (!logStat.isFile() || logStat.isSymbolicLink() || logStat.size > 2 * 1024 * 1024) {
          throw clientError('Server log is not a safe regular file or exceeds the 2 MiB limit.', 422);
        }
        const text = (await readManagedFile(server.directory, 'logs/latest.log', {
          maxFileSize: 2 * 1024 * 1024
        })).toString('utf8');
        const timestamp = logStat.mtime.toISOString();
        const previous = this.remoteLogState.get(id);
        const newLines = previous?.mtimeMs === logStat.mtimeMs && text.startsWith(previous.content)
          ? text.slice(previous.content.length).split(/\r?\n/)
          : text.split(/\r?\n/).slice(-500);
        const added = newLines.filter(Boolean).map((line) => ({
          timestamp,
          source: /error|exception|failed/i.test(line) ? 'error' : 'console',
          line: line.slice(0, 1000)
        }));
        const entries = previous?.mtimeMs === logStat.mtimeMs && text.startsWith(previous.content)
          ? [...previous.entries, ...added].slice(-500)
          : added;
        this.remoteLogState.set(id, { mtimeMs: logStat.mtimeMs, content: text, entries });
        return entries.filter((entry) => !after || entry.timestamp > after);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    const logs = this.db.listServerLogs(id);
    return after ? logs.filter((entry) => entry.timestamp > after) : logs.slice(-500);
  }

  async listServerFiles(id, directory = '') {
    const server = this.requireServer(id);
    if (!server.installed) throw clientError('Install the server before browsing its files.');
    return managedFileOperation(() => listManagedFiles(server.directory, directory));
  }

  async readServerFile(id, filename) {
    const server = this.requireServer(id);
    if (!server.installed) throw clientError('Install the server before browsing its files.');
    if (filename === '.panel-rcon-secret') throw clientError('Managed RCON credentials are not available through the file manager.', 404);
    const content = await managedFileOperation(() => readManagedFile(server.directory, filename));
    if (content.includes(0)) throw clientError('Binary files cannot be opened in the text editor.', 415);
    let text = content.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(content)) throw clientError('File is not valid UTF-8 text.', 415);
    if (filename === 'server.properties') text = text.replace(/^rcon\.password=.*$/gm, 'rcon.password=[managed]');
    return { path: filename, content: text };
  }

  async writeServerFile(id, filename, content, create = false) {
    const server = this.requireServer(id);
    this.assertServerFilesStopped(server);
    if (typeof content !== 'string') throw clientError('File content must be text.');
    if (filename === '.panel-rcon-secret') throw clientError('Managed RCON credentials cannot be edited.', 403);
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > 2 * 1024 * 1024) throw clientError('Text files are limited to 2 MiB.', 413);
    const written = await managedFileOperation(() => create
      ? createManagedFile(server.directory, filename, content)
      : writeManagedFile(server.directory, filename, content));
    if (filename === 'server.properties') await this.ensureRconConfiguration(server);
    this.db.addEvent(id, 'info', `${create ? 'Created' : 'Updated'} server file ${filename}.`);
    return { written };
  }

  async deleteServerFile(id, filename) {
    const server = this.requireServer(id);
    this.assertServerFilesStopped(server);
    await managedFileOperation(() => deleteManagedFile(server.directory, filename));
    this.db.addEvent(id, 'warning', `Deleted server file ${filename}.`);
    return { deleted: true };
  }

  assertServerFilesStopped(server) {
    if (this.runtime.has(server.id) || ['running', 'starting', 'stopping', 'orphaned', 'unknown'].includes(server.status)) {
      throw clientError('Stop and verify the server before changing its files.');
    }
  }

  sendAdminCommand(id, action, args) {
    const server = this.requireServer(id);
    if (!['running', 'orphaned'].includes(server.status)) throw clientError('The server must be running to execute Minecraft administration commands.');
    const executor = createAdminExecutor((command) => this.sendCommand(id, command));
    return executor(action, args);
  }

  getUptime(id) {
    const runtime = this.runtime.get(id);
    const startedAt = runtime?.attached
      ? Date.parse(this.db.getServer(id)?.lastStartedAt ?? '')
      : runtime?.startedAt;
    return startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0;
  }

  async createBackup(id, options = {}) {
    const server = this.requireServer(id);
    if (this.runtime.has(id) || ['running', 'starting', 'stopping', 'orphaned', 'unknown'].includes(server.status)) {
      throw clientError('Stop the server before creating a consistent backup.');
    }
    const timestamp = new Date().toISOString().replace(/[^a-z0-9-]/gi, '-').toLowerCase();
    const backupId = `${id}-${timestamp}-${randomUUID().slice(0, 6)}`;
    const target = path.join(this.backupDir, `${backupId}.tar.gz`);
    try {
      await createArchive(server.directory, target, { signal: options.signal });
    } catch (error) {
      await rm(target, { force: true });
      throw error;
    }
    let sizeBytes;
    let archiveSha256;
    try {
      sizeBytes = (await stat(target)).size;
      archiveSha256 = await sha256File(target);
    } catch (error) {
      await rm(target, { force: true });
      throw error;
    }
    const backup = this.db.addBackup({
      id: backupId, serverId: id, directory: target, archivePath: target, archiveSha256, sizeBytes,
      createdAt: new Date().toISOString()
    });
    await this.applyBackupRetention(id);
    this.db.addEvent(id, 'success', `Created stopped-server snapshot (${formatBytes(sizeBytes)}).`);
    return publicBackup(backup);
  }

  async listBackups(id = null) {
    const backups = this.db.listBackups(id);
    return Promise.all(backups.map(async (backup) => {
      try {
        if (backup.archive_path) {
          const archiveStat = await lstat(backup.archive_path);
          if (!archiveStat.isFile() || archiveStat.isSymbolicLink()) throw clientError('Backup archive is not a regular file.');
          return publicBackupEntry(backup, archiveStat.size, true);
        }
        const actualSize = await directorySize(backup.directory);
        return publicBackupEntry(backup, actualSize, false);
      } catch (error) {
        if (!['ENOENT', 'EACCES', 'ENOTDIR'].includes(error.code)) throw error;
        return publicBackupEntry(backup, null, Boolean(backup.archive_path), false);
      }
    }));
  }

  async restoreBackup(id, backupId, options = {}) {
    requireObject(options, 'Restore review');
    if (options.confirmed !== true) throw clientError('Explicit confirmation is required before replacing server files.', 403);
    const server = this.requireServer(id);
    if (this.runtime.has(id) || ['running', 'starting', 'stopping', 'orphaned', 'unknown'].includes(server.status)) {
      throw clientError('Stop the server before restoring a backup.');
    }
    const backup = this.db.listBackups(id).find((item) => item.id === backupId);
    if (!backup) throw clientError('Backup not found for this server.', 404);
    if (backup.archive_path) {
      await this.verifyBackupArchive(backup);
    } else {
      const backupStat = await stat(backup.directory).catch(() => null);
      if (!backupStat?.isDirectory()) throw clientError('Backup files are missing or invalid.', 422);
    }
    const staging = `${server.directory}.restore-${randomUUID()}`;
    try {
      if (backup.archive_path) {
        await this.verifyBackupArchive(backup);
        await extractArchive(backup.archive_path, staging, { signal: options.signal });
      } else {
        await copyDirectory(backup.directory, staging, options.signal);
      }
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
    checkCancelled(options.signal);
    const backupBeforeRestore = `${server.directory}.before-restore-${randomUUID()}`;
    const { rename } = await import('node:fs/promises');
    await rename(server.directory, backupBeforeRestore);
    try {
      await rename(staging, server.directory);
      await rm(backupBeforeRestore, { recursive: true, force: true });
    } catch (error) {
      await rename(backupBeforeRestore, server.directory);
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
    this.db.updateServer(id, { installed: 1 });
    this.db.addEvent(id, 'warning', `Restored backup ${backupId}.`);
    return { restored: true };
  }

  async verifyBackupArchive(backup) {
    if (!backup.archive_path || !/^[a-f0-9]{64}$/.test(backup.archive_sha256 ?? '')) {
      throw clientError('Backup archive is missing its integrity metadata.', 422);
    }
    const info = await lstat(backup.archive_path);
    if (!info.isFile() || info.isSymbolicLink()) throw clientError('Backup archive is not a regular file.', 422);
    const actual = await sha256File(backup.archive_path);
    if (actual !== backup.archive_sha256) throw clientError('Backup archive failed SHA-256 integrity verification.', 422);
    return { path: backup.archive_path, sizeBytes: info.size, sha256: actual };
  }

  async deleteBackup(id) {
    const backup = this.db.listBackups().find((item) => item.id === id);
    if (!backup) throw clientError('Backup not found.', 404);
    const target = backup.archive_path ?? backup.directory;
    const info = await lstat(target).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (info?.isDirectory()) await rm(target, { recursive: true, force: true });
    else await rm(target, { force: true });
    this.db.deleteBackup(id);
    return { deleted: true };
  }

  async getBackupDownload(id) {
    const backup = this.db.listBackups().find((item) => item.id === id);
    if (!backup) throw clientError('Backup not found.', 404);
    if (!backup.archive_path) throw clientError('This legacy backup has no downloadable archive.', 409);
    const integrity = await this.verifyBackupArchive(backup);
    return { ...integrity, filename: `${backup.id}.tar.gz` };
  }

  async applyBackupRetention(serverId) {
    const backups = this.db.listBackups(serverId);
    for (const backup of backups.slice(this.backupRetention)) {
      const target = backup.archive_path ?? backup.directory;
      const info = await lstat(target).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
      if (info?.isDirectory()) await rm(target, { recursive: true, force: true });
      else await rm(target, { force: true });
      this.db.deleteBackup(backup.id);
    }
  }

  async deleteServer(id, options = {}) {
    requireObject(options, 'Deletion review');
    if (options.confirmed !== true) throw clientError('Explicit confirmation is required before deleting server files.', 403);
    const server = this.requireServer(id);
    if (this.db.listTasks(1000).some((task) => task.serverId === id && ['queued', 'running', 'cancelling'].includes(task.status))) {
      throw clientError('Wait for the server operation to finish before deleting this instance.', 409);
    }
    if (this.runtime.has(id) || ['running', 'starting', 'stopping', 'orphaned', 'unknown'].includes(server.status)) {
      throw clientError('Stop the server before deleting it.');
    }
    await rm(server.directory, { recursive: true, force: true });
    this.db.deleteServer(id);
    this.db.addEvent(null, 'warning', `Deleted server ${server.name} and its files.`);
    return { deleted: true };
  }

  async shutdown() {
    clearInterval(this.reconcileInterval);
    clearInterval(this.schedulerTimer);
    clearInterval(this.metricsTimer);
    clearTimeout(this.initialMetricsTimer);
    for (const controller of this.taskControllers.values()) controller.abort();
    await Promise.all(this.taskPromises.values());
    const active = [...this.runtime.entries()];
    for (const [id, runtime] of active) {
      if (runtime.attached) {
        const server = this.db.getServer(id);
        if (!server || !await isManagedProcess(server.processPid, server)) continue;
        this.db.updateServer(id, { status: 'stopping' });
        try {
          await rconCommand({
            host: '127.0.0.1', port: server.rconPort,
            password: runtime.rconPassword, command: 'stop'
          });
        } catch (error) {
          this.db.addEvent(id, 'warning', `RCON shutdown failed; sending a process signal: ${safeMessage(error)}`);
          signalProcess(server.processPid, 'SIGTERM');
        }
        continue;
      }
      if (runtime.child.exitCode !== null) continue;
      this.db.updateServer(id, { status: 'stopping' });
      try {
        runtime.child.stdin.write('stop\n');
      } catch {
        runtime.child.kill('SIGTERM');
      }
    }
    await Promise.all(active.map(async ([id, runtime]) => {
      if (runtime.attached) {
        const server = this.db.getServer(id);
        if (!server?.processPid) return;
        const deadline = Date.now() + 20000;
        while (Date.now() < deadline && await isManagedProcess(server.processPid, server)) {
          if (Date.now() >= deadline - 5000) signalProcess(server.processPid, 'SIGTERM');
          if (Date.now() >= deadline - 1000) signalProcess(server.processPid, 'SIGKILL');
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        return;
      }
      const child = runtime.child;
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise((resolve) => child.once('exit', resolve));
      const gracefulTimeout = setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGTERM');
      }, 15000);
      const forceTimeout = setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
      }, 19000);
      gracefulTimeout.unref();
      forceTimeout.unref();
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 20000))]);
      clearTimeout(gracefulTimeout);
      clearTimeout(forceTimeout);
    }));
  }

  requireServer(id) {
    const server = this.db.getServer(id);
    if (!server) throw clientError('Server not found.', 404);
    return server;
  }

  events(limit = 50) {
    return this.db.listEvents(limit);
  }

  async systemInfo() {
    const { cpus, freemem, totalmem, platform, release } = await import('node:os');
    return {
      platform,
      release,
      cpuCount: cpus().length,
      memoryTotalBytes: totalmem(),
      memoryFreeBytes: freemem(),
      serverCount: this.db.listServers().length
    };
  }

  async fetchMojang(url, options) {
    try {
      return await this.fetch(url, {
        ...options,
        redirect: 'error',
        headers: { ...options.headers, 'accept-encoding': 'identity' },
      });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      if (Number.isInteger(error?.status)) throw error;
      throw clientError(`Unable to reach Mojang: ${safeMessage(error)}`, 503);
    }
  }

  async getJavaCandidates() {
    if (this.javaCandidates) return this.javaCandidates;
    const candidates = new Set();
    if (process.env.JAVA_HOME) candidates.add(path.join(process.env.JAVA_HOME, 'bin', 'java'));
    for (const directory of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
      candidates.add(path.join(directory, 'java'));
    }
    candidates.add('/usr/bin/java');
    candidates.add('/usr/local/bin/java');
    const home = os.homedir();
    const roots = [
      '/usr/lib/jvm', '/usr/java', '/opt/java', '/opt/jdk',
      path.join(home, '.jdks'),
      path.join(home, '.sdkman', 'candidates', 'java'),
      path.join(home, '.local', 'share', 'mise', 'installs', 'java'),
      path.join(home, '.asdf', 'installs', 'java')
    ];
    for (const root of roots) {
      try {
        for (const entry of await readdir(root, { withFileTypes: true })) {
          if (entry.isDirectory() || entry.isSymbolicLink()) candidates.add(path.join(root, entry.name, 'bin', 'java'));
        }
      } catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR' && error.code !== 'EACCES') throw error;
      }
    }
    return [...candidates];
  }

  assertJavaCompatibility(runtime, requiredMajor) {
    if (!Number.isInteger(requiredMajor)) {
      throw clientError('The required Java version is unavailable in the Minecraft metadata; compatibility cannot be confirmed.', 422);
    }
    if (runtime.majorVersion < requiredMajor) {
      throw clientError(
        `Minecraft requires Java ${requiredMajor} or newer, but "${runtime.path}" is Java ${runtime.majorVersion}. Select a compatible Java executable.`,
        422
      );
    }
  }

  async reconcileOrphanedProcesses() {
    for (const server of this.db.listServers()) {
      const runtime = this.runtime.get(server.id);
      if (!server.processPid || (
        server.status !== 'orphaned' &&
        server.status !== 'stopping' &&
        !(server.status === 'running' && runtime?.attached)
      )) continue;
      if (await isManagedProcess(server.processPid, server)) {
        if (runtime || (this.rconProbeAfter.get(server.id)?.next ?? 0) > Date.now()) continue;
        const probe = { next: Date.now() + 10000, warned: this.rconProbeAfter.get(server.id)?.warned ?? false };
        this.rconProbeAfter.set(server.id, probe);
        try {
          const secret = await readRconSecret(server.directory);
          if (!secret || !Number.isInteger(server.rconPort)) continue;
          await rconCommand({
            host: '127.0.0.1', port: server.rconPort, password: secret,
            command: 'list', timeoutMs: 1500
          });
          this.runtime.set(server.id, { attached: true, startedAt: null, rconPassword: secret });
          this.rconProbeAfter.delete(server.id);
          this.db.updateServer(server.id, { status: 'running', error: null });
          this.db.addEvent(server.id, 'success', 'Reattached to the verified server process through local RCON.');
        } catch (error) {
          if (!probe.warned) {
            this.db.addEvent(server.id, 'warning', `Could not reattach through RCON: ${safeMessage(error)}`);
            probe.warned = true;
          }
          continue;
        }
        continue;
      }
      this.runtime.delete(server.id);
      this.remoteLogState.delete(server.id);
      this.rconProbeAfter.delete(server.id);
      this.db.updateServer(server.id, { status: 'stopped', process_pid: null, error: null, last_stopped_at: new Date().toISOString() });
      this.db.addEvent(server.id, 'info', 'Previously running server process has stopped.');
    }
  }
}

function validateText(value, label, min, max) {
  if (typeof value !== 'string' || value.trim().length < min || value.length > max || /[\0\r\n]/.test(value)) {
    throw clientError(`${label} must be ${min}-${max} characters and cannot contain newlines.`);
  }
  return value.trim();
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw clientError(`${label} must be a JSON object.`);
  }
}

function validateMinecraftVersion(value) {
  if (typeof value !== 'string' || value.length > 40
      || !/^[A-Za-z0-9][A-Za-z0-9._+ -]*[A-Za-z0-9]$/.test(value)) {
    throw clientError('Choose a valid Minecraft version identifier.');
  }
  return value;
}

function requiredJavaMajor(version, metadata = {}) {
  const declared = metadata.javaVersion?.majorVersion;
  if (Number.isInteger(declared) && declared >= 8 && declared <= 100) return declared;
  const match = version.match(/^1\.(\d+)(?:\.|$)/);
  if (!match) return null;
  const minor = Number(match[1]);
  if (minor >= 20 && (minor > 20 || Number(version.match(/^1\.20\.(\d+)/)?.[1] ?? 0) >= 5)) return 21;
  if (minor >= 18) return 17;
  if (minor === 17) return 16;
  return 8;
}

function checkedMojangUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw clientError('Mojang supplied an invalid download URL.', 502);
  }
  if (url.protocol !== 'https:' || !ALLOWED_DOWNLOAD_HOSTS.has(url.hostname) || url.port || url.username || url.password) {
    throw clientError('Refusing a download URL outside Mojang distribution hosts.', 502);
  }
  return url;
}

function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function clientError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function managedFileOperation(operation) {
  try {
    return await operation();
  } catch (error) {
    const status = {
      EACCES: 403,
      EEXIST: 409,
      EFBIG: 413,
      EINVAL: 400,
      ELOOP: 403,
      ENOENT: 404,
      ENOTDIR: 400
    }[error?.code];
    if (!status) throw error;
    throw clientError(error.message, status);
  }
}

function normalizeEcosystemError(error) {
  if (error?.name !== 'EcosystemError') return error;
  const clientInputError = new Set([
    'INVALID_PROVIDER', 'INVALID_IDENTIFIER', 'INVALID_VERSION', 'INVALID_CONTENT_TYPE',
    'INVALID_QUERY', 'INVALID_LOADER', 'INVALID_PAGINATION'
  ]).has(error.code);
  return clientError(error.message, clientInputError ? 400 : 502);
}

function safeMessage(error) {
  return error instanceof Error ? error.message.slice(0, 500) : 'Unknown error';
}

function publicBackup(backup) {
  return {
    id: backup.id,
    serverId: backup.serverId,
    sizeBytes: backup.sizeBytes,
    createdAt: backup.createdAt,
    archive: Boolean(backup.archivePath),
    integrity: backup.archiveSha256 ? 'verified-on-use' : 'legacy'
  };
}

function publicBackupEntry(backup, sizeBytes, archive, available = true) {
  return {
    id: backup.id,
    server_id: backup.server_id,
    size_bytes: sizeBytes ?? backup.size_bytes,
    created_at: backup.created_at,
    archive,
    integrity: archive ? 'verified-on-use' : 'legacy',
    available
  };
}

async function sha256File(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

async function inspectJava(candidate) {
  if (typeof candidate !== 'string' || candidate.length === 0 || candidate.length > 512 || /[\0\r\n]/.test(candidate)) return null;
  let executable = candidate;
  try {
    if (candidate.includes(path.sep)) {
      await access(candidate, constants.X_OK);
      executable = await realpath(candidate);
    } else {
      executable = await resolveOnPath(candidate);
      if (!executable) return null;
    }
  } catch (error) {
    if (['ENOENT', 'EACCES', 'ENOTDIR'].includes(error.code)) return null;
    throw error;
  }
  const output = await probeJava(executable);
  if (!output) return null;
  const match = output.match(/(?:java|openjdk|temurin|zulu|graalvm)(?:\s+version)?\s+["']?((?:1\.)?\d+(?:[._+-][\w.-]+)?)/i)
    ?? output.match(/version\s+"((?:1\.)?\d+(?:[._+-][\w.-]+)?)"/i);
  if (!match) return null;
  const rawVersion = match[1];
  const majorVersion = Number(rawVersion.startsWith('1.') ? rawVersion.split('.')[1] : rawVersion.split(/[.+_-]/)[0]);
  if (!Number.isInteger(majorVersion) || majorVersion < 1 || majorVersion > 100) return null;
  return { path: executable, version: rawVersion, majorVersion };
}

async function resolveOnPath(command) {
  for (const directory of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, command);
    try {
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
    } catch (error) {
      if (!['ENOENT', 'EACCES', 'ENOTDIR'].includes(error.code)) throw error;
    }
  }
  return null;
}

function probeJava(executable) {
  return new Promise((resolve, reject) => {
    let output = '';
    let settled = false;
    const child = spawn(executable, ['-version'], { shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(null);
    }, 3000);
    timer.unref();
    const collect = (chunk) => {
      if (output.length < 8192) output += chunk.toString('utf8').slice(0, 8192 - output.length);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.once('error', (error) => {
      if (['ENOENT', 'EACCES', 'ENOEXEC'].includes(error.code)) finish(null);
      else {
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    });
    child.once('close', () => finish(output));
    function finish(value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    }
  });
}

async function copyDirectory(source, destination, signal) {
  checkCancelled(signal);
  await mkdir(destination, { recursive: false });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    checkCancelled(signal);
    if (entry.isSymbolicLink()) continue;
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) await copyDirectory(from, to, signal);
    else if (entry.isFile()) {
      await pipeline(createReadStream(from), createWriteStream(to, { flags: 'wx', mode: 0o600 }), ...(signal ? [{ signal }] : []));
    }
  }
}

async function mergeDirectory(source, destination, created = []) {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    const sourceInfo = await lstat(from);
    if (sourceInfo.isSymbolicLink() || (!sourceInfo.isDirectory() && !sourceInfo.isFile())) {
      throw clientError('Provider installer produced a symbolic link or special file; refusing to import it.', 422);
    }
    let destinationInfo;
    try {
      destinationInfo = await lstat(to);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (sourceInfo.isDirectory()) {
      if (destinationInfo && (!destinationInfo.isDirectory() || destinationInfo.isSymbolicLink())) {
        throw clientError(`Provider installer output conflicts with existing path "${entry.name}".`, 409);
      }
      if (!destinationInfo) {
        await mkdir(to, { mode: 0o700 });
        created.push(to);
      }
      await mergeDirectory(from, to, created);
    } else {
      if (destinationInfo) throw clientError(`Provider installer output would overwrite "${entry.name}".`, 409);
      await rename(from, to);
      created.push(to);
    }
  }
  return created;
}

async function writeImportedFiles(root, files) {
  if (!(files instanceof Map) || files.size > 4096) throw clientError('Imported content contains an invalid number of files.', 422);
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw clientError('Server directory is not safe for content installation.', 422);
  const createdFiles = [];
  const createdDirectories = [];
  let totalBytes = 0;
  try {
    for (const [relativePath, bytes] of files) {
      const segments = validateImportedPath(relativePath);
      if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) {
        throw clientError('Imported content file has invalid data.', 422);
      }
      totalBytes += bytes.byteLength;
      if (totalBytes > 512 * 1024 ** 2) throw clientError('Imported content exceeds the 512 MiB limit.', 413);
      let parent = root;
      for (const segment of segments.slice(0, -1)) {
        parent = path.join(parent, segment);
        try {
          const info = await lstat(parent);
          if (!info.isDirectory() || info.isSymbolicLink()) throw clientError('Imported content cannot follow an existing link.', 422);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          await mkdir(parent, { mode: 0o700 });
          createdDirectories.push(parent);
        }
      }
      const target = path.join(parent, segments.at(-1));
      const noFollow = constants.O_NOFOLLOW ?? 0;
      const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
      createdFiles.push(target);
      try {
        await handle.writeFile(bytes);
      } finally {
        await handle.close();
      }
    }
    return createdFiles.length;
  } catch (error) {
    for (const target of createdFiles.reverse()) await rm(target, { force: true });
    for (const directory of createdDirectories.reverse()) {
      await rm(directory, { recursive: false, force: true }).catch((cleanupError) => {
        if (cleanupError.code !== 'ENOTEMPTY' && cleanupError.code !== 'ENOENT') throw cleanupError;
      });
    }
    throw error;
  }
}

function validateImportedPath(value) {
  if (typeof value !== 'string' || value.length > 1024 || value.startsWith('/') || value.includes('\\') || value.includes('\0')) {
    throw clientError('Imported content contains an unsafe path.', 422);
  }
  const parts = value.split('/');
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
  if (parts.length > 16 || parts.some((part) =>
    !part || part === '.' || part === '..' || part.includes(':') || /[\u0000-\u001f\u007f]/u.test(part)
      || /[. ]$/u.test(part) || reserved.test(part)
  )) throw clientError('Imported content contains an unsafe path.', 422);
  return parts;
}

function runInstaller(executable, args, cwd, options = {}) {
  return new Promise((resolve, reject) => {
    checkCancelled(options.signal);
    const child = spawn(executable, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true
    });
    let output = '';
    let settled = false;
    let forceTimer;
    let terminalError;
    const cleanup = () => {
      clearTimeout(timeout);
      clearTimeout(forceTimer);
      options.signal?.removeEventListener('abort', onAbort);
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const kill = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      forceTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, 5000);
      forceTimer.unref();
    };
    const onAbort = () => {
      terminalError = new Error('Provider installation was cancelled.');
      terminalError.name = 'AbortError';
      kill();
    };
    const timeout = setTimeout(() => {
      terminalError = clientError('Provider installer exceeded the 10-minute time limit.', 408);
      kill();
    }, 10 * 60 * 1000);
    timeout.unref();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    const collect = (chunk) => {
      if (output.length < 8192) output = (output + chunk.toString('utf8')).slice(-8192);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.once('error', (error) => finish(terminalError ?? error));
    child.once('exit', (code, signal) => {
      if (terminalError) finish(terminalError);
      else if (code === 0) finish();
      else finish(clientError(`Provider installer failed (${signal ? `signal ${signal}` : `exit code ${code}`}): ${output.slice(-1000)}`, 502));
    });
  });
}

function neoForgeVersionPrefix(minecraftVersion) {
  const match = minecraftVersion.match(/^1\.(\d{1,3})(?:\.(\d{1,3}))?/);
  if (!match) {
    const current = minecraftVersion.match(/^(\d{2,3})\.(\d{1,3})/);
    return current ? `${current[1]}.${current[2]}.` : `${minecraftVersion}.`;
  }
  return `${match[1]}.${match[2] ?? '0'}.`;
}

async function readSystemCpuTicks() {
  if (process.platform !== 'linux') return null;
  try {
    const [line] = (await readFile('/proc/stat', 'utf8')).split('\n');
    const values = line.trim().split(/\s+/).slice(1).map(Number);
    return values.slice(0, 8).reduce((sum, value) => sum + value, 0);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EACCES') return null;
    throw error;
  }
}

async function readProcessMetrics(pid) {
  const [statLine, status] = await Promise.all([
    readFile(`/proc/${pid}/stat`, 'utf8'),
    readFile(`/proc/${pid}/status`, 'utf8')
  ]);
  const fields = statLine.slice(statLine.lastIndexOf(')') + 2).trim().split(/\s+/);
  const cpuTicks = Number(fields[11]) + Number(fields[12]);
  const rssMatch = status.match(/^VmRSS:\s+(\d+)\s+kB$/m);
  const memoryBytes = rssMatch ? Number(rssMatch[1]) * 1024 : null;
  if (!Number.isFinite(cpuTicks)) throw new Error(`Unable to parse process CPU counters for PID ${pid}.`);
  return { cpuTicks, memoryBytes };
}

async function waitForStatus(predicate, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw clientError('The scheduled server state transition timed out.', 408);
}

function combineSignals(signal, timeout) {
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function checkCancelled(signal) {
  if (signal?.aborted) {
    const error = new Error('Operation was cancelled.');
    error.name = 'AbortError';
    throw error;
  }
}

async function directorySize(directory) {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) total += await directorySize(entryPath);
    else if (entry.isFile()) total += (await stat(entryPath)).size;
  }
  return total;
}

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const probe = createNetServer();
    probe.once('error', () => resolve(false));
    probe.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
      probe.close((error) => resolve(!error));
    });
  });
}

async function assertInstalledJar(filename, label) {
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.size === 0) {
    throw clientError(`${label} installer did not produce a valid JAR.`);
  }
}

async function isManagedProcess(pid, server) {
  if (!Number.isInteger(pid) || pid < 2 || process.platform !== 'linux') return false;
  try {
    const commandLine = await readFile(`/proc/${pid}/cmdline`, 'utf8');
    const launcherJar = server.software === 'fabric' ? 'fabric-server-launch.jar'
      : server.software === 'quilt' ? 'quilt-server-launch.jar' : 'server.jar';
    const launchedByJar = [launcherJar, 'server.jar'].some((jarName) =>
      commandLine.includes(`\0-jar\0${path.join(server.directory, jarName)}\0`)
    );
    if (launchedByJar) return true;
    if (!['forge', 'neoforge'].includes(server.software) || !server.softwareVersion) return false;
    const argumentFile = server.software === 'forge'
      ? path.join(server.directory, 'libraries', 'net', 'minecraftforge', 'forge', server.softwareVersion, 'unix_args.txt')
      : path.join(server.directory, 'libraries', 'net', 'neoforged', 'neoforge', server.softwareVersion, 'unix_args.txt');
    return commandLine.includes(`\0@${argumentFile}\0`);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EACCES') return false;
    throw error;
  }
}

function signalProcess(pid, signal) {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function publicServer(server) {
  const { directory, processPid, rconPort, ...visible } = server;
  return visible;
}

async function readRconSecret(directory) {
  const secretPath = path.join(directory, '.panel-rcon-secret');
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const handle = await open(secretPath, constants.O_RDONLY | noFollow);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > 128) {
      throw clientError('Managed RCON credential file is not a safe regular file.', 422);
    }
    const secret = (await handle.readFile('utf8')).trim();
    if (!/^[A-Za-z0-9_-]{40,60}$/.test(secret)) {
      throw clientError('Managed RCON credential file contains invalid data.', 422);
    }
    return secret;
  } finally {
    await handle.close();
  }
}
