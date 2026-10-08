import { NextRequest, NextResponse } from 'next/server';
import { requireApiKey } from '@/lib/api-auth';
import { listMonitors } from '@/lib/grid-report';

export const dynamic = 'force-dynamic';

/** GET /api/v1/geo-grid/monitors?q=&cid=&project= : every monitor with its latest completed run summary. */
export async function GET(request: NextRequest) {
  const denied = requireApiKey(request);
  if (denied) return denied;
  const params = request.nextUrl.searchParams;
  const monitors = listMonitors({ q: params.get('q') ?? undefined, cid: params.get('cid') ?? undefined, project: params.get('project') ?? undefined });
  return NextResponse.json({ monitors });
}
