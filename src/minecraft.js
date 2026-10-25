import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { extractZipEntries } from "./zip.js";

const manifestUrl = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
const paperApiUrl = "https://fill.papermc.io/v3/projects/paper";
const userAgent = "Byte Server Panel/0.1.0 (https://github.com/byte/mc-server-panel)";
const versionCache = { expires: 0, versions: [] };
const javaVersionCache = new Map();
const paperVersionCache = { expires: 0, versions: [] };
const purpurVersionCache = { expires: 0, versions: [] };
const fabricVersionCache = { expires: 0, versions: [] };
const quiltVersionCache = { expires: 0, versions: [] };
const forgeVersionCache = { expires: 0, versions: [] };
const neoForgeVersionCache = { expires: 0, versions: [] };
const bedrockVersionCache = { expires: 0, version: null, url: null };

function requestSignal(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function validateTrustedUrl(value, allowedHosts, service) {
  const url = new URL(value);
  if (url.protocol !== "https:" || !allowedHosts.includes(url.hostname)) {
    throw new Error(`${service} redirected to an untrusted host`);
  }
  return url;
}

async function fetchTrusted(value, allowedHosts, service, options = {}) {
  let current = validateTrustedUrl(value, allowedHosts, service);
  for (let redirects = 0; redirects <= 3; redirects++) {
    const response = await fetch(current, { ...options, redirect: "manual" });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location || redirects === 3) {
        await response.body?.cancel();
        throw new Error(`${service} returned an invalid or excessive redirect`);
      }
      const next = validateTrustedUrl(new URL(location, current), allowedHosts, service);
      await response.body?.cancel();
      current = next;
      continue;
    }
    validateTrustedUrl(response.url || current, allowedHosts, service);
    return response;
  }
  throw new Error(`${service} returned an invalid redirect chain`);
}

export function requiredJavaMajor(version) {
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(version);
  if (!match) throw new Error("Invalid Minecraft version");
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3] ?? 0);
  if (major > 1 || (major === 1 && (minor > 20 || (minor === 20 && patch >= 5)))) return 21;
  if (major === 1 && minor >= 18) return 17;
  if (major === 1 && minor >= 17) return 16;
  return 8;
}

function javaMajorFromMetadata(metadata, version) {
  const major = metadata.javaVersion?.majorVersion;
  return Number.isInteger(major) && major >= 8 && major <= 99 ? major : requiredJavaMajor(version);
}

export async function requiredJavaForVersion(version, signal) {
  const cachedMajor = javaVersionCache.get(version);
  if (cachedMajor) return cachedMajor;
  const versions = await listMinecraftVersions(signal);
  const entry = versions.find((candidate) => candidate.id === version);
  if (!entry) throw new Error("Choose a Minecraft version listed by Mojang");
  const response = await fetchTrusted(entry.url, ["piston-meta.mojang.com", "launchermeta.mojang.com"],
    "Minecraft metadata", { headers: { "User-Agent": userAgent }, signal: requestSignal(signal, 15000) });
  if (!response.ok) throw new Error(`Minecraft metadata returned HTTP ${response.status}`);
  const metadata = await response.json();
  const major = javaMajorFromMetadata(metadata, version);
  javaVersionCache.set(version, major);
  return major;
}

export async function listMinecraftVersions(signal) {
  if (versionCache.expires > Date.now()) return versionCache.versions;
  const response = await fetchTrusted(manifestUrl, ["piston-meta.mojang.com"],
    "Minecraft version service", { headers: { "User-Agent": userAgent }, signal: requestSignal(signal, 15000) });
  if (!response.ok) throw new Error(`Minecraft version service returned HTTP ${response.status}`);
  const manifest = await response.json();
  if (!Array.isArray(manifest.versions)) throw new Error("Minecraft version service returned invalid metadata");
  versionCache.versions = manifest.versions.map(({ id, type, url, time }) => ({ id, type, url, time }));
  versionCache.expires = Date.now() + 60 * 60 * 1000;
  return versionCache.versions;
}

export async function listBedrockVersions(signal) {
  if (bedrockVersionCache.expires > Date.now() && bedrockVersionCache.version) {
    return [{ id: bedrockVersionCache.version, type: "release", url: bedrockVersionCache.url }];
  }
  const response = await fetchTrusted("https://www.minecraft.net/en-us/download/server/bedrock",
    ["www.minecraft.net"], "Official Bedrock download page", {
      headers: { "User-Agent": userAgent },
      signal: requestSignal(signal, 20000),
    });
  if (!response.ok) throw new Error(`Official Bedrock download page returned HTTP ${response.status}`);
  const html = await response.text();
  if (html.length > 10 * 1024 * 1024) throw new Error("Official Bedrock download page exceeds the metadata size limit");
  const matches = [...html.replaceAll("\\/", "/").matchAll(
    /https:\/\/www\.minecraft\.net\/bedrockdedicatedserver\/bin-linux\/bedrock-server-([0-9]+(?:\.[0-9]+){2,3})\.zip/g,
  )];
  const releases = new Map();
  for (const match of matches) {
    releases.set(match[1], `https://www.minecraft.net/bedrockdedicatedserver/bin-linux/bedrock-server-${match[1]}.zip`);
  }
  const selected = [...releases.entries()].sort((left, right) =>
    left[0].localeCompare(right[0], undefined, { numeric: true })).at(-1);
  if (!selected) throw new Error("Official Bedrock download page did not publish a Linux x86_64 server archive");
  bedrockVersionCache.version = selected[0];
  bedrockVersionCache.url = selected[1];
  bedrockVersionCache.expires = Date.now() + 60 * 60 * 1000;
  return [{ id: selected[0], type: "release", url: selected[1] }];
}

async function geyserArtifact(project, artifact, signal) {
  const url = `https://download.geysermc.org/v2/projects/${project}/versions/latest/builds/latest`;
  const response = await fetchTrusted(url, ["download.geysermc.org"],
    `${project === "geyser" ? "Geyser" : "Floodgate"} download service`, {
      headers: { "User-Agent": userAgent },
      signal: requestSignal(signal, 20000),
    });
  if (!response.ok) throw new Error(`${project} download metadata returned HTTP ${response.status}`);
  const metadata = await response.json();
  const file = metadata.downloads?.spigot;
  if (metadata.project_id !== project || !/^[0-9A-Za-z.+_-]{1,64}$/.test(metadata.version ?? "") ||
      !/^\d+$/.test(String(metadata.build)) || !file ||
      !/^[0-9a-f]{64}$/i.test(file.sha256 ?? "") ||
      !/^[A-Za-z0-9._-]{1,128}\.jar$/.test(file.name ?? "")) {
    throw new Error(`${project} returned invalid Paper plugin metadata`);
  }
  const download = `https://download.geysermc.org/v2/projects/${project}/versions/${encodeURIComponent(metadata.version)}/builds/${metadata.build}/downloads/spigot`;
  return { name: file.name, url: download, sha256: file.sha256 };
}

async function installGeyserBridge(server, directory, { signal, onProgress } = {}) {
  const pluginsDirectory = path.join(directory, "plugins");
  await fs.mkdir(pluginsDirectory, { recursive: true, mode: 0o700 });
  const pluginStat = await fs.lstat(pluginsDirectory);
  if (!pluginStat.isDirectory() || pluginStat.isSymbolicLink()) throw new Error("Paper plugins directory is invalid");
  const staging = await fs.mkdtemp(path.join(directory, ".panel-geyser-install-"));
  const previous = path.join(staging, "previous");
  const committed = [];
  try {
    await fs.mkdir(previous, { mode: 0o700 });
    let managedCrossplay = false;
    try {
      const markerPath = path.join(directory, "server-panel.json");
      const markerStat = await fs.lstat(markerPath);
      if (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.size > 32768) {
        throw new Error("Cross-play installation marker is invalid");
      }
      const marker = JSON.parse(await fs.readFile(markerPath, "utf8"));
      managedCrossplay = marker.crossplay === true && marker.software === "paper";
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const artifacts = [];
    for (const project of ["geyser", "floodgate"]) {
      if (signal?.aborted) throw new DOMException("Installation cancelled", "AbortError");
      const artifact = await geyserArtifact(project, "spigot", signal);
      const stageFile = path.join(staging, artifact.name);
      await downloadVerified(artifact.url, stageFile, artifact.sha256, "sha256", {
        signal, onProgress, headers: { "User-Agent": userAgent },
      });
      artifacts.push(artifact);
    }
    for (const artifact of artifacts) {
      if (signal?.aborted) throw new DOMException("Installation cancelled", "AbortError");
      const destination = path.join(pluginsDirectory, artifact.name);
      let existing = false;
      try {
        const stat = await fs.lstat(destination);
        if (!stat.isFile() || stat.isSymbolicLink()) {
          throw new Error(`Cannot install cross-play because ${artifact.name} is not a regular file`);
        }
        if (!managedCrossplay) throw new Error(`Cannot install cross-play plugins because ${artifact.name} already exists`);
        existing = true;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      let backup;
      if (existing) {
        backup = path.join(previous, artifact.name);
        await fs.link(destination, backup);
        await fs.rename(path.join(staging, artifact.name), destination);
      } else {
        await fs.link(path.join(staging, artifact.name), destination);
      }
      committed.push({ destination, backup });
    }
    const geyserDirectory = path.join(pluginsDirectory, "Geyser-Spigot");
    await fs.mkdir(geyserDirectory, { recursive: true, mode: 0o700 });
    const geyserDirectoryStat = await fs.lstat(geyserDirectory);
    if (!geyserDirectoryStat.isDirectory() || geyserDirectoryStat.isSymbolicLink()) {
      throw new Error("Geyser configuration directory is invalid");
    }
    const configPath = path.join(geyserDirectory, "config.yml");
    try {
      const configStat = await fs.lstat(configPath);
      if (!configStat.isFile() || configStat.isSymbolicLink()) throw new Error("Geyser configuration file is invalid");
      if (!managedCrossplay) throw new Error("Cannot install cross-play because Geyser configuration already exists");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const yaml = [
        "bedrock:",
        `  address: ${server.bind_address}`,
        `  port: ${server.bedrock_port}`,
        "  clone-remote-port: false",
        "remote:",
        "  address: 127.0.0.1",
        `  port: ${server.port}`,
        "  auth-type: floodgate",
        "",
      ].join("\n");
      await fs.writeFile(configPath, yaml, { flag: "wx", mode: 0o600 });
      committed.push({ destination: configPath });
    }
    return { geyser: true };
  } catch (error) {
    for (const { destination, backup } of committed.reverse()) {
      if (backup) await fs.rename(backup, destination);
      else await fs.rm(destination, { force: true });
    }
    throw error;
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

async function installBedrockServer(server, directory, { signal, onProgress } = {}) {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error("Official Bedrock Dedicated Server installation is supported only on Linux x86_64");
  }
  const releases = await listBedrockVersions(signal);
  let release = releases.find((candidate) => candidate.id === server.version);
  if (!release) {
    try {
      const markerPath = path.join(directory, "server-panel.json");
      const markerStat = await fs.lstat(markerPath);
      if (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.size > 32768) {
        throw new Error("Bedrock installation marker is invalid");
      }
      const marker = JSON.parse(await fs.readFile(markerPath, "utf8"));
      if (marker.loader === "bedrock" && marker.executable === "bedrock_server") release = releases[0];
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  if (!release) throw new Error("Choose the current Bedrock release listed on the official download page");
  const staging = await fs.mkdtemp(path.join(directory, ".panel-bedrock-install-"));
  const archivePath = path.join(staging, "bedrock-server.zip");
  const payloadPath = path.join(staging, "payload");
  const previousPath = path.join(staging, "previous");
  const changed = [];
  try {
    await fs.mkdir(payloadPath, { mode: 0o700 });
    await fs.mkdir(previousPath, { mode: 0o700 });
    const directoryStat = await fs.lstat(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw new Error("Bedrock server directory is invalid");
    }
    let managedInstall = false;
    try {
      const markerPath = path.join(directory, "server-panel.json");
      const markerStat = await fs.lstat(markerPath);
      if (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.size > 32768) {
        throw new Error("Bedrock installation marker is invalid");
      }
      const marker = JSON.parse(await fs.readFile(markerPath, "utf8"));
      managedInstall = marker.loader === "bedrock" && marker.executable === "bedrock_server";
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await downloadVerified(release.url, archivePath, null, "sha256", {
      signal, onProgress,
    });
    const entries = extractZipEntries(await fs.readFile(archivePath), {
      maxArchiveBytes: 256 * 1024 * 1024,
      maxExtractedBytes: 512 * 1024 * 1024,
      maxEntryBytes: 256 * 1024 * 1024,
    });
    if (!entries.has("bedrock_server") || !entries.has("server.properties")) {
      throw new Error("Official Bedrock archive is missing its server binary or properties file");
    }
    if (signal?.aborted) throw new DOMException("Installation cancelled", "AbortError");
    for (const [name, contents] of entries) {
      if (path.isAbsolute(name) || name.split(path.sep).some((part) => part === ".." || part === "")) {
        throw new Error("Bedrock archive contains an unsafe file path");
      }
      const destination = path.join(payloadPath, name);
      await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await fs.writeFile(destination, contents, { flag: "wx", mode: name === "bedrock_server" ? 0o700 : 0o600 });
    }
    const existingEntries = new Map();
    for (const name of entries.keys()) {
      const destination = await safeArchiveDestination(directory, name, false);
      try {
        const stat = await fs.lstat(destination);
        if (!stat.isFile() || stat.isSymbolicLink()) {
          throw new Error(`Bedrock installation found an unsafe existing file ${name}`);
        }
        if (!managedInstall) throw new Error(`Bedrock installation would overwrite existing server file ${name}`);
        existingEntries.set(name, stat);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    const configurationPath = path.join(payloadPath, "server.properties");
    let properties = existingEntries.has("server.properties")
      ? await fs.readFile(await safeArchiveDestination(directory, "server.properties", false), "utf8")
      : await fs.readFile(configurationPath, "utf8");
    const values = {
      "server-name": server.name.replace(/[\r\n\0]/g, " ").slice(0, 64),
      "server-port": String(server.port),
      "server-portv6": String(server.port + 1),
      "max-players": String(server.max_players),
      "online-mode": String(Boolean(server.online_mode)),
      "view-distance": String(Math.min(server.view_distance, 32)),
      "tick-distance": String(Math.min(server.simulation_distance, 12)),
    };
    for (const [key, value] of Object.entries(values)) {
      const line = `${key}=${value}`;
      const pattern = new RegExp(`^${key}=.*$`, "m");
      properties = pattern.test(properties) ? properties.replace(pattern, line) : `${properties.trimEnd()}\n${line}\n`;
    }
    await fs.writeFile(configurationPath, properties, { mode: 0o600 });
    for (const name of entries.keys()) {
      if (signal?.aborted) throw new DOMException("Installation cancelled", "AbortError");
      const source = path.join(payloadPath, name);
      const destination = await safeArchiveDestination(directory, name, true);
      const existing = existingEntries.has(name);
      if (existing && ["permissions.json", "allowlist.json"].includes(name)) continue;
      let backup;
      if (existing) {
        backup = await safeArchiveDestination(previousPath, name, true);
        await fs.link(destination, backup);
      }
      if (existing) await fs.rename(source, destination);
      else await fs.link(source, destination);
      changed.push({ destination, backup });
    }
    return {
      filename: null, executable: "bedrock_server", javaMajor: null, version: release.id,
      verifiedChecksum: false,
    };
  } catch (error) {
    for (const { destination, backup } of changed.reverse()) {
      if (backup) await fs.rename(backup, destination);
      else await fs.rm(destination, { force: true });
    }
    throw error;
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

async function safeArchiveDestination(root, relative, createParents) {
  const target = path.resolve(root, relative);
  if (target === root || !target.startsWith(`${root}${path.sep}`)) {
    throw new Error("Bedrock archive path escapes the server directory");
  }
  let current = root;
  for (const component of path.relative(root, path.dirname(target)).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try {
      const stat = await fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error("Bedrock archive path contains an unsafe directory");
      }
    } catch (error) {
      if (error.code !== "ENOENT" || !createParents) {
        if (error.code === "ENOENT" && !createParents) return target;
        throw error;
      }
      await fs.mkdir(current, { mode: 0o700 });
    }
  }
  return target;
}

export async function listPaperVersions(signal) {
  if (paperVersionCache.expires > Date.now()) return paperVersionCache.versions;
  const response = await fetchTrusted(paperApiUrl, ["fill.papermc.io"],
    "Paper version service", { headers: { "User-Agent": userAgent }, signal: requestSignal(signal, 15000) });
  if (!response.ok) throw new Error(`Paper version service returned HTTP ${response.status}`);
  const metadata = await response.json();
  if (!metadata.versions || typeof metadata.versions !== "object" || Array.isArray(metadata.versions)) {
    throw new Error("Paper version service returned invalid metadata");
  }
  paperVersionCache.versions = Object.values(metadata.versions).flat()
    .filter((version) => typeof version === "string");
  paperVersionCache.expires = Date.now() + 30 * 60 * 1000;
  return paperVersionCache.versions;
}

export async function listPurpurVersions(signal) {
  if (purpurVersionCache.expires > Date.now()) return purpurVersionCache.versions;
  const response = await fetchTrusted("https://api.purpurmc.org/v2/purpur", ["api.purpurmc.org"],
    "Purpur version service", { headers: { "User-Agent": userAgent }, signal: requestSignal(signal, 15000) });
  if (!response.ok) throw new Error(`Purpur version service returned HTTP ${response.status}`);
  const metadata = await response.json();
  if (!Array.isArray(metadata.versions) || metadata.versions.some((version) => typeof version !== "string")) {
    throw new Error("Purpur version service returned invalid metadata");
  }
  purpurVersionCache.versions = metadata.versions;
  purpurVersionCache.expires = Date.now() + 30 * 60 * 1000;
  return purpurVersionCache.versions;
}

export async function listForgeMinecraftVersions(signal) {
  if (forgeVersionCache.expires > Date.now()) return forgeVersionCache.versions;
  const response = await fetchTrusted(
    "https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json",
    ["files.minecraftforge.net"], "Forge compatibility service",
    { headers: { "User-Agent": userAgent }, signal: requestSignal(signal, 15000) },
  );
  if (!response.ok) throw new Error(`Forge compatibility service returned HTTP ${response.status}`);
  const metadata = await response.json();
  const promos = metadata.promos;
  if (!promos || typeof promos !== "object" || Array.isArray(promos)) {
    throw new Error("Forge compatibility service returned invalid metadata");
  }
  const versions = new Set();
  for (const key of Object.keys(promos)) {
    const match = /^(\d+\.\d+(?:\.\d+)?)-(?:recommended|latest)$/.exec(key);
    if (match && typeof promos[key] === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(promos[key])) {
      versions.add(match[1]);
    }
  }
  forgeVersionCache.versions = [...versions];
  forgeVersionCache.expires = Date.now() + 30 * 60 * 1000;
  return forgeVersionCache.versions;
}

function neoForgeMinecraftPrefix(minecraftVersion) {
  const match = /^1\.(\d+)(?:\.(\d+))?$/.exec(minecraftVersion);
  if (match) return `${match[1]}.${match[2] ?? "0"}.`;
  const modern = /^(\d+)\.(\d+)(?:\.\d+)?$/.exec(minecraftVersion);
  return modern ? `${modern[1]}.${modern[2]}.` : null;
}

export async function listNeoForgeVersions(minecraftVersion, signal) {
  if (typeof minecraftVersion !== "string" || !/^\d+\.\d+(?:\.\d+)?$/.test(minecraftVersion)) {
    throw new Error("NeoForge lookup requires a stable Minecraft release");
  }
  const prefix = neoForgeMinecraftPrefix(minecraftVersion);
  if (!prefix) return [];
  if (neoForgeVersionCache.expires <= Date.now()) {
    const response = await fetchTrusted(
      "https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge",
      ["maven.neoforged.net"], "NeoForge version service",
      { headers: { "User-Agent": userAgent }, signal: requestSignal(signal, 15000) },
    );
    if (!response.ok) throw new Error(`NeoForge version service returned HTTP ${response.status}`);
    const metadata = await response.json();
    if (!Array.isArray(metadata.versions) || metadata.versions.some((version) =>
      typeof version !== "string" || version.length > 64)) {
      throw new Error("NeoForge version service returned invalid metadata");
    }
    neoForgeVersionCache.versions = metadata.versions.filter((version) => /^\d+\.\d+\.\d+$/.test(version));
    neoForgeVersionCache.expires = Date.now() + 30 * 60 * 1000;
  }
  return neoForgeVersionCache.versions.filter((version) => version.startsWith(prefix));
}

export async function listFabricMinecraftVersions(signal) {
  if (fabricVersionCache.expires > Date.now()) return fabricVersionCache.versions;
  const response = await fetchTrusted("https://meta.fabricmc.net/v2/versions/game", ["meta.fabricmc.net"],
    "Fabric version service", { headers: { "User-Agent": userAgent }, signal: requestSignal(signal, 15000) });
  if (!response.ok) throw new Error(`Fabric version service returned HTTP ${response.status}`);
  const metadata = await response.json();
  if (!Array.isArray(metadata) || metadata.some((entry) =>
    typeof entry.version !== "string" || entry.version.length > 64 || typeof entry.stable !== "boolean" ||
    (entry.stable && !/^\d+\.\d+(?:\.\d+)?$/.test(entry.version)))) {
    throw new Error("Fabric returned invalid game-version metadata");
  }
  fabricVersionCache.versions = metadata.filter((entry) => entry.stable).map((entry) => entry.version);
  fabricVersionCache.expires = Date.now() + 30 * 60 * 1000;
  return fabricVersionCache.versions;
}

export async function listFabricLoaderVersions(minecraftVersion, signal) {
  if (typeof minecraftVersion !== "string" || !/^\d+\.\d+(?:\.\d+)?$/.test(minecraftVersion)) {
    throw new Error("Fabric loader lookup requires a stable Minecraft release");
  }
  const response = await fetchTrusted(
    `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(minecraftVersion)}`,
    ["meta.fabricmc.net"], "Fabric loader service",
    { headers: { "User-Agent": userAgent }, signal: requestSignal(signal, 15000) },
  );
  if (!response.ok) throw new Error(`Fabric does not support Minecraft ${minecraftVersion}`);
  const metadata = await response.json();
  if (!Array.isArray(metadata) || metadata.some((entry) =>
    typeof entry.loader?.version !== "string" || !/^[0-9A-Za-z.+_-]{1,64}$/.test(entry.loader.version) ||
    typeof entry.loader?.stable !== "boolean")) {
    throw new Error("Fabric returned invalid loader metadata");
  }
  return metadata.filter((entry) => entry.loader.stable).map((entry) => entry.loader.version);
}

export async function listQuiltMinecraftVersions(signal) {
  if (quiltVersionCache.expires > Date.now()) return quiltVersionCache.versions;
  const response = await fetchTrusted("https://meta.quiltmc.org/v3/versions/game", ["meta.quiltmc.org"],
    "Quilt version service", { headers: { "User-Agent": userAgent }, signal: requestSignal(signal, 15000) });
  if (!response.ok) throw new Error(`Quilt version service returned HTTP ${response.status}`);
  const metadata = await response.json();
  if (!Array.isArray(metadata) || metadata.some((entry) =>
    typeof entry.version !== "string" || entry.version.length > 64 || typeof entry.stable !== "boolean" ||
    (entry.stable && !/^\d+\.\d+(?:\.\d+)?$/.test(entry.version)))) {
    throw new Error("Quilt returned invalid game-version metadata");
  }
  quiltVersionCache.versions = metadata.filter((entry) => entry.stable).map((entry) => entry.version);
  quiltVersionCache.expires = Date.now() + 30 * 60 * 1000;
  return quiltVersionCache.versions;
}

export async function listQuiltLoaderVersions(minecraftVersion, signal) {
  if (typeof minecraftVersion !== "string" || !/^\d+\.\d+(?:\.\d+)?$/.test(minecraftVersion)) {
    throw new Error("Quilt loader lookup requires a stable Minecraft release");
  }
  const response = await fetchTrusted(
    `https://meta.quiltmc.org/v3/versions/loader/${encodeURIComponent(minecraftVersion)}`,
    ["meta.quiltmc.org"], "Quilt loader service",
    { headers: { "User-Agent": userAgent }, signal: requestSignal(signal, 15000) },
  );
  if (!response.ok) throw new Error(`Quilt does not support Minecraft ${minecraftVersion}`);
  const metadata = await response.json();
  if (!Array.isArray(metadata) || metadata.some((entry) =>
    typeof entry.loader?.version !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(entry.loader.version) ||
    typeof entry.loader?.hashes?.sha512 !== "string" ||
    !/^[a-f0-9]{128}$/i.test(entry.loader.hashes.sha512))) {
    throw new Error("Quilt returned invalid loader metadata");
  }
  return metadata.filter((entry) => /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(entry.loader.version))
    .map((entry) => entry.loader.version);
}

async function fabricInstallerMetadata(signal) {
  const response = await fetchTrusted("https://meta.fabricmc.net/v2/versions/installer", ["meta.fabricmc.net"],
    "Fabric installer service", { headers: { "User-Agent": userAgent }, signal: requestSignal(signal, 15000) });
  if (!response.ok) throw new Error(`Fabric installer service returned HTTP ${response.status}`);
  const versions = await response.json();
  if (!Array.isArray(versions)) throw new Error("Fabric installer service returned invalid metadata");
  const installer = versions.find((entry) => entry.stable === true);
  if (!installer || typeof installer.version !== "string" || !/^[0-9A-Za-z.+_-]{1,64}$/.test(installer.version) ||
      typeof installer.url !== "string") {
    throw new Error("Fabric has no stable server installer available");
  }
  const url = validateTrustedUrl(installer.url, ["maven.fabricmc.net"], "Fabric installer");
  if (!/^\/net\/fabricmc\/fabric-installer\/[0-9A-Za-z.+_-]+\/fabric-installer-[0-9A-Za-z.+_-]+\.jar$/.test(url.pathname)) {
    throw new Error("Fabric installer metadata returned an unexpected artifact path");
  }
  return { url: url.href, version: installer.version };
}

async function quiltInstallerMetadata(signal) {
  const response = await fetchTrusted("https://meta.quiltmc.org/v3/versions/installer", ["meta.quiltmc.org"],
    "Quilt installer service", { headers: { "User-Agent": userAgent }, signal: requestSignal(signal, 15000) });
  if (!response.ok) throw new Error(`Quilt installer service returned HTTP ${response.status}`);
  const versions = await response.json();
  if (!Array.isArray(versions)) throw new Error("Quilt installer service returned invalid metadata");
  const installer = versions.find((entry) => /^\d+\.\d+\.\d+$/.test(entry.version ?? ""));
  if (!installer || typeof installer.url !== "string" || !/^[a-f0-9]{128}$/i.test(installer.hashes?.sha512 ?? "")) {
    throw new Error("Quilt has no stable installer with a SHA-512 checksum");
  }
  const url = validateTrustedUrl(installer.url, ["maven.quiltmc.org"], "Quilt installer");
  if (!/^\/repository\/release\/org\/quiltmc\/quilt-installer\/[0-9A-Za-z.+_-]+\/quilt-installer-[0-9A-Za-z.+_-]+\.jar$/.test(url.pathname)) {
    throw new Error("Quilt installer metadata returned an unexpected artifact path");
  }
  return { url: url.href, version: installer.version, checksum: installer.hashes.sha512 };
}

async function copyGeneratedTree(source, destination) {
  const stat = await fs.lstat(source);
  if (stat.isSymbolicLink()) throw new Error("Fabric installer generated a symbolic link; refusing to install it");
  let existing;
  try {
    existing = await fs.lstat(destination);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (existing?.isSymbolicLink()) throw new Error("Refusing to overwrite a symbolic link in the server directory");
  if (stat.isDirectory()) {
    await fs.mkdir(destination, { recursive: true, mode: 0o700 });
    for (const entry of await fs.readdir(source)) {
      await copyGeneratedTree(path.join(source, entry), path.join(destination, entry));
    }
    return;
  }
  if (!stat.isFile()) throw new Error("Fabric installer generated a special file; refusing to install it");
  await fs.copyFile(source, destination);
  await fs.chmod(destination, 0o600);
}

export async function installFabricServer(server, directory, { signal, onProgress } = {}) {
  if (signal?.aborted) throw new DOMException("Installation cancelled", "AbortError");
  const supported = await listFabricMinecraftVersions(signal);
  if (!supported.includes(server.version)) throw new Error(`Fabric does not support stable Minecraft ${server.version}`);
  const loaders = await listFabricLoaderVersions(server.version, signal);
  const loaderVersion = loaders[0];
  if (!loaderVersion) throw new Error(`No stable Fabric loader is available for Minecraft ${server.version}`);
  const installer = await fabricInstallerMetadata(signal);
  const checksumResponse = await fetchTrusted(`${installer.url}.sha512`, ["maven.fabricmc.net"],
    "Fabric installer checksum", {
      headers: { "User-Agent": userAgent }, signal: requestSignal(signal, 15000),
    });
  if (!checksumResponse.ok) throw new Error(`Fabric installer checksum returned HTTP ${checksumResponse.status}`);
  const checksumText = await checksumResponse.text();
  const checksum = /^([a-f0-9]{128})(?:\s|$)/i.exec(checksumText)?.[1];
  if (!checksum) throw new Error("Fabric installer has no valid SHA-512 checksum");
  const javaMajor = await requiredJavaForVersion(server.version, signal);
  const staging = await fs.mkdtemp(path.join(directory, ".panel-fabric-install-"));
  try {
    const installerPath = path.join(staging, "fabric-installer.jar");
    await downloadVerified(installer.url, installerPath, checksum, "sha512", { signal, onProgress });
    const child = spawn(server.java_path, [
      "-jar", installerPath, "server", "-dir", staging, "-mcversion", server.version,
      "-loader", loaderVersion, "-downloadMinecraft",
    ], { cwd: staging, stdio: ["ignore", "pipe", "pipe"], shell: false });
    let output = "";
    let timedOut = false;
    const collect = (chunk) => {
      const text = chunk.toString("utf8");
      output = (output + text).slice(-8192);
      for (const line of text.split(/\r?\n/).filter(Boolean)) {
        onProgress?.(0, 0, `Fabric installer: ${line.slice(0, 240)}`);
      }
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 10 * 60 * 1000);
    let abortKillTimeout;
    const abortHandler = signal ? () => {
      child.kill("SIGTERM");
      abortKillTimeout = setTimeout(() => child.kill("SIGKILL"), 5000);
    } : undefined;
    if (abortHandler) signal.addEventListener("abort", abortHandler, { once: true });
    if (signal?.aborted) abortHandler();
    let exitCode;
    try {
      exitCode = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
    } finally {
      clearTimeout(timeout);
      clearTimeout(abortKillTimeout);
      if (abortHandler) signal.removeEventListener("abort", abortHandler);
    }
    if (signal?.aborted) throw new DOMException("Installation cancelled", "AbortError");
    if (timedOut) throw new Error(`Fabric installer timed out: ${output.trim()}`);
    if (exitCode !== 0) throw new Error(`Fabric installer failed: ${output.trim() || `exited with ${exitCode}`}`);
    const launcher = path.join(staging, "fabric-server-launch.jar");
    const launcherStat = await fs.lstat(launcher);
    if (!launcherStat.isFile() || launcherStat.isSymbolicLink() || launcherStat.size < 4 ||
        launcherStat.size > 512 * 1024 * 1024) {
      throw new Error("Fabric installer did not produce a valid server launcher jar");
    }
    const handle = await fs.open(launcher, "r");
    const signature = Buffer.alloc(4);
    await handle.read(signature, 0, 4, 0);
    await handle.close();
    if (signature[0] !== 0x50 || signature[1] !== 0x4b) {
      throw new Error("Fabric server launcher is not a valid ZIP/JAR archive");
    }
    for (const name of ["fabric-server-launch.jar", "fabric-server-launcher.properties", "server.jar", "libraries", ".fabric"]) {
      const generated = path.join(staging, name);
      let generatedStat;
      try {
        generatedStat = await fs.lstat(generated);
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      if (generatedStat) await copyGeneratedTree(generated, path.join(directory, name));
    }
    return { filename: "fabric-server-launch.jar", javaMajor, loaderVersion, installerVersion: installer.version };
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

export async function installQuiltServer(server, directory, { signal, onProgress } = {}) {
  if (signal?.aborted) throw new DOMException("Installation cancelled", "AbortError");
  const supported = await listQuiltMinecraftVersions(signal);
  if (!supported.includes(server.version)) throw new Error(`Quilt does not support stable Minecraft ${server.version}`);
  const loaders = await listQuiltLoaderVersions(server.version, signal);
  if (!loaders.length) throw new Error(`No stable Quilt loader is available for Minecraft ${server.version}`);
  const installer = await quiltInstallerMetadata(signal);
  const javaMajor = await requiredJavaForVersion(server.version, signal);
  const staging = await fs.mkdtemp(path.join(directory, ".panel-quilt-install-"));
  try {
    const installerPath = path.join(staging, "quilt-installer.jar");
    await downloadVerified(installer.url, installerPath, installer.checksum, "sha512", { signal, onProgress });
    const child = spawn(server.java_path, [
      "-jar", installerPath, "install", "server", server.version, "--download-server",
    ], { cwd: staging, stdio: ["ignore", "pipe", "pipe"], shell: false });
    let output = "";
    let timedOut = false;
    const collect = (chunk) => {
      const text = chunk.toString("utf8");
      output = (output + text).slice(-8192);
      for (const line of text.split(/\r?\n/).filter(Boolean)) {
        onProgress?.(0, 0, `Quilt installer: ${line.slice(0, 240)}`);
      }
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 10 * 60 * 1000);
    let abortKillTimeout;
    const abortHandler = signal ? () => {
      child.kill("SIGTERM");
      abortKillTimeout = setTimeout(() => child.kill("SIGKILL"), 5000);
    } : undefined;
    if (abortHandler) signal.addEventListener("abort", abortHandler, { once: true });
    if (signal?.aborted) abortHandler();
    let exitCode;
    try {
      exitCode = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
    } finally {
      clearTimeout(timeout);
      clearTimeout(abortKillTimeout);
      if (abortHandler) signal.removeEventListener("abort", abortHandler);
    }
    if (signal?.aborted) throw new DOMException("Installation cancelled", "AbortError");
    if (timedOut) throw new Error(`Quilt installer timed out: ${output.trim()}`);
    if (exitCode !== 0) throw new Error(`Quilt installer failed: ${output.trim() || `exited with ${exitCode}`}`);
    const generatedRoot = path.join(staging, "server");
    const launcher = path.join(generatedRoot, "quilt-server-launch.jar");
    const launcherStat = await fs.lstat(launcher);
    if (!launcherStat.isFile() || launcherStat.isSymbolicLink() || launcherStat.size < 4 ||
        launcherStat.size > 512 * 1024 * 1024) {
      throw new Error("Quilt installer did not produce a valid server launcher jar");
    }
    const handle = await fs.open(launcher, "r");
    const signature = Buffer.alloc(4);
    await handle.read(signature, 0, 4, 0);
    await handle.close();
    if (signature[0] !== 0x50 || signature[1] !== 0x4b) {
      throw new Error("Quilt server launcher is not a valid ZIP/JAR archive");
    }
    for (const name of ["quilt-server-launch.jar", "quilt-server-launcher.properties", "server.jar", "libraries"]) {
      const generated = path.join(generatedRoot, name);
      let stat;
      try {
        stat = await fs.lstat(generated);
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      if (stat) await copyGeneratedTree(generated, path.join(directory, name));
    }
    return { filename: "quilt-server-launch.jar", javaMajor, loaderVersion: loaders[0], installerVersion: installer.version };
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

async function runServerInstaller(javaPath, installerPath, args, cwd, { signal, onProgress, name }) {
  if (signal?.aborted) throw new DOMException("Installation cancelled", "AbortError");
  const child = spawn(javaPath, ["-jar", installerPath, ...args], {
    cwd, stdio: ["ignore", "pipe", "pipe"], shell: false,
  });
  let output = "";
  let timedOut = false;
  const collect = (chunk) => {
    const text = chunk.toString("utf8");
    output = (output + text).slice(-8192);
    for (const line of text.split(/\r?\n/).filter(Boolean)) {
      onProgress?.(0, 0, `${name} installer: ${line.slice(0, 240)}`);
    }
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, 10 * 60 * 1000);
  let abortKillTimeout;
  const abortHandler = signal ? () => {
    child.kill("SIGTERM");
    abortKillTimeout = setTimeout(() => child.kill("SIGKILL"), 5000);
  } : undefined;
  if (abortHandler) signal.addEventListener("abort", abortHandler, { once: true });
  if (signal?.aborted) abortHandler();
  let exitCode;
  try {
    exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
  } finally {
    clearTimeout(timeout);
    clearTimeout(abortKillTimeout);
    if (abortHandler) signal.removeEventListener("abort", abortHandler);
  }
  if (signal?.aborted) throw new DOMException("Installation cancelled", "AbortError");
  if (timedOut) throw new Error(`${name} installer timed out: ${output.trim()}`);
  if (exitCode !== 0) throw new Error(`${name} installer failed: ${output.trim() || `exited with ${exitCode}`}`);
  return output;
}

async function locateInstallerArgsFile(directory, group, artifact) {
  const base = path.join(directory, "libraries", "net", group, artifact);
  const baseStat = await fs.lstat(base);
  if (!baseStat.isDirectory() || baseStat.isSymbolicLink()) {
    throw new Error("Installer did not generate a safe server library directory");
  }
  const matches = [];
  for (const version of await fs.readdir(base)) {
    if (!/^[A-Za-z0-9._+-]{1,128}$/.test(version)) continue;
    const versionDirectory = path.join(base, version);
    const versionStat = await fs.lstat(versionDirectory);
    if (versionStat.isSymbolicLink() || !versionStat.isDirectory()) continue;
    const candidate = path.join(versionDirectory, "unix_args.txt");
    try {
      const stat = await fs.lstat(candidate);
      if (stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= 1024 * 1024) {
        matches.push(path.relative(directory, candidate));
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  if (matches.length !== 1) {
    throw new Error(`Installer must generate exactly one validated unix_args.txt (found ${matches.length})`);
  }
  return matches[0].split(path.sep).join("/");
}

async function copyServerInstallerOutput(staging, directory, installerPath) {
  const allowed = ["libraries", "user_jvm_args.txt", "run.sh", "run.bat", "server.jar"];
  for (const name of allowed) {
    const source = path.join(staging, name);
    let stat;
    try {
      stat = await fs.lstat(source);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (source === installerPath || stat.isSymbolicLink()) {
      throw new Error("Server installer generated an unsafe output");
    }
    await copyGeneratedTree(source, path.join(directory, name));
  }
  const userJvmArgs = path.join(directory, "user_jvm_args.txt");
  try {
    const stat = await fs.lstat(userJvmArgs);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Java argument file is not a regular file");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await fs.writeFile(userJvmArgs, "", { mode: 0o600, flag: "wx" });
  }
}

async function forgePromotions(signal) {
  const response = await fetchTrusted(
    "https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json",
    ["files.minecraftforge.net"], "Forge compatibility service",
    { headers: { "User-Agent": userAgent }, signal: requestSignal(signal, 15000) },
  );
  if (!response.ok) throw new Error(`Forge compatibility service returned HTTP ${response.status}`);
  const metadata = await response.json();
  if (!metadata.promos || typeof metadata.promos !== "object" || Array.isArray(metadata.promos)) {
    throw new Error("Forge compatibility service returned invalid metadata");
  }
  return metadata.promos;
}

async function installForgeServer(server, directory, { signal, onProgress } = {}) {
  const promos = await forgePromotions(signal);
  const forgeVersion = promos[`${server.version}-recommended`] ?? promos[`${server.version}-latest`];
  if (typeof forgeVersion !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(forgeVersion)) {
    throw new Error(`Forge does not support Minecraft ${server.version}`);
  }
  const installerUrl = `https://maven.minecraftforge.net/net/minecraftforge/forge/${server.version}-${forgeVersion}/forge-${server.version}-${forgeVersion}-installer.jar`;
  const checksumResponse = await fetchTrusted(`${installerUrl}.sha1`, ["maven.minecraftforge.net"],
    "Forge installer checksum", { headers: { "User-Agent": userAgent }, signal: requestSignal(signal, 15000) });
  if (!checksumResponse.ok) throw new Error(`Forge installer checksum returned HTTP ${checksumResponse.status}`);
  const checksum = /^\s*([a-f0-9]{40})(?:\s|$)/i.exec(await checksumResponse.text())?.[1];
  if (!checksum) throw new Error("Forge installer has no valid SHA-1 checksum");
  const javaMajor = await requiredJavaForVersion(server.version, signal);
  const staging = await fs.mkdtemp(path.join(directory, ".panel-forge-install-"));
  try {
    const installerPath = path.join(staging, "forge-installer.jar");
    await downloadVerified(installerUrl, installerPath, checksum, "sha1", { signal, onProgress });
    await runServerInstaller(server.java_path, installerPath, ["--installServer"], staging, {
      signal, onProgress, name: "Forge",
    });
    if (signal?.aborted) throw new DOMException("Installation cancelled", "AbortError");
    const argsFile = await locateInstallerArgsFile(staging, "minecraftforge", "forge");
    await copyServerInstallerOutput(staging, directory, installerPath);
    return {
      filename: null, javaMajor, loaderVersion: forgeVersion,
      javaArgs: ["@user_jvm_args.txt", `@${argsFile}`, "nogui"],
    };
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

function compareNumericVersions(a, b) {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

async function neoForgeInstallerMetadata(version, signal) {
  const installerUrl = `https://maven.neoforged.net/releases/net/neoforged/neoforge/${encodeURIComponent(version)}/neoforge-${encodeURIComponent(version)}-installer.jar`;
  const response = await fetchTrusted(`${installerUrl}.sha512`, ["maven.neoforged.net"],
    "NeoForge installer checksum", { headers: { "User-Agent": userAgent }, signal: requestSignal(signal, 15000) });
  if (!response.ok) throw new Error(`NeoForge installer checksum returned HTTP ${response.status}`);
  const checksum = /^\s*([a-f0-9]{128})(?:\s|$)/i.exec(await response.text())?.[1];
  if (!checksum) throw new Error("NeoForge installer has no valid SHA-512 checksum");
  return { installerUrl, checksum };
}

async function installNeoForgeServer(server, directory, { signal, onProgress } = {}) {
  const versions = (await listNeoForgeVersions(server.version, signal)).sort(compareNumericVersions);
  const neoForgeVersion = versions.at(-1);
  if (!neoForgeVersion) throw new Error(`NeoForge does not support Minecraft ${server.version}`);
  const { installerUrl, checksum } = await neoForgeInstallerMetadata(neoForgeVersion, signal);
  const javaMajor = await requiredJavaForVersion(server.version, signal);
  const staging = await fs.mkdtemp(path.join(directory, ".panel-neoforge-install-"));
  try {
    const installerPath = path.join(staging, "neoforge-installer.jar");
    await downloadVerified(installerUrl, installerPath, checksum, "sha512", { signal, onProgress });
    await runServerInstaller(server.java_path, installerPath, ["--installServer"], staging, {
      signal, onProgress, name: "NeoForge",
    });
    if (signal?.aborted) throw new DOMException("Installation cancelled", "AbortError");
    const argsFile = await locateInstallerArgsFile(staging, "neoforged", "neoforge");
    await copyServerInstallerOutput(staging, directory, installerPath);
    return {
      filename: null, javaMajor, loaderVersion: neoForgeVersion,
      javaArgs: ["@user_jvm_args.txt", `@${argsFile}`, "nogui"],
    };
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

export async function checkJava(javaPath, requiredMajor) {
  if (!Number.isInteger(requiredMajor) || requiredMajor < 8 || requiredMajor > 99) {
    throw new Error("Required Java major version is invalid");
  }
  const result = await new Promise((resolve, reject) => {
    const child = spawn(javaPath, ["-version"], { stdio: ["ignore", "ignore", "pipe"] });
    let output = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 10000);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      output += chunk;
      if (output.length > 4096) child.kill("SIGKILL");
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`Java version check timed out for ${javaPath}`));
      else resolve({ code, output });
    });
  });
  const match = /version "(?:1\.)?(\d+)/.exec(result.output);
  if (result.code !== 0 || !match) throw new Error(`Could not read Java version from ${javaPath}`);
  const major = Number(match[1]);
  if (major < requiredMajor) {
    throw new Error(`This Minecraft version requires Java ${requiredMajor} or newer; found Java ${major}`);
  }
  return { major, output: result.output.trim() };
}

async function downloadVerified(url, destination, expectedChecksum, algorithm, { signal, onProgress, headers = {} } = {}) {
  const trustedHosts = [
    "piston-data.mojang.com", "launcher.mojang.com", "fill-data.papermc.io",
    "api.purpurmc.org", "maven.fabricmc.net", "maven.quiltmc.org",
    "maven.minecraftforge.net", "maven.neoforged.net",
    "www.minecraft.net", "minecraft.azureedge.net", "download.geysermc.org",
  ];
  const response = await fetchTrusted(url, trustedHosts, "Server download", {
    headers: { "User-Agent": userAgent, ...headers },
    signal: requestSignal(signal, 120000),
  });
  if (!response.ok || !response.body) throw new Error(`Download failed with HTTP ${response.status}`);
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > 512 * 1024 * 1024) throw new Error("Server jar download exceeds the 512 MB safety limit");
  const temporary = `${destination}.part`;
  await fs.rm(temporary, { force: true });
  const hash = crypto.createHash(algorithm);
  let totalBytes = 0;
  const transform = new Transform({
    transform(chunk, _encoding, callback) {
      totalBytes += chunk.length;
      if (totalBytes > 512 * 1024 * 1024) return callback(new Error("Server jar download exceeds the 512 MB safety limit"));
      hash.update(chunk);
      onProgress?.(totalBytes, contentLength);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(response.body, transform, await fs.open(temporary, "wx", 0o600).then((file) => file.createWriteStream()));
    const actual = hash.digest("hex");
    if (expectedChecksum && actual.toLowerCase() !== expectedChecksum.toLowerCase()) {
      const checksumName = { sha1: "SHA-1", sha256: "SHA-256", sha512: "SHA-512", md5: "MD5" }[algorithm] ?? algorithm.toUpperCase();
      throw new Error(`Downloaded server jar failed ${checksumName} verification`);
    }
    await fs.rename(temporary, destination);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

export async function installServer(server, directory, { signal, onProgress } = {}) {
  if (signal?.aborted) throw new DOMException("Installation cancelled", "AbortError");
  if ((server.loader ?? server.software) === "bedrock") {
    return installBedrockServer(server, directory, { signal, onProgress });
  }
  if ((server.loader ?? server.software) === "fabric") {
    return installFabricServer(server, directory, { signal, onProgress });
  }
  if ((server.loader ?? server.software) === "quilt") {
    return installQuiltServer(server, directory, { signal, onProgress });
  }
  let url;
  let checksum;
  let filename = "server.jar";
  let javaMajor;
  if ((server.loader ?? server.software) === "forge") {
    return installForgeServer(server, directory, { signal, onProgress });
  }
  if ((server.loader ?? server.software) === "neoforge") {
    return installNeoForgeServer(server, directory, { signal, onProgress });
  }
  if (server.software === "vanilla") {
    const versions = await listMinecraftVersions(signal);
    const version = versions.find((entry) => entry.id === server.version);
    if (!version) throw new Error("Choose a Minecraft version listed by Mojang");
    const metadataResponse = await fetchTrusted(version.url,
      ["piston-meta.mojang.com", "launchermeta.mojang.com"], "Minecraft metadata", {
        headers: { "User-Agent": userAgent },
        signal: requestSignal(signal, 15000),
      });
    if (!metadataResponse.ok) throw new Error(`Minecraft metadata returned HTTP ${metadataResponse.status}`);
    const metadata = await metadataResponse.json();
    javaMajor = javaMajorFromMetadata(metadata, server.version);
    url = metadata.downloads?.server?.url;
    checksum = metadata.downloads?.server?.sha1;
    if (!url || !/^[a-f0-9]{40}$/i.test(checksum ?? "")) {
      throw new Error("Minecraft metadata does not provide a valid SHA-1 verified server download");
    }
  } else if ((server.loader ?? server.software) === "purpur") {
    const supported = await listPurpurVersions(signal);
    if (!supported.includes(server.version)) throw new Error(`Purpur does not support Minecraft ${server.version}`);
    const metadataResponse = await fetchTrusted(
      `https://api.purpurmc.org/v2/purpur/${encodeURIComponent(server.version)}/latest`,
      ["api.purpurmc.org"], "Purpur build service", {
        headers: { "User-Agent": userAgent },
        signal: requestSignal(signal, 15000),
      });
    if (!metadataResponse.ok) throw new Error(`Purpur build metadata returned HTTP ${metadataResponse.status}`);
    const build = await metadataResponse.json();
    if (build.project !== "purpur" || build.version !== server.version || !/^\d+$/.test(String(build.build)) ||
        !/^[a-f0-9]{32}$/i.test(build.md5 ?? "")) {
      throw new Error("Purpur metadata is missing a valid build or MD5 checksum");
    }
    javaMajor = await requiredJavaForVersion(server.version, signal);
    filename = `purpur-${server.version}-${build.build}.jar`;
    url = `https://api.purpurmc.org/v2/purpur/${encodeURIComponent(server.version)}/${encodeURIComponent(String(build.build))}/download`;
    await downloadVerified(url, path.join(directory, filename), build.md5, "md5", { signal, onProgress });
    if (server.crossplay) await installGeyserBridge(server, directory, { signal, onProgress });
    return { filename, javaMajor, ...(server.crossplay ? { crossplay: true } : {}) };
  } else {
    const response = await fetchTrusted(`${paperApiUrl}/versions/${encodeURIComponent(server.version)}/builds`,
      ["fill.papermc.io"], "Paper build service", {
        headers: { "User-Agent": userAgent },
        signal: requestSignal(signal, 15000),
      });
    if (!response.ok) throw new Error(`Paper does not support Minecraft ${server.version}`);
    const builds = await response.json();
    if (!Array.isArray(builds)) {
      throw new Error("Paper build service returned invalid metadata");
    }
    const build = builds.find((entry) => entry.channel === "STABLE");
    if (!build) {
      throw new Error(`No Paper builds are available for Minecraft ${server.version}`);
    }
    javaMajor = await requiredJavaForVersion(server.version, signal);
    const file = build.downloads?.["server:default"];
    const sha256 = file?.checksums?.sha256;
    if (!file?.name || path.basename(file.name) !== file.name || !/^[A-Za-z0-9._-]+\.jar$/.test(file.name) ||
        !/^[a-f0-9]{64}$/i.test(sha256 ?? "") || typeof file.url !== "string") {
      throw new Error("Paper metadata is missing a valid jar name, download URL, or SHA-256 checksum");
    }
    validateTrustedUrl(file.url, ["fill-data.papermc.io"], "Paper download");
    filename = file.name;
    url = file.url;
    await downloadVerified(url, path.join(directory, filename), sha256, "sha256", { signal, onProgress });
    if (server.crossplay) await installGeyserBridge(server, directory, { signal, onProgress });
    return { filename, javaMajor, ...(server.crossplay ? { crossplay: true } : {}) };
  }
  await downloadVerified(url, path.join(directory, filename), checksum, "sha1", { signal, onProgress });
  return { filename, javaMajor };
}

export function availableJavaRuntimes() {
  const paths = (process.env.PATH ?? "").split(path.delimiter);
  return Promise.all(paths.map(async (directory) => {
    const candidate = path.join(directory, "java");
    try {
      await fs.access(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      return undefined;
    }
  })).then((candidates) => [...new Set(candidates.filter(Boolean))]);
}
