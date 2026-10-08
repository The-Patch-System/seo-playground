import { NextRequest, NextResponse } from 'next/server';

// Patch fork: password-protect the whole dashboard. The app has no login of its own and
// spends DataForSEO credit, so it fails closed when no password is configured.
// The Geo-grid worker endpoint is excluded below; it authenticates with CRON_SECRET.

export const config = {
  runtime: 'nodejs',
  matcher: ['/((?!api/cron/|_next/static|_next/image|favicon.ico).*)'],
};

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function middleware(request: NextRequest) {
  const username = process.env.SITE_USERNAME?.trim() || 'patch';
  const password = process.env.SITE_PASSWORD?.trim();
  if (!password) return new NextResponse('SITE_PASSWORD is not configured.', { status: 503 });

  const header = request.headers.get('authorization') ?? '';
  if (header.startsWith('Basic ')) {
    try {
      const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
      const separator = decoded.indexOf(':');
      if (separator >= 0 && safeEqual(decoded.slice(0, separator), username) && safeEqual(decoded.slice(separator + 1), password)) {
        return NextResponse.next();
      }
    } catch {
      // Fall through to the challenge.
    }
  }
  return new NextResponse('Authentication required.', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="SEO Playground", charset="UTF-8"' },
  });
}
