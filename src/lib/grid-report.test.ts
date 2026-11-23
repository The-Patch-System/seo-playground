import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grid-report-test-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');

import { createProject, getDbForProject, gridSeriesId, saveGridSearch, saveGridSchedule, setActiveProject, type GridPoint, type GridSearchEntry } from './db';
import { getMonitorRuns, getRun, listMonitors } from './grid-report';

afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

// Schedules can't live in the Default Project (sales demos), so these monitors sit in a client project.
setActiveProject(createProject({
  name: 'Elevation Athletics', domain: 'elevation-athletics.example', defaultLocation: 'United States',
  defaultLanguage: 'English', defaultCoordinates: '', rankTrackerDepth: '100',
}).id);

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
  items: i === 4 ? [{ ...us, rank_group: centerRank }, rival] : i % 2 === 0 ? [rival, { ...us, rank_group: 5 }] : [rival],
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
    expect(run.top_competitors.find((c) => c.is_target)).toMatchObject({ found_points: 5, average_position: 4.2 });
    const lean = getRun('run-new', undefined, { competitors: false });
    expect(lean && 'points' in lean && 'results' in lean.points[0]).toBe(false);
    expect(getRun('missing')).toBeNull();
  });

  it('returns run history with Semrush-style metric series', () => {
    const history = getMonitorRuns(seriesId);
    expect(history?.runs.map((r) => r.run_id)).toEqual(['run-new', 'run-old']);
    expect(Object.values(history?.metrics.average_positions ?? {})).toHaveLength(2);
    // Semrush MRT counts every point, unranked as 21: (1 + 4*5 + 4*21) / 9 for the newest run.
    expect(history?.runs[0].summary?.mrt_average_position).toBe(11.6667);
    expect(Object.values(history?.metrics.mrt_average_positions ?? {})).toEqual([11.8889, 11.6667]);
    expect(getRun('run-new', undefined, { points: false })?.summary?.mrt_average_position).toBe(11.6667);
    expect(getMonitorRuns('nope')).toBeNull();
  });
});

// Patch fork: provenance, data-quality and report-safety fields.
describe('reporting API data quality', () => {
  const quality = (keyword: string, id: string, points: GridPoint[], ts = base.ts + 2 * 86_400_000) => {
    const series = gridSeriesId(keyword, center, 3, 2, target, 'English');
    saveGridSearch({ ...base, id, keyword, series_id: series, ts }, points);
    return series;
  };
  // raw_count marks a point checked by the wrong-city code (every point it builds has one).
  const fine = (i: number): GridPoint => ({ row: Math.floor(i / 3), col: i % 3, rank: 5, items: [rival, { ...us, rank_group: 5 }], raw_count: 20 });
  const grid = (overrides: Record<number, GridPoint>) => Array.from({ length: 9 }, (_, i) => overrides[i] ?? fine(i));
  const wrongCity: GridPoint = {
    row: 0, col: 1, rank: null, items: [], failed: true, failed_reason: 'wrong_city', task_id: 't-wc', check_url: 'https://google/wc',
    rechecks: [{ task_id: 't-wc0', reason: 'wrong_city' }, { task_id: 't-wc', reason: 'wrong_city' }],
  };
  const unresolved: GridPoint = { row: 0, col: 2, rank: null, items: [rival], truncated: true, rank_unresolved: true, task_id: 't-ru', raw_count: 30 };

  it('exposes task_id, check_url, failed_reason and rank_unresolved on points, and quality on the header', () => {
    const series = quality('pt quality', 'q-new', grid({
      0: { ...fine(0), rank: 2, items: [rival, { ...us, rank_group: 2 }], task_id: 't-0', check_url: 'https://google/0' },
      1: wrongCity,
      2: unresolved,
      3: { ...fine(3), location_status: 'unresolved' },
    }));
    const run = getRun('q-new');
    if (!run || !('points' in run)) throw new Error('expected points');
    expect(run.points[0]).toMatchObject({ rank: 2, task_id: 't-0', check_url: 'https://google/0', failed: false, failed_reason: null, rank_unresolved: false });
    expect(run.points[1]).toMatchObject({ rank: null, failed: true, failed_reason: 'wrong_city', task_id: 't-wc', check_url: 'https://google/wc' });
    expect(run.points[2]).toMatchObject({ rank: null, rank_unresolved: true, task_id: 't-ru', check_url: null });
    expect(run.points[4]).toMatchObject({ task_id: null, check_url: null, failed: false, failed_reason: null, rank_unresolved: false });
    expect(run.quality).toEqual({
      points: 9, failed_points: 1, wrong_city_failed: 1, unresolved_points: 1, rank_unresolved_points: 1, wrong_city_rechecks: 2,
    });
    expect(run).toMatchObject({ rescanned_at: null, report_safe: false, report_safe_reason: 'wrong_city_persistent' });
    // MRT leaves out the failed and the rank-unresolved point: (2 + 6 * 5) / 7.
    expect(run.summary?.mrt_average_position).toBe(4.5714);
    expect(getMonitorRuns(series)).toMatchObject({ report_safe: false, report_safe_reason: 'wrong_city_persistent' });
    expect(listMonitors({ q: 'pt quality' })[0]).toMatchObject({ report_safe: false, report_safe_reason: 'wrong_city_persistent' });
  });

  it('computes report safety for runs that were never re-scanned', () => {
    quality('pt clean', 'q-clean', grid({}));
    quality('pt three failed', 'q-three', grid({
      1: { ...wrongCity, failed_reason: 'task_error' }, 2: { ...wrongCity, row: 0, col: 2, failed_reason: 'task_error' },
      3: { ...wrongCity, row: 1, col: 0, failed_reason: 'timeout' },
    }));
    quality('pt two failed', 'q-two', grid({ 1: { ...wrongCity, failed_reason: 'task_error' }, 2: { ...wrongCity, row: 0, col: 2, failed_reason: 'timeout' } }));
    quality('pt unresolved', 'q-unresolved', grid({ 2: unresolved }));
    expect(getRun('q-clean', undefined, { points: false })).toMatchObject({ report_safe: true, report_safe_reason: null, rescanned_at: null });
    expect(getRun('q-three', undefined, { points: false })).toMatchObject({ report_safe: false, report_safe_reason: 'too_many_failed' });
    expect(getRun('q-two', undefined, { points: false })).toMatchObject({ report_safe: true, report_safe_reason: null });
    expect(getRun('q-unresolved', undefined, { points: false })).toMatchObject({ report_safe: false, report_safe_reason: 'rank_unresolved' });
  });

  it("uses the monitor's latest finished run for its flag", () => {
    const series = quality('pt latest', 'q-latest-old', grid({ 1: wrongCity }), base.ts + 3 * 86_400_000);
    quality('pt latest', 'q-latest-new', grid({}), base.ts + 4 * 86_400_000);
    quality('pt latest', 'q-latest-pending', [], base.ts + 5 * 86_400_000);
    getDbForProject('default').prepare("UPDATE grid_searches SET status = 'pending' WHERE id = 'q-latest-pending'").run();
    const history = getMonitorRuns(series);
    expect(history?.runs.map((r) => [r.run_id, r.report_safe])).toEqual([['q-latest-pending', null], ['q-latest-new', true], ['q-latest-old', false]]);
    expect(history).toMatchObject({ report_safe: true, report_safe_reason: null });
    expect(listMonitors({ q: 'pt latest' })[0]).toMatchObject({ report_safe: true, latest_run: { run_id: 'q-latest-new' } });
  });

  it('shows rescanned_at after a swap, and a re-scan safety flag wins over the computed one', () => {
    quality('pt rescanned', 'q-rescanned', grid({ 2: unresolved }));
    const swappedAt = Date.parse('2026-11-21T10:00:00Z');
    const db = getDbForProject('default');
    db.prepare(`INSERT INTO grid_rescans (run_id, series_id, manifest_id, label, state, attempt, queued_at, swapped_at, updated_at)
      VALUES ('q-rescanned', 's', 'm', '', 'swapped', 1, ?, ?, ?)`).run(swappedAt, swappedAt, swappedAt);
    db.prepare("INSERT INTO grid_run_safety (run_id, report_safe, reason, updated_at) VALUES ('q-rescanned', 1, NULL, ?)").run(swappedAt);
    expect(getRun('q-rescanned', undefined, { points: false })).toMatchObject({
      rescanned_at: '2026-11-21T10:00:00.000Z', report_safe: true, report_safe_reason: null,
    });
    // A held re-scan isn't a swap.
    db.prepare("UPDATE grid_rescans SET state = 'held' WHERE run_id = 'q-rescanned'").run();
    db.prepare("UPDATE grid_run_safety SET report_safe = 0, reason = 'wrong_city_persistent' WHERE run_id = 'q-rescanned'").run();
    expect(getRun('q-rescanned', undefined, { points: false })).toMatchObject({
      rescanned_at: null, report_safe: false, report_safe_reason: 'wrong_city_persistent',
    });
  });

  // Patch fork (Codex round 3): a partial grid is not "done and safe".
  it('flags a finished run with missing or duplicate points as incomplete_grid', () => {
    quality('pt partial', 'q-partial', grid({}).slice(0, 8));
    quality('pt duplicate', 'q-duplicate', [...grid({}).slice(0, 8), fine(0)]);
    quality('pt outside', 'q-outside', [...grid({}).slice(0, 8), { ...fine(8), row: 3 }]);
    for (const id of ['q-partial', 'q-duplicate', 'q-outside']) {
      expect(getRun(id, undefined, { points: false })).toMatchObject({ report_safe: false, report_safe_reason: 'incomplete_grid' });
    }
  });

  // Patch fork (Codex round 3): a run the wrong-city check never saw is unknown, not safe.
  it('reports null / not_checked for runs whose points were never checked, on every endpoint', () => {
    const legacy = (i: number): GridPoint => { const point = fine(i); delete point.raw_count; return point; };
    const series = quality('pt legacy', 'q-legacy-old', Array.from({ length: 9 }, (_, i) => legacy(i)), base.ts + 6 * 86_400_000);
    const notChecked = { report_safe: null, report_safe_reason: 'not_checked' };
    expect(getRun('q-legacy-old', undefined, { points: false })).toMatchObject(notChecked);
    expect(getRun('q-legacy-old')).toMatchObject(notChecked);
    expect(getMonitorRuns(series)).toMatchObject(notChecked);
    expect(getMonitorRuns(series)?.runs[0]).toMatchObject(notChecked);
    expect(listMonitors({ q: 'pt legacy' })[0]).toMatchObject(notChecked);
    expect(listMonitors({ q: 'pt legacy' })[0].latest_run).toMatchObject(notChecked);

    // One unchecked point is enough; a failed point needs no raw_count.
    quality('pt one legacy', 'q-one-legacy', grid({ 4: legacy(4) }));
    expect(getRun('q-one-legacy', undefined, { points: false })).toMatchObject(notChecked);
    quality('pt failed no raw', 'q-failed-no-raw', grid({ 1: { ...wrongCity, failed_reason: 'task_error' } }));
    expect(getRun('q-failed-no-raw', undefined, { points: false })).toMatchObject({ report_safe: true, report_safe_reason: null });

    // The monitor follows its latest finished run: a newer checked run makes it safe again.
    quality('pt legacy', 'q-legacy-new', grid({}), base.ts + 7 * 86_400_000);
    expect(getMonitorRuns(series)).toMatchObject({ report_safe: true, report_safe_reason: null });
    expect(listMonitors({ q: 'pt legacy' })[0]).toMatchObject({ report_safe: true, latest_run: { run_id: 'q-legacy-new' } });
    expect(getMonitorRuns(series)?.runs.map((r) => [r.run_id, r.report_safe])).toEqual([['q-legacy-new', true], ['q-legacy-old', null]]);
  });
});
