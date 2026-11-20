import type { LocationStatus } from '@/lib/grid-locations';

const STYLES: Record<LocationStatus, string> = {
  tracking: 'text-emerald-700 bg-emerald-50 dark:bg-emerald-950 dark:text-emerald-300',
  scanning: 'text-blue-700 bg-blue-50 dark:bg-blue-950 dark:text-blue-300',
  first_scan_running: 'text-blue-700 bg-blue-50 dark:bg-blue-950 dark:text-blue-300',
  first_scan_done: 'text-violet-700 bg-violet-50 dark:bg-violet-950 dark:text-violet-300',
  waiting: 'text-slate-600 bg-slate-100',
  not_scheduled: 'text-amber-800 bg-amber-50 dark:bg-amber-950 dark:text-amber-300',
};

export default function StatusPill({ status, label }: { status: LocationStatus; label: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-bold ${STYLES[status]}`}>
      <i className="h-[7px] w-[7px] rounded-full bg-current" aria-hidden="true" />
      {label}
    </span>
  );
}
