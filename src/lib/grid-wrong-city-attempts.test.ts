import { afterEach, describe, expect, it } from 'vitest';
import type { GridTaskPoint } from './db';
import { MAX_POINT_ATTEMPTS, retryDelayMs, scheduledWrongCityAttempts, stepGridTasks, type GridTaskCheck } from './grid-progress';

// Patch fork (Nov 24 2026): scheduled runs can give a wrong-city point a 4th search, 2 h after the 3rd.
const MIN = 60_000;
const t0 = Date.parse('2026-12-15T17:00:00Z');
const thirdSearch: GridTaskPoint = { task_id: 'wc-3', row: 0, col: 0, lat: 40, lng: -75, attempts: 3, submitted_at: t0 };
const wrongCity: GridTaskCheck = { kind: 'bad', recheck: { task_id: 'wc-3', reason: 'wrong_city' } };
const neverReposts = async () => { throw new Error('should not re-post yet'); };

afterEach(() => { delete process.env.GEO_GRID_WRONG_CITY_ATTEMPTS; });

describe('wrong-city retry schedule', () => {
  it('waits 5 min, then 30 min, then 2 h between wrong-city searches', () => {
    expect(retryDelayMs('wrong_city', 1)).toBe(5 * MIN);
    expect(retryDelayMs('wrong_city', 2)).toBe(30 * MIN);
    expect(retryDelayMs('wrong_city', 3)).toBe(120 * MIN);
    expect(retryDelayMs('task_error', 3)).toBe(0);
  });

  it('reads GEO_GRID_WRONG_CITY_ATTEMPTS: 4 allows the 2 h search, anything else keeps 3', () => {
    expect(scheduledWrongCityAttempts()).toBe(MAX_POINT_ATTEMPTS);
    process.env.GEO_GRID_WRONG_CITY_ATTEMPTS = '4';
    expect(scheduledWrongCityAttempts()).toBe(4);
    process.env.GEO_GRID_WRONG_CITY_ATTEMPTS = '9';
    expect(scheduledWrongCityAttempts()).toBe(MAX_POINT_ATTEMPTS);
  });

  it('fails a point after its 3rd wrong-city search by default', async () => {
    const step = await stepGridTasks([thirdSearch], new Map([[thirdSearch, wrongCity]]), t0 + MIN, neverReposts);
    expect(step.pending).toEqual([]);
    expect(step.ready).toEqual([expect.objectContaining({ failed: true, failed_reason: 'wrong_city', task_id: 'wc-3' })]);
  });

  it('with 4 searches allowed, holds the 3rd wrong-city point for 2 h, then re-posts it', async () => {
    const held = await stepGridTasks([thirdSearch], new Map([[thirdSearch, wrongCity]]), t0 + MIN, neverReposts, { maxWrongCityAttempts: 4 });
    expect(held.ready).toEqual([]);
    expect(held.pending).toEqual([expect.objectContaining({ task_id: 'wc-3', awaiting_retry: true, retry_due_at: t0 + 120 * MIN })]);

    const waiting = held.pending[0];
    const early = await stepGridTasks([waiting], new Map(), t0 + 119 * MIN, neverReposts, { maxWrongCityAttempts: 4 });
    expect(early.pending).toEqual([waiting]);

    const reposted = await stepGridTasks([waiting], new Map(), t0 + 120 * MIN, async () => ({ kind: 'accepted', taskId: 'wc-4' }), { maxWrongCityAttempts: 4 });
    expect(reposted.pending).toEqual([expect.objectContaining({ task_id: 'wc-4', attempts: 4 })]);
    expect(reposted.pending[0].rechecks).toHaveLength(1);
  });

  it('with 4 searches allowed, fails a point after its 4th wrong-city search', async () => {
    const fourth: GridTaskPoint = { ...thirdSearch, task_id: 'wc-4', attempts: 4 };
    const step = await stepGridTasks([fourth], new Map([[fourth, { kind: 'bad', recheck: { task_id: 'wc-4', reason: 'wrong_city' } } as GridTaskCheck]]), t0 + MIN, neverReposts, { maxWrongCityAttempts: 4 });
    expect(step.ready).toEqual([expect.objectContaining({ failed: true, failed_reason: 'wrong_city', task_id: 'wc-4' })]);
  });

  it('keeps 3 searches for task errors even when 4 are allowed for wrong-city', async () => {
    const step = await stepGridTasks([thirdSearch], new Map([[thirdSearch, { kind: 'bad', recheck: { task_id: 'wc-3', reason: 'task_error' } } as GridTaskCheck]]), t0 + MIN, neverReposts, { maxWrongCityAttempts: 4 });
    expect(step.ready).toEqual([expect.objectContaining({ failed: true, failed_reason: 'task_error' })]);
  });
});
