import { NextRequest, NextResponse } from 'next/server';
import { isShortMapsLink } from '@/lib/maps-link';

export const dynamic = 'force-dynamic';

// Patch fork: expands a Google Maps Share link (maps.app.goo.gl/…) to the full listing URL, which has the
// CID, the pin and the name. Browsers can't read the redirect themselves (CORS), so the server follows it.
// Only Google hosts are followed, and nothing but the final URL is returned. Free: no DataForSEO call.
//
// GET /api/maps-link?url=https://maps.app.goo.gl/AbC123  ->  { url: "https://www.google.com/maps/place/…" }

const ALLOWED_HOSTS = new Set(['maps.app.goo.gl', 'goo.gl', 'www.google.com', 'google.com', 'maps.google.com']);
const MAX_HOPS = 5;

function allowed(url: URL): boolean {
  return url.protocol === 'https:' && ALLOWED_HOSTS.has(url.hostname);
}

export async function GET(request: NextRequest) {
  const raw = request.nextUrl.searchParams.get('url')?.trim() ?? '';
  if (!isShortMapsLink(raw)) return NextResponse.json({ error: 'Not a Google Maps share link.' }, { status: 400 });

  let current = new URL(raw);
  for (let hop = 0; hop < MAX_HOPS; hop += 1) {
    let response: Response;
    try {
      response = await fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(8_000) });
    } catch (error) {
      console.error(`[maps-link] ${current.href}: ${error instanceof Error ? error.message : String(error)}`);
      return NextResponse.json({ error: "Couldn't open that link. Try again, or open it and copy the address bar." }, { status: 502 });
    }
    const location = response.headers.get('location');
    if (response.status < 300 || response.status >= 400 || !location) {
      // No more redirects: a Maps page is the answer, anything else (404 etc.) means a dead link.
      if (current.hostname.endsWith('google.com') && response.ok) return NextResponse.json({ url: current.href });
      return NextResponse.json({ error: "That share link didn't lead to a Google Maps listing." }, { status: 404 });
    }
    const next = new URL(location, current);
    if (!allowed(next)) return NextResponse.json({ error: "That share link didn't lead to Google Maps." }, { status: 400 });
    if (next.hostname.endsWith('google.com') && next.pathname.startsWith('/maps')) return NextResponse.json({ url: next.href });
    current = next;
  }
  return NextResponse.json({ error: 'Too many redirects.' }, { status: 502 });
}
