import path from 'node:path';
import os from 'node:os';
import { readFileSync } from 'node:fs';

const port = Number.parseInt(process.env.BSP_PORT ?? '18765', 10);
const dataDir = path.resolve(process.env.BSP_DATA_DIR ?? path.join(process.cwd(), '.data'));
const host = process.env.BSP_HOST ?? '127.0.0.1';
const tlsCertPath = process.env.BSP_TLS_CERT ? path.resolve(process.env.BSP_TLS_CERT) : null;
const tlsKeyPath = process.env.BSP_TLS_KEY ? path.resolve(process.env.BSP_TLS_KEY) : null;
const allowedHosts = (process.env.BSP_ALLOWED_HOSTS ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
const trustProxy = process.env.BSP_TRUST_PROXY === 'true';
const backupRetention = Number.parseInt(process.env.BSP_BACKUP_RETENTION ?? '10', 10);
const startupTimeoutMs = Number.parseInt(process.env.BSP_STARTUP_TIMEOUT_MS ?? '300000', 10);
const stopServersOnShutdown = process.env.BSP_STOP_SERVERS_ON_SHUTDOWN === 'true';

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('BSP_PORT must be a valid TCP port between 1 and 65535.');
}

const isLoopbackHost = ['127.0.0.1', 'localhost', '::1'].includes(host);
if (!isLoopbackHost && (!tlsCertPath || !tlsKeyPath)) {
  throw new Error('Non-loopback BSP_HOST requires BSP_TLS_CERT and BSP_TLS_KEY. LAN access must use HTTPS.');
}
if (Boolean(tlsCertPath) !== Boolean(tlsKeyPath)) {
  throw new Error('BSP_TLS_CERT and BSP_TLS_KEY must be supplied together.');
}
if (!Number.isInteger(backupRetention) || backupRetention < 1 || backupRetention > 1000) {
  throw new Error('BSP_BACKUP_RETENTION must be an integer between 1 and 1000.');
}
if (!Number.isInteger(startupTimeoutMs) || startupTimeoutMs < 30000 || startupTimeoutMs > 3600000) {
  throw new Error('BSP_STARTUP_TIMEOUT_MS must be an integer between 30000 and 3600000.');
}

export const config = Object.freeze({
  host,
  port,
  isLoopbackHost,
  allowedHosts,
  trustProxy,
  tls: tlsCertPath ? {
    cert: readFileSync(tlsCertPath),
    key: readFileSync(tlsKeyPath)
  } : null,
  dataDir,
  serverDir: path.resolve(process.env.BSP_SERVERS_DIR ?? path.join(dataDir, 'servers')),
  backupDir: path.resolve(process.env.BSP_BACKUPS_DIR ?? path.join(dataDir, 'backups')),
  backupRetention,
  startupTimeoutMs,
  stopServersOnShutdown,
  databasePath: path.resolve(process.env.BSP_DATABASE_PATH ?? path.join(dataDir, 'panel.sqlite')),
  availableMemoryMb: Math.floor(os.totalmem() / 1024 / 1024)
});
