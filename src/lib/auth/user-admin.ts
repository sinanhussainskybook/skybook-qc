import "server-only";
import type { Database } from "@/lib/db/database";
import {
  deleteUserRow,
  findUserById,
  hasQcWorkInProgress,
  setTemporaryPasswordHash,
  setUserActive,
  type User,
} from "@/lib/db/users";
import { clearAttempts } from "@/lib/db/login-throttle";
import { deleteUserSessions } from "@/lib/db/sessions";
import { createUser, type CreateUserResult, type NewUserInput } from "@/lib/auth/create-user";
import { DEFAULT_COST, hashPassword, type ScryptCost } from "@/lib/auth/password";
import { checkPassword } from "@/lib/auth/user-input";
import { isUuid } from "@/lib/company/validation";

/**
 * User Management — the rules, whoever calls them (the admin page's server
 * actions in user-admin-actions.ts). Every function:
 *   1. checks the person acting is an active admin (again — the page and the
 *      action have already checked, but this is where the change happens),
 *   2. refuses changes an admin must not make to their own account,
 *   3. leaves at least one active admin (checked in the same SQL statement
 *      as the change — see users.ts),
 *   4. signs the affected user out everywhere when their access changes.
 * Passwords are hashed with the same scrypt settings as `npm run user:create`
 * and never stored or returned.
 */

export type Actor = Pick<User, "id" | "role" | "active">;

export type AdminResult = { ok: true; message: string } | { ok: false; error: string };

export const MESSAGES = {
  notAllowed: "Only an administrator can manage users.",
  noSuchUser: "This user no longer exists. Reload the page.",
  notYourself: "You can't do this to your own account.",
  ownPassword: "Use “Change password” to change your own password.",
  lastAdmin: "This is the last active administrator. Make another user an active administrator first.",
  qcInProgress:
    "This user still has a QC check in progress. Switch the account off instead; it can be deleted once the check has expired (within 24 hours).",
  confirmDelete: "Type the user's email address exactly to confirm.",
} as const;

function isAdmin(actor: Actor | null | undefined): actor is Actor {
  return Boolean(actor && actor.active && actor.role === "admin");
}

/** Create an account with a temporary password: the user must choose their own at first sign-in. */
export async function adminCreateUser(
  db: Database,
  actor: Actor | null,
  input: Omit<NewUserInput, "mustChangePassword">,
  cost: ScryptCost = DEFAULT_COST
): Promise<CreateUserResult> {
  if (!isAdmin(actor)) return { ok: false, errors: { form: MESSAGES.notAllowed } };
  return createUser(db, { ...input, mustChangePassword: true }, cost);
}

/** Switch an account on or off. Switching off signs the user out everywhere. */
export async function adminSetUserActive(
  db: Database,
  actor: Actor | null,
  userId: string,
  active: boolean
): Promise<AdminResult> {
  if (!isAdmin(actor)) return { ok: false, error: MESSAGES.notAllowed };
  if (userId === actor.id) return { ok: false, error: MESSAGES.notYourself };
  const user = isUuid(userId) ? await findUserById(db, userId) : null;
  if (!user) return { ok: false, error: MESSAGES.noSuchUser };

  if (!(await setUserActive(db, user.id, active))) {
    // The only refusal left is the last active admin (or the row just vanished).
    return { ok: false, error: (await findUserById(db, user.id)) ? MESSAGES.lastAdmin : MESSAGES.noSuchUser };
  }
  if (!active) await deleteUserSessions(db, user.id);
  return { ok: true, message: active ? `${user.name} can sign in again.` : `${user.name} is switched off and signed out.` };
}

/**
 * Give a user a temporary password. They are signed out everywhere and must
 * choose their own password at the next sign-in. Not for the admin's own
 * account (that is "Change password", which asks for the current one).
 */
export async function adminResetPassword(
  db: Database,
  actor: Actor | null,
  input: { userId: string; password: string; passwordConfirmation: string },
  cost: ScryptCost = DEFAULT_COST
): Promise<AdminResult> {
  if (!isAdmin(actor)) return { ok: false, error: MESSAGES.notAllowed };
  if (input.userId === actor.id) return { ok: false, error: MESSAGES.ownPassword };
  const user = isUuid(input.userId) ? await findUserById(db, input.userId) : null;
  if (!user) return { ok: false, error: MESSAGES.noSuchUser };

  const password = checkPassword(input.password, input.passwordConfirmation, user.email);
  if (!password.ok) return { ok: false, error: password.error };

  if (!(await setTemporaryPasswordHash(db, user.id, await hashPassword(password.value, cost)))) {
    return { ok: false, error: MESSAGES.noSuchUser };
  }
  await deleteUserSessions(db, user.id);
  await clearAttempts(db, `email:${user.email}`); // a locked-out user can try the new password straight away
  return {
    ok: true,
    message: `Temporary password set for ${user.name}. They have been signed out and must choose a new password when they sign in.`,
  };
}

/**
 * Delete an account for good, after the admin has typed its email to
 * confirm. Never one's own account or the last active admin, and not while
 * the user has QC working data. Companies they added are kept.
 */
export async function adminDeleteUser(
  db: Database,
  actor: Actor | null,
  input: { userId: string; confirmEmail: string }
): Promise<AdminResult> {
  if (!isAdmin(actor)) return { ok: false, error: MESSAGES.notAllowed };
  if (input.userId === actor.id) return { ok: false, error: MESSAGES.notYourself };
  const user = isUuid(input.userId) ? await findUserById(db, input.userId) : null;
  if (!user) return { ok: false, error: MESSAGES.noSuchUser };
  if (input.confirmEmail.trim().toLowerCase() !== user.email) return { ok: false, error: MESSAGES.confirmDelete };
  if (await hasQcWorkInProgress(db, user.id)) return { ok: false, error: MESSAGES.qcInProgress };

  if (!(await deleteUserRow(db, user.id))) {
    if (!(await findUserById(db, user.id))) return { ok: false, error: MESSAGES.noSuchUser };
    return { ok: false, error: (await hasQcWorkInProgress(db, user.id)) ? MESSAGES.qcInProgress : MESSAGES.lastAdmin };
  }
  // Sessions and company memberships went with the account (ON DELETE CASCADE).
  return { ok: true, message: `${user.name} (${user.email}) was deleted.` };
}
