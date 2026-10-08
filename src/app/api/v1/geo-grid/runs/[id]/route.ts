import { NextRequest, NextResponse } from 'next/server';
import { requireApiKey } from '@/lib/api-auth';
import { getRun } from '@/lib/grid-report';

export const dynamic = 'force-dynamic';

/** GET /api/v1/geo-grid/runs/{run_id}?competitors=false : one run with every grid point. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = requireApiKey(request);
  if (denied) return denied;
  const { id } = await params;
  const competitors = request.nextUrl.searchParams.get('competitors') !== 'false';
  const run = getRun(id, request.nextUrl.searchParams.get('project') ?? undefined, { competitors });
  if (!run) return NextResponse.json({ error: 'Run not found.' }, { status: 404 });
  return NextResponse.json(run);
}
