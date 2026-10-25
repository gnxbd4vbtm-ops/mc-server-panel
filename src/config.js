import os from "node:os";
import path from "node:path";
import net from "node:net";

export const dataDir = path.resolve(
  process.env.MC_PANEL_DATA_DIR ??
    path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"), "mc-server-panel"),
);
export const serverRoot = path.resolve(
  process.env.MC_PANEL_SERVER_ROOT ?? path.join(dataDir, "servers"),
);
export const backupRoot = path.resolve(
  process.env.MC_PANEL_BACKUP_ROOT ?? path.join(dataDir, "backups"),
);
export const host = process.env.MC_PANEL_HOST ?? "127.0.0.1";
export const port = Number(process.env.MC_PANEL_PORT ?? 8765);
export const tlsKeyPath = process.env.MC_PANEL_TLS_KEY ? path.resolve(process.env.MC_PANEL_TLS_KEY) : null;
export const tlsCertPath = process.env.MC_PANEL_TLS_CERT ? path.resolve(process.env.MC_PANEL_TLS_CERT) : null;
export const curseForgeApiKey = process.env.MC_PANEL_CURSEFORGE_API_KEY ?? null;
const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);
const remoteBinding = !loopbackHosts.has(host);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("MC_PANEL_PORT must be an integer between 1 and 65535");
}
if (!loopbackHosts.has(host) && !net.isIP(host)) {
  throw new Error("MC_PANEL_HOST must be a loopback address, an IP address, or a wildcard bind address");
}
if (Boolean(tlsKeyPath) !== Boolean(tlsCertPath)) {
  throw new Error("Set both MC_PANEL_TLS_KEY and MC_PANEL_TLS_CERT to enable TLS");
}
if (curseForgeApiKey !== null && (curseForgeApiKey.length < 20 || curseForgeApiKey.length > 512 || /[\r\n\0]/.test(curseForgeApiKey))) {
  throw new Error("MC_PANEL_CURSEFORGE_API_KEY must be a valid API key");
}
if (remoteBinding && (!tlsKeyPath || !tlsCertPath)) {
  throw new Error("Non-loopback panel binding requires TLS certificate and key files");
}

const configuredAllowedHosts = (process.env.MC_PANEL_ALLOWED_HOSTS ?? "")
  .split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
for (const allowedHost of configuredAllowedHosts) {
  if (!net.isIP(allowedHost) &&
      !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/i.test(allowedHost)) {
    throw new Error(`Invalid hostname in MC_PANEL_ALLOWED_HOSTS: ${allowedHost}`);
  }
}
if (remoteBinding && configuredAllowedHosts.length === 0) {
  throw new Error("Non-loopback panel binding requires MC_PANEL_ALLOWED_HOSTS to restrict accepted Host headers");
}
export const allowedPanelHosts = new Set(remoteBinding ? configuredAllowedHosts : [...loopbackHosts, ...configuredAllowedHosts]);
export const secureCookies = Boolean(tlsKeyPath && tlsCertPath);
