import type { Metadata } from 'next';
import Breadcrumbs from '../../_components/Breadcrumbs';
import LocationForm from '../../_components/LocationForm';
import { CLIENTS_URL } from '../../_components/routes';
import { demoScanAction } from '../actions';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Sales demo scan · Geo-grid' };

export default function DemoScanPage() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Breadcrumbs items={[{ label: 'All clients', href: CLIENTS_URL }, { label: 'Sales demo scan' }]} />
        <h1 className="text-[28px] font-black tracking-tight">Sales demo scan</h1>
        <p className="max-w-2xl text-sm text-slate-600">
          A one-time scan for a prospect. It runs right away, is saved under Sales demos, and is never scheduled or billed again.
          For a signed client, add the client and a location instead.
        </p>
      </div>
      <LocationForm mode="demo" action={demoScanAction} submitLabel="Run demo scan" pendingLabel="Starting scan…" />
    </div>
  );
}
