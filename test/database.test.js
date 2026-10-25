import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Database } from '../src/database.js';

test('migrates earlier database schema and preserves backups when a server is deleted', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'byte-panel-migration-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, 'legacy.sqlite');
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    CREATE TABLE servers (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      minecraft_version TEXT NOT NULL, software TEXT NOT NULL DEFAULT 'vanilla',
      java_path TEXT NOT NULL DEFAULT 'java', memory_mb INTEGER NOT NULL DEFAULT 2048,
      port INTEGER NOT NULL, directory TEXT NOT NULL UNIQUE, installed INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'stopped', eula_accepted INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, last_started_at TEXT, last_stopped_at TEXT, error TEXT
    );
    CREATE TABLE backups (
      id TEXT PRIMARY KEY, server_id TEXT NOT NULL, directory TEXT NOT NULL,
      size_bytes INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
    );
    INSERT INTO servers (id, name, minecraft_version, port, directory, created_at)
      VALUES ('legacy', 'Legacy server', '1.21.8', 25565, '/tmp/legacy', '2026-01-01T00:00:00.000Z');
    INSERT INTO backups (id, server_id, directory, size_bytes, created_at)
      VALUES ('backup-legacy', 'legacy', '/tmp/legacy-backup', 10, '2026-01-01T00:00:00.000Z');
  `);
  legacy.close();

  const database = new Database(databasePath);
  assert.equal(database.getServer('legacy').processPid, null);
  assert.equal(database.deleteServer('legacy'), true);
  const backups = database.listBackups();
  assert.equal(backups.length, 1);
  assert.equal(backups[0].server_id, null);
  database.close();
});
