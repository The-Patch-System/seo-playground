// Patch fork: re-scans finished Geo-grid runs IN PLACE (temporary; built for the Nov 15 2026 wrong-city
// results). A re-scan posts new tasks at the run's own point coordinates and collects them on the side;
// the run stays `done` with its current points until one transaction swaps the new points in (the old
// ones are kept for undo). The run's date (ts) never changes; `rescanned_at` labels it.
//
// Safety rules (PATCH.md has the rollout procedure):
// - preview saves an immutable manifest and changes nothing else; start runs exactly that manifest.
// - Every paid POST is written to grid_rescan_submissions before it is sent (intent) and resolved after.
//   An intent with no outcome is never re-posted automatically; the run is held `post_unknown`.
// - One spend budget (grid_rescan_budget) is reserved before every POST.
// - A run is swapped only if every point is present once, no wrong-city point is left, at most 2 points
//   failed for other reasons, and the run's points and settings did not change since the attempt began.
//   Otherwise it is held with a reason and flagged not safe to report.
import { createHash, randomUUID } from 'crypto';
import {
  getControlDb, getDbForProject, getProjects, type GridPoint, type GridTaskPoint, type Project,
} from '@/lib/db';
import { postGridTaskChunk, type GridTaskRequest } from '@/app/dashboard/local-finder/grid-api';
import {
  checkGridTasks, stepGridTasks, type RepostOutcome,
} from '@/lib/grid-progress';

export const RESCAN_MAX_RUNS_PER_MANIFEST = 25;
/** Hold a run whose attempt is still collecting this long after it started. */
export const RESCAN_ATTEMPT_DEADLINE_MS = 2 * 60 * 60_000;
/** A submission intent with no recorded outcome after this long is treated as unknown. */
export const RESCAN_INTENT_STALE_MS = 10 * 60_000;
/** Points that may fail for reasons other than wrong-city before the run is held. */
export const RESCAN_MAX_OTHER_FAILED = 2;

export function rescanTaskPrice(): number {
  const value = Number.parseFloat(process.env.GEO_GRID_RESCAN_TASK_PRICE_USD ?? '');
  return Number.isFinite(value) && value > 0 ? value : 0.0018;
}

function defaultBudgetUsd(): number {
  const value = Number.parseFloat(process.env.GEO_GRID_RESCAN_BUDGET_USD ?? '');
  return Number.isFinite(value) && value >= 0 ? value : 60;
}

export function maxStartsPerPass(): number {
  return Math.max(1, Number.parseInt(process.env.GEO_GRID_RESCAN_MAX_STARTS_PER_PASS ?? '10', 10) || 10);
}

export type RescanState = 'queued' | 'posting' | 'scanning' | 'swapped' | 'held' | 'cancelled' | 'undone' | 'orphaned';
export type HoldReason =
  | 'wrong_city_persistent' | 'too_many_failed' | 'incomplete' | 'post_unknown' | 'budget_exhausted'
  | 'timeout' | 'source_changed' | 'bad_source';

const ACTIVE_STATES: RescanState[] = ['queued', 'posting', 'scanning'];

interface RescanRow {
  run_id: string; series_id: string; manifest_id: string; label: string; state: RescanState; hold_reason: string | null;
  attempt: number; queued_at: number; started_at: number | null; finished_at: number | null; swapped_at: number | null; updated_at: number;
}

interface AttemptRow {
  run_id: string; attempt: number; state: string; hold_reason: string | null; source_hash: string; config_hash: string;
  task_points: string; results: string; results_before: string | null; swapped_hash: string | null; cost: number;
  accepted_searches: number; rejected_submissions: number; attempt_started_at: number; finished_at: number | null;
}

interface RunRow {
  id: string; ts: number; series_id: string; keyword: string; target: string; center: string; grid_size: number;
  spacing_km: number; language: string; status: string; queue_mode: string; results: string | null;
}

export interface ManifestRun {
  project_id: string; project_name: string; run_id: string; monitor_id: string; keyword: string; target: string;
  run_at: string; points: number;
}

export interface Manifest {
  manifest_id: string; label: string; date: string | null; selector: 'ids' | 'all' | 'none';
  runs: ManifestRun[]; excluded: ManifestRun[]; estimated_cost: number; created_at: number; started_at: number | null;
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function configHash(run: Pick<RunRow, 'keyword' | 'target' | 'center' | 'grid_size' | 'spacing_km' | 'language'>): string {
  return sha256(JSON.stringify([run.keyword, run.target, run.center, run.grid_size, run.spacing_km, run.language]));
}

/** The calendar date of `ts` in `timeZone` (YYYY-MM-DD), falling back to UTC for an unknown zone. */
export function localDate(ts: number, timeZone: string | null | undefined): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timeZone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts));
  } catch {
    return new Date(ts).toISOString().slice(0, 10);
  }
}

function pointCoords(run: Pick<RunRow, 'center' | 'grid_size' | 'spacing_km'>, point: GridPoint): { lat: number; lng: number } {
  if (point.lat != null && point.lng != null) return { lat: point.lat, lng: point.lng };
  const [cLat, cLng] = run.center.split(',').map(Number);
  const half = Math.floor(run.grid_size / 2);
  const latDeg = run.spacing_km / 111.32;
  const lngDeg = run.spacing_km / (111.32 * Math.cos(cLat * Math.PI / 180));
  return { lat: cLat + (half - point.row) * latDeg, lng: cLng + (point.col - half) * lngDeg };
}

function parsePoints(json: string | null): GridPoint[] {
  try { return JSON.parse(json ?? '[]') as GridPoint[]; } catch { return []; }
}

/** Exactly one point per (row, col) inside the grid, and grid_size² of them. */
export function isCompleteGrid(points: GridPoint[], gridSize: number): boolean {
  if (points.length !== gridSize * gridSize) return false;
  const seen = new Set<string>();
  for (const p of points) {
    if (p.row < 0 || p.col < 0 || p.row >= gridSize || p.col >= gridSize) return false;
    const key = `${p.row}:${p.col}`;
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

// --- Safety flags ---------------------------------------------------------------------------------

export interface RunSafety { report_safe: boolean; reason: string | null }

function setSafety(projectId: string, runId: string, safe: boolean, reason: string | null, evidence?: unknown): void {
  getDbForProject(projectId).prepare(`INSERT INTO grid_run_safety (run_id, report_safe, reason, evidence, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(run_id) DO UPDATE SET report_safe = excluded.report_safe, reason = excluded.reason, evidence = excluded.evidence, updated_at = excluded.updated_at`)
    .run(runId, safe ? 1 : 0, reason, evidence === undefined ? null : JSON.stringify(evidence), Date.now());
}

/**
 * Patch fork: whether a run's numbers are safe to report. A re-scan's flag (grid_run_safety) wins;
 * otherwise it's computed from the points: any wrong-city failed point, more than 2 failed points,
 * or a truncated point where the target's rank is unknown makes a run unsafe.
 */
export function runSafety(projectId: string, runId: string, points: GridPoint[]): RunSafety {
  const row = getDbForProject(projectId).prepare('SELECT report_safe, reason FROM grid_run_safety WHERE run_id = ?')
    .get(runId) as { report_safe: number; reason: string | null } | undefined;
  if (row) return { report_safe: row.report_safe === 1, reason: row.reason };
  return computedSafety(points);
}

/** The point-based part of runSafety, also applied to a re-scan's new points when they swap in. */
export function computedSafety(points: GridPoint[]): RunSafety {
  if (points.some((p) => p.failed && p.failed_reason === 'wrong_city')) return { report_safe: false, reason: 'wrong_city_persistent' };
  if (points.filter((p) => p.failed).length > RESCAN_MAX_OTHER_FAILED) return { report_safe: false, reason: 'too_many_failed' };
  if (points.some((p) => p.rank_unresolved)) return { report_safe: false, reason: 'rank_unresolved' };
  return { report_safe: true, reason: null };
}

export function rescannedAt(projectId: string, runId: string): string | null {
  const row = getDbForProject(projectId).prepare("SELECT swapped_at FROM grid_rescans WHERE run_id = ? AND state = 'swapped'")
    .get(runId) as { swapped_at: number | null } | undefined;
  return row?.swapped_at ? new Date(row.swapped_at).toISOString() : null;
}

// --- Budget ---------------------------------------------------------------------------------------

function ensureBudget(): void {
  getControlDb().prepare('INSERT OR IGNORE INTO grid_rescan_budget (id, limit_usd, reserved, spent, updated_at) VALUES (1, ?, 0, 0, ?)')
    .run(defaultBudgetUsd(), Date.now());
}

export function getBudget(): { limit_usd: number; reserved: number; spent: number; available: number } {
  ensureBudget();
  const row = getControlDb().prepare('SELECT limit_usd, reserved, spent FROM grid_rescan_budget WHERE id = 1').get() as { limit_usd: number; reserved: number; spent: number };
  const round = (n: number) => Math.round(n * 10000) / 10000;
  return { limit_usd: round(row.limit_usd), reserved: round(row.reserved), spent: round(row.spent), available: round(row.limit_usd - row.reserved - row.spent) };
}

export function setBudgetLimit(limitUsd: number): void {
  ensureBudget();
  getControlDb().prepare('UPDATE grid_rescan_budget SET limit_usd = ?, updated_at = ? WHERE id = 1').run(limitUsd, Date.now());
}

function reserveBudget(amount: number): boolean {
  ensureBudget();
  return getControlDb().prepare(`UPDATE grid_rescan_budget SET reserved = reserved + ?, updated_at = ?
    WHERE id = 1 AND spent + reserved + ? <= limit_usd + 1e-9`).run(amount, Date.now(), amount).changes === 1;
}

function settleBudget(reserved: number, spent: number): void {
  getControlDb().prepare('UPDATE grid_rescan_budget SET reserved = MAX(0, reserved - ?), spent = spent + ?, updated_at = ? WHERE id = 1')
    .run(reserved, spent, Date.now());
}

// --- Selection and manifests -----------------------------------------------------------------------

export interface RescanSelector {
  date?: string;
  run_ids?: string[];
  monitor_ids?: string[];
  exclude_monitor_ids?: string[];
  all?: boolean;
  label?: string;
}

export function validateSelector(selector: RescanSelector): string | null {
  if (selector.date && !/^\d{4}-\d{2}-\d{2}$/.test(selector.date)) return 'date must be YYYY-MM-DD.';
  for (const key of ['run_ids', 'monitor_ids', 'exclude_monitor_ids'] as const) {
    const value = selector[key];
    if (value !== undefined && (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || !v))) return `${key} must be a list of ids.`;
  }
  if (selector.all !== undefined && typeof selector.all !== 'boolean') return 'all must be true or false.';
  const hasIds = Boolean(selector.run_ids?.length || selector.monitor_ids?.length);
  if (selector.all && hasIds) return 'Use either all: true or run_ids/monitor_ids, not both.';
  if (!selector.date && !selector.run_ids?.length) return 'A date or run_ids is required.';
  const excluded = new Set(selector.exclude_monitor_ids ?? []);
  if (selector.monitor_ids?.some((id) => excluded.has(id))) return 'A monitor is both selected and excluded.';
  return null;
}

function persistentExclusions(): Map<string, string> {
  const rows = getControlDb().prepare('SELECT series_id, reason FROM grid_rescan_exclusions').all() as Array<{ series_id: string; reason: string }>;
  return new Map(rows.map((r) => [r.series_id, r.reason]));
}

export function setExclusions(monitorIds: string[], reason: string, exclude: boolean): void {
  const db = getControlDb();
  db.transaction(() => {
    for (const id of monitorIds) {
      if (exclude) db.prepare('INSERT OR REPLACE INTO grid_rescan_exclusions (series_id, reason, created_at) VALUES (?, ?, ?)').run(id, reason, Date.now());
      else db.prepare('DELETE FROM grid_rescan_exclusions WHERE series_id = ?').run(id);
    }
  })();
}

export function listExclusions(): Array<{ monitor_id: string; reason: string }> {
  return [...persistentExclusions()].map(([monitor_id, reason]) => ({ monitor_id, reason }));
}

function manifestRun(project: Project, run: RunRow): ManifestRun {
  return {
    project_id: project.id, project_name: project.name, run_id: run.id, monitor_id: run.series_id, keyword: run.keyword,
    target: run.target, run_at: new Date(run.ts).toISOString(), points: run.grid_size * run.grid_size,
  };
}

/** Runs the selector matches, split into the ones to re-scan, the excluded ones and the ones skipped (with why). */
export function resolveSelection(selector: RescanSelector) {
  const runIds = selector.run_ids?.length ? new Set(selector.run_ids) : null;
  const monitorIds = selector.monitor_ids?.length ? new Set(selector.monitor_ids) : null;
  const exclusions = persistentExclusions();
  for (const id of selector.exclude_monitor_ids ?? []) if (!exclusions.has(id)) exclusions.set(id, 'excluded in this request');
  const selected: ManifestRun[] = [];
  const excluded: Array<ManifestRun & { reason: string }> = [];
  const skipped: Array<ManifestRun & { reason: string }> = [];
  for (const project of getProjects()) {
    const db = getDbForProject(project.id);
    let rows: RunRow[];
    if (runIds) {
      const ids = [...runIds];
      rows = db.prepare(`SELECT id, ts, series_id, keyword, target, center, grid_size, spacing_km, language, status, queue_mode, NULL AS results
        FROM grid_searches WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids) as RunRow[];
    } else {
      const day = Date.parse(`${selector.date}T00:00:00Z`);
      rows = db.prepare(`SELECT id, ts, series_id, keyword, target, center, grid_size, spacing_km, language, status, queue_mode, NULL AS results
        FROM grid_searches WHERE ts >= ? AND ts < ?`).all(day - 86_400_000, day + 2 * 86_400_000) as RunRow[];
    }
    const zones = new Map((db.prepare('SELECT series_id, time_zone FROM grid_schedules').all() as Array<{ series_id: string; time_zone: string }>)
      .map((r) => [r.series_id, r.time_zone]));
    for (const run of rows) {
      if (selector.date && localDate(run.ts, zones.get(run.series_id)) !== selector.date) continue;
      if (monitorIds && !monitorIds.has(run.series_id)) continue;
      const item = manifestRun(project, run);
      if (run.status !== 'done') { skipped.push({ ...item, reason: `run is ${run.status}` }); continue; }
      if (run.id.startsWith('import-')) { skipped.push({ ...item, reason: 'imported run' }); continue; }
      const exclusion = exclusions.get(run.series_id);
      if (exclusion !== undefined) { excluded.push({ ...item, reason: exclusion || 'excluded' }); continue; }
      const rescan = db.prepare('SELECT state FROM grid_rescans WHERE run_id = ?').get(run.id) as { state: RescanState } | undefined;
      if (rescan && (rescan.state === 'swapped' || ACTIVE_STATES.includes(rescan.state))) {
        skipped.push({ ...item, reason: `already ${rescan.state}` });
        continue;
      }
      if (rescan) { skipped.push({ ...item, reason: `${rescan.state}: use action "retry"` }); continue; }
      selected.push(item);
    }
  }
  const byTime = (a: ManifestRun, b: ManifestRun) => a.run_at.localeCompare(b.run_at) || a.run_id.localeCompare(b.run_id);
  return { selected: selected.sort(byTime), excluded: excluded.sort(byTime), skipped: skipped.sort(byTime) };
}

/** Saves an immutable manifest of what `start` would run. Changes nothing else. */
export function previewRescan(selector: RescanSelector) {
  const { selected, excluded, skipped } = resolveSelection(selector);
  const selectorKind: Manifest['selector'] = selector.all ? 'all' : (selector.run_ids?.length || selector.monitor_ids?.length) ? 'ids' : 'none';
  const points = selected.reduce((s, r) => s + r.points, 0);
  const estimated = Math.round(points * rescanTaskPrice() * 10000) / 10000;
  const manifest: Manifest = {
    manifest_id: randomUUID(), label: selector.label?.trim() || '', date: selector.date ?? null, selector: selectorKind,
    runs: selected, excluded, estimated_cost: estimated, created_at: Date.now(), started_at: null,
  };
  getControlDb().prepare(`INSERT INTO grid_rescan_manifests (manifest_id, label, date, selector, runs, excluded, estimated_cost, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(manifest.manifest_id, manifest.label, manifest.date, manifest.selector,
    JSON.stringify(manifest.runs), JSON.stringify(manifest.excluded), manifest.estimated_cost, manifest.created_at);
  const startable = selectorKind === 'all' || (selectorKind === 'ids' && selected.length <= RESCAN_MAX_RUNS_PER_MANIFEST);
  return {
    manifest_id: manifest.manifest_id, label: manifest.label, date: manifest.date, startable,
    ...(startable ? {} : { not_startable_reason: selectorKind === 'none'
      ? 'Name run_ids or monitor_ids (max 25), or pass all: true.'
      : `More than ${RESCAN_MAX_RUNS_PER_MANIFEST} runs; split the selection or pass all: true.` }),
    runs: selected.length, points, estimated_cost: estimated, price_per_task: rescanTaskPrice(), budget: getBudget(),
    selected, excluded, skipped,
  };
}

function loadManifest(manifestId: string): Manifest | null {
  const row = getControlDb().prepare('SELECT * FROM grid_rescan_manifests WHERE manifest_id = ?').get(manifestId) as
    (Omit<Manifest, 'runs' | 'excluded'> & { runs: string; excluded: string }) | undefined;
  if (!row) return null;
  return { ...row, runs: JSON.parse(row.runs) as ManifestRun[], excluded: JSON.parse(row.excluded) as ManifestRun[] };
}

/** Queues exactly the manifest's runs. Runs already queued, scanning or swapped are left alone. */
export function startRescan(manifestId: string): { queued: string[]; skipped: Array<{ run_id: string; reason: string }> } | { error: string } {
  const manifest = loadManifest(manifestId);
  if (!manifest) return { error: 'Manifest not found. Run preview first.' };
  if (manifest.selector === 'none') return { error: 'This manifest has no run_ids/monitor_ids and was not created with all: true.' };
  if (manifest.selector === 'ids' && manifest.runs.length > RESCAN_MAX_RUNS_PER_MANIFEST) {
    return { error: `This manifest has ${manifest.runs.length} runs; the limit without all: true is ${RESCAN_MAX_RUNS_PER_MANIFEST}.` };
  }
  const queued: string[] = [];
  const skipped: Array<{ run_id: string; reason: string }> = [];
  const now = Date.now();
  for (const run of manifest.runs) {
    const db = getDbForProject(run.project_id);
    const ok = db.transaction(() => {
      const existing = db.prepare('SELECT state FROM grid_rescans WHERE run_id = ?').get(run.run_id) as { state: RescanState } | undefined;
      if (existing) return `already ${existing.state}`;
      const exists = db.prepare("SELECT 1 FROM grid_searches WHERE id = ? AND status = 'done'").get(run.run_id);
      if (!exists) return 'run no longer exists';
      db.prepare(`INSERT INTO grid_rescans (run_id, series_id, manifest_id, label, state, attempt, queued_at, updated_at)
        VALUES (?, ?, ?, ?, 'queued', 1, ?, ?)`).run(run.run_id, run.monitor_id, manifest.manifest_id, manifest.label, now, now);
      return null;
    })();
    if (ok) { skipped.push({ run_id: run.run_id, reason: ok }); continue; }
    // The old points can't be re-checked from the database (descriptions aren't stored), so a run
    // is not safe to report until its re-scan swaps.
    setSafety(run.project_id, run.run_id, false, 'pending_rescan');
    queued.push(run.run_id);
  }
  // Excluded runs on the re-scanned date keep their old points: flag them too.
  for (const run of manifest.excluded) setSafety(run.project_id, run.run_id, false, 'excluded_from_rescan');
  getControlDb().prepare('UPDATE grid_rescan_manifests SET started_at = COALESCE(started_at, ?) WHERE manifest_id = ?').run(now, manifestId);
  return { queued, skipped };
}

function findRescan(runId: string): { project: Project; row: RescanRow } | null {
  for (const project of getProjects()) {
    const row = getDbForProject(project.id).prepare('SELECT * FROM grid_rescans WHERE run_id = ?').get(runId) as RescanRow | undefined;
    if (row) return { project, row };
  }
  return null;
}

function setState(projectId: string, runId: string, from: RescanState[], attempt: number, to: RescanState, extra: { hold_reason?: string | null; finished?: boolean; swapped?: boolean; started?: boolean } = {}): boolean {
  const now = Date.now();
  const stamps = [
    extra.finished ? 'finished_at' : null, extra.swapped ? 'swapped_at' : null, extra.started ? 'started_at' : null,
  ].filter(Boolean).map((column) => `, ${column} = ${now}`).join('');
  return getDbForProject(projectId).prepare(`UPDATE grid_rescans SET state = ?, hold_reason = ?, updated_at = ?${stamps}
    WHERE run_id = ? AND attempt = ? AND state IN (${from.map(() => '?').join(',')})`)
    .run(to, extra.hold_reason ?? null, now, runId, attempt, ...from).changes === 1;
}

function setAttemptState(projectId: string, runId: string, attempt: number, state: string, holdReason: string | null = null): void {
  getDbForProject(projectId).prepare('UPDATE grid_rescan_attempts SET state = ?, hold_reason = ?, finished_at = COALESCE(finished_at, ?) WHERE run_id = ? AND attempt = ?')
    .run(state, holdReason, Date.now(), runId, attempt);
}

function hold(projectId: string, runId: string, attempt: number, reason: HoldReason, from: RescanState[] = ['posting', 'scanning'], evidence?: unknown): boolean {
  if (!setState(projectId, runId, from, attempt, 'held', { hold_reason: reason, finished: true })) return false;
  setAttemptState(projectId, runId, attempt, 'held', reason);
  setSafety(projectId, runId, false, reason, evidence);
  return true;
}

export type RescanAction = 'cancel' | 'undo' | 'retry';

/** cancel: queued/scanning -> cancelled. undo: swapped -> undone (old points restored). retry: held/cancelled/undone -> queued. */
export function applyRescanAction(action: RescanAction, runIds: string[]): Array<{ run_id: string; ok: boolean; state?: RescanState; error?: string }> {
  return runIds.map((runId) => {
    const found = findRescan(runId);
    if (!found) return { run_id: runId, ok: false, error: 'No re-scan for this run.' };
    const { project, row } = found;
    const db = getDbForProject(project.id);
    if (action === 'cancel') {
      if (!ACTIVE_STATES.includes(row.state)) return { run_id: runId, ok: false, state: row.state, error: `Cannot cancel a ${row.state} re-scan.` };
      if (!setState(project.id, runId, ACTIVE_STATES, row.attempt, 'cancelled', { finished: true })) return { run_id: runId, ok: false, error: 'State changed; try again.' };
      setAttemptState(project.id, runId, row.attempt, 'cancelled');
      setSafety(project.id, runId, false, 'pending_rescan');
      return { run_id: runId, ok: true, state: 'cancelled' };
    }
    if (action === 'retry') {
      if (!['held', 'cancelled', 'undone'].includes(row.state)) {
        return { run_id: runId, ok: false, state: row.state, error: `Cannot retry a ${row.state} re-scan.` };
      }
      const changed = db.prepare(`UPDATE grid_rescans SET state = 'queued', hold_reason = NULL, attempt = attempt + 1, queued_at = ?, started_at = NULL,
        finished_at = NULL, updated_at = ? WHERE run_id = ? AND attempt = ? AND state = ?`).run(Date.now(), Date.now(), runId, row.attempt, row.state).changes === 1;
      return changed ? { run_id: runId, ok: true, state: 'queued' } : { run_id: runId, ok: false, error: 'State changed; try again.' };
    }
    // undo
    if (row.state !== 'swapped') return { run_id: runId, ok: false, state: row.state, error: `Cannot undo a ${row.state} re-scan.` };
    const result = db.transaction(() => {
      const attempt = db.prepare('SELECT results_before, swapped_hash FROM grid_rescan_attempts WHERE run_id = ? AND attempt = ?')
        .get(runId, row.attempt) as { results_before: string | null; swapped_hash: string | null } | undefined;
      const run = db.prepare('SELECT results FROM grid_searches WHERE id = ?').get(runId) as { results: string } | undefined;
      if (!attempt?.results_before || !run) return 'The run or its original points are gone.';
      if (sha256(run.results) !== attempt.swapped_hash) return 'The run changed after the swap; refusing to overwrite it.';
      db.prepare('UPDATE grid_searches SET results = ? WHERE id = ?').run(attempt.results_before, runId);
      db.prepare("UPDATE grid_rescans SET state = 'undone', updated_at = ? WHERE run_id = ? AND attempt = ? AND state = 'swapped'").run(Date.now(), runId, row.attempt);
      db.prepare("UPDATE grid_rescan_attempts SET state = 'undone' WHERE run_id = ? AND attempt = ?").run(runId, row.attempt);
      return null;
    })();
    if (result) return { run_id: runId, ok: false, state: row.state, error: result };
    setSafety(project.id, runId, false, 'original_restored');
    return { run_id: runId, ok: true, state: 'undone' };
  });
}

// --- Paid submissions (ledger + budget) ------------------------------------------------------------

interface SubmitItem { row: number; col: number; lat: number; lng: number; seq: number }
type SubmitOutcome = { state: 'accepted'; taskId: string; cost: number } | { state: 'rejected' } | { state: 'unknown' };

export function submissionTag(runId: string, attempt: number, row: number, col: number, seq: number): string {
  return `rs:${runId}:a${attempt}:r${row}c${col}:s${seq}`;
}

/**
 * Posts tasks with a durable record for each: reserve budget, write intents, POST, resolve.
 * Returns null (nothing posted) when the budget can't cover the whole chunk.
 */
async function submitTasks(
  projectId: string, run: RunRow, attempt: number, items: SubmitItem[], auth: string,
): Promise<SubmitOutcome[] | null> {
  const price = rescanTaskPrice();
  if (!reserveBudget(price * items.length)) return null;
  const db = getDbForProject(projectId);
  const now = Date.now();
  const tags = items.map((i) => submissionTag(run.id, attempt, i.row, i.col, i.seq));
  try {
    db.transaction(() => {
      const insert = db.prepare(`INSERT INTO grid_rescan_submissions (tag, run_id, attempt, row, col, seq, state, reserved, submitted_at)
        VALUES (?, ?, ?, ?, ?, ?, 'intent', ?, ?)`);
      items.forEach((item, index) => insert.run(tags[index], run.id, attempt, item.row, item.col, item.seq, price, now));
    })();
  } catch {
    // Nothing was posted. Release the reservation. A tag that already exists means an earlier
    // submission's outcome is unrecorded, so these points stop and the run is held post_unknown.
    settleBudget(price * items.length, 0);
    return items.map(() => ({ state: 'unknown' as const }));
  }
  const requests: GridTaskRequest[] = items.map((item, index) => ({
    keyword: run.keyword, lat: item.lat, lng: item.lng, language: run.language, priority: run.queue_mode === 'priority' ? 2 : 1, tag: tags[index],
  }));
  const posted = await postGridTaskChunk(requests, auth);
  // An HTTP error status means DataForSEO refused the call; anything else (timeout, network) may have been accepted.
  const callRejected = Boolean(posted.error?.startsWith('API error'));
  const outcomes: SubmitOutcome[] = items.map((_, index) => {
    if (posted.error) return callRejected ? { state: 'rejected' } : { state: 'unknown' };
    const result = posted.results[index];
    return result?.taskId ? { state: 'accepted', taskId: result.taskId, cost: result.cost } : { state: 'rejected' };
  });
  const resolvedAt = Date.now();
  db.transaction(() => {
    const update = db.prepare("UPDATE grid_rescan_submissions SET state = ?, task_id = ?, cost = ?, resolved_at = ? WHERE tag = ? AND state = 'intent'");
    outcomes.forEach((o, index) => {
      if (o.state === 'unknown') {
        db.prepare("UPDATE grid_rescan_submissions SET state = 'unknown', resolved_at = ? WHERE tag = ? AND state = 'intent'").run(resolvedAt, tags[index]);
      } else {
        update.run(o.state, o.state === 'accepted' ? o.taskId : null, o.state === 'accepted' ? o.cost : 0, resolvedAt, tags[index]);
      }
    });
    const accepted = outcomes.filter((o) => o.state === 'accepted') as Array<{ cost: number }>;
    db.prepare('UPDATE grid_rescan_attempts SET cost = cost + ?, accepted_searches = accepted_searches + ?, rejected_submissions = rejected_submissions + ? WHERE run_id = ? AND attempt = ?')
      .run(accepted.reduce((s, o) => s + o.cost, 0), accepted.length, outcomes.filter((o) => o.state === 'rejected').length, run.id, attempt);
  })();
  // Accepted: the reservation becomes the actual cost. Rejected: released. Unknown: stays reserved.
  const settledReserve = outcomes.filter((o) => o.state !== 'unknown').length * price;
  const spent = outcomes.reduce((s, o) => s + (o.state === 'accepted' ? o.cost : 0), 0);
  settleBudget(settledReserve, spent);
  return outcomes;
}

/** Intents with no outcome for 10+ min (a crash mid-POST) become unknown, and their runs are held. */
function recoverStaleIntents(projectId: string, now: number): number {
  const db = getDbForProject(projectId);
  const stale = db.prepare("SELECT tag, run_id, attempt FROM grid_rescan_submissions WHERE state = 'intent' AND submitted_at < ?")
    .all(now - RESCAN_INTENT_STALE_MS) as Array<{ tag: string; run_id: string; attempt: number }>;
  for (const s of stale) db.prepare("UPDATE grid_rescan_submissions SET state = 'unknown', resolved_at = ? WHERE tag = ? AND state = 'intent'").run(now, s.tag);
  const runs = new Map(stale.map((s) => [`${s.run_id}:${s.attempt}`, s]));
  let held = 0;
  for (const s of runs.values()) {
    if (hold(projectId, s.run_id, s.attempt, 'post_unknown', ['posting', 'scanning'], { tags: stale.filter((x) => x.run_id === s.run_id).map((x) => x.tag) })) held += 1;
  }
  return held;
}

// --- Worker ----------------------------------------------------------------------------------------

export interface RescanPassCounters {
  /** Shared across projects within one worker pass. */
  startsLeft: number;
  started: number;
  collected: number;
  swapped: number;
  held: number;
  orphaned: number;
}

export function newRescanCounters(): RescanPassCounters {
  return { startsLeft: maxStartsPerPass(), started: 0, collected: 0, swapped: 0, held: 0, orphaned: 0 };
}

function loadRun(projectId: string, runId: string): RunRow | undefined {
  return getDbForProject(projectId).prepare(`SELECT id, ts, series_id, keyword, target, center, grid_size, spacing_km, language, status, queue_mode, results
    FROM grid_searches WHERE id = ?`).get(runId) as RunRow | undefined;
}

function loadAttempt(projectId: string, runId: string, attempt: number): AttemptRow | undefined {
  return getDbForProject(projectId).prepare('SELECT * FROM grid_rescan_attempts WHERE run_id = ? AND attempt = ?').get(runId, attempt) as AttemptRow | undefined;
}

const CHUNK = 100;

async function startOne(projectId: string, rescan: RescanRow, auth: string, counters: RescanPassCounters): Promise<void> {
  const db = getDbForProject(projectId);
  // Conditional claim: only one worker can move a queued run to posting.
  if (!setState(projectId, rescan.run_id, ['queued'], rescan.attempt, 'posting', { started: true })) return;
  counters.started += 1;
  const run = loadRun(projectId, rescan.run_id);
  if (!run || run.status !== 'done') {
    setState(projectId, rescan.run_id, ['posting'], rescan.attempt, 'orphaned', { finished: true });
    counters.orphaned += 1;
    return;
  }
  const now = Date.now();
  const points = parsePoints(run.results);
  db.prepare(`INSERT OR REPLACE INTO grid_rescan_attempts (run_id, attempt, state, source_hash, config_hash, attempt_started_at)
    VALUES (?, ?, 'posting', ?, ?, ?)`).run(run.id, rescan.attempt, sha256(run.results ?? ''), configHash(run), now);
  if (!isCompleteGrid(points, run.grid_size)) {
    if (hold(projectId, run.id, rescan.attempt, 'bad_source', ['posting'])) counters.held += 1;
    return;
  }
  // Same rows, columns and coordinates as the stored run.
  const coords = points.map((p) => ({ row: p.row, col: p.col, ...pointCoords(run, p) }))
    .sort((a, b) => a.row - b.row || a.col - b.col);
  const taskPoints: GridTaskPoint[] = [];
  for (let i = 0; i < coords.length; i += CHUNK) {
    // A cancel during posting stops further chunks.
    const current = db.prepare('SELECT state, attempt FROM grid_rescans WHERE run_id = ?').get(run.id) as { state: RescanState; attempt: number } | undefined;
    if (current?.state !== 'posting' || current.attempt !== rescan.attempt) return;
    const chunk = coords.slice(i, i + CHUNK);
    const outcomes = await submitTasks(projectId, run, rescan.attempt, chunk.map((c) => ({ ...c, seq: 1 })), auth);
    if (!outcomes) {
      saveTaskPoints(projectId, run.id, rescan.attempt, taskPoints);
      if (hold(projectId, run.id, rescan.attempt, 'budget_exhausted', ['posting'])) counters.held += 1;
      return;
    }
    const submittedAt = Date.now();
    outcomes.forEach((o, index) => {
      const c = chunk[index];
      if (o.state === 'accepted') taskPoints.push({ task_id: o.taskId, ...c, attempts: 1, seq: 1, submitted_at: submittedAt });
      // Rejected at submission: not a search yet; re-submitted after a 1 min backoff (max 3 rejections).
      else if (o.state === 'rejected') taskPoints.push({ task_id: '', ...c, attempts: 0, seq: 2, post_failures: 1, awaiting_retry: true, retry_due_at: submittedAt + 60_000 });
    });
    if (outcomes.some((o) => o.state === 'unknown')) {
      saveTaskPoints(projectId, run.id, rescan.attempt, taskPoints);
      if (hold(projectId, run.id, rescan.attempt, 'post_unknown', ['posting'])) counters.held += 1;
      return;
    }
  }
  saveTaskPoints(projectId, run.id, rescan.attempt, taskPoints);
  if (setState(projectId, run.id, ['posting'], rescan.attempt, 'scanning')) {
    db.prepare("UPDATE grid_rescan_attempts SET state = 'scanning' WHERE run_id = ? AND attempt = ?").run(run.id, rescan.attempt);
  }
}

function saveTaskPoints(projectId: string, runId: string, attempt: number, taskPoints: GridTaskPoint[], results?: GridPoint[]): void {
  const db = getDbForProject(projectId);
  if (results) {
    db.prepare('UPDATE grid_rescan_attempts SET task_points = ?, results = ? WHERE run_id = ? AND attempt = ?').run(JSON.stringify(taskPoints), JSON.stringify(results), runId, attempt);
  } else {
    db.prepare('UPDATE grid_rescan_attempts SET task_points = ? WHERE run_id = ? AND attempt = ?').run(JSON.stringify(taskPoints), runId, attempt);
  }
}

/** Collects one scanning run: check tasks, re-post bad points through the ledger, finalize when complete. */
async function collectOne(projectId: string, rescan: RescanRow, auth: string, counters: RescanPassCounters): Promise<void> {
  const db = getDbForProject(projectId);
  const attempt = loadAttempt(projectId, rescan.run_id, rescan.attempt);
  const run = loadRun(projectId, rescan.run_id);
  if (!attempt) return;
  if (!run) {
    if (setState(projectId, rescan.run_id, ['scanning'], rescan.attempt, 'orphaned', { finished: true })) counters.orphaned += 1;
    return;
  }
  const now = Date.now();
  if (now - attempt.attempt_started_at > RESCAN_ATTEMPT_DEADLINE_MS) {
    if (hold(projectId, run.id, rescan.attempt, 'timeout')) counters.held += 1;
    return;
  }
  const tasks = JSON.parse(attempt.task_points) as GridTaskPoint[];
  const collected = JSON.parse(attempt.results) as GridPoint[];
  const toCheck = tasks.filter((t) => !t.awaiting_retry && t.task_id);
  const checks = await checkGridTasks(toCheck, { auth, target: run.target, now });
  const step = await stepGridTasks(tasks, new Map(toCheck.map((t, i) => [t, checks[i]])), now, async (task): Promise<RepostOutcome> => {
    const seq = (task.seq ?? 1) + 1;
    const outcomes = await submitTasks(projectId, run, rescan.attempt, [{ row: task.row, col: task.col, lat: task.lat, lng: task.lng, seq }], auth);
    if (!outcomes) return { kind: 'budget' };
    const o = outcomes[0];
    if (o.state === 'accepted') return { kind: 'accepted', taskId: o.taskId };
    return o.state === 'unknown' ? { kind: 'unknown' } : { kind: 'rejected' };
  });
  counters.collected += 1;
  // Write only while this attempt is still the one scanning (a cancel or retry in between wins).
  const stillScanning = db.prepare("SELECT 1 FROM grid_rescans WHERE run_id = ? AND attempt = ? AND state = 'scanning'").get(run.id, rescan.attempt);
  if (!stillScanning) return;
  const results = [...collected, ...step.ready];
  saveTaskPoints(projectId, run.id, rescan.attempt, step.pending, results);
  if (step.unknown > 0) {
    if (hold(projectId, run.id, rescan.attempt, 'post_unknown')) counters.held += 1;
    return;
  }
  if (step.budgetExhausted) {
    if (hold(projectId, run.id, rescan.attempt, 'budget_exhausted')) counters.held += 1;
    return;
  }
  if (step.pending.length > 0) return;
  finalize(projectId, run, rescan, results, counters);
}

/** Applies the hold rules, then swaps the new points into the run in one transaction. */
function finalize(projectId: string, run: RunRow, rescan: RescanRow, results: GridPoint[], counters: RescanPassCounters): void {
  const db = getDbForProject(projectId);
  const evidence = results.filter((p) => p.failed).map((p) => ({ row: p.row, col: p.col, reason: p.failed_reason, task_id: p.task_id, check_url: p.check_url, rechecks: p.rechecks }));
  const unknown = db.prepare("SELECT COUNT(*) AS n FROM grid_rescan_submissions WHERE run_id = ? AND attempt = ? AND state IN ('intent', 'unknown')")
    .get(run.id, rescan.attempt) as { n: number };
  let reason: HoldReason | null = null;
  if (unknown.n > 0) reason = 'post_unknown';
  else if (!isCompleteGrid(results, run.grid_size)) reason = 'incomplete';
  else if (results.some((p) => p.failed && p.failed_reason === 'wrong_city')) reason = 'wrong_city_persistent';
  else if (results.filter((p) => p.failed).length > RESCAN_MAX_OTHER_FAILED) reason = 'too_many_failed';
  if (reason) {
    if (hold(projectId, run.id, rescan.attempt, reason, ['scanning'], evidence)) counters.held += 1;
    return;
  }
  const sorted = [...results].sort((a, b) => a.row - b.row || a.col - b.col);
  const newJson = JSON.stringify(sorted);
  const outcome = db.transaction((): 'swapped' | 'orphaned' | 'source_changed' | 'stale' => {
    const state = db.prepare('SELECT state, attempt FROM grid_rescans WHERE run_id = ?').get(run.id) as { state: RescanState; attempt: number } | undefined;
    if (state?.state !== 'scanning' || state.attempt !== rescan.attempt) return 'stale';
    const current = db.prepare('SELECT results, keyword, target, center, grid_size, spacing_km, language, status FROM grid_searches WHERE id = ?')
      .get(run.id) as (RunRow & { results: string }) | undefined;
    if (!current) return 'orphaned';
    const attempt = db.prepare('SELECT source_hash, config_hash FROM grid_rescan_attempts WHERE run_id = ? AND attempt = ?')
      .get(run.id, rescan.attempt) as { source_hash: string; config_hash: string };
    if (sha256(current.results) !== attempt.source_hash || configHash(current) !== attempt.config_hash || current.status !== 'done') return 'source_changed';
    db.prepare('UPDATE grid_searches SET results = ? WHERE id = ?').run(newJson, run.id);
    db.prepare("UPDATE grid_rescan_attempts SET state = 'swapped', results_before = ?, swapped_hash = ?, finished_at = ? WHERE run_id = ? AND attempt = ?")
      .run(current.results, sha256(newJson), Date.now(), run.id, rescan.attempt);
    const now = Date.now();
    db.prepare("UPDATE grid_rescans SET state = 'swapped', hold_reason = NULL, finished_at = ?, swapped_at = ?, updated_at = ? WHERE run_id = ? AND attempt = ? AND state = 'scanning'")
      .run(now, now, now, run.id, rescan.attempt);
    return 'swapped';
  })();
  if (outcome === 'swapped') {
    const safety = computedSafety(sorted);
    setSafety(projectId, run.id, safety.report_safe, safety.reason);
    counters.swapped += 1;
  } else if (outcome === 'orphaned') {
    if (setState(projectId, run.id, ['scanning'], rescan.attempt, 'orphaned', { finished: true })) counters.orphaned += 1;
  } else if (outcome === 'source_changed') {
    if (hold(projectId, run.id, rescan.attempt, 'source_changed', ['scanning'])) counters.held += 1;
  }
}

const inFlight = new Map<string, Promise<void>>();

/** One worker step for a project: recover stale submissions, start queued runs (global pacing), collect scanning ones. */
export async function advanceRescans(projectId: string, credentials: { login: string; pass: string }, counters: RescanPassCounters): Promise<void> {
  const auth = btoa(`${credentials.login}:${credentials.pass}`);
  const now = Date.now();
  counters.held += recoverStaleIntents(projectId, now);
  const db = getDbForProject(projectId);
  const rows = db.prepare("SELECT * FROM grid_rescans WHERE state IN ('queued', 'scanning') ORDER BY queued_at ASC, run_id ASC").all() as RescanRow[];
  for (const row of rows) {
    if (row.state === 'queued' && counters.startsLeft <= 0) continue;
    const key = `rescan:${projectId}:${row.run_id}`;
    if (inFlight.has(key)) continue;
    if (row.state === 'queued') counters.startsLeft -= 1;
    const op = (row.state === 'queued' ? startOne(projectId, row, auth, counters) : collectOne(projectId, row, auth, counters))
      .finally(() => inFlight.delete(key));
    inFlight.set(key, op);
    try {
      await op;
    } catch {
      // A local failure leaves the state as it was; stale intents are recovered on a later pass.
    }
  }
}

// --- Status ----------------------------------------------------------------------------------------

function mrtAverage(points: GridPoint[]): number | null {
  const scanned = points.filter((p) => !p.failed && !p.rank_unresolved);
  if (!scanned.length) return null;
  return Math.round((scanned.reduce((s, p) => s + Math.min(p.rank ?? 21, 21), 0) / scanned.length) * 10000) / 10000;
}

export function rescanStatus(filter: { label?: string; state?: string; unsafe?: boolean; manifest_id?: string } = {}) {
  const counts: Record<string, number> = {};
  const runs = [];
  const detections = [];
  const unsafe = [];
  let cost = 0;
  for (const project of getProjects()) {
    const db = getDbForProject(project.id);
    if (filter.unsafe) {
      const rows = db.prepare('SELECT s.run_id, s.reason, s.evidence, s.updated_at, g.series_id, g.keyword, g.target, g.ts FROM grid_run_safety s LEFT JOIN grid_searches g ON g.id = s.run_id WHERE s.report_safe = 0')
        .all() as Array<{ run_id: string; reason: string | null; evidence: string | null; updated_at: number; series_id: string | null; keyword: string | null; target: string | null; ts: number | null }>;
      for (const r of rows) {
        unsafe.push({
          project: { id: project.id, name: project.name }, run_id: r.run_id, monitor_id: r.series_id, keyword: r.keyword, target: r.target,
          run_at: r.ts ? new Date(r.ts).toISOString() : null, reason: r.reason, evidence: r.evidence ? JSON.parse(r.evidence) : null,
          flagged_at: new Date(r.updated_at).toISOString(),
        });
      }
      continue;
    }
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (filter.label) { conditions.push('r.label = ?'); params.push(filter.label); }
    if (filter.state) { conditions.push('r.state = ?'); params.push(filter.state); }
    if (filter.manifest_id) { conditions.push('r.manifest_id = ?'); params.push(filter.manifest_id); }
    const rows = db.prepare(`SELECT r.*, a.cost, a.accepted_searches, a.rejected_submissions, a.results AS new_results, a.results_before, a.task_points,
        g.keyword, g.target, g.ts, g.results AS live_results
      FROM grid_rescans r LEFT JOIN grid_rescan_attempts a ON a.run_id = r.run_id AND a.attempt = r.attempt
      LEFT JOIN grid_searches g ON g.id = r.run_id ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''} ORDER BY r.queued_at ASC`)
      .all(...params) as Array<RescanRow & { cost: number | null; accepted_searches: number | null; rejected_submissions: number | null; new_results: string | null;
        results_before: string | null; task_points: string | null; keyword: string | null; target: string | null; ts: number | null; live_results: string | null }>;
    for (const r of rows) {
      counts[r.state] = (counts[r.state] ?? 0) + 1;
      // Before = the points the run had when this attempt swapped (or the live points if not swapped yet).
      const before = parsePoints(r.state === 'swapped' || r.state === 'undone' ? r.results_before : r.live_results);
      const after = parsePoints(r.new_results);
      const attemptCost = Math.round((r.cost ?? 0) * 10000) / 10000;
      cost += attemptCost;
      for (const p of after) {
        for (const rc of p.rechecks ?? []) {
          if (rc.reason !== 'wrong_city') continue;
          detections.push({ run_id: r.run_id, row: p.row, col: p.col, task_id: rc.task_id, check_url: rc.check_url ?? null, far: rc.far ?? [], resolved: !p.failed });
        }
      }
      runs.push({
        run_id: r.run_id, monitor_id: r.series_id, project: { id: project.id, name: project.name }, keyword: r.keyword, target: r.target,
        run_at: r.ts ? new Date(r.ts).toISOString() : null, label: r.label, manifest_id: r.manifest_id,
        state: r.state, hold_reason: r.hold_reason, attempt: r.attempt,
        queued_at: new Date(r.queued_at).toISOString(), started_at: r.started_at ? new Date(r.started_at).toISOString() : null,
        swapped_at: r.swapped_at ? new Date(r.swapped_at).toISOString() : null,
        points_collected: after.length, points_pending: r.task_points ? (JSON.parse(r.task_points) as unknown[]).length : 0,
        // Old points can't be re-checked (descriptions weren't stored), so "before" is the detections this
        // re-scan made (tasks that came back wrong-city and were re-posted) and "after" what's left.
        wrong_city: {
          detected: after.reduce((s, p) => s + (p.rechecks ?? []).filter((x) => x.reason === 'wrong_city').length, 0),
          points_left: after.filter((p) => p.failed_reason === 'wrong_city').length,
        },
        failed_points: after.filter((p) => p.failed).length,
        mrt_average_position: { before: mrtAverage(before), after: after.length ? mrtAverage(after) : null },
        accepted_searches: r.accepted_searches ?? 0, rejected_submissions: r.rejected_submissions ?? 0, cost: attemptCost,
      });
    }
  }
  if (filter.unsafe) return { unsafe };
  return { counts, cost: Math.round(cost * 10000) / 10000, budget: getBudget(), exclusions: listExclusions(), runs, wrong_city_detections: detections };
}
