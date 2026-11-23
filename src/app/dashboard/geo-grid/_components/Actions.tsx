'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { Play, Plus, Settings } from 'lucide-react';
import {
  addClientAction, addKeywordAction, deleteLocationAction, runNowAction, updateScheduleAction, type ActionState,
} from '../clients/actions';
import Modal, { BTN_DANGER, BTN_PRIMARY, BTN_SECONDARY, FormMessage, INPUT, LABEL, useKeepFormAction } from './Modal';
import ScheduleFields, { type ScheduleDefaults } from './ScheduleFields';

const EMPTY: ActionState = {};

export function AddClientButton() {
  return (
    <Modal title="Add client" triggerClassName={BTN_PRIMARY} trigger={<><Plus className="h-4 w-4" aria-hidden="true" />Add client</>}>
      {() => <AddClientForm />}
    </Modal>
  );
}

function AddClientForm() {
  const [state, action, pending] = useKeepFormAction(addClientAction, EMPTY);
  return (
    <form onSubmit={action} className="flex flex-col gap-3">
      <p className="text-sm text-slate-600 dark:text-slate-400">One client per clinic website. Multi-location clinics are one client with several locations.</p>
      <div>
        <label htmlFor="client-name" className={LABEL}>Client name</label>
        <input id="client-name" name="name" required autoFocus placeholder="Example PT & Wellness" className={INPUT} />
      </div>
      <div>
        <label htmlFor="client-domain" className={LABEL}>Website domain</label>
        <input id="client-domain" name="domain" required placeholder="example-pt.com" className={INPUT} />
      </div>
      <FormMessage state={state} />
      <button type="submit" disabled={pending} className={BTN_PRIMARY}>{pending ? 'Adding…' : 'Add client'}</button>
    </form>
  );
}

export function AddKeywordButton({ projectId, locationId, locationLabel }: { projectId: string; locationId: string; locationLabel: string }) {
  return (
    <Modal title={`Add keyword to ${locationLabel}`} trigger={<><Plus className="h-4 w-4" aria-hidden="true" />Add keyword</>}>
      {() => <AddKeywordForm projectId={projectId} locationId={locationId} />}
    </Modal>
  );
}

function AddKeywordForm({ projectId, locationId }: { projectId: string; locationId: string }) {
  const [state, action, pending] = useKeepFormAction(addKeywordAction.bind(null, projectId, locationId), EMPTY);
  const formRef = useRef<HTMLFormElement>(null);
  // Clear the field after a keyword is added (an error keeps it), ready for the next one.
  useEffect(() => { if (state.message) formRef.current?.reset(); }, [state]);
  return (
    <form ref={formRef} onSubmit={action} className="flex flex-col gap-3">
      <p className="text-sm text-slate-600 dark:text-slate-400">Uses this location&apos;s grid and schedule. The first scan starts within a minute and becomes the keyword&apos;s starting point.</p>
      <div>
        <label htmlFor="new-keyword" className={LABEL}>Keyword</label>
        <input id="new-keyword" name="keyword" required autoFocus placeholder="sports physical therapy" className={INPUT} />
      </div>
      <FormMessage state={state} />
      <button type="submit" disabled={pending} className={BTN_PRIMARY}>{pending ? 'Adding…' : 'Add keyword'}</button>
    </form>
  );
}

/** Run now for one keyword (seriesId) or the whole location (null). */
export function RunNowButton({ projectId, locationId, seriesId, label }: { projectId: string; locationId: string; seriesId: string | null; label: string }) {
  const [state, setState] = useState<ActionState>(EMPTY);
  const [pending, startTransition] = useTransition();
  return (
    <div className="relative">
      <button
        type="button"
        disabled={pending}
        className={BTN_SECONDARY}
        onClick={() => startTransition(async () => setState(await runNowAction(projectId, locationId, seriesId)))}
      >
        <Play className="h-4 w-4" aria-hidden="true" />{pending ? 'Queuing…' : label}
      </button>
      {(state.error || state.message) && (
        <div className="absolute right-0 top-full z-40 mt-2 w-80">
          <FormMessage state={state} />
        </div>
      )}
    </div>
  );
}

export interface LocationSettingsProps {
  projectId: string;
  locationId: string;
  locationName: string;
  locationLabel: string;
  schedule: ScheduleDefaults | null;
  timeZone: string;
  gridText: string;
  keywordCount: number;
  oneTimeOnly: boolean;
}

export function LocationSettingsButton(props: LocationSettingsProps) {
  return (
    <Modal title={`${props.locationLabel} settings`} wide trigger={<><Settings className="h-4 w-4" aria-hidden="true" />Settings</>}>
      {() => <LocationSettings {...props} />}
    </Modal>
  );
}

function LocationSettings({ projectId, locationId, locationName, schedule, timeZone, gridText, keywordCount, oneTimeOnly }: LocationSettingsProps) {
  const [saveState, save, saving] = useKeepFormAction(updateScheduleAction.bind(null, projectId, locationId), EMPTY);
  const [deleteState, remove, deleting] = useKeepFormAction(deleteLocationAction.bind(null, projectId, locationId), EMPTY);
  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-black">Schedule</h3>
        {oneTimeOnly ? (
          <p className="text-sm text-slate-600 dark:text-slate-400">This location only has one-time scans, which are never scheduled. To track it, add it as a location on the client&apos;s page.</p>
        ) : (
          <form onSubmit={save} className="flex flex-col gap-3">
            <p className="text-sm text-slate-600 dark:text-slate-400">Applies to every scheduled keyword at this location. Changing the day or time moves the next scan.</p>
            <ScheduleFields
              defaults={schedule ?? { frequency: 'monthly', day: 15, time_of_day: '12:00', queue_mode: 'standard' }}
              timeZoneNote={`Clinic time (${timeZone})`}
            />
            <FormMessage state={saveState} />
            <button type="submit" disabled={saving} className={`${BTN_PRIMARY} self-start`}>{saving ? 'Saving…' : 'Save schedule'}</button>
          </form>
        )}
      </section>

      <section className="flex flex-col gap-1.5 border-t border-slate-100 pt-4 dark:border-slate-800">
        <h3 className="text-sm font-black">Grid</h3>
        <p className="text-sm text-slate-700 dark:text-slate-300">{gridText}</p>
        <p className="text-xs text-slate-500">The grid can&apos;t be changed: a different grid would not compare with past scans. To use a new grid, add the location again.</p>
      </section>

      <section className="flex flex-col gap-3 rounded-xl border border-red-200 p-4 dark:border-red-900">
        <h3 className="text-sm font-black text-red-800 dark:text-red-300">Delete location</h3>
        <p className="text-sm text-slate-700 dark:text-slate-300">
          Deletes all {keywordCount} {keywordCount === 1 ? 'keyword' : 'keywords'}, every past scan (the starting point too) and the schedule. This can&apos;t be undone.
        </p>
        <form onSubmit={remove} className="flex flex-col gap-2">
          <label htmlFor="confirm-delete" className={LABEL}>Type <span className="font-black">{locationName}</span> to confirm</label>
          <input id="confirm-delete" name="confirm" required autoComplete="off" className={INPUT} />
          <FormMessage state={deleteState} />
          <button type="submit" disabled={deleting} className={`${BTN_DANGER} self-start`}>{deleting ? 'Deleting…' : 'Delete location'}</button>
        </form>
      </section>
    </div>
  );
}
