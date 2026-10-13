import "server-only";
import type { Database } from "@/lib/db/database";
import { clearAttempts, recordAttempt } from "@/lib/db/login-throttle";
import {
  deleteExpiredSessions,
  deleteSession,
  findSessionUser,
  insertSession,
  type SessionUser,
} from "@/lib/db/sessions";
import { findUserForSignIn, type User } from "@/lib/db/users";
import { getDummyHash, verifyPassword } from "@/lib/auth/password";
import {
  generateSessionToken,
  hashSessionToken,
  isWellFormedSessionToken,
  SESSION_DURATION_MS,
} from "@/lib/auth/session-token";
import {
  EMAIL_MAX_LENGTH,
  normalizeEmail,
  PASSWORD_MAX_LENGTH,
} from "@/lib/auth/user-input";

/**
 * Signing in and out, and turning a cookie back into a user.
 * No Next.js here — the page code (actions.ts, current-user.ts) handles cookies.
 */

/** At most 5 attempts per email in 15 minutes. */
export const SIGN_IN_LIMIT = { maxAttempts: 5, windowSeconds: 15 * 60 };

export type SignInResult =
  | { ok: true; user: User; token: string; expiresAt: Date }
  | { ok: false; reason: "invalid" }
  | { ok: false; reason: "throttled"; retryAfterSeconds: number };

export async function signIn(
  db: Database,
  credentials: { email: string; password: string },
  now: Date = new Date()
): Promise<SignInResult> {
  const email = normalizeEmail(credentials.email);
  const { password } = credentials;
  if (!email || email.length > EMAIL_MAX_LENGTH) return { ok: false, reason: "invalid" };
  if (!password || [...password].length > PASSWORD_MAX_LENGTH) {
    return { ok: false, reason: "invalid" };
  }

  // Count the attempt first, keyed by the email typed (real or not).
  const throttleKey = `email:${email}`;
  const window = await recordAttempt(db, throttleKey, now, SIGN_IN_LIMIT.windowSeconds);
  if (window.attempts > SIGN_IN_LIMIT.maxAttempts) {
    const reopensAt = window.windowStartedAt.getTime() + SIGN_IN_LIMIT.windowSeconds * 1000;
    return {
      ok: false,
      reason: "throttled",
      retryAfterSeconds: Math.max(1, Math.ceil((reopensAt - now.getTime()) / 1000)),
    };
  }

  const account = await findUserForSignIn(db, email);
  // Always run one full password check, even with no account, so timing
  // doesn't reveal which emails exist.
  const passwordMatches = await verifyPassword(
    password,
    account?.passwordHash ?? (await getDummyHash())
  );
  if (!account || !passwordMatches || !account.active) {
    return { ok: false, reason: "invalid" };
  }

  await clearAttempts(db, throttleKey);

  const token = generateSessionToken();
  const expiresAt = new Date(now.getTime() + SESSION_DURATION_MS);
  await insertSession(db, { tokenHash: hashSessionToken(token), userId: account.id, expiresAt });
  await deleteExpiredSessions(db, now);

  // Hand back the user without the password hash.
  const user: User = {
    id: account.id,
    name: account.name,
    email: account.email,
    role: account.role,
    active: account.active,
  };
  return { ok: true, user, token, expiresAt };
}

/** The user a cookie token belongs to, or null if it isn't a live session. */
export async function getSessionUser(
  db: Database,
  token: string,
  now: Date = new Date()
): Promise<SessionUser | null> {
  if (!isWellFormedSessionToken(token)) return null;
  return findSessionUser(db, hashSessionToken(token), now);
}

export async function signOut(db: Database, token: string): Promise<void> {
  if (!isWellFormedSessionToken(token)) return;
  await deleteSession(db, hashSessionToken(token));
}
