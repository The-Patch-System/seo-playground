/**
 * Newest run per monitor series. Picks max `ts` per `series_id` regardless of input order
 * (getGridHistory() is newest-first, so a plain Map would keep the OLDEST duplicate) and
 * returns the winners newest-first.
 */
export function latestRunPerSeries<T extends { series_id: string; ts: number }>(entries: T[]): T[] {
  const latest = new Map<string, T>();
  for (const entry of entries) {
    const current = latest.get(entry.series_id);
    if (!current || entry.ts > current.ts) latest.set(entry.series_id, entry);
  }
  return Array.from(latest.values()).sort((a, b) => b.ts - a.ts);
}
