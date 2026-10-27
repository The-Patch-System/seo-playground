// Patch fork: monitor import, retention, uncapped monitor list and staggered schedule claims.
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grid-patch-test-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');

import {
  claimDueGridSchedules, deleteGridSeriesForProject, getGridMonitorsLatest, getGridSchedule, gridSeriesId, pruneGridHistoryForProject,
  saveGridSchedule, saveGridSearch, type GridSearchEntry,
} from './db';
import { createMonitor, MonitorInputError } from './grid-import';
import { getMonitorRuns, getRun, listMonitors } from './grid-report';

afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 27, 12);
const iso = (ts: number) => new Date(ts).toISOString();
const grid = (rank: number | null) => Array.from({ length: 81 }, (_, i) => ({ row: Math.floor(i / 9), col: i % 9, rank: i === 40 ? rank : 25 }));

describe('monitor import', () => {
  it('creates a scheduled monitor at noon clinic time and imports runs without duplicates', () => {
    const body = {
      keyword: 'physical therapy',
      business: { name: 'Elevation Athletics', cid: '9715887968687677574' },
      center: { lat: 32.894142, lng: -97.269099 },
      radius_mi: 5,
      runs: [
        { run_at: iso(NOW - 400 * DAY), pinned: true, points: grid(9) },
        { run_at: iso(NOW - 30 * DAY), points: grid(3) },
      ],
    };
    const created = createMonitor(body);
    expect(created.grid_size).toBe(9);
    expect(created.spacing_km).toBeCloseTo(2.0117, 4);
    expect(created.schedule).toMatchObject({ frequency: 'monthly', weekday: 15, time_of_day: '12:00', time_zone: 'America/Chicago' });
    expect(created.imported_runs).toHaveLength(2);

    createMonitor(body); // repeat import of the same scans
    const history = getMonitorRuns(created.monitor_id);
    expect(history?.runs).toHaveLength(2);
    expect(history?.runs[1]).toMatchObject({ pinned: true });

    const run = getRun(created.imported_runs[1]);
    if (!run || !('points' in run)) throw new Error('expected points');
    // Ranks outside the top 20 are stored as "not in the top 20", like a scan.
    expect(run.points[0].rank).toBeNull();
    expect(run.points[40].rank).toBe(3);
    expect(run.positions[0]).not.toHaveProperty('position');
  });

  it('lists a monitor that is scheduled but has no runs yet', () => {
    const created = createMonitor({ keyword: 'chiropractor', business: { name: 'Spine Co', cid: '42' }, center: { lat: 40.7128, lng: -74.006 } });
    const [monitor] = listMonitors({ cid: '42' });
    expect(monitor).toMatchObject({ monitor_id: created.monitor_id, runs: 0, latest_run: null, schedule: { day_of_month: 15, time_zone: 'America/New_York' } });
  });

  it('files a monitor under its client project, created once per website', () => {
    const project = { name: 'Summit PT', domain: 'https://www.summitpt.com/' };
    const first = createMonitor({ project, keyword: 'physical therapy', business: { name: 'Summit PT Denver', cid: '101' }, center: { lat: 39.7392, lng: -104.9903 }, schedule: false });
    const second = createMonitor({ project: { name: 'Summit PT', domain: 'summitpt.com' }, keyword: 'physical therapy', business: { name: 'Summit PT Boulder', cid: '102' }, center: { lat: 40.015, lng: -105.2705 }, schedule: false });
    expect(first.project).not.toBe('default');
    expect(second.project).toBe(first.project);
    expect(() => createMonitor({ project: { name: '', domain: 'x.com' }, keyword: 'pt', business: { name: 'x' }, center: { lat: 1, lng: 1 } })).toThrow(/project/);
  });

  it('deletes an imported monitor from its client project', () => {
    const created = createMonitor({ project: { name: 'Gone PT', domain: 'gonept.com' }, keyword: 'pt', business: { name: 'Gone PT', cid: '303' }, center: { lat: 35.2, lng: -80.8 }, runs: [{ run_at: iso(NOW - DAY), points: grid(4) }] });
    expect(deleteGridSeriesForProject(created.project, created.monitor_id)).toBe(2);
    expect(listMonitors({ cid: '303' })).toEqual([]);
    expect(deleteGridSeriesForProject(created.project, created.monitor_id)).toBe(0);
  });

  it('rejects bad input', () => {
    expect(() => createMonitor({ keyword: '', business: { name: 'x' }, center: { lat: 1, lng: 1 } })).toThrow(MonitorInputError);
    expect(() => createMonitor({ keyword: 'pt', business: { name: 'x', cid: 'abc' }, center: { lat: 1, lng: 1 } })).toThrow(/CID/);
    expect(() => createMonitor({ keyword: 'pt', business: { name: 'x' }, center: { lat: 1, lng: 1 }, grid_size: 4 })).toThrow(/grid_size/);
  });
});

describe('retention', () => {
  const center = '35.000000,-80.000000';
  const target = 'Retention PT (cid:7)';
  const seriesId = gridSeriesId('pt', center, 3, 1, target, 'English');
  const base: GridSearchEntry = { id: '', series_id: seriesId, ts: 0, keyword: 'pt', target, center, grid_size: 3, spacing_km: 1, language: 'English', status: 'done', queue_mode: 'standard' };
  const pts = [{ row: 0, col: 0, rank: 1 }];

  it('keeps the oldest run and the last ~6 months when nothing is pinned', () => {
    for (const [id, age] of [['r-first', 500], ['r-old', 300], ['r-older', 250], ['r-recent', 100], ['r-new', 5]] as const) {
      saveGridSearch({ ...base, id, ts: NOW - age * DAY }, pts);
    }
    const before = getMonitorRuns(seriesId)!.runs.length;
    pruneGridHistoryForProject('default', NOW);
    const kept = getMonitorRuns(seriesId)!.runs.map((r) => r.run_id);
    expect(before).toBe(5);
    expect(kept).toEqual(['r-new', 'r-recent', 'r-first']);
  });

  it('keeps a pinned starting point instead of the oldest run', () => {
    const imported = listMonitors({ cid: '9715887968687677574' })[0];
    pruneGridHistoryForProject('default', NOW);
    const runs = getMonitorRuns(imported.monitor_id)!.runs;
    expect(runs.map((r) => r.pinned)).toEqual([false, true]);
  });
});

describe('monitor list and scheduling at scale', () => {
  it('lists every monitor, not just the newest 100 runs', () => {
    for (let i = 0; i < 130; i += 1) {
      const target = `Clinic ${i}`;
      saveGridSearch({ id: `bulk-${i}`, series_id: gridSeriesId('pt', '1,1', 3, 1, target, 'English'), ts: NOW - i * 1000, keyword: 'pt', target, center: '1,1', grid_size: 3, spacing_km: 1, language: 'English', status: 'done', queue_mode: 'standard' }, [{ row: 0, col: 0, rank: 1 }]);
    }
    expect(getGridMonitorsLatest().filter((m) => m.target.startsWith('Clinic ')).length).toBe(130);
  });

  it('claims due schedules in waves, oldest slot first', () => {
    for (let i = 0; i < 5; i += 1) {
      const target = `Due ${i}`;
      saveGridSchedule({ series_id: `due-${i}`, keyword: 'pt', target, center: '1,1', grid_size: 3, spacing_km: 1, language: 'English', queue_mode: 'standard', frequency: 'daily', weekday: null, time_of_day: '12:00', time_zone: 'UTC' });
    }
    const later = Date.now() + 3 * DAY;
    const first = claimDueGridSchedules(later, 2);
    expect(first).toHaveLength(2);
    const rest = claimDueGridSchedules(later, 100).filter((s) => s.series_id.startsWith('due-'));
    expect(rest).toHaveLength(3);
    expect(getGridSchedule('due-0')!.next_run_at).toBeGreaterThan(later);
  });
});
