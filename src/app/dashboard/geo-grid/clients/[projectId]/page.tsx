import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { getClient, listLocationsWithLatest, LocationError } from '@/lib/grid-locations-db';
import { formatScanDate, locationStatus, mapsUrl, RANK_COLORS, sharedGridConfig, sharedSchedule, summarizeKeyword, describeSchedule } from '@/lib/grid-locations';
import { timeZoneForCenter } from '@/lib/grid-timezone';
import AutoRefresh from '@/components/AutoRefresh';
import Breadcrumbs from '../../_components/Breadcrumbs';
import StatusPill from '../../_components/StatusPill';
import DeltaText from '../../_components/DeltaText';
import { CLIENTS_URL, keywordUrl, locationUrl, newLocationUrl } from '../../_components/routes';
import { BTN_PRIMARY } from '../../_components/Modal';
import { DEMO_PROJECT_ID } from '@/lib/grid-locations-db';
import { Plus } from 'lucide-react';

export const dynamic = 'force-dynamic';

type Params = Promise<{ projectId: string }>;

function load(projectId: string) {
  try {
    return { client: getClient(projectId), locations: listLocationsWithLatest(projectId) };
  } catch (error) {
    if (error instanceof LocationError) notFound();
    throw error;
  }
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { projectId } = await params;
  try {
    return { title: `${getClient(decodeURIComponent(projectId)).name} · Geo-grid` };
  } catch {
    return { title: 'Geo-grid' };
  }
}

export default async function ClientPage({ params }: { params: Params }) {
  const projectId = decodeURIComponent((await params).projectId);
  const { client, locations } = load(projectId);
  const keywordCount = locations.reduce((s, l) => s + l.monitors.length, 0);
  // Also refresh while a just-added or Run-now scan waits for the worker (about a minute).
  const anyScanning = locations.some((l) => l.monitors.some((m) => m.pendingRun || (m.schedule != null && m.schedule.next_run_at <= Date.now() + 60_000)));

  return (
    <div className="flex flex-col gap-4">
      {anyScanning && <AutoRefresh intervalMs={20000} />}
      <div className="flex flex-col gap-1.5">
        <Breadcrumbs items={[{ label: 'All clients', href: CLIENTS_URL }, { label: client.name }]} />
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-[28px] font-black tracking-tight">{client.name}</h1>
            <p className="mt-1 text-sm text-slate-600">
              {client.domain} · {locations.length} {locations.length === 1 ? 'location' : 'locations'} · {keywordCount} {keywordCount === 1 ? 'keyword' : 'keywords'} tracked
            </p>
          </div>
          {projectId !== DEMO_PROJECT_ID && locations.length > 0 && (
            <Link href={newLocationUrl(projectId)} className={BTN_PRIMARY}><Plus className="h-4 w-4" aria-hidden="true" />Add location</Link>
          )}
        </div>
      </div>

      {locations.length === 0 && (
        <section className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-slate-300 bg-white p-10 text-center">
          <p className="text-base font-black text-slate-900">No locations yet</p>
          <p className="max-w-md text-sm text-slate-600">Add each clinic location you track in Google Maps. Its first scan runs right away and becomes the starting point for reports.</p>
          {projectId !== DEMO_PROJECT_ID && (
            <Link href={newLocationUrl(projectId)} className={BTN_PRIMARY}><Plus className="h-4 w-4" aria-hidden="true" />Add the first location</Link>
          )}
        </section>
      )}

      {locations.map((location) => {
        const tz = location.monitors.find((m) => m.schedule)?.schedule?.time_zone ?? timeZoneForCenter(location.center) ?? 'America/New_York';
        const status = locationStatus(location.monitors);
        const grid = sharedGridConfig(location.monitors);
        const schedule = sharedSchedule(location.monitors);
        return (
          <section key={location.id} className="overflow-hidden rounded-2xl border border-slate-200 bg-white" aria-labelledby={`loc-${location.id}`}>
            <div className="flex flex-wrap items-center justify-between gap-2.5 border-b border-slate-100 px-5 py-4">
              <div className="min-w-0">
                <p className="text-xs font-bold uppercase tracking-wider text-slate-600">Location {location.number}</p>
                <div className="flex flex-wrap items-center gap-2">
                  <h2 id={`loc-${location.id}`} className="text-lg font-black">{location.name}</h2>
                  <StatusPill status={status.status} label={status.label} />
                </div>
                <p className="mt-1 text-sm text-slate-600">
                  <a href={mapsUrl(location.cid, location.name, location.center)} target="_blank" rel="noreferrer" className="font-semibold text-blue-600 hover:text-blue-800">
                    {location.cid ? 'View on Google Maps' : 'Search on Google Maps'}
                  </a>
                  {' · '}{grid.mixed ? 'Mixed grids' : `${grid.gridSize}×${grid.gridSize} · ${grid.radiusMi} mi`}
                  {' · '}{schedule.schedule ? describeSchedule(schedule.schedule) : status.status === 'one_time' ? 'Not tracked' : 'Not scheduled'}
                </p>
              </div>
              <Link href={locationUrl(projectId, location.id)} className="inline-flex min-h-9 items-center rounded-[10px] border border-slate-300 bg-white px-3 text-xs font-bold text-slate-900 hover:border-blue-300">
                Open location →
              </Link>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[680px] text-sm">
                <thead>
                  <tr className="bg-slate-50 text-left text-[11px] font-bold uppercase tracking-wider text-slate-500">
                    <th scope="col" className="px-5 py-2">Keyword</th>
                    <th scope="col" className="px-3 py-2">Visibility</th>
                    <th scope="col" className="px-3 py-2">Avg rank</th>
                    <th scope="col" className="px-3 py-2">Change</th>
                    <th scope="col" className="px-3 py-2">Last scan</th>
                  </tr>
                </thead>
                <tbody>
                  {location.monitors.map((monitor) => {
                    const k = summarizeKeyword(monitor);
                    const pct = k.pending ? Math.round((k.pending.readyPoints / Math.max(k.pending.totalPoints, 1)) * 100) : 0;
                    return (
                      <tr key={k.seriesId} className="border-t border-slate-100">
                        <td className="px-5 py-3">
                          <Link href={keywordUrl(projectId, location.id, k.seriesId)} className="font-bold text-blue-700 hover:text-blue-900">{k.keyword}</Link>
                          {(grid.mixed) && <span className="ml-2 text-xs text-slate-500">{k.gridSize}×{k.gridSize} · {k.radiusMi} mi</span>}
                        </td>
                        <td className="px-3 py-3">
                          {k.latest ? (
                            <span className="flex items-center gap-2">
                              <span className="h-2 w-[90px] overflow-hidden rounded-full bg-slate-200" aria-hidden="true">
                                <i className="block h-full" style={{ width: `${k.latest.kpis.visibility}%`, background: RANK_COLORS.top3 }} />
                              </span>
                              <b className="text-[13px] tabular-nums">{k.latest.kpis.visibility}%</b>
                            </span>
                          ) : k.pending ? (
                            <span className="flex items-center gap-2">
                              <span className="h-2 w-[90px] overflow-hidden rounded-full bg-slate-200" aria-hidden="true">
                                <i className="block h-full bg-blue-600" style={{ width: `${pct}%` }} />
                              </span>
                              <b className="text-[13px] tabular-nums">{pct}% done</b>
                            </span>
                          ) : <span className="text-slate-500">—</span>}
                        </td>
                        <td className="px-3 py-3 tabular-nums">{k.latest?.kpis.avgRank != null ? `#${k.latest.kpis.avgRank}` : '—'}</td>
                        <td className="px-3 py-3 text-xs">
                          {k.state === 'scanning' ? <span className="font-bold text-blue-700">Running</span>
                            : k.state === 'waiting' ? <span className="font-bold text-slate-500">{k.scheduled ? 'Queued' : 'Not scheduled'}</span>
                              : !k.scheduled ? <span className="font-bold text-slate-500">One-time</span>
                              : k.state === 'first_scan' ? <span className="font-bold text-slate-500">First scan</span>
                                : <DeltaText delta={k.visibilityDelta} fallback="—" />}
                        </td>
                        <td className="px-3 py-3 text-xs text-slate-600">
                          {k.latest ? formatScanDate(k.latest.ts, tz) : k.pending ? 'Running now' : monitor.schedule ? `Next ${formatScanDate(monitor.schedule.next_run_at, tz)}` : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}
      <p className="text-xs text-slate-500">Change is visibility points since the previous scan. Avg rank counts every point, with outside the top 20 as 21, like the monthly reports.</p>
    </div>
  );
}
