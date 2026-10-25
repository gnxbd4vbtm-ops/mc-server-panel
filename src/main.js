import { listen, server } from "./http.js";
import { host, port } from "./config.js";
import { beginShutdown, reattachRecoveredProcesses, shutdownServers } from "./manager.js";

await reattachRecoveredProcesses();
await listen();
console.log(`Minecraft Server Control Panel listening at http://${host}:${port}`);

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}; stopping managed Minecraft servers...`);
  beginShutdown();
  await shutdownServers();
  server.close(() => process.exit(0));
  server.closeAllConnections();
  setTimeout(() => process.exit(1), 30_000).unref();
}
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
