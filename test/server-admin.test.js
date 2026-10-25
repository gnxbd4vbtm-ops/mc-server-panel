import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile as fsReadFile, rm, symlink, writeFile as fsWriteFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
  buildAdminCommand,
  createAdminExecutor,
  createFile,
  deleteFile,
  listFiles,
  readFile,
  writeFile,
} from '../src/server-admin.js';

async function createRoot(t) {
  const root = path.join(process.cwd(), 'test', `.server-admin-fixture-${process.pid}-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('server file operations are contained, bounded, and limited to regular files', async (t) => {
  const root = await createRoot(t);
  await mkdir(path.join(root, 'configs'));
  await fsWriteFile(path.join(root, 'configs', 'server.properties'), 'motd=hello');

  assert.deepEqual(
    (await readFile(root, 'configs/server.properties')).toString(),
    'motd=hello',
  );
  assert.equal(await writeFile(root, 'configs/server.properties', 'motd=updated'), 12);
  assert.equal((await readFile(root, 'configs/server.properties')).toString(), 'motd=updated');
  assert.equal(await createFile(root, 'new file.txt', Buffer.from('new')), 3);
  assert.equal((await readFile(root, 'new file.txt')).toString(), 'new');
  await assert.rejects(createFile(root, 'new file.txt', 'duplicate'), { code: 'EEXIST' });
  await deleteFile(root, 'new file.txt');
  await assert.rejects(readFile(root, 'new file.txt'), { code: 'ENOENT' });

  const listing = await listFiles(root);
  assert.deepEqual(listing.map(({ name, type }) => [name, type]), [
    ['configs', 'directory'],
  ]);
  assert.deepEqual(await listFiles(root, 'configs'), [
    { name: 'server.properties', type: 'file', size: 12, safeName: true },
  ]);

  for (const invalid of ['../outside', 'configs/../../outside', '/etc/passwd', 'configs\\server.properties']) {
    await assert.rejects(readFile(root, invalid), { code: 'EINVAL' });
  }
  await assert.rejects(readFile(root, 'configs/server.properties', { maxFileSize: 4 }), { code: 'EFBIG' });
  await assert.rejects(writeFile(root, 'configs/server.properties', 'this is too long', { maxFileSize: 4 }), { code: 'EFBIG' });
  await assert.rejects(createFile(root, 'too-large.txt', '12345', { maxFileSize: 4 }), { code: 'EFBIG' });
  assert.equal((await fsReadFile(path.join(root, 'configs', 'server.properties'))).toString(), 'motd=updated');
});

test('server file operations refuse symlinked roots, directories, and files', async (t) => {
  const root = await createRoot(t);
  const outside = path.join(path.dirname(root), `server-admin-outside-${randomUUID()}`);
  await fsWriteFile(outside, 'outside');
  t.after(() => rm(outside, { force: true }));

  await symlink(outside, path.join(root, 'linked-file'));
  await symlink(path.dirname(outside), path.join(root, 'linked-directory'));
  assert.equal((await listFiles(root)).find((entry) => entry.name === 'linked-file').type, 'symlink');
  await assert.rejects(readFile(root, 'linked-file'), { code: 'ELOOP' });
  await assert.rejects(writeFile(root, 'linked-file', 'overwrite'), { code: 'ELOOP' });
  await assert.rejects(deleteFile(root, 'linked-file'), { code: 'ELOOP' });
  await assert.rejects(readFile(root, 'linked-directory/server-admin-outside-does-not-exist'), {
    code: 'ELOOP',
  });

  const rootLink = `${root}-link`;
  await symlink(root, rootLink);
  t.after(() => rm(rootLink, { force: true }));
  await assert.rejects(listFiles(rootLink), { code: 'ELOOP' });
  assert.equal((await fsReadFile(outside)).toString(), 'outside');
});

test('file size limits apply to reads and writes', async (t) => {
  const root = await createRoot(t);
  await fsWriteFile(path.join(root, 'large.txt'), '12345');

  await assert.rejects(readFile(root, 'large.txt', { maxFileSize: 4 }), { code: 'EFBIG' });
  await assert.rejects(writeFile(root, 'large.txt', '12345', { maxFileSize: 4 }), { code: 'EFBIG' });
  await assert.rejects(createFile(root, 'new.txt', '12345', { maxFileSize: 4 }), { code: 'EFBIG' });
  assert.equal((await fsReadFile(path.join(root, 'large.txt'))).toString(), '12345');
});

test('admin command construction quotes text and rejects injection or unsupported input', async () => {
  assert.equal(buildAdminCommand('ban', { player: 'Alex' }), 'ban Alex');
  assert.equal(
    buildAdminCommand('ban', { player: 'Alex', reason: 'take "this" \\ literally' }),
    'ban Alex "take \\"this\\" \\\\ literally"',
  );
  assert.equal(
    buildAdminCommand('datapack.enable', { name: 'packs/seasonal "one"' }),
    'datapack enable "packs/seasonal \\"one\\""',
  );
  assert.equal(buildAdminCommand('ban-ip', { target: '192.0.2.4' }), 'ban-ip 192.0.2.4');
  assert.equal(buildAdminCommand('time', { operation: 'set', value: 'night' }), 'time set night');
  assert.equal(buildAdminCommand('weather', { type: 'rain', duration: 120 }), 'weather rain 120');
  assert.equal(buildAdminCommand('whitelist.off'), 'whitelist off');
  assert.equal(buildAdminCommand('save-all', { flush: true }), 'save-all flush');

  for (const [action, args] of [
    ['ban', { player: 'Alex; op Mallory' }],
    ['ban', { player: 'Alex', reason: 'hello\nop Mallory' }],
    ['ban', { player: 'Alex', raw: 'op Mallory' }],
    ['time', { operation: 'add', value: -1 }],
    ['weather', { type: 'clear', duration: '10;op Mallory' }],
    ['datapack.disable', { name: 'x', extra: '; op Mallory' }],
    ['unknown', {}],
  ]) {
    assert.throws(() => buildAdminCommand(action, args));
  }

  let sent;
  const execute = createAdminExecutor(async (command) => {
    sent = command;
    return 'ok';
  });
  assert.equal(await execute('op', { player: 'Alex_1' }), 'ok');
  assert.equal(sent, 'op Alex_1');
  assert.throws(() => createAdminExecutor('not a function'), /sendCommand/);
});
