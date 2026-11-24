import {
  getGridProgressForProject, updateGridProgressForProject,
  type GridPoint, type GridRecheck, type GridSearchEntry, type GridTaskPoint,
} from '@/lib/db';
import { dataForSeoBaseUrl, gridTaskTag, MAX_POINT_ATTEMPTS, repostGridPoint } from '@/app/dashboard/local-finder/grid-api';
import { buildGridPoint, classifyRawItems, failedGridPoint, type BuiltPoint, type RawLocalItem } from '@/lib/grid-point-builder';
import { notifyGridAlert } from '@/lib/grid-alerts';
import { computedSafety } from '@/lib/grid-safety';

export { MAX_POINT_ATTEMPTS };

interface DFSTaskGetResponse {
  tasks?: Array<{
    id?: string;
    status_code?: number;
    result?: Array<{ check_url?: string; items?: RawLocalItem[] | null }> | null;
  }>;
}

/** Patch fork: task_get calls in flight at once per run, so a big batch doesn't burst DataForSEO. */
const TASK_GET_CONCURRENCY = 10;
/** Patch fork: a queued task still pending this long after it was posted is given up and re-posted. */
export const TASK_PENDING_TIMEOUT_MS = 30 * 60_000;
/** Patch fork: wait before re-posting a DataForSEO rejection of a re-post. */
export const POST_FAILURE_BACKOFF_MS = 60_000;
/** Patch fork: rejected re-posts per point before it is marked failed. */
export const MAX_POST_FAILURES = 3;

/**
 * Patch fork: wrong-city results came in bursts lasting minutes on Nov 15, so a wrong-city point's
 * 2nd search is 5 min after its 1st and the 3rd is 30 min after the 2nd. An ads-only point's one
 * retry also waits 5 min (cause unknown; waiting costs nothing). Task errors re-post at once.
 */
export function retryDelayMs(reason: GridRecheck['reason'], postsSoFar: number): number {
  if (reason === 'ads_only') return 5 * 60_000;
  if (reason !== 'wrong_city') return 0;
  return postsSoFar <= 1 ? 5 * 60_000 : 30 * 60_000;
}

export async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export type GridTaskCheck =
  | { kind: 'pending' }
  | { kind: 'ready'; built: BuiltPoint }
  | { kind: 'bad'; recheck: GridRecheck };

/**
 * Patch fork: fetches one queued task and classifies it. Shared by scheduled runs and re-scans.
 * - pending: not finished yet (or the fetch failed; tried again next pass)
 * - ready: a usable, location-checked point
 * - bad: wrong-city result, task error, malformed result, ads-only result or pending too long; the caller
 *   re-posts or fails it
 */
export async function checkGridTask(
  task: GridTaskPoint, ctx: { auth: string; target: string; now: number },
): Promise<GridTaskCheck> {
  const stillProcessing = new Set([40602, 40601]);
  const timedOut = () => task.submitted_at !== undefined && ctx.now - task.submitted_at > TASK_PENDING_TIMEOUT_MS;
  // Patch fork: a task_get that keeps failing (HTTP error, network error, bad JSON) is waited on like a
  // queued task, then re-posted as a timeout. Scheduled runs have no run deadline, so without this a
  // point could stay pending forever.
  const waitOrTimeout = (): GridTaskCheck => (timedOut() ? { kind: 'bad', recheck: { task_id: task.task_id, reason: 'timeout' } } : { kind: 'pending' });
  try {
    const response = await fetch(`${dataForSeoBaseUrl()}/v3/serp/google/local_finder/task_get/advanced/${task.task_id}`, {
      headers: { Authorization: `Basic ${ctx.auth}` }, signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return waitOrTimeout();
    const data = await response.json() as DFSTaskGetResponse;
    const dfsTask = data.tasks?.[0];
    if (!dfsTask || stillProcessing.has(dfsTask.status_code ?? 0)) return waitOrTimeout();
    const result = dfsTask.result?.[0];
    // Patch fork: the task failed, or "succeeded" without a result object or an items array (incl.
    // items: null). Upstream stored these as an empty point, which showed as "not found" even though
    // Google was never checked there. Only items: [] is a real zero-result search.
    if (dfsTask.status_code !== 20000 || !result || !Array.isArray(result.items)) {
      return { kind: 'bad', recheck: { task_id: task.task_id, check_url: result?.check_url, reason: 'task_error' } };
    }
    // Patch fork: items with no usable organic listing are not a "not found" either.
    const itemsClass = classifyRawItems(result.items);
    if (itemsClass === 'malformed') {
      return { kind: 'bad', recheck: { task_id: task.task_id, check_url: result.check_url, reason: 'task_error' } };
    }
    if (itemsClass === 'ads_only') {
      return { kind: 'bad', recheck: { task_id: task.task_id, check_url: result.check_url, reason: 'ads_only' } };
    }
    const built = buildGridPoint(task, result.items, ctx.target, { task_id: task.task_id, check_url: result.check_url });
    if (built.location.wrongCity) {
      return { kind: 'bad', recheck: { task_id: task.task_id, check_url: result.check_url, reason: 'wrong_city', far: built.location.far } };
    }
    return { kind: 'ready', built };
  } catch {
    return waitOrTimeout();
  }
}

export function checkGridTasks(tasks: GridTaskPoint[], ctx: { auth: string; target: string; now: number }): Promise<GridTaskCheck[]> {
  return mapLimited(tasks, TASK_GET_CONCURRENCY, (task) => checkGridTask(task, ctx));
}

/** Patch fork: the point a task's checks ended in, with the evidence of any discarded tasks attached. */
export function pointFromReady(task: GridTaskPoint, built: BuiltPoint): GridPoint {
  return task.rechecks?.length ? { ...built.point, rechecks: task.rechecks } : built.point;
}

export function failedPointFromTask(task: GridTaskPoint, reason: GridRecheck['reason']): GridPoint {
  const last = task.rechecks?.[task.rechecks.length - 1];
  // Patch fork: an ads-only point fails as task_error, so the Reporting API and UI need no new reason.
  return failedGridPoint(task, reason === 'ads_only' ? 'task_error' : reason, { task_id: last?.task_id ?? task.task_id, check_url: last?.check_url, rechecks: task.rechecks });
}

export type RepostOutcome =
  | { kind: 'accepted'; taskId: string }
  | { kind: 'rejected' }
  /** The POST may or may not have been accepted (and billed): the point stops, nothing is re-posted. */
  | { kind: 'unknown' }
  /** The re-scan spend budget has no room: nothing was posted. */
  | { kind: 'budget' }
  /** The caller's attempt is no longer current (cancelled or retried): nothing was posted, stop posting. */
  | { kind: 'stopped' };

/**
 * Patch fork: one collection step for a run's pending points, shared by scheduled runs and re-scans
 * (which differ only in how they re-post). Each point ends up as:
 * - still pending (task in flight, or waiting for its retry time),
 * - re-posted (wrong-city / error / timeout, while it has searches left: MAX_POINT_ATTEMPTS in all),
 * - a ready point, or a failed point (searches or re-post attempts used up).
 * An ads-only result gets one retry: a second ads-only result (or one with no searches left) fails the
 * point at once, and it is listed in adsOnlyFailed so the caller can alert.
 */
export async function stepGridTasks(
  tasks: GridTaskPoint[], checks: Map<GridTaskPoint, GridTaskCheck>, now: number,
  repost: (task: GridTaskPoint) => Promise<RepostOutcome>,
): Promise<{ ready: GridPoint[]; pending: GridTaskPoint[]; budgetExhausted: boolean; unknown: number; adsOnlyFailed: GridPoint[] }> {
  const ready: GridPoint[] = [];
  const adsOnlyFailed: GridPoint[] = [];
  const pending: GridTaskPoint[] = [];
  let budgetExhausted = false;
  let stopped = false;
  let unknown = 0;
  for (const original of tasks) {
    let task = original;
    const check = checks.get(original);
    if (!check && !task.awaiting_retry) {
      pending.push(task);
      continue;
    }
    if (check?.kind === 'pending') {
      pending.push(task);
      continue;
    }
    if (check?.kind === 'ready') {
      ready.push(pointFromReady(task, check.built));
      continue;
    }
    if (check?.kind === 'bad') {
      const posts = task.attempts ?? 1;
      const rechecks = [...(task.rechecks ?? []), check.recheck];
      if (check.recheck.reason === 'ads_only' && (posts >= MAX_POINT_ATTEMPTS || task.rechecks?.some((r) => r.reason === 'ads_only'))) {
        const failed = failedPointFromTask({ ...task, rechecks }, 'ads_only');
        ready.push(failed);
        adsOnlyFailed.push(failed);
        continue;
      }
      if (posts >= MAX_POINT_ATTEMPTS) {
        ready.push(failedPointFromTask({ ...task, rechecks }, check.recheck.reason));
        continue;
      }
      task = {
        ...task, rechecks, awaiting_retry: true,
        retry_due_at: Math.max(now, (task.submitted_at ?? now) + retryDelayMs(check.recheck.reason, posts)),
      };
    }
    if ((task.retry_due_at ?? 0) > now || budgetExhausted || stopped) {
      pending.push(task);
      continue;
    }
    const outcome = await repost(task);
    if (outcome.kind === 'accepted') {
      pending.push({
        task_id: outcome.taskId, row: task.row, col: task.col, lat: task.lat, lng: task.lng,
        attempts: (task.attempts ?? 1) + 1, submitted_at: Date.now(),
        ...(task.seq !== undefined ? { seq: task.seq + 1 } : {}),
        ...(task.rechecks?.length ? { rechecks: task.rechecks } : {}),
      });
      continue;
    }
    if (outcome.kind === 'budget') {
      budgetExhausted = true;
      pending.push(task);
      continue;
    }
    if (outcome.kind === 'stopped') {
      stopped = true;
      pending.push(task);
      continue;
    }
    if (outcome.kind === 'unknown') {
      unknown += 1;
      ready.push(failedPointFromTask(task, 'task_error'));
      continue;
    }
    const failures = (task.post_failures ?? 0) + 1;
    if (failures >= MAX_POST_FAILURES) {
      ready.push(failedPointFromTask(task, 'task_error'));
      continue;
    }
    pending.push({
      ...task, post_failures: failures, retry_due_at: now + POST_FAILURE_BACKOFF_MS,
      ...(task.seq !== undefined ? { seq: task.seq + 1 } : {}),
    });
  }
  return { ready, pending, budgetExhausted, unknown, adsOnlyFailed };
}

const inFlightCollections = new Map<string, Promise<{ status: 'done' | 'pending'; ready: number; total: number }>>();

/** Collects ready queued points for a project without relying on an open browser tab. */
export function collectGridProgress(
  projectId: string,
  entry: GridSearchEntry & { task_ids?: GridTaskPoint[] },
  credentials: { login: string; pass: string },
): Promise<{ status: 'done' | 'pending'; ready: number; total: number }> {
  const key = `${projectId}:${entry.id}`;
  const existing = inFlightCollections.get(key);
  if (existing) return existing;
  const operation = collectGridProgressOnce(projectId, entry, credentials).finally(() => inFlightCollections.delete(key));
  inFlightCollections.set(key, operation);
  return operation;
}

/** Storage adapter for scheduled and manual queued runs (grid_searches.task_ids / results). */
async function collectGridProgressOnce(
  projectId: string,
  entry: GridSearchEntry & { task_ids?: GridTaskPoint[] },
  credentials: { login: string; pass: string },
): Promise<{ status: 'done' | 'pending'; ready: number; total: number }> {
  const total = entry.grid_size ** 2;
  const progress = getGridProgressForProject(projectId, entry.id);
  if (!progress || progress.pendingTasks.length === 0) return { status: 'pending', ready: 0, total };

  const now = Date.now();
  const auth = btoa(`${credentials.login}:${credentials.pass}`);
  const priority = entry.queue_mode === 'priority' ? 'priority' : 'standard';
  const toCheck = progress.pendingTasks.filter((task) => !task.awaiting_retry && task.task_id);
  const checks = await checkGridTasks(toCheck, { auth, target: entry.target, now });
  const { ready: readyPoints, pending: pendingTasks, adsOnlyFailed } = await stepGridTasks(
    progress.pendingTasks, new Map(toCheck.map((task, index) => [task, checks[index]])), now,
    async (task) => {
      const tag = gridTaskTag(entry.series_id || entry.id, task.row, task.col);
      const repost = await repostGridPoint(entry.keyword, task.lat, task.lng, entry.language, auth, priority, tag);
      if (repost.taskId) return { kind: 'accepted', taskId: repost.taskId };
      // Patch fork: an unclear answer is still re-posted later (capped at MAX_POINT_ATTEMPTS, as planned),
      // but it may have been billed, so it is raised.
      if (repost.unclear) {
        void notifyGridAlert({
          kind: 'scheduled_repost_unclear', reason: 'unclear_repost', project_id: projectId, run_id: entry.id, monitor_id: entry.series_id,
          detail: { row: task.row, col: task.col, tag },
        });
      }
      return { kind: 'rejected' };
    },
  );

  const accumulated = [...progress.results, ...readyPoints];
  updateGridProgressForProject(projectId, entry.id, accumulated, pendingTasks);
  if (adsOnlyFailed.length > 0) {
    void notifyGridAlert({
      kind: 'ads_only_persistent', reason: 'ads_only_twice', project_id: projectId, run_id: entry.id, monitor_id: entry.series_id,
      detail: { points: adsOnlyFailed.map((p) => ({ row: p.row, col: p.col, task_id: p.task_id })) },
    });
  }
  if (pendingTasks.length === 0) {
    // Patch fork: a finished run whose numbers aren't safe to report is raised, not just flagged.
    const safety = computedSafety(accumulated, entry.grid_size);
    if (!safety.report_safe) {
      void notifyGridAlert({
        kind: 'scheduled_run_unsafe', reason: safety.reason ?? 'unsafe', project_id: projectId, run_id: entry.id, monitor_id: entry.series_id,
        detail: { failed: accumulated.filter((p) => p.failed).map((p) => ({ row: p.row, col: p.col, reason: p.failed_reason, task_id: p.task_id })) },
      });
    }
  }
  return { status: pendingTasks.length === 0 ? 'done' : 'pending', ready: accumulated.length, total };
}
