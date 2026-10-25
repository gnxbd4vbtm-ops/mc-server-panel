import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { AuthService } from '../src/auth.js';
import { Database } from '../src/database.js';

const fixtures = [];

async function createAuth() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'byte-panel-auth-'));
  fixtures.push(directory);
  const database = new Database(path.join(directory, 'panel.sqlite'));
  return { auth: new AuthService(database), database };
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test('requires one-time bootstrap token, hashes password, and issues revocable sessions', async () => {
  const { auth, database } = await createAuth();
  const token = await auth.initialize();
  assert.equal(auth.isConfigured(), false);
  await assert.rejects(auth.setup('wrong', 'correct-horse-battery-staple', '127.0.0.1'), /setup token is invalid/);
  await assert.rejects(auth.setup(token, 'short', '127.0.0.1'), /12-256/);

  const session = await auth.setup(token, 'correct-horse-battery-staple', '127.0.0.1');
  assert.equal(auth.isConfigured(), true);
  assert.equal(auth.authenticate(session.token), true);
  assert.match(database.getPanelSetting('admin_password_hash'), /^scrypt\$/);
  assert.notEqual(database.getPanelSetting('admin_password_hash'), 'correct-horse-battery-staple');
  assert.equal(auth.cookie(session, true).includes('; Secure'), true);
  await assert.rejects(auth.setup(token, 'another-safe-password', '127.0.0.1'), /already been completed/);
  auth.logout(session.token);
  assert.equal(auth.authenticate(session.token), false);
  database.close();
});

test('limits repeated password failures and permits a valid login', async () => {
  const { auth, database } = await createAuth();
  const token = await auth.initialize();
  const session = await auth.setup(token, 'correct-horse-battery-staple', '127.0.0.1');
  auth.logout(session.token);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await assert.rejects(auth.login('incorrect-password', '192.0.2.5'), /Incorrect password/);
  }
  await assert.rejects(auth.login('correct-horse-battery-staple', '192.0.2.5'), /Too many failed attempts/);
  const successfulLogin = await auth.login('correct-horse-battery-staple', '127.0.0.1');
  assert.equal(auth.authenticate(successfulLogin.token), true);
  database.close();
});
