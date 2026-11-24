import type { GridPoint, GridRecheck, GridTaskPoint } from '@/lib/db';
import { buildGridPoint, classifyRawItems, failedGridPoint, GRID_DEPTH, type RawLocalItem } from '@/lib/grid-point-builder';
import { notifyGridAlert } from '@/lib/grid-alerts';

/** Patch fork: a point is posted at most this many times (initial + re-posts) before it is marked failed. */
export const MAX_POINT_ATTEMPTS = 3;

/**
 * Patch fork: DataForSEO host for the Geo-grid calls only, so local end-to-end tests can point at a
 * mock. Defaults to the real API.
 */
export function dataForSeoBaseUrl(): string {
  return (process.env.DATAFORSEO_BASE_URL?.trim() || 'https://api.dataforseo.com').replace(/\/+$/, '');
}

/** Patch fork: tag on scheduled/manual tasks, so a run's tasks can be found in DataForSEO's free id_list. */
export function gridTaskTag(prefix: string, row: number, col: number): string {
  return `${prefix}|r${row}c${col}`.slice(0, 255);
}

export interface LocalPackItem {
  type: string;
  rank_group: number;
  rank_absolute: number;
  title?: string;
  description?: string;
  domain?: string;
  url?: string;
  phone?: string;
  booking_url?: string;
  is_paid?: boolean;
  rating?: { value?: number; votes_count?: number; rating_max?: number };
  cid?: string;
}

export function generateGridCoords(
  centerLat: number, centerLng: number, gridSize: number, spacingKm: number,
) {
  const latDeg = spacingKm / 111.32;
  const lngDeg = spacingKm / (111.32 * Math.cos(centerLat * Math.PI / 180));
  const half = Math.floor(gridSize / 2);
  const coords: { row: number; col: number; lat: number; lng: number }[] = [];
  for (let row = 0; row < gridSize; row++) {
    for (let col = 0; col < gridSize; col++) {
      coords.push({
        row, col,
        lat: centerLat + (half - row) * latDeg,
        lng: centerLng + (col - half) * lngDeg,
      });
    }
  }
  return coords;
}

/** Runs `fn` over `items` with at most `limit` calls in flight at once. */
async function mapWithConcurrency<T, R>(
  items: T[], limit: number, fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function requestGridPoint(
  keyword: string, lat: number, lng: number, language: string, auth: string, tag?: string,
): Promise<{ items: RawLocalItem[]; cost: number; taskId?: string; checkUrl?: string; error?: string }> {
  let res: Response;
  try {
    res = await fetch(`${dataForSeoBaseUrl()}/v3/serp/google/local_finder/live/advanced`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([{
        keyword,
        location_coordinate: `${lat.toFixed(6)},${lng.toFixed(6)}`,
        language_name: language,
        depth: GRID_DEPTH,
        ...(tag ? { tag } : {}),
      }]),
      signal: AbortSignal.timeout(45_000),
    });
  } catch (e) {
    return { items: [], cost: 0, error: e instanceof Error ? e.name : 'fetch failed' };
  }
  if (!res.ok) return { items: [], cost: 0, error: `HTTP ${res.status}` };
  const data = await res.json() as {
    tasks?: Array<{ id?: string; status_code?: number; status_message?: string; cost?: number; result?: Array<{ check_url?: string; items?: RawLocalItem[] | null }> | null }>;
  };
  const task = data?.tasks?.[0];
  if (!task || task.status_code !== 20000) {
    return { items: [], cost: task?.cost ?? 0, error: task?.status_message ?? 'no task in response' };
  }
  const result = task.result?.[0];
  // Patch fork: a 20000 task without a result object or an items array (incl. items: null) is
  // malformed, not a real zero-result search. Only items: [] means Google listed nothing.
  if (!result || !Array.isArray(result.items)) {
    return { items: [], cost: task.cost ?? 0, taskId: task.id, error: 'malformed result' };
  }
  // Patch fork: items with no local_pack listing, or one without a numeric rank_group, are malformed too.
  if (classifyRawItems(result.items) === 'malformed') {
    return { items: [], cost: task.cost ?? 0, taskId: task.id, checkUrl: result.check_url, error: 'malformed result' };
  }
  return { items: result.items, cost: task.cost ?? 0, taskId: task.id, checkUrl: result.check_url };
}

/**
 * Patch fork: fetches one point live. An errored (or malformed) request is retried once (as before); a
 * wrong-city result is re-requested, up to MAX_POINT_ATTEMPTS requests in all, and then stored as failed
 * so it never shows as ranks. An ads-only result is re-requested once; a second one fails the point as
 * task_error and raises an ads_only_persistent alert.
 */
export async function fetchOneGridPoint(
  keyword: string, coord: { row: number; col: number; lat: number; lng: number }, language: string, auth: string,
  target: string, tagPrefix?: string,
): Promise<{ point: GridPoint; cost: number }> {
  const tag = tagPrefix ? gridTaskTag(tagPrefix, coord.row, coord.col) : undefined;
  const rechecks: GridRecheck[] = [];
  let cost = 0;
  let lastError = false;
  for (let attempt = 1; attempt <= MAX_POINT_ATTEMPTS; attempt += 1) {
    let result = await requestGridPoint(keyword, coord.lat, coord.lng, language, auth, tag);
    cost += result.cost;
    if (result.error) {
      // Transient failures (timeouts, rate limiting) are common under concurrent load; retry once.
      result = await requestGridPoint(keyword, coord.lat, coord.lng, language, auth, tag);
      cost += result.cost;
    }
    if (result.error) {
      lastError = true;
      if (result.taskId) rechecks.push({ task_id: result.taskId, check_url: result.checkUrl, reason: 'task_error' });
      break;
    }
    if (classifyRawItems(result.items) === 'ads_only') {
      const repeated = rechecks.some((r) => r.reason === 'ads_only');
      rechecks.push({ task_id: result.taskId ?? '', check_url: result.checkUrl, reason: 'ads_only' });
      if (repeated || attempt === MAX_POINT_ATTEMPTS) {
        // A live scan has no run id: the keyword in the reason keeps the Slack dedupe to one per keyword.
        void notifyGridAlert({
          kind: 'ads_only_persistent', reason: `ads_only_twice (live scan: "${keyword}")`,
          detail: { keyword, row: coord.row, col: coord.col, tag, task_id: result.taskId },
        });
        lastError = true;
        break;
      }
      continue;
    }
    const built = buildGridPoint(coord, result.items, target, { task_id: result.taskId, check_url: result.checkUrl });
    if (!built.location.wrongCity) {
      return { point: rechecks.length ? { ...built.point, rechecks } : built.point, cost };
    }
    rechecks.push({ task_id: result.taskId ?? '', check_url: result.checkUrl, reason: 'wrong_city', far: built.location.far });
  }
  // Patch fork: a point that still errored, stayed wrong-city or stayed ads-only has no data, which is not
  // "not in the top 20". Ads-only fails as task_error so the Reporting API and UI need no new reason.
  const last = rechecks[rechecks.length - 1];
  return {
    point: failedGridPoint(coord, lastError ? 'task_error' : 'wrong_city', { task_id: last?.task_id || undefined, check_url: last?.check_url, rechecks }),
    cost,
  };
}

export async function fetchGridSearch(
  keyword: string, center: string, gridSize: number, spacingKm: number,
  language: string, target: string, login: string, pass: string, tagPrefix?: string,
): Promise<{ results: GridPoint[]; cost: number; error?: string }> {
  const parts = center.split(',').map(Number);
  if (parts.length < 2 || isNaN(parts[0]) || isNaN(parts[1])) {
    return { results: [], cost: 0, error: 'Invalid coordinates.' };
  }
  const [centerLat, centerLng] = parts;
  const coords = generateGridCoords(centerLat, centerLng, gridSize, spacingKm);
  const auth = btoa(`${login}:${pass}`);

  const pointResults = await mapWithConcurrency(
    coords, 6,
    (coord) => fetchOneGridPoint(keyword, coord, language, auth, target, tagPrefix),
  );

  const results = pointResults.map((r) => r.point);
  const totalCost = pointResults.reduce((s, r) => s + r.cost, 0);
  return { results, cost: totalCost };
}

export interface GridTaskRequest {
  keyword: string;
  lat: number;
  lng: number;
  language: string;
  priority: 1 | 2;
  tag?: string;
}

/**
 * Patch fork: what one submitted task became.
 * - accepted: an id and a status below 40000 (queued and billed)
 * - rejected: DataForSEO answered for this task with a status of 40000 or more (not queued, not billed)
 * - unknown: anything else (no answer for it, no id, no status): it may have been queued and billed
 */
export type GridTaskOutcome = 'accepted' | 'rejected' | 'unknown';

export interface GridTaskPostResult {
  /** Set only when the task was accepted. */
  taskId: string | null;
  statusCode: number | null;
  /** Billed cost of an accepted task; null when DataForSEO didn't say. 0 when not accepted. */
  cost: number | null;
  outcome: GridTaskOutcome;
}

/**
 * Patch fork: posts up to 100 tasks in one task_post call. Returns one result per request, in order,
 * or an error when the call itself failed (then no per-task results). `rejected` is true only when
 * the failure is a definitive refusal (HTTP 4xx, or HTTP 200 with a top-level status of 40000+ and
 * no tasks), so nothing in the chunk was queued. Anything unclear (HTTP 5xx, network error or
 * timeout, a body that isn't JSON, no tasks array) may have been accepted and billed: `rejected` is
 * false and callers must not re-post it.
 */
export async function postGridTaskChunk(
  requests: GridTaskRequest[], auth: string, timeoutMs = 60_000,
): Promise<{ results: GridTaskPostResult[]; error?: string; rejected?: boolean }> {
  let res: Response;
  try {
    res = await fetch(`${dataForSeoBaseUrl()}/v3/serp/google/local_finder/task_post`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(requests.map((r) => ({
        keyword: r.keyword,
        location_coordinate: `${r.lat.toFixed(6)},${r.lng.toFixed(6)}`,
        language_name: r.language,
        depth: GRID_DEPTH,
        priority: r.priority,
        ...(r.tag ? { tag: r.tag } : {}),
      }))),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return { results: [], error: error instanceof Error ? error.message : 'Could not reach DataForSEO.', rejected: false };
  }
  if (!res.ok) return { results: [], error: `API error ${res.status}`, rejected: res.status >= 400 && res.status < 500 };
  let data: { status_code?: number; status_message?: string; tasks?: Array<{ id?: string; status_code?: number; cost?: number; data?: { tag?: unknown } | null } | null> | null };
  try {
    data = await res.json();
  } catch {
    return { results: [], error: 'DataForSEO returned a body that is not JSON.', rejected: false };
  }
  const tasks = Array.isArray(data?.tasks) ? data.tasks : null;
  if (!tasks?.length && typeof data?.status_code === 'number' && data.status_code >= 40000) {
    return { results: [], error: `DataForSEO refused the call: ${data.status_code} ${data.status_message ?? ''}`.trim(), rejected: true };
  }
  if (!tasks) return { results: [], error: 'No tasks array in the DataForSEO response.', rejected: false };
  const answerFor = matchTaskAnswers(requests, tasks);
  return {
    results: requests.map((_, j): GridTaskPostResult => {
      const task = answerFor(j);
      const statusCode = typeof task?.status_code === 'number' ? task.status_code : null;
      if (task?.id && statusCode !== null && statusCode < 40000) {
        return { taskId: task.id, statusCode, cost: typeof task.cost === 'number' ? task.cost : null, outcome: 'accepted' };
      }
      if (task && statusCode !== null && statusCode >= 40000) return { taskId: null, statusCode, cost: 0, outcome: 'rejected' };
      return { taskId: null, statusCode, cost: 0, outcome: 'unknown' };
    }),
  };
}

/**
 * Patch fork: which answer belongs to which request. DataForSEO echoes each task's `data.tag`, so a
 * tagged request is matched by its tag (a missing or duplicated tag is no answer: unknown, never
 * someone else's task). Without tags in the answer, by position, and only when the counts match.
 */
function matchTaskAnswers<T extends { data?: { tag?: unknown } | null } | null>(
  requests: GridTaskRequest[], tasks: T[],
): (index: number) => T | undefined {
  const echoed = tasks.some((t) => typeof t?.data?.tag === 'string');
  if (echoed && requests.every((r) => r.tag)) {
    const byTag = new Map<string, T | null>();
    for (const t of tasks) {
      const tag = t?.data?.tag;
      if (typeof tag !== 'string') continue;
      byTag.set(tag, byTag.has(tag) ? null : t);
    }
    return (index) => byTag.get(requests[index].tag as string) ?? undefined;
  }
  if (tasks.length !== requests.length) return () => undefined;
  return (index) => tasks[index];
}

/** Patch fork: a point DataForSEO refused at its first post; the collector re-posts it after 60 s. */
function retryPendingPoint(coord: { row: number; col: number; lat: number; lng: number }, now: number): GridTaskPoint {
  return { task_id: '', row: coord.row, col: coord.col, lat: coord.lat, lng: coord.lng, attempts: 0, post_failures: 1, awaiting_retry: true, retry_due_at: now + 60_000 };
}

export async function postGridTasksQueue(
  keyword: string, center: string, gridSize: number, spacingKm: number,
  language: string, login: string, pass: string, priorityMode: 'priority' | 'standard' = 'standard', tagPrefix?: string,
): Promise<{
  taskPoints: GridTaskPoint[]; cost: number; accepted: number; error?: string;
  /** Patch fork: some task got an unclear answer, so it may have been queued and billed without a task id. */
  unclear: boolean;
}> {
  const parts = center.split(',').map(Number);
  if (parts.length < 2 || isNaN(parts[0]) || isNaN(parts[1])) {
    return { taskPoints: [], cost: 0, accepted: 0, error: 'Invalid coordinates.', unclear: false };
  }
  const [centerLat, centerLng] = parts;
  const coords = generateGridCoords(centerLat, centerLng, gridSize, spacingKm);
  const auth = btoa(`${login}:${pass}`);
  // DataForSEO: priority=2 processes the task faster for a higher per-task cost; priority=1 is the default standard queue.
  const priority = priorityMode === 'priority' ? 2 : 1;

  const CHUNK = 100;
  const allTaskPoints: GridTaskPoint[] = [];
  let totalCost = 0;
  let accepted = 0;
  let rejected = 0;
  let unknown = 0;
  const problems = () => [
    rejected ? `DataForSEO rejected ${rejected} task(s) (kept for a re-post once the run exists).` : null,
    unknown ? `${unknown} task(s) got no clear answer from DataForSEO and are not re-posted; the run will be incomplete.` : null,
  ].filter(Boolean).join(' ');

  for (let i = 0; i < coords.length; i += CHUNK) {
    const chunk = coords.slice(i, i + CHUNK);
    const submittedAt = Date.now();
    const posted = await postGridTaskChunk(chunk.map(({ row, col, lat, lng }) => ({
      keyword, lat, lng, language, priority, tag: tagPrefix ? gridTaskTag(tagPrefix, row, col) : undefined,
    })), auth);
    if (posted.error) {
      // Patch fork: a definitive refusal queued nothing in this chunk, so its points are re-posted later.
      if (posted.rejected) {
        for (const coord of chunk) allTaskPoints.push(retryPendingPoint(coord, submittedAt));
        rejected += chunk.length;
        continue;
      }
      // An unclear failure may have queued (and billed) this chunk: return what's known, never re-post
      // it. Callers keep a partial run, which ends incomplete and is flagged not safe to report.
      return { taskPoints: allTaskPoints, cost: totalCost, accepted, error: [posted.error, problems()].filter(Boolean).join(' '), unclear: true };
    }
    posted.results.forEach((task, j) => {
      const coord = chunk[j];
      if (task.outcome === 'accepted' && task.taskId) {
        allTaskPoints.push({ task_id: task.taskId, row: coord.row, col: coord.col, lat: coord.lat, lng: coord.lng, attempts: 1, submitted_at: submittedAt });
        accepted += 1;
        totalCost += task.cost ?? 0;
      } else if (task.outcome === 'rejected') {
        // Patch fork: refused (status 4xxxx): kept as a retry-pending point, re-posted after 60 s.
        allTaskPoints.push(retryPendingPoint(coord, submittedAt));
        rejected += 1;
      } else {
        unknown += 1;
      }
    });
  }

  const error = problems();
  return { taskPoints: allTaskPoints, cost: totalCost, accepted, ...(error ? { error } : {}), unclear: unknown > 0 };
}

/**
 * Patch fork: re-posts one grid point whose queued task failed or came back wrong-city. Returns the
 * new task id, or null when DataForSEO did not accept it (the caller tries again on a later pass).
 * `unclear` marks an answer that may have been queued and billed anyway (timeout, 5xx, odd body).
 */
export async function repostGridPoint(
  keyword: string, lat: number, lng: number, language: string, auth: string,
  priorityMode: 'priority' | 'standard' = 'standard', tag?: string,
): Promise<{ taskId: string | null; cost: number; unclear: boolean }> {
  const posted = await postGridTaskChunk([{ keyword, lat, lng, language, priority: priorityMode === 'priority' ? 2 : 1, tag }], auth, 30_000);
  const task = posted.results[0];
  const unclear = posted.error ? !posted.rejected : task?.outcome !== 'accepted' && task?.outcome !== 'rejected';
  return { taskId: task?.taskId ?? null, cost: task?.cost ?? 0, unclear };
}

export function stableGridId(
  keyword: string, center: string, gridSize: number,
  spacingKm: number, target: string, queueMode: string,
): string {
  const window = Math.floor(Date.now() / 60_000);
  const key = `${window}|${keyword}|${center}|${gridSize}|${spacingKm}|${target}|${queueMode}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
