import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AuthService, getSessionToken } from './auth.js';
import os from 'node:os';

const publicDir = path.resolve(fileURLToPath(new URL('../public/', import.meta.url)));
const MIME_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml']
]);
export function createHttpServer(manager, { host, port, tls, allowedHosts = [] }, auth = new AuthService(manager.db)) {
  const server = tls
    ? createHttpsServer(tls, requestHandler(manager, { host, port, tls, allowedHosts }, auth))
    : createServer(requestHandler(manager, { host, port, tls, allowedHosts }, auth));
  return server.listen(port, host);
}

function requestHandler(manager, { host, port, tls, allowedHosts }, auth) {
  const knownHosts = new Set([
    '127.0.0.1', 'localhost', '[::1]', '::1',
    ...(host === '0.0.0.0' || host === '::' ? localInterfaceAddresses() : [host]),
    ...allowedHosts
  ]);
  return async (request, response) => {
    applySecurityHeaders(response, Boolean(tls));
    try {
      assertAllowedHost(request, port, knownHosts);
      if (request.url?.startsWith('/api/')) {
        await handleApi(request, response, manager, port, auth, Boolean(tls));
      } else {
        await serveStatic(request, response);
      }
    } catch (error) {
      const status = Number.isInteger(error.status) ? error.status : 500;
      if (status >= 500) console.error(`[http] ${request.method} ${request.url}:`, error);
      sendJson(response, status, { error: status === 500 ? 'The request could not be completed.' : error.message });
    }
  };
}

async function handleApi(request, response, manager, port, auth, secure) {
  assertSameOrigin(request, port, request.socket.encrypted === true);
  const url = new URL(request.url, `http://${request.headers.host}`);
  const { pathname } = url;
  const method = request.method ?? 'GET';

  if (pathname === '/api/auth/status' && method === 'GET') {
    sendJson(response, 200, {
      configured: auth.isConfigured(),
      authenticated: auth.authenticate(getSessionToken(request))
    });
    return;
  }
  if (pathname === '/api/auth/setup' && method === 'POST') {
    const body = await readJson(request);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      const error = new Error('Authentication request must be a JSON object.');
      error.status = 400;
      throw error;
    }
    const session = await auth.setup(body.token, body.password, request.socket.remoteAddress ?? 'unknown');
    response.setHeader('Set-Cookie', auth.cookie(session, secure));
    sendJson(response, 200, { authenticated: true });
    return;
  }
  if (pathname === '/api/auth/login' && method === 'POST') {
    const body = await readJson(request);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      const error = new Error('Authentication request must be a JSON object.');
      error.status = 400;
      throw error;
    }
    const session = await auth.login(body.password, request.socket.remoteAddress ?? 'unknown');
    response.setHeader('Set-Cookie', auth.cookie(session, secure));
    sendJson(response, 200, { authenticated: true });
    return;
  }
  if (pathname === '/api/auth/logout' && method === 'POST') {
    auth.logout(getSessionToken(request));
    response.setHeader('Set-Cookie', auth.clearCookie(secure));
    sendJson(response, 200, { authenticated: false });
    return;
  }
  if (!auth.authenticate(getSessionToken(request))) {
    sendJson(response, 401, { error: 'Authentication required.' });
    return;
  }
  if (pathname === '/api/health' && method === 'GET') {
    sendJson(response, 200, { status: 'ok', name: 'Byte Server Panel' });
    return;
  }
  if (pathname === '/api/versions' && method === 'GET') {
    sendJson(response, 200, await manager.versions());
    return;
  }
  if (pathname === '/api/java' && method === 'GET') {
    sendJson(response, 200, await manager.javaRuntimes());
    return;
  }
  if (pathname === '/api/providers' && method === 'GET') {
    sendJson(response, 200, manager.providers());
    return;
  }
  const providerCatalogMatch = pathname.match(/^\/api\/providers\/([a-z]+)\/catalog$/);
  if (providerCatalogMatch && method === 'GET') {
    sendJson(response, 200, await manager.providerCatalog(
      providerCatalogMatch[1],
      url.searchParams.get('minecraftVersion') ?? undefined
    ));
    return;
  }
  if (pathname === '/api/modrinth/search' && method === 'GET') {
    sendJson(response, 200, await manager.searchModrinth({
      query: url.searchParams.get('query') ?? '',
      type: url.searchParams.get('type'),
      gameVersion: url.searchParams.get('gameVersion') ?? undefined,
      loader: url.searchParams.get('loader') ?? undefined,
      limit: Number(url.searchParams.get('limit') ?? 20),
      offset: Number(url.searchParams.get('offset') ?? 0)
    }));
    return;
  }
  const modrinthVersionsMatch = pathname.match(/^\/api\/modrinth\/projects\/([A-Za-z0-9_-]+)\/versions$/);
  if (modrinthVersionsMatch && method === 'GET') {
    sendJson(response, 200, await manager.modrinthVersions(modrinthVersionsMatch[1], {
      type: url.searchParams.get('type') ?? undefined,
      gameVersion: url.searchParams.get('gameVersion') ?? undefined,
      loader: url.searchParams.get('loader') ?? undefined
    }));
    return;
  }
  const versionMatch = pathname.match(/^\/api\/versions\/([^/]+)$/);
  if (versionMatch && method === 'GET') {
    sendJson(response, 200, await manager.versionInfo(versionMatch[1]));
    return;
  }
  if (pathname === '/api/servers' && method === 'GET') {
    sendJson(response, 200, await manager.listServers());
    return;
  }
  if (pathname === '/api/servers' && method === 'POST') {
    sendJson(response, 201, await manager.createServer(await readJson(request)));
    return;
  }
  if (pathname === '/api/events' && method === 'GET') {
    sendJson(response, 200, manager.events());
    return;
  }
  if (pathname === '/api/backups' && method === 'GET') {
    sendJson(response, 200, await manager.listBackups());
    return;
  }
  const backupDownloadMatch = pathname.match(/^\/api\/backups\/([a-z0-9-]+)\/download$/);
  if (backupDownloadMatch && method === 'GET') {
    const backup = await manager.getBackupDownload(backupDownloadMatch[1]);
    response.writeHead(200, {
      'Content-Type': 'application/gzip',
      'Content-Length': backup.sizeBytes,
      'Content-Disposition': `attachment; filename="${backup.filename}"`
    });
    createReadStream(backup.path).pipe(response);
    return;
  }
  const backupDeleteMatch = pathname.match(/^\/api\/backups\/([a-z0-9-]+)$/);
  if (backupDeleteMatch && method === 'DELETE') {
    sendJson(response, 200, await manager.deleteBackup(backupDeleteMatch[1]));
    return;
  }
  if (pathname === '/api/system' && method === 'GET') {
    sendJson(response, 200, await manager.systemInfo());
    return;
  }
  if (pathname === '/api/schedules' && method === 'GET') {
    sendJson(response, 200, manager.listSchedules());
    return;
  }
  if (pathname === '/api/diagnostics' && method === 'GET') {
    response.setHeader('Content-Disposition', 'attachment; filename="byte-server-panel-diagnostics.json"');
    sendJson(response, 200, await manager.diagnostics());
    return;
  }
  const scheduleMatch = pathname.match(/^\/api\/schedules\/([a-f0-9-]{36})$/);
  if (scheduleMatch && method === 'DELETE') {
    sendJson(response, 200, manager.deleteSchedule(scheduleMatch[1]));
    return;
  }
  if (pathname === '/api/tasks' && method === 'GET') {
    sendJson(response, 200, manager.listTasks());
    return;
  }
  const taskMatch = pathname.match(/^\/api\/tasks\/([a-f0-9-]{36})(?:\/(cancel))?$/);
  if (taskMatch) {
    const [, taskId, action] = taskMatch;
    if (!action && method === 'GET') {
      sendJson(response, 200, manager.getTask(taskId));
      return;
    }
    if (action === 'cancel' && method === 'POST') {
      sendJson(response, 202, manager.cancelTask(taskId));
      return;
    }
  }
  const match = pathname.match(/^\/api\/servers\/([a-z0-9-]+)(?:\/([a-z-]+)(?:\/([a-z0-9-]+))?)?$/);
  if (!match) {
    sendJson(response, 404, { error: 'API route not found.' });
    return;
  }
  const [, id, action, argument] = match;
  if (!action && method === 'GET') {
    sendJson(response, 200, manager.getServer(id));
    return;
  }
  if (action === 'schedules' && method === 'GET') {
    sendJson(response, 200, manager.listSchedules(id));
    return;
  }
  if (action === 'schedules' && method === 'POST') {
    sendJson(response, 201, manager.createSchedule(id, await readJson(request)));
    return;
  }
  if (action === 'metrics' && method === 'GET') {
    sendJson(response, 200, manager.getMetrics(id, url.searchParams.get('limit') ?? 1440));
    return;
  }
  if (action === 'settings' && method === 'GET') {
    sendJson(response, 200, await manager.getServerSettings(id));
    return;
  }
  if (action === 'settings' && method === 'PUT') {
    sendJson(response, 200, await manager.updateServerSettings(id, await readJson(request)));
    return;
  }
  if (action === 'files' && method === 'GET') {
    sendJson(response, 200, await manager.listServerFiles(id, url.searchParams.get('path') ?? ''));
    return;
  }
  if (action === 'file' && method === 'GET') {
    sendJson(response, 200, await manager.readServerFile(id, url.searchParams.get('path') ?? ''));
    return;
  }
  if (action === 'file' && method === 'PUT') {
    const body = await readJson(request);
    sendJson(response, 200, await manager.writeServerFile(id, body.path, body.content));
    return;
  }
  if (action === 'files' && method === 'POST') {
    const body = await readJson(request);
    sendJson(response, 201, await manager.writeServerFile(id, body.path, body.content ?? '', true));
    return;
  }
  if (action === 'file' && method === 'DELETE') {
    sendJson(response, 200, await manager.deleteServerFile(id, url.searchParams.get('path') ?? ''));
    return;
  }
  if (action === 'admin' && method === 'POST') {
    const body = await readJson(request);
    sendJson(response, 202, await manager.sendAdminCommand(id, body.action, body.args ?? {}));
    return;
  }
  if (action === 'install' && method === 'POST') {
    sendJson(response, 202, manager.queueTask('install', id, await readJson(request)));
    return;
  }
  if (action === 'runtime' && method === 'POST') {
    sendJson(response, 202, manager.queueTask('runtime-change', id, await readJson(request)));
    return;
  }
  if (action === 'content' && method === 'POST') {
    const body = await readJson(request);
    const taskType = body.contentType === 'modpack' ? 'modpack-install' : 'content-install';
    sendJson(response, 202, manager.queueTask(taskType, id, body));
    return;
  }
  if (action === 'start' && method === 'POST') {
    sendJson(response, 202, await manager.start(id, await readJson(request)));
    return;
  }
  if (action === 'stop' && method === 'POST') {
    sendJson(response, 202, await manager.stop(id));
    return;
  }
  if (action === 'restart' && method === 'POST') {
    sendJson(response, 202, await manager.restart(id));
    return;
  }
  if (action === 'force-stop' && method === 'POST') {
    const options = await readJson(request);
    if (!options || typeof options !== 'object' || Array.isArray(options) || options.confirmed !== true) {
      const error = new Error('Explicit confirmation is required before force-stopping a process.');
      error.status = 403;
      throw error;
    }
    sendJson(response, 202, await manager.stop(id, true));
    return;
  }
  if (action === 'confirm-stopped' && method === 'POST') {
    sendJson(response, 200, manager.confirmStopped(id, await readJson(request)));
    return;
  }
  if (action === 'command' && method === 'POST') {
    sendJson(response, 202, await manager.sendCommand(id, (await readJson(request)).command));
    return;
  }
  if (action === 'logs' && method === 'GET') {
    sendJson(response, 200, await manager.getLogs(id, url.searchParams.get('after')));
    return;
  }
  if (action === 'backups' && !argument && method === 'GET') {
    sendJson(response, 200, await manager.listBackups(id));
    return;
  }
  if (action === 'backups' && !argument && method === 'POST') {
    sendJson(response, 202, manager.queueTask('backup', id, {}));
    return;
  }
  if (action === 'restore' && argument && method === 'POST') {
    sendJson(response, 202, manager.queueTask('restore', id, { ...(await readJson(request)), backupId: argument }));
    return;
  }
  if (action === 'delete' && method === 'POST') {
    sendJson(response, 200, await manager.deleteServer(id, await readJson(request)));
    return;
  }
  sendJson(response, 405, { error: 'Method not allowed for this route.' });
}

async function serveStatic(request, response) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    sendJson(response, 405, { error: 'Method not allowed.' });
    return;
  }
  const pathname = new URL(request.url, 'http://localhost').pathname;
  const relativePath = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  const filePath = path.resolve(publicDir, relativePath);
  if (!filePath.startsWith(`${publicDir}${path.sep}`)) {
    sendJson(response, 403, { error: 'Access denied.' });
    return;
  }
  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch {
    sendJson(response, 404, { error: 'Page not found.' });
    return;
  }
  if (!fileStat.isFile()) {
    sendJson(response, 404, { error: 'Page not found.' });
    return;
  }
  response.writeHead(200, {
    'Content-Type': MIME_TYPES.get(path.extname(filePath)) ?? 'application/octet-stream',
    'Content-Length': fileStat.size
  });
  if (request.method === 'HEAD') response.end();
  else createReadStream(filePath).pipe(response);
}

async function readJson(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 16 * 1024) {
      const error = new Error('Request body is too large.');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('Request body must be valid JSON.');
    error.status = 400;
    throw error;
  }
}

function assertAllowedHost(request, port, knownHosts) {
  const hostHeader = request.headers.host ?? '';
  const separator = hostHeader.lastIndexOf(':');
  const hostname = separator < 0 ? hostHeader : hostHeader.slice(0, separator);
  const hostPort = separator < 0 ? '' : hostHeader.slice(separator + 1);
  if (!knownHosts.has(hostname) || hostPort !== String(port)) {
    const error = new Error('This panel only accepts requests addressed to an allowed local interface.');
    error.status = 403;
    throw error;
  }
}

function assertSameOrigin(request, port, secure) {
  const origin = request.headers.origin;
  if (!origin) return;
  let url;
  try {
    url = new URL(origin);
  } catch {
    const error = new Error('Invalid request origin.');
    error.status = 403;
    throw error;
  }
  const expectedProtocol = secure ? 'https:' : 'http:';
  if (url.protocol !== expectedProtocol || url.host !== request.headers.host) {
    const error = new Error('Cross-origin API requests are not allowed.');
    error.status = 403;
    throw error;
  }
}

function localInterfaceAddresses() {
  return Object.values(os.networkInterfaces()).flatMap((entries) =>
    (entries ?? []).map(({ address }) => address.includes(':') ? `[${address}]` : address)
  );
}

function applySecurityHeaders(response, secure) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  response.setHeader('Cache-Control', 'no-store');
  if (secure) response.setHeader('Strict-Transport-Security', 'max-age=31536000');
}

function sendJson(response, status, data) {
  if (response.headersSent) return response.end();
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(data));
}
