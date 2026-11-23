import type { GridPoint, GridRecheck, GridTaskPoint } from '@/lib/db';
import { buildGridPoint, failedGridPoint, GRID_DEPTH, type RawLocalItem } from '@/lib/grid-point-builder';

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
  // Patch fork: a 20000 task without a result object is malformed, not a real zero-result search.
  if (!result || !Array.isArray(result.items) && result.items !== null) {
    return { items: [], cost: task.cost ?? 0, taskId: task.id, error: 'malformed result' };
  }
  return { items: result.items ?? [], cost: task.cost ?? 0, taskId: task.id, checkUrl: result.check_url };
}

/**
 * Patch fork: fetches one point live. An errored request is retried once (as before); a wrong-city
 * result is re-requested, up to MAX_POINT_ATTEMPTS requests in all, and then stored as failed so it
 * never shows as ranks.
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
      if (result.taskId) rechecks.push({ task_id: result.taskId, reason: 'task_error' });
      break;
    }
    const built = buildGridPoint(coord, result.items, target, { task_id: result.taskId, check_url: result.checkUrl });
    if (!built.location.wrongCity) {
      return { point: rechecks.length ? { ...built.point, rechecks } : built.point, cost };
    }
    rechecks.push({ task_id: result.taskId ?? '', check_url: result.checkUrl, reason: 'wrong_city', far: built.location.far });
  }
  // Patch fork: a point that still errored or stayed wrong-city has no data, which is not "not in the top 20".
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

export interface GridTaskPostResult {
  /** Set when DataForSEO accepted (and billed) the task. */
  taskId: string | null;
  statusCode: number | null;
  cost: number;
}

/**
 * Patch fork: posts up to 100 tasks in one task_post call. Returns one result per request, in order,
 * or an error when the call itself failed (then nothing in this chunk is known to be accepted).
 * A task counts as accepted only with an id and a non-error status code.
 */
export async function postGridTaskChunk(
  requests: GridTaskRequest[], auth: string, timeoutMs = 60_000,
): Promise<{ results: GridTaskPostResult[]; error?: string }> {
  let data: { tasks?: Array<{ id?: string; status_code?: number; cost?: number }> };
  try {
    const res = await fetch(`${dataForSeoBaseUrl()}/v3/serp/google/local_finder/task_post`, {
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
    if (!res.ok) return { results: [], error: `API error ${res.status}` };
    data = await res.json();
  } catch (error) {
    return { results: [], error: error instanceof Error ? error.message : 'Could not reach DataForSEO.' };
  }
  if (!data.tasks) return { results: [], error: 'Empty response from DataForSEO.' };
  return {
    results: requests.map((_, j) => {
      const task = data.tasks![j];
      const statusCode = task?.status_code ?? null;
      const accepted = Boolean(task?.id) && (statusCode === null || statusCode < 40000);
      return { taskId: accepted ? task!.id! : null, statusCode, cost: accepted ? task?.cost ?? 0 : 0 };
    }),
  };
}

export async function postGridTasksQueue(
  keyword: string, center: string, gridSize: number, spacingKm: number,
  language: string, login: string, pass: string, priorityMode: 'priority' | 'standard' = 'standard', tagPrefix?: string,
): Promise<{ taskPoints: GridTaskPoint[]; cost: number; error?: string }> {
  const parts = center.split(',').map(Number);
  if (parts.length < 2 || isNaN(parts[0]) || isNaN(parts[1])) {
    return { taskPoints: [], cost: 0, error: 'Invalid coordinates.' };
  }
  const [centerLat, centerLng] = parts;
  const coords = generateGridCoords(centerLat, centerLng, gridSize, spacingKm);
  const auth = btoa(`${login}:${pass}`);
  // DataForSEO: priority=2 processes the task faster for a higher per-task cost; priority=1 is the default standard queue.
  const priority = priorityMode === 'priority' ? 2 : 1;

  const CHUNK = 100;
  const allTaskPoints: GridTaskPoint[] = [];
  let totalCost = 0;
  let rejected = 0;

  for (let i = 0; i < coords.length; i += CHUNK) {
    const chunk = coords.slice(i, i + CHUNK);
    const submittedAt = Date.now();
    const posted = await postGridTaskChunk(chunk.map(({ row, col, lat, lng }) => ({
      keyword, lat, lng, language, priority, tag: tagPrefix ? gridTaskTag(tagPrefix, row, col) : undefined,
    })), auth);
    // On failure, still return the chunks already posted: those tasks are billed, and
    // callers keep them as a partial run rather than losing them or posting them twice.
    if (posted.error) return { taskPoints: allTaskPoints, cost: totalCost, error: posted.error };
    posted.results.forEach((task, j) => {
      const coord = chunk[j];
      // Patch fork: a task DataForSEO rejected (status 4xxxx) is not queued, even if it has an id.
      if (task.taskId) {
        allTaskPoints.push({ task_id: task.taskId, row: coord.row, col: coord.col, lat: coord.lat, lng: coord.lng, attempts: 1, submitted_at: submittedAt });
      } else {
        rejected += 1;
      }
      totalCost += task.cost;
    });
  }

  return { taskPoints: allTaskPoints, cost: totalCost, ...(rejected ? { error: `DataForSEO rejected ${rejected} task(s).` } : {}) };
}

/**
 * Patch fork: re-posts one grid point whose queued task failed or came back wrong-city. Returns the
 * new task id, or null when DataForSEO did not accept it (the caller tries again on a later pass).
 */
export async function repostGridPoint(
  keyword: string, lat: number, lng: number, language: string, auth: string,
  priorityMode: 'priority' | 'standard' = 'standard', tag?: string,
): Promise<{ taskId: string | null; cost: number }> {
  const posted = await postGridTaskChunk([{ keyword, lat, lng, language, priority: priorityMode === 'priority' ? 2 : 1, tag }], auth, 30_000);
  const task = posted.results[0];
  return { taskId: task?.taskId ?? null, cost: task?.cost ?? 0 };
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
