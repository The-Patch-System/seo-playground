// Patch fork: view models for the location-based Geo-grid UI. Pure functions over parsed runs, no DB.
// Numbers match the Dec 1 reports and the n8n map pack sync: "Avg rank" is the Semrush MRT average
// (every scanned point counts, outside the top 20 = 21, failed points left out).
import type { GridPoint } from './db';
import { mrtAveragePosition } from './grid-report';
import { radiusMiForSpacing } from './grid-radius';
import { computeRingStats } from '@/app/dashboard/local-finder/grid-insights';
import type { MonitorInfo, MonitorWithLatest, RunHeader, RunWithPoints, ScheduleInfo } from './grid-locations-db';

// --- Rank display ---

export const RANK_COLORS = {
  top3: '#16a34a',
  top10: '#facc15',
  top20: '#dc2626',
  out: '#94a3b8',
  nodata: '#94a3b8',
} as const;

export type RankBucket = keyof typeof RANK_COLORS;

/** failed = DataForSEO had no data for the point ("—"); rank null = outside the top 20 ("20+"). */
export function rankBucket(point: Pick<GridPoint, 'rank' | 'failed'> | null | undefined): RankBucket {
  if (!point || point.failed) return 'nodata';
  if (point.rank == null) return 'out';
  if (point.rank <= 3) return 'top3';
  if (point.rank <= 10) return 'top10';
  if (point.rank <= 20) return 'top20';
  return 'out';
}

export function rankLabel(point: Pick<GridPoint, 'rank' | 'failed'> | null | undefined): string {
  const bucket = rankBucket(point);
  if (bucket === 'nodata') return '—';
  if (bucket === 'out') return '20+';
  return String(point!.rank);
}

export function rankColor(point: Pick<GridPoint, 'rank' | 'failed'> | null | undefined): string {
  return RANK_COLORS[rankBucket(point)];
}

// --- Dates ---

/** "Nov 15, 2026" in the clinic's time zone. */
export function formatScanDate(ts: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone }).format(new Date(ts));
  } catch {
    return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(ts));
  }
}

/** "Nov 15, 2026, 12:00 PM" in the clinic's time zone. */
export function formatScanDateTime(ts: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone }).format(new Date(ts));
  } catch {
    return formatScanDate(ts, 'UTC');
  }
}

function yearMonth(ts: number, timeZone: string): { year: number; month: number } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'numeric', timeZone }).formatToParts(new Date(ts));
  } catch {
    parts = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'numeric', timeZone: 'UTC' }).formatToParts(new Date(ts));
  }
  return { year: Number(parts.find((p) => p.type === 'year')!.value), month: Number(parts.find((p) => p.type === 'month')!.value) };
}

export function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'}`;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** "Monthly · 15th, 12:00 clinic time" */
export function describeSchedule(schedule: Pick<ScheduleInfo, 'frequency' | 'weekday' | 'time_of_day'> | null): string {
  if (!schedule) return 'Not scheduled';
  if (schedule.frequency === 'monthly') return `Monthly · ${ordinal(schedule.weekday ?? 15)}, ${schedule.time_of_day} clinic time`;
  if (schedule.frequency === 'weekly') return `Weekly · ${WEEKDAYS[schedule.weekday ?? 1]}s, ${schedule.time_of_day} clinic time`;
  return `Daily · ${schedule.time_of_day} clinic time`;
}

// --- KPIs ---

export interface Kpis {
  /** 0-100 share of voice (rank 1 = 100%, outside the top 20 = 0%), same as the reports' visibility. */
  visibility: number;
  /** Semrush MRT average position (outside the top 20 = 21, failed points left out). */
  avgRank: number | null;
  top3: number;
  top10: number;
  inTop20: number;
  /** Points that were scanned (failed points excluded). */
  scanned: number;
  failed: number;
  total: number;
}

export function computeKpis(points: GridPoint[]): Kpis {
  const scanned = points.filter((p) => !p.failed);
  const ranked = scanned.filter((p) => p.rank != null && p.rank <= 20);
  const visibility = points.length
    ? Math.round((points.reduce((s, p) => s + (p.failed ? 0 : 21 - Math.min(p.rank ?? 21, 21)), 0) / (points.length * 20)) * 100)
    : 0;
  const mrt = mrtAveragePosition(points);
  return {
    visibility,
    avgRank: mrt == null ? null : Math.round(mrt * 10) / 10,
    top3: ranked.filter((p) => p.rank! <= 3).length,
    top10: ranked.filter((p) => p.rank! <= 10).length,
    inTop20: ranked.length,
    scanned: scanned.length,
    failed: points.length - scanned.length,
    total: points.length,
  };
}

export type DeltaTone = 'better' | 'worse' | 'same' | 'none';

export interface Delta {
  /** Signed change in the metric's own units (current - compare). */
  value: number | null;
  tone: DeltaTone;
  /** "▲ 3", "▼ 0.4", "No change", or "" when there's nothing to compare. */
  label: string;
}

function round1(n: number) {
  return Math.round(n * 10) / 10;
}

/** Higher is better (visibility, top 3, top 10, in top 20). */
export function deltaHigher(current: number | null, compare: number | null | undefined): Delta {
  if (current == null || compare == null) return { value: null, tone: 'none', label: '' };
  const value = round1(current - compare);
  if (value === 0) return { value, tone: 'same', label: 'No change' };
  return { value, tone: value > 0 ? 'better' : 'worse', label: `${value > 0 ? '▲' : '▼'} ${Math.abs(value)}` };
}

/** Lower is better (avg rank). "▲ 0.4 better" means the average rank number went down. */
export function deltaLower(current: number | null, compare: number | null | undefined): Delta {
  if (current == null || compare == null) return { value: null, tone: 'none', label: '' };
  const value = round1(current - compare);
  if (value === 0) return { value, tone: 'same', label: 'No change' };
  return { value, tone: value < 0 ? 'better' : 'worse', label: `${value < 0 ? '▲' : '▼'} ${Math.abs(value)} ${value < 0 ? 'better' : 'worse'}` };
}

export interface KpiComparison {
  current: Kpis;
  compare: Kpis | null;
  visibility: Delta;
  avgRank: Delta;
  top3: Delta;
  top10: Delta;
  inTop20: Delta;
}

export function compareKpis(current: GridPoint[], compare: GridPoint[] | null): KpiComparison {
  const a = computeKpis(current);
  const b = compare ? computeKpis(compare) : null;
  return {
    current: a, compare: b,
    visibility: deltaHigher(a.visibility, b?.visibility),
    avgRank: deltaLower(a.avgRank, b?.avgRank),
    top3: deltaHigher(a.top3, b?.top3),
    top10: deltaHigher(a.top10, b?.top10),
    inTop20: deltaHigher(a.inTop20, b?.inTop20),
  };
}

// --- Compare to ---

export type CompareMode = 'previous' | 'last_year' | 'specific';

export interface CompareChoice {
  mode: CompareMode;
  /** The run to compare against, or null when none fits. */
  runId: string | null;
  /** Why the requested mode fell back or found nothing. */
  note: string | null;
  /** Whether "same month last year" has a scan for the selected run (the option is grayed out when not). */
  lastYearAvailable: boolean;
}

/** Finished runs only, newest first. */
function finished(headers: RunHeader[]): RunHeader[] {
  return headers.filter((h) => h.status === 'done').sort((a, b) => b.ts - a.ts);
}

export function sameMonthLastYear(headers: RunHeader[], selected: RunHeader, timeZone: string): RunHeader | null {
  const { year, month } = yearMonth(selected.ts, timeZone);
  // Newest scan in that month a year earlier.
  return finished(headers).find((h) => {
    const ym = yearMonth(h.ts, timeZone);
    return ym.year === year - 1 && ym.month === month;
  }) ?? null;
}

/**
 * Resolves the "Compare to" dropdown. previous = the scan before the selected one; last_year = the
 * same calendar month a year earlier (clinic time); specific = any other finished scan. A request
 * that can't be met falls back to the previous scan and says so.
 */
export function resolveCompare(headers: RunHeader[], selectedId: string, mode: CompareMode, specificId: string | null, timeZone: string): CompareChoice {
  const done = finished(headers);
  const selected = done.find((h) => h.id === selectedId);
  if (!selected) return { mode, runId: null, note: null, lastYearAvailable: false };
  const previous = done.find((h) => h.ts < selected.ts) ?? null;
  const lastYear = sameMonthLastYear(done, selected, timeZone);
  const fallback = (note: string): CompareChoice => ({
    mode: 'previous', runId: previous?.id ?? null, note: previous ? note : 'This is the first scan, so there is nothing to compare to.', lastYearAvailable: Boolean(lastYear),
  });
  if (mode === 'last_year') {
    return lastYear
      ? { mode, runId: lastYear.id, note: null, lastYearAvailable: true }
      : fallback('No scan from the same month last year, so this compares to the previous scan.');
  }
  if (mode === 'specific') {
    const run = specificId ? done.find((h) => h.id === specificId && h.id !== selected.id) : null;
    return run ? { mode, runId: run.id, note: null, lastYearAvailable: Boolean(lastYear) } : fallback('Pick a scan to compare to.');
  }
  return previous
    ? { mode: 'previous', runId: previous.id, note: null, lastYearAvailable: Boolean(lastYear) }
    : { mode: 'previous', runId: null, note: 'This is the first scan, so there is nothing to compare to.', lastYearAvailable: Boolean(lastYear) };
}

// --- Competitors ---

export interface CompetitorRow {
  key: string;
  name: string;
  cid: string | null;
  domain: string | null;
  rating: number | null;
  reviews: number | null;
  /** Reviews minus yours (positive = they have more). Null when either side is unknown. */
  reviewGap: number | null;
  visibility: number;
  /** Average rank where they appear in the top 20. */
  avgRank: number;
  /** Points where they're in the top 20. */
  top20: number;
  isTarget: boolean;
}

function competitorKeyOf(item: { cid?: string; domain?: string; title: string }): string {
  if (item.cid) return `cid:${item.cid}`;
  const domain = item.domain?.trim().toLowerCase().replace(/^www\./, '');
  if (domain) return `domain:${domain}`;
  return `title:${item.title.trim().toLowerCase()}`;
}

/**
 * Every business seen in the grid (no cap), grouped by CID, then domain, then title. Visibility uses
 * the same formula as yours, so the rows compare directly. Imported Semrush runs have no listings, so
 * they return an empty list.
 */
export function computeCompetitorRows(points: GridPoint[]): CompetitorRow[] {
  const total = points.length;
  const groups = new Map<string, { name: string; cid: string | null; domain: string | null; rating: number | null; reviews: number | null; ranks: number[]; isTarget: boolean }>();
  for (const point of points) {
    const seen = new Set<string>();
    for (const item of point.items ?? []) {
      const key = competitorKeyOf(item);
      if (seen.has(key)) continue;
      seen.add(key);
      const group = groups.get(key) ?? {
        name: item.title, cid: item.cid ?? null, domain: item.domain ?? null,
        rating: item.rating_value ?? null, reviews: item.rating_votes ?? null, ranks: [], isTarget: false,
      };
      group.ranks.push(item.rank_group);
      group.isTarget ||= item.is_target;
      group.rating ??= item.rating_value ?? null;
      group.reviews = Math.max(group.reviews ?? 0, item.rating_votes ?? 0) || group.reviews;
      group.domain ??= item.domain ?? null;
      groups.set(key, group);
    }
  }
  const rows = [...groups.entries()].map(([key, g]) => ({
    key, name: g.name, cid: g.cid, domain: g.domain, rating: g.rating, reviews: g.reviews, reviewGap: null as number | null,
    visibility: total ? Math.round((g.ranks.reduce((s, r) => s + (21 - Math.min(r, 21)), 0) / (total * 20)) * 100) : 0,
    avgRank: round1(g.ranks.reduce((s, r) => s + r, 0) / g.ranks.length),
    top20: g.ranks.filter((r) => r <= 20).length,
    isTarget: g.isTarget,
  }));
  const you = rows.find((r) => r.isTarget);
  for (const row of rows) {
    row.reviewGap = !row.isTarget && you?.reviews != null && row.reviews != null ? row.reviews - you.reviews : null;
  }
  return rows.sort((a, b) => b.visibility - a.visibility || a.avgRank - b.avgRank || a.name.localeCompare(b.name));
}

// --- Rings ---

export interface RingRow {
  ring: number;
  /** Center-to-ring distance in miles (0 = the center point). */
  miles: number;
  points: number;
  inTop20: number;
  top3Pct: number;
  /** Average rank where found (top 20). */
  avgRank: number | null;
}

/** Visibility by distance, in miles. Failed points are left out so missing data doesn't read as "not found". */
export function computeRings(points: GridPoint[], gridSize: number, spacingKm: number): RingRow[] {
  const scanned = points.filter((p) => !p.failed);
  return computeRingStats(scanned, gridSize, spacingKm).map((ring) => ({
    ring: ring.ring,
    miles: ring.ring === 0 ? 0 : radiusMiForSpacing(spacingKm, ring.ring * 2 + 1),
    points: ring.pointCount,
    inTop20: ring.foundCount,
    top3Pct: ring.top3Pct,
    avgRank: ring.avgRank,
  }));
}

// --- Trend ---

export interface TrendPoint {
  runId: string;
  ts: number;
  visibility: number;
  avgRank: number | null;
  pinned: boolean;
}

/** Oldest first, for the chart. */
export function computeTrend(runs: RunWithPoints[]): TrendPoint[] {
  return [...runs].sort((a, b) => a.ts - b.ts).map((run) => {
    const k = computeKpis(run.points);
    return { runId: run.id, ts: run.ts, visibility: k.visibility, avgRank: k.avgRank, pinned: run.pinned };
  });
}

// --- Keyword / location state ---

export type KeywordState = 'established' | 'first_scan' | 'scanning' | 'waiting';

/** established = 2+ scans; first_scan = exactly one; scanning = first scan running; waiting = scheduled, no scan yet. */
export function keywordState(monitor: Pick<MonitorInfo, 'doneRuns' | 'pendingRun'>): KeywordState {
  if (monitor.doneRuns >= 2) return 'established';
  if (monitor.doneRuns === 1) return 'first_scan';
  return monitor.pendingRun ? 'scanning' : 'waiting';
}

export type LocationStatus = 'tracking' | 'scanning' | 'first_scan_running' | 'first_scan_done' | 'waiting' | 'not_scheduled' | 'one_time';

export function locationStatus(monitors: Array<Pick<MonitorInfo, 'doneRuns' | 'pendingRun' | 'schedule'>>): { status: LocationStatus; label: string } {
  const anyDone = monitors.some((m) => m.doneRuns > 0);
  const anyPending = monitors.some((m) => m.pendingRun);
  if (anyPending) return anyDone ? { status: 'scanning', label: 'Scanning' } : { status: 'first_scan_running', label: 'First scan running' };
  // Scans but no schedule anywhere: one-time scans, e.g. a sales demo. They never become tracking.
  if (anyDone && monitors.every((m) => !m.schedule)) return { status: 'one_time', label: 'One-time scan' };
  if (!anyDone) {
    return monitors.some((m) => m.schedule) ? { status: 'waiting', label: 'Waiting for first scan' } : { status: 'not_scheduled', label: 'Not scheduled' };
  }
  if (monitors.every((m) => m.doneRuns <= 1)) return { status: 'first_scan_done', label: 'First scan done' };
  return { status: 'tracking', label: 'Tracking' };
}

/** The settings the location's keywords share, or "mixed" when imports left them different. */
export function sharedGridConfig(monitors: Array<Pick<MonitorInfo, 'grid_size' | 'spacing_km'>>): { mixed: boolean; gridSize: number | null; radiusMi: number | null } {
  const configs = new Set(monitors.map((m) => `${m.grid_size}|${m.spacing_km}`));
  if (configs.size !== 1) return { mixed: true, gridSize: null, radiusMi: null };
  const m = monitors[0];
  return { mixed: false, gridSize: m.grid_size, radiusMi: radiusMiForSpacing(m.spacing_km, m.grid_size) };
}

/** The schedule the location's keywords share (most common), and whether they differ. */
export function sharedSchedule(monitors: Array<Pick<MonitorInfo, 'schedule'>>): { schedule: ScheduleInfo | null; mixed: boolean; unscheduled: number; nextRunAt: number | null } {
  const scheduled = monitors.map((m) => m.schedule).filter((s): s is ScheduleInfo => s != null);
  const key = (s: ScheduleInfo) => [s.frequency, s.weekday, s.time_of_day, s.queue_mode].join('|');
  const counts = new Map<string, { n: number; s: ScheduleInfo }>();
  for (const s of scheduled) counts.set(key(s), { n: (counts.get(key(s))?.n ?? 0) + 1, s });
  const best = [...counts.values()].sort((a, b) => b.n - a.n)[0]?.s ?? null;
  return {
    schedule: best,
    mixed: counts.size > 1,
    unscheduled: monitors.length - scheduled.length,
    nextRunAt: scheduled.length ? Math.min(...scheduled.map((s) => s.next_run_at)) : null,
  };
}

export function clinicTimeZone(monitor: Pick<MonitorInfo, 'schedule'>, fallback: string | null): string {
  return monitor.schedule?.time_zone ?? fallback ?? 'America/New_York';
}

/** A keyword row for the client and location pages: latest scan, its KPIs and the change since the previous one. */
export interface KeywordSummary {
  seriesId: string;
  keyword: string;
  state: KeywordState;
  gridSize: number;
  radiusMi: number;
  latest: { runId: string; ts: number; kpis: Kpis; points: GridPoint[] } | null;
  visibilityDelta: Delta;
  avgRankDelta: Delta;
  pending: { readyPoints: number; totalPoints: number } | null;
  scheduled: boolean;
}

export function summarizeKeyword(monitor: MonitorWithLatest): KeywordSummary {
  const [latest, previous] = monitor.latestRuns;
  const kpis = latest ? computeKpis(latest.points) : null;
  const prev = previous ? computeKpis(previous.points) : null;
  return {
    seriesId: monitor.series_id,
    keyword: monitor.keyword,
    state: keywordState(monitor),
    gridSize: monitor.grid_size,
    radiusMi: radiusMiForSpacing(monitor.spacing_km, monitor.grid_size),
    latest: latest && kpis ? { runId: latest.id, ts: latest.ts, kpis, points: latest.points } : null,
    visibilityDelta: deltaHigher(kpis?.visibility ?? null, prev?.visibility),
    avgRankDelta: deltaLower(kpis?.avgRank ?? null, prev?.avgRank),
    pending: monitor.pendingRun ? { readyPoints: monitor.pendingRun.readyPoints, totalPoints: monitor.pendingRun.totalPoints } : null,
    scheduled: Boolean(monitor.schedule),
  };
}

/** Google Maps link for the business: by CID when known, else a search for the name. */
export function mapsUrl(cid: string | null, name: string, center?: string): string {
  if (cid) return `https://www.google.com/maps?cid=${cid}`;
  const q = encodeURIComponent(name);
  return center ? `https://www.google.com/maps/search/${q}/@${center},14z` : `https://www.google.com/maps/search/${q}`;
}

// --- Location page: "Showing" scan dates ---

/** YYYY-MM-DD in the clinic's time zone. */
export function dayKey(ts: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone }).format(new Date(ts));
  } catch {
    return new Date(ts).toISOString().slice(0, 10);
  }
}

export interface ScanDateOption {
  /** YYYY-MM-DD (clinic time). */
  day: string;
  ts: number;
  /** True when any keyword's pinned starting-point scan falls on this day. */
  startingPoint: boolean;
}

/** The distinct days any keyword at the location finished a scan, newest first. */
export function scanDateOptions(headersBySeries: Map<string, RunHeader[]>, timeZone: string): ScanDateOption[] {
  const byDay = new Map<string, ScanDateOption>();
  for (const headers of headersBySeries.values()) {
    for (const h of headers) {
      if (h.status !== 'done') continue;
      const day = dayKey(h.ts, timeZone);
      const current = byDay.get(day) ?? { day, ts: h.ts, startingPoint: false };
      current.ts = Math.max(current.ts, h.ts);
      current.startingPoint ||= h.pinned;
      byDay.set(day, current);
    }
  }
  return [...byDay.values()].sort((a, b) => b.ts - a.ts);
}

/**
 * For each keyword, the newest finished scan on or before the chosen day (clinic time) and the one
 * before it. With no day, the latest scan. Keywords with no scan by then get nulls.
 */
export function pickRunsForDay(headersBySeries: Map<string, RunHeader[]>, day: string | null, timeZone: string): Map<string, { current: RunHeader | null; previous: RunHeader | null }> {
  const out = new Map<string, { current: RunHeader | null; previous: RunHeader | null }>();
  for (const [seriesId, headers] of headersBySeries) {
    const done = headers.filter((h) => h.status === 'done').sort((a, b) => b.ts - a.ts);
    const index = day ? done.findIndex((h) => dayKey(h.ts, timeZone) <= day) : (done.length ? 0 : -1);
    out.set(seriesId, index < 0 ? { current: null, previous: null } : { current: done[index], previous: done[index + 1] ?? null });
  }
  return out;
}
