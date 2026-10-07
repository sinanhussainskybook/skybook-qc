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

/** Email and name must already be validated and normalised (see auth/user-input.ts). */
export async function insertUser(
  db: Database,
  input: { name: string; email: string; role: Role; passwordHash: string }
): Promise<User> {
  try {
    const [row] = await db.query<UserRow>(
      `insert into app_users (name, email, role, password_hash)
       values ($1, $2, $3, $4)
       returning ${USER_COLUMNS}`,
      [input.name, input.email, input.role, input.passwordHash]
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
