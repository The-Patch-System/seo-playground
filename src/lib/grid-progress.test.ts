// Patch fork: a failed DataForSEO task is re-posted, and only marked "no data" after retries.
import { describe, it, expect, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grid-progress-test-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');

import { getGridProgressForProject, saveGridSearchPendingForProject, type GridSearchEntry } from './db';
import { collectGridProgress, MAX_POINT_ATTEMPTS } from './grid-progress';

afterAll(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); vi.unstubAllGlobals(); });

const entry: GridSearchEntry = {
  id: 'run-1', series_id: 's', ts: 1, keyword: 'pt', target: 'Us (cid:1)', center: '1,1', grid_size: 1,
  spacing_km: 1, language: 'English', status: 'pending', queue_mode: 'standard',
};
const creds = { login: 'l', pass: 'p' };

function stubFetch(taskGetStatus: number, repostId = 'new-task') {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(url);
    if (url.includes('task_post')) return new Response(JSON.stringify({ tasks: [{ id: repostId, status_code: 20100, cost: 0.0006 }] }));
    return new Response(JSON.stringify({ tasks: [{ status_code: taskGetStatus, result: taskGetStatus === 20000 ? [{ items: [{ type: 'local_pack', rank_group: 4, title: 'Us', cid: '1' }] }] : null }] }));
  }));
  return calls;
}

describe('collectGridProgress retries failed points', () => {
  it('re-posts a failed task instead of storing an empty point', async () => {
    saveGridSearchPendingForProject('default', entry, [{ task_id: 'old-task', row: 0, col: 0, lat: 1, lng: 1 }]);
    const calls = stubFetch(40501);
    const status = await collectGridProgress('default', { ...entry, task_ids: [] }, creds);
    expect(status.status).toBe('pending');
    expect(calls.some((url) => url.includes('task_post'))).toBe(true);
    expect(getGridProgressForProject('default', 'run-1')!.pendingTasks[0]).toMatchObject({ task_id: 'new-task', attempts: 2 });
  });

  it('marks the point as no data once the attempts run out', async () => {
    saveGridSearchPendingForProject('default', entry, [{ task_id: 't', row: 0, col: 0, lat: 1, lng: 1, attempts: MAX_POINT_ATTEMPTS }]);
    stubFetch(40501);
    const status = await collectGridProgress('default', { ...entry, task_ids: [] }, creds);
    expect(status.status).toBe('done');
    expect(getGridProgressForProject('default', 'run-1')!.results[0]).toMatchObject({ rank: null, failed: true });
  });

  it('stores a normal result', async () => {
    saveGridSearchPendingForProject('default', entry, [{ task_id: 't', row: 0, col: 0, lat: 1, lng: 1 }]);
    stubFetch(20000);
    await collectGridProgress('default', { ...entry, task_ids: [] }, creds);
    const [point] = getGridProgressForProject('default', 'run-1')!.results;
    expect(point.rank).toBe(4);
    expect(point.failed).toBeUndefined();
  });
});
