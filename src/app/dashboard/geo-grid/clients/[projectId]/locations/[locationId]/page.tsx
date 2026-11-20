import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import {
  getClient, getLocation, getRunsForLocation, listRunHeaders, LocationError, type LocationGroup, type RunWithPoints,
} from '@/lib/grid-locations-db';
import {
  compareKpis, computeCompetitorRows, deltaHigher, describeSchedule, formatScanDate, keywordState, locationStatus, mapsUrl, pickRunsForDay,
  scanDateOptions, sharedGridConfig, sharedSchedule, type CompetitorRow,
} from '@/lib/grid-locations';
import { radiusMiForSpacing } from '@/lib/grid-radius';
import { timeZoneForCenter } from '@/lib/grid-timezone';
import AutoRefresh from '@/components/AutoRefresh';
import Breadcrumbs from '../../../../_components/Breadcrumbs';
import StatusPill from '../../../../_components/StatusPill';
import DeltaText from '../../../../_components/DeltaText';
import MiniGrid from '../../../../_components/MiniGrid';
import RankLegend from '../../../../_components/RankLegend';
import NavSelect from '../../../../_components/NavSelect';
import { CLIENTS_URL, clientUrl, locationUrl } from '../../../../_components/routes';

export const dynamic = 'force-dynamic';

type Params = Promise<{ projectId: string; locationId: string }>;

function load(projectId: string, locationId: string) {
  try {
    const client = getClient(projectId);
    const location = getLocation(projectId, locationId);
    if (!location) notFound();
    return { client, location, headers: listRunHeaders(projectId, locationId) };
  } catch (error) {
    if (error instanceof LocationError) notFound();
    throw error;
  }
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { projectId, locationId } = await params;
  try {
    const location = getLocation(decodeURIComponent(projectId), decodeURIComponent(locationId));
    return { title: location ? `${location.name} · Geo-grid` : 'Geo-grid' };
  } catch {
    return { title: 'Geo-grid' };
  }
}

interface RivalLine {
  row: CompetitorRow;
  bySeries: Map<string, number>;
  average: number;
}

/** The leading competitor (not you) per keyword, for the gap on your row. */
type TopBySeries = Map<string, { name: string; visibility: number }>;

/** Businesses across every keyword at the location: visibility per keyword on the shown scans. */
function locationCompetitors(location: LocationGroup, current: Map<string, RunWithPoints>): { lines: RivalLine[]; top: TopBySeries } {
  const lines = new Map<string, RivalLine>();
  const top: TopBySeries = new Map();
  for (const monitor of location.monitors) {
    const run = current.get(monitor.series_id);
    if (!run) continue;
    for (const row of computeCompetitorRows(run.points)) {
      const key = row.isTarget ? 'you' : row.key;
      const line = lines.get(key) ?? { row, bySeries: new Map(), average: 0 };
      line.bySeries.set(monitor.series_id, row.visibility);
      lines.set(key, line);
      const leader = top.get(monitor.series_id);
      if (!row.isTarget && (!leader || row.visibility > leader.visibility)) top.set(monitor.series_id, { name: row.name, visibility: row.visibility });
    }
  }
  const withData = location.monitors.filter((m) => current.has(m.series_id)).length || 1;
  for (const line of lines.values()) line.average = [...line.bySeries.values()].reduce((s, v) => s + v, 0) / withData;
  return {
    lines: [...lines.values()].sort((a, b) => Number(b.row.isTarget) - Number(a.row.isTarget) || b.average - a.average),
    top,
  };
}

export default async function LocationPage({ params, searchParams }: { params: Params; searchParams: Promise<{ scan?: string }> }) {
  const raw = await params;
  const projectId = decodeURIComponent(raw.projectId);
  const locationId = decodeURIComponent(raw.locationId);
  const { scan } = await searchParams;
  const { client, location, headers } = load(projectId, locationId);

  const tz = location.monitors.find((m) => m.schedule)?.schedule?.time_zone ?? timeZoneForCenter(location.center) ?? 'America/New_York';
  const options = scanDateOptions(headers, tz);
  const day = scan && options.some((o) => o.day === scan) ? scan : null;
  const picks = pickRunsForDay(headers, day, tz);
  const wanted = [...picks.values()].flatMap((p) => [p.current?.id, p.previous?.id]).filter((id): id is string => Boolean(id));
  const runs = new Map(getRunsForLocation(projectId, locationId, wanted).map((run) => [run.id, run]));
  const current = new Map<string, RunWithPoints>();
  for (const [seriesId, pick] of picks) {
    const run = pick.current ? runs.get(pick.current.id) : undefined;
    if (run) current.set(seriesId, run);
  }

  const status = locationStatus(location.monitors);
  const grid = sharedGridConfig(location.monitors);
  const schedule = sharedSchedule(location.monitors);
  const { lines: rivals, top: topBySeries } = locationCompetitors(location, current);
  const anyListings = rivals.length > 0;
  const anyScanning = location.monitors.some((m) => m.pendingRun);
  const latestDay = options[0]?.day;

  const scanOptions = [
    { value: '', label: latestDay ? `Latest · ${formatScanDate(options[0].ts, tz)}` : 'Latest' },
    ...options.slice(1).map((o) => ({ value: o.day, label: `${o.startingPoint ? 'Starting point · ' : ''}${formatScanDate(o.ts, tz)}` })),
  ];
  if (options[0]?.startingPoint && scanOptions[0]) scanOptions[0].label = `Latest · Starting point · ${formatScanDate(options[0].ts, tz)}`;

  return (
    <div className="flex flex-col gap-4">
      {anyScanning && <AutoRefresh intervalMs={20000} />}
      <div className="flex flex-col gap-1.5">
        <Breadcrumbs items={[{ label: 'All clients', href: CLIENTS_URL }, { label: client.name, href: clientUrl(projectId) }, { label: `Location ${location.number}` }]} />
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-bold uppercase tracking-wider text-slate-600">Location {location.number}</p>
            <div className="mt-0.5 flex flex-wrap items-center gap-2">
              <h1 className="text-[28px] font-black tracking-tight">{location.name}</h1>
              <StatusPill status={status.status} label={status.label} />
            </div>
            <p className="mt-1 text-sm text-slate-600">
              <a href={mapsUrl(location.cid, location.name, location.center)} target="_blank" rel="noreferrer" className="font-semibold text-blue-600 hover:text-blue-800">
                {location.cid ? 'View on Google Maps' : 'Search on Google Maps'}
              </a>
              {' · '}{grid.mixed ? 'Mixed grids' : `${grid.gridSize}×${grid.gridSize} grid · ${grid.radiusMi} mi radius`}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className={`inline-flex min-h-10 items-center gap-2 rounded-full border px-3.5 text-[13px] font-bold ${schedule.schedule ? 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300' : 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300'}`}>
              <i className={`h-2 w-2 rounded-full ${schedule.schedule ? 'bg-emerald-600' : 'bg-amber-500'}`} aria-hidden="true" />
              {schedule.schedule ? describeSchedule(schedule.schedule) : status.status === 'one_time' ? 'One-time scan · not tracked' : 'Not scheduled'}
              {schedule.nextRunAt != null && ` · Next ${formatScanDate(schedule.nextRunAt, tz)}`}
              {(schedule.mixed || (schedule.schedule && schedule.unscheduled > 0)) && ' · Mixed'}
            </span>
          </div>
        </div>
      </div>

      {options.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <NavSelect id="location-scan" label="Showing" name="scan" value={day ?? ''} options={scanOptions} baseHref={locationUrl(projectId, locationId)} />
          <RankLegend />
        </div>
      )}

      <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(260px,1fr))]">
        {location.monitors.map((monitor) => {
          const pick = picks.get(monitor.series_id);
          const run = pick?.current ? runs.get(pick.current.id) : undefined;
          const previous = pick?.previous ? runs.get(pick.previous.id) : undefined;
          const cmp = run ? compareKpis(run.points, previous?.points ?? null) : null;
          const state = keywordState(monitor);
          const pct = monitor.pendingRun ? Math.round((monitor.pendingRun.readyPoints / Math.max(monitor.pendingRun.totalPoints, 1)) * 100) : 0;
          return (
            <article key={monitor.series_id} className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-4">
              <div className="flex items-baseline justify-between gap-2">
                <h2 className="text-[15px] font-black">{monitor.keyword}</h2>
                {cmp ? <DeltaText delta={cmp.visibility} fallback={state === 'first_scan' ? 'First scan' : ''} className="text-xs" />
                  : state === 'scanning' ? <span className="text-xs font-bold text-blue-700">Running</span> : null}
              </div>
              {run && cmp ? (
                <>
                  <MiniGrid points={run.points} gridSize={monitor.grid_size} label={`${monitor.keyword} map on ${formatScanDate(run.ts, tz)}: visibility ${cmp.current.visibility}%`} />
                  <div className="grid grid-cols-3 gap-2">
                    <span><span className="block text-[11px] font-semibold text-slate-600">Visibility</span><b className="text-lg">{cmp.current.visibility}%</b></span>
                    <span><span className="block text-[11px] font-semibold text-slate-600">Avg rank</span><b className="text-lg">{cmp.current.avgRank != null ? `#${cmp.current.avgRank}` : '—'}</b></span>
                    <span><span className="block text-[11px] font-semibold text-slate-600">Top 3</span><b className="text-lg">{cmp.current.top3}</b><span className="text-xs text-slate-500">/{cmp.current.total}</span></span>
                  </div>
                  <p className="text-xs text-slate-500">
                    {formatScanDate(run.ts, tz)}{run.pinned && ' · Starting point'}
                    {grid.mixed && ` · ${monitor.grid_size}×${monitor.grid_size} · ${radiusMiForSpacing(monitor.spacing_km, monitor.grid_size)} mi`}
                  </p>
                </>
              ) : (
                <div className="flex min-h-[180px] flex-col items-center justify-center gap-2 rounded-xl bg-slate-50 p-4 text-center text-sm text-slate-600">
                  {state === 'scanning' ? (
                    <>
                      <b className="text-slate-900">First scan running</b>
                      <span className="h-2 w-40 overflow-hidden rounded-full bg-slate-200" aria-hidden="true"><i className="block h-full bg-blue-600" style={{ width: `${pct}%` }} /></span>
                      <span>{monitor.pendingRun!.readyPoints} of {monitor.pendingRun!.totalPoints} points in</span>
                    </>
                  ) : day && monitor.doneRuns > 0 ? (
                    <span>No scan on or before this date.</span>
                  ) : monitor.schedule ? (
                    <><b className="text-slate-900">Waiting for its first scan</b><span>Next scan {formatScanDate(monitor.schedule.next_run_at, tz)}</span></>
                  ) : (
                    <><b className="text-slate-900">No scans yet</b><span>Not scheduled.</span></>
                  )}
                </div>
              )}
            </article>
          );
        })}
      </div>

      <section className="rounded-2xl border border-slate-200 bg-white p-5" aria-labelledby="loc-competitors">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="loc-competitors" className="text-[15px] font-black">Competitors across all {location.monitors.length} keywords</h2>
          <span className="text-xs text-slate-500">Who shows up most often around this location</span>
        </div>
        {anyListings ? (
          <>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[640px] text-[13px]">
                <thead>
                  <tr className="bg-slate-50 text-left text-[11px] font-bold uppercase tracking-wider text-slate-500">
                    <th scope="col" className="rounded-l-lg px-3 py-2">Business</th>
                    {location.monitors.map((m) => <th key={m.series_id} scope="col" className="px-3 py-2 normal-case">{m.keyword}</th>)}
                  </tr>
                </thead>
                <RivalRows rivals={rivals.slice(0, 11)} location={location} top={topBySeries} />
              </table>
            </div>
            {rivals.length > 11 && (
              <details className="mt-2">
                <summary className="cursor-pointer text-xs font-bold text-blue-700">Show all {rivals.length} businesses</summary>
                <div className="mt-2 overflow-x-auto">
                  <table className="w-full min-w-[640px] text-[13px]">
                    <caption className="sr-only">Remaining businesses</caption>
                    <RivalRows rivals={rivals.slice(11)} location={location} top={topBySeries} />
                  </table>
                </div>
              </details>
            )}
            <p className="mt-2.5 text-xs text-slate-500">Visibility per keyword on the scans shown above. On your row, the arrow is the gap to that keyword&apos;s top competitor, in visibility points (hover it for their name).</p>
          </>
        ) : (
          <p className="mt-3 text-sm text-slate-600">No competitor data on these scans yet. Scans imported from Semrush don&apos;t include it; it appears after the first scan run here.</p>
        )}
      </section>

      <p className="text-xs text-slate-500">Dates are clinic time ({tz}). Avg rank counts every point, with outside the top 20 as 21, like the monthly reports.</p>
      <p className="text-xs"><Link href={clientUrl(projectId)} className="font-semibold text-blue-600 hover:text-blue-800">← Back to {client.name}</Link></p>
    </div>
  );
}

function RivalRows({ rivals, location, top }: { rivals: RivalLine[]; location: LocationGroup; top: TopBySeries }) {
  return (
    <tbody>
      {rivals.map((line) => (
        <tr key={line.row.key} className={`border-t border-slate-100 ${line.row.isTarget ? 'bg-emerald-50 dark:bg-emerald-950' : ''}`}>
          <th scope="row" className="px-3 py-2.5 text-left font-bold">
            {line.row.isTarget ? `${location.name} (you)` : line.row.name}
          </th>
          {location.monitors.map((m) => {
            const value = line.bySeries.get(m.series_id);
            const leader = top.get(m.series_id);
            const gap = line.row.isTarget && value != null && leader ? deltaHigher(value, leader.visibility) : null;
            return (
              <td key={m.series_id} className="px-3 py-2.5 tabular-nums text-slate-700">
                {value != null ? `${value}%` : '—'}
                {gap && leader && (
                  <span title={`Top competitor: ${leader.name} (${leader.visibility}%)`} className="ml-2 text-xs">
                    {gap.tone === 'same'
                      ? <span className="font-bold text-slate-500">Tied</span>
                      : <DeltaText delta={gap} />}
                    <span className="sr-only">{` vs top competitor ${leader.name} at ${leader.visibility}%`}</span>
                  </span>
                )}
              </td>
            );
          })}
        </tr>
      ))}
    </tbody>
  );
}
