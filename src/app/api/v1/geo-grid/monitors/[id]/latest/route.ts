import { NextRequest, NextResponse } from 'next/server';
import { requireApiKey } from '@/lib/api-auth';
import { getMonitorRuns, getRun } from '@/lib/grid-report';

export const dynamic = 'force-dynamic';

/** GET /api/v1/geo-grid/monitors/{monitor_id}/latest?competitors=false : newest completed run with every grid point. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = requireApiKey(request);
  if (denied) return denied;
  const { id } = await params;
  const project = request.nextUrl.searchParams.get('project') ?? undefined;
  const latest = getMonitorRuns(id, project)?.runs.find((run) => run.status === 'done');
  if (!latest) return NextResponse.json({ error: 'No completed run for this monitor.' }, { status: 404 });
  const competitors = request.nextUrl.searchParams.get('competitors') !== 'false';
  return NextResponse.json(getRun(latest.run_id, latest.project.id, { competitors }));
}
