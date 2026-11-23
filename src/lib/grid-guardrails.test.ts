import { describe, it, expect } from 'vitest';
import { DEMO_PROJECT_ID, gridRunProjectError, isOneTimeOnlyProject } from './grid-guardrails';

describe('isOneTimeOnlyProject', () => {
  it('is true only for the Default Project', () => {
    expect(DEMO_PROJECT_ID).toBe('default');
    expect(isOneTimeOnlyProject('default')).toBe(true);
    expect(isOneTimeOnlyProject('d056c7c7-c9f8-476e-89c3-f62abb18960f')).toBe(false);
    expect(isOneTimeOnlyProject(undefined)).toBe(false);
  });
});

describe('gridRunProjectError', () => {
  const active = { id: 'client-1', name: 'Summit PT' };

  it('passes when the form project is still the active one', () => {
    expect(gridRunProjectError('client-1', active)).toBeNull();
  });

  it('refuses when the active project changed after the form was opened', () => {
    expect(gridRunProjectError('default', active)).toBe('The selected project changed to Summit PT. Check and run again.');
    expect(gridRunProjectError('default', active, 'save')).toBe('The selected project changed to Summit PT. Check and save again.');
  });

  it('refuses a scan link with no project', () => {
    expect(gridRunProjectError(undefined, active)).toBe('This scan link has no project. Open the form and run again.');
    expect(gridRunProjectError('  ', active)).toMatch(/no project/);
  });
});
