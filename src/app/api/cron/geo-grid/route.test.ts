// Patch fork: the worker pass. A schedule whose tasks were all refused creates no run (it's retried),
// and a run whose collection throws is counted and logged instead of silently skipped.
import { describe, it, expect, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cron-geo-grid-test-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.CRON_SECRET = 'cron-test-secret';

import { getDbForProject, saveCredentials, saveGridSchedule } from '@/lib/db';
import { GET } from './route';

afterAll(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

const pass = async () => (await GET(new NextRequest('http://localhost/api/cron/geo-grid', { headers: { authorization: 'Bearer cron-test-secret' } }))).json();

describe('/api/cron/geo-grid', () => {
  it('creates no run, and retries the schedule, when DataForSEO refused every task', async () => {
    saveCredentials('l', 'p');
    saveGridSchedule({
      series_id: 'grid-refused', keyword: 'pt', target: 'Us (cid:1)', center: '40,-75', grid_size: 2, spacing_km: 1, language: 'English',
      queue_mode: 'standard', frequency: 'monthly', weekday: 15, time_of_day: '12:00', time_zone: 'America/New_York',
    }, 'default');
    const db = getDbForProject('default');
    db.prepare("UPDATE grid_schedules SET next_run_at = ? WHERE series_id = 'grid-refused'").run(Date.now() - 1000);
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
