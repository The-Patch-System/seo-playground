// Patch fork: tables for re-scanning finished Geo-grid runs in place (see grid-rescan.ts). They are
// separate tables, not columns on grid_searches, because saveGridSearch and the import use
// INSERT OR REPLACE (which would wipe extra columns) and getGridMonitorsLatest selects *.
import type Database from 'better-sqlite3';

/** Per project database: re-scan state, attempts, the paid-submission ledger and report-safety flags. */
export function initProjectRescanSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS grid_rescans (
      run_id TEXT PRIMARY KEY,
      series_id TEXT NOT NULL,
      manifest_id TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL,
      hold_reason TEXT,
      attempt INTEGER NOT NULL DEFAULT 1,
      queued_at INTEGER NOT NULL,
      started_at INTEGER,
      finished_at INTEGER,
      swapped_at INTEGER,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS grid_rescan_attempts (
      run_id TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      state TEXT NOT NULL,
      hold_reason TEXT,
      source_hash TEXT NOT NULL,
      config_hash TEXT NOT NULL,
      task_points TEXT NOT NULL DEFAULT '[]',
      results TEXT NOT NULL DEFAULT '[]',
      results_before TEXT,
      swapped_hash TEXT,
      cost REAL NOT NULL DEFAULT 0,
      accepted_searches INTEGER NOT NULL DEFAULT 0,
      rejected_submissions INTEGER NOT NULL DEFAULT 0,
      attempt_started_at INTEGER NOT NULL,
      finished_at INTEGER,
      PRIMARY KEY (run_id, attempt)
    );
    CREATE TABLE IF NOT EXISTS grid_rescan_submissions (
      tag TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      row INTEGER NOT NULL,
      col INTEGER NOT NULL,
      seq INTEGER NOT NULL,
      state TEXT NOT NULL,
      task_id TEXT,
      reserved REAL NOT NULL DEFAULT 0,
      cost REAL NOT NULL DEFAULT 0,
      submitted_at INTEGER NOT NULL,
      resolved_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_grid_rescan_submissions_run ON grid_rescan_submissions(run_id, attempt);
    CREATE TABLE IF NOT EXISTS grid_run_safety (
      run_id TEXT PRIMARY KEY,
      report_safe INTEGER NOT NULL,
      reason TEXT,
      evidence TEXT,
      updated_at INTEGER NOT NULL
    );
  `);
}

/** Control database: manifests and exclusions span projects; the spend budget is shared by all re-scans. */
export function initControlRescanSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS grid_rescan_manifests (
      manifest_id TEXT PRIMARY KEY,
      label TEXT NOT NULL DEFAULT '',
      date TEXT,
      selector TEXT NOT NULL,
      runs TEXT NOT NULL,
      excluded TEXT NOT NULL DEFAULT '[]',
      estimated_cost REAL NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      started_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS grid_rescan_exclusions (
      series_id TEXT PRIMARY KEY,
      reason TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS grid_rescan_budget (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      limit_usd REAL NOT NULL,
      reserved REAL NOT NULL DEFAULT 0,
      spent REAL NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
  `);
}
