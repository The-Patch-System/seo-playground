'use client';

import { lazy, Suspense, useActionState, useEffect, useRef, useState, useTransition, type FormEvent } from 'react';
import type { BusinessResult } from '../../local-finder/MapPicker';
import type { ActionState } from '../clients/actions';
import { DEFAULT_GRID_SIZE, DEFAULT_RADIUS_MI, RADIUS_OPTIONS_MI, spacingKmForRadius } from '@/lib/grid-radius';
import { milesBetween, parseMapsInput } from '@/lib/maps-link';
import { BTN_PRIMARY, BTN_SECONDARY, FormMessage, INPUT, LABEL } from './Modal';
import ScheduleFields from './ScheduleFields';

const MapPicker = lazy(() => import('../../local-finder/MapPicker'));

/** DataForSEO Standard queue, per grid point (81 points ≈ $0.10 on Nov 20, 2026). */
const COST_PER_POINT = 0.10 / 81;
/** A center farther than this from the listing's pin gets a warning. */
const FAR_FROM_LISTING_MI = 0.5;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function scheduleSummary(data: FormData): string {
  const time = String(data.get('time_of_day') ?? '');
  switch (data.get('frequency')) {
    case 'weekly': return `Weekly on ${WEEKDAYS[Number(data.get('weekday'))]}s at ${time} clinic time`;
    case 'daily': return `Daily at ${time} clinic time`;
    default: return `Monthly on day ${data.get('day_of_month')} at ${time} clinic time`;
  }
}

/**
 * Business + map center + grid, shared by Add location and the sales demo scan. The business comes
 * from the Google Maps search (name, CID and pin in one pick), or a pasted Google Maps link, or by
 * hand. Saving shows a review of everything first, so a scan can't start on the wrong place by accident.
 */
export default function LocationForm({ mode, action, submitLabel, pendingLabel, reviewTitle }: {
  mode: 'location' | 'demo';
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  submitLabel: string;
  pendingLabel: string;
  /** e.g. "Add Location 2 for Example PT & Wellness?" */
  reviewTitle: string;
}) {
  const [state, dispatch, pending] = useActionState(action, {});
  const [, startTransition] = useTransition();
  const reviewRef = useRef<HTMLDivElement>(null);

  const [business, setBusiness] = useState<BusinessResult | null>(null);
  const [name, setName] = useState('');
  const [cid, setCid] = useState('');
  const [center, setCenter] = useState('');
  /** The listing's own pin, when known (search pick or a pasted listing link). */
  const [pin, setPin] = useState<string | null>(null);
  const [customCenter, setCustomCenter] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [pasteNote, setPasteNote] = useState<{ ok: boolean; text: string } | null>(null);
  /** The CID whose lookup is in flight, so a stale answer from an earlier paste is ignored. */
  const lookupCid = useRef<string | null>(null);
  const [lookingUp, setLookingUp] = useState(false);
  const [gridSize, setGridSize] = useState(DEFAULT_GRID_SIZE);
  const [radiusMi, setRadiusMi] = useState<number>(DEFAULT_RADIUS_MI);
  const [keywords, setKeywords] = useState('');
  const [review, setReview] = useState<{ data: FormData; schedule: string } | null>(null);

  const keywordList = mode === 'demo'
    ? [keywords.replace(/\s+/g, ' ').trim()].filter(Boolean)
    : [...new Map(keywords.split(/\r?\n/).map((k) => k.replace(/\s+/g, ' ').trim()).filter(Boolean).map((k) => [k.toLowerCase(), k])).values()];
  const cost = Math.max(keywordList.length, 1) * gridSize * gridSize * COST_PER_POINT;
  const gridSizes = mode === 'demo' ? [5, 7, 9] : [5, 7, 9, 11];
  const distance = pin && center ? milesBetween(pin, center) : null;
  const ready = Boolean(name.trim() && center && keywordList.length);

  useEffect(() => { if (state.error) setReview(null); }, [state]);
  useEffect(() => { if (review) reviewRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, [review]);

  function pickListing(picked: BusinessResult) {
    const at = `${picked.lat.toFixed(6)},${picked.lng.toFixed(6)}`;
    setBusiness(picked); setName(picked.title); setCid(picked.cid ?? ''); setPin(at); setCenter(at); setCustomCenter(false);
  }

  function pasteLink(text: string) {
    if (!text.trim()) { setPasteNote(null); return; }
    const info = parseMapsInput(text);
    if (!info) {
      setPasteNote({ ok: false, text: "Couldn't read that. Open the listing in Google Maps and copy the full link from the address bar (a maps.app.goo.gl short link has to be opened first)." });
      return;
    }
    setBusiness(null);
    if (info.name) setName(info.name);
    if (info.cid) setCid(info.cid);
    if (info.center) {
      setCenter(info.center);
      setPin(info.centerIsPin ? info.center : null);
      setCustomCenter(false);
    }
    const found = [info.name && 'name', info.cid && 'Google CID', info.center && (info.centerIsPin ? "the listing's pin" : 'a map center (not the pin; check it)')].filter(Boolean);
    setPasteNote({ ok: Boolean(info.cid), text: `Found ${found.join(', ')}.${info.cid ? '' : ' No CID in this link: open the listing itself (not a search) and copy that link.'}` });
    if (info.cid) void lookUpListing(info.cid, info.centerIsPin ? info.center : null);
  }

  /** Fetch the listing's address (and pin, if the link had none) by CID. About $0.01 per lookup. */
  async function lookUpListing(cidToFind: string, linkPin: string | null) {
    lookupCid.current = cidToFind;
    setLookingUp(true);
    let listing: BusinessResult | null = null;
    try {
      const res = await fetch(`/api/business-search?cid=${encodeURIComponent(cidToFind)}`);
      const data = await res.json() as { results?: BusinessResult[] };
      listing = data.results?.[0] ?? null;
    } catch { listing = null; }
    if (lookupCid.current !== cidToFind) return;
    setLookingUp(false);
    if (!listing) {
      if (!linkPin) setPasteNote({ ok: false, text: "Found the Google CID, but couldn't look up the address or pin. Wait a second for Google Maps to add the coordinates (the @… part) to the address bar, then copy the link again." });
      return;
    }
    setBusiness(listing);
    setName((current) => current.trim() || listing.title);
    if (!linkPin) {
      const at = `${listing.lat.toFixed(6)},${listing.lng.toFixed(6)}`;
      setPin(at); setCenter(at); setCustomCenter(false);
    }
  }

  function centerOnListing() {
    setCustomCenter(false);
    if (pin) setCenter(pin);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready) return;
    if (!review) {
      const data = new FormData(event.currentTarget);
      setReview({ data, schedule: mode === 'demo' ? 'One time only, never scheduled' : scheduleSummary(data) });
      return;
    }
    const data = review.data;
    startTransition(() => dispatch(data));
  }

  const centerNote = !center
    ? null
    : pin && !customCenter && center === pin
      ? "on the listing's pin"
      : distance != null
        ? `${distance.toFixed(1)} mi from the listing's pin`
        : 'entered by hand (no listing pin to compare)';

  return (
    <form onSubmit={submit} className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
      <input type="hidden" name="business_name" value={name.trim()} />
      <input type="hidden" name="business_cid" value={cid} />
      <input type="hidden" name="center" value={center} />

      <fieldset disabled={Boolean(review) || pending} className="contents">
        <section className="flex min-w-0 flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
          <div>
            <h2 className="text-[15px] font-black">1. Find the business on Google Maps</h2>
            <ol className="mt-1.5 list-decimal space-y-0.5 pl-5 text-sm text-slate-600 dark:text-slate-400">
              <li>Type the clinic&apos;s name and city (e.g. &ldquo;Elevation Athletics Physical Therapy Fort Worth&rdquo;) and press <strong>Find</strong>.</li>
              <li>Pick the right listing from the results. That fills in the name, Google CID and the grid center for you.</li>
            </ol>
          </div>
          <Suspense fallback={<div className="h-72 animate-pulse rounded-xl bg-slate-100 dark:bg-slate-800" />}>
            <MapPicker
              coordinate={center}
              onChange={(next) => { setCenter(next); if (pin) setCustomCenter(true); }}
              showGrid={Boolean(center)}
              gridSize={gridSize}
              spacingKm={spacingKmForRadius(radiusMi, gridSize)}
              language="English"
              onBusinessSelect={pickListing}
              clickToPlace={customCenter || !pin}
              crosshair
            />
          </Suspense>
          {pin ? (
            <p className="-mt-1 text-xs text-slate-500">
              {customCenter
                ? 'Click the map where the grid center should go. Drag to move the map.'
                : 'The center is locked to the listing. Drag to look around; clicks don’t move it.'}
            </p>
          ) : (
            !center && <p className="-mt-1 text-xs text-slate-500">No listing picked yet. Drag to move the map; a click places the grid center.</p>
          )}

          {name.trim() && (
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3.5 py-3 text-sm text-emerald-950 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-100">
              <p className="text-[11px] font-bold uppercase tracking-wider text-emerald-800 dark:text-emerald-300">Business to track</p>
              <p className="mt-0.5 text-base font-black">{name}</p>
              {business?.address && <p className="font-semibold text-emerald-900 dark:text-emerald-100">{business.address}</p>}
              {business?.category && <p className="text-emerald-900/80 dark:text-emerald-200/80">{business.category}</p>}
              {!business?.address && lookingUp && <p className="text-emerald-900/80 dark:text-emerald-200/80">Looking up the address…</p>}
              <p className="mt-1 text-xs">
                Google CID: {cid ? <strong>{cid}</strong> : <strong className="text-amber-700 dark:text-amber-300">missing</strong>}
                {center && <> · Grid center: <strong>{center}</strong> ({centerNote})</>}
              </p>
            </div>
          )}

          {pin && (
            <fieldset className="flex flex-col gap-1.5 text-sm">
              <legend className={LABEL}>Grid center</legend>
              <label className="flex items-center gap-2">
                <input type="radio" name="center_mode" checked={!customCenter} onChange={centerOnListing} />
                On the listing&apos;s pin <span className="text-xs text-slate-500">(recommended, and what Semrush uses)</span>
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" name="center_mode" checked={customCenter} onChange={() => setCustomCenter(true)} />
                Somewhere else: I&apos;ll click the map
              </label>
            </fieldset>
          )}
          {customCenter && distance != null && distance > FAR_FROM_LISTING_MI && (
            <p role="alert" className="rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-sm font-semibold text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
              The center is {distance.toFixed(1)} mi from the listing. Grids are almost always centered on the clinic, so make sure this is on purpose.
            </p>
          )}
          {name.trim() && !cid && (
            <p className="rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-sm font-semibold text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
              No Google CID. Ranks will be matched on the name alone, which can miss or mix up listings. Pick the listing from the search, or paste its Google Maps link below.
            </p>
          )}

          <details open={manualOpen} onToggle={(e) => setManualOpen((e.currentTarget as HTMLDetailsElement).open)} className="rounded-xl border border-slate-200 dark:border-slate-700">
            <summary className="cursor-pointer px-3.5 py-2.5 text-sm font-bold text-slate-700 dark:text-slate-300">Can&apos;t find it in the search? Paste its Google Maps link, or enter it by hand</summary>
            <div className="flex flex-col gap-3 border-t border-slate-200 p-3.5 dark:border-slate-700">
              <div>
                <label htmlFor="maps_link" className={LABEL}>Google Maps link</label>
                <input
                  id="maps_link" placeholder="https://www.google.com/maps/place/…" autoComplete="off" className={INPUT}
                  onChange={(e) => pasteLink(e.target.value)}
                />
                <span className="mt-1 block text-[11px] text-slate-500">Open the clinic&apos;s listing on Google Maps, then copy the link from the address bar. It holds the CID and the pin.</span>
                {pasteNote && <p className={`mt-1.5 text-xs font-semibold ${pasteNote.ok ? 'text-emerald-700 dark:text-emerald-300' : 'text-amber-700 dark:text-amber-300'}`}>{pasteNote.text}</p>}
              </div>
              <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_190px_200px]">
                <div>
                  <label htmlFor="business_name_input" className={LABEL}>Business name</label>
                  <input id="business_name_input" value={name} onChange={(e) => { setName(e.target.value); setBusiness(null); }} className={INPUT} />
                </div>
                <div>
                  <label htmlFor="business_cid_input" className={LABEL}>Google CID</label>
                  <input id="business_cid_input" inputMode="numeric" value={cid} onChange={(e) => setCid(e.target.value.replace(/\D/g, ''))} className={INPUT} />
                </div>
                <div>
                  <label htmlFor="center_input" className={LABEL}>Grid center (lat,lng)</label>
                  <input id="center_input" value={center} onChange={(e) => { setCenter(e.target.value.trim()); if (pin) setCustomCenter(true); }} placeholder="39.740123,-104.987654" className={INPUT} />
                </div>
              </div>
            </div>
          </details>
        </section>

        <div className="flex flex-col gap-5">
          <section className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
            <h2 className="text-[15px] font-black">2. Grid</h2>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="grid_size" className={LABEL}>Grid</label>
                <select id="grid_size" name="grid_size" value={gridSize} onChange={(e) => setGridSize(Number(e.target.value))} className={INPUT}>
                  {gridSizes.map((n) => <option key={n} value={n}>{n}×{n} ({n * n} points)</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="radius_mi" className={LABEL}>Radius</label>
                <select id="radius_mi" name="radius_mi" value={radiusMi} onChange={(e) => setRadiusMi(Number(e.target.value))} className={INPUT}>
                  {RADIUS_OPTIONS_MI.map((mi) => <option key={mi} value={mi}>{mi} mi</option>)}
                </select>
              </div>
            </div>
            {mode === 'location' && <p className="text-xs text-slate-500">The grid can&apos;t be changed later without losing comparisons, so match the client&apos;s Semrush grid if they had one.</p>}
          </section>

          <section className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
            <h2 className="text-[15px] font-black">3. {mode === 'demo' ? 'Keyword' : 'Keywords'}</h2>
            {mode === 'demo' ? (
              <div>
                <label htmlFor="keyword" className={LABEL}>Keyword</label>
                <input id="keyword" name="keyword" required value={keywords} onChange={(e) => setKeywords(e.target.value)} placeholder="physical therapy" className={INPUT} />
              </div>
            ) : (
              <div>
                <label htmlFor="keywords" className={LABEL}>One per line (up to 25)</label>
                <textarea
                  id="keywords" name="keywords" required rows={5} value={keywords} onChange={(e) => setKeywords(e.target.value)}
                  placeholder={'physical therapy\nphysical therapist near me\ndry needling'} className={`${INPUT} py-2`}
                />
              </div>
            )}
          </section>

          {mode === 'location' && (
            <section className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
              <h2 className="text-[15px] font-black">4. Schedule</h2>
              <ScheduleFields defaults={{ frequency: 'monthly', day: 15, time_of_day: '12:00', queue_mode: 'standard' }} timeZoneNote="Clinic time, set from the grid center" />
            </section>
          )}

          {!review && (
            <div className="flex flex-col gap-2">
              <FormMessage state={state} />
              {!ready && (
                <p className="text-xs text-slate-500">
                  Still needed: {[!name.trim() && 'the business', !center && 'the grid center', !keywordList.length && (mode === 'demo' ? 'a keyword' : 'at least one keyword')].filter(Boolean).join(', ')}.
                </p>
              )}
              <button type="submit" disabled={!ready} className={BTN_PRIMARY}>Review before {mode === 'demo' ? 'running' : 'saving'}</button>
            </div>
          )}
        </div>
      </fieldset>

      {review && (
        <div ref={reviewRef} role="region" aria-label="Review" className="rounded-2xl border-2 border-blue-300 bg-blue-50 p-5 text-sm text-blue-950 lg:col-span-2 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-100">
          <p className="text-lg font-black">{reviewTitle}</p>
          <dl className="mt-3 grid grid-cols-[150px_minmax(0,1fr)] gap-x-4 gap-y-1.5">
            <dt className="font-bold">Business</dt><dd>{name.trim()}</dd>
            <dt className="font-bold">Address</dt><dd>{business?.address || <span className="text-blue-900/70 dark:text-blue-200/70">Not known (entered by hand). Check the center on the map.</span>}</dd>
            <dt className="font-bold">Google CID</dt><dd>{cid || <span className="font-bold text-amber-700 dark:text-amber-300">None: matched by name only</span>}</dd>
            <dt className="font-bold">Grid center</dt><dd>{center} ({centerNote})</dd>
            <dt className="font-bold">Grid</dt><dd>{gridSize}×{gridSize}, {radiusMi} mi radius ({gridSize * gridSize} points)</dd>
            <dt className="font-bold">{keywordList.length === 1 ? 'Keyword' : `Keywords (${keywordList.length})`}</dt><dd>{keywordList.join(', ')}</dd>
            <dt className="font-bold">Schedule</dt><dd>{review.schedule}</dd>
            <dt className="font-bold">Cost</dt>
            <dd>
              {mode === 'demo'
                ? <>Runs right away: about <strong>${cost.toFixed(2)}</strong>. Results take 5–10 minutes.</>
                : <>The first {keywordList.length === 1 ? 'scan starts' : `${keywordList.length} scans start`} right away and become the starting point: about <strong>${cost.toFixed(2)}</strong>, then the same each scheduled run.</>}
            </dd>
          </dl>
          <div className="mt-3"><FormMessage state={state} /></div>
          <div className="mt-4 flex flex-wrap gap-2">
            <button type="submit" disabled={pending} className={BTN_PRIMARY}>{pending ? pendingLabel : submitLabel}</button>
            <button type="button" disabled={pending} onClick={() => setReview(null)} className={BTN_SECONDARY}>Back to edit</button>
          </div>
        </div>
      )}
    </form>
  );
}
