import { NextRequest, NextResponse } from 'next/server';
import { authEnabled } from '@/lib/auth-config';

// Patch fork: two ways to protect the dashboard.
// - Default: one shared password (HTTP basic auth). Username SITE_USERNAME (default "patch"),
//   password SITE_PASSWORD. Fails closed (503) when no password is configured.
// - AUTH_ENABLED=true: upstream's per-user email + password login (/setup, /login).
// In both modes /api/cron (CRON_SECRET) and /api/v1 (REPORTING_API_KEY) use their own keys.

export const config = {
  runtime: 'nodejs',
  matcher: ['/((?!_next/static|_next/image|favicon.ico|robots.txt).*)'],
};

const KEY_AUTH_PREFIXES = ['/api/cron', '/api/v1'];
const LOGIN_PUBLIC_PREFIXES = ['/login', '/setup', '/api/auth'];

function startsWithAny(pathname: string, prefixes: string[]) {
  return prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function sharedPassword(request: NextRequest) {
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

/** Upstream: validate the session by asking this server's auth handler (revoked sessions fail immediately). */
async function hasValidSession(request: NextRequest): Promise<boolean> {
  const cookie = request.headers.get('cookie');
  if (!cookie || !cookie.includes('session_token')) return false;
  const port = process.env.PORT?.trim() || request.nextUrl.port || '3000';
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/auth/get-session`, { headers: { cookie }, cache: 'no-store' });
    if (!response.ok) return false;
    const data = await response.json() as { session?: unknown } | null;
    return Boolean(data?.session);
  } catch {
    return false; // Fail closed.
  }
}

export async function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (startsWithAny(pathname, KEY_AUTH_PREFIXES)) return NextResponse.next();
  if (!authEnabled()) return sharedPassword(request);

  if (startsWithAny(pathname, LOGIN_PUBLIC_PREFIXES)) return NextResponse.next();
  if (await hasValidSession(request)) return NextResponse.next();
  if (pathname.startsWith('/api/')) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const url = request.nextUrl.clone();
  url.pathname = '/login';
  url.search = pathname === '/' || pathname === '/dashboard' ? '' : `?next=${encodeURIComponent(pathname + search)}`;
  return NextResponse.redirect(url);
}
