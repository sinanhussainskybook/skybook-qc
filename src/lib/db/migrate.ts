import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Database } from "@/lib/db/database";

/**
 * Applies the numbered SQL files in db/migrations/ in order, once each.
 * Run with `npm run db:migrate`.
 *
 * Each file runs as one unit together with its entry in
 * `schema_migrations`: if any statement fails, none of that file is kept
 * and it will be tried again next time. Files must not contain their own
 * BEGIN / COMMIT.
 */

export type Migration = { name: string; sql: string };

/** e.g. 0001_users_and_sign_in.sql */
export const MIGRATION_NAME = /^\d{4}_[a-z0-9_]+\.sql$/;

export async function loadMigrations(directory: string): Promise<Migration[]> {
  const names = (await readdir(directory)).filter((name) => name.endsWith(".sql"));

  const invalid = names.filter((name) => !MIGRATION_NAME.test(name));
  if (invalid.length > 0) {
    throw new Error(
      `Migration file names must look like 0001_description.sql: ${invalid.join(", ")}`
    );
  }

  return Promise.all(
    names.sort().map(async (name) => ({
      name,
      sql: await readFile(path.join(directory, name), "utf8"),
    }))
  );
}

/** Returns the names of the migrations applied by this run (empty if up to date). */
export async function applyMigrations(
  db: Database,
  migrations: readonly Migration[]
): Promise<string[]> {
  await db.exec(`
    create table if not exists schema_migrations (
      name       text primary key,
      applied_at timestamptz not null default now()
    );
    alter table schema_migrations enable row level security;
  `);

  const done = new Set(
    (await db.query<{ name: string }>("select name from schema_migrations")).map(
      (row) => row.name
    )
  );

  const applied: string[] = [];
  for (const migration of [...migrations].sort((a, b) => a.name.localeCompare(b.name))) {
    if (done.has(migration.name)) continue;
    // The name is checked against a strict pattern, so it is safe to put in SQL.
    if (!MIGRATION_NAME.test(migration.name)) {
      throw new Error(`Invalid migration name: ${migration.name}`);
    }

    await db.exec(
      `${migration.sql}\n;\ninsert into schema_migrations (name) values ('${migration.name}');`
    );
    applied.push(migration.name);
  }
  return applied;
}
