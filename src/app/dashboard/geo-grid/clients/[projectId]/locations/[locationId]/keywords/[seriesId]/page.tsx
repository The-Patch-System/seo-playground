import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import {
  getClient, getKeywordData, getRunsForLocation, LocationError, type KeywordData, type RunWithPoints,
} from '@/lib/grid-locations-db';
import {
  clinicTimeZone, compareKpis, competitorPoints, computeCompetitorRows, computeRings, deltaHigher, describeSchedule, formatScanDate,
  formatScanDateTime, mapsUrl, pointMoves, rankColor, rankLabel, resolveCompare, trendBars, RANK_COLORS,
  type CompareMode, type CompetitorRow, type Delta, type KpiComparison, type PointMove,
} from '@/lib/grid-locations';
import { addressLabel, getListingAddress } from '@/lib/grid-addresses';
import { radiusMiForSpacing } from '@/lib/grid-radius';
import { timeZoneForCenter } from '@/lib/grid-timezone';
import { generateGridCoords } from '@/app/dashboard/local-finder/grid-api';
import AutoRefresh from '@/components/AutoRefresh';
import Breadcrumbs from '../../../../../../_components/Breadcrumbs';
import DeltaText from '../../../../../../_components/DeltaText';
import RankLegend from '../../../../../../_components/RankLegend';
import NavSelect from '../../../../../../_components/NavSelect';
import KeywordSwitcher from '../../../../../../_components/KeywordSwitcher';
import { KeywordSettingsButton, RunNowButton } from '../../../../../../_components/Actions';
import { keywordSettingsProps } from '../../../../../../_components/settings-props';
import KeywordMap, { type MapPin } from '../../../../../../_components/KeywordMap';
import { CLIENTS_URL, clientUrl, keywordUrl, locationUrl } from '../../../../../../_components/routes';

export const dynamic = 'force-dynamic';

type Params = Promise<{ projectId: string; locationId: string; seriesId: string }>;
type Search = Promise<{ scan?: string; cmp?: string; vs?: string; competitor?: string }>;

const COMPARE_MODES: CompareMode[] = ['previous', 'last_year', 'specific'];
const TOP_COMPETITORS = 10;

function decode(raw: Awaited<Params>) {
  return { projectId: decodeURIComponent(raw.projectId), locationId: decodeURIComponent(raw.locationId), seriesId: decodeURIComponent(raw.seriesId) };
}

function load(projectId: string, locationId: string, seriesId: string, extra: string[]): { client: ReturnType<typeof getClient>; data: KeywordData } {
  try {
    return { client: getClient(projectId), data: getKeywordData(projectId, locationId, seriesId, extra) };
  } catch (error) {
    if (error instanceof LocationError) notFound();
    throw error;
  }
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { projectId, locationId, seriesId } = decode(await params);
  try {
    const { monitor, location } = getKeywordData(projectId, locationId, seriesId);
    return { title: `${monitor.keyword} · ${location.name} · Geo-grid` };
  } catch {
    return { title: 'Geo-grid' };
  }
}

/** Dark text on the yellow 4-10 pins, white on the rest. */
function pinText(color: string) {
  return color === RANK_COLORS.top10 ? '#422006' : '#ffffff';
}

const MOVE_COLORS = { better: '#047857', worse: '#b91c1c', same: '#64748b', none: '#64748b' } as const;

/** Competitors moving up is bad news for the client, so their change reads red. */
function rivalDelta(delta: Delta): Delta {
  if (delta.tone === 'better') return { ...delta, tone: 'worse' };
  if (delta.tone === 'worse') return { ...delta, tone: 'better' };
  return delta;
}

function monthShort(ts: number, timeZone: string) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { month: 'short', year: '2-digit', timeZone }).formatToParts(new Date(ts));
    return `${parts.find((p) => p.type === 'month')?.value} '${parts.find((p) => p.type === 'year')?.value}`;
  } catch {
    return '';
  }
}

export default async function KeywordPage({ params, searchParams }: { params: Params; searchParams: Search }) {
  const { projectId, locationId, seriesId } = decode(await params);
  const search = await searchParams;
  const requested = [search.scan, search.vs].filter((id): id is string => Boolean(id));
  const { client, data } = load(projectId, locationId, seriesId, requested);
  const { location, monitor, headers } = data;
  const tz = clinicTimeZone(monitor, timeZoneForCenter(monitor.center) ?? 'America/New_York');
  const baseHref = keywordUrl(projectId, locationId, seriesId);

  const done = headers.filter((h) => h.status === 'done');
  const runsById = new Map<string, RunWithPoints>(data.runs.map((run) => [run.id, run]));
  const selectedId = search.scan && runsById.has(search.scan) ? search.scan : done[0]?.id ?? null;
  const selected = selectedId ? runsById.get(selectedId) ?? null : null;
  const isLatest = Boolean(selected && selected.id === done[0]?.id);

  const mode = COMPARE_MODES.includes(search.cmp as CompareMode) ? search.cmp as CompareMode : 'previous';
  const choice = selected ? resolveCompare(headers, selected.id, mode, search.vs ?? null, tz) : null;
  let compareRun: RunWithPoints | null = null;
  if (choice?.runId) {
    compareRun = runsById.get(choice.runId) ?? getRunsForLocation(projectId, locationId, [choice.runId])[0] ?? null;
  }

  // Competitor view: their ranks on the grid instead of yours.
  const ownRows = selected ? computeCompetitorRows(selected.points) : [];
  const viewing = search.competitor ? ownRows.find((row) => row.key === search.competitor && !row.isTarget) ?? null : null;
  const shownPoints = selected ? (viewing ? competitorPoints(selected.points, viewing.key) : selected.points) : [];

  const kpis: KpiComparison | null = selected ? compareKpis(selected.points, compareRun?.points ?? null) : null;
  const moves: Map<string, PointMove> = selected && !viewing ? pointMoves(selected.points, compareRun?.points ?? null) : new Map();

  const [lat, lng] = monitor.center.split(',').map(Number);
  const coords = new Map(generateGridCoords(lat, lng, monitor.grid_size, monitor.spacing_km).map((c) => [`${c.row}:${c.col}`, c]));
  const half = Math.floor(monitor.grid_size / 2);
  const pins: MapPin[] = shownPoints.flatMap((point) => {
    const c = point.lat != null && point.lng != null ? { lat: point.lat, lng: point.lng } : coords.get(`${point.row}:${point.col}`);
    if (!c) return [];
    const color = rankColor(point);
    const move = moves.get(`${point.row}:${point.col}`);
    return [{
      row: point.row, col: point.col, lat: c.lat, lng: c.lng, label: rankLabel(point), color, fg: pinText(color),
      isCenter: point.row === half && point.col === half, move: move?.label ?? '', moveColor: MOVE_COLORS[move?.tone ?? 'none'],
    }];
  });

  const compareRows = compareRun ? computeCompetitorRows(compareRun.points) : [];
  const compareByKey = new Map(compareRows.map((row) => [row.isTarget ? 'you' : row.key, row]));
  const you = ownRows.find((row) => row.isTarget) ?? null;
  const rivals = ownRows.filter((row) => !row.isTarget);
  const rings = selected ? computeRings(selected.points, monitor.grid_size, monitor.spacing_km) : [];
  const bars = trendBars(data.runs.filter((run) => run.status === 'done'));
  const pending = monitor.pendingRun;
  // A scan that is due (just added, or Run now) is claimed by the worker within about a minute.
  const startingSoon = !pending && monitor.schedule != null && monitor.schedule.next_run_at <= Date.now() + 60_000;
  // Due for 5+ minutes with nothing running: the worker isn't picking it up, so don't pretend it's starting.
  const overdue = startingSoon && monitor.schedule!.next_run_at < Date.now() - 5 * 60_000;
  const radiusMi = radiusMiForSpacing(monitor.spacing_km, monitor.grid_size);
  const total = selected?.points.length ?? monitor.grid_size ** 2;

  const hrefWith = (next: Record<string, string | null>) => {
    const query = new URLSearchParams();
    const merged = { scan: search.scan ?? null, cmp: search.cmp ?? null, vs: search.vs ?? null, competitor: search.competitor ?? null, ...next };
    for (const [key, value] of Object.entries(merged)) if (value) query.set(key, value);
    const qs = query.toString();
    return qs ? `${baseHref}?${qs}` : baseHref;
  };
  const keepParams = (omit: string[]) => Object.fromEntries(
    Object.entries({ scan: search.scan, cmp: search.cmp, vs: search.vs, competitor: search.competitor })
      .filter(([key, value]) => value && !omit.includes(key)) as Array<[string, string]>,
  );

  const selectedIndex = selected ? done.findIndex((h) => h.id === selected.id) : -1;
  const olderId = selectedIndex >= 0 ? done[selectedIndex + 1]?.id : undefined;
  const newerId = selectedIndex > 0 ? done[selectedIndex - 1]?.id : undefined;
  const scanLabel = (id: string, ts: number, pinned: boolean, index: number) =>
    `${index === 0 ? 'Latest · ' : ''}${formatScanDateTime(ts, tz)}${pinned ? ' · Starting point' : ''}${runsById.get(id) ? ` · ${compareKpis(runsById.get(id)!.points, null).current.visibility}%` : ''}`;
  const previousHeader = selected ? done.find((h) => h.ts < selected.ts) : undefined;
  const lastYearHeader = choice?.lastYearAvailable && choice.mode === 'last_year' && compareRun ? compareRun : null;
  const olderScans = selected ? done.filter((h) => h.ts < selected.ts) : [];

  return (
    <div className="flex flex-col gap-4">
      {(pending || startingSoon) && <AutoRefresh intervalMs={20000} />}

      <div className="flex flex-col gap-1.5">
        <Breadcrumbs items={[
          { label: 'All clients', href: CLIENTS_URL },
          { label: client.name, href: clientUrl(projectId) },
          { label: `Location ${location.number}`, href: locationUrl(projectId, locationId) },
          { label: monitor.keyword },
        ]} />
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2.5">
              {location.monitors.length > 1 ? (
                <KeywordSwitcher
                  current={monitor.keyword}
                  heading={`Keywords at Location ${location.number}`}
                  options={location.monitors.map((m) => ({
                    href: keywordUrl(projectId, locationId, m.series_id), label: m.keyword, current: m.series_id === monitor.series_id,
                  }))}
                />
              ) : (
                <h1 className="text-[26px] font-black tracking-tight">{monitor.keyword}</h1>
              )}
              {selected?.pinned && <span className="rounded-full bg-violet-100 px-2.5 py-0.5 text-xs font-bold text-violet-700">Starting-point map</span>}
            </div>
            <p className="mt-1 text-sm text-slate-600">
              {location.name} · {addressLabel(getListingAddress(location.cid), Boolean(location.cid))}
            </p>
            <p className="mt-0.5 text-sm text-slate-600">
              {monitor.grid_size}×{monitor.grid_size} grid · {radiusMi} mi radius ·{' '}
              <a href={mapsUrl(location.cid, location.name, location.center)} target="_blank" rel="noreferrer" className="font-bold text-blue-600 hover:text-blue-800">
                {location.cid ? 'View on Google Maps ↗' : 'Search on Google Maps ↗'}
              </a>
            </p>
          </div>
          <span className={`inline-flex min-h-10 items-center gap-2 rounded-full border px-3.5 text-[13px] font-bold ${
            overdue ? 'border-amber-200 bg-amber-50 text-amber-800' : pending || startingSoon ? 'border-blue-200 bg-blue-50 text-blue-800' : monitor.schedule ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-slate-200 bg-slate-100 text-slate-700'}`}>
            <i className={`h-2 w-2 rounded-full ${overdue ? 'bg-amber-500' : pending || startingSoon ? 'bg-blue-600' : monitor.schedule ? 'bg-emerald-600' : 'bg-slate-400'}`} aria-hidden="true" />
            {pending
              ? `${done.length ? 'Scan' : 'First scan'} running · ${pending.readyPoints}/${pending.totalPoints} points`
              : overdue
                ? `${done.length ? 'Scan' : 'First scan'} hasn't started yet`
                : startingSoon
                ? `${done.length ? 'Scan' : 'First scan'} starting within a minute`
                : monitor.schedule
                ? `${describeSchedule(monitor.schedule)} · Next ${formatScanDate(monitor.schedule.next_run_at, tz)}`
                : 'One-time scan · not tracked'}
          </span>
          <div className="flex flex-wrap items-center gap-2">
            {monitor.schedule && <RunNowButton projectId={projectId} locationId={locationId} seriesId={monitor.series_id} label="Run now" />}
            <KeywordSettingsButton {...keywordSettingsProps(projectId, location, monitor)} />
          </div>
        </div>
      </div>

      <section className="rounded-2xl border border-slate-200 bg-white p-5" aria-label="Scan results">
        {!selected ? (
          pending ? (
            <div className="flex flex-col gap-2.5">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-base font-black">First scan running</p>
                <p className="text-[13px] text-slate-600">{pending.readyPoints} of {pending.totalPoints} points checked · started {formatScanDateTime(pending.ts, tz)} clinic time</p>
              </div>
              <div className="h-2.5 overflow-hidden rounded-full bg-slate-200" aria-hidden="true">
                <i className="block h-full bg-blue-600" style={{ width: `${Math.round((pending.readyPoints / Math.max(pending.totalPoints, 1)) * 100)}%` }} />
              </div>
              <p className="text-xs text-slate-500">This page refreshes by itself. Results, competitors and rings appear when the scan finishes.</p>
            </div>
          ) : (
            <div className="text-sm text-slate-600">
              <p className="font-black text-slate-900">No scans yet</p>
              <p className="mt-1">
                {overdue
                  ? `The first scan was due at ${formatScanDateTime(monitor.schedule!.next_run_at, tz)} clinic time and hasn't started. Scans usually start within a minute, so the scan worker may be down: tell Trazon if this doesn't change in a few minutes.`
                  : startingSoon
                  ? 'The first scan starts within a minute, then a progress bar shows here while it runs (usually 5–10 minutes). This page refreshes by itself.'
                  : monitor.schedule ? `The first scan runs ${formatScanDateTime(monitor.schedule.next_run_at, tz)} clinic time.` : 'This keyword is not scheduled.'}
              </p>
            </div>
          )
        ) : (
          <>
            {pending && <p className="mb-3 rounded-xl border border-blue-200 bg-blue-50 px-3 py-2 text-[13px] text-blue-900">A new scan is running ({pending.readyPoints}/{pending.totalPoints} points). This page refreshes by itself.</p>}
            {kpis && <KpiRow kpis={kpis} total={total} />}

            {done.length > 1 ? (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <NavSelect
                  id="compare-mode"
                  label="Compare to"
                  name="cmp"
                  value={choice?.mode === 'previous' && mode !== 'specific' ? '' : mode}
                  baseHref={baseHref}
                  extraParams={keepParams(['cmp', 'vs'])}
                  options={[
                    { value: '', label: previousHeader ? `Previous scan · ${formatScanDate(previousHeader.ts, tz)}` : 'Previous scan · none' },
                    { value: 'last_year', label: choice?.lastYearAvailable ? `Same month last year${lastYearHeader ? ` · ${formatScanDate(lastYearHeader.ts, tz)}` : ''}` : 'Same month last year · no scan yet', disabled: !choice?.lastYearAvailable },
                    { value: 'specific', label: 'A specific scan…' },
                  ]}
                />
                {mode === 'specific' && olderScans.length > 0 && (
                  <NavSelect
                    id="compare-scan"
                    label="Scan"
                    name="vs"
                    value={choice?.mode === 'specific' ? choice.runId ?? '' : ''}
                    baseHref={baseHref}
                    extraParams={keepParams(['vs'])}
                    options={[{ value: '', label: 'Pick a scan…' }, ...olderScans.map((h) => ({ value: h.id, label: `${formatScanDate(h.ts, tz)}${h.pinned ? ' · Starting point' : ''}` }))]}
                  />
                )}
                {choice?.note && <span className="text-xs text-slate-500">{choice.note}</span>}
              </div>
            ) : (
              <p className="mt-2.5 text-xs text-slate-500">
                First scan for this keyword.{monitor.schedule ? ` Changes show from the next scan on ${formatScanDate(monitor.schedule.next_run_at, tz)}.` : ''}
              </p>
            )}

            <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-4">
              {done.length > 1 ? (
                <>
                  <ScanStep href={olderId ? hrefWith({ scan: olderId, vs: null, competitor: null }) : null} label="Older scan">‹</ScanStep>
                  <NavSelect
                    id="scan"
                    label="Scan"
                    name="scan"
                    value={isLatest ? '' : selected.id}
                    baseHref={baseHref}
                    extraParams={keepParams(['scan', 'vs', 'competitor'])}
                    options={done.map((h, i) => ({ value: i === 0 ? '' : h.id, label: scanLabel(h.id, h.ts, h.pinned, i) }))}
                  />
                  <ScanStep href={newerId ? hrefWith({ scan: newerId === done[0].id ? null : newerId, vs: null, competitor: null }) : null} label="Newer scan">›</ScanStep>
                  <span className="text-xs text-slate-500">{done.length} scans</span>
                </>
              ) : (
                <span className="text-xs font-semibold text-slate-600">Scan</span>
              )}
              {done.length <= 1 && (
                <span className="inline-flex min-h-9 items-center rounded-[10px] bg-slate-900 px-3 text-[13px] font-bold text-white">{formatScanDate(selected.ts, tz)} · only scan so far</span>
              )}
            </div>

            {!isLatest && (
              <div className="mt-3 flex flex-wrap justify-between gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-[13px] text-amber-900">
                <span>You&apos;re viewing an older scan: <b>{formatScanDateTime(selected.ts, tz)}</b>. Every number on this page follows it.</span>
                <Link href={hrefWith({ scan: null, vs: null, competitor: null })} className="font-bold text-amber-800">Back to latest →</Link>
              </div>
            )}
            {viewing && (
              <div className="mt-3 flex flex-wrap justify-between gap-2 rounded-xl border border-blue-200 bg-blue-50 px-3 py-2.5 text-[13px] text-blue-900">
                <span>Showing <b>{viewing.name}</b>&apos;s ranks on the grid</span>
                <Link href={hrefWith({ competitor: null })} className="font-bold text-blue-700">← Back to your ranks</Link>
              </div>
            )}

            <div className="mt-3">
              <KeywordMap
                pins={pins}
                gridSize={monitor.grid_size}
                label={`${viewing ? `${viewing.name}'s` : 'Your'} ranks for ${monitor.keyword} on ${formatScanDate(selected.ts, tz)}`}
              />
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5">
              <RankLegend />
              <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-600"><i className="h-3 w-3 rounded-[3px] border-2 border-dashed border-slate-500" aria-hidden="true" />Center</span>
              {moves.size > 0 && <span className="text-xs text-slate-500">Small labels: places gained (+) or lost (−) since the compared scan.</span>}
            </div>
          </>
        )}
      </section>

      <details open className="rounded-2xl border border-slate-200 bg-white">
        <summary className="flex cursor-pointer list-none items-baseline justify-between gap-3 px-5 py-4">
          <span className="flex items-baseline gap-2"><span className="text-[15px] font-black">Competitors</span>
            <span className="text-xs text-slate-500">{rivals.length ? `${rivals.length} businesses in the top 20 on this scan` : selected ? 'none on this scan' : 'after the first scan'}</span></span>
          <span className="text-slate-500" aria-hidden="true">▾</span>
        </summary>
        <div className="border-t border-slate-100 px-5 pb-5 pt-4">
          {rivals.length > 0 || you ? (
            <>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[900px] table-fixed text-[13px]">
                      <CompetitorCols />
                  <thead>
                    <tr className="text-left text-[11px] font-bold uppercase tracking-wider text-slate-500">
                      <th scope="col" className="px-3 pb-1">#</th>
                      <th scope="col" className="px-3 pb-1">Business</th>
                      <th scope="col" className="px-3 pb-1">Reviews</th>
                      <th scope="col" className="px-3 pb-1">Visibility</th>
                      <th scope="col" className="px-3 pb-1" title="Average rank where the business shows in the top 20">Avg rank</th>
                      <th scope="col" className="px-3 pb-1">In top 20</th>
                      <th scope="col" className="px-3 pb-1">Change</th>
                      <th scope="col" className="px-3 pb-1"><span className="sr-only">Actions</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {you && <CompetitorTr row={you} label="You" name={location.name} total={total} change={compareRun ? deltaHigher(you.visibility, compareByKey.get('you')?.visibility) : null} />}
                    {rivals.slice(0, TOP_COMPETITORS).map((row, i) => (
                      <CompetitorTr key={row.key} row={row} label={`#${i + 1}`} total={total} highlighted={viewing?.key === row.key}
                        change={compareRun ? rivalDelta(deltaHigher(row.visibility, compareByKey.get(row.key)?.visibility ?? 0)) : null}
                        viewHref={hrefWith({ competitor: row.key })} />
                    ))}
                  </tbody>
                </table>
              </div>
              {rivals.length > TOP_COMPETITORS && (
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs font-bold text-blue-700">Show all {rivals.length} businesses</summary>
                  <div className="mt-2 overflow-x-auto">
                    <table className="w-full min-w-[900px] table-fixed text-[13px]">
                      <CompetitorCols />
                      <caption className="sr-only">Remaining businesses</caption>
                      <tbody>
                        {rivals.slice(TOP_COMPETITORS).map((row, i) => (
                          <CompetitorTr key={row.key} row={row} label={`#${i + 1 + TOP_COMPETITORS}`} total={total} highlighted={viewing?.key === row.key}
                            change={compareRun ? rivalDelta(deltaHigher(row.visibility, compareByKey.get(row.key)?.visibility ?? 0)) : null}
                            viewHref={hrefWith({ competitor: row.key })} />
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              )}
              <p className="mt-3 text-xs leading-relaxed text-slate-500">
                Avg rank here is where each business shows in the top 20, so yours can differ from the Avg rank above (which counts every point, like the monthly reports).
                A competitor&apos;s change in red means they gained visibility. Categories and the &quot;runs ads here&quot; flag aren&apos;t stored yet.
              </p>
            </>
          ) : (
            <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-3.5 text-[13px] leading-relaxed text-slate-700">
              {pending && !selected ? (
                <><b>Competitors appear when the scan finishes.</b> Every point records the full top 20, so this fills in automatically.</>
              ) : selected ? (
                <><b>Competitors appear after the first scan run here.</b> This scan was imported from Semrush, which only kept your own rank at each point.
                  {monitor.schedule ? ` The next scan runs ${formatScanDate(monitor.schedule.next_run_at, tz)}.` : ''}</>
              ) : (
                <><b>No scans yet.</b></>
              )}
            </div>
          )}
        </div>
      </details>

      <details className="rounded-2xl border border-slate-200 bg-white">
        <summary className="flex cursor-pointer list-none items-baseline justify-between gap-3 px-5 py-4">
          <span className="flex items-baseline gap-2"><span className="text-[15px] font-black">Visibility by distance</span>
            <span className="text-xs text-slate-500">{rings.length ? 'from the center out' : 'appears after a scan'}</span></span>
          <span className="text-slate-500" aria-hidden="true">▾</span>
        </summary>
        <div className="flex flex-col gap-2.5 border-t border-slate-100 px-5 pb-5 pt-4">
          {rings.map((ring) => (
            <div key={ring.ring} className="grid grid-cols-[90px_minmax(0,1fr)_170px] items-center gap-3 text-[13px]">
              <span className="font-bold">{ring.ring === 0 ? 'Center' : `~${ring.miles} mi`}</span>
              <span className="h-2.5 overflow-hidden rounded-full bg-slate-100" aria-hidden="true">
                <i className="block h-full" style={{ width: `${ring.avgRank == null ? 4 : Math.max(12, Math.round(100 - (ring.avgRank - 1) * 6.5))}%`, background: rankColor(ring.avgRank == null ? { rank: null } : { rank: Math.round(ring.avgRank) }) }} />
              </span>
              <span className="tabular-nums text-slate-600">{ring.avgRank != null ? `avg #${ring.avgRank}` : 'not found'} · {ring.inTop20}/{ring.points} pts</span>
            </div>
          ))}
          {rings.length > 0 && <p className="text-xs text-slate-500">Longer, greener bars mean a better average rank at that distance (where found in the top 20). Points with no data are left out.</p>}
        </div>
      </details>

      <details open className="rounded-2xl border border-slate-200 bg-white">
        <summary className="flex cursor-pointer list-none items-baseline justify-between gap-3 px-5 py-4">
          <span className="flex items-baseline gap-2"><span className="text-[15px] font-black">Position over time</span>
            <span className="text-xs text-slate-500">
              {bars.length > 1 ? `${bars.length} scans · ${formatScanDate(bars[0].ts, tz)} – ${formatScanDate(bars[bars.length - 1].ts, tz)}` : bars.length === 1 ? '1 scan' : 'not yet'}
            </span></span>
          <span className="text-slate-500" aria-hidden="true">▾</span>
        </summary>
        <div className="border-t border-slate-100 px-5 pb-5 pt-4">
          {bars.length > 1 ? (
            <>
              <div className="overflow-x-auto">
                <div className="grid h-[200px] min-w-[640px] items-end gap-2 border-b border-slate-300" style={{ gridTemplateColumns: `repeat(${bars.length}, minmax(0, 1fr))` }}>
                  {bars.map((bar) => (
                    <Link
                      key={bar.runId}
                      href={hrefWith({ scan: bar.runId === done[0]?.id ? null : bar.runId, vs: null, competitor: null })}
                      title={`${formatScanDate(bar.ts, tz)}: ${bar.top3} in top 3, ${bar.top4to10} at 4-10, ${bar.top11to20} at 11-20, ${bar.rest} outside top 20 or no data`}
                      className={`flex h-full flex-col-reverse rounded ${bar.runId === selected?.id ? 'outline outline-2 outline-offset-2 outline-slate-900' : ''}`}
                    >
                      {([['top3', RANK_COLORS.top3], ['top4to10', RANK_COLORS.top10], ['top11to20', RANK_COLORS.top20], ['rest', RANK_COLORS.out]] as const).map(([key, color]) => (
                        <i key={key} className="block" style={{ height: `${bar.total ? (bar[key] / bar.total) * 100 : 0}%`, background: color }} />
                      ))}
                    </Link>
                  ))}
                </div>
                <div className="mt-1.5 grid min-w-[640px] gap-2" style={{ gridTemplateColumns: `repeat(${bars.length}, minmax(0, 1fr))` }}>
                  {bars.map((bar, i) => (
                    <span key={bar.runId} className="whitespace-nowrap text-center text-[11px] text-slate-600">
                      {i === 0 || i === bars.length - 1 || i % 3 === 2 ? monthShort(bar.ts, tz) : ''}{bar.pinned ? ' ★' : ''}
                    </span>
                  ))}
                </div>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1">
                <RankLegend />
                <span className="text-xs text-slate-500">Click a bar to open that scan. ★ = starting-point map.</span>
              </div>
            </>
          ) : (
            <p className="text-[13px] text-slate-600">
              {bars.length === 1
                ? `The trend starts after the second scan${monitor.schedule ? ` (${formatScanDate(monitor.schedule.next_run_at, tz)})` : ''}.${bars[0].pinned ? ' This first scan is pinned as the starting-point map, so reports always compare back to it.' : ''}`
                : 'Appears after the second scan.'}
            </p>
          )}
        </div>
      </details>

      <p className="text-xs text-slate-500">Dates are clinic time ({tz}). Avg rank above counts every point, with outside the top 20 as 21, like the monthly reports.</p>
      <p className="text-xs"><Link href={locationUrl(projectId, locationId)} className="font-semibold text-blue-600 hover:text-blue-800">← Back to Location {location.number}</Link></p>
    </div>
  );
}

function KpiRow({ kpis, total }: { kpis: KpiComparison; total: number }) {
  const k = kpis.current;
  const items: Array<{ label: string; value: string; of?: string; delta: Delta }> = [
    { label: 'Visibility', value: `${k.visibility}%`, delta: kpis.visibility },
    { label: 'Avg rank', value: k.avgRank != null ? `#${k.avgRank}` : '—', delta: kpis.avgRank },
    { label: 'Top 3', value: String(k.top3), of: `/${total}`, delta: kpis.top3 },
    { label: 'Top 10', value: String(k.top10), of: `/${total}`, delta: kpis.top10 },
    { label: 'In top 20', value: String(k.inTop20), of: `/${total}`, delta: kpis.inTop20 },
  ];
  return (
    <dl className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(150px,1fr))]">
      {items.map((item) => (
        <div key={item.label}>
          <dt className="text-xs font-semibold text-slate-600">{item.label}</dt>
          <dd className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="text-[26px] font-black tabular-nums">{item.value}{item.of && <span className="text-sm font-bold text-slate-500">{item.of}</span>}</span>
            <DeltaText delta={item.delta} className="text-xs" />
          </dd>
        </div>
      ))}
      {k.noData > 0 && <p className="col-span-full text-xs text-slate-500">{k.noData} point{k.noData === 1 ? '' : 's'} had no usable data on this scan (shown as —).</p>}
    </dl>
  );
}

/** Same column widths on the top-10 table and the "Show all" table, so they line up. */
function CompetitorCols() {
  return (
    <colgroup>
      <col className="w-[52px]" /><col /><col className="w-[170px]" /><col className="w-[150px]" />
      <col className="w-[80px]" /><col className="w-[90px]" /><col className="w-[100px]" /><col className="w-[130px]" />
    </colgroup>
  );
}

function ScanStep({ href, label, children }: { href: string | null; label: string; children: React.ReactNode }) {
  const cls = 'grid h-9 w-9 place-items-center rounded-[10px] border border-slate-300 bg-white text-base font-bold text-slate-700';
  return href
    ? <Link href={href} aria-label={label} scroll={false} className={`${cls} hover:bg-slate-50`}>{children}</Link>
    : <span aria-label={label} aria-disabled="true" className={`${cls} opacity-40`}>{children}</span>;
}

function CompetitorTr({ row, label, name, total, change, viewHref, highlighted = false }: {
  row: CompetitorRow; label: string; name?: string; total: number; change: Delta | null; viewHref?: string; highlighted?: boolean;
}) {
  const isYou = row.isTarget;
  const site = row.domain ? row.domain.replace(/^www\./, '') : null;
  return (
    <tr className={`border-t-4 border-white ${isYou ? 'bg-emerald-50' : highlighted ? 'bg-blue-50' : 'bg-slate-50'}`}>
      <td className={`rounded-l-xl px-3 py-2.5 text-xs font-black ${isYou ? 'text-emerald-700' : 'text-slate-500'}`}>{label}</td>
      <th scope="row" className="px-3 py-2.5 text-left">
        <span className="block text-sm font-extrabold">{name ?? row.name}</span>
        {!isYou && (
          <span className="mt-0.5 flex flex-wrap gap-x-2.5 text-xs font-bold">
            <a href={mapsUrl(row.cid, row.name)} target="_blank" rel="noreferrer" className="text-blue-600 hover:text-blue-800">Google Maps ↗</a>
            {site && <a href={`https://${site}`} target="_blank" rel="noreferrer" className="text-blue-600 hover:text-blue-800">{site} ↗</a>}
          </span>
        )}
      </th>
      <td className="px-3 py-2.5">
        {row.rating != null ? <><b>★ {row.rating}</b> <span className="text-slate-500">· {row.reviews ?? 0} reviews</span></> : <span className="text-slate-500">—</span>}
        {row.reviewGap != null && row.reviewGap !== 0 && (
          <span className={`block text-[11px] font-bold ${row.reviewGap > 0 ? 'text-red-700' : 'text-emerald-700'}`}>
            {Math.abs(row.reviewGap)} {row.reviewGap > 0 ? 'more' : 'fewer'} than you
          </span>
        )}
      </td>
      <td className="px-3 py-2.5">
        <span className="flex items-center gap-2">
          <span className={`h-2 w-[90px] overflow-hidden rounded-full ${isYou ? 'bg-emerald-100' : 'bg-slate-200'}`} aria-hidden="true">
            <i className={`block h-full ${isYou ? 'bg-green-600' : 'bg-slate-500'}`} style={{ width: `${row.visibility}%` }} />
          </span>
          <b className={isYou ? 'text-emerald-700' : 'text-slate-700'}>{row.visibility}%</b>
        </span>
      </td>
      <td className="px-3 py-2.5 tabular-nums">#{row.avgRank}</td>
      <td className="px-3 py-2.5 tabular-nums">{row.top20}<span className="text-slate-500">/{total}</span></td>
      <td className="px-3 py-2.5 text-xs">{change ? <DeltaText delta={change} fallback="—" /> : <span className="text-slate-400">—</span>}</td>
      <td className="rounded-r-xl px-3 py-2.5">
        {viewHref && (
          <Link href={viewHref} scroll={false} className="inline-flex min-h-9 items-center rounded-[10px] border border-slate-300 bg-white px-3 text-xs font-bold text-blue-700 hover:bg-slate-50">
            View on grid
          </Link>
        )}
      </td>
    </tr>
  );
}
