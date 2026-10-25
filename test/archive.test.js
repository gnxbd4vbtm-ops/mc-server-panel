import assert from 'node:assert/strict';
import {
  chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile
} from 'node:fs/promises';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { gunzipSync, gzipSync } from 'node:zlib';
import { createArchive, extractArchive } from '../src/archive.js';

const fixtures = [];

async function makeFixture() {
  const root = await mkdtemp(path.join(process.cwd(), '.archive-test-'));
  fixtures.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test('round-trips files and directories and omits symlinks', async () => {
  const root = await makeFixture();
  const source = path.join(root, 'source');
  const archive = path.join(root, 'backup.tar.gz');
  const destination = path.join(root, 'restored');
  await makeDirectory(path.join(source, 'world'));
  await writeFile(path.join(source, 'server.properties'), 'motd=hello\n');
  await writeFile(path.join(source, 'world', 'region.dat'), Buffer.from([0, 1, 2, 255]));
  const longName = `${'long-name-'.repeat(12)}file.dat`;
  await writeFile(path.join(source, longName), 'PAX path support');
  await chmod(path.join(source, 'world', 'region.dat'), 0o750);
  await symlink(path.join(source, 'server.properties'), path.join(source, 'shortcut'));

  const created = await createArchive(source, archive);
  const extracted = await extractArchive(archive, destination);

  assert.equal(created.entries, 4);
  assert.equal(extracted.entries, 4);
  assert.equal(await readFile(path.join(destination, 'server.properties'), 'utf8'), 'motd=hello\n');
  assert.deepEqual(await readFile(path.join(destination, 'world', 'region.dat')), Buffer.from([0, 1, 2, 255]));
  assert.equal(await readFile(path.join(destination, longName), 'utf8'), 'PAX path support');
  assert.equal((await lstat(path.join(destination, 'world', 'region.dat'))).mode & 0o777, 0o750);
  assert.deepEqual((await readdir(destination)).sort(), [longName, 'server.properties', 'world'].sort());
});

test('checks SHA-256 integrity before publishing extracted contents', async () => {
  const root = await makeFixture();
  const source = path.join(root, 'source');
  const archive = path.join(root, 'backup.tar.gz');
  const destination = path.join(root, 'restored');
  await makeDirectory(source);
  await writeFile(path.join(source, 'save.dat'), 'correct content');
  await createArchive(source, archive);

  const tar = gunzipSync(await readFile(archive));
  const needle = Buffer.from('correct content');
  const offset = tar.indexOf(needle);
  assert.notEqual(offset, -1);
  Buffer.from('corrupt content').copy(tar, offset);
  await writeFile(archive, gzipSync(tar));

  await assert.rejects(extractArchive(archive, destination), /SHA-256 verification failed/);
  await assert.rejects(lstat(destination), { code: 'ENOENT' });
  assert.deepEqual((await readdir(root)).filter((name) => name.includes('.restore-')), []);
});

test('rejects traversal paths before writing outside the staging directory', async () => {
  const root = await makeFixture();
  const archive = path.join(root, 'hostile.tar.gz');
  const destination = path.join(root, 'restored');
  await writeFile(archive, gzipSync(tarEntry('../escape.txt', Buffer.from('owned'))));

  await assert.rejects(extractArchive(archive, destination), /Unsafe archive path/);
  await assert.rejects(lstat(path.join(root, 'escape.txt')), { code: 'ENOENT' });
  await assert.rejects(lstat(destination), { code: 'ENOENT' });
});

test('rejects absolute paths and archive symlink or hardlink entries', async () => {
  const root = await makeFixture();
  const archive = path.join(root, 'hostile.tar.gz');
  const destination = path.join(root, 'restored');
  const hostileEntries = [
    [path.join(root, 'outside.txt'), '0'],
    ['linked.txt', '2'],
    ['hard-linked.txt', '1']
  ];

  for (const [entryPath, type] of hostileEntries) {
    await writeFile(archive, gzipSync(tarEntry(entryPath, Buffer.from('payload'), type)));
    await assert.rejects(extractArchive(archive, destination), /Unsafe archive path|links are not allowed/);
    await assert.rejects(lstat(destination), { code: 'ENOENT' });
  }
  await assert.rejects(lstat(path.join(root, 'outside.txt')), { code: 'ENOENT' });
});

test('enforces limits and AbortSignal cancellation without leaving partial outputs', async () => {
  const root = await makeFixture();
  const source = path.join(root, 'source');
  const archive = path.join(root, 'limited.tar.gz');
  await makeDirectory(source);
  await writeFile(path.join(source, 'one.dat'), 'data');

  await assert.rejects(createArchive(source, archive, { maxEntries: 1 }), /entry limit/);
  await assert.rejects(lstat(archive), { code: 'ENOENT' });
  await assert.rejects(createArchive(source, archive, { maxArchiveBytes: 1 }), /Compressed archive size limit/);
  await assert.rejects(lstat(archive), { code: 'ENOENT' });

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(createArchive(source, archive, { signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(lstat(archive), { code: 'ENOENT' });

  await createArchive(source, archive);
  await assert.rejects(
    extractArchive(archive, path.join(root, 'too-large'), { maxTotalBytes: 1 }),
    /size limit/
  );
  await assert.rejects(lstat(path.join(root, 'too-large')), { code: 'ENOENT' });
});

async function makeDirectory(directory) {
  await mkdir(directory, { recursive: true });
}

function tarEntry(entryPath, data, type = '0') {
  const header = Buffer.alloc(512);
  header.write(entryPath, 0, 100, 'utf8');
  writeOctal(header, 100, 8, 0o600);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, data.length);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = type.charCodeAt(0);
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(checksum.toString(8).padStart(6, '0'), 148, 6, 'ascii');
  header[154] = 0;
  header[155] = 0x20;
  const padding = Buffer.alloc((512 - data.length % 512) % 512);
  return Buffer.concat([header, data, padding, Buffer.alloc(1024)]);
}

function writeOctal(buffer, offset, length, value) {
  buffer.write(`${value.toString(8).padStart(length - 1, '0')}\0`, offset, length, 'ascii');
}
