'use client';

// The opened Geo-grid monitor. Single owner of the two pieces of view state:
//  - activeId: which snapshot (scan date) the map, KPIs and below-the-fold sections show.
//    Shared with the header's Export PDF button through GridSnapshotSelectionProvider.
//  - highlight: the competitor whose ranks the map shows instead of the target's.
// Switching snapshots only swaps the map's marker layer (no route navigation), so Leaflet keeps
// its pan and zoom. Changing snapshot clears the competitor highlight.
import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import type { GridPoint } from '@/lib/db';
import GridMap from './GridMap';
import GridPositionTrend, { type GridPositionTrendPoint } from './GridPositionTrend';
import { GridSnapshotSelectionProvider, type GridSnapshotSelection } from './GridSnapshotSelection';
import { GridCard, GridCollapsible, InfoTip } from './GridSection';
import { GridCompetitorList, GridDistanceRings, GridRankMatrix } from './GridCompetitorInsights';
import {
  computeCompetitors, computeGridSummary, computeRingStats, RANK_LEGEND, UNRANKED_LABEL, VISIBILITY_HELP,
  type CompetitorSummary,
} from './grid-insights';

export type GridMapSnapshot = {
  id: string;
  ts: number;
  status: string;
  visibility: number | null;
  cost?: number;
  results: GridPoint[];
  previousResults: GridPoint[] | null;
};

type Props = {
  /** Server-rendered monitor header (title + actions). Rendered inside the selection provider so Export PDF follows the selected snapshot. */
  header: ReactNode;
  /** Completed scans, newest first. */
  snapshots: GridMapSnapshot[];
  initialSnapshotId: string;
  gridSize: number;
  spacingKm: number;
  target: string;
  /** DOM id of the map; the PDF export captures this element. */
  captureId: string;
  trend: GridPositionTrendPoint[];
};

/** Above this many scans the date chips become a dropdown. */
const MAX_CHIPS = 8;

// Dates are rendered on the server and hydrated in the browser: pin locale and time zone.
const dayFormat = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const dayTimeFormat = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
const fullFormat = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });

type Delta = { text: string; tone: 'good' | 'bad' | 'flat' };

/** Change vs the previous scan. `inverse` for ranks, where a lower number is better. */
function metricDelta(current: number | null, previous: number | null, inverse = false): Delta | null {
  if (current === null || previous === null) return null;
  const value = Math.round((inverse ? previous - current : current - previous) * 10) / 10;
  if (value === 0) return { text: 'No change', tone: 'flat' };
  return { text: `${value > 0 ? '+' : ''}${value}`, tone: value > 0 ? 'good' : 'bad' };
}

const deltaClass: Record<Delta['tone'], string> = {
  good: 'text-emerald-600 dark:text-emerald-400',
  bad: 'text-red-600 dark:text-red-400',
  flat: 'text-slate-400',
};

export default function GridMonitorView({ header, snapshots, initialSnapshotId, gridSize, spacingKm, target, captureId, trend }: Props) {
  const [activeId, setActiveId] = useState(initialSnapshotId);
  const [highlight, setHighlight] = useState<CompetitorSummary | null>(null);
  const [emphasizeUnranked, setEmphasizeUnranked] = useState(false);
  const mapRef = useRef<HTMLDivElement>(null);

  const activeIndex = Math.max(0, snapshots.findIndex((snapshot) => snapshot.id === activeId));
  const active = snapshots[activeIndex];
  const previousTs = snapshots[activeIndex + 1]?.ts;

  const selectSnapshot = useCallback((id: string) => {
    setActiveId(id);
    // A competitor key belongs to one snapshot; never let the map and the list describe different dates.
    setHighlight(null);
  }, []);
  const clearHighlight = useCallback(() => setHighlight(null), []);
  const selection = useMemo<GridSnapshotSelection>(
    () => ({ activeId: active?.id ?? initialSnapshotId, setActiveId: selectSnapshot, beforeExport: clearHighlight }),
    [active?.id, initialSnapshotId, selectSnapshot, clearHighlight],
  );

  const results = useMemo(() => active?.results ?? [], [active]);
  const current = useMemo(() => computeGridSummary(results), [results]);
  const previous = useMemo(() => (active?.previousResults ? computeGridSummary(active.previousResults) : null), [active]);
  const competitors = useMemo(() => computeCompetitors(results), [results]);
  const rings = useMemo(() => computeRingStats(results, gridSize, spacingKm), [results, gridSize, spacingKm]);
  const unrankedCount = current.totalPoints - current.foundCount;
  const hasUngeocodedPoints = results.some((point) => point.lat == null || point.lng == null);

  // Several scans on the same day need the time to tell them apart.
  const chipLabel = useMemo(() => {
    const days = snapshots.map((snapshot) => dayFormat.format(new Date(snapshot.ts)));
    return (index: number) => {
      const ts = new Date(snapshots[index].ts);
      return days.filter((day) => day === days[index]).length > 1 ? dayTimeFormat.format(ts) : days[index];
    };
  }, [snapshots]);

  if (!active) return <>{header}</>;

  const viewOnGrid = (competitor: CompetitorSummary | null) => {
    setHighlight(competitor);
    if (competitor) {
      setEmphasizeUnranked(false);
      mapRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  const deltaTitle = previousTs ? `vs previous scan (${fullFormat.format(new Date(previousTs))} UTC)` : undefined;
  const metrics: { label: string; value: string; of?: number; delta: Delta | null; help?: string; helpAlign?: 'left' | 'right' }[] = [
    { label: 'Visibility', value: `${current.ato}%`, delta: metricDelta(current.ato, previous?.ato ?? null), help: VISIBILITY_HELP },
    {
      label: 'Avg rank',
      value: current.avgRank == null ? UNRANKED_LABEL : `#${current.avgRank}`,
      delta: metricDelta(current.avgRank, previous?.avgRank ?? null, true),
      help: 'Average position at the points where you are in the top 20.',
      helpAlign: 'right',
    },
    { label: 'Top 3', value: String(current.top3Count), of: current.totalPoints, delta: metricDelta(current.top3Count, previous?.top3Count ?? null) },
    { label: 'Top 10', value: String(current.top10Count), of: current.totalPoints, delta: metricDelta(current.top10Count, previous?.top10Count ?? null) },
    { label: 'In top 20', value: String(current.foundCount), of: current.totalPoints, delta: metricDelta(current.foundCount, previous?.foundCount ?? null) },
  ];

  const emphasizeActive = emphasizeUnranked && unrankedCount > 0 && !highlight;

  return (
    <GridSnapshotSelectionProvider value={selection}>
      <div className="space-y-4">
        {header}

        <GridCard>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-3 lg:grid-cols-5">
            {metrics.map((metric) => (
              <div key={metric.label}>
                <dt className="flex items-center gap-1 text-xs font-semibold text-slate-500 dark:text-slate-400">
                  {metric.label}
                  {metric.help && <InfoTip text={metric.help} label={`About ${metric.label}`} align={metric.helpAlign} />}
                </dt>
                <dd className="mt-1 flex flex-wrap items-baseline gap-x-2">
                  <span className="text-2xl font-black tabular-nums text-slate-900 dark:text-white">
                    {metric.value}
                    {metric.of !== undefined && <span className="text-sm font-bold text-slate-400">/{metric.of}</span>}
                  </span>
                  {metric.delta && <span className={`text-xs font-bold tabular-nums ${deltaClass[metric.delta.tone]}`} title={deltaTitle}>{metric.delta.text}</span>}
                </dd>
              </div>
            ))}
          </dl>

          <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-4 dark:border-slate-800">
            <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">Scan</span>
            {snapshots.length > MAX_CHIPS ? (
              <select
                aria-label="Scan date"
                value={active.id}
                onChange={(event) => selectSnapshot(event.target.value)}
                className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm font-semibold text-slate-700 outline-none focus:border-blue-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
              >
                {snapshots.map((snapshot, index) => (
                  <option key={snapshot.id} value={snapshot.id}>
                    {index === 0 ? 'Latest · ' : ''}{fullFormat.format(new Date(snapshot.ts))}{snapshot.visibility === null ? '' : ` · ${snapshot.visibility}%`}
                  </option>
                ))}
              </select>
            ) : (
              <div className="flex gap-1.5 overflow-x-auto" role="tablist" aria-label="Scan date">
                {snapshots.map((snapshot, index) => {
                  const selected = snapshot.id === active.id;
                  return (
                    <button
                      key={snapshot.id}
                      type="button"
                      role="tab"
                      aria-selected={selected}
                      title={`${fullFormat.format(new Date(snapshot.ts))} UTC`}
                      onClick={() => selectSnapshot(snapshot.id)}
                      className={`shrink-0 whitespace-nowrap rounded-lg border px-2.5 py-1 text-xs font-bold tabular-nums transition-colors ${selected ? 'border-blue-600 bg-blue-600 text-white' : 'border-slate-200 bg-white text-slate-600 hover:border-blue-300 hover:text-blue-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:border-blue-700'}`}
                    >
                      {index === 0 ? `Latest · ${chipLabel(index)}` : chipLabel(index)}
                      {snapshot.visibility !== null && <span className={selected ? 'ml-1.5 text-blue-100' : 'ml-1.5 text-slate-400'}>{snapshot.visibility}%</span>}
                    </button>
                  );
                })}
              </div>
            )}

            {unrankedCount > 0 && !highlight && (
              <button
                type="button"
                aria-pressed={emphasizeActive}
                onClick={() => setEmphasizeUnranked((value) => !value)}
                className={`ml-auto shrink-0 rounded-full border px-3 py-1 text-xs font-bold transition-colors ${emphasizeActive ? 'border-slate-900 bg-slate-900 text-white dark:border-white dark:bg-white dark:text-slate-900' : 'border-slate-300 bg-slate-100 text-slate-700 hover:border-slate-400 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200'}`}
              >
                {unrankedCount} {unrankedCount === 1 ? 'point' : 'points'} outside top 20
              </button>
            )}
          </div>

          <div ref={mapRef} className="mt-3 scroll-mt-4">
            {highlight && (
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-100">
                <span>
                  Showing <b>{highlight.name}</b> · avg #{highlight.avgRank} · in top 20 at {highlight.appearances}/{highlight.totalPoints}
                </span>
                <button type="button" onClick={clearHighlight} className="font-bold text-blue-700 hover:text-blue-900 dark:text-blue-300 dark:hover:text-white">
                  ← Back to target
                </button>
              </div>
            )}
            <GridMap
              points={results}
              previousPoints={active.previousResults}
              gridSize={gridSize}
              target={target}
              captureId={captureId}
              highlightKey={highlight?.key}
              emphasizeUnranked={emphasizeActive}
            />
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs font-semibold text-slate-500 dark:text-slate-400">
            {RANK_LEGEND.map((item) => (
              <span key={item.label} className="inline-flex items-center gap-1.5">
                <i className="h-3 w-3 rounded-sm" style={{ backgroundColor: item.color }} />{item.label}
              </span>
            ))}
            <span className="inline-flex items-center gap-1.5">
              <i className="h-3 w-3 rounded-sm border-2 border-dashed border-slate-400" />Center
            </span>
            {active.previousResults && (
              <span className="inline-flex flex-wrap items-center gap-x-2" title={deltaTitle}>
                <span className="text-slate-300 dark:text-slate-600">|</span>
                <span><b className="text-emerald-600">+3</b> moved up</span>
                <span><b className="text-red-600">-3</b> moved down</span>
                <span><b>new</b> entered top 20</span>
                <span><b>lost</b> left top 20</span>
              </span>
            )}
            <span className="ml-auto text-slate-400">Click a pin for details</span>
          </div>

          {hasUngeocodedPoints && (
            <div className="mt-4">
              <p className="mb-2 text-xs font-semibold text-slate-500 dark:text-slate-400">Points without coordinates</p>
              <GridRankMatrix results={results} gridSize={gridSize} />
            </div>
          )}
        </GridCard>

        <GridCollapsible
          title="Competitors"
          meta={competitors.length > 0 ? `${competitors.length} in the top 20` : undefined}
          defaultOpen
        >
          {competitors.length > 0 ? (
            <GridCompetitorList
              competitors={competitors}
              target={target}
              targetVisibility={current.ato}
              highlightKey={highlight?.key}
              onViewOnGrid={viewOnGrid}
            />
          ) : (
            <p className="text-xs text-slate-500 dark:text-slate-400">No other businesses ranked in the top 20 on this scan.</p>
          )}
        </GridCollapsible>

        <GridCollapsible title="Visibility by distance">
          <GridDistanceRings rings={rings} spacingKm={spacingKm} />
        </GridCollapsible>

        <GridCollapsible title="Position over time" meta={`${trend.length} ${trend.length === 1 ? 'scan' : 'scans'}`}>
          {trend.length >= 2
            ? <GridPositionTrend points={trend} selectedId={active.id} />
            : <p className="text-xs text-slate-500 dark:text-slate-400">Trend appears after the second scan.</p>}
        </GridCollapsible>
      </div>
    </GridSnapshotSelectionProvider>
  );
}
