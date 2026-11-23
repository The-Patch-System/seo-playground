'use server';

// Patch fork: writes for the location-based Geo-grid pages. Every action takes the project ID from the
// page (never the sidebar's active project). Only the sales demo scan calls DataForSEO; everything else
// writes grid_schedules and the worker picks it up within about a minute.
import { randomUUID } from 'crypto';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  addClient, addKeywordToLocation, addLocation, deleteLocation, DEMO_PROJECT_ID, getLocation, LocationError, locationIdFor, requestRunNow,
  updateLocationSchedule, type LocationScheduleInput,
} from '@/lib/grid-locations-db';
import { getCredentials, gridSeriesId, saveGridSearchPendingForProject, type GridQueueMode, type GridScheduleFrequency, type GridSearchEntry } from '@/lib/db';
import { formatBusinessTarget } from '@/lib/grid-target';
import { DEFAULT_GRID_SIZE, spacingKmForRadius } from '@/lib/grid-radius';
import { postGridTasksQueue } from '../../local-finder/grid-api';
import { CLIENTS_URL, clientUrl, keywordUrl, locationUrl } from '../_components/routes';

export interface ActionState {
  error?: string;
  message?: string;
}

function text(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}

function failure(error: unknown): ActionState {
  if (error instanceof LocationError) return { error: error.message };
  console.error('[geo-grid action]', error);
  return { error: 'Something went wrong. Try again, and tell Trazon if it keeps happening.' };
}

function scheduleFromForm(formData: FormData): LocationScheduleInput {
  const frequency = text(formData, 'frequency') as GridScheduleFrequency;
  const dayRaw = frequency === 'weekly' ? text(formData, 'weekday') : text(formData, 'day_of_month');
  return {
    frequency,
    day: frequency === 'daily' ? null : Number.parseInt(dayRaw, 10),
    time_of_day: text(formData, 'time_of_day'),
    queue_mode: (text(formData, 'queue_mode') || 'standard') as GridQueueMode,
  };
}

export async function addClientAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  let projectId: string;
  try {
    ({ projectId } = addClient(text(formData, 'name'), text(formData, 'domain')));
  } catch (error) {
    return failure(error);
  }
  revalidatePath(CLIENTS_URL);
  redirect(clientUrl(projectId));
}

export async function addLocationAction(projectId: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  let locationId: string;
  try {
    const [lat, lng] = text(formData, 'center').split(',').map((part) => Number.parseFloat(part.trim()));
    const gridSize = Number.parseInt(text(formData, 'grid_size'), 10) || DEFAULT_GRID_SIZE;
    const radiusMi = Number.parseFloat(text(formData, 'radius_mi'));
    if (!Number.isFinite(radiusMi) || radiusMi <= 0) return { error: 'Pick a radius.' };
    ({ locationId } = addLocation(projectId, {
      business: { name: text(formData, 'business_name'), cid: text(formData, 'business_cid') || null },
      center: { lat, lng },
      keywords: text(formData, 'keywords').split(/\r?\n/).map((k) => k.trim()).filter(Boolean),
      grid_size: gridSize,
      spacing_km: spacingKmForRadius(radiusMi, gridSize),
      schedule: scheduleFromForm(formData),
    }));
  } catch (error) {
    return failure(error);
  }
  revalidatePath(clientUrl(projectId));
  redirect(locationUrl(projectId, locationId));
}

export async function addKeywordAction(projectId: string, locationId: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  try {
    const added = addKeywordToLocation(projectId, locationId, text(formData, 'keyword'));
    revalidatePath(locationUrl(projectId, locationId));
    return { message: `Added "${added.keyword}". Its first scan starts within a minute.` };
  } catch (error) {
    return failure(error);
  }
}

export async function runNowAction(projectId: string, locationId: string, seriesId: string | null): Promise<ActionState> {
  try {
    const result = requestRunNow(projectId, locationId, seriesId);
    revalidatePath(locationUrl(projectId, locationId), 'layout');
    // Group skipped keywords by reason, so one reason isn't repeated for every keyword.
    const byReason = new Map<string, string[]>();
    for (const s of result.skipped) byReason.set(s.reason, [...(byReason.get(s.reason) ?? []), s.keyword]);
    const skipped = [...byReason].map(([reason, keywords]) => `${keywords.join(', ')}: ${reason}`);
    if (result.queued.length === 0) return { error: skipped.length ? `Nothing started. ${skipped.join(' ')}` : 'Nothing to run.' };
    const started = result.queued.length === 1 ? 'Scan queued' : `${result.queued.length} scans queued`;
    return { message: `${started}; it starts within a minute.${skipped.length ? ` Skipped ${skipped.join(' ')}` : ''}` };
  } catch (error) {
    return failure(error);
  }
}

export async function updateScheduleAction(projectId: string, locationId: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  try {
    const result = updateLocationSchedule(projectId, locationId, scheduleFromForm(formData));
    revalidatePath(locationUrl(projectId, locationId), 'layout');
    if (result.updated === 0) return { message: 'No changes to save.' };
    const oneTime = result.oneTime ? ` ${result.oneTime} one-time ${result.oneTime === 1 ? 'scan was' : 'scans were'} left alone.` : '';
    return { message: `Saved for ${result.updated} ${result.updated === 1 ? 'keyword' : 'keywords'}.${oneTime}` };
  } catch (error) {
    return failure(error);
  }
}

export async function deleteLocationAction(projectId: string, locationId: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  try {
    const location = getLocation(projectId, locationId);
    if (!location) return { error: 'Location not found.' };
    if (text(formData, 'confirm').trim().toLowerCase() !== location.name.trim().toLowerCase()) {
      return { error: `Type "${location.name}" to confirm.` };
    }
    deleteLocation(projectId, locationId);
  } catch (error) {
    return failure(error);
  }
  revalidatePath(clientUrl(projectId));
  redirect(clientUrl(projectId));
}

/**
 * Sales demo scan: one-time, runs immediately (Standard queue), saved to the sales demo project and
 * never scheduled. The worker collects the results; the keyword page shows progress.
 */
export async function demoScanAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const name = text(formData, 'business_name').trim();
  const cid = text(formData, 'business_cid').trim();
  const keyword = text(formData, 'keyword').replace(/\s+/g, ' ').trim();
  const [lat, lng] = text(formData, 'center').split(',').map((part) => Number.parseFloat(part.trim()));
  const gridSize = Number.parseInt(text(formData, 'grid_size'), 10) || DEFAULT_GRID_SIZE;
  const radiusMi = Number.parseFloat(text(formData, 'radius_mi'));
  if (!name) return { error: 'Pick the business from the map search.' };
  if (cid && !/^\d+$/.test(cid)) return { error: 'The business ID is not valid.' };
  if (!keyword) return { error: 'Enter a keyword.' };
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return { error: 'Pick the map center.' };
  if (![5, 7, 9].includes(gridSize)) return { error: 'Pick a grid size.' };
  if (!Number.isFinite(radiusMi) || radiusMi <= 0 || radiusMi > 20) return { error: 'Pick a radius.' };
  const creds = getCredentials();
  if (!creds) return { error: 'DataForSEO credentials are not set up.' };

  const target = cid ? formatBusinessTarget(name, cid) : name;
  const center = `${lat.toFixed(6)},${lng.toFixed(6)}`;
  const spacingKm = spacingKmForRadius(radiusMi, gridSize);
  const language = 'English';
  const seriesId = gridSeriesId(keyword, center, gridSize, spacingKm, target, language);
  const entry: GridSearchEntry = {
    id: `demo-${randomUUID()}`, ts: Date.now(), series_id: seriesId, keyword, target, center,
    grid_size: gridSize, spacing_km: spacingKm, language, status: 'pending', queue_mode: 'standard',
  };
  const result = await postGridTasksQueue(keyword, center, gridSize, spacingKm, language, creds.login, creds.pass, 'standard');
  // A failure after some chunks were posted still leaves billed tasks to collect.
  if (result.taskPoints.length > 0) saveGridSearchPendingForProject(DEMO_PROJECT_ID, { ...entry, cost: result.cost }, result.taskPoints);
  if (result.error && result.taskPoints.length === 0) return { error: `DataForSEO: ${result.error}` };

  revalidatePath(clientUrl(DEMO_PROJECT_ID), 'layout');
  redirect(keywordUrl(DEMO_PROJECT_ID, locationIdFor(DEMO_PROJECT_ID, target, center), seriesId));
}
