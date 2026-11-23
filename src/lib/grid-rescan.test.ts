// Patch fork: in-place re-scans of finished Geo-grid runs (grid-rescan.ts), end to end against a
// stubbed DataForSEO that serves real Nov 15 2026 King George responses per submitted task.
import { describe, it, expect, afterAll, afterEach, beforeAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grid-rescan-test-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');

import {
  createProject, getControlDb, getDbForProject, getProjects, saveGridSchedule, saveImportedGridRunForProject,
  type GridPoint, type GridSearchEntry, type Project,
} from './db';
import {
  advanceRescans, applyRescanAction, getBudget, newRescanCounters, previewRescan, rescanStatus, rescannedAt,
  RESCAN_MAX_RUNS_PER_MANIFEST, runSafety, setBudgetLimit, setExclusions, startRescan, validateSelector,
} from './grid-rescan';
import { loadDfsFixture, withTaskId } from './__fixtures__/dfs/load';

const bad = loadDfsFixture('kg-bad');
const good = loadDfsFixture('kg-good');
const creds = { login: 'l', pass: 'p' };
const MIN = 60_000;
const DAY = 86_400_000;
// The target is listed #2 in the good response.
const target = `Fusion Rehab and Wellness (cid:${good.items[1].cid})`;

let projectB: Project;
let clock = Date.parse('2026-12-01T15:00:00Z');
/** Moves the (Date-only) fake clock; every test starts a day after the last so ledger times never go backwards. */
const setNow = (ms: number) => { clock = ms; vi.setSystemTime(ms); };
const freshDay = () => { setNow(clock + DAY); return clock; };

// --- Stubbed DataForSEO ------------------------------------------------------------------------------

type Reply = 'bad' | 'good' | 'error' | 'pending';
let reply: (tag: string) => Reply = () => 'good';
let postMode: 'ok' | 'throw' | 'http500' | 'http400' | 'missing' = 'ok';
let postCalls = 0;
const postedTags: string[] = [];
const postedPriorities: number[] = [];
let postCost = 0.0018;
/** Runs inside the stubbed task_post, after the request is "sent" (e.g. a cancel racing the POST). */
let onPost: ((tags: string[]) => void) | null = null;

function stubDataForSeo() {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('task_post')) {
      postCalls += 1;
      if (postMode === 'throw') throw new Error('socket hang up');
      if (postMode === 'http500') return new Response('oops', { status: 500 });
      if (postMode === 'http400') return new Response(JSON.stringify({ status_code: 40000, status_message: 'Bad Request' }), { status: 400 });
      const body = JSON.parse(String(init?.body)) as Array<{ tag: string; depth: number; priority: number }>;
      for (const task of body) expect(task.depth).toBe(30);
      postedTags.push(...body.map((t) => t.tag));
      postedPriorities.push(...body.map((t) => t.priority));
      onPost?.(body.map((t) => t.tag));
      if (postMode === 'missing') return new Response(JSON.stringify({ status_code: 20000, tasks: [] }));
      return new Response(JSON.stringify({ tasks: body.map((t) => ({ id: `id-${t.tag}`, status_code: 20100, cost: postCost })) }));
    }
    const id = url.split('/').pop()!;
    const kind = reply(id.slice(3));
    if (kind === 'bad') return new Response(JSON.stringify(withTaskId(bad, id)));
    if (kind === 'good') return new Response(JSON.stringify(withTaskId(good, id)));
    if (kind === 'pending') return new Response(JSON.stringify({ tasks: [{ id, status_code: 40602 }] }));
    return new Response(JSON.stringify({ tasks: [{ id, status_code: 20000, result: null }] }));
  }));
}

// --- Seeding and inspection --------------------------------------------------------------------------

/** The run's original (wrong-city era) points: everything at the King George point, target not found. */
function oldPoints(size: number): GridPoint[] {
  const points: GridPoint[] = [];
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      points.push({ row, col, lat: bad.lat, lng: bad.lng, rank: null, items: [{ rank_group: 1, title: 'Physical Therapy of Tulsa', cid: bad.items[0].cid!, is_target: false }] });
    }
  }
  return points;
}

function seedRun(projectId: string, id: string, opts: { ts?: number; size?: number; series?: string; results?: GridPoint[]; queueMode?: GridSearchEntry['queue_mode'] } = {}): GridSearchEntry {
  const entry: GridSearchEntry = {
    id, series_id: opts.series ?? `grid-${id}`, ts: opts.ts ?? Date.parse('2026-10-15T17:00:00Z'), keyword: bad.keyword, target,
    center: `${bad.lat},${bad.lng}`, grid_size: opts.size ?? 1, spacing_km: 2, language: 'English', status: 'done', queue_mode: opts.queueMode ?? 'standard',
  };
  saveImportedGridRunForProject(projectId, entry, opts.results ?? oldPoints(entry.grid_size));
  return entry;
}

const runJson = (projectId: string, runId: string) =>
  (getDbForProject(projectId).prepare('SELECT results, ts FROM grid_searches WHERE id = ?').get(runId) as { results: string; ts: number } | undefined);
const gridSizeOf = (projectId: string, runId: string) =>
  (getDbForProject(projectId).prepare('SELECT grid_size FROM grid_searches WHERE id = ?').get(runId) as { grid_size: number } | undefined)?.grid_size ?? 0;
const rescanRow = (projectId: string, runId: string) =>
  getDbForProject(projectId).prepare('SELECT * FROM grid_rescans WHERE run_id = ?').get(runId) as
    { state: string; hold_reason: string | null; attempt: number; swapped_at: number | null } | undefined;
const attemptRows = (projectId: string, runId: string) =>
  getDbForProject(projectId).prepare('SELECT * FROM grid_rescan_attempts WHERE run_id = ? ORDER BY attempt').all(runId) as
    Array<{ attempt: number; state: string; hold_reason: string | null; results: string; results_before: string | null; task_points: string }>;
const submissions = (projectId: string, runId: string) =>
  getDbForProject(projectId).prepare('SELECT tag, state, seq FROM grid_rescan_submissions WHERE run_id = ? ORDER BY submitted_at, tag').all(runId) as
    Array<{ tag: string; state: string; seq: number }>;
const safetyOf = (projectId: string, runId: string) => {
  const raw = runJson(projectId, runId);
  return runSafety(projectId, runId, raw ? JSON.parse(raw.results) as GridPoint[] : [], gridSizeOf(projectId, runId));
};
const rescanCount = () => getProjects().reduce((n, p) => n + (getDbForProject(p.id).prepare('SELECT COUNT(*) AS n FROM grid_rescans').get() as { n: number }).n, 0);

async function pass(projectId = 'default') {
  const counters = newRescanCounters();
  await advanceRescans(projectId, creds, counters);
  return counters;
}

/** preview(run_ids) + start, asserting both succeed. */
function queue(runIds: string[], label = 'test') {
  const preview = previewRescan({ run_ids: runIds, label });
  expect(preview.startable).toBe(true);
  const started = startRescan(preview.manifest_id);
  if ('error' in started) throw new Error(started.error);
  return { preview, started };
}

/** Collects the [geo-grid-alert] lines logged while it is active. */
function captureAlerts() {
  const alerts: Array<Record<string, unknown> & { kind?: string; run_id?: string; reason?: string }> = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    const line = args.map(String).join(' ');
    if (line.startsWith('[geo-grid-alert] ')) alerts.push(JSON.parse(line.slice('[geo-grid-alert] '.length)));
  });
  return { alerts, restore: () => spy.mockRestore() };
}

beforeAll(() => {
  projectB = createProject({ name: 'Clinic B', domain: 'clinic-b.example', defaultLocation: '', defaultLanguage: '', defaultCoordinates: '', rankTrackerDepth: '100' });
  vi.useFakeTimers({ toFake: ['Date'] });
  stubDataForSeo();
});

afterEach(() => {
  // Leave nothing active for the next test's worker passes.
  for (const project of getProjects()) {
    const active = getDbForProject(project.id).prepare("SELECT run_id FROM grid_rescans WHERE state IN ('queued', 'posting', 'scanning')").all() as Array<{ run_id: string }>;
    if (active.length) applyRescanAction('cancel', active.map((r) => r.run_id));
  }
  reply = () => 'good';
  postMode = 'ok';
  postCost = 0.0018;
  onPost = null;
});

afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// --- Selection, preview and manifests ---------------------------------------------------------------

describe('selection and preview', () => {
  it('selects runs by their date in the clinic time zone, across projects', () => {
    freshDay();
    // 03:00 UTC on Nov 16 is still Nov 15 in Los Angeles.
    const la = seedRun(projectB.id, 'run-la', { ts: Date.parse('2026-11-16T03:00:00Z'), series: 'grid-la' });
    saveGridSchedule({ ...la, frequency: 'monthly', weekday: 15, time_of_day: '12:00', time_zone: 'America/Los_Angeles' }, projectB.id);
    seedRun('default', 'run-utc', { ts: Date.parse('2026-11-16T03:00:00Z'), series: 'grid-utc' });
    seedRun('default', 'run-nov15', { ts: Date.parse('2026-11-15T17:00:00Z'), series: 'grid-nov15' });

    const nov15 = previewRescan({ date: '2026-11-15', all: true });
    expect(nov15.selected.map((r) => r.run_id)).toEqual(['run-nov15', 'run-la']);
    expect(nov15.selected.find((r) => r.run_id === 'run-la')).toMatchObject({ project_id: projectB.id, project_name: 'Clinic B', monitor_id: 'grid-la', points: 1 });
    const nov16 = previewRescan({ date: '2026-11-16', all: true });
    expect(nov16.selected.map((r) => r.run_id)).toEqual(['run-utc']);
    expect(nov15).toMatchObject({ startable: true, runs: 2, points: 2, estimated_cost: 0.0036, price_per_task: 0.0018 });
  });

  it('excludes monitors persistently and per request, and flags excluded runs on start', () => {
    freshDay();
    setExclusions(['grid-nov15'], 'client paused', true);
    const preview = previewRescan({ date: '2026-11-15', all: true, exclude_monitor_ids: ['grid-la'] });
    expect(preview.selected).toEqual([]);
    expect(preview.excluded.map((r) => [r.run_id, r.reason])).toEqual([['run-nov15', 'client paused'], ['run-la', 'excluded in this request']]);
    expect(startRescan(preview.manifest_id)).toEqual({ queued: [], skipped: [] });
    expect(safetyOf('default', 'run-nov15')).toEqual({ report_safe: false, reason: 'excluded_from_rescan' });
    expect(safetyOf(projectB.id, 'run-la')).toEqual({ report_safe: false, reason: 'excluded_from_rescan' });
    setExclusions(['grid-nov15'], '', false);
    expect(previewRescan({ date: '2026-11-15', all: true }).selected.map((r) => r.run_id)).toContain('run-nov15');
  });

  it('preview only writes a manifest', () => {
    freshDay();
    seedRun('default', 'run-preview');
    const before = runJson('default', 'run-preview');
    const rescansBefore = rescanCount();
    const preview = previewRescan({ run_ids: ['run-preview'], label: 'dry' });
    expect(preview).toMatchObject({ startable: true, runs: 1, label: 'dry', selected: [{ run_id: 'run-preview' }] });
    expect(runJson('default', 'run-preview')).toEqual(before);
    expect(rescanCount()).toBe(rescansBefore);
    // The seeded (pre-fix) points were never wrong-city checked: unknown, not safe.
    expect(safetyOf('default', 'run-preview')).toEqual({ report_safe: null, reason: 'not_checked' });
    const manifest = getControlDb().prepare('SELECT * FROM grid_rescan_manifests WHERE manifest_id = ?').get(preview.manifest_id) as { runs: string; started_at: number | null };
    expect(JSON.parse(manifest.runs)).toHaveLength(1);
    expect(manifest.started_at).toBeNull();
  });

  it('skips imported runs and runs that are not done', () => {
    freshDay();
    seedRun('default', 'import-123');
    const pending = seedRun('default', 'run-pending-x');
    getDbForProject('default').prepare("UPDATE grid_searches SET status = 'pending' WHERE id = ?").run(pending.id);
    const preview = previewRescan({ run_ids: ['import-123', 'run-pending-x'] });
    expect(preview.selected).toEqual([]);
    expect(preview.skipped.map((r) => [r.run_id, r.reason])).toEqual([['import-123', 'imported run'], ['run-pending-x', 'run is pending']]);
  });

  it('validates selectors', () => {
    expect(validateSelector({})).toBe('A date or run_ids is required.');
    expect(validateSelector({ date: '11/15/2026' })).toBe('date must be YYYY-MM-DD.');
    expect(validateSelector({ date: '2026-11-15', all: true, run_ids: ['a'] })).toMatch(/not both/);
    expect(validateSelector({ date: '2026-11-15', monitor_ids: ['m'], exclude_monitor_ids: ['m'] })).toMatch(/both selected and excluded/);
    expect(validateSelector({ run_ids: [''] })).toBe('run_ids must be a list of ids.');
    expect(validateSelector({ date: '2026-11-15' })).toBeNull();
    expect(validateSelector({ run_ids: ['a'] })).toBeNull();
  });

  it(`caps a manifest at ${RESCAN_MAX_RUNS_PER_MANIFEST} runs unless it was made with all: true`, () => {
    freshDay();
    const ids = Array.from({ length: RESCAN_MAX_RUNS_PER_MANIFEST + 1 }, (_, i) => `run-cap-${String(i).padStart(2, '0')}`);
    for (const id of ids) seedRun(projectB.id, id, { ts: Date.parse('2026-10-01T15:00:00Z') });
    const tooMany = previewRescan({ run_ids: ids });
    expect(tooMany).toMatchObject({ startable: false, runs: 26 });
    expect(tooMany.not_startable_reason).toMatch(/More than 25 runs/);
    expect(startRescan(tooMany.manifest_id)).toEqual({ error: expect.stringMatching(/26 runs/) });
    const byDate = previewRescan({ date: '2026-10-01' });
    expect(byDate.startable).toBe(false);
    expect(startRescan(byDate.manifest_id)).toEqual({ error: expect.stringMatching(/all: true/) });
    expect(previewRescan({ date: '2026-10-01', all: true })).toMatchObject({ startable: true, runs: 26 });
    expect(startRescan('no-such-manifest')).toEqual({ error: expect.stringMatching(/not found/) });
    expect(rescanRow(projectB.id, ids[0])).toBeUndefined();
  });
});

// --- The worker ------------------------------------------------------------------------------------

describe('re-scan worker', () => {
  it('re-posts a wrong-city point after 5 min and swaps in the clean result', async () => {
    const t = freshDay();
    const entry = seedRun('default', 'run-swap');
    const original = runJson('default', 'run-swap')!;
    reply = (tag) => (tag.endsWith(':s1') ? 'bad' : 'good');
    const { preview, started } = queue(['run-swap'], 'nov15');
    expect(started).toEqual({ queued: ['run-swap'], skipped: [] });
    expect(rescanRow('default', 'run-swap')).toMatchObject({ state: 'queued', attempt: 1 });
    expect(safetyOf('default', 'run-swap')).toEqual({ report_safe: false, reason: 'pending_rescan' });

    expect(await pass()).toMatchObject({ started: 1 });
    expect(rescanRow('default', 'run-swap')!.state).toBe('scanning');
    expect(postedTags.at(-1)).toBe('rs:run-swap:a1:r0c0:s1');

    setNow(t + MIN);
    await pass();
    const [waiting] = JSON.parse(attemptRows('default', 'run-swap')[0].task_points);
    expect(waiting).toMatchObject({ awaiting_retry: true, retry_due_at: t + 5 * MIN, rechecks: [{ reason: 'wrong_city' }] });
    // Mid-scan status counts the in-flight detection and gives no partial "after" average.
    const midScan = rescanStatus({ manifest_id: preview.manifest_id });
    expect(midScan.runs![0]).toMatchObject({
      state: 'scanning', points_collected: 0, points_pending: 1, points_awaiting_retry: 1,
      wrong_city: { detected: 1, points_left: 0, points_rechecking: 1 }, mrt_average_position: { before: 21, after: null },
    });
    expect(midScan.wrong_city_detections).toEqual([expect.objectContaining({ run_id: 'run-swap', row: 0, col: 0, resolved: null })]);
    setNow(t + 4 * MIN);
    const postsBefore = postedTags.length;
    await pass();
    expect(postedTags.length).toBe(postsBefore);

    setNow(t + 5 * MIN);
    await pass();
    expect(postedTags.at(-1)).toBe('rs:run-swap:a1:r0c0:s2');
    expect(runJson('default', 'run-swap')).toEqual(original);

    setNow(t + 6 * MIN);
    expect(await pass()).toMatchObject({ swapped: 1 });
    expect(rescanRow('default', 'run-swap')).toMatchObject({ state: 'swapped', swapped_at: t + 6 * MIN });
    const after = runJson('default', 'run-swap')!;
    expect(after.ts).toBe(entry.ts);
    const [point] = JSON.parse(after.results) as GridPoint[];
    expect(point).toMatchObject({ row: 0, col: 0, rank: 2, task_id: 'id-rs:run-swap:a1:r0c0:s2', check_url: good.checkUrl });
    expect(point.rechecks).toEqual([expect.objectContaining({ task_id: 'id-rs:run-swap:a1:r0c0:s1', reason: 'wrong_city' })]);
    expect(attemptRows('default', 'run-swap')[0]).toMatchObject({ state: 'swapped', results_before: original.results });
    expect(rescannedAt('default', 'run-swap')).toBe(new Date(t + 6 * MIN).toISOString());
    expect(safetyOf('default', 'run-swap')).toEqual({ report_safe: true, reason: null });
    expect(submissions('default', 'run-swap').map((s) => s.state)).toEqual(['accepted', 'accepted']);

    const status = rescanStatus({ manifest_id: preview.manifest_id });
    if (!status.runs) throw new Error('expected runs');
    expect(status.counts).toEqual({ swapped: 1 });
    expect(status.runs[0]).toMatchObject({
      run_id: 'run-swap', state: 'swapped', accepted_searches: 2, cost: 0.0036, wrong_city: { detected: 1, points_left: 0, points_rechecking: 0 },
      mrt_average_position: { before: 21, after: 2 },
    });
    expect(status.wrong_city_detections).toEqual([expect.objectContaining({ run_id: 'run-swap', resolved: true })]);

    // Starting the same manifest again, or previewing the run again, does nothing.
    expect(startRescan(preview.manifest_id)).toEqual({ queued: [], skipped: [{ run_id: 'run-swap', reason: 'already swapped' }] });
    expect(previewRescan({ run_ids: ['run-swap'] }).skipped).toEqual([expect.objectContaining({ run_id: 'run-swap', reason: 'already swapped' })]);
  });

  it('undo restores the old points, and refuses when the run changed after the swap', async () => {
    freshDay();
    const original = runJson('default', 'run-swap')!.results;
    expect(applyRescanAction('undo', ['run-swap'])).toEqual([{ run_id: 'run-swap', ok: true, state: 'undone' }]);
    expect(runJson('default', 'run-swap')!.results).toBe(attemptRows('default', 'run-swap')[0].results_before);
    expect(runJson('default', 'run-swap')!.results).not.toBe(original);
    expect(safetyOf('default', 'run-swap')).toEqual({ report_safe: false, reason: 'original_restored' });
    expect(rescannedAt('default', 'run-swap')).toBeNull();
    expect(applyRescanAction('undo', ['run-swap'])[0]).toMatchObject({ ok: false, state: 'undone' });

    const t = clock;
    const entry = seedRun('default', 'run-undo-changed');
    queue(['run-undo-changed']);
    await pass();
    setNow(t + MIN);
    await pass();
    expect(rescanRow('default', 'run-undo-changed')!.state).toBe('swapped');
    saveImportedGridRunForProject('default', entry, oldPoints(1).map((p) => ({ ...p, rank: 7 })));
    expect(applyRescanAction('undo', ['run-undo-changed'])).toEqual([
      { run_id: 'run-undo-changed', ok: false, state: 'swapped', error: 'The run changed after the swap; refusing to overwrite it.' },
    ]);
    expect(JSON.parse(runJson('default', 'run-undo-changed')!.results)[0].rank).toBe(7);
  });

  it('holds a point that stays wrong-city (5 min, then 30 min) and leaves the old points alone; retry starts attempt 2', async () => {
    const t = freshDay();
    seedRun('default', 'run-persist');
    const original = runJson('default', 'run-persist')!;
    reply = () => 'bad';
    queue(['run-persist']);
    await pass();
    setNow(t + MIN); await pass();
    setNow(t + 5 * MIN); await pass();
    setNow(t + 6 * MIN); await pass();
    setNow(t + 34 * MIN); await pass();
    expect(postedTags.filter((tag) => tag.startsWith('rs:run-persist:'))).toHaveLength(2);
    setNow(t + 35 * MIN); await pass();
    expect(postedTags.filter((tag) => tag.startsWith('rs:run-persist:'))).toEqual([
      'rs:run-persist:a1:r0c0:s1', 'rs:run-persist:a1:r0c0:s2', 'rs:run-persist:a1:r0c0:s3',
    ]);
    setNow(t + 36 * MIN);
    expect(await pass()).toMatchObject({ held: 1 });
    expect(rescanRow('default', 'run-persist')).toMatchObject({ state: 'held', hold_reason: 'wrong_city_persistent' });
    expect(runJson('default', 'run-persist')).toEqual(original);
    expect(safetyOf('default', 'run-persist')).toEqual({ report_safe: false, reason: 'wrong_city_persistent' });
    const unsafe = rescanStatus({ unsafe: true });
    if (!unsafe.unsafe) throw new Error('expected unsafe list');
    const flagged = unsafe.unsafe.find((u) => u.run_id === 'run-persist')!;
    expect(flagged.reason).toBe('wrong_city_persistent');
    expect(flagged.evidence[0]).toMatchObject({ row: 0, col: 0, reason: 'wrong_city' });
    expect(flagged.evidence[0].rechecks).toHaveLength(3);

    // Retry: a new attempt; the held attempt's row stays as a record.
    expect(applyRescanAction('retry', ['run-persist'])).toEqual([{ run_id: 'run-persist', ok: true, state: 'queued' }]);
    expect(rescanRow('default', 'run-persist')).toMatchObject({ state: 'queued', attempt: 2, hold_reason: null });
    reply = () => 'good';
    setNow(t + 40 * MIN); await pass();
    expect(postedTags.at(-1)).toBe('rs:run-persist:a2:r0c0:s1');
    setNow(t + 41 * MIN); await pass();
    expect(rescanRow('default', 'run-persist')).toMatchObject({ state: 'swapped', attempt: 2 });
    expect(attemptRows('default', 'run-persist').map((a) => [a.attempt, a.state, a.hold_reason])).toEqual([
      [1, 'held', 'wrong_city_persistent'], [2, 'swapped', null],
    ]);
    expect(safetyOf('default', 'run-persist').report_safe).toBe(true);
  });

  it('holds a run with more than 2 points that keep erroring', async () => {
    const t = freshDay();
    seedRun('default', 'run-errors', { size: 2 });
    const original = runJson('default', 'run-errors')!;
    reply = (tag) => (tag.includes(':r0c0:') ? 'good' : 'error');
    queue(['run-errors']);
    await pass();
    for (let i = 1; i <= 3; i++) { setNow(t + i * MIN); await pass(); }
    expect(rescanRow('default', 'run-errors')).toMatchObject({ state: 'held', hold_reason: 'too_many_failed' });
    expect(runJson('default', 'run-errors')).toEqual(original);
    // 4 first posts + 3 points x 2 re-posts.
    expect(postedTags.filter((tag) => tag.startsWith('rs:run-errors:'))).toHaveLength(10);
    const results = JSON.parse(attemptRows('default', 'run-errors')[0].results) as GridPoint[];
    expect(results.filter((p) => p.failed_reason === 'task_error')).toHaveLength(3);
  });

  it('swaps a run with 2 failed points (within the allowance)', async () => {
    const t = freshDay();
    seedRun('default', 'run-two-errors', { size: 2 });
    reply = (tag) => (tag.includes(':r0c0:') || tag.includes(':r0c1:') ? 'good' : 'error');
    queue(['run-two-errors']);
    await pass();
    for (let i = 1; i <= 3; i++) { setNow(t + i * MIN); await pass(); }
    expect(rescanRow('default', 'run-two-errors')!.state).toBe('swapped');
    expect(safetyOf('default', 'run-two-errors')).toEqual({ report_safe: true, reason: null });
  });

  it('cancel stops a queued run, and only active runs can be cancelled', () => {
    freshDay();
    seedRun('default', 'run-cancel');
    queue(['run-cancel']);
    expect(applyRescanAction('cancel', ['run-cancel'])).toEqual([{ run_id: 'run-cancel', ok: true, state: 'cancelled' }]);
    expect(rescanRow('default', 'run-cancel')!.state).toBe('cancelled');
    expect(applyRescanAction('cancel', ['run-cancel'])[0]).toMatchObject({ ok: false, state: 'cancelled' });
    expect(applyRescanAction('undo', ['run-cancel'])[0]).toMatchObject({ ok: false });
    expect(applyRescanAction('cancel', ['no-such-run'])).toEqual([{ run_id: 'no-such-run', ok: false, error: 'No re-scan for this run.' }]);
    expect(previewRescan({ run_ids: ['run-cancel'] }).skipped[0].reason).toMatch(/cancelled: use action "retry"/);
  });

  it('marks a re-scan orphaned when its run is deleted before it starts or while it scans', async () => {
    const t = freshDay();
    seedRun('default', 'run-gone-early');
    seedRun('default', 'run-gone-late');
    queue(['run-gone-early', 'run-gone-late']);
    getDbForProject('default').prepare('DELETE FROM grid_searches WHERE id = ?').run('run-gone-early');
    reply = () => 'pending';
    expect(await pass()).toMatchObject({ orphaned: 1, started: 2 });
    expect(rescanRow('default', 'run-gone-early')!.state).toBe('orphaned');
    expect(rescanRow('default', 'run-gone-late')!.state).toBe('scanning');
    getDbForProject('default').prepare('DELETE FROM grid_searches WHERE id = ?').run('run-gone-late');
    setNow(t + MIN);
    expect(await pass()).toMatchObject({ orphaned: 1 });
    expect(rescanRow('default', 'run-gone-late')!.state).toBe('orphaned');
  });

  it('keeps re-scan state when the run is re-saved (INSERT OR REPLACE), and holds source_changed if its points changed', async () => {
    const t = freshDay();
    const same = seedRun(projectB.id, 'run-resaved-same');
    const changed = seedRun(projectB.id, 'run-resaved-changed');
    reply = () => 'pending';
    queue(['run-resaved-same', 'run-resaved-changed']);
    await pass(projectB.id);
    saveImportedGridRunForProject(projectB.id, same, oldPoints(1));
    saveImportedGridRunForProject(projectB.id, changed, oldPoints(1).map((p) => ({ ...p, rank: 9 })));
    expect(rescanRow(projectB.id, 'run-resaved-same')!.state).toBe('scanning');
    expect(rescanRow(projectB.id, 'run-resaved-changed')!.state).toBe('scanning');
    reply = () => 'good';
    setNow(t + MIN);
    await pass(projectB.id);
    expect(rescanRow(projectB.id, 'run-resaved-same')!.state).toBe('swapped');
    expect(rescanRow(projectB.id, 'run-resaved-changed')).toMatchObject({ state: 'held', hold_reason: 'source_changed' });
    expect(JSON.parse(runJson(projectB.id, 'run-resaved-changed')!.results)[0].rank).toBe(9);
  });

  it('holds budget_exhausted without posting when the budget cannot cover a run', async () => {
    freshDay();
    const budget = getBudget();
    setBudgetLimit(budget.spent + budget.reserved + 0.001);
    seedRun('default', 'run-budget');
    queue(['run-budget']);
    const calls = postCalls;
    await pass();
    expect(postCalls).toBe(calls);
    expect(rescanRow('default', 'run-budget')).toMatchObject({ state: 'held', hold_reason: 'budget_exhausted' });
    expect(submissions('default', 'run-budget')).toEqual([]);
    expect(safetyOf('default', 'run-budget')).toEqual({ report_safe: false, reason: 'budget_exhausted' });
    setBudgetLimit(60);
  });

  it('holds post_unknown, and never re-posts, when a submission intent has no outcome after 10 min', async () => {
    const t = freshDay();
    seedRun('default', 'run-crash');
    // Still pending, so the worker has nothing to re-post while the intent is fresh.
    reply = () => 'pending';
    queue(['run-crash']);
    await pass();
    // A crash between writing the intent for the re-post and recording its outcome.
    getDbForProject('default').prepare(`INSERT INTO grid_rescan_submissions (tag, run_id, attempt, row, col, seq, state, reserved, submitted_at)
      VALUES ('rs:run-crash:a1:r0c0:s2', 'run-crash', 1, 0, 0, 2, 'intent', 0.0018, ?)`).run(t);
    setNow(t + 5 * MIN);
    // Under 10 min old: left alone.
    await pass();
    expect(submissions('default', 'run-crash').find((s) => s.seq === 2)!.state).toBe('intent');
    expect(rescanRow('default', 'run-crash')!.state).toBe('scanning');
    setNow(t + 11 * MIN);
    const calls = postCalls;
    expect(await pass()).toMatchObject({ held: 1 });
    expect(rescanRow('default', 'run-crash')).toMatchObject({ state: 'held', hold_reason: 'post_unknown' });
    expect(submissions('default', 'run-crash').find((s) => s.seq === 2)!.state).toBe('unknown');
    setNow(t + 60 * MIN);
    await pass();
    expect(postCalls).toBe(calls);
    expect(safetyOf('default', 'run-crash')).toEqual({ report_safe: false, reason: 'post_unknown' });
  });

  it('releases the budget reservation when a re-post collides with an unresolved intent', async () => {
    const t = freshDay();
    seedRun('default', 'run-collide');
    reply = () => 'bad';
    queue(['run-collide']);
    await pass();
    // A crash left the re-post intent for r0c0 unresolved (it reserved nothing itself).
    getDbForProject('default').prepare(`INSERT INTO grid_rescan_submissions (tag, run_id, attempt, row, col, seq, state, reserved, submitted_at)
      VALUES ('rs:run-collide:a1:r0c0:s2', 'run-collide', 1, 0, 0, 2, 'intent', 0, ?)`).run(t);
    const before = getBudget().reserved;
    // The 5-min re-post computes the same tag: nothing is posted for it and nothing stays reserved.
    setNow(t + 6 * MIN);
    await pass();
    expect(getBudget().reserved).toBeCloseTo(before, 6);
    expect(rescanRow('default', 'run-collide')).toMatchObject({ state: 'held', hold_reason: 'post_unknown' });
    reply = () => 'good';
  });

  it('holds post_unknown when task_post throws (the POST may have been billed)', async () => {
    const t = freshDay();
    seedRun('default', 'run-net');
    queue(['run-net']);
    postMode = 'throw';
    const reservedBefore = getBudget().reserved;
    await pass();
    expect(rescanRow('default', 'run-net')).toMatchObject({ state: 'held', hold_reason: 'post_unknown' });
    expect(submissions('default', 'run-net')).toEqual([{ tag: 'rs:run-net:a1:r0c0:s1', state: 'unknown', seq: 1 }]);
    // An unknown POST keeps its budget reservation.
    expect(getBudget().reserved).toBeCloseTo(reservedBefore + 0.0018, 6);
    const calls = postCalls;
    postMode = 'ok';
    setNow(t + 30 * MIN);
    await pass();
    expect(postCalls).toBe(calls);
  });

  // Patch fork (Codex round 3): a 5xx may have been accepted and billed, so it is unknown, never rejected.
  it('holds post_unknown (never re-posts) when task_post answers HTTP 500', async () => {
    const t = freshDay();
    seedRun('default', 'run-500');
    queue(['run-500']);
    postMode = 'http500';
    const reservedBefore = getBudget().reserved;
    await pass();
    expect(rescanRow('default', 'run-500')).toMatchObject({ state: 'held', hold_reason: 'post_unknown' });
    expect(submissions('default', 'run-500')).toEqual([{ tag: 'rs:run-500:a1:r0c0:s1', state: 'unknown', seq: 1 }]);
    expect(getBudget().reserved).toBeCloseTo(reservedBefore + 0.0018, 6);
    const calls = postCalls;
    postMode = 'ok';
    setNow(t + 30 * MIN);
    await pass();
    expect(postCalls).toBe(calls);
  });

  it('holds post_unknown when a submitted task is missing from the task_post response', async () => {
    freshDay();
    seedRun('default', 'run-missing-task');
    queue(['run-missing-task']);
    postMode = 'missing';
    await pass();
    expect(rescanRow('default', 'run-missing-task')).toMatchObject({ state: 'held', hold_reason: 'post_unknown' });
    expect(submissions('default', 'run-missing-task')).toEqual([{ tag: 'rs:run-missing-task:a1:r0c0:s1', state: 'unknown', seq: 1 }]);
  });

  it('re-submits a run whose first POST was refused (HTTP 4xx) after the 60 s backoff', async () => {
    const t = freshDay();
    seedRun('default', 'run-refused');
    queue(['run-refused']);
    postMode = 'http400';
    await pass();
    expect(rescanRow('default', 'run-refused')!.state).toBe('scanning');
    expect(submissions('default', 'run-refused')).toEqual([{ tag: 'rs:run-refused:a1:r0c0:s1', state: 'rejected', seq: 1 }]);
    postMode = 'ok';
    setNow(t + 30_000); await pass();
    expect(submissions('default', 'run-refused')).toHaveLength(1);
    setNow(t + 61_000); await pass();
    expect(submissions('default', 'run-refused').map((s) => [s.seq, s.state])).toEqual([[1, 'rejected'], [3, 'accepted']]);
    setNow(t + 2 * MIN); await pass();
    expect(rescanRow('default', 'run-refused')!.state).toBe('swapped');
    const [point] = JSON.parse(runJson('default', 'run-refused')!.results) as GridPoint[];
    expect(point.task_id).toBe('id-rs:run-refused:a1:r0c0:s3');
  });

  // Patch fork (Codex round 3): re-scans reserve the standard price, so they always use the standard queue.
  it('posts priority 1 even for a run that was scanned in the priority queue', async () => {
    freshDay();
    seedRun('default', 'run-priority', { queueMode: 'priority' });
    queue(['run-priority']);
    const before = postedPriorities.length;
    await pass();
    expect(postedPriorities.slice(before)).toEqual([1]);
  });

  it('alerts price_mismatch when an accepted task costs more than 1% over the reserved price', async () => {
    freshDay();
    const logged = captureAlerts();
    seedRun('default', 'run-pricey');
    queue(['run-pricey']);
    postCost = 0.0036;
    await pass();
    logged.restore();
    const alert = logged.alerts.find((a) => a.kind === 'price_mismatch' && a.run_id === 'run-pricey');
    expect(alert).toMatchObject({ project_id: 'default', detail: { actual_cost: 0.0036, reserved_price: 0.0018 } });
  });

  // Patch fork (Codex round 3): a cancel that lands while a re-post is in flight stops the rest of the step.
  it('stops re-posting when the run is cancelled during the first re-post of a step', async () => {
    const t = freshDay();
    seedRun('default', 'run-cancel-race', { size: 2 });
    reply = (tag) => (tag.endsWith(':s1') ? 'bad' : 'good');
    queue(['run-cancel-race']);
    await pass();
    setNow(t + MIN); await pass();
    let cancelled = false;
    onPost = (tags) => {
      if (!cancelled && tags.some((tag) => tag.startsWith('rs:run-cancel-race:') && tag.endsWith(':s2'))) {
        cancelled = true;
        expect(applyRescanAction('cancel', ['run-cancel-race'])[0]).toMatchObject({ ok: true });
      }
    };
    setNow(t + 5 * MIN); await pass();
    expect(postedTags.filter((tag) => tag.startsWith('rs:run-cancel-race:') && tag.endsWith(':s2'))).toHaveLength(1);
    expect(rescanRow('default', 'run-cancel-race')!.state).toBe('cancelled');
    // Nothing recorded for the points that were never posted.
    expect(submissions('default', 'run-cancel-race').filter((x) => x.seq === 2)).toHaveLength(1);
  });

  // Patch fork (Codex round 3): a crash between the claim and the first intent must not hang in posting.
  it('holds post_unknown (never re-posts) a run stuck in posting for 10+ min with nothing in flight', async () => {
    const t = freshDay();
    const logged = captureAlerts();
    seedRun('default', 'run-stuck-posting');
    queue(['run-stuck-posting']);
    // A crash right after the conditional claim (state = posting) and one accepted submission.
    const db = getDbForProject('default');
    db.prepare("UPDATE grid_rescans SET state = 'posting', started_at = ? WHERE run_id = 'run-stuck-posting'").run(t);
    db.prepare(`INSERT INTO grid_rescan_submissions (tag, run_id, attempt, row, col, seq, state, task_id, reserved, cost, submitted_at, resolved_at)
      VALUES ('rs:run-stuck-posting:a1:r0c0:s1', 'run-stuck-posting', 1, 0, 0, 1, 'accepted', 'tid', 0.0018, 0.0018, ?, ?)`).run(t, t);
    const calls = postCalls;
    setNow(t + 9 * MIN); await pass();
    expect(rescanRow('default', 'run-stuck-posting')!.state).toBe('posting');
    setNow(t + 11 * MIN);
    expect(await pass()).toMatchObject({ held: 1 });
    logged.restore();
    expect(rescanRow('default', 'run-stuck-posting')).toMatchObject({ state: 'held', hold_reason: 'post_unknown' });
    expect(postCalls).toBe(calls);
    const flagged = (rescanStatus({ unsafe: true }).unsafe ?? []).find((u) => u.run_id === 'run-stuck-posting')!;
    expect(flagged).toMatchObject({ reason: 'post_unknown', evidence: { submissions: [{ tag: 'rs:run-stuck-posting:a1:r0c0:s1', state: 'accepted' }] } });
    expect(logged.alerts.some((a) => a.run_id === 'run-stuck-posting' && a.reason === 'post_unknown')).toBe(true);
  });
});

describe('fail-loud sweep', () => {
  it('counts and alerts a scanning run with no attempt row instead of skipping it silently every pass', async () => {
    freshDay();
    seedRun('default', 'run-no-attempt');
    reply = () => 'pending';
    queue(['run-no-attempt']);
    await pass();
    getDbForProject('default').prepare("DELETE FROM grid_rescan_attempts WHERE run_id = 'run-no-attempt'").run();
    const logged = captureAlerts();
    const counters = await pass();
    logged.restore();
    expect(counters.errors).toBe(1);
    expect(logged.alerts.find((a) => a.kind === 'rescan_error' && a.run_id === 'run-no-attempt')).toBeDefined();
  });
});

// --- Atomic safety flags (Codex round 3) -------------------------------------------------------------

/** Makes every write to grid_run_safety fail, to prove the state change rolls back with it. */
function failSafetyWrites(projectId: string) {
  const db = getDbForProject(projectId);
  db.exec(`CREATE TRIGGER fail_safety_insert BEFORE INSERT ON grid_run_safety BEGIN SELECT RAISE(ABORT, 'safety write failed'); END;
    CREATE TRIGGER fail_safety_update BEFORE UPDATE ON grid_run_safety BEGIN SELECT RAISE(ABORT, 'safety write failed'); END;`);
  return () => db.exec('DROP TRIGGER IF EXISTS fail_safety_insert; DROP TRIGGER IF EXISTS fail_safety_update;');
}

describe('safety flags change in the same transaction as the state', () => {
  it('start: no queued row without its pending_rescan flag', () => {
    freshDay();
    seedRun('default', 'run-atomic-start');
    const preview = previewRescan({ run_ids: ['run-atomic-start'] });
    const restore = failSafetyWrites('default');
    let result: ReturnType<typeof startRescan> | undefined;
    try { result = startRescan(preview.manifest_id); } catch { /* the old code throws after committing */ } finally { restore(); }
    expect(rescanRow('default', 'run-atomic-start')).toBeUndefined();
    expect(result).toMatchObject({ queued: [], skipped: [{ run_id: 'run-atomic-start', reason: expect.stringMatching(/safety write failed/) }] });
  });

  it('cancel: the state stays when the flag cannot be written', () => {
    freshDay();
    seedRun('default', 'run-atomic-cancel');
    queue(['run-atomic-cancel']);
    const restore = failSafetyWrites('default');
    let result: ReturnType<typeof applyRescanAction> | undefined;
    try { result = applyRescanAction('cancel', ['run-atomic-cancel']); } catch { /* old code */ } finally { restore(); }
    expect(rescanRow('default', 'run-atomic-cancel')!.state).toBe('queued');
    expect(result?.[0]).toMatchObject({ run_id: 'run-atomic-cancel', ok: false, error: expect.stringMatching(/safety write failed/) });
  });

  it('hold: the run is not held without its reason; the worker counts and alerts the error', async () => {
    freshDay();
    const budget = getBudget();
    setBudgetLimit(budget.spent + budget.reserved + 0.001);
    seedRun('default', 'run-atomic-hold');
    queue(['run-atomic-hold']);
    const logged = captureAlerts();
    const restore = failSafetyWrites('default');
    let counters: ReturnType<typeof newRescanCounters> | undefined;
    try { counters = await pass(); } finally { restore(); logged.restore(); setBudgetLimit(60); }
    expect(rescanRow('default', 'run-atomic-hold')).toMatchObject({ state: 'posting', hold_reason: null });
    expect(attemptRows('default', 'run-atomic-hold')[0].state).toBe('posting');
    expect(counters).toMatchObject({ held: 0, errors: 1 });
    expect(logged.alerts.find((a) => a.kind === 'rescan_error' && a.run_id === 'run-atomic-hold')).toMatchObject({ reason: expect.stringMatching(/safety write failed/) });
  });

  it('swap: the new points are not written without the new flag', async () => {
    const t = freshDay();
    seedRun('default', 'run-atomic-swap');
    const original = runJson('default', 'run-atomic-swap');
    queue(['run-atomic-swap']);
    await pass();
    setNow(t + MIN);
    const restore = failSafetyWrites('default');
    try { await pass(); } finally { restore(); }
    expect(rescanRow('default', 'run-atomic-swap')!.state).toBe('scanning');
    expect(runJson('default', 'run-atomic-swap')).toEqual(original);
    expect(safetyOf('default', 'run-atomic-swap')).toEqual({ report_safe: false, reason: 'pending_rescan' });
  });

  it('undo: the old points are not restored while the run is still flagged safe', async () => {
    const t = freshDay();
    seedRun('default', 'run-atomic-undo');
    queue(['run-atomic-undo']);
    await pass();
    setNow(t + MIN); await pass();
    expect(rescanRow('default', 'run-atomic-undo')!.state).toBe('swapped');
    const swapped = runJson('default', 'run-atomic-undo');
    const restore = failSafetyWrites('default');
    let result: ReturnType<typeof applyRescanAction> | undefined;
    try { result = applyRescanAction('undo', ['run-atomic-undo']); } catch { /* old code */ } finally { restore(); }
    expect(runJson('default', 'run-atomic-undo')).toEqual(swapped);
    expect(rescanRow('default', 'run-atomic-undo')!.state).toBe('swapped');
    expect(safetyOf('default', 'run-atomic-undo')).toEqual({ report_safe: true, reason: null });
    expect(result?.[0]).toMatchObject({ ok: false });
  });
});

// --- The "not safe to report" list (Codex round 3) ----------------------------------------------------

describe('unsafe list', () => {
  it('includes done runs whose computed safety is false, and counts runs never checked', () => {
    freshDay();
    const checked = (row: number, col: number): GridPoint => ({ row, col, lat: 1, lng: 1, rank: 3, items: [], raw_count: 20 });
    // A scheduled run (no re-scan) with a wrong-city point, in another project.
    seedRun(projectB.id, 'run-computed-unsafe', { size: 2, results: [
      checked(0, 0), checked(0, 1), checked(1, 0),
      { row: 1, col: 1, lat: 1, lng: 1, rank: null, items: [], failed: true, failed_reason: 'wrong_city', task_id: 't-wc', check_url: 'https://g/wc' },
    ] });
    seedRun(projectB.id, 'run-computed-safe', { size: 1, results: [checked(0, 0)] });
    seedRun(projectB.id, 'run-partial', { size: 2, results: [checked(0, 0)] });
    const notCheckedBefore = rescanStatus({ unsafe: true }).not_checked_runs!;
    seedRun(projectB.id, 'run-never-checked');
    const status = rescanStatus({ unsafe: true });
    expect(status.not_checked_runs).toBe(notCheckedBefore + 1);
    const unsafe = status.unsafe!;
    expect(unsafe.find((u) => u.run_id === 'run-computed-unsafe')).toMatchObject({
      project: { id: projectB.id }, monitor_id: 'grid-run-computed-unsafe', reason: 'wrong_city_persistent',
      evidence: [{ row: 1, col: 1, reason: 'wrong_city', task_id: 't-wc', check_url: 'https://g/wc' }],
    });
    expect(unsafe.find((u) => u.run_id === 'run-partial')).toMatchObject({ reason: 'incomplete_grid' });
    expect(unsafe.find((u) => u.run_id === 'run-computed-safe')).toBeUndefined();
    expect(unsafe.find((u) => u.run_id === 'run-never-checked')).toBeUndefined();
  });
});
