import { NextRequest, NextResponse } from 'next/server';
import { getCredentials } from '@/lib/db';
import { LANGUAGES } from '@/lib/geo-options';

export const dynamic = 'force-dynamic';

// Google Maps business lookup for the Geo-grid "Find" box, so a business can be picked by
// name (like Semrush's Map Rank Tracker) instead of geocoding an address.
// 1) DataForSEO Google Maps live search (about $0.002), biased to the map area and form language.
// 2) Patch fork: if that errors or finds nothing, DataForSEO's Business Listings database, which
//    does not depend on a live Google search and keeps working when the live endpoint is flaky.
//
// Query parameters:
//   q                    business name (required)
//   location_coordinate  "lat,lng" or "lat,lng,zoom" (usually the current map view)
//   location_code        DataForSEO location code, used when no coordinate is given (default: US)
//   language             language name from the form (e.g. "French"); defaults to English
//   source=listings      skip straight to the Business Listings database (testing)

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

/** Parses "lat,lng[,zoom]"; null when invalid. */
function parseCoordinate(raw: string | null): { lat: number; lng: number; zoom: number } | null {
  if (!raw) return null;
  const [lat, lng, zoom] = raw.split(',').map((part) => part.trim().replace(/z$/i, ''));
  const latN = Number(lat), lngN = Number(lng);
  if (!lat || !lng || !Number.isFinite(latN) || !Number.isFinite(lngN)) return null;
  if (Math.abs(latN) > 90 || Math.abs(lngN) > 180) return null;
  return { lat: latN, lng: lngN, zoom: Math.min(21, Math.max(3, Math.round(Number(zoom) || 12))) };
}

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
  const params = request.nextUrl.searchParams;
  const query = params.get('q')?.trim();
  if (!query) return NextResponse.json({ results: [] });
  const coordinate = parseCoordinate(params.get('location_coordinate'));
  const locationCode = Number(params.get('location_code'));
  const requestedLanguage = params.get('language')?.trim();
  const language = LANGUAGES.find((item) => item.value.toLowerCase() === requestedLanguage?.toLowerCase())?.value ?? 'English';
  const credentials = getCredentials();
  if (!credentials) return NextResponse.json({ results: [], error: 'DataForSEO credentials are not configured.' }, { status: 503 });
  const auth = Buffer.from(`${credentials.login}:${credentials.pass}`).toString('base64');
  const errors: string[] = [];

  if (params.get('source') !== 'listings') {
    const maps = await callDataForSeo(auth, 'serp/google/maps/live/advanced', {
      keyword: query,
      ...(coordinate
        ? { location_coordinate: `${coordinate.lat.toFixed(7)},${coordinate.lng.toFixed(7)},${coordinate.zoom}z` }
        : { location_code: Number.isInteger(locationCode) && locationCode > 0 ? locationCode : 2840 }),
      language_name: language,
      depth: 10,
    }, 20_000);
    if (maps.items) {
      const results = toResults(maps.items, 'maps_search');
      if (results.length > 0) return NextResponse.json({ results, source: 'google_maps' });
    } else {
      errors.push(`Google Maps: ${maps.error}`);
      console.error(`[business-search] Google Maps failed for "${query}": ${maps.error}`);
    }
  }

  // Business Listings: near the map area first (radius follows the zoom level), then anywhere.
  const radiusKm = coordinate ? Math.min(2000, Math.max(25, Math.round((20000 / 2 ** coordinate.zoom) * 4))) : null;
  const attempts: Array<{ title: string; near: boolean }> = [
    ...(coordinate ? titleCandidates(query).map((title) => ({ title, near: true })) : []),
    ...titleCandidates(query).map((title) => ({ title, near: false })),
  ];
  for (const { title, near } of attempts) {
    const listings = await callDataForSeo(auth, 'business_data/business_listings/search/live', {
      title,
      ...(near && coordinate ? { location_coordinate: `${coordinate.lat.toFixed(7)},${coordinate.lng.toFixed(7)},${radiusKm}` } : {}),
      order_by: ['rating.votes_count,desc'],
      limit: 8,
    }, 15_000);
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
