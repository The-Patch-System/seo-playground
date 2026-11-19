'use client';

// Below-the-fold detail for the snapshot selected on the monitor map: competitors,
// visibility by distance, and a plain rank grid for legacy scans stored without coordinates.
import { useState } from 'react';
import type { GridPoint } from '@/lib/db';
import { formatRadiusMiles, gridRadiusMiles } from '@/lib/geo-options';
import { rankColor, UNRANKED_LABEL, type CompetitorSummary, type RingStat } from './grid-insights';

const TOP_COMPETITORS = 5;

export function GridCompetitorList({ competitors, target, targetVisibility, highlightKey, onViewOnGrid }: {
  competitors: CompetitorSummary[];
  target: string;
  targetVisibility: number;
  highlightKey?: string;
  /** Called with the competitor to show on the map, or null to go back to the target. */
  onViewOnGrid: (competitor: CompetitorSummary | null) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? competitors : competitors.slice(0, TOP_COMPETITORS);

  return (
    <div>
      <div className="mb-2 flex items-center justify-between px-3 text-xs font-semibold text-slate-500 dark:text-slate-400">
        <span>Business</span>
        <span>Visibility</span>
      </div>
      <div className="space-y-2">
        <div className="flex items-center gap-3 rounded-xl border border-emerald-100 bg-emerald-50 px-3 py-2.5 dark:border-emerald-900 dark:bg-emerald-950">
          <span className="w-10 shrink-0 text-xs font-black text-emerald-700 dark:text-emerald-400">You</span>
          <span className="min-w-0 flex-1 truncate text-sm font-bold text-slate-800 dark:text-slate-100">{target}</span>
          <div className="hidden h-2 max-w-[120px] flex-1 overflow-hidden rounded-full bg-emerald-100 dark:bg-emerald-900 sm:block">
            <div className="h-full bg-emerald-500" style={{ width: `${targetVisibility}%` }} />
          </div>
          <span className="w-10 text-right text-sm font-black tabular-nums text-emerald-700 dark:text-emerald-400">{targetVisibility}%</span>
          {/* Keeps the % column aligned with the competitor rows' button column. */}
          <span className="hidden w-[104px] shrink-0 sm:block" aria-hidden />
        </div>

        {visible.map((competitor, index) => {
          const isActive = highlightKey === competitor.key;
          return (
            <div
              key={competitor.key}
              className={`flex items-center gap-3 rounded-xl border px-3 py-2.5 transition-colors ${isActive ? 'border-blue-200 bg-blue-50 dark:border-blue-900 dark:bg-blue-950' : 'border-transparent bg-slate-50 dark:bg-slate-800'}`}
            >
              <span className="w-10 shrink-0 text-xs font-black tabular-nums text-slate-400">#{index + 1}</span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-bold text-slate-800 dark:text-slate-100">{competitor.name}</p>
                <p className="truncate text-xs text-slate-500 dark:text-slate-400">
                  In top 20 at {competitor.appearances}/{competitor.totalPoints} · avg #{competitor.avgRank}
                  {competitor.avgRating != null ? ` · ★${competitor.avgRating.toFixed(1)}` : ''}
                </p>
              </div>
              <div className="hidden h-2 max-w-[120px] flex-1 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700 sm:block">
                <div className="h-full bg-blue-500" style={{ width: `${competitor.visibilityScore}%` }} />
              </div>
              <span className="w-10 text-right text-sm font-black tabular-nums text-slate-600 dark:text-slate-300">{competitor.visibilityScore}%</span>
              <button
                type="button"
                onClick={() => onViewOnGrid(isActive ? null : competitor)}
                aria-pressed={isActive}
                className={`shrink-0 rounded-lg px-2.5 py-1.5 text-xs font-bold transition-colors sm:w-[104px] ${isActive ? 'bg-blue-600 text-white' : 'border border-blue-200 bg-white text-blue-600 hover:bg-blue-50 dark:border-blue-900 dark:bg-slate-900 dark:hover:bg-blue-950'}`}
              >
                {isActive ? 'On map ✓' : <><span className="sm:hidden">Map</span><span className="hidden sm:inline">View on grid</span></>}
              </button>
            </div>
          );
        })}
      </div>

      {competitors.length > TOP_COMPETITORS && (
        <button
          type="button"
          onClick={() => setShowAll((value) => !value)}
          className="mt-3 text-xs font-bold text-blue-600 transition-colors hover:text-blue-800 dark:text-blue-400"
        >
          {showAll ? 'Show top 5 only' : `Show all ${competitors.length}`}
        </button>
      )}
    </div>
  );
}

export function GridDistanceRings({ rings, spacingKm }: { rings: RingStat[]; spacingKm: number }) {
  return (
    <div className="space-y-2">
      {rings.map((ring) => (
        <div key={ring.ring} className="flex items-center gap-3">
          <span className="w-16 shrink-0 text-xs font-bold tabular-nums text-slate-500 dark:text-slate-400">
            {/* Ring n sits at the edge of a (2n + 1)-wide grid, so its distance is that grid's radius. */}
            {ring.ring === 0 ? 'Center' : `~${formatRadiusMiles(gridRadiusMiles(ring.ring * 2 + 1, spacingKm))}`}
          </span>
          <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
            <div
              className={`h-full ${ring.top3Pct >= 50 ? 'bg-emerald-500' : ring.foundCount > 0 ? 'bg-amber-500' : 'bg-slate-300 dark:bg-slate-600'}`}
              style={{ width: `${Math.round((ring.foundCount / ring.pointCount) * 100)}%` }}
            />
          </div>
          <span className="w-16 shrink-0 text-right text-xs font-bold tabular-nums text-slate-700 dark:text-slate-200">
            {ring.avgRank != null ? `avg #${ring.avgRank}` : UNRANKED_LABEL}
          </span>
          <span className="w-28 shrink-0 text-right text-xs tabular-nums text-slate-500 dark:text-slate-400">
            {ring.foundCount}/{ring.pointCount} in top 20
          </span>
        </div>
      ))}
    </div>
  );
}

/** Plain rank grid for scans stored without coordinates (cannot be placed on the map). */
export function GridRankMatrix({ results, gridSize }: { results: GridPoint[]; gridSize: number }) {
  const half = Math.floor(gridSize / 2);
  return (
    <div className="inline-grid gap-1" style={{ gridTemplateColumns: `repeat(${gridSize}, 1fr)` }}>
      {results.map((point) => {
        const isCenter = point.row === half && point.col === half;
        return (
          <div
            key={`${point.row}:${point.col}`}
            title={point.rank != null ? `#${point.rank}` : `Not in the top 20`}
            className="flex h-9 w-9 items-center justify-center rounded-md text-xs font-black text-white"
            style={{
              background: rankColor(point.rank),
              border: isCenter ? '2px dashed rgba(255,255,255,0.7)' : '1px solid rgba(255,255,255,0.2)',
            }}
          >
            {point.rank ?? UNRANKED_LABEL}
          </div>
        );
      })}
    </div>
  );
}
