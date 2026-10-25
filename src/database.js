import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export class Database {
  constructor(databasePath) {
    mkdirSync(path.dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        minecraft_version TEXT NOT NULL,
        software TEXT NOT NULL DEFAULT 'vanilla',
        software_version TEXT,
        loader_version TEXT,
        java_path TEXT NOT NULL DEFAULT 'java',
        memory_mb INTEGER NOT NULL DEFAULT 2048,
        port INTEGER NOT NULL,
        directory TEXT NOT NULL UNIQUE,
        installed INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'stopped',
        eula_accepted INTEGER NOT NULL DEFAULT 0,
        process_pid INTEGER,
        required_java_major INTEGER,
        rcon_port INTEGER,
        created_at TEXT NOT NULL,
        last_started_at TEXT,
        last_stopped_at TEXT,
        error TEXT
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        server_id TEXT,
        kind TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE SET NULL
      );
      CREATE TABLE IF NOT EXISTS backups (
        id TEXT PRIMARY KEY,
        server_id TEXT,
        directory TEXT NOT NULL,
        archive_path TEXT,
        archive_sha256 TEXT,
        size_bytes INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE SET NULL
      );
      CREATE TABLE IF NOT EXISTS panel_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS auth_sessions (
        token_hash TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS auth_failures (
        remote TEXT PRIMARY KEY,
        attempts INTEGER NOT NULL DEFAULT 0,
        locked_until TEXT
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        server_id TEXT,
        status TEXT NOT NULL,
        progress INTEGER NOT NULL DEFAULT 0,
        message TEXT NOT NULL DEFAULT '',
        result_json TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE SET NULL
      );
      CREATE TABLE IF NOT EXISTS schedules (
        id TEXT PRIMARY KEY,
        server_id TEXT NOT NULL,
        action TEXT NOT NULL,
        interval_minutes INTEGER NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        next_run_at TEXT NOT NULL,
        last_run_at TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS resource_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        server_id TEXT NOT NULL,
        captured_at TEXT NOT NULL,
        cpu_percent REAL,
        memory_bytes INTEGER,
        disk_bytes INTEGER,
        FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS events_created_at ON events(created_at DESC);
      CREATE INDEX IF NOT EXISTS backups_server_id ON backups(server_id);
      CREATE INDEX IF NOT EXISTS schedules_next_run ON schedules(enabled, next_run_at);
      CREATE INDEX IF NOT EXISTS resource_metrics_server_time ON resource_metrics(server_id, captured_at DESC);
    `);
    const serverColumns = this.db.prepare('PRAGMA table_info(servers)').all().map((column) => column.name);
    if (!serverColumns.includes('process_pid')) {
      this.db.exec('ALTER TABLE servers ADD COLUMN process_pid INTEGER');
    }
    if (!serverColumns.includes('required_java_major')) {
      this.db.exec('ALTER TABLE servers ADD COLUMN required_java_major INTEGER');
    }
    if (!serverColumns.includes('rcon_port')) {
      this.db.exec('ALTER TABLE servers ADD COLUMN rcon_port INTEGER');
    }
    if (!serverColumns.includes('software_version')) {
      this.db.exec('ALTER TABLE servers ADD COLUMN software_version TEXT');
    }
    if (!serverColumns.includes('loader_version')) {
      this.db.exec('ALTER TABLE servers ADD COLUMN loader_version TEXT');
    }
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS servers_rcon_port ON servers(rcon_port) WHERE rcon_port IS NOT NULL');
    const backupDeleteRule = this.db.prepare('PRAGMA foreign_key_list(backups)').all()
      .find((foreignKey) => foreignKey.table === 'servers')?.on_delete;
    if (backupDeleteRule === 'CASCADE') {
      this.db.exec(`
        PRAGMA foreign_keys = OFF;
        BEGIN;
        ALTER TABLE backups RENAME TO backups_legacy;
        CREATE TABLE backups (
          id TEXT PRIMARY KEY,
          server_id TEXT,
          directory TEXT NOT NULL,
          archive_path TEXT,
          archive_sha256 TEXT,
          size_bytes INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE SET NULL
        );
        INSERT INTO backups (id, server_id, directory, size_bytes, created_at)
        SELECT id, server_id, directory, size_bytes, created_at FROM backups_legacy;
        DROP TABLE backups_legacy;
        COMMIT;
        PRAGMA foreign_keys = ON;
        CREATE INDEX IF NOT EXISTS backups_server_id ON backups(server_id);
      `);
    }
    const backupColumns = this.db.prepare('PRAGMA table_info(backups)').all().map((column) => column.name);
    if (!backupColumns.includes('archive_path')) this.db.exec('ALTER TABLE backups ADD COLUMN archive_path TEXT');
    if (!backupColumns.includes('archive_sha256')) this.db.exec('ALTER TABLE backups ADD COLUMN archive_sha256 TEXT');
  }

  listServers() {
    return this.db.prepare('SELECT * FROM servers ORDER BY created_at DESC').all().map(mapServer);
  }

  getServer(id) {
    const row = this.db.prepare('SELECT * FROM servers WHERE id = ?').get(id);
    return row ? mapServer(row) : null;
  }

  insertServer(server) {
    this.db.prepare(`
      INSERT INTO servers
        (id, name, description, minecraft_version, software, software_version, loader_version, java_path, memory_mb, port,
         directory, eula_accepted, created_at, rcon_port)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      server.id, server.name, server.description, server.minecraftVersion, server.software,
      server.softwareVersion ?? null, server.loaderVersion ?? null,
      server.javaPath, server.memoryMb, server.port, server.directory,
      server.eulaAccepted ? 1 : 0, server.createdAt, server.rconPort ?? null
    );
    return this.getServer(server.id);
  }

  updateServer(id, fields) {
    const assignments = Object.keys(fields).map((field) => `${field} = ?`).join(', ');
    this.db.prepare(`UPDATE servers SET ${assignments} WHERE id = ?`).run(...Object.values(fields), id);
    return this.getServer(id);
  }

  deleteServer(id) {
    return this.db.prepare('DELETE FROM servers WHERE id = ?').run(id).changes > 0;
  }

  markServerInstalled(id, message, requiredJavaMajor) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE servers SET installed = 1, error = NULL, required_java_major = ? WHERE id = ?')
        .run(requiredJavaMajor, id);
      this.db.prepare('INSERT INTO events (server_id, kind, message, created_at) VALUES (?, ?, ?, ?)')
        .run(id, 'success', message, new Date().toISOString());
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  addEvent(serverId, kind, message) {
    const createdAt = new Date().toISOString();
    this.db.prepare('INSERT INTO events (server_id, kind, message, created_at) VALUES (?, ?, ?, ?)')
      .run(serverId, kind, message, createdAt);
    return { serverId, kind, message, createdAt };
  }

  listEvents(limit = 50) {
    return this.db.prepare(`
      SELECT events.*, servers.name AS server_name
      FROM events LEFT JOIN servers ON servers.id = events.server_id
      ORDER BY events.id DESC LIMIT ?
    `).all(limit);
  }

  listServerLogs(serverId, limit = 500) {
    return this.db.prepare(`
      SELECT message, kind, created_at
      FROM events
      WHERE server_id = ? AND kind IN ('console', 'error')
      ORDER BY id DESC LIMIT ?
    `).all(serverId, limit).reverse().map((row) => ({
      timestamp: row.created_at,
      source: row.kind === 'error' ? 'stderr' : 'stdout',
      line: row.message
    }));
  }

  addBackup(backup) {
    this.db.prepare(`
      INSERT INTO backups (id, server_id, directory, archive_path, archive_sha256, size_bytes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      backup.id, backup.serverId, backup.directory, backup.archivePath ?? null,
      backup.archiveSha256 ?? null, backup.sizeBytes, backup.createdAt
    );
    return backup;
  }

  listBackups(serverId = null) {
    if (serverId) {
      return this.db.prepare('SELECT * FROM backups WHERE server_id = ? ORDER BY created_at DESC').all(serverId);
    }
    return this.db.prepare('SELECT * FROM backups ORDER BY created_at DESC').all();
  }

  deleteBackup(id) {
    return this.db.prepare('DELETE FROM backups WHERE id = ?').run(id).changes > 0;
  }

  getPanelSetting(key) {
    return this.db.prepare('SELECT value FROM panel_settings WHERE key = ?').get(key)?.value ?? null;
  }

  setPanelSetting(key, value) {
    this.db.prepare('INSERT INTO panel_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  completeAuthSetup(expectedTokenHash, passwordHash) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const setupTokenHash = this.getPanelSetting('setup_token_hash');
      if (this.getPanelSetting('admin_password_hash') || setupTokenHash !== expectedTokenHash) {
        this.db.exec('ROLLBACK');
        return false;
      }
      this.setPanelSetting('admin_password_hash', passwordHash);
      this.setPanelSetting('setup_token_hash', '');
      this.db.exec('COMMIT');
      return true;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  createAuthSession(tokenHash, createdAt, expiresAt) {
    this.db.prepare('INSERT INTO auth_sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)')
      .run(tokenHash, createdAt, expiresAt);
  }

  getAuthSession(tokenHash, now) {
    const session = this.db.prepare('SELECT token_hash, expires_at FROM auth_sessions WHERE token_hash = ? AND expires_at > ?')
      .get(tokenHash, now);
    return session ?? null;
  }

  deleteAuthSession(tokenHash) {
    this.db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(tokenHash);
  }

  pruneAuthSessions(now) {
    this.db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(now);
  }

  getAuthFailure(remote) {
    return this.db.prepare('SELECT attempts, locked_until FROM auth_failures WHERE remote = ?').get(remote) ?? null;
  }

  recordAuthFailure(remote, attempts, lockedUntil) {
    this.db.prepare(`
      INSERT INTO auth_failures (remote, attempts, locked_until) VALUES (?, ?, ?)
      ON CONFLICT(remote) DO UPDATE SET attempts = excluded.attempts, locked_until = excluded.locked_until
    `).run(remote, attempts, lockedUntil);
  }

  clearAuthFailures(remote) {
    this.db.prepare('DELETE FROM auth_failures WHERE remote = ?').run(remote);
  }

  createTask(task) {
    this.db.prepare(`
      INSERT INTO tasks (id, type, server_id, status, progress, message, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(task.id, task.type, task.serverId, 'queued', 0, 'Waiting to start.', task.createdAt, task.createdAt);
    return this.getTask(task.id);
  }

  getTask(id) {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    return row ? mapTask(row) : null;
  }

  listTasks(limit = 100) {
    return this.db.prepare('SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?').all(limit).map(mapTask);
  }

  updateTask(id, fields) {
    const columns = Object.entries(fields).map(([field]) => `${field} = ?`).join(', ');
    if (!columns) return this.getTask(id);
    this.db.prepare(`UPDATE tasks SET ${columns}, updated_at = ? WHERE id = ?`)
      .run(...Object.values(fields), new Date().toISOString(), id);
    return this.getTask(id);
  }

  interruptActiveTasks(message) {
    this.db.prepare(`
      UPDATE tasks SET status = 'failed', error = ?, message = ?, updated_at = ?
      WHERE status IN ('queued', 'running')
    `).run(message, message, new Date().toISOString());
  }

  createSchedule(schedule) {
    this.db.prepare(`
      INSERT INTO schedules (id, server_id, action, interval_minutes, next_run_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(schedule.id, schedule.serverId, schedule.action, schedule.intervalMinutes, schedule.nextRunAt, schedule.createdAt);
    return this.getSchedule(schedule.id);
  }

  getSchedule(id) {
    const row = this.db.prepare('SELECT * FROM schedules WHERE id = ?').get(id);
    return row ? mapSchedule(row) : null;
  }

  listSchedules(serverId = null) {
    const rows = serverId
      ? this.db.prepare('SELECT * FROM schedules WHERE server_id = ? ORDER BY created_at DESC').all(serverId)
      : this.db.prepare('SELECT * FROM schedules ORDER BY created_at DESC').all();
    return rows.map(mapSchedule);
  }

  listDueSchedules(now) {
    return this.db.prepare('SELECT * FROM schedules WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at').all(now).map(mapSchedule);
  }

  advanceSchedule(id, runAt, nextRunAt) {
    this.db.prepare('UPDATE schedules SET last_run_at = ?, next_run_at = ? WHERE id = ?')
      .run(runAt, nextRunAt, id);
  }

  deleteSchedule(id) {
    return this.db.prepare('DELETE FROM schedules WHERE id = ?').run(id).changes > 0;
  }

  addMetrics(metrics) {
    this.db.prepare(`
      INSERT INTO resource_metrics (server_id, captured_at, cpu_percent, memory_bytes, disk_bytes)
      VALUES (?, ?, ?, ?, ?)
    `).run(metrics.serverId, metrics.capturedAt, metrics.cpuPercent, metrics.memoryBytes, metrics.diskBytes);
  }

  listMetrics(serverId, limit = 1440) {
    return this.db.prepare(`
      SELECT captured_at AS capturedAt, cpu_percent AS cpuPercent,
        memory_bytes AS memoryBytes, disk_bytes AS diskBytes
      FROM resource_metrics WHERE server_id = ?
      ORDER BY captured_at DESC LIMIT ?
    `).all(serverId, limit).reverse();
  }

  pruneMetrics(before) {
    this.db.prepare('DELETE FROM resource_metrics WHERE captured_at < ?').run(before);
  }

  close() {
    this.db.close();
  }
}

function mapServer(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    minecraftVersion: row.minecraft_version,
    software: row.software,
    softwareVersion: row.software_version,
    loaderVersion: row.loader_version,
    javaPath: row.java_path,
    memoryMb: row.memory_mb,
    port: row.port,
    directory: row.directory,
    installed: Boolean(row.installed),
    status: row.status,
    eulaAccepted: Boolean(row.eula_accepted),
    processPid: row.process_pid,
    requiredJavaMajor: row.required_java_major,
    rconPort: row.rcon_port,
    createdAt: row.created_at,
    lastStartedAt: row.last_started_at,
    lastStoppedAt: row.last_stopped_at,
    error: row.error
  };
}

function mapTask(row) {
  return {
    id: row.id,
    type: row.type,
    serverId: row.server_id,
    status: row.status,
    progress: row.progress,
    message: row.message,
    result: row.result_json ? JSON.parse(row.result_json) : null,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapSchedule(row) {
  return {
    id: row.id,
    serverId: row.server_id,
    action: row.action,
    intervalMinutes: row.interval_minutes,
    enabled: Boolean(row.enabled),
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    createdAt: row.created_at
  };
}
