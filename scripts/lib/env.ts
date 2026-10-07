import { existsSync } from "node:fs";
import path from "node:path";
import { connect, wrapPostgres } from "@/lib/db/client";
import { loadExternalEnv } from "@/lib/external-env";

/**
 * Shared set-up for the command-line tools: read settings the same way the
 * app does — a project .env.local first (if any), then the secrets file
 * outside the project (<home>/.skybook-qc/.env.local) — and open a single
 * database connection.
 */

export function loadLocalEnv(): void {
  const file = path.join(process.cwd(), ".env.local");
  if (existsSync(file)) process.loadEnvFile(file);
  loadExternalEnv();
}

export function openDatabase() {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Put the Supabase connection string in .env.local (see .env.example)."
    );
  }
  const sql = connect(url, { max: 1 });
  return { db: wrapPostgres(sql), close: () => sql.end({ timeout: 5 }) };
}
