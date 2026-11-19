import { CalendarClock, RefreshCw } from 'lucide-react';
import type { BrandStyle } from '@/lib/brand';
import type { GridPoint, GridSchedule, GridSearchEntry } from '@/lib/db';
import { formatRadiusMiles, gridRadiusMiles } from '@/lib/geo-options';
import { GridSelectedSnapshotExportButton } from './GridSnapshotSelection';
import GridSettingsDialog from './GridSettingsDialog';
import GridMonitorView, { type GridMapSnapshot } from './GridMonitorView';
import { type GridPositionTrendPoint } from './GridPositionTrend';

type Props = {
  entry: GridSearchEntry;
  results: GridPoint[];
  previousResults: GridPoint[] | null;
  snapshots: GridMapSnapshot[];
  schedule: GridSchedule | null;
  brandName: string;
  brandLogoUrl?: string;
  brandColor?: string;
  brandFooter?: string;
  brandStyle?: Partial<BrandStyle>;
  trend: GridPositionTrendPoint[];
};

const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function scheduleLabel(schedule: GridSchedule): string {
  if (schedule.frequency === 'daily') return `Auto: daily ${schedule.time_of_day}`;
  if (schedule.frequency === 'weekly') return `Auto: weekly ${weekdays[schedule.weekday ?? 1] ?? ''} ${schedule.time_of_day}`;
  return `Auto: monthly, day ${schedule.weekday ?? 15}, ${schedule.time_of_day}`;
}

const dateFormat = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });

export default function GridTimeline({ entry, results, previousResults, snapshots, schedule, brandName, brandLogoUrl, brandColor, brandFooter, brandStyle, trend }: Props) {
  const mapId = `geo-grid-report-map-${entry.id}`;
  // The opened run should always be selectable, even if the series query somehow missed it.
  const allSnapshots = snapshots.some((snapshot) => snapshot.id === entry.id)
    ? snapshots
    : [...snapshots, { id: entry.id, ts: entry.ts, status: entry.status, visibility: entry.summary?.ato ?? null, cost: entry.cost, results, previousResults }]
      .sort((a, b) => b.ts - a.ts);
  const lastScannedTs = allSnapshots[0]?.ts ?? entry.ts;
  const radius = formatRadiusMiles(gridRadiusMiles(entry.grid_size, entry.spacing_km));
  const runNowHref = `/dashboard/geo-grid?keyword=${encodeURIComponent(entry.keyword)}&location_coordinate=${encodeURIComponent(entry.center)}&grid_size=${entry.grid_size}&spacing_km=${entry.spacing_km}&grid_target=${encodeURIComponent(entry.target)}&language=${encodeURIComponent(entry.language)}&queue_mode=${entry.queue_mode}&mode=grid`;

  const header = (
    <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <h2 className="truncate text-2xl font-black tracking-tight text-slate-900 dark:text-white">{entry.keyword}</h2>
        <p className="mt-0.5 truncate text-sm font-semibold text-blue-600 dark:text-blue-400">{entry.target}</p>
        <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-xs text-slate-500 dark:text-slate-400">
          <span title={`${entry.spacing_km} km between grid points`}>{entry.grid_size}×{entry.grid_size} · {radius} radius</span>
          <span aria-hidden>·</span>
          <span>Last scanned {dateFormat.format(new Date(lastScannedTs))} UTC</span>
          {schedule && (
            <>
              <span aria-hidden>·</span>
              <span className="inline-flex items-center gap-1">
                <CalendarClock className="h-3.5 w-3.5" aria-hidden />
                {scheduleLabel(schedule)}
              </span>
            </>
          )}
        </p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <a
          href={runNowHref}
          className="inline-flex items-center gap-2 rounded-xl border border-blue-200 bg-white px-3 py-2 text-xs font-bold text-blue-700 transition-colors hover:bg-blue-50 dark:border-blue-900 dark:bg-slate-900 dark:text-blue-300 dark:hover:bg-blue-950"
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          Run now
        </a>
        <GridSelectedSnapshotExportButton
          snapshots={allSnapshots}
          fallbackResults={results}
          fallbackTs={entry.ts}
          gridSize={entry.grid_size}
          spacingKm={entry.spacing_km}
          keyword={entry.keyword}
          target={entry.target}
          language={entry.language}
          brandName={brandName}
          brandLogoUrl={brandLogoUrl}
          brandColor={brandColor}
          brandFooter={brandFooter}
          brandStyle={brandStyle}
          mapElementId={mapId}
        />
        <GridSettingsDialog runId={entry.id} schedule={schedule} />
      </div>
    </header>
  );

  return (
    <GridMonitorView
      key={entry.id}
      header={header}
      snapshots={allSnapshots}
      initialSnapshotId={entry.id}
      gridSize={entry.grid_size}
      spacingKm={entry.spacing_km}
      target={entry.target}
      captureId={mapId}
      trend={trend}
    />
  );
}
