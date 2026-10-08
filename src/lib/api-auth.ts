import { NextRequest, NextResponse } from 'next/server';

// Patch fork: API-key check for /api/v1/*. These routes skip the site password (see
// middleware.ts) and accept REPORTING_API_KEY as "x-api-key" or "Authorization: Bearer".
// Fails closed when no key is configured.
export function requireApiKey(request: NextRequest): NextResponse | null {
  const expected = process.env.REPORTING_API_KEY?.trim();
  if (!expected) return NextResponse.json({ error: 'REPORTING_API_KEY is not configured.' }, { status: 503 });
  const given = request.headers.get('x-api-key')?.trim()
    ?? request.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim()
    ?? '';
  let diff = given.length === expected.length ? 0 : 1;
  for (let i = 0; i < Math.min(given.length, expected.length); i += 1) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0 ? null : NextResponse.json({ error: 'Invalid or missing API key.' }, { status: 401 });
}
