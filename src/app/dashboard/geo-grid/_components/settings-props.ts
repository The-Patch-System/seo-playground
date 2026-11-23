import { DEMO_PROJECT_ID, type LocationGroup, type MonitorInfo } from '@/lib/grid-locations-db';
import { describeSchedule, sharedGridConfig, sharedSchedule } from '@/lib/grid-locations';
import { radiusMiForSpacing } from '@/lib/grid-radius';
import { timeZoneForCenter } from '@/lib/grid-timezone';
import type { AddKeywordSummary, KeywordSettingsProps, LocationSettingsProps } from './Actions';
import { locationUrl } from './routes';

/** DataForSEO Standard queue, per grid point (81 points ≈ $0.10 on Nov 20, 2026). */
export const COST_PER_POINT = 0.10 / 81;

function gridText(location: LocationGroup): string {
  const grid = sharedGridConfig(location.monitors);
  return grid.mixed ? 'mixed grids' : `${grid.gridSize}×${grid.gridSize} grid, ${grid.radiusMi} mi radius`;
}

/** What the location Settings dialog needs. */
export function locationSettingsProps(projectId: string, location: LocationGroup): LocationSettingsProps {
  const { schedule } = sharedSchedule(location.monitors);
  return {
    projectId,
    locationId: location.id,
    locationName: location.name,
    locationLabel: `Location ${location.number}`,
    schedule: schedule
      ? { frequency: schedule.frequency, day: schedule.weekday, time_of_day: schedule.time_of_day, queue_mode: schedule.queue_mode === 'priority' ? 'priority' : 'standard' }
      : null,
    timeZone: schedule?.time_zone ?? timeZoneForCenter(location.center) ?? 'America/New_York',
    gridText: sharedGridConfig(location.monitors).mixed
      ? 'Mixed grids: keywords here use different grid sizes or radii.'
      : `${gridText(location)} · centered at ${location.center}`,
    keywordCount: location.monitors.length,
    oneTimeOnly: projectId === DEMO_PROJECT_ID || !location.monitors.some((m) => m.schedule),
  };
}

/** The review step of Add keyword: same grid, scan now, then the location's schedule. */
export function addKeywordSummary(location: LocationGroup): AddKeywordSummary {
  const { schedule } = sharedSchedule(location.monitors);
  const grid = sharedGridConfig(location.monitors);
  const points = grid.mixed || !grid.gridSize ? 81 : grid.gridSize * grid.gridSize;
  return {
    gridText: gridText(location),
    scheduleText: describeSchedule(schedule),
    costText: `about $${(points * COST_PER_POINT).toFixed(2)}`,
  };
}

/** The keyword-level Settings dialog: read-only details, the schedule it follows, delete this keyword. */
export function keywordSettingsProps(projectId: string, location: LocationGroup, monitor: MonitorInfo): KeywordSettingsProps {
  const locationLabel = `Location ${location.number}`;
  return {
    projectId,
    locationId: location.id,
    seriesId: monitor.series_id,
    keyword: monitor.keyword,
    locationLabel,
    locationHref: locationUrl(projectId, location.id),
    details: [
      { label: 'Location', value: `${locationLabel} · ${location.name}` },
      { label: 'Google CID', value: location.cid ?? 'None (matched by name)' },
      { label: 'Grid', value: `${monitor.grid_size}×${monitor.grid_size}, ${radiusMiForSpacing(monitor.spacing_km, monitor.grid_size)} mi radius` },
      { label: 'Center', value: monitor.center },
      { label: 'Language', value: monitor.language },
    ],
    scheduleText: monitor.schedule ? describeSchedule(monitor.schedule) : 'One-time scan, not scheduled.',
    onlyKeyword: location.monitors.length === 1,
  };
}
