import { NextRequest, NextResponse } from 'next/server';
import { getCredentials } from '@/lib/db';

export const dynamic = 'force-dynamic';

// Patch fork: Google Maps business lookup for the Geo-grid "Find" box, so a clinic can be
// picked by name (like Semrush's Map Rank Tracker) instead of geocoding an address.
// Uses DataForSEO's Google Maps SERP (about $0.002 per search).

interface MapsItem {
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

export async function GET(request: NextRequest) {
  const query = request.nextUrl.searchParams.get('q')?.trim();
  if (!query) return NextResponse.json({ results: [] });
  const credentials = getCredentials();
  if (!credentials) return NextResponse.json({ results: [], error: 'DataForSEO credentials are not configured.' }, { status: 503 });

  const auth = Buffer.from(`${credentials.login}:${credentials.pass}`).toString('base64');
  let lastError = 'Google Maps search failed.';
  // DataForSEO's live Maps endpoint occasionally errors or stalls; retry once before giving up.
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await fetch('https://api.dataforseo.com/v3/serp/google/maps/live/advanced', {
        method: 'POST',
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
        body: JSON.stringify([{ keyword: query, location_code: 2840, language_code: 'en', depth: 10 }]),
        signal: AbortSignal.timeout(25_000),
      });
      if (!response.ok) {
        lastError = `DataForSEO HTTP ${response.status}`;
      } else {
        const data = await response.json() as { status_code?: number; status_message?: string; tasks?: Array<{ status_code?: number; status_message?: string; result?: Array<{ items?: MapsItem[] }> }> };
        const task = data.tasks?.[0];
        if (task?.status_code === 20000) {
          const results = (task.result?.[0]?.items ?? [])
            .filter((item) => item.type === 'maps_search' && item.cid && item.latitude != null && item.longitude != null)
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
          return NextResponse.json({ results });
        }
        lastError = task?.status_message ?? data.status_message ?? 'No response from DataForSEO.';
      }
    } catch (error) {
      lastError = error instanceof Error && error.name === 'TimeoutError' ? 'DataForSEO took too long to respond.' : (error instanceof Error ? error.message : 'Business search failed.');
    }
    console.error(`[business-search] attempt ${attempt} failed for "${query}": ${lastError}`);
  }
  return NextResponse.json({ results: [], error: lastError }, { status: 502 });
}
