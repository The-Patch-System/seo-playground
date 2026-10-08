/**
 * Decides whether a Local Finder listing is the monitored target.
 *
 * Local Finder listings frequently come back without `domain`/`url` (only a title),
 * so a domain target such as "saint-esteve.com" can never match them by substring.
 * To avoid reporting 0% everywhere, a domain/URL target also matches on its brand
 * label ("saint-esteve" -> "saintesteve") against the normalized listing title.
 */

interface ListingLike {
  title?: string | null;
  domain?: string | null;
  url?: string | null;
}

/** Lowercase, accent-free, letters and digits only. */
function normalize(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** Returns the registrable host label when the target looks like a domain/URL ("https://www.saint-esteve.com/x" -> "saint-esteve"). */
function brandFromDomainTarget(target: string): string | null {
  const host = target.trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0];
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return null;
  const label = host.split('.')[0];
  const brand = normalize(label);
  // Very short labels would match unrelated titles.
  return brand.length >= 4 ? brand : null;
}

export function matchesGridTarget(target: string, listing: ListingLike): boolean {
  const needle = target.trim().toLowerCase();
  if (!needle) return false;
  const title = (listing.title ?? '').toLowerCase();
  if (title.includes(needle)
    || (listing.domain ?? '').toLowerCase().includes(needle)
    || (listing.url ?? '').toLowerCase().includes(needle)) return true;

  const brand = brandFromDomainTarget(needle);
  return brand !== null && normalize(title).includes(brand);
}

interface PointLike {
  rank: number | null;
  items?: Array<{ rank_group: number; title: string; domain?: string; url?: string; is_target: boolean }>;
}

/**
 * Recomputes `is_target` and `rank` from the stored listings, so runs saved before
 * the matching was fixed report correct numbers without touching the database.
 */
export function reconcileGridPoints<T extends PointLike>(points: T[], target: string): T[] {
  return points.map((point) => {
    if (!point.items?.length) return point;
    const items = point.items.map((item) => ({ ...item, is_target: matchesGridTarget(target, item) }));
    const ranks = items.filter((item) => item.is_target).map((item) => item.rank_group);
    return { ...point, items, rank: ranks.length ? Math.min(...ranks) : null };
  });
}
