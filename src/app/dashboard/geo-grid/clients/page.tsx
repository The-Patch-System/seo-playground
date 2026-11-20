import Link from 'next/link';
import type { Metadata } from 'next';
import { listClients } from '@/lib/grid-locations-db';
import { formatScanDate } from '@/lib/grid-locations';
import Breadcrumbs from '../_components/Breadcrumbs';
import { clientUrl } from '../_components/routes';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Geo-grid clients' };

export default async function GeoGridClientsPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q = '' } = await searchParams;
  const needle = q.trim().toLowerCase();
  const all = listClients();
  const clients = needle
    ? all.filter((c) => `${c.project.name} ${c.project.domain}`.toLowerCase().includes(needle))
    : all;
  // Clients span time zones, so this list shows Eastern time; client and location pages use clinic time.
  const tz = 'America/New_York';

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Breadcrumbs items={[{ label: 'All clients' }]} />
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-[28px] font-black tracking-tight">Geo-grid clients</h1>
            <p className="mt-1 text-sm text-slate-600">
              {all.length} clients · {all.reduce((s, c) => s + c.locations, 0)} locations · {all.reduce((s, c) => s + c.keywords, 0)} keywords tracked
            </p>
          </div>
          <form role="search" className="flex gap-2" action="">
            <label htmlFor="client-search" className="sr-only">Search clients</label>
            <input
              id="client-search" name="q" defaultValue={q} placeholder="Search clients"
              className="min-h-10 w-64 max-w-full rounded-xl border border-slate-300 bg-white px-3 text-sm"
            />
            <button type="submit" className="min-h-10 rounded-xl border border-slate-300 bg-white px-3.5 text-[13px] font-bold">Search</button>
          </form>
        </div>
      </div>

      <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="bg-slate-50 text-left text-[11px] font-bold uppercase tracking-wider text-slate-500">
                <th scope="col" className="px-5 py-2">Client</th>
                <th scope="col" className="px-3 py-2">Locations</th>
                <th scope="col" className="px-3 py-2">Keywords</th>
                <th scope="col" className="px-3 py-2">Last scan</th>
                <th scope="col" className="px-3 py-2">Next scan</th>
              </tr>
            </thead>
            <tbody>
              {clients.map((c) => (
                <tr key={c.project.id} className="border-t border-slate-100 hover:bg-slate-50">
                  <td className="px-5 py-3">
                    <Link href={clientUrl(c.project.id)} className="font-bold text-slate-900 hover:text-blue-700">{c.project.name}</Link>
                    <span className="block text-xs text-slate-500">{c.project.domain}</span>
                  </td>
                  <td className="px-3 py-3 tabular-nums">{c.locations}</td>
                  <td className="px-3 py-3 tabular-nums">
                    {c.keywords}
                    {c.scanning > 0 && <span className="ml-2 rounded-full bg-blue-50 px-2 py-0.5 text-xs font-bold text-blue-700 dark:bg-blue-950 dark:text-blue-300">{c.scanning} scanning</span>}
                  </td>
                  <td className="px-3 py-3 text-slate-600">{c.lastScanAt ? formatScanDate(c.lastScanAt, tz) : 'No scans yet'}</td>
                  <td className="px-3 py-3 text-slate-600">{c.nextScanAt ? formatScanDate(c.nextScanAt, tz) : 'Not scheduled'}</td>
                </tr>
              ))}
              {clients.length === 0 && (
                <tr><td colSpan={5} className="px-5 py-8 text-center text-slate-500">{needle ? `No clients match "${q}".` : 'No Geo-grid clients yet.'}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
      <p className="text-xs text-slate-500">Dates are Eastern time here; each client and location page shows its clinic&apos;s own time.</p>
    </div>
  );
}
