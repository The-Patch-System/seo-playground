import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { NextRequest, NextResponse } from 'next/server';
import {
  claimDueGridSchedules, claimDueRankTrackerSchedules, claimDuePromptTrackerSchedules, getCredentials, getPendingGridEntriesForProject,
  getProjects, getTrackedKeywordsForProject, getTrackedPrompts, pruneGridHistoryForProject, retryClaimedGridSchedule, retryClaimedRankTrackerSchedule, saveGridSearchPendingForProject, type GridSearchEntry,
} from '@/lib/db';
import { runPromptChecks } from '@/lib/prompt-tracker';
import { postGridTasksQueue } from '@/app/dashboard/local-finder/grid-api';
import { collectGridProgress } from '@/lib/grid-progress';
import { advanceRescans, newRescanCounters } from '@/lib/grid-rescan';
import { notifyGridAlert } from '@/lib/grid-alerts';
import { collectRankProgress } from '@/lib/rank-progress';
import { queueStandardRankChecksForProject } from '@/lib/rank-queue';

export const dynamic = 'force-dynamic';

function getCronSecret() {
  if (process.env.CRON_SECRET?.trim()) return process.env.CRON_SECRET.trim();
  if (!process.env.CRON_SECRET_FILE) return null;
  try {
    return readFileSync(process.env.CRON_SECRET_FILE, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

function isAuthorized(request: NextRequest) {
  const secret = getCronSecret();
  if (!secret) return false;
  const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? request.headers.get('x-cron-secret');
  return token === secret;
}

// One pass at a time per process. A pass walks every project sequentially and can
// outlast the worker interval; overlapping passes would only queue duplicate polling.
let passInProgress = false;

// Patch fork: start at most this many scheduled monitors per pass (one pass a minute). Hundreds of
// clinics share the 15th, so they start in waves instead of one burst against DataForSEO.
const MAX_GRID_CLAIMS_PER_PASS = Math.max(1, Number.parseInt(process.env.GEO_GRID_MAX_CLAIMS_PER_PASS ?? '20', 10) || 20);
// Patch fork: retention (starting-point scan + last ~6 months) is OFF by default so no map scans are deleted.
// Set GRID_RETENTION_ENABLED=true on the app service to turn it back on. When on, it runs at most once a day.
let lastPruneAt = 0;

/**
 * Invoke this endpoint every 5–15 minutes from the platform scheduler. It claims
 * all due schedules before posting them to DataForSEO, so overlapping cron calls
 * cannot produce duplicate Geo-grid or Rank Tracker runs.
 */
export async function GET(request: NextRequest) {
  if (!getCronSecret()) {
    return NextResponse.json({ error: 'The Geo-grid worker secret is not configured.' }, { status: 503 });
  }
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const credentials = getCredentials();
  if (!credentials) return NextResponse.json({ error: 'DataForSEO credentials are not configured.' }, { status: 503 });

  if (passInProgress) return NextResponse.json({ busy: true });
  passInProgress = true;
  try {
    return NextResponse.json(await runPass(credentials));
  } finally {
    passInProgress = false;
  }
}

async function runPass(credentials: { login: string; pass: string }) {

  const due = claimDueGridSchedules(Date.now(), MAX_GRID_CLAIMS_PER_PASS);
  const dueRankSchedules = claimDueRankTrackerSchedules();
  const started: string[] = [];
  const failed: Array<{ seriesId: string; error: string }> = [];

  let gridRetries = 0;
  for (const schedule of due) {
    try {
      const result = await postGridTasksQueue(
        schedule.keyword, schedule.center, schedule.grid_size, schedule.spacing_km, schedule.language,
        credentials.login, credentials.pass, schedule.queue_mode === 'priority' ? 'priority' : 'standard', schedule.series_id,
      );
      if (result.error) failed.push({ seriesId: schedule.series_id, error: result.error });
      const alertBase = {
        project_id: schedule.projectId, monitor_id: schedule.series_id,
        detail: { error: result.error ?? null, slot: new Date(schedule.scheduled_at).toISOString(), unclear_posts: schedule.unclear_posts + (result.unclear ? 1 : 0) },
      };
      // Patch fork: count accepted tasks, not task points (refused tasks are kept as retry-pending points).
      if (result.accepted === 0) {
        if (result.unclear) {
          // Patch fork: the answer was unclear (timeout, 5xx, odd body), so DataForSEO may have queued and
          // billed these tasks with no task id for us to collect. One retry, then stop; both are alerted.
          const retrying = retryClaimedGridSchedule(schedule.projectId, schedule, Date.now(), undefined, true);
          if (retrying) gridRetries += 1;
          void notifyGridAlert({ kind: 'scheduled_start_unclear', reason: retrying ? 'unclear_post_retrying' : 'unclear_post_stopped', ...alertBase });
          continue;
        }
        // Refused (or never sent): nothing was queued or billed, so the slot can safely be attempted again.
        if (retryClaimedGridSchedule(schedule.projectId, schedule)) gridRetries += 1;
        else void notifyGridAlert({ kind: 'scheduled_start_failed', reason: 'retry_window_used', ...alertBase });
        continue;
      }
      // Patch fork: some tasks were accepted, but others got an unclear answer: the run will end
      // incomplete (and alert as unsafe then); raise it now too.
      if (result.unclear) void notifyGridAlert({ kind: 'scheduled_start_unclear', reason: 'unclear_post_partial', ...alertBase });
      // A partial post is kept as-is: re-posting would bill the queued points twice.
      const entry: GridSearchEntry = {
        id: randomUUID(),
        series_id: schedule.series_id,
        ts: Date.now(),
        keyword: schedule.keyword,
        target: schedule.target,
        center: schedule.center,
        grid_size: schedule.grid_size,
        spacing_km: schedule.spacing_km,
        language: schedule.language,
        status: 'pending',
        queue_mode: schedule.queue_mode,
        cost: result.cost,
      };
      saveGridSearchPendingForProject(schedule.projectId, entry, result.taskPoints);
      started.push(entry.id);
    } catch (error) {
      // postGridTasksQueue reports API failures itself, so this is a local failure after
      // posting; retrying would bill the same points again.
      const message = error instanceof Error ? error.message : 'Could not start grid run.';
      failed.push({ seriesId: schedule.series_id, error: message });
      // Patch fork: billed tasks may now have no run to land in; never silent.
      void notifyGridAlert({ kind: 'scheduled_start_unclear', reason: 'start_error', project_id: schedule.projectId, monitor_id: schedule.series_id, detail: { error: message } });
    }
  }

  // Patch fork: the worker only prints a count, so name each failed start (monitor and reason) in the logs.
  for (const f of failed) console.error(`[geo-grid] scheduled run for monitor ${f.seriesId} did not start cleanly: ${f.error}`);

  let rankScheduled = 0;
  let rankScheduleRetries = 0;
  for (const schedule of dueRankSchedules) {
    try {
      const result = await queueStandardRankChecksForProject(
        schedule.projectId,
        getTrackedKeywordsForProject(schedule.projectId),
        credentials,
        parseInt(schedule.depth, 10) || 20,
      );
      rankScheduled += result.queued;
      if (result.failed) {
        retryClaimedRankTrackerSchedule(schedule.projectId, schedule.nextRunAt);
        rankScheduleRetries += 1;
      }
    } catch {
      retryClaimedRankTrackerSchedule(schedule.projectId, schedule.nextRunAt);
      rankScheduleRetries += 1;
    }
  }

  let pendingChecked = 0;
  let completed = 0;
  let rankPendingChecked = 0;
  let rankCompleted = 0;
  let rankFailed = 0;
  // Patch fork (temporary): in-place re-scans. Starts are paced across all projects per pass.
  const rescans = newRescanCounters();
  let rescanErrors = 0;
  let gridCollectErrors = 0;
  for (const project of getProjects()) {
    const pending = getPendingGridEntriesForProject(project.id);
    for (const entry of pending) {
      try {
        const status = await collectGridProgress(project.id, entry, credentials);
        pendingChecked += 1;
        if (status.status === 'done') completed += 1;
      } catch (error) {
        // Patch fork: DataForSEO failures are handled inside collectGridProgress, so this is a local
        // failure (e.g. unreadable stored data). The run stays pending and is retried next pass, but it
        // is counted and logged, not skipped silently.
        gridCollectErrors += 1;
        console.error(`[geo-grid] collecting run ${entry.id} (project ${project.id}) failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    try {
      await advanceRescans(project.id, credentials, rescans);
    } catch (error) {
      // Per-run errors are counted inside advanceRescans; this is a failure of the whole project step.
      rescanErrors += 1;
      console.error(`[geo-grid] re-scan pass failed for project ${project.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      const rankProgress = await collectRankProgress(project.id, credentials);
      rankPendingChecked += rankProgress.pending;
      rankCompleted += rankProgress.completed;
      rankFailed += rankProgress.failed;
    } catch {
      // A temporary API failure leaves local rank tasks pending for the next worker pass.
    }
  }

  // Prompt Tracker checks are synchronous (no task polling), so each due project runs to completion here.
  // A failed run is not retried: the calls already made would be billed again.
  const duePromptSchedules = claimDuePromptTrackerSchedules();
  let promptRuns = 0;
  let promptRunsFailed = 0;
  for (const schedule of duePromptSchedules) {
    try {
      const summary = await runPromptChecks(getTrackedPrompts(schedule.projectId), credentials, schedule.projectId);
      promptRuns += summary.ran;
      promptRunsFailed += summary.failed;
    } catch {
      promptRunsFailed += 1;
    }
  }

  let gridRunsPruned = 0;
  if (process.env.GRID_RETENTION_ENABLED === 'true' && Date.now() - lastPruneAt > 86_400_000) {
    lastPruneAt = Date.now();
    for (const project of getProjects()) {
      try {
        gridRunsPruned += pruneGridHistoryForProject(project.id);
      } catch {
        // Retention is housekeeping; a failure here must not affect scans.
      }
    }
  }

  return {
    due: due.length, started, failed, gridRetries, pendingChecked, completed, gridCollectErrors, gridRunsPruned,
    rescans: {
      started: rescans.started, collected: rescans.collected, swapped: rescans.swapped, held: rescans.held, orphaned: rescans.orphaned,
      errors: rescans.errors + rescanErrors,
    },
    rankSchedulesDue: dueRankSchedules.length, rankScheduled, rankScheduleRetries, rankPendingChecked, rankCompleted, rankFailed,
    promptSchedulesDue: duePromptSchedules.length, promptRuns, promptRunsFailed,
  };
}
