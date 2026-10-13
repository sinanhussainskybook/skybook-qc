import "server-only";
import type { Database } from "@/lib/db/database";
import { clearAttempts, recordAttempt } from "@/lib/db/login-throttle";
import { deleteUserSessions } from "@/lib/db/sessions";
import { findUserForSignIn, setOwnPasswordHash } from "@/lib/db/users";
import { DEFAULT_COST, hashPassword, verifyPassword, type ScryptCost } from "@/lib/auth/password";
import { SIGN_IN_LIMIT } from "@/lib/auth/sign-in";
import { checkPassword } from "@/lib/auth/user-input";

/**
 * A signed-in user chooses their own password — required after an
 * administrator set a temporary one. The current password is asked for (and
 * attempts are limited like sign-in), the new one follows the usual rules and
 * must differ from it. The user's other sessions are signed out; this one stays.
 */

export type ChangePasswordInput = {
  currentPassword: string;
  password: string;
  passwordConfirmation: string;
};

export type ChangePasswordResult =
  | { ok: true }
  | { ok: false; errors: Partial<Record<"currentPassword" | "password" | "form", string>> };

export async function changeOwnPassword(
  db: Database,
  user: { id: string; email: string },
  input: ChangePasswordInput,
  options: { keepTokenHash?: string; cost?: ScryptCost; now?: Date } = {}
): Promise<ChangePasswordResult> {
  const now = options.now ?? new Date();
  const throttleKey = `password-change:${user.id}`;
  const window = await recordAttempt(db, throttleKey, now, SIGN_IN_LIMIT.windowSeconds);
  if (window.attempts > SIGN_IN_LIMIT.maxAttempts) {
    return { ok: false, errors: { form: "Too many attempts. Please wait 15 minutes and try again." } };
  }

  const account = await findUserForSignIn(db, user.email);
  if (!account || account.id !== user.id || !account.active) {
    return { ok: false, errors: { form: "Your account isn't available. Please sign in again." } };
  }
  if (!input.currentPassword || !(await verifyPassword(input.currentPassword, account.passwordHash))) {
    return { ok: false, errors: { currentPassword: "Your current password is incorrect." } };
  }

  const password = checkPassword(input.password, input.passwordConfirmation, account.email);
  if (!password.ok) return { ok: false, errors: { password: password.error } };
  if (password.value === input.currentPassword) {
    return { ok: false, errors: { password: "Choose a password different from the current one." } };
  }

  await setOwnPasswordHash(db, account.id, await hashPassword(password.value, options.cost ?? DEFAULT_COST));
  await deleteUserSessions(db, account.id, options.keepTokenHash);
  await clearAttempts(db, throttleKey);
  return { ok: true };
}

