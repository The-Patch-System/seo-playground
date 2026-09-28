import { NextRequest, NextResponse } from 'next/server';
import { getActiveProject, getCredentials, getGridEntry } from '@/lib/db';
import { collectGridProgress } from '@/lib/grid-progress';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const entry = getGridEntry(id);
  if (!entry) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const total = entry.grid_size ** 2;
  if (entry.status === 'done') return NextResponse.json({ status: 'done', ready: total, total });

  const credentials = getCredentials();
  if (!credentials) return NextResponse.json({ error: 'No credentials' }, { status: 401 });

  const progress = await collectGridProgress(getActiveProject().id, entry, credentials);
  return NextResponse.json(progress);
}
