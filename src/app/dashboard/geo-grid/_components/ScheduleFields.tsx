'use client';

import { useState } from 'react';
import { INPUT, LABEL } from './Modal';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export interface ScheduleDefaults {
  frequency: 'daily' | 'weekly' | 'monthly';
  /** Day of week (0-6) for weekly, day of month (1-28) for monthly. */
  day: number | null;
  time_of_day: string;
  queue_mode: 'standard' | 'priority';
}

/** Frequency, day, time and queue inputs, named the way the server actions read them. */
export default function ScheduleFields({ defaults, timeZoneNote }: { defaults: ScheduleDefaults; timeZoneNote: string }) {
  const [frequency, setFrequency] = useState(defaults.frequency);
  return (
    <fieldset className="grid grid-cols-2 gap-3">
      <legend className="sr-only">Schedule</legend>
      <div>
        <label htmlFor="frequency" className={LABEL}>Runs</label>
        <select id="frequency" name="frequency" value={frequency} onChange={(e) => setFrequency(e.target.value as ScheduleDefaults['frequency'])} className={INPUT}>
          <option value="monthly">Monthly</option>
          <option value="weekly">Weekly</option>
          <option value="daily">Daily</option>
        </select>
      </div>
      {frequency === 'monthly' && (
        <div>
          <label htmlFor="day_of_month" className={LABEL}>Day of month</label>
          <select id="day_of_month" name="day_of_month" defaultValue={defaults.frequency === 'monthly' ? String(defaults.day ?? 15) : '15'} className={INPUT}>
            {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
        </div>
      )}
      {frequency === 'weekly' && (
        <div>
          <label htmlFor="weekday" className={LABEL}>Day</label>
          <select id="weekday" name="weekday" defaultValue={defaults.frequency === 'weekly' ? String(defaults.day ?? 1) : '1'} className={INPUT}>
            {WEEKDAYS.map((name, i) => <option key={name} value={i}>{name}</option>)}
          </select>
        </div>
      )}
      <div>
        <label htmlFor="time_of_day" className={LABEL}>Time</label>
        <input id="time_of_day" name="time_of_day" type="time" required defaultValue={defaults.time_of_day} className={INPUT} />
        <span className="mt-1 block text-[11px] text-slate-500">{timeZoneNote}</span>
      </div>
      <div>
        <label htmlFor="queue_mode" className={LABEL}>Queue</label>
        <select id="queue_mode" name="queue_mode" defaultValue={defaults.queue_mode} className={INPUT}>
          <option value="standard">Standard (cheaper)</option>
          <option value="priority">Priority (faster, costs more)</option>
        </select>
      </div>
    </fieldset>
  );
}
