import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import { db } from "./database.js";
import { curseForgeApiKey } from "./config.js";
import { extractZipEntries } from "./zip.js";

const modrinthBase = "https://api.modrinth.com/v2";
const userAgent = "Byte Server Panel/0.1.0 (https://github.com/byte/mc-server-panel)";
const modLoaders = new Set(["fabric", "forge", "neoforge", "quilt"]);
const pluginLoaders = new Set(["paper", "purpur"]);

function validateServerProviderType(server, projectType) {
  const loader = server.loader ?? server.software;
  if (projectType === "mod" && !modLoaders.has(loader)) {
    throw new Error("Mods require a Fabric, Forge, NeoForge, or Quilt server");
  }
  if (projectType === "plugin" && !pluginLoaders.has(loader)) {
    throw new Error("Plugins require Paper or Purpur");
  }
}

async function modrinthJson(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.hostname !== "api.modrinth.com") {
    throw new Error("Modrinth request URL is not trusted");
  }
  const response = await fetch(parsed, {
    headers: { "User-Agent": userAgent },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`Modrinth returned HTTP ${response.status}`);
  if (new URL(response.url).hostname !== "api.modrinth.com") throw new Error("Modrinth redirected to an untrusted host");
  return response.json();
}

function safeText(value, maximum = 256) {
  return typeof value === "string" && value.length <= maximum && !value.includes("\0");
}

async function safeProjectDirectory(directory, create = false) {
  try {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Project directory must be a regular directory");
    return true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    if (create) {
      await fs.mkdir(directory, { mode: 0o700 });
      return true;
    }
    return false;
  }
}

export async function searchModrinth(server, { query = "", type = "mod", limit = 20, offset = 0 } = {}) {
  validateServerProviderType(server, type);
  if (!safeText(query, 200) || !["mod", "plugin"].includes(type) ||
      !Number.isInteger(limit) || limit < 1 || limit > 50 ||
      !Number.isInteger(offset) || offset < 0 || offset > 10000) {
    throw new Error("Invalid project search filters");
  }
  const loader = server.loader ?? server.software;
  const facets = [[`project_type:${type}`]];
  facets.push([`versions:${server.version}`]);
  if (type === "mod") facets.push([`categories:${loader}`]);
  if (type === "plugin") facets.push(["server_side:required"]);
  const params = new URLSearchParams({
    query,
    limit: String(limit),
    offset: String(offset),
    facets: JSON.stringify(facets),
    index: "relevance",
  });
  const data = await modrinthJson(`${modrinthBase}/search?${params}`);
  if (!Array.isArray(data.hits)) throw new Error("Modrinth returned invalid search metadata");
  return {
    total_hits: data.total_hits,
    hits: data.hits.map((project) => ({
      id: project.project_id,
      slug: project.slug,
      title: project.title,
      description: project.description,
      author: project.author,
      downloads: project.downloads,
      icon_url: project.icon_url,
      categories: project.categories,
      versions: project.versions,
      project_type: project.project_type,
    })),
  };
}

export async function getModrinthProject(server, projectId, type = "mod") {
  validateServerProviderType(server, type);
  if (!safeText(projectId, 128) || !/^[A-Za-z0-9_-]+$/.test(projectId)) {
    throw new Error("Invalid Modrinth project ID");
  }
  const project = await modrinthJson(`${modrinthBase}/project/${encodeURIComponent(projectId)}`);
  if (project.project_type !== type) throw new Error(`Project is not a ${type}`);
  return project;
}

async function projectVersions(server, projectId, type) {
  const loader = server.loader ?? server.software;
  const params = new URLSearchParams({
    game_versions: JSON.stringify([server.version]),
    loaders: JSON.stringify(type === "plugin" ? ["paper"] : [loader]),
  });
  const versions = await modrinthJson(
    `${modrinthBase}/project/${encodeURIComponent(projectId)}/version?${params}`,
  );
  if (!Array.isArray(versions)) throw new Error("Modrinth returned invalid version metadata");
  return versions;
}

export async function listCompatibleProjectVersions(server, projectId, type = "mod") {
  validateServerProviderType(server, type);
  if (!safeText(projectId, 128) || !/^[A-Za-z0-9_-]+$/.test(projectId) ||
      !["mod", "plugin"].includes(type)) throw new Error("Invalid project version query");
  return (await projectVersions(server, projectId, type)).map((version) => ({
    id: version.id,
    name: version.name,
    version_number: version.version_number,
    game_versions: version.game_versions,
    loaders: version.loaders,
    date_published: version.date_published,
    dependencies: (version.dependencies ?? []).map((dependency) => ({
      project_id: dependency.project_id,
      version_id: dependency.version_id,
      dependency_type: dependency.dependency_type,
    })),
  }));
}

async function downloadModrinthFile(file, destination) {
  if (!file?.url || !safeText(file.filename, 255) || path.basename(file.filename) !== file.filename ||
      !/^[A-Za-z0-9._ -]+$/.test(file.filename)) {
    throw new Error("Modrinth returned an invalid project file");
  }
  const url = new URL(file.url);
  if (url.protocol !== "https:" || url.hostname !== "cdn.modrinth.com") {
    throw new Error("Modrinth file URL is not trusted");
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(120000), redirect: "error" });
  if (!response.ok || !response.body) throw new Error(`Project download returned HTTP ${response.status}`);
  const algorithm = file.hashes?.sha512 ? "sha512" : file.hashes?.sha1 ? "sha1" : null;
  if (!algorithm) throw new Error("Modrinth file metadata has no supported checksum");
  const expected = file.hashes[algorithm];
  const hash = crypto.createHash(algorithm);
  let size = 0;
  const transform = new Transform({
    transform(chunk, _encoding, callback) {
      size += chunk.length;
      if (size > 256 * 1024 * 1024) return callback(new Error("Project file exceeds 256 MB"));
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  const temporary = `${destination}.part`;
  try {
    await pipeline(response.body, transform, await fs.open(temporary, "wx", 0o600).then((fileHandle) => fileHandle.createWriteStream()));
    if (hash.digest("hex").toLowerCase() !== expected.toLowerCase()) {
      throw new Error("Project download failed checksum verification");
    }
    await fs.rename(temporary, destination);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

export async function listInstalledProjects(server, directory, type = "mod") {
  validateServerProviderType(server, type);
  const folder = type === "plugin" ? "plugins" : "mods";
  const root = path.join(directory, folder);
  if (!await safeProjectDirectory(root)) return [];
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    const tracked = db.prepare(`SELECT project_id, version_id, filename, project_title AS title, installed_at,
      EXISTS(SELECT 1 FROM project_install_history h
        WHERE h.server_id = project_installs.server_id AND h.project_type = project_installs.project_type
          AND h.project_id = project_installs.project_id) AS rollback_available,
      (SELECT version_id FROM project_install_history h
        WHERE h.server_id = project_installs.server_id AND h.project_type = project_installs.project_type
          AND h.project_id = project_installs.project_id ORDER BY h.id DESC LIMIT 1) AS previous_version_id
      FROM project_installs WHERE server_id = ? AND project_type = ?`).all(server.id, type);
    const known = new Set(tracked.map((entry) => entry.filename));
    return [
      ...tracked.map((entry) => ({ ...entry, managed: true })),
      ...entries.filter((entry) => entry.isFile() && entry.name.endsWith(".jar") && !known.has(entry.name))
        .map((entry) => ({ filename: entry.name, managed: false })),
    ];
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

export async function installModrinthProject(server, directory, projectId, versionId, type = "mod") {
  validateServerProviderType(server, type);
  const folder = type === "plugin" ? "plugins" : "mods";
  const root = path.join(directory, folder);
  await safeProjectDirectory(root, true);
  const alreadyInstalled = db.prepare(`SELECT version_id FROM project_installs
    WHERE server_id = ? AND project_type = ? AND project_id = ?`).get(server.id, type, projectId);
  if (alreadyInstalled) throw new Error(`Project is already installed at version ${alreadyInstalled.version_id}`);
  const resolvePlan = async (id, requestedVersion, stack = new Set()) => {
    if (stack.has(id)) throw new Error(`Modrinth dependency cycle detected at ${id}`);
    const tracked = db.prepare(`SELECT version_id, filename FROM project_installs
      WHERE server_id = ? AND project_type = ? AND project_id = ?`).get(server.id, type, id);
    if (tracked && (!requestedVersion || tracked.version_id === requestedVersion)) return [];
    if (tracked && requestedVersion && tracked.version_id !== requestedVersion) {
      throw new Error(`Required dependency ${id} is installed at an incompatible version`);
    }
    const project = await getModrinthProject(server, id, type);
    const versions = await projectVersions(server, id, type);
    const selected = requestedVersion ? versions.find((version) => version.id === requestedVersion) : versions[0];
    if (!selected) throw new Error(`No compatible ${type} release for required project ${id}`);
    const file = selected.files?.find((entry) => entry.primary) ?? selected.files?.[0];
    if (!file) throw new Error(`Project ${id} has no downloadable file in the selected version`);
    const nextStack = new Set(stack).add(id);
    const plan = [];
    for (const dependency of selected.dependencies ?? []) {
      if (dependency.dependency_type !== "required") continue;
      if (!dependency.project_id) throw new Error(`Required dependency for ${id} has no project metadata`);
      plan.push(...await resolvePlan(dependency.project_id, dependency.version_id, nextStack));
    }
    plan.push({ project, version: selected, file });
    return plan;
  };

  const plan = await resolvePlan(projectId, versionId);
  const projectIds = new Set();
  const filenames = new Set();
  const plannedProjects = new Set(plan.map((item) => item.project.id));
  for (const item of plan) {
    for (const dependency of item.version.dependencies ?? []) {
      if (dependency.dependency_type !== "incompatible" || !dependency.project_id) continue;
      const installed = db.prepare(`SELECT project_title FROM project_installs
        WHERE server_id = ? AND project_type = ? AND project_id = ?`)
        .get(server.id, type, dependency.project_id);
      if (installed || plannedProjects.has(dependency.project_id)) {
        throw new Error(`Project ${item.project.title} conflicts with ${installed?.project_title ?? dependency.project_id}`);
      }
    }
    if (!safeText(item.file.filename, 255) || path.basename(item.file.filename) !== item.file.filename ||
        !/^[A-Za-z0-9._ -]+$/.test(item.file.filename)) {
      throw new Error("Modrinth returned an invalid project filename");
    }
    if (projectIds.has(item.project.id)) throw new Error(`Duplicate project ${item.project.id} in dependency plan`);
    if (filenames.has(item.file.filename)) throw new Error(`Dependency files collide at ${item.file.filename}`);
    projectIds.add(item.project.id);
    filenames.add(item.file.filename);
    try {
      await fs.lstat(path.join(root, item.file.filename));
      throw new Error(`A file named ${item.file.filename} is already installed`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const stage = await fs.mkdtemp(path.join(root, ".panel-install-"));
  const moved = [];
  try {
    for (const item of plan) await downloadModrinthFile(item.file, path.join(stage, item.file.filename));
    for (const item of plan) {
      const destination = path.join(root, item.file.filename);
      await fs.rename(path.join(stage, item.file.filename), destination);
      moved.push(destination);
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      const insert = db.prepare(`INSERT INTO project_installs
        (server_id, project_type, project_id, version_id, filename, project_title)
        VALUES(?,?,?,?,?,?)`);
      for (const item of plan) {
        insert.run(server.id, type, item.project.id, item.version.id, item.file.filename, item.project.title);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } catch (error) {
    for (const filename of moved) await fs.rm(filename, { force: true });
    throw error;
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
  }
  return {
    project: { id: plan.at(-1).project.id, slug: plan.at(-1).project.slug, title: plan.at(-1).project.title },
    version: { id: plan.at(-1).version.id, name: plan.at(-1).version.name, version_number: plan.at(-1).version.version_number },
    filename: plan.at(-1).file.filename,
    dependencies: plan.slice(0, -1).map((item) => ({ id: item.project.id, title: item.project.title, filename: item.file.filename })),
  };
}

export async function updateModrinthProject(server, directory, projectId, type = "mod") {
  validateServerProviderType(server, type);
  if (!safeText(projectId, 128) || !/^[A-Za-z0-9_-]+$/.test(projectId)) {
    throw new Error("Invalid Modrinth project ID");
  }
  const tracked = db.prepare(`SELECT version_id, filename, project_title AS title FROM project_installs
    WHERE server_id = ? AND project_type = ? AND project_id = ?`).get(server.id, type, projectId);
  if (!tracked) throw new Error("Project is not managed by the panel");
  const project = await getModrinthProject(server, projectId, type);
  const versions = await projectVersions(server, projectId, type);
  const selected = versions[0];
  if (!selected) throw new Error(`No compatible ${type} release is available`);
  if (selected.id === tracked.version_id) throw new Error("The installed project is already at the latest compatible version");
  for (const dependency of selected.dependencies ?? []) {
    if (dependency.dependency_type !== "required") continue;
    const installedDependency = dependency.project_id && db.prepare(`SELECT version_id FROM project_installs
      WHERE server_id = ? AND project_type = ? AND project_id = ?`).get(server.id, type, dependency.project_id);
    if (!installedDependency || (dependency.version_id && installedDependency.version_id !== dependency.version_id)) {
      throw new Error(`Required dependency ${dependency.project_id ?? "unknown"} must be installed or updated first`);
    }
  }
  for (const dependency of selected.dependencies ?? []) {
    if (dependency.dependency_type !== "incompatible" || !dependency.project_id) continue;
    const installedConflict = db.prepare(`SELECT project_title FROM project_installs
      WHERE server_id = ? AND project_type = ? AND project_id = ?`)
      .get(server.id, type, dependency.project_id);
    if (installedConflict) throw new Error(`Project update conflicts with ${installedConflict.project_title}`);
  }
  const file = selected.files?.find((entry) => entry.primary) ?? selected.files?.[0];
  if (!file || !safeText(file.filename, 255) || path.basename(file.filename) !== file.filename ||
      !/^[A-Za-z0-9._ -]+$/.test(file.filename)) {
    throw new Error("Modrinth returned an invalid project file");
  }
  const folder = type === "plugin" ? "plugins" : "mods";
  const root = path.join(directory, folder);
  await safeProjectDirectory(root, true);
  const currentPath = path.join(root, tracked.filename);
  const currentStat = await fs.lstat(currentPath);
  if (!currentStat.isFile() || currentStat.isSymbolicLink()) throw new Error("Installed project file is invalid");
  const nextPath = path.join(root, file.filename);
  if (nextPath !== currentPath) {
    try {
      await fs.lstat(nextPath);
      throw new Error(`A file named ${file.filename} already exists`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const history = path.join(root, ".panel-history");
  await safeProjectDirectory(history, true);
  const backupFilename = `.panel-history/${randomUUID()}-${tracked.filename}`;
  const backupPath = path.join(root, backupFilename);
  const stage = await fs.mkdtemp(path.join(root, ".panel-update-"));
  const stagedFile = path.join(stage, file.filename);
  let oldMoved = false;
  let updatedMoved = false;
  try {
    await downloadModrinthFile(file, stagedFile);
    await fs.rename(currentPath, backupPath);
    oldMoved = true;
    await fs.rename(stagedFile, nextPath);
    updatedMoved = true;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(`UPDATE project_installs SET version_id = ?, filename = ?, project_title = ?, installed_at = CURRENT_TIMESTAMP
        WHERE server_id = ? AND project_type = ? AND project_id = ?`)
        .run(selected.id, file.filename, project.title, server.id, type, projectId);
      db.prepare(`INSERT INTO project_install_history
        (server_id, project_type, project_id, version_id, filename, project_title, backup_filename)
        VALUES(?,?,?,?,?,?,?)`)
        .run(server.id, type, projectId, tracked.version_id, tracked.filename, tracked.title, backupFilename);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } catch (error) {
    if (updatedMoved) await fs.rm(nextPath, { force: true });
    if (oldMoved) await fs.rename(backupPath, currentPath);
    throw error;
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
  }
  return {
    project: { id: project.id, slug: project.slug, title: project.title },
    version: { id: selected.id, name: selected.name, version_number: selected.version_number },
    filename: file.filename,
    rollback_available: true,
  };
}

export async function rollbackModrinthProject(server, directory, projectId, type = "mod") {
  validateServerProviderType(server, type);
  if (!safeText(projectId, 128) || !/^[A-Za-z0-9_-]+$/.test(projectId)) {
    throw new Error("Invalid Modrinth project ID");
  }
  const current = db.prepare(`SELECT version_id, filename FROM project_installs
    WHERE server_id = ? AND project_type = ? AND project_id = ?`).get(server.id, type, projectId);
  const previous = db.prepare(`SELECT id, version_id, filename, project_title, backup_filename
    FROM project_install_history WHERE server_id = ? AND project_type = ? AND project_id = ?
    ORDER BY id DESC LIMIT 1`).get(server.id, type, projectId);
  if (!current || !previous) throw new Error("No managed previous version is available");
  if (path.posix.dirname(previous.backup_filename) !== ".panel-history" ||
      [".", ".."].includes(path.posix.basename(previous.backup_filename))) {
    throw new Error("Project rollback metadata contains an invalid backup path");
  }
  const folder = type === "plugin" ? "plugins" : "mods";
  const root = path.join(directory, folder);
  if (!await safeProjectDirectory(root)) throw new Error("Project directory is missing");
  const currentPath = path.join(root, current.filename);
  const previousPath = path.join(root, previous.backup_filename);
  const currentStat = await fs.lstat(currentPath);
  const previousStat = await fs.lstat(previousPath);
  if (!currentStat.isFile() || currentStat.isSymbolicLink() || !previousStat.isFile() || previousStat.isSymbolicLink()) {
    throw new Error("Current or previous project file is invalid");
  }
  const restoredPath = path.join(root, previous.filename);
  if (restoredPath !== currentPath) {
    try {
      await fs.lstat(restoredPath);
      throw new Error(`Cannot restore because ${previous.filename} already exists`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const history = path.join(root, ".panel-history");
  if (!await safeProjectDirectory(history)) throw new Error("Project rollback directory is missing");
  const discardedPath = path.join(history, `${randomUUID()}-${current.filename}`);
  let currentMoved = false;
  let previousMoved = false;
  try {
    await fs.rename(currentPath, discardedPath);
    currentMoved = true;
    await fs.rename(previousPath, restoredPath);
    previousMoved = true;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(`UPDATE project_installs SET version_id = ?, filename = ?, project_title = ?, installed_at = CURRENT_TIMESTAMP
        WHERE server_id = ? AND project_type = ? AND project_id = ?`)
        .run(previous.version_id, previous.filename, previous.project_title, server.id, type, projectId);
      db.prepare("DELETE FROM project_install_history WHERE id = ?").run(previous.id);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } catch (error) {
    if (previousMoved) await fs.rename(restoredPath, previousPath);
    if (currentMoved) await fs.rename(discardedPath, currentPath);
    throw error;
  }
  await fs.rm(discardedPath, { force: true });
  return { project_id: projectId, version_id: previous.version_id, filename: previous.filename };
}

export async function removeInstalledProject(server, directory, filename, type = "mod") {
  validateServerProviderType(server, type);
  if (!safeText(filename, 255) || path.basename(filename) !== filename || !filename.endsWith(".jar")) {
    throw new Error("Invalid project filename");
  }
  const folder = type === "plugin" ? "plugins" : "mods";
  const root = path.join(directory, folder);
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Project directory is invalid");
  const target = path.join(root, filename);
  const stat = await fs.lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Project file is not a regular file");
  const tracked = db.prepare(`SELECT project_id FROM project_installs
    WHERE server_id = ? AND project_type = ? AND filename = ?`).get(server.id, type, filename);
  const historyFiles = [];
  if (tracked) {
    const historyRows = db.prepare(`SELECT backup_filename FROM project_install_history
      WHERE server_id = ? AND project_type = ? AND project_id = ?`).all(server.id, type, tracked.project_id);
    if (historyRows.length && !await safeProjectDirectory(path.join(root, ".panel-history"))) {
      throw new Error("Project rollback directory is missing");
    }
    for (const row of historyRows) {
      if (path.posix.dirname(row.backup_filename) !== ".panel-history" ||
          [".", ".."].includes(path.posix.basename(row.backup_filename))) {
        throw new Error("Project rollback metadata contains an invalid backup path");
      }
      const historyPath = path.join(root, row.backup_filename);
      const historyStat = await fs.lstat(historyPath);
      if (!historyStat.isFile() || historyStat.isSymbolicLink()) throw new Error("Project rollback file is invalid");
      historyFiles.push(historyPath);
    }
  }
  const trash = `${target}.removed-${randomUUID()}`;
  await fs.rename(target, trash);
  await fs.rm(trash);
  for (const historyPath of historyFiles) await fs.rm(historyPath);
  if (historyFiles.length) {
    await fs.rmdir(path.join(root, ".panel-history")).catch((error) => {
      if (error.code !== "ENOTEMPTY" && error.code !== "ENOENT") throw error;
    });
  }
  if (tracked) {
    db.prepare(`DELETE FROM project_install_history
      WHERE server_id = ? AND project_type = ? AND project_id = ?`).run(server.id, type, tracked.project_id);
  }
  db.prepare("DELETE FROM project_installs WHERE server_id = ? AND project_type = ? AND filename = ?")
    .run(server.id, type, filename);
}

const curseForgeBase = "https://api.curseforge.com/v1/";
const curseForgeLoaderTypes = Object.freeze({ forge: 1, fabric: 4, quilt: 5, neoforge: 6 });

function validateCurseForgeServer(server) {
  const loader = server.loader ?? server.software;
  if (!curseForgeLoaderTypes[loader]) throw new Error("CurseForge mods require Fabric, Forge, NeoForge, or Quilt");
  if (!curseForgeApiKey) throw new Error("Set MC_PANEL_CURSEFORGE_API_KEY in the panel service environment to enable CurseForge");
  return { loader, loaderType: curseForgeLoaderTypes[loader] };
}

async function curseForgeJson(endpoint) {
  const url = new URL(endpoint.replace(/^\/+/, ""), curseForgeBase);
  if (url.protocol !== "https:" || url.hostname !== "api.curseforge.com" || !url.pathname.startsWith("/v1/")) {
    throw new Error("CurseForge request URL is not trusted");
  }
  const response = await fetch(url, {
    headers: { "User-Agent": userAgent, "x-api-key": curseForgeApiKey, accept: "application/json" },
    signal: AbortSignal.timeout(20000),
    redirect: "error",
  });
  if (!response.ok) throw new Error(`CurseForge returned HTTP ${response.status}`);
  if (new URL(response.url).hostname !== "api.curseforge.com") throw new Error("CurseForge redirected to an untrusted host");
  const body = await response.json();
  if (!body || !Object.hasOwn(body, "data")) throw new Error("CurseForge returned invalid API metadata");
  return body;
}

export async function searchCurseForge(server, { query = "", type = "mod", limit = 20, offset = 0 } = {}) {
  const { loaderType } = validateCurseForgeServer(server);
  if (type !== "mod" || !safeText(query, 200) ||
      !Number.isInteger(limit) || limit < 1 || limit > 50 ||
      !Number.isInteger(offset) || offset < 0 || offset > 10000) {
    throw new Error("Invalid CurseForge mod search filters");
  }
  const params = new URLSearchParams({
    gameId: "432",
    classId: "6",
    gameVersion: server.version,
    modLoaderType: String(loaderType),
    searchFilter: query,
    pageSize: String(limit),
    index: String(offset),
    sortField: "2",
    sortOrder: "desc",
  });
  const body = await curseForgeJson(`/mods/search?${params}`);
  if (!Array.isArray(body?.data) || !body.pagination || !Number.isInteger(body.pagination.totalCount)) {
    throw new Error("CurseForge returned invalid mod search results");
  }
  return {
    total_hits: body.pagination.totalCount,
    hits: body.data.map((project) => ({
      id: String(project.id),
      title: project.name,
      description: project.summary ?? "",
      author: project.authors?.map((author) => author.name).filter(Boolean).join(", ") ?? "Unknown author",
      downloads: project.downloadCount ?? 0,
      icon_url: project.logo?.url ?? null,
    })),
  };
}

async function curseForgeFiles(server, projectId) {
  const { loaderType } = validateCurseForgeServer(server);
  if (!/^\d{1,12}$/.test(String(projectId))) throw new Error("Invalid CurseForge project ID");
  const params = new URLSearchParams({
    gameVersion: server.version,
    modLoaderType: String(loaderType),
    pageSize: "50",
    index: "0",
    sortField: "4",
    sortOrder: "desc",
  });
  const body = await curseForgeJson(`/mods/${encodeURIComponent(projectId)}/files?${params}`);
  if (!Array.isArray(body?.data)) throw new Error("CurseForge returned invalid file metadata");
  return body.data.filter((file) =>
    Array.isArray(file.gameVersions) && file.gameVersions.includes(server.version) &&
    file.modLoaderType === loaderType && file.isAvailable !== false &&
    /^\d{1,12}$/.test(String(file.id)) &&
    typeof file.fileName === "string" && path.basename(file.fileName) === file.fileName &&
    /^[A-Za-z0-9._ -]{1,180}\.jar$/i.test(file.fileName) &&
    typeof file.downloadUrl === "string" &&
    Array.isArray(file.hashes) && file.hashes.some((hash) => hash.algo === 1 && /^[a-f0-9]{40}$/i.test(hash.value)),
  );
}

async function curseForgeFile(projectId, fileId) {
  if (!/^\d{1,12}$/.test(String(projectId)) || !/^\d{1,12}$/.test(String(fileId))) {
    throw new Error("Invalid CurseForge project or file ID");
  }
  const body = await curseForgeJson(`/mods/${encodeURIComponent(projectId)}/files/${encodeURIComponent(fileId)}`);
  if (!body.data || String(body.data.id) !== String(fileId)) throw new Error("CurseForge returned invalid file metadata");
  return body.data;
}

async function downloadCurseForgeFile(file, destination, maximumBytes) {
  const checksum = file.hashes?.find((hash) => hash.algo === 1)?.value?.toLowerCase();
  if (!checksum || !/^[a-f0-9]{40}$/.test(checksum)) throw new Error("CurseForge file has no supported SHA-1 checksum");
  const downloadUrl = new URL(file.downloadUrl);
  if (downloadUrl.protocol !== "https:" || !downloadUrl.hostname.endsWith(".forgecdn.net")) {
    throw new Error("CurseForge file URL is not on its trusted CDN");
  }
  const response = await fetch(downloadUrl, { signal: AbortSignal.timeout(120000), redirect: "error" });
  if (!response.ok || !response.body) throw new Error(`CurseForge download returned HTTP ${response.status}`);
  if (new URL(response.url).hostname !== downloadUrl.hostname) throw new Error("CurseForge download redirected to an untrusted host");
  const hash = crypto.createHash("sha1");
  let size = 0;
  const transform = new Transform({
    transform(chunk, _encoding, callback) {
      size += chunk.length;
      if (size > maximumBytes) return callback(new Error("CurseForge download exceeds the supported size limit"));
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(response.body, transform,
      await fs.open(destination, "wx", 0o600).then((handle) => handle.createWriteStream()));
    if (hash.digest("hex") !== checksum) throw new Error("CurseForge file failed SHA-1 verification");
    return size;
  } catch (error) {
    await fs.rm(destination, { force: true });
    throw error;
  }
}

export async function listCurseForgeProjectVersions(server, projectId) {
  return (await curseForgeFiles(server, projectId)).map((file) => ({
    id: String(file.id),
    name: file.displayName ?? file.fileName,
    version_number: file.fileName,
    game_versions: file.gameVersions,
    loaders: [server.loader ?? server.software],
  }));
}

export async function installCurseForgeProject(server, directory, projectId, fileId) {
  validateServerProviderType(server, "mod");
  const file = (await curseForgeFiles(server, projectId)).find((item) => String(item.id) === String(fileId));
  if (!file) throw new Error("CurseForge file is unavailable or incompatible with this server");
  const root = path.join(directory, "mods");
  await safeProjectDirectory(root, true);
  const destination = path.join(root, file.fileName);
  try {
    await fs.lstat(destination);
    throw new Error(`A file named ${file.fileName} already exists`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const temporary = path.join(root, `.panel-download-${randomUUID()}.part`);
  try {
    await downloadCurseForgeFile(file, temporary, 256 * 1024 * 1024);
    await fs.link(temporary, destination);
    await fs.rm(temporary);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
  return { project_id: String(projectId), version_id: String(file.id), filename: file.fileName, title: file.displayName };
}

export async function searchCurseForgeModpacks(server, { query = "", limit = 20, offset = 0 } = {}) {
  validateCurseForgeServer(server);
  if (!safeText(query, 200) || !Number.isInteger(limit) || limit < 1 || limit > 50 ||
      !Number.isInteger(offset) || offset < 0 || offset > 10000) {
    throw new Error("Invalid CurseForge modpack search filters");
  }
  const params = new URLSearchParams({
    gameId: "432", classId: "4471", gameVersion: server.version, searchFilter: query,
    pageSize: String(limit), index: String(offset), sortField: "2", sortOrder: "desc",
  });
  const body = await curseForgeJson(`/mods/search?${params}`);
  if (!Array.isArray(body?.data) || !body.pagination || !Number.isInteger(body.pagination.totalCount)) {
    throw new Error("CurseForge returned invalid modpack search results");
  }
  return {
    total_hits: body.pagination.totalCount,
    hits: body.data.map((project) => ({
      id: String(project.id),
      title: project.name,
      description: project.summary ?? "",
      author: project.authors?.map((author) => author.name).filter(Boolean).join(", ") ?? "Unknown author",
      downloads: project.downloadCount ?? 0,
      icon_url: project.logo?.url ?? null,
    })),
  };
}

export async function listCurseForgeModpackVersions(server, projectId) {
  validateCurseForgeServer(server);
  if (!/^\d{1,12}$/.test(String(projectId))) throw new Error("Invalid CurseForge modpack ID");
  const params = new URLSearchParams({ gameVersion: server.version, pageSize: "50", index: "0", sortField: "4", sortOrder: "desc" });
  const body = await curseForgeJson(`/mods/${encodeURIComponent(projectId)}/files?${params}`);
  if (!Array.isArray(body?.data)) throw new Error("CurseForge returned invalid modpack file metadata");
  return body.data.filter((file) =>
    /^\d{1,12}$/.test(String(file.id)) && file.isAvailable !== false &&
    typeof file.fileName === "string" && /\.zip$/i.test(file.fileName) &&
    Array.isArray(file.gameVersions) && file.gameVersions.includes(server.version) &&
    Array.isArray(file.hashes) && file.hashes.some((hash) => hash.algo === 1 && /^[a-f0-9]{40}$/i.test(hash.value)),
  ).map((file) => ({
    id: String(file.id),
    name: file.displayName ?? file.fileName,
    version_number: file.fileName,
    game_versions: file.gameVersions,
    loaders: [],
  }));
}

const modpackOverrideRoots = new Set([
  "mods", "config", "defaultconfigs", "kubejs", "scripts", "resourcepacks", "datapacks",
]);
async function ensureSafeDirectories(root, relativeDirectory, createdDirectories) {
  let current = root;
  for (const segment of relativeDirectory.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const stat = await fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Modpack destination contains an unsafe directory");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await fs.mkdir(current, { mode: 0o700 });
      createdDirectories.push(current);
    }
  }
}

export async function installCurseForgeModpack(server, directory, projectId, fileId) {
  const { loader } = validateCurseForgeServer(server);
  const rootStat = await fs.lstat(directory);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Server directory is invalid");
  const packFile = await curseForgeFile(projectId, fileId);
  if (packFile.isAvailable === false || !Array.isArray(packFile.gameVersions) ||
      !packFile.gameVersions.includes(server.version) || !/^[A-Za-z0-9._ -]{1,180}\.zip$/i.test(packFile.fileName ?? "")) {
    throw new Error("CurseForge modpack file is unavailable or incompatible with this Minecraft version");
  }
  const modsDirectory = path.join(directory, "mods");
  try {
    const modsStat = await fs.lstat(modsDirectory);
    if (!modsStat.isDirectory() || modsStat.isSymbolicLink()) throw new Error("Mod directory is invalid");
    if ((await fs.readdir(modsDirectory)).length) {
      throw new Error("Remove existing mods before installing a modpack to avoid mixing incompatible mod sets");
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const stage = path.join(directory, `.panel-modpack-${randomUUID()}`);
  await fs.mkdir(stage, { mode: 0o700 });
  const archivePath = path.join(stage, "pack.zip");
  const payloadPath = path.join(stage, "payload");
  await fs.mkdir(payloadPath, { mode: 0o700 });
  const createdDirectories = [];
  const committedFiles = [];
  try {
    await downloadCurseForgeFile(packFile, archivePath, 128 * 1024 * 1024);
    const entries = extractZipEntries(await fs.readFile(archivePath));
    await fs.rm(archivePath, { force: true });
    const manifestBytes = entries.get("manifest.json");
    if (!manifestBytes || manifestBytes.length > 1024 * 1024) throw new Error("CurseForge modpack has no valid manifest.json");
    let manifest;
    try {
      manifest = JSON.parse(manifestBytes.toString("utf8"));
    } catch {
      throw new Error("CurseForge modpack manifest is not valid JSON");
    }
    if (manifest.minecraft?.version !== server.version || !Array.isArray(manifest.minecraft?.modLoaders) ||
        !Array.isArray(manifest.files) || manifest.files.length > 2000) {
      throw new Error("CurseForge modpack manifest is incomplete or targets a different Minecraft version");
    }
    const loaderEntries = manifest.minecraft.modLoaders.filter((entry) => entry?.primary === true);
    const selectedLoader = loaderEntries[0] ?? manifest.minecraft.modLoaders[0];
    const loaderId = selectedLoader?.id;
    if (typeof loaderId !== "string" || !loaderId.startsWith(`${loader}-`)) {
      throw new Error(`CurseForge modpack requires a different loader than ${loader}`);
    }
    const overrideFolder = manifest.overrides ?? "overrides";
    if (typeof overrideFolder !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(overrideFolder)) {
      throw new Error("CurseForge modpack has an invalid overrides directory");
    }
    const modFiles = [];
    for (const item of manifest.files) {
      if (!item || item.required === false) continue;
      if (!/^\d{1,12}$/.test(String(item.projectID)) || !/^\d{1,12}$/.test(String(item.fileID))) {
        throw new Error("CurseForge modpack contains an invalid file reference");
      }
      const file = await curseForgeFile(item.projectID, item.fileID);
      if (file.isAvailable === false || !/^[A-Za-z0-9._ -]{1,180}\.jar$/i.test(file.fileName ?? "") ||
          !Array.isArray(file.gameVersions) || !file.gameVersions.includes(server.version) ||
          (file.modLoaderType && file.modLoaderType !== curseForgeLoaderTypes[loader])) {
        throw new Error(`CurseForge modpack file ${item.fileID} is unavailable or incompatible`);
      }
      const relative = path.join("mods", file.fileName);
      modFiles.push({ file, relative });
    }
    const destinations = new Set();
    const staged = [];
    let modDownloadBytes = 0;
    for (const { file, relative } of modFiles) {
      if (destinations.has(relative)) throw new Error("CurseForge modpack has duplicate mod filenames");
      destinations.add(relative);
      const stagedPath = path.join(payloadPath, relative);
      await fs.mkdir(path.dirname(stagedPath), { recursive: true, mode: 0o700 });
      modDownloadBytes += await downloadCurseForgeFile(file, stagedPath, 256 * 1024 * 1024);
      if (modDownloadBytes > 1024 * 1024 * 1024) throw new Error("Modpack required files exceed the 1 GiB download limit");
      staged.push({ relative, stagedPath });
    }
    let skippedOverrides = 0;
    for (const [entryName, bytes] of entries) {
      const prefix = `${overrideFolder}/`;
      if (!entryName.startsWith(prefix)) continue;
      const relativeName = entryName.slice(prefix.length);
      const segments = relativeName.split("/");
      if (!modpackOverrideRoots.has(segments[0])) {
        skippedOverrides++;
        continue;
      }
      if (segments[0] === "mods" && !/\.jar$/i.test(segments.at(-1))) {
        throw new Error("CurseForge modpack mods overrides may contain only JAR files");
      }
      const relative = segments.join(path.sep);
      if (destinations.has(relative)) throw new Error(`CurseForge modpack has colliding override path ${relativeName}`);
      destinations.add(relative);
      const stagedPath = path.join(payloadPath, relative);
      await fs.mkdir(path.dirname(stagedPath), { recursive: true, mode: 0o700 });
      await fs.writeFile(stagedPath, bytes, { flag: "wx", mode: 0o600 });
      staged.push({ relative, stagedPath });
    }
    const markerRelative = ".panel-modpack.json";
    const markerPath = path.join(payloadPath, markerRelative);
    await fs.writeFile(markerPath, JSON.stringify({
      provider: "curseforge",
      project_id: String(projectId),
      file_id: String(fileId),
      minecraft_version: server.version,
      loader,
      loader_version: loaderId.slice(loader.length + 1),
      installed_at: new Date().toISOString(),
    }, null, 2), { flag: "wx", mode: 0o600 });
    staged.push({ relative: markerRelative, stagedPath: markerPath });
    for (const item of staged) {
      const destination = path.join(directory, item.relative);
      await ensureSafeDirectories(directory, path.dirname(item.relative), createdDirectories);
      try {
        await fs.lstat(destination);
        throw new Error(`Modpack install would overwrite existing file ${item.relative}`);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    for (const item of staged) {
      const destination = path.join(directory, item.relative);
      await fs.link(item.stagedPath, destination);
      committedFiles.push(destination);
    }
    return {
      project_id: String(projectId),
      file_id: String(fileId),
      title: packFile.displayName ?? packFile.fileName,
      minecraft_version: server.version,
      loader,
      installed_files: staged.length,
      skipped_overrides: skippedOverrides,
    };
  } catch (error) {
    for (const filename of committedFiles) await fs.rm(filename, { force: true });
    for (const directoryPath of createdDirectories.reverse()) {
      await fs.rmdir(directoryPath).catch((removeError) => {
        if (removeError.code !== "ENOTEMPTY" && removeError.code !== "ENOENT") throw removeError;
      });
    }
    throw error;
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
  }
}
