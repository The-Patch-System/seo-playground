import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grid-report-test-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');

import { gridSeriesId, saveGridSearch, saveGridSchedule, type GridSearchEntry } from './db';
import { getMonitorRuns, getRun, listMonitors } from './grid-report';

afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

const target = 'Elevation Athletics (cid:9715887968687677574)';
const center = '32.894142,-97.269100';
const seriesId = gridSeriesId('physical therapy', center, 3, 2, target, 'English');
const base: GridSearchEntry = {
  id: 'run-old', series_id: seriesId, ts: 1_700_000_000_000, keyword: 'physical therapy', target, center,
  grid_size: 3, spacing_km: 2, language: 'English', status: 'done', queue_mode: 'standard', cost: 0.0054,
};
const us = { rank_group: 1, title: 'Elevation Athletics', cid: '9715887968687677574', is_target: true };
const rival = { rank_group: 2, title: 'Rival PT', cid: '42', is_target: false };
const pointsAt = (centerRank: number) => Array.from({ length: 9 }, (_, i) => ({
  row: Math.floor(i / 3), col: i % 3, rank: i === 4 ? centerRank : i % 2 === 0 ? 5 : null,
  items: i === 4 ? [{ ...us, rank_group: centerRank }, rival] : [rival],
}));

describe('reporting API data', () => {
  it('lists monitors with business, schedule, report dates and latest summary', () => {
    saveGridSearch(base, pointsAt(3));
    saveGridSearch({ ...base, id: 'run-new', ts: base.ts + 86_400_000 }, pointsAt(1));
    saveGridSchedule({ ...base, frequency: 'monthly', weekday: 15, time_of_day: '11:00', time_zone: 'America/Chicago' });
    const [monitor] = listMonitors({ cid: '9715887968687677574' });
    expect(monitor.monitor_id).toBe(seriesId);
    expect(monitor.business).toEqual({ cid: '9715887968687677574', name: 'Elevation Athletics', coordinates: { lat: 32.894142, lng: -97.2691 } });
    expect(monitor.runs).toBe(2);
    expect(monitor.report_dates).toHaveLength(2);
    expect(monitor.schedule).toMatchObject({ frequency: 'monthly', day_of_month: 15, time_of_day: '11:00' });
    expect(monitor.latest_run).toMatchObject({ run_id: 'run-new', summary: { found: 5, total: 9, top3: 1 } });
    expect(listMonitors({ q: 'dentist' })).toEqual([]);
  });

  it('returns grid points, Semrush-style positions with diffs, and top competitors', () => {
    const run = getRun('run-new');
    if (!run || !('points' in run)) throw new Error('expected points');
    expect(run.points).toHaveLength(9);
    expect(run.points[4]).toMatchObject({ row: 1, col: 1, rank: 1, lat: 32.894142, lng: -97.2691 });
    expect(run.points[4].results?.[0]?.is_target).toBe(true);
    expect(run.positions[4]).toEqual({ point: { id: 'r1c1', coordinates: { lat: 32.894142, lng: -97.2691 } }, position: 1, diff: -2 });
    expect(run.positions[1]).toEqual({ point: { id: 'r0c1', coordinates: expect.any(Object) } });
    expect(run.top_competitors[0]).toMatchObject({ business: { cid: '42', name: 'Rival PT' }, found_points: 9, average_position: 2 });
    expect(run.top_competitors.find((c) => c.is_target)).toMatchObject({ found_points: 1, average_position: 1 });
    const lean = getRun('run-new', undefined, { competitors: false });
    expect(lean && 'points' in lean && 'results' in lean.points[0]).toBe(false);
    expect(getRun('missing')).toBeNull();
  });

  it('returns run history with Semrush-style metric series', () => {
    const history = getMonitorRuns(seriesId);
    expect(history?.runs.map((r) => r.run_id)).toEqual(['run-new', 'run-old']);
    expect(Object.values(history?.metrics.average_positions ?? {})).toHaveLength(2);
    expect(getMonitorRuns('nope')).toBeNull();
  });
});
