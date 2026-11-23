// Patch fork: turns one DataForSEO Local Finder result into a stored grid point. Shared by the live
// path (grid-api.ts), queued collection (grid-progress.ts) and re-scans (grid-rescan.ts) so all
// three rank, store and check points the same way.
import type { GridLocalItem, GridPoint } from '@/lib/db';
import { matchesGridTarget } from '@/lib/grid-target';
import { checkPointLocation, parseListingPlace, type LocationCheck } from '@/lib/grid-location-check';

/** Requested result depth. Ads use up depth, so 30 leaves ~20 organic listings. */
export const GRID_DEPTH = 30;
/** Organic listings stored per point. The UI, visibility and MRT (21 = unranked) all assume a top 20. */
export const GRID_ORGANIC_KEEP = 20;

export interface RawLocalItem {
  type: string;
  rank_group: number;
  rank_absolute?: number;
  title?: string;
  description?: string | null;
  domain?: string | null;
  url?: string | null;
  cid?: string | null;
  is_paid?: boolean | null;
  rating?: { value?: number; votes_count?: number } | null;
}

export interface BuiltPoint {
  point: GridPoint;
  location: LocationCheck;
}

/**
 * Organic-only ranks: ads (`is_paid`) are dropped and the rest renumbered 1..N. The renumbered rank is
 * what's stored in `rank_group`, because reconcileGridPoints recomputes `rank` from stored items on read.
 */
export function buildGridPoint(
  coord: { row: number; col: number; lat: number; lng: number },
  rawItems: RawLocalItem[],
  target: string,
  meta: { task_id?: string; check_url?: string; depth?: number } = {},
): BuiltPoint {
  const depth = meta.depth ?? GRID_DEPTH;
  const local = rawItems.filter((item) => item.type === 'local_pack');
  const paid = local.filter((item) => item.is_paid);
  const seen = new Set<string>();
  const organic = local
    .filter((item) => !item.is_paid)
    .sort((a, b) => a.rank_group - b.rank_group)
    .filter((item) => {
      // A listing repeated in one result keeps its first (best) position.
      if (!item.cid) return true;
      if (seen.has(item.cid)) return false;
      seen.add(item.cid);
      return true;
    });

  const items: GridLocalItem[] = organic.slice(0, GRID_ORGANIC_KEEP).map((item, index) => {
    const place = parseListingPlace(item.description);
    return {
      rank_group: index + 1,
      title: item.title ?? '—',
      domain: item.domain ?? undefined,
      url: item.url ?? undefined,
      cid: item.cid ?? undefined,
      rating_value: item.rating?.value,
      rating_votes: item.rating?.votes_count,
      is_target: matchesGridTarget(target, item),
      provider_rank: item.rank_group,
      ...(item.rank_absolute != null ? { rank_absolute: item.rank_absolute } : {}),
      ...(place ? { place: `${place.city}, ${place.state}` } : {}),
    };
  });

  const location = checkPointLocation(
    organic.map((item, index) => ({ rank: index + 1, title: item.title, description: item.description })),
    coord.lat, coord.lng,
  );

  const targetRanks = items.filter((item) => item.is_target).map((item) => item.rank_group);
  const rank = targetRanks.length ? Math.min(...targetRanks) : null;
  // Ads used up the depth before 20 organic listings came back: a missing target may sit just below.
  const truncated = organic.length < GRID_ORGANIC_KEEP && local.length >= depth;

  const point: GridPoint = {
    row: coord.row, col: coord.col, lat: coord.lat, lng: coord.lng,
    rank,
    items,
    raw_count: local.length,
    paid_count: paid.length,
    organic_count: organic.length,
    ...(truncated ? { truncated: true } : {}),
    ...(truncated && rank === null ? { rank_unresolved: true } : {}),
    ...(location.status === 'unresolved' ? { location_status: 'unresolved' as const } : {}),
    ...(meta.task_id ? { task_id: meta.task_id } : {}),
    ...(meta.check_url ? { check_url: meta.check_url } : {}),
  };
  return { point, location };
}

/** A point with no usable data: the task errored or every attempt came back wrong-city. */
export function failedGridPoint(
  coord: { row: number; col: number; lat: number; lng: number },
  reason: NonNullable<GridPoint['failed_reason']>,
  evidence: Pick<GridPoint, 'task_id' | 'check_url' | 'rechecks'> = {},
): GridPoint {
  return {
    row: coord.row, col: coord.col, lat: coord.lat, lng: coord.lng,
    rank: null, items: [], failed: true, failed_reason: reason,
    ...(evidence.task_id ? { task_id: evidence.task_id } : {}),
    ...(evidence.check_url ? { check_url: evidence.check_url } : {}),
    ...(evidence.rechecks?.length ? { rechecks: evidence.rechecks } : {}),
  };
}
