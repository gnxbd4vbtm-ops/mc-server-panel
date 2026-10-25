import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { extractZipEntries } from "../src/zip.js";
import { after, test } from "node:test";
import { makeZip } from "./zip-fixture.js";

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mc-panel-curseforge-"));
process.env.MC_PANEL_CURSEFORGE_API_KEY = "test-curseforge-api-key-0123456789";
const providers = await import("../src/providers.js");
const originalFetch = globalThis.fetch;

function jsonResponse(body, url) {
  const response = Response.json(body);
  Object.defineProperty(response, "url", { value: url });
  return response;
}

after(async () => {
  globalThis.fetch = originalFetch;
  await fs.rm(tempRoot, { recursive: true, force: true });
});

test("searches compatible CurseForge mods and installs only an SHA-1 verified official file", async () => {
  const server = { id: "curseforge-test", loader: "fabric", version: "1.21.1" };
  const directory = path.join(tempRoot, "instance");
  await fs.mkdir(directory);
  const jarBytes = Buffer.from("verified CurseForge mod jar");
  const checksum = crypto.createHash("sha1").update(jarBytes).digest("hex");
  let requestedFileList = false;
  globalThis.fetch = async (request, options = {}) => {
    const url = new URL(String(request));
    if (url.hostname === "api.curseforge.com") {
      assert.equal(options.headers["x-api-key"], process.env.MC_PANEL_CURSEFORGE_API_KEY);
    }
    if (url.pathname.endsWith("/mods/search")) {
      assert.equal(url.searchParams.get("gameVersion"), "1.21.1");
      assert.equal(url.searchParams.get("modLoaderType"), "4");
      return jsonResponse({
        data: [{ id: 1234, name: "Example Mod", summary: "A test mod",
          authors: [{ name: "Author" }], downloadCount: 99 }],
        pagination: { totalCount: 1 },
      }, url.href);
    }
    if (url.pathname.endsWith("/mods/1234/files")) {
      requestedFileList = true;
      assert.equal(url.searchParams.get("modLoaderType"), "4");
      return jsonResponse({ data: [{
        id: 5678,
        displayName: "Example Mod 1.21.1",
        fileName: "example-mod.jar",
        gameVersions: ["1.21.1", "Fabric"],
        modLoaderType: 4,
        isAvailable: true,
        downloadUrl: "https://edge.forgecdn.net/files/example-mod.jar",
        hashes: [{ algo: 1, value: checksum }],
      }] }, url.href);
    }
    if (url.hostname === "edge.forgecdn.net") {
      const response = new Response(jarBytes);
      Object.defineProperty(response, "url", { value: url.href });
      return response;
    }
    throw new Error(`Unexpected CurseForge request: ${url}`);
  };
  const search = await providers.searchCurseForge(server, { query: "example" });
  assert.equal(search.total_hits, 1);
  assert.equal(search.hits[0].id, "1234");
  assert.equal(search.hits[0].title, "Example Mod");
  const versions = await providers.listCurseForgeProjectVersions(server, "1234");
  assert.equal(versions[0].id, "5678");
  assert.equal(requestedFileList, true);
  const installed = await providers.installCurseForgeProject(server, directory, "1234", "5678");
  assert.equal(installed.filename, "example-mod.jar");
  assert.deepEqual(await fs.readFile(path.join(directory, "mods", installed.filename)), jarBytes);
  await assert.rejects(providers.installCurseForgeProject(server, directory, "1234", "5678"), /already exists/);
});

test("rejects unverified CurseForge files and untrusted download hosts", async () => {
  const server = { id: "curseforge-invalid", loader: "forge", version: "1.20.1" };
  const directory = path.join(tempRoot, "invalid-instance");
  await fs.mkdir(directory);
  let includeSha1 = false;
  let downloadHost = "evil.example";
  globalThis.fetch = async (request) => {
    const url = new URL(String(request));
    if (url.pathname.endsWith("/mods/12/files")) {
      return jsonResponse({ data: [{
        id: 34, displayName: "Invalid", fileName: "invalid.jar", gameVersions: ["1.20.1"],
        modLoaderType: 1, isAvailable: true, downloadUrl: `https://${downloadHost}/invalid.jar`,
        hashes: includeSha1 ? [{ algo: 1, value: "a".repeat(40) }] : [{ algo: 2, value: "a".repeat(32) }],
      }] }, url.href);
    }
    if (url.hostname === "edge.forgecdn.net") {
      const response = new Response("incorrect file contents");
      Object.defineProperty(response, "url", { value: url.href });
      return response;
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  assert.deepEqual(await providers.listCurseForgeProjectVersions(server, "12"), []);
  includeSha1 = true;
  await assert.rejects(providers.installCurseForgeProject(server, directory, "12", "34"), /trusted CDN/);
  downloadHost = "edge.forgecdn.net";
  await assert.rejects(providers.installCurseForgeProject(server, directory, "12", "34"), /SHA-1 verification/);
  assert.deepEqual(await fs.readdir(path.join(directory, "mods")), []);
});

test("installs a compatible CurseForge modpack with verified files and safe overrides", async () => {
  const server = { id: "curseforge-pack", loader: "fabric", version: "1.21.1" };
  const directory = path.join(tempRoot, "pack-instance");
  await fs.mkdir(directory);
  const modpackBytes = makeZip({
    "manifest.json": JSON.stringify({
      minecraft: { version: "1.21.1", modLoaders: [{ id: "fabric-0.16.0", primary: true }] },
      files: [{ projectID: 22, fileID: 333, required: true }],
      overrides: "overrides",
    }),
    "overrides/config/example.toml": "enabled=true\n",
    "overrides/options.txt": "client-only\n",
  });
  const modBytes = Buffer.from("pack mod jar");
  const modpackHash = crypto.createHash("sha1").update(modpackBytes).digest("hex");
  const modHash = crypto.createHash("sha1").update(modBytes).digest("hex");
  globalThis.fetch = async (request, options = {}) => {
    const url = new URL(String(request));
    if (url.hostname === "api.curseforge.com") {
      assert.equal(options.headers["x-api-key"], process.env.MC_PANEL_CURSEFORGE_API_KEY);
      if (url.pathname.endsWith("/mods/search")) {
        assert.equal(url.searchParams.get("classId"), "4471");
        return jsonResponse({ data: [{ id: 99, name: "Test Pack", authors: [{ name: "Pack author" }] }],
          pagination: { totalCount: 1 } }, url.href);
      }
      if (url.pathname.endsWith("/mods/99/files") || url.pathname.endsWith("/mods/99/files/111")) {
        const file = {
          id: 111, displayName: "Test Pack 1.21.1", fileName: "test-pack.zip", gameVersions: ["1.21.1"],
          isAvailable: true, downloadUrl: "https://edge.forgecdn.net/test-pack.zip",
          hashes: [{ algo: 1, value: modpackHash }],
        };
        return jsonResponse(url.pathname.endsWith("/files") ? { data: [file] } : { data: file }, url.href);
      }
      if (url.pathname.endsWith("/mods/22/files/333")) {
        return jsonResponse({ data: {
          id: 333, fileName: "pack-mod.jar", gameVersions: ["1.21.1"], modLoaderType: 4, isAvailable: true,
          downloadUrl: "https://edge.forgecdn.net/pack-mod.jar", hashes: [{ algo: 1, value: modHash }],
        } }, url.href);
      }
      throw new Error(`Unexpected CurseForge API request: ${url}`);
    }
    if (url.hostname === "edge.forgecdn.net") {
      const response = new Response(url.pathname.endsWith(".zip") ? modpackBytes : modBytes);
      Object.defineProperty(response, "url", { value: url.href });
      return response;
    }
    throw new Error(`Unexpected download host: ${url.hostname}`);
  };
  const search = await providers.searchCurseForgeModpacks(server, { query: "test" });
  assert.equal(search.hits[0].title, "Test Pack");
  const versions = await providers.listCurseForgeModpackVersions(server, "99");
  assert.equal(versions[0].id, "111");
  const result = await providers.installCurseForgeModpack(server, directory, "99", "111");
  assert.equal(result.installed_files, 3);
  assert.equal(result.skipped_overrides, 1);
  assert.equal(await fs.readFile(path.join(directory, "mods", "pack-mod.jar"), "utf8"), "pack mod jar");
  assert.equal(await fs.readFile(path.join(directory, "config", "example.toml"), "utf8"), "enabled=true\n");
  assert.equal((await fs.readFile(path.join(directory, ".panel-modpack.json"), "utf8")).includes("curseforge"), true);
  await assert.rejects(fs.access(path.join(directory, "options.txt")), { code: "ENOENT" });
  await assert.rejects(providers.installCurseForgeModpack(server, directory, "99", "111"), /Remove existing mods/);
});

test("rejects unsafe ZIP paths and modpack loader mismatches without changing existing files", async () => {
  assert.throws(() => extractZipEntries(makeZip({ "../outside.txt": "no" })), /unsafe path/);
  const badCrc = makeZip({ "file.txt": "payload" });
  const centralOffset = badCrc.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  badCrc.writeUInt32LE(badCrc.readUInt32LE(centralOffset + 16) ^ 1, centralOffset + 16);
  assert.throws(() => extractZipEntries(badCrc), /checksum/);
  const symlinkZip = makeZip({ "link": "target" });
  const symlinkCentralOffset = symlinkZip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  symlinkZip.writeUInt32LE((0o120777 << 16) >>> 0, symlinkCentralOffset + 38);
  assert.throws(() => extractZipEntries(symlinkZip), /symbolic link or special file/);
  const server = { id: "curseforge-pack-conflict", loader: "fabric", version: "1.20.1" };
  const directory = path.join(tempRoot, "pack-conflict-instance");
  await fs.mkdir(path.join(directory, "config"), { recursive: true });
  await fs.writeFile(path.join(directory, "config", "existing.toml"), "preserve");
  let manifestLoader = "forge-47.0.0";
  const makePack = () => makeZip({
    "manifest.json": JSON.stringify({
      minecraft: { version: "1.20.1", modLoaders: [{ id: manifestLoader, primary: true }] },
      files: [],
    }),
    "overrides/config/existing.toml": "would overwrite\n",
  });
  globalThis.fetch = async (request) => {
    const url = new URL(String(request));
    if (url.hostname === "api.curseforge.com" && url.pathname.endsWith("/mods/50/files/51")) {
      const checksum = crypto.createHash("sha1").update(makePack()).digest("hex");
      return jsonResponse({ data: {
        id: 51, fileName: "pack.zip", gameVersions: ["1.20.1"], isAvailable: true,
        downloadUrl: "https://edge.forgecdn.net/pack.zip", hashes: [{ algo: 1, value: checksum }],
      } }, url.href);
    }
    if (url.hostname === "edge.forgecdn.net") {
      const response = new Response(makePack());
      Object.defineProperty(response, "url", { value: url.href });
      return response;
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  await assert.rejects(providers.installCurseForgeModpack(server, directory, "50", "51"), /different loader/);
  manifestLoader = "fabric-0.15.0";
  await assert.rejects(providers.installCurseForgeModpack(server, directory, "50", "51"), /would overwrite/);
  assert.equal(await fs.readFile(path.join(directory, "config", "existing.toml"), "utf8"), "preserve");
  assert.deepEqual(await fs.readdir(directory), ["config"]);
});
