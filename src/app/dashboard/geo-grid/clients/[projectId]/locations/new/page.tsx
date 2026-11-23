import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { DEMO_PROJECT_ID, getClient, LocationError, listLocations } from '@/lib/grid-locations-db';
import Breadcrumbs from '../../../../_components/Breadcrumbs';
import LocationForm from '../../../../_components/LocationForm';
import { CLIENTS_URL, clientUrl } from '../../../../_components/routes';
import { addLocationAction } from '../../../actions';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Add location · Geo-grid' };

export default async function NewLocationPage({ params }: { params: Promise<{ projectId: string }> }) {
  const projectId = decodeURIComponent((await params).projectId);
  if (projectId === DEMO_PROJECT_ID) notFound();
  let client;
  let count: number;
  try {
    client = getClient(projectId);
    count = listLocations(projectId).length;
  } catch (error) {
    if (error instanceof LocationError) notFound();
    throw error;
  }
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Breadcrumbs items={[{ label: 'All clients', href: CLIENTS_URL }, { label: client.name, href: clientUrl(projectId) }, { label: 'Add location' }]} />
        <h1 className="text-[28px] font-black tracking-tight">Add location {count + 1}</h1>
        <p className="text-sm text-slate-600">For <strong>{client.name}</strong> ({client.domain}). Check the client name before saving.</p>
      </div>
      <LocationForm mode="location" action={addLocationAction.bind(null, projectId)} submitLabel="Add location and start first scans" pendingLabel="Adding…"
        reviewTitle={`Add Location ${count + 1} for ${client.name} (${client.domain})?`}
      />
    </div>
  );
}
