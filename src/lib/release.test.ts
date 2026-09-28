import { describe, expect, it } from 'vitest';
import { hasNewerStableVersion, normalizeVersion, releaseSummary } from './release';

describe('release version checks', () => {
  it('normalizes release tags but rejects non-SemVer values', () => {
    expect(normalizeVersion(' v1.2.3 ')).toBe('1.2.3');
    expect(normalizeVersion('main')).toBeNull();
    expect(normalizeVersion('1.2')).toBeNull();
  });

  it('only reports newer stable releases', () => {
    expect(hasNewerStableVersion('0.4.0', '0.4.1')).toBe(true);
    expect(hasNewerStableVersion('0.4.0', '1.0.0')).toBe(true);
    expect(hasNewerStableVersion('0.4.1', '0.4.0')).toBe(false);
    expect(hasNewerStableVersion('0.4.0', '0.5.0-beta.1')).toBe(false);
    expect(hasNewerStableVersion('0.5.0-beta.1', '0.5.0')).toBe(true);
  });

  it('turns release notes into one compact, safe summary', () => {
    expect(releaseSummary('## Added\n- Faster reports\n- Other change')).toBe('Faster reports');
    expect(releaseSummary('- Faster reports\n- Other change')).toBe('Faster reports');
  });
});
