'use server';

import {
  getCredentials, getTrackedKeywords, addTrackedKeyword,
  removeTrackedKeyword, saveRankCheck, getSetting, setSetting,
  addTargetDomain, removeTargetDomain, getActiveProject,
  saveRankTrackerSchedule, deleteRankTrackerSchedule,
} from '@/lib/db';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { queueStandardRankChecksForProject } from '@/lib/rank-queue';

interface SerpItem {
  type: string;
  rank_group?: number;
  rank_absolute?: number;
  url?: string;
  title?: string;
  domain?: string;
}

interface SerpResponse {
  tasks?: Array<{
    id?: string;
    status_code?: number;
    cost?: number;
    result?: Array<{ items?: SerpItem[] }>;
  }>;
}

function cleanDomain(d: string) {
  return d.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '');
}

type RankKeyword = { id: number; keyword: string; domain: string; location: string; language: string };

function rankOf(item: SerpItem | undefined) {
  return item?.rank_group ?? item?.rank_absolute ?? null;
}

async function checkKeywordLive(keyword: RankKeyword, auth: string, depth: number) {
  try {
    const response = await fetch('https://api.dataforseo.com/v3/serp/google/organic/live/regular', {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      // The Live endpoint accepts exactly one task per request.
      body: JSON.stringify([{ keyword: keyword.keyword, location_name: keyword.location, language_name: keyword.language, depth }]),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) return;
    const data = await response.json() as SerpResponse;
    const task = data.tasks?.[0];
    if (task?.status_code !== 20000) return;
    const domain = cleanDomain(keyword.domain).split('/')[0];
    const hit = (task.result?.[0]?.items ?? []).find((item) => {
      if (item.type !== 'organic') return false;
      const itemDomain = cleanDomain(item.domain ?? item.url ?? '').split('/')[0];
      return itemDomain === domain || itemDomain.endsWith(`.${domain}`);
    });
    saveRankCheck(keyword.id, rankOf(hit), hit?.url ?? null, hit?.title ?? null, task.cost ?? null);
  } catch {
    // Preserve the previous result; a later scheduled check can retry a transient failure.
  }
}

/** Immediate checks are deliberately individual: DataForSEO Live rejects multi-task payloads. */
async function checkKeywordsLive(keywords: RankKeyword[]) {
  const creds = getCredentials();
  if (!creds || keywords.length === 0) return;
  const depth = parseInt(getSetting('rank_tracker_depth') ?? '20', 10);
  const auth = btoa(`${creds.login}:${creds.pass}`);
  const queue = [...keywords];
  const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
    while (queue.length > 0) {
      const keyword = queue.shift();
      if (keyword) await checkKeywordLive(keyword, auth, depth);
    }
  });
  await Promise.all(workers);
}

async function queueStandardRankChecks(
  keywords: Array<{ id: number; keyword: string; domain: string; location: string; language: string }>,
) {
  const creds = getCredentials();
  if (!creds || keywords.length === 0) return;
  const depth = parseInt(getSetting('rank_tracker_depth') ?? '20', 10);
  await queueStandardRankChecksForProject(getActiveProject().id, keywords, creds, depth);
}

export async function saveDepthAction(formData: FormData) {
  const depth = formData.get('rank_tracker_depth') as string;
  const valid = ['10', '20', '50', '100'];
  if (valid.includes(depth)) setSetting('rank_tracker_depth', depth);
  revalidatePath('/dashboard/rank-tracker');
}

export async function saveRankScheduleAction(formData: FormData) {
  const enabled = formData.get('enabled') === 'on';
  if (!enabled) deleteRankTrackerSchedule();
  else {
    saveRankTrackerSchedule({
      timeOfDay: String(formData.get('time_of_day') ?? '08:00'),
      timeZone: String(formData.get('time_zone') ?? 'UTC'),
    });
  }
  revalidatePath('/dashboard/rank-tracker');
}

export async function addDomainAction(formData: FormData) {
  const domain = (formData.get('domain') as string)?.trim();
  if (!domain) return;
  addTargetDomain(domain);
  revalidatePath('/dashboard/rank-tracker');
  redirect(`/dashboard/rank-tracker?domain=${encodeURIComponent(domain.toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, ''))}`);
}

export async function removeDomainAction(formData: FormData) {
  const domain = formData.get('domain') as string;
  if (!domain) return;
  removeTargetDomain(domain);
  redirect('/dashboard/rank-tracker');
}

export async function addKeywordAction(formData: FormData) {
  const raw = (formData.get('keywords') as string) ?? '';
  const domain = (formData.get('domain') as string)?.trim();
  const location = (formData.get('location') as string)?.trim() || 'France';
  const language = (formData.get('language') as string)?.trim() || 'French';

  if (!domain) return;
  addTargetDomain(domain);

  const kwList = raw.split('\n').map((k) => k.trim()).filter(Boolean).slice(0, 50);
  if (kwList.length === 0) return;

  const toCheck: Array<{ id: number; keyword: string; domain: string; location: string; language: string }> = [];
  for (const keyword of kwList) {
    const id = addTrackedKeyword(keyword, domain, location, language);
    toCheck.push({ id, keyword, domain, location, language });
  }

  await checkKeywordsLive(toCheck);
  revalidatePath('/dashboard/rank-tracker');
}

export async function removeKeywordAction(formData: FormData) {
  const id = Number(formData.get('id'));
  if (!id) return;
  removeTrackedKeyword(id);
  revalidatePath('/dashboard/rank-tracker');
}

export async function checkOneAction(formData: FormData) {
  const id = Number(formData.get('id'));
  const keyword = formData.get('keyword') as string;
  const domain = formData.get('domain') as string;
  const location = formData.get('location') as string;
  const language = formData.get('language') as string;
  if (!id || !keyword || !domain) return;
  await queueStandardRankChecks([{ id, keyword, domain, location, language }]);
  revalidatePath('/dashboard/rank-tracker');
}

export async function checkAllAction(formData: FormData) {
  const domain = (formData.get('domain') as string | null)?.trim() ?? '';
  const keywords = getTrackedKeywords();
  await queueStandardRankChecks(keywords);
  redirect(domain ? `/dashboard/rank-tracker?domain=${encodeURIComponent(domain)}` : '/dashboard/rank-tracker');
}

export async function checkDomainAction(formData: FormData) {
  const domain = formData.get('domain') as string;
  if (!domain) return;
  const keywords = getTrackedKeywords().filter((k) => k.domain === domain);
  await queueStandardRankChecks(keywords);
  redirect(`/dashboard/rank-tracker?domain=${encodeURIComponent(domain)}`);
}
