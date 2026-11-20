// Patch fork: location grouping, location writes and view models for the location-based Geo-grid UI.
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grid-locations-test-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');

import {
  claimDueGridSchedules, createProject, getDbForProject, gridSeriesId, saveGridSchedule, saveGridSearch, saveGridSearchPendingForProject,
  saveImportedGridRunForProject, type GridPoint, type GridSearchEntry,
} from './db';
import { createMonitor } from './grid-import';
import { getMonitorRuns, listMonitors } from './grid-report';
import {
  addKeywordToLocation, addLocation, centerKey, deleteLocation, getKeywordData, getLocation, listClients, listLocations,
  listLocationsWithLatest, locationIdFor, LocationError, MAX_KEYWORD_RUNS, requestRunNow, updateLocationSchedule,
} from './grid-locations-db';
import {
  compareKpis, computeCompetitorRows, computeKpis, computeRings, deltaLower, describeSchedule, formatScanDate,
  locationStatus, rankLabel, resolveCompare, sharedGridConfig, competitorPoints, pointMoves, trendBars,
} from './grid-locations';

afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 20, 15);
const CID = '7380112684083592032';
let seq = 0;

function project(name = `Client ${++seq}`) {
  return createProject({ name, domain: `client-${seq}-${Math.random().toString(36).slice(2)}.com`, defaultLocation: '', defaultLanguage: 'English', defaultCoordinates: '', rankTrackerDepth: '100' }).id;
}

function points(rank: (i: number) => number | null, size = 9, extra: (i: number) => Partial<GridPoint> = () => ({})): GridPoint[] {
  return Array.from({ length: size * size }, (_, i) => ({ row: Math.floor(i / size), col: i % size, rank: rank(i), items: [], ...extra(i) }));
}

function seedRun(projectId: string, fields: { keyword: string; target: string; center: string; grid_size?: number; spacing_km?: number; ts: number; pinned?: boolean; pts?: GridPoint[]; scheduled?: boolean }) {
  const grid = fields.grid_size ?? 9;
  const spacing = fields.spacing_km ?? 2.0117;
  const series = gridSeriesId(fields.keyword, fields.center, grid, spacing, fields.target, 'English');
  const entry: GridSearchEntry = {
    id: `run-${++seq}`, series_id: series, ts: fields.ts, keyword: fields.keyword, target: fields.target, center: fields.center,
    grid_size: grid, spacing_km: spacing, language: 'English', status: 'done', queue_mode: 'standard',
  };
  saveImportedGridRunForProject(projectId, entry, fields.pts ?? points(() => 5, grid), fields.pinned);
  if (fields.scheduled) {
    saveGridSchedule({
      series_id: series, keyword: fields.keyword, target: fields.target, center: fields.center, grid_size: grid, spacing_km: spacing, language: 'English',
      queue_mode: 'standard', frequency: 'monthly', weekday: 15, time_of_day: '12:00', time_zone: 'America/New_York',
    }, projectId);
  }
  return { series, runId: entry.id };
}

/** The reporting API's view of a project, for contract checks. */
function apiSnapshot(projectId: string) {
  const monitors = listMonitors({ project: projectId }).map((m) => ({ ...m, schedule: null }));
  const runs = monitors.map((m) => getMonitorRuns(m.monitor_id, projectId));
  return JSON.stringify({ monitors, runs });
}

describe('location grouping and IDs', () => {
  it('groups CID targets by CID and rounded center, regardless of name or formatting', () => {
    const p = project();
    seedRun(p, { keyword: 'physical therapy', target: `Core Values PT (cid:${CID})`, center: '28.478970,-81.307302', ts: NOW - 30 * DAY });
    seedRun(p, { keyword: 'dry needling', target: `Core Values Physical Therapy (cid:${CID})`, center: '28.47897,-81.307302', ts: NOW - 20 * DAY });
    // A second location for the same client.
    seedRun(p, { keyword: 'physical therapy', target: 'Core Values Lakeview', center: '28.6,-81.4', ts: NOW - 10 * DAY });
    const locations = listLocations(p);
    expect(locations).toHaveLength(2);
    expect(locations[0].monitors.map((m) => m.keyword)).toEqual(['dry needling', 'physical therapy']);
    expect(locations[0].number).toBe(1);
    expect(locations[1].number).toBe(2);
    expect(locations[0].cid).toBe(CID);
    expect(locations[0].name).not.toMatch(/cid/);
  });

  it('keeps IDs stable across center formatting variants and versioned', () => {
    expect(centerKey('40.7128,-74.006')).toBe(centerKey('40.712800, -74.006000'));
    expect(centerKey('0.00001,1')).toBe('0.0000,1.0000');
    const a = locationIdFor('p1', `X (cid:${CID})`, '40.7128,-74.006');
    expect(a).toMatch(/^v1-[0-9a-f]{12}$/);
    expect(locationIdFor('p1', `Renamed (cid:${CID})`, '40.712800,-74.006000')).toBe(a);
    // Non-CID targets match on the trimmed, lowercased text.
    expect(locationIdFor('p1', '  Spine Co ', '1,2')).toBe(locationIdFor('p1', 'spine co', '1,2'));
    // Same business in another project is another location.
    expect(locationIdFor('p2', `X (cid:${CID})`, '40.7128,-74.006')).not.toBe(a);
    // ~11 m apart rounds apart only past the 4th decimal.
    expect(locationIdFor('p1', `X (cid:${CID})`, '40.71284,-74.006')).toBe(a);
    expect(locationIdFor('p1', `X (cid:${CID})`, '40.7130,-74.006')).not.toBe(a);
  });

  it('holds mixed grid configurations in one location and reports them as mixed', () => {
    const p = project();
    const target = `Mixed Clinic (cid:111)`;
    seedRun(p, { keyword: 'a', target, center: '30,-90', grid_size: 9, spacing_km: 2.0117, ts: NOW - 5 * DAY, scheduled: true });
    seedRun(p, { keyword: 'b', target, center: '30,-90', grid_size: 7, spacing_km: 4.0234, ts: NOW - 4 * DAY, pts: points(() => 4, 7), scheduled: true });
    seedRun(p, { keyword: 'c', target, center: '30,-90', grid_size: 9, spacing_km: 2.0117, ts: NOW - 3 * DAY, scheduled: true });
    const [location] = listLocations(p);
    expect(location.monitors).toHaveLength(3);
    expect(sharedGridConfig(location.monitors)).toEqual({ mixed: true, gridSize: null, radiusMi: null });
    // A new keyword copies the most common configuration (9x9 at 5 mi).
    const added = addKeywordToLocation(p, location.id, 'd', NOW);
    const row = getDbForProject(p).prepare('SELECT grid_size, spacing_km, center, target FROM grid_schedules WHERE series_id = ?').get(added.series_id);
    expect(row).toEqual({ grid_size: 9, spacing_km: 2.0117, center: '30,-90', target });
  });

  it('lists clients with location and keyword counts', () => {
    const p = project('Zeta Rehab');
    seedRun(p, { keyword: 'a', target: 'Zeta (cid:1)', center: '1,1', ts: NOW });
    seedRun(p, { keyword: 'b', target: 'Zeta (cid:1)', center: '1,1', ts: NOW });
    seedRun(p, { keyword: 'a', target: 'Zeta (cid:2)', center: '2,2', ts: NOW });
    const client = listClients().find((c) => c.project.id === p)!;
    expect(client).toMatchObject({ locations: 2, keywords: 3, lastScanAt: NOW });
  });

  it('reads only the latest two finished runs per keyword on the client page', () => {
    const p = project();
    for (let i = 0; i < 5; i += 1) seedRun(p, { keyword: 'pt', target: 'Five (cid:5)', center: '5,5', ts: NOW - i * 30 * DAY });
    const [location] = listLocationsWithLatest(p);
    expect(location.monitors[0].latestRuns.map((r) => r.ts)).toEqual([NOW, NOW - 30 * DAY]);
    expect(location.monitors[0].doneRuns).toBe(5);
  });

  it('caps keyword history at the last 24 runs but loads an explicitly requested older one', () => {
    const p = project();
    let first = '';
    for (let i = 0; i < 30; i += 1) {
      const { runId } = seedRun(p, { keyword: 'pt', target: 'Many (cid:6)', center: '6,6', ts: NOW - i * DAY });
      if (i === 29) first = runId;
    }
    const [location] = listLocations(p);
    const data = getKeywordData(p, location.id, location.monitors[0].series_id);
    expect(data.runs).toHaveLength(MAX_KEYWORD_RUNS);
    expect(data.headers).toHaveLength(30);
    const withOld = getKeywordData(p, location.id, location.monitors[0].series_id, [first]);
    expect(withOld.runs.map((r) => r.id)).toContain(first);
  });
});

describe('project safety', () => {
  it('rejects a location, keyword or run from another project', () => {
    const a = project();
    const b = project();
    const { series, runId } = seedRun(a, { keyword: 'pt', target: 'Alpha (cid:10)', center: '10,10', ts: NOW });
    seedRun(b, { keyword: 'pt', target: 'Beta (cid:11)', center: '11,11', ts: NOW });
    const locA = listLocations(a)[0];
    const locB = listLocations(b)[0];
    expect(getLocation(b, locA.id)).toBeNull();
    expect(() => getKeywordData(b, locA.id, series)).toThrow(LocationError);
    expect(() => getKeywordData(b, locB.id, series)).toThrow(/not found/i);
    expect(() => requestRunNow(b, locA.id, null, NOW)).toThrow(LocationError);
    expect(() => deleteLocation(b, locA.id, NOW)).toThrow(LocationError);
    expect(() => updateLocationSchedule(b, locA.id, { frequency: 'monthly', day: 1, time_of_day: '09:00', queue_mode: 'standard' }, NOW)).toThrow(LocationError);
    expect(() => listLocations('no-such-project')).toThrow(/Client not found/);
    // A run ID from project A can't be pulled through project B's keyword.
    const otherKw = listLocations(b)[0].monitors[0].series_id;
    expect(getKeywordData(b, locB.id, otherKw, [runId]).runs.map((r) => r.id)).not.toContain(runId);
  });
});

describe('location schedule', () => {
  function scheduledLocation() {
    const p = project();
    const m1 = createMonitor({ project: p, keyword: 'physical therapy', business: { name: 'Sched PT', cid: '20' }, center: { lat: 40.7128, lng: -74.006 } });
    createMonitor({ project: p, keyword: 'dry needling', business: { name: 'Sched PT', cid: '20' }, center: { lat: 40.7128, lng: -74.006 } });
    const [location] = listLocations(p);
    return { p, location, series: m1.monitor_id };
  }
  const rows = (p: string) => getDbForProject(p).prepare('SELECT series_id, frequency, weekday, time_of_day, queue_mode, next_run_at FROM grid_schedules ORDER BY series_id').all() as Array<{ next_run_at: number; queue_mode: string; weekday: number }>;

  it('keeps next_run_at on a no-op or queue-only save', () => {
    const { p, location } = scheduledLocation();
    const before = rows(p);
    expect(updateLocationSchedule(p, location.id, { frequency: 'monthly', day: 15, time_of_day: '12:00', queue_mode: 'standard' }, NOW + DAY)).toEqual({ updated: 0, created: 0, oneTime: 0, rescheduled: 0 });
    expect(rows(p)).toEqual(before);
    const queueOnly = updateLocationSchedule(p, location.id, { frequency: 'monthly', day: 15, time_of_day: '12:00', queue_mode: 'priority' }, NOW + DAY);
    expect(queueOnly).toEqual({ updated: 2, created: 0, oneTime: 0, rescheduled: 0 });
    expect(rows(p).map((r) => r.next_run_at)).toEqual(before.map((r) => r.next_run_at));
    expect(rows(p).every((r) => r.queue_mode === 'priority')).toBe(true);
  });

  it('recalculates next_run_at for every keyword when the timing changes', () => {
    const { p, location } = scheduledLocation();
    const result = updateLocationSchedule(p, location.id, { frequency: 'monthly', day: 1, time_of_day: '09:00', queue_mode: 'standard' }, NOW);
    expect(result).toEqual({ updated: 2, created: 0, oneTime: 0, rescheduled: 2 });
    for (const row of rows(p)) {
      expect(row.weekday).toBe(1);
      // Dec 1, 2026 09:00 New York.
      expect(row.next_run_at).toBe(Date.UTC(2026, 11, 1, 14));
    }
  });

  it('never turns a one-time scan (e.g. a sales demo) into a schedule', () => {
    const p = project();
    seedRun(p, { keyword: 'pt', target: 'Demo (cid:21)', center: '32.894142,-97.269099', ts: NOW - DAY });
    const [location] = listLocations(p);
    expect(locationStatus(location.monitors).label).toBe('One-time scan');
    expect(() => updateLocationSchedule(p, location.id, { frequency: 'monthly', day: 15, time_of_day: '12:00', queue_mode: 'standard' }, NOW)).toThrow(/one-time/);
    expect(() => addKeywordToLocation(p, location.id, 'chiro', NOW)).toThrow(/one-time/);
    expect(requestRunNow(p, location.id, null, NOW).queued).toEqual([]);
    expect(getDbForProject(p).prepare('SELECT COUNT(*) AS n FROM grid_schedules').get()).toEqual({ n: 0 });
  });

  it('leaves a one-time keyword alone when the rest of the location is scheduled', () => {
    const p = project();
    createMonitor({ project: p, keyword: 'pt', business: { name: 'Part', cid: '22' }, center: { lat: 40, lng: -75 } });
    const { series } = seedRun(p, { keyword: 'demo kw', target: 'Part (cid:22)', center: '40.000000,-75.000000', ts: NOW - DAY });
    const [location] = listLocations(p);
    expect(location.monitors).toHaveLength(2);
    expect(updateLocationSchedule(p, location.id, { frequency: 'monthly', day: 1, time_of_day: '09:00', queue_mode: 'standard' }, NOW)).toMatchObject({ updated: 1, oneTime: 1, created: 0 });
    expect(getDbForProject(p).prepare('SELECT 1 FROM grid_schedules WHERE series_id = ?').get(series)).toBeUndefined();
  });

  it('rejects invalid input', () => {
    const { p, location } = scheduledLocation();
    expect(() => updateLocationSchedule(p, location.id, { frequency: 'monthly', day: 31, time_of_day: '12:00', queue_mode: 'standard' }, NOW)).toThrow(/1-28/);
    expect(() => updateLocationSchedule(p, location.id, { frequency: 'monthly', day: 1, time_of_day: '25:00', queue_mode: 'standard' }, NOW)).toThrow(/HH:MM/);
  });

  it('a save while the worker holds a claim leaves the claimed scan alone and does not re-trigger it', () => {
    const { p, location } = scheduledLocation();
    // Make both keywords due and let the worker claim them.
    getDbForProject(p).prepare('UPDATE grid_schedules SET next_run_at = ?').run(NOW - 1000);
    const claimed = claimDueGridSchedules(NOW).filter((c) => c.projectId === p);
    expect(claimed).toHaveLength(2);
    updateLocationSchedule(p, location.id, { frequency: 'monthly', day: 2, time_of_day: '08:00', queue_mode: 'standard' }, NOW + 1000);
    expect(claimDueGridSchedules(NOW + 2000).filter((c) => c.projectId === p)).toHaveLength(0);
    expect(rows(p).every((r) => r.next_run_at > NOW)).toBe(true);
  });
});

describe('run now', () => {
  it('queues once: a second click finds it already due, and the worker claims it once', () => {
    const p = project();
    const m = createMonitor({ project: p, keyword: 'pt', business: { name: 'Run PT', cid: '30' }, center: { lat: 40, lng: -75 } });
    const [location] = listLocations(p);
    // Created long ago, so it's not "just changed".
    getDbForProject(p).prepare('UPDATE grid_schedules SET created_at = ?, updated_at = ?').run(NOW - 10 * DAY, NOW - 5 * DAY);
    const regular = getDbForProject(p).prepare('SELECT next_run_at FROM grid_schedules').get() as { next_run_at: number };
    expect(requestRunNow(p, location.id, m.monitor_id, NOW).queued).toEqual([m.monitor_id]);
    const second = requestRunNow(p, location.id, m.monitor_id, NOW + 500);
    expect(second.queued).toEqual([]);
    expect(second.skipped[0].reason).toMatch(/queued/);
    const claims = claimDueGridSchedules(NOW + 1000).filter((c) => c.projectId === p);
    expect(claims).toHaveLength(1);
    expect(claimDueGridSchedules(NOW + 2000).filter((c) => c.projectId === p)).toHaveLength(0);
    // The claim puts the regular monthly slot back.
    expect(claims[0].next_run_at).toBe(regular.next_run_at);
  });

  it('allows Run now right after a keyword is added, but not while the worker may be posting', () => {
    const p = project();
    seedRun(p, { keyword: 'pt', target: 'Fresh (cid:31)', center: '40,-75', ts: NOW - 40 * DAY, scheduled: true });
    const [location] = listLocations(p);
    const added = addKeywordToLocation(p, location.id, 'dry needling', NOW);
    expect(requestRunNow(p, location.id, added.series_id, NOW + 1000).queued).toEqual([added.series_id]);
    // Claimed (updated_at stamped) but the pending run isn't saved yet.
    claimDueGridSchedules(NOW + 2000);
    const again = requestRunNow(p, location.id, added.series_id, NOW + 3000);
    expect(again.queued).toEqual([]);
    expect(again.skipped[0].reason).toMatch(/starting/);
  });

  it('skips unscheduled and already-scanning keywords in Run all', () => {
    const p = project();
    createMonitor({ project: p, keyword: 'base', business: { name: 'All', cid: '32' }, center: { lat: 40, lng: -75 } });
    const { series: unscheduled } = seedRun(p, { keyword: 'old', target: 'All (cid:32)', center: '40.000000,-75.000000', ts: NOW - 40 * DAY });
    getDbForProject(p).prepare('UPDATE grid_schedules SET created_at = ?, updated_at = ?').run(NOW - 10 * DAY, NOW - 5 * DAY);
    const [location] = listLocations(p);
    const base = location.monitors.find((m) => m.keyword === 'base')!.series_id;
    const scanning = addKeywordToLocation(p, location.id, 'scanning', NOW - DAY);
    const ok = addKeywordToLocation(p, location.id, 'ok', NOW - DAY);
    const entry: GridSearchEntry = {
      id: 'pending-1', series_id: scanning.series_id, ts: NOW - 60_000, keyword: 'scanning', target: 'All (cid:32)', center: '40,-75',
      grid_size: 9, spacing_km: 2.0117, language: 'English', status: 'pending', queue_mode: 'standard',
    };
    saveGridSearchPendingForProject(p, entry, []);
    const result = requestRunNow(p, location.id, null, NOW);
    expect(result.queued.sort()).toEqual([base, ok.series_id].sort());
    expect(result.skipped.map((s) => s.series_id).sort()).toEqual([scanning.series_id, unscheduled].sort());
    expect(result.skipped.find((s) => s.series_id === unscheduled)!.reason).toMatch(/Not scheduled/);
  });
});

describe('add keyword and location', () => {
  it('clones the exact stored fields and refuses duplicates', () => {
    const p = project();
    const target = `Clone PT (cid:${CID})`;
    seedRun(p, { keyword: 'Physical Therapy', target, center: '28.478970,-81.307302', ts: NOW - DAY, scheduled: true });
    const [location] = listLocations(p);
    const added = addKeywordToLocation(p, location.id, '  sports   rehab ', NOW);
    expect(added.keyword).toBe('sports rehab');
    expect(added.series_id).toBe(gridSeriesId('sports rehab', '28.478970,-81.307302', 9, 2.0117, target, 'English'));
    const sched = getDbForProject(p).prepare('SELECT * FROM grid_schedules WHERE series_id = ?').get(added.series_id) as Record<string, unknown>;
    expect(sched).toMatchObject({ center: '28.478970,-81.307302', target, grid_size: 9, spacing_km: 2.0117, language: 'English', frequency: 'monthly', weekday: 15, time_of_day: '12:00', time_zone: 'America/New_York' });
    expect(() => addKeywordToLocation(p, location.id, 'physical therapy', NOW)).toThrow(/already tracked/);
    expect(() => addKeywordToLocation(p, location.id, 'sports rehab', NOW)).toThrow(/already tracked/);
    expect(() => addKeywordToLocation(p, location.id, '   ', NOW)).toThrow(/Enter a keyword/);
    // The new keyword stays in the same location.
    expect(listLocations(p)).toHaveLength(1);
    expect(listLocations(p)[0].monitors).toHaveLength(2);
  });

  it('inherits the location schedule', () => {
    const p = project();
    createMonitor({ project: p, keyword: 'pt', business: { name: 'Inherit', cid: '40' }, center: { lat: 40, lng: -75 }, schedule: { day_of_month: 3, time_of_day: '07:30' } });
    const [location] = listLocations(p);
    const added = addKeywordToLocation(p, location.id, 'chiro', NOW);
    expect(getDbForProject(p).prepare('SELECT frequency, weekday, time_of_day FROM grid_schedules WHERE series_id = ?').get(added.series_id))
      .toEqual({ frequency: 'monthly', weekday: 3, time_of_day: '07:30' });
  });

  it('adds a location with one scheduled keyword per keyword and refuses it twice', () => {
    const p = project();
    const created = addLocation(p, { business: { name: 'New Spot', cid: '50' }, center: { lat: 33.4484, lng: -112.074 }, keywords: ['pt', 'PT', 'dry needling'], spacing_km: 2.0117 }, NOW);
    expect(created.series_ids).toHaveLength(2);
    const location = getLocation(p, created.locationId)!;
    expect(location.monitors.map((m) => m.keyword)).toEqual(['dry needling', 'pt']);
    expect(location.monitors.every((m) => m.schedule?.time_zone === 'America/Phoenix')).toBe(true);
    expect(() => addLocation(p, { business: { name: 'New Spot', cid: '50' }, center: { lat: 33.4484, lng: -112.074 }, keywords: ['x'], spacing_km: 2.0117 }, NOW)).toThrow(/already tracked/);
    expect(() => addLocation(p, { business: { name: 'Bad', cid: 'abc' }, center: { lat: 1, lng: 1 }, keywords: ['x'], spacing_km: 2 }, NOW)).toThrow(LocationError);
  });
});

describe('delete location', () => {
  it('refuses while a scan is pending, then deletes every keyword, run, pin and schedule', () => {
    const p = project();
    const m = createMonitor({ project: p, keyword: 'pt', business: { name: 'Del', cid: '60' }, center: { lat: 40, lng: -75 },
      runs: [{ run_at: new Date(NOW - 60 * DAY).toISOString(), pinned: true, points: points(() => 3).map(({ row, col, rank }) => ({ row, col, rank })) }] });
    getDbForProject(p).prepare('UPDATE grid_schedules SET created_at = ?, updated_at = ?').run(NOW - 10 * DAY, NOW - 5 * DAY);
    const other = seedRun(p, { keyword: 'keep', target: 'Other (cid:61)', center: '41,-75', ts: NOW - DAY });
    const [location] = listLocations(p).filter((l) => l.cid === '60');
    const entry: GridSearchEntry = {
      id: 'pending-del', series_id: m.monitor_id, ts: NOW - 30 * 60_000, keyword: 'pt', target: m.target, center: m.center,
      grid_size: 9, spacing_km: m.spacing_km, language: 'English', status: 'pending', queue_mode: 'standard',
    };
    saveGridSearchPendingForProject(p, entry, []);
    expect(() => deleteLocation(p, location.id, NOW)).toThrow(/scan is in progress/);
    getDbForProject(p).prepare("UPDATE grid_searches SET status = 'done' WHERE id = 'pending-del'").run();
    expect(deleteLocation(p, location.id, NOW)).toEqual({ runs: 2, schedules: 1 });
    expect(listLocations(p).map((l) => l.cid)).toEqual(['61']);
    expect(listMonitors({ project: p }).map((x) => x.monitor_id)).toEqual([other.series]);
  });

  it('refuses while a scan is due to be claimed', () => {
    const p = project();
    createMonitor({ project: p, keyword: 'pt', business: { name: 'Due', cid: '62' }, center: { lat: 40, lng: -75 } });
    getDbForProject(p).prepare('UPDATE grid_schedules SET next_run_at = ?, created_at = ?, updated_at = ?').run(NOW - 1, NOW - DAY, NOW - DAY);
    const [location] = listLocations(p);
    expect(() => deleteLocation(p, location.id, NOW)).toThrow(LocationError);
  });
});

describe('reporting API contract', () => {
  it('UI actions leave monitors, runs, pins and MRT averages byte-identical apart from schedules', () => {
    const p = project();
    const m = createMonitor({ project: p, keyword: 'physical therapy', business: { name: 'Contract', cid: '70' }, center: { lat: 40, lng: -75 },
      runs: [
        { run_at: new Date(NOW - 60 * DAY).toISOString(), pinned: true, points: points((i) => (i % 3) + 1).map(({ row, col, rank }) => ({ row, col, rank })) },
        { run_at: new Date(NOW - 30 * DAY).toISOString(), points: points((i) => (i % 25) + 1).map(({ row, col, rank }) => ({ row, col, rank })) },
      ] });
    getDbForProject(p).prepare('UPDATE grid_schedules SET created_at = ?, updated_at = ?').run(NOW - 10 * DAY, NOW - 5 * DAY);
    const before = apiSnapshot(p);
    const [location] = listLocations(p);
    updateLocationSchedule(p, location.id, { frequency: 'monthly', day: 1, time_of_day: '09:00', queue_mode: 'priority' }, NOW);
    requestRunNow(p, location.id, m.monitor_id, NOW + 10 * 60_000);
    getKeywordData(p, location.id, m.monitor_id);
    listLocationsWithLatest(p);
    // Adding a keyword adds a monitor; the existing ones stay the same.
    const added = addKeywordToLocation(p, location.id, 'chiropractor', NOW);
    const after = JSON.parse(apiSnapshot(p)) as { monitors: Array<{ monitor_id: string }>; runs: unknown[] };
    const kept = { monitors: after.monitors.filter((x) => x.monitor_id !== added.series_id), runs: after.runs.filter((_, i) => after.monitors[i].monitor_id !== added.series_id) };
    expect(JSON.stringify(kept)).toBe(before);
  });
});

describe('view models', () => {
  it('tells failed points apart from outside the top 20', () => {
    expect(rankLabel({ rank: null, failed: true })).toBe('—');
    expect(rankLabel({ rank: null })).toBe('20+');
    expect(rankLabel({ rank: 4 })).toBe('4');
    const pts = points((i) => (i === 0 ? null : 2), 3, (i) => (i === 8 ? { failed: true, rank: null } : {}));
    const k = computeKpis(pts);
    expect(k).toMatchObject({ top3: 7, inTop20: 7, scanned: 8, failed: 1, total: 9 });
    // MRT average: 7 points at 2, one outside the top 20 at 21, the failed point left out.
    expect(k.avgRank).toBe(Math.round(((7 * 2 + 21) / 8) * 10) / 10);
  });

  it('labels KPI deltas so a lower average rank reads as better', () => {
    expect(deltaLower(3.4, 3.8)).toMatchObject({ tone: 'better', label: '▲ 0.4 better' });
    expect(deltaLower(5, 4)).toMatchObject({ tone: 'worse', label: '▼ 1 worse' });
    const cmp = compareKpis(points(() => 2), points(() => 8));
    expect(cmp.visibility.tone).toBe('better');
    expect(cmp.top3).toMatchObject({ value: 81, label: '▲ 81' });
    expect(compareKpis(points(() => 2), null).visibility.tone).toBe('none');
  });

  it('resolves Compare to, falling back to the previous scan', () => {
    const tz = 'America/New_York';
    const h = (id: string, ts: number) => ({ id, series_id: 's', ts, status: 'done' as const, pinned: false });
    const headers = [h('nov26', Date.UTC(2026, 10, 15, 17)), h('oct26', Date.UTC(2026, 9, 15, 16)), h('nov25', Date.UTC(2025, 10, 15, 17)), h('may25', Date.UTC(2025, 4, 15, 16))];
    expect(resolveCompare(headers, 'nov26', 'previous', null, tz)).toMatchObject({ runId: 'oct26', lastYearAvailable: true });
    expect(resolveCompare(headers, 'nov26', 'last_year', null, tz)).toMatchObject({ runId: 'nov25', mode: 'last_year' });
    expect(resolveCompare(headers, 'oct26', 'last_year', null, tz)).toMatchObject({ runId: 'nov25', mode: 'previous', lastYearAvailable: false });
    expect(resolveCompare(headers, 'nov26', 'specific', 'may25', tz)).toMatchObject({ runId: 'may25', mode: 'specific' });
    expect(resolveCompare(headers, 'nov26', 'specific', 'nov26', tz)).toMatchObject({ runId: 'oct26', mode: 'previous' });
    expect(resolveCompare(headers, 'may25', 'previous', null, tz)).toMatchObject({ runId: null });
  });

  it('groups competitors by CID, then domain, then title, with no cap and a review gap', () => {
    const item = (rank: number, title: string, extra: Record<string, unknown> = {}) => ({ rank_group: rank, title, is_target: false, ...extra });
    const pts: GridPoint[] = Array.from({ length: 4 }, (_, i) => ({
      row: 0, col: i, rank: 1,
      items: [
        item(1, 'You', { cid: '1', is_target: true, rating_votes: 50 }),
        item(2, i % 2 ? 'Rival Renamed' : 'Rival', { cid: '2', rating_votes: 80, rating_value: 4.8 }),
        item(3, 'Domain Co', { domain: 'www.domain.com' }),
        item(4, 'Domain Co Branch', { domain: 'domain.com' }),
        ...Array.from({ length: 12 }, (_, j) => item(5 + j, `Other ${i}-${j}`)),
      ],
    }));
    const rows = computeCompetitorRows(pts);
    expect(rows[0]).toMatchObject({ name: 'You', isTarget: true, visibility: 100, reviewGap: null });
    expect(rows.find((r) => r.cid === '2')).toMatchObject({ top20: 4, avgRank: 2, reviewGap: 30, rating: 4.8 });
    expect(rows.filter((r) => r.domain?.includes('domain.com'))).toHaveLength(1);
    expect(rows.length).toBe(3 + 48);
    // Imported Semrush runs have no listings.
    expect(computeCompetitorRows(points(() => 3))).toEqual([]);
  });

  it('reports rings in miles and leaves failed points out', () => {
    const rings = computeRings(points(() => 2, 9, (i) => (i === 0 ? { failed: true, rank: null } : {})), 9, 2.0117);
    expect(rings.map((r) => r.miles)).toEqual([0, 1.3, 2.5, 3.8, 5]);
    expect(rings[4].points).toBe(31);
  });

  it('formats dates and schedules for people', () => {
    expect(formatScanDate(Date.UTC(2026, 10, 15, 17), 'America/New_York')).toBe('Nov 15, 2026');
    expect(formatScanDate(Date.UTC(2026, 10, 16, 3), 'America/Los_Angeles')).toBe('Nov 15, 2026');
    expect(describeSchedule({ frequency: 'monthly', weekday: 15, time_of_day: '12:00' })).toBe('Monthly · 15th, 12:00 clinic time');
    expect(describeSchedule({ frequency: 'monthly', weekday: 22, time_of_day: '12:00' })).toBe('Monthly · 22nd, 12:00 clinic time');
    expect(describeSchedule(null)).toBe('Not scheduled');
  });

  it('derives the location status from its keywords', () => {
    const s = { frequency: 'monthly', weekday: 15, time_of_day: '12:00', time_zone: 'UTC', queue_mode: 'standard', next_run_at: 0, updated_at: 0 } as const;
    expect(locationStatus([{ doneRuns: 5, pendingRun: null, schedule: s }]).label).toBe('Tracking');
    expect(locationStatus([{ doneRuns: 0, pendingRun: { id: 'x', series_id: 'x', ts: 0, status: 'pending', pinned: false, readyPoints: 3, totalPoints: 81 }, schedule: s }]).label).toBe('First scan running');
    expect(locationStatus([{ doneRuns: 1, pendingRun: null, schedule: s }]).label).toBe('First scan done');
    expect(locationStatus([{ doneRuns: 0, pendingRun: null, schedule: s }]).label).toBe('Waiting for first scan');
  });
});

describe('legacy saveGridSearch rows', () => {
  it('groups runs saved by the old screen (no explicit series) like any other', () => {
    // saveGridSearch writes to the active (default) project.
    const entry: GridSearchEntry = {
      id: 'legacy-1', series_id: gridSeriesId('pt', '45,-93', 9, 2.0117, 'legacy.com', 'English'), ts: NOW, keyword: 'pt', target: 'legacy.com',
      center: '45,-93', grid_size: 9, spacing_km: 2.0117, language: 'English', status: 'done', queue_mode: 'standard',
    };
    saveGridSearch(entry, points(() => 1));
    const location = listLocations('default').find((l) => l.target === 'legacy.com')!;
    expect(location.cid).toBeNull();
    expect(location.monitors).toHaveLength(1);
  });
});

describe('location scan dates', () => {
  it('lists distinct days and picks each keyword scan on or before the day', async () => {
    const { scanDateOptions, pickRunsForDay } = await import('./grid-locations');
    const tz = 'America/New_York';
    const h = (id: string, ts: number, pinned = false) => ({ id, series_id: id[0], ts, status: 'done' as const, pinned });
    const headers = new Map([
      ['a', [h('a3', Date.UTC(2026, 10, 15, 17)), h('a2', Date.UTC(2026, 9, 15, 16)), h('a1', Date.UTC(2026, 4, 15, 16), true)]],
      ['b', [h('b2', Date.UTC(2026, 10, 15, 18)), h('b1', Date.UTC(2026, 10, 1, 16))]],
      ['c', []],
    ]);
    const options = scanDateOptions(headers, tz);
    expect(options.map((o) => o.day)).toEqual(['2026-11-15', '2026-11-01', '2026-10-15', '2026-05-15']);
    expect(options.find((o) => o.day === '2026-05-15')!.startingPoint).toBe(true);
    const latest = pickRunsForDay(headers, null, tz);
    expect(latest.get('a')).toMatchObject({ current: { id: 'a3' }, previous: { id: 'a2' } });
    expect(latest.get('c')).toEqual({ current: null, previous: null });
    const oct = pickRunsForDay(headers, '2026-10-15', tz);
    expect(oct.get('a')).toMatchObject({ current: { id: 'a2' }, previous: { id: 'a1' } });
    expect(oct.get('b')).toEqual({ current: null, previous: null });
  });
});

describe('keyword page helpers', () => {
  const item = (rank_group: number, cid: string, is_target = false) => ({ rank_group, title: `Biz ${cid}`, cid, is_target });
  const now = [
    { row: 0, col: 0, rank: 2, items: [item(1, '9'), item(2, '1', true)] },
    { row: 0, col: 1, rank: null, items: [item(4, '9')] },
    { row: 1, col: 0, rank: 5, items: [] },
    { row: 1, col: 1, rank: null, failed: true, items: [] },
  ];
  const before = [
    { row: 0, col: 0, rank: 4, items: [] },
    { row: 0, col: 1, rank: 7, items: [] },
    { row: 1, col: 0, rank: null, items: [] },
    { row: 1, col: 1, rank: 3, items: [] },
  ];

  it('shows a competitor\'s own ranks on the grid, keeping failed points', () => {
    const pts = competitorPoints(now, 'cid:9');
    expect(pts.map((p) => p.rank)).toEqual([1, 4, null, null]);
    expect(pts[3].failed).toBe(true);
  });

  it('labels each point\'s movement against the compared scan', () => {
    const moves = pointMoves(now, before);
    expect(moves.get('0:0')).toEqual({ label: '+2', tone: 'better' });
    expect(moves.get('0:1')).toEqual({ label: 'lost', tone: 'worse' });
    expect(moves.get('1:0')).toEqual({ label: 'new', tone: 'better' });
    expect(moves.has('1:1')).toBe(false);
    expect(pointMoves(now, null).size).toBe(0);
  });

  it('buckets each scan for the trend chart, oldest first', () => {
    const run = (id: string, ts: number, points: typeof now) => ({ id, series_id: 's', ts, status: 'done' as const, pinned: false, points });
    const bars = trendBars([run('b', 2, now), run('a', 1, before)]);
    expect(bars.map((b) => b.runId)).toEqual(['a', 'b']);
    expect(bars[1]).toMatchObject({ total: 4, top3: 1, top4to10: 1, top11to20: 0, rest: 2 });
  });
});
