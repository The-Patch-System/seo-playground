// Patch fork: location addresses for the Location and Keyword pages (Brad, Nov 24 2026).
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grid-addresses-test-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');

import { createProject, gridSeriesId, saveGridSchedule, setActiveProject } from './db';
import {
  addressFromListing, addressLabel, cidsNeedingAddress, fillMissingListingAddresses, getListingAddress, lookUpListingAddress,
  resetAddressFillClock, saveFormAddress, saveListingAddress, trackedListingCids,
} from './grid-addresses';

afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
afterEach(() => { vi.unstubAllGlobals(); resetAddressFillClock(); });

const creds = { login: 'user', pass: 'pass' };
const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 24, 15);

function listingsResponse(items: unknown[]) {
  return new Response(JSON.stringify({ status_code: 20000, tasks: [{ status_code: 20000, cost: 0.0103, result: [{ items }] }] }), { status: 200 });
}

describe('reading a Business Listings item', () => {
  it('uses the full address when the listing has a street address', () => {
    expect(addressFromListing({
      cid: '1', address: '6263 Old Dominion Dr, McLean, VA 22101',
      address_info: { address: '6263 Old Dominion Dr', city: 'McLean', region: 'Virginia', zip: '22101' },
    })).toEqual({ address: '6263 Old Dominion Dr, McLean, VA 22101', status: 'found' });
  });

  it('marks a hidden-address listing as a service area, keeping its city', () => {
    expect(addressFromListing({ cid: '2', address: null, address_info: { address: null, city: 'Tonopah', region: 'Nevada' } }))
      .toEqual({ address: 'Tonopah, Nevada', status: 'service_area' });
  });

  it('treats no listing as not found', () => {
    expect(addressFromListing(undefined)).toEqual({ address: '', status: 'not_found' });
  });
});

describe('page label', () => {
  it('says why there is no address', () => {
    expect(addressLabel(null, false)).toBe('No Google listing linked');
    expect(addressLabel(null, true)).toBe('Address not looked up yet');
    expect(addressLabel({ cid: '1', address: '1 Main St', status: 'found', source: 'form', updated_at: 0 }, true)).toBe('1 Main St');
    expect(addressLabel({ cid: '1', address: 'Reno, Nevada', status: 'service_area', source: 'x', updated_at: 0 }, true))
      .toBe('Service-area business, no street address (Reno, Nevada)');
    expect(addressLabel({ cid: '1', address: '', status: 'not_found', source: 'x', updated_at: 0 }, true)).toBe('Address not found on Google');
  });
});

describe('saving and retrying', () => {
  it('saves the address the Add location form showed, and skips blanks', () => {
    saveFormAddress('111', '  57 E Main St   Suite 120, Westborough, MA 01581 ', NOW);
    saveFormAddress('112', '   ', NOW);
    saveFormAddress(null, '1 Main St', NOW);
    expect(getListingAddress('111')).toMatchObject({ address: '57 E Main St Suite 120, Westborough, MA 01581', status: 'found', source: 'form' });
    expect(getListingAddress('112')).toBeNull();
  });

  it('never re-looks up a found address; retries the others after a wait', () => {
    saveListingAddress('201', '1 Main St', 'found', 'test', NOW);
    saveListingAddress('202', '', 'error', 'test', NOW);
    saveListingAddress('203', '', 'not_found', 'test', NOW);
    expect(cidsNeedingAddress(['201', '202', '203', '204'], NOW + HOUR)).toEqual(['204']);
    expect(cidsNeedingAddress(['201', '202', '203'], NOW + 6 * HOUR)).toEqual(['202']);
    expect(cidsNeedingAddress(['201', '202', '203'], NOW + 7 * 24 * HOUR)).toEqual(['202', '203']);
  });
});

describe('looking up by CID', () => {
  it('saves the listing address from DataForSEO', async () => {
    const fetch = vi.fn(async () => listingsResponse([{ cid: '301', address: '428 N Trade St #102, Matthews, NC 28105', address_info: { address: '428 N Trade St #102' } }]));
    vi.stubGlobal('fetch', fetch);
    const row = await lookUpListingAddress('301', creds, NOW);
    expect(row).toMatchObject({ address: '428 N Trade St #102, Matthews, NC 28105', status: 'found', source: 'business_listings' });
    const body = JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body).toEqual([{ filters: [['cid', '=', '301']], limit: 1 }]);
  });

  it('ignores a listing with a different CID, and records API errors for a later retry', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => listingsResponse([{ cid: '999', address: 'Somewhere else' }])));
    expect(await lookUpListingAddress('302', creds, NOW)).toMatchObject({ status: 'not_found', address: '' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500, statusText: 'Server Error' })));
    expect(await lookUpListingAddress('303', creds, NOW)).toMatchObject({ status: 'error' });
  });
});

describe('worker fill', () => {
  const clinic = createProject({
    name: 'Fitness Together - Matthews, NC', domain: 'fitnesstogether1.example', defaultLocation: 'United States',
    defaultLanguage: 'English', defaultCoordinates: '', rankTrackerDepth: '100',
  });
  setActiveProject(clinic.id);
  const target = 'Fitness Together (cid:4011223344556677889)';
  const center = '35.120219,-80.717857';
  saveGridSchedule({
    series_id: gridSeriesId('personal trainer', center, 9, 2.0117, target, 'English'),
    keyword: 'personal trainer', target, center, grid_size: 9, spacing_km: 2.0117, language: 'English', queue_mode: 'standard',
    frequency: 'monthly', weekday: 15, time_of_day: '12:00', time_zone: 'America/New_York',
  });

  it('finds every tracked CID and looks up the missing ones, at most every 10 minutes', async () => {
    expect(trackedListingCids()).toContain('4011223344556677889');
    const fetch = vi.fn(async () => listingsResponse([{ cid: '4011223344556677889', address: '428 N Trade St #102, Matthews, NC 28105' }]));
    vi.stubGlobal('fetch', fetch);
    expect(await fillMissingListingAddresses(creds, 40, NOW)).toEqual({ looked_up: 1, found: 1, remaining: 0 });
    expect(getListingAddress('4011223344556677889')?.address).toBe('428 N Trade St #102, Matthews, NC 28105');
    // Within 10 minutes: no pass. After: nothing left to look up.
    expect(await fillMissingListingAddresses(creds, 40, NOW + 60_000)).toEqual({ looked_up: 0, found: 0, remaining: 0 });
    expect(await fillMissingListingAddresses(creds, 40, NOW + 11 * 60_000)).toEqual({ looked_up: 0, found: 0, remaining: 0 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
