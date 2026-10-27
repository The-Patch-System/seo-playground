// Patch fork: create a monitor (and optionally import past runs) without running a scan.
// Used to move Semrush Map Rank Tracker campaigns over: one call per location sets up the
// monthly schedule and copies the starting-point scan plus recent history.
import {
  createProject, getProjects, gridSeriesId, pinGridRunForProject, saveGridSchedule, saveImportedGridRunForProject,
  type GridPoint, type GridSearchEntry,
} from './db';
import { formatBusinessTarget } from './grid-target';
import { DEFAULT_GRID_SIZE, DEFAULT_RADIUS_MI, DEFAULT_SCHEDULE_DAY, DEFAULT_SCHEDULE_TIME, spacingKmForRadius } from './grid-radius';
import { timeZoneForCenter } from './grid-timezone';

export interface ImportRunInput {
  run_at: string;
  pinned?: boolean;
  points: Array<{ row: number; col: number; lat?: number; lng?: number; rank: number | null }>;
}

/** A project by id, or by client (found by domain, created if missing). */
export type MonitorProjectInput = string | { name: string; domain: string };

export interface CreateMonitorInput {
  project?: MonitorProjectInput;
  keyword: string;
  business: { name: string; cid?: string | null };
  center: { lat: number; lng: number };
  grid_size?: number;
  radius_mi?: number;
  spacing_km?: number;
  language?: string;
  schedule?: false | { day_of_month?: number; time_of_day?: string };
  runs?: ImportRunInput[];
}

export class MonitorInputError extends Error {}

function fail(message: string): never {
  throw new MonitorInputError(message);
}

function validRank(rank: unknown): number | null {
  if (rank === null || rank === undefined) return null;
  const value = Number(rank);
  // Anything outside the top 20 is stored like a scan's "not found": null, shown as "20+".
  return Number.isInteger(value) && value >= 1 && value <= 20 ? value : null;
}

function bareDomain(domain: string): string {
  return domain.toLowerCase().trim().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
}

/** One project per client website, so a multi-location clinic's monitors sit together. */
function resolveProjectId(project: MonitorProjectInput | undefined, center: { lat: number; lng: number }): string {
  const projects = getProjects();
  if (project === undefined || typeof project === 'string') {
    const projectId = project ?? projects[0]?.id ?? 'default';
    if (!projects.some((existing) => existing.id === projectId)) fail(`Unknown project "${projectId}".`);
    return projectId;
  }
  const name = project.name?.trim();
  const domain = bareDomain(project.domain ?? '');
  if (!name || !domain) fail('project.name and project.domain are required.');
  const existing = projects.find((candidate) => bareDomain(candidate.domain) === domain);
  if (existing) return existing.id;
  return createProject({
    name, domain, defaultLocation: 'United States', defaultLanguage: 'English',
    defaultCoordinates: `${center.lat},${center.lng}`, rankTrackerDepth: '100',
  }).id;
}

export function createMonitor(input: CreateMonitorInput) {

  const keyword = input.keyword?.trim();
  if (!keyword) fail('keyword is required.');
  const name = input.business?.name?.trim();
  if (!name) fail('business.name is required.');
  const cid = input.business.cid ? String(input.business.cid).trim() : '';
  if (cid && !/^\d+$/.test(cid)) fail('business.cid must be the numeric Google CID.');
  const { lat, lng } = input.center ?? {};
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) fail('center.lat and center.lng are required.');

  const gridSize = input.grid_size ?? DEFAULT_GRID_SIZE;
  if (![3, 5, 7, 9, 11].includes(gridSize)) fail('grid_size must be 3, 5, 7, 9 or 11.');
  const spacingKm = input.spacing_km ?? spacingKmForRadius(input.radius_mi ?? DEFAULT_RADIUS_MI, gridSize);
  if (!Number.isFinite(spacingKm) || spacingKm <= 0 || spacingKm > 50) fail('radius_mi / spacing_km is out of range.');

  const projectId = resolveProjectId(input.project, { lat, lng });
  const language = input.language?.trim() || 'English';
  const centerText = `${lat.toFixed(6)},${lng.toFixed(6)}`;
  const target = cid ? formatBusinessTarget(name, cid) : name;
  const seriesId = gridSeriesId(keyword, centerText, gridSize, spacingKm, target, language);

  let schedule = null;
  if (input.schedule !== false) {
    const day = input.schedule?.day_of_month ?? DEFAULT_SCHEDULE_DAY;
    if (!Number.isInteger(day) || day < 1 || day > 28) fail('schedule.day_of_month must be 1-28.');
    schedule = saveGridSchedule({
      series_id: seriesId, keyword, target, center: centerText, grid_size: gridSize, spacing_km: spacingKm, language,
      queue_mode: 'standard', frequency: 'monthly', weekday: day,
      time_of_day: input.schedule?.time_of_day ?? DEFAULT_SCHEDULE_TIME,
      time_zone: timeZoneForCenter(centerText) ?? 'America/New_York',
    }, projectId);
  }

  const imported: string[] = [];
  let pinnedId: string | null = null;
  const total = gridSize * gridSize;
  for (const run of input.runs ?? []) {
    const ts = Date.parse(run.run_at);
    if (!Number.isFinite(ts)) fail(`Invalid run_at "${run.run_at}".`);
    if (!Array.isArray(run.points) || run.points.length === 0 || run.points.length > total) {
      fail(`Run ${run.run_at} needs between 1 and ${total} points.`);
    }
    const points: GridPoint[] = run.points.map((point) => {
      if (!Number.isInteger(point.row) || !Number.isInteger(point.col) || point.row < 0 || point.col < 0 || point.row >= gridSize || point.col >= gridSize) {
        fail(`Run ${run.run_at} has a point outside the ${gridSize}x${gridSize} grid.`);
      }
      return {
        row: point.row, col: point.col,
        ...(Number.isFinite(point.lat) && Number.isFinite(point.lng) ? { lat: point.lat, lng: point.lng } : {}),
        rank: validRank(point.rank), items: [],
      };
    });
    // Same id on every import of the same scan, so re-running an import never duplicates runs.
    const id = `import-${seriesId.slice(5)}-${ts}`;
    const entry: GridSearchEntry = {
      id, series_id: seriesId, ts, keyword, target, center: centerText, grid_size: gridSize, spacing_km: spacingKm,
      language, status: 'done', queue_mode: 'standard',
    };
    saveImportedGridRunForProject(projectId, entry, points, run.pinned === true);
    imported.push(id);
    if (run.pinned === true) pinnedId = id;
  }
  // One starting-point map per monitor: a re-import that pins a different scan replaces the old pin.
  if (pinnedId) pinGridRunForProject(projectId, pinnedId);

  return { monitor_id: seriesId, project: projectId, target, center: centerText, grid_size: gridSize, spacing_km: spacingKm, schedule, imported_runs: imported };
}
