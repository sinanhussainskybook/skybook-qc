/**
 * npm run db:migrate
 *
 * Applies any new SQL files in db/migrations/ to the database in
 * DATABASE_URL. Safe to run again: applied files are skipped.
 */
import path from "node:path";
import { applyMigrations, loadMigrations } from "@/lib/db/migrate";
import { loadLocalEnv, openDatabase } from "./lib/env";

async function main() {
  loadLocalEnv();
  const migrations = await loadMigrations(path.join(process.cwd(), "db", "migrations"));
  const { db, close } = openDatabase();

  try {
    const applied = await applyMigrations(db, migrations);
    if (applied.length === 0) {
      console.log("Database is up to date — nothing to apply.");
    } else {
      for (const name of applied) console.log(`Applied ${name}`);
      console.log(`Done: ${applied.length} migration(s) applied.`);
    }
  } finally {
    await close();
  }
}

main().catch((error: unknown) => {
  console.error(`Migration failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
