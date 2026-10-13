import type { Database } from "@/lib/db/database";
import type { User } from "@/lib/db/users";

/** The signed-in user, and whether they must choose a new password first. */
export type SessionUser = User & { mustChangePassword: boolean };

/**
 * Sign-in sessions (table `app_sessions`).
 *
 * `tokenHash` is the SHA-256 of the cookie token (auth/session-token.ts).
 * The token itself is never stored.
 */

export async function insertSession(
  db: Database,
  input: { tokenHash: string; userId: string; expiresAt: Date }
): Promise<void> {
  await db.query(
    "insert into app_sessions (id, user_id, expires_at) values ($1, $2, $3)",
    [input.tokenHash, input.userId, input.expiresAt]
  );
}

/**
 * The signed-in user for a session — only if the session hasn't expired
 * and the account is still active. Otherwise null.
 */
export async function findSessionUser(
  db: Database,
  tokenHash: string,
  now: Date
): Promise<SessionUser | null> {
  const [row] = await db.query<SessionUser>(
    `select u.id, u.name, u.email, u.role, u.active, u.must_change_password as "mustChangePassword"
       from app_sessions s
       join app_users u on u.id = s.user_id
      where s.id = $1
        and s.expires_at > $2
        and u.active`,
    [tokenHash, now]
  );
  return row ?? null;
}

export async function deleteSession(db: Database, tokenHash: string): Promise<void> {
  await db.query("delete from app_sessions where id = $1", [tokenHash]);
}

/**
 * Signs a user out everywhere (account switched off, deleted or given a new
 * password) — except, optionally, the session doing it.
 */
export async function deleteUserSessions(db: Database, userId: string, exceptTokenHash?: string): Promise<number> {
  const rows = await db.query<{ id: string }>(
    "delete from app_sessions where user_id = $1 and id is distinct from $2 returning id",
    [userId, exceptTokenHash ?? null]
  );
  return rows.length;
}

/** Housekeeping: remove sessions that have expired. */
export async function deleteExpiredSessions(db: Database, now: Date): Promise<void> {
  await db.query("delete from app_sessions where expires_at <= $1", [now]);
}
