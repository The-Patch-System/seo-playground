import { NextRequest, NextResponse } from 'next/server';
import { requireApiKey } from '@/lib/api-auth';
import { deleteGridSeriesForProject, getProjects } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * Patch fork: DELETE /api/v1/geo-grid/monitors/{monitor_id} removes a monitor (every snapshot
 * and its schedule) from every project, or only `?project=` when given. Used to clean up imports.
 */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = requireApiKey(request);
  if (denied) return denied;
  const { id } = await params;
  const only = request.nextUrl.searchParams.get('project');
  let removed = 0;
  for (const project of getProjects()) {
    if (only && only !== project.id) continue;
    removed += deleteGridSeriesForProject(project.id, id);
  }
  if (!removed) return NextResponse.json({ error: 'Monitor not found.' }, { status: 404 });
  return NextResponse.json({ monitor_id: id, deleted: true });
}
