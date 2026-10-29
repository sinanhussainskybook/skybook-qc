import path from "node:path";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import type { Database } from "@/lib/db/database";
import { applyMigrations, loadMigrations } from "@/lib/db/migrate";
import type { ScryptCost } from "@/lib/auth/password";

/**
 * A fresh, real PostgreSQL database in memory (PGlite) for one test file,
 * with QC's own migrations applied — so tests run the same SQL as Supabase.
 */

export const MIGRATIONS_DIR = path.resolve(import.meta.dirname, "..", "db", "migrations");

/** Cheap hashing for tests only. The app always uses DEFAULT_COST. */
export const TEST_COST: ScryptCost = { logN: 10, r: 8, p: 1 };

export function wrapPglite(pg: PGlite | Transaction): Database {
  return {
    async query<Row>(text: string, params: readonly unknown[] = []) {
      return (await pg.query<Row>(text, [...params])).rows;
    },
    async exec(script: string) {
      await pg.exec(script);
    },
    async transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T> {
      if (!("transaction" in pg)) throw new Error("Nested database transactions aren't supported.");
      return pg.transaction((tx) => fn(wrapPglite(tx)));
    },
  };
}

/** Inserts a user directly (no password checks needed for company tests). */
export async function insertTestUser(
  db: Database,
  user: { name: string; email: string; role: "admin" | "designer"; active?: boolean }
) {
  const [row] = await db.query<{ id: string; name: string; email: string; role: "admin" | "designer"; active: boolean }>(
    `insert into app_users (name, email, role, password_hash, active)
     values ($1, $2, $3, 'not-a-real-hash', $4)
     returning id, name, email, role, active`,
    [user.name, user.email, user.role, user.active ?? true]
  );
  return row;
}

export async function createTestDatabase(options: { migrate?: boolean } = {}) {
  const pg = new PGlite();
  const db = wrapPglite(pg);
  if (options.migrate !== false) {
    await applyMigrations(db, await loadMigrations(MIGRATIONS_DIR));
  }
  return { db, pg, close: () => pg.close() };
}
