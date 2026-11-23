import Link from 'next/link';
import type { Metadata } from 'next';
import { DEMO_PROJECT_ID, listClients } from '@/lib/grid-locations-db';
import { formatScanDate } from '@/lib/grid-locations';
import Breadcrumbs from '../_components/Breadcrumbs';
import { clientUrl, DEMO_SCAN_URL } from '../_components/routes';
import { AddClientButton } from '../_components/Actions';
import { BTN_SECONDARY } from '../_components/Modal';

/** A client added this recently shows in the default list even before its first location. */
const NEW_CLIENT_MS = 14 * 86_400_000;

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Geo-grid clients' };

export default async function GeoGridClientsPage({ searchParams }: { searchParams: Promise<{ q?: string; show?: string }> }) {
  const { q = '', show } = await searchParams;
  const showAll = show === 'all';
  const needle = q.trim().toLowerCase();
  const everyProject = listClients();
  const recent = Date.now() - NEW_CLIENT_MS;
  // Not every project is a live client (tests, examples, deactivated clinics), so by default list the
  // ones with locations plus any added in the last two weeks. "Show all projects" lists the rest.
  const all = showAll ? everyProject : everyProject.filter((c) => c.locations > 0 || c.project.createdAt > recent);
  const hidden = everyProject.length - all.length;
  // A search looks through every project, so a hidden client can still be found by name.
  const clients = needle
    ? everyProject.filter((c) => `${c.project.name} ${c.project.domain}`.toLowerCase().includes(needle))
    : all;
  const toggleHref = (next: boolean) => {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (next) params.set('show', 'all');
    const query = params.toString();
    return query ? `?${query}` : '?';
  };
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
          <div className="flex flex-wrap items-center gap-2">
            <Link href={DEMO_SCAN_URL} className={BTN_SECONDARY}>Sales demo scan</Link>
            <AddClientButton />
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-[13px] text-slate-600">
            {showAll
              ? <>Showing every project. <Link href={toggleHref(false)} className="font-bold text-blue-600 hover:text-blue-800">Show only active clients</Link></>
              : <>Clients with locations, or added in the last 14 days.{hidden > 0 && <> <Link href={toggleHref(true)} className="font-bold text-blue-600 hover:text-blue-800">Show all projects ({hidden} more)</Link></>}</>}
            {' · '}<Link href={clientUrl(DEMO_PROJECT_ID)} className="font-bold text-blue-600 hover:text-blue-800">Sales demos</Link>
          </p>
          <form role="search" className="flex gap-2" action="">
            {showAll && <input type="hidden" name="show" value="all" />}
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
                  <td className="px-3 py-3 tabular-nums">{c.locations || <span className="text-slate-500">No locations yet</span>}</td>
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
