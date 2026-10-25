import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  downloadModrinthVersion,
  downloadVerified,
  getModrinthVersion,
  getProviderCatalog,
  listModrinthVersions,
  listProviders,
  resolveProviderInstall,
  searchModrinth,
} from '../src/ecosystem.js';

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json' },
});
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const sha1 = (data) => createHash('sha1').update(data).digest('hex');

test('provider catalog explicitly lists supported software and install capabilities', () => {
  const catalog = listProviders();
  assert.deepEqual(catalog.map(({ id }) => id), [
    'fabric', 'forge', 'neoforge', 'quilt', 'paper', 'purpur',
  ]);
  assert.ok(catalog.every((provider) => provider.install === true && provider.installArtifact));
  assert.equal(Object.isFrozen(catalog), false);
});

test('Paper catalog validates vendor project metadata and versions', async () => {
  const catalog = await getProviderCatalog('paper', {
    fetchImpl: async (url) => {
      assert.equal(url, 'https://api.papermc.io/v2/projects/paper');
      return json({ project_id: 'paper', versions: ['1.21.1', '1.20.6'] });
    },
  });
  assert.deepEqual(catalog, { providerId: 'paper', versions: ['1.21.1', '1.20.6'] });

  await assert.rejects(
    getProviderCatalog('paper', { fetchImpl: async () => json({ project_id: 'other', versions: [] }) }),
    { code: 'INVALID_METADATA' },
  );
  await assert.rejects(
    getProviderCatalog('unknown', { fetchImpl: async () => json({}) }),
    { code: 'INVALID_PROVIDER' },
  );
});

test('Fabric catalogs accept compressed-response length differences and Mojang version identifiers', async () => {
  const catalog = await getProviderCatalog('fabric', {
    fetchImpl: async (url) => {
      const value = String(url).endsWith('/game')
        ? [
          { version: '1.21.8' },
          { version: '24w14a' },
          { version: 'b1.7.3' },
          { version: '3D Shareware v1.34' },
        ]
        : String(url).endsWith('/loader')
          ? [{ version: '0.16.14', stable: true }]
          : [{ version: '1.0.1', stable: true, maven: 'net.fabricmc:fabric-installer:1.0.1' }];
      return new Response(JSON.stringify(value), {
        headers: { 'content-type': 'application/json', 'content-length': '1' },
      });
    },
  });
  assert.deepEqual(catalog.minecraftVersions, [
    '1.21.8', '24w14a', 'b1.7.3', '3D Shareware v1.34',
  ]);
  assert.equal(catalog.loaders[0].version, '0.16.14');
});

test('NeoForge catalogs map all published version families to Minecraft releases', async () => {
  const metadata = [
    '21.0.167',
    '21.1.172',
    '20.4.237',
    '20.1.105',
    '26.4.0',
  ].map((version) => `<version>${version}</version>`).join('');
  const catalog = await getProviderCatalog('neoforge', {
    fetchImpl: async (url) => {
      assert.equal(url, 'https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml');
      return new Response(`<metadata><versioning><versions>${metadata}</versions></versioning></metadata>`);
    },
  });
  assert.deepEqual(catalog.minecraftVersions, ['1.21', '1.21.1', '1.20.4', '1.20.1', '26.4']);
});

test('provider and Modrinth identifiers, versions, and hosts are restricted', async () => {
  await assert.rejects(
    resolveProviderInstall('paper', {
      minecraftVersion: '../1.21',
      fetchImpl: async () => { throw new Error('must not fetch'); },
    }),
    { code: 'INVALID_VERSION' },
  );
  await assert.rejects(
    getModrinthVersion('../bad', { fetchImpl: async () => { throw new Error('must not fetch'); } }),
    { code: 'INVALID_IDENTIFIER' },
  );
  await assert.rejects(
    downloadVerified({
      providerId: 'paper', url: 'https://example.com/server.jar',
      sha256: 'a'.repeat(64),
    }, { fetchImpl: async () => { throw new Error('must not fetch'); } }),
    { code: 'INVALID_HOST' },
  );
  await assert.rejects(
    searchModrinth({ type: 'anything', fetchImpl: async () => { throw new Error('must not fetch'); } }),
    { code: 'INVALID_CONTENT_TYPE' },
  );
});

test('verified downloads check vendor checksum, expected size, and hard byte limits', async () => {
  const contents = Buffer.from('verified server artifact');
  const artifact = {
    providerId: 'paper',
    url: 'https://api.papermc.io/artifact.jar',
    sha256: sha256(contents),
    size: contents.byteLength,
  };
  const bytes = await downloadVerified(artifact, {
    fetchImpl: async () => new Response(contents),
  });
  assert.deepEqual(Buffer.from(bytes), contents);

  await assert.rejects(downloadVerified({ ...artifact, sha256: '0'.repeat(64) }, {
    fetchImpl: async () => new Response(contents),
  }), { code: 'CHECKSUM_MISMATCH' });

  await assert.rejects(downloadVerified({ ...artifact, size: contents.byteLength + 1 }, {
    fetchImpl: async () => new Response(contents),
  }), { code: 'SIZE_MISMATCH' });

  await assert.rejects(downloadVerified({ ...artifact, size: undefined }, {
    maxBytes: 4,
    fetchImpl: async () => new Response(contents),
  }), { code: 'SIZE_LIMIT' });
});

test('Maven installer resolution fails closed when the published SHA-1 is unavailable', async () => {
  let requests = 0;
  const fetchImpl = async (url) => {
    requests += 1;
    if (url.endsWith('maven-metadata.xml')) {
      return new Response(
        '<metadata><versioning><versions><version>1.20.1-47.2.0</version></versions></versioning></metadata>',
      );
    }
    return new Response('not a checksum');
  };
  await assert.rejects(resolveProviderInstall('forge', { version: '1.20.1-47.2.0', fetchImpl }), {
    code: 'CHECKSUM_UNAVAILABLE',
  });
  assert.equal(requests, 2);
});

test('Maven and Paper installers expose only checksum-backed official artifacts', async () => {
  const jar = Buffer.from('installer bytes');
  const forge = await resolveProviderInstall('forge', {
    version: '1.20.1-47.2.0',
    fetchImpl: async (url) => {
      if (url.endsWith('maven-metadata.xml')) {
        return new Response(
          '<metadata><versioning><versions><version>1.20.1-47.2.0</version></versions></versioning></metadata>',
        );
      }
      assert.equal(
        url,
        'https://maven.minecraftforge.net/net/minecraftforge/forge/1.20.1-47.2.0/forge-1.20.1-47.2.0-installer.jar.sha1',
      );
      return new Response(sha1(jar));
    },
  });
  assert.equal(forge.sha1, sha1(jar));
  assert.equal(new URL(forge.url).hostname, 'maven.minecraftforge.net');

  let paperRequest = 0;
  const paper = await resolveProviderInstall('paper', {
    minecraftVersion: '1.21.1',
    fetchImpl: async (url) => {
      paperRequest += 1;
      if (url.endsWith('/versions/1.21.1')) {
        return json({ project_id: 'paper', version: '1.21.1', builds: [10, 11] });
      }
      assert.equal(url, 'https://api.papermc.io/v2/projects/paper/versions/1.21.1/builds/11');
      return json({
        project_id: 'paper',
        version: { id: '1.21.1' },
        build: 11,
        downloads: { application: { name: 'paper.jar', sha256: sha256(jar), size: jar.length } },
      });
    },
  });
  assert.equal(paper.sha256, sha256(jar));
  assert.equal(paper.size, jar.length);
  assert.equal(paperRequest, 2);
});

test('malformed provider JSON and oversized metadata are rejected', async () => {
  await assert.rejects(
    getProviderCatalog('purpur', { fetchImpl: async () => new Response('{broken') }),
    { code: 'INVALID_METADATA' },
  );
  await assert.rejects(
    getProviderCatalog('paper', {
      fetchImpl: async () => new Response(' '.repeat(2 * 1024 * 1024 + 1)),
    }),
    { code: 'SIZE_LIMIT' },
  );
});

test('Modrinth search and version downloads validate content metadata and verify SHA-1', async () => {
  const data = Buffer.from('a mod file');
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.startsWith('https://api.modrinth.com/v2/search?')) {
      const parsed = new URL(url);
      assert.deepEqual(JSON.parse(parsed.searchParams.get('facets')), [['project_type:mod']]);
      return json({
        total_hits: 1,
        hits: [{
          project_id: 'abc123',
          slug: 'sample-mod',
          title: 'Sample Mod',
          description: 'Description',
          project_type: 'mod',
          downloads: 42,
          versions: ['1.21.8'],
        }],
      });
    }
    if (url === 'https://api.modrinth.com/v2/version/version123') {
      return json({
        id: 'version123',
        project_id: 'abc123',
        name: 'Sample Mod Release',
        version_number: '1.0',
        files: [{
          filename: 'sample.jar',
          url: 'https://cdn.modrinth.com/data/abc123/version123/sample.jar',
          size: data.length,
          hashes: { sha1: sha1(data) },
          primary: true,
        }],
      });
    }
    if (url === 'https://cdn.modrinth.com/data/abc123/version123/sample.jar') {
      return new Response(data);
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const search = await searchModrinth({ query: 'sample', type: 'mod', fetchImpl });
  assert.equal(search.hits[0].projectId, 'abc123');
  const result = await downloadModrinthVersion('version123', { fetchImpl });
  assert.equal(result.version.projectType, undefined);
  assert.equal(result.file.filename, 'sample.jar');
  assert.deepEqual(Buffer.from(result.bytes), data);
  assert.equal(calls.length, 3);
});

test('Modrinth rejects unapproved CDN URLs and missing checksums', async () => {
  const base = {
    id: 'version123',
    project_id: 'abc123',
    files: [{
      filename: 'bad.jar',
      url: 'https://not-modrinth.example/bad.jar',
      size: 4,
      hashes: { sha1: 'a'.repeat(40) },
    }],
  };
  await assert.rejects(getModrinthVersion('version123', {
    fetchImpl: async () => json(base),
  }), { code: 'INVALID_HOST' });

  await assert.rejects(getModrinthVersion('version123', {
    fetchImpl: async () => json({
      ...base,
      files: [{
        ...base.files[0],
        url: 'https://cdn.modrinth.com/data/abc123/version123/bad.jar',
        hashes: {},
      }],
    }),
  }), { code: 'CHECKSUM_UNAVAILABLE' });
});

test('lists only validated Modrinth project versions with requested filters', async () => {
  const versions = await listModrinthVersions('project123', {
    type: 'mod',
    gameVersion: '1.21.8',
    loader: 'fabric',
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      assert.equal(parsed.searchParams.get('game_versions'), '["1.21.8"]');
      assert.equal(parsed.searchParams.get('loaders'), '["fabric"]');
      return json([{
        id: 'version123', project_id: 'project123', project_type: 'mod',
        name: 'Example', version_number: '1.0', game_versions: ['1.21.8'], loaders: ['fabric']
      }]);
    },
  });
  assert.equal(versions[0].id, 'version123');
  assert.equal(versions[0].projectType, 'mod');
  assert.deepEqual(versions[0].loaders, ['fabric']);
});
