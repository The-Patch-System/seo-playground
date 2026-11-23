// Patch fork: a failed DataForSEO task is re-posted, and only marked "no data" after retries.
import { describe, it, expect, afterAll, afterEach, beforeEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grid-progress-test-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');

import { getGridProgressForProject, saveGridSearchPendingForProject, type GridSearchEntry, type GridTaskPoint } from './db';
import { collectGridProgress, MAX_POINT_ATTEMPTS } from './grid-progress';
import { fetchOneGridPoint, postGridTaskChunk } from '@/app/dashboard/local-finder/grid-api';
import { loadDfsFixture, withTaskId } from './__fixtures__/dfs/load';

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
    return new Response(JSON.stringify({ tasks: [{ status_code: taskGetStatus, result: taskGetStatus === 20000 ? [{ items: [1, 2, 3].map((n) => ({ type: 'local_pack', rank_group: n, title: `Other ${n}`, cid: `9${n}` })).concat([{ type: 'local_pack', rank_group: 4, title: 'Us', cid: '1' }]) }] : null }] }));
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

// Patch fork: the wrong-city retry loop, with real Nov 15 2026 King George responses. The point is
// the bad task's own coordinate; the good response (a neighbor ~4 km away) is clean from there.
describe('collectGridProgress wrong-city and error retries', () => {
  const bad = loadDfsFixture('kg-bad');
  const good = loadDfsFixture('kg-good');
  const t0 = Date.parse('2026-11-15T17:00:00Z');
  const MIN = 60_000;
  const kgEntry: GridSearchEntry = {
    ...entry, id: 'run-kg', series_id: 'grid-kg', keyword: bad.keyword, center: `${bad.lat},${bad.lng}`,
    target: `Fusion Rehab and Wellness (cid:${good.items[1].cid})`,
  };
  const task = (extra: Partial<GridTaskPoint> = {}): GridTaskPoint => ({ task_id: 'p1', row: 0, col: 0, lat: bad.lat, lng: bad.lng, attempts: 1, submitted_at: t0, ...extra });
  const collect = () => collectGridProgress('default', { ...kgEntry, task_ids: [] }, creds);
  const progress = () => getGridProgressForProject('default', 'run-kg')!;

  /** task_get serves `responses[id]` (a body, or a status code to return with no result); task_post hands out ids. */
  function stubDfs(responses: Record<string, unknown>, post: { ids?: string[]; status?: number } = {}) {
    const gets: string[] = [];
    const posts: Array<Array<Record<string, unknown>>> = [];
    const ids = [...(post.ids ?? ['new-1', 'new-2', 'new-3'])];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('task_post')) {
        posts.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ tasks: [{ id: ids.shift() ?? 'extra', status_code: post.status ?? 20100, cost: 0.0018 }] }));
      }
      const id = url.split('/').pop()!;
      gets.push(id);
      const response = responses[id];
      if (typeof response === 'number') return new Response(JSON.stringify({ tasks: [{ id, status_code: response }] }));
      if (!response) throw new Error(`unexpected task_get ${id}`);
      return new Response(JSON.stringify(response));
    }));
    return { gets, posts };
  }

  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); });
  afterEach(() => { vi.useRealTimers(); });

  it('holds a wrong-city point for 5 min, re-posts it, waits 30 min after a 2nd, and fails it after a 3rd', async () => {
    saveGridSearchPendingForProject('default', kgEntry, [task()]);
    const dfs = stubDfs({ p1: bad.body, 'new-1': withTaskId(bad, 'new-1'), 'new-2': withTaskId(bad, 'new-2') });

    vi.setSystemTime(t0 + 2 * MIN);
    expect((await collect()).status).toBe('pending');
    let { results, pendingTasks } = progress();
    expect(results).toEqual([]);
    expect(dfs.posts).toHaveLength(0);
    expect(pendingTasks[0]).toMatchObject({ task_id: 'p1', awaiting_retry: true, retry_due_at: t0 + 5 * MIN, attempts: 1 });
    expect(pendingTasks[0].rechecks).toEqual([expect.objectContaining({ task_id: 'p1', check_url: bad.checkUrl, reason: 'wrong_city' })]);
    expect(pendingTasks[0].rechecks![0].far!.map((f) => f.place)).toContain('Tulsa, OK');

    // Not due yet: neither checked again nor re-posted.
    vi.setSystemTime(t0 + 4 * MIN);
    await collect();
    expect(dfs.gets).toEqual(['p1']);
    expect(dfs.posts).toHaveLength(0);

    vi.setSystemTime(t0 + 5 * MIN);
    await collect();
    expect(dfs.posts).toHaveLength(1);
    expect(dfs.posts[0]).toEqual([expect.objectContaining({
      keyword: bad.keyword, location_coordinate: bad.body.tasks[0].data.location_coordinate, depth: 30, priority: 1, tag: 'grid-kg|r0c0',
    })]);
    ({ pendingTasks } = progress());
    expect(pendingTasks).toHaveLength(1);
    expect(pendingTasks[0]).toMatchObject({ task_id: 'new-1', attempts: 2, submitted_at: t0 + 5 * MIN });
    expect(pendingTasks[0].awaiting_retry).toBeUndefined();
    expect(pendingTasks[0].rechecks).toHaveLength(1);

    // 2nd wrong-city: the 3rd search waits 30 min after the 2nd was posted.
    vi.setSystemTime(t0 + 6 * MIN);
    await collect();
    ({ pendingTasks } = progress());
    expect(pendingTasks[0]).toMatchObject({ task_id: 'new-1', awaiting_retry: true, retry_due_at: t0 + 35 * MIN });
    vi.setSystemTime(t0 + 34 * MIN);
    await collect();
    expect(dfs.posts).toHaveLength(1);
    vi.setSystemTime(t0 + 35 * MIN);
    await collect();
    expect(dfs.posts).toHaveLength(2);
    expect(progress().pendingTasks[0]).toMatchObject({ task_id: 'new-2', attempts: 3 });

    // 3rd wrong-city: no searches left, the point is stored as failed with all three tasks as evidence.
    vi.setSystemTime(t0 + 36 * MIN);
    expect((await collect()).status).toBe('done');
    expect(dfs.posts).toHaveLength(2);
    ({ results } = progress());
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ rank: null, items: [], failed: true, failed_reason: 'wrong_city', task_id: 'new-2', check_url: bad.checkUrl });
    expect(results[0].rechecks!.map((r) => [r.task_id, r.reason])).toEqual([['p1', 'wrong_city'], ['new-1', 'wrong_city'], ['new-2', 'wrong_city']]);
  });

  it('stores the clean re-check with its own task_id and check_url, keeping the wrong-city evidence', async () => {
    saveGridSearchPendingForProject('default', kgEntry, [task()]);
    stubDfs({ p1: bad.body, 'new-1': withTaskId(good, 'new-1') });
    vi.setSystemTime(t0 + 2 * MIN);
    await collect();
    vi.setSystemTime(t0 + 5 * MIN);
    await collect();
    vi.setSystemTime(t0 + 6 * MIN);
    expect((await collect()).status).toBe('done');
    const [point] = progress().results;
    expect(point).toMatchObject({ rank: 2, task_id: 'new-1', check_url: good.checkUrl });
    expect(point.failed).toBeUndefined();
    expect(point.items![0].place).toBe('King George, VA');
    expect(point.rechecks).toEqual([expect.objectContaining({ task_id: 'p1', reason: 'wrong_city' })]);
  });

  it('keeps task_id and check_url on a clean first result', async () => {
    saveGridSearchPendingForProject('default', kgEntry, [task({ task_id: good.id })]);
    const dfs = stubDfs({ [good.id]: good.body });
    vi.setSystemTime(t0 + MIN);
    await collect();
    const [point] = progress().results;
    expect(point).toMatchObject({ task_id: good.id, check_url: good.checkUrl, rank: 2, raw_count: 20, organic_count: 20, paid_count: 0 });
    expect(point.rechecks).toBeUndefined();
    expect(dfs.posts).toHaveLength(0);
  });

  it('re-posts at once when a 20000 task has no result object (task_error)', async () => {
    saveGridSearchPendingForProject('default', kgEntry, [task()]);
    const dfs = stubDfs({ p1: { tasks: [{ id: 'p1', status_code: 20000, result: null }] } });
    vi.setSystemTime(t0 + MIN);
    await collect();
    expect(dfs.posts).toHaveLength(1);
    const [pending] = progress().pendingTasks;
    expect(pending).toMatchObject({ task_id: 'new-1', attempts: 2, rechecks: [{ task_id: 'p1', reason: 'task_error' }] });
    expect(progress().results).toEqual([]);
  });

  it('re-posts at once when a 20000 result has no items field (task_error)', async () => {
    saveGridSearchPendingForProject('default', kgEntry, [task()]);
    const dfs = stubDfs({ p1: { tasks: [{ id: 'p1', status_code: 20000, result: [{ check_url: 'u' }] }] } });
    vi.setSystemTime(t0 + MIN);
    await collect();
    expect(dfs.posts).toHaveLength(1);
    expect(progress().pendingTasks[0].rechecks).toEqual([{ task_id: 'p1', check_url: 'u', reason: 'task_error' }]);
  });

  it('waits on a pending task for 30 min, then re-posts it as a timeout', async () => {
    saveGridSearchPendingForProject('default', kgEntry, [task()]);
    const dfs = stubDfs({ p1: 40602 });
    vi.setSystemTime(t0 + 29 * MIN);
    await collect();
    expect(dfs.posts).toHaveLength(0);
    expect(progress().pendingTasks[0]).toMatchObject({ task_id: 'p1' });
    expect(progress().pendingTasks[0].awaiting_retry).toBeUndefined();
    vi.setSystemTime(t0 + 31 * MIN);
    await collect();
    expect(dfs.posts).toHaveLength(1);
    expect(progress().pendingTasks[0]).toMatchObject({ task_id: 'new-1', attempts: 2, rechecks: [{ task_id: 'p1', reason: 'timeout' }] });
  });

  it.each([
    ['an HTTP 500', () => new Response('{"status_code":50000}', { status: 500 })],
    ['a network error', () => { throw new Error('socket hang up'); }],
    ['a body that is not JSON', () => new Response('<html>bad gateway</html>')],
  ])('times out a task whose task_get keeps failing with %s', async (_label, fail) => {
    saveGridSearchPendingForProject('default', kgEntry, [task()]);
    const posts: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('task_post')) {
        posts.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ tasks: [{ id: 'new-1', status_code: 20100, cost: 0.0018 }] }));
      }
      return fail();
    }));
    vi.setSystemTime(t0 + 29 * MIN);
    await collect();
    expect(posts).toHaveLength(0);
    expect(progress().pendingTasks[0]).toMatchObject({ task_id: 'p1' });
    vi.setSystemTime(t0 + 31 * MIN);
    await collect();
    expect(posts).toHaveLength(1);
    expect(progress().pendingTasks[0]).toMatchObject({ task_id: 'new-1', attempts: 2, rechecks: [{ task_id: 'p1', reason: 'timeout' }] });
  });

  it('backs off 60 s after a rejected re-post and fails the point after 3 rejections', async () => {
    saveGridSearchPendingForProject('default', kgEntry, [task()]);
    const dfs = stubDfs({ p1: 40501 }, { status: 40501 });
    vi.setSystemTime(t0 + MIN);
    await collect();
    expect(dfs.posts).toHaveLength(1);
    expect(progress().pendingTasks[0]).toMatchObject({ task_id: 'p1', post_failures: 1, awaiting_retry: true, retry_due_at: t0 + 2 * MIN });
    vi.setSystemTime(t0 + MIN + 30_000);
    await collect();
    expect(dfs.posts).toHaveLength(1);
    vi.setSystemTime(t0 + 2 * MIN);
    await collect();
    expect(dfs.posts).toHaveLength(2);
    expect(progress().pendingTasks[0]).toMatchObject({ post_failures: 2, retry_due_at: t0 + 3 * MIN });
    vi.setSystemTime(t0 + 3 * MIN);
    expect((await collect()).status).toBe('done');
    expect(dfs.posts).toHaveLength(3);
    expect(progress().results[0]).toMatchObject({ failed: true, failed_reason: 'task_error', task_id: 'p1' });
    // Only the one task_get: an awaiting point is never re-checked.
    expect(dfs.gets).toEqual(['p1']);
  });
});

describe('postGridTaskChunk', () => {
  it('sends depth 30 and the tag, and only counts tasks with an id and a non-error status as accepted', async () => {
    let body: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ tasks: [{ id: 'a', status_code: 20100, cost: 0.0018 }, { id: 'b', status_code: 40501, cost: 0.0018 }, { status_code: 20100 }] }));
    }));
    const req = { keyword: 'pt', lat: 1, lng: 2, language: 'English', priority: 1 as const };
    const posted = await postGridTaskChunk([{ ...req, tag: 'run|r0c0' }, req, req], 'auth');
    expect(body[0]).toEqual({ keyword: 'pt', location_coordinate: '1.000000,2.000000', language_name: 'English', depth: 30, priority: 1, tag: 'run|r0c0' });
    expect(body[1].tag).toBeUndefined();
    expect(posted.results).toEqual([
      { taskId: 'a', statusCode: 20100, cost: 0.0018 }, { taskId: null, statusCode: 40501, cost: 0 }, { taskId: null, statusCode: 20100, cost: 0 },
    ]);
  });

  it('reports a network failure as an error with no results', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('socket hang up'); }));
    expect(await postGridTaskChunk([{ keyword: 'pt', lat: 1, lng: 2, language: 'English', priority: 1 }], 'auth')).toEqual({ results: [], error: 'socket hang up' });
  });
});

describe('fetchOneGridPoint (live path)', () => {
  const bad = loadDfsFixture('kg-bad');
  const good = loadDfsFixture('kg-good');
  const coord = { row: 1, col: 2, lat: bad.lat, lng: bad.lng };
  function stubLive(bodies: unknown[]) {
    const sent: Array<Array<Record<string, unknown>>> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify(bodies.shift()));
    }));
    return sent;
  }

  it('re-requests a wrong-city result and keeps the evidence', async () => {
    const sent = stubLive([withTaskId(bad, 'live-1'), withTaskId(good, 'live-2')]);
    const { point } = await fetchOneGridPoint(bad.keyword, coord, 'English', 'auth', '', 'grid-x');
    expect(sent).toHaveLength(2);
    expect(sent[0][0]).toMatchObject({ depth: 30, tag: 'grid-x|r1c2' });
    expect(point).toMatchObject({ task_id: 'live-2', check_url: good.checkUrl, rechecks: [{ task_id: 'live-1', reason: 'wrong_city' }] });
    expect(point.failed).toBeUndefined();
  });

  it(`stores a failed wrong_city point after ${MAX_POINT_ATTEMPTS} wrong-city results`, async () => {
    stubLive([withTaskId(bad, 'live-1'), withTaskId(bad, 'live-2'), withTaskId(bad, 'live-3'), withTaskId(good, 'never')]);
    const { point, cost } = await fetchOneGridPoint(bad.keyword, coord, 'English', 'auth', '');
    expect(point).toMatchObject({ failed: true, failed_reason: 'wrong_city', task_id: 'live-3', rank: null, items: [] });
    expect(point.rechecks!.map((r) => r.task_id)).toEqual(['live-1', 'live-2', 'live-3']);
    expect(cost).toBe(0);
  });

  it('treats a 20000 task with no result object as an error, not an empty point', async () => {
    stubLive([{ tasks: [{ id: 'e1', status_code: 20000, result: null }] }, { tasks: [{ id: 'e2', status_code: 20000, result: null }] }]);
    const { point } = await fetchOneGridPoint(bad.keyword, coord, 'English', 'auth', '');
    expect(point).toMatchObject({ failed: true, failed_reason: 'task_error', task_id: 'e2' });
  });
});
