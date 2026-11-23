// Patch fork: the database side of the location-based Geo-grid UI (All clients › Client › Location › Keyword).
//
// A "location" is not stored anywhere. It is computed from the monitors (series) that share a business
// and a map center, so this file needs no schema change and never rewrites a monitor's ID, its runs or
// its pins. Its only writes go to the same tables the old Geo-grid screen writes:
//   - grid_schedules: location schedule edits, new keyword or location schedules, "run now" (next_run_at)
//   - grid_searches + grid_schedules: deleting a whole location
//
// Every function takes the project ID explicitly (never the global "active project") and checks the
// project › location › series › run chain before it reads or writes anything.
import { createHash } from 'crypto';
import type Database from 'better-sqlite3';
import {
  createProject, getDbForProject, getProjects, gridSeriesId, nextGridScheduleRun, projectExists,
  type GridPoint, type GridQueueMode, type GridScheduleFrequency, type Project,
} from './db';
import { formatBusinessTarget, parseTargetCid, reconcileGridPoints } from './grid-target';
import { DEFAULT_GRID_SIZE, DEFAULT_SCHEDULE_DAY, DEFAULT_SCHEDULE_TIME } from './grid-radius';
import { timeZoneForCenter } from './grid-timezone';

/** Bumped only if the grouping rule ever changes; old IDs keep their meaning. */
export const LOCATION_ID_VERSION = 'v1';
/** Keyword pages read at most this many past scans (trend, history, compare). */
export const MAX_KEYWORD_RUNS = 24;
/** A schedule touched this recently may have just been claimed by the worker, which is still posting. */
const RECENT_CLAIM_MS = 2 * 60_000;
/** A scan started this recently counts as in progress even if it already finished posting. */
const RECENT_RUN_MS = 10 * 60_000;

export type LocationErrorCode = 'not_found' | 'invalid' | 'duplicate' | 'scan_in_progress' | 'no_schedule';

export class LocationError extends Error {
  constructor(public code: LocationErrorCode, message: string) {
    super(message);
  }
}

/**
 * The Default Project holds sales demos: one-time scans only, never a schedule.
 * TODO(after PR #8 merges): use DEMO_PROJECT_ID / isOneTimeOnlyProject from ./grid-guardrails.
 */
export const DEMO_PROJECT_ID = 'default';

function refuseDemoSchedule(projectId: string) {
  if (projectId === DEMO_PROJECT_ID) {
    throw new LocationError('invalid', 'The sales demo project only takes one-time scans. Add the client first, then add the location to that client.');
  }
}

// --- Location identity ---

/** The business half of the key: the Google CID when the target has one, else the trimmed, lowercased target. */
export function businessKey(target: string): string {
  return parseTargetCid(target) ?? target.trim().toLowerCase();
}

/** The center rounded to 4 decimals (~11 m), so "40.7128,-74.006" and "40.712800,-74.006000" match. */
export function centerKey(center: string): string {
  const [lat, lng] = center.split(',').map((part) => Number(part.trim()));
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return center.trim();
  const fixed = (value: number) => {
    const text = value.toFixed(4);
    return text === '-0.0000' ? '0.0000' : text;
  };
  return `${fixed(lat)},${fixed(lng)}`;
}

/** Stable location ID: project + business + rounded center. No clustering, so it never depends on row order. */
export function locationIdFor(projectId: string, target: string, center: string): string {
  const key = [projectId, businessKey(target), centerKey(center)].join('|');
  return `${LOCATION_ID_VERSION}-${createHash('sha256').update(key).digest('hex').slice(0, 12)}`;
}

/** The business name without the "(cid:…)" suffix. */
export function businessName(target: string): string {
  return target.replace(/\s*\(cid:\s*\d+\)\s*$/i, '').trim();
}

// --- Row types ---

export interface ScheduleInfo {
  frequency: GridScheduleFrequency;
  /** Day of week (0-6) for weekly, day of month (1-28) for monthly. */
  weekday: number | null;
  time_of_day: string;
  time_zone: string;
  queue_mode: GridQueueMode;
  next_run_at: number;
  updated_at: number;
}

export interface RunHeader {
  id: string;
  series_id: string;
  ts: number;
  status: 'done' | 'pending' | 'error';
  pinned: boolean;
}

/** A finished run with its points parsed once. Points keep the `failed` flag. */
export interface RunWithPoints extends RunHeader {
  points: GridPoint[];
}

export interface PendingRun extends RunHeader {
  totalPoints: number;
  /** Points already collected (the rest are still with DataForSEO). */
  readyPoints: number;
}

export interface MonitorInfo {
  series_id: string;
  keyword: string;
  target: string;
  center: string;
  grid_size: number;
  spacing_km: number;
  language: string;
  schedule: ScheduleInfo | null;
  /** Number of finished runs. */
  doneRuns: number;
  /** When the monitor first appeared (oldest run, else schedule creation). */
  firstSeen: number;
  pinnedRun: RunHeader | null;
  pendingRun: PendingRun | null;
}

export interface MonitorWithLatest extends MonitorInfo {
  /** The newest finished runs, newest first (at most 2: latest and previous). */
  latestRuns: RunWithPoints[];
}

export interface LocationGroup<M extends MonitorInfo = MonitorInfo> {
  id: string;
  projectId: string;
  /** 1-based position among the client's locations, oldest first. */
  number: number;
  name: string;
  target: string;
  cid: string | null;
  /** The center as stored on the most common configuration's newest monitor. */
  center: string;
  monitors: M[];
}

// --- Low-level reads ---

interface ScheduleRow {
  series_id: string; keyword: string; target: string; center: string; grid_size: number; spacing_km: number; language: string;
  queue_mode: string; frequency: string; weekday: number | null; time_of_day: string; time_zone: string;
  next_run_at: number; created_at: number; updated_at: number;
}

interface SeriesRow {
  series_id: string; keyword: string; target: string; center: string; grid_size: number; spacing_km: number; language: string;
  done_runs: number; first_ts: number;
}

function requireProject(projectId: string): Database.Database {
  if (!projectId || !projectExists(projectId)) throw new LocationError('not_found', 'Client not found.');
  return getDbForProject(projectId);
}

function scheduleFromRow(row: ScheduleRow): ScheduleInfo {
  return {
    frequency: row.frequency as GridScheduleFrequency,
    weekday: row.weekday,
    time_of_day: row.time_of_day,
    time_zone: row.time_zone,
    queue_mode: (row.queue_mode ?? 'standard') as GridQueueMode,
    next_run_at: row.next_run_at,
    updated_at: row.updated_at,
  };
}

function parsePoints(json: string | null, target: string): GridPoint[] {
  try {
    return reconcileGridPoints(JSON.parse(json ?? '[]') as GridPoint[], target);
  } catch {
    return [];
  }
}

function headerFromRow(row: { id: string; series_id: string; ts: number; status: string; pinned: number | null }): RunHeader {
  return { id: row.id, series_id: row.series_id, ts: row.ts, status: (row.status ?? 'done') as RunHeader['status'], pinned: row.pinned === 1 };
}

/** Every monitor in a project, without any results blobs. */
function readMonitors(db: Database.Database): MonitorInfo[] {
  // One row per series: the series' fixed config (target/center/grid are part of its ID, so any row has them).
  const series = db.prepare(`SELECT series_id, keyword, target, center, grid_size, spacing_km, language,
      SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done_runs, MIN(ts) AS first_ts
    FROM grid_searches GROUP BY series_id`).all() as SeriesRow[];
  const schedules = db.prepare(`SELECT series_id, keyword, target, center, grid_size, spacing_km, language, queue_mode, frequency,
      weekday, time_of_day, time_zone, next_run_at, created_at, updated_at FROM grid_schedules`).all() as ScheduleRow[];
  const pinned = db.prepare(`SELECT id, series_id, ts, status, pinned FROM grid_searches WHERE pinned = 1`)
    .all() as Array<{ id: string; series_id: string; ts: number; status: string; pinned: number }>;
  const pending = db.prepare(`SELECT id, series_id, ts, status, pinned, grid_size, results, task_ids FROM grid_searches WHERE status = 'pending' ORDER BY ts DESC`)
    .all() as Array<{ id: string; series_id: string; ts: number; status: string; pinned: number; grid_size: number; results: string | null; task_ids: string | null }>;

  const scheduleBySeries = new Map(schedules.map((row) => [row.series_id, row]));
  const pinnedBySeries = new Map(pinned.map((row) => [row.series_id, headerFromRow(row)]));
  const pendingBySeries = new Map<string, PendingRun>();
  for (const row of pending) {
    if (pendingBySeries.has(row.series_id)) continue;
    let ready = 0;
    try { ready = (JSON.parse(row.results ?? '[]') as unknown[]).length; } catch { ready = 0; }
    pendingBySeries.set(row.series_id, { ...headerFromRow(row), totalPoints: row.grid_size ** 2, readyPoints: ready });
  }

  const monitors: MonitorInfo[] = [];
  const seen = new Set<string>();
  for (const row of series) {
    seen.add(row.series_id);
    const schedule = scheduleBySeries.get(row.series_id);
    monitors.push({
      series_id: row.series_id, keyword: row.keyword, target: row.target, center: row.center,
      grid_size: row.grid_size, spacing_km: row.spacing_km, language: row.language,
      schedule: schedule ? scheduleFromRow(schedule) : null,
      doneRuns: row.done_runs,
      firstSeen: Math.min(row.first_ts, schedule?.created_at ?? Number.POSITIVE_INFINITY),
      pinnedRun: pinnedBySeries.get(row.series_id) ?? null,
      pendingRun: pendingBySeries.get(row.series_id) ?? null,
    });
  }
  // A monitor created through the API (or the new UI) is scheduled before its first run.
  for (const row of schedules) {
    if (seen.has(row.series_id)) continue;
    monitors.push({
      series_id: row.series_id, keyword: row.keyword, target: row.target, center: row.center,
      grid_size: row.grid_size, spacing_km: row.spacing_km, language: row.language,
      schedule: scheduleFromRow(row), doneRuns: 0, firstSeen: row.created_at, pinnedRun: null, pendingRun: null,
    });
  }
  return monitors;
}

/** The newest `perSeries` finished runs of each given series, results parsed once. Bounded by SQL, not in JS. */
function readLatestRuns(db: Database.Database, seriesIds: string[], perSeries: number): Map<string, RunWithPoints[]> {
  const out = new Map<string, RunWithPoints[]>();
  if (seriesIds.length === 0) return out;
  const wanted = new Set(seriesIds);
  // The window runs over ids only; results blobs are read just for the rows that survive the LIMIT.
  const rows = db.prepare(`SELECT g.id, g.series_id, g.ts, g.status, g.pinned, g.target, g.results
    FROM grid_searches g
    JOIN (
      SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (PARTITION BY series_id ORDER BY ts DESC) AS rn
        FROM grid_searches WHERE status = 'done'
      ) WHERE rn <= ?
    ) latest ON latest.id = g.id
    ORDER BY g.series_id, g.ts DESC`).all(perSeries) as Array<{ id: string; series_id: string; ts: number; status: string; pinned: number; target: string; results: string | null }>;
  for (const row of rows) {
    if (!wanted.has(row.series_id)) continue;
    const list = out.get(row.series_id) ?? [];
    list.push({ ...headerFromRow(row), points: parsePoints(row.results, row.target) });
    out.set(row.series_id, list);
  }
  return out;
}

/** Groups monitors into locations and numbers them oldest first. */
function groupLocations<M extends MonitorInfo>(projectId: string, monitors: M[]): LocationGroup<M>[] {
  const byId = new Map<string, M[]>();
  for (const monitor of monitors) {
    const id = locationIdFor(projectId, monitor.target, monitor.center);
    byId.set(id, [...(byId.get(id) ?? []), monitor]);
  }
  const groups = [...byId.entries()].map(([id, list]) => {
    const sorted = [...list].sort((a, b) => a.keyword.localeCompare(b.keyword) || a.series_id.localeCompare(b.series_id));
    const representative = mostCommonConfigMonitor(sorted);
    return {
      id, projectId, number: 0,
      name: businessName(representative.target) || representative.target,
      target: representative.target,
      cid: parseTargetCid(representative.target),
      center: representative.center,
      monitors: sorted,
      firstSeen: Math.min(...list.map((m) => m.firstSeen)),
    };
  });
  groups.sort((a, b) => a.firstSeen - b.firstSeen || a.id.localeCompare(b.id));
  return groups.map((group, index) => ({
    id: group.id, projectId: group.projectId, number: index + 1, name: group.name, target: group.target, cid: group.cid, center: group.center, monitors: group.monitors,
  }));
}

/** The monitor carrying the location's most common grid size + spacing (ties: most runs, then newest). */
export function mostCommonConfigMonitor<M extends Pick<MonitorInfo, 'grid_size' | 'spacing_km' | 'doneRuns' | 'firstSeen'>>(monitors: M[]): M {
  const counts = new Map<string, number>();
  for (const m of monitors) counts.set(`${m.grid_size}|${m.spacing_km}`, (counts.get(`${m.grid_size}|${m.spacing_km}`) ?? 0) + 1);
  return [...monitors].sort((a, b) => (counts.get(`${b.grid_size}|${b.spacing_km}`)! - counts.get(`${a.grid_size}|${a.spacing_km}`)!)
    || b.doneRuns - a.doneRuns || b.firstSeen - a.firstSeen)[0];
}

// --- Public reads ---

export interface ClientSummary {
  project: Pick<Project, 'id' | 'name' | 'domain' | 'createdAt'>;
  locations: number;
  keywords: number;
  lastScanAt: number | null;
  nextScanAt: number | null;
  scanning: number;
}

/** Every client (project) except the sales demo project, with Geo-grid counts (no results blobs read). */
export function listClients(): ClientSummary[] {
  const out: ClientSummary[] = [];
  for (const project of getProjects()) {
    if (project.id === DEMO_PROJECT_ID) continue;
    const db = getDbForProject(project.id);
    const monitors = readMonitors(db);
    const last = db.prepare(`SELECT MAX(ts) AS ts FROM grid_searches WHERE status = 'done'`).get() as { ts: number | null };
    const nextTimes = monitors.map((m) => m.schedule?.next_run_at).filter((t): t is number => t != null);
    out.push({
      project: { id: project.id, name: project.name, domain: project.domain, createdAt: project.createdAt },
      locations: new Set(monitors.map((m) => locationIdFor(project.id, m.target, m.center))).size,
      keywords: monitors.length,
      lastScanAt: last.ts ?? null,
      nextScanAt: nextTimes.length ? Math.min(...nextTimes) : null,
      scanning: monitors.filter((m) => m.pendingRun).length,
    });
  }
  return out.sort((a, b) => a.project.name.localeCompare(b.project.name));
}

/** "+ Add client": a new project for the clinic's website. One project per website, so a domain is used once. */
export function addClient(rawName: string, rawDomain: string): { projectId: string } {
  const name = rawName.replace(/\s+/g, ' ').trim();
  if (!name) throw new LocationError('invalid', 'Enter the client name.');
  if (name.length > 120) throw new LocationError('invalid', 'That name is too long.');
  const domain = rawDomain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) throw new LocationError('invalid', 'Enter the website domain, like example-pt.com.');
  const existing = getProjects().find((p) => p.domain.toLowerCase().replace(/^www\./, '') === domain);
  if (existing) throw new LocationError('duplicate', `${existing.name} already uses ${domain}.`);
  try {
    const project = createProject({ name, domain, defaultLocation: 'United States', defaultLanguage: 'English', defaultCoordinates: '', rankTrackerDepth: '100' });
    return { projectId: project.id };
  } catch (error) {
    if (error instanceof Error && /already exists/.test(error.message)) throw new LocationError('duplicate', `A client already uses ${domain}.`);
    throw error;
  }
}

export function getClient(projectId: string): Pick<Project, 'id' | 'name' | 'domain'> {
  requireProject(projectId);
  const project = getProjects().find((p) => p.id === projectId)!;
  return { id: project.id, name: project.name, domain: project.domain };
}

/** Every location of a client, each monitor with its latest two finished runs. */
export function listLocationsWithLatest(projectId: string): LocationGroup<MonitorWithLatest>[] {
  const db = requireProject(projectId);
  const monitors = readMonitors(db);
  const latest = readLatestRuns(db, monitors.map((m) => m.series_id), 2);
  return groupLocations(projectId, monitors.map((m) => ({ ...m, latestRuns: latest.get(m.series_id) ?? [] })));
}

/** Locations without any results read (for headers, settings, counts). */
export function listLocations(projectId: string): LocationGroup[] {
  return groupLocations(projectId, readMonitors(requireProject(projectId)));
}

export function getLocation(projectId: string, locationId: string): LocationGroup | null {
  return listLocations(projectId).find((location) => location.id === locationId) ?? null;
}

function requireLocation(projectId: string, locationId: string): LocationGroup {
  const location = getLocation(projectId, locationId);
  if (!location) throw new LocationError('not_found', 'Location not found for this client.');
  return location;
}

function requireMonitor(location: LocationGroup, seriesId: string): MonitorInfo {
  const monitor = location.monitors.find((m) => m.series_id === seriesId);
  if (!monitor) throw new LocationError('not_found', 'Keyword not found at this location.');
  return monitor;
}

/** A location with each monitor's latest two finished runs. */
export function getLocationWithLatest(projectId: string, locationId: string): LocationGroup<MonitorWithLatest> | null {
  return listLocationsWithLatest(projectId).find((location) => location.id === locationId) ?? null;
}

/** Headers (no results) of every run of the given series, newest first. */
export function listRunHeaders(projectId: string, locationId: string): Map<string, RunHeader[]> {
  const location = requireLocation(projectId, locationId);
  const db = getDbForProject(projectId);
  const ids = location.monitors.map((m) => m.series_id);
  const out = new Map<string, RunHeader[]>(ids.map((id) => [id, []]));
  if (ids.length === 0) return out;
  const rows = db.prepare(`SELECT id, series_id, ts, status, pinned FROM grid_searches
    WHERE series_id IN (${ids.map(() => '?').join(',')}) ORDER BY ts DESC`).all(...ids) as Array<{ id: string; series_id: string; ts: number; status: string; pinned: number }>;
  for (const row of rows) out.get(row.series_id)!.push(headerFromRow(row));
  return out;
}

/** Specific finished runs of a location, verified to belong to it. Each results blob is parsed once. */
export function getRunsForLocation(projectId: string, locationId: string, runIds: string[]): RunWithPoints[] {
  const location = requireLocation(projectId, locationId);
  const unique = [...new Set(runIds)].slice(0, 200);
  if (unique.length === 0) return [];
  const series = new Map(location.monitors.map((m) => [m.series_id, m]));
  const rows = getDbForProject(projectId).prepare(`SELECT id, series_id, ts, status, pinned, target, results FROM grid_searches
    WHERE id IN (${unique.map(() => '?').join(',')}) AND status = 'done'`).all(...unique) as Array<{ id: string; series_id: string; ts: number; status: string; pinned: number; target: string; results: string | null }>;
  return rows.filter((row) => series.has(row.series_id)).map((row) => ({ ...headerFromRow(row), points: parsePoints(row.results, row.target) }));
}

export interface KeywordData {
  location: LocationGroup;
  monitor: MonitorInfo;
  /** Every run header, newest first (for the scan dropdown). */
  headers: RunHeader[];
  /** The newest finished runs (at most MAX_KEYWORD_RUNS), newest first, plus any explicitly requested ones. */
  runs: RunWithPoints[];
}

/**
 * One keyword's data for its page. Reads at most MAX_KEYWORD_RUNS recent finished runs plus the
 * explicitly requested ones (a selected or compared scan, the pinned starting point), each parsed once.
 */
export function getKeywordData(projectId: string, locationId: string, seriesId: string, extraRunIds: string[] = []): KeywordData {
  const location = requireLocation(projectId, locationId);
  const monitor = requireMonitor(location, seriesId);
  const db = getDbForProject(projectId);
  const headers = (db.prepare(`SELECT id, series_id, ts, status, pinned FROM grid_searches WHERE series_id = ? ORDER BY ts DESC`)
    .all(seriesId) as Array<{ id: string; series_id: string; ts: number; status: string; pinned: number }>).map(headerFromRow);
  const recent = db.prepare(`SELECT id, series_id, ts, status, pinned, target, results FROM grid_searches
    WHERE series_id = ? AND status = 'done' ORDER BY ts DESC LIMIT ?`).all(seriesId, MAX_KEYWORD_RUNS) as Array<{ id: string; series_id: string; ts: number; status: string; pinned: number; target: string; results: string | null }>;
  const runs = recent.map((row) => ({ ...headerFromRow(row), points: parsePoints(row.results, row.target) }));
  const have = new Set(runs.map((run) => run.id));
  const known = new Set(headers.map((h) => h.id));
  const extra = [...new Set(extraRunIds)].filter((id) => !have.has(id) && known.has(id)).slice(0, 4);
  if (extra.length) {
    const rows = db.prepare(`SELECT id, series_id, ts, status, pinned, target, results FROM grid_searches
      WHERE series_id = ? AND status = 'done' AND id IN (${extra.map(() => '?').join(',')})`).all(seriesId, ...extra) as typeof recent;
    for (const row of rows) runs.push({ ...headerFromRow(row), points: parsePoints(row.results, row.target) });
    runs.sort((a, b) => b.ts - a.ts);
  }
  return { location, monitor, headers, runs };
}

// --- Writes ---

/** Why a scan can't be started or a location deleted right now, or null when it's safe. */
function scanActivity(db: Database.Database, monitor: MonitorInfo, now: number): string | null {
  if (monitor.pendingRun) return 'A scan is running.';
  const recent = db.prepare(`SELECT 1 FROM grid_searches WHERE series_id = ? AND ts > ? LIMIT 1`).get(monitor.series_id, now - RECENT_RUN_MS);
  if (recent) return 'A scan started in the last 10 minutes.';
  const schedule = db.prepare('SELECT next_run_at, created_at, updated_at FROM grid_schedules WHERE series_id = ?')
    .get(monitor.series_id) as { next_run_at: number; created_at: number; updated_at: number } | undefined;
  if (schedule && schedule.next_run_at <= now) return 'A scan is queued and starts within a minute.';
  // The worker's claim moves next_run_at forward and stamps updated_at, then spends a few seconds posting
  // before the pending run is saved. A just-created schedule (created_at = updated_at) was never claimed.
  if (schedule && schedule.updated_at !== schedule.created_at && schedule.updated_at > now - RECENT_CLAIM_MS) {
    return 'A scan may be starting right now. Try again in two minutes.';
  }
  return null;
}

export interface LocationScheduleInput {
  frequency: GridScheduleFrequency;
  /** Day of week (0-6) for weekly, day of month (1-28) for monthly; ignored for daily. */
  day: number | null;
  time_of_day: string;
  queue_mode: GridQueueMode;
}

function normalizeSchedule(input: LocationScheduleInput): LocationScheduleInput {
  const frequency = input.frequency;
  if (frequency !== 'daily' && frequency !== 'weekly' && frequency !== 'monthly') throw new LocationError('invalid', 'Pick daily, weekly or monthly.');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(input.time_of_day)) throw new LocationError('invalid', 'Time must be HH:MM.');
  let day: number | null = null;
  if (frequency === 'weekly') {
    if (!Number.isInteger(input.day) || input.day! < 0 || input.day! > 6) throw new LocationError('invalid', 'Pick a day of the week.');
    day = input.day;
  } else if (frequency === 'monthly') {
    if (!Number.isInteger(input.day) || input.day! < 1 || input.day! > 28) throw new LocationError('invalid', 'Day of month must be 1-28.');
    day = input.day;
  }
  const queue_mode = input.queue_mode === 'priority' ? 'priority' : 'standard';
  return { frequency, day, time_of_day: input.time_of_day, queue_mode };
}

export interface ScheduleUpdateResult {
  updated: number;
  /** Always 0: one-time scans (keywords with no schedule) are never turned into scheduled monitors. */
  created: number;
  /** One-time scans left alone. */
  oneTime: number;
  /** Rows whose due slot was recalculated (frequency, day or time changed). */
  rescheduled: number;
}

/**
 * Sets every scheduled keyword's schedule at a location in one transaction. next_run_at is recalculated
 * only when frequency, day or time changes; a queue-only or no-op save keeps the due slot. A scan the
 * worker already claimed keeps its settings.
 *
 * Keywords without a schedule are one-time scans (e.g. a sales demo) and are left alone: scheduling one
 * would make the demo the client's history and starting point. A client's tracking starts from a new
 * location added at SEO setup.
 */
export function updateLocationSchedule(projectId: string, locationId: string, raw: LocationScheduleInput, now = Date.now()): ScheduleUpdateResult {
  refuseDemoSchedule(projectId);
  const input = normalizeSchedule(raw);
  const location = requireLocation(projectId, locationId);
  if (!location.monitors.some((m) => m.schedule)) {
    throw new LocationError('invalid', 'This location only has one-time scans, which can\'t be scheduled. Add the location again from the client page to start tracking.');
  }
  const db = getDbForProject(projectId);
  const select = db.prepare(`SELECT series_id, keyword, target, center, grid_size, spacing_km, language, queue_mode, frequency,
    weekday, time_of_day, time_zone, next_run_at, created_at, updated_at FROM grid_schedules WHERE series_id = ?`);
  const update = db.prepare(`UPDATE grid_schedules SET queue_mode = ?, frequency = ?, weekday = ?, time_of_day = ?, next_run_at = ?, updated_at = ?
    WHERE series_id = ?`);
  const result: ScheduleUpdateResult = { updated: 0, created: 0, oneTime: 0, rescheduled: 0 };
  db.transaction(() => {
    for (const monitor of location.monitors) {
      const row = select.get(monitor.series_id) as ScheduleRow | undefined;
      if (row) {
        const timingChanged = row.frequency !== input.frequency || (row.weekday ?? null) !== input.day || row.time_of_day !== input.time_of_day;
        const queueChanged = row.queue_mode !== input.queue_mode;
        if (!timingChanged && !queueChanged) continue;
        const next = timingChanged
          ? nextGridScheduleRun({ frequency: input.frequency, weekday: input.day, time_of_day: input.time_of_day, time_zone: row.time_zone }, now)
          : row.next_run_at;
        update.run(input.queue_mode, input.frequency, input.day, input.time_of_day, next, now, monitor.series_id);
        result.updated += 1;
        if (timingChanged) result.rescheduled += 1;
      } else {
        result.oneTime += 1;
      }
    }
  })();
  return result;
}

export interface RunNowResult {
  queued: string[];
  skipped: Array<{ series_id: string; keyword: string; reason: string }>;
}

/**
 * "Run now": makes the keyword's (or every keyword's) schedule due now. The worker claims it on its
 * next pass with an atomic compare-and-set, then puts the regular slot back, so the UI never calls
 * DataForSEO and a double click can't post twice (a schedule that's already due is skipped).
 */
export function requestRunNow(projectId: string, locationId: string, seriesId: string | null, now = Date.now()): RunNowResult {
  const location = requireLocation(projectId, locationId);
  const monitors = seriesId ? [requireMonitor(location, seriesId)] : location.monitors;
  const db = getDbForProject(projectId);
  const result: RunNowResult = { queued: [], skipped: [] };
  const setDue = db.prepare('UPDATE grid_schedules SET next_run_at = ?, updated_at = ? WHERE series_id = ? AND next_run_at = ?');
  db.transaction(() => {
    for (const monitor of monitors) {
      const schedule = db.prepare('SELECT next_run_at FROM grid_schedules WHERE series_id = ?').get(monitor.series_id) as { next_run_at: number } | undefined;
      if (!schedule) {
        result.skipped.push({ series_id: monitor.series_id, keyword: monitor.keyword, reason: 'Not scheduled (one-time scan).' });
        continue;
      }
      const busy = scanActivity(db, monitor, now);
      if (busy) {
        result.skipped.push({ series_id: monitor.series_id, keyword: monitor.keyword, reason: busy });
        continue;
      }
      if (setDue.run(now, now, monitor.series_id, schedule.next_run_at).changes === 1) result.queued.push(monitor.series_id);
    }
  })();
  return result;
}

export interface NewKeywordResult {
  series_id: string;
  keyword: string;
}

function normalizeKeyword(keyword: string): string {
  const trimmed = keyword.replace(/\s+/g, ' ').trim();
  if (!trimmed) throw new LocationError('invalid', 'Enter a keyword.');
  if (trimmed.length > 200) throw new LocationError('invalid', 'That keyword is too long.');
  return trimmed;
}

function seriesExists(db: Database.Database, seriesId: string): boolean {
  return Boolean(db.prepare('SELECT 1 FROM grid_searches WHERE series_id = ? LIMIT 1').get(seriesId)
    || db.prepare('SELECT 1 FROM grid_schedules WHERE series_id = ?').get(seriesId));
}

/** The schedule a new keyword inherits: the location's most common one, else monthly on the 15th at noon. */
function inheritedSchedule(location: LocationGroup): Omit<ScheduleInfo, 'next_run_at' | 'updated_at' | 'time_zone'> & { time_zone: string | null } {
  const counts = new Map<string, { count: number; schedule: ScheduleInfo }>();
  for (const m of location.monitors) {
    if (!m.schedule) continue;
    const key = [m.schedule.frequency, m.schedule.weekday, m.schedule.time_of_day, m.schedule.time_zone, m.schedule.queue_mode].join('|');
    const current = counts.get(key) ?? { count: 0, schedule: m.schedule };
    current.count += 1;
    counts.set(key, current);
  }
  const best = [...counts.values()].sort((a, b) => b.count - a.count)[0]?.schedule;
  if (best) return { frequency: best.frequency, weekday: best.weekday, time_of_day: best.time_of_day, time_zone: best.time_zone, queue_mode: best.queue_mode };
  return { frequency: 'monthly', weekday: DEFAULT_SCHEDULE_DAY, time_of_day: DEFAULT_SCHEDULE_TIME, time_zone: null, queue_mode: 'standard' };
}

/**
 * firstScanNow makes the new schedule due at once, so the worker runs the first scan (the keyword's
 * starting point) within about a minute and then moves next_run_at to the regular slot.
 */
function insertSchedule(db: Database.Database, fields: {
  series_id: string; keyword: string; target: string; center: string; grid_size: number; spacing_km: number; language: string;
}, schedule: ReturnType<typeof inheritedSchedule>, now: number, firstScanNow: boolean) {
  const timeZone = schedule.time_zone ?? timeZoneForCenter(fields.center) ?? 'America/New_York';
  const next = firstScanNow
    ? now
    : nextGridScheduleRun({ frequency: schedule.frequency, weekday: schedule.weekday, time_of_day: schedule.time_of_day, time_zone: timeZone }, now);
  db.prepare(`INSERT INTO grid_schedules
    (series_id, keyword, target, center, grid_size, spacing_km, language, queue_mode, frequency, weekday, time_of_day, time_zone, next_run_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(fields.series_id, fields.keyword, fields.target, fields.center, fields.grid_size, fields.spacing_km, fields.language,
      schedule.queue_mode, schedule.frequency, schedule.weekday, schedule.time_of_day, timeZone, next, now, now);
}

/**
 * Adds a keyword to a location by cloning the location's exact stored center, target, grid, spacing
 * and language (the most common configuration) into a new schedule. Refuses a keyword the location
 * already tracks. The first scan runs right away unless firstScanNow is false.
 */
export function addKeywordToLocation(
  projectId: string, locationId: string, rawKeyword: string, now = Date.now(), { firstScanNow = true } = {},
): NewKeywordResult {
  refuseDemoSchedule(projectId);
  const keyword = normalizeKeyword(rawKeyword);
  const location = requireLocation(projectId, locationId);
  if (location.monitors.length === 0) throw new LocationError('not_found', 'Location not found for this client.');
  if (!location.monitors.some((m) => m.schedule)) {
    throw new LocationError('invalid', 'This location only has one-time scans. Add the location again from the client page to start tracking it.');
  }
  const base = mostCommonConfigMonitor(location.monitors.filter((m) => m.schedule));
  const db = getDbForProject(projectId);
  const seriesId = gridSeriesId(keyword, base.center, base.grid_size, base.spacing_km, base.target, base.language);
  if (location.monitors.some((m) => m.keyword.trim().toLowerCase() === keyword.toLowerCase()) || seriesExists(db, seriesId)) {
    throw new LocationError('duplicate', `"${keyword}" is already tracked at this location.`);
  }
  db.transaction(() => {
    if (seriesExists(db, seriesId)) throw new LocationError('duplicate', `"${keyword}" is already tracked at this location.`);
    insertSchedule(db, {
      series_id: seriesId, keyword, target: base.target, center: base.center, grid_size: base.grid_size, spacing_km: base.spacing_km, language: base.language,
    }, inheritedSchedule(location), now, firstScanNow);
  })();
  return { series_id: seriesId, keyword };
}

export interface NewLocationInput {
  business: { name: string; cid?: string | null };
  center: { lat: number; lng: number };
  keywords: string[];
  grid_size?: number;
  spacing_km: number;
  language?: string;
  schedule?: LocationScheduleInput;
}

/** Adds a location to a client: one scheduled monitor per keyword. The first scans run right away unless firstScanNow is false. */
export function addLocation(
  projectId: string, input: NewLocationInput, now = Date.now(), { firstScanNow = true } = {},
): { locationId: string; series_ids: string[] } {
  const db = requireProject(projectId);
  refuseDemoSchedule(projectId);
  const name = input.business?.name?.trim();
  if (!name) throw new LocationError('invalid', 'Pick the business.');
  const cid = input.business.cid ? String(input.business.cid).trim() : '';
  if (cid && !/^\d+$/.test(cid)) throw new LocationError('invalid', 'The business ID is not valid.');
  const { lat, lng } = input.center ?? {};
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw new LocationError('invalid', 'Pick the map center.');
  const gridSize = input.grid_size ?? DEFAULT_GRID_SIZE;
  if (![3, 5, 7, 9, 11].includes(gridSize)) throw new LocationError('invalid', 'Grid must be 3, 5, 7, 9 or 11 points wide.');
  if (!Number.isFinite(input.spacing_km) || input.spacing_km <= 0 || input.spacing_km > 50) throw new LocationError('invalid', 'Radius is out of range.');
  const keywords: string[] = [];
  for (const raw of input.keywords) {
    const keyword = normalizeKeyword(raw);
    if (!keywords.some((k) => k.toLowerCase() === keyword.toLowerCase())) keywords.push(keyword);
  }
  if (keywords.length === 0) throw new LocationError('invalid', 'Add at least one keyword.');
  if (keywords.length > 25) throw new LocationError('invalid', 'Add at most 25 keywords at a time.');

  const target = cid ? formatBusinessTarget(name, cid) : name;
  const center = `${lat.toFixed(6)},${lng.toFixed(6)}`;
  const language = input.language?.trim() || 'English';
  const locationId = locationIdFor(projectId, target, center);
  if (listLocations(projectId).some((l) => l.id === locationId)) {
    throw new LocationError('duplicate', 'This location is already tracked for this client. Add keywords from its page.');
  }
  const schedule = input.schedule ? normalizeSchedule(input.schedule) : null;
  const inherited: ReturnType<typeof inheritedSchedule> = schedule
    ? { frequency: schedule.frequency, weekday: schedule.day, time_of_day: schedule.time_of_day, time_zone: null, queue_mode: schedule.queue_mode }
    : { frequency: 'monthly', weekday: DEFAULT_SCHEDULE_DAY, time_of_day: DEFAULT_SCHEDULE_TIME, time_zone: null, queue_mode: 'standard' };
  const seriesIds = keywords.map((keyword) => gridSeriesId(keyword, center, gridSize, input.spacing_km, target, language));
  db.transaction(() => {
    keywords.forEach((keyword, index) => {
      if (seriesExists(db, seriesIds[index])) throw new LocationError('duplicate', `"${keyword}" is already tracked here.`);
      insertSchedule(db, { series_id: seriesIds[index], keyword, target, center, grid_size: gridSize, spacing_km: input.spacing_km, language }, inherited, now, firstScanNow);
    });
  })();
  return { locationId, series_ids: seriesIds };
}

/**
 * Deletes a location: every keyword's runs (pins included) and schedules. Refuses while any keyword
 * has a scan running, queued, or possibly just claimed by the worker.
 */
export function deleteLocation(projectId: string, locationId: string, now = Date.now()): { runs: number; schedules: number } {
  const location = requireLocation(projectId, locationId);
  const db = getDbForProject(projectId);
  for (const monitor of location.monitors) {
    const busy = scanActivity(db, monitor, now);
    if (busy) throw new LocationError('scan_in_progress', `Can't delete while a scan is in progress ("${monitor.keyword}": ${busy}) Try again in a few minutes.`);
  }
  const deleteRuns = db.prepare('DELETE FROM grid_searches WHERE series_id = ?');
  const deleteSchedule = db.prepare('DELETE FROM grid_schedules WHERE series_id = ?');
  return db.transaction(() => {
    let runs = 0;
    let schedules = 0;
    for (const monitor of location.monitors) {
      // Re-check inside the transaction: the worker may have saved a pending run since.
      if (db.prepare(`SELECT 1 FROM grid_searches WHERE series_id = ? AND status = 'pending' LIMIT 1`).get(monitor.series_id)) {
        throw new LocationError('scan_in_progress', `Can't delete while a scan is in progress ("${monitor.keyword}"). Try again in a few minutes.`);
      }
      runs += deleteRuns.run(monitor.series_id).changes;
      schedules += deleteSchedule.run(monitor.series_id).changes;
    }
    return { runs, schedules };
  })();
}
