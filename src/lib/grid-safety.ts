// Patch fork: whether a Geo-grid run's numbers are safe to report, from its points alone. Shared by the
// Reporting API (grid-report.ts via runSafety), re-scan swaps (grid-rescan.ts) and the scheduled-run
// completion alert (grid-progress.ts). A separate module so grid-progress needn't import grid-rescan.
import type { GridPoint } from '@/lib/db';

/** Points that may fail for reasons other than wrong-city before a run is not safe to report. */
export const MAX_OTHER_FAILED = 2;

/** report_safe: true = safe; false = not safe (see reason); null = unknown (not checked, or not finished). */
export interface RunSafety { report_safe: boolean | null; reason: string | null }
/** A verdict from points that were all checked: always true or false. */
export interface ComputedSafety { report_safe: boolean; reason: string | null }

/** Exactly one point per (row, col) inside the grid, and grid_size² of them. */
export function isCompleteGrid(points: GridPoint[], gridSize: number): boolean {
  if (points.length !== gridSize * gridSize) return false;
  const seen = new Set<string>();
  for (const p of points) {
    if (p.row < 0 || p.col < 0 || p.row >= gridSize || p.col >= gridSize) return false;
    const key = `${p.row}:${p.col}`;
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

/**
 * Any wrong-city failed point, a grid that isn't complete, more than 2 failed points, or a truncated
 * point where the target's rank is unknown makes a run unsafe.
 */
export function computedSafety(points: GridPoint[], gridSize: number): ComputedSafety {
  if (points.some((p) => p.failed && p.failed_reason === 'wrong_city')) return { report_safe: false, reason: 'wrong_city_persistent' };
  if (!isCompleteGrid(points, gridSize)) return { report_safe: false, reason: 'incomplete_grid' };
  if (points.filter((p) => p.failed).length > MAX_OTHER_FAILED) return { report_safe: false, reason: 'too_many_failed' };
  if (points.some((p) => p.rank_unresolved)) return { report_safe: false, reason: 'rank_unresolved' };
  return { report_safe: true, reason: null };
}

/** Every point the wrong-city check built has raw_count; a failed point has no data to check. */
export function wasChecked(points: GridPoint[]): boolean {
  return points.every((p) => p.failed || typeof p.raw_count === 'number');
}

/**
 * computedSafety, except that a run the wrong-city check never saw (pre-fix runs, Semrush imports)
 * is unknown (null, `not_checked`), never true. Known problems still win: they are definite.
 */
export function checkedSafety(points: GridPoint[], gridSize: number): RunSafety {
  const computed = computedSafety(points, gridSize);
  if (computed.report_safe === false) return computed;
  if (!wasChecked(points)) return { report_safe: null, reason: 'not_checked' };
  return computed;
}
