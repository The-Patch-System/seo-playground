'use client';

// Gear button + native <dialog> holding the monitor's schedule and delete controls,
// so they stay out of the way of the daily "check the latest map" flow.
import { useId, useRef } from 'react';
import { Settings, X } from 'lucide-react';
import type { GridSchedule } from '@/lib/db';
import GridScheduleControl from './GridScheduleControl';
import DeleteMonitorButton from './DeleteMonitorButton';

export default function GridSettingsDialog({ runId, schedule }: { runId: string; schedule: GridSchedule | null }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const close = () => dialogRef.current?.close();

  return (
    <>
      <button
        type="button"
        onClick={() => dialogRef.current?.showModal()}
        aria-haspopup="dialog"
        aria-label="Monitor settings"
        title="Monitor settings"
        className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-500 transition-colors hover:bg-slate-50 hover:text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-white"
      >
        <Settings className="h-4 w-4" aria-hidden />
      </button>
      <dialog
        ref={dialogRef}
        aria-labelledby={titleId}
        // A click on the backdrop lands on the <dialog> element itself; clicks inside land on its content.
        onClick={(event) => { if (event.target === event.currentTarget) close(); }}
        // Close once a form inside is submitted (the server action then refreshes the page).
        // The delete form cancels its own submit when the confirm prompt is dismissed.
        onSubmit={(event) => { if (!event.defaultPrevented) close(); }}
        className="m-auto max-h-[calc(100vh-2rem)] w-[min(32rem,calc(100vw-2rem))] overflow-y-auto rounded-2xl border border-slate-200 bg-white p-0 text-slate-900 shadow-2xl backdrop:bg-slate-950/50 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-100"
      >
        <div className="p-5">
          <div className="flex items-center justify-between gap-3">
            <h2 id={titleId} className="text-base font-black text-slate-900 dark:text-white">Monitor settings</h2>
            <button
              type="button"
              onClick={close}
              aria-label="Close settings"
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          </div>

          <div className="mt-5">
            <GridScheduleControl runId={runId} schedule={schedule} />
          </div>

          <div className="mt-5 flex items-center justify-between gap-4 border-t border-slate-100 pt-5 dark:border-slate-800">
            <p className="text-xs text-slate-500 dark:text-slate-400">Deletes every scan of this monitor and its schedule. Cannot be undone.</p>
            <DeleteMonitorButton runId={runId} />
          </div>
        </div>
      </dialog>
    </>
  );
}
