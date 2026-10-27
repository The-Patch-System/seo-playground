// Patch fork: server-only. Scheduled scans run in the clinic's local time, read from the grid
// center, instead of the time zone of whoever saved the schedule.
import tzLookup from '@photostructure/tz-lookup';

/** The clinic's IANA time zone from the grid center ("lat,lng"), or null when it can't be read. */
export function timeZoneForCenter(center: string): string | null {
  const [lat, lng] = center.split(',').map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  try {
    return tzLookup(lat, lng);
  } catch {
    return null;
  }
}
