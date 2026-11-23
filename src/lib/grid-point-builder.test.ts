// Patch fork: organic-only ranks, dedupe, provenance and the truncated/rank_unresolved flags.
import { describe, it, expect } from 'vitest';
import { buildGridPoint, failedGridPoint, GRID_DEPTH, GRID_ORGANIC_KEEP, type RawLocalItem } from './grid-point-builder';
import { loadDfsFixture } from './__fixtures__/dfs/load';

const coord = { row: 2, col: 3, lat: 34.058457, lng: -118.144055 };
const organic = (rank: number, cid: string, extra: Partial<RawLocalItem> = {}): RawLocalItem => ({
  type: 'local_pack', rank_group: rank, rank_absolute: rank, title: `Clinic ${cid}`, description: 'Alhambra, CA · 1', cid, ...extra,
});
const ad = (rank: number, cid: string): RawLocalItem => ({ ...organic(rank, cid), is_paid: true, description: 'Sponsored \n1 Main St' });

describe('buildGridPoint ranks', () => {
  it('drops ads and renumbers organic listings 1..N, keeping the provider rank', () => {
    const raw = [ad(1, 'a1'), organic(2, 'o1'), ad(3, 'a2'), organic(4, 'o2'), organic(5, '777')];
    const { point } = buildGridPoint(coord, raw, 'Us (cid:777)');
    expect(point.items!.map((i) => [i.cid, i.rank_group, i.provider_rank, i.rank_absolute])).toEqual([
      ['o1', 1, 2, 2], ['o2', 2, 4, 4], ['777', 3, 5, 5],
    ]);
    expect(point.rank).toBe(3);
    expect(point).toMatchObject({ raw_count: 5, paid_count: 2, organic_count: 3 });
    expect(point.items!.every((i) => i.place === 'Alhambra, CA')).toBe(true);
  });

  it('ignores non-local_pack items and sorts by provider rank', () => {
    const raw = [organic(3, 'c'), { type: 'something_else', rank_group: 1 }, organic(1, 'a'), organic(2, 'b')];
    const { point } = buildGridPoint(coord, raw, '');
    expect(point.items!.map((i) => i.cid)).toEqual(['a', 'b', 'c']);
    expect(point.raw_count).toBe(3);
  });

  it('keeps the first (best) position of a duplicated CID', () => {
    const raw = [organic(1, 'x'), organic(2, '777'), organic(3, 'x'), organic(4, '777'), organic(5, 'y')];
    const { point } = buildGridPoint(coord, raw, 'Us (cid:777)');
    expect(point.items!.map((i) => [i.cid, i.rank_group, i.provider_rank])).toEqual([['x', 1, 1], ['777', 2, 2], ['y', 3, 5]]);
    expect(point.rank).toBe(2);
    expect(point.organic_count).toBe(3);
  });

  it('keeps task_id and check_url when given, omits them otherwise', () => {
    const withMeta = buildGridPoint(coord, [organic(1, 'a')], '', { task_id: 't-1', check_url: 'https://www.google.com/search?q=x' }).point;
    expect(withMeta).toMatchObject({ task_id: 't-1', check_url: 'https://www.google.com/search?q=x' });
    const without = buildGridPoint(coord, [organic(1, 'a')], '').point;
    expect('task_id' in without || 'check_url' in without).toBe(false);
  });
});

describe('buildGridPoint on a real response with 3 ads above 20 organic listings', () => {
  const fixture = loadDfsFixture('ads-alhambra');
  const at = { row: 0, col: 0, lat: fixture.lat, lng: fixture.lng };
  const meta = { task_id: fixture.id, check_url: fixture.checkUrl, depth: 20 };

  it('stores organic #18 (provider rank 21) as 18', () => {
    const kindness = fixture.items.find((i) => i.rank_group === 21)!;
    expect(kindness.is_paid).toBe(false);
    expect(fixture.items.filter((i) => i.is_paid).map((i) => i.rank_group)).toEqual([1, 2, 3]);
    const { point, location } = buildGridPoint(at, fixture.items, `Kindness (cid:${kindness.cid})`, meta);
    expect(point.rank).toBe(18);
    const target = point.items!.find((i) => i.is_target)!;
    expect(target).toMatchObject({ rank_group: 18, provider_rank: 21, rank_absolute: 21, cid: kindness.cid });
    expect(point).toMatchObject({ raw_count: 23, paid_count: 3, organic_count: 20, task_id: fixture.id, check_url: fixture.checkUrl });
    expect(point.items).toHaveLength(GRID_ORGANIC_KEEP);
    expect(point.items!.some((i) => fixture.items.find((r) => r.cid === i.cid)?.is_paid)).toBe(false);
    expect(location.status).toBe('clean');
    // 23 raw >= depth 20, but 20 organic came back: not truncated.
    expect(point.truncated).toBeUndefined();
    expect(point.rank_unresolved).toBeUndefined();
  });

  it('stores organic #20 as 20 and an organic #21 listing as not found', () => {
    const last = fixture.items.find((i) => i.rank_group === 23)!;
    expect(buildGridPoint(at, fixture.items, `Last (cid:${last.cid})`, meta).point.rank).toBe(20);
    const beyond = [...fixture.items, organic(24, '2424')];
    const { point } = buildGridPoint(at, beyond, 'Beyond (cid:2424)', meta);
    expect(point.rank).toBeNull();
    expect(point.items).toHaveLength(20);
    expect(point.organic_count).toBe(21);
    expect(point.rank_unresolved).toBeUndefined();
  });

  it('does not match the target on its own ad', () => {
    const ownAd = fixture.items.find((i) => i.is_paid)!;
    const { point } = buildGridPoint(at, fixture.items, `Ad (cid:${ownAd.cid})`, meta);
    expect(point.rank).toBeNull();
  });
});

describe('truncated results', () => {
  // GRID_DEPTH raw listings, 12 of them ads: only 18 organic came back.
  const truncatedRaw = Array.from({ length: GRID_DEPTH }, (_, i) => (i % 5 === 0 || i >= 24 ? ad(i + 1, `ad${i}`) : organic(i + 1, `${1000 + i}`)));

  it('flags truncated, and rank_unresolved only when the target is missing', () => {
    const organicCount = truncatedRaw.filter((i) => !i.is_paid).length;
    expect(organicCount).toBeLessThan(GRID_ORGANIC_KEEP);
    const missing = buildGridPoint(coord, truncatedRaw, 'Us (cid:999)').point;
    expect(missing).toMatchObject({ truncated: true, rank_unresolved: true, rank: null, raw_count: GRID_DEPTH, organic_count: organicCount });
    const found = buildGridPoint(coord, truncatedRaw, 'Us (cid:1001)').point;
    expect(found).toMatchObject({ truncated: true, rank: 1 });
    expect(found.rank_unresolved).toBeUndefined();
  });

  it('a short SERP that came back complete (fewer raw listings than the depth) is not truncated', () => {
    const short = [ad(1, 'a'), organic(2, 'b'), organic(3, 'c')];
    const { point } = buildGridPoint(coord, short, 'Us (cid:999)');
    expect(point.rank).toBeNull();
    expect(point.truncated).toBeUndefined();
    expect(point.rank_unresolved).toBeUndefined();
  });

  it('uses the depth from meta', () => {
    const raw = [ad(1, 'a'), organic(2, 'b'), organic(3, 'c')];
    expect(buildGridPoint(coord, raw, 'Us (cid:999)', { depth: 3 }).point).toMatchObject({ truncated: true, rank_unresolved: true });
  });
});

describe('location status on the point', () => {
  it("records location_status 'unresolved' when no top-5 listing has a city", () => {
    const raw = [1, 2, 3].map((n) => organic(n, `s${n}`, { description: `${n}00 Main St · 1` }));
    const { point, location } = buildGridPoint(coord, raw, '');
    expect(location.status).toBe('unresolved');
    expect(point.location_status).toBe('unresolved');
    expect(point.items!.every((i) => i.place === undefined)).toBe(true);
  });

  it('checks the organic order, not the provider order (ads are skipped)', () => {
    const raw = [ad(1, 'a'), ...[2, 3, 4, 5, 6].map((n) => organic(n, `o${n}`)), organic(7, 'far', { description: 'Tulsa, OK · 1' })];
    // Tulsa is organic #6, outside the checked top 5.
    expect(buildGridPoint(coord, raw, '').location.status).toBe('clean');
  });
});

describe('a non-PT keyword ("personal training", Los Angeles)', () => {
  const fixture = loadDfsFixture('personal-training-la');

  it('ranks the target by organic position and reads "City, ST" listings', () => {
    expect(fixture.keyword).toBe('personal training');
    const rob = fixture.items.find((i) => i.title === 'Rob Riches Studio')!;
    const { point, location } = buildGridPoint({ row: 0, col: 0, lat: fixture.lat, lng: fixture.lng }, fixture.items,
      `Rob Riches Studio (cid:${rob.cid})`, { task_id: fixture.id, check_url: fixture.checkUrl, depth: 20 });
    expect(rob.rank_group).toBe(18);
    expect(point.rank).toBe(15);
    expect(point).toMatchObject({ paid_count: 3, organic_count: 20, task_id: fixture.id });
    expect(location.status).toBe('clean');
    // "10+ years in business · Los Angeles, CA" doesn't start with the city, so only some listings are placed.
    expect(location.coverage).toBeGreaterThanOrEqual(1);
    expect(point.items!.find((i) => i.title === 'Alex Nunez Fitness')?.place).toBe('Los Angeles, CA');
  });
});

describe('failedGridPoint', () => {
  it('has no ranks or items and carries the reason and evidence', () => {
    const rechecks = [{ task_id: 'a', reason: 'wrong_city' as const, check_url: 'u1' }, { task_id: 'b', reason: 'wrong_city' as const, check_url: 'u2' }];
    expect(failedGridPoint(coord, 'wrong_city', { task_id: 'b', check_url: 'u2', rechecks })).toEqual({
      row: 2, col: 3, lat: coord.lat, lng: coord.lng, rank: null, items: [], failed: true, failed_reason: 'wrong_city',
      task_id: 'b', check_url: 'u2', rechecks,
    });
    expect(failedGridPoint(coord, 'task_error')).toEqual({
      row: 2, col: 3, lat: coord.lat, lng: coord.lng, rank: null, items: [], failed: true, failed_reason: 'task_error',
    });
  });
});
