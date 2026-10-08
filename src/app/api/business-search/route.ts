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

  try {
    const response = await fetch('https://api.dataforseo.com/v3/serp/google/maps/live/advanced', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${credentials.login}:${credentials.pass}`).toString('base64')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([{ keyword: query, location_code: 2840, language_code: 'en', depth: 10 }]),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) return NextResponse.json({ results: [], error: `DataForSEO HTTP ${response.status}` }, { status: 502 });
    const data = await response.json() as { tasks?: Array<{ status_code?: number; status_message?: string; result?: Array<{ items?: MapsItem[] }> }> };
    const task = data.tasks?.[0];
    if (!task || task.status_code !== 20000) {
      return NextResponse.json({ results: [], error: task?.status_message ?? 'No response from DataForSEO.' }, { status: 502 });
    }
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
  } catch (error) {
    return NextResponse.json({ results: [], error: error instanceof Error ? error.message : 'Business search failed.' }, { status: 502 });
  }
}
