import { describe, expect, it } from 'vitest';
import { formatBusinessTarget, makeTargetMatcher, parseTargetCid } from './grid-target';

const listing = { title: 'Elevation Athletics Physical Therapy', domain: 'www.elevationathleticspt.com', url: 'https://www.elevationathleticspt.com/', cid: '1234567890' };
const other = { title: 'Elevate Rehab', domain: 'elevaterehab.com', url: 'https://elevaterehab.com/', cid: '999' };

describe('Geo-grid target matching', () => {
  it('matches a domain with or without protocol and www', () => {
    for (const target of ['https://elevationathleticspt.com', 'https://www.elevationathleticspt.com', 'elevationathleticspt.com', 'www.elevationathleticspt.com/']) {
      const match = makeTargetMatcher(target);
      expect(match(listing)).toBe(true);
      expect(match(other)).toBe(false);
    }
  });

  it('requires the path when one is given', () => {
    const brand = { title: 'Brand PT Keller', domain: 'brandpt.com', url: 'https://brandpt.com/locations/keller' };
    expect(makeTargetMatcher('brandpt.com/locations/keller')(brand)).toBe(true);
    expect(makeTargetMatcher('brandpt.com/locations/denton')(brand)).toBe(false);
  });

  it('matches a picked Google listing by CID only', () => {
    const target = formatBusinessTarget('Elevation Athletics Physical Therapy', '1234567890');
    expect(parseTargetCid(target)).toBe('1234567890');
    expect(makeTargetMatcher(target)(listing)).toBe(true);
    expect(makeTargetMatcher(target)({ ...listing, cid: '1' })).toBe(false);
  });

  it('falls back to a partial business-name match', () => {
    expect(makeTargetMatcher('elevation athletics')(listing)).toBe(true);
    expect(makeTargetMatcher('elevation athletics')(other)).toBe(false);
  });
});
