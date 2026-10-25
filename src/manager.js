import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import net from "node:net";
import dgram from "node:dgram";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { db } from "./database.js";
import { backupRoot, dataDir, serverRoot } from "./config.js";
import {
  checkJava, installServer, listBedrockVersions, listFabricLoaderVersions, listFabricMinecraftVersions,
  listForgeMinecraftVersions, listNeoForgeVersions, listPaperVersions, listPurpurVersions,
  listQuiltLoaderVersions, listQuiltMinecraftVersions, requiredJavaMajor,
} from "./minecraft.js";
import {
  getModrinthProject, installCurseForgeProject, installModrinthProject, listCompatibleProjectVersions,
  installCurseForgeModpack, listCurseForgeModpackVersions, listCurseForgeProjectVersions,
  listInstalledProjects, removeInstalledProject, rollbackModrinthProject, searchCurseForge,
  searchCurseForgeModpacks, searchModrinth, updateModrinthProject,
} from "./providers.js";

const instances = new Map();
const terminalStates = new Map();
const operationState = new Map();
const jobControllers = new Map();
let shuttingDown = false;
const supervisorPath = fileURLToPath(new URL("./process-supervisor.js", import.meta.url));

export function beginShutdown() {
  shuttingDown = true;
}

async function serverBackupDirectory(id, create = false) {
  if (!validId(id)) throw new Error("Invalid server identifier");
  if (create) await fs.mkdir(backupRoot, { recursive: true, mode: 0o700 });
  const rootStat = await fs.lstat(backupRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Backup storage root is invalid");
  const directory = path.join(backupRoot, id);
  if (create) await fs.mkdir(directory, { mode: 0o700 }).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
  try {
    const directoryStat = await fs.lstat(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || path.dirname(directory) !== backupRoot) {
      throw new Error("Server backup directory is invalid");
    }
    return directory;
  } catch (error) {
    if (!create || error.code !== "ENOENT") throw error;
    return null;
  }
}

export function setAutoRestart(serverId, enabled) {
  if (!serverQuery.get(serverId)) throw new Error("Server not found");
  if (typeof enabled !== "boolean") throw new Error("Automatic restart setting must be a boolean");
  db.prepare("UPDATE servers SET auto_restart = ? WHERE id = ?").run(Number(enabled), serverId);
  return getServer(serverId);
}

export async function queryOnlinePlayers(serverId) {
  const instance = instances.get(serverId);
  if (!instance || !["running", "starting"].includes(instance.status)) throw new Error("Server is not running");
  if (instance.listQuery) throw new Error("A player-list query is already in progress");
  return new Promise(async (resolve, reject) => {
    let timer;
    const unsubscribe = subscribe(serverId, (text) => {
      const response = /There are (\d+) of a max of \d+ players online(?::\s*(.*))?/i.exec(text);
      if (!response) return;
      clearTimeout(timer);
      unsubscribe();
      instance.listQuery = false;
      resolve({ count: Number(response[1]), players: response[2]?.split(",").map((name) => name.trim()).filter(Boolean) ?? [] });
    });
    instance.listQuery = true;
    timer = setTimeout(() => {
      unsubscribe();
      instance.listQuery = false;
      reject(new Error("Timed out waiting for the server's actual list response"));
    }, 5000);
    try {
      await sendCommand(serverId, "list");
    } catch (error) {
      clearTimeout(timer);
      unsubscribe();
      instance.listQuery = false;
      reject(error);
    }
  });
}

async function udpPortAvailable(server, port = server.bedrock_port, ipv6 = false) {
  return new Promise((resolve, reject) => {
    const address = ipv6 ? "::" : server.bind_address;
    const socket = dgram.createSocket(net.isIPv6(address) ? "udp6" : "udp4");
    socket.once("error", (error) => {
      socket.close();
      if (error.code === "EADDRINUSE" || error.code === "EACCES") resolve(false);
      else if (ipv6 && error.code === "EADDRNOTAVAIL") resolve(true);
      else reject(error);
    });
    socket.bind({ address, port, exclusive: true }, () => {
      socket.close((error) => error ? reject(error) : resolve(true));
    });
  });
}

async function queryCommandOutput(serverId, command, pattern, timeoutMs = 5000) {
  const instance = instances.get(serverId);
  if (!instance || !["running", "starting"].includes(instance.status)) throw new Error("Server is not running");
  if (instance.telemetryQuery) throw new Error("A telemetry query is already in progress");
  return new Promise((resolve, reject) => {
    let timer;
    let pending = "";
    const unsubscribe = subscribe(serverId, (text) => {
      pending = (pending + text).slice(-4096);
      const match = pattern.exec(pending);
      if (!match) return;
      clearTimeout(timer);
      unsubscribe();
      instance.telemetryQuery = false;
      resolve(match);
    });
    instance.telemetryQuery = true;
    timer = setTimeout(() => {
      unsubscribe();
      instance.telemetryQuery = false;
      reject(new Error(`Timed out waiting for the server's ${command} response`));
    }, timeoutMs);
    sendCommand(serverId, command).catch((error) => {
      clearTimeout(timer);
      unsubscribe();
      instance.telemetryQuery = false;
      reject(error);
    });
  });
}

export async function queryServerTelemetry(serverId) {
  const server = serverQuery.get(serverId);
  if (!server) throw new Error("Server not found");
  if (!["paper", "purpur"].includes(server.loader ?? server.software)) {
    throw new Error("TPS/MSPT queries require Paper or Purpur software");
  }
  const tpsResponse = await queryCommandOutput(serverId, "tps",
    /TPS from last [^:]+:\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)/i);
  const msptResponse = await queryCommandOutput(serverId, "mspt",
    /(?:Average|Mean) tick time:\s*([\d.]+)\s*ms/i);
  const tps = tpsResponse.slice(1, 4).map(Number);
  const mspt = Number(msptResponse[1]);
  if (tps.some((value) => !Number.isFinite(value) || value < 0 || value > 20.1) ||
      !Number.isFinite(mspt) || mspt < 0 || mspt > 60000) {
    throw new Error("Server telemetry response contained out-of-range values");
  }
  const instance = instances.get(serverId);
  if (instance) {
    instance.tps = tps;
    instance.mspt = mspt;
  }
  return { tps, mspt };
}

const validPlayerName = /^[A-Za-z0-9_]{1,16}$/;
const resolvedProfiles = new Map();

function formatUuid(bytes) {
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function offlinePlayerUuid(name) {
  const bytes = createHash("md5").update(`OfflinePlayer:${name}`, "utf8").digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x30;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return formatUuid(bytes);
}

export async function resolvePlayerProfile(serverId, player) {
  const server = serverQuery.get(serverId);
  if (!server) throw new Error("Server not found");
  if (!validPlayerName.test(player ?? "")) throw new Error("Player name must contain 1-16 letters, numbers, or underscores");
  if (!server.online_mode) {
    return {
      name: player,
      uuid: offlinePlayerUuid(player),
      identity_type: "offline-derived",
      identity_warning: "Offline-mode UUIDs are derived from names and do not prove player identity.",
    };
  }
  const cached = resolvedProfiles.get(player.toLowerCase());
  if (cached && cached.expiresAt > Date.now()) return cached.profile;
  const response = await fetch(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(player)}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(10000),
    redirect: "error",
  });
  if (response.status === 204 || response.status === 404) throw new Error("No Mojang profile exists for that player name");
  if (!response.ok) throw new Error(`Mojang profile lookup failed with HTTP ${response.status}`);
  if (new URL(response.url).hostname !== "api.mojang.com") throw new Error("Mojang profile lookup redirected to an untrusted host");
  const body = await response.json();
  if (body.name?.toLowerCase() !== player.toLowerCase() || !/^[0-9a-f]{32}$/i.test(body.id ?? "")) {
    throw new Error("Mojang returned invalid player profile metadata");
  }
  const profile = {
    name: body.name,
    uuid: formatUuid(Buffer.from(body.id, "hex")),
    identity_type: "mojang",
    identity_warning: null,
  };
  resolvedProfiles.set(player.toLowerCase(), { profile, expiresAt: Date.now() + 5 * 60 * 1000 });
  return profile;
}

export async function playerAction(serverId, action, player, reason = "") {
  if (!validPlayerName.test(player ?? "")) throw new Error("Player name must contain 1-16 letters, numbers, or underscores");
  if (typeof reason !== "string" || reason.length > 160 || /[\r\n\0"\\;]/.test(reason)) {
    throw new Error("Reason must be at most 160 characters and contain no quotes, slashes, or line breaks");
  }
  const commands = {
    kick: "kick", ban: "ban", pardon: "pardon", whitelistAdd: "whitelist add",
    whitelistRemove: "whitelist remove", op: "op", deop: "deop",
  };
  if (!commands[action]) throw new Error("Unsupported player action");
  const command = `${commands[action]} ${player}${["kick", "ban"].includes(action) && reason ? ` ${reason}` : ""}`;
  await sendCommand(serverId, command);
}

export async function getPlayerRecords(serverId) {
  const server = serverQuery.get(serverId);
  if (!server) throw new Error("Server not found");
  if (instances.has(serverId)) throw new Error("Stop the server before reading permission files");
  const directory = await serverDirectory(serverId);
  const files = ["whitelist.json", "ops.json", "banned-players.json"];
  const result = {};
  for (const filename of files) {
    try {
      const stat = await fs.lstat(path.join(directory, filename));
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error(`${filename} is not a safe regular file`);
      const records = JSON.parse(await fs.readFile(path.join(directory, filename), "utf8"));
      if (!Array.isArray(records)) throw new Error(`${filename} must contain a JSON array`);
      result[filename] = records;
    } catch (error) {
      if (error.code === "ENOENT") result[filename] = [];
      else throw error;
    }
  }
  return result;
}

function validatePermissionRecords(filename, records) {
  if (!["whitelist.json", "ops.json", "banned-players.json"].includes(filename)) {
    throw new Error("Unsupported permission file");
  }
  if (!Array.isArray(records) || records.length > 10000) throw new Error("Permission records must be an array of at most 10,000 entries");
  const seen = new Set();
  return records.map((record) => {
    if (!record || typeof record !== "object" || Array.isArray(record) ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record.uuid ?? "") ||
        !validPlayerName.test(record.name ?? "")) {
      throw new Error("Each permission record must contain a valid UUID and Minecraft player name");
    }
    const key = record.uuid.toLowerCase();
    if (seen.has(key)) throw new Error("Permission records cannot contain duplicate UUIDs");
    seen.add(key);
    if (filename === "whitelist.json") return { uuid: key, name: record.name };
    if (filename === "ops.json") {
      if (!Number.isInteger(record.level) || record.level < 1 || record.level > 4 ||
          typeof record.bypassesPlayerLimit !== "boolean") {
        throw new Error("Operator records require a permission level from 1 to 4 and a boolean player-limit setting");
      }
      return { uuid: key, name: record.name, level: record.level, bypassesPlayerLimit: record.bypassesPlayerLimit };
    }
    for (const field of ["created", "source", "expires", "reason"]) {
      if (typeof record[field] !== "string" || record[field].length > 256 || /[\0\r\n]/.test(record[field])) {
        throw new Error(`Banned-player records require a safe ${field} string`);
      }
    }
    return { uuid: key, name: record.name, created: record.created, source: record.source, expires: record.expires, reason: record.reason };
  });
}

export async function updatePlayerRecords(serverId, filename, records) {
  const server = serverQuery.get(serverId);
  if (!server) throw new Error("Server not found");
  if (instances.has(serverId)) throw new Error("Stop the server before editing permission files");
  const validated = validatePermissionRecords(filename, records);
  const directory = await serverDirectory(serverId);
  const target = path.join(directory, filename);
  try {
    const stat = await fs.lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${filename} is not a safe regular file`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const temporary = path.join(directory, `.${filename}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await fs.rename(temporary, target);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
  return { filename, records: validated };
}

export function getServerHistory(serverId, limit = 240) {
  if (!serverQuery.get(serverId)) throw new Error("Server not found");
  if (!Number.isInteger(limit) || limit < 1 || limit > 1440) throw new Error("History limit must be 1-1440");
  const metrics = db.prepare(`SELECT cpu_percent, memory_mb, disk_bytes, players, tps_1m, mspt, sampled_at
    FROM metrics_history WHERE server_id = ? ORDER BY id DESC LIMIT ?`).all(serverId, limit).reverse();
  const crashes = db.prepare(`SELECT exit_code, occurred_at FROM crash_history
    WHERE server_id = ? ORDER BY id DESC LIMIT 20`).all(serverId);
  return { metrics, crashes };
}

export async function getWorlds(serverId) {
  const directory = await serverDirectory(serverId);
  const entries = await fs.readdir(directory, { withFileTypes: true });
  let levelName = "world";
  try {
    const properties = await fs.readFile(path.join(directory, "server.properties"), "utf8");
    const match = /^level-name=(.+)$/m.exec(properties);
    if (match && validWorldName.test(match[1])) levelName = match[1];
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const worlds = entries.filter((entry) => entry.isDirectory() &&
    [levelName, `${levelName}_nether`, `${levelName}_the_end`].includes(entry.name));
  return Promise.all(worlds.map(async (entry) => ({
    name: entry.name,
    path: entry.name,
    size_bytes: await diskUsage(path.join(directory, entry.name)),
  })));
}

const validWorldName = /^[A-Za-z0-9_-]{1,64}$/;

export async function listWorldBackups(serverId) {
  if (!serverQuery.get(serverId)) throw new Error("Server not found");
  return db.prepare(`SELECT id, world_name, filename, created_at FROM world_backups
    WHERE server_id = ? ORDER BY created_at DESC, rowid DESC`).all(serverId);
}

async function createWorldArchive(serverId, worldName) {
  if (!validWorldName.test(worldName ?? "")) throw new Error("Invalid world folder name");
  const server = serverQuery.get(serverId);
  if (!server) throw new Error("Server not found");
  const directory = await serverDirectory(serverId);
  const worldPath = path.join(directory, worldName);
  const worldStat = await fs.lstat(worldPath);
  if (!worldStat.isDirectory() || worldStat.isSymbolicLink()) throw new Error("World folder is not a regular directory");
  const backups = await serverBackupDirectory(serverId, true);
  const id = randomUUID();
  const filename = `${serverId}-${worldName}-${id}.world.tar.gz`;
  const destination = path.join(backups, filename);
  const child = spawn("tar", ["-czf", destination, "--", worldName], {
    cwd: directory, stdio: ["ignore", "ignore", "pipe"], shell: false,
  });
  let errorOutput = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => (errorOutput = (errorOutput + chunk).slice(-4096)));
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (exitCode !== 0) {
    await fs.rm(destination, { force: true });
    throw new Error(`World backup failed: ${errorOutput.trim() || `tar exited with ${exitCode}`}`);
  }
  try {
    await inspectWorldArchive(destination, worldName);
  } catch (error) {
    await fs.rm(destination, { force: true });
    throw error;
  }
  db.prepare("INSERT INTO world_backups(id,server_id,world_name,filename) VALUES(?,?,?,?)")
    .run(id, serverId, worldName, filename);
  return { id, world_name: worldName, filename, created_at: new Date().toISOString() };
}

async function createWorldBackupInternal(serverId, worldName) {
  if (instances.has(serverId)) throw new Error("Stop the server before creating a consistent world backup");
  return createWorldArchive(serverId, worldName);
}

export const createWorldBackup = withServerOperation("backing up world", createWorldBackupInternal);

function sendCommandAndWait(serverId, command, responsePattern, timeoutMs = 120000) {
  const instance = instances.get(serverId);
  if (!instance || instance.status !== "running") throw new Error("Server is not running");
  return new Promise((resolve, reject) => {
    let pending = "";
    const unsubscribe = subscribe(serverId, (text) => {
      pending = (pending + text).slice(-8192);
      const match = responsePattern.exec(pending);
      if (!match) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(match);
    });
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out waiting for server response to ${command}`));
    }, timeoutMs);
    sendCommand(serverId, command).catch((error) => {
      clearTimeout(timer);
      unsubscribe();
      reject(error);
    });
  });
}

async function createLiveWorldSnapshotInternal(serverId, worldName) {
  const instance = instances.get(serverId);
  if (!instance || instance.status !== "running") throw new Error("Live world snapshots require a running server");
  if (!validWorldName.test(worldName ?? "")) throw new Error("Invalid world folder name");
  let saveOffRequested = false;
  let snapshot;
  let snapshotError;
  let saveOnError;
  try {
    saveOffRequested = true;
    await sendCommandAndWait(serverId, "save-off", /automatic saving is now disabled/i);
    await sendCommandAndWait(serverId, "save-all flush", /saved the game/i);
    snapshot = await createWorldArchive(serverId, worldName);
  } catch (error) {
    snapshotError = error;
  } finally {
    if (saveOffRequested && instances.has(serverId)) {
      try {
        await sendCommandAndWait(serverId, "save-on", /automatic saving is now enabled/i, 15000);
      } catch (error) {
        saveOnError = error;
      }
    }
  }
  if (saveOnError) {
    const detail = snapshotError ? `Snapshot failed: ${snapshotError.message}. ` : "";
    throw new Error(`${detail}Could not confirm that automatic world saving was re-enabled; check the server console immediately. ${saveOnError.message}`);
  }
  if (snapshotError) throw snapshotError;
  return { ...snapshot, consistent_snapshot: true };
}

export const createLiveWorldSnapshot = withServerOperation("taking live world snapshot", createLiveWorldSnapshotInternal);

export async function getWorldBackupDownload(serverId, backupId) {
  if (!serverQuery.get(serverId)) throw new Error("Server not found");
  const backup = db.prepare("SELECT filename FROM world_backups WHERE id = ? AND server_id = ?").get(backupId, serverId);
  if (!backup || path.basename(backup.filename) !== backup.filename || !backup.filename.endsWith(".world.tar.gz")) {
    throw new Error("World backup not found");
  }
  const directory = await serverBackupDirectory(serverId);
  const filename = path.join(directory, backup.filename);
  const stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("World backup file is invalid");
  return { path: filename, filename: backup.filename, size: stat.size };
}

async function inspectWorldArchive(archive, worldName) {
  const listing = spawn("tar", ["-tzf", archive], { stdio: ["ignore", "pipe", "pipe"], shell: false });
  let entriesText = "";
  let listingError = "";
  listing.stdout.setEncoding("utf8");
  listing.stderr.setEncoding("utf8");
  listing.stdout.on("data", (chunk) => {
    entriesText += chunk;
    if (entriesText.length > 20 * 1024 * 1024) listing.kill("SIGKILL");
  });
  listing.stderr.on("data", (chunk) => { listingError = (listingError + chunk).slice(-4096); });
  const listingCode = await new Promise((resolve, reject) => {
    listing.once("error", reject);
    listing.once("close", resolve);
  });
  if (listingCode !== 0) throw new Error(`Could not inspect world archive: ${listingError.trim()}`);
  const entries = entriesText.split("\n").filter(Boolean);
  if (!entries.length || entries.length > 200000) throw new Error("World archive has an invalid number of entries");
  for (const entry of entries) {
    const normalized = entry.endsWith("/") ? entry.slice(0, -1) : entry;
    if (entry.includes("\\") || /[\0\r\n]/.test(entry) || path.posix.isAbsolute(normalized) ||
        (normalized !== worldName && !normalized.startsWith(`${worldName}/`)) ||
        normalized.split("/").some((part) => !part || part === "." || part === "..") ||
        !/^[A-Za-z0-9 _./-]+$/.test(normalized)) {
      throw new Error("World archive contains an unsafe or unexpected path");
    }
  }
  const types = spawn("tar", ["--quoting-style=escape", "-tvzf", archive], {
    stdio: ["ignore", "pipe", "pipe"], shell: false,
  });
  let typesText = "";
  let typesError = "";
  types.stdout.setEncoding("utf8");
  types.stderr.setEncoding("utf8");
  types.stdout.on("data", (chunk) => {
    typesText += chunk;
    if (typesText.length > 20 * 1024 * 1024) types.kill("SIGKILL");
  });
  types.stderr.on("data", (chunk) => { typesError = (typesError + chunk).slice(-4096); });
  const typesCode = await new Promise((resolve, reject) => {
    types.once("error", reject);
    types.once("close", resolve);
  });
  if (typesCode !== 0) throw new Error(`Could not inspect world archive entry types: ${typesError.trim()}`);
  const typesList = typesText.split("\n").filter(Boolean);
  if (typesList.length !== entries.length || typesList.some((line) => !/^[\-d]/.test(line))) {
    throw new Error("World archive contains a symbolic link or special file");
  }
  let unpackedBytes = 0;
  for (const line of typesList) {
    const size = /^[\-d][^\s]*\s+\S+\s+(\d+)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+/.exec(line);
    if (!size) throw new Error("World archive has invalid size metadata");
    unpackedBytes += Number(size[1]);
    if (!Number.isSafeInteger(unpackedBytes) || unpackedBytes > 20 * 1024 ** 3) {
      throw new Error("World archive exceeds the 20 GiB expanded-size limit");
    }
  }
  return unpackedBytes;
}

async function restoreWorldBackupInternal(serverId, backupId) {
  if (instances.has(serverId)) throw new Error("Stop the server before importing a world backup");
  const server = serverQuery.get(serverId);
  if (!server) throw new Error("Server not found");
  const backup = db.prepare("SELECT world_name, filename FROM world_backups WHERE id = ? AND server_id = ?").get(backupId, serverId);
  if (!backup || !validWorldName.test(backup.world_name) || path.basename(backup.filename) !== backup.filename) {
    throw new Error("World backup not found");
  }
  const backups = await serverBackupDirectory(serverId);
  const archive = path.join(backups, backup.filename);
  const archiveStat = await fs.lstat(archive);
  if (!archiveStat.isFile() || archiveStat.isSymbolicLink()) throw new Error("World backup file is invalid");
  const directory = await serverDirectory(serverId);
  const expandedBytes = await inspectWorldArchive(archive, backup.world_name);
  const disk = await fs.statfs(directory);
  if (disk.bavail * disk.bsize < expandedBytes + 100 * 1024 * 1024) {
    throw new Error("Insufficient free space to restore this world safely");
  }
  const staging = path.join(directory, `.panel-world-import-${randomUUID()}`);
  const stagedWorld = path.join(staging, backup.world_name);
  await fs.mkdir(staging, { mode: 0o700 });
  const child = spawn("tar", ["-xzf", archive, "--no-same-owner", "-C", staging], {
    stdio: ["ignore", "ignore", "pipe"], shell: false,
  });
  let errorOutput = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => (errorOutput = (errorOutput + chunk).slice(-4096)));
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  }).catch(async (error) => {
    await fs.rm(staging, { recursive: true, force: true });
    throw error;
  });
  if (exitCode !== 0) {
    await fs.rm(staging, { recursive: true, force: true });
    throw new Error(`World import failed: ${errorOutput.trim() || `tar exited with ${exitCode}`}`);
  }
  let stagedStat;
  try {
    stagedStat = await fs.lstat(stagedWorld);
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true });
    throw error;
  }
  if (!stagedStat.isDirectory() || stagedStat.isSymbolicLink()) {
    await fs.rm(staging, { recursive: true, force: true });
    throw new Error("World archive does not contain its expected world directory");
  }
  const destination = path.join(directory, backup.world_name);
  const previous = path.join(directory, `.panel-world-previous-${randomUUID()}`);
  let movedPrevious = false;
  let installed = false;
  try {
    try {
      const currentStat = await fs.lstat(destination);
      if (!currentStat.isDirectory() || currentStat.isSymbolicLink()) throw new Error("Current world path is not a regular directory");
      await fs.rename(destination, previous);
      movedPrevious = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await fs.rename(stagedWorld, destination);
    installed = true;
  } catch (error) {
    if (installed) await fs.rm(destination, { recursive: true, force: true });
    if (movedPrevious) await fs.rename(previous, destination);
    throw error;
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
  if (movedPrevious) await fs.rm(previous, { recursive: true, force: true });
  return { world_name: backup.world_name, restored: true };
}

export const restoreWorldBackup = withServerOperation("importing world", restoreWorldBackupInternal);

async function importWorldArchiveInternal(serverId, relativeArchivePath, worldName) {
  if (instances.has(serverId)) throw new Error("Stop the server before importing a world");
  if (!validWorldName.test(worldName ?? "")) throw new Error("Invalid world folder name");
  const server = serverQuery.get(serverId);
  if (!server) throw new Error("Server not found");
  const root = await serverDirectory(serverId);
  const archive = resolveRelative(root, relativeArchivePath);
  if (archive === root || path.basename(archive) !== relativeArchivePath.split(/[\\/]/).at(-1) ||
      !archive.endsWith(".tar.gz")) throw new Error("World import requires a .tar.gz archive inside the server directory");
  await assertPathNoSymlink(root, archive);
  const archiveStat = await fs.lstat(archive);
  if (!archiveStat.isFile() || archiveStat.isSymbolicLink() || archiveStat.size > 100 * 1024 * 1024) {
    throw new Error("World archive must be a regular file no larger than 100 MB");
  }
  await inspectWorldArchive(archive, worldName);
  const backups = await serverBackupDirectory(serverId, true);
  const id = randomUUID();
  const filename = `${serverId}-${worldName}-${id}.world.tar.gz`;
  const storedArchive = path.join(backups, filename);
  await fs.copyFile(archive, storedArchive, fsSync.constants.COPYFILE_EXCL);
  db.prepare("INSERT INTO world_backups(id,server_id,world_name,filename) VALUES(?,?,?,?)")
    .run(id, serverId, worldName, filename);
  let worldImported = false;
  try {
    const restored = await restoreWorldBackupInternal(serverId, id);
    worldImported = true;
    await fs.rm(archive);
    return { ...restored, backup_id: id };
  } catch (error) {
    if (!worldImported) {
      db.prepare("DELETE FROM world_backups WHERE id = ? AND server_id = ?").run(id, serverId);
      await fs.rm(storedArchive, { force: true });
    } else {
      throw new Error(`World imported, but the uploaded archive could not be removed: ${error.message}`);
    }
    throw error;
  }
}

export const importWorldArchive = withServerOperation("importing world", importWorldArchiveInternal);

function diskUsage(directory) {
  return new Promise((resolve, reject) => {
    const child = spawn("du", ["-sb", "--", directory], { stdio: ["ignore", "pipe", "pipe"], shell: false });
    let output = "";
    let errorOutput = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { output = (output + chunk).slice(-1024); });
    child.stderr.on("data", (chunk) => { errorOutput = (errorOutput + chunk).slice(-2048); });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) return reject(new Error(`Could not calculate directory size: ${errorOutput.trim()}`));
      const size = /^(\d+)\s/.exec(output);
      if (!size) return reject(new Error("Directory size command returned invalid output"));
      resolve(Number(size[1]));
    });
  });
}
const serversQuery = db.prepare("SELECT * FROM servers ORDER BY created_at DESC");
const serverQuery = db.prepare("SELECT * FROM servers WHERE id = ?");
const usedNames = db.prepare("SELECT id FROM servers WHERE id = ?");

function processStartTicks(pid) {
  const stat = fsSync.readFileSync(`/proc/${pid}/stat`, "utf8");
  return stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/)[19];
}

function validJavaArgFileLaunch(args) {
  return Array.isArray(args) && args.length === 3 &&
    args[0] === "@user_jvm_args.txt" &&
    /^@libraries\/net\/(?:minecraftforge\/forge|neoforged\/neoforge)\/[A-Za-z0-9._+-]{1,128}\/unix_args\.txt$/.test(args[1]) &&
    args[2] === "nogui";
}

function processIdentityMatches(server) {
  if (!Number.isInteger(server.pid) || !server.process_start_ticks || !server.process_boot_id) return false;
  try {
    if (fsSync.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() !== server.process_boot_id ||
        processStartTicks(server.pid) !== server.process_start_ticks) return false;
    if (process.getuid && Number(/^Uid:\s+(\d+)/m.exec(fsSync.readFileSync(`/proc/${server.pid}/status`, "utf8"))?.[1]) !== process.getuid()) return false;
    const directory = fsSync.realpathSync(`/proc/${server.pid}/cwd`);
    const expected = fsSync.realpathSync(path.join(serverRoot, server.id));
    if (directory !== expected) return false;
    const command = fsSync.readFileSync(`/proc/${server.pid}/cmdline`, "utf8").split("\0");
    const marker = JSON.parse(fsSync.readFileSync(path.join(expected, "server-panel.json"), "utf8"));
    if (typeof marker.executable === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(marker.executable)) {
      return fsSync.realpathSync(`/proc/${server.pid}/exe`) === fsSync.realpathSync(path.join(expected, marker.executable));
    }
    if (typeof marker.jar === "string" && command.some((argument, index) =>
      argument === "-jar" && command[index + 1] === marker.jar)) return true;
    return validJavaArgFileLaunch(marker.java_args) &&
      marker.java_args.filter((argument) => argument.startsWith("@")).every((argument) => command.includes(argument));
  } catch {
    return false;
  }
}

export function refreshRecoveredProcesses() {
  for (const server of serversQuery.all()) {
    if (instances.has(server.id)) continue;
    if (server.pid && processIdentityMatches(server)) {
      terminalStates.set(server.id, { status: "orphaned", lastExitCode: null });
    } else if (server.pid) {
      db.prepare("UPDATE servers SET pid = NULL, process_start_ticks = NULL, process_boot_id = NULL WHERE id = ?").run(server.id);
      terminalStates.delete(server.id);
    }
  }
}
refreshRecoveredProcesses();

export async function reattachRecoveredProcesses() {
  for (const server of serversQuery.all()) {
    if (!server.pid || instances.has(server.id) || !processIdentityMatches(server)) continue;
    const socketPath = path.join(dataDir, "run", `${server.id}.sock`);
    try {
      const child = await connectSupervisor(socketPath, server.pid);
      if (!processIdentityMatches(server)) {
        child.socket.destroy();
        continue;
      }
      const instance = watchManagedProcess(server, child, true);
      if (child.exitCode === null && child.signalCode === null) {
        instance.status = /Done \(/.test(child.recoveryHistory) ? "running" : "starting";
        terminalStates.delete(server.id);
      }
    } catch (error) {
      console.error(`Could not reattach to recovered server ${server.id}:`, error.message);
      terminalStates.set(server.id, { status: "orphaned", lastExitCode: null });
    }
  }
}

export function serializeServer(server) {
  const instance = instances.get(server.id);
  const operation = operationState.get(server.id);
  return {
    ...server,
    eula_accepted: Boolean(server.eula_accepted),
    crossplay: Boolean(server.crossplay),
    auto_restart: Boolean(server.auto_restart),
    operation: operation ?? null,
    status: instance?.status ?? (operation === "starting" ? "starting" :
      operation === "installing" || operation === "restoring" ? "updating" :
        terminalStates.get(server.id)?.status ?? "stopped"),
    pid: instance?.child.pid ?? (terminalStates.get(server.id)?.status === "orphaned" ? server.pid : null),
    uptime_seconds: instance?.startedAt ? Math.floor((Date.now() - instance.startedAt) / 1000) : 0,
    players: instance?.playersKnown ? instance.players.size : null,
    online_players: instance?.playersKnown ? [...instance.players] : null,
    memory_mb: instance?.memoryMb ?? null,
    cpu_percent: instance?.cpuPercent ?? null,
    tps: instance?.tps ?? null,
    mspt: instance?.mspt ?? null,
    last_exit_code: instance?.lastExitCode ?? terminalStates.get(server.id)?.lastExitCode ?? null,
  };
}

function withServerOperation(name, action) {
  return async (...args) => {
    const serverId = args[0];
    if (operationState.has(serverId)) {
      throw new Error(`Cannot ${name} while ${operationState.get(serverId)} is in progress`);
    }
    operationState.set(serverId, name);
    try {
      return await action(...args);
    } finally {
      operationState.delete(serverId);
    }
  };
}

export function getServers() {
  refreshRecoveredProcesses();
  return serversQuery.all().map(serializeServer);
}

export function getLanAddresses() {
  return Object.values(os.networkInterfaces()).flatMap((interfaces) => (interfaces ?? [])
    .filter((network) => !network.internal && (network.family === "IPv4" || network.family === 4))
    .map((network) => network.address));
}

export function getServer(id) {
  refreshRecoveredProcesses();
  const server = serverQuery.get(id);
  if (!server) return undefined;
  return serializeServer(server);
}

export async function searchProjects(serverId, options = {}) {
  const server = serverQuery.get(serverId);
  if (!server) throw new Error("Server not found");
  if (!["modrinth", "curseforge"].includes(options.source ?? "modrinth")) throw new Error("Unsupported project provider");
  if (options.source === "curseforge") return searchCurseForge(server, options);
  return searchModrinth(server, options);
}

export async function getProject(serverId, projectId, type = "mod") {
  const server = serverQuery.get(serverId);
  if (!server) throw new Error("Server not found");
  return getModrinthProject(server, projectId, type);
}

export async function getProjectVersions(serverId, projectId, type = "mod", source = "modrinth") {
  const server = serverQuery.get(serverId);
  if (!server) throw new Error("Server not found");
  if (!["modrinth", "curseforge"].includes(source)) throw new Error("Unsupported project provider");
  if (source === "curseforge" && type !== "mod") throw new Error("CurseForge plugin discovery is not supported");
  if (source === "curseforge") return listCurseForgeProjectVersions(server, projectId);
  return listCompatibleProjectVersions(server, projectId, type);
}

export async function searchModpacks(serverId, options = {}) {
  const server = serverQuery.get(serverId);
  if (!server) throw new Error("Server not found");
  if (options.source !== "curseforge") throw new Error("Only CurseForge modpack discovery is supported");
  return searchCurseForgeModpacks(server, options);
}

export async function getModpackVersions(serverId, projectId) {
  const server = serverQuery.get(serverId);
  if (!server) throw new Error("Server not found");
  return listCurseForgeModpackVersions(server, projectId);
}

export async function getInstalledProjects(serverId, type = "mod") {
  const server = serverQuery.get(serverId);
  if (!server) throw new Error("Server not found");
  return listInstalledProjects(server, await serverDirectory(serverId), type);
}

async function installProjectInternal(serverId, projectId, versionId, type = "mod", source = "modrinth") {
  if (instances.has(serverId)) throw new Error("Stop the server before installing projects");
  const server = serverQuery.get(serverId);
  if (!server) throw new Error("Server not found");
  if (!["modrinth", "curseforge"].includes(source)) throw new Error("Unsupported project provider");
  if (source === "curseforge" && type !== "mod") throw new Error("CurseForge plugin installation is not supported");
  if (source === "curseforge") {
    return installCurseForgeProject(server, await serverDirectory(serverId), projectId, versionId);
  }
  return installModrinthProject(server, await serverDirectory(serverId), projectId, versionId, type);
}

export const installProject = withServerOperation("project installation", installProjectInternal);

async function installModpackInternal(serverId, projectId, fileId) {
  if (instances.has(serverId)) throw new Error("Stop the server before installing a modpack");
  const server = serverQuery.get(serverId);
  if (!server) throw new Error("Server not found");
  return installCurseForgeModpack(server, await serverDirectory(serverId), projectId, fileId);
}

export const installModpack = withServerOperation("modpack installation", installModpackInternal);

async function updateProjectInternal(serverId, projectId, type = "mod") {
  if (instances.has(serverId)) throw new Error("Stop the server before updating projects");
  const server = serverQuery.get(serverId);
  if (!server) throw new Error("Server not found");
  return updateModrinthProject(server, await serverDirectory(serverId), projectId, type);
}

export const updateProject = withServerOperation("project update", updateProjectInternal);

async function rollbackProjectInternal(serverId, projectId, type = "mod") {
  if (instances.has(serverId)) throw new Error("Stop the server before rolling back projects");
  const server = serverQuery.get(serverId);
  if (!server) throw new Error("Server not found");
  return rollbackModrinthProject(server, await serverDirectory(serverId), projectId, type);
}

export const rollbackProject = withServerOperation("project rollback", rollbackProjectInternal);

async function removeProjectInternal(serverId, filename, type = "mod") {
  if (instances.has(serverId)) throw new Error("Stop the server before removing projects");
  const server = serverQuery.get(serverId);
  if (!server) throw new Error("Server not found");
  return removeInstalledProject(server, await serverDirectory(serverId), filename, type);
}

export const removeProject = withServerOperation("project removal", removeProjectInternal);

function validId(id) {
  return typeof id === "string" && /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/.test(id);
}

function findManagedPortConflict(ports, exceptServerId = null) {
  const candidates = [...new Set(ports)];
  const placeholders = candidates.map(() => "?").join(", ");
  const exclusion = exceptServerId ? "id != ? AND " : "";
  const parameters = [...(exceptServerId ? [exceptServerId] : []), ...candidates, ...candidates, ...candidates];
  return db.prepare(`SELECT id FROM servers WHERE ${exclusion}
    (port IN (${placeholders}) OR bedrock_port IN (${placeholders}) OR
      (loader = 'bedrock' AND port + 1 IN (${placeholders})))`).get(...parameters);
}

function validateConfiguration(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Expected server configuration");
  const { name, id, description = "", version, software, port, bind_address = "0.0.0.0",
    max_players = 20, min_memory_mb = 1024, max_memory_mb = 2048, java_path = "java",
    auto_restart = false, online_mode = true, view_distance = 10, simulation_distance = 10 } = input;
  const crossplay = input.crossplay ?? false;
  const bedrockPort = input.bedrock_port ?? (crossplay ? 19132 : null);
  const requestedLoader = input.loader ?? software;
  const storedSoftware = software === "purpur" ? "paper" :
    ["fabric", "quilt", "forge", "neoforge", "bedrock"].includes(software) ? "vanilla" : software;
  const compatibleLoader = {
    vanilla: "vanilla", paper: "paper", purpur: "purpur", fabric: "fabric",
    quilt: "quilt", forge: "forge", neoforge: "neoforge", bedrock: "bedrock",
  }[software];
  if (typeof name !== "string" || name.trim().length < 1 || name.trim().length > 64 || /[\r\n\0]/.test(name)) {
    throw new Error("Server name must be 1-64 characters and contain no line breaks");
  }
  if (!validId(id)) throw new Error("Server identifier must use lowercase letters, numbers, and hyphens");
  if (usedNames.get(id)) throw new Error("That server identifier is already in use");
  if (typeof version !== "string" || !/^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/.test(version)) {
    throw new Error("Choose a valid Minecraft version identifier");
  }
  if (!compatibleLoader || requestedLoader !== compatibleLoader) {
    throw new Error("Supported server software: Bedrock Dedicated Server, Vanilla, Paper, Purpur, Fabric, Quilt, Forge, and NeoForge");
  }
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Server port must be between 1024 and 65535");
  if (typeof crossplay !== "boolean") throw new Error("Cross-play setting must be a boolean");
  if (crossplay && !["paper", "purpur"].includes(requestedLoader)) {
    throw new Error("Automatic Java/Bedrock cross-play currently requires Paper or Purpur");
  }
  if (crossplay && (!Number.isInteger(bedrockPort) || bedrockPort < 1024 || bedrockPort > 65534 || bedrockPort === port)) {
    throw new Error("Bedrock cross-play UDP port must be between 1024 and 65534 and differ from the Java port");
  }
  if (requestedLoader === "bedrock" && port > 65534) {
    throw new Error("Bedrock Dedicated Server reserves the next port for IPv6; choose a port no higher than 65534");
  }
  if (!crossplay && bedrockPort !== null) throw new Error("A separate Bedrock UDP port is only valid when cross-play is enabled");
  if (!Number.isInteger(max_players) || max_players < 1 || max_players > 1000) throw new Error("Maximum players must be between 1 and 1000");
  if (!Number.isInteger(min_memory_mb) || !Number.isInteger(max_memory_mb) ||
      min_memory_mb < 512 || max_memory_mb < min_memory_mb || max_memory_mb > Math.floor(os.totalmem() / 1024 / 1024 * 0.9)) {
    throw new Error("Memory must be at least 512 MB, initial memory cannot exceed maximum, and maximum must be below 90% of system RAM");
  }
  if (typeof description !== "string" || description.length > 500) throw new Error("Description must be at most 500 characters");
  if (typeof bind_address !== "string" || !net.isIP(bind_address)) throw new Error("Bind address must be an IPv4 or IPv6 address");
  if (requestedLoader !== "bedrock" &&
      (typeof java_path !== "string" || java_path.length < 1 || java_path.length > 4096 || java_path.includes("\0"))) {
    throw new Error("Java path is invalid");
  }
  if (typeof auto_restart !== "boolean") throw new Error("Automatic restart must be a boolean");
  if (typeof online_mode !== "boolean") throw new Error("Online mode must be a boolean");
  if (!Number.isInteger(view_distance) || view_distance < 2 || view_distance > 32) throw new Error("View distance must be between 2 and 32 chunks");
  if (!Number.isInteger(simulation_distance) || simulation_distance < 2 || simulation_distance > 32) {
    throw new Error("Simulation distance must be between 2 and 32 chunks");
  }
  return {
    id, name: name.trim(), description, version, software: storedSoftware, loader: requestedLoader, port, bind_address,
    max_players, min_memory_mb, max_memory_mb, java_path, auto_restart, online_mode, view_distance, simulation_distance,
    crossplay, bedrock_port: bedrockPort,
  };
}

export async function createServer(input) {
  const config = validateConfiguration(input);
  if (config.loader === "bedrock" && !(await listBedrockVersions()).some((version) => version.id === config.version)) {
    throw new Error(`Official Bedrock Dedicated Server does not list version ${config.version}`);
  }
  const servicePorts = config.loader === "bedrock"
    ? [config.port, config.port + 1]
    : [config.port, ...(config.crossplay ? [config.bedrock_port] : [])];
  if (findManagedPortConflict(servicePorts)) {
    throw new Error("A configured Java or Bedrock port number is already assigned to another server");
  }
  if (config.loader === "bedrock" && !await udpPortAvailable(config, config.port + 1, true)) {
    throw new Error(`Bedrock IPv6 port ${config.port + 1} is already in use on ${config.bind_address}`);
  }
  if (config.loader === "paper" && !new Set(await listPaperVersions()).has(config.version)) {
    throw new Error(`Paper does not support Minecraft ${config.version}`);
  }
  if (config.loader === "purpur" && !new Set(await listPurpurVersions()).has(config.version)) {
    throw new Error(`Purpur does not support Minecraft ${config.version}`);
  }
  if (config.loader === "fabric") {
    if (!new Set(await listFabricMinecraftVersions()).has(config.version)) {
      throw new Error(`Fabric does not support stable Minecraft ${config.version}`);
    }
    if (!(await listFabricLoaderVersions(config.version)).length) {
      throw new Error(`No stable Fabric loader is available for Minecraft ${config.version}`);
    }
  }
  if (config.loader === "quilt") {
    if (!new Set(await listQuiltMinecraftVersions()).has(config.version)) {
      throw new Error(`Quilt does not support stable Minecraft ${config.version}`);
    }
    if (!(await listQuiltLoaderVersions(config.version)).length) {
      throw new Error(`No Quilt loader is available for Minecraft ${config.version}`);
    }
  }
  if (config.loader === "forge" && !new Set(await listForgeMinecraftVersions()).has(config.version)) {
    throw new Error(`Forge does not support Minecraft ${config.version}`);
  }
  if (config.loader === "neoforge" && !(await listNeoForgeVersions(config.version)).length) {
    throw new Error(`NeoForge does not support Minecraft ${config.version}`);
  }
  await fs.mkdir(serverRoot, { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(serverRoot, config.id), { mode: 0o700 });
  let inserted = false;
  try {
    db.prepare(`INSERT INTO servers(id,name,description,version,software,loader,port,bind_address,max_players,min_memory_mb,max_memory_mb,java_path,auto_restart,online_mode,view_distance,simulation_distance,crossplay,bedrock_port)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      config.id, config.name, config.description, config.version, config.software, config.loader, config.port,
      config.bind_address, config.max_players, config.min_memory_mb, config.max_memory_mb,
      config.loader === "bedrock" ? "" : config.java_path, Number(config.auto_restart),
      Number(config.online_mode), config.view_distance, config.simulation_distance,
      Number(config.crossplay), config.bedrock_port,
    );
    inserted = true;
    if (config.loader !== "bedrock") await fs.writeFile(path.join(serverRoot, config.id, "server.properties"), [
      "# Generated by Byte Server Panel; edit in the Configuration tab",
      `motd=${config.name}`,
      `server-ip=${config.bind_address === "0.0.0.0" ? "" : config.bind_address}`,
      `server-port=${config.port}`,
      `max-players=${config.max_players}`,
      `online-mode=${config.online_mode}`,
      `view-distance=${config.view_distance}`,
      `simulation-distance=${config.simulation_distance}`,
      "",
    ].join("\n"), { mode: 0o600, flag: "wx" });
  } catch (error) {
    if (inserted) db.prepare("DELETE FROM servers WHERE id = ?").run(config.id);
    await fs.rm(path.join(serverRoot, config.id), { recursive: true, force: true });
    throw error;
  }
  return getServer(config.id);
}

async function deleteServerInternal(id) {
  const server = serverQuery.get(id);
  if (!server) throw new Error("Server not found");
  if (instances.has(id)) throw new Error("Stop the server before deleting it");
  const directory = await serverDirectory(id);
  const trash = path.join(serverRoot, `.deleting-${randomUUID()}`);
  const backupDirectory = path.join(backupRoot, id);
  const backupTrash = path.join(backupRoot, `.deleting-${id}-${randomUUID()}`);
  let movedBackup = false;
  await fs.rename(directory, trash);
  try {
    try {
      const backupStat = await fs.lstat(backupDirectory);
      if (!backupStat.isDirectory() || backupStat.isSymbolicLink()) throw new Error("Backup directory is invalid");
      await fs.rename(backupDirectory, backupTrash);
      movedBackup = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    db.prepare("DELETE FROM servers WHERE id = ?").run(id);
  } catch (error) {
    await fs.rename(trash, directory);
    if (movedBackup) await fs.rename(backupTrash, backupDirectory);
    throw error;
  }
  await fs.rm(trash, { recursive: true, force: true });
  if (movedBackup) await fs.rm(backupTrash, { recursive: true, force: true });
}

export const deleteServer = withServerOperation("delete", deleteServerInternal);

async function serverDirectory(id) {
  if (!validId(id)) throw new Error("Invalid server identifier");
  const directory = path.join(serverRoot, id);
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || path.dirname(directory) !== serverRoot) {
    throw new Error("Server directory is invalid");
  }
  return directory;
}

async function portAvailable(server) {
  if (server.loader === "bedrock") {
    return udpPortAvailable(server, server.port);
  }
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once("error", (error) => {
      if (error.code === "EADDRINUSE" || error.code === "EACCES") resolve(false);
      else reject(error);
    });
    listener.listen({ host: server.bind_address, port: server.port, exclusive: true }, () => {
      listener.close((error) => error ? reject(error) : resolve(true));
    });
  });
}

async function installInternal(serverId, options = {}) {
  const server = serverQuery.get(serverId);
  if (!server) throw new Error("Server not found");
  if (instances.has(serverId)) throw new Error("Stop the server before installing or updating it");
  const directory = await serverDirectory(serverId);
  const installation = await installServer(server, directory, options);
  const { filename, javaMajor, executable, crossplay } = installation;
  if (options.signal?.aborted) {
    if (filename) await fs.rm(path.join(directory, filename), { force: true });
    throw new DOMException("Installation cancelled", "AbortError");
  }
  await fs.writeFile(path.join(directory, "server-panel.json"), JSON.stringify({
    ...(filename ? { jar: filename } : {}),
    ...(executable ? { executable, args: [] } : {}),
    ...(installation.javaArgs ? { java_args: installation.javaArgs } : {}),
    software: server.software, loader: server.loader, version: installation.version ?? server.version, java_major: javaMajor,
    ...(crossplay ? { crossplay: true, bedrock_port: server.bedrock_port } : {}),
    ...(installation.loaderVersion ? { loader_version: installation.loaderVersion } : {}),
    ...(installation.installerVersion ? { installer_version: installation.installerVersion } : {}),
  }, null, 2), { mode: 0o600 });
  if (installation.version) {
    db.prepare("UPDATE servers SET version = ? WHERE id = ?").run(installation.version, serverId);
  }
  return { filename, java_major: javaMajor };
}

export const install = withServerOperation("installing", installInternal);

export function getJob(jobId) {
  if (typeof jobId !== "string" || !/^[0-9a-f-]{36}$/.test(jobId)) throw new Error("Invalid job identifier");
  const job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId);
  if (!job) throw new Error("Job not found");
  return job;
}

export function queueInstall(serverId) {
  const server = serverQuery.get(serverId);
  if (!server) throw new Error("Server not found");
  if (operationState.has(serverId)) throw new Error(`Cannot install while ${operationState.get(serverId)} is in progress`);
  const jobId = randomUUID();
  const controller = new AbortController();
  db.prepare("INSERT INTO jobs(id,server_id,type,status,message) VALUES(?,?,?,'queued','Waiting to install server software')")
    .run(jobId, serverId, "install");
  jobControllers.set(jobId, controller);
  operationState.set(serverId, "installing");
  setImmediate(async () => {
    if (controller.signal.aborted) {
      db.prepare("UPDATE jobs SET status = 'cancelled', message = 'Installation cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(jobId);
      jobControllers.delete(jobId);
      if (operationState.get(serverId) === "installing") operationState.delete(serverId);
      return;
    }
    db.prepare("UPDATE jobs SET status = 'running', message = 'Downloading and verifying server software', updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(jobId);
    try {
      let lastProgress = -1;
      let lastUpdate = 0;
      const result = await installInternal(serverId, {
        signal: controller.signal,
        onProgress: (bytes, total, message) => {
          const progress = total > 0 ? Math.min(99, Math.floor(bytes / total * 100)) : lastProgress;
          const now = Date.now();
          if (progress === lastProgress && now - lastUpdate < 1000) return;
          lastProgress = progress;
          lastUpdate = now;
          if (message) {
            db.prepare(`UPDATE jobs SET progress = ?, message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
              .run(progress, message, jobId);
            return;
          }
          const downloadedMb = (bytes / 1024 / 1024).toFixed(1);
          const totalText = total > 0 ? ` of ${(total / 1024 / 1024).toFixed(1)} MB` : "";
          db.prepare(`UPDATE jobs SET progress = ?, message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
            .run(progress, `Downloaded ${downloadedMb} MB${totalText}`, jobId);
        },
      });
      db.prepare(`UPDATE jobs SET status = 'completed', progress = 100, message = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`).run(`Installed ${result.filename ?? "server runtime"}`, jobId);
    } catch (error) {
      const cancelled = controller.signal.aborted || error.name === "AbortError";
      db.prepare(`UPDATE jobs SET status = ?, error = ?, message = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`).run(
        cancelled ? "cancelled" : "failed",
        error.message,
        cancelled ? "Installation cancelled" : "Installation failed",
        jobId,
      );
    } finally {
      jobControllers.delete(jobId);
      if (operationState.get(serverId) === "installing") operationState.delete(serverId);
    }
  });
  return getJob(jobId);
}

export function retryJob(jobId) {
  const job = getJob(jobId);
  if (job.type !== "install" || !["failed", "interrupted", "cancelled"].includes(job.status)) {
    throw new Error("Only a failed, interrupted, or cancelled server installation can be retried");
  }
  return queueInstall(job.server_id);
}

export function cancelJob(jobId) {
  const job = getJob(jobId);
  if (job.type !== "install" || !["queued", "running"].includes(job.status)) {
    throw new Error("Only a queued or running server installation can be cancelled");
  }
  const controller = jobControllers.get(jobId);
  if (!controller) throw new Error("This job is not active in the current panel process");
  controller.abort();
  return getJob(jobId);
}

export async function acceptEula(serverId, accepted) {
  if (operationState.has(serverId)) throw new Error(`Cannot accept the EULA while ${operationState.get(serverId)} is in progress`);
  if (accepted !== true) throw new Error("Explicitly accept the Minecraft EULA to enable starting this server");
  const server = serverQuery.get(serverId);
  if (!server) throw new Error("Server not found");
  const directory = await serverDirectory(serverId);
  await fs.writeFile(path.join(directory, "eula.txt"), "# Accepted explicitly in Minecraft Server Control Panel\neula=true\n", { mode: 0o600 });
  db.prepare("UPDATE servers SET eula_accepted = 1 WHERE id = ?").run(serverId);
  return getServer(serverId);
}

function trackLog(instance, chunk) {
  const text = chunk.toString("utf8");
  instance.logBuffer += text;
  if (instance.logBuffer.length > 30000) instance.logBuffer = instance.logBuffer.slice(-20000);
  const lines = (instance.pendingText + text).split(/\r?\n/);
  instance.pendingText = lines.pop().slice(-4096);
  for (const line of lines) {
    if (/\] \[Server thread\/INFO\].*Done \(/.test(line) ||
        (instance.loader === "bedrock" && /\bServer started\b/i.test(line))) {
      instance.status = "running";
      db.prepare("UPDATE servers SET restart_count = 0, last_started_at = CURRENT_TIMESTAMP WHERE id = ?").run(instance.serverId);
    }
    const joined = /: ([A-Za-z0-9_]{1,16}) joined the game/.exec(line);
    const left = /: ([A-Za-z0-9_]{1,16}) left the game/.exec(line);
    if (joined) {
      instance.playersKnown = true;
      instance.players.add(joined[1]);
    }
    if (left) {
      instance.playersKnown = true;
      instance.players.delete(left[1]);
    }
    const tps = /TPS from last [^:]+:\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)/i.exec(line);
    if (tps) instance.tps = tps.slice(1).map(Number);
    const mspt = /(?:average|avg)[^0-9]*([\d.]+)\s*mspt/i.exec(line);
    if (mspt) instance.mspt = Number(mspt[1]);
  }
  for (const listener of instance.listeners) listener(text);
}

function supervisorClient(socket, pid = null) {
  const child = new EventEmitter();
  child.pendingSupervisorMessages = [];
  child.pendingSupervisorExit = null;
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.stdin = {
    destroyed: false,
    get writable() { return !this.destroyed && socket.writable; },
    write(text, callback) {
      if (this.destroyed || !socket.writable) {
        const error = new Error("Server console connection is unavailable");
        callback?.(error);
        return false;
      }
      const accepted = socket.write(`${JSON.stringify({ type: "command", command: text })}\n`, callback);
      return accepted;
    },
  };
  child.kill = (signal = "SIGTERM") => {
    if (!socket.destroyed) socket.write(`${JSON.stringify({ type: "signal", signal })}\n`);
    return true;
  };
  child.socket = socket;
  child.dispatchSupervisorMessage = (message) => {
    if (child.listenerCount("message")) child.emit("message", message);
    else child.pendingSupervisorMessages.push(message);
  };
  child.dispatchSupervisorExit = (code, signal) => {
    child.exitCode = code;
    child.signalCode = signal;
    child.stdin.destroyed = true;
    if (child.listenerCount("close")) child.emit("close", code, signal);
    else child.pendingSupervisorExit = { code, signal };
  };
  child.flushSupervisorEvents = () => {
    for (const message of child.pendingSupervisorMessages.splice(0)) child.emit("message", message);
    if (child.pendingSupervisorExit) {
      const { code, signal } = child.pendingSupervisorExit;
      child.pendingSupervisorExit = null;
      child.emit("close", code, signal);
    }
  };
  return child;
}

async function connectSupervisor(socketPath, expectedPid) {
  const socket = await new Promise((resolve, reject) => {
    let settled = false;
    let buffer = "";
    let onData;
    const connection = net.createConnection(socketPath);
    const timeout = setTimeout(() => finish(new Error("Timed out connecting to the server process supervisor")), 5000);
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (onData) connection.off("data", onData);
      if (error) {
        connection.destroy();
        reject(error);
      } else resolve(result);
    };
    connection.setEncoding("utf8");
    connection.once("error", (error) => finish(error));
    onData = (chunk) => {
      buffer = (buffer + chunk).slice(-40000);
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          finish(new Error("Server supervisor returned malformed control data"));
          return;
        }
        if (message.type !== "ready") continue;
        if (!Number.isInteger(message.pid) || (expectedPid && message.pid !== expectedPid) ||
            typeof message.history !== "string" || message.history.length > 30000) {
          finish(new Error("Server supervisor identity or recovery data is invalid"));
          return;
        }
        finish(null, { connection, message, buffered: buffer });
        return;
      }
    };
    connection.on("data", onData);
  });
  const child = supervisorClient(socket.connection, socket.message.pid);
  child.recoveryHistory = socket.message.history;
  let buffered = socket.buffered;
  let closedByExit = false;
  const consume = (chunk) => {
    buffered = (buffered + chunk).slice(-40000);
    let newline;
    while ((newline = buffered.indexOf("\n")) !== -1) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        child.emit("message", { type: "error", message: "Server supervisor sent malformed control data" });
        continue;
      }
      if (message.type === "exit") {
        closedByExit = true;
        child.dispatchSupervisorExit(message.code, message.signal);
      } else {
        child.dispatchSupervisorMessage(message);
      }
    }
  };
  socket.connection.on("data", consume);
  socket.connection.once("close", () => {
    child.stdin.destroyed = true;
    child.emit("disconnect", closedByExit);
  });
  if (buffered) consume("");
  return child;
}

async function launchSupervisor(server, directory, marker) {
  const runtime = path.join(dataDir, "run");
  await fs.mkdir(runtime, { recursive: true, mode: 0o700 });
  await fs.chmod(runtime, 0o700);
  const socketPath = path.join(runtime, `${server.id}.sock`);
  await fs.rm(socketPath, { force: true });
  const executable = marker.executable
    ? path.join(directory, marker.executable)
    : server.java_path;
  const javaArgs = marker.java_args ?? (marker.executable ? marker.args ?? [] : ["-jar", marker.jar, "nogui"]);
  const args = marker.executable ? javaArgs : [
    `-Xms${server.min_memory_mb}M`, `-Xmx${server.max_memory_mb}M`, ...javaArgs,
  ];
  const configuration = {
    socketPath, cwd: directory, logPath: path.join(directory, "logs", "panel-console.log"),
    command: executable, args,
    ...(marker.executable ? { env: { LD_LIBRARY_PATH: directory } } : {}),
  };
  const supervisor = spawn(process.execPath, [supervisorPath, JSON.stringify(configuration)], {
    cwd: directory, stdio: "ignore", detached: true, shell: false,
  });
  supervisor.unref();
  supervisor.once("error", (error) => console.error(`Could not start process supervisor for ${server.id}:`, error));
  const deadline = Date.now() + 5000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const child = await connectSupervisor(socketPath, null);
      return child;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  supervisor.kill("SIGTERM");
  throw new Error(`Could not connect to server process supervisor: ${lastError?.message ?? "timed out"}`);
}

function watchManagedProcess(server, child, recovered = false) {
  const instance = {
    child, serverId: server.id, loader: server.loader, status: "starting",
    startedAt: recovered && server.last_started_at ? Date.parse(`${server.last_started_at.replace(" ", "T")}Z`) : Date.now(),
    players: new Set(), playersKnown: false, pendingText: "",
    memoryMb: null, cpuPercent: null, tps: null, mspt: null, lastExitCode: null,
    logBuffer: "", listeners: new Set(), cpuPrevious: null, stopRequested: false,
  };
  instances.set(server.id, instance);
  child.on("message", (message) => {
    if (message.type === "log" && typeof message.text === "string") {
      trackLog(instance, Buffer.from(message.text));
    } else if (message.type === "error") {
      console.error(`Server process error for ${server.id}:`, message.message);
    }
  });
  if (child.recoveryHistory) trackLog(instance, Buffer.from(child.recoveryHistory));
  child.flushSupervisorEvents();
  child.once("error", (error) => {
    instance.status = "crashed";
    instance.lastExitCode = error.message;
    terminalStates.set(server.id, { status: "crashed", lastExitCode: error.message });
  });
  child.once("close", (code, signal) => {
    instance.status = instance.stopRequested || code === 0 ? "stopped" : "crashed";
    instance.lastExitCode = code ?? signal;
    terminalStates.set(server.id, { status: instance.status, lastExitCode: instance.lastExitCode });
    if (instance.status === "crashed") {
      db.prepare("INSERT INTO crash_history(server_id,exit_code) VALUES(?,?)").run(server.id, String(instance.lastExitCode));
    }
    db.prepare("UPDATE servers SET pid = NULL, process_start_ticks = NULL, process_boot_id = NULL WHERE id = ?")
      .run(server.id);
    const serverRecord = serverQuery.get(server.id);
    if (instance.status === "crashed" && !instance.stopRequested && serverRecord?.auto_restart) {
      const result = db.prepare(`UPDATE servers SET restart_count = restart_count + 1
        WHERE id = ? AND restart_count < 3`).run(server.id);
      if (result.changes) {
        const timer = setTimeout(() => {
          startServer(server.id).catch((error) => console.error(`Automatic restart failed for ${server.id}:`, error));
        }, 5000);
        timer.unref();
      } else {
        console.error(`Automatic restart limit reached for ${server.id}`);
      }
    }
    instance.startedAt = 0;
    if (instances.get(server.id) === instance) instances.delete(server.id);
  });
  child.once("disconnect", (receivedExit) => {
    if (receivedExit || instances.get(server.id) !== instance) return;
    instance.status = "orphaned";
    terminalStates.set(server.id, { status: "orphaned", lastExitCode: null });
    instances.delete(server.id);
  });
  return instance;
}

async function startServerInternal(serverId) {
  if (shuttingDown) throw new Error("The panel is shutting down and will not start a server");
  const server = serverQuery.get(serverId);
  if (!server) throw new Error("Server not found");
  if (instances.has(serverId)) throw new Error("Server is already running");
  if (terminalStates.get(serverId)?.status === "orphaned") {
    throw new Error("A previously managed process is still running; stop it before starting another instance");
  }
  if (!server.eula_accepted) throw new Error("Accept the EULA before starting the server");
  const directory = await serverDirectory(serverId);
  const marker = JSON.parse(await fs.readFile(path.join(directory, "server-panel.json"), "utf8").catch(() => "null"));
  if (typeof marker?.executable === "string" && server.loader === "bedrock") {
    const executablePath = path.join(directory, marker.executable);
    const executableStat = await fs.lstat(executablePath);
    if (path.basename(marker.executable) !== marker.executable ||
        !/^[A-Za-z0-9._-]{1,128}$/.test(marker.executable) ||
        !executableStat.isFile() || executableStat.isSymbolicLink() || (executableStat.mode & 0o111) === 0 ||
        marker.executable !== "bedrock_server" || !Array.isArray(marker.args) || marker.args.length !== 0) {
      throw new Error("Installed Bedrock server executable is missing or invalid");
    }
  } else if (typeof marker?.jar === "string") {
    const jar = path.join(directory, marker.jar);
    const jarStat = await fs.lstat(jar);
    if (path.basename(marker.jar) !== marker.jar || !/^[A-Za-z0-9._-]+\.jar$/.test(marker.jar) ||
        !jarStat.isFile() || jarStat.isSymbolicLink()) {
      throw new Error("Installed server jar is missing or invalid");
    }
  } else if (validJavaArgFileLaunch(marker?.java_args)) {
    for (const argument of marker.java_args.filter((value) => value.startsWith("@"))) {
      const relative = argument.slice(1);
      const file = resolveRelative(directory, relative);
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) {
        throw new Error("Installed Java argument file is missing or invalid");
      }
    }
  } else {
    throw new Error("Install the server software before starting it");
  }
  const javaMajor = Number.isInteger(marker.java_major) && marker.java_major >= 8 && marker.java_major <= 99
    ? marker.java_major
    : requiredJavaMajor(server.version);
  if (server.loader !== "bedrock") await checkJava(server.java_path, javaMajor);
  if (!await portAvailable(server)) throw new Error(`Port ${server.port} is already in use on ${server.bind_address}`);
  if (server.loader === "bedrock" && !await udpPortAvailable(server, server.port + 1, true)) {
    throw new Error(`Bedrock IPv6 port ${server.port + 1} is already in use`);
  }
  if (server.crossplay && !await udpPortAvailable(server)) {
    throw new Error(`Bedrock cross-play UDP port ${server.bedrock_port} is already in use on ${server.bind_address}`);
  }
  if (shuttingDown) throw new Error("The panel is shutting down and will not start a server");
  await fs.mkdir(path.join(directory, "logs"), { recursive: true, mode: 0o700 });
  let child;
  try {
    child = await launchSupervisor(server, directory, marker);
  } catch (error) {
    throw error;
  }
  try {
    const bootId = fsSync.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    const startTicks = processStartTicks(child.pid);
    db.prepare(`UPDATE servers SET pid = ?, process_start_ticks = ?, process_boot_id = ?
      WHERE id = ?`).run(child.pid, startTicks, bootId, serverId);
  } catch (error) {
    child.kill("SIGTERM");
    throw new Error(`Could not persist process identity: ${error.message}`);
  }
  watchManagedProcess(server, child);
  terminalStates.set(serverId, { status: "starting", lastExitCode: null });
  return getServer(serverId);
}

export const startServer = withServerOperation("starting", startServerInternal);

export async function stopServer(serverId, force = false) {
  const instance = instances.get(serverId);
  if (!instance) {
    const server = serverQuery.get(serverId);
    if (!server || terminalStates.get(serverId)?.status !== "orphaned" || !processIdentityMatches(server)) {
      throw new Error("Server is not running");
    }
    process.kill(server.pid, force ? "SIGKILL" : "SIGTERM");
    const deadline = Date.now() + (force ? 3000 : 10000);
    while (Date.now() < deadline && processIdentityMatches(server)) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (processIdentityMatches(server)) {
      if (!force) {
        process.kill(server.pid, "SIGKILL");
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      if (processIdentityMatches(server)) throw new Error("Recovered process did not stop");
    }
    db.prepare("UPDATE servers SET pid = NULL, process_start_ticks = NULL, process_boot_id = NULL WHERE id = ?")
      .run(serverId);
    terminalStates.set(serverId, { status: "stopped", lastExitCode: null });
    return true;
  }
  const waitForExit = (timeoutMs) => new Promise((resolve) => {
    if (instance.child.exitCode !== null || instance.child.signalCode !== null) return resolve(true);
    instance.child.once("close", () => resolve(true));
    setTimeout(() => resolve(false), timeoutMs).unref();
  });
  if (force) {
    instance.status = "stopping";
    instance.stopRequested = true;
    instance.child.kill("SIGKILL");
    await waitForExit(3000);
  } else {
    instance.status = "stopping";
    instance.stopRequested = true;
    if (!instance.child.stdin.destroyed && instance.child.stdin.writable) instance.child.stdin.write("stop\n");
    if (!await waitForExit(15000)) {
      instance.child.kill("SIGTERM");
      if (!await waitForExit(3000)) {
        instance.child.kill("SIGKILL");
        await waitForExit(3000);
      }
    }
  }
  return true;
}

export async function restartServer(serverId) {
  if (!instances.has(serverId)) throw new Error("Server is not running");
  await stopServer(serverId);
  if (instances.has(serverId)) throw new Error("The server did not exit; restart was cancelled");
  return startServer(serverId);
}

export function sendCommand(serverId, command) {
  const instance = instances.get(serverId);
  if (!instance || !["starting", "running"].includes(instance.status)) throw new Error("Server is not accepting commands");
  if (typeof command !== "string" || !command.trim() || command.length > 2048 || /[\r\n\0]/.test(command)) {
    throw new Error("Command must be a single line of at most 2048 characters");
  }
  return new Promise((resolve, reject) => {
    instance.child.stdin.write(`${command}\n`, (error) => error ? reject(error) : resolve());
  });
}

export async function getLog(serverId) {
  const instance = instances.get(serverId);
  if (instance?.logBuffer) return instance.logBuffer;
  const directory = await serverDirectory(serverId);
  const filename = path.join(directory, "logs", "panel-console.log");
  try {
    const file = await fs.open(filename, "r");
    try {
      const { size } = await file.stat();
      const length = Math.min(size, 128 * 1024);
      const buffer = Buffer.alloc(length);
      await file.read(buffer, 0, length, size - length);
      return buffer.toString("utf8");
    } finally {
      await file.close();
    }
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

export function subscribe(serverId, listener) {
  const instance = instances.get(serverId);
  if (!instance) return () => {};
  instance.listeners.add(listener);
  return () => instance.listeners.delete(listener);
}

function processMetrics(pid) {
  try {
    const status = requireRead(`/proc/${pid}/status`);
    const rss = /^VmRSS:\s+(\d+)/m.exec(status);
    const stat = requireRead(`/proc/${pid}/stat`);
    const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
    const ticks = Number(fields[11]) + Number(fields[12]);
    const previous = metrics.get(pid);
    const now = Date.now();
    const cpuPercent = previous ? Math.max(0, (ticks - previous.ticks) / (now - previous.time) * 100000 / os.cpus().length) : 0;
    metrics.set(pid, { ticks, time: now });
    return { memoryMb: rss ? Math.round(Number(rss[1]) / 1024) : null, cpuPercent: Math.round(cpuPercent * 10) / 10 };
  } catch {
    return { memoryMb: null, cpuPercent: null };
  }
}

const metrics = new Map();
function requireRead(filename) {
  return fsSync.readFileSync(filename, "utf8");
}

setInterval(() => {
  for (const instance of instances.values()) {
    if (instance.child.pid) Object.assign(instance, processMetrics(instance.child.pid));
  }
}, 3000).unref();

let metricsSampleRunning = false;
setInterval(async () => {
  if (metricsSampleRunning) return;
  metricsSampleRunning = true;
  try {
    for (const server of serversQuery.all()) {
      const instance = instances.get(server.id);
      const diskBytes = await diskUsage(await serverDirectory(server.id));
      db.prepare(`INSERT INTO metrics_history(server_id,cpu_percent,memory_mb,disk_bytes,players,tps_1m,mspt)
        VALUES(?,?,?,?,?,?,?)`).run(
        server.id,
        instance?.cpuPercent ?? null,
        instance?.memoryMb ?? null,
        diskBytes,
        instance?.playersKnown ? instance.players.size : null,
        instance?.tps?.[0] ?? null,
        instance?.mspt ?? null,
      );
      db.prepare(`DELETE FROM metrics_history WHERE server_id = ? AND id NOT IN
        (SELECT id FROM metrics_history WHERE server_id = ? ORDER BY id DESC LIMIT 43200)`).run(server.id, server.id);
    }
  } catch (error) {
    console.error("Could not sample server metrics:", error);
  } finally {
    metricsSampleRunning = false;
  }
}, 60000).unref();

async function createBackupInternal(serverId) {
  const server = serverQuery.get(serverId);
  if (!server) throw new Error("Server not found");
  if (instances.has(serverId)) throw new Error("Stop the server before creating a consistent backup");
  const directory = await serverDirectory(serverId);
  const backups = await serverBackupDirectory(serverId, true);
  const id = randomUUID();
  const filename = `${serverId}-${id}.tar.gz`;
  const destination = path.join(backups, filename);
  const child = spawn("tar", ["-czf", destination, "--", "."], {
    cwd: directory, stdio: ["ignore", "ignore", "pipe"], shell: false,
  });
  let errorOutput = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => (errorOutput += chunk));
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (exitCode !== 0) {
    await fs.rm(destination, { force: true });
    throw new Error(`Backup failed: ${errorOutput.trim() || `tar exited with ${exitCode}`}`);
  }
  db.prepare("INSERT INTO backups(id,server_id,filename) VALUES(?,?,?)").run(id, serverId, filename);
  return { id, filename, created_at: new Date().toISOString() };
}

export const createBackup = withServerOperation("backing up", createBackupInternal);

export function listBackups(serverId) {
  if (!serverQuery.get(serverId)) throw new Error("Server not found");
  return db.prepare("SELECT id, filename, created_at FROM backups WHERE server_id = ? ORDER BY created_at DESC, rowid DESC").all(serverId);
}

export async function getBackupDownload(serverId, backupId) {
  if (!serverQuery.get(serverId)) throw new Error("Server not found");
  const backup = db.prepare("SELECT filename FROM backups WHERE id = ? AND server_id = ?").get(backupId, serverId);
  if (!backup || path.basename(backup.filename) !== backup.filename) throw new Error("Backup not found");
  const directory = await serverBackupDirectory(serverId);
  const filename = path.join(directory, backup.filename);
  const stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Backup file is invalid");
  return { path: filename, filename: backup.filename, size: stat.size };
}

export function setBackupSchedule(serverId, intervalHours, retentionCount, enabled = true) {
  if (!serverQuery.get(serverId)) throw new Error("Server not found");
  if (!Number.isInteger(intervalHours) || intervalHours < 1 || intervalHours > 720 ||
      !Number.isInteger(retentionCount) || retentionCount < 1 || retentionCount > 100 ||
      typeof enabled !== "boolean") throw new Error("Backup schedule requires 1-720 hours, 1-100 retained backups, and a boolean enabled value");
  const nextRun = new Date(Date.now() + intervalHours * 3600000).toISOString();
  db.prepare(`INSERT INTO backup_schedules(server_id,interval_hours,retention_count,enabled,next_run_at)
    VALUES(?,?,?,?,?) ON CONFLICT(server_id) DO UPDATE SET interval_hours=excluded.interval_hours,
    retention_count=excluded.retention_count, enabled=excluded.enabled, next_run_at=excluded.next_run_at`)
    .run(serverId, intervalHours, retentionCount, Number(enabled), nextRun);
  return getBackupSchedule(serverId);
}

export function getBackupSchedule(serverId) {
  if (!serverQuery.get(serverId)) throw new Error("Server not found");
  const schedule = db.prepare("SELECT * FROM backup_schedules WHERE server_id = ?").get(serverId);
  return schedule ? { ...schedule, enabled: Boolean(schedule.enabled) } : null;
}

async function applyBackupRetention(serverId, count) {
  const records = listBackups(serverId);
  for (const backup of records.slice(count)) {
    const directory = await serverBackupDirectory(serverId);
    const filename = path.join(directory, backup.filename);
    const stat = await fs.lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Refusing to remove an invalid backup file");
    await fs.rm(filename);
    db.prepare("DELETE FROM backups WHERE id = ? AND server_id = ?").run(backup.id, serverId);
  }
}

let scheduleCheckRunning = false;
export async function runScheduledBackups(now = new Date()) {
  if (scheduleCheckRunning) return;
  scheduleCheckRunning = true;
  try {
    const due = db.prepare(`SELECT server_id, interval_hours, retention_count FROM backup_schedules
      WHERE enabled = 1 AND next_run_at <= ?`).all(now.toISOString());
    for (const schedule of due) {
      const nextRun = new Date(now.getTime() + schedule.interval_hours * 3600000).toISOString();
      db.prepare("UPDATE backup_schedules SET next_run_at = ? WHERE server_id = ?").run(nextRun, schedule.server_id);
      if (instances.has(schedule.server_id) || operationState.has(schedule.server_id)) continue;
      try {
        await createBackup(schedule.server_id);
        await applyBackupRetention(schedule.server_id, schedule.retention_count);
      } catch (error) {
        console.error(`Scheduled backup failed for ${schedule.server_id}:`, error);
      }
    }
  } catch (error) {
    console.error("Could not check scheduled backups:", error);
  } finally {
    scheduleCheckRunning = false;
  }
}

setInterval(() => {
  runScheduledBackups().catch((error) => console.error("Scheduled backup runner failed:", error));
}, 30000).unref();

function serverSettingsFromProperties(serverId, content) {
  const properties = Object.fromEntries(content.split(/\r?\n/)
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const separator = line.indexOf("=");
      return separator < 0 ? [line, ""] : [line.slice(0, separator), line.slice(separator + 1)];
    }));
  const server = serverQuery.get(serverId);
  const port = properties["server-port"] === undefined ? server.port : Number(properties["server-port"]);
  const bedrockIpv6Port = properties["server-portv6"] === undefined ? port + 1 : Number(properties["server-portv6"]);
  const maxPlayers = properties["max-players"] === undefined ? server.max_players : Number(properties["max-players"]);
  const configuredAddress = properties["server-ip"];
  const bindAddress = configuredAddress === undefined ? server.bind_address : configuredAddress.trim() || "0.0.0.0";
  const onlineModeText = properties["online-mode"];
  const onlineMode = onlineModeText === undefined ? Boolean(server.online_mode) :
    onlineModeText === "true" ? true : onlineModeText === "false" ? false : null;
  const viewDistance = properties["view-distance"] === undefined ? server.view_distance : Number(properties["view-distance"]);
  const distanceKey = server.loader === "bedrock" ? "tick-distance" : "simulation-distance";
  const simulationDistance = properties[distanceKey] === undefined ? server.simulation_distance : Number(properties[distanceKey]);
  if (!Number.isInteger(port) || port < 1024 || port > (server.loader === "bedrock" ? 65534 : 65535) ||
      (server.loader === "bedrock" && bedrockIpv6Port !== port + 1) ||
      !Number.isInteger(maxPlayers) || maxPlayers < 1 || maxPlayers > 1000 ||
      (bindAddress !== "0.0.0.0" && !net.isIP(bindAddress)) || onlineMode === null ||
      !Number.isInteger(viewDistance) || viewDistance < 2 || viewDistance > 32 ||
      !Number.isInteger(simulationDistance) || simulationDistance < 2 ||
      simulationDistance > (server.loader === "bedrock" ? 12 : 32)) {
    throw new Error("server.properties contains invalid port, bind address, player limit, online mode, or distance settings");
  }
  const servicePorts = server.loader === "bedrock"
    ? [port, bedrockIpv6Port]
    : [port, ...(server.crossplay ? [server.bedrock_port] : [])];
  const conflict = findManagedPortConflict(servicePorts, serverId);
  if (conflict) throw new Error(`Port ${port} is already assigned to server ${conflict.id}`);
  return { port, bindAddress, maxPlayers, onlineMode, viewDistance, simulationDistance };
}

async function restoreBackupInternal(serverId, backupId) {
  if (instances.has(serverId)) throw new Error("Stop the server before restoring a backup");
  const row = db.prepare("SELECT filename FROM backups WHERE id = ? AND server_id = ?").get(backupId, serverId);
  if (!row) throw new Error("Backup not found");
  if (path.basename(row.filename) !== row.filename || !row.filename.endsWith(".tar.gz")) {
    throw new Error("Backup filename is invalid");
  }
  const directory = await serverDirectory(serverId);
  const archive = path.join(await serverBackupDirectory(serverId), row.filename);
  const stat = await fs.lstat(archive);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Backup file is invalid");
  const listing = spawn("tar", ["-tzf", archive], { stdio: ["ignore", "pipe", "pipe"], shell: false });
  let archiveEntries = "";
  let listingError = "";
  listing.stdout.setEncoding("utf8");
  listing.stderr.setEncoding("utf8");
  listing.stdout.on("data", (chunk) => {
    archiveEntries += chunk;
    if (archiveEntries.length > 20 * 1024 * 1024) listing.kill("SIGKILL");
  });
  listing.stderr.on("data", (chunk) => {
    listingError = (listingError + chunk).slice(-4096);
  });
  const listingCode = await new Promise((resolve, reject) => {
    listing.once("error", reject);
    listing.once("close", resolve);
  });
  if (listingCode !== 0) throw new Error(`Could not inspect backup archive: ${listingError.trim()}`);
  const entries = archiveEntries.split("\n").filter(Boolean);
  if (entries.some((entry) => path.isAbsolute(entry) || entry.split("/").some((part) => part === "..") || entry.includes("\0"))) {
    throw new Error("Backup contains an unsafe path and cannot be restored");
  }
  const typeListing = spawn("tar", ["--quoting-style=escape", "-tvzf", archive], {
    stdio: ["ignore", "pipe", "pipe"], shell: false,
  });
  let entryTypes = "";
  let typeListingError = "";
  typeListing.stdout.setEncoding("utf8");
  typeListing.stderr.setEncoding("utf8");
  typeListing.stdout.on("data", (chunk) => {
    entryTypes += chunk;
    if (entryTypes.length > 20 * 1024 * 1024) typeListing.kill("SIGKILL");
  });
  typeListing.stderr.on("data", (chunk) => {
    typeListingError = (typeListingError + chunk).slice(-4096);
  });
  const typeListingCode = await new Promise((resolve, reject) => {
    typeListing.once("error", reject);
    typeListing.once("close", resolve);
  });
  if (typeListingCode !== 0) throw new Error(`Could not inspect backup entry types: ${typeListingError.trim()}`);
  if (entryTypes.split("\n").filter(Boolean).some((entry) => !/^[\-d]/.test(entry))) {
    throw new Error("Backup contains a symbolic link or special file; restore is refused for safety");
  }
  const staging = `${directory}.restore-${randomUUID()}`;
  await fs.mkdir(staging, { mode: 0o700 });
  const child = spawn("tar", ["-xzf", archive, "--no-same-owner", "-C", staging], {
    stdio: ["ignore", "ignore", "pipe"], shell: false,
  });
  let errorOutput = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => (errorOutput += chunk));
  let exitCode;
  try {
    exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true });
    throw error;
  }
  if (exitCode !== 0) {
    await fs.rm(staging, { recursive: true, force: true });
    throw new Error(`Restore failed: ${errorOutput.trim() || `tar exited with ${exitCode}`}`);
  }
  let restoredSettings;
  try {
    const propertiesPath = path.join(staging, "server.properties");
    const propertiesStat = await fs.lstat(propertiesPath);
    if (!propertiesStat.isFile() || propertiesStat.isSymbolicLink() || propertiesStat.size > 1024 * 1024) {
      throw new Error("Backup server.properties is invalid");
    }
    restoredSettings = serverSettingsFromProperties(serverId, await fs.readFile(propertiesPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") {
      await fs.rm(staging, { recursive: true, force: true });
      throw error;
    }
  }
  const previous = `${directory}.previous-${randomUUID()}`;
  await fs.rename(directory, previous);
  try {
    await fs.rename(staging, directory);
    if (restoredSettings) {
      db.prepare(`UPDATE servers SET port = ?, bind_address = ?, max_players = ?, online_mode = ?,
        view_distance = ?, simulation_distance = ? WHERE id = ?`)
        .run(restoredSettings.port, restoredSettings.bindAddress, restoredSettings.maxPlayers,
          Number(restoredSettings.onlineMode), restoredSettings.viewDistance, restoredSettings.simulationDistance, serverId);
    }
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    await fs.rename(previous, directory);
    await fs.rm(staging, { recursive: true, force: true });
    throw error;
  }
  await fs.rm(previous, { recursive: true, force: true });
}

export const restoreBackup = withServerOperation("restoring", restoreBackupInternal);

export async function readServerFiles(serverId, relative = ".") {
  const directory = await serverDirectory(serverId);
  const target = resolveRelative(directory, relative);
  let current = directory;
  for (const component of path.relative(directory, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const componentStat = await fs.lstat(current);
    if (componentStat.isSymbolicLink()) throw new Error("Symbolic links are not accessible");
  }
  const stat = await fs.lstat(target);
  if (stat.isDirectory()) {
    const entries = await fs.readdir(target, { withFileTypes: true });
    return entries.map((entry) => ({
      name: entry.name,
      type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
    })).sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1);
  }
  if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error("Only regular text files up to 1 MB can be edited");
  return { content: await fs.readFile(target, "utf8") };
}

function resolveRelative(root, relative) {
  if (typeof relative !== "string" || relative.includes("\0") || path.isAbsolute(relative)) throw new Error("Invalid relative path");
  const target = path.resolve(root, relative);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error("Path escapes the server directory");
  return target;
}

export async function writeServerFile(serverId, relative, content) {
  if (operationState.has(serverId)) throw new Error(`Cannot edit files while ${operationState.get(serverId)} is in progress`);
  const root = await serverDirectory(serverId);
  const target = resolveRelative(root, relative);
  if (target === root || typeof content !== "string" || Buffer.byteLength(content) > 1024 * 1024) {
    throw new Error("File path or content is invalid (maximum file size is 1 MB)");
  }
  const parent = path.dirname(target);
  const relativeParent = path.relative(root, parent);
  let current = root;
  for (const component of relativeParent.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("File path contains an invalid directory");
  }
  try {
    const currentStat = await fs.lstat(target);
    if (!currentStat.isFile() || currentStat.isSymbolicLink()) throw new Error("Only regular files can be edited");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const serverProperties = relative === "server.properties";
  if (serverProperties) {
    if (instances.has(serverId)) throw new Error("Stop the server before editing server.properties");
    const settings = serverSettingsFromProperties(serverId, content);
    await fs.writeFile(target, content, { mode: 0o600 });
    db.prepare(`UPDATE servers SET port = ?, bind_address = ?, max_players = ?, online_mode = ?,
      view_distance = ?, simulation_distance = ? WHERE id = ?`)
      .run(settings.port, settings.bindAddress, settings.maxPlayers, Number(settings.onlineMode),
        settings.viewDistance, settings.simulationDistance, serverId);
    return;
  }
  await fs.writeFile(target, content, { mode: 0o600 });
}

async function assertPathNoSymlink(root, target, allowMissingLeaf = false) {
  let current = root;
  const components = path.relative(root, target).split(path.sep).filter(Boolean);
  for (let index = 0; index < components.length; index++) {
    current = path.join(current, components[index]);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new Error("Symbolic links are not accessible");
      if (index < components.length - 1 && !stat.isDirectory()) throw new Error("A parent path component is not a directory");
    } catch (error) {
      if (error.code === "ENOENT" && allowMissingLeaf && index === components.length - 1) return;
      throw error;
    }
  }
}

export async function createServerFile(serverId, relative, type = "file") {
  if (operationState.has(serverId)) throw new Error(`Cannot create files while ${operationState.get(serverId)} is in progress`);
  if (!["file", "directory"].includes(type)) throw new Error("Create type must be file or directory");
  const root = await serverDirectory(serverId);
  const target = resolveRelative(root, relative);
  if (target === root) throw new Error("Choose a child path");
  await assertPathNoSymlink(root, path.dirname(target));
  if (type === "directory") await fs.mkdir(target, { mode: 0o700 });
  else {
    const handle = await fs.open(target, "wx", 0o600);
    await handle.close();
  }
}

export async function moveServerFile(serverId, from, to) {
  if (operationState.has(serverId)) throw new Error(`Cannot move files while ${operationState.get(serverId)} is in progress`);
  const root = await serverDirectory(serverId);
  const source = resolveRelative(root, from);
  const destination = resolveRelative(root, to);
  if (source === root || destination === root || source === destination ||
      source === path.join(root, "server.properties")) throw new Error("Source or destination path is invalid");
  await assertPathNoSymlink(root, source);
  await assertPathNoSymlink(root, path.dirname(destination));
  const sourceStat = await fs.lstat(source);
  if (!sourceStat.isFile() && !sourceStat.isDirectory()) throw new Error("Only regular files and directories can be moved");
  try {
    await fs.lstat(destination);
    throw new Error("Destination already exists");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (sourceStat.isDirectory() && destination.startsWith(`${source}${path.sep}`)) {
    throw new Error("A directory cannot be moved inside itself");
  }
  await fs.rename(source, destination);
}

export async function deleteServerFile(serverId, relative) {
  if (operationState.has(serverId)) throw new Error(`Cannot delete files while ${operationState.get(serverId)} is in progress`);
  const root = await serverDirectory(serverId);
  const source = resolveRelative(root, relative);
  if (source === root || source === path.join(root, "server.properties")) {
    throw new Error("The server root and server.properties cannot be deleted");
  }
  await assertPathNoSymlink(root, source);
  const stat = await fs.lstat(source);
  if (!stat.isFile() && !stat.isDirectory()) throw new Error("Only regular files and directories can be deleted");
  const trashDirectory = path.join(root, ".panel-trash");
  await fs.mkdir(trashDirectory, { recursive: true, mode: 0o700 });
  const trash = path.join(trashDirectory, `${Date.now()}-${randomUUID()}`);
  await fs.rename(source, trash);
  return { trashed_as: path.relative(root, trash) };
}

export async function downloadServerFile(serverId, relative) {
  const root = await serverDirectory(serverId);
  const target = resolveRelative(root, relative);
  if (target === root) throw new Error("Choose a file to download");
  await assertPathNoSymlink(root, target);
  const stat = await fs.lstat(target);
  if (!stat.isFile() || stat.size > 512 * 1024 * 1024) throw new Error("Only regular files up to 512 MB can be downloaded");
  return { path: target, filename: path.basename(target), size: stat.size };
}

export async function uploadServerFile(serverId, relative, request) {
  if (operationState.has(serverId)) throw new Error(`Cannot upload files while ${operationState.get(serverId)} is in progress`);
  const root = await serverDirectory(serverId);
  const target = resolveRelative(root, relative);
  if (target === root || path.basename(target) !== relative.split(/[\\/]/).at(-1) ||
      Buffer.byteLength(relative) > 1024 || /[\0\r\n]/.test(relative)) {
    throw new Error("Invalid upload path");
  }
  const parent = path.dirname(target);
  await assertPathNoSymlink(root, parent);
  try {
    await fs.lstat(target);
    throw new Error("A file already exists at the upload path");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const temporary = path.join(parent, `.upload-${randomUUID()}.part`);
  const handle = await fs.open(temporary, "wx", 0o600);
  let size = 0;
  try {
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 100 * 1024 * 1024) throw new Error("Upload exceeds the 100 MB limit");
      await handle.write(chunk);
    }
    await handle.close();
    await fs.rename(temporary, target);
  } catch (error) {
    await handle.close().catch(() => {});
    await fs.rm(temporary, { force: true });
    throw error;
  }
  return { filename: path.basename(target), size };
}

export async function shutdownServers() {
  const results = await Promise.allSettled([...instances.keys()].map((id) => stopServer(id)));
  for (const result of results) {
    if (result.status === "rejected") console.error("Failed to gracefully stop a managed server:", result.reason);
  }
}
