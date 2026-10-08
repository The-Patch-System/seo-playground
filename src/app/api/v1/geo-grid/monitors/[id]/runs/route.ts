import { NextRequest, NextResponse } from 'next/server';
import { requireApiKey } from '@/lib/api-auth';
import { getMonitorRuns } from '@/lib/grid-report';

export const dynamic = 'force-dynamic';

/** GET /api/v1/geo-grid/monitors/{monitor_id}/runs : every run (newest first) plus average-position / share-of-voice series. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = requireApiKey(request);
  if (denied) return denied;
  const { id } = await params;
  const history = getMonitorRuns(id, request.nextUrl.searchParams.get('project') ?? undefined);
  if (!history) return NextResponse.json({ error: 'Monitor not found.' }, { status: 404 });
  return NextResponse.json({ monitor_id: id, ...history });
}
