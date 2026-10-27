import { Database } from './database.js';
import { createHttpServer } from './http.js';
import { ServerManager } from './manager.js';
import { config } from './config.js';
import { AuthService } from './auth.js';

const database = new Database(config.databasePath);
const manager = new ServerManager(database);
const auth = new AuthService(database);
const setupToken = await auth.initialize();
if (setupToken) {
  console.warn(`Initial admin setup token (enter it in the panel once): ${setupToken}`);
}
await manager.initialize();
const server = createHttpServer(manager, config, auth);

server.on('listening', () => {
  console.log(`Byte Server Panel listening at ${config.tls ? 'https' : 'http'}://${config.host}:${config.port}`);
  console.log(`Managed server files: ${config.serverDir}`);
});

let shuttingDown = false;

// When started from a terminal, a closed terminal can leave the process alive
// (SIGHUP is ignored below) but with a broken stdout/stderr pipe. Swallow those
// write errors so logging cannot take the panel down.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error) => {
    if (error.code !== 'EPIPE') process.exitCode = 1;
  });
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  const stopServers = config.stopServersOnShutdown;
  console.log(`Received ${signal}; ${stopServers ? 'stopping managed servers' : 'leaving managed servers running'}...`);
  try {
    await manager.shutdown({ stopServers });
  } catch (error) {
    console.error('[main] Shutdown failed:', error);
  }
  server.close(() => {
    database.close();
    process.exit(0);
  });
  server.closeAllConnections?.();
  setTimeout(() => process.exit(1), 20000).unref();
}

// A closed terminal or dropped SSH session must not take the panel (and the
// Minecraft servers it manages) down with it.
if (process.platform !== 'win32') {
  process.on('SIGHUP', () => console.warn('[main] Ignoring SIGHUP; the panel keeps running.'));
}
process.on('unhandledRejection', (error) => {
  console.error('[main] Unhandled promise rejection:', error);
});
process.on('uncaughtException', (error) => {
  console.error('[main] Uncaught exception:', error);
  // Never stop managed servers on a panel crash. Detach from them and let the
  // service manager restart the panel, which will reattach through RCON.
  void manager.shutdown({ stopServers: false })
    .catch((shutdownError) => console.error('[main] Emergency shutdown failed:', shutdownError))
    .finally(() => process.exit(1));
  setTimeout(() => process.exit(1), 5000).unref();
});

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
