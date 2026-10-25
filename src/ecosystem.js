import { createHash } from 'node:crypto';

const HARD_MAX_BYTES = 1024 * 1024 * 1024;
const MAX_METADATA_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const MODRINTH_HOSTS = ['api.modrinth.com', 'cdn.modrinth.com'];

export const PROVIDERS = Object.freeze([
  Object.freeze({
    id: 'fabric',
    name: 'Fabric',
    kind: 'loader',
    website: 'https://fabricmc.net/',
    api: 'https://meta.fabricmc.net',
    install: true,
    installArtifact: 'verified Fabric installer JAR',
  }),
  Object.freeze({
    id: 'forge',
    name: 'Forge',
    kind: 'loader',
    website: 'https://minecraftforge.net/',
    api: 'https://files.minecraftforge.net',
    install: true,
    installArtifact: 'verified Forge installer JAR',
  }),
  Object.freeze({
    id: 'neoforge',
    name: 'NeoForge',
    kind: 'loader',
    website: 'https://neoforged.net/',
    api: 'https://maven.neoforged.net',
    install: true,
    installArtifact: 'verified NeoForge installer JAR',
  }),
  Object.freeze({
    id: 'quilt',
    name: 'Quilt',
    kind: 'loader',
    website: 'https://quiltmc.org/',
    api: 'https://meta.quiltmc.org',
    install: true,
    installArtifact: 'verified Quilt installer JAR',
  }),
  Object.freeze({
    id: 'paper',
    name: 'Paper',
    kind: 'server',
    website: 'https://papermc.io/',
    api: 'https://api.papermc.io',
    install: true,
    installArtifact: 'verified Paper server JAR',
  }),
  Object.freeze({
    id: 'purpur',
    name: 'Purpur',
    kind: 'server',
    website: 'https://purpurmc.org/',
    api: 'https://api.purpurmc.org',
    install: true,
    installArtifact: 'verified Purpur server JAR',
  }),
].map((provider) => Object.freeze({
  ...provider,
  hosts: Object.freeze(provider.id === 'fabric'
    ? ['meta.fabricmc.net', 'maven.fabricmc.net']
    : provider.id === 'quilt'
      ? ['meta.quiltmc.org', 'maven.quiltmc.org']
      : provider.id === 'forge'
        ? ['files.minecraftforge.net', 'maven.minecraftforge.net']
        : provider.id === 'paper'
          ? ['api.papermc.io', 'fill.papermc.io']
          : [new URL(provider.api).hostname]),
})));

const PROVIDER_BY_ID = new Map(PROVIDERS.map((provider) => [provider.id, provider]));

export class EcosystemError extends Error {
  constructor(message, code = 'ECOSYSTEM_ERROR') {
    super(message);
    this.name = 'EcosystemError';
    this.code = code;
  }
}

export function listProviders() {
  return PROVIDERS.map(({ id, name, kind, website, install, installArtifact }) => ({
    id, name, kind, website, install, installArtifact,
  }));
}

function fail(message, code) {
  throw new EcosystemError(message, code);
}

function requireProvider(providerId) {
  if (typeof providerId !== 'string' || !PROVIDER_BY_ID.has(providerId)) {
    fail('Unsupported software provider.', 'INVALID_PROVIDER');
  }
  return PROVIDER_BY_ID.get(providerId);
}

function validToken(value, label = 'identifier', maxLength = 128) {
  if (typeof value !== 'string' || value.length > maxLength
      || !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(value)) {
    fail(`Invalid ${label}.`, 'INVALID_IDENTIFIER');
  }
  return value;
}

function validMinecraftVersion(value) {
  if (typeof value !== 'string' || value.length > 40
      || !/^[A-Za-z0-9][A-Za-z0-9._+ -]*[A-Za-z0-9]$/.test(value)) {
    fail('Invalid Minecraft version.', 'INVALID_VERSION');
  }
  return value;
}

function validURL(value, allowedHosts) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail('Invalid download URL.', 'INVALID_URL');
  }
  if (url.protocol !== 'https:' || url.username || url.password
      || !allowedHosts.includes(url.hostname) || url.port) {
    fail('Download URL host is not allowed.', 'INVALID_HOST');
  }
  return url;
}

function validByteLimit(value, fallback = HARD_MAX_BYTES) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > HARD_MAX_BYTES) {
    fail(`Byte limit must be between 1 and ${HARD_MAX_BYTES}.`, 'INVALID_SIZE');
  }
  return value;
}

function validTimeout(value, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > 300_000) {
    fail('Timeout must be between 1 and 300000 milliseconds.', 'INVALID_TIMEOUT');
  }
  return value;
}

async function readLimited(response, maxBytes) {
  if (!response.body?.getReader) {
    const data = new Uint8Array(await response.arrayBuffer());
    if (data.byteLength > maxBytes) fail('Response exceeds the configured size limit.', 'SIZE_LIMIT');
    return data;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        fail('Response exceeds the configured size limit.', 'SIZE_LIMIT');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function requestBytes(url, {
  fetchImpl = globalThis.fetch,
  allowedHosts,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = MAX_METADATA_BYTES,
  signal,
} = {}) {
  if (typeof fetchImpl !== 'function') fail('Fetch is unavailable.', 'FETCH_UNAVAILABLE');
  const parsed = validURL(String(url), allowedHosts);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('Request timed out.')), timeoutMs);
  const abortFromCaller = () => controller.abort(signal.reason);
  if (signal?.aborted) abortFromCaller();
  else signal?.addEventListener('abort', abortFromCaller, { once: true });
  try {
    let target = parsed;
    let response;
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      response = await fetchImpl(target.href, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          accept: 'application/json, application/xml, text/plain, application/octet-stream',
          'accept-encoding': 'identity',
        },
      });
      if (![301, 302, 303, 307, 308].includes(response?.status)) break;
      const location = response.headers?.get?.('location');
      if (!location || redirects === 3) fail('Vendor redirect is invalid or excessive.', 'INVALID_REDIRECT');
      target = validURL(new URL(location, target).href, allowedHosts);
    }
    if (!response?.ok) fail(`Vendor request failed (${response?.status ?? 'unknown'}).`, 'HTTP_ERROR');
    return await readLimited(response, maxBytes);
  } catch (error) {
    if (error instanceof EcosystemError) throw error;
    if (controller.signal.aborted) fail('Vendor request timed out or was cancelled.', 'REQUEST_ABORTED');
    fail(`Vendor request failed: ${error.message}`, 'NETWORK_ERROR');
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abortFromCaller);
  }
}

async function requestJSON(url, options) {
  const bytes = await requestBytes(url, options);
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    fail('Vendor returned malformed JSON.', 'INVALID_METADATA');
  }
}

async function requestText(url, options) {
  const bytes = await requestBytes(url, options);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail('Vendor returned malformed text metadata.', 'INVALID_METADATA');
  }
}

function assertArray(value, label) {
  if (!Array.isArray(value)) fail(`Malformed ${label} catalog.`, 'INVALID_METADATA');
  return value;
}

function validVersionArray(value, label) {
  return assertArray(value, label).map((entry) => {
    const id = typeof entry === 'string' ? entry : entry?.version;
    return validMinecraftVersion(id);
  });
}

function versionStable(value, label) {
  if (typeof value !== 'boolean') fail(`Malformed ${label} stability metadata.`, 'INVALID_METADATA');
  return value;
}

function extractMavenVersions(xml, prefix) {
  if (!xml.includes('<metadata') || !xml.includes('</metadata>')) {
    fail('Malformed Maven version metadata.', 'INVALID_METADATA');
  }
  const versionsBlock = xml.match(/<versions>([\s\S]*?)<\/versions>/)?.[1];
  if (!versionsBlock) fail('Maven version catalog is missing.', 'INVALID_METADATA');
  const versions = [...versionsBlock.matchAll(/<version>([^<]+)<\/version>/g)]
    .map((match) => match[1].trim());
  if (!versions.length || versions.some((version) => !new RegExp(`^${prefix}[A-Za-z0-9.+_-]+$`).test(version))) {
    fail('Maven version catalog contains invalid versions.', 'INVALID_METADATA');
  }
  return versions;
}

export async function getProviderCatalog(providerId, {
  minecraftVersion,
  fetchImpl = globalThis.fetch,
  timeoutMs,
  signal,
} = {}) {
  const provider = requireProvider(providerId);
  if (minecraftVersion !== undefined) validMinecraftVersion(minecraftVersion);
  const opts = { fetchImpl, allowedHosts: provider.hosts, timeoutMs: validTimeout(timeoutMs, DEFAULT_TIMEOUT_MS), signal };
  const api = provider.api;

  if (providerId === 'fabric') {
    const [games, loaders, installers] = await Promise.all([
      requestJSON(`${api}/v2/versions/game`, opts),
      requestJSON(`${api}/v2/versions/loader`, opts),
      requestJSON(`${api}/v2/versions/installer`, opts),
    ]);
    return {
      providerId,
      minecraftVersions: validVersionArray(games, 'Fabric game'),
      loaders: assertArray(loaders, 'Fabric loader').map((item) => ({
        version: validToken(item?.version, 'loader version'),
        stable: versionStable(item?.stable, 'Fabric loader'),
      })),
      installers: assertArray(installers, 'Fabric installer').map((item) => ({
        version: validToken(item?.version, 'installer version'),
        stable: versionStable(item?.stable, 'Fabric installer'),
        maven: validMavenCoordinate(item?.maven),
      })),
    };
  }

  if (providerId === 'quilt') {
    const [games, loaders, installers] = await Promise.all([
      requestJSON(`${api}/v3/versions/game`, opts),
      requestJSON(`${api}/v3/versions/loader${minecraftVersion ? `/${encodeURIComponent(minecraftVersion)}` : ''}`, opts),
      requestJSON(`${api}/v3/versions/installer`, opts),
    ]);
    return {
      providerId,
      minecraftVersions: validVersionArray(games, 'Quilt game'),
      loaders: assertArray(loaders, 'Quilt loader').map((item) => ({
        version: validToken(item?.version, 'loader version'),
        stable: versionStable(item?.stable, 'Quilt loader'),
      })),
      installers: assertArray(installers, 'Quilt installer').map((item) => ({
        version: validToken(item?.version, 'installer version'),
        stable: versionStable(item?.stable, 'Quilt installer'),
        maven: validMavenCoordinate(item?.maven),
      })),
    };
  }

  if (providerId === 'forge') {
    const xml = await requestText(`${api}/net/minecraftforge/forge/maven-metadata.xml`, opts);
    return {
      providerId,
      versions: extractMavenVersions(xml, ''),
      minecraftVersions: [...new Set(extractMavenVersions(xml, '').map((version) => version.split('-')[0]))],
    };
  }

  if (providerId === 'neoforge') {
    const xml = await requestText(`${api}/releases/net/neoforged/neoforge/maven-metadata.xml`, opts);
    const versions = extractMavenVersions(xml, '');
    return {
      providerId,
      versions,
      minecraftVersions: [...new Set(versions.map((version) => {
        const legacy = version.match(/^(1\.\d{1,3}(?:\.\d{1,3})?)/);
        if (legacy) return legacy[1];
        const current = version.match(/^(\d{2})\.(\d{1,3})/);
        if (!current) return version;
        if (Number(current[1]) >= 26) return `${current[1]}.${current[2]}`;
        return current[2] === '0'
          ? `1.${current[1]}`
          : `1.${current[1]}.${current[2]}`;
      }))],
    };
  }

  if (providerId === 'paper') {
    const metadata = await requestJSON(`${api}/v2/projects/paper`, opts);
    if (metadata?.project_id !== 'paper') fail('Invalid Paper project metadata.', 'INVALID_METADATA');
    return { providerId, versions: validVersionArray(metadata.versions, 'Paper') };
  }

  const metadata = await requestJSON(`${api}/v2/purpur`, opts);
  if (!Array.isArray(metadata?.versions)) fail('Invalid Purpur project metadata.', 'INVALID_METADATA');
  return { providerId, versions: validVersionArray(metadata.versions, 'Purpur') };
}

function validMavenCoordinate(value) {
  if (typeof value !== 'string') fail('Missing installer Maven coordinate.', 'INVALID_METADATA');
  const parts = value.split(':');
  if (parts.length !== 3
      || !/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(parts[0])
      || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(parts[1])) {
    fail('Invalid installer Maven coordinate.', 'INVALID_METADATA');
  }
  return { group: parts[0], artifact: parts[1], version: validToken(parts[2], 'artifact version') };
}

async function mavenArtifact(provider, path, filename, options) {
  const base = provider.id === 'fabric' ? 'https://maven.fabricmc.net'
    : provider.id === 'quilt' ? 'https://maven.quiltmc.org/repository/release'
      : provider.id === 'forge' ? 'https://maven.minecraftforge.net'
        : 'https://maven.neoforged.net/releases';
  const url = `${base}/${path}/${filename}`;
  const sha1Text = await requestText(`${url}.sha1`, {
    ...options,
    allowedHosts: [...new Set([...provider.hosts, new URL(base).hostname])],
    maxBytes: 1024,
  });
  const sha1 = sha1Text.trim().match(/^(?:[0-9a-fA-F]{40})(?:\s+.*)?$/)?.[0].slice(0, 40).toLowerCase();
  if (!sha1) fail('Vendor did not publish a valid SHA-1 checksum.', 'CHECKSUM_UNAVAILABLE');
  return {
    providerId: provider.id,
    name: filename,
    url,
    sha1,
    maxBytes: HARD_MAX_BYTES,
    installType: 'installer',
  };
}

export async function resolveProviderInstall(providerId, {
  minecraftVersion,
  version,
  build,
  fetchImpl = globalThis.fetch,
  timeoutMs,
  signal,
} = {}) {
  const provider = requireProvider(providerId);
  if (provider.install !== true) fail('Provider does not advertise install support.', 'INSTALL_UNAVAILABLE');
  if (providerId === 'paper' || providerId === 'purpur') {
    const game = validMinecraftVersion(minecraftVersion ?? version);
    const opts = { fetchImpl, allowedHosts: provider.hosts, timeoutMs: validTimeout(timeoutMs, DEFAULT_TIMEOUT_MS), signal };
    if (providerId === 'paper') {
      const versionMeta = await requestJSON(`${provider.api}/v2/projects/paper/versions/${encodeURIComponent(game)}`, opts);
      if (versionMeta?.project_id !== 'paper' || versionMeta?.version !== game
          || !Array.isArray(versionMeta.builds) || !versionMeta.builds.length) {
        fail('Invalid Paper build metadata.', 'INVALID_METADATA');
      }
      const selected = build === undefined ? versionMeta.builds.at(-1) : build;
      if (!Number.isSafeInteger(selected) || !versionMeta.builds.includes(selected)) {
        fail('Invalid Paper build.', 'INVALID_VERSION');
      }
      const meta = await requestJSON(`${provider.api}/v2/projects/paper/versions/${encodeURIComponent(game)}/builds/${selected}`, opts);
      const download = meta?.downloads?.application;
      if (meta?.project_id !== 'paper' || meta?.version?.id !== game || meta?.build !== selected
          || !download || !/^[a-f0-9]{64}$/i.test(download.sha256) || !safeFilename(download.name)) {
        fail('Paper build lacks valid download metadata.', 'INVALID_METADATA');
      }
      return {
        providerId, build: selected, name: download.name, size: optionalSize(download.size),
        sha256: download.sha256.toLowerCase(),
        url: `${provider.api}/v2/projects/paper/versions/${encodeURIComponent(game)}/builds/${selected}/downloads/${encodeURIComponent(download.name)}`,
        maxBytes: HARD_MAX_BYTES, installType: 'server',
      };
    }
    const buildsMeta = await requestJSON(`${provider.api}/v2/purpur/${encodeURIComponent(game)}`, opts);
    const builds = buildsMeta?.builds?.all;
    if (buildsMeta?.project !== 'purpur' || buildsMeta?.version !== game
        || !Array.isArray(builds) || !builds.length
        || builds.some((entry) => !Number.isSafeInteger(entry) || entry < 1)) {
      fail('Invalid Purpur build metadata.', 'INVALID_METADATA');
    }
    const selected = build === undefined ? builds.at(-1) : build;
    if (!Number.isSafeInteger(selected) || !builds.includes(selected)) fail('Invalid Purpur build.', 'INVALID_VERSION');
    const meta = await requestJSON(`${provider.api}/v2/purpur/${encodeURIComponent(game)}/${selected}`, opts);
    const sha256 = meta?.downloads?.application?.sha256;
    if (meta?.project !== 'purpur' || meta?.version !== game || meta?.build !== selected
        || !/^[a-f0-9]{64}$/i.test(sha256 ?? '')) {
      fail('Purpur build lacks a valid download checksum.', 'INVALID_METADATA');
    }
    return {
      providerId, build: selected, name: `purpur-${game}-${selected}.jar`, sha256: sha256.toLowerCase(),
      url: `${provider.api}/v2/purpur/${encodeURIComponent(game)}/${selected}/download`,
      maxBytes: HARD_MAX_BYTES, installType: 'server',
    };
  }

  const opts = { fetchImpl, allowedHosts: provider.hosts, timeoutMs: validTimeout(timeoutMs, DEFAULT_TIMEOUT_MS), signal };
  if (providerId === 'forge' || providerId === 'neoforge') {
    const selected = validToken(version, 'provider version');
    const catalog = await getProviderCatalog(providerId, { fetchImpl, timeoutMs, signal });
    if (!catalog.versions.includes(selected)) fail('Version is not in the official provider catalog.', 'INVALID_VERSION');
    const artifact = providerId === 'forge'
      ? `forge-${selected}-installer.jar`
      : `neoforge-${selected}-installer.jar`;
    const path = providerId === 'forge'
      ? `net/minecraftforge/forge/${selected}`
      : `net/neoforged/neoforge/${selected}`;
    return mavenArtifact(provider, path, artifact, opts);
  }

  if (providerId === 'fabric' || providerId === 'quilt') {
    const requested = version === undefined ? undefined : validToken(version, 'installer version');
    const endpoint = providerId === 'fabric' ? `${provider.api}/v2/versions/installer` : `${provider.api}/v3/versions/installer`;
    const installers = assertArray(await requestJSON(endpoint, opts), `${provider.name} installer`);
    const item = requested
      ? installers.find((entry) => entry?.version === requested)
      : installers.find((entry) => entry?.stable) ?? installers[0];
    if (!item) fail('No installer is available.', 'INSTALL_UNAVAILABLE');
    const coordinate = validMavenCoordinate(item.maven);
    const path = `${coordinate.group.replaceAll('.', '/')}/${coordinate.artifact}/${coordinate.version}`;
    const filename = `${coordinate.artifact}-${coordinate.version}.jar`;
    return mavenArtifact(provider, path, filename, opts);
  }
  fail('Provider installation is unavailable.', 'INSTALL_UNAVAILABLE');
}

function optionalSize(value) {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1 || value > HARD_MAX_BYTES) {
    fail('Vendor published an invalid artifact size.', 'INVALID_SIZE');
  }
  return value;
}

function safeFilename(value) {
  return typeof value === 'string' && value.length <= 255 && value !== '.' && value !== '..'
    && /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(value);
}

function modrinthId(value, label) {
  if (typeof value !== 'string' || value.length < 3 || value.length > 64
      || !/^[A-Za-z0-9_-]+$/.test(value)) {
    fail(`Invalid Modrinth ${label}.`, 'INVALID_IDENTIFIER');
  }
  return value;
}

const MODRINTH_TYPES = new Set(['mod', 'plugin', 'modpack']);
const MODRINTH_LOADERS = new Set(['fabric', 'forge', 'neoforge', 'quilt', 'paper', 'purpur']);

export async function searchModrinth({
  query = '',
  type,
  gameVersion,
  loader,
  limit = 20,
  offset = 0,
  fetchImpl = globalThis.fetch,
  timeoutMs,
  signal,
} = {}) {
  if (!MODRINTH_TYPES.has(type)) fail('Modrinth type must be mod, plugin, or modpack.', 'INVALID_CONTENT_TYPE');
  if (typeof query !== 'string' || query.length > 200 || /[\u0000-\u001f]/.test(query)) {
    fail('Invalid Modrinth search query.', 'INVALID_QUERY');
  }
  if (gameVersion !== undefined) validMinecraftVersion(gameVersion);
  if (loader !== undefined && !MODRINTH_LOADERS.has(loader)) fail('Unsupported Modrinth loader.', 'INVALID_LOADER');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100
      || !Number.isSafeInteger(offset) || offset < 0 || offset > 100_000) {
    fail('Invalid Modrinth pagination.', 'INVALID_PAGINATION');
  }
  const facets = [[`project_type:${type}`]];
  if (gameVersion) facets.push([`versions:${gameVersion}`]);
  if (loader && (type === 'mod' || type === 'modpack')) facets.push([`categories:${loader}`]);
  const url = new URL('https://api.modrinth.com/v2/search');
  url.searchParams.set('query', query);
  url.searchParams.set('facets', JSON.stringify(facets));
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('offset', String(offset));
  const data = await requestJSON(url.href, {
    fetchImpl, allowedHosts: MODRINTH_HOSTS, timeoutMs: validTimeout(timeoutMs, DEFAULT_TIMEOUT_MS), signal,
  });
  if (!Array.isArray(data?.hits) || !Number.isSafeInteger(data.total_hits) || data.total_hits < 0) {
    fail('Modrinth returned malformed search metadata.', 'INVALID_METADATA');
  }
  return {
    total: data.total_hits,
    hits: data.hits.map((hit) => {
      const projectId = modrinthId(hit?.project_id, 'project ID');
      if (hit.project_type !== type || typeof hit.slug !== 'string' || hit.slug.length > 100
          || !/^[A-Za-z0-9_-]+$/.test(hit.slug)) {
        fail('Modrinth returned an invalid project.', 'INVALID_METADATA');
      }
      return {
        projectId, slug: hit.slug, title: boundedText(hit.title, 200),
        description: boundedText(hit.description, 1000), projectType: hit.project_type,
        downloads: Number.isSafeInteger(hit.downloads) && hit.downloads >= 0 ? hit.downloads : 0,
        versions: Array.isArray(hit.versions)
          ? hit.versions.slice(0, 500).map((version) => validToken(version, 'game version', 64))
          : [],
      };
    }),
  };
}

function boundedText(value, maxLength) {
  return typeof value === 'string' ? value.slice(0, maxLength) : '';
}

export async function getModrinthVersion(versionId, {
  type,
  fetchImpl = globalThis.fetch,
  timeoutMs,
  signal,
} = {}) {
  const id = modrinthId(versionId, 'version ID');
  const data = await requestJSON(`https://api.modrinth.com/v2/version/${encodeURIComponent(id)}`, {
    fetchImpl, allowedHosts: MODRINTH_HOSTS, timeoutMs: validTimeout(timeoutMs, DEFAULT_TIMEOUT_MS), signal,
  });
  const projectId = modrinthId(data?.project_id, 'project ID');
  const validatedId = modrinthId(data?.id, 'version ID');
  const projectType = data?.project_type ?? type;
  if (validatedId !== id || (projectType !== undefined && !MODRINTH_TYPES.has(projectType))
      || (type !== undefined && projectType !== type) || !Array.isArray(data.files) || !data.files.length) {
    fail('Modrinth returned malformed version metadata.', 'INVALID_METADATA');
  }
  const files = data.files.map((file) => {
    if (!safeFilename(file?.filename)) fail('Modrinth returned an invalid filename.', 'INVALID_METADATA');
    const url = validURL(file.url, ['cdn.modrinth.com']).href;
    const size = optionalSize(file.size);
    const hashes = {};
    for (const algorithm of ['sha512', 'sha1']) {
      if (file.hashes?.[algorithm] !== undefined) {
        const expectedLength = algorithm === 'sha512' ? 128 : 40;
        if (typeof file.hashes[algorithm] !== 'string'
            || !new RegExp(`^[a-f0-9]{${expectedLength}}$`, 'i').test(file.hashes[algorithm])) {
          fail('Modrinth returned an invalid file checksum.', 'INVALID_METADATA');
        }
        hashes[algorithm] = file.hashes[algorithm].toLowerCase();
      }
    }
    if (!hashes.sha512 && !hashes.sha1) fail('Modrinth file has no supported checksum.', 'CHECKSUM_UNAVAILABLE');
    return { filename: file.filename, url, size, hashes, primary: file.primary === true };
  });
  return {
    id: validatedId,
    projectId,
    projectType,
    name: boundedText(data.name, 200),
    versionNumber: boundedText(data.version_number, 100),
    gameVersions: Array.isArray(data.game_versions)
      ? data.game_versions.slice(0, 500).map((version) => validToken(version, 'game version', 64))
      : [],
    loaders: Array.isArray(data.loaders)
      ? data.loaders.slice(0, 100).map((loader) => validToken(loader, 'loader'))
      : [],
    files,
  };
}

export async function listModrinthVersions(projectId, {
  type,
  gameVersion,
  loader,
  fetchImpl = globalThis.fetch,
  timeoutMs,
  signal,
} = {}) {
  const id = modrinthId(projectId, 'project ID');
  if (type !== undefined && !MODRINTH_TYPES.has(type)) fail('Invalid Modrinth project type.', 'INVALID_CONTENT_TYPE');
  if (gameVersion !== undefined) validMinecraftVersion(gameVersion);
  if (loader !== undefined && !MODRINTH_LOADERS.has(loader)) fail('Unsupported Modrinth loader.', 'INVALID_LOADER');
  const url = new URL(`https://api.modrinth.com/v2/project/${encodeURIComponent(id)}/version`);
  if (gameVersion) url.searchParams.set('game_versions', JSON.stringify([gameVersion]));
  if (loader && ['mod', 'modpack'].includes(type)) url.searchParams.set('loaders', JSON.stringify([loader]));
  const response = await requestJSON(url.href, {
    fetchImpl,
    allowedHosts: MODRINTH_HOSTS,
    timeoutMs: validTimeout(timeoutMs, DEFAULT_TIMEOUT_MS),
    signal,
  });
  if (!Array.isArray(response) || response.length > 500) fail('Modrinth returned malformed project versions.', 'INVALID_METADATA');
  return response.map((entry) => {
    if (modrinthId(entry?.project_id, 'project ID') !== id
        || (entry.project_type !== undefined && !MODRINTH_TYPES.has(entry.project_type))
        || (type !== undefined && entry.project_type !== undefined && entry.project_type !== type)
        || !Array.isArray(entry.game_versions) || !Array.isArray(entry.loaders)
        || !Array.isArray(entry.files) || entry.files.length === 0) {
      fail('Modrinth returned an invalid project version.', 'INVALID_METADATA');
    }
    const versionId = modrinthId(entry.id, 'version ID');
    const files = entry.files.map((file) => {
      if (!safeFilename(file?.filename)) fail('Modrinth returned an invalid filename.', 'INVALID_METADATA');
      return { filename: file.filename, primary: file.primary === true };
    });
    return {
      id: versionId,
      projectId: id,
      projectType: entry.project_type ?? type,
      name: boundedText(entry.name, 200),
      versionNumber: boundedText(entry.version_number, 100),
      gameVersions: entry.game_versions.slice(0, 500).map((version) => validToken(version, 'game version', 64)),
      loaders: entry.loaders.slice(0, 100).map((loaderId) => validToken(loaderId, 'loader')),
      files,
    };
  });
}

export async function downloadVerified(artifact, {
  fetchImpl = globalThis.fetch,
  timeoutMs,
  maxBytes,
  signal,
} = {}) {
  if (!artifact || typeof artifact !== 'object') fail('Invalid artifact metadata.', 'INVALID_METADATA');
  let allowedHosts;
  if (artifact.providerId === 'modrinth') allowedHosts = ['cdn.modrinth.com'];
  else allowedHosts = requireProvider(artifact.providerId).hosts;
  const url = validURL(artifact.url, allowedHosts);
  const expected = artifact.sha512 ?? artifact.sha256 ?? artifact.sha1
    ?? artifact.hashes?.sha512 ?? artifact.hashes?.sha256 ?? artifact.hashes?.sha1;
  const algorithm = artifact.sha512 || artifact.hashes?.sha512 ? 'sha512'
    : artifact.sha256 || artifact.hashes?.sha256 ? 'sha256' : 'sha1';
  const checksumLength = algorithm === 'sha1' ? 40 : algorithm === 'sha256' ? 64 : 128;
  if (typeof expected !== 'string' || !new RegExp(`^[a-f0-9]{${checksumLength}}$`, 'i').test(expected)) {
    fail('Artifact requires a valid published checksum.', 'CHECKSUM_UNAVAILABLE');
  }
  const expectedSize = optionalSize(artifact.size);
  const limit = validByteLimit(maxBytes ?? artifact.maxBytes ?? HARD_MAX_BYTES);
  if (expectedSize !== undefined && expectedSize > limit) fail('Artifact exceeds the configured size limit.', 'SIZE_LIMIT');
  const bytes = await requestBytes(url.href, {
    fetchImpl,
    allowedHosts,
    timeoutMs: validTimeout(timeoutMs, DOWNLOAD_TIMEOUT_MS),
    maxBytes: Math.min(limit, expectedSize ?? limit),
    signal,
  });
  if (!bytes.byteLength) fail('Downloaded artifact is empty.', 'INVALID_SIZE');
  if (expectedSize !== undefined && bytes.byteLength !== expectedSize) {
    fail('Downloaded artifact size did not match vendor metadata.', 'SIZE_MISMATCH');
  }
  const actual = createHash(algorithm).update(bytes).digest('hex');
  if (actual !== expected.toLowerCase()) fail('Downloaded artifact checksum did not match.', 'CHECKSUM_MISMATCH');
  return bytes;
}

export async function downloadModrinthVersion(versionId, options = {}) {
  const version = await getModrinthVersion(versionId, options);
  const file = version.files.find((candidate) => candidate.primary) ?? version.files[0];
  return {
    version,
    file: { ...file, providerId: 'modrinth' },
    bytes: await downloadVerified({ ...file, providerId: 'modrinth' }, options),
  };
}
