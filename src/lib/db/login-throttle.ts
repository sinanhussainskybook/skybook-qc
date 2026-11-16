import type { Database } from "@/lib/db/database";

/**
 * Sign-in attempt counters (table `login_throttle`).
 *
 * Each attempt is counted *before* the password is checked, in one atomic
 * statement, so many attempts sent at the same moment can't slip past the
 * limit. A successful sign-in clears the counter.
 */

export type AttemptWindow = { attempts: number; windowStartedAt: Date };

/**
 * Count one attempt for `key`. If the current window is older than
 * `windowSeconds`, a new window starts at `now` with this attempt as the first.
 */
export async function recordAttempt(
  db: Database,
  key: string,
  now: Date,
  windowSeconds: number
): Promise<AttemptWindow> {
  const [row] = await db.query<{ attempts: number; window_started_at: Date | string }>(
    `insert into login_throttle as t (key, attempts, window_started_at)
     values ($1, 1, $2::timestamptz)
     on conflict (key) do update set
       attempts = case
         when t.window_started_at <= $2::timestamptz - ($3::int * interval '1 second') then 1
         else t.attempts + 1
       end,
       window_started_at = case
         when t.window_started_at <= $2::timestamptz - ($3::int * interval '1 second') then $2::timestamptz
         else t.window_started_at
       end
     returning attempts, window_started_at`,
    [key, now, windowSeconds]
  );
  return {
    attempts: Number(row.attempts),
    windowStartedAt: new Date(row.window_started_at),
  };
}

export async function clearAttempts(db: Database, key: string): Promise<void> {
  await db.query("delete from login_throttle where key = $1", [key]);
}

/** Every counter here lasts 15 minutes at most; rows idle for a day are only leftovers. */
const STALE_AFTER_SECONDS = 24 * 60 * 60;

/**
 * Hourly clean-up: counters whose window started more than a day ago (failed sign-ins that were never
 * followed by a successful one, per-IP counts, and the old `ai:` / `ai-slot:` rows from before
 * migration 0012). Returns how many were deleted.
 */
export async function pruneLoginThrottle(db: Database, now: Date): Promise<number> {
  const rows = await db.query(
    "delete from login_throttle where window_started_at <= $1::timestamptz - ($2::int * interval '1 second') returning 1",
    [now, STALE_AFTER_SECONDS]
  );
  return rows.length;
}
