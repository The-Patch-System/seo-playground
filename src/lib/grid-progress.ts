import { matchesGridTarget } from '@/lib/grid-target';
import {
  getGridProgressForProject, updateGridProgressForProject,
  type GridLocalItem, type GridPoint, type GridSearchEntry, type GridTaskPoint,
} from '@/lib/db';
import { repostGridPoint } from '@/app/dashboard/local-finder/grid-api';

interface DFSTaskGetResponse {
  tasks?: Array<{
    status_code?: number;
    result?: Array<{ items?: Array<{
      type: string; rank_group: number; title?: string; domain?: string; url?: string; cid?: string;
      rating?: { value?: number; votes_count?: number };
    }> }>;
  }>;
}

/** Patch fork: a point whose task errors is re-posted this many times before it is marked failed. */
export const MAX_POINT_ATTEMPTS = 3;
/** Patch fork: task_get calls in flight at once per run, so a big batch doesn't burst DataForSEO. */
const TASK_GET_CONCURRENCY = 10;

async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
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

type Check =
  | { kind: 'pending'; taskPoint: GridTaskPoint }
  | { kind: 'ready'; taskPoint: GridTaskPoint; items: NonNullable<NonNullable<NonNullable<DFSTaskGetResponse['tasks']>[number]['result']>[number]['items']> }
  | { kind: 'failed'; taskPoint: GridTaskPoint };

async function collectGridProgressOnce(
  projectId: string,
  entry: GridSearchEntry & { task_ids?: GridTaskPoint[] },
  credentials: { login: string; pass: string },
): Promise<{ status: 'done' | 'pending'; ready: number; total: number }> {
  const total = entry.grid_size ** 2;
  const progress = getGridProgressForProject(projectId, entry.id);
  if (!progress || progress.pendingTasks.length === 0) return { status: 'pending', ready: 0, total };

  const auth = btoa(`${credentials.login}:${credentials.pass}`);
  const stillProcessing = new Set([40602, 40601]);
  const checks = await mapLimited(progress.pendingTasks, TASK_GET_CONCURRENCY, async (taskPoint): Promise<Check> => {
    try {
      const response = await fetch(`https://api.dataforseo.com/v3/serp/google/local_finder/task_get/advanced/${taskPoint.task_id}`, {
        headers: { Authorization: `Basic ${auth}` }, signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) return { kind: 'pending', taskPoint };
      const data = await response.json() as DFSTaskGetResponse;
      const task = data.tasks?.[0];
      if (!task || stillProcessing.has(task.status_code ?? 0)) return { kind: 'pending', taskPoint };
      if (task.status_code === 20000) {
        return { kind: 'ready', taskPoint, items: (task.result?.[0]?.items ?? []).filter((item) => item.type === 'local_pack') };
      }
      // Patch fork: the task itself failed. Upstream stored this as an empty point, which
      // showed as "not found" even though Google was never checked there.
      return { kind: 'failed', taskPoint };
    } catch {
      return { kind: 'pending', taskPoint };
    }
  });

  const isTargetItem = (item: { title?: string; domain?: string; url?: string; cid?: string }) => matchesGridTarget(entry.target, item);
  const readyPoints: GridPoint[] = [];
  const pendingTasks: GridTaskPoint[] = [];
  for (const check of checks) {
    const { taskPoint } = check;
    if (check.kind === 'pending') {
      pendingTasks.push(taskPoint);
      continue;
    }
    if (check.kind === 'failed') {
      const attempts = taskPoint.attempts ?? 1;
      if (attempts < MAX_POINT_ATTEMPTS) {
        const repost = await repostGridPoint(entry.keyword, taskPoint.lat, taskPoint.lng, entry.language, auth, entry.queue_mode === 'priority' ? 'priority' : 'standard');
        pendingTasks.push({ ...taskPoint, task_id: repost.taskId ?? taskPoint.task_id, attempts: attempts + 1 });
        continue;
      }
      readyPoints.push({ row: taskPoint.row, col: taskPoint.col, lat: taskPoint.lat, lng: taskPoint.lng, rank: null, items: [], failed: true });
      continue;
    }
    const match = check.items.find((item) => isTargetItem(item));
    const items: GridLocalItem[] = check.items.slice(0, 20).map((item) => ({
      rank_group: item.rank_group, title: item.title ?? '—', domain: item.domain, url: item.url, cid: item.cid,
      rating_value: item.rating?.value, rating_votes: item.rating?.votes_count,
      is_target: isTargetItem(item),
    }));
    readyPoints.push({ row: taskPoint.row, col: taskPoint.col, lat: taskPoint.lat, lng: taskPoint.lng, rank: match ? match.rank_group : null, items });
  }

  const accumulated = [...progress.results, ...readyPoints];
  updateGridProgressForProject(projectId, entry.id, accumulated, pendingTasks);
  return { status: pendingTasks.length === 0 ? 'done' : 'pending', ready: accumulated.length, total };
}
