import http from "node:http";
import https from "node:https";
import { createReadStream } from "node:fs";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { allowedPanelHosts, host, port, secureCookies, tlsCertPath, tlsKeyPath } from "./config.js";
import {
  acceptEula, cancelJob, createBackup, createLiveWorldSnapshot, createServer, createServerFile, createWorldBackup, deleteServer, deleteServerFile, downloadServerFile,
  getBackupDownload, getBackupSchedule, getLanAddresses, getLog, getPlayerRecords, getProjectVersions, getServer, getServerHistory, getServers,
  getWorldBackupDownload, getWorlds, getJob, getModpackVersions, importWorldArchive, installModpack, listBackups, listWorldBackups, getInstalledProjects, getProject, moveServerFile, playerAction,
  queryOnlinePlayers, readServerFiles, removeProject, resolvePlayerProfile, restoreBackup, restoreWorldBackup, rollbackProject, searchProjects, sendCommand, setBackupSchedule,
  queueInstall, retryJob, queryServerTelemetry, searchModpacks, startServer, restartServer, setAutoRestart, stopServer, subscribe, uploadServerFile, updatePlayerRecords, writeServerFile, installProject, updateProject,
} from "./manager.js";
import {
  availableJavaRuntimes, listFabricMinecraftVersions, listMinecraftVersions,
  listForgeMinecraftVersions, listNeoForgeVersions, listPaperVersions, listPurpurVersions,
  listQuiltMinecraftVersions, listBedrockVersions, requiredJavaForVersion,
} from "./minecraft.js";
import {
  authenticate, createSession, getSession, hasPassword, invalidateOtherSessions, parseCookies, removeSession, setPassword,
} from "./security.js";

const staticRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");
const loginAttempts = new Map();
const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);

function sendJson(response, status, value, headers = {}) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  response.end(JSON.stringify(value));
}

function streamFile(response, filename) {
  const stream = createReadStream(filename);
  stream.once("error", (error) => response.destroy(error));
  return stream.pipe(response);
}

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function readJson(request) {
  let content = "";
  for await (const chunk of request) {
    content += chunk;
    if (Buffer.byteLength(content) > 1024 * 1024) throw fail(413, "Request body exceeds 1 MB");
  }
  try {
    return content ? JSON.parse(content) : {};
  } catch {
    throw fail(400, "Request body must contain valid JSON");
  }
}

function sessionCookie(id, maxAge) {
  return `mc_panel_session=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secureCookies ? "; Secure" : ""}`;
}

function requireSameOrigin(request) {
  if (safeMethods.has(request.method)) return;
  const origin = request.headers.origin;
  const hostHeader = request.headers.host;
  if (!origin || !hostHeader) throw fail(403, "Same-origin request required");
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    throw fail(403, "Invalid request origin");
  }
  if (parsed.host !== hostHeader || !["http:", "https:"].includes(parsed.protocol)) {
    throw fail(403, "Cross-origin request rejected");
  }
}

function authenticateRequest(request) {
  const cookies = parseCookies(request.headers.cookie);
  const id = cookies.mc_panel_session;
  const session = getSession(id);
  if (!session) throw fail(401, "Sign in to continue");
  if (!safeMethods.has(request.method) && request.headers["x-csrf-token"] !== session.csrf) {
    throw fail(403, "Invalid or missing CSRF token");
  }
  return session;
}

async function api(request, response, url) {
  const pathname = url.pathname;
  if (request.method === "GET" && pathname === "/api/setup") {
    return sendJson(response, 200, { configured: hasPassword() });
  }
  if (request.method === "POST" && pathname === "/api/setup") {
    requireSameOrigin(request);
    if (hasPassword()) throw fail(409, "Panel setup has already been completed");
    const body = await readJson(request);
    await setPassword(body.password);
    const session = createSession();
    return sendJson(response, 200, { csrf: session.csrf }, { "set-cookie": sessionCookie(session.id, 43200) });
  }
  if (request.method === "POST" && pathname === "/api/login") {
    requireSameOrigin(request);
    const address = request.socket.remoteAddress ?? "unknown";
    const attempt = loginAttempts.get(address) ?? { count: 0, until: 0 };
    if (attempt.until > Date.now()) throw fail(429, "Too many sign-in attempts. Try again later.");
    const body = await readJson(request);
    if (!await authenticate(body.password)) {
      attempt.count++;
      if (attempt.count >= 5) {
        attempt.count = 0;
        attempt.until = Date.now() + 60_000;
      }
      loginAttempts.set(address, attempt);
      throw fail(401, "Incorrect password");
    }
    loginAttempts.delete(address);
    const session = createSession();
    return sendJson(response, 200, { csrf: session.csrf }, { "set-cookie": sessionCookie(session.id, 43200) });
  }
  if (request.method === "GET" && pathname === "/api/session") {
    const session = getSession(parseCookies(request.headers.cookie).mc_panel_session);
    return sendJson(response, 200, { configured: hasPassword(), authenticated: Boolean(session), csrf: session?.csrf ?? null });
  }
  if (request.method === "POST" && pathname === "/api/logout") {
    const cookies = parseCookies(request.headers.cookie);
    authenticateRequest(request);
    removeSession(cookies.mc_panel_session);
    return sendJson(response, 200, { ok: true }, { "set-cookie": sessionCookie("", 0) });
  }

  requireSameOrigin(request);
  authenticateRequest(request);

  if (request.method === "POST" && pathname === "/api/password") {
    const body = await readJson(request);
    if (!await authenticate(body.current_password)) throw fail(401, "Current password is incorrect");
    await setPassword(body.new_password);
    const sessionId = parseCookies(request.headers.cookie).mc_panel_session;
    invalidateOtherSessions(sessionId);
    return sendJson(response, 200, { ok: true });
  }

  const jobRoute = /^\/api\/jobs\/([0-9a-f-]{36})(?:\/(retry|cancel))?$/.exec(pathname);
  if (jobRoute && request.method === "GET" && !jobRoute[2]) {
    return sendJson(response, 200, getJob(jobRoute[1]));
  }
  if (jobRoute && request.method === "POST" && jobRoute[2] === "retry") {
    return sendJson(response, 202, retryJob(jobRoute[1]));
  }
  if (jobRoute && request.method === "POST" && jobRoute[2] === "cancel") {
    return sendJson(response, 202, cancelJob(jobRoute[1]));
  }

  if (request.method === "GET" && pathname === "/api/versions") {
    const versions = await listMinecraftVersions();
    let bedrockVersions = [];
    let bedrockError = null;
    try {
      bedrockVersions = await listBedrockVersions();
    } catch (error) {
      bedrockError = error.message;
    }
    let paperVersions = new Set();
    let paperError = null;
    let purpurVersions = new Set();
    let purpurError = null;
    let fabricVersions = new Set();
    let fabricError = null;
    let quiltVersions = new Set();
    let quiltError = null;
    let forgeVersions = new Set();
    let forgeError = null;
    try {
      paperVersions = new Set(await listPaperVersions());
    } catch (error) {
      paperError = error.message;
    }
    try {
      purpurVersions = new Set(await listPurpurVersions());
    } catch (error) {
      purpurError = error.message;
    }
    try {
      fabricVersions = new Set(await listFabricMinecraftVersions());
    } catch (error) {
      fabricError = error.message;
    }
    try {
      quiltVersions = new Set(await listQuiltMinecraftVersions());
    } catch (error) {
      quiltError = error.message;
    }
    try {
      forgeVersions = new Set(await listForgeMinecraftVersions());
    } catch (error) {
      forgeError = error.message;
    }
    const neoForgeVersions = new Set();
    let neoForgeError = null;
    try {
      const supported = await Promise.all(versions.filter((version) => version.type === "release")
        .map(async (version) => [version.id, (await listNeoForgeVersions(version.id)).length > 0]));
      for (const [version, compatible] of supported) if (compatible) neoForgeVersions.add(version);
    } catch (error) {
      neoForgeError = error.message;
    }
    return sendJson(response, 200, {
      versions: versions.filter((version) => ["release", "snapshot"].includes(version.type))
        .map(({ id, type, time }) => ({
          id, type, time, paper: paperVersions.has(id), purpur: purpurVersions.has(id),
          fabric: fabricVersions.has(id), quilt: quiltVersions.has(id),
          forge: type === "release" && forgeVersions.has(id), neoforge: type === "release" && neoForgeVersions.has(id),
        })),
      bedrock_versions: bedrockVersions,
      bedrock_available: bedrockError === null,
      bedrock_error: bedrockError,
      paper_available: paperError === null,
      paper_error: paperError,
      purpur_available: purpurError === null,
      purpur_error: purpurError,
      fabric_available: fabricError === null,
      fabric_error: fabricError,
      quilt_available: quiltError === null,
      quilt_error: quiltError,
      forge_available: forgeError === null,
      forge_error: forgeError,
      neoforge_available: neoForgeError === null,
      neoforge_error: neoForgeError,
    });
  }
  if (request.method === "GET" && pathname === "/api/java") {
    const version = url.searchParams.get("version");
    return sendJson(response, 200, {
      runtimes: await availableJavaRuntimes(),
      required_major: version ? await requiredJavaForVersion(version) : null,
    });
  }
  if (request.method === "GET" && pathname === "/api/network") {
    return sendJson(response, 200, { lan_addresses: getLanAddresses() });
  }
  if (request.method === "GET" && pathname === "/api/servers") return sendJson(response, 200, getServers());
  if (request.method === "POST" && pathname === "/api/servers") {
    return sendJson(response, 201, await createServer(await readJson(request)));
  }

  const route = /^\/api\/servers\/([a-z0-9-]+)(?:\/([a-z-]+))?$/.exec(pathname);
  if (!route) throw fail(404, "Not found");
  const [, id, action] = route;
  if (request.method === "GET" && action === "modpacks") {
    return sendJson(response, 200, await searchModpacks(id, {
      source: url.searchParams.get("source") ?? "curseforge",
      query: url.searchParams.get("query") ?? "",
      limit: Number(url.searchParams.get("limit") ?? 20),
      offset: Number(url.searchParams.get("offset") ?? 0),
    }));
  }
  if (request.method === "GET" && action === "modpack-versions") {
    return sendJson(response, 200, await getModpackVersions(id, url.searchParams.get("project_id")));
  }
  if (request.method === "POST" && action === "modpacks") {
    const body = await readJson(request);
    return sendJson(response, 200, await installModpack(id, body.project_id, body.file_id));
  }
  if (request.method === "GET" && action === "projects") {
    const type = url.searchParams.get("type") ?? "mod";
    if (url.searchParams.get("installed") === "1") return sendJson(response, 200, await getInstalledProjects(id, type));
    return sendJson(response, 200, await searchProjects(id, {
      source: url.searchParams.get("source") ?? "modrinth",
      type,
      query: url.searchParams.get("query") ?? "",
      limit: Number(url.searchParams.get("limit") ?? 20),
      offset: Number(url.searchParams.get("offset") ?? 0),
    }));
  }
  if (request.method === "GET" && action === "project") {
    return sendJson(response, 200, await getProject(id, url.searchParams.get("project_id"), url.searchParams.get("type") ?? "mod"));
  }
  if (request.method === "GET" && action === "project-versions") {
    return sendJson(response, 200, await getProjectVersions(
      id, url.searchParams.get("project_id"), url.searchParams.get("type") ?? "mod",
      url.searchParams.get("source") ?? "modrinth",
    ));
  }
  if (request.method === "POST" && action === "projects") {
    const body = await readJson(request);
    if (body.operation === "install") {
      return sendJson(response, 200, await installProject(
        id, body.project_id, body.version_id, body.type ?? "mod", body.source ?? "modrinth",
      ));
    }
    if (body.operation === "remove") {
      return sendJson(response, 200, await removeProject(id, body.filename, body.type ?? "mod"));
    }
    if (body.operation === "update") {
      return sendJson(response, 200, await updateProject(id, body.project_id, body.type ?? "mod"));
    }
    if (body.operation === "rollback") {
      return sendJson(response, 200, await rollbackProject(id, body.project_id, body.type ?? "mod"));
    }
    throw fail(400, "Project operation must be install, update, rollback, or remove");
  }
  if (request.method === "GET" && action === "players") return sendJson(response, 200, await queryOnlinePlayers(id));
  if (request.method === "POST" && action === "telemetry") {
    return sendJson(response, 200, await queryServerTelemetry(id));
  }
  if (request.method === "POST" && action === "players") {
    const body = await readJson(request);
    await playerAction(id, body.action, body.player, body.reason);
    return sendJson(response, 200, { ok: true });
  }
  if (request.method === "GET" && action === "player-profile") {
    return sendJson(response, 200, await resolvePlayerProfile(id, url.searchParams.get("name")));
  }
  if (request.method === "GET" && action === "permissions") return sendJson(response, 200, await getPlayerRecords(id));
  if (request.method === "PUT" && action === "permissions") {
    const body = await readJson(request);
    return sendJson(response, 200, await updatePlayerRecords(id, body.filename, body.records));
  }
  if (request.method === "GET" && action === "history") return sendJson(response, 200, getServerHistory(id));
  if (request.method === "GET" && action === "worlds") return sendJson(response, 200, await getWorlds(id));
  if (request.method === "POST" && action === "worlds") {
    const body = await readJson(request);
    if (body.operation === "backup") return sendJson(response, 201, await createWorldBackup(id, body.world_name));
    if (body.operation === "snapshot") return sendJson(response, 201, await createLiveWorldSnapshot(id, body.world_name));
    if (body.operation === "import") {
      return sendJson(response, 200, await importWorldArchive(id, body.archive_path, body.world_name));
    }
    throw fail(400, "World operation must be backup, snapshot, or import");
  }
  if (request.method === "GET" && action === "world-backups") return sendJson(response, 200, await listWorldBackups(id));
  if (request.method === "POST" && action === "world-backups") {
    const body = await readJson(request);
    if (body.operation !== "restore") throw fail(400, "World backup operation must be restore");
    return sendJson(response, 200, await restoreWorldBackup(id, body.backup_id));
  }
  if (request.method === "GET" && action === "backup-schedule") return sendJson(response, 200, getBackupSchedule(id));
  if (request.method === "PUT" && action === "auto-restart") {
    const body = await readJson(request);
    return sendJson(response, 200, setAutoRestart(id, body.enabled));
  }
  if (request.method === "PUT" && action === "backup-schedule") {
    const body = await readJson(request);
    return sendJson(response, 200, setBackupSchedule(id, body.interval_hours, body.retention_count, body.enabled));
  }
  if (request.method === "GET" && action === "download") {
    const file = await downloadServerFile(id, url.searchParams.get("path"));
    response.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": file.size,
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
      "cache-control": "no-store",
    });
    return streamFile(response, file.path);
  }
  if (request.method === "GET" && action === "backup-download") {
    const file = await getBackupDownload(id, url.searchParams.get("backup_id"));
    response.writeHead(200, {
      "content-type": "application/gzip",
      "content-length": file.size,
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
      "cache-control": "no-store",
    });
    return streamFile(response, file.path);
  }
  if (request.method === "GET" && action === "world-backup-download") {
    const file = await getWorldBackupDownload(id, url.searchParams.get("backup_id"));
    response.writeHead(200, {
      "content-type": "application/gzip",
      "content-length": file.size,
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
      "cache-control": "no-store",
    });
    return streamFile(response, file.path);
  }
  if (request.method === "PUT" && action === "upload") {
    const uploaded = await uploadServerFile(id, url.searchParams.get("path"), request);
    return sendJson(response, 201, uploaded);
  }
  if (request.method === "GET" && !action) {
    const server = getServer(id);
    if (!server) throw fail(404, "Server not found");
    return sendJson(response, 200, server);
  }
  if (request.method === "DELETE" && !action) {
    await deleteServer(id);
    return sendJson(response, 200, { ok: true });
  }
  if (request.method === "POST" && action === "install") return sendJson(response, 202, queueInstall(id));
  if (request.method === "POST" && action === "eula") {
    const body = await readJson(request);
    return sendJson(response, 200, await acceptEula(id, body.accepted));
  }
  if (request.method === "POST" && action === "start") return sendJson(response, 200, await startServer(id));
  if (request.method === "POST" && action === "restart") return sendJson(response, 200, await restartServer(id));
  if (request.method === "POST" && action === "stop") {
    const body = await readJson(request);
    await stopServer(id, body.force === true);
    return sendJson(response, 200, { ok: true });
  }
  if (request.method === "POST" && action === "command") {
    const body = await readJson(request);
    await sendCommand(id, body.command);
    return sendJson(response, 200, { ok: true });
  }
  if (request.method === "GET" && action === "files") {
    const relative = url.searchParams.get("path") ?? ".";
    return sendJson(response, 200, await readServerFiles(id, relative));
  }
  if (request.method === "PUT" && action === "files") {
    const body = await readJson(request);
    await writeServerFile(id, body.path, body.content);
    return sendJson(response, 200, { ok: true });
  }
  if (request.method === "POST" && action === "files") {
    const body = await readJson(request);
    if (body.operation === "create") {
      await createServerFile(id, body.path, body.type);
      return sendJson(response, 201, { ok: true });
    }
    if (body.operation === "move") {
      await moveServerFile(id, body.from, body.to);
      return sendJson(response, 200, { ok: true });
    }
    if (body.operation === "delete") return sendJson(response, 200, await deleteServerFile(id, body.path));
    throw fail(400, "File operation must be create, move, or delete");
  }
  if (request.method === "GET" && action === "logs") {
    if (url.searchParams.get("stream") !== "1") return sendJson(response, 200, { log: await getLog(id) });
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    response.write(`data: ${JSON.stringify(await getLog(id))}\n\n`);
    const unsubscribe = subscribe(id, (text) => response.write(`data: ${JSON.stringify(text)}\n\n`));
    const keepalive = setInterval(() => response.write(": keepalive\n\n"), 20000);
    response.on("close", () => {
      clearInterval(keepalive);
      unsubscribe();
    });
    return;
  }
  if (request.method === "GET" && action === "backups") return sendJson(response, 200, listBackups(id));
  if (request.method === "POST" && action === "backups") return sendJson(response, 201, await createBackup(id));
  if (request.method === "POST" && action === "restore") {
    const body = await readJson(request);
    await restoreBackup(id, body.backup_id);
    return sendJson(response, 200, { ok: true });
  }
  throw fail(404, "Not found");
}

async function staticFile(request, response, pathname) {
  const file = pathname === "/" ? "index.html" : pathname.slice(1);
  if (!/^[a-zA-Z0-9._-]+$/.test(file)) throw fail(404, "Not found");
  const target = path.join(staticRoot, file);
  let content;
  try {
    content = await fs.readFile(target);
  } catch (error) {
    if (error.code === "ENOENT") throw fail(404, "Not found");
    throw error;
  }
  const type = file.endsWith(".css") ? "text/css" : file.endsWith(".js") ? "text/javascript" : "text/html";
  response.writeHead(200, { "content-type": `${type}; charset=utf-8`, "cache-control": "no-cache" });
  response.end(content);
}

const handler = async (request, response) => {
  try {
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("x-frame-options", "DENY");
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader("cross-origin-resource-policy", "same-origin");
    response.setHeader(
      "content-security-policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    );
    const encrypted = Boolean(request.socket.encrypted);
    if (secureCookies && !encrypted) throw fail(403, "HTTPS is required for this panel");
    const requestHost = request.headers.host;
    let hostname;
    try {
      hostname = new URL(`${encrypted ? "https" : "http"}://${requestHost}`).hostname.toLowerCase();
    } catch {
      throw fail(403, "Invalid Host header");
    }
    if (!allowedPanelHosts.has(hostname)) throw fail(403, "Invalid Host header");
    const url = new URL(request.url, `${encrypted ? "https" : "http"}://${requestHost}`);
    if (url.pathname.startsWith("/api/")) await api(request, response, url);
    else await staticFile(request, response, url.pathname);
  } catch (error) {
    if (response.headersSent) {
      response.destroy(error);
      return;
    }
    console.error("Panel request failed:", error);
    sendJson(response, error.status ?? 400, { error: error.message ?? "Unexpected server error" });
  }
};

export const server = secureCookies
  ? https.createServer({
    key: fsSync.readFileSync(tlsKeyPath),
    cert: fsSync.readFileSync(tlsCertPath),
    minVersion: "TLSv1.2",
  }, handler)
  : http.createServer(handler);

export function listen() {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
}
