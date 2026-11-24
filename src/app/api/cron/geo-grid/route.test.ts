// Patch fork: the worker pass. A schedule whose tasks were all refused creates no run (it's retried
// within 6 h of its slot); an unclear start is retried once, then stopped, both alerted; and a run
// whose collection throws is counted and logged instead of silently skipped.
import { describe, it, expect, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cron-geo-grid-test-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.CRON_SECRET = 'cron-test-secret';

import { createProject, getDbForProject, saveCredentials, saveGridSchedule } from '@/lib/db';
import { GET } from './route';

// Schedules can't live in the Default Project (one-time scans only), so these sit in a client project.
const projectId = createProject({
  name: 'Cron Client', domain: 'cron-client.example', defaultLocation: 'United States', defaultLanguage: 'English', defaultCoordinates: '', rankTrackerDepth: '100',
}).id;
const schedule = (seriesId: string) => saveGridSchedule({
  series_id: seriesId, keyword: 'pt', target: 'Us (cid:1)', center: '40,-75', grid_size: 2, spacing_km: 1, language: 'English',
  queue_mode: 'standard', frequency: 'monthly', weekday: 15, time_of_day: '12:00', time_zone: 'America/New_York',
}, projectId);
const makeDue = (seriesId: string) => getDbForProject(projectId).prepare('UPDATE grid_schedules SET next_run_at = ? WHERE series_id = ?').run(Date.now() - 1000, seriesId);
const capture = () => {
  const logged: string[] = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
  return { logged, restore: () => spy.mockRestore(), alerts: () => logged.filter((l) => l.startsWith('[geo-grid-alert]')).map((l) => JSON.parse(l.slice('[geo-grid-alert] '.length))) };
};

afterAll(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

const pass = async () => (await GET(new NextRequest('http://localhost/api/cron/geo-grid', { headers: { authorization: 'Bearer cron-test-secret' } }))).json();

describe('/api/cron/geo-grid', () => {
  it('creates no run, and retries the schedule, when DataForSEO refused every task', async () => {
    saveCredentials('l', 'p');
    schedule('grid-refused');
    const db = getDbForProject(projectId);
    makeDue('grid-refused');
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as unknown[];
      return new Response(JSON.stringify({ tasks: body.map(() => ({ status_code: 40501 })) }));
    }));
    const logged: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
    const result = await pass();
    spy.mockRestore();
    expect(result).toMatchObject({ due: 1, started: [], gridRetries: 1, failed: [{ seriesId: 'grid-refused' }] });
    // A failed start is logged with its monitor and reason, not only counted.
    expect(logged.some((line) => line.includes('grid-refused') && line.includes('rejected 4 task(s)'))).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS n FROM grid_searches WHERE series_id = 'grid-refused'").get()).toEqual({ n: 0 });
    getDbForProject(projectId).prepare("DELETE FROM grid_schedules WHERE series_id = 'grid-refused'").run();
  });

  it('retries an unclear start once (alerted), then stops (alerted), and never a third time', async () => {
    saveCredentials('l', 'p');
    schedule('grid-unclear');
    const db = getDbForProject(projectId);
    // A timeout: DataForSEO may have queued and billed the tasks without us getting their ids.
    const fetchMock = vi.fn(async () => { throw new Error('The operation was aborted due to timeout'); });
    vi.stubGlobal('fetch', fetchMock);

    makeDue('grid-unclear');
    let log = capture();
    expect(await pass()).toMatchObject({ due: 1, started: [], gridRetries: 1 });
    log.restore();
    expect(log.alerts()).toEqual([expect.objectContaining({ kind: 'scheduled_start_unclear', reason: 'unclear_post_retrying', monitor_id: 'grid-unclear' })]);
    const retry = db.prepare("SELECT next_run_at, retry_slot_at, unclear_posts FROM grid_schedules WHERE series_id = 'grid-unclear'").get() as { next_run_at: number; retry_slot_at: number; unclear_posts: number };
    expect(retry.unclear_posts).toBe(1);
    expect(retry.next_run_at).toBeGreaterThan(Date.now());

    // The retry is unclear too: stop, alert, and leave the slot for next month.
    db.prepare("UPDATE grid_schedules SET next_run_at = ? WHERE series_id = 'grid-unclear'").run(Date.now() - 1000);
    log = capture();
    expect(await pass()).toMatchObject({ due: 1, started: [], gridRetries: 0 });
    log.restore();
    expect(log.alerts()).toEqual([expect.objectContaining({ kind: 'scheduled_start_unclear', reason: 'unclear_post_stopped', monitor_id: 'grid-unclear' })]);
    const after = db.prepare("SELECT next_run_at, retry_slot_at, unclear_posts FROM grid_schedules WHERE series_id = 'grid-unclear'").get() as { next_run_at: number; retry_slot_at: number | null; unclear_posts: number };
    expect(after).toMatchObject({ retry_slot_at: null, unclear_posts: 0 });
    expect(after.next_run_at - Date.now()).toBeGreaterThan(6 * 3_600_000);
    // Two POSTs in all (one per pass), never a third.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(db.prepare("SELECT COUNT(*) AS n FROM grid_searches WHERE series_id = 'grid-unclear'").get()).toEqual({ n: 0 });
    db.prepare("DELETE FROM grid_schedules WHERE series_id = 'grid-unclear'").run();
  });

  it('keeps retrying a refused start only within 6 h of the original slot, then alerts', async () => {
    saveCredentials('l', 'p');
    schedule('grid-refused-long');
    const db = getDbForProject(projectId);
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as unknown[];
      return new Response(JSON.stringify({ tasks: body.map(() => ({ status_code: 40501 })) }));
    }));
    makeDue('grid-refused-long');
    let log = capture();
    expect(await pass()).toMatchObject({ gridRetries: 1 });
    log.restore();
    expect(log.alerts()).toEqual([]);
    // The retry chain remembers the original slot. Pretend it was 7 h ago: the window is used up.
    db.prepare("UPDATE grid_schedules SET next_run_at = ?, retry_slot_at = ? WHERE series_id = 'grid-refused-long'").run(Date.now() - 1000, Date.now() - 7 * 3_600_000);
    log = capture();
    expect(await pass()).toMatchObject({ gridRetries: 0 });
    log.restore();
    expect(log.alerts()).toEqual([expect.objectContaining({ kind: 'scheduled_start_failed', reason: 'retry_window_used', monitor_id: 'grid-refused-long' })]);
    db.prepare("DELETE FROM grid_schedules WHERE series_id = 'grid-refused-long'").run();
  });

  it('counts and logs a pending run whose collection throws, instead of skipping it silently', async () => {
    const db = getDbForProject('default');
    db.prepare(`INSERT INTO grid_searches (id, ts, series_id, keyword, target, center, grid_size, spacing_km, language, cost, results, status, queue_mode, task_ids)
      VALUES ('run-broken', ?, 'grid-broken', 'pt', 'Us (cid:1)', '40,-75', 1, 1, 'English', 0, 'not json', 'pending', 'standard', ?)`)
      .run(Date.now(), JSON.stringify([{ task_id: 't1', row: 0, col: 0, lat: 40, lng: -75, attempts: 1 }]));
    const logged: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('unexpected network call'); }));
    const result = await pass();
    spy.mockRestore();
    expect(result).toMatchObject({ gridCollectErrors: 1, rescans: { errors: 0 } });
    expect(logged.some((line) => line.includes('run-broken'))).toBe(true);
  });
});
