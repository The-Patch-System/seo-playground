// Patch fork: Geo-grid alerts (grid-alerts.ts) always log, and post to Slack only when the webhook is set.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { notifyGridAlert, resetGridAlertsForTests } from './grid-alerts';

const WEBHOOK = 'https://hooks.slack.example/services/T000/B000/secret-token';

describe('notifyGridAlert', () => {
  let logged: string[];
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resetGridAlertsForTests();
    logged = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
    fetchMock = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('logs one [geo-grid-alert] JSON line and posts nothing when the webhook is unset', async () => {
    vi.stubEnv('GEO_GRID_ALERT_WEBHOOK_URL', '');
    await notifyGridAlert({ kind: 'rescan_held', reason: 'post_unknown', project_id: 'p1', run_id: 'r1', monitor_id: 'm1' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logged).toHaveLength(1);
    expect(logged[0].startsWith('[geo-grid-alert] ')).toBe(true);
    expect(JSON.parse(logged[0].slice('[geo-grid-alert] '.length))).toMatchObject({
      kind: 'rescan_held', reason: 'post_unknown', project_id: 'p1', run_id: 'r1', monitor_id: 'm1',
    });
  });

  it('posts one Slack message with kind, reason and ids, and never logs the webhook URL', async () => {
    vi.stubEnv('GEO_GRID_ALERT_WEBHOOK_URL', WEBHOOK);
    await notifyGridAlert({ kind: 'price_mismatch', reason: 'cost above reserve', run_id: 'r2', monitor_id: 'm2', detail: { actual: 0.0036 } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(WEBHOOK);
    expect(init.method).toBe('POST');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(String(init.body)) as { text: string };
    expect(Object.keys(body)).toEqual(['text']);
    expect(body.text).toContain('price_mismatch');
    expect(body.text).toContain('cost above reserve');
    expect(body.text).toContain('r2');
    expect(body.text).toContain('m2');
    expect(logged.join('\n')).not.toContain('secret-token');
  });

  it('dedupes the Slack post per process on kind|run_id|monitor_id|reason', async () => {
    vi.stubEnv('GEO_GRID_ALERT_WEBHOOK_URL', WEBHOOK);
    await notifyGridAlert({ kind: 'rescan_held', reason: 'timeout', run_id: 'r3' });
    await notifyGridAlert({ kind: 'rescan_held', reason: 'timeout', run_id: 'r3' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await notifyGridAlert({ kind: 'rescan_held', reason: 'post_unknown', run_id: 'r3' });
    await notifyGridAlert({ kind: 'rescan_held', reason: 'timeout', run_id: 'r4' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // Every alert is still logged.
    expect(logged.filter((l) => l.startsWith('[geo-grid-alert]'))).toHaveLength(4);
  });

  // Patch fork: start alerts have no run id yet, so the monitor keeps two monitors' alerts apart.
  it('dedupes per monitor, so two monitors with the same start failure both post', async () => {
    vi.stubEnv('GEO_GRID_ALERT_WEBHOOK_URL', WEBHOOK);
    await notifyGridAlert({ kind: 'scheduled_start_unclear', reason: 'unclear_post_stopped', monitor_id: 'grid-a' });
    await notifyGridAlert({ kind: 'scheduled_start_unclear', reason: 'unclear_post_stopped', monitor_id: 'grid-b' });
    await notifyGridAlert({ kind: 'scheduled_start_unclear', reason: 'unclear_post_stopped', monitor_id: 'grid-a' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('never throws when the webhook fails, and logs the failure without the URL', async () => {
    vi.stubEnv('GEO_GRID_ALERT_WEBHOOK_URL', WEBHOOK);
    fetchMock.mockImplementation(async () => { throw new Error(`connect ECONNREFUSED ${WEBHOOK}`); });
    await expect(notifyGridAlert({ kind: 'rescan_error', reason: 'boom', run_id: 'r5' })).resolves.toBeUndefined();
    fetchMock.mockImplementation(async () => new Response('no', { status: 500 }));
    await expect(notifyGridAlert({ kind: 'rescan_error', reason: 'boom', run_id: 'r6' })).resolves.toBeUndefined();
    expect(logged.some((l) => l.includes('webhook'))).toBe(true);
    expect(logged.join('\n')).not.toContain('secret-token');
  });
});
