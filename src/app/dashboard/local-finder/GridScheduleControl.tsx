'use client';

import { useEffect, useState } from 'react';
import { CalendarClock } from 'lucide-react';
import type { GridSchedule } from '@/lib/db';
import { updateGridSchedule } from '../geo-grid/actions';

const days = [
  ['Sunday', 0], ['Monday', 1], ['Tuesday', 2], ['Wednesday', 3], ['Thursday', 4], ['Friday', 5], ['Saturday', 6],
] as const;

export default function GridScheduleControl({ runId, schedule }: { runId: string; schedule: GridSchedule | null }) {
  const [frequency, setFrequency] = useState<'off' | 'daily' | 'weekly' | 'monthly'>(schedule?.frequency ?? 'off');
  const [timeZone, setTimeZone] = useState(schedule?.time_zone ?? 'UTC');

  useEffect(() => {
    if (!schedule) setTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  }, [schedule]);

  return (
    <form action={updateGridSchedule}>
      <input type="hidden" name="run_id" value={runId} />
      <input type="hidden" name="time_zone" value={timeZone} />
      <div className="flex items-center justify-between gap-4">
        <p className="inline-flex items-center gap-2 text-sm font-black text-slate-900 dark:text-white">
          <CalendarClock className="h-4 w-4 text-blue-600 dark:text-blue-400" aria-hidden />
          Automatic scans
        </p>
        {schedule && (
          <span className="shrink-0 text-xs tabular-nums text-slate-500 dark:text-slate-400">
            Next {new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: schedule.time_zone }).format(new Date(schedule.next_run_at))}
          </span>
        )}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <select name="frequency" aria-label="How often" value={frequency} onChange={(event) => setFrequency(event.target.value as 'off' | 'daily' | 'weekly' | 'monthly')} className="rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-sm font-semibold text-slate-700 outline-none focus:border-blue-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200">
          <option value="off">Not scheduled</option>
          <option value="daily">Every day</option>
          <option value="weekly">Every week</option>
          <option value="monthly">Every month</option>
        </select>
        <input name="time_of_day" aria-label="Time of day" type="time" defaultValue={schedule?.time_of_day ?? '08:00'} disabled={frequency === 'off'} className="rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-sm font-semibold text-slate-700 outline-none focus:border-blue-500 disabled:opacity-40 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200" />
        {frequency === 'monthly' ? (
          <select name="day_of_month" aria-label="Day of month" defaultValue={schedule?.frequency === 'monthly' ? (schedule.weekday ?? 15) : 15} className="rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-sm font-semibold text-slate-700 outline-none focus:border-blue-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200">
            {Array.from({ length: 28 }, (_, i) => i + 1).map((day) => <option key={day} value={day}>Day {day}</option>)}
          </select>
        ) : (
          <select name="weekday" aria-label="Day of week" defaultValue={schedule?.frequency === 'weekly' ? (schedule.weekday ?? 1) : 1} disabled={frequency !== 'weekly'} className="rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-sm font-semibold text-slate-700 outline-none focus:border-blue-500 disabled:opacity-40 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200">
            {days.map(([label, value]) => <option key={value} value={value}>{label}</option>)}
          </select>
        )}
        <select name="queue_mode" aria-label="Queue" defaultValue={schedule?.queue_mode ?? 'standard'} disabled={frequency === 'off'} className="rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-sm font-semibold text-slate-700 outline-none focus:border-blue-500 disabled:opacity-40 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200">
          <option value="standard">Standard queue</option>
          <option value="priority">Priority queue</option>
        </select>
      </div>
      <div className="mt-3 flex items-center justify-between gap-3">
        <p className="text-xs text-slate-500 dark:text-slate-400">{timeZone.replace(/_/g, ' ')} · Requires the configured cron endpoint.</p>
        <button type="submit" className="shrink-0 rounded-xl bg-blue-600 px-3 py-2 text-xs font-bold text-white transition-colors hover:bg-blue-700">
          {frequency === 'off' ? 'Save' : 'Save schedule'}
        </button>
      </div>
    </form>
  );
}
