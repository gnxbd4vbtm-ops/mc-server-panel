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

async function shutdown(signal) {
  console.log(`Received ${signal}; stopping managed servers...`);
  await manager.shutdown();
  server.close(() => {
    database.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 20000).unref();
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
