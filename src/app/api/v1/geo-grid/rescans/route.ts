import { NextRequest, NextResponse } from 'next/server';
import { requireApiKey } from '@/lib/api-auth';
import {
  applyRescanAction, getBudget, listExclusions, previewRescan, rescanStatus, setBudgetLimit, setExclusions, startRescan,
  validateSelector, type RescanAction, type RescanSelector,
} from '@/lib/grid-rescan';

export const dynamic = 'force-dynamic';

// Patch fork (temporary): re-scan finished Geo-grid runs in place. Built for the Nov 15 2026 wrong-city
// results; remove this route when that's done (the tables it uses are harmless). PATCH.md has the
// rollout procedure.

const MAX_RUN_ACTIONS = 25;

/**
 * GET /api/v1/geo-grid/rescans?label=&state=&manifest_id= : counts by state, one row per re-scanned run
 * and every wrong-city detection. ?unsafe=true : the "not safe to report" list instead.
 */
export async function GET(request: NextRequest) {
  const denied = requireApiKey(request);
  if (denied) return denied;
  const params = request.nextUrl.searchParams;
  return NextResponse.json(rescanStatus({
    label: params.get('label') ?? undefined,
    state: params.get('state') ?? undefined,
    manifest_id: params.get('manifest_id') ?? undefined,
    unsafe: params.get('unsafe') === 'true',
  }));
}

/**
 * POST /api/v1/geo-grid/rescans with { action, ... }:
 * - "preview" (default): { date?, run_ids?, monitor_ids?, exclude_monitor_ids?, all?, label? } lists the
 *   runs it would re-scan and the cost, and saves them as a manifest. Changes nothing else.
 * - "start": { manifest_id } re-scans exactly that manifest (max 25 runs unless it was previewed with all: true).
 * - "cancel" | "undo" | "retry": { run_ids } (max 25).
 * - "exclude" | "unexclude": { monitor_ids, reason? } edits the persistent exclude list.
 * - "budget": { limit_usd } sets the shared spend ceiling for all re-scans.
 */
export async function POST(request: NextRequest) {
  const denied = requireApiKey(request);
  if (denied) return denied;
  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
  } catch {
    return NextResponse.json({ error: 'Body must be a JSON object.' }, { status: 400 });
  }
  const action = body.action ?? 'preview';
  const bad = (error: string) => NextResponse.json({ error }, { status: 400 });
  const ids = (value: unknown) => Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === 'string' && v) ? value as string[] : null;

  switch (action) {
    case 'preview': {
      const selector: RescanSelector = {
        date: typeof body.date === 'string' ? body.date : undefined,
        run_ids: body.run_ids as string[] | undefined,
        monitor_ids: body.monitor_ids as string[] | undefined,
        exclude_monitor_ids: body.exclude_monitor_ids as string[] | undefined,
        all: body.all as boolean | undefined,
        label: typeof body.label === 'string' ? body.label : undefined,
      };
      const error = validateSelector(selector);
      if (error) return bad(error);
      return NextResponse.json(previewRescan(selector));
    }
    case 'start': {
      if (typeof body.manifest_id !== 'string' || !body.manifest_id) return bad('start needs the manifest_id from a preview.');
      const result = startRescan(body.manifest_id);
      if ('error' in result) return bad(result.error);
      return NextResponse.json({ ...result, budget: getBudget() });
    }
    case 'cancel':
    case 'undo':
    case 'retry': {
      const runIds = ids(body.run_ids);
      if (!runIds) return bad(`${action} needs run_ids.`);
      if (runIds.length > MAX_RUN_ACTIONS) return bad(`At most ${MAX_RUN_ACTIONS} run_ids per call.`);
      return NextResponse.json({ results: applyRescanAction(action as RescanAction, runIds) });
    }
    case 'exclude':
    case 'unexclude': {
      const monitorIds = ids(body.monitor_ids);
      if (!monitorIds) return bad(`${action} needs monitor_ids.`);
      setExclusions(monitorIds, typeof body.reason === 'string' ? body.reason : '', action === 'exclude');
      return NextResponse.json({ exclusions: listExclusions() });
    }
    case 'budget': {
      const limit = body.limit_usd;
      if (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 0) return bad('limit_usd must be a number >= 0.');
      setBudgetLimit(limit);
      return NextResponse.json({ budget: getBudget() });
    }
    default:
      return bad('action must be preview, start, cancel, undo, retry, exclude, unexclude or budget.');
  }
}
