import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const configUrl = new URL("../src/config.js", import.meta.url).href;

function loadConfig(overrides) {
  const environment = {
    ...process.env,
    MC_PANEL_HOST: "127.0.0.1",
    MC_PANEL_PORT: "8765",
    MC_PANEL_TLS_KEY: "",
    MC_PANEL_TLS_CERT: "",
    MC_PANEL_ALLOWED_HOSTS: "",
    ...overrides,
  };
  return spawnSync(process.execPath, [
    "--input-type=module",
    "-e",
    `const config = await import(${JSON.stringify(configUrl)}); console.log(JSON.stringify({host:config.host, secureCookies:config.secureCookies, allowed:[...config.allowedPanelHosts]}));`,
  ], { env: environment, encoding: "utf8" });
}

test("requires TLS and an explicit host allowlist for non-loopback panel binding", () => {
  const missingTls = loadConfig({ MC_PANEL_HOST: "0.0.0.0" });
  assert.notEqual(missingTls.status, 0);
  assert.match(missingTls.stderr, /requires TLS certificate and key/);

  const missingHosts = loadConfig({
    MC_PANEL_HOST: "0.0.0.0",
    MC_PANEL_TLS_KEY: "/tmp/panel.key",
    MC_PANEL_TLS_CERT: "/tmp/panel.crt",
  });
  assert.notEqual(missingHosts.status, 0);
  assert.match(missingHosts.stderr, /requires MC_PANEL_ALLOWED_HOSTS/);

  const remote = loadConfig({
    MC_PANEL_HOST: "0.0.0.0",
    MC_PANEL_TLS_KEY: "/tmp/panel.key",
    MC_PANEL_TLS_CERT: "/tmp/panel.crt",
    MC_PANEL_ALLOWED_HOSTS: "panel.example.test",
  });
  assert.equal(remote.status, 0, remote.stderr);
  assert.deepEqual(JSON.parse(remote.stdout.trim()).allowed, ["panel.example.test"]);
  assert.equal(JSON.parse(remote.stdout.trim()).secureCookies, true);
});
