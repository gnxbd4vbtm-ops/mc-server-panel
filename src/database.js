import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";
import { dataDir } from "./config.js";

fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
export const db = new DatabaseSync(path.join(dataDir, "panel.sqlite"));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS servers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    version TEXT NOT NULL,
    software TEXT NOT NULL CHECK (software IN ('vanilla', 'paper')),
    port INTEGER NOT NULL UNIQUE,
    bind_address TEXT NOT NULL DEFAULT '0.0.0.0',
    max_players INTEGER NOT NULL DEFAULT 20,
    min_memory_mb INTEGER NOT NULL DEFAULT 1024,
    max_memory_mb INTEGER NOT NULL DEFAULT 2048,
    java_path TEXT NOT NULL DEFAULT 'java',
    eula_accepted INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS backups (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS world_backups (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    world_name TEXT NOT NULL,
    filename TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    status TEXT NOT NULL,
    progress INTEGER NOT NULL DEFAULT 0,
    message TEXT NOT NULL DEFAULT '',
    error TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS crash_history (
    id INTEGER PRIMARY KEY,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    exit_code TEXT,
    occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS metrics_history (
    id INTEGER PRIMARY KEY,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    cpu_percent REAL,
    memory_mb INTEGER,
    disk_bytes INTEGER,
    players INTEGER,
    tps_1m REAL,
    mspt REAL,
    sampled_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS backup_schedules (
    server_id TEXT PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
    interval_hours INTEGER NOT NULL,
    retention_count INTEGER NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    next_run_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS project_installs (
    id INTEGER PRIMARY KEY,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    project_type TEXT NOT NULL CHECK (project_type IN ('mod', 'plugin')),
    project_id TEXT NOT NULL,
    version_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    project_title TEXT NOT NULL,
    installed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(server_id, project_type, project_id)
  );
  CREATE TABLE IF NOT EXISTS project_install_history (
    id INTEGER PRIMARY KEY,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    project_type TEXT NOT NULL CHECK (project_type IN ('mod', 'plugin')),
    project_id TEXT NOT NULL,
    version_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    project_title TEXT NOT NULL,
    backup_filename TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

const metricColumns = new Set(db.prepare("PRAGMA table_info(metrics_history)").all().map((column) => column.name));
if (!metricColumns.has("tps_1m")) db.exec("ALTER TABLE metrics_history ADD COLUMN tps_1m REAL");
if (!metricColumns.has("mspt")) db.exec("ALTER TABLE metrics_history ADD COLUMN mspt REAL");

const serverColumns = new Set(db.prepare("PRAGMA table_info(servers)").all().map((column) => column.name));
if (!serverColumns.has("loader")) {
  db.exec("ALTER TABLE servers ADD COLUMN loader TEXT NOT NULL DEFAULT 'vanilla'");
}
if (!serverColumns.has("auto_restart")) {
  db.exec("ALTER TABLE servers ADD COLUMN auto_restart INTEGER NOT NULL DEFAULT 0");
}
if (!serverColumns.has("restart_count")) {
  db.exec("ALTER TABLE servers ADD COLUMN restart_count INTEGER NOT NULL DEFAULT 0");
}
if (!serverColumns.has("last_started_at")) {
  db.exec("ALTER TABLE servers ADD COLUMN last_started_at TEXT");
}
if (!serverColumns.has("online_mode")) {
  db.exec("ALTER TABLE servers ADD COLUMN online_mode INTEGER NOT NULL DEFAULT 1");
}
if (!serverColumns.has("view_distance")) {
  db.exec("ALTER TABLE servers ADD COLUMN view_distance INTEGER NOT NULL DEFAULT 10");
}
if (!serverColumns.has("simulation_distance")) {
  db.exec("ALTER TABLE servers ADD COLUMN simulation_distance INTEGER NOT NULL DEFAULT 10");
}
if (!serverColumns.has("pid")) {
  db.exec("ALTER TABLE servers ADD COLUMN pid INTEGER");
}
if (!serverColumns.has("process_start_ticks")) {
  db.exec("ALTER TABLE servers ADD COLUMN process_start_ticks TEXT");
}
if (!serverColumns.has("process_boot_id")) {
  db.exec("ALTER TABLE servers ADD COLUMN process_boot_id TEXT");
}
if (!serverColumns.has("crossplay")) {
  db.exec("ALTER TABLE servers ADD COLUMN crossplay INTEGER NOT NULL DEFAULT 0");
}
if (!serverColumns.has("bedrock_port")) {
  db.exec("ALTER TABLE servers ADD COLUMN bedrock_port INTEGER");
}
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS servers_bedrock_port_unique ON servers(bedrock_port) WHERE bedrock_port IS NOT NULL");
db.exec(`
  UPDATE servers SET loader = software WHERE loader = 'vanilla' AND software != 'vanilla';
  UPDATE jobs SET status = 'interrupted', message = 'Panel restarted before operation completed',
    updated_at = CURRENT_TIMESTAMP WHERE status IN ('queued', 'running');
`);
