import "server-only";
import type { Database } from "@/lib/db/database";
import { findUserByEmail, setPasswordHash, type User } from "@/lib/db/users";
import { clearAttempts } from "@/lib/db/login-throttle";
import { deleteUserSessions } from "@/lib/db/sessions";
import { DEFAULT_COST, hashPassword, type ScryptCost } from "@/lib/auth/password";
import { checkEmail, checkPassword } from "@/lib/auth/user-input";

/**
 * Sets a new password for an EXISTING account (used by
 * `npm run user:reset-password`). Same rules and the same scrypt hashing as
 * `npm run user:create` (createUser). Never creates a user, and changes only
 * that user's password hash — not the email, name, role, active flag or
 * company memberships. Like a reset on the Users page, the user is then signed
 * out everywhere (whoever may have had the old password loses access) and their
 * failed sign-in attempts are cleared (so the new password works straight away).
 * Everything is checked again here, whatever the caller already checked.
 */

export type ResetPasswordInput = {
  email: string;
  password: string;
  passwordConfirmation: string;
};

export type ResetPasswordResult =
  | { ok: true; user: User }
  | { ok: false; errors: Partial<Record<keyof ResetPasswordInput, string>> };

export const NO_SUCH_USER = "There is no user with this email.";

export async function resetPassword(
  db: Database,
  input: ResetPasswordInput,
  cost: ScryptCost = DEFAULT_COST
): Promise<ResetPasswordResult> {
  const email = checkEmail(input.email);
  if (!email.ok) return { ok: false, errors: { email: email.error } };
  const password = checkPassword(input.password, input.passwordConfirmation, email.value);
  if (!password.ok) return { ok: false, errors: { password: password.error } };

  const user = await findUserByEmail(db, email.value);
  if (!user) return { ok: false, errors: { email: NO_SUCH_USER } };

  const updated = await setPasswordHash(db, user.id, await hashPassword(password.value, cost));
  if (!updated) return { ok: false, errors: { email: NO_SUCH_USER } };
  await deleteUserSessions(db, user.id);
  await clearAttempts(db, `email:${user.email}`);
  return { ok: true, user };
}
