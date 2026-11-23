'use client';

import { lazy, Suspense, useState } from 'react';
import type { BusinessResult } from '../../local-finder/MapPicker';
import type { ActionState } from '../clients/actions';
import { DEFAULT_GRID_SIZE, DEFAULT_RADIUS_MI, RADIUS_OPTIONS_MI, spacingKmForRadius } from '@/lib/grid-radius';
import { BTN_PRIMARY, FormMessage, INPUT, LABEL, useKeepFormAction } from './Modal';
import ScheduleFields from './ScheduleFields';

const MapPicker = lazy(() => import('../../local-finder/MapPicker'));

/** DataForSEO Standard queue, per grid point (81 points ≈ $0.10 on Nov 20, 2026). */
const COST_PER_POINT = 0.10 / 81;

/**
 * The business + map center + grid part shared by Add location and the sales demo scan.
 * mode "location": many keywords and a schedule. mode "demo": one keyword, one-time.
 */
export default function LocationForm({ mode, action, submitLabel, pendingLabel }: {
  mode: 'location' | 'demo';
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  submitLabel: string;
  pendingLabel: string;
}) {
  const [state, onSubmit, pending] = useKeepFormAction(action, {});
  const [business, setBusiness] = useState<BusinessResult | null>(null);
  const [businessName, setBusinessName] = useState('');
  const [businessCid, setBusinessCid] = useState('');
  const [center, setCenter] = useState('');
  const [gridSize, setGridSize] = useState(DEFAULT_GRID_SIZE);
  const [radiusMi, setRadiusMi] = useState<number>(DEFAULT_RADIUS_MI);
  const [keywords, setKeywords] = useState('');

  const keywordCount = mode === 'demo' ? 1 : new Set(keywords.split(/\r?\n/).map((k) => k.trim().toLowerCase()).filter(Boolean)).size;
  const cost = keywordCount * gridSize * gridSize * COST_PER_POINT;
  const gridSizes = mode === 'demo' ? [5, 7, 9] : [5, 7, 9, 11];

  return (
    <form onSubmit={onSubmit} className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
      <section className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
        <div>
          <h2 className="text-[15px] font-black">1. Business and map center</h2>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            Search for the clinic&apos;s Google listing and pick it. That drops the center pin on the clinic; click the map to move it.
          </p>
        </div>
        <Suspense fallback={<div className="h-80 animate-pulse rounded-xl bg-slate-100 dark:bg-slate-800" />}>
          <MapPicker
            coordinate={center}
            onChange={setCenter}
            showGrid={Boolean(center)}
            gridSize={gridSize}
            spacingKm={spacingKmForRadius(radiusMi, gridSize)}
            language="English"
            onBusinessSelect={(picked) => {
              setBusiness(picked); setBusinessName(picked.title); setBusinessCid(picked.cid ?? ''); setCenter(`${picked.lat},${picked.lng}`);
            }}
          />
        </Suspense>
        {business && business.title === businessName && (
          <p className="text-sm text-slate-600 dark:text-slate-400">{[business.category, business.address].filter(Boolean).join(' · ')}</p>
        )}
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_200px_220px]">
          <div>
            <label htmlFor="business_name" className={LABEL}>Business name</label>
            <input id="business_name" name="business_name" required value={businessName} onChange={(e) => setBusinessName(e.target.value)} className={INPUT} />
          </div>
          <div>
            <label htmlFor="business_cid" className={LABEL}>Google CID</label>
            <input id="business_cid" name="business_cid" inputMode="numeric" value={businessCid} onChange={(e) => setBusinessCid(e.target.value.trim())} className={INPUT} />
          </div>
          <div>
            <label htmlFor="center" className={LABEL}>Map center (lat,lng)</label>
            <input id="center" name="center" required value={center} onChange={(e) => setCenter(e.target.value.trim())} placeholder="Click the map" className={INPUT} />
          </div>
        </div>
        {!businessCid && (
          <p className="rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-sm font-semibold text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
            Pick the listing from the search, or paste its Google CID. Without a CID, ranks are matched on the name alone, which is less reliable.
          </p>
        )}
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
              <input id="keyword" name="keyword" required placeholder="physical therapy" className={INPUT} />
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
            <ScheduleFields defaults={{ frequency: 'monthly', day: 15, time_of_day: '12:00', queue_mode: 'standard' }} timeZoneNote="Clinic time, set from the map center" />
          </section>
        )}

        <div className="flex flex-col gap-2">
          <FormMessage state={state} />
          <p className="text-xs text-slate-600 dark:text-slate-400">
            {mode === 'demo'
              ? <>Runs once, right now, and is never scheduled. About <strong>${cost.toFixed(2)}</strong> in DataForSEO credit; results take a few minutes.</>
              : <>The first scan of {keywordCount || 'each'} {keywordCount === 1 ? 'keyword' : 'keywords'} starts within a minute and becomes the starting point. About <strong>${cost.toFixed(2)}</strong> per round of scans.</>}
          </p>
          <button type="submit" disabled={pending || !businessName.trim() || !center} className={BTN_PRIMARY}>{pending ? pendingLabel : submitLabel}</button>
        </div>
      </div>
    </form>
  );
}
