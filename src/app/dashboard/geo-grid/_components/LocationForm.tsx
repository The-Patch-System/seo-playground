'use client';

import { lazy, Suspense, useActionState, useEffect, useRef, useState, useTransition, type FormEvent } from 'react';
import type { BusinessResult } from '../../local-finder/MapPicker';
import type { ActionState } from '../clients/actions';
import { DEFAULT_GRID_SIZE, DEFAULT_RADIUS_MI, RADIUS_OPTIONS_MI, spacingKmForRadius } from '@/lib/grid-radius';
import { isShortMapsLink, parseMapsInput } from '@/lib/maps-link';
import { BTN_PRIMARY, BTN_SECONDARY, FormMessage, INPUT, LABEL } from './Modal';
import ScheduleFields from './ScheduleFields';

const MapPicker = lazy(() => import('../../local-finder/MapPicker'));

/** DataForSEO Standard queue, per grid point (81 points ≈ $0.10 on Nov 20, 2026). */
const COST_PER_POINT = 0.10 / 81;
/** A Google CID is a long number; shorter input is still being typed. */
const MIN_CID_DIGITS = 10;
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
 *
 * The grid center is always the listing's own pin (Brad, Nov 23): there is no way to place it
 * anywhere else. A CID without a pin (typed by hand, or a link without the @… coordinates) is looked
 * up in DataForSEO Business Listings to get the pin.
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
  /** The listing's own pin, which is always the grid center. Empty until a listing is known. */
  const [center, setCenter] = useState('');
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
  const ready = Boolean(name.trim() && center && keywordList.length);

  useEffect(() => { if (state.error) setReview(null); }, [state]);
  useEffect(() => { if (review) reviewRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, [review]);

  function pickListing(picked: BusinessResult) {
    const at = `${picked.lat.toFixed(6)},${picked.lng.toFixed(6)}`;
    lookupCid.current = null; setLookingUp(false);
    setBusiness(picked); setName(picked.title); setCid(picked.cid ?? ''); setCenter(at);
  }

  /** The link being expanded, so a slow answer for an older paste is ignored. */
  const expandingLink = useRef<string | null>(null);

  function pasteLink(text: string) {
    if (!text.trim()) { expandingLink.current = null; setPasteNote(null); return; }
    // A Share link (maps.app.goo.gl) has no CID or pin in it: the server expands it to the full link first.
    if (isShortMapsLink(text)) { void expandShareLink(text.trim()); return; }
    expandingLink.current = null;
    readLink(text);
  }

  async function expandShareLink(link: string) {
    expandingLink.current = link;
    setPasteNote({ ok: true, text: 'Opening the share link…' });
    let url: string | null = null;
    let error = "Couldn't open that share link. Open it in Google Maps and copy the link from the address bar instead.";
    try {
      const res = await fetch(`/api/maps-link?url=${encodeURIComponent(link)}`);
      const data = await res.json() as { url?: string; error?: string };
      url = data.url ?? null;
      if (data.error) error = data.error;
    } catch { url = null; }
    if (expandingLink.current !== link) return;
    expandingLink.current = null;
    if (!url) { setPasteNote({ ok: false, text: error }); return; }
    readLink(url);
  }

  function readLink(text: string) {
    const info = parseMapsInput(text);
    if (!info) {
      setPasteNote({ ok: false, text: "Couldn't read that. Open the listing in Google Maps and copy the full link from the address bar, or its Share link." });
      return;
    }
    setBusiness(null);
    // A link without a name clears the previous listing's name; the CID lookup fills it back in.
    setName(info.name ?? '');
    if (info.cid) setCid(info.cid);
    // Only the listing's own pin can be the center. A link's map view (no pin) is ignored, and the
    // previous listing's center is cleared so it can't stay on the new business by mistake.
    const linkPin = info.center && info.centerIsPin ? info.center : null;
    setCenter(linkPin ?? '');
    const found = [info.name && 'name', info.cid && 'Google CID', linkPin && "the listing's pin"].filter(Boolean);
    setPasteNote({ ok: Boolean(info.cid), text: `${found.length ? `Found ${found.join(', ')}.` : 'No listing in that.'}${info.cid ? '' : ' Open the listing itself on Google Maps (not a search or a spot on the map) and copy that link.'}` });
    if (info.cid) void lookUpListing(info.cid, linkPin);
    else lookupCid.current = null;
  }

  /** A CID typed by hand: look up its listing for the address and pin (the center). */
  function lookUpTypedCid() {
    if (cid.length < MIN_CID_DIGITS || cid === business?.cid || cid === lookupCid.current) return;
    setBusiness(null);
    setName('');
    setCenter('');
    void lookUpListing(cid, null);
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
      if (!linkPin) setPasteNote({ ok: false, text: "Couldn't look up this CID's address or pin, so there's no grid center yet. Check the CID, or paste the listing's Google Maps link once Google Maps has added the coordinates (the @… part) to the address bar." });
      return;
    }
    setBusiness(listing);
    setName((current) => current.trim() || listing.title);
    if (!linkPin) setCenter(`${listing.lat.toFixed(6)},${listing.lng.toFixed(6)}`);
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

  return (
    <form onSubmit={submit} className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
      <input type="hidden" name="business_name" value={name.trim()} />
      <input type="hidden" name="business_cid" value={cid} />
      <input type="hidden" name="center" value={center} />
      {/* The picked listing's address, saved with the location (shown on its pages). Only when it is the same listing. */}
      <input type="hidden" name="business_address" value={business?.cid && business.cid === cid ? business.address ?? '' : ''} />

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
              // The center only comes from a picked listing (onBusinessSelect); clicks and plain
              // address results never set it.
              onChange={() => {}}
              showGrid={Boolean(center)}
              gridSize={gridSize}
              spacingKm={spacingKmForRadius(radiusMi, gridSize)}
              language="English"
              onBusinessSelect={pickListing}
              clickToPlace={false}
            />
          </Suspense>
          <p className="-mt-1 text-xs text-slate-500">
            {center
              ? 'The grid center is locked to the listing’s pin. Drag to look around.'
              : 'No listing picked yet. The grid center is set from the listing’s pin.'}
          </p>

          {name.trim() && (
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3.5 py-3 text-sm text-emerald-950 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-100">
              <p className="text-[11px] font-bold uppercase tracking-wider text-emerald-800 dark:text-emerald-300">Business to track</p>
              <p className="mt-0.5 text-base font-black">{name}</p>
              {business?.address && <p className="font-semibold text-emerald-900 dark:text-emerald-100">{business.address}</p>}
              {business?.category && <p className="text-emerald-900/80 dark:text-emerald-200/80">{business.category}</p>}
              {!business?.address && lookingUp && <p className="text-emerald-900/80 dark:text-emerald-200/80">Looking up the address…</p>}
              <p className="mt-1 text-xs">
                Google CID: {cid ? <strong>{cid}</strong> : <strong className="text-amber-700 dark:text-amber-300">missing</strong>}
                {center && <> · Grid center: <strong>{center}</strong> (the listing&apos;s pin)</>}
              </p>
            </div>
          )}

          {name.trim() && !cid && (
            <p className="rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-sm font-semibold text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
              No Google CID. Ranks will be matched on the name alone, which can miss or mix up listings. Pick the listing from the search, or paste its Google Maps link below.
            </p>
          )}

          <details open={manualOpen} onToggle={(e) => setManualOpen((e.currentTarget as HTMLDetailsElement).open)} className="rounded-xl border border-slate-200 dark:border-slate-700">
            <summary className="cursor-pointer px-3.5 py-2.5 text-sm font-bold text-slate-700 dark:text-slate-300">Can&apos;t find it in the search? Paste its Google Maps link, or enter its CID</summary>
            <div className="flex flex-col gap-3 border-t border-slate-200 p-3.5 dark:border-slate-700">
              <div>
                <label htmlFor="maps_link" className={LABEL}>Google Maps link</label>
                <input
                  id="maps_link" placeholder="https://www.google.com/maps/place/…" autoComplete="off" className={INPUT}
                  onChange={(e) => pasteLink(e.target.value)}
                />
                <span className="mt-1 block text-[11px] text-slate-500">Open the clinic&apos;s listing on Google Maps, then copy the link from the address bar or the Share button. It holds the CID and the pin.</span>
                {pasteNote && <p className={`mt-1.5 text-xs font-semibold ${pasteNote.ok ? 'text-emerald-700 dark:text-emerald-300' : 'text-amber-700 dark:text-amber-300'}`}>{pasteNote.text}</p>}
              </div>
              <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_200px]">
                <div>
                  <label htmlFor="business_name_input" className={LABEL}>Business name</label>
                  <input id="business_name_input" value={name} onChange={(e) => setName(e.target.value)} className={INPUT} />
                </div>
                <div>
                  <label htmlFor="business_cid_input" className={LABEL}>Google CID</label>
                  <input
                    id="business_cid_input" inputMode="numeric" value={cid}
                    onChange={(e) => setCid(e.target.value.replace(/\D/g, ''))}
                    onBlur={lookUpTypedCid}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); lookUpTypedCid(); } }}
                    className={INPUT}
                  />
                </div>
              </div>
              <span className="-mt-1 text-[11px] text-slate-500">A typed CID is looked up for the address and the pin, which becomes the grid center (about $0.01).</span>
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
            <dt className="font-bold">Address</dt><dd>{business?.address || <span className="text-blue-900/70 dark:text-blue-200/70">Not known. The center is the pin from the pasted link; check it on the map.</span>}</dd>
            <dt className="font-bold">Google CID</dt><dd>{cid || <span className="font-bold text-amber-700 dark:text-amber-300">None: matched by name only</span>}</dd>
            <dt className="font-bold">Grid center</dt><dd>{center} (the listing&apos;s pin)</dd>
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
