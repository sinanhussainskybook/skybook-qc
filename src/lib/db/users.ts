import type { Database } from "@/lib/db/database";
import type { Role } from "@/lib/auth/roles";

/**
 * Staff accounts (table `app_users`).
 *
 * `password_hash` is only ever read by sign-in. Everything else gets a
 * `User`, which has no hash on it, so it can't leak into a page by accident.
 */

export type User = {
  id: string;
  name: string;
  email: string;
  role: Role;
  active: boolean;
};

export type UserWithPasswordHash = User & { passwordHash: string };

type UserRow = {
  id: string;
  name: string;
  email: string;
  role: Role;
  active: boolean;
  password_hash?: string;
};

const USER_COLUMNS = "id, name, email, role, active";

function toUser(row: UserRow): User {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    active: row.active,
  };
}

export class EmailAlreadyUsedError extends Error {
  constructor(email: string) {
    super(`A user with the email ${email} already exists.`);
    this.name = "EmailAlreadyUsedError";
  }
}

/**
 * Email and name must already be validated and normalised (see auth/user-input.ts).
 * `mustChangePassword`: the password is temporary (set by an administrator).
 */
export async function insertUser(
  db: Database,
  input: { name: string; email: string; role: Role; passwordHash: string; mustChangePassword?: boolean }
): Promise<User> {
  try {
    const [row] = await db.query<UserRow>(
      `insert into app_users (name, email, role, password_hash, must_change_password)
       values ($1, $2, $3, $4, $5)
       returning ${USER_COLUMNS}`,
      [input.name, input.email, input.role, input.passwordHash, input.mustChangePassword ?? false]
    );
    return toUser(row);
  } catch (error) {
    if (isUniqueViolation(error)) throw new EmailAlreadyUsedError(input.email);
    throw error;
  }
}

/** For sign-in only: the account including its password hash. */
export async function findUserForSignIn(
  db: Database,
  email: string
): Promise<UserWithPasswordHash | null> {
  const [row] = await db.query<UserRow>(
    `select ${USER_COLUMNS}, password_hash from app_users where email = $1`,
    [email]
  );
  return row ? { ...toUser(row), passwordHash: row.password_hash! } : null;
}

export async function findUserByEmail(db: Database, email: string): Promise<User | null> {
  const [row] = await db.query<UserRow>(
    `select ${USER_COLUMNS} from app_users where email = $1`,
    [email]
  );
  return row ? toUser(row) : null;
}

/** A user by id (the analysis worker re-checks who asked for a run). */
export async function findUserById(db: Database, id: string): Promise<User | null> {
  const [row] = await db.query<UserRow>(`select ${USER_COLUMNS} from app_users where id = $1`, [id]);
  return row ? toUser(row) : null;
}

// ---------------------------------------------------------------------------
// User Management (admins only — see auth/user-admin.ts for the rules)
// ---------------------------------------------------------------------------

export type ManagedUser = User & { mustChangePassword: boolean; createdAt: Date };

/** Every account, for the User Management page. Never the password hash. */
export async function listUsers(db: Database): Promise<ManagedUser[]> {
  const rows = await db.query<UserRow & { must_change_password: boolean; created_at: Date | string }>(
    `select ${USER_COLUMNS}, must_change_password, created_at from app_users order by lower(name), email`
  );
  return rows.map((row) => ({
    ...toUser(row),
    mustChangePassword: row.must_change_password,
    createdAt: new Date(row.created_at),
  }));
}

/**
 * A temporary password set by an administrator: the new hash, and the user
 * must choose their own password at the next sign-in.
 */
export async function setTemporaryPasswordHash(db: Database, userId: string, passwordHash: string): Promise<boolean> {
  const rows = await db.query<{ id: string }>(
    "update app_users set password_hash = $2, must_change_password = true, updated_at = now() where id = $1 returning id",
    [userId, passwordHash]
  );
  return rows.length === 1;
}

/** The user chose their own password: the new hash, and the "must change" flag cleared. */
export async function setOwnPasswordHash(db: Database, userId: string, passwordHash: string): Promise<boolean> {
  const rows = await db.query<{ id: string }>(
    "update app_users set password_hash = $2, must_change_password = false, updated_at = now() where id = $1 returning id",
    [userId, passwordHash]
  );
  return rows.length === 1;
}

/**
 * The active admins, locked until the statement ends. Used by the two
 * statements below so two admins switched off at the same moment can't
 * leave nobody able to manage users: the second waits, then sees one admin.
 */
const LOCKED_ACTIVE_ADMINS = "with admins as (select id from app_users where role = 'admin' and active for update)";

/**
 * Switches an account on or off. Switching off the LAST active admin is
 * refused (returns false), in the same statement as the change.
 */
export async function setUserActive(db: Database, userId: string, active: boolean): Promise<boolean> {
  const rows = active
    ? await db.query<{ id: string }>("update app_users set active = true, updated_at = now() where id = $1 returning id", [userId])
    : await db.query<{ id: string }>(
        `${LOCKED_ACTIVE_ADMINS}
         update app_users set active = false, updated_at = now()
          where id = $1
            and (role <> 'admin' or not active or (select count(*) from admins) > 1)
          returning id`,
        [userId]
      );
  return rows.length === 1;
}

/** Does this user still have QC working data (a temporary QC session or analysis run)? */
export async function hasQcWorkInProgress(db: Database, userId: string): Promise<boolean> {
  const [row] = await db.query<{ busy: boolean }>(
    `select exists (select 1 from qc_sessions where user_id = $1)
         or exists (select 1 from qc_analysis_runs where requested_by = $1) as busy`,
    [userId]
  );
  return Boolean(row?.busy);
}

/**
 * Deletes an account. Refused (returns false) for the last active admin and
 * while the user still has QC working data — those rows would be removed with
 * the account (ON DELETE CASCADE) without their files in Storage. Their
 * sign-in sessions and company memberships go with the account; companies
 * they added are kept (created_by becomes empty).
 */
export async function deleteUserRow(db: Database, userId: string): Promise<boolean> {
  const rows = await db.query<{ id: string }>(
    `${LOCKED_ACTIVE_ADMINS}
     delete from app_users
      where id = $1
        and (role <> 'admin' or not active or (select count(*) from admins) > 1)
        and not exists (select 1 from qc_sessions where user_id = $1)
        and not exists (select 1 from qc_analysis_runs where requested_by = $1)
      returning id`,
    [userId]
  );
  return rows.length === 1;
}

export async function countActiveAdmins(db: Database): Promise<number> {
  const [row] = await db.query<{ count: number | string }>(
    "select count(*)::int as count from app_users where role = 'admin' and active"
  );
  return Number(row.count);
}

export async function countUsers(db: Database): Promise<number> {
  const [row] = await db.query<{ count: number | string }>(
    "select count(*)::int as count from app_users"
  );
  return Number(row.count);
}

/** PostgreSQL error 23505: a unique index (here, the email) already has this value. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "23505"
  );
}
