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
