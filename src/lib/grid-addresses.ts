// Patch fork (Nov 24 2026, Brad): show each location's street address on the Location and Keyword
// pages, so you can tell which location you're on without opening Google Maps.
//
// Addresses are keyed by Google CID in the control database, so one lookup serves every client and
// keyword at that listing. They come from:
//  - the Add location form, which already shows the picked listing's address (saved for free)
//  - DataForSEO Business Listings by CID (about $0.01 each), for locations added any other way
//    (imports, older locations). The worker fills a few missing ones each pass, so it self-heals.
import { getControlDb, getCredentials, getDbForProject, getProjects } from './db';
import { callDataForSeoFirst, type DfsCredentials } from './dataforseo';
import { parseTargetCid } from './grid-target';

/** found: has a street address. service_area: listing hides its address. not_found / error: no answer yet. */
export type ListingAddressStatus = 'found' | 'service_area' | 'not_found' | 'error';

export interface ListingAddress {
  cid: string;
  address: string;
  status: ListingAddressStatus;
  source: string;
  updated_at: number;
}

const HOUR = 3_600_000;
/** How long before a lookup without a street address is tried again. */
const RETRY_AFTER: Record<ListingAddressStatus, number | null> = {
  found: null,
  service_area: 30 * 24 * HOUR,
  not_found: 7 * 24 * HOUR,
  error: 6 * HOUR,
};

let schemaReady = false;
function db() {
  const control = getControlDb();
  if (!schemaReady) {
    control.exec(`
      CREATE TABLE IF NOT EXISTS grid_listing_addresses (
        cid TEXT PRIMARY KEY,
        address TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL
      );
    `);
    schemaReady = true;
  }
  return control;
}

export function getListingAddresses(cids: Array<string | null | undefined>): Map<string, ListingAddress> {
  const wanted = [...new Set(cids.filter((cid): cid is string => Boolean(cid)))];
  const out = new Map<string, ListingAddress>();
  if (!wanted.length) return out;
  const select = db().prepare('SELECT cid, address, status, source, updated_at FROM grid_listing_addresses WHERE cid = ?');
  for (const cid of wanted) {
    const row = select.get(cid) as ListingAddress | undefined;
    if (row) out.set(cid, row);
  }
  return out;
}

export function getListingAddress(cid: string | null | undefined): ListingAddress | null {
  return cid ? getListingAddresses([cid]).get(cid) ?? null : null;
}

export function saveListingAddress(cid: string, address: string, status: ListingAddressStatus, source: string, now = Date.now()): void {
  if (!/^\d+$/.test(cid)) return;
  db().prepare(`INSERT INTO grid_listing_addresses (cid, address, status, source, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(cid) DO UPDATE SET address = excluded.address, status = excluded.status, source = excluded.source, updated_at = excluded.updated_at`)
    .run(cid, address.trim(), status, source, now);
}

/** The street address the Add location form already showed; free, so it's saved when the location is added. */
export function saveFormAddress(cid: string | null | undefined, address: string | null | undefined, now = Date.now()): void {
  const value = address?.replace(/\s+/g, ' ').trim();
  if (!cid || !value) return;
  saveListingAddress(cid, value, 'found', 'form', now);
}

/** One line for the page: the address, or why there isn't one. */
export function addressLabel(row: ListingAddress | null | undefined, hasCid: boolean): string {
  if (!hasCid) return 'No Google listing linked';
  if (!row) return 'Address not looked up yet';
  if (row.status === 'found') return row.address;
  if (row.status === 'service_area') return row.address ? `Service-area business, no street address (${row.address})` : 'Service-area business, no street address';
  if (row.status === 'not_found') return 'Address not found on Google';
  return 'Address not looked up yet';
}

interface ListingItem {
  cid?: string | number | null;
  address?: string | null;
  address_info?: { address?: string | null; city?: string | null; region?: string | null; zip?: string | null } | null;
}

/** Reads a Business Listings item: a street address, or a service area's city when the address is hidden. */
export function addressFromListing(item: ListingItem | null | undefined): { address: string; status: ListingAddressStatus } {
  if (!item) return { address: '', status: 'not_found' };
  const street = item.address_info?.address?.trim();
  const full = item.address?.replace(/\s+/g, ' ').trim();
  if (full && (street || !item.address_info)) return { address: full, status: 'found' };
  const area = [item.address_info?.city, item.address_info?.region].map((part) => part?.trim()).filter(Boolean).join(', ');
  return { address: area, status: 'service_area' };
}

/** Looks one CID up in DataForSEO Business Listings and saves the answer. About $0.01. */
export async function lookUpListingAddress(cid: string, credentials: DfsCredentials, now = Date.now()): Promise<ListingAddress> {
  const { result, error } = await callDataForSeoFirst<{ items?: ListingItem[] | null }>(
    'business_data/business_listings/search/live',
    { filters: [['cid', '=', cid]], limit: 1 },
    credentials,
    15_000,
  );
  if (error) {
    console.error(`[geo-grid] address lookup failed for cid ${cid}: ${error}`);
    saveListingAddress(cid, '', 'error', 'business_listings', now);
  } else {
    const item = (result?.items ?? []).find((listing) => String(listing.cid ?? '') === cid);
    const { address, status } = addressFromListing(item);
    saveListingAddress(cid, address, status, 'business_listings', now);
  }
  return getListingAddress(cid) as ListingAddress;
}

/** Every Google CID with a scheduled or scanned map, across all clients. */
export function trackedListingCids(): string[] {
  const cids = new Set<string>();
  for (const project of getProjects()) {
    const rows = getDbForProject(project.id).prepare(
      'SELECT DISTINCT target FROM grid_schedules UNION SELECT DISTINCT target FROM grid_searches',
    ).all() as Array<{ target: string }>;
    for (const row of rows) {
      const cid = parseTargetCid(row.target);
      if (cid) cids.add(cid);
    }
  }
  return [...cids];
}

/** CIDs that need a (new) lookup: never looked up, or an old answer without a street address. */
export function cidsNeedingAddress(cids: string[], now = Date.now()): string[] {
  const known = getListingAddresses(cids);
  return cids.filter((cid) => {
    const row = known.get(cid);
    if (!row) return true;
    const retry = RETRY_AFTER[row.status];
    return retry !== null && now - row.updated_at >= retry;
  });
}

const FILL_EVERY_MS = 10 * 60_000;
let lastFillAt = 0;

/**
 * Worker step: looks up a few missing addresses per pass (at most every 10 minutes), so imported and
 * older locations fill in on their own. Never throws: addresses are display-only.
 */
export async function fillMissingListingAddresses(
  credentials: DfsCredentials | null = getCredentials(), max = 40, now = Date.now(),
): Promise<{ looked_up: number; found: number; remaining: number }> {
  const empty = { looked_up: 0, found: 0, remaining: 0 };
  if (!credentials || now - lastFillAt < FILL_EVERY_MS) return empty;
  lastFillAt = now;
  try {
    const missing = cidsNeedingAddress(trackedListingCids(), now);
    const batch = missing.slice(0, max);
    let found = 0;
    for (let i = 0; i < batch.length; i += 5) {
      const rows = await Promise.all(batch.slice(i, i + 5).map((cid) => lookUpListingAddress(cid, credentials, now)));
      found += rows.filter((row) => row?.status === 'found').length;
    }
    return { looked_up: batch.length, found, remaining: missing.length - batch.length };
  } catch (error) {
    console.error(`[geo-grid] address fill failed: ${error instanceof Error ? error.message : String(error)}`);
    return empty;
  }
}

/** For tests: lets the next fillMissingListingAddresses run right away. */
export function resetAddressFillClock(): void {
  lastFillAt = 0;
}
