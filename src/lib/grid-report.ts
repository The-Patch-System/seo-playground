// Patch fork: read-only Geo-grid data for the reporting API (/api/v1/geo-grid/*).
// Reads every project, so one API call covers all clients. Field names mirror the
// Semrush Map Rank Tracker API where it helps (positions[], metrics, top competitors)
// so the reporting agent can swap sources with a thin adapter.
import { getProjects, getDbForProject, entryFromGridRow, type GridPoint, type GridSearchEntry, type Project } from './db';
import { parseTargetCid } from './grid-target';

const COLUMNS = 'id, ts, series_id, keyword, target, center, grid_size, spacing_km, language, cost, status, queue_mode';

type GridRow = Parameters<typeof entryFromGridRow>[0];
type GridRowWithResults = GridRow & { results: string | null };

interface ScheduleRow {
  series_id: string; frequency: string; weekday: number | null; time_of_day: string; time_zone: string; next_run_at: number;
}

function center(value: string) {
  const [lat, lng] = value.split(',').map(Number);
  return { lat, lng };
}

function businessOf(entry: GridSearchEntry) {
  const cid = parseTargetCid(entry.target);
  return {
    cid,
    name: entry.target.replace(/\s*\(cid:\s*\d+\)\s*$/i, '').trim(),
    // For a listing picked from the map search the grid is centered on the listing itself.
    coordinates: cid ? center(entry.center) : null,
  };
}

function summaryOf(entry: GridSearchEntry) {
  const s = entry.summary;
  if (!s) return null;
  return { visibility: s.ato, average_rank: s.avgRank, top3: s.top3Count, found: s.foundCount, total: s.totalPoints };
}

function pointCoords(entry: GridSearchEntry, point: GridPoint) {
  if (point.lat != null && point.lng != null) return { lat: point.lat, lng: point.lng };
  const c = center(entry.center);
  const half = Math.floor(entry.grid_size / 2);
  const latDeg = entry.spacing_km / 111.32;
  const lngDeg = entry.spacing_km / (111.32 * Math.cos(c.lat * Math.PI / 180));
  return { lat: c.lat + (half - point.row) * latDeg, lng: c.lng + (point.col - half) * lngDeg };
}

function scheduleOf(row: ScheduleRow | undefined) {
  if (!row) return null;
  return {
    frequency: row.frequency,
    day_of_week: row.frequency === 'weekly' ? row.weekday : null,
    day_of_month: row.frequency === 'monthly' ? row.weekday : null,
    time_of_day: row.time_of_day,
    time_zone: row.time_zone,
    next_run_at: new Date(row.next_run_at).toISOString(),
  };
}

function parsePoints(json: string | null): GridPoint[] {
  try { return JSON.parse(json ?? '[]') as GridPoint[]; } catch { return []; }
}

/** Same share-of-voice formula as the dashboard's visibility score: rank 1 = 100%, unranked = 0%. */
function shareOfVoice(ranks: Array<number | null>, total: number) {
  if (total === 0) return 0;
  return Math.round((ranks.reduce<number>((sum, rank) => sum + (21 - Math.min(rank ?? 21, 21)), 0) / (total * 20)) * 100);
}

function topCompetitors(points: GridPoint[], limit = 10) {
  const byBusiness = new Map<string, { title: string; domain: string | null; cid: string | null; rating: number | null; reviews: number | null; is_target: boolean; ranks: number[] }>();
  for (const point of points) {
    const seen = new Set<string>();
    for (const item of point.items ?? []) {
      const key = item.cid ?? item.title;
      if (seen.has(key)) continue;
      seen.add(key);
      const current = byBusiness.get(key) ?? {
        title: item.title, domain: item.domain ?? null, cid: item.cid ?? null,
        rating: item.rating_value ?? null, reviews: item.rating_votes ?? null, is_target: item.is_target, ranks: [],
      };
      current.ranks.push(item.rank_group);
      current.is_target ||= item.is_target;
      byBusiness.set(key, current);
    }
  }
  return [...byBusiness.values()]
    .map((b) => ({
      business: { cid: b.cid, name: b.title, domain: b.domain, rating: b.rating, reviews: b.reviews },
      is_target: b.is_target,
      average_position: Math.round((b.ranks.reduce((s, r) => s + r, 0) / b.ranks.length) * 10) / 10,
      share_of_voice: shareOfVoice(b.ranks, points.length),
      found_points: b.ranks.length,
    }))
    .sort((a, b) => b.share_of_voice - a.share_of_voice || a.average_position - b.average_position)
    .slice(0, limit);
}

function runHeader(project: Project, entry: GridSearchEntry) {
  return {
    run_id: entry.id,
    monitor_id: entry.series_id,
    run_at: new Date(entry.ts).toISOString(),
    status: entry.status,
    project: { id: project.id, name: project.name },
    keyword: entry.keyword,
    target: entry.target,
    business: businessOf(entry),
    center: center(entry.center),
    grid_size: entry.grid_size,
    spacing_km: entry.spacing_km,
    language: entry.language,
    cost: entry.cost ?? null,
    summary: summaryOf(entry),
  };
}

export function listMonitors(filter: { q?: string; cid?: string; project?: string } = {}) {
  const q = filter.q?.trim().toLowerCase();
  const monitors = [];
  for (const project of getProjects()) {
    if (filter.project && filter.project !== project.id) continue;
    const db = getDbForProject(project.id);
    const rows = db.prepare(`SELECT ${COLUMNS} FROM grid_searches ORDER BY ts DESC`).all() as GridRow[];
    const schedules = new Map((db.prepare('SELECT series_id, frequency, weekday, time_of_day, time_zone, next_run_at FROM grid_schedules').all() as ScheduleRow[])
      .map((row) => [row.series_id, row]));
    const bySeries = new Map<string, GridSearchEntry[]>();
    for (const row of rows) {
      const entry = entryFromGridRow(row);
      bySeries.set(entry.series_id, [...(bySeries.get(entry.series_id) ?? []), entry]);
    }
    for (const [seriesId, runs] of bySeries) {
      const first = runs[0];
      if (q && !`${first.keyword} ${first.target}`.toLowerCase().includes(q)) continue;
      if (filter.cid && parseTargetCid(first.target) !== filter.cid) continue;
      const latestDone = runs.find((run) => run.status === 'done');
      monitors.push({
        monitor_id: seriesId,
        project: { id: project.id, name: project.name },
        keyword: first.keyword,
        target: first.target,
        business: businessOf(first),
        center: center(first.center),
        grid_size: first.grid_size,
        spacing_km: first.spacing_km,
        language: first.language,
        schedule: scheduleOf(schedules.get(seriesId)),
        runs: runs.length,
        report_dates: runs.filter((run) => run.status === 'done').map((run) => new Date(run.ts).toISOString()).reverse(),
        latest_run: latestDone ? getRun(latestDone.id, project.id, { points: false }) : null,
      });
    }
  }
  return monitors;
}

function findRow(runId: string, projectId?: string): { project: Project; row: GridRowWithResults } | null {
  for (const project of getProjects()) {
    if (projectId && projectId !== project.id) continue;
    const row = getDbForProject(project.id).prepare(`SELECT ${COLUMNS}, results FROM grid_searches WHERE id = ?`).get(runId) as GridRowWithResults | undefined;
    if (row) return { project, row };
  }
  return null;
}

function previousDonePoints(project: Project, entry: GridSearchEntry): GridPoint[] | null {
  const row = getDbForProject(project.id)
    .prepare("SELECT results FROM grid_searches WHERE series_id = ? AND ts < ? AND status = 'done' ORDER BY ts DESC LIMIT 1")
    .get(entry.series_id, entry.ts) as { results: string | null } | undefined;
  return row ? parsePoints(row.results) : null;
}

export function getRun(runId: string, projectId?: string, options: { points?: boolean; competitors?: boolean } = {}) {
  const { points: includePoints = true, competitors: includeCompetitors = true } = options;
  const found = findRow(runId, projectId);
  if (!found) return null;
  const entry = entryFromGridRow(found.row);
  const header = runHeader(found.project, entry);
  if (!includePoints) return header;
  const points = parsePoints(found.row.results);
  const previous = previousDonePoints(found.project, entry);
  const previousRank = new Map((previous ?? []).map((p) => [`${p.row}:${p.col}`, p.rank]));
  return {
    ...header,
    previous_run_compared: previous !== null,
    points: points.map((point) => ({
      row: point.row,
      col: point.col,
      ...pointCoords(entry, point),
      rank: point.rank,
      ...(includeCompetitors ? {
        results: (point.items ?? []).map((item) => ({
          rank: item.rank_group, title: item.title, domain: item.domain ?? null, cid: item.cid ?? null,
          rating: item.rating_value ?? null, reviews: item.rating_votes ?? null, is_target: item.is_target,
        })),
      } : {}),
    })),
    // Semrush MRT heatmap shape: position omitted when not in the top 20; diff < 0 = improved.
    positions: points.map((point) => {
      const before = previousRank.get(`${point.row}:${point.col}`);
      return {
        point: { id: `r${point.row}c${point.col}`, coordinates: pointCoords(entry, point) },
        ...(point.rank != null ? { position: point.rank } : {}),
        ...(point.rank != null && before != null ? { diff: point.rank - before } : {}),
      };
    }),
    top_competitors: topCompetitors(points),
  };
}

export function getMonitorRuns(monitorId: string, projectId?: string) {
  for (const project of getProjects()) {
    if (projectId && projectId !== project.id) continue;
    const rows = getDbForProject(project.id).prepare(`SELECT ${COLUMNS}, results FROM grid_searches WHERE series_id = ? ORDER BY ts DESC`).all(monitorId) as GridRowWithResults[];
    if (!rows.length) continue;
    const runs = rows.map((row) => runHeader(project, entryFromGridRow(row)));
    const done = runs.filter((run) => run.status === 'done' && run.summary).reverse();
    return {
      runs,
      // Semrush MRT metrics shape, keyed by ISO date (oldest first).
      metrics: {
        average_positions: Object.fromEntries(done.map((run) => [run.run_at, run.summary!.average_rank])),
        share_of_voices: Object.fromEntries(done.map((run) => [run.run_at, run.summary!.visibility])),
      },
    };
  }
  return null;
}
