import { describe, it, expect } from 'vitest';
import { radiusMiForSpacing, spacingKmForRadius } from './grid-radius';
import { timeZoneForCenter } from './grid-timezone';

describe('grid radius in miles', () => {
  it('puts the outer ring of a 9x9 grid at the chosen radius', () => {
    expect(spacingKmForRadius(5, 9)).toBeCloseTo(2.0117, 4);
    expect(spacingKmForRadius(10, 9)).toBeCloseTo(4.0234, 4);
    expect(radiusMiForSpacing(spacingKmForRadius(5, 9), 9)).toBe(5);
    expect(radiusMiForSpacing(spacingKmForRadius(10, 7), 7)).toBe(10);
  });

  it('reads the clinic time zone from the grid center', () => {
    expect(timeZoneForCenter('32.894142,-97.269099')).toBe('America/Chicago');
    expect(timeZoneForCenter('40.7128,-74.0060')).toBe('America/New_York');
    expect(timeZoneForCenter('33.4484,-112.0740')).toBe('America/Phoenix');
    expect(timeZoneForCenter('not a center')).toBeNull();
  });
});
