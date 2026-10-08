import { NextRequest, NextResponse } from 'next/server';
import { getCredentials } from '@/lib/db';

export const dynamic = 'force-dynamic';

// Patch fork: Google Maps business lookup for the Geo-grid "Find" box, so a clinic can be
// picked by name (like Semrush's Map Rank Tracker) instead of geocoding an address.
// 1) DataForSEO Google Maps live search (about $0.002), the freshest source.
// 2) If that errors or finds nothing, DataForSEO's Business Listings database, which does
//    not depend on a live Google search and keeps working when the live endpoint is flaky.
// Add ?source=listings to skip straight to the database (useful for testing).

interface DfsItem {
  type?: string;
  title?: string;
  address?: string;
  latitude?: number;
  longitude?: number;
  cid?: string;
  domain?: string;
  category?: string;
  rating?: { value?: number; votes_count?: number };
}

type DfsResult = { items: DfsItem[]; error?: undefined } | { items?: undefined; error: string };

async function callDataForSeo(auth: string, path: string, body: unknown, timeoutMs: number): Promise<DfsResult> {
  try {
    const response = await fetch(`https://api.dataforseo.com/v3/${path}`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([body]),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { error: `DataForSEO HTTP ${response.status}` };
    const data = await response.json() as { status_message?: string; tasks?: Array<{ status_code?: number; status_message?: string; result?: Array<{ items?: DfsItem[] | null }> | null }> };
    const task = data.tasks?.[0];
    if (task?.status_code !== 20000) return { error: task?.status_message ?? data.status_message ?? 'No response from DataForSEO.' };
    return { items: task.result?.[0]?.items ?? [] };
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') return { error: 'DataForSEO took too long to respond.' };
    return { error: error instanceof Error ? error.message : 'Business search failed.' };
  }
}

function toResults(items: DfsItem[], type: string) {
  return items
    .filter((item) => item.type === type && item.cid && item.latitude != null && item.longitude != null)
    .slice(0, 8)
    .map((item) => ({
      title: item.title ?? 'Unnamed business',
      address: item.address ?? '',
      lat: item.latitude as number,
      lng: item.longitude as number,
      cid: String(item.cid),
      domain: item.domain ?? '',
      category: item.category ?? '',
      rating: item.rating?.value ?? null,
      reviews: item.rating?.votes_count ?? null,
    }));
}

/** "elevation athletics fort worth" -> also try "elevation athletics fort", "elevation athletics" (listings match on the name only). */
function titleCandidates(query: string): string[] {
  const words = query.split(/\s+/).filter(Boolean);
  const candidates = [words.join(' ')];
  for (let n = words.length - 1; n >= 2 && candidates.length < 3; n -= 1) candidates.push(words.slice(0, n).join(' '));
  return candidates;
}

export async function GET(request: NextRequest) {
  const query = request.nextUrl.searchParams.get('q')?.trim();
  if (!query) return NextResponse.json({ results: [] });
  const credentials = getCredentials();
  if (!credentials) return NextResponse.json({ results: [], error: 'DataForSEO credentials are not configured.' }, { status: 503 });
  const auth = Buffer.from(`${credentials.login}:${credentials.pass}`).toString('base64');
  const errors: string[] = [];

  if (request.nextUrl.searchParams.get('source') !== 'listings') {
    const maps = await callDataForSeo(auth, 'serp/google/maps/live/advanced', { keyword: query, location_code: 2840, language_code: 'en', depth: 10 }, 20_000);
    if (maps.items) {
      const results = toResults(maps.items, 'maps_search');
      if (results.length > 0) return NextResponse.json({ results, source: 'google_maps' });
    } else {
      errors.push(`Google Maps: ${maps.error}`);
      console.error(`[business-search] Google Maps failed for "${query}": ${maps.error}`);
    }
  }

  for (const title of titleCandidates(query)) {
    const listings = await callDataForSeo(auth, 'business_data/business_listings/search/live', { title, order_by: ['rating.votes_count,desc'], limit: 8 }, 15_000);
    if (listings.error) {
      errors.push(`Business listings: ${listings.error}`);
      console.error(`[business-search] Business listings failed for "${title}": ${listings.error}`);
      break;
    }
    const results = toResults(listings.items ?? [], 'business_listing');
    if (results.length > 0) return NextResponse.json({ results, source: 'business_listings' });
  }

  if (errors.length > 0) return NextResponse.json({ results: [], error: errors.join(' · ') }, { status: 502 });
  return NextResponse.json({ results: [] });
}
