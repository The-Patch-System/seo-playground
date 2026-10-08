// Patch fork: decides which Maps result is "our" business in a Geo-grid snapshot.
//
// A target can be:
// - a Google listing picked from the map search, stored as "Business Name (cid:1234…)":
//   matched on the listing's CID only, exactly like Semrush's Map Rank Tracker.
// - a domain or URL: matched on the hostname, ignoring protocol and "www.", so
//   "https://example.com" and "www.example.com" behave the same. A path, if given,
//   must also appear in the listing's URL (useful for multi-location brands).
// - anything else: case-insensitive partial match on the business name, domain or URL.

export interface TargetCandidate {
  title?: string | null;
  domain?: string | null;
  url?: string | null;
  cid?: string | number | null;
}

export function parseTargetCid(target: string): string | null {
  const match = target.match(/cid:\s*(\d+)/i);
  return match ? match[1] : null;
}

export function formatBusinessTarget(title: string, cid: string): string {
  return `${title.trim()} (cid:${cid})`;
}

function normalizeUrl(value: string): { host: string; path: string } | null {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`);
    const path = url.pathname.replace(/\/+$/, '');
    return { host: url.hostname.replace(/^www\./, ''), path };
  } catch {
    return null;
  }
}

function looksLikeDomain(value: string): boolean {
  return /^(https?:\/\/)?(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?(\/\S*)?$/i.test(value.trim());
}

export function makeTargetMatcher(target: string): (item: TargetCandidate) => boolean {
  const cid = parseTargetCid(target);
  if (cid) return (item) => item.cid != null && String(item.cid) === cid;

  const raw = target.trim().toLowerCase();
  if (!raw) return () => false;

  if (looksLikeDomain(raw)) {
    const wanted = normalizeUrl(raw);
    if (wanted) {
      return (item) => [item.url, item.domain].some((value) => {
        if (!value) return false;
        const got = normalizeUrl(value);
        if (!got) return false;
        const hostMatches = got.host === wanted.host || got.host.endsWith(`.${wanted.host}`);
        return hostMatches && (!wanted.path || (value === item.url && got.path.startsWith(wanted.path)));
      });
    }
  }

  return (item) => [item.title, item.domain, item.url].some((value) => (value ?? '').toLowerCase().includes(raw));
}
