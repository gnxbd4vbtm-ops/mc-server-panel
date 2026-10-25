import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";

const config = JSON.parse(process.argv[2] ?? "null");
if (!config || typeof config.socketPath !== "string" || typeof config.cwd !== "string" ||
    typeof config.logPath !== "string" || typeof config.command !== "string" ||
    !Array.isArray(config.args) || config.args.some((argument) => typeof argument !== "string")) {
  throw new Error("Invalid server supervisor configuration");
}

try {
  fs.unlinkSync(config.socketPath);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

const log = fs.createWriteStream(config.logPath, { flags: "a", mode: 0o600 });
let history = "";
let client;
let input = "";
let closed = false;
let child;
const server = net.createServer((connection) => {
  client = connection;
  connection.setEncoding("utf8");
  connection.write(`${JSON.stringify({ type: "ready", pid: child?.pid ?? null, history })}\n`);
  connection.on("data", (chunk) => {
    input = (input + chunk).slice(-8192);
    let newline;
    while ((newline = input.indexOf("\n")) !== -1) {
      const line = input.slice(0, newline);
      input = input.slice(newline + 1);
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.type === "command" && typeof message.command === "string" &&
          message.command.length <= 2050 && !/[\0]/.test(message.command)) {
        child?.stdin.write(message.command);
      } else if (message.type === "signal" && ["SIGTERM", "SIGKILL"].includes(message.signal)) {
        child?.kill(message.signal);
      }
    }
  });
  connection.on("close", () => {
    if (client === connection) client = undefined;
    input = "";
  });
});

server.listen(config.socketPath, () => {
  fs.chmodSync(config.socketPath, 0o600);
  child = spawn(config.command, config.args, {
    cwd: config.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...(config.env ?? {}) },
    shell: false,
  });
  const consume = (chunk) => {
    const text = chunk.toString("utf8");
    history = (history + text).slice(-30000);
    log.write(chunk);
    if (client?.writable) client.write(`${JSON.stringify({ type: "log", text })}\n`);
  };
  child.stdout.on("data", consume);
  child.stderr.on("data", consume);
  child.once("error", (error) => {
    if (client?.writable) client.write(`${JSON.stringify({ type: "error", message: error.message })}\n`);
  });
  child.once("close", (code, signal) => {
    if (closed) return;
    closed = true;
    if (client?.writable) {
      client.end(`${JSON.stringify({ type: "exit", code, signal })}\n`);
      client = undefined;
    }
    log.end(() => {
      server.close(() => {
        try {
          fs.unlinkSync(config.socketPath);
        } catch (error) {
          if (error.code !== "ENOENT") console.error("Could not remove supervisor socket:", error);
        }
        process.exitCode = code ?? (signal ? 1 : 0);
      });
    });
  });
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, () => child?.kill(signal));
}
