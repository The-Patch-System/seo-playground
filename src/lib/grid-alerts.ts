// Patch fork: loud failures for the Geo-grid worker and re-scans. Every alert is logged as one
// `[geo-grid-alert] {json}` line. If GEO_GRID_ALERT_WEBHOOK_URL is set (a Slack incoming webhook for
// #seo-workflow-errors; a secret, env only, never logged), it is also posted there, once per
// kind|run_id|monitor_id|reason per process so a held run doesn't alert on every worker pass.

export type GridAlertKind =
  /** A re-scan was held (reason = hold reason). */
  | 'rescan_held'
  /** A re-scan stayed in `posting` with nothing in flight (crash between claim and outcome). */
  | 'posting_stalled'
  /** A worker step for one re-scan threw; its state was left as it was. */
  | 'rescan_error'
  /** A scheduled or manual queued run finished, but its numbers are not safe to report. */
  | 'scheduled_run_unsafe'
  /** DataForSEO billed more for a re-scan task than the price reserved for it. */
  | 'price_mismatch'
  /**
   * A scheduled run's start got an unclear answer (timeout, 5xx, odd body), so its tasks may have been
   * queued and billed. reason: `unclear_post_retrying` (one retry in 5 min), `unclear_post_stopped`,
   * `unclear_post_partial` (some tasks accepted; the run will be incomplete) or `start_error` (a local
   * failure after posting).
   */
  | 'scheduled_start_unclear'
  /** A scheduled run's start was refused by DataForSEO and its 6 h retry window is used up. */
  | 'scheduled_start_failed'
  /** A scheduled run's single-point re-post got an unclear answer (may be billed twice; capped at 3 attempts). */
  | 'scheduled_repost_unclear'
  /** A re-scan POST got an unclear answer, but the run could not be held (a cancel or retry won the race). */
  | 'rescan_post_unknown_unheld';

export interface GridAlert {
  kind: GridAlertKind;
  reason: string;
  project_id?: string;
  run_id?: string;
  monitor_id?: string;
  detail?: unknown;
}

const WEBHOOK_TIMEOUT_MS = 5_000;
const sent = new Set<string>();

/** Test helper: forget which alerts were already posted. */
export function resetGridAlertsForTests(): void {
  sent.clear();
}

function summary(alert: GridAlert): string {
  const ids = [
    alert.monitor_id ? `monitor ${alert.monitor_id}` : null,
    alert.run_id ? `run ${alert.run_id}` : null,
    alert.project_id ? `project ${alert.project_id}` : null,
  ].filter(Boolean).join(', ');
  return `Geo-grid alert: ${alert.kind}: ${alert.reason}${ids ? ` (${ids})` : ''}`;
}

/** Logs the alert and, when configured, posts it to Slack. Never throws; resolves once the post is done. */
export async function notifyGridAlert(alert: GridAlert): Promise<void> {
  try {
    console.error(`[geo-grid-alert] ${JSON.stringify({ ...alert, at: new Date().toISOString() })}`);
  } catch {
    // An unserializable detail must not stop the alert.
    console.error(`[geo-grid-alert] ${JSON.stringify({ kind: alert.kind, reason: alert.reason, run_id: alert.run_id, monitor_id: alert.monitor_id })}`);
  }
  const url = process.env.GEO_GRID_ALERT_WEBHOOK_URL?.trim();
  if (!url) return;
  // Patch fork: monitor_id is part of the key, since start alerts have no run id yet.
  const key = `${alert.kind}|${alert.run_id ?? ''}|${alert.monitor_id ?? ''}|${alert.reason}`;
  if (sent.has(key)) return;
  sent.add(key);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: summary(alert) }),
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    if (!response.ok) {
      sent.delete(key);
      console.error(`[geo-grid-alert] webhook post failed: HTTP ${response.status} (${alert.kind})`);
    }
  } catch (error) {
    // Not delivered: let a later occurrence try again. Only the error's name is logged, since
    // messages can echo the (secret) webhook URL.
    sent.delete(key);
    console.error(`[geo-grid-alert] webhook post failed: ${error instanceof Error ? error.name : 'error'} (${alert.kind})`);
  }
}
