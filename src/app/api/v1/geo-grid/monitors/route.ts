import { NextRequest, NextResponse } from 'next/server';
import { requireApiKey } from '@/lib/api-auth';
import { listMonitors } from '@/lib/grid-report';
import { createMonitor, MonitorInputError, type CreateMonitorInput } from '@/lib/grid-import';

export const dynamic = 'force-dynamic';

/** GET /api/v1/geo-grid/monitors?q=&cid=&project= : every monitor with its latest completed run summary. */
export async function GET(request: NextRequest) {
  const denied = requireApiKey(request);
  if (denied) return denied;
  const params = request.nextUrl.searchParams;
  const monitors = listMonitors({ q: params.get('q') ?? undefined, cid: params.get('cid') ?? undefined, project: params.get('project') ?? undefined });
  return NextResponse.json({ monitors });
}

/**
 * Patch fork: POST /api/v1/geo-grid/monitors creates a monitor without running a scan:
 * it saves the monthly schedule (noon, clinic time, 15th by default) and imports any past
 * runs given in `runs[]` (e.g. copied from Semrush MRT). Safe to repeat for the same location.
 */
export async function POST(request: NextRequest) {
  const denied = requireApiKey(request);
  if (denied) return denied;
  let body: CreateMonitorInput;
  try {
    body = await request.json() as CreateMonitorInput;
  } catch {
    return NextResponse.json({ error: 'Body must be JSON.' }, { status: 400 });
  }
  try {
    return NextResponse.json(createMonitor(body), { status: 201 });
  } catch (error) {
    if (error instanceof MonitorInputError) return NextResponse.json({ error: error.message }, { status: 400 });
    throw error;
  }
}
