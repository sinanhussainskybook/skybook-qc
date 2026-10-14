import type { Database } from "@/lib/db/database";
import type { ContentDetections } from "@/lib/qc/detections";

/** Which provider processed a run (migration 0007 added "local"). */
export type AnalysisProviderName = "mock" | "google" | "local" | "gemini";

/**
 * Content analysis runs (Phase 6, 6.10) — table qc_analysis_runs. Temporary:
 * deleted with their session. The table is also the worker's queue.
 *
 * Every change is guarded by the run's current status, so a run that was
 * cancelled, finished or taken over after going stale can't be overwritten
 * by a slow worker.
 */

export type RunKind = "content" | "information";
export type RunStatus = "queued" | "processing" | "done" | "failed" | "cancelled";

export type AnalysisRun = {
  id: string;
  session_id: string;
  requested_by: string;
  kind: RunKind;
  provider: AnalysisProviderName;
  status: RunStatus;
  stage: string | null;
  progress_done: number;
  progress_total: number;
  attempts: number;
  files_fingerprint: string;
  analysed_share: number | null;
  failure_reason: string | null;
  created_at: Date;
  started_at: Date | null;
  heartbeat_at: Date | null;
  finished_at: Date | null;
};

const COLUMNS =
  "id, session_id, requested_by, kind, provider, status, stage, progress_done, progress_total, attempts, " +
  "files_fingerprint, analysed_share, failure_reason, created_at, started_at, heartbeat_at, finished_at";

/** Queues a run. Returns null when the session already has an active run. */
export async function insertRun(
  db: Database,
  input: { sessionId: string; userId: string; kind: RunKind; provider: AnalysisProviderName; fingerprint: string },
  now: Date
): Promise<AnalysisRun | null> {
  const [row] = await db.query<AnalysisRun>(
    `insert into qc_analysis_runs (session_id, requested_by, kind, provider, files_fingerprint, created_at)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (session_id) where status in ('queued', 'processing') do nothing
     returning ${COLUMNS}`,
    [input.sessionId, input.userId, input.kind, input.provider, input.fingerprint, now]
  );
  return row ?? null;
}

/**
 * A run still waiting to start takes in files added since it was queued (another
 * information file uploaded straight after the first). Returns false once it has started.
 */
export async function refreshQueuedFingerprint(db: Database, runId: string, fingerprint: string): Promise<boolean> {
  const rows = await db.query("update qc_analysis_runs set files_fingerprint = $2 where id = $1 and status = 'queued' returning id", [runId, fingerprint]);
  return rows.length > 0;
}

/** How many runs a session has had — of one kind when `kind` is given. */
export async function countRuns(db: Database, sessionId: string, kind?: RunKind): Promise<number> {
  const [row] = await db.query<{ count: number }>(
    "select count(*)::int as count from qc_analysis_runs where session_id = $1 and ($2::text is null or kind = $2)",
    [sessionId, kind ?? null]
  );
  return Number(row.count);
}

export async function findRun(db: Database, runId: string): Promise<AnalysisRun | null> {
  const [row] = await db.query<AnalysisRun>(`select ${COLUMNS} from qc_analysis_runs where id = $1`, [runId]);
  return row ?? null;
}

/** The session's newest run (of a kind, or any). */
export async function latestRun(db: Database, sessionId: string, kind?: RunKind): Promise<AnalysisRun | null> {
  const [row] = await db.query<AnalysisRun>(
    `select ${COLUMNS} from qc_analysis_runs
      where session_id = $1 and ($2::text is null or kind = $2)
      order by created_at desc, id desc limit 1`,
    [sessionId, kind ?? null]
  );
  return row ?? null;
}

/**
 * Has this session's design been checked to the end — a finished design (content) analysis, so a QC
 * result exists? Such a check is complete: Start a QC check never reopens it (it starts a fresh one).
 */
export async function hasFinishedDesignCheck(db: Database, sessionId: string): Promise<boolean> {
  const [row] = await db.query<{ done: boolean }>(
    "select exists (select 1 from qc_analysis_runs where session_id = $1 and kind = 'content' and status = 'done') as done",
    [sessionId]
  );
  return Boolean(row?.done);
}

/** The detections of the session's newest finished content run, with what it analysed. */
export async function latestDetections(
  db: Database,
  sessionId: string
): Promise<{ runId: string; provider: AnalysisProviderName; fingerprint: string; analysedShare: number | null; detections: ContentDetections } | null> {
  const [row] = await db.query<{ id: string; provider: AnalysisProviderName; files_fingerprint: string; analysed_share: number | null; detections: ContentDetections | string }>(
    `select id, provider, files_fingerprint, analysed_share, detections from qc_analysis_runs
      where session_id = $1 and kind = 'content' and status = 'done' and detections is not null
      order by finished_at desc nulls last, created_at desc limit 1`,
    [sessionId]
  );
  if (!row) return null;
  const detections = typeof row.detections === "string" ? (JSON.parse(row.detections) as ContentDetections) : row.detections;
  return { runId: row.id, provider: row.provider, fingerprint: row.files_fingerprint, analysedShare: row.analysed_share === null ? null : Number(row.analysed_share), detections };
}

/** The worker takes the oldest queued run for ITS provider; concurrent workers never take the same one. */
export async function claimNextRun(db: Database, now: Date, provider: AnalysisProviderName): Promise<AnalysisRun | null> {
  // Only runs created for this worker's provider: a worker set up for another
  // provider (e.g. a mock worker next to a Gemini one) must never take them.
  const [row] = await db.query<AnalysisRun>(
    `update qc_analysis_runs
        set status = 'processing', attempts = attempts + 1, started_at = coalesce(started_at, $1), heartbeat_at = $1
      where id = (
        select id from qc_analysis_runs where status = 'queued' and provider = $2 order by created_at, id for update skip locked limit 1
      )
      returning ${COLUMNS}`,
    [now, provider]
  );
  return row ?? null;
}

/** Keeps a processing run alive and records progress. False when the run is no longer ours. */
export async function heartbeat(
  db: Database,
  runId: string,
  now: Date,
  progress?: { stage: string; done: number; total: number }
): Promise<boolean> {
  const rows = await db.query(
    `update qc_analysis_runs
        set heartbeat_at = $2,
            stage = coalesce($3, stage),
            progress_done = coalesce($4, progress_done),
            progress_total = coalesce($5, progress_total)
      where id = $1 and status = 'processing'
      returning id`,
    [runId, now, progress?.stage.slice(0, 80) ?? null, progress?.done ?? null, progress?.total ?? null]
  );
  return rows.length > 0;
}

/**
 * Marks a run done. A content run stores its validated detections, and older
 * runs of the session lose theirs — one ContentDetections per session.
 */
export async function finishRun(
  db: Database,
  runId: string,
  result: { detections?: ContentDetections; analysedShare?: number },
  now: Date
): Promise<boolean> {
  const rows = await db.query<{ session_id: string }>(
    `update qc_analysis_runs
        set status = 'done', finished_at = $2, heartbeat_at = $2, detections = $3::jsonb, analysed_share = $4,
            stage = 'Finished', progress_done = progress_total
      where id = $1 and status = 'processing'
      returning session_id`,
    [runId, now, result.detections ? JSON.stringify(result.detections) : null, result.analysedShare ?? null]
  );
  if (!rows.length) return false;
  if (result.detections) {
    await db.query("update qc_analysis_runs set detections = null where session_id = $1 and id <> $2 and detections is not null", [
      rows[0].session_id,
      runId,
    ]);
  }
  return true;
}

export async function failRun(db: Database, runId: string, reason: string, now: Date): Promise<boolean> {
  const rows = await db.query(
    `update qc_analysis_runs set status = 'failed', failure_reason = $2, finished_at = $3, stage = 'Failed'
      where id = $1 and status in ('queued', 'processing') returning id`,
    [runId, reason.slice(0, 300), now]
  );
  return rows.length > 0;
}

export async function cancelRun(db: Database, runId: string, reason: string, now: Date): Promise<boolean> {
  const rows = await db.query(
    `update qc_analysis_runs set status = 'cancelled', failure_reason = $2, finished_at = $3, stage = 'Cancelled'
      where id = $1 and status in ('queued', 'processing') returning id`,
    [runId, reason.slice(0, 300), now]
  );
  return rows.length > 0;
}

/**
 * Crash recovery: a processing run whose worker stopped sending heartbeats
 * is queued again, or failed once it has used its attempts.
 */
export async function recoverStaleRuns(
  db: Database,
  now: Date,
  staleBefore: Date,
  maxAttempts: number
): Promise<{ requeued: number; failed: number }> {
  const failed = await db.query(
    `update qc_analysis_runs
        set status = 'failed', failure_reason = 'The analysis stopped responding.', finished_at = $1, stage = 'Failed'
      where status = 'processing' and heartbeat_at < $2 and attempts >= $3 returning id`,
    [now, staleBefore, maxAttempts]
  );
  const requeued = await db.query(
    `update qc_analysis_runs set status = 'queued', stage = 'Waiting to restart'
      where status = 'processing' and heartbeat_at < $1 and attempts < $2 returning id`,
    [staleBefore, maxAttempts]
  );
  return { requeued: requeued.length, failed: failed.length };
}
