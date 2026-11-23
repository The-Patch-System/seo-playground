import type { LocationGroup } from '@/lib/grid-locations-db';
import { sharedGridConfig, sharedSchedule } from '@/lib/grid-locations';
import { timeZoneForCenter } from '@/lib/grid-timezone';
import { DEMO_PROJECT_ID } from '@/lib/grid-locations-db';
import type { LocationSettingsProps } from './Actions';

/** What the location Settings dialog needs, from either the location page or a keyword page. */
export function locationSettingsProps(projectId: string, location: LocationGroup): LocationSettingsProps {
  const { schedule } = sharedSchedule(location.monitors);
  const grid = sharedGridConfig(location.monitors);
  return {
    projectId,
    locationId: location.id,
    locationName: location.name,
    locationLabel: `Location ${location.number}`,
    schedule: schedule
      ? { frequency: schedule.frequency, day: schedule.weekday, time_of_day: schedule.time_of_day, queue_mode: schedule.queue_mode === 'priority' ? 'priority' : 'standard' }
      : null,
    timeZone: schedule?.time_zone ?? timeZoneForCenter(location.center) ?? 'America/New_York',
    gridText: grid.mixed ? 'Mixed grids: keywords here use different grid sizes or radii.' : `${grid.gridSize}×${grid.gridSize} grid · ${grid.radiusMi} mi radius · centered at ${location.center}`,
    keywordCount: location.monitors.length,
    oneTimeOnly: projectId === DEMO_PROJECT_ID || !location.monitors.some((m) => m.schedule),
  };
}
