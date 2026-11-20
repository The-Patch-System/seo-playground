// Patch fork: guardrails for the old Geo-Grid screen (/dashboard/geo-grid).
// Sales reps run one-time demo scans in the Default Project, so no schedule (and no monthly
// bill) may ever be created there. The active project is one server-wide setting, so a scan
// also has to prove it was started from a form showing the project it will be saved to.

/** The Default Project, used for sales demos. Its ID stays `default` even if it's renamed. */
export const DEMO_PROJECT_ID = 'default';

/** Projects where only one-time scans may run: no schedule, ever. */
export function isOneTimeOnlyProject(projectId: string | null | undefined): boolean {
  return projectId === DEMO_PROJECT_ID;
}

export const ONE_TIME_ONLY_MESSAGE = 'The Default Project is for one-time scans; pass schedule:false';

/**
 * Compares the project a form was rendered with against the server's active project.
 * Returns null when they match, otherwise the message to show instead of running the scan.
 */
export function gridRunProjectError(
  postedProjectId: string | null | undefined,
  active: { id: string; name: string },
  action: 'run' | 'save' = 'run',
): string | null {
  const posted = postedProjectId?.trim();
  if (!posted) return 'This scan link has no project. Open the form and run again.';
  if (posted !== active.id) return `The selected project changed to ${active.name}. Check and ${action} again.`;
  return null;
}
