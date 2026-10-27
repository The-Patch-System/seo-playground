// Patch fork: Semrush MRT (and Patch's SOP) sets a map by radius in miles: 5 mi for most
// clinics, 10 mi for rural ones. The grid itself is still stored as km between points.

export const KM_PER_MILE = 1.609344;
export const RADIUS_OPTIONS_MI = [1, 2, 3, 5, 10, 15, 20] as const;
export const DEFAULT_RADIUS_MI = 5;
export const DEFAULT_GRID_SIZE = 9;
/** Midday local time, so Google results reflect businesses that are open. */
export const DEFAULT_SCHEDULE_TIME = '12:00';
export const DEFAULT_SCHEDULE_DAY = 15;

/** Distance between neighbouring points that puts the outer ring `radiusMi` from the center. */
export function spacingKmForRadius(radiusMi: number, gridSize: number): number {
  const half = Math.max(1, Math.floor(gridSize / 2));
  return Math.round(((radiusMi * KM_PER_MILE) / half) * 10_000) / 10_000;
}

/** Center-to-edge radius in miles for a stored grid, rounded to 0.1 mi. */
export function radiusMiForSpacing(spacingKm: number, gridSize: number): number {
  const half = Math.floor(gridSize / 2);
  return Math.round(((spacingKm * half) / KM_PER_MILE) * 10) / 10;
}
