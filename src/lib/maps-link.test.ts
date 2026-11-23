import { describe, expect, it } from 'vitest';
import { milesBetween, parseMapsInput } from './maps-link';

describe('parseMapsInput', () => {
  it('reads the CID, the pin and the name from a listing URL', () => {
    const url = 'https://www.google.com/maps/place/Elevation+Athletics+Physical+Therapy/@39.7392,-104.9903,15z/data=!4m6!3m5!1s0x876c7f0ab12cd34e:0x666a5e1b2c3d4e5f!8m2!3d39.7401234!4d-104.9876543!16s%2Fg%2F11abc';
    expect(parseMapsInput(url)).toEqual({
      cid: BigInt('0x666a5e1b2c3d4e5f').toString(),
      center: '39.740123,-104.987654',
      centerIsPin: true,
      name: 'Elevation Athletics Physical Therapy',
    });
  });

  it('reads ?cid= links and falls back to the map view center', () => {
    expect(parseMapsInput('https://maps.google.com/?cid=7380112684083592032')).toMatchObject({ cid: '7380112684083592032', center: null });
    expect(parseMapsInput('https://www.google.com/maps/@40.7128,-74.006,14z')).toEqual({ cid: null, center: '40.712800,-74.006000', centerIsPin: false, name: null });
  });

  it('accepts a bare CID or lat,lng and rejects junk', () => {
    expect(parseMapsInput(' 7380112684083592032 ')).toMatchObject({ cid: '7380112684083592032' });
    expect(parseMapsInput('40.7128, -74.006')).toMatchObject({ center: '40.712800,-74.006000' });
    expect(parseMapsInput('hello')).toBeNull();
    expect(parseMapsInput('95,200')).toBeNull();
    expect(parseMapsInput('')).toBeNull();
  });
});

describe('milesBetween', () => {
  it('measures miles between two centers', () => {
    expect(milesBetween('40.7128,-74.0060', '40.7128,-74.0060')).toBe(0);
    expect(milesBetween('40.7128,-74.0060', '40.7273,-74.0060')!).toBeCloseTo(1.0, 1);
    expect(milesBetween('bad', '40,-74')).toBeNull();
  });
});
