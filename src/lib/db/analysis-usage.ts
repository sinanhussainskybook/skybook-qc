import type { Database } from "@/lib/db/database";

/**
 * Each user's AI analyses (design checks and brief readings together), for the per-user limits in
 * analysis/enqueue.ts: how many in the last 24 hours, and how many are waiting or running.
 *
 * Kept in their own table `analysis_usage` (migration 0012) — unlike the runs, which go with their
 * session, the count survives Start over and new checks. One row per analysis, written BEFORE a run is
 * queued (a reservation), so a run the worker could pick up has always passed both limits:
 *   - it counts for 24 hours from `reserved_at`;
 *   - while `queuing` it also holds one of the user's "waiting or running" places (then the run itself
 *     counts as waiting); one left behind by a crash stops holding a place after SLOT_SECONDS.
 * Every statement stands alone, so this is correct with any number of database connections, web
 * instances and workers: each request's row is saved before it counts, so of two requests at the same
 * moment the later one always sees the earlier.
 */

const DAY_SECONDS = 24 * 60 * 60;
/** How long a reservation may take to become a queued run before it no longer holds a place. */
const SLOT_SECONDS = 120;

/** Holds a place for one analysis: counted in the 24 hours, and as waiting until the run is queued. */
export async function reserveAnalysis(db: Database, userId: string, reservationId: string, now: Date): Promise<void> {
  // The user's rows that no longer count are forgotten first.
  await db.query(
    "delete from analysis_usage where user_id = $1 and reserved_at <= $2::timestamptz - ($3::int * interval '1 second')",
    [userId, now, DAY_SECONDS]
  );
  await db.query("insert into analysis_usage (id, user_id, reserved_at, queuing) values ($1, $2, $3, true)", [
    reservationId,
    userId,
    now,
  ]);
}

/**
 * In ONE statement (one consistent view of both tables): the user's analyses in the 24 hours before
 * `now` (with the oldest, to say when the next is possible), and how many are waiting or running —
 * queued and processing runs plus places held by reservations still being queued.
 */
export async function analysisUsage(
  db: Database,
  userId: string,
  now: Date
): Promise<{ today: number; oldest: Date | null; active: number }> {
  const [row] = await db.query<{ today: number; oldest: Date | string | null; active: number }>(
    `select
       (select count(*)::int from analysis_usage
         where user_id = $1 and reserved_at > $2::timestamptz - ($3::int * interval '1 second')) as today,
       (select min(reserved_at) from analysis_usage
         where user_id = $1 and reserved_at > $2::timestamptz - ($3::int * interval '1 second')) as oldest,
       (select count(*)::int from qc_analysis_runs where requested_by = $1 and status in ('queued', 'processing'))
       + (select count(*)::int from analysis_usage
           where user_id = $1 and queuing and reserved_at > $2::timestamptz - ($4::int * interval '1 second')) as active`,
    [userId, now, DAY_SECONDS, SLOT_SECONDS]
  );
  return { today: Number(row.today), oldest: row.oldest ? new Date(row.oldest) : null, active: Number(row.active) };
}

/** The run is queued (it now counts as waiting itself): its reservation stops holding a place. */
export async function releaseAnalysisSlot(db: Database, userId: string, reservationId: string): Promise<void> {
  await db.query("update analysis_usage set queuing = false where id = $1 and user_id = $2", [reservationId, userId]);
}

/** A refused or failed reservation: no run was queued, so nothing is counted. */
export async function cancelAnalysisReservation(db: Database, userId: string, reservationId: string): Promise<void> {
  await db.query("delete from analysis_usage where id = $1 and user_id = $2", [reservationId, userId]);
}

/** Hourly clean-up: every user's analyses older than 24 hours (they no longer count). Returns how many. */
export async function pruneAnalysisUsage(db: Database, now: Date): Promise<number> {
  const rows = await db.query(
    "delete from analysis_usage where reserved_at <= $1::timestamptz - ($2::int * interval '1 second') returning 1",
    [now, DAY_SECONDS]
  );
  return rows.length;
}
