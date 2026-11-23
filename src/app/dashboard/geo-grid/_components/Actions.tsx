'use client';

import { useActionState, useEffect, useState, useTransition, type FormEvent } from 'react';
import { Play, Plus, Settings } from 'lucide-react';
import {
  addClientAction, addKeywordAction, deleteKeywordAction, deleteLocationAction, runNowAction, updateScheduleAction, type ActionState,
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

/** What adding a keyword will do, shown on the review step. */
export interface AddKeywordSummary {
  gridText: string;
  scheduleText: string;
  costText: string;
}

export function AddKeywordButton({ projectId, locationId, locationLabel, summary }: {
  projectId: string; locationId: string; locationLabel: string; summary: AddKeywordSummary;
}) {
  return (
    <Modal title={`Add keyword to ${locationLabel}`} trigger={<><Plus className="h-4 w-4" aria-hidden="true" />Add keyword</>}>
      {() => <AddKeywordForm projectId={projectId} locationId={locationId} locationLabel={locationLabel} summary={summary} />}
    </Modal>
  );
}

function AddKeywordForm({ projectId, locationId, locationLabel, summary }: {
  projectId: string; locationId: string; locationLabel: string; summary: AddKeywordSummary;
}) {
  const [state, dispatch, pending] = useActionState(addKeywordAction.bind(null, projectId, locationId), EMPTY);
  const [, startTransition] = useTransition();
  const [keyword, setKeyword] = useState('');
  const [reviewing, setReviewing] = useState(false);
  const trimmed = keyword.replace(/\s+/g, ' ').trim();

  // After a keyword is added, clear the field for the next one; an error goes back to editing.
  useEffect(() => {
    if (state.message) { setKeyword(''); setReviewing(false); }
    if (state.error) setReviewing(false);
  }, [state]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!trimmed) return;
    if (!reviewing) { setReviewing(true); return; }
    const formData = new FormData();
    formData.set('keyword', trimmed);
    startTransition(() => dispatch(formData));
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      {!reviewing ? (
        <>
          <div>
            <label htmlFor="new-keyword" className={LABEL}>Keyword</label>
            <input id="new-keyword" value={keyword} onChange={(e) => setKeyword(e.target.value)} required autoFocus placeholder="sports physical therapy" className={INPUT} />
          </div>
          <FormMessage state={state} />
          <button type="submit" disabled={!trimmed} className={BTN_PRIMARY}>Review</button>
        </>
      ) : (
        <>
          <div className="rounded-xl border border-blue-200 bg-blue-50 p-3.5 text-sm text-blue-950 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-100">
            <p className="font-black">Add &ldquo;{trimmed}&rdquo; to {locationLabel}?</p>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              <li>Same grid as the location: {summary.gridText}.</li>
              <li>The first scan <strong>starts right away</strong> ({summary.costText}) and becomes this keyword&apos;s starting point.</li>
              <li>After that it runs with the location&apos;s other keywords: {summary.scheduleText}.</li>
            </ul>
          </div>
          <div className="flex gap-2">
            <button type="submit" disabled={pending} className={BTN_PRIMARY}>{pending ? 'Adding…' : 'Add keyword and start scan'}</button>
            <button type="button" disabled={pending} onClick={() => setReviewing(false)} className={BTN_SECONDARY}>Back</button>
          </div>
        </>
      )}
    </form>
  );
}

/**
 * Type-to-confirm, then "Are you sure?": a delete needs the exact name and a second, deliberate click.
 * The server checks the typed name again.
 */
function DeleteConfirm({ expected, what, detail, action }: {
  expected: string;
  /** e.g. "location", "keyword" */
  what: string;
  detail: string;
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
}) {
  const [state, dispatch, pending] = useActionState(action, EMPTY);
  const [, startTransition] = useTransition();
  const [typed, setTyped] = useState('');
  const [armed, setArmed] = useState(false);
  const matches = typed.trim().toLowerCase() === expected.trim().toLowerCase();
  const inputId = `confirm-delete-${what}`;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!matches) return;
    if (!armed) { setArmed(true); return; }
    const formData = new FormData();
    formData.set('confirm', typed);
    startTransition(() => dispatch(formData));
  };

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-red-200 p-4 dark:border-red-900">
      <h3 className="text-sm font-black text-red-800 dark:text-red-300">Delete {what}</h3>
      <p className="text-sm text-slate-700 dark:text-slate-300">{detail} This can&apos;t be undone.</p>
      <form onSubmit={submit} className="flex flex-col gap-2">
        <label htmlFor={inputId} className={LABEL}>Type <span className="font-black">{expected}</span> to confirm</label>
        <input id={inputId} value={typed} onChange={(e) => { setTyped(e.target.value); setArmed(false); }} autoComplete="off" className={INPUT} />
        <FormMessage state={state} />
        {!armed ? (
          <button type="submit" disabled={!matches} className={`${BTN_DANGER} self-start`}>Delete {what}</button>
        ) : (
          <div role="alertdialog" aria-label={`Confirm deleting this ${what}`} className="flex flex-col gap-2 rounded-xl bg-red-50 p-3 dark:bg-red-950">
            <p className="text-sm font-black text-red-900 dark:text-red-200">Are you sure? This permanently deletes the {what} and its scan history.</p>
            <div className="flex gap-2">
              <button type="submit" disabled={pending} autoFocus className={BTN_DANGER}>{pending ? 'Deleting…' : 'Yes, delete permanently'}</button>
              <button type="button" disabled={pending} onClick={() => setArmed(false)} className={BTN_SECONDARY}>Cancel</button>
            </div>
          </div>
        )}
      </form>
    </section>
  );
}

export interface KeywordSettingsProps {
  projectId: string;
  locationId: string;
  seriesId: string;
  keyword: string;
  locationLabel: string;
  locationHref: string;
  details: Array<{ label: string; value: string }>;
  scheduleText: string;
  onlyKeyword: boolean;
}

export function KeywordSettingsButton(props: KeywordSettingsProps) {
  return (
    <Modal title="Keyword settings" wide trigger={<><Settings className="h-4 w-4" aria-hidden="true" />Settings</>}>
      {() => (
        <div className="flex flex-col gap-5">
          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-black">&ldquo;{props.keyword}&rdquo;</h3>
            <dl className="grid grid-cols-[140px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm">
              {props.details.map((d) => (
                <div key={d.label} className="contents">
                  <dt className="font-bold text-slate-600 dark:text-slate-400">{d.label}</dt>
                  <dd className="break-words text-slate-900 dark:text-slate-100">{d.value}</dd>
                </div>
              ))}
            </dl>
          </section>
          <section className="flex flex-col gap-1.5 border-t border-slate-100 pt-4 dark:border-slate-800">
            <h3 className="text-sm font-black">Schedule</h3>
            <p className="text-sm text-slate-700 dark:text-slate-300">{props.scheduleText}</p>
            <p className="text-xs text-slate-500">
              Keywords at a location run together, so the schedule is set for the whole location.{' '}
              <a href={props.locationHref} className="font-bold text-blue-600 hover:text-blue-800">Change it in {props.locationLabel} settings</a>
            </p>
          </section>
          <DeleteConfirm
            expected={props.keyword}
            what="keyword"
            detail={`Deletes "${props.keyword}" from ${props.locationLabel}, with every past scan (the starting point too) and its schedule.${props.onlyKeyword ? ` It's the only keyword here, so ${props.locationLabel} goes away too.` : ''}`}
            action={deleteKeywordAction.bind(null, props.projectId, props.locationId, props.seriesId)}
          />
        </div>
      )}
    </Modal>
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

      <DeleteConfirm
        expected={locationName}
        what="location"
        detail={`Deletes all ${keywordCount} ${keywordCount === 1 ? 'keyword' : 'keywords'} at this location, every past scan (the starting points too) and the schedule.`}
        action={deleteLocationAction.bind(null, projectId, locationId)}
      />
    </div>
  );
}
