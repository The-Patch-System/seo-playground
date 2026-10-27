import { NextRequest, NextResponse } from 'next/server';
import { requireApiKey } from '@/lib/api-auth';
import { getRun } from '@/lib/grid-report';
import { pinGridRunForProject, setGridRunPinnedForProject } from '@/lib/db';

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

/**
 * Patch fork: PATCH /api/v1/geo-grid/runs/{run_id} with { "pinned": true } makes this run the
 * monitor's starting-point map (any other pinned run in the monitor is unpinned);
 * { "pinned": false } unpins it. Used by the reporting agent to keep its starting map and
 * Playground's in sync.
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = requireApiKey(request);
  if (denied) return denied;
  const { id } = await params;
  let body: { pinned?: unknown };
  try {
    body = await request.json() as { pinned?: unknown };
  } catch {
    return NextResponse.json({ error: 'Body must be JSON.' }, { status: 400 });
  }
  if (typeof body.pinned !== 'boolean') return NextResponse.json({ error: 'pinned must be true or false.' }, { status: 400 });
  const run = getRun(id, request.nextUrl.searchParams.get('project') ?? undefined, { points: false });
  if (!run) return NextResponse.json({ error: 'Run not found.' }, { status: 404 });
  const projectId = run.project.id;
  const ok = body.pinned ? pinGridRunForProject(projectId, id) : setGridRunPinnedForProject(projectId, id, false);
  if (!ok) return NextResponse.json({ error: 'Run not found.' }, { status: 404 });
  return NextResponse.json(getRun(id, projectId, { points: false }));
}
