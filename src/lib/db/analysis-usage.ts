import type { Database } from "@/lib/db/database";

/**
 * Each user's AI analyses (design checks and brief readings together), for the per-user limits in
 * analysis/enqueue.ts: how many in the last 24 hours, and how many are waiting or running.
 *
 * Kept in the existing counter table `login_throttle`, so no migration is needed and — unlike the runs,
 * which go with their session — the count survives Start over and new checks. Two kinds of rows, both
 * written BEFORE a run is queued (a reservation), so a run the worker could pick up has always passed both
 * limits:
 *   - `ai:<user id>:<reservation id>`      one per analysis, for the rolling 24 hours;
 *   - `ai-slot:<user id>:<reservation id>` held only while the run is being queued (then the run itself
 *     counts as waiting); one left behind by a crash stops counting after SLOT_SECONDS.
 * The sign-in counters (keys `email:…`) are never touched. Every statement stands alone, so this is
 * correct with any number of database connections, web instances and workers: each request's rows are
 * saved before it counts, so of two requests at the same moment the later one always sees the earlier.
 */

const DAY_SECONDS = 24 * 60 * 60;
/** How long a reservation may take to become a queued run before it no longer holds a place. */
const SLOT_SECONDS = 120;

/** A key prefix for LIKE. User IDs are UUIDs (no % or _), but escape them anyway. */
const like = (prefix: string) => `${prefix.replace(/[\\%_]/g, "\\$&")}%`;
const dayKey = (userId: string, id = "") => `ai:${userId}:${id}`;
const slotKey = (userId: string, id = "") => `ai-slot:${userId}:${id}`;

/** Holds a place for one analysis: counted in the 24 hours, and as waiting until the run is queued. */
export async function reserveAnalysis(db: Database, userId: string, reservationId: string, now: Date): Promise<void> {
  // The user's rows that no longer count are forgotten first.
  await db.query(
    `delete from login_throttle
      where (key like $1 and window_started_at <= $3::timestamptz - ($4::int * interval '1 second'))
         or (key like $2 and window_started_at <= $3::timestamptz - ($5::int * interval '1 second'))`,
    [like(dayKey(userId)), like(slotKey(userId)), now, DAY_SECONDS, SLOT_SECONDS]
  );
  await db.query("insert into login_throttle (key, attempts, window_started_at) values ($1, 1, $3), ($2, 1, $3)", [
    dayKey(userId, reservationId),
    slotKey(userId, reservationId),
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
       (select count(*)::int from login_throttle
         where key like $2 and window_started_at > $4::timestamptz - ($5::int * interval '1 second')) as today,
       (select min(window_started_at) from login_throttle
         where key like $2 and window_started_at > $4::timestamptz - ($5::int * interval '1 second')) as oldest,
       (select count(*)::int from qc_analysis_runs where requested_by = $1 and status in ('queued', 'processing'))
       + (select count(*)::int from login_throttle
           where key like $3 and window_started_at > $4::timestamptz - ($6::int * interval '1 second')) as active`,
    [userId, like(dayKey(userId)), like(slotKey(userId)), now, DAY_SECONDS, SLOT_SECONDS]
  );
  return { today: Number(row.today), oldest: row.oldest ? new Date(row.oldest) : null, active: Number(row.active) };
}

/** The run is queued (it now counts as waiting itself): its reservation stops holding a place. */
export async function releaseAnalysisSlot(db: Database, userId: string, reservationId: string): Promise<void> {
  await db.query("delete from login_throttle where key = $1", [slotKey(userId, reservationId)]);
}

/** A refused or failed reservation: no run was queued, so nothing is counted. */
export async function cancelAnalysisReservation(db: Database, userId: string, reservationId: string): Promise<void> {
  await db.query("delete from login_throttle where key in ($1, $2)", [dayKey(userId, reservationId), slotKey(userId, reservationId)]);
}
