import { describe, expect, it } from 'vitest';
import { isShortMapsLink, milesBetween, parseMapsInput } from './maps-link';

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

  it('reads the CID from both forms of a real listing link: before and after Google adds the coordinates', () => {
    const cid = '10223171319798353624';
    expect(parseMapsInput('https://www.google.com/maps/place/The+Wellness+Track,+LLC/data=!4m2!3m1!1s0x0:0x8de00026928aced8?sa=X&ved=1t:2428&ictx=111'))
      .toEqual({ cid, center: null, centerIsPin: false, name: 'The Wellness Track, LLC' });
    expect(parseMapsInput('https://www.google.com/maps/place/The+Wellness+Track,+LLC/@39.1651321,-84.7003209,1109m/data=!3m2!1e3!4b1!4m6!3m5!1s0x8805679fc2307283:0x8de00026928aced8!8m2!3d39.1651321!4d-84.7003209!16s%2Fg%2F11sqq0fn0h!5m1!1e2?entry=ttu&g_ep=EgoyMDI2MTExOC4xIKXMDSoASAFQAw%3D%3D'))
      .toEqual({ cid, center: '39.165132,-84.700321', centerIsPin: true, name: 'The Wellness Track, LLC' });
  });

  it('reads ?cid= links and falls back to the map view center', () => {
    expect(parseMapsInput('https://maps.google.com/?cid=7380112684083592032')).toMatchObject({ cid: '7380112684083592032', center: null });
    expect(parseMapsInput('https://www.google.com/maps/@40.7128,-74.006,14z')).toEqual({ cid: null, center: '40.712800,-74.006000', centerIsPin: false, name: null });
  });

  it('reads ludocid= links from Google search results', () => {
    expect(parseMapsInput('https://www.google.com/search?q=the+wellness+track&ludocid=10223171319798353624&lsig=AB86z5W'))
      .toMatchObject({ cid: '10223171319798353624' });
  });

  it('reads the full link a Share short link expands to (real redirect, Nov 23 2026)', () => {
    const expanded = 'https://www.google.com/maps/place/Forge+Physical+Therapy/@33.1530144,-96.894528,17z/data=!3m1!4b1!4m6!3m5!1s0x864c3b047a4f5fe3:0xbd85348c0c116aee!8m2!3d33.1530144!4d-96.8919477!16s%2Fg%2F11n9d6758c?entry=tts&g_ep=EgoyMDI2MDQxOS4wIPu8ASoASAFQAw%3D%3D&skid=768d4f6b-4cb0-4938-8a1d-5f3ed572098c';
    expect(parseMapsInput(expanded)).toEqual({
      cid: BigInt('0xbd85348c0c116aee').toString(),
      center: '33.153014,-96.891948',
      centerIsPin: true,
      name: 'Forge Physical Therapy',
    });
  });

  it('knows a Share short link needs expanding first', () => {
    expect(isShortMapsLink('https://maps.app.goo.gl/j6Ebso1fuLAx3usK9')).toBe(true);
    expect(isShortMapsLink(' https://goo.gl/maps/abc123 ')).toBe(true);
    expect(isShortMapsLink('https://goo.gl/other')).toBe(false);
    expect(isShortMapsLink('http://maps.app.goo.gl/abc')).toBe(false);
    expect(isShortMapsLink('https://www.google.com/maps/place/X')).toBe(false);
    expect(isShortMapsLink('not a link')).toBe(false);
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
