// Patch fork: request handling for the temporary re-scan endpoint (the logic is in grid-rescan.test.ts).
import { describe, it, expect, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rescans-route-test-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.REPORTING_API_KEY = 'test-key';

import { GET, POST } from './route';

afterAll(() => { vi.unstubAllGlobals(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

// No DataForSEO calls are expected from any request here.
vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('unexpected network call'); }));

const url = 'http://localhost/api/v1/geo-grid/rescans';
const post = (body: unknown, key: string | null = 'test-key') => POST(new NextRequest(url, {
  method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers: key ? { 'x-api-key': key } : {},
}));

describe('/api/v1/geo-grid/rescans', () => {
  it('rejects requests without the API key', async () => {
    expect((await post({ run_ids: ['a'] }, null)).status).toBe(401);
    expect((await post({ run_ids: ['a'] }, 'wrong')).status).toBe(401);
    expect((await GET(new NextRequest(url))).status).toBe(401);
  });

  it('previews by default and returns a manifest', async () => {
    const response = await post({ run_ids: ['missing-run'], label: 'nov15' });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ manifest_id: expect.any(String), label: 'nov15', startable: true, runs: 0, selected: [] });
  });

  it('validates the preview selector', async () => {
    const response = await post({});
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'A date or run_ids is required.' });
    expect((await post('not json')).status).toBe(400);
    expect((await post([1, 2])).status).toBe(400);
  });

  it('start needs a manifest_id from a preview', async () => {
    expect(await (await post({ action: 'start' })).json()).toEqual({ error: 'start needs the manifest_id from a preview.' });
    const unknown = await post({ action: 'start', manifest_id: 'nope' });
    expect(unknown.status).toBe(400);
    expect((await unknown.json()).error).toMatch(/Manifest not found/);
  });

  it('rejects more than 25 run_ids for cancel/undo/retry', async () => {
    const ids = Array.from({ length: 26 }, (_, i) => `run-${i}`);
    const response = await post({ action: 'cancel', run_ids: ids });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'At most 25 run_ids per call.' });
    expect((await post({ action: 'undo' })).status).toBe(400);
    const ok = await post({ action: 'retry', run_ids: ['run-0'] });
    expect(await ok.json()).toEqual({ results: [{ run_id: 'run-0', ok: false, error: 'No re-scan for this run.' }] });
  });

  it('validates the budget and unknown actions', async () => {
    expect((await post({ action: 'budget', limit_usd: -1 })).status).toBe(400);
    const set = await post({ action: 'budget', limit_usd: 12.5 });
    expect((await set.json()).budget).toMatchObject({ limit_usd: 12.5, available: 12.5 });
    expect((await post({ action: 'nope' })).status).toBe(400);
  });

  it('GET returns status, or the unsafe list', async () => {
    const status = await (await GET(new NextRequest(url, { headers: { 'x-api-key': 'test-key' } }))).json();
    expect(status).toMatchObject({ counts: {}, runs: [], wrong_city_detections: [] });
    const unsafe = await (await GET(new NextRequest(`${url}?unsafe=true`, { headers: { authorization: 'Bearer test-key' } }))).json();
    expect(unsafe).toEqual({ unsafe: [], not_checked_runs: 0 });
  });
});
